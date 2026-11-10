/**
 * Tests — Sean month-end bank review. All data fictional.
 */
const R = require('../sean/bank-review');

let nextId = 1;
const line = (date, description, amount, balance, extra = {}) =>
  ({ id: nextId++, date, description, amount, balance, status: 'matched', allocated_account_id: 10, allocation_type: 'account', ...extra });

describe('balance breaks', () => {
  test('lines inside one day may be in any order — no false break', () => {
    const rows = [
      line('2026-03-01', 'OPENING ACTIVITY', -10, 990),
      line('2026-03-02', 'B', -50, 890),   // stored before A, statement order was A then B
      line('2026-03-02', 'A', -50, 940),
      line('2026-03-03', 'C', 100, 990)
    ];
    expect(R.findBalanceBreaks(rows)).toEqual([]);
  });

  test('a missing line shows as a break on the day after it', () => {
    const rows = [
      line('2026-03-01', 'X', -10, 990),
      line('2026-03-05', 'Y', -20, 900)  // 990 - 20 = 970, statement says 900 → R70 missing
    ];
    const b = R.findBalanceBreaks(rows);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: 'balance_break', severity: 'problem', date: '2026-03-05' });
  });

  test('days with lines lacking a statement balance reset the chain (no break)', () => {
    const rows = [line('2026-03-01', 'X', -10, 990), line('2026-03-02', 'MANUAL', -5, null), line('2026-03-03', 'Y', -20, 500)];
    expect(R.findBalanceBreaks(rows)).toEqual([]);
  });
});

describe('gaps', () => {
  test('more than 35 days without a line → missing statement', () => {
    const g = R.findGaps([line('2026-01-31', 'A', -1, null), line('2026-03-15', 'B', -1, null)]);
    expect(g).toHaveLength(1);
    expect(g[0].message).toMatch(/43 days/);
  });
  test('a normal month is not a gap', () => {
    expect(R.findGaps([line('2026-01-18', 'A', -1, null), line('2026-02-18', 'B', -1, null)])).toEqual([]);
  });
});

describe('duplicates', () => {
  test('same day, amount, description AND statement balance → probably imported twice', () => {
    const d = R.findDuplicates([line('2026-04-01', 'ACME FEE', -5, 100), line('2026-04-01', 'ACME FEE', -5, 100)]);
    expect(d).toEqual([expect.objectContaining({ type: 'duplicate', severity: 'problem' })]);
  });
  test('repeated fees with different running balances are real — not flagged', () => {
    expect(R.findDuplicates([line('2026-04-01', 'ACME FEE', -5, 100), line('2026-04-01', 'ACME FEE', -5, 95)])).toEqual([]);
  });
  test('without statement balances it is only a "check"', () => {
    const d = R.findDuplicates([line('2026-04-01', 'ACME FEE', -5, null), line('2026-04-01', 'ACME FEE', -5, null)]);
    expect(d[0].severity).toBe('check');
  });
});

describe('outliers', () => {
  const habit = n => Array.from({ length: n }, (_, i) => line(`2026-0${(i % 9) + 1}-10`, 'EXAMPLE SHOP 4111*2222', -100, null, { allocated_account_id: 20 }));

  test('one line booked differently from a 4+ habit is flagged', () => {
    const odd = line('2026-05-11', 'EXAMPLE SHOP 4111*9999', -100, null, { allocated_account_id: 21 });
    const o = R.findOutliers([...habit(4), odd], id => `acct ${id}`);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ type: 'outlier', txnIds: [odd.id] });
    expect(o[0].message).toMatch(/acct 21.*acct 20.*4 time/);
  });

  test('a weak habit or a real split between two accounts is not flagged', () => {
    const odd = line('2026-05-11', 'EXAMPLE SHOP', -100, null, { allocated_account_id: 21 });
    expect(R.findOutliers([...habit(3), odd])).toEqual([]);
    const twoEach = [...habit(4), ...Array.from({ length: 2 }, () => line('2026-06-01', 'EXAMPLE SHOP', -100, null, { allocated_account_id: 21 }))];
    expect(R.findOutliers(twoEach)).toEqual([]);
  });

  test('money in and money out are separate habits', () => {
    const refund = line('2026-05-11', 'EXAMPLE SHOP 4111*2222', 100, null, { allocated_account_id: 21 });
    expect(R.findOutliers([...habit(5), refund])).toEqual([]);
  });
});

describe('reviewBankAccount', () => {
  test('stale unallocated lines and Sean\'s own postings are listed; problems sort first', () => {
    const rows = [
      line('2026-01-01', 'OLD UNALLOCATED', -10, null, { status: 'unmatched', allocated_account_id: null }),
      line('2026-03-01', 'SEAN DID THIS', -10, null, { allocation_source: 'sean_auto' }),
      line('2026-06-01', 'LATER', -10, null)
    ];
    const r = R.reviewBankAccount({ rows, accounts: [], today: '2026-06-15' });
    expect(r.findings.map(f => f.type)).toEqual(['gap', 'gap', 'stale', 'sean_auto']);
    expect(r.counts).toEqual({ problem: 2, check: 1, info: 1 });
  });

  test('a clean account has no findings', () => {
    const rows = [line('2026-03-01', 'A', -10, 990), line('2026-03-15', 'B', -10, 980), line('2026-04-01', 'C', 20, 1000)];
    expect(R.reviewBankAccount({ rows, today: '2026-04-02' }).findings).toEqual([]);
  });
});
