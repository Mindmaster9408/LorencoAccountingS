/**
 * ============================================================================
 * POS Customers Routes - Checkout Charlie Module
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/customers
 */
router.get('/', requirePermission('CUSTOMERS.VIEW'), async (req, res) => {
  try {
    const { search, active_only, group } = req.query;

    let query = supabase
      .from('customers')
      .select('*')
      .eq('company_id', req.companyId);

    if (active_only !== 'false') query = query.eq('is_active', true);
    if (group) query = query.eq('customer_group', group);
    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
    }

    query = query.order('name');

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ customers: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/customers/:id
 */
router.get('/:id', requirePermission('CUSTOMERS.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customer: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/customers
 */
router.post('/', requirePermission('CUSTOMERS.CREATE'), async (req, res) => {
  try {
    const { name, email, phone, address, id_number, customer_group, notes } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const customerNumber = `C-${Date.now().toString(36).toUpperCase()}`;

    const { data, error } = await supabase
      .from('customers')
      .insert({
        company_id: req.companyId,
        name,
        email,
        phone,
        address,
        id_number,
        customer_number: customerNumber,
        customer_group: customer_group || 'retail',
        loyalty_points: 0,
        loyalty_tier: 'bronze',
        current_balance: 0,
        notes,
        is_active: true
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'customer', data.id, { module: 'pos', newValue: data });
    res.status(201).json({ customer: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/customers/:id
 */
router.put('/:id', requirePermission('CUSTOMERS.EDIT'), async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'address', 'id_number', 'customer_group', 'notes', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Customer not found' });

    await auditFromReq(req, 'UPDATE', 'customer', req.params.id, { module: 'pos', newValue: data });
    res.json({ customer: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/customers/:id/account
 * Get a customer's account balance and transaction history.
 * Used for credit account customers who have an outstanding balance.
 */
router.get('/:id/account', requirePermission('CUSTOMERS.VIEW'), async (req, res) => {
  try {
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, name, current_balance, credit_limit')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    const { data: transactions, error: txErr } = await supabase
      .from('customer_account_transactions')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('customer_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (txErr) return res.status(500).json({ error: txErr.message });

    res.json({
      customer,
      balance:      customer.current_balance || 0,
      transactions: transactions || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/customers/:id/account/payment
 * Record a payment against a customer's outstanding account balance.
 *
 * Body: { amount, payment_method, reference, notes, idempotency_key }
 *
 * BUG FIX (found live, Workstream 90): this endpoint previously had no
 * idempotency protection at all — a retried request (network retry,
 * double-tap) created a second full-amount payment row and decremented the
 * balance twice. Confirmed live: two identical retry requests produced two
 * separate transaction rows. Two changes:
 *   1. idempotency_key (optional but recommended) — if a transaction with
 *      the same company_id + idempotency_key already exists, that existing
 *      transaction is returned unchanged rather than processing again.
 *   2. Order flipped: the ledger row is now inserted BEFORE the balance
 *      update (previously balance-then-ledger). If the insert fails, no
 *      balance was touched — the safe failure direction. If the update
 *      fails after a successful insert, the ledger still has undeniable,
 *      reconcilable evidence of the payment, which is recoverable; a wrong
 *      balance with zero ledger trail (the old order's failure mode) is not.
 *      The balance update itself uses compare-and-swap (matching the
 *      pattern in sales.js's postAccountCharge) so a concurrent charge/
 *      payment against the same customer cannot silently overwrite this one.
 */
router.post('/:id/account/payment', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { amount, payment_method, reference, notes, idempotency_key: idempotencyKey } = req.body;
    const customerId = req.params.id;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, name, current_balance')
      .eq('id', customerId)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    if (idempotencyKey) {
      const { data: existing } = await supabase
        .from('customer_account_transactions')
        .select('*')
        .eq('company_id', req.companyId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (existing) {
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_PAYMENT_REPLAYED, {
          metadata: { customer_id: customerId, transaction_id: existing.id, idempotency_key: idempotencyKey },
        });
        return res.status(200).json({
          transaction: existing, was_duplicate: true,
          old_balance: null, new_balance: existing.balance_after,
        });
      }
    }

    const currentBalance = customer.current_balance || 0;

    // Insert the ledger row first — a failure here touches nothing.
    const { data: tx, error: txErr } = await supabase
      .from('customer_account_transactions')
      .insert({
        company_id:      req.companyId,
        customer_id:     parseInt(customerId),
        sale_id:         null,
        type:            'payment',
        amount:          -amount,           // negative = money coming in (reduces balance)
        balance_after:   null,              // filled in once the CAS balance update below succeeds
        reference:       reference || null,
        notes:           notes || `Payment via ${payment_method || 'cash'}`,
        created_by:      req.user.userId,
        idempotency_key: idempotencyKey || null,
      })
      .select()
      .single();

    if (txErr) {
      // Unique-index race: a concurrent request with the same idempotency_key
      // won first. Return that row rather than a 500.
      if (idempotencyKey && txErr.code === '23505') {
        const { data: winner } = await supabase
          .from('customer_account_transactions')
          .select('*').eq('company_id', req.companyId).eq('idempotency_key', idempotencyKey).maybeSingle();
        if (winner) return res.status(200).json({ transaction: winner, was_duplicate: true, old_balance: null, new_balance: winner.balance_after });
      }
      return res.status(500).json({ error: txErr.message });
    }

    // Compare-and-swap balance update — bounded retries against a lost race.
    let newBalance = null;
    for (let attempt = 1; attempt <= 5 && newBalance === null; attempt++) {
      const { data: fresh } = await supabase.from('customers').select('current_balance').eq('id', customerId).eq('company_id', req.companyId).single();
      const oldVal = fresh ? (fresh.current_balance || 0) : currentBalance;
      const candidate = Math.max(0, Math.round((oldVal - amount) * 100) / 100);
      const { data: updated } = await supabase
        .from('customers')
        .update({ current_balance: candidate, updated_at: new Date().toISOString() })
        .eq('id', customerId).eq('company_id', req.companyId).eq('current_balance', oldVal)
        .select().maybeSingle();
      if (updated) newBalance = candidate;
    }
    if (newBalance === null) {
      console.error('[Customers] CRITICAL: payment ledger row created but balance CAS update lost every retry:', tx.id);
      return res.status(500).json({ error: 'Payment recorded but balance update failed — contact support for reconciliation', transaction: tx });
    }

    await supabase.from('customer_account_transactions').update({ balance_after: newBalance }).eq('id', tx.id);

    await auditFromReq(req, 'UPDATE', 'customer_account', customerId, {
      module:   'pos',
      oldValue: currentBalance,
      newValue: newBalance,
      metadata: { payment_amount: amount, payment_method, reference },
    });
    posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_PAYMENT_RECORDED, {
      metadata: { customer_id: customerId, amount, payment_method, reference, transaction_id: tx.id, new_balance: newBalance },
    });

    res.status(201).json({
      transaction:  { ...tx, balance_after: newBalance },
      old_balance:  currentBalance,
      new_balance:  newBalance,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/customers/:id (soft delete)
 */
router.delete('/:id', requirePermission('CUSTOMERS.DELETE'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('customers')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'customer', req.params.id, { module: 'pos' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
