'use strict';

/**
 * ============================================================================
 * GL report data — the ONE place posted journal lines are fetched for reports
 * ============================================================================
 * Moved verbatim out of routes/reports.js on 2026-11-11 so a second consumer
 * (Insights, modules/insights) reads the General Ledger through exactly the
 * same SQL as Ledger Leo's own reports. An owner must never see a different
 * number than the accountant sees in Leo (concept doc:
 * docs/future-build/OWNER_REPORTING_APP_CONCEPT.md, section 2 rule 1).
 *
 * Nothing here was changed in the move: same filters (status IN
 * ('posted','reversed') — see the reversed-journal reports bug of
 * 2026-09-02), same segment/source clauses, same sign conventions.
 * Classification lives in profitLossService.js; this file only fetches.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');
const db = require('../config/database'); // direct pg Pool — avoids .in() URL-length limits
const { fyStartMonthFromYearEnd } = require('./profitLossService');

// Month (1-12) the company's financial year starts in, for 'financial_year'
// grouping on the P&L trend chart and matrix.
async function fetchFyStartMonth(companyId) {
  const { data } = await supabase
    .from('companies')
    .select('financial_year_end')
    .eq('id', companyId)
    .maybeSingle();
  return fyStartMonthFromYearEnd(data && data.financial_year_end);
}

// ─── Helper: fetch posted journal lines for a company within a date range ────
// Uses a SQL JOIN instead of two-step Supabase fetch + .in(journalIds) to avoid
// PostgREST URL-length limits that silently truncate results for large companies.
async function fetchAccountBalances(companyId, { fromDate, toDate, asOfDate, types, segmentValueId, journalSourceMode } = {}) {
  // Accounts — small table, no .in() risk
  let acctQ = supabase.from('accounts').select('id, code, name, type, sub_type, reporting_group, parent_id, sort_order')
    .eq('company_id', companyId).eq('is_active', true);
  if (types) acctQ = acctQ.in('type', types);
  const { data: accounts, error: acctErr } = await acctQ;
  if (acctErr) throw new Error(acctErr.message);

  // Build parameterised date clauses for direct SQL
  const baseParams = [companyId];
  let dateClauses = '';
  if (asOfDate) { baseParams.push(asOfDate); dateClauses += ` AND j.date <= $${baseParams.length}`; }
  if (fromDate) { baseParams.push(fromDate); dateClauses += ` AND j.date >= $${baseParams.length}`; }
  if (toDate)   { baseParams.push(toDate);   dateClauses += ` AND j.date <= $${baseParams.length}`; }

  // Segment clause (untagged = IS NULL, numeric id = exact match)
  const linesParams = [...baseParams];
  let segClause = '';
  if (segmentValueId === 'untagged') {
    segClause = ' AND jl.segment_value_id IS NULL';
  } else if (segmentValueId) {
    linesParams.push(parseInt(segmentValueId));
    segClause = ` AND jl.segment_value_id = $${linesParams.length}`;
  }

  // Journal source filter (no extra params — literal SQL conditions only)
  let sourceClause = '';
  if (journalSourceMode === 'manual') {
    sourceClause = ` AND (j.source_type IS NULL OR j.source_type = 'manual')`;
  } else if (journalSourceMode === 'system') {
    sourceClause = ` AND j.source_type IS NOT NULL AND j.source_type != 'manual'`;
  }

  // Lines via JOIN + journal count — run in parallel, no .in() batching
  // j.date is selected too (2026-09-17, P&L trend chart) so a caller that
  // needs month-by-month buckets (aggregateLinesByMonth in
  // services/profitLossService.js) can group the exact same rows every
  // other caller here already gets — existing callers simply ignore the
  // extra column, no behaviour change for them.
  const linesSql = `
    SELECT jl.account_id, jl.debit, jl.credit, j.date
    FROM journal_lines jl
    INNER JOIN journals j ON j.id = jl.journal_id
    WHERE j.company_id = $1
      AND j.status IN ('posted', 'reversed')${dateClauses}${segClause}${sourceClause}
  `;
  const countSql = `
    SELECT COUNT(DISTINCT j.id)::int AS count
    FROM journals j
    WHERE j.company_id = $1
      AND j.status IN ('posted', 'reversed')${dateClauses}${sourceClause}
  `;

  const [linesResult, countResult] = await Promise.all([
    db.query(linesSql, linesParams),
    db.query(countSql, baseParams),
  ]);

  return {
    accounts: accounts || [],
    lines: linesResult.rows,
    journalCount: countResult.rows[0]?.count || 0,
  };
}

// Aggregate lines by account_id → { accountId: { debit, credit } }
function aggregateLines(lines) {
  const map = {};
  for (const l of lines) {
    const id = l.account_id;
    if (!map[id]) map[id] = { debit: 0, credit: 0 };
    map[id].debit  += parseFloat(l.debit  || 0);
    map[id].credit += parseFloat(l.credit || 0);
  }
  return map;
}

// Balance of one account given an aggregated debit/credit map, using the same
// sign convention as /balance-sheet: assets are debit-normal (d - c), everything
// else (liability/equity) is credit-normal (c - d).
function balanceOf(agg, acct) {
  const d = parseFloat(agg[acct.id]?.debit  || 0);
  const c = parseFloat(agg[acct.id]?.credit || 0);
  return acct.type === 'asset' ? (d - c) : (c - d);
}

module.exports = {
  fetchFyStartMonth,
  fetchAccountBalances,
  aggregateLines,
  balanceOf,
};
