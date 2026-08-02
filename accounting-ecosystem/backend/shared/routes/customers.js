/**
 * ============================================================================
 * Shared Customers Routes - Top-level /api/customers
 * ============================================================================
 * Customer CRUD, search, loyalty, and account management.
 * Accessible from POS and other modules.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const { hasPermission } = require('../../config/permissions');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// Standard customer discount — 0 to 100, or undefined/null when not supplied.
// Margin-affecting, so writing it requires CUSTOMERS.MANAGE_DISCOUNT
// (management-role only), independent of whatever role can otherwise
// create/edit a customer via this route (this router has no per-action
// permission gate at all today — auth-only).
function validateDiscountPercentage(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const num = parseFloat(value);
  if (isNaN(num) || num < 0 || num > 100) {
    return { ok: false, error: 'discount_percentage must be a number between 0 and 100' };
  }
  return { ok: true, value: num };
}

/**
 * GET /api/customers
 * List customers with search and filters
 */
router.get('/', async (req, res) => {
  try {
    const { search, active_only, group, page = 1, limit = 100 } = req.query;

    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .eq('company_id', req.companyId);

    if (active_only !== 'false') query = query.eq('is_active', true);
    if (group) query = query.eq('customer_group', group);
    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%,contact_number.ilike.%${search}%`);
    }

    query = query.order('name');

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ customers: data || [], total: count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/customers/search
 * Quick search for customer autocomplete
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ customers: [] });

    // credit_limit/discount_percentage added (found live, 2026-07-31, during
    // customer-discount audit): the POS checkout picker (selectAccountCustomer)
    // has always read c.credit_limit from this response and always got
    // undefined — a pre-existing display bug (silently showed "R 0.00" limit
    // regardless of the real value), fixed in passing since it's the same
    // select(). discount_percentage is required for this feature: without it,
    // the on-screen cart total wouldn't reflect a selected customer's discount
    // even though the backend would still correctly apply and charge it —
    // an on-screen-vs-charged mismatch, not just a display gap.
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, phone, email, customer_number, loyalty_points, current_balance, credit_limit, discount_percentage')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%,customer_number.ilike.%${q}%`)
      .order('name')
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ customers: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/customers/:id
 */
router.get('/:id', async (req, res) => {
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
 * POST /api/customers
 */
router.post('/', async (req, res) => {
  try {
    const { name, email, phone, address_line_1, id_number, customer_group, notes, contact_number, discount_percentage } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const discountCheck = validateDiscountPercentage(discount_percentage);
    if (!discountCheck.ok) return res.status(400).json({ error: discountCheck.error });
    if (discountCheck.value !== undefined && !hasPermission(req.user.role, 'CUSTOMERS', 'MANAGE_DISCOUNT')) {
      return res.status(403).json({ error: 'Only management can set a customer discount' });
    }

    const customerNumber = `C-${Date.now().toString(36).toUpperCase()}`;

    const { data, error } = await supabase
      .from('customers')
      .insert({
        company_id: req.companyId,
        name,
        email: email || null,
        phone: phone || contact_number || null,
        contact_number: contact_number || phone || null,
        address_line_1: address_line_1 || null,
        id_number: id_number || null,
        customer_number: customerNumber,
        customer_group: customer_group || 'retail',
        loyalty_points: 0,
        current_balance: 0,
        discount_percentage: discountCheck.value ?? 0,
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
 * PUT /api/customers/:id
 */
router.put('/:id', async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'contact_number', 'address_line_1', 'id_number', 'customer_group', 'notes', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const discountCheck = validateDiscountPercentage(req.body.discount_percentage);
    if (!discountCheck.ok) return res.status(400).json({ error: discountCheck.error });
    if (discountCheck.value !== undefined) {
      if (!hasPermission(req.user.role, 'CUSTOMERS', 'MANAGE_DISCOUNT')) {
        return res.status(403).json({ error: 'Only management can set a customer discount' });
      }
      updates.discount_percentage = discountCheck.value;
    }

    const { data, error } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ customer: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/customers/:id/account
 * Get account balance for a customer
 */
router.get('/:id/account', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, current_balance, credit_limit')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Customer not found' });
    res.json({ account: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/customers/:id/account/payment
 * Record a payment against a customer account
 */
router.post('/:id/account/payment', async (req, res) => {
  try {
    const { amount, reference } = req.body;
    const { data: customer } = await supabase
      .from('customers')
      .select('current_balance')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const newBalance = (customer.current_balance || 0) - (amount || 0);
    const { data, error } = await supabase
      .from('customers')
      .update({ current_balance: newBalance })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ customer: data, payment: amount, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/customers/:id/product-discounts
 * List this customer's per-product discount overrides — distinct from the
 * flat discount_percentage above. See sales.js for how these two (plus
 * store-wide pos_daily_discounts) are reconciled at checkout.
 */
router.get('/:id/product-discounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customer_product_discounts')
      .select('*, products(product_name, unit_price)')
      .eq('customer_id', req.params.id)
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('id', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ discounts: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/customers/:id/product-discounts
 * Add/replace a discount for one product for this customer. Management-only
 * (CUSTOMERS.MANAGE_DISCOUNT — same gate as the flat discount_percentage,
 * same reasoning: margin-affecting).
 */
router.post('/:id/product-discounts', async (req, res) => {
  try {
    if (!hasPermission(req.user.role, 'CUSTOMERS', 'MANAGE_DISCOUNT')) {
      return res.status(403).json({ error: 'Only management can set a customer discount' });
    }

    const { product_id, discount_type, discount_value } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    if (!['fixed', 'percent'].includes(discount_type)) {
      return res.status(400).json({ error: "discount_type must be 'fixed' or 'percent'" });
    }
    const value = parseFloat(discount_value);
    if (isNaN(value) || value < 0) {
      return res.status(400).json({ error: 'discount_value must be a non-negative number' });
    }
    if (discount_type === 'percent' && value > 100) {
      return res.status(400).json({ error: 'discount_value cannot exceed 100 for a percent discount' });
    }

    // One row per (customer, product) — upsert so re-adding the same product
    // updates the existing override instead of erroring on the unique constraint.
    const { data, error } = await supabase
      .from('customer_product_discounts')
      .upsert({
        company_id: req.companyId,
        customer_id: req.params.id,
        product_id,
        discount_type,
        discount_value: value,
        is_active: true,
        created_by: req.user.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'customer_id,product_id' })
      .select('*, products(product_name, unit_price)')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'customer_product_discount', data.id, { module: 'pos', newValue: data });
    res.status(201).json({ discount: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/customers/:id/product-discounts/:discountId
 * Remove a product-specific discount override. Same management-only gate as create.
 */
router.delete('/:id/product-discounts/:discountId', async (req, res) => {
  try {
    if (!hasPermission(req.user.role, 'CUSTOMERS', 'MANAGE_DISCOUNT')) {
      return res.status(403).json({ error: 'Only management can remove a customer discount' });
    }

    const { error } = await supabase
      .from('customer_product_discounts')
      .delete()
      .eq('id', req.params.discountId)
      .eq('customer_id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
