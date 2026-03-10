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

    // === DEFAULT TAX CONSTANTS (SA 2025/2026 — same brackets as 2024/2025) ===
    // Override via Tax Configuration in Payroll Items (stored in Supabase KV)
    TAX_YEAR: '2025/2026',

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
     * @returns {number} Monthly medical credit amount
     */
    calculateMedicalCredit: function(numMembers) {
        if (!numMembers || numMembers <= 0) return 0;
        if (numMembers === 1) return this.MEDICAL_CREDIT_MAIN;
        if (numMembers === 2) return this.MEDICAL_CREDIT_MAIN + this.MEDICAL_CREDIT_FIRST_DEP;
        return this.MEDICAL_CREDIT_MAIN + this.MEDICAL_CREDIT_FIRST_DEP
               + (numMembers - 2) * this.MEDICAL_CREDIT_ADDITIONAL;
    },

    // === CORE CALCULATION FUNCTIONS ===

    /**
     * Calculate annual PAYE from annual taxable income.
     * Pure function - no side effects.
     * @param {number} annualGross - Annual taxable income
     * @param {number} [age] - Employee age for secondary/tertiary rebates
     */
    calculateAnnualPAYE: function(annualGross, age) {
        if (annualGross <= 0) return 0;
        var tax = 0;
        if (annualGross <= 237100)       tax = annualGross * 0.18;
        else if (annualGross <= 370500)  tax = 42678 + (annualGross - 237100) * 0.26;
        else if (annualGross <= 512800)  tax = 77362 + (annualGross - 370500) * 0.31;
        else if (annualGross <= 673000)  tax = 121475 + (annualGross - 512800) * 0.36;
        else if (annualGross <= 857900)  tax = 179147 + (annualGross - 673000) * 0.39;
        else if (annualGross <= 1817000) tax = 251258 + (annualGross - 857900) * 0.41;
        else                             tax = 644489 + (annualGross - 1817000) * 0.45;
        tax -= this.PRIMARY_REBATE;
        if (age && age >= 65) tax -= this.SECONDARY_REBATE;
        if (age && age >= 75) tax -= this.TERTIARY_REBATE;
        return Math.max(tax, 0);
    },

    /**
     * Calculate monthly PAYE from monthly gross.
     * Annualizes, calculates annual tax, divides by 12.
     * @param {number} monthlyGross
     * @param {Object} [options] - { age, medicalMembers, taxDirective }
     */
    calculateMonthlyPAYE: function(monthlyGross, options) {
        options = options || {};

        // Tax directive override: flat rate
        if (options.taxDirective && options.taxDirective > 0) {
            return this.r2(monthlyGross * (options.taxDirective / 100));
        }

        var annualTax = this.calculateAnnualPAYE(monthlyGross * 12, options.age);
        var monthlyTax = annualTax / 12;

        // Subtract medical tax credits
        if (options.medicalMembers && options.medicalMembers > 0) {
            monthlyTax -= this.calculateMedicalCredit(options.medicalMembers);
        }

        return this.r2(Math.max(monthlyTax, 0));
    },

    /**
     * Calculate monthly UIF contribution (employee portion).
     * 1% of gross, capped at R177.12/month.
     */
    calculateUIF: function(monthlyGross) {
        return this.r2(Math.min(monthlyGross * this.UIF_RATE, this.UIF_MONTHLY_CAP));
    },

    /**
     * Calculate SDL (Skills Development Levy).
     * 1% of gross.
     */
    calculateSDL: function(monthlyGross) {
        return this.r2(monthlyGross * this.SDL_RATE);
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
     * @returns {Object} { gross, paye, uif, sdl, deductions, net, negativeNetPay, medicalCredit }
     */
    calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions) {
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

        // Overtime (always taxable)
        var hourlyRate = payrollData.basic_salary ? payrollData.basic_salary / PayrollEngine.HOURLY_DIVISOR : 0;
        (overtime || []).forEach(function(ot) {
            taxableGross += (parseFloat(ot.hours) || 0) * hourlyRate * (parseFloat(ot.rate_multiplier) || 1.5);
        });

        // Multi-rate hours (always taxable)
        (multiRate || []).forEach(function(mr) {
            taxableGross += (parseFloat(mr.hours) || 0) * (parseFloat(mr.hourly_rate) || 0);
        });

        // Short time deductions
        (shortTime || []).forEach(function(st) {
            taxableGross -= (parseFloat(st.hours_missed) || 0) * hourlyRate;
        });

        if (taxableGross < 0) taxableGross = 0;

        // Total gross includes both taxable and non-taxable
        var gross = taxableGross + nonTaxableIncome;

        var opts = employeeOptions || {};
        var paye = PayrollEngine.calculateMonthlyPAYE(taxableGross, opts);
        var uif = PayrollEngine.calculateUIF(gross);
        var sdl = PayrollEngine.calculateSDL(gross);

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
            medicalCredit: opts.medicalMembers ? PayrollEngine.calculateMedicalCredit(opts.medicalMembers) : 0
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

        return this.calculateFromData(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions);
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
    }
};
