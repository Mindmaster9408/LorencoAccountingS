/**
 * ============================================================================
 * POS ↔ Accounting Bridge Routes
 * ============================================================================
 * Provides accounting-side read access to POS data (Checkout Charlie) and
 * handles cash/card daily reconciliation (settlement) between POS takings
 * and bank deposits.
 *
 * All routes are under /api/accounting/pos/
 *
 * POS tables (sales, customers) live in the same PostgreSQL database as
 * accounting tables — queried directly via the same pg Pool connection.
 * The pg Pool bypasses Supabase RLS; company_id scoping is enforced here.
 *
 * SA timezone: UTC+2 (no DST). Date grouping uses (created_at + 2h)::date.
 * ============================================================================
 */

const express = require('express');
const db = require('../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a DB date row to YYYY-MM-DD string */
function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  const dt = new Date(d);
  return dt.toISOString().substring(0, 10);
}

// ─── GET /api/accounting/pos/daily-totals ─────────────────────────────────────
/**
 * Aggregate POS sales by date, split cash vs card.
 * Joins with pos_reconciliations to show settlement status.
 *
 * Query params:
 *   fromDate  YYYY-MM-DD  (default: 30 days ago)
 *   toDate    YYYY-MM-DD  (default: today)
 *
 * Returns:
 *   { days: [{ date, cashSales, cardSales, accountSales, totalSales,
 *              transactionCount, cashSettled, cardSettled,
 *              cashPending, cardPending }] }
 */
router.get('/daily-totals', authenticate, hasPermission('pos.view'), async (req, res) => {
  try {
    const today = new Date().toISOString().substring(0, 10);
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
    const fromDate = req.query.fromDate || thirtyAgo;
    const toDate   = req.query.toDate   || today;

    // Aggregate POS sales by SA date (UTC+2)
    const salesResult = await db.query(
      `SELECT
         ((s.created_at + INTERVAL '2 hours')::date)::text                        AS date,
         COALESCE(SUM(CASE WHEN s.payment_method = 'cash'  THEN s.total_amount ELSE 0 END), 0) AS cash_sales,
         COALESCE(SUM(CASE WHEN s.payment_method = 'card'  THEN s.total_amount ELSE 0 END), 0) AS card_sales,
         COALESCE(SUM(CASE WHEN s.payment_method = 'account' THEN s.total_amount ELSE 0 END), 0) AS account_sales,
         COALESCE(SUM(s.total_amount), 0)     AS total_sales,
         COUNT(*)                             AS transaction_count
       FROM sales s
       WHERE s.company_id = $1
         AND s.status = 'completed'
         AND (s.created_at + INTERVAL '2 hours')::date >= $2::date
         AND (s.created_at + INTERVAL '2 hours')::date <= $3::date
       GROUP BY 1
       ORDER BY 1 DESC`,
      [req.user.companyId, fromDate, toDate]
    );

    // Get existing settlements for the same period
    const reconResult = await db.query(
      `SELECT date::text, payment_method, bank_amount, pos_amount
       FROM pos_reconciliations
       WHERE company_id = $1
         AND date >= $2::date
         AND date <= $3::date`,
      [req.user.companyId, fromDate, toDate]
    );

    // Build settlement map: { 'YYYY-MM-DD': { cash: amount, card: amount } }
    const settled = {};
    for (const r of reconResult.rows) {
      const d = toDateStr(r.date);
      if (!settled[d]) settled[d] = {};
      settled[d][r.payment_method] = parseFloat(r.bank_amount) || 0;
    }

    const days = salesResult.rows.map(row => {
      const date        = toDateStr(row.date);
      const cashSales   = parseFloat(row.cash_sales)   || 0;
      const cardSales   = parseFloat(row.card_sales)   || 0;
      const acctSales   = parseFloat(row.account_sales)|| 0;
      const totalSales  = parseFloat(row.total_sales)  || 0;
      const cashSettled = settled[date]?.cash  || 0;
      const cardSettled = settled[date]?.card  || 0;

      return {
        date,
        cashSales,
        cardSales,
        accountSales: acctSales,
        totalSales,
        transactionCount: parseInt(row.transaction_count) || 0,
        cashSettled,
        cardSettled,
        cashPending:  Math.max(0, cashSales - cashSettled),
        cardPending:  Math.max(0, cardSales - cardSettled),
      };
    });

    res.json({ days });
  } catch (err) {
    console.error('[pos-bridge] daily-totals error:', err);
    res.status(500).json({ error: 'Failed to load daily totals' });
  }
});

// ─── GET /api/accounting/pos/sales ────────────────────────────────────────────
/**
 * Individual POS sales for a specific date (for drill-down view).
 *
 * Query params:
 *   date          YYYY-MM-DD  (required)
 *   paymentMethod cash | card | account  (optional)
 *
 * Returns:
 *   { sales: [{ id, saleNumber, time, description, paymentMethod,
 *               totalAmount, customerName, status }] }
 */
router.get('/sales', authenticate, hasPermission('pos.view'), async (req, res) => {
  const { date, paymentMethod } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

  try {
    const params = [req.user.companyId, date];
    let methodClause = '';
    if (paymentMethod) {
      params.push(paymentMethod);
      methodClause = `AND s.payment_method = $${params.length}`;
    }

    const result = await db.query(
      `SELECT
         s.id,
         s.sale_number                                            AS sale_number,
         TO_CHAR(s.created_at + INTERVAL '2 hours', 'HH24:MI')  AS time,
         COALESCE(c.name, 'Walk-in Customer')                    AS customer_name,
         s.payment_method,
         s.total_amount,
         s.vat_amount,
         s.status,
         s.payment_status
       FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       WHERE s.company_id = $1
         AND (s.created_at + INTERVAL '2 hours')::date = $2::date
         AND s.status = 'completed'
         ${methodClause}
       ORDER BY s.created_at ASC`,
      params
    );

    const sales = result.rows.map(r => ({
      id:            r.id,
      saleNumber:    r.sale_number,
      time:          r.time,
      description:   `${r.sale_number} — ${r.customer_name}`,
      customerName:  r.customer_name,
      paymentMethod: r.payment_method,
      total:         parseFloat(r.total_amount) || 0,
      vatAmount:     parseFloat(r.vat_amount)   || 0,
      status:        r.status,
      paymentStatus: r.payment_status,
    }));

    res.json({ sales });
  } catch (err) {
    console.error('[pos-bridge] sales error:', err);
    res.status(500).json({ error: 'Failed to load sales' });
  }
});

// ─── POST /api/accounting/pos/reconciliation/settle ──────────────────────────
/**
 * Settle (reconcile) a day's cash or card takings against a bank deposit.
 * Records the reconciliation and optionally auto-creates + posts a journal.
 *
 * Body:
 *   date              YYYY-MM-DD  (required)
 *   paymentMethod     'cash' | 'card'  (required)
 *   bankAmount        number  (confirmed bank deposit/settlement amount)
 *   bankDescription   string  (e.g. "Cash deposit 22 Mar")
 *   notes             string  (optional)
 *   bankLedgerAccountId   integer  (optional — if provided, creates journal)
 *   clearingAccountId     integer  (optional — the account to credit/debit)
 *
 * Returns:
 *   { reconciliation, journal (if created), salesCount, posAmount, hasVariance, variance }
 */
router.post('/reconciliation/settle', authenticate, hasPermission('pos.reconcile'), async (req, res) => {
  const { date, paymentMethod, bankAmount, bankDescription, notes,
          bankLedgerAccountId, clearingAccountId } = req.body;

  if (!date)          return res.status(400).json({ error: 'date is required' });
  if (!paymentMethod) return res.status(400).json({ error: 'paymentMethod (cash|card) is required' });
  if (!['cash', 'card'].includes(paymentMethod))
    return res.status(400).json({ error: 'paymentMethod must be cash or card' });
  if (bankAmount == null) return res.status(400).json({ error: 'bankAmount is required' });

  const parsedBankAmount = parseFloat(bankAmount);
  if (isNaN(parsedBankAmount) || parsedBankAmount < 0)
    return res.status(400).json({ error: 'bankAmount must be a non-negative number' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Check for existing reconciliation
    const existing = await client.query(
      'SELECT id FROM pos_reconciliations WHERE company_id = $1 AND date = $2::date AND payment_method = $3',
      [req.user.companyId, date, paymentMethod]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${paymentMethod} for ${date} is already settled. Cannot re-settle.`,
        code: 'ALREADY_SETTLED'
      });
    }

    // Calculate POS amount for the day
    const salesResult = await client.query(
      `SELECT
         COALESCE(SUM(total_amount), 0) AS pos_amount,
         COUNT(*)                        AS sales_count
       FROM sales
       WHERE company_id = $1
         AND (created_at + INTERVAL '2 hours')::date = $2::date
         AND payment_method = $3
         AND status = 'completed'`,
      [req.user.companyId, date, paymentMethod]
    );
    const posAmount   = parseFloat(salesResult.rows[0].pos_amount)  || 0;
    const salesCount  = parseInt(salesResult.rows[0].sales_count)   || 0;
    const variance    = parsedBankAmount - posAmount;

    // Optionally create a journal entry
    let journal = null;
    if (bankLedgerAccountId && clearingAccountId) {
      // Verify both accounts belong to this company
      const acctCheck = await client.query(
        'SELECT id FROM accounts WHERE company_id = $1 AND id = ANY($2)',
        [req.user.companyId, [bankLedgerAccountId, clearingAccountId]]
      );
      if (acctCheck.rows.length < 2) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One or both ledger accounts not found for this company' });
      }

      const desc = bankDescription || `${paymentMethod === 'cash' ? 'Cash deposit' : 'Card settlement'} ${date}`;
      const lines = [
        { accountId: bankLedgerAccountId, debit: parsedBankAmount, credit: 0,               description: desc },
        { accountId: clearingAccountId,   debit: 0,                credit: parsedBankAmount, description: desc },
      ];
      // If there's a variance, add a rounding/variance line only if the accounts differ
      // (for simplicity, variance is absorbed into the clearing account line)

      const draftJournal = await JournalService.createDraftJournal(client, {
        companyId:         req.user.companyId,
        date,
        reference:         `POS-${paymentMethod.toUpperCase()}-${date}`,
        description:       desc,
        sourceType:        'pos_reconciliation',
        createdByUserId:   req.user.id,
        lines,
      });

      // Auto-post the journal
      await JournalService.postJournal(client, draftJournal.id, req.user.companyId, req.user.id);
      journal = draftJournal;
    }

    // Record the reconciliation
    const recon = await client.query(
      `INSERT INTO pos_reconciliations
         (company_id, date, payment_method, pos_amount, bank_amount,
          journal_id, bank_description, notes, reconciled_by_user_id)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.user.companyId, date, paymentMethod, posAmount, parsedBankAmount,
        journal?.id || null, bankDescription || null, notes || null, req.user.id
      ]
    );

    await AuditLogger.logUserAction(
      req, 'SETTLE', 'POS_RECONCILIATION', recon.rows[0].id,
      null,
      { date, paymentMethod, posAmount, bankAmount: parsedBankAmount, variance },
      `POS ${paymentMethod} reconciled for ${date}`
    );

    await client.query('COMMIT');

    res.status(201).json({
      reconciliation: recon.rows[0],
      journal:        journal ? { id: journal.id, reference: journal.reference } : null,
      salesCount,
      posAmount,
      bankAmount: parsedBankAmount,
      hasVariance: Math.abs(variance) >= 0.01,
      variance,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[pos-bridge] settle error:', err);
    res.status(500).json({ error: 'Failed to settle reconciliation' });
  } finally {
    client.release();
  }
});

// ─── GET /api/accounting/pos/customers ────────────────────────────────────────
/**
 * List POS customers for the company.
 *
 * Query params:
 *   search   string  (filter by name/email/number)
 *   limit    integer (default 100)
 *   offset   integer (default 0)
 *   active   'true'|'false'|''  (default: active only)
 *
 * Returns:
 *   { customers: [...], total }
 */
router.get('/customers', authenticate, hasPermission('pos.view'), async (req, res) => {
  try {
    const { search, limit = 100, offset = 0, active = 'true' } = req.query;

    const params  = [req.user.companyId];
    let whereParts = ['c.company_id = $1'];

    if (active === 'true')  whereParts.push('c.is_active = true');
    if (active === 'false') whereParts.push('c.is_active = false');

    if (search) {
      params.push(`%${search}%`);
      whereParts.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.customer_number ILIKE $${params.length})`);
    }

    const whereClause = whereParts.join(' AND ');

    const result = await db.query(
      `SELECT
         c.id, c.customer_number, c.name, c.customer_type,
         c.contact_person, c.email, c.phone, c.contact_number,
         c.address_line_1, c.city, c.postal_code,
         c.credit_limit, c.current_balance,
         c.is_active, c.created_at,
         COUNT(s.id)              AS total_sales,
         COALESCE(SUM(s.total_amount), 0) AS lifetime_value,
         MAX(s.created_at)        AS last_purchase_at,
         MAX(CASE WHEN s.payment_method = 'account' THEN s.created_at END) AS last_account_sale_at
       FROM customers c
       LEFT JOIN sales s ON s.customer_id = c.id AND s.status = 'completed'
       WHERE ${whereClause}
       GROUP BY c.id
       ORDER BY c.name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const totalResult = await db.query(
      `SELECT COUNT(*) FROM customers c WHERE ${whereClause}`,
      params
    );

    res.json({
      customers: result.rows,
      total: parseInt(totalResult.rows[0].count) || 0,
    });
  } catch (err) {
    console.error('[pos-bridge] customers error:', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// ─── GET /api/accounting/pos/customers/:id ────────────────────────────────────
/**
 * Customer detail with sales summary.
 *
 * Returns:
 *   { customer, salesSummary: { total, count, cashSales, cardSales, accountSales,
 *                               outstandingBalance } }
 */
router.get('/customers/:id', authenticate, hasPermission('pos.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const custResult = await db.query(
      'SELECT * FROM customers WHERE id = $1 AND company_id = $2',
      [id, req.user.companyId]
    );
    if (custResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const salesResult = await db.query(
      `SELECT
         COUNT(*)                                                              AS total_sales,
         COALESCE(SUM(total_amount), 0)                                       AS lifetime_value,
         COALESCE(SUM(CASE WHEN payment_method='cash'    THEN total_amount ELSE 0 END), 0) AS cash_sales,
         COALESCE(SUM(CASE WHEN payment_method='card'    THEN total_amount ELSE 0 END), 0) AS card_sales,
         COALESCE(SUM(CASE WHEN payment_method='account' THEN total_amount ELSE 0 END), 0) AS account_sales,
         MAX(created_at)                                                       AS last_purchase_at
       FROM sales
       WHERE customer_id = $1 AND company_id = $2 AND status = 'completed'`,
      [id, req.user.companyId]
    );

    res.json({
      customer:     custResult.rows[0],
      salesSummary: {
        totalSales:       parseInt(salesResult.rows[0].total_sales)     || 0,
        lifetimeValue:    parseFloat(salesResult.rows[0].lifetime_value) || 0,
        cashSales:        parseFloat(salesResult.rows[0].cash_sales)     || 0,
        cardSales:        parseFloat(salesResult.rows[0].card_sales)     || 0,
        accountSales:     parseFloat(salesResult.rows[0].account_sales)  || 0,
        outstandingBalance: parseFloat(custResult.rows[0].current_balance) || 0,
        lastPurchaseAt:   salesResult.rows[0].last_purchase_at,
      },
    });
  } catch (err) {
    console.error('[pos-bridge] customer detail error:', err);
    res.status(500).json({ error: 'Failed to load customer' });
  }
});

// ─── GET /api/accounting/pos/customers/:id/sales ──────────────────────────────
/**
 * Sales history for a specific customer.
 *
 * Query params:
 *   fromDate      YYYY-MM-DD
 *   toDate        YYYY-MM-DD
 *   paymentMethod cash | card | account
 *   limit         (default 50)
 *   offset        (default 0)
 *
 * Returns:
 *   { sales: [...], total }
 */
router.get('/customers/:id/sales', authenticate, hasPermission('pos.view'), async (req, res) => {
  try {
    const { id } = req.params;
    const { fromDate, toDate, paymentMethod, limit = 50, offset = 0 } = req.query;

    // Verify customer belongs to company
    const custCheck = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
      [id, req.user.companyId]
    );
    if (custCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const params = [id, req.user.companyId];
    let whereParts = ['s.customer_id = $1', 's.company_id = $2', "s.status = 'completed'"];

    if (fromDate) { params.push(fromDate); whereParts.push(`s.created_at >= $${params.length}::date`); }
    if (toDate)   { params.push(toDate);   whereParts.push(`s.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (paymentMethod) { params.push(paymentMethod); whereParts.push(`s.payment_method = $${params.length}`); }

    const whereClause = whereParts.join(' AND ');

    const result = await db.query(
      `SELECT
         s.id, s.sale_number,
         (s.created_at + INTERVAL '2 hours')::date::text AS date,
         TO_CHAR(s.created_at + INTERVAL '2 hours', 'HH24:MI') AS time,
         s.payment_method, s.total_amount, s.vat_amount,
         s.subtotal, s.discount_amount,
         s.status, s.payment_status
       FROM sales s
       WHERE ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM sales s WHERE ${whereClause}`,
      params
    );

    res.json({
      sales: result.rows,
      total: parseInt(countResult.rows[0].count) || 0,
    });
  } catch (err) {
    console.error('[pos-bridge] customer sales error:', err);
    res.status(500).json({ error: 'Failed to load customer sales' });
  }
});

module.exports = router;
