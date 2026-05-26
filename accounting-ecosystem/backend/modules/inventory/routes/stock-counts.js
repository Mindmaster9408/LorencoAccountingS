'use strict';

/**
 * ============================================================================
 * Stock Counts Routes — Codebox 03
 * ============================================================================
 * Mounted at: /api/inventory/stock-counts
 *
 * Endpoints:
 *   GET    /stock-counts                      — list sessions (company scoped)
 *   POST   /stock-counts                      — create new count session
 *   GET    /stock-counts/:id                  — get session + lines + approvals
 *   PATCH  /stock-counts/:id/lines/:lineId    — update counted_quantity on a line
 *   POST   /stock-counts/:id/submit           — submit count for approval
 *   POST   /stock-counts/:id/approve          — approve / reject / recount_required
 *   POST   /stock-counts/:id/apply            — apply approved variance to stock
 *   GET    /stock-counts/:id/history          — stock movements linked to this session
 *   DELETE /stock-counts/:id                  — cancel session (draft/in_progress only)
 *
 * Auth: JWT required (companyId embedded). No additional role check enforced
 *       here — role-based separation for count vs approve is PREP ONLY in
 *       Codebox 03 (documented in 06_permission_prep.md).
 * ============================================================================
 */

const express  = require('express');
const { supabase } = require('../../../config/database');
const stockCountService = require('../services/stockCountService');

const router = express.Router();

// ─── GET /stock-counts ────────────────────────────────────────────────────────
// List count sessions for this company.
// Query params: status, count_type, warehouse_id, from_date, to_date, limit
router.get('/', async (req, res) => {
  try {
    const { status, count_type, warehouse_id, from_date, to_date, limit = 50 } = req.query;

    let query = supabase
      .from('stock_count_sessions')
      .select('*')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 50, 200));

    if (status)       query = query.eq('status', status);
    if (count_type)   query = query.eq('count_type', count_type);
    if (warehouse_id) query = query.eq('warehouse_id', parseInt(warehouse_id));
    if (from_date)    query = query.gte('created_at', from_date);
    if (to_date)      query = query.lte('created_at', to_date);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Attach line summary counts (how many lines / how many counted)
    // Lightweight: fetch counts grouped by session_id
    const sessionIds = (data || []).map(s => s.id);
    let lineSummary = {};
    if (sessionIds.length > 0) {
      const { data: lineRows } = await supabase
        .from('stock_count_lines')
        .select('session_id, counted_quantity')
        .eq('company_id', req.companyId)
        .in('session_id', sessionIds);

      for (const row of lineRows || []) {
        if (!lineSummary[row.session_id]) {
          lineSummary[row.session_id] = { total: 0, counted: 0 };
        }
        lineSummary[row.session_id].total++;
        if (row.counted_quantity !== null) lineSummary[row.session_id].counted++;
      }
    }

    const sessions = (data || []).map(s => ({
      ...s,
      line_count:    (lineSummary[s.id] || {}).total   || 0,
      counted_count: (lineSummary[s.id] || {}).counted || 0,
    }));

    res.json({ sessions, total: sessions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /stock-counts ───────────────────────────────────────────────────────
// Create a new count session and snapshot item quantities.
// Body: { count_type, warehouse_id?, notes?, blind_count?, freeze_inventory?,
//         mode?, category?, item_ids? }
router.post('/', async (req, res) => {
  try {
    const {
      count_type     = 'full',
      warehouse_id   = null,
      notes          = null,
      blind_count    = false,
      freeze_inventory = false,
      mode           = 'full',
      category       = null,
      item_ids       = null,
    } = req.body;

    const result = await stockCountService.createCountSession(supabase, req.companyId, {
      countType:      count_type,
      warehouseId:    warehouse_id ? parseInt(warehouse_id) : null,
      notes:          notes || null,
      blindCount:     !!blind_count,
      freezeInventory: !!freeze_inventory,
      startedBy:      req.user.userId,
      mode:           mode || 'full',
      category:       category || null,
      itemIds:        Array.isArray(item_ids) ? item_ids : null,
    });

    if (!result.success) return res.status(400).json({ error: result.error });

    res.status(201).json({
      session:    result.session,
      line_count: (result.lines || []).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /stock-counts/:id ────────────────────────────────────────────────────
// Get session with all lines and approval history.
// Blind count: system_quantity hidden until session is submitted.
router.get('/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const result = await stockCountService.getCountSession(supabase, req.companyId, sessionId);
    if (!result.success) return res.status(404).json({ error: result.error });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /stock-counts/:id/lines/:lineId ────────────────────────────────────
// Update counted_quantity (and optionally variance_reason/notes) on one line.
// Body: { counted_quantity, variance_reason?, variance_notes? }
router.patch('/:id/lines/:lineId', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const lineId    = parseInt(req.params.lineId);
    if (isNaN(sessionId) || isNaN(lineId)) return res.status(400).json({ error: 'Invalid ID' });

    const { counted_quantity, variance_reason, variance_notes } = req.body;

    const result = await stockCountService.updateCountLine(
      supabase, req.companyId, sessionId, lineId,
      { countedQuantity: counted_quantity, varianceReason: variance_reason, varianceNotes: variance_notes }
    );

    if (!result.success) return res.status(400).json({ error: result.error });

    res.json({ line: result.line });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /stock-counts/:id/submit ───────────────────────────────────────────
// Submit a count for approval. Calculates all variances.
// All lines must have counted_quantity before submission.
router.post('/:id/submit', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const result = await stockCountService.submitCount(
      supabase, req.companyId, sessionId, req.user.userId
    );

    if (!result.success) return res.status(400).json({ error: result.error });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /stock-counts/:id/approve ──────────────────────────────────────────
// Approve, reject, or request recount on a submitted session.
// Body: { action: 'approved'|'rejected'|'recount_required', notes? }
router.post('/:id/approve', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const { action, notes } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });

    const result = await stockCountService.approveCountSession(
      supabase, req.companyId, sessionId, req.user.userId, action, notes || null
    );

    if (!result.success) return res.status(400).json({ error: result.error });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /stock-counts/:id/apply ────────────────────────────────────────────
// Apply approved variances to live stock via adjustStockTx.
// Guard: session must be status='approved'. Idempotency: status flipped to
// 'applied' before processing so duplicate calls fail cleanly.
router.post('/:id/apply', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const result = await stockCountService.applyApprovedVariance(
      supabase, req.companyId, sessionId, req.user.userId
    );

    if (!result.success) return res.status(400).json({ error: result.error });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /stock-counts/:id/history ───────────────────────────────────────────
// Fetch stock movements that were created by this count session.
// Uses source_type='stock_count' and source_id=sessionId.
router.get('/:id/history', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    // Verify session belongs to this company
    const { data: session, error: sessionErr } = await supabase
      .from('stock_count_sessions')
      .select('id, session_number, status')
      .eq('id', sessionId)
      .eq('company_id', req.companyId)
      .single();

    if (sessionErr || !session) return res.status(404).json({ error: 'Count session not found' });

    const { data: movements, error: movErr } = await supabase
      .from('stock_movements')
      .select('*, inventory_items:item_id(name, sku, unit)')
      .eq('company_id', req.companyId)
      .eq('source_type', 'stock_count')
      .eq('source_id', String(sessionId))
      .order('created_at', { ascending: false });

    if (movErr) return res.status(500).json({ error: movErr.message });

    res.json({
      session_id:     sessionId,
      session_number: session.session_number,
      movements:      movements || [],
      total:          (movements || []).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /stock-counts/:id ─────────────────────────────────────────────────
// Cancel a session. Only allowed when status is 'draft' or 'in_progress'.
// No stock mutations occur. Lines are removed (CASCADE on foreign key).
router.delete('/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const { data: session } = await supabase
      .from('stock_count_sessions')
      .select('id, status')
      .eq('id', sessionId)
      .eq('company_id', req.companyId)
      .single();

    if (!session) return res.status(404).json({ error: 'Count session not found' });
    if (!['draft', 'in_progress'].includes(session.status)) {
      return res.status(400).json({
        error: `Only draft or in_progress sessions can be cancelled (current: ${session.status})`,
      });
    }

    const { error: cancelErr } = await supabase
      .from('stock_count_sessions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('company_id', req.companyId);

    if (cancelErr) return res.status(500).json({ error: cancelErr.message });

    res.json({ success: true, session_id: sessionId, status: 'cancelled' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
