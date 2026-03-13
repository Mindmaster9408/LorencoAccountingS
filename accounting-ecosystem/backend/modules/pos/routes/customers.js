/**
 * ============================================================================
 * POS Customers Routes - Checkout Charlie Module
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');

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
 * Body: { amount, payment_method, reference, notes }
 */
router.post('/:id/account/payment', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { amount, payment_method, reference, notes } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, name, current_balance')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    const currentBalance = customer.current_balance || 0;
    const newBalance     = Math.max(0, currentBalance - amount);

    // Update customer balance
    await supabase
      .from('customers')
      .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    // Record account transaction
    const { data: tx, error: txErr } = await supabase
      .from('customer_account_transactions')
      .insert({
        company_id:    req.companyId,
        customer_id:   parseInt(req.params.id),
        sale_id:       null,
        type:          'payment',
        amount:        -amount,           // negative = money coming in (reduces balance)
        balance_after: newBalance,
        reference:     reference || null,
        notes:         notes || `Payment via ${payment_method || 'cash'}`,
        created_by:    req.user.userId,
      })
      .select()
      .single();

    if (txErr) return res.status(500).json({ error: txErr.message });

    await auditFromReq(req, 'UPDATE', 'customer_account', req.params.id, {
      module:   'pos',
      oldValue: currentBalance,
      newValue: newBalance,
      metadata: { payment_amount: amount, payment_method, reference },
    });

    res.status(201).json({
      transaction:  tx,
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
