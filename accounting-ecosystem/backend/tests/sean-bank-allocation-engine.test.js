/**
 * Tests — Sean bank allocation engine (Phase 1: suggest + prefill)
 * All data fictional.
 */
const E = require('../sean/bank-allocation-engine');

const ACCOUNTS = [
  { id: 1, code: '6700', name: 'Bank Charges and Fees', type: 'expense' },
  { id: 2, code: '6000', name: 'Salaries and Wages', type: 'expense' },
  { id: 3, code: '6300', name: 'Motor Vehicle — Fuel', type: 'expense' },
  { id: 4, code: '4000', name: 'Sales Revenue', type: 'income' },
  { id: 5, code: '4500', name: 'Interest Received', type: 'income' },
  { id: 6, code: '6500', name: 'Computer and IT Expenses', type: 'expense' },
  { id: 7, code: '2000', name: 'Accounts Payable', type: 'liability' },
  { id: 8, code: '6900', name: 'Old Expenses', type: 'expense', is_active: false },
  { id: 9, code: '6800', name: 'Insurance — Business', type: 'expense' },
  { id: 10, code: '6320', name: 'Motor Vehicle — Insurance and Licensing', type: 'expense' }
];
const VAT = [{ id: 31, name: 'Standard 15%' }];

const h = (description, amount, accountId, date, extra = {}) =>
  ({ description, amount, allocated_account_id: accountId, vat_setting_id: null, allocation_type: 'account', date, ...extra });

describe('merchantKey', () => {
  test('drops reference numbers, dates and month names so repeats share a key', () => {
    expect(E.merchantKey('CHEQUE CARD PURCHASE ACME CAFE 4111*2222 12 JAN'))
      .toBe(E.merchantKey('CHEQUE CARD PURCHASE ACME CAFE 4111*9999 03 FEB'));
  });
});

describe('client history', () => {
  const history = [
    h('MONTHLY MANAGEMENT FEE', -9, 1, '2026-01-31'),
    h('MONTHLY MANAGEMENT FEE', -9, 1, '2026-02-28'),
    h('MONTHLY MANAGEMENT FEE', -9, 1, '2026-03-31'),
    h('MONTHLY MANAGEMENT FEE', -9, 1, '2026-04-30'),
    h('MONTHLY MANAGEMENT FEE', -9, 1, '2026-05-31'),
    h('MONTHLY MANAGEMENT FEE', -9, 1, '2026-06-30'),
    h('IB PAYMENT TO J TESTPERSON', -5000, 2, '2026-05-25'),
    h('IB PAYMENT TO J TESTPERSON', -5000, 2, '2026-06-25'),
    h('FUEL PURCHASE EXAMPLE GARAGE 4111*2222', -400, 3, '2026-06-10', { vat_setting_id: 31 }),
    h('FUEL PURCHASE EXAMPLE GARAGE 4111*3333', -350, 3, '2026-06-17', { vat_setting_id: 31 })
  ];
  const run = txns => E.suggestAll({ transactions: txns, history, accounts: ACCOUNTS, vatSettings: VAT });

  test('6 of 6 the same → high confidence, prefilled, with a reason', () => {
    const s = run([{ id: 1, description: 'MONTHLY MANAGEMENT FEE', amount: -9 }])[1];
    expect(s).toMatchObject({ source: 'client_history', accountCode: '6700', matchedCount: 6, totalSeen: 6, prefill: true });
    expect(s.confidence).toBeGreaterThanOrEqual(95);
    expect(s.reason).toMatch(/6 of 6/);
  });

  test('2 consistent repeats → prefilled but lower confidence', () => {
    const s = run([{ id: 2, description: 'IB PAYMENT TO J TESTPERSON', amount: -5000 }])[2];
    expect(s.accountCode).toBe('6000');
    expect(s.confidence).toBeLessThan(80);
    expect(s.prefill).toBe(true);
  });

  test('VAT setting is learned together with the account', () => {
    const s = run([{ id: 3, description: 'FUEL PURCHASE EXAMPLE GARAGE 4111*9999', amount: -300 }])[3];
    expect(s).toMatchObject({ accountCode: '6300', vatSettingId: 31, vatSettingName: 'Standard 15%' });
  });

  test('money in never borrows from money-out history', () => {
    const s = run([{ id: 4, description: 'MONTHLY MANAGEMENT FEE', amount: 9 }])[4];
    expect(s === null || s.source !== 'client_history').toBe(true);
  });

  test('two lines that only share bank words are NOT treated as the same party', () => {
    const s = E.suggestAll({
      transactions: [{ id: 5, description: 'DIGITAL PAYMENT DT SETTLEMENT ABSA BANK OTHER PARTY', amount: -100 }],
      history: [h('DIGITAL PAYMENT DT SETTLEMENT ABSA BANK SOMEONE ELSE', -100, 6, '2026-06-01')],
      accounts: ACCOUNTS
    })[5];
    expect(s).toBeNull();
  });

  test('client changed how they book a party → follow the two most recent, capped confidence', () => {
    const hist = [
      h('ACME SOFTWARE SUBSCRIPTION', -99, 1, '2026-01-01'), h('ACME SOFTWARE SUBSCRIPTION', -99, 1, '2026-02-01'),
      h('ACME SOFTWARE SUBSCRIPTION', -99, 1, '2026-03-01'), h('ACME SOFTWARE SUBSCRIPTION', -99, 6, '2026-04-01'),
      h('ACME SOFTWARE SUBSCRIPTION', -99, 6, '2026-05-01')
    ];
    const s = E.suggestAll({ transactions: [{ id: 6, description: 'ACME SOFTWARE SUBSCRIPTION', amount: -99 }], history: hist, accounts: ACCOUNTS })[6];
    expect(s.accountCode).toBe('6500');
    expect(s.confidence).toBeLessThanOrEqual(75);
    expect(s.alternatives.map(a => a.accountCode)).toEqual(['6700']);
  });
});

describe('safety', () => {
  test('never suggests the AP/AR control account or an inactive account', () => {
    const out = E.suggestAll({
      transactions: [{ id: 1, description: 'SUPPLIER X', amount: -10 }, { id: 2, description: 'OLD THING', amount: -10 }],
      history: [h('SUPPLIER X', -10, 7, '2026-01-01'), h('OLD THING', -10, 8, '2026-01-01')],
      accounts: ACCOUNTS
    });
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
  });

  test('transfers are never learned', () => {
    const out = E.suggestAll({
      transactions: [{ id: 1, description: 'TRANSFER TO SAVINGS', amount: -10 }],
      history: [h('TRANSFER TO SAVINGS', -10, 6, '2026-01-01', { allocation_type: 'transfer' })],
      accounts: ACCOUNTS
    });
    expect(out[1]).toBeNull();
  });
});

describe('starter knowledge', () => {
  test('obvious bank fee is resolved by NAME in this chart, low confidence, not prefilled', () => {
    const s = E.suggestAll({ transactions: [{ id: 1, description: 'CASH WITHDRAWAL FEE', amount: -12 }], history: [], accounts: ACCOUNTS })[1];
    expect(s).toMatchObject({ source: 'starter', accountCode: '6700', prefill: false });
    expect(s.confidence).toBeLessThan(E.PREFILL_MIN_CONFIDENCE);
  });

  test('bank fee with the branch glued on ("…FeeHeadoffice*") is still recognised', () => {
    const s = E.suggestAll({ transactions: [{ id: 1, description: 'Monthly Acc FeeHeadoffice*', amount: -95 }], history: [], accounts: ACCOUNTS })[1];
    expect(s.accountCode).toBe('6700');
  });

  test('the word "current" does not look like rent; insurance picks the business account', () => {
    const out = E.suggestAll({
      transactions: [{ id: 1, description: 'TRANSFER TO CURRENT ACCOUNT', amount: -10 },
        { id: 2, description: 'EXAMPLE INSURANCE PREMIUM', amount: -50 }],
      history: [], accounts: ACCOUNTS
    });
    expect(out[1]).toBeNull();
    expect(out[2].accountCode).toBe('6800');
  });

  test('no matching account in the chart → no suggestion', () => {
    const s = E.suggestAll({ transactions: [{ id: 1, description: 'CASH WITHDRAWAL FEE', amount: -12 }], history: [],
      accounts: ACCOUNTS.filter(a => a.code !== '6700') })[1];
    expect(s).toBeNull();
  });
});

describe('approved global knowledge', () => {
  const pattern = { normalized_description: 'example telecom', suggested_account_code: '6500', suggested_account_name: 'Computer and IT Expenses', confidence_score: 88, clients_observed: 4 };

  test('used when this client has the same code with the same meaning (capped at 75)', () => {
    const s = E.suggestAll({ transactions: [{ id: 1, description: 'EXAMPLE TELECOM 12345', amount: -10 }], history: [], accounts: ACCOUNTS, globalPatterns: [pattern] })[1];
    expect(s).toMatchObject({ source: 'global_pattern', accountCode: '6500', confidence: 75 });
  });

  test('skipped when the same code means something else in this client\'s chart', () => {
    const other = ACCOUNTS.map(a => (a.code === '6500' ? { ...a, name: 'Repairs and Maintenance' } : a));
    const s = E.suggestAll({ transactions: [{ id: 1, description: 'EXAMPLE TELECOM 12345', amount: -10 }], history: [], accounts: other, globalPatterns: [pattern] })[1];
    expect(s).toBeNull();
  });
});

describe('suggestForTransactions (data loading)', () => {
  function fakeSupabase(tables) {
    return {
      from(name) {
        const rows = tables[name] || [];
        const q = { _rows: rows, select() { return q; }, eq(c, v) { q._rows = q._rows.filter(r => r[c] === undefined || r[c] === v); return q; },
          in(c, vs) { q._rows = q._rows.filter(r => vs.includes(r[c])); return q; }, not() { return q; }, order() { return q; },
          range(a, b) { return Promise.resolve({ data: q._rows.slice(a, b + 1), error: null }); },
          then(res, rej) { return Promise.resolve({ data: q._rows, error: null }).then(res, rej); } };
        return q;
      }
    };
  }

  test('only unmatched lines of THIS company are answered', async () => {
    const sb = fakeSupabase({
      bank_transactions: [
        { id: 1, company_id: 9, description: 'MONTHLY MANAGEMENT FEE', amount: -9, status: 'unmatched' },
        { id: 2, company_id: 9, description: 'MONTHLY MANAGEMENT FEE', amount: -9, status: 'matched', allocated_account_id: 1, allocation_type: 'account', date: '2026-01-01' },
        { id: 3, company_id: 8, description: 'OTHER COMPANY LINE', amount: -9, status: 'unmatched' }
      ],
      accounts: ACCOUNTS.map(a => ({ ...a, company_id: 9 })),
      vat_settings: []
    });
    const out = await E.suggestForTransactions(sb, 9, [1, 3, 'x']);
    expect(Object.keys(out)).toEqual(['1']);
    expect(out[1].accountCode).toBe('6700');
  });
});
