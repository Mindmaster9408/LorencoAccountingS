// ============================================================
// Regression Test Runner (Node.js)
// ============================================================

const PayrollEngine = require('./payroll-engine.js');
const {
    runRegressionTests,
    formatRegressionReport
} = require('./payroll-engine.regression-tests.js');

// Run the tests
const testResults = runRegressionTests(PayrollEngine);

// Output the formatted report
console.log(formatRegressionReport(testResults));

// Output JSON for programmatic processing
console.log('\nJSON RESULTS:');
console.log(JSON.stringify(testResults, null, 2));

// Exit with appropriate status
process.exit(testResults.failed > 0 ? 1 : 0);
