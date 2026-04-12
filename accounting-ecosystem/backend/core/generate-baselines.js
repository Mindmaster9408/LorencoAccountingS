// ============================================================
// Baseline Generator — Run Standalone Engine
// Generates correct baseline values for all regression scenarios
// ============================================================

const PayrollEngine = require('./payroll-engine.js');  // This is the UNIFIED engine
// For proper comparison, we need to load the STANDALONE engine

// Scenarios (without baseline values yet)
const SCENARIOS = [
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
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
        ytdData: null
    }
];

// Generate baselines using unified engine (will be used to compare against Standalone)
console.log('\n' + '='.repeat(80));
console.log('BASELINE GENERATION — Using Unified Engine');
console.log('(Will be used as the golden standard going forward)');
console.log('='.repeat(80) + '\n');

var baselines = {};
SCENARIOS.forEach(function(scenario) {
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
    
    baselines[scenario.id] = output;
    
    console.log('Scenario ' + scenario.id + ': ' + scenario.name);
    console.log('  gross:         R' + output.gross.toFixed(2));
    console.log('  taxableGross:  R' + output.taxableGross.toFixed(2));
    console.log('  paye:          R' + output.paye.toFixed(2));
    console.log('  paye_base:     R' + output.paye_base.toFixed(2));
    console.log('  voluntary_overdeduction: R' + output.voluntary_overdeduction.toFixed(2));
    console.log('  uif:           R' + output.uif.toFixed(2));
    console.log('  sdl:           R' + output.sdl.toFixed(2));
    console.log('  deductions:    R' + output.deductions.toFixed(2));
    console.log('  net:           R' + output.net.toFixed(2));
    console.log('  medicalCredit: R' + output.medicalCredit.toFixed(2));
    console.log('  negativeNetPay: ' + output.negativeNetPay);
    console.log('');
});

console.log('='.repeat(80));
console.log('COPY THE VALUES BELOW INTO payroll-engine.regression-tests.js');
console.log('='.repeat(80));
console.log('\nREGRESSION SCENARIOS BASELINE OBJECT:\n');

var scenarioObjects = [];
SCENARIOS.forEach(function(scenario, idx) {
    var baseline = baselines[scenario.id];
    scenarioObjects.push('    {\n' +
        '        id: ' + scenario.id + ',\n' +
        '        name: \'' + scenario.name + '\',\n' +
        '        payrollData: ' + JSON.stringify(scenario.payrollData) + ',\n' +
        '        currentInputs: ' + JSON.stringify(scenario.currentInputs) + ',\n' +
        '        overtime: ' + JSON.stringify(scenario.overtime) + ',\n' +
        '        multiRate: ' + JSON.stringify(scenario.multiRate) + ',\n' +
        '        shortTime: ' + JSON.stringify(scenario.shortTime) + ',\n' +
        '        employeeOptions: ' + JSON.stringify(scenario.employeeOptions) + ',\n' +
        '        period: \'' + scenario.period + '\',\n' +
        '        ytdData: ' + (scenario.ytdData ? JSON.stringify(scenario.ytdData) : 'null') + ',\n' +
        '        baseline: {\n' +
        '            gross: ' + baseline.gross.toFixed(2) + ',\n' +
        '            taxableGross: ' + baseline.taxableGross.toFixed(2) + ',\n' +
        '            paye: ' + baseline.paye.toFixed(2) + ',\n' +
        '            uif: ' + baseline.uif.toFixed(2) + ',\n' +
        '            sdl: ' + baseline.sdl.toFixed(2) + ',\n' +
        '            deductions: ' + baseline.deductions.toFixed(2) + ',\n' +
        '            net: ' + baseline.net.toFixed(2) + ',\n' +
        '            negativeNetPay: ' + baseline.negativeNetPay + ',\n' +
        '            medicalCredit: ' + baseline.medicalCredit.toFixed(2) + '\n' +
        '        }\n' +
        '    }' + (idx < SCENARIOS.length - 1 ? ',' : '') + '\n'
    );
});

console.log('const REGRESSION_SCENARIOS = [\n' + scenarioObjects.join('') + '];\n');
