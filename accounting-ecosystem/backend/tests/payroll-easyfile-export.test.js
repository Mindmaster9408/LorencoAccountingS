'use strict';

/**
 * Tests — spec 09 RS-07: SARS e@syFile import file (IRP5 / IT3(a)).
 * Expected layout follows SARS BRS V25.3.0 and two SimplePay files e@syFile accepted;
 * the reference numbers / ID / tax number are the BRS Appendix B examples (valid check digits).
 */

const express = require('express');
const E = require('../modules/payroll/services/easyfileExport');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1 }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));

const TODAY = new Date(Date.UTC(2026, 9, 28));

const COMPANY = {
  id: 7, company_name: 'Test Speech Therapy', paye_reference_number: '7230767891',
  uif_reference_number: 'U230767891', contact_person: 'Jane Van Tester',
  contact_phone: '011 555 0101', contact_email: 'payroll@example.co.za', sic7_code: '86900',
  address_street: '10 Example', address_city: 'Testville', address_postal_code: '1234'
};

const EMP = {
  id: 11, company_id: 7, first_name: 'Anna', last_name: 'Tester', id_number: '8001015009087',
  tax_number: '0001339050', phone: '0825550123', employee_code: 'E001', hire_date: '2020-01-01',
  payment_method: 'EFT', bank_account_type: 1, account_number: '1234567890', branch_code: '632005',
  bank_name: 'ABSA Bank', account_holder: 'Anna Tester',
  res_street_number: '1', res_street_name: 'Test Road', res_city: 'Testville', res_postal_code: '1234'
};

const MASTERS = [
  { id: 1, item_name: 'Commission', item_type: 'income', irp5_code: '3606' },
  { id: 2, item_name: 'Travel Allowance', item_type: 'allowance', irp5_code: '3701' },
  { id: 3, item_name: 'Annual Bonus', item_type: 'income', irp5_code: '3605' },
  { id: 4, item_name: 'Pension Fund', item_type: 'deduction', irp5_code: '4001' },
  { id: 5, item_name: 'Employer Pension', item_type: 'employer_contribution', irp5_code: '3817' },
  { id: 6, item_name: 'Staff Loan', item_type: 'deduction', irp5_code: null }
];

const snap = (employee_id, period_key, ci, out) => ({
  employee_id, period_key, created_at: '2026-10-01T00:00:00Z',
  calculation_input: ci, calculation_output: out
});

/** Independent re-calculation of the trailer, straight from the BRS text. */
function checkTrailer(text) {
  const lines = text.split('\r\n').filter(Boolean);
  let recs = 0, codes = 0, amounts = 0, trailer = null;
  lines.forEach(l => {
    const t = l.split(',');
    if (t[0] === '6010') { trailer = t; return; }
    recs++;
    for (let i = 0; i < t.length; i += 2) {
      const c = +t[i], v = t[i + 1];
      if ((c >= 2010 && c <= 2082) || (c >= 3010 && c <= 4497) || (c >= 4582 && c <= 4587) || (c >= 7002 && c <= 7009) || c === 9999) codes += c;
      if ((c >= 3601 && c <= 4497) || (c >= 4582 && c <= 4587) || (c >= 7002 && c <= 7004) || c === 7008) amounts += parseFloat(v);
    }
  });
  return { trailer, recs, codes, amounts: amounts.toFixed(2) };
}

describe('amounts per IRP5 code from a snapshot', () => {
  test('engine snapshot: items to their codes, rest of cash gross to 3601, employer pension pairs', () => {
    const a = E.snapshotAmounts(snap(11, '2026-03', {
      basic_salary: 20000,
      regular_inputs: [
        { description: 'Travel Allowance', type: 'allowance', amount: 3000, taxable_percentage: 80 },
        { description: 'Pension Fund', type: 'deduction', amount: 1000, tax_treatment: 'pre_tax' },
        { description: 'Employer Pension', type: 'employer_contribution', amount: 500, irp5_code: '3817' },
        { description: 'Staff Loan', type: 'deduction', amount: 300 }
      ],
      currentInputs: [{ description: 'Commission', type: 'earning', amount: 2000 }]
    }, { gross: 25000, paye: 3000, uif: 177.12, uif_employer: 177.12, sdl: 250, overtimeAmount: 0 }), MASTERS);
    expect(a.income).toEqual({ 3601: 20000, 3701: 3000, 3606: 2000, 3817: 500 });
    expect(a.deductions).toEqual({ 4001: 1500, 4472: 500 });
    expect(a.portionTaxable).toBe(2400);
    expect(a.uif).toBeCloseTo(354.24);
    expect(a.missing).toEqual([]);
  });

  test('imported month without a breakdown → all under 3601; overtime → 3607; sub-code → main', () => {
    const a = E.snapshotAmounts(snap(11, '2026-04', {
      basic_salary: 9229, currentInputs: [{ description: 'Annual Bonus', type: 'earning', amount: 9229 },
        { description: 'Tool money', type: 'earning', amount: 100, irp5_code: '3711' }]
    }, { gross: 20458, overtimeAmount: 1000 }), MASTERS);
    expect(a.income).toEqual({ 3605: 9229, 3713: 100, 3607: 1000, 3601: 10129 });
  });

  test('item without an IRP5 code is reported; net-only deduction without a code is not', () => {
    const a = E.snapshotAmounts(snap(11, '2026-05', {
      basic_salary: 1000, regular_inputs: [{ description: 'Mystery', type: 'earning', amount: 50 },
        { description: 'Staff Loan', type: 'deduction', amount: 20 }]
    }, { gross: 1050 }), MASTERS);
    expect(a.missing).toEqual(['Mystery']);
  });
});

describe('certificate record', () => {
  // A full-year IRP5: bonus 3605, commission 3606, travel allowance 3701 taxed on 80%.
  function annualEmployee() {
    const months = ['2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'];
    return months.map((p, i) => snap(11, p, {
      basic_salary: 0,
      regular_inputs: [{ description: 'Travel Allowance', type: 'allowance', amount: i === 0 ? 8000 : 0, taxable_percentage: 80 }],
      currentInputs: [{ description: 'Commission', type: 'earning', amount: i === 0 ? 250000 : 0 },
        { description: 'Annual Bonus', type: 'earning', amount: i === 0 ? 5000 : 0 }]
    }, i === 0 ? { gross: 263000, paye: 35000, uif: 100, uif_employer: 100, sdl: 0 } : { gross: 0, paye: 0, uif: 0, sdl: 0 }));
  }

  test('IRP5 line is laid out like the files e@syFile accepted', () => {
    const r = E.build({ company: COMPANY, employees: [EMP], snapshots: annualEmployee(), codeSource: MASTERS,
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    expect(r.employer.issues).toEqual([]);
    const c = r.certificates[0];
    expect(c.issues).toEqual([]);
    expect(c.type).toBe('IRP5');
    const text = E.fileFor(r, { 11: E.certificateNumber('7230767891', 2026, '02', 1) });
    const [head, line, trail] = text.split('\r\n');
    expect(head).toBe('2010,"Test Speech Therapy",2015,"LIVE",2020,7230767891,2024,"U230767891",2025,"Jane",2036,"Van Tester",'
      + '2026,"0115550101",2027,"payroll@example.co.za",2028,"Lorenco",2029,"Paytime",2030,2026,2031,202602,2037,"N",2082,"86900",'
      + '2063,"10",2064,"Example",2066,"Testville",2080,1234,2081,ZA,9999');
    expect(line).toBe('3010,"723076789120260200000000000001",3015,"IRP5",3020,"A",3025,2026,3026,N,3030,"Tester",3040,"Anna",3050,"A",'
      + '3060,8001015009087,3080,19800101,3100,0001339050,3136,"0825550123",3146,"10",3147,"Example",3149,"Testville",3150,"1234",3151,ZA,'
      + '3160,"E001",3170,20250301,3180,20260228,3195,"N",3200,12.0000,3210,12.0000,3213,"1",3214,"Test Road",3216,"Testville",'
      + '3217,"1234",3220,"N",3240,1,3241,1234567890,3242,632005,3243,"ABSA Bank",3245,"Anna Tester",3246,1,3263,"86900",3279,N,3285,ZA,3288,1,'
      + '3605,5000,3606,250000,3699,263000,3701,8000,4102,35000.00,4141,200.00,4149,35200.00,4497,6400,4582,6400,9999');
    const chk = checkTrailer(text);
    expect(trail).toBe(`6010,${chk.recs},6020,${chk.codes},6030,${chk.amounts},9999`);
    expect(chk.recs).toBe(2);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  test('no PAYE → IT3(a) with reason 02, no 3195/3220/4102; tax number optional', () => {
    const r = E.build({ company: COMPANY, employees: [{ ...EMP, tax_number: '' }], codeSource: MASTERS,
      snapshots: [snap(11, '2025-06', { basic_salary: 6000 }, { gross: 6000, paye: 0, uif: 60, uif_employer: 60 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    const c = r.certificates[0];
    expect(c.type).toBe('IT3(a)');
    expect(c.issues).toEqual([]);
    const codes = c.fields.map(f => f[0]);
    expect(codes).toContain(4150);
    expect(codes).not.toContain(4102);
    expect(codes).not.toContain(3195);
    expect(codes).not.toContain(3220);
    expect(codes).not.toContain(3100);
    expect(c.fields.find(f => f[0] === 4141)[1]).toBe('120.00');
  });

  test('IRP5 without a valid tax number, missing address and bank type are blocking', () => {
    const r = E.build({ company: COMPANY, codeSource: MASTERS,
      employees: [{ ...EMP, tax_number: '', res_street_name: '', res_city: '', bank_account_type: null }],
      snapshots: [snap(11, '2025-06', { basic_salary: 30000 }, { gross: 30000, paye: 4000, uif: 177.12 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    const c = r.certificates[0];
    expect(c.ready).toBe(false);
    expect(c.issues.join(' | ')).toMatch(/tax number/);
    expect(c.issues.join(' | ')).toMatch(/Residential address: street/);
    expect(c.issues.join(' | ')).toMatch(/Bank account type/);
  });

  test('cash-paid employee: account type 0 and no bank fields', () => {
    const r = E.build({ company: COMPANY, codeSource: MASTERS,
      employees: [{ ...EMP, payment_method: 'Cash', bank_account_type: null }],
      snapshots: [snap(11, '2025-06', { basic_salary: 30000 }, { gross: 30000, paye: 4000, uif: 177.12 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    const codes = r.certificates[0].fields.map(f => f[0]);
    expect(r.certificates[0].fields.find(f => f[0] === 3240)[1]).toBe('0');
    expect(codes).not.toContain(3241);
    expect(r.certificates[0].ready).toBe(true);
  });

  test('4582 is capped at 80% of the travel allowance when PAYE was on 100%', () => {
    const r = E.build({ company: COMPANY, employees: [EMP], codeSource: MASTERS,
      snapshots: [snap(11, '2025-06', { basic_salary: 20000,
        regular_inputs: [{ description: 'Travel Allowance', type: 'allowance', amount: 5000, taxable_percentage: 100 }] },
      { gross: 25000, paye: 4000, uif: 177.12 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    const c = r.certificates[0];
    expect(c.fields.find(f => f[0] === 4582)[1]).toBe('4000');
    expect(c.warnings.join(' ')).toMatch(/capped at 80%/);
  });

  test('employer pension: 3817 income, 4472 + 4001 deductions, 4497 total', () => {
    const r = E.build({ company: COMPANY, employees: [EMP], codeSource: MASTERS,
      snapshots: [snap(11, '2025-06', { basic_salary: 20000,
        regular_inputs: [{ description: 'Employer Pension', type: 'employer_contribution', amount: 1500, irp5_code: '3817' },
          { description: 'Pension Fund', type: 'deduction', amount: 1500, tax_treatment: 'pre_tax' }] },
      { gross: 20000, paye: 2500, uif: 177.12 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    const f = Object.fromEntries(r.certificates[0].fields);
    expect(f[3817]).toBe('1500');
    expect(f[3699]).toBe('21500');
    expect(f[4001]).toBe('3000');
    expect(f[4472]).toBe('1500');
    expect(f[4497]).toBe('4500');
  });

  test('medical credit without a 4005 medical aid item is blocking', () => {
    const r = E.build({ company: COMPANY, employees: [EMP], codeSource: MASTERS,
      snapshots: [snap(11, '2025-06', { basic_salary: 20000 }, { gross: 20000, paye: 2000, uif: 177.12, medicalCredit: 364 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    expect(r.certificates[0].issues.join(' ')).toMatch(/4005/);
  });
});

describe('interim and company checks', () => {
  test('interim: window Mar–Aug, ongoing employee 08 to 31 Aug, terminated employee final 02', () => {
    const r = E.build({ company: COMPANY, codeSource: MASTERS,
      employees: [EMP, { ...EMP, id: 12, termination_date: '2026-06-25' }],
      snapshots: [
        snap(11, '2026-03', { basic_salary: 20000 }, { gross: 20000, paye: 2000, uif: 177.12 }),
        snap(12, '2026-03', { basic_salary: 20000 }, { gross: 20000, paye: 2000, uif: 177.12 })
      ],
      taxYear: '2026/2027', period: 'interim', today: TODAY });
    expect(r.window).toMatchObject({ transactionYear: 2027, reconPeriod: 202608 });
    expect(r.window.periods).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    const [a, b] = [r.certificates.find(c => c.employee_id === 11), r.certificates.find(c => c.employee_id === 12)];
    expect(a.certPeriod).toBe('08');
    expect(Object.fromEntries(a.fields)[3180]).toBe('20260831');
    expect(Object.fromEntries(a.fields)[3210]).toBe('6.0000');
    expect(b.certPeriod).toBe('02');
    expect(b.finalCert).toBe(true);
    expect(Object.fromEntries(b.fields)[3180]).toBe('20260625');
  });

  test('company: SIC7, contact surname, bad PAYE check digit and SDL/UIF suffix are reported', () => {
    const r = E.build({ company: { ...COMPANY, sic7_code: '', contact_person: 'Jane', paye_reference_number: '7230767892',
      sdl_reference_number: 'L111111111' }, employees: [EMP], snapshots: [], codeSource: MASTERS,
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    const all = r.employer.issues.join(' | ');
    expect(all).toMatch(/SIC7/);
    expect(all).toMatch(/first name and a surname/);
    expect(all).toMatch(/check digit/);
    expect(all).toMatch(/SDL reference/);
  });

  test('UIF paid without a SARS UIF number: one company problem, with the expected number; Labour number refused', () => {
    const r = E.build({ company: { ...COMPANY, uif_reference_number: '' }, employees: [EMP], codeSource: MASTERS,
      snapshots: [snap(11, '2025-06', { basic_salary: 20000 }, { gross: 20000, paye: 2000, uif: 177.12 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    expect(r.employer.issues).toEqual(['UIF was deducted but the SARS UIF reference number is missing (Company Details) — normally U230767891']);
    expect(r.certificates[0].issues).toEqual([]);
    const r2 = E.build({ company: { ...COMPANY, uif_reference_number: '1234567/8' }, employees: [], snapshots: [], codeSource: MASTERS,
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    expect(r2.employer.issues.join(' ')).toMatch(/not the Labour UIF number\) — normally U230767891/);
  });

  test('public-sector SIC7 (Appendix D) leaves out the ETI indicator 3026', () => {
    const r = E.build({ company: { ...COMPANY, sic7_code: '84111' }, employees: [EMP], codeSource: MASTERS,
      snapshots: [snap(11, '2025-06', { basic_salary: 20000 }, { gross: 20000, paye: 2000, uif: 177.12 })],
      taxYear: '2025/2026', period: 'annual', today: TODAY });
    expect(r.certificates[0].fields.map(f => f[0])).not.toContain(3026);
  });

  test('bad tax year is refused', () => {
    expect(() => E.reconWindow('2026', 'annual')).toThrow(/taxYear/);
  });
});

describe('POST /easyfile — certificate numbers', () => {
  let server, base;
  beforeAll(async () => {
    Object.assign(mockDb, {
      companies: [COMPANY],
      employees: [EMP],
      payroll_items_master: MASTERS.map(m => ({ ...m, company_id: 7, is_active: true })),
      payroll_snapshots: [
        { company_id: 7, employee_id: 11, period_key: '2025-06', is_locked: true, created_at: '2025-07-01T00:00:00Z',
          calculation_input: { basic_salary: 20000 }, calculation_output: { gross: 20000, paye: 2000, uif: 177.12, uif_employer: 177.12 } },
        { company_id: 7, employee_id: 11, period_key: '2025-06', is_locked: true, created_at: '2025-06-01T00:00:00Z',
          calculation_input: { basic_salary: 1 }, calculation_output: { gross: 1, paye: 0, uif: 0 } }   // older duplicate: ignored
      ],
      payroll_tax_certificates: []
    });
    const app = express();
    app.use(express.json());
    app.use('/recon', require('../modules/payroll/routes/recon'));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/recon`;
  });
  afterAll(() => server.close());

  const post = (body) => fetch(base + '/easyfile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('preview lists the employee as ready, nothing written', async () => {
    const r = await fetch(base + '/easyfile?taxYear=2025/2026&period=annual').then(x => x.json());
    expect(r.companyIssues).toEqual([]);
    expect(r.summary).toMatchObject({ certificates: 1, ready: 1, irp5: 1, paye: 2000 });
    expect(mockDb.payroll_tax_certificates).toHaveLength(0);
  });

  test('download issues a 30-character number and reuses it on the next export', async () => {
    const res1 = await post({ taxYear: '2025/2026', period: 'annual' });
    expect(res1.status).toBe(200);
    const t1 = await res1.text();
    const n1 = /^3010,"([0-9]{30})"/m.exec(t1)[1];
    expect(n1.startsWith('7230767891202602')).toBe(true);
    expect(mockDb.payroll_tax_certificates).toHaveLength(1);
    expect(mockDb.payroll_tax_certificates[0]).toMatchObject({ certificate_number: n1, certificate_type: 'IRP5', status: 'issued' });

    const t2 = await (await post({ taxYear: '2025/2026', period: 'annual', mode: 'TEST' })).text();
    expect(/^3010,"([0-9]{30})"/m.exec(t2)[1]).toBe(n1);
    expect(t2).toMatch(/2015,"TEST"/);
    expect(mockDb.payroll_tax_certificates).toHaveLength(1);
  });

  test('company problems block the download', async () => {
    mockDb.companies[0].sic7_code = '';
    const res = await post({ taxYear: '2025/2026', period: 'annual' });
    expect(res.status).toBe(422);
    expect((await res.json()).companyIssues.join(' ')).toMatch(/SIC7/);
    mockDb.companies[0].sic7_code = '86900';
  });
});
