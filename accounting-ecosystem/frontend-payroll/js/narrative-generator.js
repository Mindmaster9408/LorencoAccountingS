/* =============================================
   PAYSLIP NARRATIVE GENERATOR
   Payroll App - Auto-explain payslip deductions
   ============================================= */

const NarrativeGenerator = {

    // ---- Main Generator ----
    generate: function(employee, period, currentCalc, previousCalc, payrollData) {
        return {
            greeting: this.generateGreeting(employee),
            summary: this.generateSummary(currentCalc),
            comparison: this.generateComparison(currentCalc, previousCalc, payrollData, period),
            breakdown: this.generateBreakdown(currentCalc, payrollData, period),
            taxExplanation: this.generateTaxExplanation(employee, currentCalc, period),
            conclusion: this.generateConclusion(currentCalc, employee),
            timestamp: new Date().toISOString()
        };
    },

    // ---- Greeting ----
    generateGreeting: function(employee) {
        var firstName = employee.first_name || 'Employee';
        var hour = new Date().getHours();
        var timeOfDay = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        return timeOfDay + ', ' + firstName;
    },

    // ---- Summary ----
    generateSummary: function(calc) {
        return 'Your take-home pay this month is ' + this.formatMoney(calc.net) + '.';
    },

    // ---- Comparison ----
    generateComparison: function(current, previous, payrollData, period) {
        if (!previous || previous.gross === 0) {
            return {
                text: 'This is the first calculated payslip for this period.',
                changes: []
            };
        }

        var changes = [];

        // Gross comparison
        var grossDiff = current.gross - previous.gross;
        if (Math.abs(grossDiff) > 0.01) {
            var direction = grossDiff > 0 ? 'increased' : 'decreased';
            var percent = Math.abs((grossDiff / previous.gross) * 100).toFixed(1);
            changes.push({
                type: 'gross',
                direction: direction,
                text: 'Your gross income ' + direction + ' by ' + this.formatMoney(Math.abs(grossDiff)) + ' (' + percent + '%).',
                amount: grossDiff,
                reason: this.inferGrossReason(current, previous, grossDiff, payrollData, period)
            });
        }

        // PAYE comparison
        var payeDiff = current.paye - previous.paye;
        if (Math.abs(payeDiff) > 0.01) {
            var dir = payeDiff > 0 ? 'increased' : 'decreased';
            changes.push({
                type: 'paye',
                direction: dir,
                text: 'Your PAYE ' + dir + ' by ' + this.formatMoney(Math.abs(payeDiff)) + '.',
                amount: payeDiff,
                reason: this.inferPayeReason(grossDiff, payeDiff)
            });
        }

        // UIF comparison
        var uifDiff = current.uif - previous.uif;
        if (Math.abs(uifDiff) > 0.01) {
            var uifDir = uifDiff > 0 ? 'increased' : 'decreased';
            changes.push({
                type: 'uif',
                direction: uifDir,
                text: 'Your UIF ' + uifDir + ' by ' + this.formatMoney(Math.abs(uifDiff)) + '.',
                amount: uifDiff,
                reason: current.uif >= 177.12 ? 'Your UIF is capped at R177.12 per month.' : 'UIF is calculated at 1% of your gross salary.'
            });
        }

        // Deductions comparison
        var dedDiff = current.totalDeductions - previous.totalDeductions;
        if (Math.abs(dedDiff) > 0.01) {
            var dedDir = dedDiff > 0 ? 'increased' : 'decreased';
            changes.push({
                type: 'deductions',
                direction: dedDir,
                text: 'Your other deductions ' + dedDir + ' by ' + this.formatMoney(Math.abs(dedDiff)) + '.',
                amount: dedDiff,
                reason: ''
            });
        }

        // Net summary
        var netDiff = current.net - previous.net;
        var netText = '';
        if (Math.abs(netDiff) > 0.01) {
            var netDir = netDiff > 0 ? 'higher' : 'lower';
            var netPercent = Math.abs((netDiff / previous.net) * 100).toFixed(1);
            netText = 'Overall, your take-home pay is ' + this.formatMoney(Math.abs(netDiff)) + ' (' + netPercent + '%) ' + netDir + ' than last month.';
        } else {
            netText = 'Your take-home pay is the same as last month.';
        }

        return {
            text: netText,
            changes: changes
        };
    },

    // ---- Infer Gross Change Reason ----
    inferGrossReason: function(current, previous, diff, payrollData, period) {
        var reasons = [];

        // Check overtime
        if (current.overtimeAmount > 0 && (!previous.overtimeAmount || current.overtimeAmount !== previous.overtimeAmount)) {
            if (current.overtimeAmount > (previous.overtimeAmount || 0)) {
                reasons.push('You worked more overtime hours this month.');
            } else {
                reasons.push('You worked fewer overtime hours this month.');
            }
        }

        // Check basic salary change
        if (current.basicSalary !== previous.basicSalary) {
            if (current.basicSalary > previous.basicSalary) {
                reasons.push('Your basic salary increased from ' + this.formatMoney(previous.basicSalary) + ' to ' + this.formatMoney(current.basicSalary) + '.');
            } else {
                reasons.push('Your basic salary decreased.');
            }
        }

        // Check current inputs (one-time items)
        if (current.currentInputsTotal > 0) {
            reasons.push('You have one-time items totalling ' + this.formatMoney(current.currentInputsTotal) + ' this month.');
        }

        if (reasons.length === 0) {
            if (diff > 0) {
                reasons.push('This increase may be due to additional allowances or earnings this period.');
            } else {
                reasons.push('This decrease may be due to reduced hours, absences, or removed allowances.');
            }
        }

        return reasons.join(' ');
    },

    // ---- Infer PAYE Reason ----
    inferPayeReason: function(grossDiff, payeDiff) {
        if (grossDiff > 0 && payeDiff > 0) {
            return 'PAYE increased because your gross income was higher. Higher earnings may push you into a higher marginal tax bracket.';
        } else if (grossDiff < 0 && payeDiff < 0) {
            return 'PAYE decreased because your gross income was lower this month.';
        } else if (Math.abs(grossDiff) < 0.01 && Math.abs(payeDiff) > 0.01) {
            return 'PAYE changed due to adjustments in tax-deductible items or rebates.';
        }
        return '';
    },

    // ---- Breakdown ----
    generateBreakdown: function(calc, payrollData, period) {
        // tax_year comes from the backend calculation result — no frontend engine call needed.
        var _taxYearRaw = calc.tax_year || '';
        var _taxYearDisplay = _taxYearRaw
            ? _taxYearRaw.replace(/(\d{4})\/(\d{4})/, function(m, y1, y2) { return y1 + '/' + y2.slice(2); })
            : '';
        var items = [];

        // Earnings
        if (calc.basicSalary > 0) {
            items.push({
                category: 'Earnings',
                name: 'Basic Salary',
                amount: calc.basicSalary,
                description: 'Your monthly base salary before any additions or deductions.',
                type: 'earning'
            });
        }

        // Regular allowances
        if (payrollData && payrollData.regular_inputs) {
            payrollData.regular_inputs.forEach(function(ri) {
                if (ri.type === 'allowance' || ri.type === 'earning') {
                    items.push({
                        category: 'Earnings',
                        name: ri.description,
                        amount: parseFloat(ri.amount),
                        description: 'Recurring monthly allowance.',
                        type: 'earning'
                    });
                }
            });
        }

        // Overtime
        if (calc.overtimeAmount > 0) {
            items.push({
                category: 'Earnings',
                name: 'Overtime',
                amount: calc.overtimeAmount,
                description: 'Additional pay for hours worked beyond normal schedule. Calculated at 1.5x your hourly rate.',
                type: 'earning'
            });
        }

        // Statutory deductions
        items.push({
            category: 'Statutory Deductions',
            name: 'PAYE (Pay As You Earn)',
            amount: calc.paye,
            description: 'Income tax withheld based on South African ' + (_taxYearDisplay || 'current') + ' tax brackets. This is paid to SARS on your behalf.',
            type: 'deduction'
        });

        items.push({
            category: 'Statutory Deductions',
            name: 'UIF (Unemployment Insurance)',
            amount: calc.uif,
            description: 'Unemployment insurance contribution at 1% of gross salary' +
                (calc.uif >= (calc.uif_monthly_cap || 177.12) ? ' (capped at ' + this.formatMoney(calc.uif_monthly_cap || 177.12) + '/month)' : '') +
                '. Your employer also contributes 1%.',
            type: 'deduction'
        });

        // Regular deductions
        if (payrollData && payrollData.regular_inputs) {
            payrollData.regular_inputs.forEach(function(ri) {
                if (ri.type === 'deduction') {
                    items.push({
                        category: 'Other Deductions',
                        name: ri.description,
                        amount: parseFloat(ri.amount),
                        description: 'Recurring monthly deduction.',
                        type: 'deduction'
                    });
                }
            });
        }

        return items;
    },

    // ---- Tax Explanation ----
    // ARCHITECTURE RULE: Frontend is display-only. There is ONE payroll engine: backend/core/payroll-engine.js.
    // This function uses ONLY values from the backend calculation result (calc).
    // NO frontend PayrollEngine calls. NO hardcoded tax defaults. NO bracket lookups.
    // All tax fields (primary_rebate_annual, marginal_rate, marginal_bracket, uif_monthly_cap,
    // tax_year) are populated by the backend engine using the active Supabase KV tax tables.
    // Age is derived from the SA ID number for descriptive purposes only — no tax recalculation.
    generateTaxExplanation: function(employee, calc, period) {
        var meta              = calc._meta || null;
        var ytdMethod         = meta ? (meta.ytdMethod || '') : '';
        var isYtdAverage      = ytdMethod === 'average_taxable_ytd';
        var isProjectionType  = ytdMethod === 'projection_type_ytd';
        var isYtdMethod       = isYtdAverage || isProjectionType;

        // All values come directly from the backend calculation result.
        // calc.rebate = total monthly rebate applied by the backend (all applicable: primary + secondary + tertiary).
        // calc.primary_rebate_annual = primary rebate only (when backend sends it explicitly).
        var totalRebateAnnual = calc.rebate ? Math.round(calc.rebate * 12 * 100) / 100 : (calc.primary_rebate_annual || 0);
        var uifCap            = calc.uif_monthly_cap || 177.12;
        var marginalRate      = calc.marginal_rate   || '';
        var marginalBracket   = calc.marginal_bracket || '';

        // TRACE D — confirm backend display fields are flowing through correctly.
        console.log('[narrative-generator TRACE D] Tax explanation source (backend calc):', JSON.stringify({
            primary_rebate_annual:   calc.primary_rebate_annual,
            rebate_monthly:          calc.rebate,
            totalRebateAnnual_used:  totalRebateAnnual,
            marginal_rate:           calc.marginal_rate,
            marginal_bracket:        calc.marginal_bracket,
            uif_monthly_cap:         calc.uif_monthly_cap,
            tax_year:                calc.tax_year,
            taxBeforeRebate_monthly: calc.taxBeforeRebate,
            ytdMethod:               ytdMethod
        }));

        var text;

        if (isProjectionType && meta) {
            // Per-item projection type method — each income stream projected by its classification.
            var ptPrior     = meta.ytdPriorTaxableGross    || 0;
            var ptCurrent   = meta.ytdCurrentTaxableGross  || 0;
            var ptFixed     = meta.ytdCurrentFixed         || 0;
            var ptVariable  = meta.ytdCurrentVariable      || 0;
            var ptOnceOff   = meta.ytdCurrentOnceOff       || 0;
            var ptVarAvg    = meta.ytdVariableAvgMonthly   || 0;
            var ptProjected = meta.ytdProjectedAnnualTaxable || 0;
            var ptRemaining = meta.ytdRemainingMonths      || 0;
            var ptMonthNum  = meta.ytdCurrentMonthNumber   || 0;
            var ptAnnualPAYE     = meta.ytdAnnualPAYE          || 0;
            var ptMedCredit      = meta.ytdMonthlyMedCredit    || 0;
            var ptCumTaxDue      = meta.ytdCumulativeTaxDueToDate || 0;
            var ptPriorPAYEPaid  = meta.ytdPriorPAYEPaid       || 0;
            var ptMarginalRate   = meta.ytdProjectionMarginalRate    || '';
            var ptMarginalBracket = meta.ytdProjectionMarginalBracket || '';

            text = 'PAYE was calculated using the projection-type method. ' +
                'Prior finalized taxable income: ' + this.formatMoney(ptPrior) + '. ' +
                'Current month taxable income: ' + this.formatMoney(ptCurrent) + '. ';
            if (ptFixed > 0) {
                text += 'Fixed recurring income this month: ' + this.formatMoney(ptFixed) +
                    ' × ' + ptRemaining + ' remaining months = ' + this.formatMoney(ptFixed * ptRemaining) + '. ';
            }
            if (ptVariable > 0) {
                text += 'Variable income (YTD average): ' + this.formatMoney(ptVarAvg) + '/month × 12 = ' +
                    this.formatMoney(ptVarAvg * 12) + '. ';
            }
            if (ptOnceOff > 0) {
                text += 'Once-off income: ' + this.formatMoney(ptOnceOff) + ' (included once only). ';
            }
            text += 'Projected annual taxable income: ' + this.formatMoney(ptProjected) + '. ';
            if (ptMarginalRate && ptMarginalBracket) {
                text += 'Marginal tax rate: ' + ptMarginalRate + ' (bracket: ' + ptMarginalBracket + '). ';
            }
            // Show full tax derivation so the prior-PAYE deduction is transparent
            if (ptAnnualPAYE > 0 && ptMonthNum > 0) {
                text += 'Annual tax on projected income: ' + this.formatMoney(ptAnnualPAYE) + '. ';
                text += 'Pro-rated for month ' + ptMonthNum + ' of 12';
                if (ptMedCredit > 0) {
                    text += ' less medical credit (' + this.formatMoney(ptMedCredit) + '/month × ' + ptMonthNum + ')';
                }
                text += ' = cumulative tax due to date: ' + this.formatMoney(ptCumTaxDue) + '. ';
                if (ptPriorPAYEPaid > 0) {
                    text += 'Less prior PAYE paid in locked months: ' + this.formatMoney(ptPriorPAYEPaid) + '. ';
                }
                text += 'PAYE this month: ' + this.formatMoney(ptCumTaxDue - ptPriorPAYEPaid) + '. ';
            }

        } else if (isYtdAverage && meta) {
            // YTD average taxable income method — use backend _meta fields directly.
            // DO NOT use gross × 12; that is only correct for monthly annualization.
            var priorTaxable    = meta.ytdPriorTaxableGross     || 0;
            var currentTaxable  = meta.ytdCurrentTaxableGross   || 0;
            var toDateTaxable   = meta.ytdTaxableGrossToDate     != null ? meta.ytdTaxableGrossToDate : (priorTaxable + currentTaxable);
            var avgMonthly      = meta.ytdAverageMonthlyTaxable  || 0;
            var projectedAnnual = meta.ytdProjectedAnnualTaxable || 0;
            var avgMonthNum     = meta.ytdCurrentMonthNumber     || 0;
            var avgAnnualPAYE   = meta.ytdAnnualPAYE             || 0;
            var avgMedCredit    = meta.ytdMonthlyMedCredit       || 0;
            var avgCumTaxDue    = meta.ytdCumulativeTaxDueToDate || 0;
            var avgPriorPAYE    = meta.ytdPriorPAYEPaid          || 0;
            var avgMargRate     = meta.ytdProjectionMarginalRate    || '';
            var avgMargBracket  = meta.ytdProjectionMarginalBracket || '';

            text = 'PAYE was calculated using year-to-date average taxable income. ' +
                'Prior finalized taxable income: ' + this.formatMoney(priorTaxable) + '. ' +
                'Current month taxable income: ' + this.formatMoney(currentTaxable) + '. ' +
                'Taxable income to date: ' + this.formatMoney(toDateTaxable) + '. ' +
                'Average monthly taxable income: ' + this.formatMoney(avgMonthly) + '. ' +
                'Projected annual taxable income: ' + this.formatMoney(projectedAnnual) + '. ';
            if (avgMargRate && avgMargBracket) {
                text += 'Marginal tax rate: ' + avgMargRate + ' (bracket: ' + avgMargBracket + '). ';
            }
            if (avgAnnualPAYE > 0 && avgMonthNum > 0) {
                text += 'Annual tax on projected income: ' + this.formatMoney(avgAnnualPAYE) + '. ';
                text += 'Pro-rated for month ' + avgMonthNum + ' of 12';
                if (avgMedCredit > 0) {
                    text += ' less medical credit (' + this.formatMoney(avgMedCredit) + '/month × ' + avgMonthNum + ')';
                }
                text += ' = cumulative tax due to date: ' + this.formatMoney(avgCumTaxDue) + '. ';
                if (avgPriorPAYE > 0) {
                    text += 'Less prior PAYE paid in locked months: ' + this.formatMoney(avgPriorPAYE) + '. ';
                }
                text += 'PAYE this month: ' + this.formatMoney(avgCumTaxDue - avgPriorPAYE) + '. ';
            }
        } else {
            // Monthly annualization (no prior YTD data available).
            var annualGross = calc.gross * 12;
            text = 'Based on your monthly gross of ' + this.formatMoney(calc.gross) +
                ', your annualized income is ' + this.formatMoney(annualGross) + '. ';
        }

        // marginal_rate/marginal_bracket from the engine are computed from gross × 12 (monthly
        // annualization). When any YTD method is active, those fields refer to a different projected
        // income — showing both would imply contradictory projected incomes.
        if (!isYtdMethod && marginalRate && marginalBracket) {
            text += 'Your marginal tax rate is ' + marginalRate + ' (bracket: ' + marginalBracket + '). ';
        }

        if (totalRebateAnnual > 0) {
            // Derive age from SA ID number (display-only — not used in any calculation).
            var age = this._getAgeFromId(employee && employee.id_number ? employee.id_number : null);
            if (age !== null && age >= 75) {
                text += 'You qualify for all three SARS tax rebates: the primary rebate (all taxpayers), ' +
                    'the secondary rebate (age 65 and older), and the tertiary rebate (age 75 and older). ' +
                    'Together these total ' + this.formatMoney(totalRebateAnnual) + ' annually, reducing your effective tax. ';
            } else if (age !== null && age >= 65) {
                text += 'You qualify for the primary rebate (all taxpayers) and the secondary rebate (age 65 and older). ' +
                    'Together these total ' + this.formatMoney(totalRebateAnnual) + ' annually, reducing your effective tax. ';
            } else {
                text += 'A primary rebate of ' + this.formatMoney(totalRebateAnnual) + ' is applied annually, reducing your effective tax. ';
            }
        }

        text += 'Your UIF contribution is 1% of gross' +
            (calc.uif >= uifCap ? ', capped at the maximum of ' + this.formatMoney(uifCap) + ' per month' : '') + '.';

        return text;
    },

    // Derives age in years from a South African ID number (YYMMDDXXXXXXX).
    // Returns null if the ID is invalid or too short. Year cutoff: YY > 30 → 19xx, else 20xx.
    // Used for narrative description only — never for tax calculation.
    _getAgeFromId: function(idNumber) {
        if (!idNumber || idNumber.length < 6) return null;
        try {
            var yy = parseInt(idNumber.substring(0, 2), 10);
            var mm = parseInt(idNumber.substring(2, 4), 10);
            var dd = parseInt(idNumber.substring(4, 6), 10);
            if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
            var year = yy > 30 ? 1900 + yy : 2000 + yy;
            var today = new Date();
            var age = today.getFullYear() - year;
            var monthDiff = (today.getMonth() + 1) - mm;
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dd)) age--;
            return (age >= 0 && age <= 130) ? age : null;
        } catch(e) { return null; }
    },

    // ---- Conclusion ----
    generateConclusion: function(calc, employee) {
        var method = employee.payment_method || 'EFT';
        return 'Your total net pay after all deductions is ' + this.formatMoney(calc.net) + '. This amount will be paid via ' + method + '.';
    },

    // ---- Format as HTML ----
    formatAsHTML: function(narrative) {
        var html = '<div class="payslip-narrative">';

        // Greeting + Summary
        html += '<div class="narrative-greeting">' + narrative.greeting + ',</div>';
        html += '<div class="narrative-summary">' + narrative.summary + '</div>';

        // Comparison
        if (narrative.comparison.changes.length > 0) {
            html += '<div class="narrative-section">';
            html += '<h4>Changes from Last Month</h4>';
            html += '<ul class="narrative-changes">';
            narrative.comparison.changes.forEach(function(change) {
                var cls = change.amount > 0 ? 'change-increase' : 'change-decrease';
                html += '<li class="' + cls + '">';
                html += '<strong>' + change.text + '</strong>';
                if (change.reason) html += '<br><span class="change-reason">' + change.reason + '</span>';
                html += '</li>';
            });
            html += '</ul>';
            html += '<div class="narrative-overall">' + narrative.comparison.text + '</div>';
            html += '</div>';
        } else {
            html += '<div class="narrative-section"><p>' + narrative.comparison.text + '</p></div>';
        }

        // Breakdown
        html += '<div class="narrative-section">';
        html += '<h4>Payslip Breakdown</h4>';
        var grouped = this.groupBy(narrative.breakdown, 'category');
        var self = this;
        Object.keys(grouped).forEach(function(category) {
            html += '<div class="breakdown-category">';
            html += '<h5>' + category + '</h5>';
            grouped[category].forEach(function(item) {
                var amountClass = item.type === 'deduction' ? 'amount-deduction' : 'amount-earning';
                html += '<div class="breakdown-item">';
                html += '<span class="item-name">' + item.name + '</span>';
                html += '<span class="item-amount ' + amountClass + '">' + (item.type === 'deduction' ? '- ' : '') + self.formatMoney(item.amount) + '</span>';
                html += '</div>';
                html += '<div class="item-description">' + item.description + '</div>';
            });
            html += '</div>';
        });
        html += '</div>';

        // Tax Explanation
        html += '<div class="narrative-section">';
        html += '<h4>Tax Information</h4>';
        html += '<p>' + narrative.taxExplanation + '</p>';
        html += '</div>';

        // Conclusion
        html += '<div class="narrative-conclusion">' + narrative.conclusion + '</div>';
        html += '</div>';

        return html;
    },

    // ---- Format as Text (for PDF/print) ----
    formatAsText: function(narrative) {
        var text = narrative.greeting + ',\n\n';
        text += narrative.summary + '\n\n';

        if (narrative.comparison.changes.length > 0) {
            text += 'CHANGES FROM LAST MONTH:\n';
            narrative.comparison.changes.forEach(function(change) {
                text += '  - ' + change.text;
                if (change.reason) text += ' ' + change.reason;
                text += '\n';
            });
            text += '\n' + narrative.comparison.text + '\n\n';
        }

        text += 'BREAKDOWN:\n';
        var grouped = this.groupBy(narrative.breakdown, 'category');
        var self = this;
        Object.keys(grouped).forEach(function(category) {
            text += '\n' + category + ':\n';
            grouped[category].forEach(function(item) {
                text += '  ' + item.name + ': ' + self.formatMoney(item.amount) + '\n';
            });
        });

        text += '\nTAX INFORMATION:\n' + narrative.taxExplanation + '\n\n';
        text += narrative.conclusion;

        return text;
    },

    // ---- Helpers ----
    groupBy: function(array, property) {
        return array.reduce(function(acc, obj) {
            var key = obj[property];
            if (!acc[key]) acc[key] = [];
            acc[key].push(obj);
            return acc;
        }, {});
    },

    formatMoney: function(amount) {
        return 'R' + (amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },

    // ---- Storage ----
    save: function(companyId, empId, period, narrative) {
        var key = 'narrative_' + companyId + '_' + empId + '_' + period;
        safeLocalStorage.setItem(key, JSON.stringify(narrative));
    },

    load: function(companyId, empId, period) {
        var key = 'narrative_' + companyId + '_' + empId + '_' + period;
        var stored = safeLocalStorage.getItem(key);
        return stored ? JSON.parse(stored) : null;
    },

    clear: function(companyId, empId, period) {
        var key = 'narrative_' + companyId + '_' + empId + '_' + period;
        safeLocalStorage.removeItem(key);
    }
};
