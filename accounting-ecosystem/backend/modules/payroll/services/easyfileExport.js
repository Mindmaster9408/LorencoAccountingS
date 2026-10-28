'use strict';

/**
 * ============================================================================
 * Paytime RS-07 — SARS e@syFile Employer import file (IRP5 / IT3(a))
 * ============================================================================
 * Ruan 2026-10-28: "bou dat ek kan import in easyfile". One file per company per
 * reconciliation (annual = period YYYY02, interim = YYYY08), built from the LOCKED
 * payroll snapshots only (RS-01) — every employee paid in the window, also terminated
 * ones (RS-01a).
 *
 * Format source of truth: SARS "BRS PAYE Employer Reconciliation" V25.3.0 (Jun 2026),
 * sections 3 (file rules), 4 (layout), 5 (sub-code consolidation), Appendix B/D.
 * Where the BRS and practice differ (which values are quoted), we follow two SimplePay
 * files that e@syFile accepted (2026 annual, 2027 interim) — see QUOTE below.
 *
 * Pure functions only (no DB) — the route loads data and allocates certificate numbers.
 *
 * Amount per IRP5 code, per locked snapshot:
 *   - every earning item → its IRP5 code (item's own code, else the Payroll Items screen)
 *   - employer contribution / fringe benefit with a code → that code (full value)
 *       3817/3825/3828/3810 are also reported as 4472/4473/4475/4474 and added to
 *       4001/4003/4006/4005 (the employee is deemed to have contributed them)
 *   - deduction items with a 40xx/44xx code → that code
 *   - overtime → 3607; the rest of cash gross (basic salary after short time, multi-rate
 *     hours, imported months without a breakdown) → 3601
 *   - 4582 = taxable portion of 3701 + 3802 + 3816 (SARS: 20%–80% of their sum)
 * PAYE, UIF (employee + employer), SDL and the medical credit come straight from the
 * snapshot output — the same numbers the EMP201s and the reconciliation used.
 * ============================================================================
 */

const ItemLink = require('./itemLink');
const { taxNumberError, idNumberError, clean } = require('../../../shared/utils/saIdentity');

// ─── SARS code tables ────────────────────────────────────────────────────────

/** Codes whose amounts make up 3696 (non-taxable income), BRS code 3696. */
const NON_TAXABLE = new Set([3602, 3652, 3622, 3672, 3703, 3753, 3714, 3764, 3815, 3865,
  3821, 3871, 3822, 3872, 3830, 3880, 3832, 3882, 3834, 3884, 3835, 3885, 3908, 3922]);

/** Sub-codes that must be written under their main code (BRS section 5). */
const SUB_TO_MAIN = {
  3604: 3602, 3609: 3602, 3612: 3602, 3654: 3652, 3659: 3652, 3662: 3652,
  3706: 3713, 3710: 3713, 3711: 3713, 3712: 3713, 3756: 3763, 3760: 3763, 3761: 3763, 3762: 3763,
  3705: 3714, 3709: 3714, 3716: 3714, 3755: 3764, 3759: 3764, 3766: 3764,
  3803: 3801, 3804: 3801, 3807: 3801, 3853: 3851, 3854: 3851, 3857: 3851
};

/** Employer contribution (fringe benefit) → [employer contribution code, deemed employee deduction code]. */
const EMPLOYER_PAIRS = { 3817: [4472, 4001], 3825: [4473, 4003], 3828: [4475, 4006], 3810: [4474, 4005] };

/** 4582: allowances/benefits on which PAYE is on a portion (BRS 4582, from 2019 YoA). */
const PORTION_CODES = new Set([3701, 3802, 3816]);

/** Employers in these SIC7 codes do not qualify for ETI → code 3026 must be left out (Appendix D). */
const NO_ETI_SIC7 = new Set(['84111', '84112', '84113', '84121', '84122', '84123', '84131', '84132',
  '84133', '84140', '84210', '84220', '84231', '84232', '84233', '84300']);

/**
 * How each code's value is written. q = in double quotes, r = raw.
 * BRS 3l says every A/AN/FT field is quoted; SimplePay (accepted by e@syFile) writes these
 * raw: 2080, 2081, 3026, 3060, 3151, 3241, 3279, 3285 — we copy what is proven to import.
 */
const QUOTE = {
  2010: 'q', 2015: 'q', 2020: 'r', 2022: 'q', 2024: 'q', 2025: 'q', 2036: 'q', 2026: 'q', 2027: 'q',
  2028: 'q', 2029: 'q', 2030: 'r', 2031: 'r', 2037: 'q', 2082: 'q', 2063: 'q', 2064: 'q', 2065: 'q',
  2066: 'q', 2080: 'r', 2081: 'r',
  3010: 'q', 3015: 'q', 3020: 'q', 3025: 'r', 3026: 'r', 3030: 'q', 3040: 'q', 3050: 'q', 3060: 'r',
  3070: 'q', 3075: 'q', 3080: 'r', 3100: 'r', 3125: 'q', 3136: 'q', 3146: 'q', 3147: 'q', 3148: 'q',
  3149: 'q', 3150: 'q', 3151: 'r', 3160: 'q', 3170: 'r', 3180: 'r', 3195: 'q', 3200: 'r', 3210: 'r',
  3211: 'q', 3212: 'q', 3213: 'q', 3214: 'q', 3215: 'q', 3216: 'q', 3217: 'q', 3220: 'q', 3240: 'r',
  3241: 'r', 3242: 'r', 3243: 'q', 3245: 'q', 3246: 'r', 3263: 'q', 3279: 'r', 3285: 'r', 3288: 'r',
  4150: 'r'
};

// ─── small helpers ───────────────────────────────────────────────────────────

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const cents = (n) => Math.round(n * 100) / 100;
const rands = (n) => Math.floor(n + 1e-6);                  // BRS 3j: cents dropped (rounded down)
const s = (v) => (v == null ? '' : String(v)).trim();

/** Free text for the file: no comma, pipe or double quote (BRS 3h), no leading space, max length. */
function ft(v, max) {
  const out = s(v).replace(/[,|"]/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return max ? out.slice(0, max).trim() : out;
}

/** Phone number as SARS wants it: digits only, national starts with 0, international 00, ≥ 10 digits. */
function phone(v) {
  let d = s(v).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1).startsWith('27') ? '0' + d.slice(3) : '00' + d.slice(1);
  else if (/^27\d{9}$/.test(d)) d = '0' + d.slice(2);
  return /^0\d{9,14}$/.test(d) ? d : '';
}

/** SARS PAYE/SDL/UIF reference check (Appendix B 8.2): first digit replaced with 4, Luhn on 10 digits. */
function sarsRefOk(ref) {
  const digits = '4' + ref.slice(1);
  if (!/^\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(digits[i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[9]);
}

/** E-mail rules of BRS 2027/3125: one @, a dotted domain, no ( ) \ | %, no special first/last or twice in a row. */
function emailOk(e) {
  if (!e || e.length > 70 || /[()\\|%,"\s]/.test(e)) return false;
  if ((e.match(/@/g) || []).length !== 1) return false;
  if (!/^[A-Za-z0-9]/.test(e) || !/[A-Za-z0-9]$/.test(e) || /[^A-Za-z0-9]{2}/.test(e)) return false;
  return e.split('@')[1].includes('.');
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s(v));
  return m ? utc(+m[1], +m[2], +m[3]) : null;
}

/** Date of birth from a 13-digit SA ID (century: a two-digit year after this year is 19xx). */
function dobFromId(id, today) {
  if (!/^\d{13}$/.test(id)) return null;
  const yy = +id.slice(0, 2), mm = +id.slice(2, 4), dd = +id.slice(4, 6);
  const nowYY = today.getUTCFullYear() % 100;
  const d = utc((yy > nowYY ? 1900 : 2000) + yy, mm, dd);
  return d.getUTCMonth() === mm - 1 ? d : null;
}

/** Pay periods worked (BRS 3210): calendar months between the two dates, part months as a fraction. */
function periodsWorked(from, to) {
  let total = 0;
  let y = from.getUTCFullYear(), m = from.getUTCMonth() + 1;
  while (utc(y, m, 1) <= to) {
    const days = lastDay(y, m);
    const start = Math.max(from.getTime(), utc(y, m, 1).getTime());
    const end = Math.min(to.getTime(), utc(y, m, days).getTime());
    if (end >= start) total += (Math.round((end - start) / 864e5) + 1) / days;
    if (++m > 12) { m = 1; y++; }
  }
  return Math.min(Math.round(total * 10000) / 10000, 12);
}

// ─── reconciliation window ───────────────────────────────────────────────────

/**
 * @param {string} taxYear 'YYYY/YYYY'
 * @param {'annual'|'interim'} period
 */
function reconWindow(taxYear, period) {
  const [y1, y2] = String(taxYear || '').split('/').map(Number);
  if (!y1 || y2 !== y1 + 1) throw new Error('taxYear must be YYYY/YYYY, e.g. 2026/2027');
  const interim = period === 'interim';
  const periods = [];
  const months = interim ? [3, 4, 5, 6, 7, 8] : [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2];
  months.forEach(m => periods.push(`${m >= 3 ? y1 : y2}-${String(m).padStart(2, '0')}`));
  return {
    taxYear, interim, periods,
    transactionYear: y2,                                    // BRS 2030
    reconPeriod: interim ? y1 * 100 + 8 : y2 * 100 + 2,     // BRS 2031
    start: utc(y1, 3, 1),
    end: interim ? utc(y1, 8, 31) : utc(y2, 2, lastDay(y2, 2))
  };
}

// ─── amounts per IRP5 code from one locked snapshot ──────────────────────────

function itemAmount(x, basic) {
  if (x.is_percentage && num(x.percentage_value)) return cents(num(x.percentage_value) / 100 * basic);
  return num(x.amount);
}

/**
 * @param {object} snap { calculation_input, calculation_output }
 * @param {Array} codeSource payroll_items_master rows (irp5ItemCheck.loadCodeSource)
 * @returns {{income, deductions, portionTaxable, paye, uif, sdl, medicalCredit, voluntary,
 *            missing: string[], residualNegative: boolean}}
 */
function snapshotAmounts(snap, codeSource) {
  const ci = snap.calculation_input || {};
  const out = snap.calculation_output || {};
  const basic = num(ci.basic_salary);
  const income = {}, deductions = {};
  const add = (bag, code, amt) => { bag[code] = (bag[code] || 0) + amt; };
  const missing = [];
  let cashEarnings = 0, portionTaxable = 0;

  const items = [].concat(ci.regular_inputs || [], ci.currentInputs || ci.current_inputs || []);
  items.forEach(x => {
    if (!x || !x.description) return;
    const amt = itemAmount(x, basic);
    if (!amt) return;
    const side = ItemLink.sideOf(x.type);
    const master = ItemLink.pickMaster(codeSource, { master_item_id: x.master_item_id, name: x.description, type: x.type });
    const raw = parseInt(s(x.irp5_code) || s(master && master.irp5_code), 10);
    const code = raw ? (SUB_TO_MAIN[raw] || raw) : null;

    if (side === 'deduction') {
      if (code && code >= 4000 && code < 4600) add(deductions, code, amt);
      else if (x.tax_treatment === 'pre_tax') missing.push(x.description);
      return;
    }
    const pct = x.taxable_percentage == null ? 100 : num(x.taxable_percentage);
    const taxablePart = x.is_taxable === false ? 0 : amt * pct / 100;
    if (side === 'earning') cashEarnings += amt;
    else if (x.is_taxable === false && !code) return;     // non-taxable employer cost (not on an IRP5)
    if (!code) { missing.push(x.description); return; }
    add(income, code, amt);
    if (PORTION_CODES.has(code)) portionTaxable += taxablePart;
    if (side === 'employer' && EMPLOYER_PAIRS[code]) {
      add(deductions, EMPLOYER_PAIRS[code][0], amt);
      add(deductions, EMPLOYER_PAIRS[code][1], amt);
    }
  });

  const overtime = num(out.overtimeAmount);
  if (overtime) add(income, 3607, overtime);
  const residual = cents(num(out.gross) - cashEarnings - overtime);
  if (residual > 0) add(income, 3601, residual);

  return {
    income, deductions, portionTaxable,
    paye: num(out.paye),
    uif: num(out.uif) + (typeof out.uif_employer === 'number' ? out.uif_employer : num(out.uif)),
    sdl: num(out.sdl),
    medicalCredit: num(out.medicalCredit),
    voluntary: num(out.voluntary_overdeduction),
    missing,
    residualNegative: residual < -0.01
  };
}

/** Sum snapshotAmounts over all of an employee's snapshots in the window. */
function sumAmounts(list) {
  const t = { income: {}, deductions: {}, portionTaxable: 0, paye: 0, uif: 0, sdl: 0,
    medicalCredit: 0, voluntary: 0, missing: [], residualNegative: false, months: list.length };
  list.forEach(a => {
    Object.entries(a.income).forEach(([c, v]) => { t.income[c] = (t.income[c] || 0) + v; });
    Object.entries(a.deductions).forEach(([c, v]) => { t.deductions[c] = (t.deductions[c] || 0) + v; });
    ['portionTaxable', 'paye', 'uif', 'sdl', 'medicalCredit', 'voluntary'].forEach(k => { t[k] += a[k]; });
    t.missing.push(...a.missing);
    t.residualNegative = t.residualNegative || a.residualNegative;
  });
  t.missing = [...new Set(t.missing)];
  return t;
}

// ─── employer header ─────────────────────────────────────────────────────────

/**
 * @returns {{fields: Array<[number, string]>, issues: string[], refs}}
 */
function employerRecord(company, win, mode) {
  const issues = [];
  const paye = clean(company.paye_reference_number);
  const sdl = clean(company.sdl_reference_number).toUpperCase();
  const uif = clean(company.uif_reference_number).toUpperCase();
  const name = ft(company.trading_name || company.company_name, 90);
  const sic = s(company.sic7_code);

  if (!name) issues.push('Company name is missing');
  if (!/^\d{10}$/.test(paye)) issues.push('PAYE reference number must be 10 digits (Company Details)');
  else if (!sarsRefOk(paye)) issues.push('PAYE reference number fails the SARS check digit');
  // With a 7… PAYE number SARS's SDL / UIF references are L / U + the same last 9 digits.
  const hint = (letter) => (/^7\d{9}$/.test(paye) ? ` — normally ${letter}${paye.slice(1)}` : '');
  if (sdl && !(/^L\d{9}$/.test(sdl) && sarsRefOk(sdl))) issues.push('SDL reference number is not valid (L + 9 digits)' + hint('L'));
  if (uif && !(/^U\d{9}$/.test(uif) && sarsRefOk(uif))) {
    issues.push('SARS UIF reference number is not valid (U + 9 digits, not the Labour UIF number)' + hint('U'));
  }
  if (/^7/.test(paye)) {
    if (/^L\d{9}$/.test(sdl) && sdl.slice(1) !== paye.slice(1)) issues.push('SDL reference must end in the same 9 digits as the PAYE reference' + hint('L'));
    if (/^U\d{9}$/.test(uif) && uif.slice(1) !== paye.slice(1)) issues.push('UIF reference must end in the same 9 digits as the PAYE reference' + hint('U'));
  }
  if (!/^\d{5}$/.test(sic)) issues.push('SIC7 industry code (5 digits) is missing — Company Details');

  const contact = ft(company.contact_person, 101).replace(/[^A-Za-zÀ-ÿ' -]/g, '').trim().split(/\s+/).filter(Boolean);
  if (contact.length < 2) issues.push('Contact person needs a first name and a surname (Company Details)');
  const tel = phone(company.contact_phone || company.phone);
  if (!tel) issues.push('Company phone number is missing or not a valid SA number (10 digits, starts with 0)');
  const email = s(company.contact_email || company.email);

  const street = ft(company.address_street, 60);
  const m = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(street);
  const streetNo = m ? m[1] : '', streetName = ft(m ? m[2] : street, 26);
  const suburb = ft(company.address_suburb, 33), city = ft(company.address_city, 21);
  const postal = s(company.address_postal_code);
  if (!streetName) issues.push('Company street address is missing');
  if (!suburb && !city) issues.push('Company suburb or city is missing');
  if (!/^\d{4}$/.test(postal) || postal === '0000') issues.push('Company postal code must be 4 digits');

  const f = [[2010, name], [2015, mode === 'TEST' ? 'TEST' : 'LIVE'], [2020, paye]];
  if (sdl) f.push([2022, sdl]);
  if (uif) f.push([2024, uif]);
  // First word = first name, the rest = surname ("Jane van der Merwe" → "van der Merwe").
  f.push([2025, ft(contact[0], 50)], [2036, ft(contact.slice(1).join(' '), 50)], [2026, tel]);
  if (emailOk(email)) f.push([2027, email]);
  f.push([2028, 'Lorenco'], [2029, 'Paytime'], [2030, String(win.transactionYear)], [2031, String(win.reconPeriod)],
    [2037, 'N'], [2082, sic]);
  if (streetNo) f.push([2063, streetNo.slice(0, 8)]);
  f.push([2064, streetName]);
  if (suburb) f.push([2065, suburb]);
  if (city) f.push([2066, city]);
  f.push([2080, postal], [2081, 'ZA']);

  return { fields: f, issues, refs: { paye, sdl, uif, sic, tel, streetNo, streetName, suburb, city, postal }, hint };
}

// ─── one employee certificate ────────────────────────────────────────────────

/**
 * @param {object} emp employees row
 * @param {object} t   sumAmounts() result
 * @param {object} ctx { win, employer (employerRecord result), company, today }
 * @returns {{type, fields, issues, warnings, totals, finalCert}|null} null = nothing to declare
 */
function employeeCertificate(emp, t, ctx) {
  const { win, employer, today } = ctx;
  const R = employer.refs;
  const issues = [], warnings = [];
  const name = `${s(emp.first_name)} ${s(emp.last_name)}`.trim();

  // ── money ──
  const income = {};
  Object.entries(t.income).forEach(([c, v]) => { const r = rands(v); if (r > 0) income[c] = r; });
  const incomeCodes = Object.keys(income).map(Number);
  if (!incomeCodes.length && !t.paye) return null;          // nothing paid in the window
  if (incomeCodes.length > 20) issues.push(`More than 20 income codes (${incomeCodes.length}) — combine items`);

  let gross3696 = 0, gross3699 = 0;
  incomeCodes.forEach(c => { if (NON_TAXABLE.has(c)) gross3696 += income[c]; else gross3699 += income[c]; });

  const ded = {};
  Object.entries(t.deductions).forEach(([c, v]) => { const r = rands(v); if (r > 0) ded[c] = r; });
  const portionBase = [...PORTION_CODES].reduce((a, c) => a + (income[c] || 0), 0);
  if (portionBase > 0) {
    let p = rands(t.portionTaxable);
    const lo = Math.ceil(portionBase * 0.2), hi = Math.floor(portionBase * 0.8);
    if (p > hi) { warnings.push(`PAYE was on ${Math.round(p / portionBase * 100)}% of travel/car allowances — SARS code 4582 is capped at 80%`); p = hi; }
    if (p < lo) { warnings.push(`Taxable portion of travel/car allowances below 20% — SARS code 4582 set to the 20% minimum`); p = lo; }
    if (p > 0) ded[4582] = p;
  }
  const dedCodes = Object.keys(ded).map(Number);
  if (dedCodes.length > 12) issues.push(`More than 12 deduction codes (${dedCodes.length})`);
  const total4497 = dedCodes.reduce((a, c) => a + ded[c], 0);

  const paye = cents(t.paye), uif = cents(t.uif), sdl = cents(t.sdl), medCredit = cents(t.medicalCredit);
  const type = paye > 0 ? 'IRP5' : 'IT3(a)';
  if (type === 'IRP5' && !/^7/.test(R.paye)) issues.push('PAYE was deducted but the PAYE reference does not start with 7 — only IT3(a) allowed');
  if (paye > 0 && !(t.voluntary > 0) && paye > gross3699) issues.push('PAYE is more than taxable income (3699)');
  if (t.missing.length) t.missing.forEach(d => issues.push(`Payroll item "${d}" has no IRP5 code`));
  if (t.residualNegative) warnings.push('Earning items are more than gross pay in a month — check the payslips');
  if (medCredit > 0 && !ded[4005]) issues.push('Medical tax credit given but no medical aid item with IRP5 code 4005');

  // ── who ──
  const nature = s(emp.nature_of_person).toUpperCase() || 'A';
  const idRaw = clean(emp.id_number);
  const isSaId = /^\d{13}$/.test(idRaw);
  const surname = ft(emp.last_name, 120);
  const firstNames = ft(s(emp.first_name).split(/\s+/).slice(0, 2).join(' '), 90);
  const initials = s(emp.first_name).split(/\s+/).map(w => (w.match(/[A-Za-z]/) || [''])[0]).join('').toUpperCase().slice(0, 5);
  if (!surname || /\d/.test(surname)) issues.push('Surname is missing or contains digits');
  if (!firstNames || /\d/.test(firstNames)) issues.push('First name is missing or contains digits');
  if (!initials) issues.push('Initials could not be made from the first name');

  let dob = null;
  if (isSaId) {
    if (idNumberError(idRaw)) issues.push(idNumberError(idRaw));
    dob = dobFromId(idRaw, today);
  } else if (idRaw) {
    if (idRaw.length < 6) issues.push('Passport number must have at least 6 characters');
    if (!/^[A-Z]{3}$/.test(s(emp.passport_country).toUpperCase())) issues.push('Passport country of issue (3 letters, e.g. ZWE) is missing');
    dob = parseDate(emp.date_of_birth);
  } else if (nature === 'A' || nature === 'R') {
    issues.push('No ID or passport number');
  }
  if (!dob) issues.push('Date of birth is missing (needed when there is no SA ID number)');

  const tax = clean(emp.tax_number);
  let taxOut = '';
  if (tax && !taxNumberError(tax)) taxOut = tax;
  else if (type === 'IRP5') issues.push(tax ? taxNumberError(tax) : 'SARS tax number is required on an IRP5');
  else if (tax) warnings.push(`Tax number left off the IT3(a): ${taxNumberError(tax)}`);

  const tel = phone(emp.phone) || R.tel;
  if (!phone(emp.phone)) warnings.push('No valid employee phone number — the company number is used');

  // ── period ──
  const hired = parseDate(emp.hire_date);
  const ended = parseDate(emp.termination_date);
  const from = hired && hired > win.start ? hired : win.start;
  const finalCert = !!(ended && ended <= win.end);
  const to = finalCert ? ended : win.end;
  if (to < from) issues.push('Termination date is before the start date');
  if (from > today) issues.push('Start date is in the future');
  const certPeriod = win.interim && !finalCert ? '08' : '02';

  // ── residential address ──
  const resCountry = (s(emp.res_country_code) || 'ZA').toUpperCase();
  const resStreet = ft(emp.res_street_name, 26), resSuburb = ft(emp.res_suburb, 33), resCity = ft(emp.res_city, 21);
  const resPostal = s(emp.res_postal_code);
  if (!resStreet) issues.push('Residential address: street is missing');
  if (!resSuburb && !resCity) issues.push('Residential address: suburb or city is missing');
  if (resCountry === 'ZA' && (!/^\d{4}$/.test(resPostal) || resPostal === '0000')) issues.push('Residential address: postal code must be 4 digits');

  // ── bank ──
  const cashPaid = /^(cash|cheque)$/i.test(s(emp.payment_method));
  const acctType = cashPaid ? 0 : parseInt(emp.bank_account_type, 10) || null;
  const acctNo = s(emp.account_number).replace(/\D/g, '');
  const branch = s(emp.branch_code).replace(/\D/g, '');
  if (acctType == null) issues.push('Bank account type is missing (current / savings / transmission)');
  if (acctType && acctType !== 7) {
    if (!acctNo || acctNo.length > 16) issues.push('Bank account number is missing or too long');
    if (!branch || branch.length > 6) issues.push('Bank branch code is missing');
  }

  // ── build record (order as in files e@syFile accepted) ──
  const f = [[3010, '<CERT>'], [3015, type], [3020, nature], [3025, String(win.transactionYear)]];
  if (!NO_ETI_SIC7.has(R.sic)) f.push([3026, 'N']);          // Paytime does not calculate ETI (RS-09)
  f.push([3030, surname], [3040, firstNames], [3050, initials]);
  if (isSaId) f.push([3060, idRaw]);
  else if (idRaw) f.push([3070, idRaw.toUpperCase().slice(0, 18)], [3075, s(emp.passport_country).toUpperCase()]);
  if (dob) f.push([3080, ymd(dob)]);
  if (taxOut) f.push([3100, taxOut]);
  if (emailOk(s(emp.email))) f.push([3125, s(emp.email)]);
  f.push([3136, tel]);
  if (R.streetNo) f.push([3146, R.streetNo.slice(0, 8)]);
  f.push([3147, R.streetName]);
  if (R.suburb) f.push([3148, R.suburb]);
  if (R.city) f.push([3149, R.city]);
  f.push([3150, R.postal], [3151, 'ZA']);
  const empNo = ft(emp.employee_code || emp.employee_number, 25);
  if (empNo) f.push([3160, empNo]);
  f.push([3170, ymd(from)], [3180, ymd(to)]);
  if (type === 'IRP5') f.push([3195, t.voluntary > 0 ? 'Y' : 'N']);
  f.push([3200, '12.0000'], [3210, periodsWorked(from, to).toFixed(4)]);
  if (s(emp.res_unit_number)) f.push([3211, ft(emp.res_unit_number, 8)]);
  if (s(emp.res_complex)) f.push([3212, ft(emp.res_complex, 26)]);
  if (s(emp.res_street_number)) f.push([3213, ft(emp.res_street_number, 8)]);
  f.push([3214, resStreet]);
  if (resSuburb) f.push([3215, resSuburb]);
  if (resCity) f.push([3216, resCity]);
  if (resPostal) f.push([3217, resPostal.slice(0, 10)]);
  if (type === 'IRP5') f.push([3220, 'N']);
  f.push([3240, String(acctType == null ? 0 : acctType)]);
  if (acctType && acctType !== 7) {
    f.push([3241, acctNo], [3242, branch.padStart(6, '0')]);
    if (s(emp.bank_name)) f.push([3243, ft(emp.bank_name, 50)]);
    f.push([3245, ft(emp.account_holder || name, 49)], [3246, String(parseInt(emp.bank_account_relationship, 10) || 1)]);
  }
  f.push([3263, R.sic], [3279, 'N'], [3285, resCountry], [3288, '1']);

  const money = [];
  incomeCodes.forEach(c => money.push([c, String(income[c])]));
  if (gross3696) money.push([3696, String(gross3696)]);
  money.push([3699, String(gross3699)]);
  dedCodes.forEach(c => money.push([c, String(ded[c])]));
  if (dedCodes.length) money.push([4497, String(total4497)]);
  if (type === 'IRP5') money.push([4102, paye.toFixed(2)]);
  if (ded[4005]) {
    money.push([4116, medCredit.toFixed(2)]);
    const age = dob ? win.end.getUTCFullYear() - dob.getUTCFullYear() : 0;
    if (age >= 65) money.push([4120, '0.00']);
  }
  if (R.uif) money.push([4141, uif.toFixed(2)]);
  if (R.sdl) money.push([4142, sdl.toFixed(2)]);
  const total4149 = cents((type === 'IRP5' ? paye : 0) + (R.uif ? uif : 0) + (R.sdl ? sdl : 0));
  if (type === 'IRP5' || R.uif || R.sdl) money.push([4149, total4149.toFixed(2)]);
  if (type === 'IT3(a)') money.push([4150, '02']);           // earns below the tax threshold
  money.sort((a, b) => a[0] - b[0]);
  f.push(...money);

  if (s(emp.tax_directive) && num(emp.tax_directive) > 0) warnings.push('Employee has a tax directive — capture the directive number in e@syFile');
  if (type === 'IT3(a)') warnings.push('IT3(a) reason 02 (earns below the tax threshold) — change it in e@syFile if another reason applies');

  return {
    type, fields: f, issues, warnings, certPeriod, finalCert,
    totals: { gross: gross3696 + gross3699, taxable: gross3699, paye, uif, sdl, medicalCredit: medCredit, months: t.months }
  };
}

// ─── file ────────────────────────────────────────────────────────────────────

function fmt(code, value) {
  const v = String(value);
  if (QUOTE[code] === 'q') return `${code},"${v}"`;
  if (QUOTE[code] === 'r' || /^-?\d+(\.\d+)?$/.test(v)) return `${code},${v}`;
  return `${code},"${v}"`;
}

/** Trailer totals (BRS 6010/6020/6030) over the header + certificate records. */
function trailer(records) {
  let codeSum = 0, amountSum = 0;
  records.forEach(fields => {
    fields.forEach(([c, v]) => {
      if ((c >= 2010 && c <= 2082) || (c >= 3010 && c <= 4497) || (c >= 4582 && c <= 4587) || (c >= 7002 && c <= 7009)) codeSum += c;
      if ((c >= 3601 && c <= 4497) || (c >= 4582 && c <= 4587) || (c >= 7002 && c <= 7004) || c === 7008) amountSum += num(v);
    });
    codeSum += 9999;
  });
  return [[6010, String(records.length)], [6020, String(codeSum)], [6030, cents(amountSum).toFixed(2)]];
}

/** Whole file text (CRLF, like the files e@syFile accepted). records[0] = employer header. */
function writeFile(records) {
  const line = (fields) => fields.map(([c, v]) => fmt(c, v)).join(',') + ',9999';
  return records.concat([trailer(records)]).map(line).join('\r\n') + '\r\n';
}

/**
 * Certificate number (BRS 3010): PAYE ref (10) + transaction year (4) + period digits (2)
 * + unique part left-padded with zeros to 30 characters.
 */
function certificateNumber(paye, transactionYear, certPeriod, unique) {
  return `${paye}${transactionYear}${certPeriod}${String(unique).padStart(14, '0')}`;
}

/**
 * Everything for one company: preview and file are the same build, so what the user
 * reviews is exactly what gets written.
 *
 * @param {object} p
 * @param {object} p.company       companies row
 * @param {Array}  p.employees     employees rows (all, incl. terminated)
 * @param {Array}  p.snapshots     locked payroll_snapshots in the window (deduplicated)
 * @param {Array}  p.codeSource    payroll items with IRP5 codes
 * @param {string} p.taxYear       'YYYY/YYYY'
 * @param {'annual'|'interim'} p.period
 * @param {'LIVE'|'TEST'} [p.mode]
 * @param {Date}   [p.today]
 */
function build(p) {
  const win = reconWindow(p.taxYear, p.period);
  const today = p.today || new Date();
  const employer = employerRecord(p.company, win, p.mode);
  const byEmp = {};
  (p.snapshots || []).forEach(sn => { (byEmp[sn.employee_id] = byEmp[sn.employee_id] || []).push(sn); });
  const empById = {};
  (p.employees || []).forEach(e => { empById[e.id] = e; });

  const certificates = [];
  Object.keys(byEmp).forEach(eid => {
    const emp = empById[eid] || { id: Number(eid) };
    const t = sumAmounts(byEmp[eid].map(sn => snapshotAmounts(sn, p.codeSource)));
    const cert = employeeCertificate(emp, t, { win, employer, today });
    if (!cert) return;
    if (!empById[eid]) cert.issues.unshift('Employee record not found');
    certificates.push({ employee_id: Number(eid), name: `${s(emp.first_name)} ${s(emp.last_name)}`.trim(),
      employee_number: s(emp.employee_code || emp.employee_number), ...cert, ready: cert.issues.length === 0 });
  });
  certificates.sort((a, b) => a.name.localeCompare(b.name));

  // UIF / SDL paid without the matching reference: one company problem, not one per employee.
  if (!employer.refs.uif && certificates.some(c => c.totals.uif > 0)) {
    employer.issues.push('UIF was deducted but the SARS UIF reference number is missing (Company Details)' + employer.hint('U'));
  }
  if (!employer.refs.sdl && certificates.some(c => c.totals.sdl > 0)) {
    employer.issues.push('SDL was levied but the SDL reference number is missing (Company Details)' + employer.hint('L'));
  }

  const sum = (k) => cents(certificates.reduce((a, c) => a + c.totals[k], 0));
  return {
    window: { taxYear: win.taxYear, period: win.interim ? 'interim' : 'annual',
      transactionYear: win.transactionYear, reconPeriod: win.reconPeriod, periods: win.periods },
    employer, certificates,
    summary: {
      certificates: certificates.length,
      ready: certificates.filter(c => c.ready).length,
      blocked: certificates.filter(c => !c.ready).length,
      irp5: certificates.filter(c => c.type === 'IRP5').length,
      it3a: certificates.filter(c => c.type === 'IT3(a)').length,
      paye: sum('paye'), uif: sum('uif'), sdl: sum('sdl'), gross: sum('gross')
    }
  };
}

/**
 * File text for the ready certificates. numbers: { [employee_id]: certificate number }.
 */
function fileFor(result, numbers) {
  const records = [result.employer.fields];
  result.certificates.filter(c => c.ready).forEach(c => {
    const n = numbers[c.employee_id];
    if (!n) throw new Error(`No certificate number for employee ${c.employee_id}`);
    records.push(c.fields.map(([code, v]) => (code === 3010 ? [3010, n] : [code, v])));
  });
  return writeFile(records);
}

module.exports = {
  build, fileFor, writeFile, trailer, certificateNumber, reconWindow,
  snapshotAmounts, sumAmounts, employerRecord, employeeCertificate,
  sarsRefOk, phone, periodsWorked, emailOk,
  NON_TAXABLE, SUB_TO_MAIN, EMPLOYER_PAIRS
};
