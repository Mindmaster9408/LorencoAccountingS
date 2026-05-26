'use strict';
// ============================================================================
// procurementService.js — Lorenco Storehouse Procurement Intelligence
// Codebox 05 — Purchasing & Supplier Procurement
// ============================================================================
// Provides:
//   1. generateReorderRecommendations — items at/below min_stock
//   2. generateShortageRecommendations — items with open shortage requirements
//   3. getPreferredSupplier — best supplier per item (by flag, cost, recency)
//   4. updateSupplierItemHistory — called after every successful receipt
//
// NEVER call adjustStockTx() from here. Stock mutations are in the routes.
// All queries must include company_id for multi-tenant isolation.
// ============================================================================

/**
 * Generate reorder recommendations for items at or below their min_stock level.
 *
 * Logic:
 *  - Fetch all active items where current_stock <= min_stock (and min_stock > 0)
 *  - Subtract active reservations (from reservations table) to get available_stock
 *  - Subtract open PO quantities (draft/approved/ordered) to avoid duplication
 *  - Recommend: max_stock - current_stock, with preferred supplier per item
 *
 * @param {object} supabase  — Supabase client instance
 * @param {number} companyId — Company scope
 * @returns {Array<ReorderRecommendation>}
 */
async function generateReorderRecommendations(supabase, companyId) {
  // 1. Items at or below min_stock (with stock > 0 excluded from noise)
  const { data: items, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, min_stock, cost_price, warehouse_id')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .gt('min_stock', 0)
    .filter('current_stock', 'lte', 'min_stock');

  if (itemErr) throw itemErr;
  if (!items || !items.length) return [];

  const itemIds = items.map(i => i.id);

  // 2. Active reservations per item
  const { data: reservations, error: resErr } = await supabase
    .from('reservations')
    .select('item_id, quantity')
    .eq('company_id', companyId)
    .in('status', ['confirmed', 'pending'])
    .in('item_id', itemIds);
  if (resErr) throw resErr;

  // 3. Open PO quantities already on order (draft/approved/ordered)
  const { data: openLines, error: lineErr } = await supabase
    .from('purchase_order_items')
    .select('item_id, quantity, received_qty, purchase_orders!po_id(status, company_id)')
    .in('item_id', itemIds);
  if (lineErr) throw lineErr;

  // Build lookup maps
  const reservedQtyMap = {};
  (reservations || []).forEach(r => {
    reservedQtyMap[r.item_id] = (reservedQtyMap[r.item_id] || 0) + parseFloat(r.quantity || 0);
  });

  const onOrderMap = {};
  (openLines || []).forEach(l => {
    const po = l.purchase_orders;
    if (!po || po.company_id !== companyId) return;
    if (!['draft', 'approved', 'ordered', 'partial_receipt'].includes(po.status)) return;
    const outstanding = parseFloat(l.quantity || 0) - parseFloat(l.received_qty || 0);
    if (outstanding > 0) {
      onOrderMap[l.item_id] = (onOrderMap[l.item_id] || 0) + outstanding;
    }
  });

  // 4. Build recommendations
  const recs = [];
  for (const item of items) {
    const reserved  = reservedQtyMap[item.id] || 0;
    const onOrder   = onOrderMap[item.id] || 0;
    const available = parseFloat(item.current_stock || 0) - reserved;
    const netNeed   = parseFloat(item.min_stock || 0) - available - onOrder;

    if (netNeed <= 0) continue; // already covered by stock + open POs

    // Target = reorder to 2x min_stock (simple logic; can be expanded with max_stock)
    const recommendedQty = Math.max(netNeed, parseFloat(item.min_stock || 0));

    const supplier = await getPreferredSupplier(supabase, companyId, item.id);

    recs.push({
      item_id:         item.id,
      item_name:       item.name,
      sku:             item.sku || null,
      unit:            item.unit || 'each',
      current_stock:   parseFloat(item.current_stock || 0),
      reserved_qty:    reserved,
      available_stock: available,
      on_order_qty:    onOrder,
      min_stock:       parseFloat(item.min_stock || 0),
      recommended_qty: Math.ceil(recommendedQty * 100) / 100,
      reason:          'below_min_stock',
      last_cost:       supplier ? supplier.last_purchase_cost : (item.cost_price || null),
      preferred_supplier_id:   supplier ? supplier.supplier_id   : null,
      preferred_supplier_name: supplier ? supplier.supplier_name : null,
    });
  }

  return recs;
}


/**
 * Generate shortage-driven procurement recommendations.
 * Items with unfulfilled shortage from open work orders + shortages.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @returns {Array<ShortageRecommendation>}
 */
async function generateShortageRecommendations(supabase, companyId) {
  // Fetch open work order materials that don't have enough stock
  const { data: woMaterials, error: woErr } = await supabase
    .from('work_order_materials')
    .select(`
      id, item_id, quantity_required, quantity_issued,
      work_orders!work_order_id(id, wo_number, status, company_id)
    `)
    .in('work_orders.status', ['released', 'in_progress'])
    .eq('work_orders.company_id', companyId);

  if (woErr) throw woErr;

  if (!woMaterials || !woMaterials.length) return [];

  const itemIds = [...new Set(woMaterials.map(m => m.item_id).filter(Boolean))];
  if (!itemIds.length) return [];

  // Fetch current stock for these items
  const { data: items, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, cost_price')
    .eq('company_id', companyId)
    .in('id', itemIds);
  if (itemErr) throw itemErr;

  const itemMap = {};
  (items || []).forEach(i => { itemMap[i.id] = i; });

  // Aggregate shortage by item
  const shortageMap = {};
  for (const m of woMaterials) {
    const wo = m.work_orders;
    if (!wo || wo.company_id !== companyId) continue;
    if (!['released', 'in_progress'].includes(wo.status)) continue;

    const shortfall = parseFloat(m.quantity_required || 0) - parseFloat(m.quantity_issued || 0);
    if (shortfall <= 0) continue;

    const item = itemMap[m.item_id];
    if (!item) continue;

    const available = parseFloat(item.current_stock || 0);
    const net = shortfall - available;
    if (net <= 0) continue; // stock covers it

    if (!shortageMap[m.item_id]) {
      shortageMap[m.item_id] = {
        item_id:   m.item_id,
        item_name: item.name,
        sku:       item.sku || null,
        unit:      item.unit || 'each',
        current_stock: available,
        total_shortfall: 0,
        work_orders: [],
      };
    }
    shortageMap[m.item_id].total_shortfall += net;
    shortageMap[m.item_id].work_orders.push({
      wo_id:     wo.id,
      wo_number: wo.wo_number,
      shortfall: Math.ceil(net * 1000) / 1000,
    });
  }

  const recs = [];
  for (const itemId of Object.keys(shortageMap)) {
    const s = shortageMap[itemId];
    const item = itemMap[itemId];
    const supplier = await getPreferredSupplier(supabase, companyId, parseInt(itemId));
    recs.push({
      ...s,
      recommended_qty:         Math.ceil(s.total_shortfall * 100) / 100,
      reason:                  'work_order_shortage',
      last_cost:               supplier ? supplier.last_purchase_cost : (item ? item.cost_price : null),
      preferred_supplier_id:   supplier ? supplier.supplier_id   : null,
      preferred_supplier_name: supplier ? supplier.supplier_name : null,
    });
  }

  return recs;
}


/**
 * Get the preferred supplier for a given item.
 *
 * Priority:
 *   1. Explicit preferred_supplier = true in supplier_item_history
 *   2. Lowest last_purchase_cost (most recent data)
 *   3. Most recent last_purchase_date (recency as tiebreaker)
 *
 * Returns null if no supplier history exists.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @returns {object|null}
 */
async function getPreferredSupplier(supabase, companyId, itemId) {
  const { data, error } = await supabase
    .from('supplier_item_history')
    .select(`
      id, supplier_id, item_id,
      last_purchase_cost, average_supplier_cost,
      last_purchase_date, lead_time_days,
      preferred_supplier, purchase_count,
      suppliers!supplier_id(id, name, is_active)
    `)
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .order('preferred_supplier', { ascending: false })
    .order('last_purchase_cost', { ascending: true })
    .order('last_purchase_date', { ascending: false })
    .limit(1);

  if (error || !data || !data.length) return null;

  const row = data[0];
  const sup = row.suppliers;
  if (!sup || !sup.is_active) return null;

  return {
    supplier_id:          row.supplier_id,
    supplier_name:        sup.name,
    last_purchase_cost:   row.last_purchase_cost,
    average_supplier_cost:row.average_supplier_cost,
    lead_time_days:       row.lead_time_days || 0,
    preferred_supplier:   row.preferred_supplier,
    purchase_count:       row.purchase_count,
  };
}


/**
 * Update (or create) supplier_item_history after a successful receipt.
 *
 * Called ONLY from the receive route, AFTER adjustStockTx has succeeded.
 * Computes a running weighted average cost across all receipts.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} supplierId
 * @param {number} itemId
 * @param {number} receivedQty
 * @param {number} unitCost
 * @param {number} poId
 */
async function updateSupplierItemHistory(supabase, companyId, supplierId, itemId, receivedQty, unitCost, poId) {
  if (!supplierId || !itemId || receivedQty <= 0) return;

  // Fetch existing row
  const { data: existing } = await supabase
    .from('supplier_item_history')
    .select('*')
    .eq('company_id', companyId)
    .eq('supplier_id', supplierId)
    .eq('item_id', itemId)
    .maybeSingle();

  const now = new Date().toISOString();

  if (!existing) {
    // First receipt from this supplier for this item
    await supabase
      .from('supplier_item_history')
      .insert({
        company_id:            companyId,
        supplier_id:           supplierId,
        item_id:               itemId,
        last_purchase_cost:    unitCost,
        average_supplier_cost: unitCost,
        last_purchase_date:    now,
        last_po_id:            poId,
        last_received_qty:     receivedQty,
        purchase_count:        1,
        updated_at:            now,
      });
  } else {
    // Update with running weighted average
    const prevCount = existing.purchase_count || 0;
    const prevAvg   = parseFloat(existing.average_supplier_cost || unitCost);
    // Weighted average: (prev_total + new_total) / (prev_count + 1)
    // Using purchase_count as receipt event count (not qty weighted)
    const newAvg = ((prevAvg * prevCount) + unitCost) / (prevCount + 1);

    await supabase
      .from('supplier_item_history')
      .update({
        last_purchase_cost:    unitCost,
        average_supplier_cost: Math.round(newAvg * 10000) / 10000,
        last_purchase_date:    now,
        last_po_id:            poId,
        last_received_qty:     receivedQty,
        purchase_count:        prevCount + 1,
        updated_at:            now,
      })
      .eq('company_id', companyId)
      .eq('supplier_id', supplierId)
      .eq('item_id', itemId);
  }
}


module.exports = {
  generateReorderRecommendations,
  generateShortageRecommendations,
  getPreferredSupplier,
  updateSupplierItemHistory,
};
