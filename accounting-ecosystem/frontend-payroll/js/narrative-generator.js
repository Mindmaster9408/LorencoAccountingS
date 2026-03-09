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
            taxExplanation: this.generateTaxExplanation(currentCalc),
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
            description: 'Income tax withheld based on South African 2024/25 tax brackets. This is paid to SARS on your behalf.',
            type: 'deduction'
        });

        items.push({
            category: 'Statutory Deductions',
            name: 'UIF (Unemployment Insurance)',
            amount: calc.uif,
            description: 'Unemployment insurance contribution at 1% of gross salary' + (calc.uif >= 177.12 ? ' (capped at R177.12/month)' : '') + '. Your employer also contributes 1%.',
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
    generateTaxExplanation: function(calc) {
        var annualGross = calc.gross * 12;
        var bracket = '';
        var rate = '';

        if (annualGross <= 237100) {
            bracket = 'R0 - R237,100'; rate = '18%';
        } else if (annualGross <= 370500) {
            bracket = 'R237,101 - R370,500'; rate = '26%';
        } else if (annualGross <= 512800) {
            bracket = 'R370,501 - R512,800'; rate = '31%';
        } else if (annualGross <= 673000) {
            bracket = 'R512,801 - R673,000'; rate = '36%';
        } else if (annualGross <= 857900) {
            bracket = 'R673,001 - R857,900'; rate = '39%';
        } else if (annualGross <= 1817000) {
            bracket = 'R857,901 - R1,817,000'; rate = '41%';
        } else {
            bracket = 'Above R1,817,000'; rate = '45%';
        }

        var text = 'Based on your monthly gross of ' + this.formatMoney(calc.gross) + ', your annualized income is ' + this.formatMoney(annualGross) + '. ';
        text += 'Your marginal tax rate is ' + rate + ' (bracket: ' + bracket + '). ';
        text += 'A primary rebate of R17,235 is applied annually, reducing your effective tax. ';
        text += 'Your UIF contribution is 1% of gross' + (calc.uif >= 177.12 ? ', capped at the maximum of R177.12 per month' : '') + '.';

        return text;
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
