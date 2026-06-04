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

const PayrollEngine = require('../../../core/payroll-engine');

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
  // Step 2b: If basic_salary is missing from the employees table, fall back to the
  // KV store (key: emp_payroll_{companyId}_{employeeId}). The frontend employee-detail
  // page writes payroll setup (including basic_salary) there via polyfills.js.
  if (!employee.basic_salary) {
    try {
      const kvKey = `emp_payroll_${companyId}_${employeeId}`;
      const { data: kvRow } = await supabase
        .from('payroll_kv_store_eco')
        .select('value')
        .eq('company_id', companyId)
        .eq('key', kvKey)
        .maybeSingle();
      if (kvRow && kvRow.value) {
        const kvVal = typeof kvRow.value === 'string' ? JSON.parse(kvRow.value) : kvRow.value;
        if (kvVal && kvVal.basic_salary) {
          employee.basic_salary = kvVal.basic_salary;
        }
      }
    } catch (kvErr) {
      // KV fallback is best-effort — a missing KV entry is not an error
      console.warn(`[PayrollDataService] KV salary fallback failed for emp ${employeeId}:`, kvErr.message);
    }
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

  // Step 4b: Fetch company SDL/UIF registration flags from companies table.
  // These control whether SDL/UIF are calculated (true = calculate, false = 0).
  const companyRegistrationFlags = await fetchCompanyRegistrationFlags(
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

  // Step 6b: Fetch YTD data from prior locked snapshots in the same SA tax year.
  // Returns null if: first month of tax year, no prior locked snapshots exist,
  // PAYE_YTD_ENABLED=false, or any DB error — all of which fall back to monthly method.
  const ytdData = await fetchYtdData(companyId, employeeId, periodKey, supabase);

  // Step 7: Normalize into engine input format
  const normalizedInput = normalizeCalculationInput(
    employee,
    workSchedule,
    companySettings,
    recurringItems,
    periodInputs,
    period,
    companyRegistrationFlags
  );

  // Attach YTD data (set after normalizeCalculationInput which defaults this to null)
  normalizedInput.ytdData = ytdData;

  return normalizedInput;
}

/**
 * Fetch YTD (year-to-date) data from prior finalized snapshots for an employee.
 *
 * Returns the accumulated periodic taxable gross, once-off taxable gross, and PAYE
 * already withheld across all LOCKED snapshots in the same SA tax year that precede
 * the current period.  This is the authoritative input to calculateMonthlyPAYE_YTD().
 *
 * YTD source rules (in order):
 *   1. payroll_snapshots where same company_id, same employee_id, same tax year,
 *      period_key < current period, is_locked = true.
 *   2. If no locked prior snapshots exist → returns null (caller uses monthly method).
 *
 * Disable feature-wide by setting PAYE_YTD_ENABLED=false in the environment.
 *
 * @param {number} companyId
 * @param {number} employeeId
 * @param {string} periodKey - Current period 'YYYY-MM'
 * @param {object} supabase
 * @returns {Promise<object|null>} ytdData for engine, or null to use monthly method
 */
async function fetchYtdData(companyId, employeeId, periodKey, supabase) {
    // Feature flags:
    //   PAYE_YTD_ENABLED=false        → disable YTD entirely; fall back to monthly annualization.
    //   PAYE_YTD_METHOD=average_taxable (default) → YTD average taxable gross method.
    //   PAYE_YTD_METHOD=cumulative               → old cumulative projection method (legacy).
    //   PAYE_YTD_METHOD=projection_type          → per-item type classification method.
    if (process.env.PAYE_YTD_ENABLED === 'false') return null;
    const _ytdMethodEnv  = process.env.PAYE_YTD_METHOD || 'average_taxable';
    const _methodName    = _ytdMethodEnv === 'cumulative'        ? 'cumulative_ytd'
                         : _ytdMethodEnv === 'projection_type'   ? 'projection_type_ytd'
                         : 'average_taxable_ytd';

    // Get all prior periods in the same SA tax year (never includes current period).
    // Returns [] for March (month 1 of tax year) — no prior periods possible.
    const priorPeriods = PayrollEngine.getTaxYearPriorPeriods(periodKey);
    if (!priorPeriods.length) return null;

    let snapshots;
    try {
        const { data, error } = await supabase
            .from('payroll_snapshots')
            .select('period_key, calculation_output')
            .eq('company_id', companyId)
            .eq('employee_id', employeeId)
            .eq('is_locked', true)
            .in('period_key', priorPeriods)
            .order('period_key', { ascending: true });

        if (error) {
            console.warn('[PayrollDataService] fetchYtdData: DB error, falling back to monthly method:', error.message);
            return null;
        }
        snapshots = data;
    } catch (ex) {
        console.warn('[PayrollDataService] fetchYtdData: exception, falling back to monthly method:', ex.message);
        return null;
    }

    if (!snapshots || snapshots.length === 0) return null;

    // Aggregate YTD totals from locked snapshots only.
    let ytdPeriodicTaxableGross = 0;
    let ytdOnceOffTaxableGross  = 0;
    let ytdPAYE                 = 0;
    const periods = [];

    for (const snap of snapshots) {
        const out = snap.calculation_output || {};

        // periodicTaxableGross was added as an engine output field alongside migration 018.
        // Fall back to taxableGross for older snapshots that predate that field — this
        // slightly overstates the periodic portion (conservative, never understates PAYE).
        const periodicTaxable = typeof out.periodicTaxableGross === 'number'
            ? out.periodicTaxableGross
            : (typeof out.taxableGross === 'number' ? out.taxableGross : 0);
        const onceOffTaxable  = typeof out.onceOffTaxableGross === 'number'
            ? out.onceOffTaxableGross : 0;

        // Use paye_base (statutory PAYE before voluntary adjustments) for YTD accumulation.
        // The YTD formula in calculateMonthlyPAYE_YTD() computes a STATUTORY liability.
        // ytdPAYE must be on the same basis — statutory only — so the subtraction is
        // apples-to-apples.  Voluntary additions in prior months have already been
        // correctly deducted from those months' net pay; including them here would
        // over-credit prior periods and zero out the current month's statutory PAYE.
        // Fall back to paye only for old snapshots that pre-date the paye_base field.
        const payeBase     = (typeof out.paye_base === 'number' && out.paye_base >= 0)
            ? out.paye_base
            : (typeof out.paye === 'number' ? out.paye : 0);
        const payeFinal    = typeof out.paye === 'number' ? out.paye : 0;

        ytdPeriodicTaxableGross += periodicTaxable;
        ytdOnceOffTaxableGross  += onceOffTaxable;
        ytdPAYE                 += payeBase;

        periods.push({
            period_key:           snap.period_key,
            periodicTaxableGross: periodicTaxable,
            onceOffTaxableGross:  onceOffTaxable,
            paye_base:            payeBase,
            paye:                 payeFinal
        });
    }

    const taxYear        = PayrollEngine.getTaxYearForPeriod(periodKey);
    const monthInTaxYear = PayrollEngine.getMonthInTaxYear(periodKey);

    const priorTaxableGross = PayrollEngine.r2(ytdPeriodicTaxableGross + ytdOnceOffTaxableGross);
    const ytdPAYEFinal      = periods.reduce((s, p) => s + p.paye, 0);
    console.log(
        `[PayrollDataService] YTD(${_methodName}): empId=${employeeId} period=${periodKey}` +
        ` taxYear=${taxYear} monthInTaxYear=${monthInTaxYear}` +
        ` priorSnapshots=${snapshots.length}` +
        ` priorTaxableGross=${priorTaxableGross}` +
        ` priorPAYEPaid(statutory)=${ytdPAYE}` +
        ` priorPAYEPaid(incl.voluntary)=${ytdPAYEFinal}`
    );

    return {
        // Method identifier — read by engine dispatch to select formula.
        // average_taxable_ytd: (priorTotal + currentTotal) / months × 12
        // cumulative_ytd:      priorPeriodic × 12/months + priorOnceOff (legacy)
        method:                      _methodName,
        tax_year:                    taxYear,
        current_period:              periodKey,
        current_month_in_tax_year:   monthInTaxYear,
        prior_periods_count:         snapshots.length,
        // Semantic field names — these are what the engine dispatch reads for the average method
        prior_taxable_gross:         priorTaxableGross,
        prior_paye_paid:             ytdPAYE,            // paye_base sum (statutory, never voluntary)
        // Total PAYE collected including voluntary over-deductions — used by projection_type_ytd
        // spreading formula: (annualTax - priorTotalPaid) / remainingMonths.
        prior_total_paye_paid:       PayrollEngine.r2(ytdPAYEFinal),
        // Split fields kept for the cumulative fallback path
        prior_periodic_taxable_gross: ytdPeriodicTaxableGross,
        prior_once_off_taxable_gross: ytdOnceOffTaxableGross,
        source:                      'locked_snapshots',
        periods
    };
}

/**
 * Fetch period by period_key (YYYY-MM format).
 * Returns first matching period for the company.
 */
async function fetchPeriod(companyId, periodKey, supabase) {
  // NOTE: tax_year is NOT selected here — it does not exist in the base payroll_periods
  // schema. The column is added by payroll-schema.js migration; until that migration
  // runs against Supabase, selecting it causes a 400 error. Tax year is resolved
  // dynamically from period_key by the engine via getTaxYearForPeriod().
  const { data, error } = await supabase
    .from('payroll_periods')
    .select('id, start_date, end_date, period_key')
    .eq('company_id', companyId)
    .eq('period_key', periodKey)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  if (data) return data;

  // Period doesn't exist yet — auto-create it from the YYYY-MM key.
  // This avoids requiring the user to manually create periods before calculating.
  const [y, m] = periodKey.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const startDate = new Date(y, m - 1, 1);
  const endDate   = new Date(y, m, 0); // last day of month
  const fmt = (d) => d.toISOString().slice(0, 10);
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const { data: created, error: createErr } = await supabase
    .from('payroll_periods')
    .insert({
      company_id:  companyId,
      period_key:  periodKey,
      period_name: months[m - 1] + ' ' + y,
      start_date:  fmt(startDate),
      end_date:    fmt(endDate),
      pay_date:    fmt(endDate)
    })
    .select('id, start_date, end_date, period_key')
    .single();

  if (createErr) {
    // Race condition: another request created it between our read and insert.
    // Retry the read once.
    if (createErr.code === '23505') {
      const { data: retry } = await supabase
        .from('payroll_periods')
        .select('id, start_date, end_date, period_key')
        .eq('company_id', companyId)
        .eq('period_key', periodKey)
        .maybeSingle();
      return retry || null;
    }
    console.error('[fetchPeriod] auto-create failed:', createErr.message);
    return null;
  }
  console.log('[fetchPeriod] auto-created period:', periodKey, 'id:', created.id);
  return created;
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
  // The work schedule is stored in employee_work_schedule (singular) — one row
  // per employee. It holds hours_per_day (the standard daily hours) and a
  // working_days JSONB array describing each day's enabled/partial state.
  try {
    const { data, error } = await supabase
      .from('employee_work_schedule')
      .select('hours_per_day, working_days')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .single();

    if (error || !data) {
      if (error && error.code !== 'PGRST116') {
        console.warn('[PayrollDataService] fetchWorkSchedule: query error, using default schedule.', error.code);
      }
      return getDefaultWorkSchedule();
    }

    const hpd = parseFloat(data.hours_per_day) || 8;
    const days = Array.isArray(data.working_days) ? data.working_days : [];
    if (days.length === 0) return getDefaultWorkSchedule();

    // All days use `type: 'partial'` with explicit partial_hours so that
    // calcWeeklyHours uses the stored value instead of a fallback default.
    // For 'partial' days the stored partial_hours override takes precedence;
    // for 'normal' days the row-level hours_per_day applies to all.
    return days.map(d => {
      const isPartial = d.type === 'partial' && d.partial_hours != null && parseFloat(d.partial_hours) > 0;
      return {
        day:           normalizeDayOfWeek(d.day),
        enabled:       d.enabled === true,
        type:          'partial',
        partial_hours: isPartial ? parseFloat(d.partial_hours) : hpd
      };
    });
  } catch (ex) {
    console.warn('[PayrollDataService] fetchWorkSchedule: exception, using default schedule.', ex.message);
    return getDefaultWorkSchedule();
  }
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
 * Fetch company SDL/UIF registration flags from the companies table.
 * Returns { sdl_registered: bool, uif_registered: bool }.
 * Defaults to true (registered) if column is null or company not found —
 * ensuring backward compatibility with companies created before migration 018.
 */
async function fetchCompanyRegistrationFlags(companyId, supabase) {
  const { data, error } = await supabase
    .from('companies')
    .select('sdl_registered, uif_registered')
    .eq('id', companyId)
    .maybeSingle();

  if (error) {
    console.warn('[PayrollDataService] fetchCompanyRegistrationFlags: error fetching flags, defaulting to registered.', error.code);
    return { sdl_registered: true, uif_registered: true };
  }

  return {
    sdl_registered: data?.sdl_registered !== false, // null or true → true; only explicit false = false
    uif_registered: data?.uif_registered !== false
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
       payroll_items(code, name, item_category, is_taxable, tax_treatment, paye_projection_type, affects_uif)`
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
      // affects_uif is read directly from payroll_period_inputs (stamped at insert time
      // by POST /api/payroll/transactions/inputs from payroll_items_master).
      // It is NOT read via the payroll_items join because payroll_item_id is often null,
      // which makes the join return null and affects_uif unresolvable from the join.
      // Both affects_uif and is_taxable are read directly from payroll_period_inputs
      // (stamped at insert time by POST /api/payroll/transactions/inputs).
      // They are NOT read via the payroll_items join (payroll_item_id is often null).
      // INDEPENDENT FLAGS: is_taxable → PAYE only. affects_uif → UIF only.
      `id, description, amount, item_type, affects_uif, is_taxable,
       payroll_items(code, item_category, tax_treatment)`
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

  // Override affects_uif from payroll_items_master at calculation time.
  //
  // Problem: payroll_period_inputs records may have affects_uif = true (the
  // migration default) even when the master item is configured as Affects UIF = No.
  // This happens for any record saved before the fix, or if the user never re-saved.
  //
  // Solution: after loading period inputs, fetch the latest affects_uif values from
  // payroll_items_master and stamp them onto the loaded records.  One extra query
  // per calculation — acceptable cost for always-correct behaviour.  Non-fatal:
  // if this lookup fails, the stored record value is used (defaults to true = safe).
  const loadedInputs = currentInputs || [];
  if (loadedInputs.length > 0) {
    try {
      const { data: masterItems } = await supabase
        .from('payroll_items_master')
        .select('item_name, affects_uif, is_taxable')  // item_name not name; both independent flags
        .eq('company_id', companyId)
        .eq('is_active', true);
      if (masterItems && masterItems.length > 0) {
        const masterFlagMap = {};
        masterItems.forEach(function(m) {
          if (m.item_name) {
            masterFlagMap[m.item_name.toLowerCase().trim()] = {
              affects_uif: m.affects_uif !== false,
              is_taxable:  m.is_taxable  !== false
            };
          }
        });
        loadedInputs.forEach(function(ci) {
          const key = (ci.description || '').toLowerCase().trim();
          if (Object.prototype.hasOwnProperty.call(masterFlagMap, key)) {
            // Override both flags from master config independently.
            // affects_uif: UIF base only — never affects PAYE.
            // is_taxable:  PAYE base only — never affects UIF.
            ci.affects_uif = masterFlagMap[key].affects_uif;
            ci.is_taxable  = masterFlagMap[key].is_taxable;
          }
          // If no master match: keep stored record values (both default true).
        });
      }
    } catch (masterErr) {
      console.warn('[PayrollDataService] affects_uif master override failed (non-fatal):', masterErr.message);
    }
  }

  return {
    currentInputs: loadedInputs,
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
  period,
  companyRegistrationFlags
) {
  // Calculate age at the END of the SA tax year (28/29 Feb) — SARS requires rebate tier
  // to be determined at year-end, not at today's date or the current pay period date.
  // E.g. an employee who turns 65 on 15 Jan within the tax year gets the secondary rebate
  // for the full year. Age at tax year end is the correct reference point.
  const taxYearEndDate = getTaxYearEndDate(period.period_key);
  let age = calculateAge(employee.dob, taxYearEndDate);
  // If dob is not stored but SA ID number is available, derive age from ID.
  if (age === null && employee.id_number) {
    age = PayrollEngine.getAgeFromId(employee.id_number, taxYearEndDate);
  }

  // Normalize recurring items into regular_inputs format
  const regularInputs = recurringItems.map(item => ({
    description: item.payroll_items?.name || item.payroll_items?.code || 'Unknown',
    amount: item.amount || 0,
    percentage: item.percentage || 0,
    type: item.item_type || 'allowance',
    is_taxable: item.payroll_items?.is_taxable !== false,
    // tax_treatment: controls whether a deduction reduces taxableGross (pre-PAYE) or net only.
    // Defaults to 'net_only' for backward compatibility with items that predate migration 018.
    tax_treatment: item.payroll_items?.tax_treatment || 'net_only',
    // paye_projection_type: how this item is classified in the projection_type_ytd method.
    // Defaults to 'VARIABLE_AVERAGE' — the conservative safe default for unclassified items.
    paye_projection_type: item.payroll_items?.paye_projection_type || 'VARIABLE_AVERAGE',
    // affects_uif: controls whether this item contributes to the UIF-applicable gross.
    // MUST preserve explicit false — do not use || true fallback (it erases false).
    // null/undefined → true (default UIF-applicable); only explicit false = excluded.
    affects_uif: item.payroll_items?.affects_uif !== false
  }));

  // Normalize period inputs (one-off items)
  const normalizedPeriodInputs = periodInputs.currentInputs.map(item => ({
    description: item.payroll_items?.code || item.description || 'Unknown',
    amount: item.amount || 0,
    type: item.item_type || 'input',
    // Inherit tax_treatment from the linked payroll item master; default net_only.
    tax_treatment: item.payroll_items?.tax_treatment || 'net_only',
    // is_taxable: read directly from payroll_period_inputs.is_taxable (stamped at insert
    // from payroll_items_master by POST /inputs, then live-overridden by fetchPeriodInputs).
    // Controls PAYE taxable income ONLY — completely independent of affects_uif.
    // Preserving explicit false: null/undefined → true (default taxable).
    is_taxable:  item.is_taxable  !== false,
    // affects_uif: read directly from payroll_period_inputs.affects_uif (same pipeline).
    // Controls UIF contribution base ONLY — completely independent of is_taxable.
    affects_uif: item.affects_uif !== false
  }));

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
    regular_inputs: regularInputs,
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
      rebateCode: employee.tax_rebate_code || 'R',
      // Directors are excluded from UIF per the Unemployment Insurance Act.
      // is_director === true → engine sets UIF = 0 regardless of company registration.
      is_director: employee.is_director === true,
      // Company-level SDL/UIF registration flags (from migration 018).
      // false = company is exempt → engine returns 0 for that levy.
      // Defaults to true for backward compatibility if flags not yet in DB.
      sdl_registered: companyRegistrationFlags ? companyRegistrationFlags.sdl_registered !== false : true,
      uif_registered: companyRegistrationFlags ? companyRegistrationFlags.uif_registered !== false : true,
      // Voluntary tax over-deduction config from the employee's saved record.
      // Normalised here so that both /api/payroll/calculate (single-employee preview)
      // and /api/payroll/run (Execute Payroll) receive the same config automatically.
      // payruns.js may still override this with a caller-supplied voluntary_configs
      // map (for backward compat) — its injection runs after fetchCalculationInputs.
      voluntaryTaxConfig: employee.voluntary_tax_config || null
    },

    // === Period Context ===
    // Use period.period_key directly — it is already YYYY-MM and was query-verified.
    // Do NOT re-derive from period.start_date via new Date(): ISO date-only strings are
    // parsed as UTC midnight, and getMonth() returns the prior month on servers running
    // UTC-negative timezones, causing March to resolve as February and selecting the
    // wrong SA tax year tables for the first month of the new tax year.
    period: period.period_key,

    // === YTD Data (SARS cumulative method) ===
    // Populated by fetchCalculationInputs() from prior locked snapshots.
    // null here is overridden by the caller after normalizeCalculationInput returns.
    ytdData: null

    // === Metadata (not used by engine, but useful for audit trail) ===
    // employeeId: employee.id,
    // periodId: period.id,
    // companyId: companyId
  };

  return normalizedInput;
}

/**
 * Return the end date of the SA tax year for a given period key ('YYYY-MM').
 * SA tax year runs 1 March → last day of February.
 * The end date is 28 or 29 February of the year AFTER the tax year opens.
 * e.g. '2026-04' → tax year 2026/2027 → returns Date representing 28 Feb 2027
 * Used to calculate employee age at the correct SARS reference point.
 */
function getTaxYearEndDate(periodKey) {
  const taxYear = PayrollEngine.getTaxYearForPeriod(periodKey || '');
  const endYear = parseInt(taxYear.split('/')[1], 10);
  const isLeap = (endYear % 4 === 0 && endYear % 100 !== 0) || (endYear % 400 === 0);
  return new Date(endYear, 1, isLeap ? 29 : 28);
}

/**
 * Calculate age from date of birth at a specific reference date.
 * @param {string} dob - Date of birth (YYYY-MM-DD or any Date-parseable string)
 * @param {Date} [refDate] - Reference date for age calculation (defaults to today).
 *   Pass tax year end date (28/29 Feb) for SARS-compliant rebate tier determination.
 * Returns null if dob not provided.
 */
function calculateAge(dob, refDate) {
  if (!dob) return null;
  const birthDate = new Date(dob);
  const ref = refDate || new Date();
  let age = ref.getFullYear() - birthDate.getFullYear();
  const monthDiff = ref.getMonth() - birthDate.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && ref.getDate() < birthDate.getDate())
  ) {
    age--;
  }
  return age;
}

/**
 * Format period start_date to YYYY-MM format.
 * Parses YYYY-MM directly from the string to avoid timezone offset issues:
 * new Date('2026-03-01') is UTC midnight and getMonth() returns the prior
 * month on servers with a negative UTC offset (e.g. UTC-1 → Feb 28 23:00).
 * This function is a fallback only — callers should prefer period.period_key.
 */
function formatPeriodKey(startDate) {
  if (!startDate) return null;
  const match = String(startDate).match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

module.exports = {
  fetchCalculationInputs,
  fetchYtdData,
  fetchPeriod,
  fetchEmployee,
  fetchWorkSchedule,
  fetchCompanyPayrollSettings,
  fetchCompanyRegistrationFlags,
  fetchRecurringPayrollItems,
  fetchPeriodInputs
};
