'use strict';
// ============================================================================
// routes/purchase-orders.js — Lorenco Storehouse PO & Receipt Routes
// Codebox 05 — Purchasing & Supplier Procurement
// Codebox 10 — UOM pack-size conversion on receive
// ============================================================================
// Mounted at: /api/inventory/purchase-orders
//
// Lifecycle:
//   draft → approved → ordered → partial_receipt → fully_received → closed
//   Any → cancelled  (blocked if receipts exist)
//
// HARD RULES:
//  - adjustStockTx() is the ONLY path for stock changes
//  - purchase_receipts rows are immutable (INSERT only, never UPDATE/DELETE)
//  - All queries must include company_id for multi-tenant isolation
//  - No localStorage for any business data
//  - UOM conversion happens BEFORE adjustStockTx — stock is always in base units
// ============================================================================

const express = require('express');
const router  = express.Router();

const { adjustStockTx }           = require('../services/stockMutationService');
const { updateSupplierItemHistory } = require('../services/procurementService');
const { auditFromReq }            = require('../../../middleware/audit');
const {
  convertToBaseUnit,
  computeCostPerBaseUnit,
  getEffectiveBaseUnit
}                                  = require('../services/uomService');
const { requirePerm, PERM }        = require('../permissions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate sequential PO number: LPO-2026-1042 */
function makePONumber(companyId, seqVal) {
  const yr = new Date().getFullYear();
  const seq = String(seqVal).padStart(4, '0');
  return `LPO-${yr}-${seq}`;
}

/** Return allowed status transitions */
const STATUS_TRANSITIONS = {
  draft:            ['approved', 'cancelled'],
  approved:         ['ordered', 'cancelled'],
  ordered:          ['partial_receipt', 'fully_received', 'cancelled'],
  partial_receipt:  ['fully_received', 'closed'],
  fully_received:   ['closed'],
  closed:           [],
  cancelled:        [],
};

function canTransition(from, to) {
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

// ---------------------------------------------------------------------------
// GET /  — List purchase orders with enrichment
// ---------------------------------------------------------------------------
router.get('/', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;

  try {
    let query = supabase
      .from('purchase_orders')
      .select(`
        id, po_number, po_date, expected_date, status,
        total_inc_vat, subtotal, tax_amount, currency_code,
        notes, created_at, updated_at,
        suppliers:supplier_id(id, name, email)
      `)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    const { status } = req.query;
    if (status) query = query.eq('status', status);

    const { data: pos, error } = await query;
    if (error) throw error;

    // Enrich with receipt summary per PO
    const poIds = (pos || []).map(p => p.id);
    let receiptMap = {};
    if (poIds.length) {
      const { data: receipts } = await supabase
        .from('purchase_receipts')
        .select('po_id, total_value, total_qty')
        .eq('company_id', companyId)
        .in('po_id', poIds);

      (receipts || []).forEach(r => {
        if (!receiptMap[r.po_id]) receiptMap[r.po_id] = { total_received_value: 0, receipt_count: 0 };
        receiptMap[r.po_id].total_received_value += parseFloat(r.total_value || 0);
        receiptMap[r.po_id].receipt_count += 1;
      });
    }

    const enriched = (pos || []).map(p => {
      const rm = receiptMap[p.id] || {};
      const now = new Date();
      const overdue = p.expected_date && !['cancelled','closed','fully_received'].includes(p.status)
        && new Date(p.expected_date) < now;
      return {
        ...p,
        total_received_value: rm.total_received_value || 0,
        receipt_count:        rm.receipt_count || 0,
        is_overdue:           !!overdue,
      };
    });

    return res.json({ purchase_orders: enriched });
  } catch (err) {
    console.error('[PO list]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id — PO detail with lines and receipt history
// ---------------------------------------------------------------------------
router.get('/:id', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const poId      = parseInt(req.params.id, 10);

  try {
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select(`
        id, po_number, po_date, expected_date, status,
        total_inc_vat, subtotal, tax_amount, currency_code,
        notes, approved_by, approved_at, closed_at,
        created_at, updated_at, created_by_user_id,
        suppliers:supplier_id(id, name, email, phone, contact_name)
      `)
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (poErr || !po) return res.status(404).json({ error: 'Purchase order not found' });

    // PO lines
    const { data: lines, error: lineErr } = await supabase
      .from('purchase_order_items')
      .select(`
        id, description, quantity, unit_cost, received_qty,
        supplier_sku, expected_date, notes,
        inventory_items:item_id(id, name, sku, unit, current_stock)
      `)
      .eq('po_id', poId)
      .order('id', { ascending: true });

    if (lineErr) throw lineErr;

    // Receipt history
    const { data: receipts, error: rcptErr } = await supabase
      .from('purchase_receipts')
      .select(`
        id, receipt_date, notes, total_qty, total_value, received_by,
        purchase_receipt_lines(
          id, item_id, qty_received, unit_cost, line_value, movement_id,
          inventory_items:item_id(name, sku, unit)
        )
      `)
      .eq('company_id', companyId)
      .eq('po_id', poId)
      .order('receipt_date', { ascending: false });

    if (rcptErr) throw rcptErr;

    return res.json({
      purchase_order: {
        ...po,
        lines:    lines || [],
        receipts: receipts || [],
      },
    });
  } catch (err) {
    console.error('[PO detail]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /  — Create purchase order with lines
// ---------------------------------------------------------------------------
router.post('/', requirePerm(PERM.PO_CREATE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const userId    = req.user?.userId || null;

  const { supplier_id, expected_date, notes, currency_code, lines } = req.body;

  if (!supplier_id) return res.status(400).json({ error: 'supplier_id is required' });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  // Validate lines
  for (const l of lines) {
    if (!l.item_id)         return res.status(400).json({ error: 'Each line requires item_id' });
    if (!l.quantity || l.quantity <= 0) return res.status(400).json({ error: 'Each line requires quantity > 0' });
    if (l.unit_cost < 0)   return res.status(400).json({ error: 'unit_cost cannot be negative' });
  }

  try {
    // Verify supplier belongs to this company
    const { data: supplier, error: supErr } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('id', supplier_id)
      .single();
    if (supErr || !supplier) return res.status(400).json({ error: 'Supplier not found for this company' });

    // Generate PO number using sequence
    const { data: seqData, error: seqErr } = await supabase
      .rpc('nextval', { seq_name: 'po_number_seq' })
      .single();
    const seqVal  = seqData || Date.now(); // fallback if RPC unavailable
    const poNumber = makePONumber(companyId, seqVal);

    // Compute totals
    let subtotal = 0;
    for (const l of lines) {
      subtotal += (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_cost) || 0);
    }
    const taxAmount   = parseFloat(req.body.tax_amount) || 0;
    const totalAmount = subtotal + taxAmount;

    // Create PO header
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .insert({
        company_id:    companyId,
        supplier_id,
        po_number:     poNumber,
        status:              'draft',
        po_date:             new Date().toISOString().slice(0, 10),
        expected_date:       expected_date || null,
        notes:               notes || null,
        currency_code:       currency_code || 'ZAR',
        subtotal,
        tax_amount:          taxAmount,
        total_inc_vat:       totalAmount,
        created_by_user_id:  userId,
      })
      .select()
      .single();

    if (poErr) throw poErr;

    // Create PO lines
    const lineRows = lines.map(l => ({
      po_id:         po.id,
      purchase_order_id: po.id,   // backfill both column names for compat
      item_id:       l.item_id,
      description:   l.description || '',
      quantity:      parseFloat(l.quantity),
      unit_cost:     parseFloat(l.unit_cost || 0),
      received_qty:  0,
      supplier_sku:  l.supplier_sku  || null,
      expected_date: l.expected_date || null,
      notes:         l.notes         || null,
      purchase_unit: l.purchase_unit || null, // Codebox 10 — pack size unit
    }));

    const { error: lineErr } = await supabase
      .from('purchase_order_items')
      .insert(lineRows);
    if (lineErr) throw lineErr;

    await auditFromReq(req, 'CREATE', 'purchase_orders', po.id, {
      supplier_id, po_number: poNumber, line_count: lines.length,
    });

    return res.status(201).json({ purchase_order: po });
  } catch (err) {
    console.error('[PO create]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — Update PO (limited fields; lifecycle guards)
// ---------------------------------------------------------------------------
router.put('/:id', requirePerm(PERM.PO_CREATE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const poId      = parseInt(req.params.id, 10);

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('purchase_orders')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Purchase order not found' });

    // Cannot edit after approved
    if (!['draft'].includes(existing.status)) {
      return res.status(400).json({
        error: `Cannot edit a purchase order in status '${existing.status}'. Only draft POs may be edited.`,
      });
    }

    const { expected_date, notes, supplier_id, currency_code, tax_amount } = req.body;
    const updates = {};
    if (expected_date !== undefined) updates.expected_date = expected_date;
    if (notes !== undefined)         updates.notes = notes;
    if (supplier_id !== undefined)   updates.supplier_id = supplier_id;
    if (currency_code !== undefined) updates.currency_code = currency_code;
    if (tax_amount !== undefined)    updates.tax_amount = parseFloat(tax_amount) || 0;
    updates.updated_at = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabase
      .from('purchase_orders')
      .update(updates)
      .eq('company_id', companyId)
      .eq('id', poId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await auditFromReq(req, 'UPDATE', 'purchase_orders', poId, updates);
    return res.json({ purchase_order: updated });
  } catch (err) {
    console.error('[PO update]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/approve — Transition to approved
// ---------------------------------------------------------------------------
router.post('/:id/approve', requirePerm(PERM.PO_APPROVE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const userId    = req.user?.userId || null;
  const poId      = parseInt(req.params.id, 10);

  try {
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .select('id, status, po_number')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (error || !po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!canTransition(po.status, 'approved')) {
      return res.status(400).json({ error: `Cannot approve a PO in status '${po.status}'` });
    }

    const { data: updated, error: updErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', poId)
      .select()
      .single();

    if (updErr) throw updErr;

    await auditFromReq(req, 'APPROVE', 'purchase_orders', poId, { po_number: po.po_number });
    return res.json({ purchase_order: updated, status: 'approved' });
  } catch (err) {
    console.error('[PO approve]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/mark-ordered — Transition to ordered
// ---------------------------------------------------------------------------
router.post('/:id/mark-ordered', requirePerm(PERM.PO_APPROVE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const poId      = parseInt(req.params.id, 10);

  try {
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .select('id, status, po_number')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (error || !po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!canTransition(po.status, 'ordered')) {
      return res.status(400).json({ error: `Cannot mark-ordered a PO in status '${po.status}'` });
    }

    const { data: updated, error: updErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'ordered', updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', poId)
      .select()
      .single();

    if (updErr) throw updErr;

    await auditFromReq(req, 'MARK_ORDERED', 'purchase_orders', poId, { po_number: po.po_number });
    return res.json({ purchase_order: updated, status: 'ordered' });
  } catch (err) {
    console.error('[PO mark-ordered]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/receive — Receive stock against PO (creates immutable receipt)
// ---------------------------------------------------------------------------
router.post('/:id/receive', requirePerm(PERM.RECEIVE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const userId    = req.user?.userId || null;
  const poId      = parseInt(req.params.id, 10);

  const { lines, notes, warehouse_id } = req.body;
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'lines array is required' });
  }

  try {
    // ── 1. Fetch and validate PO ──────────────────────────────────────────
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('id, status, supplier_id, po_number')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (poErr || !po) return res.status(404).json({ error: 'Purchase order not found' });

    if (['cancelled', 'closed'].includes(po.status)) {
      return res.status(400).json({ error: `Cannot receive against a ${po.status} PO` });
    }
    if (po.status === 'draft') {
      return res.status(400).json({ error: 'Cannot receive against a draft PO — approve it first' });
    }

    // ── 2. Fetch PO lines ────────────────────────────────────────────────
    const { data: poLines, error: lineErr } = await supabase
      .from('purchase_order_items')
      .select('id, item_id, quantity, unit_cost, received_qty, description')
      .eq('po_id', poId);

    if (lineErr) throw lineErr;

    const lineMap = {};
    (poLines || []).forEach(l => { lineMap[l.id] = l; });

    // ── 3. Fetch item base units for UOM conversion ──────────────────────
    // Collect unique item IDs from PO lines that have receive qty > 0
    const itemIdsNeeded = [...new Set(
      lines
        .filter(rl => parseFloat(rl.received_qty || 0) > 0 && lineMap[rl.po_item_id]?.item_id)
        .map(rl => lineMap[rl.po_item_id].item_id)
    )];

    const itemBaseUnitMap = {};
    if (itemIdsNeeded.length > 0) {
      const { data: itemRows } = await supabase
        .from('inventory_items')
        .select('id, unit, base_unit, default_purchase_unit')
        .eq('company_id', companyId)
        .in('id', itemIdsNeeded);
      for (const r of (itemRows || [])) {
        itemBaseUnitMap[r.id] = r;
      }
    }

    // ── 4. Validate each receive line + apply UOM conversion ─────────────
    const validLines = [];
    for (const rl of lines) {
      const poLine = lineMap[rl.po_item_id];
      if (!poLine) return res.status(400).json({ error: `PO line ${rl.po_item_id} not found` });

      const qtyRcv = parseFloat(rl.received_qty || 0);
      if (isNaN(qtyRcv) || qtyRcv <= 0) continue; // skip zero-qty lines silently

      // remaining is in PO purchase units (same unit as quantity/received_qty on the PO line)
      const remaining = parseFloat(poLine.quantity) - parseFloat(poLine.received_qty || 0);
      if (qtyRcv > remaining + 0.0001) {
        return res.status(400).json({
          error: `Over-receive blocked: line ${rl.po_item_id} has ${remaining.toFixed(3)} remaining, received ${qtyRcv}`,
        });
      }

      const rawUnitCost = parseFloat(rl.unit_cost !== undefined ? rl.unit_cost : poLine.unit_cost) || 0;

      // ── UOM conversion (Codebox 10) ──────────────────────────────────
      // purchaseUnit from: (1) receive line override, (2) PO line purchase_unit, (3) none
      const purchaseUnit = rl.purchase_unit || poLine.purchase_unit || null;
      const itemRow = poLine.item_id ? itemBaseUnitMap[poLine.item_id] : null;
      const baseUnit = itemRow ? getEffectiveBaseUnit(itemRow) : null;

      let baseQty = qtyRcv;
      let conversionFactor = 1;
      let costPerBaseUnit = rawUnitCost;

      if (purchaseUnit && baseUnit && purchaseUnit !== baseUnit) {
        try {
          const conv = await convertToBaseUnit(
            supabase, companyId, poLine.item_id, qtyRcv, purchaseUnit, itemRow
          );
          baseQty = conv.baseQty;
          conversionFactor = conv.factor;
          costPerBaseUnit = computeCostPerBaseUnit(rawUnitCost, conversionFactor);
        } catch (convErr) {
          return res.status(400).json({
            error: `UOM conversion failed for PO line ${rl.po_item_id}: ${convErr.message}`
          });
        }
      }

      validLines.push({
        po_item_id:               poLine.id,
        item_id:                  poLine.item_id,
        // qty_received = purchase qty (what was physically delivered, in purchase units)
        qty_received:             qtyRcv,
        purchase_unit:            purchaseUnit,
        purchase_qty:             qtyRcv,
        base_qty:                 baseQty,
        unit_cost:                rawUnitCost,
        unit_cost_per_base_unit:  costPerBaseUnit,
        // line_value in purchase-unit terms for the receipt header total
        line_value:               qtyRcv * rawUnitCost,
        // delta for stock: always in base units
        stock_delta:              baseQty,
        stock_unit_cost:          costPerBaseUnit,
      });
    }

    if (!validLines.length) {
      return res.status(400).json({ error: 'No valid quantities to receive' });
    }

    // ── 5. Create immutable purchase_receipts header ──────────────────────
    const totalQty   = validLines.reduce((s, l) => s + l.qty_received, 0);
    const totalValue = validLines.reduce((s, l) => s + l.line_value, 0);

    const { data: receipt, error: rcptErr } = await supabase
      .from('purchase_receipts')
      .insert({
        company_id:   companyId,
        po_id:        poId,
        receipt_date: new Date().toISOString(),
        received_by:  userId,
        notes:        notes || null,
        total_qty:    Math.round(totalQty * 10000) / 10000,
        total_value:  Math.round(totalValue * 10000) / 10000,
      })
      .select()
      .single();

    if (rcptErr) throw rcptErr;

    // ── 6. Process each line: UOM-converted adjustStockTx + receipt line ──
    //
    // Stock delta is ALWAYS in base units (Codebox 10 rule):
    //   rl.stock_delta = base_qty after UOM conversion
    //   rl.stock_unit_cost = cost_per_base_unit (used for weighted average)
    //
    const receiptLineInserts = [];
    for (const rl of validLines) {
      let movementId = null;

      if (rl.item_id) {
        const result = await adjustStockTx(supabase, {
          companyId,
          itemId:      rl.item_id,
          delta:       rl.stock_delta,          // base_qty — always base units
          movementType:'in',
          warehouseId: warehouse_id || null,
          reference:   po.po_number || `PO-${poId}`,
          notes:       `PO receipt #${receipt.id}${notes ? ': ' + notes : ''}`,
          unitCost:    rl.stock_unit_cost,       // cost_per_base_unit — correct for weighted avg
          createdBy:   userId,
          sourceType:  'po_receive',
          sourceId:    receipt.id,
        });
        movementId = result?.movement_id || null;
      }

      receiptLineInserts.push({
        receipt_id:               receipt.id,
        po_item_id:               rl.po_item_id,
        item_id:                  rl.item_id,
        qty_received:             rl.qty_received,      // purchase qty (forensic record)
        unit_cost:                rl.unit_cost,         // cost per purchase unit (forensic record)
        line_value:               rl.line_value,
        movement_id:              movementId,
        warehouse_id:             warehouse_id || null,
        // UOM fields (Codebox 10)
        purchase_unit:            rl.purchase_unit     || null,
        purchase_qty:             rl.purchase_qty,
        base_qty:                 rl.base_qty,
        unit_cost_per_purchase_unit: rl.unit_cost,
        unit_cost_per_base_unit:  rl.unit_cost_per_base_unit,
      });
    }

    // ── 7. Insert receipt lines ──────────────────────────────────────────
    const { error: prlErr } = await supabase
      .from('purchase_receipt_lines')
      .insert(receiptLineInserts);
    if (prlErr) throw prlErr;

    // ── 8. Update received_qty on each PO line ────────────────────────────
    for (const rl of validLines) {
      const existing = lineMap[rl.po_item_id];
      const newReceivedQty = parseFloat(existing.received_qty || 0) + rl.qty_received;
      await supabase
        .from('purchase_order_items')
        .update({ received_qty: Math.round(newReceivedQty * 10000) / 10000 })
        .eq('id', rl.po_item_id);
    }

    // ── 9. Recalculate PO status ──────────────────────────────────────────
    // Re-fetch lines with updated received_qty
    const { data: updatedLines } = await supabase
      .from('purchase_order_items')
      .select('quantity, received_qty')
      .eq('po_id', poId);

    const allFullyReceived = (updatedLines || []).every(
      l => parseFloat(l.received_qty || 0) >= parseFloat(l.quantity || 0)
    );
    const anyReceived = (updatedLines || []).some(
      l => parseFloat(l.received_qty || 0) > 0
    );

    let newPoStatus = po.status;
    if (allFullyReceived)                        newPoStatus = 'fully_received';
    else if (anyReceived)                        newPoStatus = 'partial_receipt';

    await supabase
      .from('purchase_orders')
      .update({ status: newPoStatus, updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', poId);

    // ── 10. Update supplier_item_history ──────────────────────────────────
    if (po.supplier_id) {
      for (const rl of validLines) {
        if (!rl.item_id) continue;
        await updateSupplierItemHistory(
          supabase, companyId, po.supplier_id, rl.item_id,
          rl.qty_received, rl.unit_cost, poId
        );
      }
    }

    // ── 11. Audit ─────────────────────────────────────────────────────────
    await auditFromReq(req, 'RECEIVE', 'purchase_orders', poId, {
      receipt_id:  receipt.id,
      po_number:   po.po_number,
      lines_count: validLines.length,
      new_status:  newPoStatus,
    });

    return res.json({
      receipt_id: receipt.id,
      status:     newPoStatus,
      lines_processed: validLines.length,
    });
  } catch (err) {
    console.error('[PO receive]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/close — Transition to closed
// ---------------------------------------------------------------------------
router.post('/:id/close', requirePerm(PERM.PO_APPROVE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const poId      = parseInt(req.params.id, 10);

  try {
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .select('id, status, po_number')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (error || !po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!canTransition(po.status, 'closed')) {
      return res.status(400).json({ error: `Cannot close a PO in status '${po.status}'` });
    }

    const { data: updated, error: updErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', poId)
      .select()
      .single();

    if (updErr) throw updErr;

    await auditFromReq(req, 'CLOSE', 'purchase_orders', poId, { po_number: po.po_number });
    return res.json({ purchase_order: updated, status: 'closed' });
  } catch (err) {
    console.error('[PO close]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/cancel — Cancel PO (blocked if any receipts exist)
// ---------------------------------------------------------------------------
router.post('/:id/cancel', requirePerm(PERM.PO_APPROVE), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const poId      = parseInt(req.params.id, 10);

  try {
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .select('id, status, po_number')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (error || !po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!canTransition(po.status, 'cancelled')) {
      return res.status(400).json({ error: `Cannot cancel a PO in status '${po.status}'` });
    }

    // Hard block: any receipts exist?
    const { data: existingReceipts, error: rcptErr } = await supabase
      .from('purchase_receipts')
      .select('id')
      .eq('company_id', companyId)
      .eq('po_id', poId)
      .limit(1);

    if (rcptErr) throw rcptErr;
    if (existingReceipts && existingReceipts.length) {
      return res.status(400).json({
        error: 'Cannot cancel this PO — stock has already been received against it. Close it instead.',
      });
    }

    const { data: updated, error: updErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', poId)
      .select()
      .single();

    if (updErr) throw updErr;

    await auditFromReq(req, 'CANCEL', 'purchase_orders', poId, { po_number: po.po_number });
    return res.json({ purchase_order: updated, status: 'cancelled' });
  } catch (err) {
    console.error('[PO cancel]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/receipts — Receipt history for a PO
// ---------------------------------------------------------------------------
router.get('/:id/receipts', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const poId      = parseInt(req.params.id, 10);

  try {
    // Verify PO belongs to this company
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('id, po_number')
      .eq('company_id', companyId)
      .eq('id', poId)
      .single();

    if (poErr || !po) return res.status(404).json({ error: 'Purchase order not found' });

    const { data: receipts, error } = await supabase
      .from('purchase_receipts')
      .select(`
        id, receipt_date, notes, total_qty, total_value, received_by,
        purchase_receipt_lines(
          id, item_id, qty_received, unit_cost, line_value, movement_id,
          inventory_items:item_id(name, sku, unit)
        )
      `)
      .eq('company_id', companyId)
      .eq('po_id', poId)
      .order('receipt_date', { ascending: false });

    if (error) throw error;
    return res.json({ po_number: po.po_number, receipts: receipts || [] });
  } catch (err) {
    console.error('[PO receipts]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
