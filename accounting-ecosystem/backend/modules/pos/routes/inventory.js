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

    // Get current stock — must belong to this company
    const { data: product } = await supabase
      .from('products')
      .select('stock_quantity, product_name')
      .eq('id', product_id)
      .eq('company_id', req.companyId)
      .single();

    if (!product) return res.status(404).json({ error: 'Product not found' });

    const oldQty = product.stock_quantity;
    const newQty = Math.max(0, oldQty + quantity_change);

    // Update stock
    const { error: updateErr } = await supabase
      .from('products')
      .update({ stock_quantity: newQty, updated_at: new Date().toISOString() })
      .eq('id', product_id)
      .eq('company_id', req.companyId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

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
        await supabase.from('products')
          .update({ stock_quantity: countedQty, updated_at: new Date().toISOString() })
          .eq('id', pid).eq('company_id', req.companyId);

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

      const { data: product } = await supabase
        .from('products').select('stock_quantity, product_name')
        .eq('id', pid).eq('company_id', req.companyId).single();
      if (!product) continue;

      const oldQty   = parseFloat(product.stock_quantity || 0);
      const newQty   = oldQty + qty;
      const costPrice = item.cost_price ? parseFloat(item.cost_price) : null;

      await supabase.from('products')
        .update({ stock_quantity: newQty, ...(costPrice !== null && { cost_price: costPrice }), updated_at: new Date().toISOString() })
        .eq('id', pid).eq('company_id', req.companyId);

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

      const { data: product } = await supabase
        .from('products').select('stock_quantity, product_name')
        .eq('id', pid).eq('company_id', req.companyId).single();
      if (!product) continue;

      const oldQty = parseFloat(product.stock_quantity || 0);
      let newQty = oldQty;

      if (affectsStock) {
        newQty = Math.max(0, oldQty - qty);
        await supabase.from('products')
          .update({ stock_quantity: newQty, updated_at: new Date().toISOString() })
          .eq('id', pid).eq('company_id', req.companyId);

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
