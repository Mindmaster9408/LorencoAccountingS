'use strict';

/**
 * Tests — historical payslip import (spec 12 HI-01/03/06/07/09).
 * Bug 2026-11-18: the import kept only basic salary. These tests pin that every
 * supplied figure and every column line survives, exactly as supplied.
 * All figures are fictional.
 */

const H = require('../modules/payroll/services/historicalImport');
const PayrollHistoryService = require('../modules/payroll/services/PayrollHistoryService');
const Easyfile = require('../modules/payroll/services/easyfileExport');

const masters = [
  { id: 35, item_name: '7.5% Allowance', item_type: 'income', irp5_code: '3601', is_taxable: true },
  { id: 36, item_name: 'Salary Advance', item_type: 'deduction', irp5_code: null, tax_treatment: 'net_only' },
  { id: 40, item_name: 'Provident Fund', item_type: 'deduction', irp5_code: '4003', tax_treatment: 'pre_tax' },
  { id: 46, item_name: 'Annual Bonus', item_type: 'earning', irp5_code: '3605', is_taxable: true },
  { id: 47, item_name: 'Travel Allowance', item_type: 'allowance', irp5_code: '3701', is_taxable: true, taxable_percentage: 80 }
];
const period = { id: 9, period_key: '2026-09', start_date: '2026-09-01', end_date: '2026-09-30' };
const employee = { id: 501, company_id: 51, first_name: 'Test', last_name: 'Person' };
const mapping = {
  allowance_75_percent: { target: 'item', master_item_id: 35 },
  allowance_overtime: { target: 'overtime' },
  allowance_short_time: { target: 'short_time' },
  deduction_salary_advance: { target: 'item', master_item_id: 36 }
};
// Same shape as the bug report's row, fictional amounts:
// gross = 6000 + 450 + 70 − 90 = 6430 ; net = 6430 − 0 − 64.30 − 250 = 6115.70
const baseRow = () => ({
  row: 2, employee_number: 'T001', period: '2026-09', basic_salary: 6000, gross: 6430,
  paye: 0, uif: 64.30, net: 6115.70, overtime_hours: 1.5,
  lines: [
    { column: 'allowance_75_percent', amount: 450 },
    { column: 'allowance_overtime', amount: 70 },
    { column: 'allowance_short_time', amount: -90 },
    { column: 'deduction_salary_advance', amount: 250 }
  ]
});
const build = (over = {}) => H.buildImportedSnapshot(Object.assign({
  row: baseRow(), mapping, masters, period, employee, companyFlags: { sdl_registered: true },
  batch: { id: '00000000-0000-4000-8000-000000000001', user_id: 1, at: '2026-11-18T10:00:00Z' }
}, over));

describe('buildImportedSnapshot — figures kept exactly (HI-01)', () => {
  const r = build();
  const out = r.snapshot.calculation_output;

  test('no errors, locked + finalized', () => {
    expect(r.errors).toEqual([]);
    expect(r.snapshot.is_locked).toBe(true);
    expect(r.snapshot.status).toBe('finalized');
  });

  test('supplied totals are authoritative — UIF is NOT recalculated as 1% of basic', () => {
    expect(out.gross).toBe(6430);
    expect(out.paye).toBe(0);
    expect(out.uif).toBe(64.30);
    expect(out.net).toBe(6115.70);
    expect(out.deductions).toBe(250);
  });

  test('every column becomes its own payslip line, negatives kept (HI-06)', () => {
    const lines = out.payslip_lines;
    const find = (kind, desc) => lines.find(l => l.kind === kind && (!desc || l.description === desc));
    expect(find('basic').amount).toBe(6000);
    expect(find('regular', '7.5% Allowance')).toMatchObject({ amount: 450, irp5_code: '3601', master_item_id: 35 });
    expect(find('overtime')).toMatchObject({ amount: 70, hours: 1.5 });
    expect(find('short_time').amount).toBe(-90);
    expect(find('regular', 'Salary Advance')).toMatchObject({ section: 'deduction', amount: 250 });
    expect(find('uif').amount).toBe(64.30);
    expect(out.payslip_check.ok).toBe(true);
  });

  test('overtime hours never create a calculated amount', () => {
    expect(out.overtimeAmount).toBe(70);
    expect(r.snapshot.calculation_input.overtime).toEqual([]);
  });

  test('employer UIF defaults to employee UIF, SDL derived at 1% when not supplied', () => {
    expect(out.uif_employer).toBe(64.30);
    expect(out.sdl).toBe(64.30);
    expect(out.sdl_source).toBe('derived');
  });

  test('YTD fields are filled (HI-03)', () => {
    expect(out.taxableGross).toBe(6430);
    expect(out.periodicTaxableGross).toBe(6430);
    expect(out.onceOffTaxableGross).toBe(0);
    expect(out.paye_base).toBe(0);
  });

  test('stored lines are returned as-is by the snapshot reader (never rebuilt)', () => {
    const f = PayrollHistoryService.formatForResponse(Object.assign({ id: 'x' }, r.snapshot));
    expect(f.payslip_lines_source).toBe('snapshot');
    expect(f.payslip_lines).toEqual(out.payslip_lines);
  });

  test('the import batch is recorded for undo', () => {
    expect(r.snapshot.calculation_input._import.batch_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(r.snapshot.calculation_input._import.source).toBe('screen_import');
  });
});

describe('net check (HI-09)', () => {
  test('mismatch is refused unless accepted', () => {
    const row = Object.assign(baseRow(), { net: 6000 });          // R115.70 unexplained
    const r = build({ row });
    expect(r.errors[0]).toMatch(/Net does not add up/);
    expect(r.mismatch.difference).toBe(115.70);
  });
  test('accepted mismatch becomes a "Not allocated" deduction and still balances', () => {
    const row = Object.assign(baseRow(), { net: 6000 });
    const r = build({ row, acceptMismatch: true });
    expect(r.errors).toEqual([]);
    const out = r.snapshot.calculation_output;
    expect(out.payslip_lines.find(l => l.kind === 'unallocated' && l.section === 'deduction').amount).toBe(115.70);
    expect(out.net).toBe(6000);
    expect(out.payslip_check.ok).toBe(true);
  });
  test('net above gross − deductions is always refused', () => {
    const r = build({ row: Object.assign(baseRow(), { net: 7000 }), acceptMismatch: true });
    expect(r.errors[0]).toMatch(/more than/);
  });
});

describe('gross handling', () => {
  test('gross above the lines → "Not allocated" earning', () => {
    const r = build({ row: Object.assign(baseRow(), { gross: 6530, net: 6215.70 }) });
    expect(r.errors).toEqual([]);
    expect(r.snapshot.calculation_output.payslip_lines.find(l => l.kind === 'unallocated').amount).toBe(100);
  });
  test('lines above gross → refused', () => {
    expect(build({ row: Object.assign(baseRow(), { gross: 6000 }) }).errors[0]).toMatch(/more than gross/);
  });
  test('gross omitted → derived from basic + earnings lines', () => {
    const r = build({ row: Object.assign(baseRow(), { gross: null }) });
    expect(r.snapshot.calculation_output.gross).toBe(6430);
  });
  test('PAYE and UIF are required', () => {
    expect(build({ row: Object.assign(baseRow(), { paye: null }) }).errors).toContain('PAYE is missing');
    expect(build({ row: Object.assign(baseRow(), { uif: null }) }).errors).toContain('UIF is missing');
  });
});

describe('taxable income + item rules', () => {
  test('pre-tax deduction and partly taxable allowance reduce taxable income; bonus (3605) is once-off', () => {
    const row = {
      row: 3, employee_number: 'T002', period: '2026-09', basic_salary: 10000, paye: 1000, uif: 177.12, net: null,
      lines: [
        { column: 'allowance_travel', amount: 1000 },          // 80% taxable
        { column: 'allowance_bonus', amount: 2000 },
        { column: 'deduction_provident', amount: 500 }
      ]
    };
    const r = build({ row, mapping: {
      allowance_travel: { target: 'item', master_item_id: 47 },
      allowance_bonus: { target: 'item', master_item_id: 46 },
      deduction_provident: { target: 'item', master_item_id: 40 }
    } });
    expect(r.errors).toEqual([]);
    const out = r.snapshot.calculation_output;
    expect(out.gross).toBe(13000);
    expect(out.taxableGross).toBe(13000 - 200 - 500);
    expect(out.onceOffTaxableGross).toBe(2000);
    expect(out.periodicTaxableGross).toBe(10300);
    expect(out.preTaxDeductions).toBe(500);
    expect(out.net).toBe(13000 - 1000 - 177.12 - 500);
  });

  test('mapping to an item on the wrong side is refused', () => {
    const r = build({ mapping: Object.assign({}, mapping, { allowance_75_percent: { target: 'item', master_item_id: 36 } }) });
    expect(r.errors[0]).toMatch(/is an earning, but "Salary Advance" is not/);
  });

  test('unmapped column is kept as its own line, named after the column', () => {
    const r = build({ mapping: Object.assign({}, mapping, { allowance_75_percent: { target: 'none' } }) });
    expect(r.errors).toEqual([]);
    expect(r.snapshot.calculation_output.payslip_lines.find(l => l.column === 'allowance_75_percent').description).toBe('75 percent');
  });

  test('taxable_gross and sdl columns win when supplied', () => {
    const r = build({ row: Object.assign(baseRow(), { taxable_gross: 6000, sdl: 0, uif_employer: 60 }) });
    const out = r.snapshot.calculation_output;
    expect(out.taxableGross).toBe(6000);
    expect(out.sdl).toBe(0);
    expect(out.sdl_source).toBe('file');
    expect(out.uif_employer).toBe(60);
  });
});

describe('EMP501 / e@syFile reads the imported lines by IRP5 code (HI-11)', () => {
  test('amounts split per code; overtime 3607; basic − short time in 3601', () => {
    const snap = build().snapshot;
    const a = Easyfile.snapshotAmounts(snap, masters);
    expect(a.income[3607]).toBeCloseTo(70, 2);
    // 7.5% allowance coded 3601 + residual basic − short time = 450 + 5910
    expect(a.income[3601]).toBeCloseTo(6360, 2);
    expect(a.residualNegative).toBe(false);
    expect(a.paye).toBe(0);
  });
});

describe('suggestTarget — automatic column linking (HI-07)', () => {
  test.each([
    ['allowance_75_percent', { target: 'item', master_item_id: 35 }],
    ['deduction_salary_advance', { target: 'item', master_item_id: 36 }],
    ['allowance_overtime', { target: 'overtime' }],
    ['allowance_short_time', { target: 'short_time' }],
    ['allowance_mystery', { target: 'none' }]
  ])('%s', (col, expected) => {
    expect(H.suggestTarget(col, masters)).toEqual(expected);
  });
});

describe('importEligibility — inactive employees', () => {
  const p = { start_date: '2026-03-01', end_date: '2026-03-31' };
  test('months before the end of service import', () => {
    expect(H.importEligibility({ is_active: false, termination_date: '2026-06-30' }, p).ok).toBe(true);
  });
  test('months after the end of service are refused', () => {
    expect(H.importEligibility({ is_active: false, termination_date: '2026-02-15' }, p).ok).toBe(false);
  });
  test('months before the hire date are refused', () => {
    expect(H.importEligibility({ is_active: true, hire_date: '2026-05-01' }, p).ok).toBe(false);
  });
});
