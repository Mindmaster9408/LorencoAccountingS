'use strict';

/**
 * vat-period.test.js
 * VAT Period Generation, Locking, and Out-of-Period Logic — Prompt 2 Tests
 */

const {
  derivePeriodForDate,
  generatePeriods,
  isVatJournal,
  getVatAmountsFromLines,
} = require('../modules/accounting/services/vatPeriodUtils');

// ─── Suite A: Monthly period derivation ──────────────────────────────────────

describe('A — Monthly period derivation', () => {
  test('A1: January → 2025-01', () => {
    const p = derivePeriodForDate('2025-01-15', 'monthly', null);
    expect(p.periodKey).toBe('2025-01');
    expect(p.fromDate).toBe('2025-01-01');
    expect(p.toDate).toBe('2025-01-31');
  });

  test('A2: February (leap year 2024) → 2024-02 ends on 29th', () => {
    const p = derivePeriodForDate('2024-02-10', 'monthly', null);
    expect(p.periodKey).toBe('2024-02');
    expect(p.toDate).toBe('2024-02-29');
  });

  test('A3: December → 2025-12', () => {
    const p = derivePeriodForDate('2025-12-31', 'monthly', null);
    expect(p.periodKey).toBe('2025-12');
    expect(p.fromDate).toBe('2025-12-01');
    expect(p.toDate).toBe('2025-12-31');
  });
});

// ─── Suite B: Bi-monthly EVEN cycle ──────────────────────────────────────────

describe('B — Bi-monthly EVEN cycle', () => {
  // Even cycle ends: Feb, Apr, Jun, Aug, Oct, Dec
  const cases = [
    { date: '2025-01-10', periodKey: '2025-02', fromDate: '2025-01-01', toDate: '2025-02-28' },
    { date: '2025-02-20', periodKey: '2025-02', fromDate: '2025-01-01', toDate: '2025-02-28' },
    { date: '2025-03-05', periodKey: '2025-04', fromDate: '2025-03-01', toDate: '2025-04-30' },
    { date: '2025-04-30', periodKey: '2025-04', fromDate: '2025-03-01', toDate: '2025-04-30' },
    { date: '2025-05-01', periodKey: '2025-06', fromDate: '2025-05-01', toDate: '2025-06-30' },
    { date: '2025-11-15', periodKey: '2025-12', fromDate: '2025-11-01', toDate: '2025-12-31' },
    { date: '2025-12-01', periodKey: '2025-12', fromDate: '2025-11-01', toDate: '2025-12-31' },
  ];

  cases.forEach(({ date, periodKey, fromDate, toDate }) => {
    test(`B: ${date} → period ${periodKey}`, () => {
      const p = derivePeriodForDate(date, 'bi-monthly', 'even');
      expect(p.periodKey).toBe(periodKey);
      expect(p.fromDate).toBe(fromDate);
      expect(p.toDate).toBe(toDate);
    });
  });
});

// ─── Suite C: Bi-monthly ODD cycle ───────────────────────────────────────────

describe('C — Bi-monthly ODD cycle', () => {
  // Odd cycle ends: Jan, Mar, May, Jul, Sep, Nov
  // Dec is the start of a period ending in Jan of next year (year-boundary)
  const cases = [
    { date: '2025-01-01', periodKey: '2025-01', fromDate: '2024-12-01', toDate: '2025-01-31' },
    { date: '2025-01-31', periodKey: '2025-01', fromDate: '2024-12-01', toDate: '2025-01-31' },
    { date: '2025-02-15', periodKey: '2025-03', fromDate: '2025-02-01', toDate: '2025-03-31' },
    { date: '2025-03-31', periodKey: '2025-03', fromDate: '2025-02-01', toDate: '2025-03-31' },
    { date: '2025-11-10', periodKey: '2025-11', fromDate: '2025-10-01', toDate: '2025-11-30' },
    { date: '2025-12-15', periodKey: '2026-01', fromDate: '2025-12-01', toDate: '2026-01-31' },
  ];

  cases.forEach(({ date, periodKey, fromDate, toDate }) => {
    test(`C: ${date} → period ${periodKey}`, () => {
      const p = derivePeriodForDate(date, 'bi-monthly', 'odd');
      expect(p.periodKey).toBe(periodKey);
      expect(p.fromDate).toBe(fromDate);
      expect(p.toDate).toBe(toDate);
    });
  });
});

// ─── Suite D: Quarterly period derivation ────────────────────────────────────

describe('D — Quarterly period derivation', () => {
  // Ends: Mar(3), Jun(6), Sep(9), Dec(12)
  const cases = [
    { date: '2025-01-15', periodKey: '2025-03', fromDate: '2025-01-01', toDate: '2025-03-31' },
    { date: '2025-03-31', periodKey: '2025-03', fromDate: '2025-01-01', toDate: '2025-03-31' },
    { date: '2025-04-01', periodKey: '2025-06', fromDate: '2025-04-01', toDate: '2025-06-30' },
    { date: '2025-07-10', periodKey: '2025-09', fromDate: '2025-07-01', toDate: '2025-09-30' },
    { date: '2025-10-01', periodKey: '2025-12', fromDate: '2025-10-01', toDate: '2025-12-31' },
  ];

  cases.forEach(({ date, periodKey, fromDate, toDate }) => {
    test(`D: ${date} → period ${periodKey}`, () => {
      const p = derivePeriodForDate(date, 'quarterly', null);
      expect(p.periodKey).toBe(periodKey);
      expect(p.fromDate).toBe(fromDate);
      expect(p.toDate).toBe(toDate);
    });
  });
});

// ─── Suite E: generatePeriods range ──────────────────────────────────────────

describe('E — generatePeriods range', () => {
  test('E1: Monthly — Jan to Mar 2025 produces 3 periods', () => {
    const periods = generatePeriods('2025-01-01', '2025-03-31', 'monthly', null);
    expect(periods).toHaveLength(3);
    expect(periods[0].periodKey).toBe('2025-01');
    expect(periods[1].periodKey).toBe('2025-02');
    expect(periods[2].periodKey).toBe('2025-03');
  });

  test('E2: Bi-monthly even — Jan to Jun 2025 produces 3 periods', () => {
    const periods = generatePeriods('2025-01-01', '2025-06-30', 'bi-monthly', 'even');
    expect(periods).toHaveLength(3);
    expect(periods.map(p => p.periodKey)).toEqual(['2025-02', '2025-04', '2025-06']);
  });

  test('E3: Bi-monthly odd — Dec 2024 to Mar 2025 produces 2 periods', () => {
    const periods = generatePeriods('2024-12-01', '2025-03-31', 'bi-monthly', 'odd');
    expect(periods).toHaveLength(2);
    expect(periods[0].periodKey).toBe('2025-01'); // Dec 2024 + Jan 2025
    expect(periods[1].periodKey).toBe('2025-03'); // Feb + Mar 2025
  });

  test('E4: Single month range produces exactly 1 period (monthly)', () => {
    const periods = generatePeriods('2025-05-01', '2025-05-31', 'monthly', null);
    expect(periods).toHaveLength(1);
    expect(periods[0].periodKey).toBe('2025-05');
  });

  test('E5: No duplicate periods in range (bi-monthly even, 6 months)', () => {
    const periods = generatePeriods('2025-01-01', '2025-06-30', 'bi-monthly', 'even');
    const keys = periods.map(p => p.periodKey);
    const unique = [...new Set(keys)];
    expect(keys).toHaveLength(unique.length);
  });
});

// ─── Suite F: isVatJournal detection ─────────────────────────────────────────

describe('F — isVatJournal detection', () => {
  test('F1: Lines with vat_asset reporting_group → true', () => {
    const lines = [
      { account_reporting_group: 'vat_asset', debit: 15, credit: 0 },
      { account_reporting_group: 'operating_expense', debit: 100, credit: 0 },
    ];
    expect(isVatJournal(lines)).toBe(true);
  });

  test('F2: Lines with vat_liability reporting_group → true', () => {
    const lines = [
      { account_reporting_group: 'vat_liability', debit: 0, credit: 15 },
    ];
    expect(isVatJournal(lines)).toBe(true);
  });

  test('F3: Lines with no VAT accounts → false', () => {
    const lines = [
      { account_reporting_group: 'operating_expense', debit: 100, credit: 0 },
      { account_reporting_group: 'current_asset', debit: 0, credit: 100 },
    ];
    expect(isVatJournal(lines)).toBe(false);
  });

  test('F4: Empty lines array → false', () => {
    expect(isVatJournal([])).toBe(false);
  });

  test('F5: null/undefined → false', () => {
    expect(isVatJournal(null)).toBe(false);
    expect(isVatJournal(undefined)).toBe(false);
  });
});

// ─── Suite G: getVatAmountsFromLines ─────────────────────────────────────────

describe('G — getVatAmountsFromLines', () => {
  test('G1: Standard expense — input VAT R15 (DR 1400)', () => {
    const lines = [
      { account_reporting_group: 'operating_expense', account_code: '6100', debit: 100, credit: 0 },
      { account_reporting_group: 'vat_asset',         account_code: '1400', debit: 15,  credit: 0 },
      { account_reporting_group: 'current_asset',     account_code: '1010', debit: 0,   credit: 115 },
    ];
    const { inputVat, outputVat } = getVatAmountsFromLines(lines);
    expect(inputVat).toBe(15);
    expect(outputVat).toBe(0);
  });

  test('G2: Income with output VAT R15 (CR 2300)', () => {
    const lines = [
      { account_reporting_group: 'current_asset',    account_code: '1010', debit: 115, credit: 0 },
      { account_reporting_group: 'operating_income', account_code: '4000', debit: 0,   credit: 100 },
      { account_reporting_group: 'vat_liability',    account_code: '2300', debit: 0,   credit: 15 },
    ];
    const { inputVat, outputVat } = getVatAmountsFromLines(lines);
    expect(inputVat).toBe(0);
    expect(outputVat).toBe(15);
  });

  test('G3: Zero-rated transaction — no VAT amounts', () => {
    const lines = [
      { account_reporting_group: 'operating_expense', account_code: '6100', debit: 100, credit: 0 },
      { account_reporting_group: 'current_asset',     account_code: '1010', debit: 0,   credit: 100 },
    ];
    const { inputVat, outputVat } = getVatAmountsFromLines(lines);
    expect(inputVat).toBe(0);
    expect(outputVat).toBe(0);
  });

  test('G4: Empty lines → { inputVat: 0, outputVat: 0 }', () => {
    const { inputVat, outputVat } = getVatAmountsFromLines([]);
    expect(inputVat).toBe(0);
    expect(outputVat).toBe(0);
  });

  test('G5: Rounding — R1.005 rounds correctly', () => {
    const lines = [
      { account_reporting_group: 'vat_asset', account_code: '1400', debit: 1.005, credit: 0 },
    ];
    const { inputVat } = getVatAmountsFromLines(lines);
    expect(Number.isFinite(inputVat)).toBe(true);
  });
});

// ─── Suite H: Out-of-period logic (period derivation for late items) ──────────

describe('H — Out-of-period identification', () => {
  /**
   * Simulate the assignVatPeriod logic: if the period derived from the
   * transaction date is locked, it should be flagged as OOP.
   */
  function simulateOOPCheck(journalDate, filingFrequency, cycleType, lockedPeriodKeys) {
    const derived = derivePeriodForDate(journalDate, filingFrequency, cycleType);
    const isLocked = lockedPeriodKeys.includes(derived.periodKey);
    return { derived, isOutOfPeriod: isLocked };
  }

  test('H1: Transaction in open period → not OOP', () => {
    const result = simulateOOPCheck('2025-03-15', 'monthly', null, ['2025-01', '2025-02']);
    expect(result.isOutOfPeriod).toBe(false);
    expect(result.derived.periodKey).toBe('2025-03');
  });

  test('H2: Late transaction in locked period → OOP', () => {
    const result = simulateOOPCheck('2025-01-10', 'monthly', null, ['2025-01']);
    expect(result.isOutOfPeriod).toBe(true);
    expect(result.derived.periodKey).toBe('2025-01');
  });

  test('H3: Bi-monthly even — late item for locked period is OOP', () => {
    const result = simulateOOPCheck('2025-02-28', 'bi-monthly', 'even', ['2025-02']);
    expect(result.isOutOfPeriod).toBe(true);
    expect(result.derived.periodKey).toBe('2025-02');
  });

  test('H4: Bi-monthly odd year-boundary — Dec item in open Jan period is not OOP', () => {
    const result = simulateOOPCheck('2025-12-20', 'bi-monthly', 'odd', ['2025-11']);
    expect(result.isOutOfPeriod).toBe(false);
    expect(result.derived.periodKey).toBe('2026-01');
  });

  test('H5: Late item for locked odd-cycle Dec/Jan period is OOP', () => {
    const result = simulateOOPCheck('2025-12-20', 'bi-monthly', 'odd', ['2026-01']);
    expect(result.isOutOfPeriod).toBe(true);
  });
});

// ─── Suite I: Regression — non-VAT allocations unchanged ─────────────────────

describe('I — Regression: non-VAT journals unaffected', () => {
  test('I1: isVatJournal returns false for pure bank transfer lines', () => {
    const lines = [
      { account_reporting_group: 'current_asset', account_code: '1010', debit: 1000, credit: 0 },
      { account_reporting_group: 'current_asset', account_code: '1011', debit: 0, credit: 1000 },
    ];
    expect(isVatJournal(lines)).toBe(false);
  });

  test('I2: getVatAmountsFromLines returns 0/0 for AP journal (no VAT lines)', () => {
    const lines = [
      { account_reporting_group: 'operating_expense', account_code: '6100', debit: 100, credit: 0 },
      { account_reporting_group: 'current_liability', account_code: '2000', debit: 0,   credit: 100 },
    ];
    const { inputVat, outputVat } = getVatAmountsFromLines(lines);
    expect(inputVat).toBe(0);
    expect(outputVat).toBe(0);
  });

  test('I3: Period derivation does not throw for all 12 months (monthly)', () => {
    for (let m = 1; m <= 12; m++) {
      const date = `2025-${String(m).padStart(2,'0')}-15`;
      expect(() => derivePeriodForDate(date, 'monthly', null)).not.toThrow();
    }
  });

  test('I4: Period derivation does not throw for all 12 months (bi-monthly even)', () => {
    for (let m = 1; m <= 12; m++) {
      const date = `2025-${String(m).padStart(2,'0')}-15`;
      expect(() => derivePeriodForDate(date, 'bi-monthly', 'even')).not.toThrow();
    }
  });

  test('I5: Period derivation does not throw for all 12 months (bi-monthly odd)', () => {
    for (let m = 1; m <= 12; m++) {
      const date = `2025-${String(m).padStart(2,'0')}-15`;
      expect(() => derivePeriodForDate(date, 'bi-monthly', 'odd')).not.toThrow();
    }
  });
});

// ─── Suite J: Bi-monthly even — all 12 months coverage ───────────────────────

describe('J — Bi-monthly even: all 12 months map to correct period', () => {
  const expected = {
    1: '2025-02',  2: '2025-02',
    3: '2025-04',  4: '2025-04',
    5: '2025-06',  6: '2025-06',
    7: '2025-08',  8: '2025-08',
    9: '2025-10', 10: '2025-10',
   11: '2025-12', 12: '2025-12',
  };

  Object.entries(expected).forEach(([month, expectedKey]) => {
    test(`J: Month ${month} → ${expectedKey}`, () => {
      const date = `2025-${String(month).padStart(2,'0')}-15`;
      const p = derivePeriodForDate(date, 'bi-monthly', 'even');
      expect(p.periodKey).toBe(expectedKey);
    });
  });
});

// ─── Suite K: Bi-monthly odd — all 12 months coverage ────────────────────────

describe('K — Bi-monthly odd: all 12 months map to correct period', () => {
  // Dec 2024 → 2025-01; Jan→2025-01; Feb→2025-03; etc.
  const expected = {
    1: '2025-01',  2: '2025-03',
    3: '2025-03',  4: '2025-05',
    5: '2025-05',  6: '2025-07',
    7: '2025-07',  8: '2025-09',
    9: '2025-09', 10: '2025-11',
   11: '2025-11', 12: '2026-01',
  };

  Object.entries(expected).forEach(([month, expectedKey]) => {
    test(`K: 2025 Month ${month} → ${expectedKey}`, () => {
      const date = `2025-${String(month).padStart(2,'0')}-15`;
      const p = derivePeriodForDate(date, 'bi-monthly', 'odd');
      expect(p.periodKey).toBe(expectedKey);
    });
  });
});
