'use strict';

/**
 * ============================================================================
 * Insights — dashboard overview
 * ============================================================================
 * Puts together one owner dashboard from the apps a company actually uses:
 *
 *   finance — Ledger Leo (General Ledger). Read ONLY through Leo's own report
 *             code: glReportData.fetchAccountBalances (same SQL as Leo's P&L,
 *             balance sheet and cash flow) + profitLossService (same
 *             classification and sign convention). Revenue / gross profit /
 *             net profit here therefore always equal Leo's P&L for the same
 *             dates.
 *   sales   — Checkout Charlie. Read through pos/services/salesAnalyticsService,
 *             which uses Charlie's report definitions (completed sales only,
 *             VAT-inclusive totals, endOfDay date rule).
 *
 * A section is only returned when the company has data for it AND the
 * user's role may see it (finance: GL_REPORTS.VIEW, sales:
 * REPORTS.VIEW_FINANCIAL because it includes margin-tier data). Super admins
 * see everything (CLAUDE.md Rule F1). Nothing is written anywhere — this
 * service is read-only.
 * ============================================================================
 */

const { hasPermission } = require('../../../config/permissions');
const { fetchAccountBalances, aggregateLines, balanceOf } = require('../../accounting/services/glReportData');
const {
  classifyAccountBalance,
  buildProfitLossTotals,
  aggregateLinesByMonth,
  buildMonthlySeries,
  monthRangeLabels,
} = require('../../accounting/services/profitLossService');
const sales = require('../../pos/services/salesAnalyticsService');
const db = require('../../accounting/config/database');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TREND_MONTHS = 12;

// ─── Date helpers (pure, UTC-based so the server timezone never shifts a day) ─

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toDate(s) { return new Date(`${s}T00:00:00Z`); }
function fmt(d) { return d.toISOString().slice(0, 10); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

/** Shift a date back by n whole months, clamping to the month's last day. */
function minusMonths(s, n) {
  const d = toDate(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - n;
  const target = new Date(Date.UTC(y, m, 1));
  const day = Math.min(d.getUTCDate(), lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth()));
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)));
}

function minusDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() - n);
  return fmt(d);
}

/**
 * The period the "▲ x% vs …" badges compare against.
 *  - Range starting on the 1st of a month (a month, a quarter, month-to-date):
 *    the same days, N months earlier, where N = number of months the range
 *    touches. "1–11 Nov" compares with "1–11 Oct"; "Feb–Apr" with "Nov–Jan".
 *  - Year-to-date (from 1 January): the same dates last year.
 *  - Any other range: the same number of days immediately before it.
 */
function comparisonPeriod(from, to) {
  const f = toDate(from);
  const t = toDate(to);
  if (f.getUTCDate() === 1) {
    const months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth()) + 1;
    // Year-to-date (1 Jan → a date in the same year): compare with the same
    // dates last year — "Jan–Nov this year vs Feb–Dec last year" means nothing.
    if (months > 1 && f.getUTCMonth() === 0 && t.getUTCFullYear() === f.getUTCFullYear()) {
      return { from: minusMonths(from, 12), to: minusMonths(to, 12), label: 'vs same period last year' };
    }
    const prevFrom = minusMonths(from, months);
    // If `to` is a month end, compare with the full earlier month end too.
    const toIsMonthEnd = t.getUTCDate() === lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth());
    let prevTo = minusMonths(to, months);
    if (toIsMonthEnd) {
      const p = toDate(prevTo);
      prevTo = fmt(new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), lastDayOfMonth(p.getUTCFullYear(), p.getUTCMonth()))));
    }
    return { from: prevFrom, to: prevTo, label: months === 1 ? 'vs previous month' : `vs previous ${months} months` };
  }
  const days = Math.round((t - f) / 86400000) + 1;
  return { from: minusDays(from, days), to: minusDays(from, 1), label: `vs previous ${days} days` };
}

/** Same dates one year earlier (for the products' year-on-year column). */
function priorYearPeriod(from, to) {
  return { from: minusMonths(from, 12), to: minusMonths(to, 12) };
}

/** First day of the month TREND_MONTHS-1 months before `to`'s month. */
function trendStart(to) {
  const t = toDate(to);
  return fmt(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - (TREND_MONTHS - 1), 1)));
}

/** Percentage change, or null when there is no base to compare with. */
function pctChange(current, previous) {
  const c = parseFloat(current) || 0;
  const p = parseFloat(previous) || 0;
  if (p === 0) return null;
  return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
}

function kpi(current, previous) {
  return { value: current, previous, changePct: pctChange(current, previous) };
}

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

/**
 * Runs async tasks with at most `limit` in flight. Insights shares Ledger
 * Leo's pg Pool (max 15 connections); firing ~25 dashboard queries at once
 * starved the pool in testing (2026-11-11) and would make Leo's own reports
 * wait behind one owner opening a dashboard. Results keep the input order.
 */
const MAX_PARALLEL = 3;
async function runLimited(tasks, limit = MAX_PARALLEL) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ─── Access ──────────────────────────────────────────────────────────────────

function canSee(user, category, action) {
  if (user?.isSuperAdmin) return true; // Rule F1
  return hasPermission(user?.role, category, action);
}

async function hasLedgerData(companyId) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM journals WHERE company_id = $1 AND status IN ('posted', 'reversed')) AS has`,
    [companyId]);
  return !!rows[0]?.has;
}

// ─── Finance (Ledger Leo) ────────────────────────────────────────────────────

async function profitAndLoss(companyId, from, to) {
  const { accounts, lines } = await fetchAccountBalances(companyId, {
    fromDate: from, toDate: to, types: ['income', 'expense'],
  });
  const agg = aggregateLines(lines);
  const { totals } = buildProfitLossTotals(accounts.map(a => classifyAccountBalance(a, agg[a.id])));
  return totals;
}

/**
 * Cash, debtors and creditors at a date, from the balance-sheet accounts'
 * reporting_group (the same grouping Leo's cash flow uses for bank_cash).
 * Cash is the NET bank position: every bank_cash account debit-minus-credit,
 * so an overdraft (a bank_cash liability with a credit balance) lowers cash.
 */
async function balancesAt(companyId, asOfDate) {
  const { accounts, lines } = await fetchAccountBalances(companyId, {
    asOfDate, types: ['asset', 'liability'],
  });
  const agg = aggregateLines(lines);
  let cash = 0, debtors = 0, creditors = 0;
  for (const a of accounts) {
    if (a.reporting_group === 'bank_cash') {
      cash += (parseFloat(agg[a.id]?.debit || 0) - parseFloat(agg[a.id]?.credit || 0));
    } else if (a.reporting_group === 'debtors') {
      debtors += balanceOf(agg, a);
    } else if (a.reporting_group === 'creditors') {
      creditors += balanceOf(agg, a);
    }
  }
  return { cash: round2(cash), debtors: round2(debtors), creditors: round2(creditors) };
}

async function financeSection(companyId, period, compare, trendFrom) {
  // Each task below runs 2 queries in parallel itself, so 2 at a time = 4 connections max.
  const [cur, prev, balNow, balPrev, trendData] = await runLimited([
    () => profitAndLoss(companyId, period.from, period.to),
    () => profitAndLoss(companyId, compare.from, compare.to),
    () => balancesAt(companyId, period.to),
    () => balancesAt(companyId, compare.to),
    () => fetchAccountBalances(companyId, { fromDate: trendFrom, toDate: period.to, types: ['income', 'expense'] }),
  ], 2);

  const margin = t => (t.operatingIncome ? Math.round((t.grossProfit / t.operatingIncome) * 1000) / 10 : null);
  const monthKeys = monthRangeLabels(trendFrom, period.to);
  const trend = buildMonthlySeries(trendData.accounts, aggregateLinesByMonth(trendData.lines), monthKeys);

  return {
    available: true,
    source: 'Ledger Leo — posted General Ledger, excl. VAT',
    kpis: {
      revenue:        kpi(round2(cur.operatingIncome), round2(prev.operatingIncome)),
      grossProfit:    kpi(round2(cur.grossProfit), round2(prev.grossProfit)),
      grossMarginPct: { value: margin(cur), previous: margin(prev),
                        changePts: margin(cur) != null && margin(prev) != null
                          ? Math.round((margin(cur) - margin(prev)) * 10) / 10 : null },
      netProfit:      kpi(round2(cur.netProfit), round2(prev.netProfit)),
      operatingExpenses: kpi(round2(cur.operatingExpenses), round2(prev.operatingExpenses)),
      cash:           kpi(balNow.cash, balPrev.cash),
      debtors:        kpi(balNow.debtors, balPrev.debtors),
      creditors:      kpi(balNow.creditors, balPrev.creditors),
    },
    trend: { months: monthKeys, labels: trend.labels, datasets: trend.datasets },
  };
}

// ─── Sales (Checkout Charlie) ────────────────────────────────────────────────

async function salesSection(companyId, period, compare, trendFrom, filters) {
  const py = priorYearPeriod(period.from, period.to);
  const [cur, prev, monthly, byCategory, byStore, top, payments, returns, recent, options] = await runLimited([
    () => sales.getTotals(companyId, period.from, period.to, filters),
    () => sales.getTotals(companyId, compare.from, compare.to, filters),
    () => sales.getMonthly(companyId, trendFrom, period.to, filters),
    () => sales.getByCategory(companyId, period.from, period.to, filters),
    () => sales.getByStore(companyId, period.from, period.to, filters),
    () => sales.getTopProducts(companyId, period.from, period.to, filters, 5),
    () => sales.getPaymentMethods(companyId, period.from, period.to, filters),
    () => sales.getReturns(companyId, period.from, period.to),
    () => sales.getRecentSales(companyId, period.from, period.to, filters, 15),
    () => sales.getFilterOptions(companyId),
  ]);
  const pyRevenue = await sales.getProductRevenue(companyId, py.from, py.to, filters, top.map(p => p.productId));

  const monthKeys = monthRangeLabels(trendFrom, period.to);
  return {
    available: true,
    source: 'Checkout Charlie — completed till sales, incl. VAT',
    kpis: {
      sales:         kpi(cur.sales, prev.sales),
      orders:        kpi(cur.orders, prev.orders),
      avgOrderValue: kpi(cur.avgOrderValue, prev.avgOrderValue),
    },
    returns,
    trend: {
      months: monthKeys,
      sales: monthKeys.map(m => monthly[m]?.sales || 0),
      orders: monthKeys.map(m => monthly[m]?.orders || 0),
    },
    byCategory,
    byStore,
    paymentMethods: payments,
    topProducts: top.map(p => ({
      ...p,
      priorYearRevenue: pyRevenue[p.productId] ?? 0,
      yoyPct: pctChange(p.revenue, pyRevenue[p.productId] ?? 0),
    })),
    recentSales: recent,
    filterOptions: options,
    priorYearPeriod: py,
  };
}

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {number} args.companyId
 * @param {object} args.user      req.user (role, isSuperAdmin)
 * @param {string} args.from      'YYYY-MM-DD'
 * @param {string} args.to        'YYYY-MM-DD'
 * @param {object} args.filters   { store, category, paymentMethod } — sales slicers
 */
async function buildOverview({ companyId, user, from, to, filters = {} }) {
  const period = { from, to };
  const compare = comparisonPeriod(from, to);
  const trendFrom = trendStart(to);

  const financeAllowed = canSee(user, 'GL_REPORTS', 'VIEW');
  const salesAllowed = canSee(user, 'REPORTS', 'VIEW_FINANCIAL');
  const ledger = financeAllowed ? await hasLedgerData(companyId) : false;
  const till = salesAllowed ? await sales.hasSalesData(companyId) : false;

  // Sections run one after the other (not in parallel) — see runLimited().
  const finance = !financeAllowed ? { available: false, reason: 'no_permission' }
    : !ledger ? { available: false, reason: 'no_data' }
    : await financeSection(companyId, period, compare, trendFrom);
  const salesData = !salesAllowed ? { available: false, reason: 'no_permission' }
    : !till ? { available: false, reason: 'no_data' }
    : await salesSection(companyId, period, compare, trendFrom, filters);

  return {
    period,
    comparison: compare,
    generatedAt: new Date().toISOString(),
    finance,
    sales: salesData,
  };
}

module.exports = {
  buildOverview,
  // exported for unit tests
  _internal: { runLimited, isValidDate, comparisonPeriod, priorYearPeriod, trendStart, pctChange, minusMonths },
};
