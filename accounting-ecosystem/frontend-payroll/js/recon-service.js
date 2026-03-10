/**
 * recon-service.js — PAYE Reconciliation Data Service
 * Aggregates payroll historical data for the PAYE Reconciliation module.
 * Depends on: PayrollEngine (payroll-engine.js), safeLocalStorage (polyfills.js)
 */

var ReconService = (function() {
    'use strict';

    // ─── Tax Year Utilities ─────────────────────────────────────────────────────

    /**
     * Derives tax year label from a period string.
     * SA tax year runs March–February.
     * Example: '2025-03' → '2025/2026'; '2025-02' → '2024/2025'
     */
    function getTaxYearForPeriod(period) {
        var parts = period.split('-');
        var year = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        // March (3) starts a new tax year
        if (month >= 3) {
            return year + '/' + (year + 1);
        } else {
            return (year - 1) + '/' + year;
        }
    }

    /**
     * Returns a sorted array of unique tax year labels from a period array.
     * e.g. ['2024/2025', '2025/2026']
     */
    function getTaxYears(allPeriods) {
        var seen = {};
        var years = [];
        (allPeriods || []).forEach(function(p) {
            var ty = getTaxYearForPeriod(p);
            if (!seen[ty]) { seen[ty] = true; years.push(ty); }
        });
        return years.sort();
    }

    /**
     * Filters periods to only those belonging to the given taxYear label.
     * taxYear e.g. '2025/2026'
     */
    function getPeriodsForTaxYear(allPeriods, taxYear) {
        return (allPeriods || []).filter(function(p) {
            return getTaxYearForPeriod(p) === taxYear;
        });
    }

    /**
     * Returns the month number within the SA tax year (1 = March, 12 = February)
     */
    function getMonthInTaxYear(period) {
        var month = parseInt(period.split('-')[1], 10);
        return month >= 3 ? month - 2 : month + 10;
    }

    /**
     * Formats a period string 'YYYY-MM' to 'MMM YYYY'
     */
    function formatPeriodLabel(period) {
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var parts = period.split('-');
        return months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
    }

    // ─── Data Aggregation ───────────────────────────────────────────────────────

    /**
     * Sums all employees' historical records for each period.
     * Returns: { [period]: { gross, paye, uif, sdl, total } }
     */
    function buildPayrollTotals(companyId, employees, periods) {
        var totals = {};
        periods.forEach(function(period) {
            totals[period] = { gross: 0, paye: 0, uif: 0, sdl: 0, total: 0 };
        });

        employees.forEach(function(emp) {
            periods.forEach(function(period) {
                var rec = PayrollEngine.getHistoricalRecord(companyId, emp.id, period);
                if (!rec) return;
                var t = totals[period];
                t.gross += parseFloat(rec.gross) || 0;
                t.paye  += parseFloat(rec.paye)  || 0;
                t.uif   += parseFloat(rec.uif)   || 0;
                t.sdl   += parseFloat(rec.sdl)   || 0;
            });
        });

        // Compute totals column
        periods.forEach(function(period) {
            var t = totals[period];
            t.paye  = round2(t.paye);
            t.uif   = round2(t.uif);
            t.sdl   = round2(t.sdl);
            t.gross = round2(t.gross);
            t.total = round2(t.paye + t.uif + t.sdl);
        });

        return totals;
    }

    /**
     * Builds a per-employee, per-period breakdown.
     * Returns: [ { emp, rows: [ { period, basic, overtime, allowances, bonus, commission,
     *              gross, paye, uif, sdl, pension, medical, garnishee,
     *              otherDeductions, totalDeductions, net, bank, diff } ] } ]
     */
    function getEmployeeBreakdown(companyId, employees, periods) {
        var result = [];

        employees.forEach(function(emp) {
            var empRows = [];

            periods.forEach(function(period) {
                var rec = PayrollEngine.getHistoricalRecord(companyId, emp.id, period);
                if (!rec) return;

                var basic     = parseFloat(rec.basic_salary) || 0;
                var gross     = parseFloat(rec.gross)        || 0;
                var paye      = parseFloat(rec.paye)         || 0;
                var uif       = parseFloat(rec.uif)          || 0;
                var sdl       = parseFloat(rec.sdl)          || 0;
                var net       = parseFloat(rec.net)          || 0;

                // ── Overtime ──────────────────────────────────────────────────
                var overtime = 0;
                var otKey = 'emp_overtime_' + companyId + '_' + emp.id + '_' + period;
                try {
                    var otItems = JSON.parse(safeLocalStorage.getItem(otKey) || '[]');
                    var hourlyRate = basic > 0 ? basic / 173.33 : 0;
                    otItems.forEach(function(ot) {
                        overtime += (parseFloat(ot.hours) || 0) * hourlyRate * (parseFloat(ot.rate_multiplier) || 1.5);
                    });
                    overtime = round2(overtime);
                } catch(e) { overtime = 0; }

                // ── Allowances / Deductions breakdown ────────────────────────
                var allowances = 0;
                var bonus      = 0;
                var commission = 0;
                var pension    = 0;
                var medical    = 0;
                var garnishee  = 0;
                var otherDed   = 0;

                var deductions = rec.deductions || [];
                var csvAllowances = rec.allowances || [];

                // CSV-imported records have explicit arrays
                if (csvAllowances.length > 0) {
                    csvAllowances.forEach(function(a) {
                        var desc = (a.description || '').toLowerCase();
                        var amt = parseFloat(a.amount) || 0;
                        if (/bonus/i.test(desc))           { bonus += amt; }
                        else if (/commis/i.test(desc))     { commission += amt; }
                        else                                { allowances += amt; }
                    });
                }

                // Categorize deductions
                if (deductions.length > 0) {
                    var hasSingleTotal = deductions.length === 1 &&
                        /total/i.test(deductions[0].description || '');

                    if (!hasSingleTotal) {
                        deductions.forEach(function(d) {
                            var desc = (d.description || '').toLowerCase();
                            var amt  = parseFloat(d.amount) || 0;
                            if (/pension/i.test(desc))         { pension += amt; }
                            else if (/medical/i.test(desc))    { medical += amt; }
                            else if (/garnish/i.test(desc))    { garnishee += amt; }
                            else                                { otherDed += amt; }
                        });
                    } else {
                        // Single "Total Deductions" entry — try current payroll config
                        otherDed = parseFloat(deductions[0].amount) || 0;
                        _enrichFromPayrollData(companyId, emp.id, {
                            pension: 0, medical: 0, garnishee: 0, other: 0
                        });
                    }
                }

                // Try to enrich from current payroll items if no itemized deductions
                if (deductions.length <= 1 && csvAllowances.length === 0) {
                    var payrollKey = 'emp_payroll_' + companyId + '_' + emp.id;
                    try {
                        var pd = JSON.parse(safeLocalStorage.getItem(payrollKey) || 'null');
                        if (pd && pd.regular_inputs) {
                            pd.regular_inputs.forEach(function(ri) {
                                var amt  = parseFloat(ri.amount) || 0;
                                var desc = (ri.description || '').toLowerCase();
                                if (ri.type === 'allowance' || ri.type === 'addition') {
                                    if (/bonus/i.test(desc))        { bonus += amt; }
                                    else if (/commis/i.test(desc))  { commission += amt; }
                                    else                             { allowances += amt; }
                                } else if (ri.type === 'deduction') {
                                    if (/pension/i.test(desc))      { pension += amt; }
                                    else if (/medical/i.test(desc)) { medical += amt; }
                                    else if (/garnish/i.test(desc)) { garnishee += amt; }
                                    else                             { otherDed += amt; }
                                }
                            });
                        }
                    } catch(e) {}
                }

                allowances  = round2(allowances);
                bonus       = round2(bonus);
                commission  = round2(commission);
                pension     = round2(pension);
                medical     = round2(medical);
                garnishee   = round2(garnishee);
                otherDed    = round2(otherDed);

                var totalDeductions = round2(pension + medical + garnishee + otherDed + paye + uif);
                var bank = net; // what is deposited to employee's bank
                var diff = round2(gross - paye - uif - (pension + medical + garnishee + otherDed) - net);

                empRows.push({
                    period:         period,
                    basic:          basic,
                    overtime:       overtime,
                    allowances:     allowances,
                    bonus:          bonus,
                    commission:     commission,
                    gross:          gross,
                    paye:           paye,
                    uif:            uif,
                    sdl:            sdl,
                    pension:        pension,
                    medical:        medical,
                    garnishee:      garnishee,
                    otherDeductions: otherDed,
                    totalDeductions: totalDeductions,
                    net:            net,
                    bank:           bank,
                    diff:           diff
                });
            });

            if (empRows.length > 0) {
                result.push({ emp: emp, rows: empRows });
            }
        });

        return result;
    }

    // Unused helper placeholder — kept for future extension
    function _enrichFromPayrollData(companyId, empId, out) { return out; }

    // ─── SARS Submitted Values ──────────────────────────────────────────────────

    function _sarsKey(companyId) { return 'paye_recon_sars_' + companyId; }

    /**
     * Returns { [period]: { paye, uif, sdl } }
     */
    function loadSARSValues(companyId) {
        try {
            return JSON.parse(safeLocalStorage.getItem(_sarsKey(companyId)) || '{}');
        } catch(e) { return {}; }
    }

    function saveSARSValues(companyId, data) {
        safeLocalStorage.setItem(_sarsKey(companyId), JSON.stringify(data));
    }

    function setSARSPeriod(companyId, period, paye, uif, sdl) {
        var data = loadSARSValues(companyId);
        data[period] = { paye: round2(parseFloat(paye) || 0), uif: round2(parseFloat(uif) || 0), sdl: round2(parseFloat(sdl) || 0) };
        saveSARSValues(companyId, data);
    }

    // ─── Bank Payment Values ────────────────────────────────────────────────────

    function _bankKey(companyId) { return 'paye_recon_bank_' + companyId; }

    /**
     * Returns { [period]: { paye, uif, sdl } }
     */
    function loadBankValues(companyId) {
        try {
            return JSON.parse(safeLocalStorage.getItem(_bankKey(companyId)) || '{}');
        } catch(e) { return {}; }
    }

    function saveBankValues(companyId, data) {
        safeLocalStorage.setItem(_bankKey(companyId), JSON.stringify(data));
    }

    function setBankPeriod(companyId, period, paye, uif, sdl) {
        var data = loadBankValues(companyId);
        data[period] = { paye: round2(parseFloat(paye) || 0), uif: round2(parseFloat(uif) || 0), sdl: round2(parseFloat(sdl) || 0) };
        saveBankValues(companyId, data);
    }

    // ─── Reconciliation Diffs ───────────────────────────────────────────────────

    /**
     * Computes differences: calc vs SARS;  and calc vs Bank.
     * Returns: { [period]: { payeDiff, uifDiff, sdlDiff, totalDiff,
     *                         bankPayeDiff, bankUifDiff, bankSdlDiff, bankTotalDiff } }
     */
    function buildReconciliation(payrollTotals, sarsValues, bankValues) {
        var recon = {};
        var periods = Object.keys(payrollTotals);
        periods.forEach(function(period) {
            var calc  = payrollTotals[period]  || { paye:0, uif:0, sdl:0 };
            var sars  = (sarsValues  || {})[period] || { paye:0, uif:0, sdl:0 };
            var bank  = (bankValues  || {})[period] || { paye:0, uif:0, sdl:0 };

            var payeDiff = round2(calc.paye - sars.paye);
            var uifDiff  = round2(calc.uif  - sars.uif);
            var sdlDiff  = round2(calc.sdl  - sars.sdl);

            var bankPayeDiff = round2(calc.paye - bank.paye);
            var bankUifDiff  = round2(calc.uif  - bank.uif);
            var bankSdlDiff  = round2(calc.sdl  - bank.sdl);

            recon[period] = {
                payeDiff:     payeDiff,
                uifDiff:      uifDiff,
                sdlDiff:      sdlDiff,
                totalDiff:    round2(payeDiff + uifDiff + sdlDiff),
                bankPayeDiff: bankPayeDiff,
                bankUifDiff:  bankUifDiff,
                bankSdlDiff:  bankSdlDiff,
                bankTotalDiff: round2(bankPayeDiff + bankUifDiff + bankSdlDiff)
            };
        });
        return recon;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    function round2(n) {
        return Math.round((parseFloat(n) || 0) * 100) / 100;
    }

    // ─── Public API ─────────────────────────────────────────────────────────────

    return {
        getTaxYearForPeriod:   getTaxYearForPeriod,
        getTaxYears:           getTaxYears,
        getPeriodsForTaxYear:  getPeriodsForTaxYear,
        getMonthInTaxYear:     getMonthInTaxYear,
        formatPeriodLabel:     formatPeriodLabel,
        buildPayrollTotals:    buildPayrollTotals,
        getEmployeeBreakdown:  getEmployeeBreakdown,
        loadSARSValues:        loadSARSValues,
        saveSARSValues:        saveSARSValues,
        setSARSPeriod:         setSARSPeriod,
        loadBankValues:        loadBankValues,
        saveBankValues:        saveBankValues,
        setBankPeriod:         setBankPeriod,
        buildReconciliation:   buildReconciliation,
        round2:                round2
    };
})();
