/**
 * ============================================================================
 * POS Inventory Routes - Checkout Charlie Module
 * ============================================================================
 * Stock level queries and manual adjustments.
 *
 * Table used for adjustments: inventory_adjustments
 *   (created by pos-schema.js auto-migration on startup)
 *
 * Column names match the products schema:
 *   product_name, unit_price, min_stock_level
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { getStockPolicy } = require('../services/stockPolicyCache');
const { adjustStockCAS } = require('../services/stockCAS');

const RETURN_REASONS = new Set(['damaged', 'expired', 'wrong_item', 'over_supplied', 'credit_requested', 'supplier_collection', 'other']);

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/inventory
 * Get stock levels for all products, optionally filtered to low-stock items.
 */
router.get('/', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { low_stock } = req.query;

    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, barcode, product_code, stock_quantity, min_stock_level, cost_price, unit_price, category_id, category, categories(name)')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('product_name');

    if (error) return res.status(500).json({ error: error.message });

    let products = data || [];
    if (low_stock === 'true') {
      products = products.filter(p => p.stock_quantity <= (p.min_stock_level ?? 10));
    }

    res.json({ inventory: products });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/inventory/adjust
 * Manual stock adjustment — records to inventory_adjustments table.
 */
router.post('/adjust', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { product_id, quantity_change, reason, notes } = req.body;

    if (!product_id || quantity_change === undefined) {
      return res.status(400).json({ error: 'product_id and quantity_change are required' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason is required for stock adjustments' });
    }

    // Get current stock — must belong to this company. Only used to compute
    // the clamped delta below; the actual write is guarded by adjustStockCAS
    // so a concurrent change between this read and that write (e.g. this
    // adjustment racing a sale, or another manual adjustment on the same
    // product) fails the write cleanly instead of silently dropping one of
    // the two changes — the same primitive already used by
    // company-transfers.js/purchase-orders.js for this exact reason.
    const { data: product } = await supabase
      .from('products')
      .select('stock_quantity, product_name')
      .eq('id', product_id)
      .eq('company_id', req.companyId)
      .single();

    if (!product) return res.status(404).json({ error: 'Product not found' });

    // This route's contract is "clamp to zero, never reject" — compute the
    // clamped delta up front so adjustStockCAS is asked to make exactly the
    // change this route has always promised, not a raw negative overshoot.
    const currentQty = parseFloat(product.stock_quantity || 0);
    const clampedChange = Math.max(-currentQty, quantity_change);

    const result = await adjustStockCAS(req.companyId, product_id, clampedChange, { allowNegative: true });
    if (!result.ok) {
      return res.status(409).json({ error: 'Stock changed concurrently — please retry', detail: result.error });
    }

    const oldQty = result.oldQty;
    const newQty = result.newQty;

    // Record adjustment in inventory_adjustments
    // (table created by pos-schema.js migration)
    const { data: adj, error: adjErr } = await supabase
      .from('inventory_adjustments')
      .insert({
        company_id:      req.companyId,
        product_id,
        adjusted_by:     req.user.userId,
        quantity_before: oldQty,
        quantity_change,
        quantity_after:  newQty,
        reason:          reason || 'manual',
        notes:           notes || null,
      })
      .select()
      .single();

    if (adjErr) return res.status(500).json({ error: adjErr.message });

    await auditFromReq(req, 'UPDATE', 'inventory', product_id, {
      module:    'pos',
      fieldName: 'stock_quantity',
      oldValue:  oldQty,
      newValue:  newQty,
      metadata:  { product_name: product.product_name, reason }
    });
    posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
      productId:      product_id,
      beforeSnapshot: { stock_quantity: oldQty },
      afterSnapshot:  { stock_quantity: newQty },
      metadata:       {
        product_name:     product.product_name,
        quantity_change,
        reason,
        adjustment_id:    adj.id,
        notes:            notes || null,
      },
    });

    res.json({ adjustment: adj });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/inventory/adjustments
 * List stock adjustment history for this company.
 */
router.get('/adjustments', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inventory_adjustments')
      .select('*, products(product_name, barcode)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ adjustments: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/inventory/return
 * Return stock to a supplier — reduces stock. Guards against returning more
 * than is on hand unless the company's negative-stock policy allows it or the
 * requester explicitly sets override:true (route is already management-only).
 *
 * Body: { supplier_name, supplier_id, reference, notes, override, items:
 *   [{ product_id, quantity, unit_cost, reason, notes }] }
 *
 * Zero/blank-quantity rows are skipped, matching the receive flow.
 * All lines are validated (existence + stock) before anything is written, so
 * a return either applies in full or not at all — no partial stock reduction
 * from a request that was going to fail partway through.
 */
router.post('/return', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { supplier_name, supplier_id, reference, notes, override, items } = req.body;
    if (!supplier_name) return res.status(400).json({ error: 'supplier_name is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const lines = items
      .map(i => ({
        product_id: parseInt(i.product_id),
        quantity:   parseInt(i.quantity),
        unit_cost:  i.unit_cost != null && i.unit_cost !== '' ? parseFloat(i.unit_cost) : null,
        reason:     RETURN_REASONS.has(i.reason) ? i.reason : 'other',
        notes:      i.notes ? String(i.notes).trim() : null,
      }))
      .filter(l => l.product_id > 0 && l.quantity > 0);

    if (lines.length === 0) return res.status(400).json({ error: 'No items with a quantity greater than zero' });

    const productIds = lines.map(l => l.product_id);
    const { data: dbProducts, error: prodErr } = await supabase
      .from('products')
      .select('id, product_name, stock_quantity')
      .eq('company_id', req.companyId)
      .in('id', productIds);
    if (prodErr) return res.status(500).json({ error: prodErr.message });

    const byId = new Map((dbProducts || []).map(p => [p.id, p]));
    const missing = productIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Product IDs not found for this company: ${missing.join(', ')}` });
    }

    const allowNegative = await getStockPolicy(req.companyId, supabase);
    const bypassGuard = allowNegative || override === true;

    if (!bypassGuard) {
      const exceeding = lines
        .map(l => ({ ...l, product: byId.get(l.product_id) }))
        .filter(l => l.quantity > parseFloat(l.product.stock_quantity || 0));
      if (exceeding.length > 0) {
        return res.status(400).json({
          error: 'Return quantity exceeds current stock for one or more products',
          exceeding: exceeding.map(l => ({ product_id: l.product_id, product_name: l.product.product_name, requested: l.quantity, current_stock: l.product.stock_quantity })),
        });
      }
    }

    const totalQty   = lines.reduce((sum, l) => sum + l.quantity, 0);
    const totalValue = lines.reduce((sum, l) => sum + (l.unit_cost != null ? l.unit_cost * l.quantity : 0), 0);

    const { data: ret, error: retErr } = await supabase
      .from('pos_supplier_returns')
      .insert({
        company_id:     req.companyId,
        supplier_id:    supplier_id ? parseInt(supplier_id) : null,
        supplier_name,
        reference:      reference || null,
        notes:          notes || null,
        item_count:     lines.length,
        total_quantity: totalQty,
        total_value:    totalValue,
        returned_by:    req.user.userId,
      })
      .select().single();
    if (retErr) return res.status(500).json({ error: retErr.message });

    const processedItems = [];

    for (const line of lines) {
      const product = byId.get(line.product_id);
      // Clamp computed from the pre-loop snapshot (line 192) — same
      // upfront-validation UX as before. The actual write below is guarded by
      // adjustStockCAS so a concurrent change (a sale, another adjustment)
      // between that snapshot and this write fails cleanly instead of
      // silently dropping one of the two changes.
      const snapshotQty   = parseFloat(product.stock_quantity || 0);
      const clampedChange = bypassGuard ? -line.quantity : -Math.min(line.quantity, snapshotQty);

      const result = await adjustStockCAS(req.companyId, line.product_id, clampedChange, { allowNegative: true });
      if (!result.ok) {
        // Rare mid-request race on one line — log and fall back to the
        // pre-loop snapshot so the rest of this return can still be recorded
        // truthfully rather than aborting a return that's already partially
        // applied (matches the "best effort" pattern used for multi-line
        // stock moves in company-transfers.js/purchase-orders.js).
        console.error('[inventory] return: stock decrement failed for product', line.product_id, result.error);
      }
      const oldQty = result.ok ? result.oldQty : snapshotQty;
      const newQty = result.ok ? result.newQty : snapshotQty + clampedChange;

      await supabase.from('pos_supplier_return_items').insert({
        return_id: ret.id, company_id: req.companyId, product_id: line.product_id,
        quantity: line.quantity, unit_cost: line.unit_cost, reason: line.reason,
        qty_before: oldQty, qty_after: newQty,
      });

      await supabase.from('inventory_adjustments').insert({
        company_id: req.companyId, product_id: line.product_id, adjusted_by: req.user.userId,
        quantity_before: oldQty, quantity_change: -line.quantity, quantity_after: newQty,
        reason: 'supplier_return',
        notes: `Return #${ret.id}: ${supplier_name} (${line.reason})${reference ? ' / ' + reference : ''}`,
      });

      posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
        productId: line.product_id,
        beforeSnapshot: { stock_quantity: oldQty },
        afterSnapshot:  { stock_quantity: newQty },
        metadata: { product_name: product.product_name, quantity_change: -line.quantity, reason: 'supplier_return', return_id: ret.id, supplier_name, return_reason: line.reason },
      });

      processedItems.push({ product_id: line.product_id, product_name: product.product_name, quantity: line.quantity, qty_before: oldQty, qty_after: newQty, reason: line.reason });
    }

    posAuditFromReq(req, POS_EVENTS.SUPPLIER_RETURN_COMPLETED, {
      metadata: { return_id: ret.id, supplier_name, reference: reference || null, item_count: lines.length, total_quantity: totalQty, total_value: totalValue, stock_override_used: bypassGuard && !allowNegative },
    });

    res.json({ return: { ...ret, items: processedItems } });
  } catch (err) {
    console.error('[inventory] return:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/inventory/returns
 */
router.get('/returns', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pos_supplier_returns')
      .select('*, users:returned_by(username, full_name)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ returns: data || [] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Workstream 7A: Retail inventory operations ────────────────────────────────

const TRANSFER_LOCATIONS = new Set(['floor', 'backroom', 'wastage', 'spoilage']);
const STOCK_REDUCING_DESTINATIONS = new Set(['wastage', 'spoilage']);

/**
 * POST /api/pos/inventory/stock-take
 * Create a stock take session and apply variances immediately.
 * Items with no counted_qty are skipped.
 */
router.post('/stock-take', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { notes, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }
    for (const item of items) {
      if (!item.product_id || item.counted_qty == null) {
        return res.status(400).json({ error: 'Each item requires product_id and counted_qty' });
      }
    }

    const { data: stockTake, error: takeErr } = await supabase
      .from('pos_stock_takes')
      .insert({ company_id: req.companyId, conducted_by: req.user.userId, notes: notes || null, product_count: items.length })
      .select().single();
    if (takeErr) return res.status(500).json({ error: takeErr.message });

    const processedItems = [];
    let varianceCount = 0;

    for (const item of items) {
      const pid = parseInt(item.product_id);
      const countedQty = parseFloat(item.counted_qty);
      const { data: product } = await supabase
        .from('products').select('stock_quantity, product_name')
        .eq('id', pid).eq('company_id', req.companyId).single();
      if (!product) continue;

      const systemQty = parseFloat(product.stock_quantity || 0);
      const variance  = countedQty - systemQty;

      if (variance !== 0) {
        varianceCount++;
        // A stock-take sets an ABSOLUTE counted value, not a relative delta,
        // so adjustStockCAS's delta-based guard doesn't fit here — same
        // compare-and-swap idea applied directly: only write if stock_quantity
        // still matches the value just read above, so a concurrent sale or
        // adjustment landing mid-request fails this write cleanly instead of
        // silently overwriting it with a stale count.
        const { data: casUpdated } = await supabase.from('products')
          .update({ stock_quantity: countedQty, updated_at: new Date().toISOString() })
          .eq('id', pid).eq('company_id', req.companyId).eq('stock_quantity', systemQty)
          .select().maybeSingle();
        if (!casUpdated) {
          console.error('[inventory] stock-take: concurrent stock change for product', pid, '— variance recorded against a stale system_qty');
        }

        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: pid, adjusted_by: req.user.userId,
          quantity_before: systemQty, quantity_change: variance, quantity_after: countedQty,
          reason: 'stock_take_variance', notes: `Stock take #${stockTake.id}`,
        });

        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
          productId: pid,
          beforeSnapshot: { stock_quantity: systemQty },
          afterSnapshot:  { stock_quantity: countedQty },
          metadata: { product_name: product.product_name, quantity_change: variance, reason: 'stock_take_variance', stock_take_id: stockTake.id },
        });
      }

      await supabase.from('pos_stock_take_items').insert({
        stock_take_id: stockTake.id, company_id: req.companyId, product_id: pid,
        system_qty: systemQty, counted_qty: countedQty, variance,
      });

      processedItems.push({ product_id: pid, product_name: product.product_name, system_qty: systemQty, counted_qty: countedQty, variance });
    }

    await supabase.from('pos_stock_takes').update({ variance_count: varianceCount }).eq('id', stockTake.id);

    posAuditFromReq(req, POS_EVENTS.STOCK_TAKE_COMPLETED, {
      metadata: { stock_take_id: stockTake.id, product_count: items.length, variance_count: varianceCount, notes: notes || null },
    });

    res.json({ stock_take: { ...stockTake, variance_count: varianceCount, items: processedItems } });
  } catch (err) {
    console.error('[inventory] stock-take:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/inventory/stock-takes
 */
router.get('/stock-takes', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pos_stock_takes')
      .select('*, users:conducted_by(username, full_name)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ stock_takes: data || [] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/**
 * POST /api/pos/inventory/receive
 * Lightweight supplier receive — increments stock.
 */
router.post('/receive', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { supplier_name, supplier_id, reference, notes, items } = req.body;
    if (!supplier_name) return res.status(400).json({ error: 'supplier_name is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const totalQty = items.reduce((sum, i) => sum + (parseInt(i.quantity) || 0), 0);
    const { data: receive, error: recErr } = await supabase
      .from('pos_supplier_receives')
      .insert({
        company_id:  req.companyId,
        supplier_name,
        supplier_id: supplier_id ? parseInt(supplier_id) : null,
        reference:   reference || null,
        notes:       notes || null,
        item_count:  items.length,
        total_quantity: totalQty,
        received_by: req.user.userId,
      })
      .select().single();
    if (recErr) return res.status(500).json({ error: recErr.message });

    const processedItems = [];

    for (const item of items) {
      const pid = parseInt(item.product_id);
      const qty = parseInt(item.quantity);
      if (!pid || !qty || qty <= 0) continue;

      const costPrice = item.cost_price ? parseFloat(item.cost_price) : null;

      // Compare-and-swap stock increment — a receive can legitimately land at
      // the same time as a sale decrementing the same product, and a naive
      // read-then-write here would silently drop whichever write lands
      // second. Same primitive as company-transfers.js/purchase-orders.js.
      const result = await adjustStockCAS(req.companyId, pid, qty, {});
      if (!result.ok) {
        console.error('[inventory] receive: stock increment failed for product', pid, result.error);
        continue;
      }
      const { product, oldQty, newQty } = result;

      if (costPrice !== null) {
        await supabase.from('products')
          .update({ cost_price: costPrice, updated_at: new Date().toISOString() })
          .eq('id', pid).eq('company_id', req.companyId);
      }

      await supabase.from('pos_supplier_receive_items').insert({
        receive_id: receive.id, company_id: req.companyId, product_id: pid,
        quantity: qty, cost_price: costPrice, qty_before: oldQty, qty_after: newQty,
      });

      await supabase.from('inventory_adjustments').insert({
        company_id: req.companyId, product_id: pid, adjusted_by: req.user.userId,
        quantity_before: oldQty, quantity_change: qty, quantity_after: newQty,
        reason: 'supplier_correction',
        notes: `Receive #${receive.id}: ${supplier_name}${reference ? ' / ' + reference : ''}`,
      });

      posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
        productId: pid,
        beforeSnapshot: { stock_quantity: oldQty },
        afterSnapshot:  { stock_quantity: newQty },
        metadata: { product_name: product.product_name, quantity_change: qty, reason: 'supplier_correction', receive_id: receive.id, supplier_name },
      });

      // Update per-supplier price tracking (Workstream 78) — only for products
      // explicitly linked to this supplier via product_suppliers. A receive
      // against an unlinked product/supplier pair leaves no price history,
      // since that link is what defines "this supplier's price" for the item.
      if (supplier_id && costPrice !== null) {
        const { data: link } = await supabase
          .from('product_suppliers')
          .select('id, last_purchase_price')
          .eq('company_id', req.companyId)
          .eq('supplier_id', parseInt(supplier_id))
          .eq('product_id', pid)
          .maybeSingle();

        if (link) {
          const previousPrice = link.last_purchase_price != null ? parseFloat(link.last_purchase_price) : null;

          await supabase.from('product_suppliers')
            .update({ last_purchase_price: costPrice, last_purchase_date: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', link.id);

          if (previousPrice !== null && costPrice > previousPrice) {
            posAuditFromReq(req, POS_EVENTS.SUPPLIER_PRICE_INCREASE_DETECTED, {
              productId: pid,
              beforeSnapshot: { price: previousPrice },
              afterSnapshot:  { price: costPrice },
              metadata: { product_name: product.product_name, supplier_id: parseInt(supplier_id), supplier_name, old_price: previousPrice, new_price: costPrice, receive_id: receive.id },
            });
          }
        }
      }

      processedItems.push({ product_id: pid, product_name: product.product_name, quantity: qty, qty_before: oldQty, qty_after: newQty });
    }

    posAuditFromReq(req, POS_EVENTS.SUPPLIER_RECEIVE_COMPLETED, {
      metadata: { receive_id: receive.id, supplier_name, reference: reference || null, item_count: items.length, total_quantity: totalQty },
    });

    res.json({ receive: { ...receive, items: processedItems } });
  } catch (err) {
    console.error('[inventory] receive:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/inventory/receives
 */
router.get('/receives', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pos_supplier_receives')
      .select('*, users:received_by(username, full_name)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ receives: data || [] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/**
 * POST /api/pos/inventory/transfer
 * Records retail movement. Wastage/spoilage reduce stock; floor/backroom moves are visibility-only.
 */
router.post('/transfer', requirePermission('INVENTORY.TRANSFER'), async (req, res) => {
  try {
    const { from_location, to_location, notes, items } = req.body;
    if (!TRANSFER_LOCATIONS.has(from_location) || !TRANSFER_LOCATIONS.has(to_location)) {
      return res.status(400).json({ error: `from_location and to_location must be one of: ${[...TRANSFER_LOCATIONS].join(', ')}` });
    }
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const affectsStock = STOCK_REDUCING_DESTINATIONS.has(to_location);

    const { data: transfer, error: txErr } = await supabase
      .from('pos_stock_transfers')
      .insert({
        company_id: req.companyId, from_location, to_location,
        notes: notes || null, item_count: items.length,
        affects_stock: affectsStock, transferred_by: req.user.userId,
      })
      .select().single();
    if (txErr) return res.status(500).json({ error: txErr.message });

    const processedItems = [];

    for (const item of items) {
      const pid = parseInt(item.product_id);
      const qty = parseInt(item.quantity);
      if (!pid || !qty || qty <= 0) continue;

      let product, oldQty, newQty;

      if (affectsStock) {
        // Compare-and-swap — a floor/backroom-to-wastage/spoilage transfer can
        // land at the same time as a sale on the same product; a naive
        // read-then-write here would silently drop whichever write lands
        // second. Same primitive as company-transfers.js/purchase-orders.js.
        const { data: dbProduct } = await supabase
          .from('products').select('stock_quantity').eq('id', pid).eq('company_id', req.companyId).single();
        if (!dbProduct) continue;
        const clampedChange = -Math.min(qty, parseFloat(dbProduct.stock_quantity || 0));

        const result = await adjustStockCAS(req.companyId, pid, clampedChange, { allowNegative: true });
        if (!result.ok) {
          console.error('[inventory] transfer: stock decrement failed for product', pid, result.error);
          continue;
        }
        ({ product, oldQty, newQty } = result);

        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: pid, adjusted_by: req.user.userId,
          quantity_before: oldQty, quantity_change: -qty, quantity_after: newQty,
          reason: to_location, notes: `Transfer #${transfer.id} → ${to_location}`,
        });

        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
          productId: pid,
          beforeSnapshot: { stock_quantity: oldQty },
          afterSnapshot:  { stock_quantity: newQty },
          metadata: { product_name: product.product_name, quantity_change: -qty, reason: to_location, transfer_id: transfer.id },
        });
      } else {
        const { data: dbProduct } = await supabase
          .from('products').select('stock_quantity, product_name').eq('id', pid).eq('company_id', req.companyId).single();
        if (!dbProduct) continue;
        product = dbProduct;
        oldQty = newQty = parseFloat(dbProduct.stock_quantity || 0);
      }

      await supabase.from('pos_stock_transfer_items').insert({
        transfer_id: transfer.id, company_id: req.companyId, product_id: pid,
        quantity: qty, qty_before: oldQty, qty_after: newQty,
      });

      processedItems.push({ product_id: pid, product_name: product.product_name, quantity: qty, qty_before: oldQty, qty_after: newQty });
    }

    posAuditFromReq(req, POS_EVENTS.STOCK_TRANSFER_RECORDED, {
      metadata: { transfer_id: transfer.id, from_location, to_location, affects_stock: affectsStock, item_count: items.length },
    });

    res.json({ transfer: { ...transfer, items: processedItems } });
  } catch (err) {
    console.error('[inventory] transfer:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/inventory/transfers
 */
router.get('/transfers', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pos_stock_transfers')
      .select('*, users:transferred_by(username, full_name)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ transfers: data || [] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
