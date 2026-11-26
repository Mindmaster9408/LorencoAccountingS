'use strict';

/**
 * Firmflow ↔ Ledger Leo VAT registration + cycle (practice/lib/company-sync).
 * Fictional data only.
 */

const mockTables = {};
jest.mock('../config/database', () => ({
  supabase: {
    from: table => ({
      select: () => ({ in: async (col, ids) => ({ data: (mockTables[table] || []).filter(r => ids.includes(r[col])), error: null }) }),
    }),
  },
}));

const sync = require('../modules/practice/lib/company-sync');
const { derivePeriodForDate } = require('../modules/accounting/services/vatPeriodUtils');

describe('Leo → Firmflow vocabulary', () => {
  test.each([
    [{ vat_period: 'monthly' }, 'monthly', null],
    [{ vat_period: 'bi-monthly', vat_cycle_type: 'even' }, 'bi_monthly', 'even'],
    [{ vat_period: 'four-monthly' }, 'quarterly', null],
    [{ vat_period: 'six-monthly' }, '6_monthly', null],
    [{ vat_period: 'annually' }, 'annual', null],
  ])('%j → %s', (co, seq, parity) => {
    expect(sync.practiceVatFromCompany({ is_vat_registered: true, ...co }))
      .toEqual({ vat_registered: true, vat_payment_sequence: seq, vat_bi_monthly_parity: parity });
  });

  test('a company not registered in Leo leaves Firmflow\'s own values', () => {
    expect(sync.practiceVatFromCompany({ is_vat_registered: false, vat_period: 'bi-monthly', vat_cycle_type: 'even' })).toBeNull();
  });
});

describe('Firmflow → Leo on save', () => {
  test('bi-monthly odd', () => {
    expect(sync.companyVatUpdateFromPractice({ vat_registered: true, vat_payment_sequence: 'bi_monthly', vat_bi_monthly_parity: 'odd' }))
      .toEqual({ is_vat_registered: true, vat_period: 'bi-monthly', vat_cycle_type: 'odd' });
  });
  test('"Quarterly (every 4 months)" = Leo four-monthly; 6-monthly', () => {
    expect(sync.companyVatUpdateFromPractice({ vat_payment_sequence: 'quarterly' })).toEqual({ vat_period: 'four-monthly' });
    expect(sync.companyVatUpdateFromPractice({ vat_payment_sequence: '6_monthly' })).toEqual({ vat_period: 'six-monthly' });
  });
  test('"Not set" never clears Leo\'s cycle; parity without bi-monthly ignored', () => {
    expect(sync.companyVatUpdateFromPractice({ vat_registered: false, vat_payment_sequence: null, vat_bi_monthly_parity: 'odd' }))
      .toEqual({ is_vat_registered: false });
  });
  test('fields not in the body are not touched', () => {
    expect(sync.companyVatUpdateFromPractice({ name: 'x' })).toEqual({});
  });
});

describe('overlay', () => {
  beforeEach(() => {
    mockTables.eco_clients = [{ id: 10, client_company_id: 100 }, { id: 11, client_company_id: 101 }, { id: 12, client_company_id: null }];
    mockTables.companies = [
      { id: 100, is_vat_registered: true, vat_period: 'six-monthly', vat_cycle_type: null },
      { id: 101, is_vat_registered: false, vat_period: null, vat_cycle_type: null },
    ];
  });

  test('linked + registered in Leo → Leo values; otherwise unchanged', async () => {
    const out = await sync.overlayCompanyVat([
      { id: 1, eco_client_id: 10, vat_registered: false, vat_payment_sequence: null },
      { id: 2, eco_client_id: 11, vat_registered: true, vat_payment_sequence: 'bi_monthly', vat_bi_monthly_parity: null },
      { id: 3, eco_client_id: 12, vat_registered: true, vat_payment_sequence: 'monthly' },
      { id: 4, eco_client_id: null, vat_registered: false },
    ]);
    expect(out[0]).toEqual(expect.objectContaining({ vat_registered: true, vat_payment_sequence: '6_monthly', vat_settings_source: 'ledger' }));
    expect(out[1]).toEqual(expect.objectContaining({ vat_registered: true, vat_payment_sequence: 'bi_monthly' }));
    expect(out[1].vat_settings_source).toBeUndefined();
    expect(out[2].vat_payment_sequence).toBe('monthly');
    expect(out[3]).toEqual({ id: 4, eco_client_id: null, vat_registered: false });
  });

  test('no links → same list, no queries needed', async () => {
    const list = [{ id: 1 }];
    expect(await sync.overlayCompanyVat(list)).toBe(list);
  });
});

describe('deadline months match Leo\'s period maths', () => {
  const files = (seq, period) => derivePeriodForDate(`${period}-01`, sync.leoFrequencyOf({ vat_payment_sequence: seq })).periodKey === period;
  test('every 4 months: Feb, Jun, Oct only', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`).filter(p => files('quarterly', p));
    expect(months).toEqual(['2026-02', '2026-06', '2026-10']);
  });
  test('every 6 months: Feb, Aug only', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`).filter(p => files('6_monthly', p));
    expect(months).toEqual(['2026-02', '2026-08']);
  });
});
