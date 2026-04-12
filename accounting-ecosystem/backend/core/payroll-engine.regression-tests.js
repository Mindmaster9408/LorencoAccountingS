// ============================================================
// PayrollEngine Regression Test Suite
// STEP 3: Verify unified engine matches Standalone baseline
// ============================================================

/**
 * Regression Test Scenarios
 * These 10 scenarios capture the core calculation paths.
 * Each baseline was run through the Standalone engine and locked.
 * The unified engine must return identical values (±0.01 tolerance).
 */

const REGRESSION_SCENARIOS = [
    {
        id: 1,
        name: 'Full-month salary only (basic)',
        payrollData: { basic_salary: 20000, regular_inputs: [] },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 1 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 20000.00,
            taxableGross: 20000.00,
            paye: 1819.06,
            uif: 177.12,
            sdl: 200.00,
            deductions: 0.00,
            net: 18003.82,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    },
    {
        id: 2,
        name: 'Full-month + 8 hours overtime @ 1.5x',
        payrollData: { basic_salary: 20000, regular_inputs: [], workSchedule: null },
        currentInputs: [],
        overtime: [{ hours: 8, rate_multiplier: 1.5 }],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 1 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 21384.68,
            taxableGross: 21384.68,
            paye: 2179.08,
            uif: 177.12,
            sdl: 213.85,
            deductions: 0.00,
            net: 19028.48,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    },
    {
        id: 3,
        name: 'Full-month + short-time 10 hours',
        payrollData: { basic_salary: 20000, regular_inputs: [], workSchedule: null },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [{ hours_missed: 10 }],
        employeeOptions: { age: 35, medicalMembers: 1 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 18846.10,
            taxableGross: 18846.10,
            paye: 1592.05,
            uif: 177.12,
            sdl: 188.46,
            deductions: 0.00,
            net: 17076.93,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    },
    {
        id: 4,
        name: 'Zero medical credits (OPT/uninsured)',
        payrollData: { basic_salary: 20000, regular_inputs: [] },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 0 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 20000.00,
            taxableGross: 20000.00,
            paye: 2183.06,
            uif: 177.12,
            sdl: 200.00,
            deductions: 0.00,
            net: 17639.82,
            negativeNetPay: false,
            medicalCredit: 0.00
        }
    },
    {
        id: 5,
        name: 'Tax directive override (15% flat)',
        payrollData: { basic_salary: 20000, regular_inputs: [] },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 1, taxDirective: 15 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 20000.00,
            taxableGross: 20000.00,
            paye: 3000.00,
            uif: 177.12,
            sdl: 200.00,
            deductions: 0.00,
            net: 16822.88,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    },
    {
        id: 6,
        name: 'Multiple medical members (3 people)',
        payrollData: { basic_salary: 20000, regular_inputs: [] },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 3 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 20000.00,
            taxableGross: 20000.00,
            paye: 1209.06,
            uif: 177.12,
            sdl: 200.00,
            deductions: 0.00,
            net: 18613.82,
            negativeNetPay: false,
            medicalCredit: 974.00
        }
    },
    {
        id: 7,
        name: 'Age >= 65 (secondary rebate)',
        payrollData: { basic_salary: 20000, regular_inputs: [] },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 67, medicalMembers: 1 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 20000.00,
            taxableGross: 20000.00,
            paye: 1032.06,
            uif: 177.12,
            sdl: 200.00,
            deductions: 0.00,
            net: 18790.82,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    },
    {
        id: 8,
        name: 'Mixed taxable + non-taxable inputs',
        payrollData: { basic_salary: 18000, regular_inputs: [{ type: 'allowance', amount: 1000, is_taxable: false }, { type: 'allowance', amount: 500, is_taxable: true }] },
        currentInputs: [],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 1 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 19500.00,
            taxableGross: 18500.00,
            paye: 1529.75,
            uif: 177.12,
            sdl: 195.00,
            deductions: 0.00,
            net: 17793.13,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    },
    {
        id: 9,
        name: 'Zero salary (edge case)',
        payrollData: { basic_salary: 0, regular_inputs: [] },
        currentInputs: [{ type: 'allowance', amount: 5000, is_taxable: true }],
        overtime: [],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 0 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 5000.00,
            taxableGross: 5000.00,
            paye: 0.00,
            uif: 50.00,
            sdl: 50.00,
            deductions: 0.00,
            net: 4950.00,
            negativeNetPay: false,
            medicalCredit: 0.00
        }
    },
    {
        id: 10,
        name: 'High overtime (24 hours @ 1.5x)',
        payrollData: { basic_salary: 20000, regular_inputs: [], workSchedule: null },
        currentInputs: [],
        overtime: [{ hours: 24, rate_multiplier: 1.5 }],
        multiRate: [],
        shortTime: [],
        employeeOptions: { age: 35, medicalMembers: 1 },
        period: '2026-04',
        ytdData: null,
        baseline: {
            gross: 24154.04,
            taxableGross: 24154.04,
            paye: 2899.11,
            uif: 177.12,
            sdl: 241.54,
            deductions: 0.00,
            net: 21077.81,
            negativeNetPay: false,
            medicalCredit: 364.00
        }
    }
];

/**
 * Run regression tests: compare unified engine output vs baseline
 * @param {Object} PayrollEngine - The unified engine module
 * @returns {Object} { passed, failed, total, results: [] }
 */
function runRegressionTests(PayrollEngine) {
    var results = [];
    var passed = 0, failed = 0;
    var tolerance = 0.01;

    REGRESSION_SCENARIOS.forEach(function(scenario) {
        var output = PayrollEngine.calculateFromData(
            scenario.payrollData,
            scenario.currentInputs,
            scenario.overtime,
            scenario.multiRate,
            scenario.shortTime,
            scenario.employeeOptions,
            scenario.period,
            scenario.ytdData
        );

        var mismatches = [];
        var testPassed = true;

        // Check each output field against baseline (with tolerance)
        var fieldsToCheck = ['gross', 'taxableGross', 'paye', 'uif', 'sdl', 'deductions', 'net', 'medicalCredit'];
        fieldsToCheck.forEach(function(field) {
            var expectedVal = scenario.baseline[field];
            var actualVal = output[field];
            if (Math.abs(actualVal - expectedVal) > tolerance) {
                testPassed = false;
                mismatches.push({
                    field: field,
                    expected: expectedVal,
                    actual: actualVal,
                    diff: actualVal - expectedVal
                });
            }
        });

        if (testPassed) {
            passed++;
        } else {
            failed++;
        }

        results.push({
            id: scenario.id,
            name: scenario.name,
            passed: testPassed,
            mismatches: mismatches
        });
    });

    return {
        passed: passed,
        failed: failed,
        total: REGRESSION_SCENARIOS.length,
        results: results
    };
}

/**
 * Format regression report for console output
 */
function formatRegressionReport(testResults) {
    var report = [];
    report.push('\n' + '='.repeat(70));
    report.push('PAYROLL ENGINE REGRESSION TEST RESULTS');
    report.push('='.repeat(70));
    report.push('');
    report.push('Test Summary: ' + testResults.passed + '/' + testResults.total + ' PASSED');
    report.push('');

    if (testResults.failed > 0) {
        report.push('⛔ ' + testResults.failed + ' TEST(S) FAILED\n');
    } else {
        report.push('✅ ALL TESTS PASSED — Zero regression detected\n');
    }

    testResults.results.forEach(function(result) {
        var status = result.passed ? '✅ PASS' : '❌ FAIL';
        report.push(status + ' — Scenario ' + result.id + ': ' + result.name);

        if (!result.passed && result.mismatches.length > 0) {
            result.mismatches.forEach(function(m) {
                var diff_str = m.diff > 0 ? '+' + m.diff.toFixed(4) : m.diff.toFixed(4);
                report.push('     ' + m.field + ': expected R' + m.expected.toFixed(2) + ', got R' + m.actual.toFixed(2) + ' (diff: ' + diff_str + ')');
            });
        }
        report.push('');
    });

    report.push('='.repeat(70));
    return report.join('\n');
}

// Export for Node.js test runners
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        REGRESSION_SCENARIOS: REGRESSION_SCENARIOS,
        runRegressionTests: runRegressionTests,
        formatRegressionReport: formatRegressionReport
    };
}
