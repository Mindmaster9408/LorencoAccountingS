const express = require('express');
const { supabase } = require('../../../config/database');
const db = require('../config/database'); // direct pg Pool — avoids .in() URL-length limits
const { authenticate, hasPermission } = require('../middleware/auth');
const { getBadge } = require('../services/reportTruthBadge');

const router = express.Router();

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
  const linesSql = `
    SELECT jl.account_id, jl.debit, jl.credit
    FROM journal_lines jl
    INNER JOIN journals j ON j.id = jl.journal_id
    WHERE j.company_id = $1
      AND j.status = 'posted'${dateClauses}${segClause}${sourceClause}
  `;
  const countSql = `
    SELECT COUNT(DISTINCT j.id)::int AS count
    FROM journals j
    WHERE j.company_id = $1
      AND j.status = 'posted'${dateClauses}${sourceClause}
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

/**
 * GET /api/reports/trial-balance
 */
router.get('/trial-balance', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { fromDate, toDate, journalSourceMode: rawMode } = req.query;
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate are required' });
    }
    const journalSourceMode = ['all', 'manual', 'system'].includes(rawMode) ? rawMode : 'all';

    const { accounts, lines, journalCount } = await fetchAccountBalances(req.user.companyId, { fromDate, toDate, journalSourceMode });
    const agg = aggregateLines(lines);

    const result = accounts.map(a => {
      const d = parseFloat(agg[a.id]?.debit  || 0);
      const c = parseFloat(agg[a.id]?.credit || 0);
      return { ...a, total_debit: d, total_credit: c, balance: d - c };
    }).sort((a, b) => a.code.localeCompare(b.code));

    const summary = { asset: {}, liability: {}, equity: {}, income: {}, expense: {}, total: {} };
    ['asset','liability','equity','income','expense','total'].forEach(k => {
      summary[k] = { debit: 0, credit: 0, balance: 0 };
    });
    result.forEach(a => {
      const t = summary[a.type] || summary.total;
      t.debit   += a.total_debit;
      t.credit  += a.total_credit;
      t.balance += a.balance;
      summary.total.debit   += a.total_debit;
      summary.total.credit  += a.total_credit;
      summary.total.balance += a.balance;
    });

    res.json({
      fromDate, toDate,
      accounts: result,
      summary,
      journalCount: journalCount || 0,
      isBalanced: Math.abs(summary.total.debit - summary.total.credit) < 0.01,
      reportTruth: getBadge('posted_gl_only', { journalSourceMode }),
    });

  } catch (error) {
    console.error('Error generating trial balance:', error);
    res.status(500).json({ error: 'Failed to generate trial balance' });
  }
});

/**
 * GET /api/reports/general-ledger
 */
router.get('/general-ledger', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { accountId, fromDate, toDate, journalSourceMode: rawMode } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    const journalSourceMode = ['all', 'manual', 'system'].includes(rawMode) ? rawMode : 'all';
    let glSourceClause = '';
    if (journalSourceMode === 'manual') {
      glSourceClause = ` AND (j.source_type IS NULL OR j.source_type = 'manual')`;
    } else if (journalSourceMode === 'system') {
      glSourceClause = ` AND j.source_type IS NOT NULL AND j.source_type != 'manual'`;
    }

    const { data: account, error: aErr } = await supabase
      .from('accounts').select('*')
      .eq('id', accountId).eq('company_id', req.user.companyId).single();
    if (aErr || !account) return res.status(404).json({ error: 'Account not found' });

    // Opening balance and period lines via SQL JOIN — no .in() batching
    // Both run in parallel since they are independent queries.
    const obParams = fromDate ? [req.user.companyId, fromDate, accountId] : null;
    const periodParams = [req.user.companyId, accountId];
    let periodDateClauses = '';
    if (fromDate) { periodParams.push(fromDate); periodDateClauses += ` AND j.date >= $${periodParams.length}`; }
    if (toDate)   { periodParams.push(toDate);   periodDateClauses += ` AND j.date <= $${periodParams.length}`; }

    const [obResult, periodResult] = await Promise.all([
      obParams
        ? db.query(
            `SELECT jl.debit, jl.credit
             FROM journal_lines jl
             INNER JOIN journals j ON j.id = jl.journal_id
             WHERE j.company_id = $1 AND j.status = 'posted'
               AND j.date < $2 AND jl.account_id = $3${glSourceClause}`,
            obParams
          )
        : Promise.resolve({ rows: [] }),
      db.query(
        `SELECT jl.journal_id, jl.description AS line_description, jl.debit, jl.credit,
                j.date::text AS date, j.reference,
                j.description AS journal_description, j.source_type
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         WHERE j.company_id = $1 AND j.status = 'posted'
           AND jl.account_id = $2${periodDateClauses}${glSourceClause}`,
        periodParams
      ),
    ]);

    // Opening balance
    let openingBalance = 0;
    for (const l of obResult.rows) {
      openingBalance += parseFloat(l.debit || 0) - parseFloat(l.credit || 0);
    }

    // Period transactions — map without running balance, sort by date/journal, then accumulate.
    // Running balance must be computed after sort — computing it during the map
    // produces wrong per-row balances because DB row order is not date order.
    const mapped = periodResult.rows.map(l => ({
      journal_id: l.journal_id,
      date: l.date,
      reference: l.reference,
      journal_description: l.journal_description,
      line_description: l.line_description,
      source_type: l.source_type,
      debit: parseFloat(l.debit || 0),
      credit: parseFloat(l.credit || 0),
    }));
    mapped.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.journal_id - b.journal_id);
    let running = openingBalance;
    const transactions = mapped.map(line => {
      running += line.debit - line.credit;
      return { ...line, balance: running };
    });

    const totalDebit   = transactions.reduce((s, t) => s + t.debit,  0);
    const totalCredit  = transactions.reduce((s, t) => s + t.credit, 0);
    const closingBalance = openingBalance + totalDebit - totalCredit;

    res.json({ account, fromDate: fromDate || null, toDate: toDate || null,
               openingBalance, transactions, totalDebit, totalCredit, closingBalance,
               reportTruth: getBadge('posted_gl_only', { journalSourceMode }) });

  } catch (error) {
    console.error('Error generating general ledger:', error);
    res.status(500).json({ error: 'Failed to generate general ledger' });
  }
});

/**
 * GET /api/reports/bank-reconciliation
 */
router.get('/bank-reconciliation', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { bankAccountId, date } = req.query;
    if (!bankAccountId || !date) {
      return res.status(400).json({ error: 'bankAccountId and date are required' });
    }

    const { data: ba, error: baErr } = await supabase
      .from('bank_accounts')
      .select('*, accounts!ledger_account_id(code, name)')
      .eq('id', bankAccountId).eq('company_id', req.user.companyId).single();
    if (baErr || !ba) return res.status(404).json({ error: 'Bank account not found' });

    const bankAccount = { ...ba, ledger_code: ba.accounts?.code, ledger_name: ba.accounts?.name };

    // Statement balance: most recent balance field on or before date
    const { data: lastTxn } = await supabase
      .from('bank_transactions').select('balance')
      .eq('company_id', req.user.companyId)
      .eq('bank_account_id', bankAccountId).lte('date', date)
      .order('date', { ascending: false }).order('id', { ascending: false }).limit(1);
    const statementBalance = lastTxn && lastTxn.length > 0 && lastTxn[0].balance != null
      ? parseFloat(lastTxn[0].balance)
      : parseFloat(bankAccount.opening_balance || 0);

    // Ledger balance from posted journals via SQL JOIN — no .in() batching
    let ledgerBalance = parseFloat(bankAccount.opening_balance || 0);
    if (bankAccount.ledger_account_id) {
      const { rows: lns } = await db.query(
        `SELECT jl.debit, jl.credit
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         WHERE j.company_id = $1
           AND j.status = 'posted'
           AND j.date <= $2
           AND jl.account_id = $3`,
        [req.user.companyId, date, bankAccount.ledger_account_id]
      );
      for (const l of lns) {
        ledgerBalance += parseFloat(l.debit || 0) - parseFloat(l.credit || 0);
      }
    }

    // Unreconciled transactions
    const { data: unrecon } = await supabase.from('bank_transactions').select('*')
      .eq('company_id', req.user.companyId)
      .eq('bank_account_id', bankAccountId).lte('date', date)
      .in('status', ['unmatched', 'matched'])
      .order('date').order('id');

    const unreconciledTransactions = (unrecon || []).map(t => ({ ...t, amount: parseFloat(t.amount) }));
    const unreconciledTotal   = unreconciledTransactions.reduce((s, t) => s + t.amount, 0);
    const reconciledBalance   = statementBalance - unreconciledTotal;
    const difference          = ledgerBalance - reconciledBalance;

    res.json({ bankAccount, date, statementBalance, ledgerBalance,
               unreconciledTransactions, unreconciledTotal, reconciledBalance,
               difference, isReconciled: Math.abs(difference) < 0.01,
               reportTruth: getBadge('diagnostic_reconciliation') });

  } catch (error) {
    console.error('Error generating bank reconciliation:', error);
    res.status(500).json({ error: 'Failed to generate bank reconciliation' });
  }
});

/**
 * GET /api/reports/balance-sheet
 */
router.get('/balance-sheet', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { asOfDate, fromDate } = req.query;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate is required' });

    const companyId = req.user.companyId;

    // Balance sheet accounts
    const { accounts: bsAccounts, lines: bsLines } = await fetchAccountBalances(companyId, {
      asOfDate, types: ['asset', 'liability', 'equity']
    });
    const bsAgg = aggregateLines(bsLines);

    // P&L accounts for current year earnings
    const { accounts: plAccounts, lines: plLines } = await fetchAccountBalances(companyId, {
      asOfDate, fromDate, types: ['income', 'expense']
    });
    const plAgg = aggregateLines(plLines);

    let totalIncome = 0, totalExpense = 0;
    for (const a of plAccounts) {
      const d = parseFloat(plAgg[a.id]?.debit  || 0);
      const c = parseFloat(plAgg[a.id]?.credit || 0);
      if (a.type === 'income')  totalIncome  += c - d;
      if (a.type === 'expense') totalExpense += d - c;
    }
    const netIncome = totalIncome - totalExpense;

    const assets = [], liabilities = [], equity = [];
    for (const a of bsAccounts) {
      const d = parseFloat(bsAgg[a.id]?.debit  || 0);
      const c = parseFloat(bsAgg[a.id]?.credit || 0);
      const entry = { id: a.id, code: a.code, name: a.name, type: a.type, parent_id: a.parent_id,
                      total_debit: d, total_credit: c,
                      balance: a.type === 'asset' ? (d - c) : (c - d) };
      if (a.type === 'asset')          assets.push(entry);
      else if (a.type === 'liability') liabilities.push(entry);
      else                             equity.push(entry);
    }

    const totalAssets      = assets.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
    const totalEquity      = equity.reduce((s, a) => s + a.balance, 0) + netIncome;

    res.json({
      asOfDate, fromDate: fromDate || null,
      assets, liabilities, equity,
      currentYearEarnings: netIncome,
      totals: { assets: totalAssets, liabilities: totalLiabilities, equity: totalEquity,
                liabilitiesAndEquity: totalLiabilities + totalEquity },
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      reportTruth: getBadge('posted_gl_only'),
    });

  } catch (error) {
    console.error('Error generating balance sheet:', error);
    res.status(500).json({ error: 'Failed to generate balance sheet' });
  }
});

/**
 * GET /api/reports/profit-loss
 */
router.get('/profit-loss', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { fromDate, toDate, segmentValueId, journalSourceMode: rawMode } = req.query;
    if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate are required' });
    const journalSourceMode = ['all', 'manual', 'system'].includes(rawMode) ? rawMode : 'all';

    const companyId = req.user.companyId;
    const { accounts, lines } = await fetchAccountBalances(companyId, {
      fromDate, toDate, types: ['income', 'expense'],
      segmentValueId: segmentValueId || null, journalSourceMode
    });
    const agg = aggregateLines(lines);

    const sections = {
      operating_income: [], other_income: [], cost_of_sales: [],
      operating_expense: [], depreciation_amort: [], finance_cost: []
    };

    for (const a of accounts) {
      const d = parseFloat(agg[a.id]?.debit  || 0);
      const c = parseFloat(agg[a.id]?.credit || 0);
      const effectiveSubType = a.sub_type ||
        (a.type === 'income' ? 'operating_income' : 'operating_expense');
      const entry = { id: a.id, code: a.code, name: a.name, type: a.type,
                      sub_type: effectiveSubType, reporting_group: a.reporting_group,
                      parent_id: a.parent_id, total_debit: d, total_credit: c,
                      balance: a.type === 'income' ? (c - d) : (d - c) };
      if (sections[effectiveSubType]) sections[effectiveSubType].push(entry);
      else if (a.type === 'income')   sections.operating_income.push(entry);
      else                            sections.operating_expense.push(entry);
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

    res.json({
      fromDate, toDate, segmentValueId: segmentValueId || null,
      operatingIncome: sections.operating_income, costOfSales: sections.cost_of_sales,
      otherIncome: sections.other_income, operatingExpenses: sections.operating_expense,
      depreciation: sections.depreciation_amort, financeCosts: sections.finance_cost,
      totals: { operatingIncome: totalOperatingIncome, otherIncome: totalOtherIncome,
                costOfSales: totalCostOfSales, grossProfit, operatingExpenses: totalOperatingExpenses,
                depreciation: totalDepreciation, operatingProfit, financeCosts: totalFinanceCosts, netProfit },
      isProfitable: netProfit >= 0,
      income:  [...sections.operating_income, ...sections.other_income],
      expense: [...sections.cost_of_sales, ...sections.operating_expense,
                ...sections.depreciation_amort, ...sections.finance_cost],
      reportTruth: getBadge('posted_gl_only', { journalSourceMode }),
    });

  } catch (error) {
    console.error('Error generating profit & loss:', error);
    res.status(500).json({ error: 'Failed to generate profit & loss report' });
  }
});

/**
 * GET /api/reports/division-profit-loss?fromDate=&toDate=
 *
 * Returns a complete side-by-side P&L for every division (segment value) in the company,
 * plus an "Untagged" column for journal lines with no segment_value_id, plus a Company Total.
 *
 * Response shape:
 * {
 *   fromDate, toDate,
 *   columns: [{ id, name, code, color }],   // one per division + { id:'untagged', name:'Untagged' } + { id:'total', name:'Total' }
 *   sections: { operating_income, cost_of_sales, other_income, operating_expense, depreciation_amort, finance_cost },
 *   // each section is an array of { id, code, name, sub_type, values: { [columnId]: balance } }
 *   totals: { [columnId]: { grossProfit, operatingProfit, netProfit, ... } }
 * }
 */
router.get('/division-profit-loss', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate are required' });

    const companyId = req.user.companyId;

    // 1 — fetch all active segments + values for this company
    const { data: segments, error: segErr } = await supabase
      .from('coa_segments')
      .select('id, name, code')
      .eq('company_id', companyId)
      .eq('is_active', true);
    if (segErr) throw new Error(segErr.message);

    let divisionValues = [];
    if (segments && segments.length > 0) {
      const { data: vals, error: vErr } = await supabase
        .from('coa_segment_values')
        .select('id, segment_id, code, name, color, sort_order')
        .in('segment_id', segments.map(s => s.id))
        .eq('is_active', true)
        .order('sort_order').order('name');
      if (vErr) throw new Error(vErr.message);
      divisionValues = vals || [];
    }

    // 2 — build column list: one per division value + untagged + total
    const columns = [
      ...divisionValues.map(v => ({ id: String(v.id), name: v.name, code: v.code, color: v.color || null })),
      { id: 'untagged', name: 'Untagged', code: 'UNTAGGED', color: '#9ca3af' },
      { id: 'total',    name: 'Total',    code: 'TOTAL',    color: null }
    ];

    // 3 — fetch P&L data for each column (division, untagged, total)
    // Re-use fetchAccountBalances; accounts list is the same for all — fetch once then reuse
    const { accounts, lines: totalLines, journalCount } = await fetchAccountBalances(companyId, {
      fromDate, toDate, types: ['income', 'expense']
    });

    // aggregations keyed by column id
    const aggByColumn = {};

    // total
    aggByColumn['total'] = aggregateLines(totalLines);

    // untagged
    const { lines: untaggedLines } = await fetchAccountBalances(companyId, {
      fromDate, toDate, types: ['income', 'expense'], segmentValueId: 'untagged'
    });
    aggByColumn['untagged'] = aggregateLines(untaggedLines);

    // per division
    for (const dv of divisionValues) {
      const { lines: dvLines } = await fetchAccountBalances(companyId, {
        fromDate, toDate, types: ['income', 'expense'], segmentValueId: String(dv.id)
      });
      aggByColumn[String(dv.id)] = aggregateLines(dvLines);
    }

    // 4 — build sections
    const sectionKeys = ['operating_income', 'cost_of_sales', 'other_income', 'operating_expense', 'depreciation_amort', 'finance_cost'];
    const sections = {};
    sectionKeys.forEach(k => { sections[k] = []; });

    for (const a of accounts) {
      const effectiveSubType = a.sub_type ||
        (a.type === 'income' ? 'operating_income' : 'operating_expense');
      const targetSection = sections[effectiveSubType]
        ? effectiveSubType
        : (a.type === 'income' ? 'operating_income' : 'operating_expense');

      const values = {};
      for (const col of columns) {
        const agg = aggByColumn[col.id] || {};
        const d = parseFloat(agg[a.id]?.debit  || 0);
        const c = parseFloat(agg[a.id]?.credit || 0);
        values[col.id] = a.type === 'income' ? (c - d) : (d - c);
      }

      // only include row if at least one column has a non-zero balance
      const hasActivity = Object.values(values).some(v => Math.abs(v) > 0.001);
      if (!hasActivity) continue;

      sections[targetSection].push({
        id: a.id, code: a.code, name: a.name, type: a.type,
        sub_type: effectiveSubType, reporting_group: a.reporting_group,
        values
      });
    }

    // 5 — compute subtotals per column
    const sum = (section, colId) => sections[section].reduce((s, r) => s + (r.values[colId] || 0), 0);
    const totals = {};
    for (const col of columns) {
      const cid = col.id;
      const totalOperatingIncome   = sum('operating_income',   cid);
      const totalOtherIncome       = sum('other_income',       cid);
      const totalCostOfSales       = sum('cost_of_sales',      cid);
      const totalOperatingExpenses = sum('operating_expense',  cid);
      const totalDepreciation      = sum('depreciation_amort', cid);
      const totalFinanceCosts      = sum('finance_cost',       cid);
      const grossProfit     = totalOperatingIncome - totalCostOfSales;
      const operatingProfit = grossProfit + totalOtherIncome - totalOperatingExpenses - totalDepreciation;
      const netProfit       = operatingProfit - totalFinanceCosts;
      totals[cid] = {
        operatingIncome: totalOperatingIncome, otherIncome: totalOtherIncome,
        costOfSales: totalCostOfSales, grossProfit,
        operatingExpenses: totalOperatingExpenses, depreciation: totalDepreciation,
        operatingProfit, financeCosts: totalFinanceCosts, netProfit
      };
    }

    res.json({
      fromDate, toDate,
      columns,
      sections: {
        operatingIncome:   sections.operating_income,
        costOfSales:       sections.cost_of_sales,
        otherIncome:       sections.other_income,
        operatingExpenses: sections.operating_expense,
        depreciation:      sections.depreciation_amort,
        financeCosts:      sections.finance_cost,
      },
      totals,
      journalCount
    });

  } catch (error) {
    console.error('Error generating division P&L:', error);
    res.status(500).json({ error: 'Failed to generate division profit & loss report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/unallocated-bank-transactions
// Lists bank_transactions with status = 'unmatched' (confirmed but not yet
// allocated/journalised). This is the "silent gap" list that does NOT appear in
// the TB — the TB is correct in excluding these; this report surfaces them for
// management review so the accountant can track what still needs to be allocated.
//
// Query params:
//   bankAccountId  — optional, filter to one bank account
//   dateFrom       — optional YYYY-MM-DD
//   dateTo         — optional YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/unallocated-bank-transactions', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { bankAccountId, dateFrom, dateTo } = req.query;
    const companyId = req.user.companyId;

    let q = supabase
      .from('bank_transactions')
      .select(`
        id,
        date,
        description,
        amount,
        reference,
        bank_account_id,
        bank_accounts!bank_transactions_bank_account_id_fkey(
          id,
          name,
          account_number
        )
      `)
      .eq('company_id', companyId)
      .eq('status', 'unmatched')
      .order('date', { ascending: false })
      .order('id', { ascending: false });

    if (bankAccountId) q = q.eq('bank_account_id', Number(bankAccountId));
    if (dateFrom)      q = q.gte('date', dateFrom);
    if (dateTo)        q = q.lte('date', dateTo);

    const { data: txns, error } = await q;
    if (error) throw new Error(error.message);

    const rows = txns || [];
    const totalAmount = rows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    res.json({
      transactions: rows,
      count:       rows.length,
      totalAmount: Number(totalAmount.toFixed(2)),
      filters: { bankAccountId: bankAccountId || null, dateFrom: dateFrom || null, dateTo: dateTo || null },
      reportTruth: getBadge('mixed_gl_operational'),
    });

  } catch (error) {
    console.error('Error generating unallocated bank transactions report:', error);
    res.status(500).json({ error: 'Failed to generate unallocated bank transactions report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/bank-recon-history
// Lists all formal bank_recon_sessions for the company (from migration 047).
// Each row represents one completed bank reconciliation event with the
// statement date, closing balance, difference, and who performed it.
//
// Query params:
//   bankAccountId  — optional, filter to one bank account
//
// GET /api/reports/bank-recon-history/:sessionId
// Returns one session with its linked transactions.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/bank-recon-history', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { bankAccountId } = req.query;
    const companyId = req.user.companyId;

    let q = supabase
      .from('bank_recon_sessions')
      .select(`
        id,
        bank_account_id,
        statement_date,
        statement_closing_balance,
        cleared_balance,
        difference,
        transaction_count,
        created_at,
        created_by,
        bank_accounts!bank_recon_sessions_bank_account_id_fkey(
          id,
          name,
          account_number
        ),
        users!bank_recon_sessions_created_by_fkey(
          id,
          name,
          email
        )
      `)
      .eq('company_id', companyId)
      .order('statement_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (bankAccountId) q = q.eq('bank_account_id', Number(bankAccountId));

    const { data: sessions, error } = await q;
    if (error) throw new Error(error.message);

    res.json({ sessions: sessions || [], reportTruth: getBadge('diagnostic_reconciliation') });

  } catch (error) {
    console.error('Error generating bank recon history:', error);
    res.status(500).json({ error: 'Failed to generate bank reconciliation history' });
  }
});

router.get('/bank-recon-history/:sessionId', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const companyId = req.user.companyId;

    if (!sessionId || isNaN(sessionId)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const { data: session, error: sessErr } = await supabase
      .from('bank_recon_sessions')
      .select(`
        id,
        bank_account_id,
        statement_date,
        statement_closing_balance,
        cleared_balance,
        difference,
        transaction_count,
        created_at,
        created_by,
        bank_accounts!bank_recon_sessions_bank_account_id_fkey(
          id,
          name,
          account_number
        ),
        users!bank_recon_sessions_created_by_fkey(
          id,
          name,
          email
        )
      `)
      .eq('id', sessionId)
      .eq('company_id', companyId)
      .single();

    if (sessErr || !session) {
      return res.status(404).json({ error: 'Reconciliation session not found' });
    }

    const { data: txns, error: txnErr } = await supabase
      .from('bank_transactions')
      .select('id, date, description, amount, reference, allocated_account_name, allocation_type, reconciled_at')
      .eq('recon_session_id', sessionId)
      .eq('company_id', companyId)
      .order('date', { ascending: true });

    if (txnErr) throw new Error(txnErr.message);

    res.json({ session, transactions: txns || [], reportTruth: getBadge('diagnostic_reconciliation') });

  } catch (error) {
    console.error('Error fetching bank recon session:', error);
    res.status(500).json({ error: 'Failed to fetch reconciliation session' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounting/reports/control-account-reconciliation
//
// Forensic reconciliation proof: compares GL control account balances against
// the corresponding sub-ledger outstanding balances.
//
//   AR: GL account 1100  vs  outstanding customer_invoices
//   AP: GL account 2000  vs  outstanding supplier_invoices
//
// Sign convention (consistent with rest of reports.js):
//   AR GL balance  = SUM(debit) − SUM(credit) → positive = receivable  (asset)
//   AP GL balance  = SUM(credit) − SUM(debit) → positive = payable    (liability)
//
// Query params:
//   asAt  — ISO date (YYYY-MM-DD), defaults to today
//   type  — 'ar' | 'ap' | 'both'  (default 'both')
// ─────────────────────────────────────────────────────────────────────────────
router.get('/control-account-reconciliation', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const asAt = req.query.asAt || new Date().toISOString().slice(0, 10);
    const type = req.query.type || 'both';

    const includeAR = type === 'ar' || type === 'both';
    const includeAP = type === 'ap' || type === 'both';

    const result = { asAt };
    if (includeAR) result.ar = await buildARReconciliation(companyId, asAt);
    if (includeAP) result.ap = await buildAPReconciliation(companyId, asAt);

    res.json({ ...result, reportTruth: getBadge('diagnostic_reconciliation') });
  } catch (error) {
    console.error('[reports.control-account-recon] Error:', error.message);
    res.status(500).json({ error: 'Failed to generate control account reconciliation' });
  }
});

// ─── AR helper: GL 1100 vs customer_invoices sub-ledger ──────────────────────
async function buildARReconciliation(companyId, asAt) {
  const warnings = [];

  // 1. Lookup control account 1100
  const acctRes = await db.query(
    `SELECT id, code, name FROM accounts WHERE company_id = $1 AND code = '1100' LIMIT 1`,
    [companyId]
  );
  const acct = acctRes.rows[0] || null;
  if (!acct) {
    warnings.push('AR control account (code 1100) not found in Chart of Accounts. GL balance cannot be calculated.');
  }

  // 2. GL balance: debit − credit (positive = receivable, asset normal balance)
  let glBalance = 0;
  if (acct) {
    const glRes = await db.query(
      `SELECT COALESCE(SUM(jl.debit), 0) AS d, COALESCE(SUM(jl.credit), 0) AS c
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date <= $2
         AND jl.account_id = $3`,
      [companyId, asAt, acct.id]
    );
    const d = parseFloat(glRes.rows[0].d);
    const c = parseFloat(glRes.rows[0].c);
    glBalance = Math.round((d - c) * 100) / 100;

    // Warning: manual journals posting directly to 1100 (bypass sub-ledger)
    const manualRes = await db.query(
      `SELECT COUNT(DISTINCT j.id) AS cnt
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date <= $2
         AND jl.account_id = $3
         AND (j.source_type = 'manual' OR j.source_type IS NULL)`,
      [companyId, asAt, acct.id]
    );
    const manualCount = parseInt(manualRes.rows[0].cnt || 0);
    if (manualCount > 0) {
      warnings.push(
        `${manualCount} manual journal(s) post directly to AR control account 1100 and are not linked to customer invoices or payments. ` +
        `These may cause a GL vs sub-ledger difference.`
      );
    }
  }

  // 3. Sub-ledger: outstanding customer invoices as at asAt
  const slRes = await db.query(
    `SELECT COALESCE(SUM(total_inc_vat - amount_paid), 0) AS subledger_balance, COUNT(*) AS invoice_count
     FROM customer_invoices
     WHERE company_id = $1
       AND invoice_date <= $2
       AND status NOT IN ('draft', 'void', 'cancelled')
       AND (total_inc_vat - amount_paid) > 0.005`,
    [companyId, asAt]
  );
  const subledgerBalance = Math.round(parseFloat(slRes.rows[0].subledger_balance || 0) * 100) / 100;
  const invoiceCount     = parseInt(slRes.rows[0].invoice_count || 0);

  // 4. Warning: invoices posted (sent/part_paid) but journal_id missing
  const orphanInvRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM customer_invoices
     WHERE company_id = $1 AND status IN ('sent', 'part_paid') AND journal_id IS NULL`,
    [companyId]
  );
  const orphanInvCount = parseInt(orphanInvRes.rows[0].cnt || 0);
  if (orphanInvCount > 0) {
    warnings.push(
      `${orphanInvCount} customer invoice(s) with status 'sent' or 'part_paid' have no linked GL journal. ` +
      `These appear in the sub-ledger but NOT in the GL.`
    );
  }

  // 5. Warning: customer payments with no GL journal
  const orphanPayRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM customer_payments WHERE company_id = $1 AND journal_id IS NULL`,
    [companyId]
  );
  const orphanPayCount = parseInt(orphanPayRes.rows[0].cnt || 0);
  if (orphanPayCount > 0) {
    warnings.push(
      `${orphanPayCount} customer payment(s) have no linked GL journal. ` +
      `These reduce the sub-ledger but NOT the GL.`
    );
  }

  // 6. Detail breakdown by customer
  const detailRes = await db.query(
    `SELECT
       CASE WHEN customer_id IS NOT NULL THEN 'id:' || customer_id::text
            ELSE 'name:' || lower(trim(customer_name)) END AS group_key,
       MAX(customer_name)  AS customer_name,
       MAX(customer_id)    AS customer_id,
       COUNT(*)            AS invoice_count,
       COALESCE(SUM(total_inc_vat - amount_paid), 0) AS outstanding
     FROM customer_invoices
     WHERE company_id = $1
       AND invoice_date <= $2
       AND status NOT IN ('draft', 'void', 'cancelled')
       AND (total_inc_vat - amount_paid) > 0.005
     GROUP BY CASE WHEN customer_id IS NOT NULL THEN 'id:' || customer_id::text
                   ELSE 'name:' || lower(trim(customer_name)) END
     ORDER BY outstanding DESC`,
    [companyId, asAt]
  );
  const details = detailRes.rows.map(r => ({
    customerName: r.customer_name,
    customerId:   r.customer_id ? parseInt(r.customer_id) : null,
    invoiceCount: parseInt(r.invoice_count),
    outstanding:  Math.round(parseFloat(r.outstanding || 0) * 100) / 100,
  }));

  const difference   = Math.round((glBalance - subledgerBalance) * 100) / 100;
  const isReconciled = Math.abs(difference) < 0.01;

  return {
    controlAccountCode: '1100',
    controlAccountName: acct ? acct.name : 'Accounts Receivable (account not found)',
    glBalance,
    subledgerBalance,
    difference,
    isReconciled,
    customerCount: details.length,
    invoiceCount,
    warnings,
    details,
  };
}

// ─── AP helper: GL 2000 vs supplier_invoices sub-ledger ──────────────────────
async function buildAPReconciliation(companyId, asAt) {
  const warnings = [];

  // 1. Lookup control account 2000
  const acctRes = await db.query(
    `SELECT id, code, name FROM accounts WHERE company_id = $1 AND code = '2000' LIMIT 1`,
    [companyId]
  );
  const acct = acctRes.rows[0] || null;
  if (!acct) {
    warnings.push('AP control account (code 2000) not found in Chart of Accounts. GL balance cannot be calculated.');
  }

  // 2. GL balance: credit − debit (positive = payable, liability normal balance)
  let glBalance = 0;
  if (acct) {
    const glRes = await db.query(
      `SELECT COALESCE(SUM(jl.debit), 0) AS d, COALESCE(SUM(jl.credit), 0) AS c
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date <= $2
         AND jl.account_id = $3`,
      [companyId, asAt, acct.id]
    );
    const d = parseFloat(glRes.rows[0].d);
    const c = parseFloat(glRes.rows[0].c);
    glBalance = Math.round((c - d) * 100) / 100; // SIGN FLIP for liability account

    // Warning: manual journals posting directly to 2000 (bypass sub-ledger)
    const manualRes = await db.query(
      `SELECT COUNT(DISTINCT j.id) AS cnt
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date <= $2
         AND jl.account_id = $3
         AND (j.source_type = 'manual' OR j.source_type IS NULL)`,
      [companyId, asAt, acct.id]
    );
    const manualCount = parseInt(manualRes.rows[0].cnt || 0);
    if (manualCount > 0) {
      warnings.push(
        `${manualCount} manual journal(s) post directly to AP control account 2000 and are not linked to supplier invoices or payments. ` +
        `These may cause a GL vs sub-ledger difference.`
      );
    }
  }

  // 3. Sub-ledger: outstanding supplier invoices as at asAt
  const slRes = await db.query(
    `SELECT COALESCE(SUM(total_inc_vat - amount_paid), 0) AS subledger_balance, COUNT(*) AS invoice_count
     FROM supplier_invoices
     WHERE company_id = $1
       AND invoice_date <= $2
       AND status NOT IN ('draft', 'cancelled')
       AND (total_inc_vat - amount_paid) > 0.005`,
    [companyId, asAt]
  );
  const subledgerBalance = Math.round(parseFloat(slRes.rows[0].subledger_balance || 0) * 100) / 100;
  const invoiceCount     = parseInt(slRes.rows[0].invoice_count || 0);

  // 4. Warning: invoices posted (unpaid/part_paid) but journal_id missing
  const orphanInvRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM supplier_invoices
     WHERE company_id = $1 AND status IN ('unpaid', 'part_paid') AND journal_id IS NULL`,
    [companyId]
  );
  const orphanInvCount = parseInt(orphanInvRes.rows[0].cnt || 0);
  if (orphanInvCount > 0) {
    warnings.push(
      `${orphanInvCount} supplier invoice(s) with status 'unpaid' or 'part_paid' have no linked GL journal. ` +
      `These appear in the sub-ledger but NOT in the GL.`
    );
  }

  // 5. Warning: supplier payments with no GL journal
  const orphanPayRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM supplier_payments WHERE company_id = $1 AND journal_id IS NULL`,
    [companyId]
  );
  const orphanPayCount = parseInt(orphanPayRes.rows[0].cnt || 0);
  if (orphanPayCount > 0) {
    warnings.push(
      `${orphanPayCount} supplier payment(s) have no linked GL journal. ` +
      `These reduce the sub-ledger but NOT the GL.`
    );
  }

  // 6. Detail breakdown by supplier
  const detailRes = await db.query(
    `SELECT
       si.supplier_id,
       MAX(s.name)  AS supplier_name,
       COUNT(*)     AS invoice_count,
       COALESCE(SUM(si.total_inc_vat - si.amount_paid), 0) AS outstanding
     FROM supplier_invoices si
     LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
     WHERE si.company_id = $1
       AND si.invoice_date <= $2
       AND si.status NOT IN ('draft', 'cancelled')
       AND (si.total_inc_vat - si.amount_paid) > 0.005
     GROUP BY si.supplier_id
     ORDER BY outstanding DESC`,
    [companyId, asAt]
  );
  const details = detailRes.rows.map(r => ({
    supplierName: r.supplier_name || 'Unknown Supplier',
    supplierId:   r.supplier_id ? parseInt(r.supplier_id) : null,
    invoiceCount: parseInt(r.invoice_count),
    outstanding:  Math.round(parseFloat(r.outstanding || 0) * 100) / 100,
  }));

  const difference   = Math.round((glBalance - subledgerBalance) * 100) / 100;
  const isReconciled = Math.abs(difference) < 0.01;

  return {
    controlAccountCode: '2000',
    controlAccountName: acct ? acct.name : 'Accounts Payable (account not found)',
    glBalance,
    subledgerBalance,
    difference,
    isReconciled,
    supplierCount: details.length,
    invoiceCount,
    warnings,
    details,
  };
}

module.exports = router;
