/**
 * ============================================================================
 * Year-End Close & Opening Balances — Route Handler
 * ============================================================================
 * Prefix: /api/accounting/year-end  (mounted in index.js)
 *
 * Routes:
 *   GET  /records            — list all year-end close records for the company
 *   POST /close              — execute year-end close (creates closing journal)
 *   POST /opening-balances   — create and post an opening balance journal
 *
 * Year-End Close logic:
 *   1. Guard: no duplicate close for same (company, fromDate, toDate) — 409
 *   2. Find retained earnings account (equity, sub_type='retained_earnings') — 422 if missing
 *   3. Fetch all posted P&L (income/expense) journal lines in the year range
 *   4. Build closing journal:
 *        income accounts  → DEBIT  each by its net credit balance (zeros income)
 *        expense accounts → CREDIT each by its net debit balance  (zeros expenses)
 *        net to retained earnings: CREDIT if profit, DEBIT if loss
 *   5. Validate journal balances (safety check — math guarantees balance)
 *   6. Atomic pg transaction: INSERT journal header (posted) + lines + close record
 *   7. Optionally lock the matching accounting_period
 *
 * Opening Balances logic:
 *   - Validate debits = credits via JournalService
 *   - Guard period lock
 *   - createDraftJournal + postJournal (standard flow, source_type='opening_balance')
 *
 * Atomicity guarantee:
 *   The year-end close uses a direct pg client transaction — journal header,
 *   all lines, and year_end_close_records row are committed together or not at all.
 *   If the transaction fails nothing is written. No orphaned journals possible.
 *
 * The closing journal is posted directly (status='posted', posted_at=NOW())
 * without going through JournalService.postJournal — this is intentional.
 * Closing entries are internal accounting movements, not VAT-generating events.
 * Running them through postJournal would attempt (and fail) VAT assignment.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const db = require('../config/database'); // direct pg Pool — for atomic write
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

// ─── Permission helpers ───────────────────────────────────────────────────────

function requireAccountant(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const allowed = ['admin', 'accountant', 'business_owner', 'super_admin'];
  if (req.user.isSuperAdmin || allowed.includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Year-end close requires accountant or admin access' });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/year-end/records
 * List all year-end close records for the authenticated company.
 */
router.get('/records', authenticate, hasPermission('report.view'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('year_end_close_records')
      .select('*')
      .eq('company_id', req.user.companyId)
      .order('from_date', { ascending: false });

    if (error) throw new Error(error.message);

    res.json({ records: data || [] });
  } catch (err) {
    console.error('[year-end] GET /records error:', err.message);
    res.status(500).json({ error: 'Failed to fetch year-end close records' });
  }
});

/**
 * POST /api/accounting/year-end/close
 * Execute year-end close for a financial year period.
 *
 * Request body:
 *   fromDate           {string}  YYYY-MM-DD — start of financial year
 *   toDate             {string}  YYYY-MM-DD — end of financial year (closing journal date)
 *   financialYearLabel {string}  e.g. "2025" or "FY2025"
 *   lockPeriod         {boolean} if true, lock the accounting_period covering toDate (optional)
 */
router.post('/close', authenticate, requireAccountant, async (req, res) => {
  try {
    const { fromDate, toDate, financialYearLabel, lockPeriod = false } = req.body;
    const companyId = req.user.companyId;
    const userId    = req.user.id;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!fromDate || !toDate || !financialYearLabel) {
      return res.status(400).json({ error: 'fromDate, toDate, and financialYearLabel are required' });
    }
    if (fromDate > toDate) {
      return res.status(400).json({ error: 'fromDate must be before or equal to toDate' });
    }
    if (typeof financialYearLabel !== 'string' || financialYearLabel.trim().length === 0) {
      return res.status(400).json({ error: 'financialYearLabel must be a non-empty string' });
    }

    // ── 2. Idempotency — block duplicate close for same period ───────────────
    const { data: existingClose, error: existErr } = await supabase
      .from('year_end_close_records')
      .select('id, closing_journal_id, closed_at')
      .eq('company_id', companyId)
      .eq('from_date', fromDate)
      .eq('to_date', toDate)
      .maybeSingle();

    if (existErr) throw new Error(existErr.message);
    if (existingClose) {
      return res.status(409).json({
        error: 'Year-end close has already been completed for this period',
        existingRecord: existingClose
      });
    }

    // ── 3. Retained earnings account — required ──────────────────────────────
    const { data: reAccount, error: reErr } = await supabase
      .from('accounts')
      .select('id, code, name')
      .eq('company_id', companyId)
      .eq('type', 'equity')
      .eq('sub_type', 'retained_earnings')
      .eq('is_active', true)
      .maybeSingle();

    if (reErr) throw new Error(reErr.message);
    if (!reAccount) {
      return res.status(422).json({
        error: 'No retained earnings account found. ' +
               'Create an equity account with sub_type "retained_earnings" before running year-end close.'
      });
    }

    // ── 4. Period lock guard on closing date ─────────────────────────────────
    const isLocked = await JournalService.isPeriodLocked(companyId, toDate);
    if (isLocked) {
      return res.status(422).json({
        error: `The closing date ${toDate} falls within a locked accounting period. ` +
               'Unlock the period before running year-end close.'
      });
    }

    // ── 5. Fetch posted journals in the year range ───────────────────────────
    const { data: yearJournals, error: jErr } = await supabase
      .from('journals')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .gte('date', fromDate)
      .lte('date', toDate);

    if (jErr) throw new Error(jErr.message);
    if (!yearJournals || yearJournals.length === 0) {
      return res.status(422).json({
        error: 'No posted journals found in the specified date range. Nothing to close.'
      });
    }

    const journalIds = yearJournals.map(j => j.id);

    // Fetch active income and expense accounts for this company
    const { data: plAccounts, error: acctErr } = await supabase
      .from('accounts')
      .select('id, code, name, type')
      .eq('company_id', companyId)
      .in('type', ['income', 'expense'])
      .eq('is_active', true);

    if (acctErr) throw new Error(acctErr.message);
    if (!plAccounts || plAccounts.length === 0) {
      return res.status(422).json({ error: 'No income or expense accounts found.' });
    }

    const plAccountIds = plAccounts.map(a => a.id);

    // Fetch journal lines for P&L accounts within the year (batched — supabase .in() supports up to 1000)
    const { data: plLines, error: lErr } = await supabase
      .from('journal_lines')
      .select('account_id, debit, credit')
      .in('journal_id', journalIds)
      .in('account_id', plAccountIds);

    if (lErr) throw new Error(lErr.message);

    // ── 6. Aggregate balances per account ────────────────────────────────────
    const balMap = {};
    for (const l of plLines || []) {
      const id = l.account_id;
      if (!balMap[id]) balMap[id] = { debit: 0, credit: 0 };
      balMap[id].debit  += parseFloat(l.debit  || 0);
      balMap[id].credit += parseFloat(l.credit || 0);
    }

    // Build closing journal lines:
    //   Income accounts  (normal credit balance): close by DEBITING
    //   Expense accounts (normal debit  balance): close by CREDITING
    const plAccountMap = {};
    for (const a of plAccounts) plAccountMap[a.id] = a;

    const closingLines = [];
    let totalIncomeNet  = 0; // sum of income net credit balances
    let totalExpenseNet = 0; // sum of expense net debit balances

    for (const [idStr, bal] of Object.entries(balMap)) {
      const id      = parseInt(idStr, 10);
      const account = plAccountMap[id];
      if (!account) continue;

      const netCredit = bal.credit - bal.debit; // positive = net credit (normal for income)
      const netDebit  = bal.debit  - bal.credit; // positive = net debit  (normal for expense)

      if (account.type === 'income') {
        // Skip zero-balance accounts
        if (Math.abs(netCredit) <= 0.004) continue;
        // Close income: debit the income account (or credit if unusual negative income)
        closingLines.push({
          accountId:   id,
          description: `Year-end close: ${account.name}`,
          debit:  netCredit > 0 ? parseFloat(netCredit.toFixed(2))   : 0,
          credit: netCredit < 0 ? parseFloat((-netCredit).toFixed(2)) : 0,
        });
        totalIncomeNet += netCredit;

      } else if (account.type === 'expense') {
        // Skip zero-balance accounts
        if (Math.abs(netDebit) <= 0.004) continue;
        // Close expense: credit the expense account (or debit if unusual negative expense)
        closingLines.push({
          accountId:   id,
          description: `Year-end close: ${account.name}`,
          debit:  netDebit < 0 ? parseFloat((-netDebit).toFixed(2)) : 0,
          credit: netDebit > 0 ? parseFloat(netDebit.toFixed(2))    : 0,
        });
        totalExpenseNet += netDebit;
      }
    }

    if (closingLines.length === 0) {
      return res.status(422).json({
        error: 'All income and expense accounts have zero balance — nothing to close.'
      });
    }

    // ── 7. Net to retained earnings ──────────────────────────────────────────
    // netIncome > 0 = profit  → CREDIT retained earnings (equity increases)
    // netIncome < 0 = loss    → DEBIT  retained earnings (equity decreases)
    // netIncome = 0           → no RE line needed (journal already balances)
    const netIncome = parseFloat((totalIncomeNet - totalExpenseNet).toFixed(2));

    if (Math.abs(netIncome) > 0.004) {
      closingLines.push({
        accountId:   reAccount.id,
        description: netIncome > 0
          ? 'Year-end close: net profit transferred to retained earnings'
          : 'Year-end close: net loss deducted from retained earnings',
        debit:  netIncome < 0 ? parseFloat((-netIncome).toFixed(2)) : 0,
        credit: netIncome > 0 ? parseFloat(netIncome.toFixed(2))    : 0,
      });
    }

    // ── Safety check: journal must balance before we attempt any DB write ────
    const totalD = closingLines.reduce((s, l) => s + (l.debit  || 0), 0);
    const totalC = closingLines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(totalD - totalC) > 0.01) {
      console.error('[year-end] Balance check failed — totalD:', totalD, 'totalC:', totalC);
      return res.status(500).json({
        error: 'Internal error: computed closing journal is out of balance. Please contact support.',
        debug: { totalDebit: totalD, totalCredit: totalC, difference: Math.abs(totalD - totalC) }
      });
    }

    // ── 8. Atomic write ───────────────────────────────────────────────────────
    // Journal header (posted directly) + all lines + close record — one transaction.
    // The closing journal bypasses JournalService.postJournal intentionally:
    // year-end closing entries are not VAT-generating transactions.
    const client = await db.getClient();
    let closingJournalId;
    try {
      await client.query('BEGIN');

      // Insert journal header with status='posted' directly
      const jRes = await client.query(
        `INSERT INTO journals
           (company_id, date, reference, description, status, source_type,
            created_by_user_id, posted_at, posted_by_user_id, metadata)
         VALUES ($1, $2, $3, $4, 'posted', 'year_end_close', $5, NOW(), $5, $6::jsonb)
         RETURNING id`,
        [
          companyId,
          toDate,
          `YEC-${financialYearLabel}`,
          `Year-end closing entry — ${financialYearLabel} (${fromDate} to ${toDate})`,
          userId,
          JSON.stringify({
            financial_year_label: financialYearLabel,
            from_date:  fromDate,
            to_date:    toDate,
            net_income: netIncome
          })
        ]
      );
      closingJournalId = jRes.rows[0].id;

      // Insert all closing journal lines
      for (let i = 0; i < closingLines.length; i++) {
        const line = closingLines[i];
        await client.query(
          `INSERT INTO journal_lines
             (journal_id, account_id, line_number, description, debit, credit)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            closingJournalId,
            line.accountId,
            i + 1,
            line.description,
            line.debit  || 0,
            line.credit || 0,
          ]
        );
      }

      // Insert the year_end_close_records row (unique constraint guards idempotency)
      await client.query(
        `INSERT INTO year_end_close_records
           (company_id, financial_year_label, from_date, to_date,
            closing_journal_id, closed_by_user_id, net_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [companyId, financialYearLabel, fromDate, toDate, closingJournalId, userId, netIncome]
      );

      await client.query('COMMIT');

    } catch (txErr) {
      await client.query('ROLLBACK');
      throw new Error(`Year-end close transaction rolled back: ${txErr.message}`);
    } finally {
      client.release();
    }

    // ── 9. Optionally lock the accounting period ─────────────────────────────
    // This step runs AFTER the main transaction. A lock failure does NOT undo the
    // year-end close — the close record and journal are permanent. The user can
    // lock the period manually via POST /api/accounting/periods/:id/lock if needed.
    let periodLockResult = null;
    if (lockPeriod) {
      const { data: period, error: pErr } = await supabase
        .from('accounting_periods')
        .select('id, is_locked, from_date, to_date')
        .eq('company_id', companyId)
        .lte('from_date', toDate)
        .gte('to_date', fromDate)
        .limit(1)
        .maybeSingle();

      if (pErr) {
        periodLockResult = { success: false, message: 'Failed to query accounting period: ' + pErr.message };
      } else if (!period) {
        periodLockResult = { success: false, message: 'No accounting period found covering this date range. Lock it manually if needed.' };
      } else if (period.is_locked) {
        periodLockResult = { success: true, message: 'Period was already locked', periodId: period.id };
      } else {
        const { error: lockErr } = await supabase
          .from('accounting_periods')
          .update({ is_locked: true, locked_by_user_id: userId })
          .eq('id', period.id)
          .eq('company_id', companyId);

        periodLockResult = lockErr
          ? { success: false, message: 'Close succeeded but period lock failed: ' + lockErr.message }
          : { success: true, message: 'Period locked successfully', periodId: period.id };
      }
    }

    // ── 10. Audit log ────────────────────────────────────────────────────────
    await AuditLogger.logUserAction(
      req,
      'YEAR_END_CLOSE',
      'JOURNAL',
      closingJournalId,
      null,
      {
        financialYearLabel,
        fromDate,
        toDate,
        netIncome,
        closingJournalId,
        lineCount:    closingLines.length,
        periodLocked: lockPeriod && periodLockResult?.success === true,
      },
      `Year-end close completed for ${financialYearLabel}`
    );

    res.status(201).json({
      message:              'Year-end close completed successfully',
      financialYearLabel,
      fromDate,
      toDate,
      closingJournalId,
      netIncome,
      lineCount:            closingLines.length,
      retainedEarningsAccount: { id: reAccount.id, code: reAccount.code, name: reAccount.name },
      periodLock:           lockPeriod ? periodLockResult : undefined,
    });

  } catch (error) {
    console.error('[year-end] POST /close error:', error.message);
    res.status(500).json({ error: 'Year-end close failed: ' + error.message });
  }
});

/**
 * POST /api/accounting/year-end/opening-balances
 * Create and post an opening balance journal.
 *
 * This uses the standard JournalService flow (createDraftJournal + postJournal)
 * with source_type='opening_balance'. The journal must balance (sum debit = sum credit).
 *
 * Request body:
 *   date        {string} YYYY-MM-DD — date for the opening balance entry
 *   reference   {string} optional   — e.g. "OB-2026"
 *   description {string}            — description for the journal
 *   lines       {array}             — [{ accountId, description, debit, credit }, ...]
 *                                     accountId is required on each line
 */
router.post('/opening-balances', authenticate, requireAccountant, async (req, res) => {
  try {
    const { date, reference, description, lines } = req.body;
    const companyId = req.user.companyId;
    const userId    = req.user.id;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!date || !description || !lines) {
      return res.status(400).json({ error: 'date, description, and lines are required' });
    }
    if (!Array.isArray(lines) || lines.length < 2) {
      return res.status(400).json({ error: 'At least two journal lines are required (double-entry)' });
    }

    // Line-level validation (checks accountId, non-negative, not both debit+credit)
    const lineValidation = JournalService.validateLines(lines);
    if (!lineValidation.valid) {
      return res.status(400).json({ error: lineValidation.message });
    }

    // Balance validation (sum debit must equal sum credit within 0.01)
    const balanceValidation = JournalService.validateBalance(lines);
    if (!balanceValidation.valid) {
      return res.status(400).json({ error: balanceValidation.message });
    }

    // ── 2. Period lock guard ─────────────────────────────────────────────────
    const isLocked = await JournalService.isPeriodLocked(companyId, date);
    if (isLocked) {
      return res.status(422).json({
        error: `The date ${date} falls within a locked accounting period. Unlock the period first.`
      });
    }

    // ── 3. Create draft journal then post it (standard VAT-safe flow) ────────
    const journal = await JournalService.createDraftJournal({
      companyId,
      date,
      reference:        reference || `OB-${date}`,
      description,
      sourceType:       'opening_balance',
      createdByUserId:  userId,
      lines,
      metadata: { source: 'opening_balance_entry' }
    });

    await JournalService.postJournal(journal.id, companyId, userId);

    // ── 4. Audit log ─────────────────────────────────────────────────────────
    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'JOURNAL',
      journal.id,
      null,
      {
        date,
        reference:  reference || `OB-${date}`,
        description,
        sourceType: 'opening_balance',
        lineCount:  lines.length
      },
      'Opening balance journal created and posted'
    );

    res.status(201).json({
      message:   'Opening balance journal created and posted successfully',
      journalId: journal.id,
      date,
      reference: reference || `OB-${date}`,
      lineCount: lines.length,
    });

  } catch (error) {
    console.error('[year-end] POST /opening-balances error:', error.message);
    res.status(500).json({ error: 'Failed to create opening balance journal: ' + error.message });
  }
});

module.exports = router;
