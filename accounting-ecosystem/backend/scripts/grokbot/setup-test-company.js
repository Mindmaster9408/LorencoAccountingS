'use strict';

/**
 * Sets up the GrokBot test environment in company 51 (Infinite Legacy — TEST) ONLY.
 * Synthetic data; refuses any other company. Runs against a Lorenco server
 * (default http://localhost:3999) as a platform admin, through the normal API.
 *
 *   node scripts/grokbot/setup-test-company.js [baseUrl]
 *
 * Creates (idempotent — reuses what already exists):
 *   - ledger account 1015 "GrokBot Test Bank (synthetic)"
 *   - bank account "GrokBot Test Bank (synthetic)", masked ****0917 (matches the synthetic statement)
 *   - VAT code "STD" 15% (if the company has no VAT codes)
 *   - approved rule: description contains "ENGEN" → 6300 Motor Vehicle — Fuel
 *   - Sean history: three September "VODACOM DEBIT ORDER" lines allocated to 6200 and reconciled
 *     (so Sean recommends 6200 with confidence), opening balance chosen so the statement's
 *     R50 000 opening balance follows on.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const jwt = require('jsonwebtoken');

const COMPANY = 51;
const BASE = (process.argv[2] || 'http://localhost:3999').replace(/\/$/, '');
const NAME = 'GrokBot Test Bank (synthetic)';
const HISTORY = [['2026-09-02', -699], ['2026-09-12', -699], ['2026-09-22', -699]];
const STATEMENT_OPENING = 50000;

const admin = jwt.sign({ userId: 1, email: 'setup', role: 'super_admin', isSuperAdmin: true, companyId: COMPANY },
  process.env.JWT_SECRET, { expiresIn: '15m' });

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin, 'X-Company-Id': String(COMPANY) },
    body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${d.error || JSON.stringify(d).slice(0, 200)}`);
  return d;
}

async function main() {
  const accts = (await api('GET', '/api/accounting/accounts?includeInactive=true')).accounts || [];
  const byCode = (c) => accts.find(a => a.code === c);
  for (const c of ['6200', '6300', '1030']) if (!byCode(c)) throw new Error('company 51 is missing account ' + c);

  let ledger = byCode('1015');
  if (!ledger) {
    ledger = (await api('POST', '/api/accounting/accounts', { code: '1015', name: NAME, type: 'asset', subType: 'bank' })).account
      || (await api('GET', '/api/accounting/accounts')).accounts.find(a => a.code === '1015');
    console.log('created ledger account 1015');
  }

  const historyTotal = HISTORY.reduce((s, [, a]) => s + a, 0);
  let bank = ((await api('GET', '/api/accounting/bank/accounts')).bankAccounts || []).find(b => b.name === NAME);
  if (!bank) {
    const r = await api('POST', '/api/accounting/bank/accounts', { name: NAME, bankName: 'FNB', accountNumberMasked: '****0917',
      ledgerAccountId: ledger.id, openingBalance: STATEMENT_OPENING - historyTotal, openingBalanceDate: '2026-09-01' });
    bank = r.bankAccount || r.account || r;
    console.log('created bank account', bank.id);
  }

  const vats = (await api('GET', '/api/accounting/vat-settings')).vatSettings || [];
  if (!vats.length) {
    await api('POST', '/api/accounting/vat-settings', { code: 'STD', name: 'Standard rate 15%', rate: 15, is_active: true, effective_from: '2018-04-01' });
    console.log('created VAT code STD 15%');
  }

  const rules = (await api('GET', '/api/accounting/bank/rules')).rules || [];
  if (!rules.some(r => String(r.matchPattern || r.match_pattern || '').toUpperCase() === 'ENGEN')) {
    await api('POST', '/api/accounting/bank/rules', { matchPattern: 'ENGEN', matchType: 'contains', accountId: byCode('6300').id, priority: 50 });
    console.log('created rule ENGEN → 6300');
  }

  const existing = (await api('GET', `/api/accounting/bank/transactions?bankAccountId=${bank.id}&limit=500`)).transactions || [];
  if (!existing.some(t => t.date === HISTORY[0][0] && /VODACOM/.test(t.description))) {
    const st = await api('POST', '/api/accounting/bank/import', { bankAccountId: bank.id, importSource: 'csv',
      transactions: HISTORY.map(([date, amount]) => ({ date, description: 'VODACOM DEBIT ORDER', amount })) });
    const batch = await api('GET', '/api/accounting/bank/staging?batchId=' + encodeURIComponent(st.batchId));
    const conf = await api('POST', '/api/accounting/bank/staging/confirm', { stagingIds: batch.staging.map(s => s.id) });
    const ids = conf.confirmed.map(t => t.id);
    for (const id of ids) {
      await api('POST', `/api/accounting/bank/transactions/${id}/allocate`, { lines: [{ accountId: byCode('6200').id, amount: 699 }], allocationType: 'account' });
    }
    const bankAcc = ((await api('GET', '/api/accounting/bank/accounts')).bankAccounts || []).find(b => b.id === bank.id);
    const cleared = Math.round((Number(bankAcc.opening_balance) + historyTotal) * 100) / 100;
    await api('POST', '/api/accounting/bank/reconcile', { transactionIds: ids, bankAccountId: bank.id, statementDate: '2026-09-30',
      statementClosingBalance: cleared, clearedBalance: cleared });
    console.log('Sean history: 3 VODACOM lines allocated to 6200 and reconciled; cleared balance', cleared);
  }
  console.log(JSON.stringify({ company: COMPANY, bank_account_id: bank.id, ledger_account_id: ledger.id }));
}

main().catch(e => { console.error('setup failed:', e.message); process.exit(1); });
