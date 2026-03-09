// ============================================================
// SeanPayrollHelper — Frontend integration for SEAN AI
// ============================================================
// Provides methods to call SEAN payroll intelligence endpoints
// and display results in the Lorenco Paytime UI.
//
// Uses the same API pattern as DataAccess (Bearer token auth).
// ============================================================

var SeanPayrollHelper = (function() {
    'use strict';

    const API_BASE = window.location.origin + '/api/payroll/sean';

    function getToken() {
        return safeLocalStorage.getItem('token');
    }

    async function apiRequest(method, path, body) {
        const url = API_BASE + path;
        const headers = { 'Content-Type': 'application/json' };
        const token = getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const opts = { method, headers };
        if (body && method !== 'GET') opts.body = JSON.stringify(body);
        const response = await fetch(url, opts);
        if (response.status === 401) {
            safeLocalStorage.removeItem('token');
            window.location.href = 'login.html';
            throw new Error('Session expired');
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'SEAN request failed');
        return data;
    }

    // ─── API Methods ─────────────────────────────────────────────────────

    async function runPreflightChecks(periodId) {
        return apiRequest('POST', '/' + periodId + '/preflight');
    }

    async function getTaxOptimizations() {
        return apiRequest('GET', '/optimize-tax');
    }

    async function getCashFlowForecast(months) {
        return apiRequest('GET', '/forecast/' + (months || 3));
    }

    async function checkCompliance() {
        return apiRequest('GET', '/compliance');
    }

    async function analyzeEmployeeCost(employeeId) {
        return apiRequest('GET', '/employee-cost/' + employeeId);
    }

    async function recordLearning(data) {
        return apiRequest('POST', '/learn', data);
    }

    // ─── UI Display Methods ──────────────────────────────────────────────

    function showLoading(containerId, message) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '<div style="text-align:center;padding:30px;color:#667eea;">' +
            '<div style="font-size:2rem;margin-bottom:10px;">🧠</div>' +
            '<div style="font-weight:600;">' + (message || 'SEAN is analyzing...') + '</div>' +
            '<div style="margin-top:10px;"><div class="sean-spinner"></div></div></div>';
        container.style.display = 'block';
    }

    function displayPreflightResults(checks, containerId) {
        const container = document.getElementById(containerId || 'sean-results');
        if (!container) return;

        let html = '<div class="sean-panel">';
        html += '<h3 style="margin-bottom:15px;">🧠 SEAN Pre-Flight Checks</h3>';

        // Summary bar
        const s = checks.summary;
        html += '<div class="sean-summary-bar">';
        html += '<span class="sean-stat green">' + s.passed + ' Passed</span>';
        if (s.errors > 0) html += '<span class="sean-stat red">' + s.errors + ' Errors</span>';
        if (s.warnings > 0) html += '<span class="sean-stat orange">' + s.warnings + ' Warnings</span>';
        html += '</div>';

        if (checks.canProcess) {
            html += '<div class="sean-alert success">✅ All critical checks passed — safe to process payroll</div>';
        } else {
            html += '<div class="sean-alert error">❌ Critical errors detected — fix before processing</div>';
        }

        // Errors
        if (checks.errors.length > 0) {
            html += '<div class="sean-section"><h4 style="color:#e53e3e;">Errors</h4>';
            checks.errors.forEach(function(err) {
                html += '<div class="sean-item error">';
                html += '<div class="sean-item-header"><span class="severity-badge ' + err.severity.toLowerCase() + '">' + err.severity + '</span> ' + err.type.replace(/_/g, ' ') + '</div>';
                html += '<div class="sean-item-body">' + err.message + '</div>';
                if (err.employees && err.employees.length > 0) {
                    html += '<div class="sean-employees">';
                    err.employees.forEach(function(emp) {
                        html += '<span class="emp-chip">' + (emp.name || emp.id) + '</span>';
                    });
                    html += '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        }

        // Warnings
        if (checks.warnings.length > 0) {
            html += '<div class="sean-section"><h4 style="color:#dd6b20;">Warnings</h4>';
            checks.warnings.forEach(function(warn) {
                html += '<div class="sean-item warning">';
                html += '<div class="sean-item-header"><span class="severity-badge ' + warn.severity.toLowerCase() + '">' + warn.severity + '</span> ' + warn.type.replace(/_/g, ' ') + '</div>';
                html += '<div class="sean-item-body">' + warn.message + '</div>';
                if (warn.employees && warn.employees.length > 0) {
                    html += '<div class="sean-employees">';
                    warn.employees.forEach(function(emp) {
                        html += '<span class="emp-chip">' + (emp.name || emp.id) + '</span>';
                    });
                    html += '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';
    }

    function displayTaxOptimizations(data, containerId) {
        const container = document.getElementById(containerId || 'sean-results');
        if (!container) return;

        let html = '<div class="sean-panel">';
        html += '<h3 style="margin-bottom:15px;">🧠 Tax Optimization Suggestions</h3>';

        if (data.totalSuggestions === 0) {
            html += '<div class="sean-alert success">✅ No optimization opportunities found — current tax structure is efficient</div>';
        } else {
            html += '<div class="sean-summary-bar">';
            html += '<span class="sean-stat green">' + data.totalSuggestions + ' Suggestions</span>';
            html += '<span class="sean-stat blue">R' + formatMoney(data.totalSavingsPerMonth) + '/month potential savings</span>';
            html += '<span class="sean-stat purple">R' + formatMoney(data.totalSavingsPerYear) + '/year potential savings</span>';
            html += '</div>';

            data.suggestions.forEach(function(s) {
                html += '<div class="sean-item info">';
                html += '<div class="sean-item-header"><span class="severity-badge info">' + s.type.replace(/_/g, ' ') + '</span>';
                if (s.employee) html += ' — ' + s.employee;
                if (s.employees) html += ' — ' + s.employees + ' employees';
                html += '</div>';
                html += '<div class="sean-item-body">' + s.explanation + '</div>';
                if (s.current) html += '<div style="margin-top:5px;font-size:0.85rem;"><strong>Current:</strong> ' + s.current + '</div>';
                if (s.suggested) html += '<div style="font-size:0.85rem;"><strong>Suggested:</strong> ' + s.suggested + '</div>';
                html += '<div style="margin-top:8px;font-weight:600;color:#38a169;">💰 Savings: R' + formatMoney(s.savingsPerMonth) + '/month (R' + formatMoney(s.savingsPerYear) + '/year)</div>';
                if (s.legal) html += '<div style="font-size:0.8rem;color:#667eea;margin-top:3px;">✅ Fully legal & SARS compliant</div>';
                html += '</div>';
            });
        }

        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';
    }

    function displayCashFlowForecast(data, containerId) {
        const container = document.getElementById(containerId || 'sean-results');
        if (!container) return;

        let html = '<div class="sean-panel">';
        html += '<h3 style="margin-bottom:15px;">🧠 Cash Flow Forecast</h3>';

        html += '<div class="sean-summary-bar">';
        html += '<span class="sean-stat blue">' + data.employeeCount + ' Employees</span>';
        html += '<span class="sean-stat green">R' + formatMoney(data.currentMonthly) + '/month current</span>';
        html += '<span class="sean-stat purple">R' + formatMoney(data.totalNeeded) + ' total needed</span>';
        html += '</div>';

        // Forecast table
        html += '<table class="sean-table"><thead><tr>';
        html += '<th>Month</th><th>Predicted</th><th>Base</th><th>Employer Costs</th><th>Overtime</th><th>Bonuses</th><th>Confidence</th>';
        html += '</tr></thead><tbody>';

        data.forecast.forEach(function(f) {
            html += '<tr' + (f.isBonus ? ' style="background:#fef3c7;"' : '') + '>';
            html += '<td><strong>' + f.monthName + '</strong></td>';
            html += '<td style="font-weight:700;color:#2d3748;">R' + formatMoney(f.predictedAmount) + '</td>';
            html += '<td>R' + formatMoney(f.breakdown.baseSalaries) + '</td>';
            html += '<td>R' + formatMoney(f.breakdown.employerCosts) + '</td>';
            html += '<td>R' + formatMoney(f.breakdown.overtime) + '</td>';
            html += '<td>' + (f.breakdown.bonuses > 0 ? 'R' + formatMoney(f.breakdown.bonuses) + ' 🎄' : '—') + '</td>';
            html += '<td><div class="confidence-bar"><div class="confidence-fill" style="width:' + f.confidence + '%;background:' + (f.confidence > 80 ? '#38a169' : f.confidence > 60 ? '#dd6b20' : '#e53e3e') + ';"></div><span>' + f.confidence + '%</span></div></td>';
            html += '</tr>';
        });

        html += '</tbody></table>';

        // Patterns
        if (data.patterns) {
            html += '<div style="margin-top:15px;padding:12px;background:#f7fafc;border-radius:8px;font-size:0.85rem;">';
            html += '<strong>Patterns Detected:</strong> ';
            html += 'Annual increase: ' + data.patterns.annualIncrease + ' | ';
            html += 'Bonus: ' + data.patterns.bonusMonth + ' | ';
            html += 'Overtime avg: ' + data.patterns.avgOvertime + ' | ';
            html += 'Employer costs: ' + data.patterns.employerCosts;
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';
    }

    function displayComplianceReport(data, containerId) {
        const container = document.getElementById(containerId || 'sean-results');
        if (!container) return;

        let html = '<div class="sean-panel">';
        html += '<h3 style="margin-bottom:15px;">🧠 SA Labour Law Compliance</h3>';

        // Summary
        const s = data.summary;
        html += '<div class="sean-summary-bar">';
        if (data.compliant) {
            html += '<span class="sean-stat green">✅ COMPLIANT</span>';
        } else {
            html += '<span class="sean-stat red">⚠️ NON-COMPLIANT</span>';
        }
        if (s.critical > 0) html += '<span class="sean-stat red">' + s.critical + ' Critical</span>';
        if (s.high > 0) html += '<span class="sean-stat orange">' + s.high + ' High</span>';
        if (s.medium > 0) html += '<span class="sean-stat yellow">' + s.medium + ' Medium</span>';
        if (s.low > 0) html += '<span class="sean-stat green">' + s.low + ' Low</span>';
        html += '</div>';

        // Violations
        if (data.violations.length > 0) {
            html += '<div class="sean-section"><h4 style="color:#e53e3e;">⚖️ Violations</h4>';
            data.violations.forEach(function(v) {
                html += '<div class="sean-item error">';
                html += '<div class="sean-item-header"><span class="severity-badge ' + v.severity.toLowerCase() + '">' + v.severity + '</span> ' + v.law + '</div>';
                html += '<div style="font-size:0.8rem;color:#667eea;margin:3px 0;">' + v.section + '</div>';
                html += '<div class="sean-item-body">' + v.violation + '</div>';
                html += '<div style="margin-top:5px;font-size:0.85rem;color:#e53e3e;">⚠️ Penalty: ' + v.penalty + '</div>';
                html += '<div style="margin-top:3px;font-size:0.85rem;color:#38a169;">✅ Action: ' + v.action + '</div>';
                if (v.employees && v.employees.length > 0) {
                    html += '<div class="sean-employees">';
                    v.employees.forEach(function(emp) { html += '<span class="emp-chip">' + (emp.name || emp.id) + '</span>'; });
                    html += '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        }

        // Warnings
        if (data.warnings.length > 0) {
            html += '<div class="sean-section"><h4 style="color:#dd6b20;">⚠️ Warnings</h4>';
            data.warnings.forEach(function(w) {
                html += '<div class="sean-item warning">';
                html += '<div class="sean-item-header"><span class="severity-badge ' + w.severity.toLowerCase() + '">' + w.severity + '</span> ' + w.law + '</div>';
                html += '<div style="font-size:0.8rem;color:#667eea;margin:3px 0;">' + w.section + '</div>';
                html += '<div class="sean-item-body">' + w.issue + '</div>';
                html += '<div style="margin-top:3px;font-size:0.85rem;color:#38a169;">✅ Action: ' + w.action + '</div>';
                html += '</div>';
            });
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';
    }

    function displayEmployeeCost(data, containerId) {
        const container = document.getElementById(containerId || 'sean-results');
        if (!container) return;

        let html = '<div class="sean-panel">';
        html += '<h3 style="margin-bottom:15px;">🧠 Employee Cost Analysis — ' + data.employee.name + '</h3>';

        html += '<div class="sean-summary-bar">';
        html += '<span class="sean-stat blue">R' + formatMoney(data.totalMonthlyCost) + '/month</span>';
        html += '<span class="sean-stat purple">R' + formatMoney(data.totalAnnualCost) + '/year</span>';
        html += '<span class="sean-stat green">R' + formatMoney(data.costPerDay) + '/day</span>';
        html += '<span class="sean-stat orange">' + data.comparison.trueCostMultiplier + ' of basic</span>';
        html += '</div>';

        // Breakdown
        html += '<table class="sean-table"><thead><tr><th>Cost Component</th><th>Monthly Amount</th><th>% of Total</th></tr></thead><tbody>';
        var b = data.breakdown;
        var items = [
            ['Basic Salary', b.basicSalary], ['Overtime (avg)', b.overtime],
            ['Allowances', b.allowances], ['UIF (Employer)', b.uifEmployer],
            ['SDL', b.sdl], ['Workers Comp', b.workersComp],
            ['Medical Aid', b.medicalAid], ['Pension/Retirement', b.pension],
            ['Leave Provision', b.leaveProvision], ['Equipment', b.equipment],
            ['Training', b.training]
        ];
        items.forEach(function(item) {
            var pct = data.totalMonthlyCost > 0 ? (item[1] / data.totalMonthlyCost * 100).toFixed(1) : '0';
            html += '<tr><td>' + item[0] + '</td><td>R' + formatMoney(item[1]) + '</td><td>' + pct + '%</td></tr>';
        });
        html += '<tr style="font-weight:700;background:#f0f4ff;"><td>TOTAL</td><td>R' + formatMoney(data.totalMonthlyCost) + '</td><td>100%</td></tr>';
        html += '</tbody></table>';

        // Market comparison
        if (data.comparison.market) {
            var m = data.comparison.market;
            var posColor = m.position === 'WITHIN_RANGE' ? '#38a169' : m.position === 'BELOW_MARKET' ? '#dd6b20' : '#e53e3e';
            html += '<div style="margin-top:15px;padding:12px;background:#f7fafc;border-radius:8px;">';
            html += '<strong>Market Comparison:</strong> ';
            html += '<span style="color:' + posColor + ';font-weight:600;">' + m.position.replace(/_/g, ' ') + '</span>';
            html += ' (Market range: R' + formatMoney(m.marketRangeMin) + ' – R' + formatMoney(m.marketRangeMax) + ')';
            html += '</div>';
        }

        // Insight
        if (data.insight) {
            html += '<div style="margin-top:10px;padding:12px;background:#ebf8ff;border-radius:8px;border-left:4px solid #667eea;">';
            html += '💡 ' + data.insight;
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';
    }

    function formatMoney(amount) {
        return Math.round(amount || 0).toLocaleString('en-ZA');
    }

    function closeSeanPanel() {
        var container = document.getElementById('sean-results');
        if (container) {
            container.innerHTML = '';
            container.style.display = 'none';
        }
    }

    // ─── Public API ──────────────────────────────────────────────────────

    return {
        runPreflightChecks: runPreflightChecks,
        getTaxOptimizations: getTaxOptimizations,
        getCashFlowForecast: getCashFlowForecast,
        checkCompliance: checkCompliance,
        analyzeEmployeeCost: analyzeEmployeeCost,
        recordLearning: recordLearning,
        showLoading: showLoading,
        displayPreflightResults: displayPreflightResults,
        displayTaxOptimizations: displayTaxOptimizations,
        displayCashFlowForecast: displayCashFlowForecast,
        displayComplianceReport: displayComplianceReport,
        displayEmployeeCost: displayEmployeeCost,
        closeSeanPanel: closeSeanPanel
    };

})();
