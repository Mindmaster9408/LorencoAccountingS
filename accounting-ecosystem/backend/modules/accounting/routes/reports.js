const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

const router = express.Router();

// ─── Helper: fetch posted journal lines for a company within a date range ────
// Returns array of { account_id, debit, credit } aggregated per account.
async function fetchAccountBalances(companyId, { fromDate, toDate, asOfDate, types, segmentValueId } = {}) {
  // Fetch accounts
  let acctQ = supabase.from('accounts').select('id, code, name, type, sub_type, reporting_group, parent_id, sort_order')
    .eq('company_id', companyId).eq('is_active', true);
  if (types) acctQ = acctQ.in('type', types);
  const { data: accounts, error: acctErr } = await acctQ;
  if (acctErr) throw new Error(acctErr.message);

  // Fetch posted journals for the company within range
  let jQ = supabase.from('journals').select('id, date').eq('company_id', companyId).eq('status', 'posted');
  if (asOfDate)  jQ = jQ.lte('date', asOfDate);
  if (fromDate)  jQ = jQ.gte('date', fromDate);
  if (toDate)    jQ = jQ.lte('date', toDate);
  const { data: journals, error: jErr } = await jQ;
  if (jErr) throw new Error(jErr.message);

  const journalCount = journals ? journals.length : 0;

  if (!journals || journals.length === 0) {
    return { accounts: accounts || [], lines: [], journalCount: 0 };
  }

  const journalIds = journals.map(j => j.id);

  // Fetch journal lines for those journals (batch — Supabase supports .in() up to 1000)
  let lQ = supabase.from('journal_lines').select('account_id, debit, credit').in('journal_id', journalIds);
  if (segmentValueId) lQ = lQ.eq('segment_value_id', segmentValueId);
  const { data: lines, error: lErr } = await lQ;
  if (lErr) throw new Error(lErr.message);

  return { accounts: accounts || [], lines: lines || [], journalCount };
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
    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate are required' });
    }

    const { accounts, lines, journalCount } = await fetchAccountBalances(req.user.companyId, { fromDate, toDate });
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
      isBalanced: Math.abs(summary.total.debit - summary.total.credit) < 0.01
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
    const { accountId, fromDate, toDate } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const { data: account, error: aErr } = await supabase
      .from('accounts').select('*')
      .eq('id', accountId).eq('company_id', req.user.companyId).single();
    if (aErr || !account) return res.status(404).json({ error: 'Account not found' });

    // Opening balance: all posted lines before fromDate
    let openingBalance = 0;
    if (fromDate) {
      const { data: priorJournals } = await supabase
        .from('journals').select('id')
        .eq('company_id', req.user.companyId).eq('status', 'posted').lt('date', fromDate);
      if (priorJournals && priorJournals.length > 0) {
        const { data: priorLines } = await supabase
          .from('journal_lines').select('debit, credit')
          .eq('account_id', accountId)
          .in('journal_id', priorJournals.map(j => j.id));
        for (const l of priorLines || []) {
          openingBalance += parseFloat(l.debit || 0) - parseFloat(l.credit || 0);
        }
      }
    }

    // Period journals
    let jQ = supabase.from('journals')
      .select('id, date, reference, description, source_type')
      .eq('company_id', req.user.companyId).eq('status', 'posted');
    if (fromDate) jQ = jQ.gte('date', fromDate);
    if (toDate)   jQ = jQ.lte('date', toDate);
    const { data: journals } = await jQ;

    const transactions = [];
    if (journals && journals.length > 0) {
      const { data: lines } = await supabase
        .from('journal_lines').select('journal_id, description, debit, credit')
        .eq('account_id', accountId)
        .in('journal_id', journals.map(j => j.id));

      const journalMap = {};
      for (const j of journals) journalMap[j.id] = j;

      let running = openingBalance;
      const withMeta = (lines || []).map(l => {
        const j = journalMap[l.journal_id] || {};
        const d = parseFloat(l.debit || 0);
        const c = parseFloat(l.credit || 0);
        running += d - c;
        return { journal_id: l.journal_id, date: j.date, reference: j.reference,
                 journal_description: j.description, line_description: l.description,
                 source_type: j.source_type, debit: d, credit: c, balance: running };
      });
      withMeta.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.journal_id - b.journal_id);
      transactions.push(...withMeta);
    }

    const totalDebit   = transactions.reduce((s, t) => s + t.debit,  0);
    const totalCredit  = transactions.reduce((s, t) => s + t.credit, 0);
    const closingBalance = openingBalance + totalDebit - totalCredit;

    res.json({ account, fromDate: fromDate || null, toDate: toDate || null,
               openingBalance, transactions, totalDebit, totalCredit, closingBalance });

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
      .eq('bank_account_id', bankAccountId).lte('date', date)
      .order('date', { ascending: false }).order('id', { ascending: false }).limit(1);
    const statementBalance = lastTxn && lastTxn.length > 0 && lastTxn[0].balance != null
      ? parseFloat(lastTxn[0].balance)
      : parseFloat(bankAccount.opening_balance || 0);

    // Ledger balance from posted journals
    let ledgerBalance = parseFloat(bankAccount.opening_balance || 0);
    if (bankAccount.ledger_account_id) {
      const { data: jnls } = await supabase.from('journals').select('id')
        .eq('company_id', req.user.companyId).eq('status', 'posted').lte('date', date);
      if (jnls && jnls.length > 0) {
        const { data: lns } = await supabase.from('journal_lines').select('debit, credit')
          .eq('account_id', bankAccount.ledger_account_id)
          .in('journal_id', jnls.map(j => j.id));
        for (const l of lns || []) {
          ledgerBalance += parseFloat(l.debit || 0) - parseFloat(l.credit || 0);
        }
      }
    }

    // Unreconciled transactions
    const { data: unrecon } = await supabase.from('bank_transactions').select('*')
      .eq('bank_account_id', bankAccountId).lte('date', date)
      .in('status', ['unmatched', 'matched'])
      .order('date').order('id');

    const unreconciledTransactions = (unrecon || []).map(t => ({ ...t, amount: parseFloat(t.amount) }));
    const unreconciledTotal   = unreconciledTransactions.reduce((s, t) => s + t.amount, 0);
    const reconciledBalance   = statementBalance - unreconciledTotal;
    const difference          = ledgerBalance - reconciledBalance;

    res.json({ bankAccount, date, statementBalance, ledgerBalance,
               unreconciledTransactions, unreconciledTotal, reconciledBalance,
               difference, isReconciled: Math.abs(difference) < 0.01 });

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
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
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
    const { fromDate, toDate, segmentValueId } = req.query;
    if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate are required' });

    const companyId = req.user.companyId;
    const { accounts, lines } = await fetchAccountBalances(companyId, {
      fromDate, toDate, types: ['income', 'expense'],
      segmentValueId: segmentValueId || null
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
    });

  } catch (error) {
    console.error('Error generating profit & loss:', error);
    res.status(500).json({ error: 'Failed to generate profit & loss report' });
  }
});

module.exports = router;
