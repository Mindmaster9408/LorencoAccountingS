'use strict';

/**
 * ============================================================================
 * Paytime — historical payslip import (spec 12: HI-01/02/03/05/06/07/09/12)
 * ============================================================================
 * Payslips from a previous payroll system are stored EXACTLY as supplied, as
 * locked payroll_snapshots (source = 'screen_import'). Paytime never
 * recalculates them. The payslip view, YTD PAYE, the PAYE recon, EMP201/EMP501
 * and e@syFile all read payroll_snapshots, so an imported month behaves like a
 * month that was finalized in Paytime.
 *
 * One row in    = one employee + one month:
 *   { row, employee_number, period, basic_salary, gross?, taxable_gross?, paye,
 *     uif, uif_employer?, sdl?, net?, overtime_hours?, lines: [{ column, amount }] }
 * lines come from the file's allowance_* / deduction_* / employer_* columns.
 * Every column is mapped once per import (mapping[column]):
 *   { target: 'item', master_item_id }   a Payroll Items row (carries the IRP5 code)
 *   { target: 'overtime' }               overtime (IRP5 3607 via overtimeAmount)
 *   { target: 'short_time' }             short time (always a negative earning)
 *   { target: 'none' }                   kept as its own line, no item (EMP501 flags it)
 *
 * Pure functions first (unit-tested in tests/payroll-historical-import.test.js),
 * DB functions at the bottom. No browser/KV storage anywhere (Part D, HI-12).
 * ============================================================================
 */

const crypto = require('crypto');
const PayrollEngine = require('../../../core/payroll-engine');
const ItemLink = require('./itemLink');
const PeriodSequence = require('./periodSequence');
const PayrollHistoryService = require('./PayrollHistoryService');
const PayrollDataService = require('./PayrollDataService');
const { payrollEligibility } = require('./payrollEligibility');
const { fetchAllRows } = require('./fetchAllRows');   // Supabase caps reads at 1000 rows (audit H2)

const SOURCE_TAG = 'screen_import';
const ENGINE_VERSION = 'external-import-screen-v1';
const r2 = PayrollEngine.r2;
const TOL = 0.01;

// ─── small helpers ───────────────────────────────────────────────────────────

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[R\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Which side of the payslip a file column belongs to, from its prefix. */
function columnSide(column) {
  const c = String(column || '').toLowerCase();
  if (c.indexOf('deduction') === 0) return 'deduction';
  if (c.indexOf('employer') === 0) return 'employer';
  return 'earning';
}

/** 'allowance_75_percent' → '75 percent' (fallback description for unlinked lines). */
function columnLabel(column) {
  const label = String(column || '')
    .replace(/^(allowance|deduction|employer(_contribution)?)_?/i, '')
    .replace(/_/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : String(column || 'Item');
}

const STOP = new Set(['allowance', 'allowances', 'deduction', 'deductions', 'employer', 'contribution', 'the', 'of', 'and', 'for']);
function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/(\d)[.,](\d)/g, '$1$2')       // 7.5 → 75 (so "7.5%" matches "75_percent")
    .split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t));
}

/**
 * Best automatic target for a column (pure). Exact/near name match on the same side
 * wins; overtime / short time columns go to the built-in lines.
 */
function suggestTarget(column, masters) {
  const side = columnSide(column);
  const tk = tokens(column);
  const joined = tk.join(' ');
  if (side === 'earning' && /^(overtime|ot)( pay| amount)?$/.test(joined)) return { target: 'overtime' };
  if (/^short ?time( pay| amount)?$/.test(joined) || joined === 'shorttime') return { target: 'short_time' };
  let best = null, bestScore = 0;
  (masters || []).forEach(m => {
    if (m.is_active === false) return;
    if (ItemLink.sideOf(m.item_type) !== side) return;
    const mt = tokens(m.item_name);
    if (!mt.length || !tk.length) return;
    const a = new Set(tk), b = new Set(mt);
    let inter = 0; a.forEach(t => { if (b.has(t)) inter++; });
    const score = inter / (a.size + b.size - inter);
    if (score > bestScore) { bestScore = score; best = m; }
  });
  if (best && bestScore >= 0.5) return { target: 'item', master_item_id: best.id };
  return { target: 'none' };
}

// ─── row → snapshot (pure) ───────────────────────────────────────────────────

/**
 * Validate one row and build the snapshot payload. Pure — no DB.
 * @param {object} p
 *   row, mapping, masters, period {id,start_date,end_date,period_key}, employee,
 *   companyFlags {sdl_registered}, acceptMismatch, batch {id, file_name, user_id, at}
 * @returns {{ errors: string[], warnings: string[], mismatch: object|null,
 *             totals: object|null, snapshot: object|null }}
 */
function buildImportedSnapshot(p) {
  const { row, mapping = {}, masters = [], period, employee, companyFlags = {}, acceptMismatch = false, batch = {} } = p;
  const errors = [], warnings = [];
  const out = { errors, warnings, mismatch: null, totals: null, snapshot: null };

  const basic = num(row.basic_salary);
  const paye = num(row.paye);
  const uif = num(row.uif);
  if (basic === null || basic < 0) errors.push('Invalid basic salary');
  if (paye === null) errors.push('PAYE is missing');
  if (uif === null) errors.push('UIF is missing');
  if (errors.length) return out;

  // ── lines from the mapped columns ──
  const regularInputs = [];
  const earningLines = [], deductionLines = [], employerLines = [];
  let earningsFromLines = 0, overtimeAmount = 0, shortTimeAmount = 0;
  let deductionsTotal = 0, preTax = 0, netOnly = 0;
  let nonTaxableEarnings = 0, onceOffTaxable = 0, taxableFringe = 0;
  const overtimeHours = num(row.overtime_hours);
  const masterById = {};
  masters.forEach(m => { masterById[String(m.id)] = m; });

  (row.lines || []).forEach(l => {
    const amount = num(l.amount);
    if (!amount) return;                                   // 0 / blank → no line
    const side = columnSide(l.column);
    const map = mapping[l.column] || { target: 'none' };

    if (map.target === 'overtime' || map.target === 'short_time') {
      if (side !== 'earning' && !(map.target === 'short_time' && side === 'deduction')) {
        errors.push(`Column ${l.column}: ${map.target === 'overtime' ? 'overtime' : 'short time'} must be an earnings column`);
        return;
      }
      if (map.target === 'overtime') {
        overtimeAmount += amount;
        earningsFromLines += amount;
        earningLines.push(Object.assign({ section: 'earning', kind: 'overtime', description: 'Overtime', amount: r2(amount) },
          overtimeHours ? { hours: overtimeHours } : {}));
      } else {
        const st = -Math.abs(amount);                        // short time always reduces pay
        shortTimeAmount += Math.abs(amount);
        earningsFromLines += st;
        earningLines.push({ section: 'earning', kind: 'short_time', description: 'Short Time', amount: r2(st) });
      }
      return;
    }

    let master = null;
    if (map.target === 'item') {
      master = masterById[String(map.master_item_id)] || null;
      if (!master) { errors.push(`Column ${l.column}: the chosen payroll item no longer exists`); return; }
      const mSide = ItemLink.sideOf(master.item_type);
      if (mSide !== side) {
        errors.push(`Column ${l.column} is ${side === 'deduction' ? 'a deduction' : side === 'employer' ? 'an employer contribution' : 'an earning'}, but "${master.item_name}" is not`);
        return;
      }
    }
    const description = master ? master.item_name : columnLabel(l.column);
    const type = side === 'deduction' ? 'deduction'
      : side === 'employer' ? (master && master.item_type ? master.item_type : 'employer_contribution')
      : (master && master.item_type && ItemLink.sideOf(master.item_type) === 'earning' ? master.item_type : 'allowance');
    const isTaxable = master ? master.is_taxable !== false : true;
    const pct = master && master.taxable_percentage != null ? Number(master.taxable_percentage) : 100;
    const taxTreatment = side === 'deduction' ? ((master && master.tax_treatment) || 'net_only') : undefined;
    const projection = master && master.paye_projection_type ? master.paye_projection_type : undefined;

    const ri = { description, amount: r2(amount), type, _import_column: l.column };
    if (master) {
      ri.master_item_id = master.id;
      if (master.irp5_code) ri.irp5_code = String(master.irp5_code);
      ri.is_taxable = isTaxable;
      if (pct !== 100) ri.taxable_percentage = pct;
      if (taxTreatment) ri.tax_treatment = taxTreatment;
      if (projection) ri.paye_projection_type = projection;
    }
    regularInputs.push(ri);

    const line = { section: side === 'employer' ? 'employer' : side, kind: 'regular', description, amount: r2(amount), column: l.column };
    if (master) { line.master_item_id = master.id; if (master.irp5_code) line.irp5_code = String(master.irp5_code); }

    if (side === 'deduction') {
      if (taxTreatment === 'pre_tax') { preTax += amount; line.pre_tax = true; } else netOnly += amount;
      deductionsTotal += amount;
      deductionLines.push(line);
    } else if (side === 'employer') {
      if (isTaxable) taxableFringe += amount * pct / 100;
      employerLines.push(line);
    } else {
      earningsFromLines += amount;
      const taxablePart = isTaxable ? amount * pct / 100 : 0;
      nonTaxableEarnings += amount - taxablePart;
      // Once-off for YTD: flagged ONCE_OFF, or coded as an annual bonus (IRP5 3605) —
      // many companies' bonus item still carries the default VARIABLE_AVERAGE flag.
      if (projection === 'ONCE_OFF' || (master && String(master.irp5_code || '') === '3605')) onceOffTaxable += taxablePart;
      if (pct !== 100) line.taxable_percentage = pct;
      earningLines.push(line);
    }
  });
  if (errors.length) return out;

  // ── gross: supplied (authoritative) or derived from the lines ──
  const linesGross = r2(basic + earningsFromLines);
  let gross = num(row.gross);
  if (gross === null) gross = linesGross;
  gross = r2(gross);
  const unallocatedEarnings = r2(gross - linesGross);
  if (unallocatedEarnings < -TOL) {
    errors.push(`The earnings lines (R${linesGross.toFixed(2)}) add up to more than gross (R${gross.toFixed(2)})`);
    return out;
  }

  // ── net check (HI-09) ──
  const expectedNet = r2(gross - paye - uif - deductionsTotal);
  let net = num(row.net);
  if (net === null) net = expectedNet;
  net = r2(net);
  let unallocatedDeductions = 0;
  const netDiff = r2(expectedNet - net);           // > 0: unlisted deductions on the old payslip
  if (Math.abs(netDiff) > TOL) {
    out.mismatch = { expected_net: expectedNet, net, difference: netDiff };
    if (netDiff < 0) {
      errors.push(`Net (R${net.toFixed(2)}) is more than gross − PAYE − UIF − deductions (R${expectedNet.toFixed(2)})`);
      return out;
    }
    if (!acceptMismatch) {
      errors.push(`Net does not add up: gross − PAYE − UIF − deductions = R${expectedNet.toFixed(2)}, file says R${net.toFixed(2)} (difference R${netDiff.toFixed(2)})`);
      return out;
    }
    unallocatedDeductions = netDiff;
    warnings.push(`Net differs by R${netDiff.toFixed(2)} — imported as a "Not allocated" deduction`);
  }
  const totalDeductions = r2(deductionsTotal + unallocatedDeductions);

  // ── employer side ──
  const uifEmployer = num(row.uif_employer) !== null ? r2(num(row.uif_employer)) : r2(uif);
  let sdl = num(row.sdl);
  let sdlSource = 'file';
  if (sdl === null) {
    sdl = companyFlags.sdl_registered === false ? 0 : r2(gross * 0.01);
    sdlSource = 'derived';
  }
  sdl = r2(sdl);

  // ── taxable income (for YTD PAYE of later Paytime months — HI-03) ──
  let taxable = num(row.taxable_gross);
  if (taxable === null) {
    taxable = Math.max(r2(gross - nonTaxableEarnings + taxableFringe - preTax), 0);
  }
  taxable = r2(taxable);
  onceOffTaxable = r2(Math.min(Math.max(onceOffTaxable, 0), taxable));
  const periodicTaxable = r2(taxable - onceOffTaxable);

  // ── payslip lines (stored → the payslip prints exactly these) ──
  const lines = [];
  if (basic) lines.push({ section: 'earning', kind: 'basic', description: 'Basic Salary', amount: r2(basic) });
  earningLines.forEach(l => lines.push(l));
  if (Math.abs(unallocatedEarnings) >= TOL) lines.push({ section: 'earning', kind: 'unallocated', description: 'Not allocated', amount: unallocatedEarnings });
  deductionLines.forEach(l => lines.push(l));
  if (unallocatedDeductions >= TOL) lines.push({ section: 'deduction', kind: 'unallocated', description: 'Not allocated', amount: r2(unallocatedDeductions) });
  lines.push({ section: 'tax', kind: 'paye', description: 'PAYE', amount: r2(paye) });
  if (uif) lines.push({ section: 'tax', kind: 'uif', description: 'UIF', amount: r2(uif) });
  if (uifEmployer) lines.push({ section: 'employer', kind: 'uif_employer', description: 'UIF (employer)', amount: uifEmployer });
  if (sdl) lines.push({ section: 'employer', kind: 'sdl', description: 'SDL', amount: sdl });
  employerLines.forEach(l => lines.push(l));

  const taxYear = PayrollEngine.getTaxYearForPeriod(period.period_key);
  const nowIso = batch.at || new Date().toISOString();
  const calculationOutput = {
    gross, taxableGross: taxable, paye: r2(paye), paye_base: r2(paye),
    voluntary_paye_adjustment: 0, voluntary_overdeduction: 0,
    uif: r2(uif), uif_employer: uifEmployer, sdl,
    deductions: totalDeductions, preTaxDeductions: r2(preTax), netOnlyDeductions: r2(netOnly + unallocatedDeductions),
    net, negativeNetPay: net < 0, medicalCredit: 0,
    overtimeAmount: r2(overtimeAmount), shortTimeAmount: r2(shortTimeAmount),
    periodicTaxableGross: periodicTaxable, onceOffTaxableGross: onceOffTaxable,
    uifApplicableGross: gross, uifExcludedEarnings: 0,
    tax_year: taxYear, sdl_source: sdlSource,
    payslip_lines: lines,
    payslip_check: null,
    _meta: {
      calculatedAt: nowIso, engineVersion: ENGINE_VERSION, schemaVersion: '1.0',
      calculationMethod: 'imported', startDate: period.start_date, endDate: period.end_date,
      resolvedTaxYear: taxYear, taxYear, taxConfig: null,
      ytdMethod: 'imported', ytdSource: SOURCE_TAG
    }
  };
  calculationOutput.payslip_check = PayrollEngine.checkPayslipLines(lines, calculationOutput);
  if (!calculationOutput.payslip_check.ok) {
    errors.push('Internal check failed: payslip lines do not add up to the imported totals');
    return out;
  }

  const calculationInput = {
    basic_salary: r2(basic),
    regular_inputs: regularInputs,
    currentInputs: [], overtime: [], shortTime: [], multiRate: [], workSchedule: [],
    hours_per_day: 8,
    period: period.period_key, period_start_date: period.start_date, period_end_date: period.end_date,
    employeeOptions: {}, ytdData: null,
    _import: {
      source: SOURCE_TAG, batch_id: batch.id || null, file_name: batch.file_name || null,
      row: row.row != null ? row.row : null, imported_by: batch.user_id || null, imported_at: nowIso,
      overtime_hours: overtimeHours || null, mapping, raw: row.raw || null
    }
  };

  const snapshot = PayrollHistoryService.prepareSnapshot(
    employee.company_id, employee.id, period.id, period.period_key,
    calculationInput, calculationOutput, batch.user_id || null
  );
  snapshot.status = 'finalized';
  snapshot.is_locked = true;
  snapshot.finalized_by = batch.user_id || null;
  snapshot.finalized_at = nowIso;

  out.snapshot = snapshot;
  out.totals = { gross, paye: r2(paye), uif: r2(uif), uif_employer: uifEmployer, sdl, deductions: totalDeductions, net };
  return out;
}

/** Can this employee receive a payslip for this month? Inactive is fine for history. */
function importEligibility(emp, period) {
  const e = payrollEligibility(emp, period.start_date, period.end_date);
  if (e.eligible || e.code === 'INACTIVE') return { ok: true, warning: e.code === 'INACTIVE' ? 'Employee is inactive' : null };
  return { ok: false, error: e.message };
}

function currentPeriodKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─── DB ──────────────────────────────────────────────────────────────────────

async function loadMasters(supabase, companyId) {
  const { data, error } = await supabase.from('payroll_items_master')
    .select('id, item_code, item_name, item_type, is_taxable, is_recurring, irp5_code, tax_treatment, paye_projection_type, taxable_percentage, is_active')
    .eq('company_id', companyId);
  if (error) throw new Error('Could not load payroll items: ' + error.message);
  return data || [];
}

/**
 * Validate (dry run) or import a set of rows for ONE company.
 * @returns {{ batch_id, dry_run, results: [...], summary }}
 */
async function runImport(supabase, { companyId, userId, rows, mapping, fileName, acceptMismatch, dryRun }) {
  const masters = await loadMasters(supabase, companyId);
  const companyFlags = await PayrollDataService.fetchCompanyRegistrationFlags(companyId, supabase);

  const { data: emps, error: empErr } = await supabase.from('employees')
    .select('id, company_id, employee_code, first_name, last_name, is_active, hire_date, termination_date')
    .eq('company_id', companyId);
  if (empErr) throw new Error('Could not load employees: ' + empErr.message);
  // employees.employee_code is what the app shows as "employee number" (shared route alias).
  // Active and inactive employees alike — history may predate an End of Service.
  const empByNumber = {};
  (emps || []).forEach(e => {
    const k = String(e.employee_code || '').trim().toUpperCase();
    if (k && !empByNumber[k]) empByNumber[k] = e;
  });

  const periodKeys = [...new Set(rows.map(r => String(r.period || '')).filter(p => /^\d{4}-(0[1-9]|1[0-2])$/.test(p)))];
  const empIds = [...new Set(rows.map(r => empByNumber[String(r.employee_number || '').trim().toUpperCase()]).filter(Boolean).map(e => e.id))];

  // Existing snapshots for these employees in the affected tax years (duplicates + later-locked warnings)
  const yearKeys = [...new Set(periodKeys.flatMap(p => PeriodSequence.taxYearPeriodKeys(p)))];
  let existing = [];
  if (empIds.length && yearKeys.length) {
    const { data, error } = await fetchAllRows(() => supabase.from('payroll_snapshots')
      .select('id, employee_id, period_key, is_locked, status, source')
      .eq('company_id', companyId).in('employee_id', empIds).in('period_key', yearKeys).neq('status', 'reversed'));
    if (error) throw new Error('Could not check existing payslips: ' + error.message);
    existing = data || [];
  }
  const existingFor = (empId, pk) => existing.find(s => s.employee_id === empId && s.period_key === pk);

  const batch = { id: crypto.randomUUID(), file_name: fileName || null, user_id: userId || null, at: new Date().toISOString() };
  const nowKey = currentPeriodKey();
  const periodCache = {};
  const seen = new Set();
  const results = [];

  for (const row of rows) {
    const res = { row: row.row, employee_number: row.employee_number, period: row.period, status: 'error', errors: [], warnings: [] };
    results.push(res);
    const emp = empByNumber[String(row.employee_number || '').trim().toUpperCase()];
    if (!emp) { res.errors.push('Unrecognised employee number'); continue; }
    res.employee_id = emp.id;
    res.employee_name = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
    const pk = String(row.period || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pk)) { res.errors.push('Invalid period: ' + (row.period_raw || row.period || '')); continue; }
    if (pk > nowKey) { res.errors.push('Period is in the future'); continue; }
    const dupKey = emp.id + '|' + pk;
    if (seen.has(dupKey)) { res.errors.push('This employee and month appear more than once in the file'); continue; }
    seen.add(dupKey);

    const periodShape = { id: null, period_key: pk, start_date: `${pk}-01`, end_date: PeriodSequence.periodEndDate(pk) };
    const elig = importEligibility(emp, periodShape);
    if (!elig.ok) { res.errors.push(elig.error); continue; }
    if (elig.warning) res.warnings.push(elig.warning);

    const ex = existingFor(emp.id, pk);
    if (ex && ex.is_locked) {
      res.status = 'skipped';
      res.errors.push(ex.source ? `Already imported (${ex.source}) — skipped` : 'Already finalized in Paytime — skipped');
      continue;
    }
    if (ex && !ex.is_locked) res.warnings.push('An unfinalized Paytime calculation for this month will be replaced');
    const later = existing.filter(s => s.employee_id === emp.id && s.is_locked && !s.source && s.period_key > pk
      && PeriodSequence.taxYearPeriodKeys(pk).includes(s.period_key)).map(s => s.period_key).sort();
    if (later.length) res.warnings.push(`Later months already finalized in Paytime (${later.join(', ')}) — their PAYE was calculated without this month`);

    let period = periodShape;
    if (!dryRun) {
      if (!periodCache[pk]) periodCache[pk] = await PayrollDataService.fetchPeriod(companyId, pk, supabase);
      period = periodCache[pk];
      if (!period) { res.errors.push('Could not create the pay period'); continue; }
    } else {
      period = Object.assign({}, periodShape, { id: 'dry-run' });
    }

    const built = buildImportedSnapshot({ row, mapping, masters, period, employee: emp, companyFlags, acceptMismatch, batch });
    res.errors.push(...built.errors);
    res.warnings.push(...built.warnings);
    res.mismatch = built.mismatch;
    res.totals = built.totals;
    if (built.errors.length) continue;

    if (dryRun) { res.status = 'ok'; continue; }

    try {
      if (ex && !ex.is_locked) {
        const { error: delErr } = await supabase.from('payroll_snapshots').delete()
          .eq('id', ex.id).eq('company_id', companyId).eq('is_locked', false);
        if (delErr) throw new Error(delErr.message);
      }
      const saved = await PayrollHistoryService.saveSnapshot(supabase, built.snapshot, null);
      const { error: srcErr } = await supabase.from('payroll_snapshots')
        .update({ source: SOURCE_TAG }).eq('id', saved.id).eq('company_id', companyId);
      if (srcErr) {
        // Never leave an untagged import behind — it would look engine-calculated.
        await supabase.from('payroll_snapshots').delete().eq('id', saved.id).eq('company_id', companyId);
        throw new Error('could not tag the payslip as imported: ' + srcErr.message);
      }
      res.status = 'imported';
      res.snapshot_id = saved.id;
    } catch (e) {
      res.errors.push('Save failed: ' + e.message);
    }
  }

  const count = (s) => results.filter(r => r.status === s).length;
  const imported = results.filter(r => r.status === (dryRun ? 'ok' : 'imported'));
  const sum = (k) => r2(imported.reduce((t, r) => t + ((r.totals && r.totals[k]) || 0), 0));
  return {
    batch_id: dryRun ? null : batch.id,
    dry_run: !!dryRun,
    results,
    summary: {
      rows: results.length,
      ok: count(dryRun ? 'ok' : 'imported'),
      skipped: count('skipped'),
      errors: count('error'),
      mismatches: results.filter(r => r.mismatch).length,
      periods: [...new Set(imported.map(r => r.period))].sort(),
      totals: { gross: sum('gross'), paye: sum('paye'), uif: sum('uif'), uif_employer: sum('uif_employer'), sdl: sum('sdl'), net: sum('net') }
    }
  };
}

/** Import batches of a company (newest first), from the snapshots themselves. */
async function listBatches(supabase, companyId) {
  const { data, error } = await fetchAllRows(() => supabase.from('payroll_snapshots')
    .select('employee_id, period_key, status, calculation_input->_import, calculation_output->gross, calculation_output->paye, calculation_output->net')
    .eq('company_id', companyId).eq('source', SOURCE_TAG));
  if (error) throw new Error('Could not load imports: ' + error.message);
  const byId = {};
  (data || []).forEach(s => {
    const imp = s._import || {};
    const id = imp.batch_id || 'unknown';
    const b = byId[id] || (byId[id] = {
      batch_id: id, file_name: imp.file_name || null, imported_at: imp.imported_at || null, imported_by: imp.imported_by || null,
      mapping: imp.mapping || null, count: 0, reversed: 0, periods: new Set(), gross: 0, paye: 0, net: 0
    });
    if (s.status === 'reversed') { b.reversed++; return; }
    b.count++;
    b.periods.add(s.period_key);
    b.gross += Number(s.gross) || 0; b.paye += Number(s.paye) || 0; b.net += Number(s.net) || 0;
  });
  return Object.values(byId)
    .map(b => Object.assign(b, { periods: [...b.periods].sort(), gross: r2(b.gross), paye: r2(b.paye), net: r2(b.net) }))
    .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')));
}

/**
 * Undo an import batch (HI-05): reverse its snapshots like a pay-run reversal.
 * An employee is skipped when a later Paytime-calculated month in the same tax
 * year is finalized — that month's PAYE relied on the imported figures.
 */
async function undoBatch(supabase, { companyId, userId, batchId }) {
  const { data: snaps, error } = await fetchAllRows(() => supabase.from('payroll_snapshots')
    .select('id, employee_id, period_key')
    .eq('company_id', companyId).eq('source', SOURCE_TAG).neq('status', 'reversed')
    .eq('calculation_input->_import->>batch_id', batchId));
  if (error) throw new Error('Could not load the import: ' + error.message);
  if (!(snaps || []).length) return { reversed: [], blocked: [], notFound: true };

  const empIds = [...new Set(snaps.map(s => s.employee_id))];
  const yearKeys = [...new Set(snaps.flatMap(s => PeriodSequence.taxYearPeriodKeys(s.period_key)))];
  // Only Paytime-calculated (source IS NULL) finalized months can depend on the import.
  const { data: locked, error: lErr } = await fetchAllRows(() => supabase.from('payroll_snapshots')
    .select('employee_id, period_key, source')
    .eq('company_id', companyId).eq('is_locked', true).neq('status', 'reversed').is('source', null)
    .in('employee_id', empIds).in('period_key', yearKeys));
  if (lErr) throw new Error('Could not check later months: ' + lErr.message);

  const reverseIds = [], blocked = [];
  snaps.forEach(s => {
    const yk = PeriodSequence.taxYearPeriodKeys(s.period_key);
    const later = (locked || []).filter(l => l.employee_id === s.employee_id && !l.source && l.period_key > s.period_key && yk.includes(l.period_key));
    if (later.length) blocked.push({ employee_id: s.employee_id, period_key: s.period_key, later: later.map(l => l.period_key).sort() });
    else reverseIds.push(s.id);
  });

  // In chunks: a long id list would make the request URL too long (and stay under the row cap).
  const reversed = [];
  const at = new Date().toISOString();
  for (let i = 0; i < reverseIds.length; i += 200) {
    const chunk = reverseIds.slice(i, i + 200);
    const { data: upd, error: uErr } = await supabase.from('payroll_snapshots')
      .update({ status: 'reversed', is_locked: false, reversed_at: at, reversed_by: userId || null })
      .eq('company_id', companyId).eq('source', SOURCE_TAG).in('id', chunk).select('id, employee_id, period_key');
    if (uErr) throw new Error(`Undo failed after ${reversed.length} payslip(s) were reversed: ` + uErr.message);
    reversed.push(...(upd || []));
  }
  return { reversed, blocked, notFound: false };
}

module.exports = {
  SOURCE_TAG,
  columnSide, columnLabel, suggestTarget, buildImportedSnapshot, importEligibility, currentPeriodKey,
  loadMasters, runImport, listBatches, undoBatch
};
