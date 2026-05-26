'use strict';
// ============================================================================
// routes/procurement.js — Procurement Suggestions & Supplier History Routes
// Codebox 05 — Purchasing & Supplier Procurement
// ============================================================================
// Mounted at: /api/inventory/procurement
//
// Routes:
//   GET /suggestions        — shortage + reorder recommendations
//   GET /supplier-history   — per-item supplier purchase history
//   GET /overdue-pos        — POs past expected_date with open status
// ============================================================================

const express = require('express');
const router  = express.Router();

const {
  generateReorderRecommendations,
  generateShortageRecommendations,
} = require('../services/procurementService');

// ---------------------------------------------------------------------------
// GET /suggestions — Combined shortage + reorder recommendations
// ---------------------------------------------------------------------------
router.get('/suggestions', async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;

  try {
    const [reorderRecs, shortageRecs] = await Promise.all([
      generateReorderRecommendations(supabase, companyId),
      generateShortageRecommendations(supabase, companyId),
    ]);

    // Merge: if an item appears in both, combine (shortage takes priority)
    const merged = {};

    for (const r of reorderRecs) {
      merged[r.item_id] = { ...r, sources: ['reorder'] };
    }

    for (const s of shortageRecs) {
      if (merged[s.item_id]) {
        // Item in both — take the higher qty and merge sources
        merged[s.item_id] = {
          ...merged[s.item_id],
          ...s,
          recommended_qty: Math.max(merged[s.item_id].recommended_qty, s.recommended_qty),
          sources: [...(merged[s.item_id].sources || []), 'shortage'],
        };
      } else {
        merged[s.item_id] = { ...s, sources: ['shortage'] };
      }
    }

    const suggestions = Object.values(merged);

    return res.json({
      suggestions,
      summary: {
        total:           suggestions.length,
        reorder_count:   reorderRecs.length,
        shortage_count:  shortageRecs.length,
      },
    });
  } catch (err) {
    console.error('[Procurement suggestions]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /supplier-history — Supplier item history for this company
// ---------------------------------------------------------------------------
router.get('/supplier-history', async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;

  const { item_id, supplier_id } = req.query;

  try {
    let query = supabase
      .from('supplier_item_history')
      .select(`
        id, supplier_id, item_id,
        last_purchase_cost, average_supplier_cost,
        last_purchase_date, lead_time_days,
        preferred_supplier, purchase_count,
        updated_at,
        suppliers:supplier_id(id, name, email, is_active),
        inventory_items:item_id(id, name, sku, unit)
      `)
      .eq('company_id', companyId)
      .order('last_purchase_date', { ascending: false });

    if (item_id)     query = query.eq('item_id', parseInt(item_id, 10));
    if (supplier_id) query = query.eq('supplier_id', parseInt(supplier_id, 10));

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ supplier_history: data || [] });
  } catch (err) {
    console.error('[Supplier history]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /supplier-history/:id/set-preferred — Mark preferred supplier for item
// ---------------------------------------------------------------------------
router.post('/supplier-history/:id/set-preferred', async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;
  const histId    = parseInt(req.params.id, 10);

  try {
    // Get the target row to find the item_id
    const { data: target, error: fetchErr } = await supabase
      .from('supplier_item_history')
      .select('id, item_id, supplier_id')
      .eq('company_id', companyId)
      .eq('id', histId)
      .single();

    if (fetchErr || !target) return res.status(404).json({ error: 'History record not found' });

    // Clear preferred flag from all other suppliers for this item
    await supabase
      .from('supplier_item_history')
      .update({ preferred_supplier: false, updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('item_id', target.item_id)
      .neq('id', histId);

    // Set this one as preferred
    const { data: updated, error: updErr } = await supabase
      .from('supplier_item_history')
      .update({ preferred_supplier: true, updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', histId)
      .select()
      .single();

    if (updErr) throw updErr;

    return res.json({ supplier_history: updated });
  } catch (err) {
    console.error('[Set preferred supplier]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /overdue-pos — POs past expected_date and not closed/cancelled
// ---------------------------------------------------------------------------
router.get('/overdue-pos', async (req, res) => {
  const supabase  = req.supabase;
  const companyId = req.companyId;

  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('purchase_orders')
      .select(`
        id, po_number, order_date, expected_date, status, total_amount,
        suppliers:supplier_id(id, name, email)
      `)
      .eq('company_id', companyId)
      .not('status', 'in', '("cancelled","closed","fully_received")')
      .lt('expected_date', today)
      .order('expected_date', { ascending: true });

    if (error) throw error;

    return res.json({ overdue_pos: data || [], count: (data || []).length });
  } catch (err) {
    console.error('[Overdue POs]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
