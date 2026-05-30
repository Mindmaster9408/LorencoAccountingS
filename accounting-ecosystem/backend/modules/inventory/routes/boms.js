/**
 * ============================================================================
 * Bill of Materials (BOM) Routes
 * ============================================================================
 * Endpoints:
 *   GET    /boms               — list BOMs for company (with item name)
 *   GET    /boms/:id           — get single BOM with all lines
 *   POST   /boms               — create BOM header + lines
 *   PUT    /boms/:id           — update BOM header + replace lines
 *   DELETE /boms/:id           — soft-deactivate (set status=inactive)
 *   POST   /boms/:id/activate  — set status=active (deactivates other versions of same item)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const { getIssueCostFromItemData } = require('../services/costingService');
const { convertToBaseUnit } = require('../services/uomService');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();

/**
 * Resolve a BOM line's base_qty from its input_unit/input_qty.
 * If input_unit is provided and differs from the item's base_unit,
 * looks up the conversion and returns the converted qty.
 * Falls back to the raw quantity (backward compatible).
 *
 * @param {number} qty          Raw quantity as entered
 * @param {string|null} inputUnit  Unit the qty is expressed in
 * @param {number} itemId
 * @param {number} companyId
 * @returns {Promise<{baseQty: number, conversionApplied: boolean}>}
 */
async function resolveBomLineBaseQty(qty, inputUnit, itemId, companyId) {
  if (!inputUnit) {
    return { baseQty: qty, conversionApplied: false };
  }
  try {
    const { baseQty } = await convertToBaseUnit(supabase, companyId, itemId, qty, inputUnit);
    return { baseQty, conversionApplied: true };
  } catch {
    // Conversion not defined — store qty as-is, flag for follow-up
    return { baseQty: qty, conversionApplied: false };
  }
}

// ─── List BOMs ────────────────────────────────────────────────────────────────
router.get('/', requirePerm(PERM.VIEW), async (req, res) => {
  const { item_id, status } = req.query;
  let q = supabase
    .from('bom_headers')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (item_id) q = q.eq('item_id', parseInt(item_id));
  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ boms: data || [] });
});

// ─── Get single BOM with lines ────────────────────────────────────────────────
router.get('/:id', requirePerm(PERM.VIEW), async (req, res) => {
  const { data: header, error: hErr } = await supabase
    .from('bom_headers')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (hErr || !header) return res.status(404).json({ error: 'BOM not found' });

  const { data: lines, error: lErr } = await supabase
    .from('bom_lines')
    .select('*, inventory_items:item_id(name, sku, unit, item_type, current_stock)')
    .eq('bom_id', header.id)
    .order('sort_order');

  if (lErr) return res.status(500).json({ error: lErr.message });

  res.json({ bom: { ...header, lines: lines || [] } });
});

// ─── Create BOM ───────────────────────────────────────────────────────────────
router.post('/', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const { item_id, name, version, output_qty, scrap_percent, notes, lines } = req.body;

  if (!item_id) return res.status(400).json({ error: 'item_id is required' });
  if (!name)    return res.status(400).json({ error: 'BOM name is required' });

  // Verify item belongs to this company
  const { data: item } = await supabase
    .from('inventory_items')
    .select('id')
    .eq('id', parseInt(item_id))
    .eq('company_id', req.companyId)
    .single();
  if (!item) return res.status(400).json({ error: 'Item not found' });

  const { data: header, error: hErr } = await supabase
    .from('bom_headers')
    .insert({
      company_id:    req.companyId,
      item_id:       parseInt(item_id),
      name,
      version:       version || '1.0',
      status:        'draft',
      output_qty:    parseFloat(output_qty) || 1,
      scrap_percent: parseFloat(scrap_percent) || 0,
      notes:         notes || null,
      created_by:    req.user.userId
    })
    .select().single();

  if (hErr) return res.status(500).json({ error: hErr.message });

  // Insert lines (Codebox 10: resolve input_unit → base_qty)
  if (Array.isArray(lines) && lines.length > 0) {
    const lineRows = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (!l.item_id || !l.quantity) {
        await supabase.from('bom_headers').delete().eq('id', header.id);
        return res.status(400).json({ error: `Line ${idx + 1}: item_id and quantity are required` });
      }
      const rawQty = parseFloat(l.quantity);
      const inputUnit = l.input_unit || null;
      const { baseQty } = await resolveBomLineBaseQty(rawQty, inputUnit, parseInt(l.item_id), req.companyId);
      lineRows.push({
        bom_id:        header.id,
        item_id:       parseInt(l.item_id),
        quantity:      rawQty,           // raw entry qty (in input_unit or base_unit)
        input_unit:    inputUnit,        // unit the recipe quantity is expressed in
        input_qty:     rawQty,           // same as quantity — explicit for clarity
        base_qty:      baseQty,          // converted to item base_unit (for costing)
        scrap_percent: parseFloat(l.scrap_percent) || 0,
        notes:         l.notes || null,
        sort_order:    l.sort_order !== undefined ? parseInt(l.sort_order) : idx
      });
    }

    const { error: lErr } = await supabase.from('bom_lines').insert(lineRows);
    if (lErr) {
      await supabase.from('bom_headers').delete().eq('id', header.id);
      return res.status(500).json({ error: 'Failed to save BOM lines: ' + lErr.message });
    }
  }

  await auditFromReq(req, 'CREATE', 'bom_header', header.id, { module: 'inventory' });
  res.status(201).json({ bom: header });
});

// ─── Update BOM header + replace lines ───────────────────────────────────────
router.put('/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const { name, version, output_qty, scrap_percent, notes, lines } = req.body;

  // Verify ownership
  const { data: existing } = await supabase
    .from('bom_headers')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'BOM not found' });
  if (existing.status === 'active') {
    return res.status(400).json({ error: 'Cannot edit an active BOM. Deactivate it first.' });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (name !== undefined)          updates.name = name;
  if (version !== undefined)       updates.version = version;
  if (output_qty !== undefined)    updates.output_qty = parseFloat(output_qty);
  if (scrap_percent !== undefined) updates.scrap_percent = parseFloat(scrap_percent);
  if (notes !== undefined)         updates.notes = notes;

  const { data: header, error: hErr } = await supabase
    .from('bom_headers')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (hErr) return res.status(500).json({ error: hErr.message });

  // Replace lines if provided (Codebox 10: resolve input_unit → base_qty)
  if (Array.isArray(lines)) {
    await supabase.from('bom_lines').delete().eq('bom_id', header.id);

    if (lines.length > 0) {
      const lineRows = [];
      for (let idx = 0; idx < lines.length; idx++) {
        const l = lines[idx];
        const rawQty = parseFloat(l.quantity);
        const inputUnit = l.input_unit || null;
        const { baseQty } = await resolveBomLineBaseQty(rawQty, inputUnit, parseInt(l.item_id), req.companyId);
        lineRows.push({
          bom_id:        header.id,
          item_id:       parseInt(l.item_id),
          quantity:      rawQty,
          input_unit:    inputUnit,
          input_qty:     rawQty,
          base_qty:      baseQty,
          scrap_percent: parseFloat(l.scrap_percent) || 0,
          notes:         l.notes || null,
          sort_order:    l.sort_order !== undefined ? parseInt(l.sort_order) : idx
        });
      }
      const { error: lErr } = await supabase.from('bom_lines').insert(lineRows);
      if (lErr) return res.status(500).json({ error: 'Failed to save BOM lines: ' + lErr.message });
    }
  }

  await auditFromReq(req, 'UPDATE', 'bom_header', header.id, { module: 'inventory' });
  res.json({ bom: header });
});

// ─── Activate BOM (one active per item) ──────────────────────────────────────
router.post('/:id/activate', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const { data: bom } = await supabase
    .from('bom_headers')
    .select('id, item_id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!bom) return res.status(404).json({ error: 'BOM not found' });

  // Deactivate all other active BOMs for the same item
  await supabase
    .from('bom_headers')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('company_id', req.companyId)
    .eq('item_id', bom.item_id)
    .eq('status', 'active')
    .neq('id', bom.id);

  const { data, error } = await supabase
    .from('bom_headers')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', bom.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'bom_header', bom.id, { module: 'inventory', metadata: { action: 'activate' } });
  res.json({ bom: data });
});

// ─── BOM cost summary ────────────────────────────────────────────────────────
router.get('/:id/cost-summary', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const { data: header, error: hErr } = await supabase
    .from('bom_headers')
    .select('*, inventory_items:item_id(name, sku, unit, item_type)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (hErr || !header) return res.status(404).json({ error: 'BOM not found' });

  const { data: lines, error: lErr } = await supabase
    .from('bom_lines')
    .select('*, inventory_items:item_id(name, sku, unit, item_type, current_stock, average_cost, last_purchase_cost, standard_cost, cost_price, costing_method)')
    .eq('bom_id', header.id)
    .order('sort_order');

  if (lErr) return res.status(500).json({ error: lErr.message });

  const componentLines = (lines || []).map(line => {
    // Costing uses base_qty when available (Codebox 10: UOM conversion applied).
    // Falls back to quantity for lines without input_unit (backward compatible).
    const { issueCost: unitCost } = getIssueCostFromItemData(line.inventory_items);
    const costingQty   = parseFloat(line.base_qty ?? line.quantity) || 0;
    const estimatedCost = unitCost == null ? null : costingQty * unitCost;

    return {
      id:             line.id,
      item_id:        line.item_id,
      item_name:      line.inventory_items?.name || 'Unknown',
      sku:            line.inventory_items?.sku  || null,
      unit:           line.inventory_items?.unit || null,
      base_unit:      line.inventory_items?.base_unit || line.inventory_items?.unit || null,
      item_type:      line.inventory_items?.item_type || null,
      // Recipe entry (what the user typed)
      quantity:       parseFloat(line.quantity) || 0,
      input_unit:     line.input_unit || null,
      input_qty:      parseFloat(line.input_qty ?? line.quantity) || 0,
      // Costing qty — always in item base unit
      base_qty:       parseFloat(line.base_qty ?? line.quantity) || 0,
      scrap_percent:  parseFloat(line.scrap_percent) || 0,
      unit_cost:      unitCost,
      estimated_cost: estimatedCost,
      cost_missing:   unitCost == null,
      current_stock:  parseFloat(line.inventory_items?.current_stock) || 0
    };
  });

  const totalRecipeCost = componentLines.reduce((sum, line) => sum + (parseFloat(line.estimated_cost) || 0), 0);
  const outputQty = parseFloat(header.output_qty) || 1;

  res.json({
    bom: {
      id:                       header.id,
      name:                     header.name,
      version:                  header.version,
      status:                   header.status,
      item:                     header.inventory_items,
      output_qty:               outputQty,
      total_recipe_cost:        totalRecipeCost,
      estimated_cost_per_unit:  outputQty > 0 ? totalRecipeCost / outputQty : null,
      missing_cost:             componentLines.some(line => line.cost_missing),
      uom_conversions_applied:  componentLines.some(line => line.input_unit != null),
      lines:                    componentLines
    }
  });
});

// ─── Deactivate / soft-delete BOM ────────────────────────────────────────────
router.delete('/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  // Check no active work orders reference this BOM
  const { count } = await supabase
    .from('work_orders')
    .select('id', { count: 'exact', head: true })
    .eq('bom_id', req.params.id)
    .in('status', ['released', 'in_progress']);

  if (count > 0) {
    return res.status(400).json({ error: 'Cannot deactivate BOM with open work orders referencing it.' });
  }

  const { error } = await supabase
    .from('bom_headers')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'DELETE', 'bom_header', req.params.id, { module: 'inventory' });
  res.json({ success: true });
});

module.exports = router;
