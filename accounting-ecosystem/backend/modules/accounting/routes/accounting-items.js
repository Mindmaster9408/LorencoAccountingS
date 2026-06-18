/**
 * ============================================================================
 * Accounting Items / Service Master Routes
 * ============================================================================
 * Mounted at /api/accounting/items
 *
 * Provides a lightweight item/service catalogue for invoice line selection.
 * Scope: company-isolated, no stock tracking.
 *
 * Routes:
 *   GET  /          — list active items for the company (for dropdowns)
 *   POST /          — create a new item
 * ============================================================================
 */

const express  = require('express');
const router   = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

// ─── List Items ───────────────────────────────────────────────────────────────
// Returns active items only — used to populate the invoice line item selector.

router.get('/', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  try {
    const { data, error } = await supabase
      .from('accounting_items')
      .select('id, item_code, item_name, item_type, description, selling_price, income_account_id, tax_type, is_active')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('item_name');
    if (error) throw new Error(error.message);
    res.json({ items: data || [] });
  } catch (err) {
    console.error('GET /accounting/items error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Item ──────────────────────────────────────────────────────────────
// Validates company ownership of income_account_id before insert.
// item_code is unique per company when provided (enforced by DB unique index).

router.post('/', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { itemCode, itemName, itemType, description, sellingPrice, incomeAccountId, taxType } = req.body;

  if (!itemName?.trim()) {
    return res.status(400).json({ error: 'Item name is required' });
  }

  const validTypes = ['service', 'inventory', 'non_stock'];
  if (itemType && !validTypes.includes(itemType)) {
    return res.status(400).json({ error: `Invalid item type. Must be one of: ${validTypes.join(', ')}` });
  }

  const validTaxTypes = ['standard', 'zero_rated', 'exempt'];
  if (taxType && !validTaxTypes.includes(taxType)) {
    return res.status(400).json({ error: `Invalid tax type. Must be one of: ${validTaxTypes.join(', ')}` });
  }

  // income_account_id must belong to this company
  if (incomeAccountId) {
    const { data: acct } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', parseInt(incomeAccountId))
      .eq('company_id', companyId)
      .maybeSingle();
    if (!acct) {
      return res.status(403).json({
        error: 'Income account not found or does not belong to this company',
        errorCode: 'ACCOUNT_TENANT_VIOLATION',
      });
    }
  }

  // item_code uniqueness per company (pre-check for a clear error message)
  if (itemCode?.trim()) {
    const { data: dup } = await supabase
      .from('accounting_items')
      .select('id')
      .eq('company_id', companyId)
      .eq('item_code', itemCode.trim())
      .maybeSingle();
    if (dup) {
      return res.status(409).json({
        error: `Item code '${itemCode.trim()}' already exists for this company`,
        errorCode: 'DUPLICATE_ITEM_CODE',
      });
    }
  }

  try {
    const { data: item, error } = await supabase
      .from('accounting_items')
      .insert({
        company_id:        companyId,
        item_code:         itemCode?.trim() || null,
        item_name:         itemName.trim(),
        item_type:         itemType || 'service',
        description:       description?.trim() || null,
        selling_price:     sellingPrice != null ? parseFloat(sellingPrice) : null,
        income_account_id: incomeAccountId ? parseInt(incomeAccountId) : null,
        tax_type:          taxType || 'standard',
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

module.exports = router;
