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
 * fetchAccountBalances (routes/reports.js) fetches its `date` column via the
 * direct pg Pool, not the Supabase client — and node-postgres's default type
 * parser for a DATE column returns a real JS Date object (constructed at
 * LOCAL midnight of that calendar date), not a string. `String(dateObject)`
 * produces a human-readable form like "Wed Jan 15 2025 00:00:00 GMT+0200
 * (...)" — slicing that does NOT recover 'YYYY-MM-DD'. Using this object's
 * LOCAL getters (not `.toISOString()`, which would convert to UTC and can
 * shift the calendar day depending on the server's timezone offset) exactly
 * reverses how pg constructed it, so this round-trips correctly regardless
 * of server timezone. A plain string (e.g. from the Supabase JS client
 * elsewhere in this codebase) is returned as-is.
 */
function toDateOnlyString(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Groups journal_lines rows (each must include account_id, debit, credit,
 * and a `date` column — fetchAccountBalances in routes/reports.js selects
 * this) into { 'YYYY-MM': { [account_id]: { debit, credit } } }.
 */
function aggregateLinesByMonth(lines) {
  const byMonth = {};
  for (const l of lines) {
    const month = toDateOnlyString(l.date).slice(0, 7); // 'YYYY-MM-DD' -> 'YYYY-MM'
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

/** 'YYYY-MM' -> 'YYYY-Qn' (calendar quarter, not fiscal — this codebase's
 * P&L reports already work off plain calendar fromDate/toDate, so quarterly
 * grouping follows the same convention rather than introducing a
 * jurisdiction-specific fiscal-year quarter that nothing else here uses). */
function quarterKeyFromMonth(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** 'YYYY-MM' -> 'YYYY' */
function yearKeyFromMonth(yyyyMm) {
  return yyyyMm.split('-')[0];
}

/** 'YYYY-Qn' -> 'Q1 2026'; a plain 'YYYY' key is already display-ready. */
function formatPeriodLabel(key, granularity) {
  if (granularity !== 'quarterly') return key;
  const [year, q] = key.split('-');
  return `${q} ${year}`;
}

/**
 * Rolls a monthly {labels, datasets} series (as buildMonthlySeries returns)
 * up into quarterly or yearly buckets by SUMMING each dataset's values —
 * correct for flow measures like Revenue/Gross Profit/Net Profit (each
 * month's figure is itself already a period total, so a quarter/year is
 * just the sum of its months, never an average or a snapshot).
 *
 * `monthKeys` must be the same raw 'YYYY-MM' array (in the same order) that
 * was passed into buildMonthlySeries to produce `monthlySeries` — that
 * function's own `labels` are already human-formatted ('Jan 2026') and
 * can't be re-parsed back into a sortable/groupable key.
 */
function rollupMonthlySeries(monthlySeries, monthKeys, granularity) {
  if (granularity !== 'quarterly' && granularity !== 'yearly') return monthlySeries;

  const keyFn = granularity === 'quarterly' ? quarterKeyFromMonth : yearKeyFromMonth;
  const bucketOrder = [];
  const bucketIndexByKey = {};
  monthKeys.forEach(mk => {
    const key = keyFn(mk);
    if (!(key in bucketIndexByKey)) {
      bucketIndexByKey[key] = bucketOrder.length;
      bucketOrder.push(key);
    }
  });

  const datasets = monthlySeries.datasets.map(ds => {
    const data = new Array(bucketOrder.length).fill(0);
    ds.data.forEach((value, i) => {
      data[bucketIndexByKey[keyFn(monthKeys[i])]] += value;
    });
    return { label: ds.label, data: data.map(v => Math.round(v * 100) / 100) };
  });

  return { labels: bucketOrder.map(k => formatPeriodLabel(k, granularity)), datasets };
}

module.exports = {
  classifyAccountBalance,
  buildProfitLossTotals,
  aggregateLinesByMonth,
  buildMonthlySeries,
  monthRangeLabels,
  rollupMonthlySeries,
  toDateOnlyString,
};
