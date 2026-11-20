/**
 * Lorenco companies by ID (2026-11-20): super profile = 1, Lorenco Accounting Services = 38.
 * Fictional data only.
 */
jest.mock('../config/database', () => ({ supabase: {} }));
jest.mock('../shared/services/email', () => ({ sendEmail: jest.fn() }));

const E = require('../shared/utils/ecoCompanies');
const { computePayers } = require('../shared/services/ecoBilling');

describe('ecoCompanies', () => {
  test('defaults: super profile 1, Lorenco practice 38', () => {
    expect(E.SUPER_COMPANY_ID()).toBe(1);
    expect(E.LORENCO_PRACTICE_ID()).toBe(38);
    expect(E.isSuperCompany(1)).toBe(true);
    expect(E.isSuperCompany('1')).toBe(true);
    expect(E.isSuperCompany(38)).toBe(false);
    expect(E.isStocktonManager(1)).toBe(true);
    expect(E.isStocktonManager(38)).toBe(true);
    expect(E.isStocktonManager(6)).toBe(false);
    expect(E.isStocktonManager(null)).toBe(false);
  });

  test('companyMayUseStockton: the two Lorenco companies, and active clients they manage', async () => {
    const calls = [];
    const db = (rows) => ({ from: () => {
      const q = { select: () => q, eq: (k, v) => { calls.push([k, v]); return q; }, in: (k, v) => { calls.push([k, v]); return q; },
        limit: async () => ({ data: rows, error: null }) };
      return q;
    } });
    expect(await E.companyMayUseStockton(db([]), 38)).toBe(true);
    expect(calls).toEqual([]);                                   // no lookup needed for 1 / 38
    expect(await E.companyMayUseStockton(db([{ id: 5 }]), 7)).toBe(true);
    expect(calls).toEqual([['client_company_id', 7], ['is_active', true], ['company_id', [1, 38]]]);
    expect(await E.companyMayUseStockton(db([]), 9)).toBe(false);
    expect(await E.companyMayUseStockton(db([]), null)).toBe(false);
  });

  test('billing: clients of Lorenco Accounting (38) pay themselves; clients of another practice are billed to it', () => {
    const companies = [{ id: 1, modules_enabled: ['pos'] }, { id: 38, modules_enabled: ['payroll', 'practice'] },
      { id: 7 }, { id: 6, modules_enabled: ['practice'] }, { id: 8 }];
    const eco = [
      { id: 1, company_id: 38, client_company_id: 38, apps: ['payroll', 'practice'], is_active: true },   // practice's own row
      { id: 2, company_id: 38, client_company_id: 7, apps: ['accounting'], is_active: true },
      { id: 3, company_id: 6, client_company_id: 8, apps: ['accounting'], is_active: true }
    ];
    const p = computePayers(eco, companies);
    expect(p.get(7).clients.map(c => c.companyId)).toEqual([7]);
    expect(p.get(38).clients.map(c => c.companyId)).toEqual([38]);
    expect(p.get(6).clients.map(c => c.companyId)).toEqual([8]);
    expect(p.has(8)).toBe(false);
  });

  test('billing: a client still held by the super profile (1) also pays for itself', () => {
    const p = computePayers([{ id: 9, company_id: 1, client_company_id: 3, apps: ['accounting'], is_active: true }],
      [{ id: 1, modules_enabled: ['pos'] }, { id: 3 }]);
    expect(p.get(3).clients.map(c => c.companyId)).toEqual([3]);
    expect(p.get(1).clients).toEqual([]);
  });
});
