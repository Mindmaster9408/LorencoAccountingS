// ============================================================
// PayrollEngine - Shared Payroll Calculation Module
// South African PAYE Tax Calculation
// ============================================================
// TAX TABLE UPDATE GUIDE (every 1 March):
//   1. Go to Payroll → Payroll Items → Tax Configuration (super-admin)
//   2. Enter new brackets/rebates from the SARS budget announcement
//   3. Save — tables are stored in Supabase and override these defaults
//   4. If you need to update code defaults, edit BRACKETS/REBATES below
//      and update DEFAULT_TAX_YEAR.  Source: www.sars.gov.za
// ============================================================

const PayrollEngine = {

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
            if (Array.isArray(cfg.BRACKETS) && cfg.BRACKETS.length)
                                        this.BRACKETS           = cfg.BRACKETS;
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
        var year = yy > 30 ? 1900 + yy : 2000 + yy;
        var dob = new Date(year, mm, dd);
        var ref = atDate || new Date();
        var age = ref.getFullYear() - dob.getFullYear();
        var m = ref.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
        return age;
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
        var main       = typeof t.MEDICAL_CREDIT_MAIN       === 'number' ? t.MEDICAL_CREDIT_MAIN       : this.MEDICAL_CREDIT_MAIN;
        var firstDep   = typeof t.MEDICAL_CREDIT_FIRST_DEP  === 'number' ? t.MEDICAL_CREDIT_FIRST_DEP  : this.MEDICAL_CREDIT_FIRST_DEP;
        var additional = typeof t.MEDICAL_CREDIT_ADDITIONAL === 'number' ? t.MEDICAL_CREDIT_ADDITIONAL : this.MEDICAL_CREDIT_ADDITIONAL;
        if (numMembers === 1) return main;
        if (numMembers === 2) return main + firstDep;
        return main + firstDep + (numMembers - 2) * additional;
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
        var brackets = (t.BRACKETS && t.BRACKETS.length) ? t.BRACKETS : this.BRACKETS;
        var tax = 0;
        for (var i = 0; i < brackets.length; i++) {
            var b = brackets[i];
            if (annualGross <= b.max) {
                tax = b.base + (annualGross - b.min) * b.rate;
                break;
            }
        }
        tax -= (typeof t.PRIMARY_REBATE   === 'number' ? t.PRIMARY_REBATE   : this.PRIMARY_REBATE);
        if (age && age >= 65) tax -= (typeof t.SECONDARY_REBATE === 'number' ? t.SECONDARY_REBATE : this.SECONDARY_REBATE);
        if (age && age >= 75) tax -= (typeof t.TERTIARY_REBATE  === 'number' ? t.TERTIARY_REBATE  : this.TERTIARY_REBATE);
        return Math.max(tax, 0);
    },

    /**
     * Calculate monthly PAYE from monthly gross.
     * Annualizes, calculates annual tax, divides by 12.
     * @param {number} monthlyGross
     * @param {Object} [options] - { age, medicalMembers, taxDirective }
     * @param {Object} [tables] - Optional period-specific tax tables (from getTablesForPeriod)
     */
    calculateMonthlyPAYE: function(monthlyGross, options, tables) {
        options = options || {};
        tables = tables || this;

        // Tax directive override: flat rate
        if (options.taxDirective && options.taxDirective > 0) {
            return this.r2(monthlyGross * (options.taxDirective / 100));
        }

        var annualTax = this.calculateAnnualPAYE(monthlyGross * 12, options.age, tables);
        var monthlyTax = annualTax / 12;

        // Subtract medical tax credits
        if (options.medicalMembers && options.medicalMembers > 0) {
            monthlyTax -= this.calculateMedicalCredit(options.medicalMembers, tables);
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
     * Read prior-period finalized payslip snapshots from safeLocalStorage and
     * return the year-to-date totals needed for the YTD PAYE calculation.
     * @param {string} companyId
     * @param {string} empId
     * @param {string} period - 'YYYY-MM' (current period, NOT included)
     * @returns {{ ytdTaxableGross: number, ytdPAYE: number }}
     */
    getYTDData: function(companyId, empId, period) {
        var priorPeriods = this.getTaxYearPriorPeriods(period);
        var ytdTaxableGross = 0;
        var ytdPAYE = 0;
        priorPeriods.forEach(function(p) {
            var stored = safeLocalStorage.getItem('emp_historical_' + companyId + '_' + empId + '_' + p);
            if (stored) {
                try {
                    var rec = JSON.parse(stored);
                    // Use taxableGross if present (finalized records after this fix);
                    // fall back to gross for pre-fix records (conservative – slightly
                    // over-estimates, but self-corrects at year end via run-to-date method)
                    ytdTaxableGross += typeof rec.taxableGross === 'number' ? rec.taxableGross : (rec.gross || 0);
                    ytdPAYE += rec.paye || 0;
                } catch(e) { /* ignore corrupt records */ }
            }
        });
        return { ytdTaxableGross: ytdTaxableGross, ytdPAYE: ytdPAYE };
    },

    /**
     * SARS run-to-date PAYE method (Section 7 of the PAYE Guide).
     * Accumulates taxable income for elapsed months, projects to annual,
     * determines the YTD tax liability, then subtracts PAYE already withheld.
     * This corrects over/under-withheld PAYE caused by variable income so that
     * by February the total PAYE withheld exactly equals the annual liability.
     *
     * @param {number} currentTaxableGross  - Taxable gross for the current month
     * @param {number} ytdTaxableGross      - Sum of taxable gross for all prior months in the tax year
     * @param {number} ytdPAYE              - Sum of PAYE withheld in all prior months
     * @param {number} monthInTaxYear       - Current month number (March=1 … February=12)
     * @param {Object} [options]            - { age, medicalMembers, taxDirective }
     * @param {Object} [tables]             - Period-specific tax tables
     * @returns {number} PAYE for the current month
     */
    calculateMonthlyPAYE_YTD: function(currentTaxableGross, ytdTaxableGross, ytdPAYE, monthInTaxYear, options, tables) {
        options = options || {};
        tables  = tables  || this;

        // Tax directive: apply flat rate, no YTD step-up/down
        if (options.taxDirective && options.taxDirective > 0) {
            return this.r2(currentTaxableGross * (options.taxDirective / 100));
        }

        var accumulatedTaxable = ytdTaxableGross + currentTaxableGross;
        // Project to annual income based on elapsed months
        var annualEquivalent = monthInTaxYear > 0
            ? accumulatedTaxable * (12 / monthInTaxYear)
            : accumulatedTaxable * 12;

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
        var rate = typeof t.UIF_RATE        === 'number' ? t.UIF_RATE        : this.UIF_RATE;
        var cap  = typeof t.UIF_MONTHLY_CAP === 'number' ? t.UIF_MONTHLY_CAP : this.UIF_MONTHLY_CAP;
        return this.r2(Math.min(monthlyGross * rate, cap));
    },

    /**
     * Calculate SDL (Skills Development Levy).
     * 1% of gross.
     * @param {Object} [tables] - Optional period-specific tax tables
     */
    calculateSDL: function(monthlyGross, tables) {
        var t = tables || this;
        var rate = typeof t.SDL_RATE === 'number' ? t.SDL_RATE : this.SDL_RATE;
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
     * Return the correct set of tax tables for a given pay period.
     * Looks up HISTORICAL_TABLES by the SA tax year derived from the period.
     * If the period is in the CURRENT tax year, returns `this` (so that any
     * Tax Config UI override stored in Supabase KV applies automatically).
     * Falls back gracefully to the most recent known table.
     * @param {string} periodStr - 'YYYY-MM'
     * @returns {Object} Tables object with BRACKETS, PRIMARY_REBATE, etc.
     */
    getTablesForPeriod: function(periodStr) {
        if (!periodStr) return this;
        var taxYear = this.getTaxYearForPeriod(periodStr);
        // Current year → use `this` (may be overridden by loadTaxConfig KV data)
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
     * @param {Object} payrollData - { basic_salary, regular_inputs[] }
     * @param {Array} currentInputs - Current period additions/deductions
     * @param {Array} overtime - Overtime entries { hours, rate_multiplier }
     * @param {Array} multiRate - Multi-rate entries { hours, hourly_rate }
     * @param {Array} shortTime - Short time entries { hours_missed }
     * @param {Object} [employeeOptions] - { age, medicalMembers, taxDirective }
     * @param {string} [period] - Pay period 'YYYY-MM' — auto-selects correct tax year tables
     * @param {Object} [ytdData] - YTD totals { ytdTaxableGross, ytdPAYE }; when provided the
     *                             SARS run-to-date method is used for more accurate PAYE.
     * @returns {Object} { gross, taxableGross, paye, uif, sdl, deductions, net, negativeNetPay, medicalCredit }
     */
    calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData) {
        // Select the correct tax tables for the period (auto-applies historical brackets)
        var tables = period ? this.getTablesForPeriod(period) : this;
        var taxableGross = payrollData.basic_salary || 0;
        var nonTaxableIncome = 0;

        // Regular allowances (non-deduction regular_inputs add to gross)
        (payrollData.regular_inputs || []).forEach(function(ri) {
            if (ri.type !== 'deduction') {
                var amt = parseFloat(ri.amount) || 0;
                if (ri.is_taxable === false) {
                    nonTaxableIncome += amt;
                } else {
                    taxableGross += amt;
                }
            }
        });

        // Current period inputs (non-deduction add to gross)
        (currentInputs || []).forEach(function(ci) {
            if (ci.type !== 'deduction') {
                var amt = parseFloat(ci.amount) || 0;
                if (ci.is_taxable === false) {
                    nonTaxableIncome += amt;
                } else {
                    taxableGross += amt;
                }
            }
        });

        // Overtime (always taxable — calculated independently, never offset against short time)
        var hourlyRate = payrollData.basic_salary ? payrollData.basic_salary / PayrollEngine.HOURLY_DIVISOR : 0;
        var overtimeAmount = 0;
        (overtime || []).forEach(function(ot) {
            var otAmt = (parseFloat(ot.hours) || 0) * hourlyRate * (parseFloat(ot.rate_multiplier) || 1.5);
            taxableGross += otAmt;
            overtimeAmount += otAmt;
        });

        // Multi-rate hours (always taxable)
        (multiRate || []).forEach(function(mr) {
            taxableGross += (parseFloat(mr.hours) || 0) * (parseFloat(mr.hourly_rate) || 0);
        });

        // Short time (earnings reduction — calculated independently, never offset against overtime)
        // hours_missed × hourly_rate at 1.0x (straight deduction — no multiplier penalty)
        var shortTimeAmount = 0;
        (shortTime || []).forEach(function(st) {
            var stAmt = (parseFloat(st.hours_missed) || 0) * hourlyRate;
            taxableGross -= stAmt;
            shortTimeAmount += stAmt;
        });

        if (taxableGross < 0) taxableGross = 0;

        // Total gross includes both taxable and non-taxable
        var gross = taxableGross + nonTaxableIncome;

        var opts = employeeOptions || {};
        var paye;
        if (ytdData && period) {
            var monthInTaxYear = PayrollEngine.getMonthInTaxYear(period);
            paye = PayrollEngine.calculateMonthlyPAYE_YTD(
                taxableGross,
                ytdData.ytdTaxableGross || 0,
                ytdData.ytdPAYE        || 0,
                monthInTaxYear,
                opts,
                tables
            );
        } else {
            paye = PayrollEngine.calculateMonthlyPAYE(taxableGross, opts, tables);
        }
        var uif = PayrollEngine.calculateUIF(gross, tables);
        var sdl = PayrollEngine.calculateSDL(gross, tables);

        // Other deductions (deduction-type regular_inputs and current inputs)
        var deductions = 0;
        (payrollData.regular_inputs || []).forEach(function(ri) {
            if (ri.type === 'deduction') deductions += parseFloat(ri.amount) || 0;
        });
        (currentInputs || []).forEach(function(ci) {
            if (ci.type === 'deduction') deductions += parseFloat(ci.amount) || 0;
        });

        var net = gross - paye - uif - deductions;
        var negativeNetPay = net < 0;

        return {
            gross: PayrollEngine.r2(gross),
            taxableGross: PayrollEngine.r2(taxableGross),
            paye: paye,
            uif: uif,
            sdl: sdl,
            deductions: PayrollEngine.r2(deductions),
            net: PayrollEngine.r2(net),
            negativeNetPay: negativeNetPay,
            medicalCredit: opts.medicalMembers ? PayrollEngine.calculateMedicalCredit(opts.medicalMembers) : 0,
            // Itemised components for payslip display — both are independent; neither offsets the other
            overtimeAmount: PayrollEngine.r2(overtimeAmount),
            shortTimeAmount: PayrollEngine.r2(shortTimeAmount)
        };
    },

    // === LOCALSTORAGE-COUPLED WRAPPER ===

    /**
     * Calculate employee payroll for a period, reading data from safeLocalStorage.
     * Convenience wrapper around calculateFromData.
     *
     * @param {string} companyId - Company identifier
     * @param {string} empId - Employee identifier
     * @param {string} period - Period string (e.g., '2025-01')
     * @param {Object} [payrollData] - Optional pre-loaded payroll data
     * @returns {Object} { gross, paye, uif, sdl, deductions, net }
     */
    calculateEmployeePeriod: async function(companyId, empId, period, payrollData) {
        // Check for historical data first - historical records store pre-calculated values
        var histData = this.getHistoricalRecord(companyId, empId, period);
        if (histData) {
            return {
                gross: histData.gross || 0,
                paye: histData.paye || 0,
                uif: histData.uif || 0,
                sdl: histData.sdl || this.calculateSDL(histData.gross || 0),
                deductions: this.r2((histData.deductions || []).reduce(function(sum, d) { return sum + (parseFloat(d.amount) || 0); }, 0)),
                net: histData.net || 0,
                source: histData.source || 'historical',
                negativeNetPay: false,
                medicalCredit: 0
            };
        }

        // Use DataAccess (API) only when empId is a numeric Supabase ID.
        // String IDs like "emp-abc123" are localStorage-based — use localStorage directly
        // to avoid invalid integer errors hitting the backend.
        var useDA = typeof DataAccess !== 'undefined' && /^\d+$/.test(String(empId));

        if (!payrollData) {
            payrollData = useDA
                ? await DataAccess.getEmployeePayroll(companyId, empId)
                : JSON.parse(safeLocalStorage.getItem('emp_payroll_' + companyId + '_' + empId) || '{"basic_salary":0,"regular_inputs":[]}');
        }

        // Load employee record for age/medical/directive data
        var employeeOptions = {};
        var emp = useDA
            ? await DataAccess.getEmployeeById(companyId, empId)
            : (function() {
                var s = safeLocalStorage.getItem('employees_' + companyId);
                return s ? JSON.parse(s).find(function(e) { return e.id === empId; }) : null;
            })();
        if (emp) {
            if (emp.id_number) {
                var parts = period.split('-');
                var periodEnd = new Date(parseInt(parts[0]), parseInt(parts[1]), 0);
                employeeOptions.age = PayrollEngine.getAgeFromId(emp.id_number, periodEnd);
            }
            if (emp.medical_aid_members) {
                employeeOptions.medicalMembers = parseInt(emp.medical_aid_members) || 0;
            }
            if (emp.tax_directive) {
                employeeOptions.taxDirective = parseFloat(emp.tax_directive) || 0;
            }
        }

        var currentInputs = useDA
            ? await DataAccess.getCurrentInputs(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_current_' + companyId + '_' + empId + '_' + period) || '[]');
        var overtime = useDA
            ? await DataAccess.getOvertime(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_overtime_' + companyId + '_' + empId + '_' + period) || '[]');
        var multiRate = useDA
            ? await DataAccess.getMultiRate(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_multi_rate_' + companyId + '_' + empId + '_' + period) || '[]');
        var shortTime = useDA
            ? await DataAccess.getShortTime(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_short_time_' + companyId + '_' + empId + '_' + period) || '[]');

        var ytdData = this.getYTDData(companyId, empId, period);
        return this.calculateFromData(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData);
    },

    // === HISTORICAL DATA FUNCTIONS ===

    /**
     * Get a historical record for an employee/period.
     * Returns the stored data object or null if not found.
     */
    getHistoricalRecord: function(companyId, empId, period) {
        var key = 'emp_historical_' + companyId + '_' + empId + '_' + period;
        var stored = safeLocalStorage.getItem(key);
        if (!stored) return null;
        try { return JSON.parse(stored); } catch(e) { return null; }
    },

    /**
     * Check if a historical record exists for an employee/period.
     */
    hasHistoricalRecord: function(companyId, empId, period) {
        return safeLocalStorage.getItem('emp_historical_' + companyId + '_' + empId + '_' + period) !== null;
    },

    /**
     * Get all historical periods for a company (scans localStorage keys).
     * Returns sorted array of period strings.
     */
    getHistoricalPeriods: function(companyId) {
        var prefix = 'emp_historical_' + companyId + '_';
        var periods = {};
        for (var i = 0; i < safeLocalStorage.length; i++) {
            var key = safeLocalStorage.key(i);
            if (key && key.indexOf(prefix) === 0) {
                var parts = key.replace(prefix, '').split('_');
                var period = parts[parts.length - 1];
                // Validate it looks like YYYY-MM
                if (/^\d{4}-\d{2}$/.test(period)) {
                    periods[period] = true;
                }
            }
        }
        return Object.keys(periods).sort();
    },

    /**
     * Get all historical records for an employee across all periods.
     * Returns object keyed by period.
     */
    getEmployeeHistory: function(companyId, empId) {
        var prefix = 'emp_historical_' + companyId + '_' + empId + '_';
        var records = {};
        for (var i = 0; i < safeLocalStorage.length; i++) {
            var key = safeLocalStorage.key(i);
            if (key && key.indexOf(prefix) === 0) {
                var period = key.replace(prefix, '');
                if (/^\d{4}-\d{2}$/.test(period)) {
                    try {
                        records[period] = JSON.parse(safeLocalStorage.getItem(key));
                    } catch(e) { /* skip corrupt records */ }
                }
            }
        }
        return records;
    },

    /**
     * Delete a historical record.
     */
    deleteHistoricalRecord: function(companyId, empId, period) {
        safeLocalStorage.removeItem('emp_historical_' + companyId + '_' + empId + '_' + period);
    },

    /**
     * Delete all records from a specific import batch.
     * Returns number of records deleted.
     */
    undoImportBatch: function(companyId, importLogId) {
        var logKey = 'historical_import_log_' + companyId;
        var log = [];
        try { log = JSON.parse(safeLocalStorage.getItem(logKey) || '[]'); } catch(e) { return 0; }

        var entry = log.find(function(l) { return l.id === importLogId; });
        if (!entry) return 0;

        var employees = JSON.parse(safeLocalStorage.getItem('employees_' + companyId) || '[]');
        var deletedCount = 0;

        // Delete all historical records for the periods in this import
        (entry.periods || []).forEach(function(period) {
            employees.forEach(function(emp) {
                var key = 'emp_historical_' + companyId + '_' + emp.id + '_' + period;
                var record = safeLocalStorage.getItem(key);
                if (record) {
                    try {
                        var data = JSON.parse(record);
                        // Only delete if it was from this import (check timestamp proximity)
                        if (data.imported_date && entry.timestamp) {
                            var importTime = new Date(data.imported_date).getTime();
                            var logTime = new Date(entry.timestamp).getTime();
                            // Within 60 seconds of the log entry = same batch
                            if (Math.abs(importTime - logTime) < 60000) {
                                safeLocalStorage.removeItem(key);
                                deletedCount++;
                            }
                        }
                    } catch(e) { /* skip */ }
                }
            });
        });

        // Mark the log entry as undone
        entry.undone = true;
        entry.undone_date = new Date().toISOString();
        safeLocalStorage.setItem(logKey, JSON.stringify(log));

        return deletedCount;
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
                medicalCredit: loResult.medicalCredit || 0,
                negativeNetPay: loResult.negativeNetPay,
                iterations: 0,
                note: 'Basic salary is zero — known items alone meet or exceed the target net.'
            };
        }

        // Edge case: upper bound is insufficient
        if (hiResult.net < targetNet - tolerance) {
            return {
                success: false,
                error: 'Target net exceeds what is achievable within the search range (R' +
                    hiLimit.toLocaleString('en-ZA') + ' basic). Increase the search limit or reduce fixed deductions.',
                basic: hiLimit,
                gross: hiResult.gross,
                taxableGross: hiResult.taxableGross,
                paye: hiResult.paye,
                uif: hiResult.uif,
                sdl: hiResult.sdl,
                deductions: hiResult.deductions,
                net: hiResult.net,
                medicalCredit: hiResult.medicalCredit || 0,
                negativeNetPay: hiResult.negativeNetPay,
                iterations: 2
            };
        }

        // Binary search (bisection)
        var lo = 0;
        var hi = hiLimit;
        var result = loResult;
        var i = 0;
        for (i = 0; i < maxIter; i++) {
            var mid = (lo + hi) / 2;
            result = trial(mid);
            var diff = result.net - targetNet;
            if (Math.abs(diff) <= tolerance) { break; }
            if (diff < 0) {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        // Recalculate with the rounded basic for a consistent, clean output
        var finalBasic = self.r2((lo + hi) / 2);
        var finalResult = trial(finalBasic);

        return {
            success: true,
            basic: finalBasic,
            gross: finalResult.gross,
            taxableGross: finalResult.taxableGross,
            paye: finalResult.paye,
            uif: finalResult.uif,
            sdl: finalResult.sdl,
            deductions: finalResult.deductions,
            net: finalResult.net,
            medicalCredit: finalResult.medicalCredit || 0,
            negativeNetPay: finalResult.negativeNetPay,
            iterations: i + 1
        };
    }

};

// CommonJS export — allows Node.js/Jest testing without affecting browser behaviour
if (typeof module !== 'undefined' && module.exports) { module.exports = PayrollEngine; }
