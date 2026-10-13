'use strict';

/**
 * ============================================================================
 * Paytime tax tables per tax year — spec 02 (BT-01..15), Fase 1
 * ============================================================================
 * Every pay period uses the table of ITS OWN SA tax year (1 March – end Feb).
 * There is no "active year": February 2027 uses 2026/2027 and March 2027 uses
 * 2027/2028, even when both are calculated on the same day.
 *
 * Source of truth: table payroll_tax_tables (migration 027), one row per year,
 * ecosystem-wide. Only CONFIRMED rows are used; a missing / unconfirmed year
 * stops the calculation with a clear message — never a silent guess (BT-15).
 *
 * Before migration 027 has run, the table does not exist and the old behaviour
 * is kept (global KV tax_config, then company KV) so deploying the code first
 * is safe.
 * ============================================================================
 */

const PayrollEngine = require('../../../core/payroll-engine');

class TaxTablesMissingError extends Error {
  constructor(taxYear, reason) {
    super(reason === 'unconfirmed'
      ? `The tax tables for ${taxYear} are loaded but not confirmed yet. A super user must confirm them in Payroll Items → Tax Configuration before this period can be calculated.`
      : `No tax tables for ${taxYear}. A super user must load the SARS tables for ${taxYear} in Payroll Items → Tax Configuration before this period can be calculated.`);
    this.name = 'TaxTablesMissingError';
    this.code = 'TAX_TABLES_MISSING';
    this.taxYear = taxYear;
  }
}

const isMissingTableError = (err) => !!err && (
  err.code === '42P01' || err.code === 'PGRST205' ||
  /payroll_tax_tables/.test(err.message || '') && /does not exist|could not find|schema cache/i.test(err.message || '')
);

/** DB row → engine tables object (same shape as PayrollEngine.HISTORICAL_TABLES entries). */
function rowToEngineTables(row) {
  const brackets = (typeof row.brackets === 'string' ? JSON.parse(row.brackets) : row.brackets) || [];
  return {
    TAX_YEAR: row.tax_year,
    BRACKETS: brackets.map(b => ({
      min:  Number(b.min) || 0,
      max:  (b.max === null || b.max === undefined || Number(b.max) >= 1e15) ? Infinity : Number(b.max),
      base: Number(b.base) || 0,
      rate: Number(b.rate)
    })),
    PRIMARY_REBATE:            Number(row.primary_rebate),
    SECONDARY_REBATE:          Number(row.secondary_rebate),
    TERTIARY_REBATE:           Number(row.tertiary_rebate),
    UIF_RATE:                  Number(row.uif_rate),
    UIF_MONTHLY_CAP:           Number(row.uif_monthly_cap),
    SDL_RATE:                  Number(row.sdl_rate),
    MEDICAL_CREDIT_MAIN:       Number(row.medical_credit_main),
    MEDICAL_CREDIT_FIRST_DEP:  Number(row.medical_credit_first_dep),
    MEDICAL_CREDIT_ADDITIONAL: Number(row.medical_credit_additional)
  };
}

/** Legacy path (before migration 027): global KV tax_config, then the company's own. */
async function legacyKvTaxConfig(supabase, companyId) {
  for (const cid of ['__global__', companyId]) {
    const { data } = await supabase
      .from('payroll_kv_store_eco')
      .select('value')
      .eq('company_id', cid)
      .eq('key', 'tax_config')
      .maybeSingle();
    if (data && data.value) return typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
  }
  return null;
}

/**
 * Tax tables for a pay period, as the `taxConfig` option of PayrollCalculationService.calculate().
 * @returns {Promise<object|null>} engine tables (null = engine code defaults, legacy only)
 * @throws  {TaxTablesMissingError} when the table exists but this year is missing / unconfirmed
 */
async function getTaxConfigForPeriod(supabase, companyId, periodKey) {
  const taxYear = PayrollEngine.getTaxYearForPeriod(periodKey);
  const { data, error } = await supabase
    .from('payroll_tax_tables')
    .select('*')
    .eq('tax_year', taxYear)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return legacyKvTaxConfig(supabase, companyId);
    throw new Error('Could not load tax tables: ' + error.message);
  }
  if (!data) throw new TaxTablesMissingError(taxYear, 'missing');
  if (data.confirmed !== true) throw new TaxTablesMissingError(taxYear, 'unconfirmed');
  return rowToEngineTables(data);
}

/**
 * Validate a tax-table payload before it is saved (pure). Returns a list of problems.
 * Brackets: ascending, contiguous (min = previous max), last max null, rates 0..1.
 */
function validateTaxTableRow(row) {
  const errs = [];
  if (!/^\d{4}\/\d{4}$/.test(row.tax_year || '')) errs.push('tax_year must look like 2027/2028');
  else {
    const [a, b] = row.tax_year.split('/').map(Number);
    if (b !== a + 1) errs.push('tax_year must be two consecutive years');
  }
  const br = row.brackets;
  if (!Array.isArray(br) || br.length < 1) errs.push('at least one bracket is required');
  else {
    br.forEach((x, i) => {
      if (!(Number(x.rate) >= 0 && Number(x.rate) <= 1)) errs.push(`bracket ${i + 1}: rate must be between 0 and 1`);
      if (!(Number(x.base) >= 0)) errs.push(`bracket ${i + 1}: base must be 0 or more`);
      const isLast = i === br.length - 1;
      if (isLast && x.max !== null && x.max !== undefined) errs.push('the last bracket must have no maximum');
      if (!isLast && !(Number(x.max) > Number(x.min))) errs.push(`bracket ${i + 1}: max must be above min`);
      if (i === 0 && Number(x.min) !== 0) errs.push('the first bracket must start at 0');
      if (i > 0 && Number(x.min) !== Number(br[i - 1].max)) errs.push(`bracket ${i + 1}: min must equal the previous bracket's max (SARS "above R…")`);
    });
  }
  ['primary_rebate', 'secondary_rebate', 'tertiary_rebate', 'uif_monthly_cap',
   'medical_credit_main', 'medical_credit_first_dep', 'medical_credit_additional'].forEach(f => {
    if (!(Number(row[f]) >= 0)) errs.push(`${f} must be a number of 0 or more`);
  });
  ['uif_rate', 'sdl_rate'].forEach(f => {
    if (!(Number(row[f]) >= 0 && Number(row[f]) <= 1)) errs.push(`${f} must be between 0 and 1 (e.g. 0.01)`);
  });
  return errs;
}

/** valid_from / valid_to for a tax year label ('2027/2028' → 2027-03-01 … 2028-02-29). */
function taxYearDates(taxYear) {
  const end = parseInt(taxYear.split('/')[1], 10);
  const leap = (end % 4 === 0 && end % 100 !== 0) || end % 400 === 0;
  return { valid_from: `${end - 1}-03-01`, valid_to: `${end}-02-${leap ? '29' : '28'}` };
}

module.exports = {
  TaxTablesMissingError,
  getTaxConfigForPeriod,
  rowToEngineTables,
  validateTaxTableRow,
  taxYearDates,
  isMissingTableError
};
