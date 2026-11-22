/**
 * Paytime — bulk import of one month's variable inputs (pure functions).
 * Fictional data only.
 */
jest.mock('../config/database', () => ({ supabase: {} }));

const B = require('../modules/payroll/services/bulkInputs');

const masters = [
  { id: 1, item_name: 'Staff Loan', item_type: 'deduction', affects_uif: false, is_active: true },
  { id: 2, item_name: 'Savings', item_type: 'deduction', affects_uif: false, is_active: true },
  { id: 3, item_name: 'Savings', item_type: 'earning', affects_uif: true, is_active: true },
  { id: 4, item_name: 'Commission', item_type: 'income', affects_uif: null, is_active: true },
  { id: 5, item_name: 'Provident Fund Employer', item_type: 'employer_contribution', is_active: true },
  { id: 6, item_name: 'Old Item', item_type: 'deduction', is_active: false },
  { id: 7, item_name: 'Advance', item_type: 'deduction', affects_uif: false, is_active: true }
];
const employees = [
  { id: 10, employee_number: 'E001', first_name: 'Ann', last_name: 'A', is_active: true },
  { id: 11, employee_number: 'e002', first_name: 'Ben', last_name: 'B', is_active: true },
  { id: 12, employee_number: 'E003', first_name: 'Cee', last_name: 'C', is_active: false, termination_date: '2026-09-30' },
  { id: 13, employee_number: 'E004', first_name: 'Dee', last_name: 'D', is_active: true }
];
const period = { start_date: '2026-11-01', end_date: '2026-11-30' };
const mapping = {
  'Employee Number': { target: 'ignore' },
  'Overtime': { target: 'overtime', rate: 1.5 },
  'Overtime 2x': { target: 'overtime', rate: 2 },
  'Short Time': { target: 'short_time' },
  'Advance': { target: 'item', master_item_id: 7 },
  'Staff Loan': { target: 'item', master_item_id: 1 },
  'Savings': { target: 'item', master_item_id: 2 }
};
const plan = (rows, existing = {}, locked = new Set()) => B.buildPlan({
  rows, mapping, masters, employees, period, existing: Object.assign({ inputs: [], overtime: [], short: [] }, existing), lockedEmployeeIds: locked
});

describe('parseValue', () => {
  test('SA and US number styles, currency, blanks', () => {
    expect(B.parseValue('1 234,50')).toBe(1234.5);
    expect(B.parseValue('1,234.50')).toBe(1234.5);
    expect(B.parseValue('R 300')).toBe(300);
    expect(B.parseValue('7,5')).toBe(7.5);
    expect(B.parseValue(206.75)).toBe(206.75);
    expect(B.parseValue('')).toBeNull();
    expect(B.parseValue(null)).toBeNull();
    expect(Number.isNaN(B.parseValue('abc'))).toBe(true);
  });
});

describe('suggestTarget / checkMapping', () => {
  test('hours columns, same-name items, deduction preferred for a duplicated name', () => {
    expect(B.suggestTarget('Employee Number', masters)).toEqual({ target: 'ignore' });
    expect(B.suggestTarget('Overtime Hours', masters)).toEqual({ target: 'overtime', rate: 1.5 });
    expect(B.suggestTarget('Overtime 2x', masters)).toEqual({ target: 'overtime', rate: 2 });
    expect(B.suggestTarget('short_time', masters)).toEqual({ target: 'short_time' });
    expect(B.suggestTarget('Staff Loan', masters)).toEqual({ target: 'item', master_item_id: 1 });
    expect(B.suggestTarget('Savings', masters)).toEqual({ target: 'item', master_item_id: 2 });
    expect(B.suggestTarget('Old Item', masters)).toEqual({ target: 'ignore' });
    expect(B.suggestTarget('Something else', masters)).toEqual({ target: 'ignore' });
  });
  test('refuses unknown, inactive and employer-contribution items and bad rates', () => {
    expect(B.checkMapping(mapping, masters)).toEqual([]);
    const bad = B.checkMapping({ a: { target: 'item', master_item_id: 99 }, b: { target: 'item', master_item_id: 6 },
      c: { target: 'item', master_item_id: 5 }, d: { target: 'overtime', rate: 5 }, e: { target: 'x' } }, masters);
    expect(bad).toHaveLength(5);
  });
});

describe('buildPlan', () => {
  test('writes items, overtime per rate and short time; totals per column', () => {
    const r = plan([
      { row: 2, employee_number: 'E001', values: { 'Overtime': '10', 'Overtime 2x': '4,5', 'Advance': '500', 'Savings': '100' } },
      { row: 3, employee_number: 'E002', values: { 'Short Time': '8', 'Staff Loan': 'R 250', 'Advance': '' } }
    ]);
    expect(r.errors).toEqual([]);
    expect(r.plans).toHaveLength(2);
    const a = r.plans[0];
    expect(a.inputs).toEqual([
      { item_type: 'deduction', description: 'Advance', amount: 500, affects_uif: false },
      { item_type: 'deduction', description: 'Savings', amount: 100, affects_uif: false }]);
    expect(a.overtime).toEqual([
      { hours: 10, rate_multiplier: 1.5, description: 'Overtime', source: 'manual' },
      { hours: 4.5, rate_multiplier: 2, description: 'Overtime 2x', source: 'manual' }]);
    expect(a.short_time).toBeNull();
    const b = r.plans[1];                                   // employee_number matched case-insensitively
    expect(b.short_time).toEqual([{ hours_missed: 8, description: 'Short time', source: 'manual' }]);
    expect(b.inputs).toEqual([{ item_type: 'deduction', description: 'Staff Loan', amount: 250, affects_uif: false }]);
    expect(b.overtime).toBeNull();
    expect(r.totals).toEqual({ 'Overtime': 10, 'Overtime 2x': 4.5, 'Short Time': 8, 'Advance': 500, 'Staff Loan': 250, 'Savings': 100 });
    expect(r.summary).toMatchObject({ rows: 2, employees_changed: 2, errors: 0, entries: 6 });
  });

  test('replaces only the same item; keeps other items; Savings deduction never touches Savings earning', () => {
    const existing = { inputs: [
      { employee_id: 10, description: 'Advance', amount: 999, item_type: 'deduction', affects_uif: false },
      { employee_id: 10, description: 'Commission', amount: 1500, item_type: 'earning', affects_uif: true },
      { employee_id: 10, description: 'Savings', amount: 50, item_type: 'earning', affects_uif: true },
      { employee_id: 11, description: 'Advance', amount: 77, item_type: 'deduction', affects_uif: false }] };
    const r = plan([{ row: 2, employee_number: 'E001', values: { 'Advance': '300', 'Savings': '100' } }], existing);
    expect(r.plans[0].inputs).toEqual([
      { payroll_item_id: null, description: 'Commission', amount: 1500, item_type: 'earning', affects_uif: true },
      { payroll_item_id: null, description: 'Savings', amount: 50, item_type: 'earning', affects_uif: true },
      { item_type: 'deduction', description: 'Advance', amount: 300, affects_uif: false },
      { item_type: 'deduction', description: 'Savings', amount: 100, affects_uif: false }]);
  });

  test('overtime / short time replace manual rows, keep Attendance and leave rows, and warn', () => {
    const existing = {
      overtime: [{ employee_id: 10, hours: 3, rate_multiplier: 1.5, description: 'OT', source: 'attendance' },
        { employee_id: 10, hours: 9, rate_multiplier: 1.5, description: 'typed', source: 'manual' }],
      short: [{ employee_id: 10, hours_missed: 8, description: 'Unpaid leave', source: 'leave' },
        { employee_id: 10, hours_missed: 2, description: 'typed', source: 'manual' }] };
    const r = plan([{ row: 2, employee_number: 'E001', values: { 'Overtime': '12', 'Short Time': '4' } }], existing);
    const p = r.plans[0];
    expect(p.overtime).toEqual([
      { hours: 3, rate_multiplier: 1.5, description: 'OT', source: 'attendance' },
      { hours: 12, rate_multiplier: 1.5, description: 'Overtime', source: 'manual' }]);
    expect(p.short_time).toEqual([
      { hours_missed: 8, description: 'Unpaid leave', source: 'leave' },
      { hours_missed: 4, description: 'Short time', source: 'manual' }]);
    expect(p.warnings).toHaveLength(2);
  });

  test('errors: unknown, duplicate, terminated, finalized, negative and non-numeric — nothing planned for them', () => {
    const r = plan([
      { row: 2, employee_number: 'X999', values: { 'Advance': '1' } },
      { row: 3, employee_number: 'E001', values: { 'Advance': '1' } },
      { row: 4, employee_number: 'e001', values: { 'Advance': '2' } },
      { row: 5, employee_number: 'E003', values: { 'Advance': '1' } },
      { row: 6, employee_number: 'E004', values: { 'Advance': '1' } },
      { row: 7, employee_number: 'E002', values: { 'Advance': '-5' } },
      { row: 8, employee_number: '', values: {} }
    ], {}, new Set([13]));
    expect(r.errors.map(e => e.row)).toEqual([2, 4, 5, 6, 7, 8]);
    expect(r.plans.map(p => p.employee_number)).toEqual(['E001']);
    expect(r.totals.Advance).toBe(1);
    const nan = plan([{ row: 2, employee_number: 'E001', values: { 'Advance': 'abc' } }]);
    expect(nan.errors[0].message).toMatch(/not a number/);
  });

  test('blank and zero values change nothing', () => {
    const r = plan([{ row: 2, employee_number: 'E001', values: { 'Advance': '0', 'Overtime': '' } }]);
    expect(r.plans).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
