/**
 * ============================================================================
 * Attendance Routes - Payroll Module
 * ============================================================================
 * Replaces localStorage DataAccess.getAttendance() / saveAttendance().
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { getEmployeeFilter } = require('../services/paytimeAccess');
const PayrollDataService = require('../services/PayrollDataService');
const { payrollEligibility } = require('../services/payrollEligibility');
const { computeAttendanceProposal, hoursBetween } = require('../services/attendanceProposal');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ─── Fase 8 helpers ───────────────────────────────────────────────────────────
// Attendance lives in the `attendance` table (one row per employee per day). It used
// to live in browser/KV storage only (CLAUDE.md Part D) and the routes below read a
// `date` column that does not exist — they never worked (finding V1).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Employee ids this user may see (paytimeAccess: confidential employees stay hidden). */
async function visibleEmployeeIds(req) {
  const filter = await getEmployeeFilter(req.user.role, req.user.userId, req.companyId);
  let q = supabase.from('employees').select('id').eq('company_id', req.companyId);
  if (filter.type === 'ids') {
    if (!filter.ids.length) return [];
    q = q.in('id', filter.ids);
  } else if (filter.type === 'classification') {
    q = q.eq('classification', 'public');
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(e => e.id);
}

/** 'YYYY-MM-DD' + 'HH:MM' → ISO timestamp in SA time (+02:00). */
const toTimestamp = (date, time, nextDay) => {
  if (!time) return null;
  const d = nextDay ? new Date(Date.UTC(...date.split('-').map((v, i) => i === 1 ? v - 1 : +v)) + 86400000).toISOString().slice(0, 10) : date;
  return `${d}T${time.length === 4 ? '0' + time : time}:00+02:00`;
};
/** ISO timestamp → 'HH:MM' in SA time. */
const toClock = (ts) => {
  if (!ts) return '';
  const d = new Date(new Date(ts).getTime() + 2 * 3600000);
  return d.toISOString().slice(11, 16);
};
const periodBounds = (periodKey) => {
  const [y, m] = periodKey.split('-').map(Number);
  return { from: `${periodKey}-01`, to: `${periodKey}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` };
};

/**
 * GET /api/payroll/attendance?from=&to=&employee_id=
 * Attendance rows (one per employee per day) with clock times as HH:MM.
 */
router.get('/', requirePermission('ATTENDANCE.VIEW'), async (req, res) => {
  try {
    const { from, to, employee_id } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
    }
    const ids = await visibleEmployeeIds(req);
    if (!ids.length) return res.json({ attendance: [] });
    let q = supabase.from('attendance')
      .select('id, employee_id, attendance_date, clock_in, clock_out, status, hours_worked, notes')
      .eq('company_id', req.companyId)
      .gte('attendance_date', from).lte('attendance_date', to)
      .in('employee_id', ids)
      .order('attendance_date', { ascending: true });
    if (employee_id) q = q.eq('employee_id', parseInt(employee_id, 10));
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({
      attendance: (data || []).map(r => Object.assign({}, r, {
        date: String(r.attendance_date).slice(0, 10), clock_in: toClock(r.clock_in), clock_out: toClock(r.clock_out)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

/**
 * POST /api/payroll/attendance
 * Body: { entries: [{ employee_id, date, clock_in 'HH:MM', clock_out 'HH:MM', status?, notes? }] }
 * One row per employee per day (upsert). Hours are calculated here, never trusted from the client.
 */
router.post('/', requirePermission('ATTENDANCE.RECORD'), async (req, res) => {
  try {
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'entries array is required' });
    if (entries.length > 5000) return res.status(400).json({ error: 'At most 5000 entries per request' });

    const visible = new Set((await visibleEmployeeIds(req)).map(String));
    const problems = [];
    const rows = [];
    entries.forEach((e, i) => {
      const empId = parseInt(e.employee_id, 10);
      const status = e.status || 'present';
      if (!visible.has(String(empId))) return problems.push(`row ${i + 1}: employee not found`);
      if (!DATE_RE.test(e.date || '')) return problems.push(`row ${i + 1}: date must be YYYY-MM-DD`);
      if (!['present', 'absent', 'late', 'half_day', 'leave'].includes(status)) return problems.push(`row ${i + 1}: unknown status ${status}`);
      if (e.clock_in && !TIME_RE.test(e.clock_in)) return problems.push(`row ${i + 1}: clock in must be HH:MM`);
      if (e.clock_out && !TIME_RE.test(e.clock_out)) return problems.push(`row ${i + 1}: clock out must be HH:MM`);
      const hours = (status === 'absent' || status === 'leave') ? 0 : hoursBetween(e.clock_in, e.clock_out);
      const overnight = e.clock_in && e.clock_out && e.clock_out <= e.clock_in;
      rows.push({
        company_id: req.companyId, employee_id: empId, attendance_date: e.date, status,
        clock_in: toTimestamp(e.date, e.clock_in, false),
        clock_out: toTimestamp(e.date, e.clock_out, overnight),
        hours_worked: hours, overtime_hours: 0,
        notes: e.notes ? String(e.notes).slice(0, 500) : null,
        recorded_by: req.user.userId || null
      });
    });
    if (problems.length) return res.status(400).json({ error: problems.slice(0, 10).join('; '), problems });

    const { data, error } = await supabase.from('attendance')
      .upsert(rows, { onConflict: 'company_id,employee_id,attendance_date' })
      .select('id');
    if (error) return res.status(500).json({ error: error.message });
    try { await auditFromReq(req, 'CREATE', 'attendance', null, { module: 'payroll', metadata: { count: rows.length } }); } catch (_) { /* audit is best effort */ }
    res.status(201).json({ success: true, saved: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

/** DELETE /api/payroll/attendance/:id */
router.delete('/:id(\\d+)', requirePermission('ATTENDANCE.RECORD'), async (req, res) => {
  try {
    const visible = await visibleEmployeeIds(req);
    const { data: row } = await supabase.from('attendance').select('id, employee_id, attendance_date')
      .eq('id', parseInt(req.params.id, 10)).eq('company_id', req.companyId).maybeSingle();
    if (!row || !visible.includes(row.employee_id)) return res.status(404).json({ error: 'Attendance record not found' });
    const { error } = await supabase.from('attendance').delete().eq('id', row.id).eq('company_id', req.companyId);
    if (error) return res.status(500).json({ error: error.message });
    try { await auditFromReq(req, 'DELETE', 'attendance', row.id, { module: 'payroll', metadata: { date: row.attendance_date, employee_id: row.employee_id } }); } catch (_) { /* best effort */ }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

/** Load everything a proposal needs for one period (visible employees only). */
async function loadProposals(req, periodKey, onlyIds) {
  const { from, to } = periodBounds(periodKey);
  let ids = await visibleEmployeeIds(req);
  if (onlyIds) { const want = new Set(onlyIds.map(String)); ids = ids.filter(id => want.has(String(id))); }
  if (!ids.length) return [];
  const [emps, sched, att, leave] = await Promise.all([
    supabase.from('employees').select('id, first_name, last_name, employee_code, is_active, hire_date, termination_date')
      .eq('company_id', req.companyId).in('id', ids),
    supabase.from('employee_work_schedule').select('employee_id, hours_per_day, working_days')
      .eq('company_id', req.companyId).in('employee_id', ids),
    supabase.from('attendance').select('employee_id, attendance_date, hours_worked, status')
      .eq('company_id', req.companyId).in('employee_id', ids).gte('attendance_date', from).lte('attendance_date', to),
    supabase.from('leave_records').select('employee_id, start_date, end_date, status')
      .eq('company_id', req.companyId).in('employee_id', ids).lte('start_date', to).gte('end_date', from)
  ]);
  for (const r of [emps, sched, att, leave]) if (r.error) throw new Error(r.error.message);
  const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  return (emps.data || [])
    .filter(e => payrollEligibility(e, from, to).eligible)
    .map(e => {
      const recs = (att.data || []).filter(a => a.employee_id === e.id);
      const proposal = computeAttendanceProposal({
        periodKey, employee: e, today,
        schedule: (sched.data || []).find(s => s.employee_id === e.id) || null,
        records: recs,
        leave: (leave.data || []).filter(l => l.employee_id === e.id)
      });
      return Object.assign({ employee_id: e.id, name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
        employee_code: e.employee_code || null, has_attendance: recs.length > 0 }, proposal);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GET /api/payroll/attendance/proposal?period_key=YYYY-MM
 * What attendance would put on each payslip — nothing is written (spec 05 PI-08 b).
 */
router.get('/proposal', requirePermission('ATTENDANCE.VIEW'), async (req, res) => {
  try {
    const periodKey = req.query.period_key;
    if (!PERIOD_RE.test(periodKey || '')) return res.status(400).json({ error: 'period_key (YYYY-MM) is required' });
    const proposals = await loadProposals(req, periodKey);
    res.json({ success: true, period_key: periodKey, proposals: proposals.filter(p => p.has_attendance) });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

/**
 * POST /api/payroll/attendance/apply  { period_key, employee_ids: [] }
 * Approve the proposal for the chosen employees: their attendance-sourced overtime /
 * short-time rows for the month are replaced (manual rows are never touched).
 * The proposal is recalculated here — client figures are never trusted.
 */
router.post('/apply', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { period_key: periodKey, employee_ids: employeeIds } = req.body || {};
    if (!PERIOD_RE.test(periodKey || '')) return res.status(400).json({ error: 'period_key (YYYY-MM) is required' });
    if (!Array.isArray(employeeIds) || !employeeIds.length) return res.status(400).json({ error: 'employee_ids is required' });

    const period = await PayrollDataService.fetchPeriod(req.companyId, periodKey, supabase);
    if (!period || !period.id) return res.status(404).json({ error: 'Period not found' });

    const proposals = await loadProposals(req, periodKey, employeeIds);
    const applied = [], skipped = [];
    const found = new Set(proposals.map(p => String(p.employee_id)));
    employeeIds.filter(id => !found.has(String(id))).forEach(id => skipped.push({ employee_id: id, error: 'Not eligible or not visible' }));

    for (const p of proposals) {
      const { error } = await supabase.rpc('paytime_apply_attendance', {
        p_company_id: req.companyId, p_employee_id: p.employee_id, p_period_id: period.id,
        p_overtime: p.overtime_rows, p_short_time: p.short_time_rows
      });
      if (!error) { applied.push({ employee_id: p.employee_id, overtime: p.overtime_rows, short_time: p.short_time_rows }); continue; }
      const msg = error.message || '';
      if (/PERIOD_LOCKED/.test(msg)) skipped.push({ employee_id: p.employee_id, code: 'PERIOD_LOCKED', error: `${p.name}: ${periodKey} is already finalized` });
      else if (error.code === 'PGRST202' || /could not find the function/i.test(msg)) {
        return res.status(409).json({ error: 'Database update 029 has not been run yet — attendance cannot be applied.' });
      } else skipped.push({ employee_id: p.employee_id, error: msg });
    }
    try {
      await auditFromReq(req, 'APPLY', 'attendance', null, {
        module: 'payroll', metadata: { period_key: periodKey, applied, skipped }
      });
    } catch (_) { /* best effort */ }
    res.json({ success: true, period_key: periodKey, applied, skipped });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LEAVE MANAGEMENT — full CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/attendance/leave
 * List leave records for an employee. Also returns current-year balances.
 * Query: employee_id (required), year (optional, defaults to current year)
 */
router.get('/leave', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { employee_id, year } = req.query;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

    const targetYear = parseInt(year) || new Date().getFullYear();

    // Fetch leave records (all years — frontend filters by year if needed)
    const { data: records, error: rErr } = await supabase
      .from('leave_records')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('employee_id', parseInt(employee_id))
      .order('start_date', { ascending: false });

    if (rErr) return res.status(500).json({ error: rErr.message });

    // Fetch leave balances for this year
    const { data: balances, error: bErr } = await supabase
      .from('leave_balances')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('employee_id', parseInt(employee_id))
      .eq('year', targetYear);

    if (bErr) return res.status(500).json({ error: bErr.message });

    // If no balances exist for this year, create SA statutory defaults
    let effectiveBalances = balances || [];
    if (effectiveBalances.length === 0) {
      const defaults = [
        { leave_type: 'annual',  annual_entitlement: 15, balance: 15, carried_forward: 0 },
        { leave_type: 'sick',    annual_entitlement: 30, balance: 30, carried_forward: 0 },
        { leave_type: 'family',  annual_entitlement: 3,  balance: 3,  carried_forward: 0 },
      ];
      const rows = defaults.map(d => ({
        company_id: req.companyId,
        employee_id: parseInt(employee_id),
        year: targetYear,
        ...d
      }));
      const { data: inserted } = await supabase.from('leave_balances').insert(rows).select();
      effectiveBalances = inserted || rows;
    }

    res.json({ records: records || [], balances: effectiveBalances, year: targetYear });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/attendance/leave/:id
 * Update a leave record's status or fields.
 */
router.put('/leave/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason, start_date, end_date, days_taken } = req.body;

    // Verify ownership
    const { data: existing, error: fErr } = await supabase
      .from('leave_records')
      .select('id, company_id, employee_id, days_taken, leave_type, status, start_date')
      .eq('id', parseInt(id))
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (fErr || !existing) return res.status(404).json({ error: 'Leave record not found' });

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (reason !== undefined) updates.reason = reason;
    if (start_date !== undefined) updates.start_date = start_date;
    if (end_date !== undefined) updates.end_date = end_date;
    if (days_taken !== undefined) updates.days_taken = parseFloat(days_taken);

    // If days_taken changed AND record was approved, adjust the balance delta
    if (days_taken !== undefined && existing.status === 'approved' && updates.days_taken !== existing.days_taken) {
      const delta = existing.days_taken - updates.days_taken; // positive = freeing up days
      const year = new Date(existing.start_date).getFullYear();
      const { data: bal } = await supabase.from('leave_balances').select('id, balance')
        .eq('company_id', req.companyId).eq('employee_id', existing.employee_id)
        .eq('leave_type', existing.leave_type).eq('year', year).maybeSingle();
      if (bal) {
        await supabase.from('leave_balances').update({ balance: parseFloat(bal.balance) + delta }).eq('id', bal.id);
      }
    }

    // If status is changing from non-approved → approved, deduct balance
    if (status === 'approved' && existing.status !== 'approved') {
      const year = new Date(existing.start_date).getFullYear();
      const { data: bal } = await supabase.from('leave_balances').select('id, balance')
        .eq('company_id', req.companyId).eq('employee_id', existing.employee_id)
        .eq('leave_type', existing.leave_type).eq('year', year).maybeSingle();
      if (bal) {
        await supabase.from('leave_balances').update({ balance: parseFloat(bal.balance) - existing.days_taken }).eq('id', bal.id);
      }
    }

    // If status is changing from approved → rejected/cancelled, restore balance
    if ((status === 'rejected' || status === 'cancelled') && existing.status === 'approved') {
      const year = new Date(existing.start_date).getFullYear();
      const { data: bal } = await supabase.from('leave_balances').select('id, balance')
        .eq('company_id', req.companyId).eq('employee_id', existing.employee_id)
        .eq('leave_type', existing.leave_type).eq('year', year).maybeSingle();
      if (bal) {
        await supabase.from('leave_balances').update({ balance: parseFloat(bal.balance) + existing.days_taken }).eq('id', bal.id);
      }
    }

    const { data, error } = await supabase.from('leave_records').update(updates).eq('id', parseInt(id)).select().single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/payroll/attendance/leave/:id
 * Delete a leave record and restore the balance if it was approved.
 */
router.delete('/leave/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership and fetch for balance restoration
    const { data: existing, error: fErr } = await supabase
      .from('leave_records')
      .select('id, company_id, employee_id, days_taken, leave_type, status, start_date')
      .eq('id', parseInt(id))
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (fErr || !existing) return res.status(404).json({ error: 'Leave record not found' });

    // Restore balance only if the leave was approved
    if (existing.status === 'approved') {
      const year = new Date(existing.start_date).getFullYear();
      const { data: bal } = await supabase.from('leave_balances').select('id, balance')
        .eq('company_id', req.companyId).eq('employee_id', existing.employee_id)
        .eq('leave_type', existing.leave_type).eq('year', year).maybeSingle();
      if (bal) {
        await supabase.from('leave_balances')
          .update({ balance: parseFloat(bal.balance) + existing.days_taken })
          .eq('id', bal.id);
      }
    }

    const { error } = await supabase.from('leave_records').delete().eq('id', parseInt(id));
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
