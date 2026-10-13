'use strict';

/**
 * Tests — tax tables per tax year (Fase 1, spec 02 BT-01..15).
 *   - seed rows (migration 027) are valid and match the engine code defaults
 *   - a period always gets ITS OWN tax year's table; missing / unconfirmed years stop
 *   - before migration 027 the legacy KV tax_config is still used
 *   - the engine never applies an override from another tax year (finding W3)
 *   - PUT /api/payroll/tax-tables: super user in the authority company only, validated, audited
 */

const express = require('express');
const { createFakeSupabase } = require('./golden/fake-supabase');
const { loadTaxTableSeedRows } = require('./helpers/taxTableSeed');

const mockDb = {};
const mockAudit = [];
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.companyId = Number(req.headers['x-company'] || 1);
    req.user = { userId: 5, role: req.headers['x-role'] || 'admin' };
    next();
  },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({
  auditFromReq: async (req, action, entity, id, extra) => { mockAudit.push({ action, entity, extra }); }
}));
jest.mock('../shared/utils/globalAuthority', () => ({
  isGlobalPayrollAuthority: async (companyId) => Number(companyId) === 1
}));

const PayrollEngine = require('../core/payroll-engine');
const {
  getTaxConfigForPeriod, validateTaxTableRow, rowToEngineTables, taxYearDates
} = require('../modules/payroll/services/taxTables');

const SEED = loadTaxTableSeedRows();
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('seed rows (migration 027)', () => {
  test('every seeded year passes validation and is confirmed', () => {
    SEED.forEach(r => {
      expect(validateTaxTableRow(r)).toEqual([]);
      expect(r.confirmed).toBe(true);
      expect(taxYearDates(r.tax_year)).toEqual({ valid_from: r.valid_from, valid_to: r.valid_to });
    });
  });

  test('engine code defaults (HISTORICAL_TABLES) mirror the migration exactly', () => {
    SEED.forEach(r => {
      const code = PayrollEngine.HISTORICAL_TABLES[r.tax_year];
      expect(code).toBeDefined();
      const fromDb = rowToEngineTables(r);
      expect(code.BRACKETS).toEqual(fromDb.BRACKETS);
      ['PRIMARY_REBATE', 'SECONDARY_REBATE', 'TERTIARY_REBATE', 'UIF_RATE', 'UIF_MONTHLY_CAP', 'SDL_RATE',
       'MEDICAL_CREDIT_MAIN', 'MEDICAL_CREDIT_FIRST_DEP', 'MEDICAL_CREDIT_ADDITIONAL'].forEach(k => {
        expect([r.tax_year, k, code[k]]).toEqual([r.tax_year, k, fromDb[k]]);
      });
    });
  });

  test('engine top-level defaults = the latest year (2026/2027)', () => {
    const latest = PayrollEngine.HISTORICAL_TABLES[PayrollEngine.TAX_YEAR];
    expect(PayrollEngine.TAX_YEAR).toBe('2026/2027');
    expect(PayrollEngine.BRACKETS).toEqual(latest.BRACKETS);
    expect(PayrollEngine.PRIMARY_REBATE).toBe(latest.PRIMARY_REBATE);
    expect(PayrollEngine.MEDICAL_CREDIT_ADDITIONAL).toBe(latest.MEDICAL_CREDIT_ADDITIONAL);
  });

  test('SARS example: R300 000 a year in 2026/2027 = R40 572 (B10: no R1 offset)', () => {
    const t = rowToEngineTables(SEED.find(r => r.tax_year === '2026/2027'));
    const b = PayrollEngine._calcAnnualTaxBreakdown(300000, 40, t);
    expect(b.grossTax).toBeCloseTo(44118 + 0.26 * (300000 - 245100), 2);
    expect(b.netTax).toBeCloseTo(40572, 2);
  });
});

describe('validateTaxTableRow', () => {
  const good = () => clone(SEED.find(r => r.tax_year === '2026/2027'));

  test('rejects the old "min = previous max + 1" convention', () => {
    const r = good(); r.brackets[1].min = 245101;
    expect(validateTaxTableRow(r).join(' ')).toMatch(/previous bracket's max/);
  });
  test('rejects a top bracket with a maximum', () => {
    const r = good(); r.brackets[6].max = 9999999;
    expect(validateTaxTableRow(r).join(' ')).toMatch(/last bracket/);
  });
  test('rejects a rate typed as a percentage (26 instead of 0.26)', () => {
    const r = good(); r.brackets[1].rate = 26;
    expect(validateTaxTableRow(r).join(' ')).toMatch(/rate must be between 0 and 1/);
  });
  test('rejects a bad tax year label', () => {
    expect(validateTaxTableRow(Object.assign(good(), { tax_year: '2027/2029' })).length).toBeGreaterThan(0);
    expect(validateTaxTableRow(Object.assign(good(), { tax_year: '2027' })).length).toBeGreaterThan(0);
  });
  test('rejects a missing rebate', () => {
    const r = good(); delete r.primary_rebate;
    expect(validateTaxTableRow(r).join(' ')).toMatch(/primary_rebate/);
  });
});

describe('getTaxConfigForPeriod', () => {
  const db = () => ({ payroll_tax_tables: clone(SEED), payroll_kv_store_eco: [] });

  test('each period gets its own tax year — no "active year" (BT-03)', async () => {
    const sb = createFakeSupabase(db());
    expect((await getTaxConfigForPeriod(sb, 7, '2026-02')).TAX_YEAR).toBe('2025/2026');
    expect((await getTaxConfigForPeriod(sb, 7, '2026-03')).TAX_YEAR).toBe('2026/2027');
    expect((await getTaxConfigForPeriod(sb, 7, '2027-02')).TAX_YEAR).toBe('2026/2027');
    const t = await getTaxConfigForPeriod(sb, 7, '2024-06');
    expect(t.TAX_YEAR).toBe('2024/2025');
    expect(t.BRACKETS[6].max).toBe(Infinity);
  });

  test('a missing year stops with TAX_TABLES_MISSING — never a silent guess (BT-15)', async () => {
    const sb = createFakeSupabase(db());
    await expect(getTaxConfigForPeriod(sb, 7, '2027-03')).rejects.toMatchObject({ code: 'TAX_TABLES_MISSING', taxYear: '2027/2028' });
  });

  test('an unconfirmed year stops too, with its own message', async () => {
    const d = db(); d.payroll_tax_tables.find(r => r.tax_year === '2026/2027').confirmed = false;
    const sb = createFakeSupabase(d);
    await expect(getTaxConfigForPeriod(sb, 7, '2026-10')).rejects.toThrow(/not confirmed/);
  });

  describe('before migration 027 (table missing) the legacy KV config is used', () => {
    const missingTableSb = (kvRows) => {
      const real = createFakeSupabase({ payroll_kv_store_eco: kvRows });
      const errQ = {
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.payroll_tax_tables' in the schema cache" } })
      };
      return { from: (t) => t === 'payroll_tax_tables' ? errQ : real.from(t) };
    };

    test('global first', async () => {
      const sb = missingTableSb([
        { company_id: '__global__', key: 'tax_config', value: { TAX_YEAR: 'G' } },
        { company_id: '7', key: 'tax_config', value: { TAX_YEAR: 'C' } }
      ]);
      expect((await getTaxConfigForPeriod(sb, 7, '2026-10')).TAX_YEAR).toBe('G');
    });
    test('then the company row; string JSON is parsed', async () => {
      const sb = missingTableSb([{ company_id: '7', key: 'tax_config', value: '{"TAX_YEAR":"C"}' }]);
      expect((await getTaxConfigForPeriod(sb, 7, '2026-10')).TAX_YEAR).toBe('C');
    });
    test('nothing stored → null (engine code defaults)', async () => {
      expect(await getTaxConfigForPeriod(missingTableSb([]), 7, '2026-10')).toBeNull();
    });
  });
});

describe('engine getTablesForPeriod — override only for its own year (W3)', () => {
  const override = { TAX_YEAR: '2026/2027', marker: 'override' };

  test('override of the same year is used', () => {
    expect(PayrollEngine.getTablesForPeriod('2026-10', override)).toBe(override);
  });
  test('override of another year is ignored → that year\'s historical table', () => {
    expect(PayrollEngine.getTablesForPeriod('2024-06', override)).toBe(PayrollEngine.HISTORICAL_TABLES['2024/2025']);
  });
  test('an unlabelled override is still trusted (old callers)', () => {
    const o = { marker: 'x' };
    expect(PayrollEngine.getTablesForPeriod('2024-06', o)).toBe(o);
  });
  test('no period → override as-is', () => {
    expect(PayrollEngine.getTablesForPeriod(null, override)).toBe(override);
  });
});

describe('/api/payroll/tax-tables routes', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/tt', require('../modules/payroll/routes/tax-tables'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => {
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, { payroll_tax_tables: clone(SEED), payroll_kv_store_eco: [] });
    mockAudit.length = 0;
  });

  const call = async (method, body, headers = {}) => {
    const r = await fetch(base + '/tt', {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json() };
  };
  const SUPER = { 'x-role': 'super_admin', 'x-company': '1' };
  const next = () => {
    const r = clone(SEED.find(x => x.tax_year === '2026/2027'));
    return Object.assign(r, { tax_year: '2027/2028', confirmed: false, source: 'test' });
  };

  test('GET lists every year; can_edit only for a super user in the authority company', async () => {
    const a = await call('GET', null, { 'x-role': 'admin', 'x-company': '1' });
    expect(a.body.migrated).toBe(true);
    expect(a.body.tables.map(t => t.tax_year)).toEqual(SEED.map(r => r.tax_year));
    expect(a.body.can_edit).toBe(false);
    expect((await call('GET', null, { 'x-role': 'super_admin', 'x-company': '9' })).body.can_edit).toBe(false);
    expect((await call('GET', null, SUPER)).body.can_edit).toBe(true);
  });

  test('PUT refused for a normal admin and for a super user in another company', async () => {
    expect((await call('PUT', next(), { 'x-role': 'admin', 'x-company': '1' })).status).toBe(403);
    expect((await call('PUT', next(), { 'x-role': 'super_admin', 'x-company': '9' })).status).toBe(403);
    expect(mockDb.payroll_tax_tables.some(r => r.tax_year === '2027/2028')).toBe(false);
  });

  test('PUT validates (bad bracket chain → 400, nothing saved)', async () => {
    const bad = next(); bad.brackets[2].min = 1;
    const r = await call('PUT', bad, SUPER);
    expect(r.status).toBe(400);
    expect(mockDb.payroll_tax_tables.some(x => x.tax_year === '2027/2028')).toBe(false);
  });

  test('PUT creates a new year with its dates, and audits it', async () => {
    const r = await call('PUT', next(), SUPER);
    expect(r.status).toBe(200);
    expect(r.body.table).toMatchObject({ tax_year: '2027/2028', valid_from: '2027-03-01', valid_to: '2028-02-29', confirmed: false });
    expect(mockAudit[0]).toMatchObject({ action: 'CREATE', entity: 'payroll_tax_tables' });
  });

  test('unconfirm sends only { confirmed:false } but the FULL row is written (NOT NULL safe)', async () => {
    const r = await call('PUT', { tax_year: '2025/2026', confirmed: false }, SUPER);
    expect(r.status).toBe(200);
    const row = mockDb.payroll_tax_tables.find(x => x.tax_year === '2025/2026');
    expect(row.confirmed).toBe(false);
    expect(row.brackets.length).toBe(7);
    expect(row.primary_rebate).toBe(17235);
    expect(mockAudit[0].extra.oldValue.confirmed).toBe(true);
    expect(mockAudit[0].extra.newValue.confirmed).toBe(false);
  });

  test('confirming the CURRENT year mirrors it to the legacy KV key; other years do not', async () => {
    const cur = PayrollEngine.getTaxYearForPeriod(new Date().toISOString().slice(0, 7));
    await call('PUT', { tax_year: '2024/2025', confirmed: true }, SUPER);
    expect(mockDb.payroll_kv_store_eco.length).toBe(0);
    if (SEED.some(r => r.tax_year === cur)) {
      await call('PUT', { tax_year: cur, confirmed: true }, SUPER);
      const kv = mockDb.payroll_kv_store_eco.find(r => r.company_id === '__global__' && r.key === 'tax_config');
      expect(kv.value.TAX_YEAR).toBe(cur);
    }
  });
});

describe('BT-08 tax-year readiness (warning banner)', () => {
  const { taxYearReadiness } = require('../modules/payroll/routes/tax-tables');
  const rows = [{ tax_year: '2026/2027', confirmed: true }, { tax_year: '2027/2028', confirmed: false }];
  test('quiet during the year when the current year is confirmed', () => {
    expect(taxYearReadiness(rows, '2026-10').warn).toBe(false);
  });
  test('from February: warns when next year is not confirmed', () => {
    const r = taxYearReadiness(rows, '2027-02');
    expect([r.warn, r.next_tax_year, r.next_ready]).toEqual([true, '2027/2028', false]);
  });
  test('February is quiet once next year is confirmed', () => {
    expect(taxYearReadiness([rows[0], { tax_year: '2027/2028', confirmed: true }], '2027-02').warn).toBe(false);
  });
  test('current year missing / unconfirmed always warns', () => {
    expect(taxYearReadiness(rows, '2027-03').message).toMatch(/2027\/2028 are not confirmed/);
  });
});
