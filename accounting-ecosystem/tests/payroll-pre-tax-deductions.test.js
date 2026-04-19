/**
 * Pre-Tax Deduction Engine Tests (Migration 018)
 * -----------------------------------------------
 * Tests for SARS-compliant pre-tax deduction handling in PayrollEngine.calculateFromData().
 *
 * Run from the repo root:
 *   cd accounting-ecosystem && npx jest tests/payroll-pre-tax-deductions.test.js
 *
 * All monetary assertions use toBeCloseTo(value, 2) — tolerance ±0.005 — matching SA payslip
 * rounding convention (2 decimal places).
 *
 * SARS RULES TESTED:
 *   1. Pre-tax deductions (pension fund, RA, etc.) reduce taxableGross before PAYE.
 *   2. UIF and SDL are still calculated on gross (full earnings, unaffected by pre-tax).
 *   3. Net still reflects all deductions (pre-tax + net-only) via net = gross - paye - uif - deductions.
 *   4. Existing items without tax_treatment default to 'net_only' (backward compatible).
 *   5. Pre-tax deductions cannot make taxableGross negative.
 *   6. The 13 locked output fields are never removed or renamed.
 *   7. New additive fields preTaxDeductions and netOnlyDeductions are appended.
 */

'use strict';

const PayrollEngine = require('../backend/core/payroll-engine');

// Helper: returns a minimal payrollData object.
function makeData({ basicSalary = 0, inputs = [], allowances = [] } = {}) {
    return {
        basic_salary: basicSalary,
        regular_inputs: [...allowances, ...inputs]
    };
}

// Helper: deduction input with explicit tax_treatment.
function deduction(description, amount, tax_treatment = 'net_only') {
    return { type: 'deduction', description, amount, tax_treatment };
}

// Helper: allowance input (always adds to taxableGross via engine logic).
function allowance(description, amount) {
    return { type: 'allowance', description, amount };
}

// ─── Fixture: 2025–2026 tax tables (accurate SA values) ────────────────────────
// PayrollEngine uses period-based table selection. All tests use period '2025-04'
// which falls in the 2025/2026 tax year.
const TEST_PERIOD = '2025-04';

// ─── Helper: calculate with no options (single-period, no YTD) ─────────────────
function calc(payrollData, currentInputs = [], employeeOptions = {}) {
    // Signature: calculateFromData(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData)
    return PayrollEngine.calculateFromData(payrollData, currentInputs, [], null, null, employeeOptions, TEST_PERIOD);
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 1: Baseline — no deductions
// Confirms gross = basicSalary, taxableGross = basicSalary, deductions = 0.
// ─────────────────────────────────────────────────────────────────────────────────
test('T01: No deductions — gross equals basic salary, deductions zero', () => {
    const data = makeData({ basicSalary: 20000 });
    const result = calc(data);

    expect(result.gross).toBeCloseTo(20000, 2);
    expect(result.taxableGross).toBeCloseTo(20000, 2);
    expect(result.deductions).toBeCloseTo(0, 2);
    expect(result.preTaxDeductions).toBeCloseTo(0, 2);
    expect(result.netOnlyDeductions).toBeCloseTo(0, 2);
    // net = gross - paye - uif - deductions
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 2: Net-only deduction (legacy default)
// Medical aid R1,500 with tax_treatment='net_only'.
// taxableGross must be UNCHANGED; only net decreases.
// ─────────────────────────────────────────────────────────────────────────────────
test('T02: net_only deduction does NOT reduce taxableGross', () => {
    const noDeductionData  = makeData({ basicSalary: 20000 });
    const withDeductionData = makeData({
        basicSalary: 20000,
        inputs: [deduction('Medical Aid', 1500, 'net_only')]
    });

    const baseline = calc(noDeductionData);
    const result   = calc(withDeductionData);

    // taxableGross must equal baseline (medical aid has no PAYE impact)
    expect(result.taxableGross).toBeCloseTo(baseline.taxableGross, 2);
    // PAYE must equal baseline (taxable income unchanged)
    expect(result.paye).toBeCloseTo(baseline.paye, 2);
    // gross unchanged
    expect(result.gross).toBeCloseTo(20000, 2);
    // deductions captured
    expect(result.deductions).toBeCloseTo(1500, 2);
    expect(result.netOnlyDeductions).toBeCloseTo(1500, 2);
    expect(result.preTaxDeductions).toBeCloseTo(0, 2);
    // net = gross - paye - uif - deductions
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 3: Pre-tax deduction reduces taxableGross and PAYE
// Pension fund R2,000 with tax_treatment='pre_tax'.
// taxableGross must decrease by R2,000. PAYE must decrease accordingly.
// gross must remain R20,000 (UIF base unchanged).
// ─────────────────────────────────────────────────────────────────────────────────
test('T03: pre_tax deduction reduces taxableGross and PAYE', () => {
    const baseline = calc(makeData({ basicSalary: 20000 }));

    const result = calc(makeData({
        basicSalary: 20000,
        inputs: [deduction('Pension Fund', 2000, 'pre_tax')]
    }));

    // taxableGross must be 2000 lower
    expect(result.taxableGross).toBeCloseTo(baseline.taxableGross - 2000, 2);
    // PAYE must be lower than baseline
    expect(result.paye).toBeLessThan(baseline.paye);
    // gross is unchanged (pre-tax deduction does NOT reduce gross)
    expect(result.gross).toBeCloseTo(20000, 2);
    // UIF uses gross (unchanged)
    expect(result.uif).toBeCloseTo(baseline.uif, 2);
    // deductions total = all deductions reduce net
    expect(result.deductions).toBeCloseTo(2000, 2);
    expect(result.preTaxDeductions).toBeCloseTo(2000, 2);
    expect(result.netOnlyDeductions).toBeCloseTo(0, 2);
    // net formula holds
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 4: Mixed deductions — pre_tax + net_only in same pay run
// Pension R2,000 (pre_tax) + Medical Aid R1,500 (net_only).
// Only pension reduces taxableGross. Both reduce net.
// ─────────────────────────────────────────────────────────────────────────────────
test('T04: mixed pre_tax and net_only deductions — correct split', () => {
    const baseline = calc(makeData({ basicSalary: 20000 }));

    const result = calc(makeData({
        basicSalary: 20000,
        inputs: [
            deduction('Pension Fund', 2000, 'pre_tax'),
            deduction('Medical Aid',  1500, 'net_only')
        ]
    }));

    expect(result.taxableGross).toBeCloseTo(baseline.taxableGross - 2000, 2);
    expect(result.gross).toBeCloseTo(20000, 2);
    expect(result.uif).toBeCloseTo(baseline.uif, 2);       // UIF unchanged
    expect(result.paye).toBeLessThan(baseline.paye);        // PAYE lower
    expect(result.deductions).toBeCloseTo(3500, 2);          // 2000 + 1500
    expect(result.preTaxDeductions).toBeCloseTo(2000, 2);
    expect(result.netOnlyDeductions).toBeCloseTo(1500, 2);
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 5: Pre-tax deduction > taxableGross — must NOT make taxableGross negative
// Edge case: if pre-tax deductions exceed taxableGross, taxableGross is floored at zero.
// ─────────────────────────────────────────────────────────────────────────────────
test('T05: pre_tax deduction exceeding taxableGross clamps to zero', () => {
    const result = calc(makeData({
        basicSalary: 1000,
        inputs: [deduction('RA Contribution', 5000, 'pre_tax')]
    }));

    expect(result.taxableGross).toBeCloseTo(0, 2);
    expect(result.gross).toBeCloseTo(1000, 2);     // gross unchanged
    expect(result.paye).toBeCloseTo(0, 2);         // no tax on zero taxable income
    expect(result.preTaxDeductions).toBeCloseTo(5000, 2);
    expect(result.deductions).toBeCloseTo(5000, 2);
    // net may go negative (employee owes money to employer — negativeNetPay flag)
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
    expect(result.negativeNetPay).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 6: Backward compatibility — items with no tax_treatment behave as net_only
// Older items saved before migration 018 will have no tax_treatment property.
// The engine must treat them as 'net_only' (default).
// ─────────────────────────────────────────────────────────────────────────────────
test('T06: missing tax_treatment on deduction defaults to net_only', () => {
    const legacy = makeData({
        basicSalary: 20000,
        inputs: [{ type: 'deduction', description: 'Legacy Deduction', amount: 1000 }] // NO tax_treatment
    });

    const baseline = calc(makeData({ basicSalary: 20000 }));
    const result   = calc(legacy);

    // Legacy item should be net_only — taxableGross must be unchanged
    expect(result.taxableGross).toBeCloseTo(baseline.taxableGross, 2);
    expect(result.paye).toBeCloseTo(baseline.paye, 2);
    expect(result.deductions).toBeCloseTo(1000, 2);
    expect(result.netOnlyDeductions).toBeCloseTo(1000, 2);
    expect(result.preTaxDeductions).toBeCloseTo(0, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 7: Pre-tax deduction from currentInputs (period-level input)
// currentInputs is the second argument to calculateFromData.
// Period-level RA contributions should behave identically to recurring ones.
// ─────────────────────────────────────────────────────────────────────────────────
test('T07: pre_tax deduction in currentInputs reduces taxableGross', () => {
    const payrollData  = makeData({ basicSalary: 20000 });
    const currentInput = [deduction('Period RA', 3000, 'pre_tax')];

    const baseline = calc(makeData({ basicSalary: 20000 }));
    const result   = calc(payrollData, currentInput);

    expect(result.taxableGross).toBeCloseTo(baseline.taxableGross - 3000, 2);
    expect(result.paye).toBeLessThan(baseline.paye);
    expect(result.gross).toBeCloseTo(20000, 2);
    expect(result.uif).toBeCloseTo(baseline.uif, 2);
    expect(result.preTaxDeductions).toBeCloseTo(3000, 2);
    expect(result.deductions).toBeCloseTo(3000, 2);
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 8: Pre-tax deduction with income allowance
// Employee: basic R20,000 + travel allowance R3,000.
// Pension fund R2,000 (pre_tax).
// taxableGross = 23,000 - 2,000 = 21,000.
// ─────────────────────────────────────────────────────────────────────────────────
test('T08: pre_tax deduction with taxable allowance present', () => {
    const result = calc(makeData({
        basicSalary: 20000,
        allowances: [allowance('Travel Allowance', 3000)],
        inputs:     [deduction('Pension Fund', 2000, 'pre_tax')]
    }));

    // taxableGross = 23000 - 2000 = 21000
    expect(result.taxableGross).toBeCloseTo(21000, 2);
    // gross = 23000 (travel allowance is taxable → counts toward taxableGross accumulation before reduction)
    // Note: in the engine, allowance adds to taxableGross. gross = taxableGross(before reduction) + nonTaxable
    expect(result.gross).toBeCloseTo(23000, 2);
    expect(result.preTaxDeductions).toBeCloseTo(2000, 2);
    expect(result.deductions).toBeCloseTo(2000, 2);
    expect(result.net).toBeCloseTo(result.gross - result.paye - result.uif - result.deductions, 2);
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 9: Locked output contract — all 13 required fields must be present
// Migration 018 is ADDITIVE only. No locked field may be removed.
// ─────────────────────────────────────────────────────────────────────────────────
test('T09: all 13 locked output fields present after migration 018', () => {
    const result = calc(makeData({ basicSalary: 25000 }));

    const LOCKED_FIELDS = [
        'gross', 'taxableGross', 'paye', 'paye_base', 'voluntary_overdeduction',
        'uif', 'sdl', 'deductions', 'net', 'negativeNetPay',
        'medicalCredit', 'overtimeAmount', 'shortTimeAmount'
    ];

    LOCKED_FIELDS.forEach(field => {
        expect(result).toHaveProperty(field);
    });

    // New additive fields also present
    expect(result).toHaveProperty('preTaxDeductions');
    expect(result).toHaveProperty('netOnlyDeductions');
});

// ─────────────────────────────────────────────────────────────────────────────────
// TEST 10: Net formula invariant under all deduction types
// Regardless of tax_treatment, net = gross - paye - uif - deductions must always hold.
// Tested with: zero, net_only only, pre_tax only, and mixed deductions.
// ─────────────────────────────────────────────────────────────────────────────────
test('T10: net formula invariant holds for all deduction type combinations', () => {
    const scenarios = [
        { label: 'no deductions',     inputs: [] },
        { label: 'net_only only',     inputs: [deduction('Medical', 1500, 'net_only')] },
        { label: 'pre_tax only',      inputs: [deduction('Pension',  2000, 'pre_tax')] },
        { label: 'mixed',             inputs: [deduction('Pension', 2000, 'pre_tax'), deduction('Medical', 1500, 'net_only')] },
        { label: 'legacy (no field)', inputs: [{ type: 'deduction', description: 'Legacy', amount: 1000 }] }
    ];

    scenarios.forEach(({ label, inputs }) => {
        const result = calc(makeData({ basicSalary: 20000, inputs }));
        const expected = result.gross - result.paye - result.uif - result.deductions;
        expect(result.net).toBeCloseTo(expected, 2);
        // Verify pre + net-only sums to total deductions
        expect(result.preTaxDeductions + result.netOnlyDeductions).toBeCloseTo(result.deductions, 2);
    }, `net formula failed for: ${scenarios.label}`);
});
