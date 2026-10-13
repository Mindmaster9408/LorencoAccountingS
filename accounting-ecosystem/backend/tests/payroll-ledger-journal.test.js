'use strict';

/**
 * Tests — Paytime → Ledger Leo DRAFT payroll journal (spec 10 VU-04)
 *   - balanced lines from the finalized snapshots only
 *   - accounts from the company's own chart; missing control accounts reported, never created
 *   - one journal per run (idempotent); never posted by Paytime
 *   - reversal: draft deleted; posted → reversing DRAFT
 */

const { createFakeSupabase } = require('./golden/fake-supabase');
const PJ = require('../modules/payroll/services/payrollJournal');

const COA = [
  { id: 1, code: '6000', name: 'Salaries and Wages', type: 'expense' },
  { id: 2, code: '6020', name: 'Employer UIF Contributions', type: 'expense' },
  { id: 3, code: '6030', name: 'Employer SDL Contributions', type: 'expense' },
  { id: 4, code: '2400', name: 'PAYE / UIF Payable', type: 'liability' },
  { id: 5, code: '2410', name: 'SDL Payable', type: 'liability' },
  { id: 6, code: '2420', name: 'Payroll Deductions Payable', type: 'liability' },
  { id: 7, code: '2430', name: 'Salaries Payable', type: 'liability' }
];
const snap = (o) => ({ company_id: 51, payroll_run_id: 'r1', is_locked: true, status: 'finalized', calculation_output: o });
const SNAPS = [
  snap({ gross: 20000, paye: 1739, uif: 177.12, uif_employer: 177.12, sdl: 200, deductions: 900, net: 17183.88 }),
  snap({ gross: 10000, paye: 0, uif: 100, uif_employer: 100, sdl: 100, deductions: 0, net: 9900 })
];

function deps(db, posted) {
  const created = [];
  return {
    created,
    supabase: createFakeSupabase(db),
    JournalService: {
      createDraftJournal: async (j) => {
        const id = 100 + created.length;
        created.push(j);
        db.journals.push({ id, company_id: j.companyId, status: 'draft', source_type: j.sourceType, reference: j.reference, metadata: j.metadata });
        j.lines.forEach(l => db.journal_lines.push({ journal_id: id, account_id: l.accountId, debit: l.debit, credit: l.credit, description: l.description }));
        return { id };
      }
    },
    db: { getClient: async () => ({
      query: async (sql, p) => {
        if (/^DELETE FROM journal_lines/.test(sql)) { db.journal_lines = db.journal_lines.filter(l => l.journal_id !== p[0]); return { rowCount: 1 }; }
        if (/^DELETE FROM journals/.test(sql)) {
          const before = db.journals.length;
          db.journals = db.journals.filter(j => !(j.id === p[0] && j.status === 'draft'));
          return { rowCount: before - db.journals.length };
        }
        return { rowCount: 0 };
      },
      release() {}
    }) }
  };
}
const freshDb = (extra) => Object.assign({ accounts: COA.map(a => Object.assign({ company_id: 51 }, a)), payroll_snapshots: SNAPS.slice(), journals: [], journal_lines: [] }, extra || {});
const ARGS = { companyId: 51, runId: 'r1', periodKey: '2026-10', userId: 9 };

test('draft journal: balanced, from snapshots, standard accounts, dated end of month', async () => {
  const db = freshDb(); const d = deps(db);
  const res = await PJ.createDraftForRun(d, ARGS);
  expect(res.created).toBe(true);
  const j = d.created[0];
  expect(j).toMatchObject({ companyId: 51, date: '2026-10-31', reference: 'PAYROLL 2026-10', sourceType: 'payroll' });
  const by = Object.fromEntries(j.lines.map(l => [l.accountId, l]));
  expect(by[1].debit).toBe(30000);                               // gross
  expect(by[2].debit).toBe(277.12);                              // employer UIF
  expect(by[3].debit).toBe(300);                                 // SDL
  expect(by[4].credit).toBe(1739 + 277.12 + 277.12);             // PAYE + UIF both sides
  expect(by[6].credit).toBe(900);                                // other deductions
  expect(by[7].credit).toBe(27083.88);                           // net pay
  const dr = j.lines.reduce((s, l) => s + l.debit, 0), cr = j.lines.reduce((s, l) => s + l.credit, 0);
  expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));
});

test('idempotent: a second call does not create another journal', async () => {
  const db = freshDb(); const d = deps(db);
  await PJ.createDraftForRun(d, ARGS);
  const again = await PJ.createDraftForRun(d, ARGS);
  expect([again.created, again.reason]).toEqual([false, 'already_exists']);
  expect(d.created).toHaveLength(1);
});

test('missing control accounts → not created, says which to add, nothing written', async () => {
  const db = freshDb({ accounts: COA.filter(a => a.code < '2420' || a.code >= '6000').map(a => Object.assign({ company_id: 51 }, a)) });
  const d = deps(db);
  const res = await PJ.createDraftForRun(d, ARGS);
  expect(res.created).toBe(false);
  expect(res.reason).toBe('missing_accounts');
  expect(res.missing_accounts.join(' ')).toMatch(/Deductions Payable.*Salaries Payable/);
  expect(db.journals).toEqual([]);
});

test('no deductions → the deductions account is not needed', async () => {
  const db = freshDb({ accounts: COA.filter(a => a.code !== '2420').map(a => Object.assign({ company_id: 51 }, a)),
                       payroll_snapshots: [SNAPS[1]] });
  const res = await PJ.createDraftForRun(deps(db), ARGS);
  expect(res.created).toBe(true);
});

test('company without Ledger Leo: quietly skipped', async () => {
  const res = await PJ.createDraftForRun(deps(freshDb({ accounts: [] })), ARGS);
  expect(res).toEqual({ created: false, reason: 'ledger_not_set_up' });
});

test('reversal of a draft journal deletes it', async () => {
  const db = freshDb(); const d = deps(db);
  await PJ.createDraftForRun(d, ARGS);
  const res = await PJ.handleRunReversal(d, ARGS);
  expect(res.action).toBe('draft_deleted');
  expect(db.journals).toEqual([]);
  expect(db.journal_lines).toEqual([]);
});

test('reversal of a POSTED journal creates a reversing DRAFT (debits ↔ credits), once', async () => {
  const db = freshDb(); const d = deps(db);
  await PJ.createDraftForRun(d, ARGS);
  db.journals[0].status = 'posted';
  const res = await PJ.handleRunReversal(d, Object.assign({ reason: 'wrong salary' }, ARGS));
  expect(res.action).toBe('reversal_draft_created');
  const rev = d.created[1];
  expect(rev.reference).toBe('PAYROLL REVERSAL 2026-10');
  expect(rev.metadata.reversal_of).toBe(100);
  expect(rev.lines.find(l => l.accountId === 1).credit).toBe(30000);
  expect((await PJ.handleRunReversal(d, ARGS)).action).toBe('reversal_exists');
});

test('a failure never throws into the payroll flow', async () => {
  const d = deps(freshDb());
  d.JournalService.createDraftJournal = async () => { throw new Error('period locked'); };
  const res = await PJ.createDraftForRun(d, ARGS);
  expect([res.created, res.reason, res.error]).toEqual([false, 'error', 'period locked']);
});
