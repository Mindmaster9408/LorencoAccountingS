// ============================================================
// PayrollEngine (UNIFIED) - Shared Payroll Calculation Module
// South African PAYE Tax Calculation
// ============================================================
// Status: Production-Ready Unified Engine
// Version: 2026-04-12-v1
// Schema Version: 1.0 (locked for backward compatibility)
//
// ============================================================
// TIME INPUT STANDARD (MANDATORY)
// ============================================================
// All payroll time values must use DECIMAL HOURS inside this engine.
// Reference conversion table:
//   15 minutes = 0.25 hours
//   30 minutes = 0.50 hours
//   45 minutes = 0.75 hours
//   1 hour    = 1.00 hours
// Do NOT use HH:MM format as the calculation basis.
// workSchedule partial_hours field must be in decimal format.
//
// This is the single source of truth for all payroll calculations
// across the Lorenco ecosystem.
//
// ============================================================
// OUTPUT CONTRACT (IMMUTABLE — additive changes only)
// ============================================================
// returns Object with the following structure:
// {
//   gross:                          {number} — total earnings (taxable + non-taxable)
//   taxableGross:                   {number} — income subject to PAYE tax
//   paye:                           {number} — PAYE tax withheld (includes voluntary over-deduction)
//   paye_base:                      {number} — base PAYE (before voluntary top-up)
//   voluntary_overdeduction:        {number} — bonus-linked/fixed additional tax withholding
//   uif:                            {number} — Unemployment Insurance Fund contribution
//   sdl:                            {number} — Skills Development Levy
//   deductions:                     {number} — non-tax deductions (pension, medical, etc.)
//   net:                            {number} — take-home pay (gross - paye - uif - deductions)
//   negativeNetPay:                 {boolean} — true if net < 0
//   medicalCredit:                  {number} — monthly medical tax credit (Section 6A/6B)
//   overtimeAmount:                 {number} — overtime earnings (calculated separately)
//   shortTimeAmount:                {number} — short-time deductions (calculated separately)
//   preTaxDeductions:               {number} — qualifying pre-tax deductions (pension, RA)
//   netOnlyDeductions:              {number} — net-only deductions (medical aid, garnishee)
//   periodicTaxableGross:           {number} — recurring taxable gross (annualised × 12)
//   onceOffTaxableGross:            {number} — once-off taxable gross (never annualised)
//   taxBeforeRebate:                {number} — monthly bracket tax before age rebates
//   rebate:                         {number} — monthly total age rebate (primary+secondary+tertiary)
//   primary_rebate_annual:          {number} — annual primary rebate from active tax tables
//   secondary_rebate_annual:        {number} — annual secondary rebate (age >= 65)
//   tertiary_rebate_annual:         {number} — annual tertiary rebate (age >= 75)
//   uif_monthly_cap:                {number} — UIF monthly cap from active tax tables
//   marginal_rate:                  {string} — marginal bracket rate e.g. "26%"
//   marginal_bracket:               {string} — marginal bracket range e.g. "R237,101 - R370,500"
//   tax_year:                       {string} — active tax year e.g. "2026/2027"
// }
// NOTE: All display fields (primary_rebate_annual … tax_year) come from the SAME tables
// object used for the calculation. Frontend must use these fields exclusively for explanation
// text — NO frontend engine calls, NO hardcoded defaults.
//
// OUTPUT RULES:
// - All numeric values are rounded to 2 decimal places (cents)
// - Fields are NEVER removed (backward compatibility rule)
// - New fields ONLY added after last field (no insertion)
// - Field order NEVER changed in return statement
// - All values are non-negative (except net which can be negative)
//
// HISTORICAL IMMUTABILITY:
// Payslips finalized with this engine MUST be stored with:
// { ...payroll_output, engineVersion: '2026-04-12-v1', schemaVersion: '1.0' }
// Future engines MUST preserve these version fields and NEVER recalculate finalized payslips.
//
// TAX TABLE UPDATE GUIDE (every 1 March):
//   1. Go to Payroll → Payroll Items → Tax Configuration (super-admin)
//   2. Enter new brackets/rebates from the SARS budget announcement
//   3. Save — tables are stored in Supabase and override these defaults
//   4. If you need to update code defaults, edit BRACKETS/REBATES below
//      and update DEFAULT_TAX_YEAR.  Source: www.sars.gov.za
// ============================================================

const PayrollEngine = {

    // === ENGINE METADATA ===
    ENGINE_VERSION: '2026-04-12-v1',
    SCHEMA_VERSION: '1.0',

    // === DEFAULT TAX CONSTANTS (SA 2026/2027 — same brackets as 2025/2026, pending SARS confirmation) ===
    // Override via Tax Configuration in Payroll Items (stored in Supabase KV)
    TAX_YEAR: '2026/2027',

    BRACKETS: [
        { min: 0,       max: 237100,   base: 0,      rate: 0.18 },
        { min: 237101,  max: 370500,   base: 42678,   rate: 0.26 },
        { min: 370501,  max: 512800,   base: 77362,   rate: 0.31 },
        { min: 512801,  max: 673000,   base: 121475,  rate: 0.36 },
        { min: 673001,  max: 857900,   base: 179147,  rate: 0.39 },
        { min: 857901,  max: 1817000,  base: 251258,  rate: 0.41 },
        { min: 1817001, max: Infinity, base: 644489,  rate: 0.45 }
    ],

    PRIMARY_REBATE: 17235,
    SECONDARY_REBATE: 9444,     // age >= 65
    TERTIARY_REBATE: 3145,      // age >= 75

    UIF_RATE: 0.01,
    UIF_MONTHLY_CAP: 177.12,
    SDL_RATE: 0.01,
    HOURLY_DIVISOR: 173.33,

    // Medical Tax Credits (Section 6A/6B) - 2025/2026
    MEDICAL_CREDIT_MAIN: 364,
    MEDICAL_CREDIT_FIRST_DEP: 364,
    MEDICAL_CREDIT_ADDITIONAL: 246,

    // ============================================================
    // HISTORICAL SA TAX TABLES (auto-selected by pay period)
    // Source: www.sars.gov.za — verify before each new tax year.
    // Periods auto-resolve: e.g. '2023-07' → tax year '2023/2024'.
    // SA tax year runs 1 March → last day of February.
    // Admin can override the CURRENT year via Tax Config UI.
    // ============================================================
    HISTORICAL_TABLES: {

        // --- 2021/2022 (1 Mar 2021 – 28 Feb 2022) ---
        '2021/2022': {
            BRACKETS: [
                { min: 0,        max: 216200,   base: 0,       rate: 0.18 },
                { min: 216201,   max: 337800,   base: 38916,   rate: 0.26 },
                { min: 337801,   max: 467500,   base: 70532,   rate: 0.31 },
                { min: 467501,   max: 613600,   base: 110739,  rate: 0.36 },
                { min: 613601,   max: 782200,   base: 163335,  rate: 0.39 },
                { min: 782201,   max: 1656600,  base: 229089,  rate: 0.41 },
                { min: 1656601,  max: Infinity, base: 587593,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 15714, SECONDARY_REBATE: 8613, TERTIARY_REBATE: 2871,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 332, MEDICAL_CREDIT_FIRST_DEP: 332, MEDICAL_CREDIT_ADDITIONAL: 224
        },

        // --- 2022/2023 (1 Mar 2022 – 28 Feb 2023) ---
        '2022/2023': {
            BRACKETS: [
                { min: 0,        max: 226000,   base: 0,       rate: 0.18 },
                { min: 226001,   max: 353100,   base: 40680,   rate: 0.26 },
                { min: 353101,   max: 488700,   base: 73726,   rate: 0.31 },
                { min: 488701,   max: 641400,   base: 115762,  rate: 0.36 },
                { min: 641401,   max: 817600,   base: 170734,  rate: 0.39 },
                { min: 817601,   max: 1731600,  base: 239452,  rate: 0.41 },
                { min: 1731601,  max: Infinity, base: 614192,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 15714, SECONDARY_REBATE: 8613, TERTIARY_REBATE: 2871,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 332, MEDICAL_CREDIT_FIRST_DEP: 332, MEDICAL_CREDIT_ADDITIONAL: 224
        },

        // --- 2023/2024 (1 Mar 2023 – 29 Feb 2024) ---
        '2023/2024': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237101,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370501,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512801,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673001,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857901,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817001,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 16425, SECONDARY_REBATE: 9000, TERTIARY_REBATE: 2997,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 347, MEDICAL_CREDIT_FIRST_DEP: 347, MEDICAL_CREDIT_ADDITIONAL: 234
        },

        // --- 2024/2025 (1 Mar 2024 – 28 Feb 2025) ---
        '2024/2025': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237101,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370501,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512801,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673001,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857901,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817001,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17235, SECONDARY_REBATE: 9444, TERTIARY_REBATE: 3145,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 364, MEDICAL_CREDIT_FIRST_DEP: 364, MEDICAL_CREDIT_ADDITIONAL: 246
        },

        // --- 2025/2026 (1 Mar 2025 – 28 Feb 2026) — same brackets as 2024/2025 ---
        '2025/2026': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237101,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370501,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512801,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673001,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857901,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817001,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17235, SECONDARY_REBATE: 9444, TERTIARY_REBATE: 3145,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 364, MEDICAL_CREDIT_FIRST_DEP: 364, MEDICAL_CREDIT_ADDITIONAL: 246
        },

        // --- 2026/2027 (1 Mar 2026 – 28 Feb 2027) — verify from www.sars.gov.za after budget speech ---
        '2026/2027': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237101,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370501,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512801,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673001,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857901,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817001,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17235, SECONDARY_REBATE: 9444, TERTIARY_REBATE: 3145,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 364, MEDICAL_CREDIT_FIRST_DEP: 364, MEDICAL_CREDIT_ADDITIONAL: 246
        }
    },

    // === TAX TABLE CONFIGURATION (Supabase KV override) ===

    /**
     * Load custom tax tables saved by a super-admin via the Tax Configuration
     * UI in Payroll Items.  Call this once per page AFTER data-access.js / the
     * KV bridge is active (i.e. inside window.addEventListener('load', ...)).
     * Falls back to hardcoded defaults if nothing is stored.
     */
    loadTaxConfig: function() {
        try {
            var raw = typeof safeLocalStorage !== 'undefined'
                ? safeLocalStorage.getItem('tax_config') : null;
            if (!raw) return;
            var cfg = JSON.parse(raw);
            if (cfg.TAX_YEAR)           this.TAX_YEAR           = cfg.TAX_YEAR;
            if (Array.isArray(cfg.BRACKETS) && cfg.BRACKETS.length) {
                // Restore Infinity sentinel (1e99 or null) back to Infinity so bracket
                // comparisons work correctly for all income levels.
                this.BRACKETS = cfg.BRACKETS.map(function(b) {
                    var max = (b.max === null || b.max === undefined || (typeof b.max === 'number' && b.max >= 1e15)) ? Infinity : b.max;
                    return { min: b.min, max: max, base: b.base, rate: b.rate };
                });
            }
            if (typeof cfg.PRIMARY_REBATE   === 'number') this.PRIMARY_REBATE   = cfg.PRIMARY_REBATE;
            if (typeof cfg.SECONDARY_REBATE === 'number') this.SECONDARY_REBATE = cfg.SECONDARY_REBATE;
            if (typeof cfg.TERTIARY_REBATE  === 'number') this.TERTIARY_REBATE  = cfg.TERTIARY_REBATE;
            if (typeof cfg.UIF_RATE         === 'number') this.UIF_RATE         = cfg.UIF_RATE;
            if (typeof cfg.UIF_MONTHLY_CAP  === 'number') this.UIF_MONTHLY_CAP  = cfg.UIF_MONTHLY_CAP;
            if (typeof cfg.SDL_RATE         === 'number') this.SDL_RATE         = cfg.SDL_RATE;
            if (typeof cfg.MEDICAL_CREDIT_MAIN       === 'number') this.MEDICAL_CREDIT_MAIN       = cfg.MEDICAL_CREDIT_MAIN;
            if (typeof cfg.MEDICAL_CREDIT_FIRST_DEP  === 'number') this.MEDICAL_CREDIT_FIRST_DEP  = cfg.MEDICAL_CREDIT_FIRST_DEP;
            if (typeof cfg.MEDICAL_CREDIT_ADDITIONAL === 'number') this.MEDICAL_CREDIT_ADDITIONAL = cfg.MEDICAL_CREDIT_ADDITIONAL;
            console.log('[PayrollEngine] Tax tables loaded from Supabase KV — Tax Year:', this.TAX_YEAR);
        } catch(e) {
            console.warn('[PayrollEngine] Could not load tax config from KV:', e.message);
        }
    },

    /**
     * Save current tax table values to Supabase KV store.
     * Called by the Tax Configuration UI on payroll-items.html.
     */
    saveTaxConfig: function(cfg) {
        if (typeof safeLocalStorage === 'undefined') return;
        safeLocalStorage.setItem('tax_config', JSON.stringify(cfg));
        this.loadTaxConfig(); // apply immediately
    },

    // === UTILITY ===

    r2: function(n) {
        return Math.round(n * 100) / 100;
    },

    /**
     * Calculate total weekly hours from a work schedule array.
     * Each entry: { day, enabled, type: 'normal'|'partial', partial_hours }
     * Normal days use hoursPerDay (default 8). Partial days use partial_hours.
     * Disabled days contribute 0 hours.
     */
    calcWeeklyHours: function(workSchedule, hoursPerDay) {
        if (!workSchedule || !workSchedule.length) return 0;
        var hpd = parseFloat(hoursPerDay) || 8;
        return workSchedule.reduce(function(sum, d) {
            if (!d.enabled) return sum;
            if (d.type === 'partial' && d.partial_hours != null && parseFloat(d.partial_hours) > 0) {
                return sum + parseFloat(d.partial_hours);
            }
            return sum + hpd;
        }, 0);
    },

    /**
     * Calculate hourly rate from monthly salary and work schedule.
     * Formula: monthly_salary ÷ (weekly_hours × 4.33)
     * Falls back to HOURLY_DIVISOR (173.33) when no schedule or zero hours.
     * @param {number} monthlySalary
     * @param {Array} [workSchedule] - Array from employee_work_schedule table
     * @param {number} [hoursPerDay] - Hours for a normal day (default 8)
     * @returns {number} Hourly rate rounded to 2 decimal places
     */
    calcHourlyRate: function(monthlySalary, workSchedule, hoursPerDay) {
        var salary = parseFloat(monthlySalary) || 0;
        if (salary <= 0) return 0;
        var weeklyHours = this.calcWeeklyHours(workSchedule, hoursPerDay);
        if (weeklyHours <= 0) {
            return this.r2(salary / this.HOURLY_DIVISOR);
        }
        return this.r2(salary / (weeklyHours * 4.33));
    },

    /**
     * Calculate age from SA ID number at a given date.
     * SA ID format: YYMMDD followed by 7 digits.
     * Returns age in years, or null if ID is invalid.
     */
    getAgeFromId: function(idNumber, atDate) {
        if (!idNumber || idNumber.length < 6) return null;
        var yy = parseInt(idNumber.substring(0, 2));
        var mm = parseInt(idNumber.substring(2, 4)) - 1;
        var dd = parseInt(idNumber.substring(4, 6));
        if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return null;
        // Dynamic century cutoff: yy > last two digits of current year → 1900s, else 2000s.
        // Avoids the static "> 30" cutoff which misclassifies IDs from 2031 onwards.
        var currentYY = new Date().getFullYear() % 100;
        var year = yy > currentYY ? 1900 + yy : 2000 + yy;
        var dob = new Date(year, mm, dd);
        var ref = atDate || new Date();
        var age = ref.getFullYear() - dob.getFullYear();
        var m = ref.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
        return age;
    },

    /**
     * Return annual tax breakdown for payslip display transparency.
     * Splits the annual tax calculation into bracket tax, age rebate, and net tax.
     * Used internally by calculateFromData to populate additive output fields.
     * @param {number} annualGross - Annual taxable income (post-pre-tax deductions)
     * @param {number} [age]
     * @param {Object} [tables]
     * @returns {{ grossTax: number, rebate: number, netTax: number }}
     */
    _calcAnnualTaxBreakdown: function(annualGross, age, tables) {
        if (annualGross <= 0) return { grossTax: 0, rebate: 0, netTax: 0 };
        var t = tables || this;
        var brackets = t.BRACKETS;
        var grossTax = 0;
        for (var i = 0; i < brackets.length; i++) {
            var b = brackets[i];
            var bMax = (b.max === null || b.max === undefined) ? Infinity : b.max;
            if (annualGross <= bMax) {
                grossTax = b.base + (annualGross - b.min) * b.rate;
                break;
            }
        }
        // Use tables values directly — no fallback to engine defaults.
        var rebate = t.PRIMARY_REBATE;
        if (age && age >= 65) rebate += t.SECONDARY_REBATE;
        if (age && age >= 75) rebate += t.TERTIARY_REBATE;
        var netTax = Math.max(grossTax - rebate, 0);
        return { grossTax: this.r2(grossTax), rebate: rebate, netTax: this.r2(netTax) };
    },

    /**
     * Calculate monthly medical tax credit (Section 6A).
     * @param {number} numMembers - Total medical aid members (employee + dependents)
     * @param {Object} [tables] - Optional period-specific tax tables (from getTablesForPeriod)
     * @returns {number} Monthly medical credit amount
     */
    calculateMedicalCredit: function(numMembers, tables) {
        if (!numMembers || numMembers <= 0) return 0;
        var t = tables || this;
        // Use tables values directly — no fallback to engine defaults.
        if (numMembers === 1) return t.MEDICAL_CREDIT_MAIN;
        if (numMembers === 2) return t.MEDICAL_CREDIT_MAIN + t.MEDICAL_CREDIT_FIRST_DEP;
        return t.MEDICAL_CREDIT_MAIN + t.MEDICAL_CREDIT_FIRST_DEP + (numMembers - 2) * t.MEDICAL_CREDIT_ADDITIONAL;
    },

    // === CORE CALCULATION FUNCTIONS ===

    /**
     * Calculate annual PAYE from annual taxable income.
     * Pure function — uses dynamic brackets so Tax Config overrides and
     * historical tables both take effect automatically.
     * @param {number} annualGross - Annual taxable income
     * @param {number} [age] - Employee age for secondary/tertiary rebates
     * @param {Object} [tables] - Optional period-specific tax tables (from getTablesForPeriod)
     */
    calculateAnnualPAYE: function(annualGross, age, tables) {
        if (annualGross <= 0) return 0;
        var t = tables || this;
        var brackets = t.BRACKETS;
        var tax = 0;
        for (var i = 0; i < brackets.length; i++) {
            var b = brackets[i];
            // Treat null/undefined max as Infinity (safety net for serialization edge-cases)
            var bMax = (b.max === null || b.max === undefined) ? Infinity : b.max;
            if (annualGross <= bMax) {
                tax = b.base + (annualGross - b.min) * b.rate;
                break;
            }
        }
        // Use tables values directly — no fallback to engine defaults.
        // When taxConfig exists, t = taxOverride and ALL values must come from it.
        tax -= t.PRIMARY_REBATE;
        if (age && age >= 65) tax -= t.SECONDARY_REBATE;
        if (age && age >= 75) tax -= t.TERTIARY_REBATE;
        return Math.max(tax, 0);
    },

    /**
     * Calculate monthly PAYE from monthly gross.
     * Supports two call patterns:
     *   New: (periodicMonthlyGross, onceOffGross, options, tables)
     *   Legacy: (monthlyGross, options, tables)
     * Annual income = periodicMonthlyGross × 12 + onceOffGross.
     * @param {number} monthlyGross - Recurring monthly taxable income
     * @param {number|Object} onceOffGrossOrOptions - Once-off taxable income (new) OR options object (legacy)
     * @param {Object} [options] - { age, medicalMembers, taxDirective }
     * @param {Object} [tables] - Optional period-specific tax tables (from getTablesForPeriod)
     */
    calculateMonthlyPAYE: function(monthlyGross, onceOffGrossOrOptions, options, tables) {
        var onceOffGross, opts, tbls;
        if (typeof onceOffGrossOrOptions === 'number') {
            // New call pattern: (periodicMonthlyGross, onceOffGross, options, tables)
            onceOffGross = onceOffGrossOrOptions || 0;
            opts  = options || {};
            tbls  = tables  || this;
        } else {
            // Legacy call pattern: (monthlyGross, options, tables)
            onceOffGross = 0;
            opts  = onceOffGrossOrOptions || {};
            tbls  = options || this;
        }

        // Tax directive override: flat rate on total income
        if (opts.taxDirective && opts.taxDirective > 0) {
            return this.r2((monthlyGross + onceOffGross) * (opts.taxDirective / 100));
        }

        var annualTax = this.calculateAnnualPAYE(monthlyGross * 12 + onceOffGross, opts.age, tbls);
        var monthlyTax = annualTax / 12;

        // Subtract medical tax credits
        if (opts.medicalMembers && opts.medicalMembers > 0) {
            monthlyTax -= this.calculateMedicalCredit(opts.medicalMembers, tbls);
        }

        return this.r2(Math.max(monthlyTax, 0));
    },

    // === YTD (RUN-TO-DATE) PAYE — SARS METHOD ===

    /**
     * Return the month number within the SA tax year (March = 1, Feb = 12).
     * @param {string} period - 'YYYY-MM'
     * @returns {number} 1-12
     */
    getMonthInTaxYear: function(period) {
        var month = parseInt(period.split('-')[1], 10);
        return month >= 3 ? month - 2 : month + 10;
    },

    /**
     * Return all period strings from the start of the SA tax year up to
     * (but NOT including) the given period.
     * E.g. for '2025-05' returns ['2025-03', '2025-04'].
     * @param {string} period - 'YYYY-MM'
     * @returns {string[]}
     */
    getTaxYearPriorPeriods: function(period) {
        var parts = period.split('-');
        var year  = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        // SA tax year starts in March; if month < 3, tax year started March prior year
        var startYear = month >= 3 ? year : year - 1;
        var periods = [];
        var y = startYear, m = 3;
        while (y < year || (y === year && m < month)) {
            periods.push(y + '-' + String(m).padStart(2, '0'));
            m++;
            if (m > 12) { m = 1; y++; }
        }
        return periods;
    },

    /**
     * SARS run-to-date PAYE method (Section 7 of the PAYE Guide).
     * Accumulates periodic taxable income (annualised × 12/month) and adds
     * once-off income once (never annualised) — so bonuses are not projected × 12.
     *
     * @param {number} currentPeriodicGross  - Recurring taxable gross for current month (basic + regular inputs)
     * @param {number} currentOnceOffGross   - Once-off taxable gross for current month (current inputs, overtime)
     * @param {number} ytdPeriodicGross      - Sum of periodic taxable gross for all prior months
     * @param {number} ytdOnceOffGross       - Sum of once-off taxable gross for all prior months
     * @param {number} ytdPAYE              - Sum of PAYE withheld in all prior months
     * @param {number} monthInTaxYear       - Current month number (March=1 … February=12)
     * @param {Object} [options]            - { age, medicalMembers, taxDirective }
     * @param {Object} [tables]             - Period-specific tax tables
     * @returns {number} PAYE for the current month
     */
    calculateMonthlyPAYE_YTD: function(currentPeriodicGross, currentOnceOffGross, ytdPeriodicGross, ytdOnceOffGross, ytdPAYE, monthInTaxYear, options, tables) {
        options = options || {};
        tables  = tables  || this;

        // Tax directive: apply flat rate, no YTD step-up/down
        if (options.taxDirective && options.taxDirective > 0) {
            return this.r2((currentPeriodicGross + currentOnceOffGross) * (options.taxDirective / 100));
        }

        var accumulatedPeriodic = ytdPeriodicGross + currentPeriodicGross;
        var totalOnceOff        = ytdOnceOffGross  + currentOnceOffGross;

        // Periodic income is projected to annual based on elapsed months.
        // Once-off income is added directly — never annualised.
        var annualEquivalent = monthInTaxYear > 0
            ? accumulatedPeriodic * (12 / monthInTaxYear) + totalOnceOff
            : accumulatedPeriodic * 12 + totalOnceOff;

        var annualPAYE   = this.calculateAnnualPAYE(annualEquivalent, options.age, tables);
        var monthlyMed   = options.medicalMembers ? this.calculateMedicalCredit(options.medicalMembers, tables) : 0;

        // Total YTD liability = annualPAYE × elapsed/12, minus all monthly medical credits
        var ytdLiability = (annualPAYE * monthInTaxYear / 12) - (monthlyMed * monthInTaxYear);

        // Current month PAYE = what still needs to be withheld (never negative)
        return this.r2(Math.max(ytdLiability - ytdPAYE, 0));
    },

    /**
     * Calculate monthly UIF contribution (employee portion).
     * 1% of gross, capped at R177.12/month.
     * @param {Object} [tables] - Optional period-specific tax tables
     */
    calculateUIF: function(monthlyGross, tables) {
        var t = tables || this;
        // Use tables values directly — no fallback to engine defaults.
        return this.r2(Math.min(monthlyGross * t.UIF_RATE, t.UIF_MONTHLY_CAP));
    },

    /**
     * Calculate SDL (Skills Development Levy).
     * 1% of gross.
     * @param {Object} [tables] - Optional period-specific tax tables
     */
    calculateSDL: function(monthlyGross, tables) {
        var t = tables || this;
        // Use tables values directly — no fallback to engine defaults.
        return this.r2(monthlyGross * t.SDL_RATE);
    },

    // === PERIOD-AWARE TAX TABLE SELECTION ===

    /**
     * Derive the SA tax year string for a given pay period.
     * SA tax year runs 1 March → last day of February.
     * Examples: '2025-01' → '2024/2025',  '2025-03' → '2025/2026'
     * @param {string} periodStr - 'YYYY-MM' or 'YYYY-MM-DD'
     * @returns {string} e.g. '2024/2025'
     */
    getTaxYearForPeriod: function(periodStr) {
        if (!periodStr) return this.TAX_YEAR;
        var parts = periodStr.split('-');
        var year  = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        if (isNaN(year) || isNaN(month)) return this.TAX_YEAR;
        return month >= 3
            ? year + '/' + (year + 1)
            : (year - 1) + '/' + year;
    },

    /**
     * Return the end date of the SA tax year for a given pay period.
     * SA tax year runs 1 March → last day of February.
     * The end date is 28 or 29 February of the year AFTER the tax year opens.
     * e.g. '2026-04' → tax year 2026/2027 → returns Date(2027, 1, 28)
     * e.g. '2026-02' → tax year 2025/2026 → returns Date(2026, 1, 29) (leap year)
     * Used to calculate employee age at the correct SARS reference point.
     * @param {string} periodStr - 'YYYY-MM'
     * @returns {Date}
     */
    getTaxYearEndDate: function(periodStr) {
        var taxYear = this.getTaxYearForPeriod(periodStr || '');
        var endYear = parseInt(taxYear.split('/')[1], 10);
        var isLeap = (endYear % 4 === 0 && endYear % 100 !== 0) || (endYear % 400 === 0);
        return new Date(endYear, 1, isLeap ? 29 : 28);
    },

    /**
     * Return the correct set of tax tables for a given pay period.
     * Looks up HISTORICAL_TABLES by the SA tax year derived from the period.
     * If the period is in the CURRENT tax year, returns `this` (so that any
     * Tax Config UI override stored in Supabase KV applies automatically).
     * Falls back gracefully to the most recent known table.
     * @param {string} periodStr - 'YYYY-MM'
     * @returns {Object} Tables object with BRACKETS, PRIMARY_REBATE, etc.
     */
    getTablesForPeriod: function(periodStr, taxOverride) {
        // taxOverride (admin-configured KV tables) is the absolute single source of truth.
        // When provided it takes precedence over ALL hardcoded defaults AND historical tables.
        // Rule: "If taxConfig exists — NOTHING ELSE may influence tax calculation."
        if (taxOverride) return taxOverride;
        if (!periodStr) return this;
        var taxYear = this.getTaxYearForPeriod(periodStr);
        if (taxYear === this.TAX_YEAR) return this;
        // Historical year → use hardcoded verified tables
        if (this.HISTORICAL_TABLES[taxYear]) return this.HISTORICAL_TABLES[taxYear];
        // Future or unknown year → use latest known tables as best estimate
        var keys = Object.keys(this.HISTORICAL_TABLES).sort();
        return this.HISTORICAL_TABLES[keys[keys.length - 1]] || this;
    },

    /**
     * Identify which tax bracket applies for a given annual gross.
     * Returns bracket object with min, max, base, rate, and index.
     */
    getTaxBracket: function(annualGross) {
        for (var i = 0; i < this.BRACKETS.length; i++) {
            if (annualGross <= this.BRACKETS[i].max) {
                return { index: i + 1, bracket: this.BRACKETS[i] };
            }
        }
        return { index: 7, bracket: this.BRACKETS[6] };
    },

    // === PAYROLL PERIOD CALCULATOR (Pure - no localStorage) ===

    /**
     * Calculate full payroll for a period from raw data.
     * Pure function - accepts all data as parameters.
     *
     * @param {Object} payrollData - { basic_salary, regular_inputs[], workSchedule?, hours_per_day? }
     *   workSchedule: Array from employee_work_schedule — enables schedule-based hourly rate.
     *   hours_per_day: Override hours for a normal day (default 8). Ignored if not provided.
     * @param {Array} currentInputs - Current period additions/deductions
     * @param {Array} overtime - Overtime entries { hours, rate_multiplier }
     * @param {Array} multiRate - Multi-rate entries { hours, hourly_rate }
     * @param {Array} shortTime - Short time entries { hours_missed }
     * @param {Object} [employeeOptions] - { age, medicalMembers, taxDirective, voluntaryTaxConfig }
     * @param {string} [period] - Pay period 'YYYY-MM' — auto-selects correct tax year tables
     * @param {Object} [ytdData] - YTD totals { ytdTaxableGross, ytdPAYE }; when provided the
     *                             SARS run-to-date method is used for more accurate PAYE.
     * @returns {Object} { gross, taxableGross, paye, paye_base, voluntary_overdeduction, uif, sdl, deductions, net, negativeNetPay, medicalCredit, overtimeAmount, shortTimeAmount }
     */
    calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData, taxOverride) {
        // Select the correct tax tables for the period (auto-applies historical brackets).
        // taxOverride: pre-built tables from backend KV config (Node.js cannot use localStorage).
        var tables = period ? this.getTablesForPeriod(period, taxOverride) : (taxOverride || this);

        // Debug: log which tax source is active for this calculation run.
        console.log('[PayrollEngine] TAX SOURCE:', JSON.stringify({
            source: taxOverride ? 'taxConfig (KV override)' : (period ? 'historical/engine-default' : 'engine-default'),
            TAX_YEAR: tables.TAX_YEAR || this.TAX_YEAR,
            PRIMARY_REBATE: tables.PRIMARY_REBATE,
            SECONDARY_REBATE: tables.SECONDARY_REBATE,
            TERTIARY_REBATE: tables.TERTIARY_REBATE,
            MEDICAL_CREDIT_MAIN: tables.MEDICAL_CREDIT_MAIN,
            UIF_RATE: tables.UIF_RATE,
            UIF_MONTHLY_CAP: tables.UIF_MONTHLY_CAP,
            SDL_RATE: tables.SDL_RATE,
            bracketCount: tables.BRACKETS ? tables.BRACKETS.length : 0
        }));

        // Split taxable income into periodic (annualised × 12) and once-off (added once).
        // This ensures bonuses/overtime are not incorrectly projected × 12 in annual PAYE.
        var periodicTaxable = payrollData.basic_salary || 0;
        var onceOffTaxable  = 0;
        var nonTaxableIncome = 0;

        // Resolve percentage-based regular inputs against the current basic_salary.
        // When called from calculateWithProRata, basic_salary is already pro-rated — so % items
        // automatically receive the correct pro-rated value with no extra handling required.
        var resolvedRegularInputs = (payrollData.regular_inputs || []).map(function(ri) {
            if (ri.is_percentage && ri.percentage_value) {
                return Object.assign({}, ri, { amount: PayrollEngine.r2((ri.percentage_value / 100) * (payrollData.basic_salary || 0)) });
            }
            return ri;
        });

        // Regular inputs → periodic (recurring each month)
        resolvedRegularInputs.forEach(function(ri) {
            if (ri.type !== 'deduction') {
                var amt = parseFloat(ri.amount) || 0;
                if (ri.is_taxable === false) {
                    nonTaxableIncome += amt;
                } else {
                    periodicTaxable += amt;
                }
            }
        });

        // Current period inputs → once-off (this month only, never annualised)
        (currentInputs || []).forEach(function(ci) {
            if (ci.type !== 'deduction') {
                var amt = parseFloat(ci.amount) || 0;
                if (ci.is_taxable === false) {
                    nonTaxableIncome += amt;
                } else {
                    onceOffTaxable += amt;
                }
            }
        });

        // Overtime → once-off (always taxable, calculated independently)
        // Use schedule-based hourly rate when workSchedule is provided; fall back to HOURLY_DIVISOR (173.33)
        var hourlyRate = PayrollEngine.calcHourlyRate(payrollData.basic_salary, payrollData.workSchedule, payrollData.hours_per_day);
        var overtimeAmount = 0;
        (overtime || []).forEach(function(ot) {
            var otAmt = (parseFloat(ot.hours) || 0) * hourlyRate * (parseFloat(ot.rate_multiplier) || 1.5);
            onceOffTaxable += otAmt;
            overtimeAmount += otAmt;
        });

        // Multi-rate hours → once-off (always taxable)
        (multiRate || []).forEach(function(mr) {
            onceOffTaxable += (parseFloat(mr.hours) || 0) * (parseFloat(mr.hourly_rate) || 0);
        });

        // Short time → reduces periodic income (salary reduction, not a once-off)
        var shortTimeAmount = 0;
        (shortTime || []).forEach(function(st) {
            var stAmt = (parseFloat(st.hours_missed) || 0) * hourlyRate;
            periodicTaxable -= stAmt;
            shortTimeAmount += stAmt;
        });

        if (periodicTaxable < 0) periodicTaxable = 0;

        var taxableGross = periodicTaxable + onceOffTaxable;

        // Total gross includes both taxable and non-taxable.
        // Captured BEFORE pre-tax deductions are applied so that UIF/SDL
        // remain based on actual earnings, not the reduced taxable income.
        var gross = taxableGross + nonTaxableIncome;

        // === DEDUCTION TAX TREATMENT (SARS COMPLIANCE — migration 018) ===
        // Split deductions into two categories BEFORE PAYE is calculated:
        //
        //   pre_tax  — qualifying deductions (pension fund, RA, etc.) that
        //              reduce taxable income before PAYE per SARS rules.
        //              These ALSO reduce net pay (they come off the employee's remuneration).
        //
        //   net_only — all other deductions (medical aid employee portion, garnishee, etc.)
        //              that reduce net pay only; PAYE base is unchanged.
        //
        // Backward compatibility: items with no tax_treatment field default to 'net_only'.
        var preTaxDeductions = 0;
        var netOnlyDeductions = 0;
        resolvedRegularInputs.forEach(function(ri) {
            if (ri.type === 'deduction') {
                var amt = parseFloat(ri.amount) || 0;
                if (ri.tax_treatment === 'pre_tax') {
                    preTaxDeductions += amt;
                } else {
                    netOnlyDeductions += amt;
                }
            }
        });
        (currentInputs || []).forEach(function(ci) {
            if (ci.type === 'deduction') {
                var amt = parseFloat(ci.amount) || 0;
                if (ci.tax_treatment === 'pre_tax') {
                    preTaxDeductions += amt;
                } else {
                    netOnlyDeductions += amt;
                }
            }
        });

        // Pre-tax deductions reduce periodic taxable income (pension deducted from salary, not bonus).
        // Never below zero — a pre-tax deduction cannot create a negative tax base.
        periodicTaxable = Math.max(periodicTaxable - preTaxDeductions, 0);
        taxableGross    = periodicTaxable + onceOffTaxable;

        // Total deductions = pre-tax + net-only (BOTH reduce net pay).
        // The existing 'deductions' output field is preserved unchanged for
        // backward compatibility — it continues to represent all employee deductions.
        var deductions = preTaxDeductions + netOnlyDeductions;

        var opts = employeeOptions || {};
        var paye;
        if (ytdData && period) {
            var monthInTaxYear = PayrollEngine.getMonthInTaxYear(period);
            paye = PayrollEngine.calculateMonthlyPAYE_YTD(
                periodicTaxable,
                onceOffTaxable,
                ytdData.ytdPeriodicTaxableGross || ytdData.ytdTaxableGross || 0,
                ytdData.ytdOnceOffTaxableGross  || 0,
                ytdData.ytdPAYE        || 0,
                monthInTaxYear,
                opts,
                tables
            );
        } else {
            paye = PayrollEngine.calculateMonthlyPAYE(periodicTaxable, onceOffTaxable, opts, tables);
        }
        // UIF and SDL are calculated from gross (full earnings) — not the reduced taxable income.
        var uif = PayrollEngine.calculateUIF(gross, tables);
        var sdl = PayrollEngine.calculateSDL(gross, tables);
        // Respect company-level SDL/UIF registration flags.
        // employeeOptions.uif_registered === false  →  company not registered for UIF  →  0
        // employeeOptions.sdl_registered === false  →  company not registered for SDL  →  0
        // undefined / true (default) → levy calculated normally (backward compatible).
        if (employeeOptions && employeeOptions.uif_registered === false) { uif = 0; }
        if (employeeOptions && employeeOptions.sdl_registered === false) { sdl = 0; }
        // Directors are excluded from UIF per the Unemployment Insurance Act.
        // is_director === true overrides even when company is UIF-registered.
        if (employeeOptions && employeeOptions.is_director === true) { uif = 0; }

        // === VOLUNTARY TAX OVER-DEDUCTION ===
        // Three supported scenarios: fixed, variable (current period only), bonus_spread (period range).
        // Config passed in employeeOptions.voluntaryTaxConfig.
        // Supports single config object (legacy) OR multi-config object keyed by type (new format).
        // Multiple types can be active simultaneously — amounts are summed.
        // Only adds to PAYE — never affects UIF or SDL.
        var voluntaryOverDeduction = 0;
        var voluntaryConfigData = employeeOptions && employeeOptions.voluntaryTaxConfig;
        if (voluntaryConfigData) {
            // Normalise to an array of config entries
            var _volConfigs;
            if (Array.isArray(voluntaryConfigData)) {
                // Array format
                _volConfigs = voluntaryConfigData;
            } else if (voluntaryConfigData.type) {
                // Legacy: single config object with a .type property
                _volConfigs = [voluntaryConfigData];
            } else {
                // New multi-config: plain object keyed by type e.g. { fixed: {...}, bonus_spread: {...} }
                _volConfigs = Object.values(voluntaryConfigData);
            }
            for (var _vi = 0; _vi < _volConfigs.length; _vi++) {
                var voluntaryConfig = _volConfigs[_vi];
                if (!voluntaryConfig || !voluntaryConfig.type) continue;
                if (voluntaryConfig.type === 'fixed') {
                    // Scenario 1: Fixed monthly extra tax — applies every period
                    voluntaryOverDeduction += parseFloat(voluntaryConfig.fixed_amount) || 0;
                } else if (voluntaryConfig.type === 'variable') {
                    // Scenario 2: Variable/manual — applies only if config.period matches current period
                    if (voluntaryConfig.period === period) {
                        voluntaryOverDeduction += parseFloat(voluntaryConfig.variable_amount) || 0;
                    }
                } else if (voluntaryConfig.type === 'bonus_spread') {
                    // Scenario 3: Bonus spread — applies for a range of periods (start_period to end_period)
                    var spreadStart = voluntaryConfig.start_period || '';
                    var spreadEnd   = voluntaryConfig.end_period   || '';
                    if (spreadStart && spreadEnd && period >= spreadStart && period <= spreadEnd) {
                        voluntaryOverDeduction += parseFloat(voluntaryConfig.monthly_spread_amount) || 0;
                    }
                }
            }
        }
        voluntaryOverDeduction = Math.max(0, voluntaryOverDeduction);
        // Add voluntary over-deduction to PAYE only (not to UIF/SDL)
        var payeWithVoluntary = paye + voluntaryOverDeduction;
        var net = gross - payeWithVoluntary - uif - deductions;
        var negativeNetPay = net < 0;

        // Tax transparency breakdown — for payslip display (SARS spec: tax_before_rebate, rebate).
        // Computed on the simple-method annual equivalent. When YTD method is active the
        // actual PAYE deducted may differ; these fields are informational display values only.
        var annualEquivalentForDisplay = periodicTaxable * 12 + onceOffTaxable;
        var taxBreakdown = PayrollEngine._calcAnnualTaxBreakdown(annualEquivalentForDisplay, opts.age, tables);
        var monthlyMedCredit = opts.medicalMembers ? PayrollEngine.calculateMedicalCredit(opts.medicalMembers, tables) : 0;

        // === MARGINAL BRACKET LOOKUP (payslip display transparency) ===
        // Uses the same tables object as the PAYE calculation — guaranteed consistent.
        // Computed here so the frontend never needs to import tables or calculate brackets.
        var _dispBrackets = tables.BRACKETS;
        var _marginalRate = '';
        var _marginalBracket = '';
        if (_dispBrackets && _dispBrackets.length > 0) {
            for (var _bi = 0; _bi < _dispBrackets.length; _bi++) {
                var _db = _dispBrackets[_bi];
                var _dbMax = (_db.max === null || _db.max === undefined) ? Infinity : _db.max;
                if (annualEquivalentForDisplay <= _dbMax) {
                    _marginalRate = Math.round(_db.rate * 100) + '%';
                    var _minFmt = _db.min === 0 ? 'R0' : 'R' + _db.min.toLocaleString('en-ZA');
                    if (_dbMax === Infinity) {
                        var _prevMax = _bi > 0 ? _dispBrackets[_bi - 1].max : _db.min;
                        _marginalBracket = 'Above R' + _prevMax.toLocaleString('en-ZA');
                    } else {
                        _marginalBracket = _minFmt + ' - R' + _dbMax.toLocaleString('en-ZA');
                    }
                    break;
                }
            }
        }

        return {
            gross: PayrollEngine.r2(gross),
            taxableGross: PayrollEngine.r2(taxableGross),
            paye: PayrollEngine.r2(payeWithVoluntary),
            paye_base: PayrollEngine.r2(paye),
            voluntary_overdeduction: PayrollEngine.r2(voluntaryOverDeduction),
            uif: uif,
            sdl: sdl,
            deductions: PayrollEngine.r2(deductions),
            net: PayrollEngine.r2(net),
            negativeNetPay: negativeNetPay,
            medicalCredit: monthlyMedCredit,
            // Itemised components for payslip display — both are independent; neither offsets the other
            overtimeAmount: PayrollEngine.r2(overtimeAmount),
            shortTimeAmount: PayrollEngine.r2(shortTimeAmount),
            // === ADDITIVE FIELDS (migration 018 — pre-tax deduction transparency) ===
            // New fields appended after all 13 locked fields. Backward-compatible.
            preTaxDeductions: PayrollEngine.r2(preTaxDeductions),
            netOnlyDeductions: PayrollEngine.r2(netOnlyDeductions),
            // Split gross for YTD snapshot storage — enables correct once-off tax treatment
            periodicTaxableGross: PayrollEngine.r2(periodicTaxable),
            onceOffTaxableGross:  PayrollEngine.r2(onceOffTaxable),
            // === ADDITIVE FIELDS (SARS spec compliance — tax breakdown transparency) ===
            // taxBeforeRebate: monthly bracket tax before age rebates (annual ÷ 12)
            // rebate: monthly sum of applicable age rebates (primary + secondary + tertiary)
            // Breakdown: taxBeforeRebate - rebate - medicalCredit = PAYE (before floor)
            taxBeforeRebate: PayrollEngine.r2(taxBreakdown.grossTax / 12),
            rebate: PayrollEngine.r2(taxBreakdown.rebate / 12),
            // === ADDITIVE FIELDS (payslip explanation transparency) ===
            // These fields allow the frontend to display accurate tax explanation text
            // WITHOUT any frontend tax engine, bracket lookup, or hardcoded defaults.
            // ALL values are derived from the SAME tables object used for this calculation.
            // Rule: frontend is display-only. One engine. One source of truth.
            primary_rebate_annual:   tables.PRIMARY_REBATE,
            secondary_rebate_annual: tables.SECONDARY_REBATE,
            tertiary_rebate_annual:  tables.TERTIARY_REBATE,
            uif_monthly_cap:         tables.UIF_MONTHLY_CAP,
            marginal_rate:           _marginalRate,
            marginal_bracket:        _marginalBracket,
            tax_year:                tables.TAX_YEAR || this.TAX_YEAR
        };
    },

    // === NET-TO-GROSS REVERSE CALCULATION ===

    /**
     * calculateNetToGross — Reverse payroll calculation.
     *
     * Given a desired net pay amount (what lands in the employee's bank), and
     * any known payroll items (fixed allowances / deductions), determines the
     * required basic salary using binary search (bisection) so that after
     * applying all items, PAYE, and UIF the resulting net matches targetNet
     * to within R0.01.
     *
     * The function iterates over trial basic salary values between 0 and
     * basicSalaryHi (default R500,000). Because PAYE is monotonically
     * increasing in basic salary, net is also monotonically increasing, which
     * guarantees bisection converges.
     *
     * @param {Object} params
     * @param {number}  params.targetNet         - Target net pay (amount paid into bank)
     * @param {Array}   params.items             - Known items excluding basic salary.
     *                                             Each: { type, amount, is_taxable }
     *                                             type: 'deduction' | any string (income)
     *                                             is_taxable: true/false (income items only)
     * @param {Object}  [params.employeeOptions] - { age, medicalMembers, taxDirective }
     * @param {string}  [params.period]          - 'YYYY-MM' — selects correct tax year tables
     * @param {Object}  [params.ytdData]         - { ytdTaxableGross, ytdPAYE } for SARS YTD method
     * @param {number}  [params.basicSalaryHi]   - Upper search bound (default 500000)
     *
     * @returns {Object} {
     *   success       {boolean}
     *   basic         {number}  — required basic salary
     *   gross         {number}  — total gross (basic + allowances)
     *   taxableGross  {number}
     *   paye          {number}
     *   uif           {number}
     *   sdl           {number}
     *   deductions    {number}
     *   net           {number}  — actual net (should equal targetNet ± R0.01)
     *   medicalCredit {number}
     *   iterations    {number}
     *   error         {string}  — present when success=false
     *   note          {string}  — present for edge-case successes
     * }
     */
    calculateNetToGross: function(params) {
        var targetNet = typeof params.targetNet    === 'number' ? params.targetNet    : 0;
        var items     = params.items               || [];
        var empOpts   = params.employeeOptions     || {};
        var period    = params.period              || null;
        var ytdData   = params.ytdData             || null;
        var hiLimit   = typeof params.basicSalaryHi === 'number' ? params.basicSalaryHi : 500000;
        var tolerance = 0.01;
        var maxIter   = 100;

        var self = this;

        if (targetNet <= 0) {
            return {
                success: false,
                error: 'Target net must be greater than zero.',
                basic: 0, gross: 0, taxableGross: 0,
                paye: 0, uif: 0, sdl: 0, deductions: 0,
                net: 0, medicalCredit: 0, negativeNetPay: false, iterations: 0
            };
        }

        // Run one trial calculation with a given basic salary
        function trial(trialBasic) {
            return self.calculateFromData(
                { basic_salary: trialBasic, regular_inputs: [] },
                items,
                [], [], [],
                empOpts,
                period,
                ytdData
            );
        }

        var loResult = trial(0);
        var hiResult = trial(hiLimit);

        // Edge case: items alone already meet or exceed the target net
        if (loResult.net >= targetNet - tolerance) {
            return {
                success: true,
                basic: 0,
                gross: loResult.gross,
                taxableGross: loResult.taxableGross,
                paye: loResult.paye,
                uif: loResult.uif,
                sdl: loResult.sdl,
                deductions: loResult.deductions,
                net: loResult.net,
                medicalCredit: loResult.medicalCredit,
                negativeNetPay: loResult.negativeNetPay,
                iterations: 1,
                note: 'A net at R0 basic already meets target (items/allowances alone sufficient)'
            };
        }

        // Edge case: even max salary cannot reach the target net
        if (hiResult.net < targetNet - tolerance) {
            return {
                success: false,
                error: 'Target net cannot be achieved even at maximum basic salary of R' + hiLimit,
                basic: 0, gross: 0, taxableGross: 0,
                paye: 0, uif: 0, sdl: 0, deductions: 0,
                net: 0, medicalCredit: 0, negativeNetPay: false, iterations: 1
            };
        }

        // Binary search (bisection)
        var lo = 0, hi = hiLimit, mid, iterations = 0;
        var resultData = null;

        while ((hi - lo) > tolerance && iterations < maxIter) {
            mid = (lo + hi) / 2;
            resultData = trial(mid);
            if (resultData.net < targetNet) {
                lo = mid;
            } else {
                hi = mid;
            }
            iterations++;
        }

        resultData = trial((lo + hi) / 2);
        return {
            success: true,
            basic: this.r2((lo + hi) / 2),
            gross: resultData.gross,
            taxableGross: resultData.taxableGross,
            paye: resultData.paye,
            uif: resultData.uif,
            sdl: resultData.sdl,
            deductions: resultData.deductions,
            net: resultData.net,
            medicalCredit: resultData.medicalCredit,
            negativeNetPay: resultData.negativeNetPay,
            iterations: iterations
        };
    },

    // === PRO-RATA CALCULATION (HOURS-BASED, SCHEDULE-AWARE) ===
    // IMPORTANT: Pro-rata is HOURS-BASED, respecting the schedule_based payroll model.
    // It factors in the work_schedule array to determine expected scheduled hours.
    //
    // Pro-rata is used when an employee:
    // - Joins mid-month (start_date after 1st of month)
    // - Leaves mid-month (end_date before last day of month)
    // - Works partial hours during a period
    //
    // PRO-RATA FORMULA (HOURS-BASED):
    // factor = workedScheduledHours / expectedScheduledHours
    // Where:
    //   expectedScheduledHours = sum of scheduled hours for all dates in full period
    //   workedScheduledHours = sum of scheduled hours for dates between start_date and end_date
    //
    // This respects partial_hours field in work_schedule and aligns with:
    // - Hourly rate calculation: salary / (weeklyHours × 4.33)
    // - Overtime model: hours × rate × hourly_rate
    // - Short-time model: hours × hourly_rate
    //
    // Then basic_salary_pro_rata = basic_salary * factor

    /**
     * Count scheduled hours between two dates based on a work schedule.
     * HOURS-BASED: Respects partial_hours field for part-time employees.
     * 
     * @param {Date|string} startDate      - First day of period (inclusive)
     * @param {Date|string} endDate        - Last day of period (inclusive)
     * @param {Array} workSchedule         - Work schedule array: [{ day:'MON', enabled:true, type:'normal|partial', partial_hours: 6 }, ...]
     * @param {number} [defaultHoursPerDay] - Default hours for 'normal' type days (default 8)
     * @returns {number} Total scheduled hours in [startDate, endDate]
     */
    countScheduledHours: function(startDate, endDate, workSchedule, defaultHoursPerDay) {
        // No schedule defined — fall back to standard Mon-Fri 8hr workweek so pro-rata
        // still produces a sensible factor for mid-month starters/leavers.
        if (!workSchedule || !workSchedule.length) {
            workSchedule = [
                { day: 'MON', enabled: true, type: 'normal' },
                { day: 'TUE', enabled: true, type: 'normal' },
                { day: 'WED', enabled: true, type: 'normal' },
                { day: 'THU', enabled: true, type: 'normal' },
                { day: 'FRI', enabled: true, type: 'normal' }
            ];
        }
        var start = typeof startDate === 'string' ? new Date(startDate) : startDate;
        var end   = typeof endDate === 'string' ? new Date(endDate)     : endDate;
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;

        var dayMap = { 'SUN': 0, 'MON': 1, 'TUE': 2, 'WED': 3, 'THU': 4, 'FRI': 5, 'SAT': 6 };
        var scheduleHours = {}; // dayOfWeek -> hours for that day
        var hpd = parseFloat(defaultHoursPerDay) || 8;

        // Build map of hours per day of week
        workSchedule.forEach(function(sd) {
            if (sd.enabled) {
                var dayIdx = dayMap[sd.day];
                if (dayIdx != null) {
                    // If partial type with specified hours, use those; otherwise use default
                    if (sd.type === 'partial' && sd.partial_hours != null) {
                        scheduleHours[dayIdx] = parseFloat(sd.partial_hours);
                    } else {
                        scheduleHours[dayIdx] = hpd;
                    }
                }
            }
        });

        var totalHours = 0;
        var current = new Date(start);
        while (current <= end) {
            var dayOfWeek = current.getDay();
            if (scheduleHours[dayOfWeek] != null) {
                totalHours += scheduleHours[dayOfWeek];
            }
            current.setDate(current.getDate() + 1);
        }
        return this.r2(totalHours);
    },

    /**
     * Calculate pro-rata factor for a period (HOURS-BASED).
     * @param {string} startDate            - Employee start date in period (YYYY-MM-DD); null/empty = 1st of month
     * @param {string} endDate              - Employee end date in period (YYYY-MM-DD); null/empty = last day of month
     * @param {string} period               - Pay period (YYYY-MM)
     * @param {Array} workSchedule          - Work schedule array
     * @param {number} [defaultHoursPerDay] - Default hours per day (default 8)
     * @returns {Object} { factor, expectedHours, workedHours }
     */
    calculateProRataFactor: function(startDate, endDate, period, workSchedule, defaultHoursPerDay) {
        if (!period) return { factor: 1, expectedHours: 0, workedHours: 0 };

        // Parse period to get first and last days
        var periodParts = period.split('-');
        var year = parseInt(periodParts[0], 10);
        var month = parseInt(periodParts[1], 10) - 1; // JS months are 0-indexed
        if (isNaN(year) || isNaN(month)) return { factor: 1, expectedHours: 0, workedHours: 0 };

        var periodStart = new Date(year, month, 1);
        var periodEnd = new Date(year, month + 1, 0); // Last day of month

        var actualStart = startDate && startDate.trim()
            ? new Date(startDate)
            : new Date(periodStart);
        var actualEnd = endDate && endDate.trim()
            ? new Date(endDate)
            : new Date(periodEnd);

        // Clamp to period boundaries
        if (actualStart < periodStart) actualStart = new Date(periodStart);
        if (actualEnd > periodEnd) actualEnd = new Date(periodEnd);

        var expectedHours = this.countScheduledHours(periodStart, periodEnd, workSchedule, defaultHoursPerDay);
        var workedHours = this.countScheduledHours(actualStart, actualEnd, workSchedule, defaultHoursPerDay);

        if (expectedHours <= 0) {
            // Edge case: no scheduled hours in period (all non-work days or disabled schedule)
            return { factor: 0, expectedHours: 0, workedHours: 0 };
        }

        var factor = this.r2(workedHours / expectedHours);
        return { factor: factor, expectedHours: expectedHours, workedHours: workedHours };
    },

    /**
     * Calculate payroll WITH pro-rata support (HOURS-BASED).
     * Wrapper around calculateFromData that pre-applies pro-rata factor to basic_salary.
     * Pro-rata is applied ONLY to basic salary; overtime, short-time, allowances, and deductions are NOT pro-rated.
     *
     * @param {Object} payrollData           - Full payroll data including basic_salary, workSchedule, hours_per_day
     * @param {string} [startDate]           - Employee start date (YYYY-MM-DD); null = 1st of month
     * @param {string} [endDate]             - Employee end date (YYYY-MM-DD); null = last day of month
     * @param {Array} currentInputs          - Current period inputs
     * @param {Array} overtime               - Overtime entries (NOT pro-rated)
     * @param {Array} multiRate              - Multi-rate entries (NOT pro-rated)
     * @param {Array} shortTime              - Short-time entries (NOT pro-rated)
     * @param {Object} employeeOptions       - Employee options
     * @param {string} period                - Pay period (YYYY-MM)
     * @param {Object} ytdData               - YTD data (if using SARS method)
     * @returns {Object} Payroll output with prorataFactor, expectedHoursInPeriod, workedHoursInPeriod fields added
     */
    calculateWithProRata: function(payrollData, startDate, endDate, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData, taxOverride) {
        // Calculate pro-rata factor (HOURS-BASED)
        var defaultHrs = payrollData.hours_per_day || 8;
        var prorataInfo = this.calculateProRataFactor(startDate, endDate, period, payrollData.workSchedule, defaultHrs);

        // Apply pro-rata to basic salary ONLY
        var adjustedPayrollData = Object.assign({}, payrollData);
        adjustedPayrollData.basic_salary = (payrollData.basic_salary || 0) * prorataInfo.factor;

        // Calculate with adjusted salary
        // Overtime, short-time, allowances, deductions are NOT pro-rated
        var result = this.calculateFromData(
            adjustedPayrollData,
            currentInputs,
            overtime,
            multiRate,
            shortTime,
            employeeOptions,
            period,
            ytdData,
            taxOverride
        );

        // Add pro-rata fields (ADDITIVE — no removal of existing 13 fields)
        result.prorataFactor = prorataInfo.factor;
        result.expectedHoursInPeriod = prorataInfo.expectedHours;
        result.workedHoursInPeriod = prorataInfo.workedHours;

        return result;
    }
};

// Export for Node.js backends
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PayrollEngine;
}
