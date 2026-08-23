'use strict';
/**
 * import_historical_payroll_simplepay.js
 * ============================================================================
 * Proof-of-concept: import already-finalized historical payslips (exported
 * from SimplePay) into Paytime as locked payroll_snapshots rows.
 *
 * Run from: accounting-ecosystem/backend/
 * Usage:    node scripts/import_historical_payroll_simplepay.js
 *
 * SCOPE / GUARD RAILS (CLAUDE.md Part H, Part E):
 *   - Hardcoded to TARGET_COMPANY_ID = 51 ("Infinite Legacy — TEST"). The
 *     script verifies the company name before writing anything and aborts
 *     if it doesn't match — this must never accidentally run against a real
 *     client or against The Infinite Legacy's own live company (id 1).
 *   - Figures are taken AS-IS from the SimplePay export — never recalculated
 *     by PayrollEngine. Every snapshot is tagged source='simplepay_import'
 *     (migration 025) so it is always identifiable as external, not
 *     engine-calculated, data.
 *   - Idempotent: safe to re-run. Existing employees/items/periods/snapshots
 *     are detected and skipped, never duplicated or overwritten.
 *
 * What this writes:
 *   1. employees          — one row per unique employee name in the CSV
 *                            (placeholder tax_number/id_number — TEST data).
 *   2. payroll_items_master — BASIC / BONUS items with SARS IRP5 codes,
 *                            only if missing (never overwrites an existing
 *                            populated irp5_code — CLAUDE.md Rule B6/B9).
 *   3. payroll_periods     — one row per period_key (2026-03..2026-07),
 *                            status='paid' (already paid out externally).
 *   4. payroll_snapshots   — one locked, finalized row per employee+period,
 *                            via the EXISTING PayrollHistoryService
 *                            (prepareSnapshot/saveSnapshot) — no protected
 *                            payroll files are modified by this script.
 *   5. payroll_period_inputs — once-off line items (e.g. Annual Bonus), so
 *                            they render in the payslip UI's "Current
 *                            Inputs" panel, which reads this table live
 *                            (not the snapshot) — see transactions.js
 *                            GET /period-inputs.
 * ============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const PayrollHistoryService = require('../modules/payroll/services/PayrollHistoryService');
const PayrollEngine = require('../core/payroll-engine');

const TARGET_COMPANY_ID = 51; // "Infinite Legacy — TEST" — see CLAUDE.md Part H
const EXPECTED_COMPANY_NAME_FRAGMENT = 'TEST';
const CSV_PATH = path.resolve(__dirname, 'data/simplepay_pennygrow_2026-03_to_2026-07.csv');
const IMPORT_SOURCE_TAG = 'simplepay_import';
const IMPORTED_BY_USER_ID = null; // no specific user context for a script-driven import

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ── CSV parsing helpers ─────────────────────────────────────────────────────

function parseMoney(raw) {
  if (raw == null) return 0;
  const cleaned = String(raw)
    .replace(/R/g, '')
    .replace(/\s/g, '')     // ordinary + non-breaking spaces (thousands separator)
    .replace(/ /g, '')
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
    // Columns per header:
    // 0 Employee, 1 Date, 2 Annual Bonus, 3 Basic Hourly Pay, 4 Basic Salary,
    // 5 Leave Paid Out, 6 Overtime, 7 Short Time, 8 Staff Loans (custom),
    // 9 Tax (PAYE), 10 UIF - Employee, 11 SDL - Employer, 12 UIF - Employer,
    // 13 Gross Remuneration Taxable Portion, 14 Gross Remuneration,
    // 15 Normal Hours, 16 Overtime Hours, 17 Short Hours, 18 Nett Pay,
    // 19 Normal Rate, 20 Cost to Company
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
  return dateStr.slice(0, 7); // 'YYYY-MM-DD' -> 'YYYY-MM'
}

function taxYearForPeriod(periodKey) {
  const [y, m] = periodKey.split('-').map(Number);
  return m >= 3 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

// Ensures the once-off "Annual Bonus" line item exists in payroll_period_inputs
// (the live table the payslip UI's "Current Inputs" panel reads — see
// transactions.js GET /period-inputs). Independent of whether the snapshot
// itself was just created or already existed, so it's safe to call on every
// resume/re-run without ever duplicating the row.
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
  console.log('\n=== Historical Payroll Import (SimplePay -> Paytime) — PROOF OF CONCEPT ===\n');

  // STEP 0: Guard — verify target company is really the designated test company.
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
    console.error(`ABORT: company_id=${TARGET_COMPANY_ID} name "${company.company_name}" does not look like the test company. Refusing to write.`);
    process.exit(1);
  }
  console.log(`✅ Target company verified: [${company.id}] ${company.company_name}\n`);

  // STEP 1: Parse CSV
  const rows = parseCsv(CSV_PATH);
  console.log(`✅ Parsed ${rows.length} payslip rows from CSV.\n`);

  // STEP 2: Ensure employees exist
  const uniqueEmployees = [];
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.first_name}|${r.last_name}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEmployees.push({ first_name: r.first_name, last_name: r.last_name });
    }
  }

  const employeeIdByKey = {};
  let empSeq = 0;
  for (const emp of uniqueEmployees) {
    empSeq++;
    const key = `${emp.first_name}|${emp.last_name}`.toLowerCase();

    const { data: existing, error: findErr } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('company_id', TARGET_COMPANY_ID)
      .ilike('first_name', emp.first_name)
      .ilike('last_name', emp.last_name)
      .maybeSingle();
    if (findErr) throw new Error(`Employee lookup failed: ${findErr.message}`);

    if (existing) {
      employeeIdByKey[key] = existing.id;
      console.log(`  = Employee already exists: ${emp.first_name} ${emp.last_name} (id=${existing.id})`);
      continue;
    }

    const seqStr = String(empSeq).padStart(3, '0');
    const { data: created, error: insErr } = await supabase
      .from('employees')
      .insert({
        company_id: TARGET_COMPANY_ID,
        first_name: emp.first_name,
        last_name: emp.last_name,
        employee_code: `PGW-${seqStr}`,
        tax_number: `TEST-TAXNO-${seqStr}`,
        id_number: `TEST-IDNO-${seqStr}`,
        hire_date: '2026-01-01',
        employment_status: 'active',
        employment_type: 'permanent',
        payment_method: 'bank_transfer',
        is_active: true
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`Employee insert failed for ${emp.first_name} ${emp.last_name}: ${insErr.message}`);

    employeeIdByKey[key] = created.id;
    console.log(`  + Created employee: ${emp.first_name} ${emp.last_name} (id=${created.id}, placeholder tax/ID numbers — TEST data)`);
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

  // STEP 4: Ensure payroll_periods rows
  const uniquePeriodKeys = [...new Set(rows.map(r => periodKeyFromDate(r.date)))].sort();
  const periodByKey = {};
  for (const periodKey of uniquePeriodKeys) {
    const { data: existingPeriod, error: findErr } = await supabase
      .from('payroll_periods')
      .select('id, period_key, start_date, end_date')
      .eq('company_id', TARGET_COMPANY_ID)
      .eq('period_key', periodKey)
      .maybeSingle();
    if (findErr) throw new Error(`payroll_periods lookup failed: ${findErr.message}`);

    if (existingPeriod) {
      periodByKey[periodKey] = existingPeriod;
      console.log(`  = Period already exists: ${periodKey} (id=${existingPeriod.id})`);
      continue;
    }

    const [pyear, pmonth] = periodKey.split('-').map(Number);
    const startDate = `${pyear}-${String(pmonth).padStart(2, '0')}-01`;
    const lastDay = new Date(pyear, pmonth, 0).getDate();
    const endDate = `${pyear}-${String(pmonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const payDate = `${pyear}-${String(pmonth).padStart(2, '0')}-25`;
    const monthName = new Date(pyear, pmonth - 1, 1).toLocaleString('en-ZA', { month: 'long', year: 'numeric' });

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

  // STEP 5: Build + save snapshots (and once-off payroll_period_inputs rows)
  let createdCount = 0, skippedCount = 0;
  const totals = { gross: 0, paye: 0, uifEmployee: 0, sdlEmployer: 0, net: 0 };

  for (const r of rows) {
    const empKey = `${r.first_name}|${r.last_name}`.toLowerCase();
    const employeeId = employeeIdByKey[empKey];
    const periodKey = periodKeyFromDate(r.date);
    const period = periodByKey[periodKey];

    const existingSnapshot = await PayrollHistoryService.getSnapshot(supabase, TARGET_COMPANY_ID, employeeId, periodKey);
    if (existingSnapshot) {
      console.log(`  = Snapshot already exists, skipping: ${r.first_name} ${r.last_name} / ${periodKey}`);
      await ensureAnnualBonusInput(employeeId, period, r);
      skippedCount++;
      continue;
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
    // saveSnapshot() (PayrollHistoryService.js:396-424) only forwards columns it
    // knows about and does not include `source` — patch it in as a follow-up update
    // since migration 025 added the column after that function was last touched.
    const { error: sourceErr } = await supabase
      .from('payroll_snapshots')
      .update({ source: IMPORT_SOURCE_TAG })
      .eq('id', saved.id);
    if (sourceErr) throw new Error(`Failed to tag snapshot source: ${sourceErr.message}`);

    // Once-off line item -> payroll_period_inputs (live table the payslip UI reads)
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

  // STEP 6: Update each employee's current basic_salary to their latest imported period
  // (continuity for live payroll going forward, e.g. period 8 onward).
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
  }

  // STEP 7: Summary + verification against the CSV's own TOTAL row
  console.log('=== SUMMARY ===');
  console.log(`Snapshots created: ${createdCount}`);
  console.log(`Snapshots skipped (already existed): ${skippedCount}`);
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
