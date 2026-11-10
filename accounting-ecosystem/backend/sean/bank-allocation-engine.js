/**
 * ============================================================================
 * SEAN Bank Allocation Engine — Phase 1 (suggest + prefill, human posts)
 * ============================================================================
 * Suggests an allocation (account + VAT) for unmatched bank transactions the
 * way an accountant would: "what did we do with this before, for THIS client?"
 *
 * No external AI. Everything comes from the client's own posted allocations
 * plus explicitly approved knowledge:
 *
 *   1. Client history   — this company's own matched/reconciled bank lines,
 *                          all import sources (pdf, csv, manual). Same
 *                          description + same direction → same account/VAT.
 *                          Confidence grows with how often and how
 *                          consistently it was allocated that way.
 *   2. Global knowledge — approved cross-client patterns (bank-learning.js),
 *                          used only when this client has an account with the
 *                          same code AND meaning. Capped confidence.
 *   3. Starter knowledge — a few obvious bank-line types (bank fees, interest,
 *                          fuel, …) resolved by NAME against this client's own
 *                          chart. Low confidence, so it is shown, never
 *                          prefilled.
 *
 * Bank rules and payroll matches are applied by the bank page BEFORE this
 * runs and are never overridden. Nothing here posts or writes anything — the
 * user reviews and posts through the normal allocate endpoint, which is also
 * what teaches Sean (the posted line becomes history).
 *
 * Never suggested (by design, see project Sean roadmap): transfers between
 * accounts, the AR/AP control accounts (1100/2000 — use Record Payment),
 * VAT determinations from anything other than the client's own history.
 * ============================================================================
 */

'use strict';

const { normalizeBankDescription } = require('../modules/accounting/services/bankDescriptionNormalizer');

// Rows at or above this are prefilled on the bank page; lower ones are only
// shown in the AI panel. Exported so the page and the tests agree.
const PREFILL_MIN_CONFIDENCE = 70;

// Phase 2 — Sean may POST a line by himself (only for companies that switched
// it on) when ALL of these hold (Ruan, 2026-11-10):
//   • the client's own history, exact same line (not "similar")
//   • seen at least AUTO_MIN_COUNT times and EVERY time the same account
//   • the VAT setting was the same every time (Sean never decides VAT)
//   • type 'account' (never transfers, VAT payments, AR/AP)
//   • amount at most AUTO_MAX_AMOUNT (rand)
const AUTO_MIN_COUNT = 5;
const AUTO_MAX_AMOUNT = 5000;

const HISTORY_LIMIT = 5000;           // most recent posted lines considered
const HISTORY_PAGE  = 1000;           // PostgREST max rows per request
const BLOCKED_CODES = new Set(['1100', '2000']); // AR / AP control — Record Payment only
const LEARNABLE_TYPES = new Set([null, undefined, '', 'account', 'single', 'vat']);

const MONTH_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/g;
// Words that describe the KIND of bank line, not who it is with. Two lines
// must share at least one word outside this list to count as "similar".
const GENERIC_WORDS = new Set([
  'cheque', 'card', 'purchase', 'pos', 'local', 'payment', 'pmt', 'ib', 'to', 'from', 'for', 'at',
  'debit', 'credit', 'order', 'transfer', 'trf', 'tfr', 'inward', 'outward', 'eft', 'internet',
  'immediate', 'digital', 'settlement', 'acb', 'rtc', 'real', 'time', 'express', 'retail', 'cr',
  'dr', 'dt', 'ref', 'instant', 'external', 'the', 'and', 'of', 'via', 'online', 'banking',
  'account', 'acc', 'purch', 'date', 'magtape', 'stop', 'international', 'za', 'sa',
  // Bank names / bank-side words: "…Absa Bank…" on two lines says nothing about the party
  'bank', 'absa', 'fnb', 'nedbank', 'capitec', 'standard', 'sbsa', 'investec', 'tyme', 'discovery',
  'dtsettlement', 'crsettlement', 'atm', 'cash', 'withdrawal', 'deposit', 'notific', 'notification'
]);

// ─── Description keys ────────────────────────────────────────────────────────

/** Stable key for "the same kind of line with the same party". */
function merchantKey(description) {
  return normalizeBankDescription(description || '')
    .replace(MONTH_RE, ' ')
    .split(' ')
    .filter(t => t.length > 1)
    .join(' ')
    .trim();
}

function keyTokens(key) {
  return key ? key.split(' ') : [];
}

function similarity(tokensA, tokensB) {
  const a = new Set(tokensA), b = new Set(tokensB);
  if (!a.size || !b.size) return 0;
  let shared = 0, distinctiveShared = 0;
  for (const t of a) {
    if (b.has(t)) { shared++; if (!GENERIC_WORDS.has(t)) distinctiveShared++; }
  }
  if (distinctiveShared === 0) return 0;
  return shared / (a.size + b.size - shared);
}

const sign = amount => (Number(amount) < 0 ? 'out' : 'in');

// ─── 1. Client history ───────────────────────────────────────────────────────

/**
 * Build an index of a company's posted allocations.
 * @param {Array<{description, amount, allocated_account_id, vat_setting_id, allocation_type, date}>} rows
 */
function buildHistoryIndex(rows) {
  const byKey = new Map(); // `${dir}|${key}` → { key, dir, tokens, rows: [] }
  for (const r of rows || []) {
    if (!r || !r.allocated_account_id) continue;
    if (!LEARNABLE_TYPES.has(r.allocation_type)) continue;
    const key = merchantKey(r.description);
    if (!key) continue;
    const dir = sign(r.amount);
    const id = `${dir}|${key}`;
    if (!byKey.has(id)) byKey.set(id, { key, dir, tokens: keyTokens(key), rows: [] });
    byKey.get(id).rows.push({
      accountId: r.allocated_account_id,
      vatSettingId: r.vat_setting_id || null,
      type: r.allocation_type === 'vat' ? 'vat' : 'account',
      date: r.date || null
    });
  }
  return byKey;
}

/** Majority vote over a group's rows → { accountId, type, vatSettingId, top, total, last, recentChange } */
function vote(groupRows) {
  const counts = new Map();
  for (const r of groupRows) {
    const c = counts.get(r.accountId) || { accountId: r.accountId, type: r.type, n: 0, vats: new Map(), last: null };
    c.n++;
    c.vats.set(r.vatSettingId, (c.vats.get(r.vatSettingId) || 0) + 1);
    if (r.date && (!c.last || r.date > c.last)) c.last = r.date;
    counts.set(r.accountId, c);
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last)));
  let winner = ranked[0];
  let recentChange = false;

  // The client may have changed how they book this party. If the two most
  // recent lines agree with each other but not with the majority, follow them.
  const byDate = [...groupRows].filter(r => r.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (byDate.length >= 2 && byDate[0].accountId === byDate[1].accountId && byDate[0].accountId !== winner.accountId) {
    winner = counts.get(byDate[0].accountId);
    recentChange = true;
  }
  const vatSettingId = [...winner.vats.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    accountId: winner.accountId, type: winner.type, vatSettingId,
    vatConsistent: winner.vats.size === 1,
    top: winner.n, total: groupRows.length, last: winner.last, recentChange,
    alternatives: ranked.filter(c => c.accountId !== winner.accountId).slice(0, 2)
      .map(c => ({ accountId: c.accountId, count: c.n }))
  };
}

function historyConfidence(top, total, { similar = false, recentChange = false } = {}) {
  const share = total ? top / total : 0;
  // Seen once → ~67 (shown, not prefilled); twice the same → ~75 (prefilled);
  // five or more and always the same → 97. Inconsistency pulls it down.
  let c = 60 + 37 * share * (Math.min(top, 5) / 5);
  if (similar) c = Math.min(80, c - 10);
  if (recentChange) c = Math.min(75, c);
  return Math.max(1, Math.min(97, Math.round(c)));
}

function suggestFromHistory(txn, index) {
  const key = merchantKey(txn.description);
  if (!key) return null;
  const dir = sign(txn.amount);

  const exact = index.get(`${dir}|${key}`);
  if (exact) {
    const v = vote(exact.rows);
    return { ...v, similar: false, matchedKey: key,
      confidence: historyConfidence(v.top, v.total, { recentChange: v.recentChange }) };
  }

  // Similar line (same party, different reference/branch text)
  const tokens = keyTokens(key);
  let best = null;
  for (const g of index.values()) {
    if (g.dir !== dir) continue;
    const s = similarity(tokens, g.tokens);
    if (s >= 0.6 && (!best || s > best.s || (s === best.s && g.rows.length > best.g.rows.length))) best = { s, g };
  }
  if (!best) return null;
  const v = vote(best.g.rows);
  return { ...v, similar: true, matchedKey: best.g.key,
    confidence: historyConfidence(v.top, v.total, { similar: true, recentChange: v.recentChange }) };
}

// ─── 3. Starter knowledge (resolved by account NAME in the client's chart) ──

const STARTER = [
  // No closing \b: ABSA glues the branch on ("Monthly Acc FeeHeadoffice*")
  { dir: 'out', desc: /\b(?:fees?|charges?|commission)|s\/fee/i, account: /bank charge/i, label: 'bank fee' },
  { dir: 'in',  desc: /\binterest\b/i, account: /interest (?:received|income|earned)/i, label: 'interest received' },
  { dir: 'out', desc: /\binterest\b/i, account: /interest (?:expense|paid)/i, label: 'interest charged' },
  { dir: 'out', desc: /\b(?:fuel|engen|sasol|shell|caltex|astron|petrol|diesel)\b/i, account: /fuel/i, label: 'fuel' },
  { dir: 'out', desc: /\b(?:telkom|vodacom|mtn|cell ?c|afrihost|airtime|fibre|internet)\b/i, account: /telephone|internet|communication/i, label: 'telephone / internet' },
  { dir: 'out', desc: /\b(?:eskom|electricity|prepaid elec|municipal(?:ity)?|munic)\b/i, account: /electric|utilit|water/i, label: 'electricity / municipal' },
  { dir: 'out', desc: /\b(?:insurance|assurance|santam|outsurance|hollard)\b/i, account: /^insurance/i, label: 'insurance' }
];

function suggestFromStarter(txn, accounts) {
  const dir = sign(txn.amount);
  for (const s of STARTER) {
    if (s.dir !== dir || !s.desc.test(txn.description || '')) continue;
    const wantType = dir === 'out' ? 'expense' : 'income';
    const acct = accounts.find(a => a.type === wantType && s.account.test(a.name || ''));
    if (acct) return { accountId: acct.id, type: 'account', vatSettingId: null, label: s.label, confidence: 50 };
  }
  return null;
}

// ─── 2. Approved global knowledge ────────────────────────────────────────────

function nameOverlap(a, b) {
  const wa = new Set(String(a || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2));
  const wb = new Set(String(b || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let n = 0; for (const w of wa) if (wb.has(w)) n++;
  return n / Math.max(wa.size, wb.size);
}

function suggestFromGlobal(txn, patterns, accounts, normalizeForGlobal) {
  if (!patterns || !patterns.length) return null;
  const norm = normalizeForGlobal(txn.description || '');
  if (!norm) return null;
  for (const p of patterns) {
    const pn = p.normalized_description || '';
    if (!pn || !(norm === pn || norm.includes(pn) || pn.includes(norm))) continue;
    // Same code AND same meaning in this client's chart, otherwise skip
    const acct = accounts.find(a => a.code === p.suggested_account_code);
    if (!acct || nameOverlap(acct.name, p.suggested_account_name) < 0.5) continue;
    return { accountId: acct.id, type: 'account', vatSettingId: null,
      confidence: Math.min(75, Math.round(Number(p.confidence_score) || 60)),
      clients: p.clients_observed || null };
  }
  return null;
}

// ─── Orchestration (pure) ────────────────────────────────────────────────────

/**
 * @param {object} ctx
 *   transactions — unmatched lines to suggest for
 *   history      — company's posted lines (see buildHistoryIndex)
 *   accounts     — company chart (id, code, name, type, is_active, is_postable)
 *   vatSettings  — company VAT settings (id, name)
 *   globalPatterns, normalizeForGlobal — optional approved cross-client patterns
 * @returns {Object<string, object|null>} suggestion per transaction id
 */
function suggestAll({ transactions, history, accounts, vatSettings = [], globalPatterns = [], normalizeForGlobal = merchantKey }) {
  const usable = (accounts || []).filter(a => a.is_active !== false && a.is_postable !== false && !BLOCKED_CODES.has(a.code));
  const byId = new Map(usable.map(a => [a.id, a]));
  const vatById = new Map((vatSettings || []).map(v => [v.id, v]));
  const index = buildHistoryIndex(history);
  const out = {};

  for (const txn of transactions || []) {
    let s = null;

    const h = suggestFromHistory(txn, index);
    if (h && byId.has(h.accountId)) {
      const when = h.last ? ` (last ${h.last})` : '';
      s = {
        source: 'client_history', accountId: h.accountId, allocationType: h.type,
        vatSettingId: h.vatSettingId && vatById.has(h.vatSettingId) ? h.vatSettingId : null,
        confidence: h.confidence, matchedCount: h.top, totalSeen: h.total,
        reason: h.similar
          ? `A similar line ("${h.matchedKey}") was allocated here ${h.top} of ${h.total} time(s)${when}`
          : h.recentChange
            ? `Allocated here the last ${h.top} time(s)${when} — earlier it went elsewhere`
            : `Allocated here ${h.top} of ${h.total} time(s) before${when}`,
        alternatives: h.alternatives.filter(a => byId.has(a.accountId)),
        autoEligible: !h.similar && !h.recentChange && h.top === h.total && h.top >= AUTO_MIN_COUNT
          && h.vatConsistent && h.type === 'account'
          // a historic VAT setting that is no longer active would silently drop VAT
          && (h.vatSettingId == null || vatById.has(h.vatSettingId))
          && Math.abs(Number(txn.amount) || 0) <= AUTO_MAX_AMOUNT
      };
    }

    if (!s) {
      const g = suggestFromGlobal(txn, globalPatterns, usable, normalizeForGlobal);
      if (g) s = { source: 'global_pattern', accountId: g.accountId, allocationType: 'account', vatSettingId: null,
        confidence: g.confidence, reason: `Approved Sean knowledge${g.clients ? ` (seen at ${g.clients} clients)` : ''}`, alternatives: [] };
    }

    if (!s) {
      const st = suggestFromStarter(txn, usable);
      if (st) s = { source: 'starter', accountId: st.accountId, allocationType: 'account', vatSettingId: null,
        confidence: st.confidence, reason: `Looks like a ${st.label} — no history for this line yet, please check`, alternatives: [] };
    }

    if (s) {
      const a = byId.get(s.accountId);
      s.accountCode = a.code;
      s.accountName = a.name;
      s.vatSettingName = s.vatSettingId ? (vatById.get(s.vatSettingId) || {}).name || null : null;
      s.alternatives = (s.alternatives || []).map(alt => {
        const aa = byId.get(alt.accountId);
        return { accountId: alt.accountId, accountCode: aa.code, accountName: aa.name, count: alt.count };
      });
      s.prefill = s.confidence >= PREFILL_MIN_CONFIDENCE;
      s.autoEligible = s.autoEligible === true;
    }
    out[txn.id] = s;
  }
  return out;
}

// ─── Data loading (company-scoped) ───────────────────────────────────────────

async function suggestForTransactions(supabase, companyId, transactionIds, { getApprovedGlobalPatterns, normalizeForGlobal } = {}) {
  const ids = [...new Set((transactionIds || []).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) return {};

  const { data: txns, error: tErr } = await supabase
    .from('bank_transactions')
    .select('id, description, amount, status')
    .eq('company_id', companyId)
    .in('id', ids);
  if (tErr) throw new Error(tErr.message);
  const transactions = (txns || []).filter(t => t.status === 'unmatched');
  if (!transactions.length) return {};

  const [{ data: accounts, error: aErr }, { data: vatSettings }] = await Promise.all([
    supabase.from('accounts').select('id, code, name, type, is_active, is_postable').eq('company_id', companyId),
    supabase.from('vat_settings').select('id, name, is_active').eq('company_id', companyId)
  ]);
  if (aErr) throw new Error(aErr.message);
  const activeVat = (vatSettings || []).filter(v => v.name && v.is_active !== false);

  const history = [];
  for (let from = 0; from < HISTORY_LIMIT; from += HISTORY_PAGE) {
    const { data, error } = await supabase
      .from('bank_transactions')
      .select('description, amount, allocated_account_id, vat_setting_id, allocation_type, date')
      .eq('company_id', companyId)
      .in('status', ['matched', 'reconciled'])
      .not('allocated_account_id', 'is', null)
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + HISTORY_PAGE - 1);
    if (error) throw new Error(error.message);
    history.push(...(data || []));
    if (!data || data.length < HISTORY_PAGE) break;
  }

  let globalPatterns = [];
  if (getApprovedGlobalPatterns) {
    try { globalPatterns = await getApprovedGlobalPatterns(); } catch (_) { globalPatterns = []; }
  }

  return suggestAll({ transactions, history, accounts: accounts || [], vatSettings: activeVat,
    globalPatterns, normalizeForGlobal: normalizeForGlobal || merchantKey });
}

module.exports = {
  PREFILL_MIN_CONFIDENCE,
  AUTO_MIN_COUNT,
  AUTO_MAX_AMOUNT,
  merchantKey,
  similarity,
  buildHistoryIndex,
  historyConfidence,
  suggestAll,
  suggestForTransactions
};
