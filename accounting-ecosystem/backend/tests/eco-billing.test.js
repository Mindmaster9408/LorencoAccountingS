/**
 * Eco billing — who pays, customer fields, invoice lines (pure functions).
 * Fictional data only.
 */
jest.mock('../config/database', () => ({ supabase: {} }));
jest.mock('../shared/services/email', () => ({ sendEmail: jest.fn() }));

const { computePayers, customerFieldsFor, buildLines } = require('../shared/services/ecoBilling');

const companies = [
  { id: 1,  company_name: 'Lorenco Practice', modules_enabled: ['pos'] },
  { id: 2,  company_name: 'Direct Client A' },
  { id: 6,  company_name: 'Other Practice', modules_enabled: ['payroll'] },
  { id: 8,  company_name: 'Practice Client 1' },
  { id: 9,  company_name: 'Practice Client 2' },
  { id: 51, company_name: 'Sandbox TEST' },
  { id: 60, company_name: 'Made under TEST' },
  { id: 70, company_name: 'Demo Co', is_demo: true },
  { id: 80, company_name: 'Self Registered' },
  { id: 90, company_name: 'Trial Practice', modules_enabled: ['payroll', 'accounting'] },
  { id: 91, company_name: 'Trial Demo', is_demo: true },
];
const eco = [
  { id: 1, name: 'Direct Client A', company_id: 1, client_company_id: 2, apps: ['payroll', 'accounting'], is_active: true },
  { id: 2, name: 'Practice Client 1', company_id: 6, client_company_id: 8, apps: ['payroll'], is_active: true },
  { id: 3, name: 'Practice Client 2', company_id: 6, client_company_id: 9, apps: ['payroll'], is_active: true },
  { id: 4, name: 'Sandbox TEST', company_id: 1, client_company_id: 51, apps: ['pos'], is_active: true, billing_excluded: true },
  { id: 5, name: 'Made under TEST', company_id: 51, client_company_id: 60, apps: ['accounting'], is_active: true },
  { id: 6, name: 'Demo Co', company_id: 6, client_company_id: 70, apps: ['payroll'], is_active: true },
  { id: 7, name: 'Self Registered', company_id: 80, client_company_id: 80, apps: ['payroll'], is_active: true },
  { id: 8, name: 'Gone', company_id: 1, client_company_id: 2, apps: ['pos'], is_active: false },
  { id: 9, name: 'Trial Demo', company_id: 90, client_company_id: 91, apps: ['payroll'], is_active: true },
];

describe('computePayers', () => {
  const payers = computePayers(eco, companies);

  test('TEST-BILL-01 a client of Lorenco\'s practice pays for itself', () => {
    expect(payers.get(2).clients.map(c => c.ecoClientId)).toEqual([1]);
  });
  test('TEST-BILL-02 another practice pays for all its clients on one invoice', () => {
    expect(payers.get(6).clients.map(c => c.ecoClientId).sort()).toEqual([2, 3]);
    expect(payers.has(8)).toBe(false);
    expect(payers.has(9)).toBe(false);
  });
  test('TEST-BILL-03 test company, rows made under it and demo companies are never billed', () => {
    for (const id of [51, 60, 70, 91]) expect(payers.has(id)).toBe(false);
    expect(payers.get(6).clients.some(c => c.companyId === 70)).toBe(false);
  });
  test('TEST-BILL-04 a self-registered company pays for itself', () => {
    expect(payers.get(80).clients.map(c => c.ecoClientId)).toEqual([7]);
    expect(payers.get(80).ownApps).toEqual([]);
  });
  test('TEST-BILL-05 inactive rows are skipped', () => {
    expect(payers.get(2).clients).toHaveLength(1);
  });
  test('TEST-BILL-06 practices (incl. Lorenco\'s, and one with only a demo) are billed for their own modules', () => {
    expect(payers.get(1).ownApps).toEqual(['pos']);
    expect(payers.get(6).ownApps).toEqual(['payroll']);
    expect(payers.get(90).ownApps).toEqual(['payroll', 'accounting']);
  });
});

describe('customerFieldsFor', () => {
  test('TEST-BILL-07 maps company data with fallbacks and drops empty values', () => {
    const f = customerFieldsFor(
      { company_name: 'Acme (Pty) Ltd', vat_number: '4000000000', contact_email: 'a@example.test',
        address_street: '1 Main Rd', address_suburb: 'Centre', address_city: 'Town', address_postal_code: '0001', phone: '' },
      { phone: '012 000 0000' }
    );
    expect(f).toEqual({
      name: 'Acme (Pty) Ltd', vat_number: '4000000000', email: 'a@example.test',
      address_line_1: '1 Main Rd', address_line_2: 'Centre', city: 'Town', postal_code: '0001',
      phone: '012 000 0000', contact_number: '012 000 0000',
    });
  });
});

describe('buildLines', () => {
  test('TEST-BILL-08 a line per app per client; Paytime shows active employees; unpriced = R0', () => {
    const payers = computePayers(eco, companies);
    const lines = buildLines(payers.get(6), 'Other Practice', { 8: 3, 9: 1, 6: 0 });
    expect(lines.map(l => l.description)).toEqual([
      'Lorenco Paytime — Other Practice (0 active employees)',
      'Lorenco Paytime — Practice Client 1 (3 active employees)',
      'Lorenco Paytime — Practice Client 2 (1 active employee)',
    ]);
    expect(lines.every(l => l.unitPrice === 0 && l.quantity === 1)).toBe(true);
  });
});
