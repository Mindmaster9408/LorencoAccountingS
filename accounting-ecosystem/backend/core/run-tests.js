// ============================================================
// Regression Test Runner (Node.js) + Pro-Rata Tests
// STEP 5: Unified engine with pro-rata implementation
// ============================================================

const PayrollEngine = require('./payroll-engine.js');
const {
    runRegressionTests,
    runProRataTests,
    formatRegressionReport,
    formatProRataReport
} = require('./payroll-engine.regression-tests.js');

console.log('\n' + '='.repeat(70));
console.log('PAYROLL ENGINE TEST SUITE — STEP 5 PRO-RATA IMPLEMENTATION');
console.log('='.repeat(70));

// Run regression tests (verify no regression on unchanged scenarios)
console.log('\n📊 Running REGRESSION tests (unchanged full-month scenarios)...');
const regressionResults = runRegressionTests(PayrollEngine);
console.log(formatRegressionReport(regressionResults));

// Run pro-rata tests (new scenarios for pro-rata functionality)
console.log('\n📊 Running PRO-RATA tests (new functionality)...');
const prorataResults = runProRataTests(PayrollEngine);
console.log(formatProRataReport(prorataResults));

// Summary
console.log('\n' + '='.repeat(70));
console.log('OVERALL TEST SUMMARY');
console.log('='.repeat(70));
console.log('Regression Tests: ' + regressionResults.passed + '/' + regressionResults.total + ' PASSED');
console.log('Pro-Rata Tests:   ' + prorataResults.passed + '/' + prorataResults.total + ' PASSED');

const totalPassed = regressionResults.passed + prorataResults.passed;
const totalTests = regressionResults.total + prorataResults.total;
console.log('');
console.log('TOTAL: ' + totalPassed + '/' + totalTests + ' PASSED');

if (regressionResults.failed > 0 || prorataResults.failed > 0) {
    console.log('\n❌ SOME TESTS FAILED');
    process.exit(1);
} else {
    console.log('\n✅ ALL TESTS PASSED');
    process.exit(0);
}

// Exit with appropriate status
process.exit(testResults.failed > 0 ? 1 : 0);
