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
 *
 * Query params:
 *   fromDate  (required)  YYYY-MM-DD
 *   toDate    (required)  YYYY-MM-DD
 */
router.get('/profit-loss', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate are required' });
    }

    const companyId = req.user.companyId;

    const result = await db.query(
      `SELECT
         a.id, a.code, a.name, a.type, a.parent_id,
         COALESCE(SUM(jl.debit), 0)  AS total_debit,
         COALESCE(SUM(jl.credit), 0) AS total_credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON a.id = jl.account_id
       LEFT JOIN journals j ON jl.journal_id = j.id
       WHERE a.company_id = $1
         AND a.is_active = true
         AND a.type IN ('income', 'expense')
         AND (j.id IS NULL OR (j.status = 'posted' AND j.date BETWEEN $2 AND $3))
       GROUP BY a.id, a.code, a.name, a.type, a.parent_id
       ORDER BY a.type, a.code`,
      [companyId, fromDate, toDate]
    );

    const incomeAccounts  = [];
    const expenseAccounts = [];

    for (const row of result.rows) {
      const debit  = parseFloat(row.total_debit);
      const credit = parseFloat(row.total_credit);
      const entry = {
        id: row.id, code: row.code, name: row.name,
        type: row.type, parent_id: row.parent_id,
        total_debit: debit, total_credit: credit,
        // income: credit is positive; expense: debit is positive
        balance: row.type === 'income' ? (credit - debit) : (debit - credit)
      };
      if (row.type === 'income')  incomeAccounts.push(entry);
      else                        expenseAccounts.push(entry);
    }

    const totalIncome  = incomeAccounts.reduce((s, a) => s + a.balance, 0);
    const totalExpense = expenseAccounts.reduce((s, a) => s + a.balance, 0);
    const netProfit    = totalIncome - totalExpense;

    res.json({
      fromDate,
      toDate,
      income:  incomeAccounts,
      expense: expenseAccounts,
      totals: {
        income:    totalIncome,
        expense:   totalExpense,
        netProfit
      },
      isProfitable: netProfit >= 0
    });

  } catch (error) {
    console.error('Error generating profit & loss:', error);
    res.status(500).json({ error: 'Failed to generate profit & loss report' });
  }
});

module.exports = router;
