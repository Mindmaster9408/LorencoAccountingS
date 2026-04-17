/**
 * ============================================================================
 * PayrollDataService — Fetch and Normalize Payroll Calculation Inputs
 * ============================================================================
 * Purpose: Centralize data retrieval and normalization for payroll calculations.
 * Responsibility: Convert scattered database records into engine-ready input format.
 *
 * This service abstracts:
 * - Employee master data fetching
 * - Payroll item retrieval
 * - Period boundary resolution
 * - Work schedule assembly
 * - Input normalization
 * - Decimal hour preservation
 *
 * Usage:
 *   const inputs = await PayrollDataService.fetchCalculationInputs(
 *     companyId, employeeId, periodKey, supabase
 *   );
 *   const result = PayrollEngine.calculateFromData(inputs, ...);
 *
 * MULTI-TENANT SAFETY:
 * All methods require explicit companyId — no implicit context.
 * ============================================================================
 */

/**
 * Fetch and normalize complete payroll calculation input for an employee/period.
 *
 * @param {number} companyId - Company ID (required for multi-tenant safety)
 * @param {number} employeeId - Employee ID to calculate for
 * @param {string} periodKey - Period identifier (YYYY-MM)
 * @param {object} supabase - Supabase client instance
 * @returns {Promise<object>} Normalized calculation input object for PayrollEngine
 */
async function fetchCalculationInputs(companyId, employeeId, periodKey, supabase) {
  if (!companyId || !employeeId || !periodKey) {
    throw new Error('companyId, employeeId, and periodKey are required');
  }

  // Step 1: Fetch period to get boundaries
  const period = await fetchPeriod(companyId, periodKey, supabase);
  if (!period) {
    throw new Error(`Period not found: ${periodKey}`);
  }

  // Step 2: Fetch employee master data
  const employee = await fetchEmployee(companyId, employeeId, supabase);
  if (!employee) {
    throw new Error(`Employee not found: ${employeeId}`);
  }

  // Step 3: Fetch employee's work schedule
  const workSchedule = await fetchWorkSchedule(
    companyId,
    employeeId,
    supabase
  );

  // Step 4: Fetch company payroll settings (tax year, defaults, etc.)
  const companySettings = await fetchCompanyPayrollSettings(
    companyId,
    supabase
  );

  // Step 5: Fetch recurring payroll items for this employee
  const recurringItems = await fetchRecurringPayrollItems(
    companyId,
    employeeId,
    supabase
  );

  // Step 6: Fetch one-off period items (inputs, overtime, short-time, etc.)
  const periodInputs = await fetchPeriodInputs(
    companyId,
    employeeId,
    period.id,
    supabase
  );

  // Step 7: Normalize into engine input format
  const normalizedInput = normalizeCalculationInput(
    employee,
    workSchedule,
    companySettings,
    recurringItems,
    periodInputs,
    period
  );

  return normalizedInput;
}

/**
 * Fetch period by period_key (YYYY-MM format).
 * Returns first matching period for the company.
 */
async function fetchPeriod(companyId, periodKey, supabase) {
  // NOTE: tax_year is NOT selected here — it does not exist in the base payroll_periods
  // schema. The column is added by payroll-schema.js migration; until that migration
  // runs against Supabase, selecting it causes a 400 error. It is also not used
  // downstream (normalizeCalculationInput only uses period.start_date).
  const { data, error } = await supabase
    .from('payroll_periods')
    .select('id, start_date, end_date, period_key')
    .eq('company_id', companyId)
    .eq('period_key', periodKey)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Fetch employee master record with payroll-relevant fields.
 */
async function fetchEmployee(companyId, employeeId, supabase) {
  // Use select('*') to avoid column-not-found errors when payroll-specific columns
  // haven't been added yet by the payroll-schema migration.
  // normalizeCalculationInput handles missing fields with safe defaults.
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', employeeId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;

  if (data) {
    // Normalize column name variants between base schema and payroll schema:
    // Base schema uses 'salary'; payroll-schema migration adds 'basic_salary'.
    // If 'basic_salary' doesn't exist yet, fall through to 'salary'.
    if (data.basic_salary === undefined && data.salary !== undefined) {
      data.basic_salary = data.salary;
    }
    // Base schema uses 'hire_date'; engine expects 'start_date'.
    if (data.start_date === undefined && data.hire_date !== undefined) {
      data.start_date = data.hire_date;
    }
  }

  return data;
}

/**
 * Fetch employee's work schedule.
 * Returns schedule array with day-of-week definitions.
 * Format: [{ day: 'MON', enabled: true, type: 'normal'|'partial', partial_hours: 8.0 }, ...]
 *
 * DECIMAL HOURS STANDARD: partial_hours are stored and returned as decimals.
 * E.g., 6.5 hours, not "6:30".
 */
async function fetchWorkSchedule(companyId, employeeId, supabase) {
  // employee_work_schedules table is created by payroll-schema.js migration.
  // If not yet migrated, catch the "relation does not exist" error and
  // fall back to the default Mon-Fri 8h schedule.
  const { data, error } = await supabase
    .from('employee_work_schedules')
    .select(
      `id, day_of_week, is_enabled, schedule_type,
       hours_per_day, notes`
    )
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .order('day_of_week', { ascending: true });

  if (error) {
    // PGRST116 = no rows found; anything else including 42P01 (table not found)
    // → fall back to default schedule
    if (error.code !== 'PGRST116') {
      console.warn('[PayrollDataService] fetchWorkSchedule: table unavailable, using default schedule.', error.code);
    }
    return getDefaultWorkSchedule();
  }

  if (!data || data.length === 0) {
    // Default: Monday-Friday, 8 hours/day (if no schedule exists)
    return getDefaultWorkSchedule();
  }

  // Normalize database schedule to engine format
  return data.map(row => ({
    day: normalizeDayOfWeek(row.day_of_week),
    enabled: row.is_enabled === true,
    type: row.schedule_type === 'partial' ? 'partial' : 'normal',
    partial_hours: row.hours_per_day // Preserved as decimal
  }));
}

/**
 * Return default work schedule (Mon-Fri, 8 hrs/day).
 * Used if employee has no custom schedule.
 */
function getDefaultWorkSchedule() {
  return [
    { day: 'MON', enabled: true, type: 'normal' },
    { day: 'TUE', enabled: true, type: 'normal' },
    { day: 'WED', enabled: true, type: 'normal' },
    { day: 'THU', enabled: true, type: 'normal' },
    { day: 'FRI', enabled: true, type: 'normal' },
    { day: 'SAT', enabled: false },
    { day: 'SUN', enabled: false }
  ];
}

/**
 * Normalize day-of-week from database (various formats) to 3-letter code.
 * Handles: 'monday', 'MON', 1, etc.
 */
function normalizeDayOfWeek(dayInput) {
  const dayMap = {
    '0': 'SUN', 'sunday': 'SUN', 'sun': 'SUN',
    '1': 'MON', 'monday': 'MON', 'mon': 'MON',
    '2': 'TUE', 'tuesday': 'TUE', 'tue': 'TUE',
    '3': 'WED', 'wednesday': 'WED', 'wed': 'WED',
    '4': 'THU', 'thursday': 'THU', 'thu': 'THU',
    '5': 'FRI', 'friday': 'FRI', 'fri': 'FRI',
    '6': 'SAT', 'saturday': 'SAT', 'sat': 'SAT'
  };
  const key = String(dayInput).toLowerCase();
  return dayMap[key] || 'MON'; // Default to MON if invalid
}

/**
 * Fetch company-level payroll settings (tax year, base rates, etc.).
 */
async function fetchCompanyPayrollSettings(companyId, supabase) {
  // company_payroll_settings is created by payroll-schema.js migration.
  // Gracefully fall back to SA 2026/2027 defaults if table doesn't exist yet.
  const { data, error } = await supabase
    .from('company_payroll_settings')
    .select(
      `id, tax_year, uif_rate, sdl_rate,
       hourly_divisor, medical_credit_main,
       medical_credit_first_dep, medical_credit_additional,
       primary_rebate, secondary_rebate, tertiary_rebate`
    )
    .eq('company_id', companyId)
    .maybeSingle();

  if (error) {
    if (error.code !== 'PGRST116') {
      console.warn('[PayrollDataService] fetchCompanyPayrollSettings: table unavailable, using defaults.', error.code);
    }
    return getDefaultPayrollSettings();
  }

  // Return defaults if no settings row exists
  if (!data) {
    return getDefaultPayrollSettings();
  }

  return data;
}

/**
 * Return default company payroll settings (SA 2026/2027 defaults).
 */
function getDefaultPayrollSettings() {
  return {
    tax_year: '2026/2027',
    uif_rate: 0.01,
    sdl_rate: 0.01,
    hourly_divisor: 173.33,
    medical_credit_main: 364,
    medical_credit_first_dep: 364,
    medical_credit_additional: 246,
    primary_rebate: 17235,
    secondary_rebate: 9444,
    tertiary_rebate: 3145
  };
}

/**
 * Fetch recurring payroll items assigned to employee.
 * E.g., commission, allowances, deductions, etc.
 */
async function fetchRecurringPayrollItems(companyId, employeeId, supabase) {
  // employee_payroll_items and payroll_items are created by payroll-schema migration.
  // Gracefully return empty array if tables don't exist yet.
  const { data, error } = await supabase
    .from('employee_payroll_items')
    .select(
      `id, payroll_item_id, amount, percentage, item_type,
       payroll_items(code, name, item_category, is_taxable)`
    )
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('is_active', true);

  if (error) {
    if (error.code !== 'PGRST116') {
      console.warn('[PayrollDataService] fetchRecurringPayrollItems: table unavailable, returning [].', error.code);
    }
    return [];
  }
  return data || [];
}

/**
 * Fetch period-specific inputs, overtime, short-time, multi-rate, etc.
 * These are ONE-OFF items for this specific pay period.
 */
async function fetchPeriodInputs(
  companyId,
  employeeId,
  periodId,
  supabase
) {
  // Fetch current period inputs (one-off line items)
  const { data: currentInputs, error: err1 } = await supabase
    .from('payroll_period_inputs')
    .select(
      `id, description, amount, item_type,
       payroll_items(code, item_category)`
    )
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('payroll_period_id', periodId);

  // Fetch overtime entries
  const { data: overtime, error: err2 } = await supabase
    .from('payroll_overtime')
    .select(`id, hours, rate_multiplier, description`)
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('payroll_period_id', periodId)
    .eq('is_deleted', false);

  // Fetch short-time entries
  const { data: shortTime, error: err3 } = await supabase
    .from('payroll_short_time')
    .select(`id, hours_missed, description`)
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('payroll_period_id', periodId)
    .eq('is_deleted', false);

  // Fetch multi-rate entries (not yet common, but prepared)
  const { data: multiRate, error: err4 } = await supabase
    .from('payroll_multi_rate')
    .select(`id, hours, rate_multiplier, description`)
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('payroll_period_id', periodId)
    .eq('is_deleted', false);

  if (err1 || err2 || err3 || err4) {
    const errors = [err1, err2, err3, err4].filter(Boolean);
    console.error('Error fetching period inputs:', errors);
  }

  return {
    currentInputs: currentInputs || [],
    overtime: overtime || [],
    shortTime: shortTime || [],
    multiRate: multiRate || []
  };
}

/**
 * Normalize all fetched data into PayrollEngine input format.
 * This is the critical transformation step.
 *
 * OUTPUT CONTRACT (matches PayrollEngine.calculateFromData signature):
 * {
 *   basic_salary: number,
 *   regular_inputs: [ { description, amount, type }, ... ],
 *   workSchedule: [ { day, enabled, type, partial_hours }, ... ],
 *   hours_per_day: number (decimal),
 *   ...additional schema from engine
 * }
 */
function normalizeCalculationInput(
  employee,
  workSchedule,
  companySettings,
  recurringItems,
  periodInputs,
  period
) {
  const age = employee.age || calculateAge(employee.dob);

  // Normalize recurring items into regular_inputs format
  const regularInputs = recurringItems.map(item => ({
    description: item.payroll_items?.name || item.payroll_items?.code || 'Unknown',
    amount: item.amount || 0,
    percentage: item.percentage || 0,
    type: item.item_type || 'allowance',
    is_taxable: item.payroll_items?.is_taxable !== false
  }));

  // Normalize period inputs (one-off items)
  const normalizedPeriodInputs = periodInputs.currentInputs.map(item => ({
    description: item.payroll_items?.code || item.description || 'Unknown',
    amount: item.amount || 0,
    type: item.item_type || 'input'
  }));

  // Combine recurring + period inputs
  const allInputs = [...regularInputs, ...normalizedPeriodInputs];

  // Normalize overtime (preserve decimal hours)
  const overtimeNormalized = periodInputs.overtime.map(ot => ({
    hours: parseFloat(ot.hours) || 0, // Decimal hours
    rate_multiplier: parseFloat(ot.rate_multiplier) || 1.5
  }));

  // Normalize short-time (preserve decimal hours)
  const shortTimeNormalized = periodInputs.shortTime.map(st => ({
    hours_missed: parseFloat(st.hours_missed) || 0 // Decimal hours
  }));

  // Normalize multi-rate (preserve decimal hours)
  const multiRateNormalized = periodInputs.multiRate.map(mr => ({
    hours: parseFloat(mr.hours) || 0, // Decimal hours
    rate_multiplier: parseFloat(mr.rate_multiplier) || 1.5
  }));

  const normalizedInput = {
    // === Employee & Context ===
    basic_salary: parseFloat(employee.basic_salary) || 0,
    regular_inputs: allInputs,
    workSchedule: workSchedule,
    hours_per_day: parseFloat(employee.hours_per_day || 8), // Decimal

    // === Pro-Rata Support ===
    start_date: employee.start_date || null,
    end_date: employee.termination_date || null, // Auto-populated from employee record

    // === Period Boundaries (for auto-proration detection in routes) ===
    period_start_date: period.start_date || null,
    period_end_date:   period.end_date   || null,

    // === Current Period Items ===
    currentInputs: normalizedPeriodInputs,
    overtime: overtimeNormalized,
    shortTime: shortTimeNormalized,
    multiRate: multiRateNormalized,

    // === Employee Options for Tax Calc ===
    employeeOptions: {
      age: age,
      medicalMembers: parseInt(employee.medical_aid_members) || 0,
      taxDirective: employee.tax_directive ? parseFloat(employee.tax_directive) : null,
      rebateCode: employee.tax_rebate_code || 'R'
    },

    // === Period Context ===
    period: formatPeriodKey(period.start_date), // YYYY-MM format

    // === YTD Data (if using SARS method) ===
    ytdData: null // Set by caller if needed for YTD tax calc

    // === Metadata (not used by engine, but useful for audit trail) ===
    // employeeId: employee.id,
    // periodId: period.id,
    // companyId: companyId
  };

  return normalizedInput;
}

/**
 * Calculate age from date of birth.
 * Returns null if dob not provided.
 */
function calculateAge(dob) {
  if (!dob) return null;
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age--;
  }
  return age;
}

/**
 * Format period start_date to YYYY-MM format.
 */
function formatPeriodKey(startDate) {
  if (!startDate) return null;
  const date = new Date(startDate);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

module.exports = {
  fetchCalculationInputs,
  fetchPeriod,
  fetchEmployee,
  fetchWorkSchedule,
  fetchCompanyPayrollSettings,
  fetchRecurringPayrollItems,
  fetchPeriodInputs
};
