'use strict';
/**
 * import_historical_payroll_pennygrow.js
 * ============================================================================
 * Real client import: SimplePay historical payslips (2026-03..2026-07) into
 * Pennygrow's live Paytime data (company_id=2, trading as "Turkstra Outlet").
 *
 * This is the REAL counterpart to the proof-of-concept run against company 51
 * ("Infinite Legacy — TEST") in import_historical_payroll_simplepay.js. It is
 * NOT a copy-paste of that script with the company_id swapped — company 2
 * already has real employee records (with real tax/ID numbers) and already
 * had in-progress DRAFT payroll for March 2026, so this script:
 *
 *   1. NEVER creates employees — maps CSV rows to EXISTING employee ids only
 *      (hardcoded map below, confirmed with the user). Never touches
 *      tax_number/id_number on a real employee record.
 *   2. NEVER overwrites a LOCKED/finalized snapshot (CLAUDE.md Rule E6) — if
 *      one is found for an employee+period, the script aborts with an error
 *      rather than silently replacing real finalized payroll.
 *   3. DOES delete an existing DRAFT (is_locked=false) snapshot before
 *      inserting the SimplePay figures for that employee+period — explicitly
 *      confirmed with the user for the pre-existing March 2026 drafts. Same
 *      "delete draft, then insert" pattern the normal Execute Payroll route
 *      already uses (payruns.js:339-344).
 *   4. Updates existing payroll_periods rows (pay_date/status) rather than
 *      only inserting, since 2026-03/05/07 already existed as 'draft'.
 *
 * Run from: accounting-ecosystem/backend/
 * Usage:    node scripts/import_historical_payroll_pennygrow.js
 * ============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const PayrollHistoryService = require('../modules/payroll/services/PayrollHistoryService');
const PayrollEngine = require('../core/payroll-engine');

const TARGET_COMPANY_ID = 2; // Pennygrow (Pty) Ltd — trading as "Turkstra Outlet"
const EXPECTED_COMPANY_NAME_FRAGMENT = 'PENNYGROW';
const CSV_PATH = path.resolve(__dirname, 'data/simplepay_pennygrow_2026-03_to_2026-07.csv');
const IMPORT_SOURCE_TAG = 'simplepay_import';
const IMPORTED_BY_USER_ID = null;

// Confirmed with user (2026-08-16): CSV "TURKSTRA, SONETTE" is the same
// person as the existing employee record "Sonnet Turkstra" (id=263) —
// a spelling variant between the two systems, not a different person.
const EMPLOYEE_ID_MAP = {
  'natasja|fourie': 260,
  'cornelia jacoba|hall': 261,
  'christiaan|turkstra': 262,
  'sonette|turkstra': 263 // CSV spelling "Sonette" -> real record "Sonnet Turkstra"
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ── CSV parsing helpers (identical to the test-company script) ─────────────

function parseMoney(raw) {
  if (raw == null) return 0;
  const cleaned = String(raw)
    .replace(/R/g, '')
    .replace(/\s/g, '')
    .replace(/ /g, '')
    .replace(',', '.')
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function titleCase(s) {
  return String(s).trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);

  const headerIdx = lines.findIndex(l => l.startsWith('Employee;Date;'));
  if (headerIdx === -1) throw new Error('Could not find header row in CSV');

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith(';') || line.toUpperCase().startsWith('TOTAL;')) continue;

    const c = line.split(';');
    const [lastNameRaw, firstNameRaw] = c[0].split(',').map(s => (s || '').trim());

    rows.push({
      employeeNameRaw: c[0].trim(),
      first_name: titleCase(firstNameRaw),
      last_name: titleCase(lastNameRaw),
      date: c[1].trim(),
      annualBonus: parseMoney(c[2]),
      basicSalary: parseMoney(c[4]),
      overtime: parseMoney(c[6]),
      shortTime: parseMoney(c[7]),
      staffLoans: parseMoney(c[8]),
      paye: parseMoney(c[9]),
      uifEmployee: parseMoney(c[10]),
      sdlEmployer: parseMoney(c[11]),
      uifEmployer: parseMoney(c[12]),
      taxableGross: parseMoney(c[13]),
      grossRemuneration: parseMoney(c[14]),
      nettPay: parseMoney(c[18])
    });
  }
  return rows;
}

function periodKeyFromDate(dateStr) {
  return dateStr.slice(0, 7);
}

function taxYearForPeriod(periodKey) {
  const [y, m] = periodKey.split('-').map(Number);
  return m >= 3 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

async function ensureAnnualBonusInput(employeeId, period, r) {
  if (!(r.annualBonus > 0)) return;

  const { data: existingInput } = await supabase
    .from('payroll_period_inputs')
    .select('id')
    .eq('company_id', TARGET_COMPANY_ID)
    .eq('employee_id', employeeId)
    .eq('payroll_period_id', period.id)
    .eq('description', 'Annual Bonus')
    .eq('is_deleted', false)
    .maybeSingle();

  if (existingInput) return;

  const { error: piErr } = await supabase.from('payroll_period_inputs').insert({
    company_id: TARGET_COMPANY_ID,
    employee_id: employeeId,
    payroll_period_id: period.id,
    description: 'Annual Bonus',
    amount: r.annualBonus,
    item_type: 'earning',
    affects_uif: true,
    is_taxable: true,
    taxable_percentage: 100,
    is_deleted: false
  });
  if (piErr) throw new Error(`payroll_period_inputs insert failed: ${piErr.message}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Historical Payroll Import (SimplePay -> Paytime) — PENNYGROW (LIVE CLIENT) ===\n');
  const placeholderFieldsUsed = []; // per feedback_data_import_missing_fields_rule — report, never hide

  // STEP 0: Guard — verify target company is really Pennygrow.
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('id, company_name, trading_name')
    .eq('id', TARGET_COMPANY_ID)
    .single();
  if (companyErr || !company) {
    console.error(`ABORT: company_id=${TARGET_COMPANY_ID} not found (${companyErr && companyErr.message}).`);
    process.exit(1);
  }
  const nameCheck = `${company.company_name || ''} ${company.trading_name || ''}`.toUpperCase();
  if (!nameCheck.includes(EXPECTED_COMPANY_NAME_FRAGMENT)) {
    console.error(`ABORT: company_id=${TARGET_COMPANY_ID} name "${company.company_name}" does not look like Pennygrow. Refusing to write.`);
    process.exit(1);
  }
  console.log(`✅ Target company verified: [${company.id}] ${company.company_name} (${company.trading_name})\n`);

  // STEP 1: Parse CSV
  const rows = parseCsv(CSV_PATH);
  console.log(`✅ Parsed ${rows.length} payslip rows from CSV.\n`);

  // STEP 2: Resolve CSV rows to EXISTING employee ids only — never create.
  const employeeIdByKey = {};
  for (const key of Object.keys(EMPLOYEE_ID_MAP)) {
    const employeeId = EMPLOYEE_ID_MAP[key];
    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('id, first_name, last_name, tax_number, id_number, company_id')
      .eq('id', employeeId)
      .maybeSingle();
    if (empErr || !emp) throw new Error(`Mapped employee id=${employeeId} (key=${key}) not found — aborting.`);
    if (emp.company_id !== TARGET_COMPANY_ID) {
      throw new Error(`Mapped employee id=${employeeId} belongs to company_id=${emp.company_id}, not ${TARGET_COMPANY_ID} — aborting.`);
    }
    if (!emp.tax_number || !emp.id_number) {
      throw new Error(`Employee id=${employeeId} (${emp.first_name} ${emp.last_name}) is missing tax_number or id_number — real client data must not proceed without it. Aborting.`);
    }
    employeeIdByKey[key] = employeeId;
    console.log(`  = Mapped: ${emp.first_name} ${emp.last_name} (id=${employeeId}, real tax_number/id_number on file — untouched)`);
  }
  console.log('');

  // STEP 3: Ensure payroll_items_master IRP5 mappings (never overwrite an existing code)
  const irp5Items = [
    { item_code: 'BASIC', item_name: 'Basic Salary', item_type: 'earning', category: 'salary', is_taxable: true, is_recurring: true, sort_order: 1, irp5_code: '3601' },
    { item_code: 'BONUS', item_name: 'Annual Bonus', item_type: 'earning', category: 'bonus', is_taxable: true, is_recurring: false, sort_order: 30, irp5_code: '3605' }
  ];
  for (const item of irp5Items) {
    const { data: existingItem, error: findErr } = await supabase
      .from('payroll_items_master')
      .select('id, irp5_code')
      .eq('company_id', TARGET_COMPANY_ID)
      .eq('item_code', item.item_code)
      .maybeSingle();
    if (findErr) throw new Error(`payroll_items_master lookup failed: ${findErr.message}`);

    if (!existingItem) {
      const { error: insErr } = await supabase.from('payroll_items_master').insert({
        company_id: TARGET_COMPANY_ID,
        item_code: item.item_code,
        item_name: item.item_name,
        item_type: item.item_type,
        category: item.category,
        is_taxable: item.is_taxable,
        is_recurring: item.is_recurring,
        sort_order: item.sort_order,
        irp5_code: item.irp5_code,
        irp5_code_updated_at: new Date().toISOString()
      });
      if (insErr) throw new Error(`payroll_items_master insert failed for ${item.item_code}: ${insErr.message}`);
      console.log(`  + Created payroll item ${item.item_code} "${item.item_name}" -> IRP5 ${item.irp5_code}`);
    } else if (!existingItem.irp5_code) {
      const { error: updErr } = await supabase.from('payroll_items_master')
        .update({ irp5_code: item.irp5_code, irp5_code_updated_at: new Date().toISOString() })
        .eq('id', existingItem.id);
      if (updErr) throw new Error(`payroll_items_master IRP5 backfill failed for ${item.item_code}: ${updErr.message}`);
      console.log(`  ~ Backfilled missing IRP5 code on ${item.item_code} -> ${item.irp5_code}`);
    } else {
      console.log(`  = ${item.item_code} already has IRP5 code ${existingItem.irp5_code} — left untouched (Rule B6/B9).`);
    }
  }
  console.log('');

  // STEP 4: Ensure payroll_periods rows — INSERT missing, UPDATE existing
  // (2026-03/05/07 already existed as 'draft' with no pay_date).
  const uniquePeriodKeys = [...new Set(rows.map(r => periodKeyFromDate(r.date)))].sort();
  const periodByKey = {};
  for (const periodKey of uniquePeriodKeys) {
    const [pyear, pmonth] = periodKey.split('-').map(Number);
    const startDate = `${pyear}-${String(pmonth).padStart(2, '0')}-01`;
    const lastDay = new Date(pyear, pmonth, 0).getDate();
    const endDate = `${pyear}-${String(pmonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const payDate = `${pyear}-${String(pmonth).padStart(2, '0')}-25`;
    const monthName = new Date(pyear, pmonth - 1, 1).toLocaleString('en-ZA', { month: 'long', year: 'numeric' });

    const { data: existingPeriod, error: findErr } = await supabase
      .from('payroll_periods')
      .select('id, period_key, start_date, end_date, status')
      .eq('company_id', TARGET_COMPANY_ID)
      .eq('period_key', periodKey)
      .maybeSingle();
    if (findErr) throw new Error(`payroll_periods lookup failed: ${findErr.message}`);

    if (existingPeriod) {
      const { data: updated, error: updErr } = await supabase
        .from('payroll_periods')
        .update({ pay_date: payDate, status: 'paid' })
        .eq('id', existingPeriod.id)
        .select('id, period_key, start_date, end_date')
        .single();
      if (updErr) throw new Error(`payroll_periods update failed for ${periodKey}: ${updErr.message}`);
      periodByKey[periodKey] = updated;
      console.log(`  ~ Updated existing period: ${periodKey} (id=${existingPeriod.id}, was status='${existingPeriod.status}' -> 'paid', pay_date=${payDate})`);
      continue;
    }

    const { data: created, error: insErr } = await supabase
      .from('payroll_periods')
      .insert({
        company_id: TARGET_COMPANY_ID,
        period_key: periodKey,
        period_name: monthName,
        start_date: startDate,
        end_date: endDate,
        pay_date: payDate,
        status: 'paid'
      })
      .select('id, period_key, start_date, end_date')
      .single();
    if (insErr) throw new Error(`payroll_periods insert failed for ${periodKey}: ${insErr.message}`);

    periodByKey[periodKey] = created;
    console.log(`  + Created period: ${periodKey} (${monthName}, pay_date=${payDate})`);
  }
  console.log('');

  // STEP 5: Build + save snapshots
  //   - LOCKED existing snapshot for employee+period -> ABORT (never overwrite real finalized payroll).
  //   - DRAFT (unlocked) existing snapshot -> DELETE then insert (confirmed with user for the
  //     pre-existing March 2026 drafts; same "delete draft, then insert" pattern payruns.js uses).
  let createdCount = 0, deletedDraftCount = 0;
  const totals = { gross: 0, paye: 0, uifEmployee: 0, sdlEmployer: 0, net: 0 };

  for (const r of rows) {
    const empKey = `${r.first_name}|${r.last_name}`.toLowerCase();
    const employeeId = employeeIdByKey[empKey];
    if (!employeeId) throw new Error(`No employee mapping for CSV row "${r.employeeNameRaw}" — aborting.`);
    const periodKey = periodKeyFromDate(r.date);
    const period = periodByKey[periodKey];

    const { data: existingAny, error: existErr } = await supabase
      .from('payroll_snapshots')
      .select('id, is_locked, status')
      .eq('company_id', TARGET_COMPANY_ID)
      .eq('employee_id', employeeId)
      .eq('period_key', periodKey)
      .maybeSingle();
    if (existErr) throw new Error(`payroll_snapshots lookup failed: ${existErr.message}`);

    if (existingAny && existingAny.is_locked) {
      throw new Error(
        `ABORT: employee_id=${employeeId} period=${periodKey} already has a LOCKED/finalized snapshot ` +
        `(id=${existingAny.id}). Refusing to overwrite real finalized payroll (CLAUDE.md Rule E6). ` +
        `Resolve manually before re-running.`
      );
    }
    if (existingAny && !existingAny.is_locked) {
      const { error: delErr } = await supabase.from('payroll_snapshots').delete().eq('id', existingAny.id);
      if (delErr) throw new Error(`Failed to delete existing draft snapshot id=${existingAny.id}: ${delErr.message}`);
      deletedDraftCount++;
      console.log(`  - Deleted existing DRAFT snapshot for ${r.first_name} ${r.last_name} / ${periodKey} (confirmed with user)`);
    }

    const onceOffTaxableGross = r.annualBonus;
    const periodicTaxableGross = r.taxableGross - r.annualBonus;
    const taxYear = taxYearForPeriod(periodKey);

    const currentInputs = [];
    if (r.annualBonus > 0) {
      currentInputs.push({
        description: 'Annual Bonus',
        amount: r.annualBonus,
        type: 'earning',
        tax_treatment: 'taxable',
        affects_uif: true,
        paye_projection_type: 'ONCE_OFF',
        taxable_percentage: 100
      });
    }

    const calculationInput = {
      basic_salary: r.basicSalary,
      regular_inputs: [],
      workSchedule: [],
      hours_per_day: 8,
      start_date: null,
      end_date: null,
      period_start_date: period.start_date,
      period_end_date: period.end_date,
      currentInputs,
      overtime: [],
      shortTime: [],
      multiRate: [],
      employeeOptions: {
        age: null,
        medicalMembers: 0,
        taxDirective: null,
        rebateCode: 'R',
        is_director: false,
        sdl_registered: true,
        uif_registered: true,
        voluntaryTaxConfig: null
      },
      period: periodKey,
      ytdData: null
    };

    const calculationOutput = {
      gross: r.grossRemuneration,
      taxableGross: r.taxableGross,
      paye: r.paye,
      paye_base: r.paye,
      voluntary_paye_adjustment: 0,
      voluntary_overdeduction: 0,
      uif: r.uifEmployee,
      sdl: r.sdlEmployer,
      deductions: r.staffLoans,
      net: r.nettPay,
      negativeNetPay: r.nettPay < 0,
      medicalCredit: 0,
      overtimeAmount: r.overtime,
      shortTimeAmount: r.shortTime,
      preTaxDeductions: 0,
      netOnlyDeductions: r.staffLoans,
      periodicTaxableGross: PayrollEngine.r2(periodicTaxableGross),
      onceOffTaxableGross: PayrollEngine.r2(onceOffTaxableGross),
      uifApplicableGross: r.grossRemuneration,
      uifExcludedEarnings: 0,
      uif_employer: r.uifEmployer,
      taxBeforeRebate: 0,
      rebate: 0,
      primary_rebate_annual: 0,
      secondary_rebate_annual: 0,
      tertiary_rebate_annual: 0,
      uif_monthly_cap: 0,
      marginal_rate: '',
      marginal_bracket: '',
      tax_year: taxYear,
      is_director: false,
      uif_exempt: false,
      _meta: {
        calculatedAt: new Date().toISOString(),
        engineVersion: 'external-import-simplepay-v1',
        schemaVersion: '1.0',
        calculationMethod: 'imported',
        startDate: period.start_date,
        endDate: period.end_date,
        resolvedTaxYear: taxYear,
        taxYear: taxYear,
        taxConfig: null,
        rebatePrimary: null,
        rebateSecondary: null,
        rebateTertiary: null,
        ytdMethod: 'imported',
        ytdSource: 'simplepay_import',
        ytdTaxYear: null,
        ytdPriorPeriodsCount: 0
      }
    };

    const snapshot = PayrollHistoryService.prepareSnapshot(
      TARGET_COMPANY_ID,
      employeeId,
      period.id,
      periodKey,
      calculationInput,
      calculationOutput,
      IMPORTED_BY_USER_ID
    );
    snapshot.status = 'finalized';
    snapshot.is_locked = true;
    snapshot.finalized_by = IMPORTED_BY_USER_ID;
    snapshot.finalized_at = new Date().toISOString();
    snapshot.source = IMPORT_SOURCE_TAG;

    const saved = await PayrollHistoryService.saveSnapshot(supabase, snapshot, null);
    const { error: sourceErr } = await supabase
      .from('payroll_snapshots')
      .update({ source: IMPORT_SOURCE_TAG })
      .eq('id', saved.id);
    if (sourceErr) throw new Error(`Failed to tag snapshot source: ${sourceErr.message}`);

    await ensureAnnualBonusInput(employeeId, period, r);

    totals.gross += r.grossRemuneration;
    totals.paye += r.paye;
    totals.uifEmployee += r.uifEmployee;
    totals.sdlEmployer += r.sdlEmployer;
    totals.net += r.nettPay;
    createdCount++;
    console.log(`  + Snapshot: ${r.first_name} ${r.last_name} / ${periodKey}  gross=R${r.grossRemuneration.toFixed(2)}  paye=R${r.paye.toFixed(2)}  net=R${r.nettPay.toFixed(2)}`);
  }
  console.log('');

  // STEP 6: Update each employee's current basic_salary to their latest imported period.
  // All 4 real employees currently have basic_salary=0 in their live payroll setup —
  // this fixes that for continuity into period 8 (August 2026) onward.
  const latestByEmployee = {};
  for (const r of rows) {
    const empKey = `${r.first_name}|${r.last_name}`.toLowerCase();
    const pk = periodKeyFromDate(r.date);
    if (!latestByEmployee[empKey] || pk > latestByEmployee[empKey].periodKey) {
      latestByEmployee[empKey] = { periodKey: pk, basicSalary: r.basicSalary };
    }
  }
  for (const empKey of Object.keys(latestByEmployee)) {
    const employeeId = employeeIdByKey[empKey];
    const { error: updErr } = await supabase
      .from('employees')
      .update({ basic_salary: latestByEmployee[empKey].basicSalary })
      .eq('id', employeeId)
      .eq('company_id', TARGET_COMPANY_ID);
    if (updErr) throw new Error(`Failed to update current basic_salary for employee ${employeeId}: ${updErr.message}`);
    console.log(`  ~ Updated live basic_salary for employee id=${employeeId} -> R${latestByEmployee[empKey].basicSalary.toFixed(2)} (was R0.00)`);
  }
  console.log('');

  // STEP 7: Summary + verification
  console.log('=== SUMMARY ===');
  console.log(`Snapshots created: ${createdCount}`);
  console.log(`Existing draft snapshots deleted first: ${deletedDraftCount}`);
  console.log(`Placeholder/test data used: ${placeholderFieldsUsed.length === 0 ? 'NONE — all employees already had real tax_number/id_number on file' : placeholderFieldsUsed.join('; ')}`);
  console.log('');
  console.log('Computed totals from imported rows vs. CSV TOTAL row:');
  const expected = { gross: 248864.45, paye: 12944.10, uifEmployee: 2378.88, sdlEmployer: 2488.64, net: 233541.47 };
  for (const key of Object.keys(expected)) {
    const got = PayrollEngine.r2(totals[key]);
    const match = Math.abs(got - expected[key]) < 0.01;
    console.log(`  [${match ? 'PASS' : 'FAIL'}] ${key}: computed=R${got.toFixed(2)}  csvTotal=R${expected[key].toFixed(2)}`);
  }
  console.log('\n=== Import complete ===\n');
}

main().catch(err => {
  console.error('\n❌ Import failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
