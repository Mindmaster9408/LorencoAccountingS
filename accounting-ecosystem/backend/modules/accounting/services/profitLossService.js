/**
 * ============================================================================
 * Profit & Loss — shared classification/aggregation logic
 * ============================================================================
 * Extracted 2026-09-17 so the new monthly trend chart (GET /profit-loss/trend)
 * and the existing single-period report (GET /profit-loss, routes/reports.js)
 * share ONE source of truth for account classification and sign convention,
 * rather than risking the two silently drifting apart.
 *
 * classifyAccountBalance() is a byte-for-byte extraction of the loop body
 * routes/reports.js's GET /profit-loss used to inline (same effectiveSubType
 * fallback, same sign convention: income accounts credit-debit, everything
 * else debit-credit) — not a reinterpretation. This codebase has a
 * documented history of a real bug class here (reversed journals once
 * silently excluded from reports instead of netting to zero); this file
 * deliberately does not touch the SQL/filter logic in
 * routes/reports.js's fetchAccountBalances() (status IN ('posted','reversed')
 * etc.) at all — it only classifies whatever lines that function already
 * fetched.
 * ============================================================================
 */

/**
 * Classify + sign one account's aggregated debit/credit into the shape both
 * /profit-loss and /profit-loss/trend need. `agg` is a { debit, credit }
 * pair for this one account (already summed from journal_lines).
 */
function classifyAccountBalance(account, agg) {
  const d = parseFloat(agg?.debit || 0);
  const c = parseFloat(agg?.credit || 0);
  const effectiveSubType = account.sub_type ||
    (account.type === 'income' ? 'operating_income' : 'operating_expense');
  return {
    id: account.id, code: account.code, name: account.name, type: account.type,
    sub_type: effectiveSubType, reporting_group: account.reporting_group,
    parent_id: account.parent_id, total_debit: d, total_credit: c,
    balance: account.type === 'income' ? (c - d) : (d - c),
  };
}

/**
 * Buckets a list of already-classified account entries into the same
 * section shape /profit-loss returns, and sums each section into the
 * familiar P&L totals. Pure — no I/O, no knowledge of dates/companies.
 */
function buildProfitLossTotals(classifiedEntries) {
  const sections = {
    operating_income: [], other_income: [], cost_of_sales: [],
    operating_expense: [], depreciation_amort: [], finance_cost: [],
  };
  for (const entry of classifiedEntries) {
    if (sections[entry.sub_type]) sections[entry.sub_type].push(entry);
    else if (entry.type === 'income') sections.operating_income.push(entry);
    else sections.operating_expense.push(entry);
  }

  const sum = arr => arr.reduce((s, a) => s + a.balance, 0);
  const totalOperatingIncome   = sum(sections.operating_income);
  const totalOtherIncome       = sum(sections.other_income);
  const totalCostOfSales       = sum(sections.cost_of_sales);
  const totalOperatingExpenses = sum(sections.operating_expense);
  const totalDepreciation      = sum(sections.depreciation_amort);
  const totalFinanceCosts      = sum(sections.finance_cost);
  const grossProfit     = totalOperatingIncome - totalCostOfSales;
  const operatingProfit = grossProfit + totalOtherIncome - totalOperatingExpenses - totalDepreciation;
  const netProfit       = operatingProfit - totalFinanceCosts;

  return {
    sections,
    totals: {
      operatingIncome: totalOperatingIncome, otherIncome: totalOtherIncome,
      costOfSales: totalCostOfSales, grossProfit, operatingExpenses: totalOperatingExpenses,
      depreciation: totalDepreciation, operatingProfit, financeCosts: totalFinanceCosts, netProfit,
    },
  };
}

/**
 * Groups journal_lines rows (each must include account_id, debit, credit,
 * and a `date` column — fetchAccountBalances in routes/reports.js selects
 * this) into { 'YYYY-MM': { [account_id]: { debit, credit } } }.
 */
function aggregateLinesByMonth(lines) {
  const byMonth = {};
  for (const l of lines) {
    const month = String(l.date).slice(0, 7); // 'YYYY-MM-DD...' -> 'YYYY-MM'
    if (!byMonth[month]) byMonth[month] = {};
    const acctMap = byMonth[month];
    const id = l.account_id;
    if (!acctMap[id]) acctMap[id] = { debit: 0, credit: 0 };
    acctMap[id].debit  += parseFloat(l.debit  || 0);
    acctMap[id].credit += parseFloat(l.credit || 0);
  }
  return byMonth;
}

/**
 * Builds the Chart.js-ready { labels, datasets } shape for the P&L trend
 * chart from a company's accounts + month-grouped line aggregation.
 * Months with no activity at all still appear (as zero) so the chart's
 * x-axis is a continuous calendar, not just months that happened to post
 * something.
 */
function buildMonthlySeries(accounts, linesByMonth, monthLabels) {
  const revenueData = [];
  const grossProfitData = [];
  const netProfitData = [];

  for (const month of monthLabels) {
    const agg = linesByMonth[month] || {};
    const classified = accounts.map(a => classifyAccountBalance(a, agg[a.id]));
    const { totals } = buildProfitLossTotals(classified);
    revenueData.push(Math.round(totals.operatingIncome * 100) / 100);
    grossProfitData.push(Math.round(totals.grossProfit * 100) / 100);
    netProfitData.push(Math.round(totals.netProfit * 100) / 100);
  }

  return {
    labels: monthLabels.map(formatMonthLabel),
    datasets: [
      { label: 'Revenue', data: revenueData },
      { label: 'Gross Profit', data: grossProfitData },
      { label: 'Net Profit', data: netProfitData },
    ],
  };
}

/** 'YYYY-MM' -> 'Jan 2026' */
function formatMonthLabel(yyyyMm) {
  const [year, month] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Every 'YYYY-MM' from fromDate to toDate inclusive, in order. */
function monthRangeLabels(fromDate, toDate) {
  const months = [];
  const start = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= endCursor) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

module.exports = {
  classifyAccountBalance,
  buildProfitLossTotals,
  aggregateLinesByMonth,
  buildMonthlySeries,
  monthRangeLabels,
};
