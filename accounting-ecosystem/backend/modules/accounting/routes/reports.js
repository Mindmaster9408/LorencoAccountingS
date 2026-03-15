const express = require('express');
const db = require('../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/reports/trial-balance
 * Generate trial balance for a period
 */
router.get('/trial-balance', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate are required' });
    }

    // Get all accounts with their balances
    const result = await db.query(
      `SELECT 
         a.id,
         a.code,
         a.name,
         a.type,
         COALESCE(SUM(jl.debit), 0) as total_debit,
         COALESCE(SUM(jl.credit), 0) as total_credit,
         COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
       FROM accounts a
       LEFT JOIN journal_lines jl ON a.id = jl.account_id
       LEFT JOIN journals j ON jl.journal_id = j.id
       WHERE a.company_id = $1
         AND a.is_active = true
         AND (j.id IS NULL OR (j.status = 'posted' AND j.date BETWEEN $2 AND $3))
       GROUP BY a.id, a.code, a.name, a.type
       ORDER BY a.code`,
      [req.user.companyId, fromDate, toDate]
    );

    const accounts = result.rows.map(row => ({
      ...row,
      total_debit: parseFloat(row.total_debit),
      total_credit: parseFloat(row.total_credit),
      balance: parseFloat(row.balance)
    }));

    // Calculate totals by type
    const summary = {
      asset: { debit: 0, credit: 0, balance: 0 },
      liability: { debit: 0, credit: 0, balance: 0 },
      equity: { debit: 0, credit: 0, balance: 0 },
      income: { debit: 0, credit: 0, balance: 0 },
      expense: { debit: 0, credit: 0, balance: 0 },
      total: { debit: 0, credit: 0, balance: 0 }
    };

    accounts.forEach(account => {
      const type = account.type;
      summary[type].debit += account.total_debit;
      summary[type].credit += account.total_credit;
      summary[type].balance += account.balance;
      summary.total.debit += account.total_debit;
      summary.total.credit += account.total_credit;
      summary.total.balance += account.balance;
    });

    res.json({
      fromDate,
      toDate,
      accounts,
      summary,
      isBalanced: Math.abs(summary.total.debit - summary.total.credit) < 0.01
    });

  } catch (error) {
    console.error('Error generating trial balance:', error);
    res.status(500).json({ error: 'Failed to generate trial balance' });
  }
});

/**
 * GET /api/reports/general-ledger
 * Generate general ledger for an account
 */
router.get('/general-ledger', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { accountId, fromDate, toDate } = req.query;

    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required' });
    }

    // Get account details
    const accountResult = await db.query(
      'SELECT * FROM accounts WHERE id = $1 AND company_id = $2',
      [accountId, req.user.companyId]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = accountResult.rows[0];

    // Get opening balance (if fromDate is provided)
    let openingBalance = 0;
    if (fromDate) {
      const openingResult = await db.query(
        `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as opening_balance
         FROM journal_lines jl
         JOIN journals j ON jl.journal_id = j.id
         WHERE jl.account_id = $1
           AND j.company_id = $2
           AND j.status = 'posted'
           AND j.date < $3`,
        [accountId, req.user.companyId, fromDate]
      );
      openingBalance = parseFloat(openingResult.rows[0].opening_balance);
    }

    // Get transactions
    let query = `
      SELECT 
        j.id as journal_id,
        j.date,
        j.reference,
        j.description as journal_description,
        jl.description as line_description,
        jl.debit,
        jl.credit,
        j.source_type
      FROM journal_lines jl
      JOIN journals j ON jl.journal_id = j.id
      WHERE jl.account_id = $1
        AND j.company_id = $2
        AND j.status = 'posted'
    `;
    const params = [accountId, req.user.companyId];
    let paramCount = 3;

    if (fromDate) {
      query += ` AND j.date >= $${paramCount}`;
      params.push(fromDate);
      paramCount++;
    }

    if (toDate) {
      query += ` AND j.date <= $${paramCount}`;
      params.push(toDate);
      paramCount++;
    }

    query += ' ORDER BY j.date, j.id';

    const transactionsResult = await db.query(query, params);

    // Calculate running balance
    let runningBalance = openingBalance;
    const transactions = transactionsResult.rows.map(txn => {
      const debit = parseFloat(txn.debit);
      const credit = parseFloat(txn.credit);
      runningBalance += (debit - credit);
      
      return {
        ...txn,
        debit,
        credit,
        balance: runningBalance
      };
    });

    // Calculate totals
    const totalDebit = transactions.reduce((sum, txn) => sum + txn.debit, 0);
    const totalCredit = transactions.reduce((sum, txn) => sum + txn.credit, 0);
    const closingBalance = openingBalance + totalDebit - totalCredit;

    res.json({
      account,
      fromDate: fromDate || null,
      toDate: toDate || null,
      openingBalance,
      transactions,
      totalDebit,
      totalCredit,
      closingBalance
    });

  } catch (error) {
    console.error('Error generating general ledger:', error);
    res.status(500).json({ error: 'Failed to generate general ledger' });
  }
});

/**
 * GET /api/reports/bank-reconciliation
 * Generate bank reconciliation report
 */
router.get('/bank-reconciliation', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { bankAccountId, date } = req.query;

    if (!bankAccountId || !date) {
      return res.status(400).json({ error: 'bankAccountId and date are required' });
    }

    // Get bank account
    const bankAccountResult = await db.query(
      `SELECT ba.*, a.code as ledger_code, a.name as ledger_name
       FROM bank_accounts ba
       LEFT JOIN accounts a ON ba.ledger_account_id = a.id
       WHERE ba.id = $1 AND ba.company_id = $2`,
      [bankAccountId, req.user.companyId]
    );

    if (bankAccountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    const bankAccount = bankAccountResult.rows[0];

    // Get bank statement balance
    const statementResult = await db.query(
      `SELECT balance
       FROM bank_transactions
       WHERE bank_account_id = $1 AND date <= $2
       ORDER BY date DESC, id DESC
       LIMIT 1`,
      [bankAccountId, date]
    );

    const statementBalance = statementResult.rows.length > 0 
      ? parseFloat(statementResult.rows[0].balance) 
      : bankAccount.opening_balance;

    // Get ledger balance
    const ledgerResult = await db.query(
      `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as ledger_balance
       FROM journal_lines jl
       JOIN journals j ON jl.journal_id = j.id
       WHERE jl.account_id = $1
         AND j.company_id = $2
         AND j.status = 'posted'
         AND j.date <= $3`,
      [bankAccount.ledger_account_id, req.user.companyId, date]
    );

    const ledgerBalance = bankAccount.opening_balance + parseFloat(ledgerResult.rows[0].ledger_balance);

    // Get unreconciled transactions
    const unreconciledResult = await db.query(
      `SELECT *
       FROM bank_transactions
       WHERE bank_account_id = $1
         AND date <= $2
         AND status IN ('unmatched', 'matched')
       ORDER BY date, id`,
      [bankAccountId, date]
    );

    const unreconciledTransactions = unreconciledResult.rows.map(txn => ({
      ...txn,
      amount: parseFloat(txn.amount)
    }));

    // Calculate reconciliation
    const unreconciledTotal = unreconciledTransactions.reduce((sum, txn) => sum + txn.amount, 0);
    const reconciledBalance = statementBalance - unreconciledTotal;
    const difference = ledgerBalance - reconciledBalance;

    res.json({
      bankAccount,
      date,
      statementBalance,
      ledgerBalance,
      unreconciledTransactions,
      unreconciledTotal,
      reconciledBalance,
      difference,
      isReconciled: Math.abs(difference) < 0.01
    });

  } catch (error) {
    console.error('Error generating bank reconciliation:', error);
    res.status(500).json({ error: 'Failed to generate bank reconciliation' });
  }
});

/**
 * GET /api/reports/balance-sheet
 * Balance sheet as of a given date.
 * Includes net income from income/expense accounts as "Current Year Earnings" within equity.
 *
 * Query params:
 *   asOfDate  (required)  YYYY-MM-DD — balance sheet date
 *   fromDate  (optional)  YYYY-MM-DD — start of current year for net income calculation.
 *                         If omitted, net income is calculated from all time.
 */
router.get('/balance-sheet', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { asOfDate, fromDate } = req.query;

    if (!asOfDate) {
      return res.status(400).json({ error: 'asOfDate is required' });
    }

    const companyId = req.user.companyId;

    // ── Balance sheet accounts (asset / liability / equity) ─────────────────
    const bsResult = await db.query(
      `SELECT
         a.id, a.code, a.name, a.type, a.parent_id,
         COALESCE(SUM(jl.debit), 0)  AS total_debit,
         COALESCE(SUM(jl.credit), 0) AS total_credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON a.id = jl.account_id
       LEFT JOIN journals j ON jl.journal_id = j.id
       WHERE a.company_id = $1
         AND a.is_active = true
         AND a.type IN ('asset', 'liability', 'equity')
         AND (j.id IS NULL OR (j.status = 'posted' AND j.date <= $2))
       GROUP BY a.id, a.code, a.name, a.type, a.parent_id
       ORDER BY a.type, a.code`,
      [companyId, asOfDate]
    );

    // ── Net income from P&L accounts (becomes Current Year Earnings) ─────────
    const plParams = [companyId, asOfDate];
    let plDateClause = 'j.date <= $2';
    if (fromDate) {
      plDateClause = 'j.date BETWEEN $3 AND $2';
      plParams.push(fromDate);
    }

    const plResult = await db.query(
      `SELECT
         a.type,
         COALESCE(SUM(jl.debit), 0)  AS total_debit,
         COALESCE(SUM(jl.credit), 0) AS total_credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON a.id = jl.account_id
       LEFT JOIN journals j ON jl.journal_id = j.id
       WHERE a.company_id = $1
         AND a.is_active = true
         AND a.type IN ('income', 'expense')
         AND (j.id IS NULL OR (j.status = 'posted' AND ${plDateClause}))
       GROUP BY a.type`,
      plParams
    );

    // Net income: income credits - income debits - expense debits + expense credits
    let totalIncome = 0;
    let totalExpense = 0;
    for (const row of plResult.rows) {
      if (row.type === 'income') {
        totalIncome = parseFloat(row.total_credit) - parseFloat(row.total_debit);
      } else if (row.type === 'expense') {
        totalExpense = parseFloat(row.total_debit) - parseFloat(row.total_credit);
      }
    }
    const netIncome = totalIncome - totalExpense;

    // ── Build grouped output ─────────────────────────────────────────────────
    const assets = [];
    const liabilities = [];
    const equity = [];

    for (const row of bsResult.rows) {
      const debit  = parseFloat(row.total_debit);
      const credit = parseFloat(row.total_credit);
      const entry = {
        id: row.id, code: row.code, name: row.name,
        type: row.type, parent_id: row.parent_id,
        total_debit: debit, total_credit: credit,
        balance: row.type === 'asset' ? (debit - credit) : (credit - debit)
      };
      if (row.type === 'asset')     assets.push(entry);
      else if (row.type === 'liability') liabilities.push(entry);
      else                          equity.push(entry);
    }

    const totalAssets      = assets.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
    const totalEquity      = equity.reduce((s, a) => s + a.balance, 0) + netIncome;

    res.json({
      asOfDate,
      fromDate: fromDate || null,
      assets,
      liabilities,
      equity,
      currentYearEarnings: netIncome,
      totals: {
        assets:      totalAssets,
        liabilities: totalLiabilities,
        equity:      totalEquity,
        liabilitiesAndEquity: totalLiabilities + totalEquity
      },
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
    });

  } catch (error) {
    console.error('Error generating balance sheet:', error);
    res.status(500).json({ error: 'Failed to generate balance sheet' });
  }
});

/**
 * GET /api/reports/profit-loss
 * Income statement (P&L) for a period.
 * Returns accounts grouped by sub_type for proper SA P&L structure:
 *   Revenue (operating_income)
 *   Less: Cost of Sales (cost_of_sales)       → Gross Profit
 *   Add:  Other Income (other_income)
 *   Less: Operating Expenses (operating_expense, depreciation_amort)
 *                                             → Operating Profit
 *   Less: Finance Costs (finance_cost)        → Net Profit Before Tax
 *
 * Accounts without a sub_type fall back to: income→operating_income, expense→operating_expense
 *
 * Query params:
 *   fromDate  (required)  YYYY-MM-DD
 *   toDate    (required)  YYYY-MM-DD
 */
router.get('/profit-loss', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { fromDate, toDate, segmentValueId } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate are required' });
    }

    const companyId = req.user.companyId;

    let result;
    if (segmentValueId) {
      // Segment-filtered P&L: only journal lines tagged with this segment_value_id
      result = await db.query(
        `SELECT
           a.id, a.code, a.name, a.type, a.sub_type, a.reporting_group, a.parent_id,
           COALESCE(SUM(jl.debit), 0)  AS total_debit,
           COALESCE(SUM(jl.credit), 0) AS total_credit
         FROM accounts a
         INNER JOIN journal_lines jl ON a.id = jl.account_id
                                     AND jl.segment_value_id = $4
         INNER JOIN journals j ON jl.journal_id = j.id
         WHERE a.company_id = $1
           AND a.is_active = true
           AND a.type IN ('income', 'expense')
           AND j.status = 'posted'
           AND j.date BETWEEN $2 AND $3
         GROUP BY a.id, a.code, a.name, a.type, a.sub_type, a.reporting_group, a.parent_id
         ORDER BY a.sort_order, a.code`,
        [companyId, fromDate, toDate, segmentValueId]
      );
    } else {
      result = await db.query(
        `SELECT
           a.id, a.code, a.name, a.type, a.sub_type, a.reporting_group, a.parent_id,
           COALESCE(SUM(jl.debit), 0)  AS total_debit,
           COALESCE(SUM(jl.credit), 0) AS total_credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON a.id = jl.account_id
         LEFT JOIN journals j ON jl.journal_id = j.id
         WHERE a.company_id = $1
           AND a.is_active = true
           AND a.type IN ('income', 'expense')
           AND (j.id IS NULL OR (j.status = 'posted' AND j.date BETWEEN $2 AND $3))
         GROUP BY a.id, a.code, a.name, a.type, a.sub_type, a.reporting_group, a.parent_id
         ORDER BY a.sort_order, a.code`,
        [companyId, fromDate, toDate]
      );
    }

    // Resolve effective sub_type (fall back if null)
    const sections = {
      operating_income:   [],
      other_income:       [],
      cost_of_sales:      [],
      operating_expense:  [],
      depreciation_amort: [],
      finance_cost:       [],
    };

    for (const row of result.rows) {
      const debit  = parseFloat(row.total_debit);
      const credit = parseFloat(row.total_credit);
      const effectiveSubType = row.sub_type ||
        (row.type === 'income' ? 'operating_income' : 'operating_expense');

      const entry = {
        id: row.id, code: row.code, name: row.name,
        type: row.type, sub_type: effectiveSubType,
        reporting_group: row.reporting_group, parent_id: row.parent_id,
        total_debit: debit, total_credit: credit,
        balance: row.type === 'income' ? (credit - debit) : (debit - credit),
      };

      if (sections[effectiveSubType]) {
        sections[effectiveSubType].push(entry);
      } else {
        // Unknown sub_type — fall back by type
        if (row.type === 'income') sections.operating_income.push(entry);
        else sections.operating_expense.push(entry);
      }
    }

    const sum = (arr) => arr.reduce((s, a) => s + a.balance, 0);

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
      fromDate,
      toDate,
      segmentValueId: segmentValueId || null,
      // Sections for structured rendering
      operatingIncome:   sections.operating_income,
      costOfSales:       sections.cost_of_sales,
      otherIncome:       sections.other_income,
      operatingExpenses: sections.operating_expense,
      depreciation:      sections.depreciation_amort,
      financeCosts:      sections.finance_cost,
      // Subtotals
      totals: {
        operatingIncome:   totalOperatingIncome,
        otherIncome:       totalOtherIncome,
        costOfSales:       totalCostOfSales,
        grossProfit,
        operatingExpenses: totalOperatingExpenses,
        depreciation:      totalDepreciation,
        operatingProfit,
        financeCosts:      totalFinanceCosts,
        netProfit,
      },
      isProfitable: netProfit >= 0,
      // Legacy flat arrays for backwards-compatibility with older frontend code
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
