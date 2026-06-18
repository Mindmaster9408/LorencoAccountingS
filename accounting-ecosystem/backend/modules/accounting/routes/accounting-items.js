/**
 * ============================================================================
 * Accounting Items / Service Master Routes
 * ============================================================================
 * Mounted at /api/accounting/items
 *
 * Routes:
 *   GET  /                 — list items (active only by default; ?includeInactive=true for all)
 *   POST /                 — create a new item
 *   PUT  /:id              — update an existing item
 *   PATCH /:id/deactivate  — soft-delete (is_active = false)
 *   PATCH /:id/activate    — reactivate   (is_active = true)
 * ============================================================================
 */

const express  = require('express');
const router   = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

const VALID_TYPES     = ['service', 'inventory', 'non_stock'];
const VALID_TAX_TYPES = ['standard', 'zero_rated', 'exempt'];

// Verify income_account_id belongs to this company (tenant safety)
async function validateAccountOwnership(incomeAccountId, companyId) {
  const { data } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', parseInt(incomeAccountId))
    .eq('company_id', companyId)
    .maybeSingle();
  return !!data;
}

// ─── List Items ───────────────────────────────────────────────────────────────
// Default: active items only (for invoice item selector).
// Pass ?includeInactive=true to get all (for management page).

router.get('/', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId        = req.companyId;
  const includeInactive  = req.query.includeInactive === 'true';
  try {
    let q = supabase
      .from('accounting_items')
      .select('id, item_code, item_name, item_type, description, selling_price, income_account_id, tax_type, is_active, integration_key, created_at, updated_at')
      .eq('company_id', companyId)
      .order('item_name');
    if (!includeInactive) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ items: data || [] });
  } catch (err) {
    console.error('GET /accounting/items error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Item ──────────────────────────────────────────────────────────────

router.post('/', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { itemCode, itemName, itemType, description, sellingPrice, incomeAccountId, taxType, integrationKey } = req.body;

  if (!itemName?.trim())
    return res.status(400).json({ error: 'Item name is required' });
  if (itemType && !VALID_TYPES.includes(itemType))
    return res.status(400).json({ error: `Invalid item type. Must be one of: ${VALID_TYPES.join(', ')}` });
  if (taxType && !VALID_TAX_TYPES.includes(taxType))
    return res.status(400).json({ error: `Invalid tax type. Must be one of: ${VALID_TAX_TYPES.join(', ')}` });

  if (incomeAccountId) {
    const valid = await validateAccountOwnership(incomeAccountId, companyId);
    if (!valid) return res.status(403).json({ error: 'Income account not found or does not belong to this company', errorCode: 'ACCOUNT_TENANT_VIOLATION' });
  }

  if (itemCode?.trim()) {
    const { data: dup } = await supabase.from('accounting_items').select('id')
      .eq('company_id', companyId).eq('item_code', itemCode.trim()).maybeSingle();
    if (dup) return res.status(409).json({ error: `Item code '${itemCode.trim()}' already exists for this company`, errorCode: 'DUPLICATE_ITEM_CODE' });
  }

  try {
    const { data: item, error } = await supabase
      .from('accounting_items')
      .insert({
        company_id:        companyId,
        item_code:         itemCode?.trim()  || null,
        item_name:         itemName.trim(),
        item_type:         itemType          || 'service',
        description:       description?.trim() || null,
        selling_price:     sellingPrice != null ? parseFloat(sellingPrice) : null,
        income_account_id: incomeAccountId   ? parseInt(incomeAccountId) : null,
        tax_type:          taxType           || 'standard',
        integration_key:   integrationKey?.trim() || null,
        is_active:         true,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ item });
  } catch (err) {
    console.error('POST /accounting/items error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Item ──────────────────────────────────────────────────────────────

router.put('/:id', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const itemId    = parseInt(req.params.id);
  if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item ID' });

  const { data: existing } = await supabase.from('accounting_items').select('id')
    .eq('id', itemId).eq('company_id', companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  const { itemCode, itemName, itemType, description, sellingPrice, incomeAccountId, taxType, integrationKey } = req.body;

  if (!itemName?.trim())
    return res.status(400).json({ error: 'Item name is required' });
  if (itemType && !VALID_TYPES.includes(itemType))
    return res.status(400).json({ error: `Invalid item type. Must be one of: ${VALID_TYPES.join(', ')}` });
  if (taxType && !VALID_TAX_TYPES.includes(taxType))
    return res.status(400).json({ error: `Invalid tax type. Must be one of: ${VALID_TAX_TYPES.join(', ')}` });

  if (incomeAccountId) {
    const valid = await validateAccountOwnership(incomeAccountId, companyId);
    if (!valid) return res.status(403).json({ error: 'Income account not found or does not belong to this company', errorCode: 'ACCOUNT_TENANT_VIOLATION' });
  }

  // item_code uniqueness — exclude self
  if (itemCode?.trim()) {
    const { data: dup } = await supabase.from('accounting_items').select('id')
      .eq('company_id', companyId).eq('item_code', itemCode.trim()).neq('id', itemId).maybeSingle();
    if (dup) return res.status(409).json({ error: `Item code '${itemCode.trim()}' already exists for this company`, errorCode: 'DUPLICATE_ITEM_CODE' });
  }

  try {
    const { data: item, error } = await supabase
      .from('accounting_items')
      .update({
        item_code:         itemCode?.trim()  || null,
        item_name:         itemName.trim(),
        item_type:         itemType          || 'service',
        description:       description?.trim() || null,
        selling_price:     sellingPrice != null ? parseFloat(sellingPrice) : null,
        income_account_id: incomeAccountId   ? parseInt(incomeAccountId) : null,
        tax_type:          taxType           || 'standard',
        integration_key:   integrationKey?.trim() || null,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('company_id', companyId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ item });
  } catch (err) {
    console.error('PUT /accounting/items/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Deactivate Item ──────────────────────────────────────────────────────────
// Soft-delete: sets is_active = false. Item remains on historical invoices.

router.patch('/:id/deactivate', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const itemId    = parseInt(req.params.id);
  if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item ID' });

  const { data: existing } = await supabase.from('accounting_items').select('id')
    .eq('id', itemId).eq('company_id', companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  try {
    const { data: item, error } = await supabase
      .from('accounting_items')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', itemId).eq('company_id', companyId)
      .select().single();
    if (error) throw new Error(error.message);
    res.json({ item });
  } catch (err) {
    console.error('PATCH /accounting/items/:id/deactivate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Activate Item ────────────────────────────────────────────────────────────

router.patch('/:id/activate', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const itemId    = parseInt(req.params.id);
  if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item ID' });

  const { data: existing } = await supabase.from('accounting_items').select('id')
    .eq('id', itemId).eq('company_id', companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  try {
    const { data: item, error } = await supabase
      .from('accounting_items')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', itemId).eq('company_id', companyId)
      .select().single();
    if (error) throw new Error(error.message);
    res.json({ item });
  } catch (err) {
    console.error('PATCH /accounting/items/:id/activate error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
