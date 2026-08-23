'use strict';
/**
 * import_historical_payroll_turkstra_bakkery.js
 * ============================================================================
 * Real client import: SimplePay historical payslips (2026-03..2026-07) into
 * Turkstra Bakkery's live Paytime data (company_id=7). 35 employees, far more
 * earning/deduction column types than the Pennygrow import.
 *
 * SAFETY DESIGN (given the size/complexity jump vs. Pennygrow):
 *   - Columns are located by exact header NAME (headers.indexOf), never by
 *     hardcoded position — this file has 39 columns and manual counting
 *     already produced a wrong index once while planning this script.
 *   - Two-phase run: `--verify` (default) parses the CSV and sums every
 *     numeric column across all data rows, comparing each sum to the CSV's
 *     own TOTAL row. Nothing is written to the DB in this phase. Only
 *     `--write` proceeds to the actual import, and only after verification
 *     has already passed in this same run.
 *   - Employee mapping is a hardcoded, human-confirmed map (2026-08-16) to
 *     existing employee ids — never fuzzy-matched. The two identical
 *     "Gerhard Turkstra" records (id=4 senior, id=5 "Jnr") were
 *     disambiguated by the user, not guessed silently.
 *   - 3 employees not yet in the system (Medirwe Badirle Sylvester, Nakedi
 *     Vuelwa Anna, Williams Reshon Harry Shieba) are created with clearly
 *     marked placeholder tax_number/id_number, per the standing rule agreed
 *     2026-08-16 (feedback_data_import_missing_fields_rule) — flagged in the
 *     final report, never silently real-looking.
 *   - IRP5 codes: BASIC->3601, BONUS->3605, EXTRA_PAY->null (uncertain,
 *     flagged) are the only NEW items created. Existing items (7.5%
 *     Allowance->3601, Key Allowance->3713, Commission->3606, Provident
 *     Fund->4003, and 3 null-coded deduction items) are left completely
 *     untouched — confirmed with user not to align them to SimplePay's
 *     column-embedded "- 3605" suggestion (Rule B9).
 *   - payroll_periods 2026-03..07 already existed (status='draft', pay_date
 *     = month-end). Only status is updated to 'paid' — pay_date is left as
 *     the existing month-end convention, NOT overridden to the 25th (that
 *     was Pennygrow's convention, not this company's).
 *   - 32 pre-existing DRAFT March snapshots are deleted before insert
 *     (confirmed with user, same principle as Pennygrow — draft=unlocked,
 *     safe per Rule E6). Any LOCKED snapshot found aborts the whole run.
 *   - Deduction line items (Garnishee, Provident Fund, Salary Advance, etc.)
 *     are summed correctly into the snapshot's `deductions` total (so Nett
 *     Pay is exact) but are NOT itemized individually into
 *     payroll_period_inputs, and the 3 recurring allowances (7.5%, Key,
 *     Team Leader) are NOT set up as ongoing recurring items — both are
 *     explicitly out of scope for this historical-import task and flagged
 *     as a separate follow-up (setting up true recurring config for future
 *     live payroll is a different, riskier kind of change).
 *
 * Run from: accounting-ecosystem/backend/
 * Usage:    node scripts/import_historical_payroll_turkstra_bakkery.js --verify
 *           node scripts/import_historical_payroll_turkstra_bakkery.js --write
 * ============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const PayrollHistoryService = require('../modules/payroll/services/PayrollHistoryService');
const PayrollEngine = require('../core/payroll-engine');

const TARGET_COMPANY_ID = 7; // Turkstra Bakkery (Pty) Ltd
const EXPECTED_COMPANY_NAME_FRAGMENT = 'TURKSTRA BAKKERY';
const CSV_PATH = path.resolve(__dirname, 'data/simplepay_turkstra_bakkery_2026-03_to_2026-07.csv');
const IMPORT_SOURCE_TAG = 'simplepay_import';
const IMPORTED_BY_USER_ID = null;

const MODE = process.argv.includes('--write') ? 'write' : 'verify';

// Confirmed with user 2026-08-16: id=4 = "Gerhard" (senior, ID prefix ~1969),
// id=5 = "Gerhard Jnr" (ID prefix ~2001). Two identical-name records in the
// live system, disambiguated by the user, not guessed silently.
const EMPLOYEE_ID_MAP = {
  'cliffodene fadilla|baard': 9,
  'lengekile richard|bola': 10,
  'walter mothobiso|botlhokwa': 11,
  'mamokete emily|boyisa': 12,
  'antoinette|grimbeek': 13,
  'maureen|jansen van vuuren': 14,
  'wilhelmina hendrika|janse van vuuren': 2,
  'sarah mary|joubert': 15,
  'david mosiako|kalanku': 16,
  'sune|koover': 3,
  'jeffrey pogiso|lebogang': 17,
  'ben|lerefolo': 18,
  'sularo solomon|luka': 19,
  'meriam mmatebono|mahano': 20,
  'nozi georgina|marumo': 21,
  'kagiso|modukanele': 22,
  'mothlalepule maria|mokone': 23,
  'tshokolo|mokotedi': 24,
  'matsheza samuel|molaoli': 25,
  'yvonne|molefe': 26,
  'geelboy|moloi': 27,
  'tshepang|motale': 28,
  'katlego patrick|nakedi': 29,
  'ponto aubrey|ntsoeleng': 30,
  'sheila|ntswaki': 31,
  'nozimanga maki annah|rakuna': 32,
  'cecilie mokiti|thekiso': 33,
  'raseditsi ertius|tlhale': 34,
  'thabo david|tsiane': 35, // DB has "Thabo Dav" — typo variant, same person
  'gerhard|turkstra': 4,
  'gerhard jnr|turkstra': 5,
  'dione esmaerelda|williams': 36
};

// Not yet in the system — created with placeholder tax/ID numbers (standing
// rule agreed 2026-08-16). Real numbers should replace these when available.
const NEW_EMPLOYEES = [
  { key: 'badirle sylvester|medirwe', first_name: 'Badirle Sylvester', last_name: 'Medirwe' },
  { key: 'vuelwa anna|nakedi', first_name: 'Vuelwa Anna', last_name: 'Nakedi' },
  { key: 'reshon harry shieba|williams', first_name: 'Reshon Harry Shieba', last_name: 'Williams' }
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ── CSV parsing (header-name based — see file header comment for why) ─────

function parseMoney(raw) {
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/R/g, '').replace(/\s/g, '').replace(/ /g, '').replace(',', '.').trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function titleCase(s) {
  return String(s).trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

const DEDUCTION_COLUMNS = [
  'Garnishee Deduction',
  'Power of Finance Loan Installment (custom)',
  'Provident Fund - Employee',
  'Repayment of Advance',
  'SACCAWU Union (custom)',
  'Salary Advance (custom)',
  'Savings Deduction (Durban Trip)',
  'Savings Deduction',
  'Staff Loans- Long Term (custom)',
  'Union Membership Fee'
];

function loadCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const headerIdx = lines.findIndex(l => l.startsWith('Employee;Date;'));
  if (headerIdx === -1) throw new Error('Could not find header row in CSV');
  const headers = lines[headerIdx].split(';');

  function colIndex(name) {
    const idx = headers.indexOf(name);
    if (idx === -1) throw new Error(`Column not found in CSV header: "${name}"`);
    return idx;
  }

  const totalLineRaw = lines.find(l => l.toUpperCase().startsWith('TOTAL;'));
  if (!totalLineRaw) throw new Error('Could not find TOTAL row in CSV');
  const totalFields = totalLineRaw.split(';');

  const dataRows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith(';') || line.toUpperCase().startsWith('TOTAL;')) continue;
    dataRows.push(line.split(';'));
  }

  return { headers, colIndex, totalFields, dataRows };
}

module.exports = { loadCsv, parseMoney, titleCase, DEDUCTION_COLUMNS, CSV_PATH };

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ Failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

async function main() {
  console.log(`\n=== Historical Payroll Import — TURKSTRA BAKKERY (LIVE CLIENT) — mode: ${MODE.toUpperCase()} ===\n`);

  const { colIndex, totalFields, dataRows } = loadCsv(CSV_PATH);
  console.log(`Parsed ${dataRows.length} payslip rows.\n`);

  // ── PHASE 1: verify every relevant numeric column against the CSV's own TOTAL row ──
  const VERIFY_COLUMNS = [
    '7.5 % Allowance (custom) - 3605', 'Annual Bonus', 'Basic Salary', 'Extra Pay',
    'Key alowance (custom) - 3605', 'Overtime', 'Short Time', 'Team Leader Allowance (custom) - 3605',
    ...DEDUCTION_COLUMNS,
    'Tax (PAYE)', 'UIF - Employee', 'Voluntary Tax Over-Deduction', 'SDL - Employer', 'UIF - Employer',
    'Gross Remuneration, Taxable Portion (before deductions)', 'Gross Remuneration', 'Nett Pay'
  ];

  let allPass = true;
  console.log('--- Column verification vs. CSV TOTAL row ---');
  for (const name of VERIFY_COLUMNS) {
    const idx = colIndex(name);
    let sum = 0;
    for (const row of dataRows) sum += parseMoney(row[idx]);
    sum = PayrollEngine.r2(sum);
    const expected = PayrollEngine.r2(parseMoney(totalFields[idx]));
    const pass = Math.abs(sum - expected) < 0.02;
    if (!pass) allPass = false;
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}: computed=R${sum.toFixed(2)}  csvTotal=R${expected.toFixed(2)}`);
  }
  console.log('');

  if (!allPass) {
    console.error('❌ Column verification FAILED — column indices may be wrong. Aborting before any DB action.');
    process.exit(1);
  }
  console.log('✅ All columns verified against CSV TOTAL row.\n');

  if (MODE === 'verify') {
    console.log('Verify-only mode — no DB changes made. Re-run with --write to import.\n');
    return;
  }

  await runWrite(colIndex, dataRows);
}

function periodKeyFromDate(dateStr) {
  return dateStr.slice(0, 7);
}
function taxYearForPeriod(periodKey) {
  const [y, m] = periodKey.split('-').map(Number);
  return m >= 3 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

async function ensureAnnualBonusInput(companyId, employeeId, period, amount) {
  if (!(amount > 0)) return;
  const { data: existingInput } = await supabase
    .from('payroll_period_inputs')
    .select('id')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('payroll_period_id', period.id)
    .eq('description', 'Annual Bonus')
    .eq('is_deleted', false)
    .maybeSingle();
  if (existingInput) return;

  const { error } = await supabase.from('payroll_period_inputs').insert({
    company_id: companyId,
    employee_id: employeeId,
    payroll_period_id: period.id,
    description: 'Annual Bonus',
    amount,
    item_type: 'earning',
    affects_uif: true,
    is_taxable: true,
    taxable_percentage: 100,
    is_deleted: false
  });
  if (error) throw new Error(`payroll_period_inputs insert failed: ${error.message}`);
}

async function runWrite(colIndex, dataRows) {
  const placeholderNotes = [];
  const followUpNotes = [];

  // STEP 0: verify target company
  const { data: company, error: companyErr } = await supabase
    .from('companies').select('id, company_name, trading_name').eq('id', TARGET_COMPANY_ID).single();
  if (companyErr || !company) { console.error(`ABORT: company_id=${TARGET_COMPANY_ID} not found.`); process.exit(1); }
  const nameCheck = `${company.company_name || ''} ${company.trading_name || ''}`.toUpperCase();
  if (!nameCheck.includes(EXPECTED_COMPANY_NAME_FRAGMENT)) {
    console.error(`ABORT: company_id=${TARGET_COMPANY_ID} name "${company.company_name}" doesn't look like Turkstra Bakkery.`);
    process.exit(1);
  }
  console.log(`✅ Target company verified: [${company.id}] ${company.company_name}\n`);

  // STEP 1: resolve employees — existing (map) + new (create w/ placeholders)
  const employeeIdByKey = {};
  for (const key of Object.keys(EMPLOYEE_ID_MAP)) {
    const employeeId = EMPLOYEE_ID_MAP[key];
    const { data: emp, error: empErr } = await supabase
      .from('employees').select('id, first_name, last_name, tax_number, id_number, company_id')
      .eq('id', employeeId).maybeSingle();
    if (empErr || !emp) throw new Error(`Mapped employee id=${employeeId} (key=${key}) not found — aborting.`);
    if (emp.company_id !== TARGET_COMPANY_ID) throw new Error(`Employee id=${employeeId} belongs to company ${emp.company_id}, not ${TARGET_COMPANY_ID} — aborting.`);
    if (!emp.id_number) throw new Error(`Employee id=${employeeId} (${emp.first_name} ${emp.last_name}) has no id_number on file — aborting.`);
    if (!emp.tax_number) followUpNotes.push(`Employee "${emp.first_name} ${emp.last_name}" (id=${employeeId}) has no tax_number on file — pre-existing gap, not touched, needs the real number from the client/accountant before IRP5 submission.`);
    employeeIdByKey[key] = employeeId;
  }
  console.log(`✅ Mapped ${Object.keys(EMPLOYEE_ID_MAP).length} existing employees (real tax/ID numbers untouched).\n`);

  let newEmpSeq = 0;
  for (const ne of NEW_EMPLOYEES) {
    newEmpSeq++;
    const seqStr = String(newEmpSeq).padStart(3, '0');
    const placeholderTax = `TEST-TAXNO-TB${seqStr}`;
    const placeholderId = `TEST-IDNO-TB${seqStr}`;
    const { data: created, error: insErr } = await supabase.from('employees').insert({
      company_id: TARGET_COMPANY_ID,
      first_name: ne.first_name,
      last_name: ne.last_name,
      employee_code: `TB-NEW-${seqStr}`,
      tax_number: placeholderTax,
      id_number: placeholderId,
      hire_date: '2026-01-01',
      employment_status: 'active',
      employment_type: 'permanent',
      payment_method: 'bank_transfer',
      is_active: true
    }).select('id').single();
    if (insErr) throw new Error(`Failed to create new employee ${ne.first_name} ${ne.last_name}: ${insErr.message}`);
    employeeIdByKey[ne.key] = created.id;
    placeholderNotes.push(`NEW employee "${ne.first_name} ${ne.last_name}" (id=${created.id}) created with PLACEHOLDER tax_number="${placeholderTax}" and id_number="${placeholderId}" — real numbers needed from client/accountant.`);
    console.log(`  + Created new employee: ${ne.first_name} ${ne.last_name} (id=${created.id}) — PLACEHOLDER tax/ID numbers`);
  }
  console.log('');

  // STEP 2: ensure IRP5 items (only BASIC/BONUS — Extra Pay is always 0 in this dataset)
  const irp5Items = [
    { item_code: 'BASIC', item_name: 'Basic Salary', item_type: 'earning', category: 'salary', is_taxable: true, is_recurring: true, sort_order: 1, irp5_code: '3601' },
    { item_code: 'BONUS', item_name: 'Annual Bonus', item_type: 'earning', category: 'bonus', is_taxable: true, is_recurring: false, sort_order: 30, irp5_code: '3605' }
  ];
  for (const item of irp5Items) {
    const { data: existingItem } = await supabase.from('payroll_items_master')
      .select('id, irp5_code').eq('company_id', TARGET_COMPANY_ID).eq('item_code', item.item_code).maybeSingle();
    if (!existingItem) {
      const { error } = await supabase.from('payroll_items_master').insert({
        company_id: TARGET_COMPANY_ID, item_code: item.item_code, item_name: item.item_name,
        item_type: item.item_type, category: item.category, is_taxable: item.is_taxable,
        is_recurring: item.is_recurring, sort_order: item.sort_order, irp5_code: item.irp5_code,
        irp5_code_updated_at: new Date().toISOString()
      });
      if (error) throw new Error(`payroll_items_master insert failed for ${item.item_code}: ${error.message}`);
      console.log(`  + Created payroll item ${item.item_code} -> IRP5 ${item.irp5_code}`);
    } else if (!existingItem.irp5_code) {
      await supabase.from('payroll_items_master').update({ irp5_code: item.irp5_code, irp5_code_updated_at: new Date().toISOString() }).eq('id', existingItem.id);
      console.log(`  ~ Backfilled missing IRP5 code on ${item.item_code} -> ${item.irp5_code}`);
    } else {
      console.log(`  = ${item.item_code} already has IRP5 code ${existingItem.irp5_code} — left untouched.`);
    }
  }
  followUpNotes.push('"7.5% Allowance" (existing item TB001) and "Key Allowance" (TK001) keep their existing Paytime IRP5 codes (3601/3713) — NOT changed to the 3605 SimplePay\'s column names suggest (confirmed with user, Rule B9).');
  followUpNotes.push('"Team Leader Allowance" has no IRP5 code configured (no existing item, none created) — SimplePay\'s column name suggests 3605, but given the 7.5%/Key Allowance conflict, this was NOT assumed; needs accountant classification.');
  followUpNotes.push('Recurring allowances (7.5% Allowance, Key Allowance, Team Leader Allowance) are correctly included in each period\'s gross/taxable totals, but are NOT set up as ongoing recurring employee_payroll_items — August 2026 onward payroll will need these configured again live in Paytime for continuity (separate follow-up task, not done here).');
  followUpNotes.push('Deduction line items (Garnishee, Provident Fund, Repayment of Advance, SACCAWU Union, Salary Advance, Savings Deductions, Staff Loans Long Term, Union Fee) are correctly totaled into each snapshot\'s net-pay-reducing "deductions" figure, but are NOT itemized individually in the payslip UI\'s Current Inputs panel, and are NOT set up as ongoing recurring deductions for live payroll — same as the allowances, a separate follow-up task.');
  followUpNotes.push('Company-level PAYE/UIF/SDL/income tax reference numbers are all still blank for Turkstra Bakkery — pre-existing gap, unrelated to this import, needed before any real IRP5/EMP201 submission.');
  console.log('');

  // STEP 3: payroll_periods already exist (03-08, status='draft', pay_date=month-end) —
  // only flip status to 'paid' for the 5 periods being imported; pay_date untouched.
  const uniquePeriodKeys = [...new Set(dataRows.map(r => periodKeyFromDate(r[colIndex('Date')])))].sort();
  const periodByKey = {};
  for (const periodKey of uniquePeriodKeys) {
    const { data: existingPeriod, error: findErr } = await supabase
      .from('payroll_periods').select('id, period_key, start_date, end_date, status, pay_date')
      .eq('company_id', TARGET_COMPANY_ID).eq('period_key', periodKey).maybeSingle();
    if (findErr) throw new Error(`payroll_periods lookup failed: ${findErr.message}`);
    if (!existingPeriod) throw new Error(`Expected existing payroll_periods row for ${periodKey}, found none — aborting (unexpected state).`);
    const { data: updated, error: updErr } = await supabase.from('payroll_periods')
      .update({ status: 'paid' }).eq('id', existingPeriod.id)
      .select('id, period_key, start_date, end_date').single();
    if (updErr) throw new Error(`payroll_periods update failed for ${periodKey}: ${updErr.message}`);
    periodByKey[periodKey] = updated;
    console.log(`  ~ Period ${periodKey}: status '${existingPeriod.status}' -> 'paid' (pay_date ${existingPeriod.pay_date} kept as-is)`);
  }
  console.log('');

  // STEP 4: build + save snapshots
  let createdCount = 0, deletedDraftCount = 0;
  const totals = { gross: 0, paye: 0, uifEmployee: 0, sdlEmployer: 0, net: 0 };
  const C = {
    date: colIndex('Date'),
    basicSalary: colIndex('Basic Salary'),
    annualBonus: colIndex('Annual Bonus'),
    annualIrregular: colIndex('Annual / Irregular Payment'),
    extraPay: colIndex('Extra Pay'),
    overtime: colIndex('Overtime'),
    shortTime: colIndex('Short Time'),
    paye: colIndex('Tax (PAYE)'),
    voluntaryOverDeduction: colIndex('Voluntary Tax Over-Deduction'),
    uifEmployee: colIndex('UIF - Employee'),
    sdlEmployer: colIndex('SDL - Employer'),
    uifEmployer: colIndex('UIF - Employer'),
    taxableGross: colIndex('Gross Remuneration, Taxable Portion (before deductions)'),
    grossRemuneration: colIndex('Gross Remuneration'),
    nettPay: colIndex('Nett Pay')
  };
  const deductionCols = DEDUCTION_COLUMNS.map(name => colIndex(name));

  for (const row of dataRows) {
    const employeeNameRaw = row[0].trim();
    const [lastNameRaw, firstNameRaw] = employeeNameRaw.split(',').map(s => (s || '').trim());
    const key = `${titleCase(firstNameRaw)}|${titleCase(lastNameRaw)}`.toLowerCase();
    const employeeId = employeeIdByKey[key];
    if (!employeeId) throw new Error(`No employee mapping for CSV row "${employeeNameRaw}" — aborting.`);

    const dateStr = row[C.date].trim();
    const periodKey = periodKeyFromDate(dateStr);
    const period = periodByKey[periodKey];
    if (!period) throw new Error(`No period found for ${periodKey} (row: ${employeeNameRaw})`);

    const { data: existingAny, error: existErr } = await supabase.from('payroll_snapshots')
      .select('id, is_locked').eq('company_id', TARGET_COMPANY_ID).eq('employee_id', employeeId).eq('period_key', periodKey).maybeSingle();
    if (existErr) throw new Error(`payroll_snapshots lookup failed: ${existErr.message}`);
    if (existingAny && existingAny.is_locked) {
      throw new Error(`ABORT: employee_id=${employeeId} period=${periodKey} already has a LOCKED snapshot (id=${existingAny.id}). Refusing to overwrite. Resolve manually.`);
    }
    if (existingAny && !existingAny.is_locked) {
      await supabase.from('payroll_snapshots').delete().eq('id', existingAny.id);
      deletedDraftCount++;
    }

    const annualBonus = parseMoney(row[C.annualBonus]);
    const annualIrregular = parseMoney(row[C.annualIrregular]);
    const extraPay = parseMoney(row[C.extraPay]);
    const onceOffTaxableGross = annualBonus + annualIrregular + extraPay;
    const taxableGross = parseMoney(row[C.taxableGross]);
    const paye = parseMoney(row[C.paye]);
    const voluntaryOverDeduction = parseMoney(row[C.voluntaryOverDeduction]);
    const grossRemuneration = parseMoney(row[C.grossRemuneration]);
    const uifEmployee = parseMoney(row[C.uifEmployee]);
    const sdlEmployer = parseMoney(row[C.sdlEmployer]);
    const uifEmployer = parseMoney(row[C.uifEmployer]);
    const nettPay = parseMoney(row[C.nettPay]);
    const overtime = parseMoney(row[C.overtime]);
    const shortTime = parseMoney(row[C.shortTime]);
    const basicSalary = parseMoney(row[C.basicSalary]);
    let deductionsTotal = 0;
    for (const idx of deductionCols) deductionsTotal += parseMoney(row[idx]);
    deductionsTotal = PayrollEngine.r2(deductionsTotal);

    const taxYear = taxYearForPeriod(periodKey);
    const calculationInput = {
      basic_salary: basicSalary, regular_inputs: [], workSchedule: [], hours_per_day: 8,
      start_date: null, end_date: null, period_start_date: period.start_date, period_end_date: period.end_date,
      currentInputs: annualBonus > 0 ? [{ description: 'Annual Bonus', amount: annualBonus, type: 'earning', tax_treatment: 'taxable', affects_uif: true, paye_projection_type: 'ONCE_OFF', taxable_percentage: 100 }] : [],
      overtime: [], shortTime: [], multiRate: [],
      employeeOptions: { age: null, medicalMembers: 0, taxDirective: null, rebateCode: 'R', is_director: false, sdl_registered: true, uif_registered: true, voluntaryTaxConfig: null },
      period: periodKey, ytdData: null
    };
    const calculationOutput = {
      gross: grossRemuneration, taxableGross, paye, paye_base: PayrollEngine.r2(paye - voluntaryOverDeduction),
      voluntary_paye_adjustment: voluntaryOverDeduction, voluntary_overdeduction: voluntaryOverDeduction,
      uif: uifEmployee, sdl: sdlEmployer, deductions: deductionsTotal, net: nettPay,
      negativeNetPay: nettPay < 0, medicalCredit: 0, overtimeAmount: overtime, shortTimeAmount: shortTime,
      preTaxDeductions: 0, netOnlyDeductions: deductionsTotal,
      periodicTaxableGross: PayrollEngine.r2(taxableGross - onceOffTaxableGross),
      onceOffTaxableGross: PayrollEngine.r2(onceOffTaxableGross),
      uifApplicableGross: grossRemuneration, uifExcludedEarnings: 0, uif_employer: uifEmployer,
      taxBeforeRebate: 0, rebate: 0, primary_rebate_annual: 0, secondary_rebate_annual: 0, tertiary_rebate_annual: 0,
      uif_monthly_cap: 0, marginal_rate: '', marginal_bracket: '', tax_year: taxYear, is_director: false, uif_exempt: false,
      _meta: {
        calculatedAt: new Date().toISOString(), engineVersion: 'external-import-simplepay-v1', schemaVersion: '1.0',
        calculationMethod: 'imported', startDate: period.start_date, endDate: period.end_date,
        resolvedTaxYear: taxYear, taxYear, taxConfig: null, rebatePrimary: null, rebateSecondary: null, rebateTertiary: null,
        ytdMethod: 'imported', ytdSource: 'simplepay_import', ytdTaxYear: null, ytdPriorPeriodsCount: 0
      }
    };

    const snapshot = PayrollHistoryService.prepareSnapshot(TARGET_COMPANY_ID, employeeId, period.id, periodKey, calculationInput, calculationOutput, IMPORTED_BY_USER_ID);
    snapshot.status = 'finalized'; snapshot.is_locked = true;
    snapshot.finalized_by = IMPORTED_BY_USER_ID; snapshot.finalized_at = new Date().toISOString();
    snapshot.source = IMPORT_SOURCE_TAG;

    const saved = await PayrollHistoryService.saveSnapshot(supabase, snapshot, null);
    await supabase.from('payroll_snapshots').update({ source: IMPORT_SOURCE_TAG }).eq('id', saved.id);
    await ensureAnnualBonusInput(TARGET_COMPANY_ID, employeeId, period, annualBonus);

    totals.gross += grossRemuneration; totals.paye += paye; totals.uifEmployee += uifEmployee;
    totals.sdlEmployer += sdlEmployer; totals.net += nettPay;
    createdCount++;
  }
  console.log(`✅ ${createdCount} snapshots saved (${deletedDraftCount} existing drafts deleted first).\n`);

  // STEP 5: continuity — update basic_salary to latest imported period
  const latestByEmployee = {};
  for (const row of dataRows) {
    const employeeNameRaw = row[0].trim();
    const [lastNameRaw, firstNameRaw] = employeeNameRaw.split(',').map(s => (s || '').trim());
    const key = `${titleCase(firstNameRaw)}|${titleCase(lastNameRaw)}`.toLowerCase();
    const pk = periodKeyFromDate(row[C.date]);
    const basicSalary = parseMoney(row[C.basicSalary]);
    if (!latestByEmployee[key] || pk > latestByEmployee[key].periodKey) latestByEmployee[key] = { periodKey: pk, basicSalary };
  }
  for (const key of Object.keys(latestByEmployee)) {
    const employeeId = employeeIdByKey[key];
    await supabase.from('employees').update({ basic_salary: latestByEmployee[key].basicSalary }).eq('id', employeeId).eq('company_id', TARGET_COMPANY_ID);
  }
  console.log(`✅ Updated basic_salary (continuity) for ${Object.keys(latestByEmployee).length} employees.\n`);

  // STEP 6: report
  console.log('=== SUMMARY ===');
  console.log(`Snapshots created: ${createdCount}  |  Existing draft snapshots deleted first: ${deletedDraftCount}`);
  console.log('');
  console.log('Computed totals vs. CSV TOTAL row:');
  const expected = { gross: 1393693.58, paye: 26347.34, uifEmployee: 13732.30, sdlEmployer: 13737.39, net: 1132589.16 };
  for (const k of Object.keys(expected)) {
    const got = PayrollEngine.r2(totals[k]);
    console.log(`  [${Math.abs(got - expected[k]) < 0.02 ? 'PASS' : 'FAIL'}] ${k}: computed=R${got.toFixed(2)}  csvTotal=R${expected[k].toFixed(2)}`);
  }
  console.log('');
  console.log('=== PLACEHOLDER DATA USED (per standing rule — needs real data follow-up) ===');
  placeholderNotes.forEach(n => console.log(`  - ${n}`));
  console.log('');
  console.log('=== FOLLOW-UP NOTES ===');
  followUpNotes.forEach(n => console.log(`  - ${n}`));
  console.log('\n=== Import complete ===\n');
}
