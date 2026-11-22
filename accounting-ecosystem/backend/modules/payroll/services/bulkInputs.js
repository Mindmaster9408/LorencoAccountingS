'use strict';

/**
 * ============================================================================
 * Paytime — bulk import of ONE month's variable inputs (Ruan 2026-11-22)
 * ============================================================================
 * One file row = one employee for the chosen (open) month:
 *   { row, employee_number, values: { <column>: <raw value> } }
 * Each file column is mapped once (mapping[column]):
 *   { target: 'item', master_item_id }   a Payroll Items row → a current input
 *   { target: 'overtime', rate }         overtime HOURS at that multiplier (default 1.5)
 *   { target: 'short_time' }             short time HOURS missed
 *   { target: 'ignore' }                 not imported
 *
 * Rule = "the file states this month's value":
 *   - an amount for an item REPLACES that employee's existing row(s) for the same item;
 *     other items stay. Blank / 0 = no change for that item.
 *   - overtime / short time hours REPLACE the hand-captured (source 'manual') rows;
 *     rows from Attendance and approved unpaid leave stay (a warning shows when they
 *     exist, so nothing is counted twice).
 * Rows are written exactly as the payslip screen writes them (POST /transactions/inputs,
 * /overtime, /short-time) through services/periodInputs.replacePeriodRows — one
 * transaction per employee+table, refused for a finalized month. The payroll engine and
 * the calculation are untouched. Nothing is written when any row has an error.
 *
 * Pure functions first (tests/payroll-bulk-inputs.test.js), DB functions at the bottom.
 * No browser/KV storage (CLAUDE.md Part D).
 * ============================================================================
 */

const ItemLink = require('./itemLink');
const { payrollEligibility } = require('./payrollEligibility');
const { fetchAllRows } = require('./fetchAllRows');
const { replacePeriodRows } = require('./periodInputs');

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const normNo = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** "1 234,50" · "1,234.50" · "R 300" · 7.5 → number; '' → null; junk → NaN. */
function parseValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? r2(v) : NaN;
  let s = String(v).replace(/[R\s ]/g, '');
  if (s === '' || s === '-') return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? r2(n) : NaN;
}

/**
 * The basic salary item. It is paid from each employee's record (employees.basic_salary /
 * salary history), so as a monthly input it would be paid TWICE (2026-11-22: a Turkstra file
 * with a "Basic" column did exactly that). Never a monthly input.
 */
function isBasicSalary(master) {
  if (!master) return false;
  return String(master.category || '').toLowerCase() === 'salary'
    || String(master.item_code || '').toUpperCase() === 'BASIC'
    || String(master.item_name || '').toLowerCase().trim() === 'basic salary';
}

/** Input side for a Payroll Items row; null = cannot be a monthly input. */
function inputSide(master) {
  if (isBasicSalary(master)) return null;
  const t = String((master && master.item_type) || '').toLowerCase();
  if (t === 'deduction') return 'deduction';
  if (t === 'employer_contribution' || t === 'company_contribution') return null;
  return 'earning';
}

/** Suggested mapping for a column (pure): built-in hours columns, else a same-name item. */
function suggestTarget(column, masters) {
  const c = String(column || '').toLowerCase().replace(/[_\-]+/g, ' ').trim();
  if (/^(employee|emp|staff)\s*(number|no|code|id)?$|^name$|^surname$|first name|last name|employee name/.test(c)) return { target: 'ignore' };
  if (/short\s*time|korttyd/.test(c)) return { target: 'short_time' };
  if (/overtime|oortyd|^ot\b/.test(c)) {
    const m = c.match(/(\d+(?:[.,]\d+)?)\s*x|x\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)$/);
    const rate = m ? parseFloat(String(m[1] || m[2] || m[3]).replace(',', '.')) : 1.5;
    return { target: 'overtime', rate: rate >= 1 && rate <= 3 ? rate : 1.5 };
  }
  const exact = (masters || []).filter(m => m.is_active !== false && inputSide(m) &&
    String(m.item_name || '').toLowerCase().trim() === c);
  if (exact.length === 1) return { target: 'item', master_item_id: exact[0].id };
  if (exact.length > 1) {   // same name on both sides (company 7 "Savings") — a deduction is the usual monthly input
    const ded = exact.find(m => inputSide(m) === 'deduction');
    return { target: 'item', master_item_id: (ded || exact[0]).id };
  }
  return { target: 'ignore' };
}

/** Validate the mapping against the company's items (pure). Returns error strings. */
function checkMapping(mapping, masters) {
  const errors = [];
  for (const [col, m] of Object.entries(mapping || {})) {
    if (!m || typeof m !== 'object') { errors.push(`Column "${col}": no mapping`); continue; }
    if (m.target === 'item') {
      const master = (masters || []).find(x => String(x.id) === String(m.master_item_id));
      if (!master) errors.push(`Column "${col}": the payroll item does not exist in this company`);
      else if (master.is_active === false) errors.push(`Column "${col}": "${master.item_name}" is inactive`);
      else if (isBasicSalary(master)) errors.push(`Column "${col}": the basic salary comes from each employee's record — importing it would pay it twice. Set this column to "do not import".`);
      else if (!inputSide(master)) errors.push(`Column "${col}": "${master.item_name}" is an employer contribution, not a monthly input`);
    } else if (m.target === 'overtime') {
      const rate = m.rate == null ? 1.5 : Number(m.rate);
      if (!(rate >= 1 && rate <= 3)) errors.push(`Column "${col}": overtime rate must be between 1 and 3`);
    } else if (m.target !== 'short_time' && m.target !== 'ignore') {
      errors.push(`Column "${col}": unknown target "${m.target}"`);
    }
  }
  return errors;
}

/**
 * Work out every employee's new rows (pure).
 * @param {object} p {
 *   rows, mapping, masters, employees, period: {start_date, end_date},
 *   existing: { inputs: [], overtime: [], short: [] }   rows of this period (all employees),
 *   lockedEmployeeIds: Set<number>
 * }
 * @returns {{ plans: [...], errors: [{row, employee_number, message}], totals, summary }}
 */
function buildPlan(p) {
  const masters = p.masters || [];
  const masterById = new Map(masters.map(m => [String(m.id), m]));
  const mapping = p.mapping || {};
  const empByNo = new Map();
  for (const e of p.employees || []) if (e.employee_number != null && normNo(e.employee_number)) empByNo.set(normNo(e.employee_number), e);
  const locked = p.lockedEmployeeIds || new Set();
  const byEmp = (list) => {
    const m = new Map();
    for (const r of list || []) {
      const k = Number(r.employee_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const exInputs = byEmp(p.existing && p.existing.inputs);
  const exOt = byEmp(p.existing && p.existing.overtime);
  const exSt = byEmp(p.existing && p.existing.short);

  const errors = [];
  const plans = [];
  const totals = {};
  const seen = new Map();
  const mapped = Object.entries(mapping).filter(([, m]) => m && m.target && m.target !== 'ignore');
  for (const [col] of mapped) totals[col] = 0;

  for (const row of p.rows || []) {
    const rowNo = row.row;
    const no = normNo(row.employee_number);
    const fail = (message) => errors.push({ row: rowNo, employee_number: row.employee_number || '', message });
    if (!no) { fail('employee_number is empty'); continue; }
    if (seen.has(no)) { fail(`employee ${row.employee_number} appears twice in the file (rows ${seen.get(no)} and ${rowNo})`); continue; }
    seen.set(no, rowNo);
    const emp = empByNo.get(no);
    if (!emp) { fail(`no employee with number ${row.employee_number} in this company`); continue; }
    const elig = payrollEligibility(emp, p.period && p.period.start_date, p.period && p.period.end_date);
    if (!elig.eligible) { fail(elig.message || 'employee cannot be paid in this month'); continue; }
    if (locked.has(Number(emp.id))) { fail('this month is already finalized for this employee — reverse the pay run first'); continue; }

    const values = row.values || {};
    const itemAmounts = new Map();      // master id → amount
    const otByRate = new Map();         // rate → hours
    let stHours = 0, stSet = false, otSet = false, bad = false;
    for (const [col, m] of mapped) {
      const v = parseValue(values[col]);
      if (v === null || v === 0) continue;
      if (Number.isNaN(v)) { fail(`"${values[col]}" in column "${col}" is not a number`); bad = true; continue; }
      if (v < 0) { fail(`column "${col}" is negative (${v}) — enter deductions and hours as positive numbers`); bad = true; continue; }
      if (m.target === 'item') {
        itemAmounts.set(String(m.master_item_id), r2((itemAmounts.get(String(m.master_item_id)) || 0) + v));
      } else if (m.target === 'overtime') {
        const rate = m.rate == null ? 1.5 : Number(m.rate);
        otByRate.set(rate, r2((otByRate.get(rate) || 0) + v));
        otSet = true;
      } else if (m.target === 'short_time') {
        stHours = r2(stHours + v); stSet = true;
      }
    }
    if (bad) continue;
    for (const [col, m] of mapped) {
      const v = parseValue(values[col]);
      if (typeof v === 'number' && v > 0 && m) totals[col] = r2(totals[col] + v);
    }

    const plan = {
      row: rowNo, employee_id: Number(emp.id), employee_number: emp.employee_number,
      name: [emp.first_name, emp.last_name].filter(Boolean).join(' '),
      inputs: null, overtime: null, short_time: null, changes: [], warnings: []
    };

    if (itemAmounts.size) {
      const replaced = new Set(itemAmounts.keys());
      // payroll_item_id points at payroll_items (not the master list) and is normally null —
      // an input belongs to a Payroll Items row by name + side, exactly as Paytime links it.
      const kept = (exInputs.get(plan.employee_id) || []).filter(r => {
        const master = ItemLink.pickMaster(masters, { name: r.description, type: r.item_type });
        return !(master && replaced.has(String(master.id)));
      });
      const fresh = [...itemAmounts.entries()].map(([id, amount]) => {
        const master = masterById.get(id);
        plan.changes.push({ kind: 'item', item: master.item_name, side: inputSide(master), amount });
        return { item_type: inputSide(master), description: master.item_name, amount,
          affects_uif: master.affects_uif === null || master.affects_uif === undefined ? true : master.affects_uif === true };
      });
      plan.inputs = kept.map(r => ({ payroll_item_id: r.payroll_item_id == null ? null : r.payroll_item_id,
        description: r.description, amount: Number(r.amount) || 0, item_type: r.item_type,
        affects_uif: r.affects_uif === null || r.affects_uif === undefined ? true : r.affects_uif === true })).concat(fresh);
    }
    if (otSet) {
      const other = (exOt.get(plan.employee_id) || []).filter(r => r.source && r.source !== 'manual');
      if (other.length) plan.warnings.push(`already has ${r2(other.reduce((s, r) => s + Number(r.hours || 0), 0))} overtime hours from Attendance — these stay; check the file's hours exclude them`);
      plan.overtime = other.map(r => ({ hours: Number(r.hours) || 0, rate_multiplier: Number(r.rate_multiplier) || 1.5,
        description: r.description || 'Overtime', source: r.source }))
        .concat([...otByRate.entries()].map(([rate, hours]) => {
          plan.changes.push({ kind: 'overtime', rate, hours });
          return { hours, rate_multiplier: rate, description: rate === 1.5 ? 'Overtime' : `Overtime ${rate}x`, source: 'manual' };
        }));
    }
    if (stSet) {
      const other = (exSt.get(plan.employee_id) || []).filter(r => r.source && r.source !== 'manual');
      if (other.length) plan.warnings.push(`already has ${r2(other.reduce((s, r) => s + Number(r.hours_missed || 0), 0))} short-time hours from Attendance / unpaid leave — these stay`);
      plan.short_time = other.map(r => ({ hours_missed: Number(r.hours_missed) || 0, description: r.description || 'Short time', source: r.source }))
        .concat([{ hours_missed: stHours, description: 'Short time', source: 'manual' }]);
      plan.changes.push({ kind: 'short_time', hours: stHours });
    }
    if (plan.changes.length) plans.push(plan);
  }

  return {
    plans, errors, totals,
    summary: {
      rows: (p.rows || []).length, employees_changed: plans.length, errors: errors.length,
      warnings: plans.reduce((s, x) => s + x.warnings.length, 0),
      entries: plans.reduce((s, x) => s + x.changes.length, 0)
    }
  };
}

// ─── DB ──────────────────────────────────────────────────────────────────────

/** Every row of a query (fetchAllRows pages past the 1000-row cap); throws on error. */
async function allRows(makeQuery, what) {
  const { data, error } = await fetchAllRows(makeQuery);
  if (error) throw new Error('Could not load ' + what + ': ' + error.message);
  return data || [];
}

async function loadMasters(supabase, companyId) {
  const { data, error } = await supabase.from('payroll_items_master')
    .select('id, item_code, item_name, item_type, category, affects_uif, irp5_code, is_active')
    .eq('company_id', companyId);
  if (error) throw new Error('Could not load payroll items: ' + error.message);
  return data || [];
}

/**
 * Validate (dryRun) or write one month's inputs for ONE company.
 * @returns {{ dry_run, period_key, plans, errors, totals, summary, written?, failed? }}
 */
async function runBulkInputs(supabase, { companyId, periodKey, rows, mapping, dryRun }) {
  if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) throw Object.assign(new Error('period_key must look like 2026-11'), { status: 400 });
  const { data: period, error: pErr } = await supabase.from('payroll_periods')
    .select('id, start_date, end_date, period_key').eq('company_id', companyId).eq('period_key', periodKey).maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!period) throw Object.assign(new Error(`Pay period ${periodKey} does not exist for this company yet — open it in Paytime first`), { status: 404 });

  const masters = await loadMasters(supabase, companyId);
  const mapErrors = checkMapping(mapping, masters);
  if (mapErrors.length) {
    return { dry_run: true, period_key: periodKey, plans: [], errors: mapErrors.map(m => ({ row: null, employee_number: '', message: m })),
      totals: {}, summary: { rows: rows.length, employees_changed: 0, errors: mapErrors.length, warnings: 0, entries: 0 } };
  }

  // employees.employee_code is what the app shows as "employee number" (same as historicalImport).
  const employees = (await allRows(() => supabase.from('employees')
    .select('id, employee_code, first_name, last_name, is_active, hire_date, termination_date').eq('company_id', companyId), 'employees'))
    .map(e => Object.assign({}, e, { employee_number: e.employee_code }));
  const sel = (table, cols) => allRows(() => supabase.from(table).select('employee_id, ' + cols)
    .eq('company_id', companyId).eq('payroll_period_id', period.id).eq('is_deleted', false), table);
  const [inputs, overtime, short] = await Promise.all([
    sel('payroll_period_inputs', 'payroll_item_id, description, amount, item_type, affects_uif'),
    sel('payroll_overtime', 'hours, rate_multiplier, description, source'),
    sel('payroll_short_time', 'hours_missed, description, source')
  ]);
  const snaps = await allRows(() => supabase.from('payroll_snapshots').select('employee_id')
    .eq('company_id', companyId).eq('period_key', periodKey).eq('is_locked', true).neq('status', 'reversed'), 'payslips');

  const plan = buildPlan({ rows, mapping, masters, employees, period, existing: { inputs, overtime, short },
    lockedEmployeeIds: new Set(snaps.map(s => Number(s.employee_id))) });
  const out = Object.assign({ dry_run: !!dryRun || plan.errors.length > 0, period_key: periodKey }, plan);
  if (dryRun || plan.errors.length) return out;

  // Employees are independent (each table write is its own transaction), so a few run side by
  // side — 32 employees one after the other took about a minute and looked like a frozen page.
  const written = [], failed = [];
  const writeOne = async (pl) => {
    try {
      const base = { companyId, employeeId: pl.employee_id, periodId: period.id, periodKey };
      if (pl.inputs) await replacePeriodRows(supabase, Object.assign({ table: 'payroll_period_inputs', rows: pl.inputs }, base));
      if (pl.overtime) await replacePeriodRows(supabase, Object.assign({ table: 'payroll_overtime', rows: pl.overtime }, base));
      if (pl.short_time) await replacePeriodRows(supabase, Object.assign({ table: 'payroll_short_time', rows: pl.short_time }, base));
      written.push(pl.employee_number);
    } catch (e) {
      failed.push({ employee_number: pl.employee_number, message: e.message });
    }
  };
  const PARALLEL = 6;
  for (let i = 0; i < plan.plans.length; i += PARALLEL) {
    await Promise.all(plan.plans.slice(i, i + PARALLEL).map(writeOne));
  }
  return Object.assign(out, { written, failed });
}

module.exports = { parseValue, isBasicSalary, inputSide, suggestTarget, checkMapping, buildPlan, loadMasters, runBulkInputs };
