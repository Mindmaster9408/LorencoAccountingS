/**
 * ============================================================================
 * Practice Billing — WIP Management + Billing Pack Preparation
 * ============================================================================
 * Mounted at /api/practice/billing by practice/index.js
 * All routes require auth + company context from JWT (req.companyId).
 *
 * This is the layer BEFORE invoice generation:
 *  - Partner reviews approved time (WIP)
 *  - Groups entries into a billing pack per client
 *  - Writes off irrecoverable time
 *  - Excludes entries from billing
 *  - Approves and locks the pack (marks entries as 'billed')
 *
 * Invoice generation is NOT built here — that is a future codebox.
 * Accounting integration is NOT built here — excluded by CLAUDE.md.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

const PACK_STATUSES = ['draft', 'reviewed', 'approved', 'locked', 'cancelled'];
// Packs in an editable state (not yet locked or cancelled)
const EDITABLE_STATUSES = ['draft', 'reviewed'];
const LINE_STATUSES = ['included', 'written_off', 'excluded'];

// ─── Helper: fetch and ownership-check a pack ─────────────────────────────────

async function fetchPack(companyId, packId) {
  const { data, error } = await supabase
    .from('practice_billing_packs')
    .select('*')
    .eq('id', parseInt(packId))
    .eq('company_id', companyId)
    .single();
  if (error || !data) return null;
  return data;
}

// ─── Helper: recalculate pack totals from its lines ──────────────────────────
// Called after any line mutation (write-off, exclude, add).

async function recalculatePack(companyId, packId) {
  const { data: lines } = await supabase
    .from('practice_billing_pack_lines')
    .select('hours, recoverable_value, writeoff_value, billable_value, line_status')
    .eq('billing_pack_id', parseInt(packId))
    .eq('company_id', companyId);

  const rows = lines || [];
  let total_hours = 0, billable_hours = 0, non_billable_hours = 0;
  let recoverable_value = 0, writeoff_value = 0, billable_value = 0;

  rows.forEach(l => {
    const h = parseFloat(l.hours || 0);
    total_hours += h;
    if (l.line_status === 'included') {
      billable_hours    += h;
      recoverable_value += parseFloat(l.recoverable_value || 0);
      billable_value    += parseFloat(l.billable_value    || 0);
    } else if (l.line_status === 'written_off') {
      non_billable_hours += h;
      writeoff_value     += parseFloat(l.writeoff_value   || 0);
      recoverable_value  += parseFloat(l.recoverable_value || 0);
    }
    // excluded: hours counted in total only
  });

  const round = n => Math.round(n * 100) / 100;

  await supabase
    .from('practice_billing_packs')
    .update({
      total_hours:        round(total_hours),
      billable_hours:     round(billable_hours),
      non_billable_hours: round(non_billable_hours),
      recoverable_value:  round(recoverable_value),
      writeoff_value:     round(writeoff_value),
      billable_value:     round(billable_value),
      updated_at:         new Date().toISOString()
    })
    .eq('id', parseInt(packId))
    .eq('company_id', companyId);
}

// ─── Helper: verify a client belongs to this company ─────────────────────────

async function verifyClient(companyId, clientId) {
  const { data } = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', parseInt(clientId))
    .eq('company_id', companyId)
    .single();
  return !!data;
}

// ─── Helper: generate next sequential pack number for company ─────────────────
// Format: BP-YYYY-NNNNNN  (e.g. BP-2026-000001)
// App-level sequencing — safe for practice management concurrency levels.
// Existing pack_number values (from before this codebox) are preserved as-is.

async function generatePackNumber(companyId) {
  const year   = new Date().getFullYear();
  const prefix = `BP-${year}-`;

  const { data } = await supabase
    .from('practice_billing_packs')
    .select('pack_number')
    .eq('company_id', companyId)
    .like('pack_number', prefix + '%')
    .order('pack_number', { ascending: false })
    .limit(1);

  let seq = 1;
  if (data && data.length > 0 && data[0].pack_number) {
    const n = parseInt(data[0].pack_number.slice(prefix.length), 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return prefix + String(seq).padStart(6, '0');
}

// ─── Helper: build billing_period_key for duplicate-pack detection ────────────
// Returns null when either period date is absent (no duplicate check possible).

function buildPeriodKey(clientId, periodStart, periodEnd) {
  if (!clientId || !periodStart || !periodEnd) return null;
  return `${clientId}_${periodStart}_${periodEnd}`;
}

// ─── Helper: log a billing pack lifecycle event ───────────────────────────────
// Non-fatal — a logging failure must never abort a billing operation.

async function logPackEvent(companyId, packId, eventType, opts = {}) {
  try {
    await supabase.from('practice_billing_pack_events').insert({
      company_id:      companyId,
      billing_pack_id: parseInt(packId),
      event_type:      eventType,
      old_status:      opts.oldStatus   || null,
      new_status:      opts.newStatus   || null,
      actor_user_id:   opts.actorUserId || null,
      notes:           opts.notes       || null,
      metadata:        opts.metadata    || {}
    });
  } catch (_) { /* non-fatal */ }
}

// ═══ WIP REPORT ══════════════════════════════════════════════════════════════
// Approved time entries not yet in a billing pack, grouped by client.
// Filters: client_id, user_id, date_from, date_to
// This is the source list for creating billing packs.

router.get('/wip', async (req, res) => {
  const { client_id, user_id, date_from, date_to } = req.query;

  let q = supabase
    .from('practice_time_entries')
    .select(`
      id, date, hours, description, time_type, effective_rate, recoverable_value,
      billing_status, user_id,
      practice_clients:client_id(id, name)
    `)
    .eq('company_id', req.companyId)
    .eq('billing_status', 'approved')
    .is('billing_pack_id', null)
    .in('time_type', ['billable'])
    .order('date', { ascending: false });

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (user_id)   q = q.eq('user_id',   parseInt(user_id));
  if (date_from) q = q.gte('date',     date_from);
  if (date_to)   q = q.lte('date',     date_to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];

  // Group by client
  const byClient = {};
  let grand_total_hours = 0;
  let grand_total_recoverable = 0;

  rows.forEach(r => {
    const clientId   = r.practice_clients?.id   || null;
    const clientName = r.practice_clients?.name || 'No Client';
    const key        = clientId || 'none';

    if (!byClient[key]) {
      byClient[key] = {
        client_id:         clientId,
        client_name:       clientName,
        total_hours:       0,
        total_recoverable: 0,
        entry_count:       0
      };
    }

    const h  = parseFloat(r.hours || 0);
    const rv = parseFloat(r.recoverable_value || 0);

    byClient[key].total_hours       = Math.round((byClient[key].total_hours       + h)  * 100) / 100;
    byClient[key].total_recoverable = Math.round((byClient[key].total_recoverable + rv) * 100) / 100;
    byClient[key].entry_count       += 1;

    grand_total_hours       = Math.round((grand_total_hours       + h)  * 100) / 100;
    grand_total_recoverable = Math.round((grand_total_recoverable + rv) * 100) / 100;
  });

  res.json({
    entries:                rows,
    by_client:              Object.values(byClient),
    grand_total_hours,
    grand_total_recoverable,
    total_entries:          rows.length
  });
});

// ═══ BILLING PACKS ═══════════════════════════════════════════════════════════

// ── Create billing pack from selected approved time entries ───────────────────

router.post('/packs', async (req, res) => {
  const { client_id, pack_name, period_start, period_end, time_entry_ids, notes } = req.body;

  if (!client_id)          return res.status(400).json({ error: 'client_id is required' });
  if (!pack_name)          return res.status(400).json({ error: 'pack_name is required' });
  if (!Array.isArray(time_entry_ids) || time_entry_ids.length === 0) {
    return res.status(400).json({ error: 'time_entry_ids must be a non-empty array' });
  }

  // Period validation
  if (period_start && period_end && period_end < period_start) {
    return res.status(400).json({ error: 'period_end cannot be before period_start' });
  }

  // Duplicate active-pack detection: same client + same period = likely user error
  const periodKey = buildPeriodKey(client_id, period_start, period_end);
  if (periodKey) {
    const { data: dupCheck } = await supabase
      .from('practice_billing_packs')
      .select('id, pack_name, pack_number')
      .eq('company_id', req.companyId)
      .eq('billing_period_key', periodKey)
      .neq('status', 'cancelled')
      .limit(1);
    if (dupCheck && dupCheck.length > 0) {
      const dup = dupCheck[0];
      return res.status(409).json({
        error: `An active billing pack already exists for this client and period (${dup.pack_number || dup.pack_name}). Cancel it first or choose a different period.`
      });
    }
  }

  // Verify client belongs to company
  if (!await verifyClient(req.companyId, client_id)) {
    return res.status(400).json({ error: 'client_id not found in this company' });
  }

  const parsedClientId = parseInt(client_id);
  const parsedIds      = time_entry_ids.map(id => parseInt(id));

  // Fetch all requested entries — verify ownership, client match, status, not already packed
  const { data: entries, error: entryErr } = await supabase
    .from('practice_time_entries')
    .select('id, company_id, client_id, task_id, workflow_run_id, hours, recoverable_value, billing_status, billing_pack_id, time_type')
    .in('id', parsedIds)
    .eq('company_id', req.companyId);

  if (entryErr) return res.status(500).json({ error: entryErr.message });

  const found = entries || [];

  if (found.length !== parsedIds.length) {
    const foundIds = found.map(e => e.id);
    const missing  = parsedIds.filter(id => !foundIds.includes(id));
    return res.status(400).json({ error: `Time entries not found in this company: ${missing.join(', ')}` });
  }

  const wrongClient = found.filter(e => e.client_id !== parsedClientId);
  if (wrongClient.length > 0) {
    return res.status(400).json({
      error: `${wrongClient.length} time entries do not belong to the selected client`
    });
  }

  const notApproved = found.filter(e => e.billing_status !== 'approved');
  if (notApproved.length > 0) {
    return res.status(400).json({
      error: `${notApproved.length} entries are not in 'approved' status and cannot be packed (must be approved first)`
    });
  }

  const alreadyPacked = found.filter(e => e.billing_pack_id != null);
  if (alreadyPacked.length > 0) {
    return res.status(400).json({
      error: `${alreadyPacked.length} entries are already in another billing pack. Remove them from that pack first.`
    });
  }

  // Create the billing pack — generate sequential number server-side (frontend cannot supply pack_number)
  const now        = new Date().toISOString();
  const packNumber = await generatePackNumber(req.companyId);

  const { data: pack, error: packErr } = await supabase
    .from('practice_billing_packs')
    .insert({
      company_id:         req.companyId,
      client_id:          parsedClientId,
      pack_name:          pack_name.trim(),
      pack_number:        packNumber,
      billing_period_key: periodKey || null,
      period_start:       period_start || null,
      period_end:         period_end   || null,
      status:             'draft',
      notes:              notes        || null,
      created_by:         req.user?.userId || null,
      updated_at:         now
    })
    .select()
    .single();

  if (packErr) return res.status(500).json({ error: packErr.message });

  // Create one line per time entry
  const lines = found.map(e => ({
    company_id:       req.companyId,
    billing_pack_id:  pack.id,
    time_entry_id:    e.id,
    client_id:        e.client_id,
    task_id:          e.task_id          || null,
    workflow_run_id:  e.workflow_run_id  || null,
    hours:            e.hours            || 0,
    recoverable_value: e.recoverable_value || 0,
    writeoff_value:   0,
    billable_value:   e.recoverable_value || 0,  // initial billable = full recoverable
    line_status:      'included'
  }));

  const { error: lineErr } = await supabase
    .from('practice_billing_pack_lines')
    .insert(lines);

  if (lineErr) {
    // Roll back the pack if lines fail
    await supabase.from('practice_billing_packs').delete().eq('id', pack.id);
    return res.status(500).json({ error: `Failed to create lines: ${lineErr.message}` });
  }

  // Mark time entries with this pack's ID
  const { error: teErr } = await supabase
    .from('practice_time_entries')
    .update({ billing_pack_id: pack.id, updated_at: now })
    .in('id', parsedIds)
    .eq('company_id', req.companyId);

  if (teErr) return res.status(500).json({ error: `Failed to link time entries: ${teErr.message}` });

  // Recalculate pack totals from lines
  await recalculatePack(req.companyId, pack.id);

  // Fetch updated pack
  const { data: finalPack } = await supabase
    .from('practice_billing_packs')
    .select('*')
    .eq('id', pack.id)
    .single();

  const actor = req.user?.userId || null;
  await logPackEvent(req.companyId, pack.id, 'pack_created', {
    newStatus:   'draft',
    actorUserId: actor,
    metadata:    { pack_number: packNumber, client_id: parsedClientId, line_count: lines.length }
  });
  await logPackEvent(req.companyId, pack.id, 'pack_number_assigned', {
    actorUserId: actor,
    notes:       packNumber,
    metadata:    { pack_number: packNumber }
  });
  await auditFromReq(req, 'billing_pack_created', 'practice_billing_pack', pack.id, {
    module:      'practice',
    client_id:   parsedClientId,
    line_count:  lines.length,
    pack_number: packNumber
  });

  res.status(201).json({ pack: finalPack });
});

// ── List billing packs ────────────────────────────────────────────────────────

router.get('/packs', async (req, res) => {
  const { client_id, status } = req.query;

  const page  = Math.max(1, parseInt(req.query.page  || 1));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let q = supabase
    .from('practice_billing_packs')
    .select('*, practice_clients:client_id(name)', { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (status && PACK_STATUSES.includes(status)) q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ packs: data || [], total: count || 0 });
});

// ── Get billing pack detail (pack + lines) ────────────────────────────────────

router.get('/packs/:id', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });

  const { data: lines, error: lineErr } = await supabase
    .from('practice_billing_pack_lines')
    .select(`
      *,
      practice_time_entries:time_entry_id(id, date, description, user_id, time_type, effective_rate, billing_status, billing_notes),
      practice_tasks:task_id(id, title),
      practice_workflow_runs:workflow_run_id(id, name)
    `)
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: true });

  if (lineErr) return res.status(500).json({ error: lineErr.message });

  res.json({ pack, lines: lines || [] });
});

// ── Update draft pack (notes, proposed invoice value) ────────────────────────

router.put('/packs/:id', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });

  if (['locked', 'cancelled'].includes(pack.status)) {
    return res.status(400).json({ error: `Cannot edit a pack with status '${pack.status}'` });
  }

  const allowed = ['pack_name', 'period_start', 'period_end', 'notes', 'internal_notes', 'proposed_invoice_value'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (req.user?.userId) updates.updated_by = req.user.userId;

  const { data, error } = await supabase
    .from('practice_billing_packs')
    .update(updates)
    .eq('id', pack.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'billing_pack_updated', 'practice_billing_pack', pack.id, { module: 'practice' });
  res.json({ pack: data });
});

// ── Write off a line ──────────────────────────────────────────────────────────
// Sets line_status = 'written_off'. Time entry billing_status → 'written_off'.
// Requires a reason. Recalculates pack totals.

router.put('/packs/:id/lines/:lineId/writeoff', async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'reason is required for write-off' });
  }

  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });
  if (!EDITABLE_STATUSES.includes(pack.status)) {
    return res.status(400).json({ error: `Pack must be in draft or reviewed status to write off lines (current: '${pack.status}')` });
  }

  // Fetch the line
  const { data: line, error: lineErr } = await supabase
    .from('practice_billing_pack_lines')
    .select('*')
    .eq('id', req.params.lineId)
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .single();
  if (lineErr || !line) return res.status(404).json({ error: 'Line not found in this billing pack' });

  if (line.line_status === 'written_off') {
    return res.status(400).json({ error: 'Line is already written off' });
  }
  if (line.line_status === 'excluded') {
    return res.status(400).json({ error: 'Cannot write off an excluded line' });
  }

  const writeoffValue = parseFloat(line.recoverable_value || 0);
  const now = new Date().toISOString();

  // Update line
  const { error: lineUpdateErr } = await supabase
    .from('practice_billing_pack_lines')
    .update({
      line_status:   'written_off',
      writeoff_value: writeoffValue,
      billable_value: 0,
      notes:          reason.trim()
    })
    .eq('id', line.id)
    .eq('company_id', req.companyId);
  if (lineUpdateErr) return res.status(500).json({ error: lineUpdateErr.message });

  // Update time entry
  const { error: teErr } = await supabase
    .from('practice_time_entries')
    .update({
      billing_status: 'written_off',
      writeoff_value: writeoffValue,
      writeoff_reason: reason.trim(),
      updated_at:     now
    })
    .eq('id', line.time_entry_id)
    .eq('company_id', req.companyId);
  if (teErr) return res.status(500).json({ error: teErr.message });

  await recalculatePack(req.companyId, pack.id);

  await logPackEvent(req.companyId, pack.id, 'pack_line_written_off', {
    actorUserId: req.user?.userId || null,
    notes:       reason.trim(),
    metadata:    { line_id: line.id, writeoff_value: writeoffValue }
  });
  await auditFromReq(req, 'billing_line_written_off', 'practice_billing_pack_line', parseInt(req.params.lineId), {
    module:         'practice',
    pack_id:        pack.id,
    reason:         reason.trim(),
    writeoff_value: writeoffValue
  });

  const { data: updatedPack } = await supabase
    .from('practice_billing_packs').select('*').eq('id', pack.id).single();
  res.json({ success: true, pack: updatedPack });
});

// ── Exclude a line ────────────────────────────────────────────────────────────
// Removes the line from billing calculation but does NOT write off the time entry.
// Time entry is returned to 'approved' status so it can be added to another pack.

router.put('/packs/:id/lines/:lineId/exclude', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });
  if (!EDITABLE_STATUSES.includes(pack.status)) {
    return res.status(400).json({ error: `Pack must be in draft or reviewed status to exclude lines (current: '${pack.status}')` });
  }

  const { data: line, error: lineErr } = await supabase
    .from('practice_billing_pack_lines')
    .select('*')
    .eq('id', req.params.lineId)
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .single();
  if (lineErr || !line) return res.status(404).json({ error: 'Line not found in this billing pack' });

  if (line.line_status === 'excluded') {
    return res.status(400).json({ error: 'Line is already excluded' });
  }
  if (line.line_status === 'written_off') {
    return res.status(400).json({ error: 'Cannot exclude a written-off line. Un-write-off it first.' });
  }

  const now = new Date().toISOString();

  // Set line to excluded
  const { error: lineUpdateErr } = await supabase
    .from('practice_billing_pack_lines')
    .update({ line_status: 'excluded', billable_value: 0 })
    .eq('id', line.id)
    .eq('company_id', req.companyId);
  if (lineUpdateErr) return res.status(500).json({ error: lineUpdateErr.message });

  // Return time entry to 'approved', clear billing_pack_id linkage
  const { error: teErr } = await supabase
    .from('practice_time_entries')
    .update({
      billing_pack_id: null,
      updated_at:      now
    })
    .eq('id', line.time_entry_id)
    .eq('company_id', req.companyId);
  if (teErr) return res.status(500).json({ error: teErr.message });

  await recalculatePack(req.companyId, pack.id);

  await logPackEvent(req.companyId, pack.id, 'pack_line_excluded', {
    actorUserId: req.user?.userId || null,
    metadata:    { line_id: line.id }
  });
  await auditFromReq(req, 'billing_line_excluded', 'practice_billing_pack_line', parseInt(req.params.lineId), {
    module:  'practice',
    pack_id: pack.id
  });

  const { data: updatedPack } = await supabase
    .from('practice_billing_packs').select('*').eq('id', pack.id).single();
  res.json({ success: true, pack: updatedPack });
});

// ── Recalculate pack totals from lines ───────────────────────────────────────

router.put('/packs/:id/recalculate', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });
  if (pack.status === 'locked') {
    return res.status(400).json({ error: 'Cannot recalculate a locked billing pack' });
  }

  await recalculatePack(req.companyId, pack.id);

  await logPackEvent(req.companyId, pack.id, 'pack_recalculated', {
    actorUserId: req.user?.userId || null
  });
  await auditFromReq(req, 'billing_pack_recalculated', 'practice_billing_pack', pack.id, { module: 'practice' });

  const { data: updatedPack } = await supabase
    .from('practice_billing_packs').select('*').eq('id', pack.id).single();
  res.json({ pack: updatedPack });
});

// ── Approve pack (partner sign-off) ──────────────────────────────────────────

router.put('/packs/:id/approve', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });

  if (!['draft', 'reviewed'].includes(pack.status)) {
    return res.status(400).json({ error: `Pack must be in draft or reviewed status to approve (current: '${pack.status}')` });
  }

  // Verify pack has at least one included line before approving
  const { data: lineCheck } = await supabase
    .from('practice_billing_pack_lines')
    .select('id')
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .eq('line_status', 'included')
    .limit(1);
  if (!lineCheck || lineCheck.length === 0) {
    return res.status(400).json({ error: 'Pack has no included lines and cannot be approved. Review entries or check that none have been written off or excluded.' });
  }

  // Auto-recalculate before approving to ensure totals match current line state
  await recalculatePack(req.companyId, pack.id);

  const now   = new Date().toISOString();
  const actor = req.user?.userId || null;
  const { data, error } = await supabase
    .from('practice_billing_packs')
    .update({
      status:      'approved',
      approved_at: now,
      approved_by: actor,
      updated_at:  now,
      updated_by:  actor
    })
    .eq('id', pack.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logPackEvent(req.companyId, pack.id, 'pack_approved', {
    oldStatus:   pack.status,
    newStatus:   'approved',
    actorUserId: actor
  });
  await auditFromReq(req, 'billing_pack_approved', 'practice_billing_pack', pack.id, { module: 'practice' });
  res.json({ pack: data });
});

// ── Lock pack (finalise — marks included time entries as 'billed') ─────────────

router.put('/packs/:id/lock', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });

  if (pack.status !== 'approved') {
    return res.status(400).json({ error: `Pack must be in 'approved' status to lock (current: '${pack.status}'). Approve it first.` });
  }

  // Fetch all included lines
  const { data: lines, error: lineErr } = await supabase
    .from('practice_billing_pack_lines')
    .select('id, time_entry_id, billable_value')
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .eq('line_status', 'included');

  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!lines || lines.length === 0) {
    return res.status(400).json({ error: 'Pack has no included lines — cannot lock an empty pack' });
  }

  const now          = new Date().toISOString();
  const actorId      = req.user?.userId || null;
  const includedIds  = lines.map(l => l.time_entry_id);

  // Mark all included time entries as 'billed'
  const { error: teErr } = await supabase
    .from('practice_time_entries')
    .update({
      billing_status:     'billed',
      billing_reviewed_at: now,
      billing_reviewed_by: actorId,
      updated_at:          now
    })
    .in('id', includedIds)
    .eq('company_id', req.companyId);

  if (teErr) return res.status(500).json({ error: `Failed to mark time entries as billed: ${teErr.message}` });

  // Update billed_value on each time entry (set to line billable_value)
  for (const line of lines) {
    await supabase
      .from('practice_time_entries')
      .update({ billed_value: parseFloat(line.billable_value || 0) })
      .eq('id', line.time_entry_id)
      .eq('company_id', req.companyId);
  }

  // Lock the pack
  const { data, error } = await supabase
    .from('practice_billing_packs')
    .update({
      status:     'locked',
      locked_at:  now,
      locked_by:  actorId,
      updated_at: now,
      updated_by: actorId
    })
    .eq('id', pack.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logPackEvent(req.companyId, pack.id, 'pack_locked', {
    oldStatus:   'approved',
    newStatus:   'locked',
    actorUserId: actorId,
    metadata:    { locked_entries: includedIds.length }
  });
  await auditFromReq(req, 'billing_pack_locked', 'practice_billing_pack', pack.id, {
    module:         'practice',
    locked_entries: includedIds.length
  });
  res.json({ pack: data });
});

// ── Cancel (soft delete) billing pack ────────────────────────────────────────
// Returns all included+approved time entries back to 'approved' (pack is abandoned).
// Written-off entries remain written_off.
// Excluded entries remain approved (they were already returned to approved at exclude time).

router.delete('/packs/:id', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });
  if (pack.status === 'locked') {
    return res.status(400).json({ error: 'Locked billing packs cannot be cancelled. A locked pack has already billed time entries.' });
  }
  if (pack.status === 'cancelled') {
    return res.status(400).json({ error: 'Pack is already cancelled' });
  }

  const now = new Date().toISOString();

  // Fetch included lines (entries still linked to this pack)
  const { data: includedLines } = await supabase
    .from('practice_billing_pack_lines')
    .select('time_entry_id')
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .eq('line_status', 'included');

  const includedEntryIds = (includedLines || []).map(l => l.time_entry_id);

  // Return included entries to 'approved', clear billing_pack_id
  if (includedEntryIds.length > 0) {
    await supabase
      .from('practice_time_entries')
      .update({ billing_pack_id: null, updated_at: now })
      .in('id', includedEntryIds)
      .eq('company_id', req.companyId);
  }

  // Also fetch written-off lines — their entries need billing_pack_id cleared
  // but billing_status stays 'written_off' (the write-off decision stands until manually reversed)
  const { data: writtenOffLines } = await supabase
    .from('practice_billing_pack_lines')
    .select('time_entry_id')
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .eq('line_status', 'written_off');

  const writtenOffIds = (writtenOffLines || []).map(l => l.time_entry_id);
  if (writtenOffIds.length > 0) {
    await supabase
      .from('practice_time_entries')
      .update({ billing_pack_id: null, updated_at: now })
      .in('id', writtenOffIds)
      .eq('company_id', req.companyId);
  }

  // Cancel the pack (soft delete — pack and lines remain for audit trail)
  const cancelActor = req.user?.userId || null;
  const { data, error } = await supabase
    .from('practice_billing_packs')
    .update({
      status:       'cancelled',
      cancelled_at: now,
      cancelled_by: cancelActor,
      updated_at:   now,
      updated_by:   cancelActor
    })
    .eq('id', pack.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logPackEvent(req.companyId, pack.id, 'pack_cancelled', {
    oldStatus:   pack.status,
    newStatus:   'cancelled',
    actorUserId: cancelActor,
    metadata:    { returned_entries: includedEntryIds.length }
  });
  await auditFromReq(req, 'billing_pack_cancelled', 'practice_billing_pack', pack.id, {
    module:           'practice',
    returned_entries: includedEntryIds.length
  });
  res.json({ success: true, pack: data });
});

// ── Pack event history ────────────────────────────────────────────────────────
// Returns full lifecycle event log for a billing pack (most recent first).
// Multi-tenant: verifies pack belongs to req.companyId before querying events.

router.get('/packs/:id/history', async (req, res) => {
  const pack = await fetchPack(req.companyId, req.params.id);
  if (!pack) return res.status(404).json({ error: 'Billing pack not found' });

  const { data, error } = await supabase
    .from('practice_billing_pack_events')
    .select('*')
    .eq('billing_pack_id', pack.id)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [], pack_id: pack.id, pack_number: pack.pack_number });
});

// ═══ BILLING PACK REPORTS ════════════════════════════════════════════════════
// Three endpoints: structured JSON, printable HTML, PDF.
// All data generated server-side. Totals never trusted from frontend.
// Multi-tenant: pack.company_id verified against req.companyId on every request.

// ── Shared data assembly for all report formats ───────────────────────────────
// Fetches and joins all data needed to render a billing pack report.

async function buildReportData(companyId, packId) {
  const pack = await fetchPack(companyId, packId);
  if (!pack) return null;

  // Fetch pack lines (base columns only — manual JS join is safer than PostgREST
  // implicit joins when no FK is defined on time_entry_id)
  const { data: rawLines } = await supabase
    .from('practice_billing_pack_lines')
    .select('id, time_entry_id, task_id, workflow_run_id, hours, recoverable_value, writeoff_value, billable_value, line_status, notes, created_at')
    .eq('billing_pack_id', pack.id)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true });

  const lines = rawLines || [];

  // Collect IDs for parallel lookups
  const entryIds = [...new Set(lines.map(l => l.time_entry_id).filter(Boolean))];
  const taskIds  = [...new Set(lines.map(l => l.task_id).filter(Boolean))];
  const runIds   = [...new Set(lines.map(l => l.workflow_run_id).filter(Boolean))];

  // Parallel fetch: time entries, tasks, workflow runs, client, profile, company
  const [entriesRes, tasksRes, runsRes, clientRes, profileRes, companyRes] = await Promise.all([
    entryIds.length > 0
      ? supabase.from('practice_time_entries')
          .select('id, date, description, user_id, time_type, effective_rate, billing_notes')
          .in('id', entryIds)
          .eq('company_id', companyId)
      : { data: [] },
    taskIds.length > 0
      ? supabase.from('practice_tasks')
          .select('id, title')
          .in('id', taskIds)
          .eq('company_id', companyId)
      : { data: [] },
    runIds.length > 0
      ? supabase.from('practice_workflow_runs')
          .select('id, name')
          .in('id', runIds)
          .eq('company_id', companyId)
      : { data: [] },
    supabase.from('practice_clients')
      .select('id, name, email, phone, vat_number, registration_number, income_tax_number, address_line1, address_city, client_type')
      .eq('id', pack.client_id)
      .eq('company_id', companyId)
      .single(),
    supabase.from('practice_profiles')
      .select('practice_email, practice_phone, address_line1, address_city, address_province, address_postal_code, tax_practitioner_number, vat_registration_number')
      .eq('company_id', companyId)
      .single(),
    supabase.from('companies')
      .select('company_name, trading_name')
      .eq('id', companyId)
      .single()
  ]);

  // Build lookup maps
  const entryMap = {};
  (entriesRes.data || []).forEach(e => { entryMap[e.id] = e; });
  const taskMap = {};
  (tasksRes.data || []).forEach(t => { taskMap[t.id] = t; });
  const runMap = {};
  (runsRes.data || []).forEach(r => { runMap[r.id] = r; });

  // Look up team members by user_id
  const userIds = [...new Set(Object.values(entryMap).map(e => e.user_id).filter(Boolean))];
  const memberMap = {};
  if (userIds.length > 0) {
    const { data: members } = await supabase
      .from('practice_team_members')
      .select('user_id, display_name')
      .eq('company_id', companyId)
      .in('user_id', userIds);
    (members || []).forEach(m => { if (m.user_id) memberMap[m.user_id] = m.display_name; });
  }

  const client  = clientRes.data  || null;
  const profile = profileRes.data || null;
  const company = companyRes.data || null;

  // Enrich lines
  const enrichedLines = lines.map(line => {
    const te  = entryMap[line.time_entry_id] || {};
    const uid = te.user_id || null;
    return {
      id:                line.id,
      date:              te.date || null,
      description:       te.description || '',
      team_member:       uid ? (memberMap[uid] || `User ${uid}`) : '—',
      task_title:        line.task_id   ? (taskMap[line.task_id]?.title || null) : null,
      workflow_run:      line.workflow_run_id ? (runMap[line.workflow_run_id]?.name || null) : null,
      hours:             parseFloat(line.hours || 0),
      rate:              parseFloat(te.effective_rate || 0),
      recoverable_value: parseFloat(line.recoverable_value || 0),
      writeoff_value:    parseFloat(line.writeoff_value || 0),
      billable_value:    parseFloat(line.billable_value || 0),
      line_status:       line.line_status,
      notes:             line.notes || null,
      billing_notes:     te.billing_notes || null
    };
  });

  // Build staff breakdown (included + written-off lines only)
  const staffAgg = {};
  enrichedLines.filter(l => l.line_status === 'included' || l.line_status === 'written_off').forEach(l => {
    const k = l.team_member;
    if (!staffAgg[k]) staffAgg[k] = { name: k, hours: 0, recoverable_value: 0, billable_value: 0, entry_count: 0 };
    staffAgg[k].hours             += l.hours;
    staffAgg[k].recoverable_value += l.recoverable_value;
    if (l.line_status === 'included') staffAgg[k].billable_value += l.billable_value;
    staffAgg[k].entry_count++;
  });

  // Build task breakdown (included lines with a task only)
  const taskAgg = {};
  enrichedLines.filter(l => l.line_status === 'included' && l.task_title).forEach(l => {
    const k = l.task_title;
    if (!taskAgg[k]) taskAgg[k] = { task: k, hours: 0, billable_value: 0, entry_count: 0 };
    taskAgg[k].hours         += l.hours;
    taskAgg[k].billable_value += l.billable_value;
    taskAgg[k].entry_count++;
  });

  const round2 = n => Math.round(n * 100) / 100;

  const includedLines    = enrichedLines.filter(l => l.line_status === 'included');
  const writtenOffLines  = enrichedLines.filter(l => l.line_status === 'written_off');
  const excludedLines    = enrichedLines.filter(l => l.line_status === 'excluded');

  const rv = parseFloat(pack.recoverable_value || 0);
  const bv = parseFloat(pack.billable_value    || 0);
  const wv = parseFloat(pack.writeoff_value    || 0);
  const ev = round2(excludedLines.reduce((s, l) => s + l.recoverable_value, 0));

  const realizationPct = rv > 0 ? Math.round((bv / rv) * 1000) / 10 : (bv > 0 ? 100 : 0);
  const writeoffPct    = rv > 0 ? Math.round((wv / rv) * 1000) / 10 : 0;

  const practiceName = company?.trading_name || company?.company_name || 'Practice';

  return {
    practice: {
      name:                    practiceName,
      email:                   profile?.practice_email                || null,
      phone:                   profile?.practice_phone                || null,
      address_line1:           profile?.address_line1                 || null,
      address_city:            profile?.address_city                  || null,
      address_province:        profile?.address_province              || null,
      address_postal_code:     profile?.address_postal_code           || null,
      tax_practitioner_number: profile?.tax_practitioner_number       || null,
      vat_number:              profile?.vat_registration_number       || null
    },
    client: {
      id:                  client?.id                  || pack.client_id,
      name:                client?.name                || 'Unknown Client',
      email:               client?.email               || null,
      phone:               client?.phone               || null,
      vat_number:          client?.vat_number          || null,
      registration_number: client?.registration_number || null,
      income_tax_number:   client?.income_tax_number   || null,
      client_type:         client?.client_type         || null
    },
    pack: {
      id:                    pack.id,
      pack_name:             pack.pack_name,
      pack_number:           pack.pack_number            || null,
      period_start:          pack.period_start           || null,
      period_end:            pack.period_end             || null,
      status:                pack.status,
      notes:                 pack.notes                  || null,
      internal_notes:        pack.internal_notes         || null,
      proposed_invoice_value: pack.proposed_invoice_value != null ? parseFloat(pack.proposed_invoice_value) : null,
      created_at:            pack.created_at,
      report_version:        pack.report_version         || 1
    },
    lines:           enrichedLines,
    included_lines:  includedLines,
    written_off_lines: writtenOffLines,
    excluded_lines:  excludedLines,
    staff_breakdown: Object.values(staffAgg)
      .sort((a, b) => b.billable_value - a.billable_value)
      .map(s => ({ ...s, hours: round2(s.hours), recoverable_value: round2(s.recoverable_value), billable_value: round2(s.billable_value) })),
    task_breakdown: Object.values(taskAgg)
      .sort((a, b) => b.billable_value - a.billable_value)
      .map(t => ({ ...t, hours: round2(t.hours), billable_value: round2(t.billable_value) })),
    totals: {
      total_hours:            parseFloat(pack.total_hours        || 0),
      billable_hours:         parseFloat(pack.billable_hours     || 0),
      non_billable_hours:     parseFloat(pack.non_billable_hours || 0),
      total_lines:            enrichedLines.length,
      included_count:         includedLines.length,
      written_off_count:      writtenOffLines.length,
      excluded_count:         excludedLines.length,
      recoverable_value:      rv,
      writeoff_value:         wv,
      excluded_value:         ev,
      billable_value:         bv,
      proposed_invoice_value: pack.proposed_invoice_value != null ? parseFloat(pack.proposed_invoice_value) : null,
      realization_percentage: realizationPct,
      writeoff_percentage:    writeoffPct
    }
  };
}

// ── Helper: stamp report_generated_at on the pack ────────────────────────────

async function stampReportGenerated(companyId, packId, userId) {
  const now = new Date().toISOString();
  await supabase
    .from('practice_billing_packs')
    .update({
      report_generated_at: now,
      report_generated_by: userId || null,
      report_version:      supabase.rpc ? undefined : undefined  // incremented by recalc; leave alone here
    })
    .eq('id', parseInt(packId))
    .eq('company_id', companyId);
}

// ── GET /packs/:id/report-data ────────────────────────────────────────────────
// Returns structured JSON for the billing pack report.

router.get('/packs/:id/report-data', async (req, res) => {
  const report = await buildReportData(req.companyId, req.params.id);
  if (!report) return res.status(404).json({ error: 'Billing pack not found' });

  await stampReportGenerated(req.companyId, req.params.id, req.user?.userId);
  await auditFromReq(req, 'billing_report_viewed', 'practice_billing_pack', parseInt(req.params.id), {
    module:  'practice',
    format:  'json'
  });

  res.json({ report, generated_at: new Date().toISOString() });
});

// ── GET /packs/:id/report-html ────────────────────────────────────────────────
// Returns a self-contained printable HTML report (no external resources).

router.get('/packs/:id/report-html', async (req, res) => {
  const d = await buildReportData(req.companyId, req.params.id);
  if (!d) return res.status(404).json({ error: 'Billing pack not found' });

  const e = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmtR = n => 'R ' + parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtH = n => parseFloat(n || 0).toFixed(2) + ' hrs';
  const fmtD = s => s ? new Date(s).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const fmtPct = n => parseFloat(n || 0).toFixed(1) + '%';
  const now = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const { practice: p, client: c, pack, totals: t, included_lines, written_off_lines, excluded_lines, staff_breakdown, task_breakdown } = d;

  const statusLabel = { draft: 'Draft', reviewed: 'Reviewed', approved: 'Approved', locked: 'Locked', cancelled: 'Cancelled' };
  const realizColor = t.realization_percentage >= 90 ? '#15803d' : t.realization_percentage >= 70 ? '#92400e' : '#991b1b';

  function lineRows(lines, showNotes) {
    if (!lines.length) return '<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:12px;">None</td></tr>';
    return lines.map((l, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
      const ref = [l.task_title, l.workflow_run].filter(Boolean).join(' / ') || '—';
      return `<tr style="background:${bg}">
        <td>${e(fmtD(l.date))}</td>
        <td>${e(l.description || '—')}<br><small style="color:#6b7280">${e(ref)}</small></td>
        <td>${e(l.team_member)}</td>
        <td style="text-align:right">${e(fmtH(l.hours))}</td>
        <td style="text-align:right">${e(l.rate ? 'R ' + parseFloat(l.rate).toFixed(2) + '/hr' : '—')}</td>
        <td style="text-align:right">${e(fmtR(l.recoverable_value))}</td>
        <td style="text-align:right;font-weight:600">${e(l.line_status === 'written_off' ? '—' : fmtR(l.billable_value))}</td>
        ${showNotes ? `<td style="font-size:11px;color:#6b7280">${e(l.notes || '—')}</td>` : ''}
      </tr>`;
    }).join('');
  }

  function staffRows() {
    if (!staff_breakdown.length) return '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:12px;">No staff data</td></tr>';
    return staff_breakdown.map((s, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
      return `<tr style="background:${bg}">
        <td>${e(s.name)}</td>
        <td style="text-align:right">${e(fmtH(s.hours))}</td>
        <td style="text-align:right">${e(fmtR(s.recoverable_value))}</td>
        <td style="text-align:right;font-weight:600">${e(fmtR(s.billable_value))}</td>
      </tr>`;
    }).join('');
  }

  function taskRows() {
    if (!task_breakdown.length) return '<tr><td colspan="3" style="text-align:center;color:#6b7280;padding:12px;">No task data</td></tr>';
    return task_breakdown.map((tk, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
      return `<tr style="background:${bg}">
        <td>${e(tk.task)}</td>
        <td style="text-align:right">${e(fmtH(tk.hours))}</td>
        <td style="text-align:right;font-weight:600">${e(fmtR(tk.billable_value))}</td>
      </tr>`;
    }).join('');
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Billing Pack Report — ${e(c.name)} — ${e(pack.pack_name)}</title>
<style>
  @page { size: A4; margin: 18mm 14mm 14mm 14mm; }
  *    { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #111827; background: #fff; }
  .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 3px solid #7c3aed; padding-bottom: 14px; }
  .practice-name { font-size: 20px; font-weight: 800; color: #7c3aed; }
  .practice-sub  { font-size: 11px; color: #6b7280; margin-top: 2px; }
  .report-title  { font-size: 14px; font-weight: 700; color: #111827; text-align: right; }
  .report-sub    { font-size: 11px; color: #6b7280; text-align: right; margin-top: 2px; }
  .meta-grid     { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .meta-box      { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; }
  .meta-label    { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #9ca3af; font-weight: 700; margin-bottom: 4px; }
  .meta-value    { font-size: 12px; font-weight: 600; color: #111827; }
  .meta-sub      { font-size: 11px; color: #6b7280; margin-top: 1px; }
  .stat-grid     { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
  .stat-card     { background: #f3f4f6; border-radius: 6px; padding: 10px 12px; text-align: center; }
  .stat-lbl      { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; font-weight: 700; margin-bottom: 3px; }
  .stat-val      { font-size: 14px; font-weight: 800; color: #111827; }
  .stat-sub      { font-size: 10px; color: #6b7280; margin-top: 1px; }
  .stat-card.accent-purple { border-top: 2px solid #7c3aed; }
  .stat-card.accent-green  { border-top: 2px solid #16a34a; }
  .stat-card.accent-amber  { border-top: 2px solid #d97706; }
  .stat-card.accent-red    { border-top: 2px solid #dc2626; }
  .section       { margin-bottom: 20px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #7c3aed; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
  table          { width: 100%; border-collapse: collapse; font-size: 11px; }
  th             { background: #f3f4f6; color: #374151; font-weight: 700; padding: 6px 8px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  td             { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tfoot td       { background: #1e1b4b; color: #fff; font-weight: 700; font-size: 12px; padding: 8px; border: none; }
  .notes-box     { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 4px; padding: 10px 14px; font-size: 11px; color: #374151; white-space: pre-line; }
  .footer        { margin-top: 24px; padding-top: 10px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
  .footer-text   { font-size: 10px; color: #9ca3af; }
  .status-badge  { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; }
  .status-locked   { background: #ede9fe; color: #5b21b6; }
  .status-approved { background: #dcfce7; color: #166534; }
  .status-draft    { background: #f3f4f6; color: #374151; }
  .status-reviewed { background: #dbeafe; color: #1e40af; }
  @media print {
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .no-print { display: none; }
  }
  .print-btn { position: fixed; top: 12px; right: 12px; background: #7c3aed; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .print-btn:hover { background: #6d28d9; }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">Print / Save PDF</button>

<div class="page-header">
  <div>
    <div class="practice-name">${e(p.name)}</div>
    <div class="practice-sub">${p.email ? e(p.email) : ''}${p.phone ? ' · ' + e(p.phone) : ''}${p.address_city ? ' · ' + e(p.address_city) : ''}</div>
    ${p.tax_practitioner_number ? `<div class="practice-sub">Tax Practitioner: ${e(p.tax_practitioner_number)}</div>` : ''}
    ${p.vat_number ? `<div class="practice-sub">VAT: ${e(p.vat_number)}</div>` : ''}
  </div>
  <div>
    <div class="report-title">BILLING PACK REVIEW</div>
    <div class="report-sub">Internal Report — Not a Tax Invoice</div>
    <div class="report-sub" style="margin-top:4px"><span class="status-badge status-${e(pack.status)}">${e(statusLabel[pack.status] || pack.status)}</span></div>
  </div>
</div>

<div class="meta-grid">
  <div class="meta-box">
    <div class="meta-label">Client</div>
    <div class="meta-value">${e(c.name)}</div>
    ${c.vat_number          ? `<div class="meta-sub">VAT: ${e(c.vat_number)}</div>` : ''}
    ${c.registration_number ? `<div class="meta-sub">Reg: ${e(c.registration_number)}</div>` : ''}
  </div>
  <div class="meta-box">
    <div class="meta-label">Pack Details</div>
    <div class="meta-value">${e(pack.pack_name)}</div>
    ${pack.pack_number ? `<div class="meta-sub">Ref: ${e(pack.pack_number)}</div>` : ''}
    ${pack.period_start && pack.period_end ? `<div class="meta-sub">Period: ${e(fmtD(pack.period_start))} – ${e(fmtD(pack.period_end))}</div>` : ''}
  </div>
</div>

<div class="stat-grid">
  <div class="stat-card accent-purple">
    <div class="stat-lbl">Billable Value</div>
    <div class="stat-val">${e(fmtR(t.billable_value))}</div>
    <div class="stat-sub">${e(fmtH(t.billable_hours))} billed</div>
  </div>
  <div class="stat-card accent-green" style="border-top-color:${realizColor}">
    <div class="stat-lbl">Realization</div>
    <div class="stat-val" style="color:${realizColor}">${e(fmtPct(t.realization_percentage))}</div>
    <div class="stat-sub">of ${e(fmtR(t.recoverable_value))} recoverable</div>
  </div>
  <div class="stat-card accent-amber">
    <div class="stat-lbl">Written Off</div>
    <div class="stat-val">${e(fmtR(t.writeoff_value))}</div>
    <div class="stat-sub">${e(fmtPct(t.writeoff_percentage))} of recoverable</div>
  </div>
  <div class="stat-card">
    <div class="stat-lbl">Total Hours</div>
    <div class="stat-val">${e(fmtH(t.total_hours))}</div>
    <div class="stat-sub">${t.included_count} incl · ${t.written_off_count} w/o · ${t.excluded_count} excl</div>
  </div>
</div>
${t.proposed_invoice_value != null ? `<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px"><strong style="color:#5b21b6">Proposed Invoice Value: ${e(fmtR(t.proposed_invoice_value))}</strong> (partner override — differs from billable value)</div>` : ''}

<div class="section">
  <div class="section-title">Included Time Entries (${t.included_count})</div>
  <table>
    <thead><tr><th>Date</th><th>Description / Reference</th><th>Staff</th><th style="text-align:right">Hours</th><th style="text-align:right">Rate</th><th style="text-align:right">Recoverable</th><th style="text-align:right">Billable</th></tr></thead>
    <tbody>${lineRows(included_lines, false)}</tbody>
    <tfoot><tr><td colspan="3" style="text-align:left">TOTALS</td><td style="text-align:right">${e(fmtH(t.billable_hours))}</td><td></td><td style="text-align:right">${e(fmtR(t.recoverable_value - t.writeoff_value))}</td><td style="text-align:right">${e(fmtR(t.billable_value))}</td></tr></tfoot>
  </table>
</div>

${written_off_lines.length > 0 ? `
<div class="section">
  <div class="section-title">Written-Off Entries (${written_off_lines.length})</div>
  <table>
    <thead><tr><th>Date</th><th>Description / Reference</th><th>Staff</th><th style="text-align:right">Hours</th><th style="text-align:right">Rate</th><th style="text-align:right">Recoverable</th><th style="text-align:right">Billed</th><th>Reason</th></tr></thead>
    <tbody>${lineRows(written_off_lines, true)}</tbody>
    <tfoot><tr><td colspan="3">WRITE-OFF TOTAL</td><td style="text-align:right">${e(fmtH(t.non_billable_hours))}</td><td></td><td style="text-align:right">${e(fmtR(t.writeoff_value))}</td><td style="text-align:right">—</td><td></td></tr></tfoot>
  </table>
</div>` : ''}

${excluded_lines.length > 0 ? `
<div class="section">
  <div class="section-title">Excluded Entries (${excluded_lines.length}) — returned to WIP</div>
  <table>
    <thead><tr><th>Date</th><th>Description / Reference</th><th>Staff</th><th style="text-align:right">Hours</th><th style="text-align:right">Rate</th><th style="text-align:right">Recoverable</th><th style="text-align:right">Billed</th></tr></thead>
    <tbody>${lineRows(excluded_lines, false)}</tbody>
  </table>
</div>` : ''}

<div class="meta-grid">
  <div class="section" style="margin-bottom:0">
    <div class="section-title">Staff Breakdown</div>
    <table>
      <thead><tr><th>Staff Member</th><th style="text-align:right">Hours</th><th style="text-align:right">Recoverable</th><th style="text-align:right">Billable</th></tr></thead>
      <tbody>${staffRows()}</tbody>
    </table>
  </div>
  <div class="section" style="margin-bottom:0">
    <div class="section-title">Task Breakdown</div>
    <table>
      <thead><tr><th>Task</th><th style="text-align:right">Hours</th><th style="text-align:right">Billable</th></tr></thead>
      <tbody>${taskRows()}</tbody>
    </table>
  </div>
</div>

${pack.notes ? `
<div class="section" style="margin-top:16px">
  <div class="section-title">Notes</div>
  <div class="notes-box">${e(pack.notes)}</div>
</div>` : ''}

<div class="footer">
  <div class="footer-text">Lorenco Practice Management — Internal Billing Report<br>This is NOT a tax invoice. For billing review purposes only.</div>
  <div class="footer-text" style="text-align:right">Generated: ${e(now)}<br>Pack v${e(pack.report_version)}</div>
</div>
</body>
</html>`;

  await stampReportGenerated(req.companyId, req.params.id, req.user?.userId);
  await auditFromReq(req, 'billing_report_generated', 'practice_billing_pack', parseInt(req.params.id), {
    module: 'practice',
    format: 'html'
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── GET /packs/:id/report-pdf ─────────────────────────────────────────────────
// Streams a PDF billing pack report using PDFKit (already installed).

router.get('/packs/:id/report-pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const d = await buildReportData(req.companyId, req.params.id);
  if (!d) return res.status(404).json({ error: 'Billing pack not found' });

  const { practice: p, client: c, pack, totals: t, included_lines, written_off_lines, excluded_lines, staff_breakdown, task_breakdown } = d;

  const fmtR  = n => 'R ' + parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtH  = n => parseFloat(n || 0).toFixed(2) + 'h';
  const fmtD  = s => s ? new Date(s).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const fmtPc = n => parseFloat(n || 0).toFixed(1) + '%';
  const nowStr = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const safeFilename = c.name.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
  const filename = `billing-pack-${pack.id}-${safeFilename}.pdf`;

  const doc = new PDFDocument({ size: 'A4', margin: 45, info: {
    Title:   `Billing Pack — ${c.name} — ${pack.pack_name}`,
    Author:  p.name,
    Creator: 'Lorenco Practice Management'
  }});

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const PW = doc.page.width;
  const L  = 45;
  const W  = PW - 90;
  const R  = L + W;

  // Palette
  const PURPLE   = '#7c3aed';
  const DARKTEXT = '#111827';
  const MUTED    = '#6b7280';
  const BORDER   = '#e5e7eb';
  const HDR_BG   = '#f3f4f6';
  const ALT_BG   = '#f9fafb';
  const FOOT_BG  = '#1e1b4b';
  const FOOT_FG  = '#ffffff';
  const GREEN    = '#16a34a';
  const AMBER    = '#d97706';
  const RED      = '#dc2626';

  let y = 45;

  function maybeNewPage(needed = 60) {
    if (y + needed > doc.page.height - 50) { doc.addPage(); y = 45; }
  }

  function hline(color) {
    doc.moveTo(L, y).lineTo(R, y).strokeColor(color || BORDER).lineWidth(0.5).stroke();
  }

  function sectionTitle(title) {
    maybeNewPage(30);
    y += 12;
    doc.rect(L, y, W, 18).fill(PURPLE);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff')
       .text(title.toUpperCase(), L + 8, y + 5, { width: W - 16, lineBreak: false });
    y += 22;
  }

  function tblHeader(cols) {
    maybeNewPage(24);
    doc.rect(L, y, W, 20).fill(HDR_BG);
    let x = L;
    cols.forEach(col => {
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
         .text(col.label, x + 4, y + 6, { width: col.w - 8, align: col.align || 'left', lineBreak: false });
      x += col.w;
    });
    y += 20;
    hline(BORDER); y += 1;
  }

  function tblRow(cells, cols, opts = {}) {
    const rh = opts.rh || 18;
    maybeNewPage(rh + 4);
    if (opts.bg) doc.rect(L, y, W, rh).fill(opts.bg);
    let x = L;
    cells.forEach((cell, i) => {
      const col = cols[i];
      doc.fontSize(7.5).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(opts.fg || DARKTEXT)
         .text(String(cell || ''), x + 4, y + 4, { width: col.w - 8, align: col.align || 'left', lineBreak: false });
      x += col.w;
    });
    y += rh;
  }

  function tblFoot(cells, cols) {
    maybeNewPage(22);
    doc.rect(L, y, W, 20).fill(FOOT_BG);
    let x = L;
    cells.forEach((cell, i) => {
      const col = cols[i];
      doc.fontSize(8).font('Helvetica-Bold').fillColor(FOOT_FG)
         .text(String(cell || ''), x + 4, y + 6, { width: col.w - 8, align: col.align || 'left', lineBreak: false });
      x += col.w;
    });
    y += 22;
  }

  // ── Page header ──────────────────────────────────────────────────────────────
  doc.rect(L, y, W, 56).fill('#f9f7ff');
  doc.rect(L, y, 4, 56).fill(PURPLE);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(PURPLE)
     .text(p.name, L + 12, y + 8, { width: W * 0.55, lineBreak: false });
  if (p.email || p.phone) {
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text([p.email, p.phone].filter(Boolean).join('  ·  '), L + 12, y + 28, { width: W * 0.55, lineBreak: false });
  }
  doc.fontSize(12).font('Helvetica-Bold').fillColor(DARKTEXT)
     .text('BILLING PACK REVIEW', L + W * 0.58, y + 8, { width: W * 0.42, align: 'right', lineBreak: false });
  doc.fontSize(8).font('Helvetica').fillColor(MUTED)
     .text('Internal Report — Not a Tax Invoice', L + W * 0.58, y + 26, { width: W * 0.42, align: 'right', lineBreak: false });
  const statusLabel = { locked: 'LOCKED', approved: 'APPROVED', draft: 'DRAFT', reviewed: 'REVIEWED', cancelled: 'CANCELLED' };
  doc.fontSize(8).font('Helvetica-Bold').fillColor(PURPLE)
     .text(statusLabel[pack.status] || pack.status.toUpperCase(), L + W * 0.58, y + 40, { width: W * 0.42, align: 'right', lineBreak: false });
  y += 64;

  // ── Meta block ───────────────────────────────────────────────────────────────
  const half = W / 2 - 4;
  doc.rect(L, y, half, 52).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.rect(L + half + 8, y, half, 52).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
     .text('CLIENT', L + 8, y + 7, { lineBreak: false });
  doc.fontSize(9).font('Helvetica-Bold').fillColor(DARKTEXT)
     .text(c.name, L + 8, y + 17, { width: half - 16, lineBreak: false });
  const clientSubs = [c.vat_number ? `VAT: ${c.vat_number}` : null, c.registration_number ? `Reg: ${c.registration_number}` : null].filter(Boolean).join('  ');
  if (clientSubs) doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text(clientSubs, L + 8, y + 30, { width: half - 16, lineBreak: false });

  doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
     .text('PACK', L + half + 16, y + 7, { lineBreak: false });
  doc.fontSize(9).font('Helvetica-Bold').fillColor(DARKTEXT)
     .text(pack.pack_name, L + half + 16, y + 17, { width: half - 16, lineBreak: false });
  const period = pack.period_start && pack.period_end ? `${fmtD(pack.period_start)} – ${fmtD(pack.period_end)}` : null;
  if (period) doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text(period, L + half + 16, y + 30, { width: half - 16, lineBreak: false });
  y += 60;

  // ── Summary stat row ──────────────────────────────────────────────────────────
  const sw = W / 4;
  const statColors = [PURPLE, t.realization_percentage >= 90 ? GREEN : t.realization_percentage >= 70 ? AMBER : RED, AMBER, MUTED];
  const statLabels = ['Billable Value', 'Realization', 'Written Off', 'Total Hours'];
  const statVals   = [fmtR(t.billable_value), fmtPc(t.realization_percentage), fmtR(t.writeoff_value), fmtH(t.total_hours)];
  const statSubs   = [fmtH(t.billable_hours) + ' billed', `of ${fmtR(t.recoverable_value)}`, `${fmtPc(t.writeoff_percentage)} of recv`, `${t.included_count} incl · ${t.written_off_count} w/o`];

  for (let i = 0; i < 4; i++) {
    const sx = L + i * sw;
    doc.rect(sx, y, sw - 3, 44).fill('#f3f4f6');
    doc.rect(sx, y, sw - 3, 3).fill(statColors[i]);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text(statLabels[i].toUpperCase(), sx + 8, y + 8, { width: sw - 19, lineBreak: false });
    doc.fontSize(12).font('Helvetica-Bold').fillColor(statColors[i]).text(statVals[i], sx + 8, y + 18, { width: sw - 19, lineBreak: false });
    doc.fontSize(7).font('Helvetica').fillColor(MUTED).text(statSubs[i], sx + 8, y + 33, { width: sw - 19, lineBreak: false });
  }
  y += 52;

  if (t.proposed_invoice_value != null) {
    doc.rect(L, y, W, 18).fill('#ede9fe');
    doc.fontSize(8).font('Helvetica-Bold').fillColor(PURPLE)
       .text(`Proposed Invoice Value: ${fmtR(t.proposed_invoice_value)}  (partner override)`, L + 8, y + 5, { width: W - 16, lineBreak: false });
    y += 22;
  }

  // ── Included lines table ──────────────────────────────────────────────────────
  sectionTitle(`Included Time Entries (${t.included_count})`);
  const incCols = [
    { label: 'Date',        w: 52,         align: 'left'  },
    { label: 'Description', w: W - 52 - 42 - 46 - 56 - 58, align: 'left' },
    { label: 'Staff',       w: 58,         align: 'left'  },
    { label: 'Hours',       w: 42,         align: 'right' },
    { label: 'Rate',        w: 46,         align: 'right' },
    { label: 'Recoverable', w: 56,         align: 'right' },
    { label: 'Billable',    w: 58,         align: 'right' }
  ];
  tblHeader(incCols);
  included_lines.forEach((l, i) => {
    tblRow([fmtD(l.date), l.description || '—', l.team_member, fmtH(l.hours), l.rate ? `R${parseFloat(l.rate).toFixed(0)}/h` : '—', fmtR(l.recoverable_value), fmtR(l.billable_value)], incCols, { bg: i % 2 === 1 ? ALT_BG : null });
  });
  if (!included_lines.length) { tblRow(['No included lines', '', '', '', '', '', ''], incCols, { fg: MUTED }); }
  tblFoot(['TOTALS', '', '', fmtH(t.billable_hours), '', fmtR(t.recoverable_value - t.writeoff_value), fmtR(t.billable_value)], incCols);

  // ── Written-off lines ─────────────────────────────────────────────────────────
  if (written_off_lines.length > 0) {
    sectionTitle(`Written-Off Entries (${written_off_lines.length})`);
    const woCols = [
      { label: 'Date',        w: 52, align: 'left'  },
      { label: 'Description', w: W - 52 - 42 - 58 - 56 - 80, align: 'left' },
      { label: 'Staff',       w: 50, align: 'left'  },
      { label: 'Hours',       w: 42, align: 'right' },
      { label: 'Recoverable', w: 56, align: 'right' },
      { label: 'Reason',      w: 80, align: 'left'  }
    ];
    tblHeader(woCols);
    written_off_lines.forEach((l, i) => {
      tblRow([fmtD(l.date), l.description || '—', l.team_member, fmtH(l.hours), fmtR(l.recoverable_value), l.notes || '—'], woCols, { bg: i % 2 === 1 ? ALT_BG : null });
    });
    tblFoot(['WRITE-OFF TOTAL', '', '', fmtH(t.non_billable_hours), fmtR(t.writeoff_value), ''], woCols);
  }

  // ── Staff breakdown ───────────────────────────────────────────────────────────
  sectionTitle('Staff Breakdown');
  const stCols = [
    { label: 'Staff Member',  w: W * 0.45, align: 'left'  },
    { label: 'Hours',         w: W * 0.18, align: 'right' },
    { label: 'Recoverable',   w: W * 0.18, align: 'right' },
    { label: 'Billable',      w: W * 0.19, align: 'right' }
  ];
  tblHeader(stCols);
  staff_breakdown.forEach((s, i) => {
    tblRow([s.name, fmtH(s.hours), fmtR(s.recoverable_value), fmtR(s.billable_value)], stCols, { bg: i % 2 === 1 ? ALT_BG : null });
  });
  if (!staff_breakdown.length) tblRow(['No staff data', '', '', ''], stCols, { fg: MUTED });

  // ── Task breakdown ────────────────────────────────────────────────────────────
  if (task_breakdown.length > 0) {
    sectionTitle('Task Breakdown');
    const tkCols = [
      { label: 'Task',    w: W * 0.6,  align: 'left'  },
      { label: 'Hours',   w: W * 0.2,  align: 'right' },
      { label: 'Billable',w: W * 0.2,  align: 'right' }
    ];
    tblHeader(tkCols);
    task_breakdown.forEach((tk, i) => {
      tblRow([tk.task, fmtH(tk.hours), fmtR(tk.billable_value)], tkCols, { bg: i % 2 === 1 ? ALT_BG : null });
    });
  }

  // ── Notes ─────────────────────────────────────────────────────────────────────
  if (pack.notes) {
    sectionTitle('Notes');
    maybeNewPage(40);
    doc.rect(L, y, W, 14 + Math.ceil(pack.notes.length / 80) * 10).fill('#fafafa').strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT)
       .text(pack.notes, L + 8, y + 7, { width: W - 16 });
    y = doc.y + 10;
  }

  // ── Footer ────────────────────────────────────────────────────────────────────
  const footY = doc.page.height - 36;
  doc.rect(L, footY, W, 0.5).fill(BORDER);
  doc.fontSize(7).font('Helvetica').fillColor(MUTED)
     .text('Lorenco Practice Management — Internal Billing Report — Not a Tax Invoice', L, footY + 5, { width: W * 0.6, lineBreak: false });
  doc.text(`Generated: ${nowStr}  |  Pack v${pack.report_version}`, L + W * 0.6, footY + 5, { width: W * 0.4, align: 'right', lineBreak: false });

  doc.end();

  await stampReportGenerated(req.companyId, req.params.id, req.user?.userId);
  await auditFromReq(req, 'billing_report_generated', 'practice_billing_pack', parseInt(req.params.id), {
    module: 'practice',
    format: 'pdf'
  });
});

module.exports = router;
