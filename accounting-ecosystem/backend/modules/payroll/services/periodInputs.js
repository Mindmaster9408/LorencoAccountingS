'use strict';

/**
 * ============================================================================
 * Period inputs — save safely (Fase 6, spec 07/08, finding B3)
 * ============================================================================
 * Current inputs, overtime, short time and multi-rate are stored per employee
 * per pay period and saved as a full replacement set. Two rules:
 *
 *   1. A finalized month cannot change: if the employee has a locked,
 *      non-reversed snapshot for the month → PeriodLockedError (HTTP 423).
 *   2. All or nothing: the replacement runs in ONE database transaction
 *      (function paytime_replace_period_rows, migration 028). The old routes
 *      deleted first and inserted afterwards, so a failed insert lost the inputs.
 *
 * Before migration 028 has run, the old delete-then-insert is used (with the
 * lock check and with the delete error now checked).
 * ============================================================================
 */

const TABLES = ['payroll_period_inputs', 'payroll_overtime', 'payroll_short_time', 'payroll_multi_rate'];

class PeriodLockedError extends Error {
  constructor(periodKey) {
    super(`${periodKey} is finalized for this employee — inputs can no longer be changed. Reverse the pay run first if a correction is needed.`);
    this.code = 'PERIOD_LOCKED';
    this.status = 423;
  }
}

class InputSaveError extends Error {
  constructor(message, status) { super(message); this.status = status || 500; }
}

const isMissingFunction = (err) => !!err && (err.code === 'PGRST202' || err.code === '42883' ||
  /paytime_replace_period_rows/.test(err.message || '') && /could not find|does not exist/i.test(err.message || ''));

/** True when the employee's month is finalized (locked, not reversed). */
async function isPeriodLocked(supabase, companyId, employeeId, periodKey) {
  const { data, error } = await supabase
    .from('payroll_snapshots')
    .select('id')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('period_key', periodKey)
    .eq('is_locked', true)
    .neq('status', 'reversed')
    .limit(1);
  if (error) throw new InputSaveError('Could not check whether the month is finalized: ' + error.message);
  return (data || []).length > 0;
}

/** Throws PeriodLockedError when the month is finalized. */
async function assertPeriodOpen(supabase, companyId, employeeId, periodKey) {
  if (await isPeriodLocked(supabase, companyId, employeeId, periodKey)) throw new PeriodLockedError(periodKey);
}

/**
 * Replace one employee's rows of one input table for one period.
 * @param {object} p { table, companyId, employeeId, periodId, periodKey, rows }
 *   rows: plain objects with the table's own columns (no ids / company / period).
 * @returns {Promise<number>} rows written
 */
async function replacePeriodRows(supabase, p) {
  if (!TABLES.includes(p.table)) throw new InputSaveError('Unknown input table ' + p.table, 400);
  const employeeId = parseInt(p.employeeId, 10);
  if (!Number.isInteger(employeeId)) throw new InputSaveError('employee_id must be an integer', 400);

  await assertPeriodOpen(supabase, p.companyId, employeeId, p.periodKey);
  const rows = Array.isArray(p.rows) ? p.rows : [];

  const { data, error } = await supabase.rpc('paytime_replace_period_rows', {
    p_table: p.table, p_company_id: p.companyId, p_employee_id: employeeId,
    p_period_id: p.periodId, p_rows: rows
  });
  if (!error) return typeof data === 'number' ? data : rows.length;
  if (/PERIOD_LOCKED/.test(error.message || '')) throw new PeriodLockedError(p.periodKey);
  if (/EMPLOYEE_NOT_FOUND/.test(error.message || '')) throw new InputSaveError('Employee not found in this company', 404);
  if (/PERIOD_NOT_FOUND/.test(error.message || '')) throw new InputSaveError('Period not found', 404);
  if (!isMissingFunction(error)) throw new InputSaveError(error.message);

  // Legacy path (migration 028 not run yet).
  const { data: emp, error: empErr } = await supabase
    .from('employees').select('id').eq('id', employeeId).eq('company_id', p.companyId).maybeSingle();
  if (empErr) throw new InputSaveError(empErr.message);
  if (!emp) throw new InputSaveError('Employee not found in this company', 404);

  const { error: delErr } = await supabase.from(p.table).delete()
    .eq('company_id', p.companyId).eq('employee_id', employeeId).eq('payroll_period_id', p.periodId);
  if (delErr) throw new InputSaveError(delErr.message);
  if (!rows.length) return 0;
  const records = rows.map(r => Object.assign({}, r, {
    company_id: p.companyId, employee_id: employeeId, payroll_period_id: p.periodId, is_deleted: false
  }));
  const { error: insErr } = await supabase.from(p.table).insert(records);
  if (insErr) throw new InputSaveError(insErr.message);
  return records.length;
}

/** Express helper: send the right status for errors from this module. */
function sendInputError(res, err) {
  if (err && err.code === 'PERIOD_LOCKED') return res.status(423).json({ success: false, code: 'PERIOD_LOCKED', error: err.message });
  const status = (err && err.status) || 500;
  return res.status(status).json({ success: false, error: status === 500 ? 'Server error: ' + (err && err.message) : err.message });
}

module.exports = { replacePeriodRows, assertPeriodOpen, isPeriodLocked, PeriodLockedError, sendInputError, TABLES };
