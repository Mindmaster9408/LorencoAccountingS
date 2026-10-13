'use strict';

/**
 * ============================================================================
 * Paytime golden runner — docs/paytime/REGSTELPLAN_2026-10.md §1
 * ============================================================================
 * Runs every scenario in scenarios.js through the real production pipeline:
 *
 *   PayrollDataService.fetchCalculationInputs   (input assembly, YTD from locked snapshots)
 *     → pro-rata detection (mirrors POST /api/payroll/run in routes/payruns.js)
 *     → PayrollCalculationService.calculate     (the backend engine)
 *     → period locked into the in-memory DB before the next period runs
 *
 * Usage:
 *   node tests/golden/run-golden.js            print a summary table
 *   node tests/golden/run-golden.js --update   rewrite baseline.json (ONLY when a fix
 *                                              phase's expected changes are confirmed)
 *
 * tests/golden/golden.test.js fails on ANY difference from baseline.json.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { createFakeSupabase } = require('./fake-supabase');
const { SCENARIOS } = require('./scenarios');
const PayrollDataService = require('../../modules/payroll/services/PayrollDataService');
const PayrollCalculationService = require('../../modules/payroll/services/PayrollCalculationService');
const { getTaxConfigForPeriod } = require('../../modules/payroll/services/taxTables');
const { loadTaxTableSeedRows } = require('../helpers/taxTableSeed');

const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const CID = 900;
const EID = 1;

// Fields recorded per period. Keep stable — adding a field changes every baseline row.
const FIELDS = [
  'gross', 'taxableGross', 'paye', 'paye_base', 'voluntary_paye_adjustment', 'uif', 'uif_employer', 'sdl',
  'deductions', 'net', 'medicalCredit', 'overtimeAmount', 'shortTimeAmount',
  'periodicTaxableGross', 'onceOffTaxableGross', 'prorataFactor'
];
// Extra fields recorded only for scenarios that assert them (keeps other baseline rows unchanged).
const EXTRA_FIELDS = { S12a: ['uifApplicableGross'], S12b: ['uifApplicableGross'] };

function periodDates(key) {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start_date: `${key}-01`, end_date: `${key}-${String(last).padStart(2, '0')}` };
}

// The same rule as Execute Payroll (Fase 5: services/payrollEligibility.js).
const { payrollEligibility } = require('../../modules/payroll/services/payrollEligibility');
function isEligible(emp, ps, pe) { return payrollEligibility(emp, ps, pe).eligible; }

function buildDb(sc) {
  const db = {
    companies: [Object.assign({ id: CID, sdl_registered: true, uif_registered: true }, sc.company || {})],
    employees: [Object.assign({ id: EID, company_id: CID }, sc.employee)],
    employee_payroll_setup: [Object.assign({ employee_id: EID, company_id: CID, uif_exempt: false }, sc.setup || {})],
    employee_work_schedule: [],
    company_payroll_settings: [],
    payroll_items_master: [],
    payroll_items: [],
    employee_payroll_items: [],
    payroll_periods: [],
    payroll_period_inputs: [],
    payroll_overtime: [],
    payroll_short_time: [],
    payroll_multi_rate: [],
    payroll_snapshots: [],
    payroll_kv_store_eco: [],
    // Fase 1: the tax tables production is seeded with (migration 027), one row per tax year.
    payroll_tax_tables: loadTaxTableSeedRows()
  };

  const addMaster = (name, type, cfg) => {
    db.payroll_items_master.push({
      id: db.payroll_items_master.length + 1, company_id: CID, item_name: name,
      item_type: type, is_active: true,
      is_taxable: cfg.is_taxable !== false,
      affects_uif: cfg.affects_uif !== false,
      taxable_percentage: cfg.taxable_percentage != null ? cfg.taxable_percentage : 100,
      tax_treatment: cfg.tax_treatment || 'net_only',
      paye_projection_type: cfg.proj || 'VARIABLE_AVERAGE'
    });
  };
  (sc.master || []).forEach(m => addMaster(m.item_name, m.item_type || 'income', m));

  const regularItems = (sc.items || []).slice();
  if (sc.variableByPeriod) regularItems.push({ kind: 'regular', name: sc.variableByPeriod.name, type: 'income', amount: 0, cfg: { proj: 'VARIABLE_AVERAGE' } });

  regularItems.forEach((it, i) => {
    const cfg = it.cfg || {};
    addMaster(it.name, it.type, cfg);
    const piId = i + 1;
    // Mirrors POST /api/payroll/items/employee: anything not 'deduction' is stored as 'earning'.
    db.employee_payroll_items.push({
      id: 100 + i, company_id: CID, employee_id: EID, payroll_item_id: piId, is_active: true,
      amount: cfg.percentage ? null : it.amount,
      percentage: cfg.percentage || null,
      item_type: it.type === 'deduction' ? 'deduction' : 'earning',
      payroll_items: {
        code: it.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name: it.name, item_category: it.type,
        is_taxable: true, tax_treatment: null,
        paye_projection_type: cfg.proj || 'VARIABLE_AVERAGE', affects_uif: cfg.affects_uif !== false
      }
    });
  });
  return db;
}

async function runScenario(sc) {
  const db = buildDb(sc);
  const supabase = createFakeSupabase(db);
  // Default = production since Fase 1: each period loads ITS OWN tax year from payroll_tax_tables
  // through the real loader (routes/calculate.js, payruns.js). A scenario may pin taxConfig:
  // null = engine code defaults, an object = a fixed override (e.g. the legacy KV table).
  const pinnedTaxConfig = sc.taxConfig;
  const prevMethod = process.env.PAYE_YTD_METHOD;
  // Production default. History: projection_type until 2026-10-12, then Zeabur switched to
  // cumulative (REGSTELPLAN step D.1 — stops the double bonus tax, finding P1).
  process.env.PAYE_YTD_METHOD = sc.method || 'cumulative';

  const results = {};
  try {
    for (const periodKey of Object.keys(sc.periods).sort()) {
      const spec = sc.periods[periodKey] || {};
      const { start_date, end_date } = periodDates(periodKey);
      const periodId = db.payroll_periods.length + 1;
      db.payroll_periods.push({ id: periodId, company_id: CID, period_key: periodKey, start_date, end_date });

      if (sc.variableByPeriod) {
        const row = db.employee_payroll_items.find(r => r.payroll_items.name === sc.variableByPeriod.name);
        row.amount = sc.variableByPeriod.amounts[periodKey] || 0;
      }
      (spec.inputs || []).forEach(ci => {
        const m = db.payroll_items_master.find(x => x.item_name.toLowerCase() === ci.name.toLowerCase());
        db.payroll_period_inputs.push({
          id: db.payroll_period_inputs.length + 1, company_id: CID, employee_id: EID, payroll_period_id: periodId,
          description: ci.name, amount: ci.amount, item_type: ci.type === 'deduction' ? 'deduction' : 'earning',
          affects_uif: m ? m.affects_uif : true, is_taxable: m ? m.is_taxable : true,
          payroll_items: null, is_deleted: false
        });
      });
      const hoursRows = (arr, table) => (arr || []).forEach(h => db[table].push(Object.assign(
        { id: db[table].length + 1, company_id: CID, employee_id: EID, payroll_period_id: periodId, is_deleted: false, description: '' }, h)));
      hoursRows(spec.overtime, 'payroll_overtime');
      hoursRows(spec.shortTime, 'payroll_short_time');
      hoursRows(spec.multiRate, 'payroll_multi_rate');

      const emp = db.employees[0];
      if (!isEligible(emp, start_date, end_date)) { results[periodKey] = { skipped: 'not eligible' }; continue; }

      let out;
      try {
        const inputs = await PayrollDataService.fetchCalculationInputs(CID, EID, periodKey, supabase);
        // Mirrors routes/payruns.js POST /run auto pro-rata detection.
        const s = inputs.start_date, e = inputs.end_date, ps = inputs.period_start_date, pe = inputs.period_end_date;
        const auto = (s && ps && pe && s > ps && s <= pe) || (e && ps && pe && e < pe && e >= ps);
        const taxConfig = pinnedTaxConfig !== undefined ? pinnedTaxConfig
          : await getTaxConfigForPeriod(supabase, CID, periodKey);
        const calc = await PayrollCalculationService.calculate(inputs, {
          startDate: auto ? s : null, endDate: auto ? e : null, useProRata: !!auto, taxConfig
        });
        out = {};
        FIELDS.concat(EXTRA_FIELDS[sc.id] || []).forEach(f => { out[f] = calc[f] === undefined ? null : calc[f]; });
        out.ytdMethod = (calc._meta && calc._meta.ytdMethod) || null;
        db.payroll_snapshots.push({
          id: db.payroll_snapshots.length + 1, company_id: CID, employee_id: EID, period_key: periodKey,
          is_locked: true, status: 'finalized', calculation_output: JSON.parse(JSON.stringify(calc))
        });
      } catch (err) {
        out = { error: err.message };
      }
      results[periodKey] = out;
    }
  } finally {
    if (prevMethod === undefined) delete process.env.PAYE_YTD_METHOD; else process.env.PAYE_YTD_METHOD = prevMethod;
  }
  return results;
}

async function computeAll() {
  const quiet = ['log', 'warn', 'info'].map(k => [k, console[k]]);
  quiet.forEach(([k]) => { console[k] = () => {}; });
  try {
    const all = {};
    for (const sc of SCENARIOS) all[sc.id] = { desc: sc.desc, periods: await runScenario(sc) };
    return all;
  } finally {
    quiet.forEach(([k, fn]) => { console[k] = fn; });
  }
}

module.exports = { computeAll, BASELINE_PATH };

if (require.main === module) {
  computeAll().then(all => {
    if (process.argv.includes('--update')) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(all, null, 2) + '\n');
      console.log('Baseline written: ' + BASELINE_PATH);
    }
    for (const [id, sc] of Object.entries(all)) {
      console.log(`\n${id}  ${sc.desc}`);
      for (const [p, r] of Object.entries(sc.periods)) {
        if (r.error || r.skipped) { console.log(`  ${p}  ${r.error ? 'ERROR ' + r.error : r.skipped}`); continue; }
        console.log(`  ${p}  gross=${r.gross}  paye=${r.paye}  uif=${r.uif}  sdl=${r.sdl}  net=${r.net}  [${r.ytdMethod}]` +
          (r.prorataFactor != null ? `  prorata=${r.prorataFactor}` : ''));
      }
    }
  }).catch(e => { console.error(e); process.exit(1); });
}
