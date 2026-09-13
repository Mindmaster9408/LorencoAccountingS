'use strict';

/**
 * ============================================================================
 * Production Routings / Phases — Stockton Proof scoping (2026-09-12)
 * ============================================================================
 * Mounted at: /api/inventory/routings
 *
 * A BOM's routing is the ordered list of operations (step_number,
 * operation_name, work_center, expected_minutes) production should follow.
 * Previously a work order was a single flat step (release -> issue
 * materials -> complete) with no multi-step operation sequence at all.
 *
 * A BOM's routing is edited here; work-orders.js's /:id/release snapshots
 * the routing into work_order_operations at release time so later BOM
 * routing edits never rewrite an already-released work order's history.
 *
 * Endpoints:
 *   GET    /routings/boms/:bomId              — list a BOM's routing steps
 *   PUT    /routings/boms/:bomId              — replace a BOM's routing (full set)
 *   GET    /routings/work-orders/:woId        — a work order's operations
 *   POST   /routings/work-orders/:woId/operations/:stepNumber/start    — start an operation
 *   POST   /routings/work-orders/:woId/operations/:stepNumber/complete — complete an operation
 * ============================================================================
 */

const express = require('express');
const { auditFromReq } = require('../../../middleware/audit');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();

router.get('/boms/:bomId', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase = req.supabase;
  const bomId = parseInt(req.params.bomId);

  const { data: bom } = await supabase
    .from('bom_headers').select('id').eq('id', bomId).eq('company_id', req.companyId).single();
  if (!bom) return res.status(404).json({ error: 'BOM not found' });

  const { data, error } = await supabase
    .from('bom_routing_steps')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('bom_id', bomId)
    .order('step_number');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ steps: data || [] });
});

// Replaces the full routing for a BOM — simplest correct semantics for an
// ordered list (avoids partial-update step-number collision headaches).
// Body: { steps: [{ step_number, operation_name, work_center?, expected_minutes?, notes? }] }
router.put('/boms/:bomId', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const supabase = req.supabase;
  const bomId = parseInt(req.params.bomId);
  const { steps } = req.body;

  if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps must be an array' });
  for (const s of steps) {
    if (!s.step_number || !s.operation_name) {
      return res.status(400).json({ error: 'Each step requires step_number and operation_name' });
    }
  }

  const { data: bom } = await supabase
    .from('bom_headers').select('id').eq('id', bomId).eq('company_id', req.companyId).single();
  if (!bom) return res.status(404).json({ error: 'BOM not found' });

  const { error: delErr } = await supabase
    .from('bom_routing_steps').delete().eq('company_id', req.companyId).eq('bom_id', bomId);
  if (delErr) return res.status(500).json({ error: delErr.message });

  if (steps.length > 0) {
    const { error: insErr } = await supabase.from('bom_routing_steps').insert(
      steps.map(s => ({
        company_id:       req.companyId,
        bom_id:           bomId,
        step_number:      parseInt(s.step_number),
        operation_name:   s.operation_name,
        work_center:      s.work_center || null,
        expected_minutes: s.expected_minutes != null ? parseFloat(s.expected_minutes) : null,
        notes:            s.notes || null,
      }))
    );
    if (insErr) return res.status(500).json({ error: insErr.message });
  }

  await auditFromReq(req, 'UPDATE', 'bom_routing', bomId, { module: 'inventory', metadata: { step_count: steps.length } });

  const { data: saved } = await supabase
    .from('bom_routing_steps').select('*').eq('company_id', req.companyId).eq('bom_id', bomId).order('step_number');
  res.json({ steps: saved || [] });
});

router.get('/work-orders/:woId', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase = req.supabase;
  const woId = parseInt(req.params.woId);

  const { data: wo } = await supabase
    .from('work_orders').select('id').eq('id', woId).eq('company_id', req.companyId).single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });

  const { data, error } = await supabase
    .from('work_order_operations')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('work_order_id', woId)
    .order('step_number');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ operations: data || [] });
});

router.post('/work-orders/:woId/operations/:stepNumber/start', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const supabase = req.supabase;
  const woId = parseInt(req.params.woId);
  const stepNumber = parseInt(req.params.stepNumber);

  const { data: op } = await supabase
    .from('work_order_operations')
    .select('id, status')
    .eq('company_id', req.companyId)
    .eq('work_order_id', woId)
    .eq('step_number', stepNumber)
    .single();
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  if (op.status !== 'pending') return res.status(400).json({ error: `Only a pending operation can be started (current: ${op.status})` });

  const { data, error } = await supabase
    .from('work_order_operations')
    .update({ status: 'in_progress', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', op.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order_operation', op.id, { module: 'inventory', metadata: { action: 'start', step_number: stepNumber } });
  res.json({ operation: data });
});

router.post('/work-orders/:woId/operations/:stepNumber/complete', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const supabase = req.supabase;
  const woId = parseInt(req.params.woId);
  const stepNumber = parseInt(req.params.stepNumber);
  const { actual_minutes, notes } = req.body;

  const { data: op } = await supabase
    .from('work_order_operations')
    .select('id, status, started_at')
    .eq('company_id', req.companyId)
    .eq('work_order_id', woId)
    .eq('step_number', stepNumber)
    .single();
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  if (op.status !== 'in_progress') return res.status(400).json({ error: `Only an in-progress operation can be completed (current: ${op.status})` });

  const completedAt = new Date().toISOString();
  const computedMinutes = actual_minutes != null
    ? parseFloat(actual_minutes)
    : (op.started_at ? Math.round((new Date(completedAt) - new Date(op.started_at)) / 60000) : null);

  const { data, error } = await supabase
    .from('work_order_operations')
    .update({
      status: 'completed',
      completed_at: completedAt,
      completed_by: req.user.userId,
      actual_minutes: computedMinutes,
      notes: notes || null,
      updated_at: completedAt,
    })
    .eq('id', op.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order_operation', op.id, {
    module: 'inventory',
    metadata: { action: 'complete', step_number: stepNumber, actual_minutes: computedMinutes },
  });
  res.json({ operation: data });
});

module.exports = router;
