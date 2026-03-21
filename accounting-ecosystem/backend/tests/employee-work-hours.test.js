'use strict';

/**
 * ============================================================================
 * Tests — Paytime Employee Work Hours & Hourly Rate Foundation
 * ============================================================================
 *
 * Feature implemented (2026-03-21):
 *   hours_per_week and hours_per_day fields added to employees.
 *   Hourly wage formula: Salary / (hours_per_week × 4.33)
 *   Overtime rate:       Hourly wage × 1.5
 *   Short time value:    Hourly wage × hours_missed
 *   Quarter-hour increments (0.25 = 15 min) supported on all hour inputs.
 *   Backward compatibility: null/missing hours_per_week falls back to HOURLY_DIVISOR = 173.33
 *
 * Coverage:
 *   A. Static helpers — calculateHourlyWage, calculateOvertimeRate, calculateShortTimeValue
 *   B. Hourly wage formula — per-employee hours drive the divisor
 *   C. Overtime rate — hourly wage × 1.5 using employee-specific hours
 *   D. Short time value — quarter-hour increments calculate correctly
 *   E. calculateFromData integration — hours_per_week in payrollData object
 *   F. Backward compatibility — null/missing hours_per_week falls back to HOURLY_DIVISOR
 *   G. Regression — existing overtime/short time flow unchanged for default employees
 * ============================================================================
 */

const PayrollEngine = require('../../frontend-payroll/js/payroll-engine.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_SALARY   = 20000;     // R20,000/month
const HOURS_DEFAULT = 40;        // SA standard 40 hrs/week
const HOURS_CUSTOM  = 45;        // Non-standard contract

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

// Calculates expected hourly wage for assertions
function expectedHourly(salary, hoursPerWeek) {
    return salary / (hoursPerWeek * 4.33);
}

function makePayroll(basicSalary = BASE_SALARY, hoursPerWeek = null, extraInputs = []) {
    const p = { basic_salary: basicSalary, regular_inputs: extraInputs };
    if (hoursPerWeek !== null) p.hours_per_week = hoursPerWeek;
    return p;
}

// ─── A. Static helpers ────────────────────────────────────────────────────────

describe('A. PayrollEngine.calculateHourlyWage', () => {
    test('returns salary divided by (hours_per_week × 4.33)', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        const expected = r4(BASE_SALARY / (HOURS_DEFAULT * 4.33));
        expect(result).toBeCloseTo(expected, 3);
    });

    test('40 hrs/week → R115.47/hr (at R20,000)', () => {
        // 20000 / (40 × 4.33) = 20000 / 173.2 ≈ 115.4734
        const result = PayrollEngine.calculateHourlyWage(20000, 40);
        expect(result).toBeCloseTo(115.47, 1);
    });

    test('45 hrs/week gives lower hourly rate than 40 hrs/week (same salary)', () => {
        const rate40 = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        const rate45 = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_CUSTOM);
        expect(rate45).toBeLessThan(rate40);
    });

    test('falls back to HOURLY_DIVISOR when hours_per_week is null', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, null);
        const fallback = r4(BASE_SALARY / PayrollEngine.HOURLY_DIVISOR);
        expect(result).toBeCloseTo(fallback, 3);
    });

    test('falls back to HOURLY_DIVISOR when hours_per_week is undefined', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, undefined);
        const fallback = r4(BASE_SALARY / PayrollEngine.HOURLY_DIVISOR);
        expect(result).toBeCloseTo(fallback, 3);
    });

    test('falls back to HOURLY_DIVISOR when hours_per_week is 0', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, 0);
        const fallback = r4(BASE_SALARY / PayrollEngine.HOURLY_DIVISOR);
        expect(result).toBeCloseTo(fallback, 3);
    });

    test('returns 0 when salary is 0', () => {
        expect(PayrollEngine.calculateHourlyWage(0, 40)).toBe(0);
    });

    test('returns 0 when salary is null', () => {
        expect(PayrollEngine.calculateHourlyWage(null, 40)).toBe(0);
    });

    test('result is rounded to 4 decimal places', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, 40);
        expect(result).toBe(Math.round(result * 10000) / 10000);
    });
});

describe('A. PayrollEngine.calculateOvertimeRate', () => {
    test('overtime rate = hourly wage × 1.5', () => {
        const hourly = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        const ot     = PayrollEngine.calculateOvertimeRate(BASE_SALARY, HOURS_DEFAULT);
        expect(ot).toBeCloseTo(hourly * 1.5, 3);
    });

    test('40 hrs/week → overtime rate ≈ R173.21/hr (at R20,000)', () => {
        // Hourly ≈ 115.47, OT = 115.47 × 1.5 ≈ 173.21
        const ot = PayrollEngine.calculateOvertimeRate(20000, 40);
        expect(ot).toBeCloseTo(173.21, 0);
    });

    test('falls back to HOURLY_DIVISOR-based rate when hours_per_week is null', () => {
        const ot       = PayrollEngine.calculateOvertimeRate(BASE_SALARY, null);
        const fallback = r4((BASE_SALARY / PayrollEngine.HOURLY_DIVISOR) * 1.5);
        expect(ot).toBeCloseTo(fallback, 3);
    });

    test('result is rounded to 4 decimal places', () => {
        const ot = PayrollEngine.calculateOvertimeRate(BASE_SALARY, 40);
        expect(ot).toBe(Math.round(ot * 10000) / 10000);
    });
});

describe('A. PayrollEngine.calculateShortTimeValue', () => {
    test('short time value = hourly wage × hours_missed', () => {
        const hoursMissed = 8;
        const hourly      = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        const stValue     = PayrollEngine.calculateShortTimeValue(BASE_SALARY, hoursMissed, HOURS_DEFAULT);
        expect(stValue).toBeCloseTo(hourly * hoursMissed, 2);
    });

    test('falls back to HOURLY_DIVISOR when hours_per_week is null', () => {
        const stValue  = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 8, null);
        const fallback = r2(8 * (BASE_SALARY / PayrollEngine.HOURLY_DIVISOR));
        expect(stValue).toBeCloseTo(fallback, 2);
    });

    test('returns 0 for 0 hours missed', () => {
        expect(PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0, 40)).toBe(0);
    });

    test('returns 0 for null hours missed', () => {
        expect(PayrollEngine.calculateShortTimeValue(BASE_SALARY, null, 40)).toBe(0);
    });

    test('result is rounded to 2 decimal places', () => {
        const stValue = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 3, 40);
        expect(stValue).toBe(Math.round(stValue * 100) / 100);
    });
});

// ─── B. Hourly wage formula ───────────────────────────────────────────────────

describe('B. Hourly wage formula — employee-specific hours drive the divisor', () => {
    test('divisor at 40 hrs/week produces R115.47/hr (not the old 173.33 constant)', () => {
        // 40 × 4.33 = 173.2, not 173.33
        const hourly = PayrollEngine.calculateHourlyWage(20000, 40);
        const legacyHourly = 20000 / PayrollEngine.HOURLY_DIVISOR;

        // Both are close but not equal
        expect(hourly).toBeCloseTo(115.47, 1);
        // The new formula at 40 hrs is slightly different from HOURLY_DIVISOR = 173.33
        expect(Math.abs(hourly - legacyHourly)).toBeLessThan(0.1); // within R0.10 — backward compatible
    });

    test('higher weekly hours → lower hourly rate (works more, paid less per hour)', () => {
        const r35 = PayrollEngine.calculateHourlyWage(BASE_SALARY, 35);
        const r40 = PayrollEngine.calculateHourlyWage(BASE_SALARY, 40);
        const r45 = PayrollEngine.calculateHourlyWage(BASE_SALARY, 45);
        expect(r35).toBeGreaterThan(r40);
        expect(r40).toBeGreaterThan(r45);
    });

    test('formula handles fractional hours — 37.5 hrs/week', () => {
        // Common in SA service industry
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, 37.5);
        const expected = BASE_SALARY / (37.5 * 4.33);
        expect(result).toBeCloseTo(expected, 3);
    });

    test('formula handles minimum legal — 1 hr/week does not crash', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, 1);
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThan(0);
    });

    test('formula handles maximum legal — 84 hrs/week (SA legal cap)', () => {
        const result = PayrollEngine.calculateHourlyWage(BASE_SALARY, 84);
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(BASE_SALARY / (40 * 4.33)); // lower than 40-hr rate
    });
});

// ─── C. Overtime rate ─────────────────────────────────────────────────────────

describe('C. Overtime rate — employee-specific hours', () => {
    test('overtime at 1.5x uses employee hourly rate (not legacy divisor)', () => {
        const hourly = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_CUSTOM);
        const ot     = PayrollEngine.calculateOvertimeRate(BASE_SALARY, HOURS_CUSTOM);
        expect(ot).toBeCloseTo(hourly * 1.5, 3);
    });

    test('10 OT hours at 1.5x rate using 45 hrs/week', () => {
        const otRate    = PayrollEngine.calculateOvertimeRate(BASE_SALARY, HOURS_CUSTOM);
        const otPay     = r2(otRate * 10);
        const hourly    = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_CUSTOM);
        const expected  = r2(hourly * 1.5 * 10);
        expect(otPay).toBeCloseTo(expected, 2);
    });
});

// ─── D. Short time — quarter-hour increments ──────────────────────────────────

describe('D. Short time — quarter-hour increments', () => {
    test('0.25 hours (15 min) calculates correctly', () => {
        const stValue  = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0.25, HOURS_DEFAULT);
        const hourly   = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        expect(stValue).toBeCloseTo(hourly * 0.25, 2);
    });

    test('0.50 hours (30 min) calculates correctly', () => {
        const stValue = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0.50, HOURS_DEFAULT);
        const hourly  = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        expect(stValue).toBeCloseTo(hourly * 0.50, 2);
    });

    test('0.75 hours (45 min) calculates correctly', () => {
        const stValue = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0.75, HOURS_DEFAULT);
        const hourly  = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        expect(stValue).toBeCloseTo(hourly * 0.75, 2);
    });

    test('quarter-hour steps are linearly proportional', () => {
        const st15  = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0.25, HOURS_DEFAULT);
        const st30  = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0.50, HOURS_DEFAULT);
        const st45  = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 0.75, HOURS_DEFAULT);
        const st60  = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 1.00, HOURS_DEFAULT);

        // Each increment should be equal (allow 1dp tolerance — rounding on R2 rounds at each step)
        expect(st30 - st15).toBeCloseTo(st15, 1);
        expect(st45 - st30).toBeCloseTo(st15, 1);
        expect(st60 - st45).toBeCloseTo(st15, 1);
    });

    test('1.25 hours (1h 15min) — fractional increments beyond 1 hour', () => {
        const stValue = PayrollEngine.calculateShortTimeValue(BASE_SALARY, 1.25, HOURS_DEFAULT);
        const hourly  = PayrollEngine.calculateHourlyWage(BASE_SALARY, HOURS_DEFAULT);
        expect(stValue).toBeCloseTo(hourly * 1.25, 2);
    });
});

// ─── E. calculateFromData integration ────────────────────────────────────────

describe('E. calculateFromData — hours_per_week in payrollData', () => {
    test('hours_per_week in payrollData drives overtime calculation', () => {
        const payroll    = makePayroll(BASE_SALARY, HOURS_CUSTOM);
        const overtime   = [{ hours: 10, rate_multiplier: 1.5 }];
        const calc       = PayrollEngine.calculateFromData(payroll, [], overtime, [], []);

        const expectedHourly = BASE_SALARY / (HOURS_CUSTOM * 4.33);
        const expectedOT     = r2(10 * expectedHourly * 1.5);

        expect(calc.overtimeAmount).toBeCloseTo(expectedOT, 1);
    });

    test('hours_per_week in payrollData drives short time calculation', () => {
        const payroll   = makePayroll(BASE_SALARY, HOURS_CUSTOM);
        const shortTime = [{ hours_missed: 8 }];
        const calc      = PayrollEngine.calculateFromData(payroll, [], [], [], shortTime);

        const expectedHourly = BASE_SALARY / (HOURS_CUSTOM * 4.33);
        const expectedST     = r2(8 * expectedHourly);

        expect(calc.shortTimeAmount).toBeCloseTo(expectedST, 1);
    });

    test('45 hrs/week overtime produces smaller amount than 40 hrs/week (lower hourly rate)', () => {
        const overtime   = [{ hours: 10, rate_multiplier: 1.5 }];
        const calc40     = PayrollEngine.calculateFromData(makePayroll(BASE_SALARY, 40), [], overtime, [], []);
        const calc45     = PayrollEngine.calculateFromData(makePayroll(BASE_SALARY, 45), [], overtime, [], []);

        expect(calc45.overtimeAmount).toBeLessThan(calc40.overtimeAmount);
    });

    test('45 hrs/week short time produces smaller deduction than 40 hrs/week', () => {
        const shortTime = [{ hours_missed: 8 }];
        const calc40    = PayrollEngine.calculateFromData(makePayroll(BASE_SALARY, 40), [], [], [], shortTime);
        const calc45    = PayrollEngine.calculateFromData(makePayroll(BASE_SALARY, 45), [], [], [], shortTime);

        expect(calc45.shortTimeAmount).toBeLessThan(calc40.shortTimeAmount);
    });

    test('gross is correctly adjusted for OT and ST with custom hours', () => {
        const payroll   = makePayroll(BASE_SALARY, HOURS_CUSTOM);
        const overtime  = [{ hours: 5, rate_multiplier: 1.5 }];
        const shortTime = [{ hours_missed: 4 }];
        const calc      = PayrollEngine.calculateFromData(payroll, [], overtime, [], shortTime);

        const expectedHourly = BASE_SALARY / (HOURS_CUSTOM * 4.33);
        const expectedOT     = r2(5 * expectedHourly * 1.5);
        const expectedST     = r2(4 * expectedHourly);

        expect(calc.gross).toBeCloseTo(BASE_SALARY + expectedOT - expectedST, 1);
    });
});

// ─── F. Backward compatibility ────────────────────────────────────────────────

describe('F. Backward compatibility — null hours_per_week falls back to HOURLY_DIVISOR', () => {
    test('payrollData without hours_per_week uses legacy HOURLY_DIVISOR (173.33)', () => {
        const payroll  = { basic_salary: BASE_SALARY, regular_inputs: [] };   // no hours_per_week
        const overtime = [{ hours: 10, rate_multiplier: 1.5 }];
        const calc     = PayrollEngine.calculateFromData(payroll, [], overtime, [], []);

        const legacyHourly = BASE_SALARY / PayrollEngine.HOURLY_DIVISOR;
        const expectedOT   = r2(10 * legacyHourly * 1.5);

        expect(calc.overtimeAmount).toBeCloseTo(expectedOT, 1);
    });

    test('payrollData with hours_per_week: null falls back to HOURLY_DIVISOR', () => {
        const payroll  = { basic_salary: BASE_SALARY, hours_per_week: null, regular_inputs: [] };
        const overtime = [{ hours: 10, rate_multiplier: 1.5 }];
        const calc     = PayrollEngine.calculateFromData(payroll, [], overtime, [], []);

        const legacyHourly = BASE_SALARY / PayrollEngine.HOURLY_DIVISOR;
        const expectedOT   = r2(10 * legacyHourly * 1.5);

        expect(calc.overtimeAmount).toBeCloseTo(expectedOT, 1);
    });

    test('null-hours result is within 0.15/hr of 40-hr formula result (backward compat)', () => {
        // 40×4.33 = 173.2 vs HOURLY_DIVISOR = 173.33 — difference is ~R0.013/hr
        // For 1 OT hour at 1.5x the payslip difference is ~R0.02 — well under R0.15
        const overtime    = [{ hours: 1, rate_multiplier: 1.5 }];
        const calcLegacy  = PayrollEngine.calculateFromData(makePayroll(BASE_SALARY, null), [], overtime, [], []);
        const calc40      = PayrollEngine.calculateFromData(makePayroll(BASE_SALARY, 40),   [], overtime, [], []);

        expect(Math.abs(calc40.overtimeAmount - calcLegacy.overtimeAmount)).toBeLessThan(0.15);
    });

    test('HOURLY_DIVISOR constant is still 173.33', () => {
        expect(PayrollEngine.HOURLY_DIVISOR).toBe(173.33);
    });
});

// ─── G. Regression — existing overtime/short time flow ────────────────────────

describe('G. Regression — existing overtime/short time flow unaffected', () => {
    test('base salary payslip (no OT/ST, no hours) unchanged', () => {
        const calc = PayrollEngine.calculateFromData(
            { basic_salary: BASE_SALARY, regular_inputs: [] },
            [], [], [], []
        );
        expect(calc.gross).toBeCloseTo(BASE_SALARY, 1);
        expect(calc.overtimeAmount).toBe(0);
        expect(calc.shortTimeAmount).toBe(0);
    });

    test('overtime at 1.5x without hours_per_week still works (legacy path)', () => {
        const overtime = [{ hours: 10, rate_multiplier: 1.5 }];
        const calc     = PayrollEngine.calculateFromData(
            { basic_salary: BASE_SALARY, regular_inputs: [] },
            [], overtime, [], []
        );
        const legacyHourly = BASE_SALARY / PayrollEngine.HOURLY_DIVISOR;
        const expectedOT   = r2(10 * legacyHourly * 1.5);

        expect(calc.overtimeAmount).toBeCloseTo(expectedOT, 1);
        expect(calc.gross).toBeCloseTo(BASE_SALARY + expectedOT, 1);
    });

    test('short time without hours_per_week still works (legacy path)', () => {
        const shortTime = [{ hours_missed: 8 }];
        const calc      = PayrollEngine.calculateFromData(
            { basic_salary: BASE_SALARY, regular_inputs: [] },
            [], [], [], shortTime
        );
        const legacyHourly = BASE_SALARY / PayrollEngine.HOURLY_DIVISOR;
        const expectedST   = r2(8 * legacyHourly);

        expect(calc.shortTimeAmount).toBeCloseTo(expectedST, 1);
        expect(calc.gross).toBeCloseTo(BASE_SALARY - expectedST, 1);
    });

    test('both OT and ST without hours_per_week — independent components still work', () => {
        const overtime  = [{ hours: 10, rate_multiplier: 1.5 }];
        const shortTime = [{ hours_missed: 8 }];
        const calc      = PayrollEngine.calculateFromData(
            { basic_salary: BASE_SALARY, regular_inputs: [] },
            [], overtime, [], shortTime
        );

        const legacyHourly = BASE_SALARY / PayrollEngine.HOURLY_DIVISOR;
        const expectedOT   = r2(10 * legacyHourly * 1.5);
        const expectedST   = r2(8 * legacyHourly);

        expect(calc.overtimeAmount).toBeCloseTo(expectedOT, 1);
        expect(calc.shortTimeAmount).toBeCloseTo(expectedST, 1);
        expect(calc.gross).toBeCloseTo(BASE_SALARY + expectedOT - expectedST, 1);
    });

    test('payroll deductions unchanged when hours_per_week is added', () => {
        const payrollBase   = makePayroll(BASE_SALARY, null,         [{ type: 'deduction', amount: 500, description: 'Medical' }]);
        const payrollHours  = makePayroll(BASE_SALARY, HOURS_CUSTOM, [{ type: 'deduction', amount: 500, description: 'Medical' }]);
        const overtime      = [{ hours: 5, rate_multiplier: 1.5 }];

        const calcBase  = PayrollEngine.calculateFromData(payrollBase,  [], overtime, [], []);
        const calcHours = PayrollEngine.calculateFromData(payrollHours, [], overtime, [], []);

        // Both should deduct R500 regardless of hours_per_week setting
        expect(calcBase.deductions).toBeCloseTo(calcHours.deductions, 0);
    });
});
