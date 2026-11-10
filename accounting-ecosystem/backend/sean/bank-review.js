/**
 * ============================================================================
 * SEAN Bank Review — month-end checks an accountant does before closing
 * ============================================================================
 * Read-only. Looks at ONE bank account's lines and reports what needs a human
 * look before the books are closed. No external AI, no writes.
 *
 *   outlier          a line allocated differently from how this client books
 *                    that exact line every other time (likely a mis-post)
 *   balance_break    the statement balances do not follow on from one day to
 *                    the next → a missing / duplicated line or statement
 *   gap              no bank lines for more than GAP_DAYS → missing statement
 *   duplicate        same date, amount, description and statement balance
 *                    (likely imported twice); without a statement balance it
 *                    is only "possible" — repeated fees on one day are real
 *   stale            unallocated lines older than STALE_DAYS
 *   sean_auto        lines Sean posted by himself — listed so they get a look
 *
 * Checks are deliberately conservative: a review that cries wolf is ignored.
 * Tuned on real client data (2026-11-10).
 * ============================================================================
 */

'use strict';

const { merchantKey } = require('./bank-allocation-engine');

const GAP_DAYS = 35;
const STALE_DAYS = 30;
const OUTLIER_MIN_REPEATS = 3;     // the usual way must be seen at least this often
const MAX_PER_TYPE = 50;           // keep the review readable

const day = d => String(d || '').slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(day(b)) - new Date(day(a))) / 86400000);
const round2 = n => Math.round(n * 100) / 100;
const isPosted = r => r.status === 'matched' || r.status === 'reconciled';

/** Lines booked against this client's own consistent pattern for the same line. */
function findOutliers(rows, accountName = id => String(id)) {
  const groups = new Map();
  for (const r of rows) {
    if (!isPosted(r) || !r.allocated_account_id || r.allocation_type === 'transfer') continue;
    const key = `${Number(r.amount) < 0 ? 'out' : 'in'}|${merchantKey(r.description)}`;
    if (!merchantKey(r.description)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    const counts = new Map();
    for (const r of list) counts.set(r.allocated_account_id, (counts.get(r.allocated_account_id) || 0) + 1);
    if (counts.size < 2) continue;
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [usualId, usualN] = ranked[0];
    // A clear habit: the usual account dominates and the odd ones are rare
    if (usualN < OUTLIER_MIN_REPEATS) continue;
    for (const [odd, n] of ranked.slice(1)) {
      if (n > 1 || n * 4 > usualN) continue;
      const r = list.find(x => x.allocated_account_id === odd);
      out.push({
        type: 'outlier', severity: 'check', date: day(r.date), txnIds: [r.id], status: r.status,
        message: `"${r.description}" went to ${accountName(odd)}, but this line went to ${accountName(usualId)} the other ${usualN} time(s) — mis-posted?`
      });
    }
  }
  return out;
}

/**
 * Statement balances must follow on day to day: the previous day's closing
 * balance + this day's movements must equal one of this day's balances (lines
 * within a day may be stored in any order). Days with a line missing its
 * statement balance reset the chain (CSV/manual lines have none).
 */
function findBalanceBreaks(rows) {
  const days = new Map();
  for (const r of [...rows].sort((a, b) => day(a.date).localeCompare(day(b.date)) || a.id - b.id)) {
    const d = day(r.date);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  const out = [];
  let prevClose = null, prevDay = null;
  for (const [d, list] of days) {
    if (list.some(r => r.balance == null)) { prevClose = null; continue; }
    const bals = list.map(r => Number(r.balance));
    const sum = list.reduce((t, r) => t + Number(r.amount), 0);
    if (prevClose == null) {
      // First day of a chain: its close is the balance the day's lines lead up to
      prevClose = bals.find(b => list.some(r => Math.abs(round2(b - sum) + Number(r.amount) - Number(r.balance)) < 0.01)) ?? null;
      prevDay = d;
      continue;
    }
    const expected = round2(prevClose + sum);
    const hit = bals.find(b => Math.abs(b - expected) < 0.01);
    if (hit == null) {
      out.push({
        type: 'balance_break', severity: 'problem', date: d, txnIds: list.map(r => r.id),
        message: `Statement balances do not follow on from ${prevDay}: expected the day to close at R ${expected.toFixed(2)}, the statement shows R ${bals[bals.length - 1].toFixed(2)} — a line or statement is missing or doubled`
      });
      prevClose = null; // restart the chain from here
    } else {
      prevClose = hit;
    }
    prevDay = d;
  }
  return out;
}

/** Periods with no bank lines at all — usually a statement that was never imported. */
function findGaps(rows, gapDays = GAP_DAYS) {
  const dates = [...new Set(rows.map(r => day(r.date)))].sort();
  const out = [];
  for (let i = 1; i < dates.length; i++) {
    const n = daysBetween(dates[i - 1], dates[i]);
    if (n > gapDays) out.push({
      type: 'gap', severity: 'problem', date: dates[i - 1], txnIds: [],
      message: `No bank lines between ${dates[i - 1]} and ${dates[i]} (${n} days) — is a statement missing?`
    });
  }
  return out;
}

/** Same date + amount + description; same statement balance → likely imported twice. */
function findDuplicates(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${day(r.date)}|${Number(r.amount).toFixed(2)}|${String(r.description || '').trim().toLowerCase()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const withBal = list.filter(r => r.balance != null);
    const byBal = new Map();
    for (const r of withBal) byBal.set(Number(r.balance).toFixed(2), [...(byBal.get(Number(r.balance).toFixed(2)) || []), r]);
    const exact = [...byBal.values()].filter(g => g.length > 1);
    for (const g of exact) out.push({
      type: 'duplicate', severity: 'problem', date: day(g[0].date), txnIds: g.map(r => r.id),
      message: `${g.length}× "${g[0].description}" R ${Math.abs(Number(g[0].amount)).toFixed(2)} on the same day with the same statement balance — probably imported twice`
    });
    const noBal = list.filter(r => r.balance == null);
    if (noBal.length && list.length > 1 && !exact.length) out.push({
      type: 'duplicate', severity: 'check', date: day(list[0].date), txnIds: list.map(r => r.id),
      message: `${list.length}× "${list[0].description}" R ${Math.abs(Number(list[0].amount)).toFixed(2)} on the same day, ${noBal.length} without a statement balance — check it is not counted twice`
    });
  }
  return out;
}

function findStale(rows, today, staleDays = STALE_DAYS) {
  const old = rows.filter(r => r.status === 'unmatched' && daysBetween(r.date, today) > staleDays);
  if (!old.length) return [];
  const oldest = old.map(r => day(r.date)).sort()[0];
  return [{
    type: 'stale', severity: 'check', date: oldest, txnIds: old.map(r => r.id),
    message: `${old.length} line(s) older than ${staleDays} days are still unallocated (oldest ${oldest})`
  }];
}

function listSeanAuto(rows) {
  const lines = rows.filter(r => r.allocation_source === 'sean_auto' && isPosted(r));
  if (!lines.length) return [];
  return [{
    type: 'sean_auto', severity: 'info', date: lines.map(r => day(r.date)).sort()[0], txnIds: lines.map(r => r.id),
    message: `Sean posted ${lines.length} line(s) by himself — worth a glance in the Reviewed tab (marked 🤖 Sean)`
  }];
}

/**
 * @param {object} p
 *   rows      — one bank account's lines: id, date, description, amount, balance,
 *               status, allocated_account_id, allocation_type, allocation_source
 *   accounts  — company chart (id, code, name) for readable messages
 *   today     — 'YYYY-MM-DD'
 * @returns {{ findings: object[], counts: object }}
 */
function reviewBankAccount({ rows, accounts = [], today = new Date().toISOString().slice(0, 10) }) {
  const names = new Map(accounts.map(a => [a.id, `${a.code} ${a.name}`]));
  const accountName = id => names.get(id) || `account #${id}`;
  const order = { problem: 0, check: 1, info: 2 };
  const all = [
    ...findBalanceBreaks(rows), ...findGaps(rows), ...findDuplicates(rows),
    ...findOutliers(rows, accountName), ...findStale(rows, today), ...listSeanAuto(rows)
  ];
  const perType = {};
  const findings = all
    .sort((a, b) => order[a.severity] - order[b.severity] || a.date.localeCompare(b.date))
    .filter(f => (perType[f.type] = (perType[f.type] || 0) + 1) <= MAX_PER_TYPE);
  // Where the bank page should take the user for "Show": the tab the lines are
  // in, and the date range to filter on (stale = everything from the oldest).
  const statusById = new Map(rows.map(r => [r.id, r.status]));
  for (const f of findings) {
    f.tab = f.txnIds.some(id => statusById.get(id) === 'unmatched') ? 'new' : 'reviewed';
    f.showFrom = f.txnIds.length ? f.date : null;
    f.showTo = f.type === 'stale' ? null : f.showFrom;
  }
  const counts = { problem: 0, check: 0, info: 0 };
  findings.forEach(f => { counts[f.severity]++; });
  return { findings, counts };
}

module.exports = {
  GAP_DAYS, STALE_DAYS,
  findOutliers, findBalanceBreaks, findGaps, findDuplicates, findStale, listSeanAuto,
  reviewBankAccount
};
