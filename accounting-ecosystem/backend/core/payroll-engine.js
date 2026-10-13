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
//   1. Payroll -> Payroll Items -> Tax Configuration (super user, The Infinite Legacy)
//   2. Add the new tax year with the SARS budget figures and tick Confirmed
//   3. Saved to payroll_tax_tables (migration 027); each period uses its own year
//   4. Keep HISTORICAL_TABLES below in step (code defaults for tests). Source: www.sars.gov.za
// ============================================================

/* global safeLocalStorage */ // browser-only KV bridge; every use is guarded by a typeof check

const PayrollEngine = {

    // === ENGINE METADATA ===
    ENGINE_VERSION: '2026-04-12-v1',
    SCHEMA_VERSION: '1.0',

    // === DEFAULT TAX CONSTANTS (SA 2026/2027 = SARS "2027 tax year") ===
    // Production reads payroll_tax_tables (migration 027) per period; these code
    // defaults are only used by tests and before that migration has run.
    // Bracket convention (SARS wording, finding B10 fixed 2026-10-13):
    //   tax = base + rate × (income − min), min = the PREVIOUS bracket's max.
    TAX_YEAR: '2026/2027',

    BRACKETS: [
        { min: 0,       max: 245100,   base: 0,      rate: 0.18 },
        { min: 245100,  max: 383100,   base: 44118,  rate: 0.26 },
        { min: 383100,  max: 530200,   base: 79998,  rate: 0.31 },
        { min: 530200,  max: 695800,   base: 125599, rate: 0.36 },
        { min: 695800,  max: 887000,   base: 185215, rate: 0.39 },
        { min: 887000,  max: 1878600,  base: 259783, rate: 0.41 },
        { min: 1878600, max: Infinity, base: 666339, rate: 0.45 }
    ],

    PRIMARY_REBATE: 17820,
    SECONDARY_REBATE: 9765,     // age >= 65
    TERTIARY_REBATE: 3249,      // age >= 75

    UIF_RATE: 0.01,
    UIF_MONTHLY_CAP: 177.12,
    SDL_RATE: 0.01,
    HOURLY_DIVISOR: 173.33,

    // Medical Tax Credits (Section 6A/6B) — 2027 tax year
    MEDICAL_CREDIT_MAIN: 376,
    MEDICAL_CREDIT_FIRST_DEP: 376,
    MEDICAL_CREDIT_ADDITIONAL: 254,

    // ============================================================
    // HISTORICAL SA TAX TABLES (code defaults, mirror migration 027)
    // Source: www.sars.gov.za, checked 2026-10-12. Key = tax year label
    // (1 March → end February), e.g. '2026/2027' = SARS "2027 tax year".
    // 2022/2023 and 2023/2024 rebates / medical credits corrected 2026-10-13
    // (they were one year behind — finding W2).
    // ============================================================
    HISTORICAL_TABLES: {

        // --- 2021/2022 (SARS 2022 tax year) ---
        '2021/2022': {
            BRACKETS: [
                { min: 0,        max: 216200,   base: 0,       rate: 0.18 },
                { min: 216200,   max: 337800,   base: 38916,   rate: 0.26 },
                { min: 337800,   max: 467500,   base: 70532,   rate: 0.31 },
                { min: 467500,   max: 613600,   base: 110739,  rate: 0.36 },
                { min: 613600,   max: 782200,   base: 163335,  rate: 0.39 },
                { min: 782200,   max: 1656600,  base: 229089,  rate: 0.41 },
                { min: 1656600,  max: Infinity, base: 587593,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 15714, SECONDARY_REBATE: 8613, TERTIARY_REBATE: 2871,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 332, MEDICAL_CREDIT_FIRST_DEP: 332, MEDICAL_CREDIT_ADDITIONAL: 224
        },

        // --- 2022/2023 (SARS 2023 tax year) ---
        '2022/2023': {
            BRACKETS: [
                { min: 0,        max: 226000,   base: 0,       rate: 0.18 },
                { min: 226000,   max: 353100,   base: 40680,   rate: 0.26 },
                { min: 353100,   max: 488700,   base: 73726,   rate: 0.31 },
                { min: 488700,   max: 641400,   base: 115762,  rate: 0.36 },
                { min: 641400,   max: 817600,   base: 170734,  rate: 0.39 },
                { min: 817600,   max: 1731600,  base: 239452,  rate: 0.41 },
                { min: 1731600,  max: Infinity, base: 614192,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 16425, SECONDARY_REBATE: 9000, TERTIARY_REBATE: 2997,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 347, MEDICAL_CREDIT_FIRST_DEP: 347, MEDICAL_CREDIT_ADDITIONAL: 234
        },

        // --- 2023/2024 (SARS 2024 tax year) ---
        '2023/2024': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237100,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370500,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512800,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673000,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857900,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817000,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17235, SECONDARY_REBATE: 9444, TERTIARY_REBATE: 3145,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 364, MEDICAL_CREDIT_FIRST_DEP: 364, MEDICAL_CREDIT_ADDITIONAL: 246
        },

        // --- 2024/2025 (SARS 2025 tax year — unchanged from 2024) ---
        '2024/2025': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237100,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370500,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512800,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673000,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857900,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817000,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17235, SECONDARY_REBATE: 9444, TERTIARY_REBATE: 3145,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 364, MEDICAL_CREDIT_FIRST_DEP: 364, MEDICAL_CREDIT_ADDITIONAL: 246
        },

        // --- 2025/2026 (SARS 2026 tax year — unchanged) ---
        '2025/2026': {
            BRACKETS: [
                { min: 0,        max: 237100,   base: 0,       rate: 0.18 },
                { min: 237100,   max: 370500,   base: 42678,   rate: 0.26 },
                { min: 370500,   max: 512800,   base: 77362,   rate: 0.31 },
                { min: 512800,   max: 673000,   base: 121475,  rate: 0.36 },
                { min: 673000,   max: 857900,   base: 179147,  rate: 0.39 },
                { min: 857900,   max: 1817000,  base: 251258,  rate: 0.41 },
                { min: 1817000,  max: Infinity, base: 644489,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17235, SECONDARY_REBATE: 9444, TERTIARY_REBATE: 3145,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 364, MEDICAL_CREDIT_FIRST_DEP: 364, MEDICAL_CREDIT_ADDITIONAL: 246
        },

        // --- 2026/2027 (SARS 2027 tax year) ---
        '2026/2027': {
            BRACKETS: [
                { min: 0,        max: 245100,   base: 0,       rate: 0.18 },
                { min: 245100,   max: 383100,   base: 44118,   rate: 0.26 },
                { min: 383100,   max: 530200,   base: 79998,   rate: 0.31 },
                { min: 530200,   max: 695800,   base: 125599,  rate: 0.36 },
                { min: 695800,   max: 887000,   base: 185215,  rate: 0.39 },
                { min: 887000,   max: 1878600,  base: 259783,  rate: 0.41 },
                { min: 1878600,  max: Infinity, base: 666339,  rate: 0.45 }
            ],
            PRIMARY_REBATE: 17820, SECONDARY_REBATE: 9765, TERTIARY_REBATE: 3249,
            UIF_RATE: 0.01, UIF_MONTHLY_CAP: 177.12, SDL_RATE: 0.01,
            MEDICAL_CREDIT_MAIN: 376, MEDICAL_CREDIT_FIRST_DEP: 376, MEDICAL_CREDIT_ADDITIONAL: 254
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

        // Periodic income is annualized and divided by 12 as normal. Once-off income
        // (bonus/current input) is NEVER divided by 12 — its full incremental annual
        // tax is collected in this same period, matching calculateMonthlyPAYE_YTD's
        // treatment (fixed 2026-09-03) so behaviour is identical whether or not YTD
        // history exists yet (e.g. a bonus paid in the employee's very first period).
        var annualTaxPeriodicOnly = this.calculateAnnualPAYE(monthlyGross * 12, opts.age, tbls);
        var annualTaxWithOnceOff  = this.calculateAnnualPAYE(monthlyGross * 12 + onceOffGross, opts.age, tbls);
        var onceOffTax = Math.max(annualTaxWithOnceOff - annualTaxPeriodicOnly, 0);
        var monthlyTax = (annualTaxPeriodicOnly / 12) + onceOffTax;

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

        // Periodic income is projected to annual based on elapsed months and run
        // through the standard SARS run-to-date smoothing method below.
        //
        // Once-off income (bonuses, current inputs, overtime) must NEVER be smoothed
        // across months — SARS requires the full incremental tax caused by an
        // irregular/once-off amount to be withheld in the period it is actually paid.
        // (Fixed 2026-09-03: previously the once-off amount was folded into the same
        // annualEquivalent that then got multiplied by monthInTaxYear/12, which meant
        // only a fraction of a bonus's tax was collected in the month it was paid, with
        // the remainder silently smeared into later months. Mirrors the identical fix
        // applied the same day to frontend-payroll/js/payroll-engine.js — these two
        // files are a duplicated, manually-synced pair; see follow-up note to unify them.)
        var annualPeriodicEquivalent = monthInTaxYear > 0
            ? accumulatedPeriodic * (12 / monthInTaxYear)
            : accumulatedPeriodic * 12;

        var monthlyMed = options.medicalMembers ? this.calculateMedicalCredit(options.medicalMembers, tables) : 0;

        // Periodic component: smoothed run-to-date exactly as before, but computed on
        // periodic income ALONE (no once-off baked in), so the monthInTaxYear/12
        // fraction never touches once-off tax.
        var annualPeriodicPAYE = this.calculateAnnualPAYE(annualPeriodicEquivalent, options.age, tables);
        var ytdPeriodicLiability = (annualPeriodicPAYE * monthInTaxYear / 12) - (monthlyMed * monthInTaxYear);

        // Once-off component: the FULL incremental annual tax caused by all once-off
        // income received so far this tax year (prior periods' once-off amounts were
        // already collected in full when they were paid, under this same formula, so
        // subtracting ytdPAYE below correctly isolates just today's new increment).
        var annualPAYEWithOnceOff = this.calculateAnnualPAYE(annualPeriodicEquivalent + totalOnceOff, options.age, tables);
        var cumulativeOnceOffTax = Math.max(annualPAYEWithOnceOff - annualPeriodicPAYE, 0);

        var totalLiabilityToDate = ytdPeriodicLiability + cumulativeOnceOffTax;

        // Current month PAYE = what still needs to be withheld (never negative)
        return this.r2(Math.max(totalLiabilityToDate - ytdPAYE, 0));
    },

    /**
     * Calculate monthly UIF contribution (employee portion).
     * 1% of gross, capped at R177.12/month.
     * @param {Object} [tables] - Optional period-specific tax tables
     */
    calculateUIF: function(monthlyGross, tables) {
        var t = tables || this;
        // Guard: if UIF_RATE is missing, empty-string, or 0 (e.g. admin tax config saved
        // with a blank field), fall back to the engine's statutory default (1%).
        // monthlyGross * '' = 0 and monthlyGross * undefined = NaN — both produce wrong results.
        var rate = (t.UIF_RATE && !isNaN(Number(t.UIF_RATE))) ? Number(t.UIF_RATE) : this.UIF_RATE;
        var cap  = (t.UIF_MONTHLY_CAP != null && t.UIF_MONTHLY_CAP !== '' && !isNaN(Number(t.UIF_MONTHLY_CAP)))
            ? Number(t.UIF_MONTHLY_CAP) : this.UIF_MONTHLY_CAP;
        return this.r2(Math.min(monthlyGross * rate, cap));
    },

    /**
     * Calculate SDL (Skills Development Levy).
     * 1% of gross.
     * @param {Object} [tables] - Optional period-specific tax tables
     */
    calculateSDL: function(monthlyGross, tables) {
        var t = tables || this;
        // Same guard as calculateUIF — fall back to engine default if SDL_RATE is invalid.
        var rate = (t.SDL_RATE && !isNaN(Number(t.SDL_RATE))) ? Number(t.SDL_RATE) : this.SDL_RATE;
        return this.r2(monthlyGross * rate);
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
     * An override (taxOverride) is used only when it belongs to the period's own tax year.
     * Falls back gracefully to the most recent known table.
     * @param {string} periodStr - 'YYYY-MM'
     * @returns {Object} Tables object with BRACKETS, PRIMARY_REBATE, etc.
     */
    getTablesForPeriod: function(periodStr, taxOverride) {
        // taxOverride = the tables the backend loaded for this period (payroll_tax_tables,
        // migration 027 — already per tax year) or, on the legacy path, the KV tax_config.
        // Spec 02 / finding W3 (Fase 1): an override only applies to ITS OWN tax year.
        // A legacy KV config labelled 2026/2027 must not tax a 2025/2026 period — that
        // period uses its historical table. An override without a TAX_YEAR label is
        // trusted as-is (old callers).
        var taxYear = periodStr ? this.getTaxYearForPeriod(periodStr) : null;
        if (taxOverride && (!taxYear || !taxOverride.TAX_YEAR || taxOverride.TAX_YEAR === taxYear)) return taxOverride;
        if (!periodStr) return this;
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
     * @returns {Object} { gross, taxableGross, paye, paye_base, voluntary_paye_adjustment, voluntary_overdeduction, uif, sdl, deductions, net, negativeNetPay, medicalCredit, overtimeAmount, shortTimeAmount }
     */
    calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData, taxOverride) {
        // Select the correct tax tables for the period (auto-applies historical brackets).
        // taxOverride: pre-built tables from backend KV config (Node.js cannot use localStorage).
        var tables = period ? this.getTablesForPeriod(period, taxOverride) : (taxOverride || this);

        // Split taxable income into periodic (annualised × 12) and once-off (added once).
        // This ensures bonuses/overtime are not incorrectly projected × 12 in annual PAYE.
        var periodicTaxable = payrollData.basic_salary || 0;
        var onceOffTaxable  = 0;
        var nonTaxableIncome = 0;
        // uifApplicableGross: built positively from items where affects_uif !== false.
        // Basic salary is always UIF-applicable. Overtime and short-time are handled below.
        // This whitelist approach is independent of PAYE bucket routing and gross subtraction.
        var uifApplicableGross = payrollData.basic_salary || 0;

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
                // taxable_percentage: what fraction of amt is taxable/UIF-applicable
                // when the item isn't fully excluded (e.g. a fixed travel allowance
                // is typically 80% taxable, not 0% or 100%). null/undefined → 100
                // (safe default — identical to pre-existing behaviour for every
                // item that has never set this field). Only takes effect when the
                // item is otherwise taxable/UIF-applicable — is_taxable/affects_uif
                // remain the master on/off switch, unaffected by this percentage.
                var pct = (ri.taxable_percentage === null || ri.taxable_percentage === undefined)
                    ? 100 : parseFloat(ri.taxable_percentage);
                var taxablePortion    = PayrollEngine.r2(amt * (pct / 100));
                var nonTaxablePortion = PayrollEngine.r2(amt - taxablePortion);

                // UIF: include only items where affects_uif !== false (whitelist).
                // null/undefined → UIF-applicable (safe default). Only explicit false excludes.
                // Uses the same taxablePortion as PAYE — SARS applies the identical
                // percentage split to UIF remuneration as to PAYE taxable income.
                if (ri.affects_uif !== false) { uifApplicableGross += taxablePortion; }
                if (ri.is_taxable === false) {
                    nonTaxableIncome += amt;
                } else {
                    periodicTaxable  += taxablePortion;
                    nonTaxableIncome += nonTaxablePortion;
                }
            }
        });

        // Current period inputs: routing controlled by paye_projection_type.
        // FIXED_RECURRING / VARIABLE_AVERAGE → periodicTaxable.
        //   Both are projected via YTD averaging (× 12 / monthInTaxYear) so commission
        //   entered as a current input correctly builds an annualised PAYE projection.
        // ONCE_OFF (or no type — default changed 2026-09-03) → onceOffTaxable.
        //   Added once to the annual equivalent, never projected. A current input is by
        //   definition a one-time entry for this period (recurring items belong under
        //   Regular Inputs instead), so unclassified defaults to ONCE_OFF, not
        //   VARIABLE_AVERAGE — matching PayrollDataService.normalizeCalculationInput's
        //   same default change. Confirmed with Ruan.
        // UIF basis is independent of PAYE bucket — controlled only by affects_uif.
        (currentInputs || []).forEach(function(ci) {
            if (ci.type !== 'deduction') {
                var amt = parseFloat(ci.amount) || 0;
                // taxable_percentage: same fractional-inclusion rule as regular
                // inputs above (see that loop's comment) — applied before the
                // once-off/periodic routing decision below.
                var pct = (ci.taxable_percentage === null || ci.taxable_percentage === undefined)
                    ? 100 : parseFloat(ci.taxable_percentage);
                var taxablePortion    = PayrollEngine.r2(amt * (pct / 100));
                var nonTaxablePortion = PayrollEngine.r2(amt - taxablePortion);

                // UIF: include only if affects_uif !== false (whitelist — same rule as regular inputs).
                if (ci.affects_uif !== false) { uifApplicableGross += taxablePortion; }
                if (ci.is_taxable === false) {
                    nonTaxableIncome += amt;
                } else {
                    nonTaxableIncome += nonTaxablePortion;
                    var projType = ci.paye_projection_type || 'ONCE_OFF';
                    if (projType === 'ONCE_OFF') {
                        onceOffTaxable += taxablePortion;
                    } else {
                        periodicTaxable += taxablePortion;
                    }
                }
            }
        });

        // Overtime → once-off (always taxable, calculated independently)
        // Use schedule-based hourly rate when workSchedule is provided; fall back to HOURLY_DIVISOR (173.33)
        // In a pro-rata month the hourly rate still comes from the FULL monthly salary
        // (owner decision 2026-10-13, Fase 5): overtime is paid, and a missed hour (short time)
        // deducted, at the normal rate — never at a reduced rate. hourly_basis_salary is set by
        // calculateWithProRata; otherwise basic_salary is the full salary.
        var hourlyRate = PayrollEngine.calcHourlyRate(
            payrollData.hourly_basis_salary != null ? payrollData.hourly_basis_salary : payrollData.basic_salary,
            payrollData.workSchedule, payrollData.hours_per_day);
        var overtimeAmount = 0;
        (overtime || []).forEach(function(ot) {
            var otAmt = (parseFloat(ot.hours) || 0) * hourlyRate * (parseFloat(ot.rate_multiplier) || 1.5);
            onceOffTaxable += otAmt;
            overtimeAmount += otAmt;
        });
        // Overtime is always UIF-applicable.
        uifApplicableGross += overtimeAmount;

        // Multi-rate hours → once-off (always taxable, always UIF-applicable)
        var multiRateAmount = 0;
        (multiRate || []).forEach(function(mr) {
            var mrAmt = (parseFloat(mr.hours) || 0) * (parseFloat(mr.hourly_rate) || 0);
            onceOffTaxable    += mrAmt;
            multiRateAmount   += mrAmt;
        });
        uifApplicableGross += multiRateAmount;

        // Short time → reduces periodic income (salary reduction, not a once-off)
        var shortTimeAmount = 0;
        (shortTime || []).forEach(function(st) {
            var stAmt = (parseFloat(st.hours_missed) || 0) * hourlyRate;
            periodicTaxable -= stAmt;
            shortTimeAmount += stAmt;
        });
        // Short time reduces the UIF basis (it reduces the remuneration that UIF is levied on).
        uifApplicableGross = Math.max(uifApplicableGross - shortTimeAmount, 0);

        if (periodicTaxable < 0) periodicTaxable = 0;

        var taxableGross = periodicTaxable + onceOffTaxable;

        // Total gross includes both taxable and non-taxable.
        // Captured BEFORE pre-tax deductions are applied so that SDL remain based on actual earnings.
        var gross = taxableGross + nonTaxableIncome;

        // SDL leviable amount = remuneration, i.e. the TAXABLE earnings before pre-tax
        // deductions: non-taxable reimbursements and the non-taxable part of a partly
        // taxable item (e.g. the 20% of a travel allowance) are excluded (spec 04 IT-15,
        // Fase 2). Captured here, before pension/RA reduce the PAYE base.
        var sdlLeviableGross = taxableGross;

        // uifApplicableGross is built from the whitelist above — do NOT re-derive from gross.
        // uifExcludedEarnings is derived for trace/return transparency only.
        var uifExcludedEarnings = PayrollEngine.r2(Math.max(gross - uifApplicableGross, 0));

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
        var _ytdCalc = null;
        if (ytdData && period) {
            var monthInTaxYear = PayrollEngine.getMonthInTaxYear(period);

            // Helper: look up the marginal bracket for a given annual income using the active tables.
            // Returns { rate: '36%', bracket: 'R488,701 - R641,400' } or empty strings if no match.
            // Used to show the bracket based on the YTD projected annual rather than gross × 12.
            var _ytdGetBracket = function(annualIncome) {
                var _br = tables.BRACKETS;
                if (!_br || !_br.length) return { rate: '', bracket: '' };
                for (var _i = 0; _i < _br.length; _i++) {
                    var _b = _br[_i];
                    var _bMax = (_b.max === null || _b.max === undefined) ? Infinity : _b.max;
                    if (annualIncome <= _bMax) {
                        var _rate = Math.round(_b.rate * 100) + '%';
                        var _minFmt = _b.min === 0 ? 'R0' : 'R' + _b.min.toLocaleString('en-ZA');
                        var _bkt = _bMax === Infinity
                            ? ('Above R' + (_i > 0 ? _br[_i - 1].max : _b.min).toLocaleString('en-ZA'))
                            : (_minFmt + ' - R' + _bMax.toLocaleString('en-ZA'));
                        return { rate: _rate, bracket: _bkt };
                    }
                }
                return { rate: '', bracket: '' };
            };

            // Resolve prior taxable gross and prior PAYE from whichever ytdData shape is present.
            // New shape (average_taxable_ytd): prior_taxable_gross, prior_paye_paid
            // Old shape (cumulative_ytd):      ytdPeriodicTaxableGross + ytdOnceOffTaxableGross, ytdPAYE
            var _ytdCurrentTaxable = periodicTaxable + onceOffTaxable;
            var _ytdPriorTaxable   = ytdData.prior_taxable_gross !== undefined
                ? ytdData.prior_taxable_gross
                : ((ytdData.ytdPeriodicTaxableGross || 0) + (ytdData.ytdOnceOffTaxableGross || 0));
            var _ytdPriorPAYE      = ytdData.prior_paye_paid !== undefined
                ? ytdData.prior_paye_paid
                : (ytdData.ytdPAYE || 0);

            // Per-item projection type method:
            // Each income stream is classified as FIXED_RECURRING, VARIABLE_AVERAGE, or ONCE_OFF
            // and projected differently. Activated when ytdData.method === 'projection_type_ytd'
            // (set by PAYE_YTD_METHOD=projection_type in PayrollDataService).
            if (ytdData.method === 'projection_type_ytd') {
                var _remainingMonths = 13 - monthInTaxYear; // includes current month

                // Classify current month income.
                // Basic salary → FIXED. Overtime → VARIABLE. Period inputs → ONCE_OFF.
                // Regular recurring items use their paye_projection_type field (default VARIABLE_AVERAGE).
                var _ptFixed    = 0;
                var _ptVariable = 0;
                var _ptOnceOff  = 0;

                // Basic salary: FIXED. Apply short-time and pre-tax deductions to the fixed base
                // (pension/RA reduces salary, not variable items — this is the correct apportionment).
                var _basicAfterAdj = Math.max((payrollData.basic_salary || 0) - shortTimeAmount - preTaxDeductions, 0);
                _ptFixed += _basicAfterAdj;

                // Classify taxable regular inputs by paye_projection_type
                resolvedRegularInputs.forEach(function(ri) {
                    if (ri.type === 'deduction' || ri.is_taxable === false) return;
                    var amt = parseFloat(ri.amount) || 0;
                    var projType = ri.paye_projection_type || 'VARIABLE_AVERAGE';
                    if      (projType === 'FIXED_RECURRING') { _ptFixed    += amt; }
                    else if (projType === 'ONCE_OFF')        { _ptOnceOff  += amt; }
                    else                                      { _ptVariable += amt; }
                });

                // Overtime: always VARIABLE
                _ptVariable += overtimeAmount;

                // Current period inputs: classify by paye_projection_type.
                // After the engine routing fix, FIXED_RECURRING and VARIABLE_AVERAGE current inputs
                // are in periodicTaxable (not onceOffTaxable), so they must be classified here.
                // ONCE_OFF current inputs remain in onceOffTaxable and are captured below.
                // Default must match the routing default above (ONCE_OFF, not VARIABLE_AVERAGE) —
                // otherwise an unclassified item would be excluded from periodicTaxable up there
                // but still counted here, double-counting it (once via _ptOnceOff, again via
                // _variableAvgMonthly's ×12 projection).
                (currentInputs || []).forEach(function(ci) {
                    if (ci.type === 'deduction' || ci.is_taxable === false) return;
                    var amt = parseFloat(ci.amount) || 0;
                    var projType = ci.paye_projection_type || 'ONCE_OFF';
                    if      (projType === 'FIXED_RECURRING') { _ptFixed    += amt; }
                    else if (projType !== 'ONCE_OFF')        { _ptVariable += amt; }
                    // ONCE_OFF falls through to the onceOffTaxable accumulator below
                });

                // Multi-rate and ONCE_OFF current inputs remain in onceOffTaxable (minus overtime).
                _ptOnceOff += Math.max(onceOffTaxable - overtimeAmount, 0);

                // Variable accumulation — use prior_once_off_taxable_gross as proxy for prior
                // variable income (overtime + period inputs stored there in snapshots).
                // NOTE: snapshot schema doesn't store a fixed/variable split for recurring items;
                // this is the best available approximation without a schema change.
                var _priorVariableProxy = ytdData.prior_once_off_taxable_gross || 0;
                var _variableToDate     = _priorVariableProxy + _ptVariable;
                var _variableAvgMonthly = monthInTaxYear > 0 ? _variableToDate / monthInTaxYear : _ptVariable;

                // FIXED + VARIABLE income is genuinely recurring/ongoing, so its tax is
                // correctly smoothed evenly across the remaining months of the tax year.
                //
                // ONCE_OFF income (bonuses, one-off current inputs) must NEVER be smoothed
                // — SARS requires the full incremental tax it causes to be withheld in the
                // period it is actually paid. (Fixed 2026-09-03: previously _ptOnceOff was
                // folded into the same _projAnnual that then had its ENTIRE resulting tax
                // divided by _remainingMonths — meaning even a correctly-classified ONCE_OFF
                // item had its tax spread over every remaining month of the year, not just
                // caught up faster. This mirrors the identical principle already fixed the
                // same day in calculateMonthlyPAYE_YTD/calculateMonthlyPAYE for the simpler
                // average_taxable_ytd method — see that fix's commit for the full writeup.)
                var _monthlyMed = opts.medicalMembers ? PayrollEngine.calculateMedicalCredit(opts.medicalMembers, tables) : 0;
                var _priorTotalPAYEPaid = ytdData.prior_total_paye_paid !== undefined
                    ? ytdData.prior_total_paye_paid : _ytdPriorPAYE;

                // Smoothed component: FIXED + VARIABLE only, no once-off baked in.
                var _projAnnualNoOnceOff = PayrollEngine.r2(
                    _ytdPriorTaxable              // prior periods: all actual taxable (already happened)
                  + (_ptFixed * _remainingMonths) // project current fixed for remaining months (incl. current)
                  + (_variableAvgMonthly * 12)    // full-year variable estimate (YTD average × 12)
                );
                var _annualPAYENoOnceOff      = PayrollEngine.calculateAnnualPAYE(_projAnnualNoOnceOff, opts.age, tables);
                var _annualTaxNetMedNoOnceOff = PayrollEngine.r2(_annualPAYENoOnceOff - (_monthlyMed * 12));
                var _remainingTaxNoOnceOff    = PayrollEngine.r2(Math.max(_annualTaxNetMedNoOnceOff - _priorTotalPAYEPaid, 0));
                var _smoothedPAYE             = PayrollEngine.r2(_remainingTaxNoOnceOff / _remainingMonths);

                // Once-off component: the FULL incremental tax caused by this month's
                // once-off income, collected entirely now (never divided by remainingMonths).
                var _projAnnual      = PayrollEngine.r2(_projAnnualNoOnceOff + _ptOnceOff);
                var _annualPAYE      = PayrollEngine.calculateAnnualPAYE(_projAnnual, opts.age, tables);
                var _annualTaxNetMed = PayrollEngine.r2(_annualPAYE - (_monthlyMed * 12));
                var _onceOffPAYE     = PayrollEngine.r2(Math.max(_annualTaxNetMed - _annualTaxNetMedNoOnceOff, 0));

                var _remainingTax = PayrollEngine.r2(_remainingTaxNoOnceOff + _onceOffPAYE);
                paye = PayrollEngine.r2(_smoothedPAYE + _onceOffPAYE);
                var _ptBracket = _ytdGetBracket(_projAnnual);
                _ytdCalc = {
                    method:                    'projection_type_ytd',
                    currentMonthNumber:        monthInTaxYear,
                    remainingMonths:           _remainingMonths,
                    smoothedPAYE:              _smoothedPAYE,
                    onceOffPAYE:               _onceOffPAYE,
                    priorTaxableGross:         PayrollEngine.r2(_ytdPriorTaxable),
                    currentTaxableGross:       PayrollEngine.r2(periodicTaxable + onceOffTaxable),
                    taxableGrossToDate:        PayrollEngine.r2(_ytdPriorTaxable + periodicTaxable + onceOffTaxable),
                    currentFixedTaxable:       PayrollEngine.r2(_ptFixed),
                    currentVariableTaxable:    PayrollEngine.r2(_ptVariable),
                    currentOnceOffTaxable:     PayrollEngine.r2(_ptOnceOff),
                    priorVariableProxy:        PayrollEngine.r2(_priorVariableProxy),
                    variableTaxableToDate:     PayrollEngine.r2(_variableToDate),
                    variableAvgMonthly:        PayrollEngine.r2(_variableAvgMonthly),
                    projectedAnnualTaxable:    _projAnnual,
                    annualPAYE:                PayrollEngine.r2(_annualPAYE),
                    monthlyMedCredit:          _monthlyMed,
                    annualTaxNetMedCredit:     _annualTaxNetMed,
                    priorTotalPAYEPaid:        PayrollEngine.r2(_priorTotalPAYEPaid),
                    remainingTax:              _remainingTax,
                    priorPAYEPaid:             PayrollEngine.r2(_ytdPriorPAYE),
                    currentBasePAYE:           paye,
                    projectionMarginalRate:    _ptBracket.rate,
                    projectionMarginalBracket: _ptBracket.bracket
                };

            // Average taxable method (default when ytdData.method !== 'cumulative_ytd'):
            // All taxable income to date is averaged over elapsed months and projected to annual.
            // This prevents a single high-salary month from dominating the annual projection.
            } else if (ytdData.method !== 'cumulative_ytd') {
                var _totalTaxable  = _ytdPriorTaxable + _ytdCurrentTaxable;
                var _avgMonthly    = monthInTaxYear > 0 ? _totalTaxable / monthInTaxYear : _ytdCurrentTaxable;
                var _projAnnual    = _avgMonthly * 12;
                var _annualPAYE    = PayrollEngine.calculateAnnualPAYE(_projAnnual, opts.age, tables);
                var _monthlyMed    = opts.medicalMembers ? PayrollEngine.calculateMedicalCredit(opts.medicalMembers, tables) : 0;
                var _cumTaxDue     = (_annualPAYE * monthInTaxYear / 12) - (_monthlyMed * monthInTaxYear);
                paye = PayrollEngine.r2(Math.max(_cumTaxDue - _ytdPriorPAYE, 0));
                var _avgBracket = _ytdGetBracket(_projAnnual);
                _ytdCalc = {
                    method:                    'average_taxable_ytd',
                    currentMonthNumber:        monthInTaxYear,
                    priorTaxableGross:         PayrollEngine.r2(_ytdPriorTaxable),
                    currentTaxableGross:       PayrollEngine.r2(_ytdCurrentTaxable),
                    taxableGrossToDate:        PayrollEngine.r2(_totalTaxable),
                    averageMonthlyTaxable:     PayrollEngine.r2(_avgMonthly),
                    projectedAnnualTaxable:    PayrollEngine.r2(_projAnnual),
                    annualPAYE:                PayrollEngine.r2(_annualPAYE),
                    monthlyMedCredit:          _monthlyMed,
                    cumulativeTaxDueToDate:    PayrollEngine.r2(_cumTaxDue),
                    priorPAYEPaid:             PayrollEngine.r2(_ytdPriorPAYE),
                    currentBasePAYE:           paye,
                    projectionMarginalRate:    _avgBracket.rate,
                    projectionMarginalBracket: _avgBracket.bracket
                };
            } else {
                // Cumulative projection fallback — active when ytdData.method = 'cumulative_ytd'
                // (set by PAYE_YTD_METHOD=cumulative env var in PayrollDataService).
                // Periodic income is projected × 12/months; once-off is added as lump sum.
                var _ytdPeriodic = ytdData.prior_periodic_taxable_gross !== undefined
                    ? ytdData.prior_periodic_taxable_gross : _ytdPriorTaxable;
                var _ytdOnceOff  = ytdData.prior_once_off_taxable_gross !== undefined
                    ? ytdData.prior_once_off_taxable_gross : 0;
                // Annualise over the months this employee actually has payroll data for in
                // this tax year (locked snapshots incl. imported months, + this month), not the
                // calendar month number. With complete history the two are equal; for a
                // mid-year starter (or a company that joined Paytime mid-year) the calendar
                // number made PAYE collapse to R0 in months 2–3 (finding K2, Fase 3a,
                // docs/paytime/FASE3_CHANGE_IMPACT_NOTE.md). Capped at the calendar month number.
                var _periodsWorked = (typeof ytdData.prior_periods_count === 'number' && ytdData.prior_periods_count >= 0)
                    ? Math.min(ytdData.prior_periods_count + 1, monthInTaxYear)
                    : monthInTaxYear;
                paye = PayrollEngine.calculateMonthlyPAYE_YTD(
                    periodicTaxable, onceOffTaxable,
                    _ytdPeriodic, _ytdOnceOff, _ytdPriorPAYE,
                    _periodsWorked, opts, tables
                );
                _ytdCalc = { method: 'cumulative_ytd', currentMonthNumber: monthInTaxYear, periodsWorked: _periodsWorked };
            }
        } else {
            paye = PayrollEngine.calculateMonthlyPAYE(periodicTaxable, onceOffTaxable, opts, tables);
        }
        // UIF is calculated from uifApplicableGross — built positively from UIF-applicable items.
        // SDL is calculated from the leviable (taxable) remuneration — see sdlLeviableGross.
        var uif = PayrollEngine.calculateUIF(uifApplicableGross, tables);
        var sdl = PayrollEngine.calculateSDL(sdlLeviableGross, tables);

        // Respect company-level SDL/UIF registration flags.
        // employeeOptions.uif_registered === false  →  company not registered for UIF  →  0
        // employeeOptions.sdl_registered === false  →  company not registered for SDL  →  0
        // undefined / true (default) → levy calculated normally (backward compatible).
        if (employeeOptions && employeeOptions.uif_registered === false) { uif = 0; }
        if (employeeOptions && employeeOptions.sdl_registered === false) { sdl = 0; }
        // Directors DO pay UIF (owner decision 2026-10-12, spec 03 WN-06) — the director flag
        // no longer zeroes UIF. An individual exemption is set per employee instead (below).
        // Employee-level UIF exemption (employee_payroll_setup.uif_exempt, spec 03 WN-07).
        if (employeeOptions && employeeOptions.uif_exempt === true) { uif = 0; }
        // Contractors: PAYE on the tax tables only — no UIF, no SDL (spec 03 WN-08).
        if (employeeOptions && employeeOptions.is_contractor === true) { uif = 0; sdl = 0; }

        // Employer UIF contribution — under the Unemployment Insurance Contributions
        // Act the employer matches the employee's 1% (same base, same monthly cap),
        // so it is always equal to `uif` once all registration/director/exemption
        // overrides above have already zeroed it out where applicable.
        var uif_employer = uif;

        // === VOLUNTARY PAYE ADJUSTMENT ===
        // Owner-confirmed rules: docs/paytime/spec/06_BEREKENINGSENJIN.md §E (2026-10-12, Fase 4).
        //   - PAYE is never reduced below statutory. 'variable' entries and direction 'reduce'
        //     are INACTIVE: kept in the config, shown as inactive, never applied (VPA-06/20).
        //   - fixed / target_paye: optional start_period / end_period (VPA-02).
        //   - target_paye: only ever ADDS (target − statutory); a target below statutory is
        //     ignored and reported as a warning (VPA-04).
        //   - bonus_spread linked to its bonus month (bonus_period): instalments before the
        //     bonus month are credited against the bonus tax in that month; any part planned
        //     after the bonus month is deferred and collected later, never more than owed
        //     (VPA-13..17). Unlinked legacy entries keep the old behaviour plus a warning.
        // The statutory figure (paye_base) is never changed here, so YTD stays consistent.
        var voluntaryPayeAdjustment = 0;
        var voluntaryBreakdown = [];
        var voluntaryWarnings = [];
        var voluntaryConfigData = employeeOptions && employeeOptions.voluntaryTaxConfig;
        if (voluntaryConfigData) {
            // Normalise to an array of config entries
            var _volConfigs;
            if (Array.isArray(voluntaryConfigData)) {
                _volConfigs = voluntaryConfigData;
            } else if (voluntaryConfigData.type) {
                // Legacy: single config object with a .type property
                _volConfigs = [voluntaryConfigData];
            } else {
                // Multi-config: plain object keyed by type
                _volConfigs = Object.values(voluntaryConfigData);
            }
            var _priorVol     = (ytdData && ytdData.prior_voluntary_by_entry) || {};
            var _unattributed = (ytdData && ytdData.prior_voluntary_unattributed) || 0;
            var _activeVol    = _volConfigs.filter(function(c) {
                return c && c.type && c.type !== 'variable' && c.direction !== 'reduce';
            });

            // Statutory PAYE for this month WITHOUT this month's once-off income — the bonus
            // tax is (paye − this). Same dispatch as above for the methods in use.
            var _payeExclOnceOff = function() {
                if (onceOffTaxable <= 0) return paye;
                if (ytdData && period && ytdData.method === 'cumulative_ytd') {
                    return PayrollEngine.calculateMonthlyPAYE_YTD(periodicTaxable, 0,
                        _ytdPeriodic, _ytdOnceOff, _ytdPriorPAYE, _periodsWorked, opts, tables);
                }
                var _withO    = PayrollEngine.calculateMonthlyPAYE(periodicTaxable, onceOffTaxable, opts, tables);
                var _withoutO = PayrollEngine.calculateMonthlyPAYE(periodicTaxable, 0, opts, tables);
                return paye - (_withO - _withoutO);
            };
            // Months in (afterPeriod, endPeriod], i.e. spread months planned after the bonus month.
            var _monthsAfter = function(afterPeriod, endPeriod) {
                if (!endPeriod || endPeriod <= afterPeriod) return 0;
                var a = afterPeriod.split('-').map(Number), e = endPeriod.split('-').map(Number);
                return (e[0] - a[0]) * 12 + (e[1] - a[1]);
            };

            for (var _vi = 0; _vi < _volConfigs.length; _vi++) {
                var voluntaryConfig = _volConfigs[_vi];
                if (!voluntaryConfig || !voluntaryConfig.type) continue;
                var _vid  = String(voluntaryConfig.id || voluntaryConfig.type);
                var _item = { id: _vid, type: voluntaryConfig.type,
                              description: voluntaryConfig.description || voluntaryConfig.reference || '' };
                var _amt  = 0;

                if (voluntaryConfig.type === 'variable' || voluntaryConfig.direction === 'reduce') {
                    _item.inactive = true;            // VPA-06/20 — never applied
                } else if (voluntaryConfig.type === 'fixed' || voluntaryConfig.type === 'target_paye') {
                    var _inRange = (!voluntaryConfig.start_period || period >= voluntaryConfig.start_period) &&
                                   (!voluntaryConfig.end_period   || period <= voluntaryConfig.end_period);
                    if (_inRange && voluntaryConfig.type === 'fixed') {
                        _amt = Math.max(parseFloat(voluntaryConfig.fixed_amount) || 0, 0);
                    } else if (_inRange) {
                        var _targetPaye = parseFloat(voluntaryConfig.target_paye);
                        if (!isNaN(_targetPaye) && _targetPaye >= 0) {
                            if (_targetPaye < paye) {
                                voluntaryWarnings.push({ code: 'TARGET_BELOW_STATUTORY', id: _vid,
                                    target: PayrollEngine.r2(_targetPaye), statutory: PayrollEngine.r2(paye) });
                            } else {
                                _amt = _targetPaye - paye;
                            }
                        }
                    }
                } else if (voluntaryConfig.type === 'bonus_spread') {
                    var _sStart = voluntaryConfig.start_period || '';
                    var _sEnd   = voluntaryConfig.end_period   || '';
                    var _monthly = Math.max(parseFloat(voluntaryConfig.monthly_spread_amount) || 0, 0);
                    var _inst   = (_sStart && _sEnd && period >= _sStart && period <= _sEnd) ? _monthly : 0;
                    var _bp     = voluntaryConfig.bonus_period || '';
                    var _pv     = _priorVol[_vid] || null;
                    if (!_bp) {
                        _item.phase = 'unlinked';
                        _amt = _inst;
                        if (_inst > 0) voluntaryWarnings.push({ code: 'BONUS_SPREAD_NOT_LINKED', id: _vid });
                    } else if (period < _bp) {
                        _item.phase = 'prepay';
                        _amt = _inst;
                    } else if (period === _bp) {
                        // Prepaid = this entry's instalments in locked months. Snapshots from before
                        // per-entry tracking only carry a total: attribute it when this is the
                        // employee's only active voluntary entry.
                        var _prepaid = _pv ? (_pv.prepay || 0)
                                           : (_activeVol.length === 1 ? _unattributed : 0);
                        var _bonusTax     = Math.max(paye - _payeExclOnceOff(), 0);
                        var _futurePlan   = _monthly * _monthsAfter(_bp, _sEnd);
                        var _dueNow       = Math.max(_bonusTax - _prepaid - _futurePlan, 0);
                        var _deferred     = Math.max(Math.min(_futurePlan, _bonusTax - _prepaid), 0);
                        _amt = _dueNow - _bonusTax;   // ≤ 0: prepaid credited, later part deferred
                        _item.phase     = 'bonus';
                        _item.bonus_tax = PayrollEngine.r2(_bonusTax);
                        _item.prepaid   = PayrollEngine.r2(_prepaid);
                        _item.deferred  = PayrollEngine.r2(_deferred);
                        if (_deferred > 0) {
                            voluntaryWarnings.push({ code: 'BONUS_SPREAD_DEFERRED', id: _vid,
                                deferred: PayrollEngine.r2(_deferred) });
                        }
                    } else {
                        // After the bonus month: collect only what was deferred, never more.
                        var _owed = Math.max(((_pv && _pv.deferred) || 0) - ((_pv && _pv.post) || 0), 0);
                        _item.phase = 'post';
                        _amt = Math.min(_inst, _owed);
                    }
                }
                _item.amount = PayrollEngine.r2(_amt);
                voluntaryBreakdown.push(_item);
                voluntaryPayeAdjustment += _amt;
            }
        }
        // Final PAYE is floored at zero; the raw adjustment may be negative for reductions
        var payeWithVoluntary = Math.max(paye + voluntaryPayeAdjustment, 0);
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

        var _result = {
            gross: PayrollEngine.r2(gross),
            taxableGross: PayrollEngine.r2(taxableGross),
            paye: PayrollEngine.r2(payeWithVoluntary),
            paye_base: PayrollEngine.r2(paye),
            // voluntary_paye_adjustment: signed total (negative = reduction, positive = increase)
            voluntary_paye_adjustment: PayrollEngine.r2(voluntaryPayeAdjustment),
            // voluntary_overdeduction: backward-compat alias — positive-only for legacy display code
            voluntary_overdeduction: PayrollEngine.r2(Math.max(voluntaryPayeAdjustment, 0)),
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
            // UIF transparency fields — allow payslip and audit to show the correct UIF base.
            uifApplicableGross:   PayrollEngine.r2(uifApplicableGross),
            uifExcludedEarnings:  PayrollEngine.r2(uifExcludedEarnings),
            // === ADDITIVE FIELD (company contributions payslip display) ===
            // Employer-side UIF match — see comment at calculation site above.
            uif_employer: PayrollEngine.r2(uif_employer),
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
            tax_year:                tables.TAX_YEAR || this.TAX_YEAR,
            // Exemption flags — included so the frontend can detect intentional UIF = 0
            // and avoid incorrectly recomputing UIF from display gross for exempt employees.
            is_director:  !!(employeeOptions && employeeOptions.is_director),
            // NOTE (Fase 2): is_director no longer means UIF = 0 — directors pay UIF (spec 03 WN-06).
            // Contractors (no UIF/SDL) are flagged in is_contractor at the end of this object.
            uif_exempt:   !!(employeeOptions && employeeOptions.uif_exempt),
            // YTD calculation intermediates — populated when YTD method is active, null otherwise.
            // Consumed by PayrollCalculationService to populate _meta transparency fields.
            // Never null-checked downstream — callers must guard on this field being null.
            _ytdCalc:     _ytdCalc,
            // === ADDITIVE FIELDS (Fase 4 — voluntary PAYE per entry, spec 06 §E) ===
            // One item per configured entry: { id, type, description, amount, inactive?,
            // phase?, bonus_tax?, prepaid?, deferred? }. Stored in the snapshot so payslips
            // show each line separately (VPA-07/09) and later months can track bonus spreads.
            voluntary_breakdown: voluntaryBreakdown,
            // [{ code, id, ... }] — TARGET_BELOW_STATUTORY, BONUS_SPREAD_NOT_LINKED, BONUS_SPREAD_DEFERRED
            voluntary_warnings:  voluntaryWarnings,
            // === ADDITIVE FIELDS (Fase 2) ===
            is_contractor:       !!(employeeOptions && employeeOptions.is_contractor),
            sdlLeviableGross:    PayrollEngine.r2(sdlLeviableGross),
            // === ADDITIVE FIELDS (Fase 6 — payslip lines frozen in the snapshot, spec 08 PS-02/03) ===
            // Every line the payslip prints, with the exact amounts used above. Stored in
            // calculation_output, so a finalized payslip is reprinted from these lines —
            // never from the employee's current items.
            payslip_lines: PayrollEngine.buildPayslipLines({
                basicSalary:    payrollData.basic_salary || 0,
                regularInputs:  resolvedRegularInputs,
                currentInputs:  currentInputs || [],
                overtime:       overtime || [],
                multiRate:      multiRate || [],
                shortTime:      shortTime || [],
                hourlyRate:     hourlyRate,
                payeBase:       paye,
                voluntary:      voluntaryBreakdown,
                payeTotal:      payeWithVoluntary,
                uif:            uif,
                uifEmployer:    uif_employer,
                sdl:            sdl
            }),
            // { earnings, deductions, net, gross_diff, deductions_diff, net_diff, ok }
            payslip_check: null
        };
        _result.payslip_check = PayrollEngine.checkPayslipLines(_result.payslip_lines, _result);
        return _result;
    },

    /**
     * Payslip lines for one calculation (Fase 6, spec 08 PS-02). Pure.
     * Sections: 'earning' (incl. short time as a negative line), 'deduction'
     * (employee deductions), 'tax' (PAYE, voluntary PAYE, UIF), 'employer' (UIF, SDL).
     * Amounts are rounded to cents. Also used to rebuild lines for snapshots made
     * before Fase 6 from their frozen calculation_input.
     */
    buildPayslipLines: function(c) {
        var r2 = PayrollEngine.r2;
        var lines = [];
        var desc = function(x, fallback) { return (x && (x.description || x.name)) || fallback; };
        if (c.basicSalary) lines.push({ section: 'earning', kind: 'basic', description: 'Basic Salary', amount: r2(c.basicSalary) });
        (c.regularInputs || []).forEach(function(ri) {
            var a = r2(parseFloat(ri.amount) || 0);
            if (!a) return;
            lines.push({ section: ri.type === 'deduction' ? 'deduction' : 'earning', kind: 'regular',
                description: desc(ri, ri.type === 'deduction' ? 'Deduction' : 'Allowance'), amount: a,
                pre_tax: ri.type === 'deduction' && ri.tax_treatment === 'pre_tax' ? true : undefined,
                taxable_percentage: ri.type !== 'deduction' && ri.taxable_percentage != null && Number(ri.taxable_percentage) !== 100
                    ? Number(ri.taxable_percentage) : undefined });
        });
        (c.currentInputs || []).forEach(function(ci) {
            var a = r2(parseFloat(ci.amount) || 0);
            if (!a) return;
            lines.push({ section: ci.type === 'deduction' ? 'deduction' : 'earning', kind: 'current',
                description: desc(ci, ci.type === 'deduction' ? 'Deduction' : 'Earning'), amount: a,
                pre_tax: ci.type === 'deduction' && ci.tax_treatment === 'pre_tax' ? true : undefined });
        });
        (c.overtime || []).forEach(function(ot) {
            var h = parseFloat(ot.hours) || 0, m = parseFloat(ot.rate_multiplier) || 1.5;
            if (!h) return;
            lines.push({ section: 'earning', kind: 'overtime',
                description: desc(ot, m === 1.5 ? 'Overtime' : m === 2 ? 'Double Time' : 'Overtime ×' + m),
                hours: h, rate: r2(c.hourlyRate * m), multiplier: m, amount: r2(h * c.hourlyRate * m) });
        });
        (c.multiRate || []).forEach(function(mr) {
            var h = parseFloat(mr.hours) || 0, rate = parseFloat(mr.hourly_rate) || 0;
            if (!h) return;
            lines.push({ section: 'earning', kind: 'multi_rate', description: desc(mr, 'Paid at Different Rate'),
                hours: h, rate: r2(rate), amount: r2(h * rate) });
        });
        (c.shortTime || []).forEach(function(st) {
            var h = parseFloat(st.hours_missed) || 0;
            if (!h) return;
            lines.push({ section: 'earning', kind: 'short_time', description: desc(st, 'Short Time'),
                hours: h, rate: r2(c.hourlyRate), amount: -r2(h * c.hourlyRate) });
        });
        lines.push({ section: 'tax', kind: 'paye', description: 'PAYE', amount: r2(c.payeBase || 0) });
        var volSum = 0;
        (c.voluntary || []).forEach(function(v) {
            if (v.inactive || !v.amount) return;
            volSum += v.amount;
            lines.push({ section: 'tax', kind: 'voluntary', id: v.id, type: v.type,
                description: 'Voluntary PAYE' + (v.description ? ' — ' + v.description : ''), amount: r2(v.amount) });
        });
        // PAYE is floored at zero after voluntary credits; show the floor so the lines add up.
        var floorAdj = r2((c.payeTotal || 0) - ((c.payeBase || 0) + volSum));
        if (Math.abs(floorAdj) >= 0.01) lines.push({ section: 'tax', kind: 'paye_floor', description: 'PAYE cannot be negative', amount: floorAdj });
        if (c.uif) lines.push({ section: 'tax', kind: 'uif', description: 'UIF', amount: r2(c.uif) });
        if (c.uifEmployer) lines.push({ section: 'employer', kind: 'uif_employer', description: 'UIF (employer)', amount: r2(c.uifEmployer) });
        if (c.sdl) lines.push({ section: 'employer', kind: 'sdl', description: 'SDL', amount: r2(c.sdl) });
        return lines;
    },

    /**
     * PS-03: do the lines add up to the totals on the same payslip? Pure.
     * @returns {{ earnings, deductions, net, gross_diff, deductions_diff, net_diff, ok }}
     */
    checkPayslipLines: function(lines, totals) {
        var r2 = PayrollEngine.r2, e = 0, d = 0;
        (lines || []).forEach(function(l) {
            if (l.section === 'earning') e += l.amount;
            else if (l.section === 'deduction' || l.section === 'tax') d += l.amount;
        });
        e = r2(e); d = r2(d);
        var totDed = r2((totals.paye || 0) + (totals.uif || 0) + (totals.deductions || 0));
        var res = {
            earnings: e, deductions: d, net: r2(e - d),
            gross_diff: r2(e - (totals.gross || 0)),
            deductions_diff: r2(d - totDed),
            net_diff: r2((e - d) - (totals.net || 0))
        };
        res.ok = Math.abs(res.gross_diff) < 0.015 && Math.abs(res.deductions_diff) < 0.015 && Math.abs(res.net_diff) < 0.015;
        return res;
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

        // Spec 06 ENJ-20 (Fase 5, finding B8): NOT rounded — only rand amounts are rounded
        // to cents. Rounding the factor to 2 decimals cost up to ~R150 on a R30 000 salary.
        var factor = workedHours / expectedHours;
        return { factor: factor, expectedHours: expectedHours, workedHours: workedHours };
    },

    /**
     * Calculate payroll WITH pro-rata support (HOURS-BASED).
     * Wrapper around calculateFromData that pre-applies pro-rata factor to basic_salary.
     * Pro-rata is applied to basic salary and fixed (regular) allowances (ENJ-21); once-off inputs,
     * overtime, multi-rate, short-time and deductions are NOT pro-rated.
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

        // Spec 06 ENJ-21 (BEVESTIG 2026-10-12, Fase 5): basic salary AND fixed (regular)
        // allowances are pro-rated. Percentage items follow the pro-rated basic salary.
        // Current (once-off) inputs, overtime, multi-rate, short time and deductions are NOT.
        var factor = prorataInfo.factor;
        var adjustedPayrollData = Object.assign({}, payrollData);
        adjustedPayrollData.basic_salary = PayrollEngine.r2((payrollData.basic_salary || 0) * factor);
        adjustedPayrollData.hourly_basis_salary = payrollData.basic_salary || 0;   // overtime / short time at the normal rate
        adjustedPayrollData.regular_inputs = (payrollData.regular_inputs || []).map(function(ri) {
            if (ri.type === 'deduction' || ri.is_percentage) return ri;
            return Object.assign({}, ri, { amount: PayrollEngine.r2((parseFloat(ri.amount) || 0) * factor) });
        });

        // Calculate with adjusted salary and allowances
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
