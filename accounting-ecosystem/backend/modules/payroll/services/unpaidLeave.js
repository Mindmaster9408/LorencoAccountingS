'use strict';

/**
 * ============================================================================
 * Unpaid leave → short time on the payslip (Ruan 2026-11-11)
 * ============================================================================
 * Approved leave of type 'unpaid' is not paid: for every month it touches, the
 * employee gets ONE short-time row (payroll_short_time.source = 'leave') with the
 * scheduled hours of the leave days. The payroll engine already reduces gross pay
 * for every short-time row, so nothing in the calculation changes.
 *
 *   - Scheduled hours come from the employee's work schedule (same reading as the
 *     attendance proposal: default Mon–Fri, 8 h). Public holidays and days outside
 *     employment are not counted.
 *   - Recomputed for whole months, so adding / approving / editing / deleting leave
 *     always leaves exactly the right row (or none).
 *   - A finalized month is never written (the RPC refuses with PERIOD_LOCKED).
 *   - Manual and attendance short-time rows are never touched.
 *   - The attendance proposal keeps treating approved leave as "leave", so a day is
 *     never deducted twice.
 * Change Impact Note: docs/paytime/UNPAID_LEAVE_CHANGE_IMPACT_NOTE.md
 * ============================================================================
 */

const { saPublicHolidays, scheduleMap } = require('./attendanceProposal');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const day = (v) => (v ? String(v).slice(0, 10) : null);

/** 'YYYY-MM' keys of every month from start to end (inclusive). */
function monthsBetween(start, end) {
  const s = day(start), e = day(end) || s;
  if (!s) return [];
  const out = [];
  let [y, m] = s.split('-').map(Number);
  const [ey, em] = e.split('-').map(Number);
  for (let guard = 0; (y < ey || (y === ey && m <= em)) && guard < 36; guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Unpaid hours for ONE month (pure).
 * @param {object} p { periodKey, leave: [{ leave_type, status, start_date, end_date }],
 *                     schedule, employee: { hire_date, termination_date } }
 * @returns {{ days: string[], hours: number }}
 */
function unpaidLeaveForMonth(p) {
  const [y, m] = p.periodKey.split('-').map(Number);
  const first = iso(new Date(Date.UTC(y, m - 1, 1)));
  const last = iso(new Date(Date.UTC(y, m, 0)));
  const hire = day(p.employee && p.employee.hire_date);
  const term = day(p.employee && p.employee.termination_date);
  const sched = scheduleMap(p.schedule);
  const holidays = saPublicHolidays(y);
  const dates = new Set();
  (p.leave || [])
    .filter(l => String(l.leave_type || '').toLowerCase() === 'unpaid' && l.status === 'approved')
    .forEach(l => {
      const from = day(l.start_date) > first ? day(l.start_date) : first;
      const to = (day(l.end_date) || day(l.start_date)) < last ? (day(l.end_date) || day(l.start_date)) : last;
      for (let d = new Date(`${from}T00:00:00Z`); iso(d) <= to; d = addDays(d, 1)) dates.add(iso(d));
    });
  const days = [];
  let hours = 0;
  [...dates].sort().forEach(ds => {
    if ((hire && ds < hire) || (term && ds > term) || holidays.has(ds)) return;
    const h = sched[new Date(`${ds}T00:00:00Z`).getUTCDay()] || 0;
    if (h > 0) { days.push(ds); hours += h; }
  });
  return { days, hours: r2(hours) };
}

const description = (n) => `Unpaid leave: ${n} day${n === 1 ? '' : 's'}`;

/**
 * Rewrite the 'leave' short-time row of each given month for one employee.
 * @param deps { supabase, fetchPeriod(companyId, periodKey, supabase) }
 * @returns {{ updated: [{period_key, days, hours}], locked: string[], warning?: string }}
 */
async function syncUnpaidLeave(deps, companyId, employeeId, periodKeys) {
  const { supabase, fetchPeriod } = deps;
  const keys = [...new Set((periodKeys || []).filter(k => PERIOD_RE.test(k)))].sort();
  const result = { updated: [], locked: [] };
  if (!keys.length) return result;

  const first = `${keys[0]}-01`;
  const [ly, lm] = keys[keys.length - 1].split('-').map(Number);
  const last = iso(new Date(Date.UTC(ly, lm, 0)));
  const [emp, sched, leave] = await Promise.all([
    supabase.from('employees').select('id, hire_date, termination_date')
      .eq('company_id', companyId).eq('id', employeeId).maybeSingle(),
    supabase.from('employee_work_schedule').select('hours_per_day, working_days')
      .eq('company_id', companyId).eq('employee_id', employeeId).maybeSingle(),
    supabase.from('leave_records').select('leave_type, status, start_date, end_date')
      .eq('company_id', companyId).eq('employee_id', employeeId)
      .lte('start_date', last).gte('end_date', first)
  ]);
  for (const r of [emp, sched, leave]) if (r.error) throw new Error(r.error.message);
  if (!emp.data) throw new Error('Employee not found');

  for (const periodKey of keys) {
    const calc = unpaidLeaveForMonth({ periodKey, leave: leave.data || [], schedule: sched.data, employee: emp.data });
    const period = await fetchPeriod(companyId, periodKey, supabase);
    if (!period || !period.id) continue;
    const { error } = await supabase.rpc('paytime_apply_unpaid_leave', {
      p_company_id: companyId, p_employee_id: employeeId, p_period_id: period.id,
      p_hours: calc.hours, p_description: description(calc.days.length)
    });
    if (!error) { result.updated.push({ period_key: periodKey, days: calc.days.length, hours: calc.hours }); continue; }
    const msg = error.message || '';
    // Finalized month: left exactly as it was. Report it only when unpaid leave there
    // could not be deducted, so the user corrects it in the next open month.
    if (/PERIOD_LOCKED/.test(msg)) { if (calc.hours > 0) result.locked.push(periodKey); continue; }
    if (error.code === 'PGRST202' || /could not find the function/i.test(msg)) {
      result.warning = 'Database update 037 has not been run yet — unpaid leave is saved but not yet deducted on the payslip.';
      return result;
    }
    throw new Error(msg);
  }
  return result;
}

module.exports = { unpaidLeaveForMonth, syncUnpaidLeave, monthsBetween, description };
