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
    // balance_after is NOT NULL on this table, so the ledger row must carry a
    // best-effort computed value at insert time — computed here from the
    // balance already read above, then corrected below if a concurrent
    // write means the CAS loop has to recompute against a fresher value.
    const initialCandidate = Math.max(0, Math.round((currentBalance - amount) * 100) / 100);

    // Insert the ledger row first — a failure here touches nothing.
    const { data: tx, error: txErr } = await supabase
      .from('customer_account_transactions')
      .insert({
        company_id:      req.companyId,
        customer_id:     parseInt(customerId),
        sale_id:         null,
        type:            'payment',
        amount:          -amount,           // negative = money coming in (reduces balance)
        balance_after:   initialCandidate,  // corrected below if the CAS loop recomputes against a fresher balance
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

    if (newBalance !== initialCandidate) {
      await supabase.from('customer_account_transactions').update({ balance_after: newBalance }).eq('id', tx.id);
    }

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

/**
 * POST /api/pos/customers/:id/link-company
 * Link this customer record to another company on the platform by invitation
 * code — the customer-side mirror of suppliers.js's existing link-company
 * (Workstream 80). Needed for Workstream 99: an account sale to a customer
 * whose record is linked this way can auto-sync to that company's Purchase
 * Order (attach as a delivery, or auto-create one) — the customer record is
 * how the seller knows "this local customer IS that platform company."
 *
 * Unlike suppliers.js's version, this gracefully reuses an existing
 * relationship between the two companies (e.g. one already established via
 * a Supplier record) rather than erroring — the underlying relationship is
 * a single, symmetric row per company pair; a customer and a supplier record
 * can legitimately point at the very same one.
 */
// Same permission tier as suppliers.js's link-company (INVENTORY.ADJUST,
// management-only) — establishing any cross-company relationship is the
// same class of sensitive action regardless of which local record anchors it.
router.post('/:id/link-company', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });
    const invitationCode = (req.body.invitationCode || '').trim();
    if (!invitationCode) return res.status(400).json({ error: 'invitationCode is required' });

    const { data: customer } = await supabase
      .from('customers').select('*').eq('id', customerId).eq('company_id', req.companyId).single();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (customer.link_status === 'active' || customer.link_status === 'pending') {
      return res.status(400).json({ error: `This customer already has a ${customer.link_status} company link. Revoke it first.` });
    }

    const InterCompanyNetwork = require('../../../inter-company/network');
    const { supabaseSeanStore } = require('../../../sean/supabase-store');
    const network = new InterCompanyNetwork(supabaseSeanStore);

    const matches = await network.findCompanies({ invitationCode }, req.companyId);
    const match = matches.find(m => m.matchType === 'invitation_code');
    if (!match) return res.status(404).json({ error: 'No company found for that invitation code' });

    let relationship;
    const created = await network.createRelationship(req.companyId, match.companyId, req.companyId, {
      stock_transfer: false, receive_transfer: false, return_transfer: false,
      pricing_visible: false, invoice_reference_visible: false,
    });
    if (created.success) {
      relationship = created.relationship;
    } else if (created.relationship) {
      // Relationship already exists (e.g. linked via a Supplier record already) —
      // reuse it rather than failing; that's exactly the same relationship this
      // customer record should point at.
      relationship = created.relationship;
    } else {
      return res.status(400).json(created);
    }

    const { data: updatedCustomer, error: updErr } = await supabase
      .from('customers')
      .update({
        linked_company_id:      match.companyId,
        linked_relationship_id: relationship.id,
        link_status:            relationship.status === 'active' ? 'active' : 'pending',
        updated_at:              new Date().toISOString(),
      })
      .eq('id', customerId).eq('company_id', req.companyId)
      .select().single();
    if (updErr) return res.status(500).json({ error: updErr.message });

    posAuditFromReq(req, POS_EVENTS.COMPANY_RELATIONSHIP_REQUESTED, {
      entityType: 'customer', entityId: customerId,
      metadata: { relationship_id: relationship.id, target_company_name: match.companyName, reused_existing: !created.success },
    });

    res.json({
      customer: updatedCustomer,
      linked_company: { id: match.companyId, name: match.companyName },
      relationship_status: updatedCustomer.link_status,
      message: created.success
        ? 'Link request sent. The other company must approve before any data is shared.'
        : 'Linked to the existing relationship with this company.',
    });
  } catch (err) {
    console.error('[customers] link-company:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
