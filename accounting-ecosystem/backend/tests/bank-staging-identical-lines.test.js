'use strict';

/**
 * Identical same-day bank lines (e.g. several R5 bank fees on one day) must
 * each be importable. They used to share one generated external_id, the
 * unique index (migration 163) rejected the 2nd, and because confirm is a
 * bulk insert the WHOLE confirm failed. Fictional data only.
 */

// ── Tiny in-memory stand-in for the supabase query builder ─────────────────
const db = { bank_transaction_staging: [], bank_transactions: [] };
let nextId = 1;

function uniqueViolation(table, rows) {
  if (table !== 'bank_transactions') return null;
  const keys = new Set(db.bank_transactions
    .filter(r => r.external_id).map(r => `${r.bank_account_id}|${r.external_id}`));
  for (const r of rows) {
    if (!r.external_id) continue;
    const k = `${r.bank_account_id}|${r.external_id}`;
    if (keys.has(k)) return { message: 'duplicate key value violates unique constraint "bank_transactions_unique_account_external_id"' };
    keys.add(k);
  }
  return null;
}

function mockBuilder(table) {
  const filters = [];
  let op = 'select', payload = null, range = null, wantRows = false;
  const q = {
    select() { wantRows = true; return q; },
    insert(rows) { op = 'insert'; payload = rows; return q; },
    update(vals) { op = 'update'; payload = vals; return q; },
    eq(c, v)  { filters.push(r => r[c] === v); return q; },
    neq(c, v) { filters.push(r => r[c] !== v); return q; },
    in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
    gte(c, v) { filters.push(r => r[c] >= v); return q; },
    lte(c, v) { filters.push(r => r[c] <= v); return q; },
    not(c, o, v) {
      if (o === 'eq') filters.push(r => r[c] !== v);
      else if (o === 'is') filters.push(r => r[c] != null);
      else if (o === 'in') {
        const vs = v.replace(/[()]/g, '').split(',');
        filters.push(r => !vs.includes(r[c]));
      }
      return q;
    },
    order() { return q; },
    range(a, b) { range = [a, b]; return q; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  function run() {
    const tbl = db[table];
    if (op === 'insert') {
      const err = uniqueViolation(table, payload);
      if (err) return { data: null, error: err };
      const ins = payload.map(r => ({ id: nextId++, ...r }));
      tbl.push(...ins);
      return { data: wantRows ? ins : null, error: null };
    }
    const hit = tbl.filter(r => filters.every(f => f(r)));
    if (op === 'update') {
      hit.forEach(r => Object.assign(r, payload));
      return { data: wantRows ? hit.map(r => ({ ...r })) : null, error: null };
    }
    const out = range ? hit.slice(range[0], range[1] + 1) : hit;
    return { data: out.map(r => ({ ...r })), error: null };
  }
  return q;
}

jest.mock('../config/database', () => ({ supabase: { from: t => mockBuilder(t) } }));
jest.mock('../modules/accounting/config/database', () => ({}));
jest.mock('../modules/accounting/services/journalService', () => ({}));
jest.mock('../modules/accounting/services/auditLogger', () => ({}));

const BankStagingService = require('../modules/accounting/services/bankStagingService');
const {
  numberRepeatedExternalIds, resolveExternalIdCollisions, baseExternalId,
} = require('../modules/accounting/services/bankExternalId');

const CO = 951, ACCT = 77;
const fee = (date) => ({
  date, description: 'FEE POS DECLINED INSUFF FUNDS', amount: -5,
  externalId: `pdf-${date}--500-feeposdeclinedinsuff`,
});

beforeEach(() => {
  db.bank_transaction_staging = [];
  db.bank_transactions = [];
  nextId = 1;
});

describe('bankExternalId helpers', () => {
  test('numbers repeats by position, leaves first and id-less rows alone', () => {
    const out = numberRepeatedExternalIds([
      { externalId: 'a' }, { externalId: 'a' }, { externalId: 'b' },
      { externalId: 'a' }, { description: 'no id' },
    ]);
    expect(out.map(t => t.externalId)).toEqual(['a', 'a#2', 'b', 'a#3', undefined]);
  });

  test('numbering is idempotent', () => {
    const once = numberRepeatedExternalIds([{ externalId: 'a' }, { externalId: 'a' }]);
    expect(numberRepeatedExternalIds(once).map(t => t.externalId)).toEqual(['a', 'a#2']);
  });

  test('collision resolution picks next free #n per bank account', () => {
    const taken = new Set(['1|x', '1|x#2']);
    const ids = resolveExternalIdCollisions([
      { bank_account_id: 1, external_id: 'x' },
      { bank_account_id: 1, external_id: 'x' },
      { bank_account_id: 2, external_id: 'x' },
      { bank_account_id: 1, external_id: null },
    ], taken);
    expect(ids).toEqual(['x#3', 'x#4', 'x', null]);
    expect(baseExternalId('x#12')).toBe('x');
  });
});

describe('identical same-day lines through staging → confirm', () => {
  test('nine identical fees on one day all stage and all confirm', async () => {
    const lines = Array.from({ length: 9 }, () => fee('2026-06-29'));
    const { staged, skipped } = await BankStagingService.stageTransactions(CO, ACCT, lines, 'b1', 'pdf');
    expect(staged).toHaveLength(9);
    expect(skipped).toBe(0);

    const { confirmed } = await BankStagingService.confirmStaged(CO, staged.map(r => r.id), 1);
    expect(confirmed).toHaveLength(9);
    expect(new Set(db.bank_transactions.map(r => r.external_id)).size).toBe(9);
  });

  test('re-importing the same statement still skips every line', async () => {
    const lines = [fee('2026-06-29'), fee('2026-06-29'), fee('2026-06-30')];
    const first = await BankStagingService.stageTransactions(CO, ACCT, lines, 'b1', 'pdf');
    await BankStagingService.confirmStaged(CO, first.staged.map(r => r.id), 1);

    const again = await BankStagingService.stageTransactions(CO, ACCT, lines, 'b2', 'pdf');
    expect(again.staged).toHaveLength(0);
    expect(again.skipped).toBe(3);
  });

  test('a longer statement only adds the extra occurrence', async () => {
    await BankStagingService.stageTransactions(CO, ACCT, [fee('2026-06-29')], 'b1', 'pdf');
    const more = await BankStagingService.stageTransactions(
      CO, ACCT, [fee('2026-06-29'), fee('2026-06-29')], 'b2', 'pdf');
    expect(more.staged).toHaveLength(1);
    expect(more.staged[0].external_id).toBe('pdf-2026-06-29--500-feeposdeclinedinsuff#2');
  });

  test('legacy stuck rows (same plain id, one already live) confirm and are marked OVERRIDDEN', async () => {
    const id = fee('2026-04-14').externalId;
    db.bank_transactions.push({ id: nextId++, company_id: CO, bank_account_id: ACCT, date: '2026-04-14', external_id: id, amount: -5 });
    const base = { company_id: CO, bank_account_id: ACCT, date: '2026-04-14', amount: -5,
      description: 'FEE POS DECLINED', external_id: id, match_status: 'UNMATCHED', duplicate_status: 'NONE' };
    db.bank_transaction_staging.push({ id: nextId++, ...base }, { id: nextId++, ...base, match_status: 'DUPLICATE_SUSPECTED' });
    const stuck = db.bank_transaction_staging.map(r => r.id);

    const { confirmed } = await BankStagingService.confirmStaged(CO, stuck, 1);
    expect(confirmed.map(r => r.external_id).sort()).toEqual([`${id}#2`, `${id}#3`]);
    expect(db.bank_transaction_staging.every(r => r.match_status === 'CONFIRMED')).toBe(true);
    expect(db.bank_transaction_staging.every(r => r.duplicate_status === 'OVERRIDDEN')).toBe(true);

    // ...and re-importing that day's 3 fees adds nothing
    const again = await BankStagingService.stageTransactions(
      CO, ACCT, [fee('2026-04-14'), fee('2026-04-14'), fee('2026-04-14')], 'b9', 'pdf');
    expect(again.staged).toHaveLength(0);
  });

  test('double confirm of the same rows still inserts only once', async () => {
    const { staged } = await BankStagingService.stageTransactions(
      CO, ACCT, [fee('2026-06-29'), fee('2026-06-29')], 'b1', 'pdf');
    const ids = staged.map(r => r.id);
    const [a, b] = await Promise.all([
      BankStagingService.confirmStaged(CO, ids, 1),
      BankStagingService.confirmStaged(CO, ids, 1),
    ]);
    expect(a.confirmed.length + b.confirmed.length).toBe(2);
    expect(db.bank_transactions).toHaveLength(2);
  });
});
