// ============================================================
// PayrollEngine - Shared Payroll Calculation Module
// South African PAYE Tax Calculation
// TAX TABLE UPDATE GUIDE (every 1 March):
//   1. Go to Payroll -> Payroll Items -> Tax Configuration (super-admin)
//   2. Enter new brackets/rebates from the SARS budget announcement
//   3. Save - tables are stored in Supabase and override these defaults
//   4. If needed, update BRACKETS/REBATES below and TAX_YEAR
// ============================================================

const PayrollEngine = {

    // === DEFAULT TAX CONSTANTS (SA 2026/2027 — same brackets as 2025/2026, pending SARS confirmation) ===
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

    // Historical tax tables by SA tax year (1 March -> end February)
    HISTORICAL_TABLES: {
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
    calculateMedicalCredit: function(numMembers, tables) {
        if (!numMembers || numMembers <= 0) return 0;
        var t = tables || this;
        var main = typeof t.MEDICAL_CREDIT_MAIN === 'number' ? t.MEDICAL_CREDIT_MAIN : this.MEDICAL_CREDIT_MAIN;
        var firstDep = typeof t.MEDICAL_CREDIT_FIRST_DEP === 'number' ? t.MEDICAL_CREDIT_FIRST_DEP : this.MEDICAL_CREDIT_FIRST_DEP;
        var additional = typeof t.MEDICAL_CREDIT_ADDITIONAL === 'number' ? t.MEDICAL_CREDIT_ADDITIONAL : this.MEDICAL_CREDIT_ADDITIONAL;
        if (numMembers === 1) return main;
        if (numMembers === 2) return main + firstDep;
        return main + firstDep + (numMembers - 2) * additional;
    },

    // === CORE CALCULATION FUNCTIONS ===

    /**
     * Calculate annual PAYE from annual taxable income.
     * Pure function - no side effects.
     * @param {number} annualGross - Annual taxable income
     * @param {number} [age] - Employee age for secondary/tertiary rebates
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
        tax -= (typeof t.PRIMARY_REBATE === 'number' ? t.PRIMARY_REBATE : this.PRIMARY_REBATE);
        if (age && age >= 65) tax -= (typeof t.SECONDARY_REBATE === 'number' ? t.SECONDARY_REBATE : this.SECONDARY_REBATE);
        if (age && age >= 75) tax -= (typeof t.TERTIARY_REBATE === 'number' ? t.TERTIARY_REBATE : this.TERTIARY_REBATE);
        return Math.max(tax, 0);
    },

    /**
     * Calculate monthly PAYE from monthly gross.
     * Annualizes, calculates annual tax, divides by 12.
     * @param {number} monthlyGross
     * @param {Object} [options] - { age, medicalMembers, taxDirective }
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

    /**
     * Calculate monthly UIF contribution (employee portion).
     * 1% of gross, capped at R177.12/month.
     */
    calculateUIF: function(monthlyGross, tables) {
        var t = tables || this;
        var rate = typeof t.UIF_RATE === 'number' ? t.UIF_RATE : this.UIF_RATE;
        var cap = typeof t.UIF_MONTHLY_CAP === 'number' ? t.UIF_MONTHLY_CAP : this.UIF_MONTHLY_CAP;
        return this.r2(Math.min(monthlyGross * rate, cap));
    },

    /**
     * Calculate SDL (Skills Development Levy).
     * 1% of gross.
     */
    calculateSDL: function(monthlyGross, tables) {
        var t = tables || this;
        var rate = typeof t.SDL_RATE === 'number' ? t.SDL_RATE : this.SDL_RATE;
        return this.r2(monthlyGross * rate);
    },

    /**
     * Derive SA tax year for a pay period.
     * Example: 2025-01 -> 2024/2025, 2025-03 -> 2025/2026.
     */
    getTaxYearForPeriod: function(periodStr) {
        if (!periodStr) return this.TAX_YEAR;
        var parts = periodStr.split('-');
        var year = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        if (isNaN(year) || isNaN(month)) return this.TAX_YEAR;
        return month >= 3 ? year + '/' + (year + 1) : (year - 1) + '/' + year;
    },

    /**
     * Resolve which tax table set to use for a given pay period.
     */
    getTablesForPeriod: function(periodStr) {
        if (!periodStr) return this;
        var taxYear = this.getTaxYearForPeriod(periodStr);
        if (taxYear === this.TAX_YEAR) return this;
        if (this.HISTORICAL_TABLES[taxYear]) return this.HISTORICAL_TABLES[taxYear];
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
     * @returns {Object} { gross, paye, uif, sdl, deductions, net, negativeNetPay, medicalCredit }
     */
    calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period) {
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
        var paye = PayrollEngine.calculateMonthlyPAYE(taxableGross, opts, tables);
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
            medicalCredit: opts.medicalMembers ? PayrollEngine.calculateMedicalCredit(opts.medicalMembers, tables) : 0
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
    calculateEmployeePeriod: function(companyId, empId, period, payrollData) {
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

        if (!payrollData) {
            payrollData = (typeof DataAccess !== 'undefined')
                ? DataAccess.getEmployeePayroll(companyId, empId)
                : JSON.parse(safeLocalStorage.getItem('emp_payroll_' + companyId + '_' + empId) || '{"basic_salary":0,"regular_inputs":[]}');
        }

        // Load employee record for age/medical/directive data
        var employeeOptions = {};
        var emp = (typeof DataAccess !== 'undefined')
            ? DataAccess.getEmployeeById(companyId, empId)
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

        var useDA = typeof DataAccess !== 'undefined';
        var currentInputs = useDA
            ? DataAccess.getCurrentInputs(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_current_' + companyId + '_' + empId + '_' + period) || '[]');
        var overtime = useDA
            ? DataAccess.getOvertime(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_overtime_' + companyId + '_' + empId + '_' + period) || '[]');
        var multiRate = useDA
            ? DataAccess.getMultiRate(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_multi_rate_' + companyId + '_' + empId + '_' + period) || '[]');
        var shortTime = useDA
            ? DataAccess.getShortTime(companyId, empId, period)
            : JSON.parse(safeLocalStorage.getItem('emp_short_time_' + companyId + '_' + empId + '_' + period) || '[]');

        return this.calculateFromData(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period);
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
        var keys = (typeof DataAccess !== 'undefined' && DataAccess.listKeys)
            ? DataAccess.listKeys()
            : [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
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
        var keys = (typeof DataAccess !== 'undefined' && DataAccess.listKeys)
            ? DataAccess.listKeys()
            : [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key && key.indexOf(prefix) === 0) {
                var period = key.replace(prefix, '');
                if (/^\d{4}-\d{2}$/.test(period)) {
                    try {
                        var raw = (typeof DataAccess !== 'undefined' && DataAccess.getRaw)
                            ? DataAccess.getRaw(key)
                            : safeLocalStorage.getItem(key);
                        records[period] = JSON.parse(raw);
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
