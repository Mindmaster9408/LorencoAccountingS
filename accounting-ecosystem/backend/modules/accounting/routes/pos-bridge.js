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
 * POS tables (sales, customers) live in the same Supabase database as
 * accounting tables — queried via the Supabase JS client.
 * The service-role key bypasses RLS; company_id scoping is enforced here.
 *
 * SA timezone: UTC+2 (no DST). Date grouping is performed in JavaScript
 * by offsetting UTC timestamps by +2 hours before extracting the date string.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const db = require('../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a DB date value to YYYY-MM-DD string */
function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  const dt = new Date(d);
  return dt.toISOString().substring(0, 10);
}

/** Compute the SA date (UTC+2) string from a UTC timestamp */
function saDateStr(createdAt) {
  const ms = new Date(createdAt).getTime() + 2 * 3600 * 1000;
  return new Date(ms).toISOString().substring(0, 10);
}

/** Compute the SA time HH:MM (UTC+2) from a UTC timestamp */
function saTimeStr(createdAt) {
  const ms = new Date(createdAt).getTime() + 2 * 3600 * 1000;
  return new Date(ms).toISOString().substring(11, 16);
}

/**
 * Convert an SA calendar date (YYYY-MM-DD) to the UTC ISO timestamp
 * for the very start of that SA day (SA midnight = UTC-2h).
 */
function saDateToUtcStart(saDate) {
  return new Date(`${saDate}T00:00:00+02:00`).toISOString();
}

/**
 * Convert an SA calendar date (YYYY-MM-DD) to the UTC ISO timestamp
 * for the very end of that SA day (SA 23:59:59.999 = UTC-2h).
 */
function saDateToUtcEnd(saDate) {
  return new Date(`${saDate}T23:59:59.999+02:00`).toISOString();
}

// ─── GET /api/accounting/pos/daily-totals ─────────────────────────────────────
/**
 * Aggregate POS sales by SA date, split cash vs card.
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
    const today     = new Date().toISOString().substring(0, 10);
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
    const fromDate  = req.query.fromDate || thirtyAgo;
    const toDate    = req.query.toDate   || today;

    // Fetch completed sales within the SA date range (converted to UTC)
    const { data: salesRows, error: salesError } = await supabase
      .from('sales')
      .select('created_at, payment_method, total_amount')
      .eq('company_id', req.user.companyId)
      .eq('status', 'completed')
      .gte('created_at', saDateToUtcStart(fromDate))
      .lte('created_at', saDateToUtcEnd(toDate));

    if (salesError) throw new Error(salesError.message);

    // Fetch existing settlements for the same period
    const { data: reconRows, error: reconError } = await supabase
      .from('pos_reconciliations')
      .select('date, payment_method, bank_amount, pos_amount')
      .eq('company_id', req.user.companyId)
      .gte('date', fromDate)
      .lte('date', toDate);

    if (reconError) throw new Error(reconError.message);

    // Aggregate sales by SA date in JavaScript
    const salesByDate = {};
    for (const s of salesRows || []) {
      const date   = saDateStr(s.created_at);
      const amount = parseFloat(s.total_amount) || 0;
      if (!salesByDate[date]) {
        salesByDate[date] = { date, cashSales: 0, cardSales: 0, accountSales: 0, totalSales: 0, transactionCount: 0 };
      }
      if (s.payment_method === 'cash')    salesByDate[date].cashSales    += amount;
      if (s.payment_method === 'card')    salesByDate[date].cardSales    += amount;
      if (s.payment_method === 'account') salesByDate[date].accountSales += amount;
      salesByDate[date].totalSales += amount;
      salesByDate[date].transactionCount++;
    }

    // Build settlement map: { 'YYYY-MM-DD': { cash: amount, card: amount } }
    const settled = {};
    for (const r of reconRows || []) {
      const d = toDateStr(r.date);
      if (!settled[d]) settled[d] = {};
      settled[d][r.payment_method] = parseFloat(r.bank_amount) || 0;
    }

    const days = Object.values(salesByDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(row => {
        const { date, cashSales, cardSales, accountSales, totalSales, transactionCount } = row;
        const cashSettled = settled[date]?.cash || 0;
        const cardSettled = settled[date]?.card || 0;
        return {
          date,
          cashSales,
          cardSales,
          accountSales,
          totalSales,
          transactionCount,
          cashSettled,
          cardSettled,
          cashPending: Math.max(0, cashSales - cashSettled),
          cardPending: Math.max(0, cardSales - cardSettled),
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
 * Individual POS sales for a specific SA date (for drill-down view).
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
    let query = supabase
      .from('sales')
      .select('id, sale_number, created_at, payment_method, total_amount, vat_amount, status, payment_status, customers!customer_id(name)')
      .eq('company_id', req.user.companyId)
      .eq('status', 'completed')
      .gte('created_at', saDateToUtcStart(date))
      .lte('created_at', saDateToUtcEnd(date))
      .order('created_at');

    if (paymentMethod) {
      query = query.eq('payment_method', paymentMethod);
    }

    const { data: salesRows, error } = await query;
    if (error) throw new Error(error.message);

    const sales = (salesRows || []).map(r => {
      const customerName = r.customers?.name || 'Walk-in Customer';
      return {
        id:            r.id,
        saleNumber:    r.sale_number,
        time:          saTimeStr(r.created_at),
        description:   `${r.sale_number} — ${customerName}`,
        customerName,
        paymentMethod: r.payment_method,
        total:         parseFloat(r.total_amount) || 0,
        vatAmount:     parseFloat(r.vat_amount)   || 0,
        status:        r.status,
        paymentStatus: r.payment_status,
      };
    });

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

  try {
    // Check for existing reconciliation
    const { data: existing, error: existingError } = await supabase
      .from('pos_reconciliations')
      .select('id')
      .eq('company_id', req.user.companyId)
      .eq('date', date)
      .eq('payment_method', paymentMethod)
      .maybeSingle();

    if (existingError) throw new Error(existingError.message);

    if (existing) {
      return res.status(409).json({
        error: `${paymentMethod} for ${date} is already settled. Cannot re-settle.`,
        code: 'ALREADY_SETTLED'
      });
    }

    // Calculate POS amount for the day by fetching sales and aggregating in JS
    const { data: salesRows, error: salesError } = await supabase
      .from('sales')
      .select('total_amount')
      .eq('company_id', req.user.companyId)
      .eq('payment_method', paymentMethod)
      .eq('status', 'completed')
      .gte('created_at', saDateToUtcStart(date))
      .lte('created_at', saDateToUtcEnd(date));

    if (salesError) throw new Error(salesError.message);

    const salesCount = (salesRows || []).length;
    const posAmount  = (salesRows || []).reduce((sum, s) => sum + (parseFloat(s.total_amount) || 0), 0);
    const variance   = parsedBankAmount - posAmount;

    // Optionally create a journal entry
    let journal = null;
    if (bankLedgerAccountId && clearingAccountId) {
      // Verify both accounts belong to this company
      const { data: acctCheck, error: acctError } = await supabase
        .from('accounts')
        .select('id')
        .eq('company_id', req.user.companyId)
        .in('id', [bankLedgerAccountId, clearingAccountId]);

      if (acctError) throw new Error(acctError.message);
      if (!acctCheck || acctCheck.length < 2) {
        return res.status(400).json({ error: 'One or both ledger accounts not found for this company' });
      }

      const desc = bankDescription || `${paymentMethod === 'cash' ? 'Cash deposit' : 'Card settlement'} ${date}`;
      const lines = [
        { accountId: bankLedgerAccountId, debit: parsedBankAmount, credit: 0,               description: desc },
        { accountId: clearingAccountId,   debit: 0,                credit: parsedBankAmount, description: desc },
      ];

      const draftJournal = await JournalService.createDraftJournal({
        companyId:       req.user.companyId,
        date,
        reference:       `POS-${paymentMethod.toUpperCase()}-${date}`,
        description:     desc,
        sourceType:      'pos_reconciliation',
        createdByUserId: req.user.id,
        lines,
      });

      // Auto-post the journal
      await JournalService.postJournal(draftJournal.id, req.user.companyId, req.user.id);
      journal = draftJournal;
    }

    // Record the reconciliation
    const { data: recon, error: reconInsertError } = await supabase
      .from('pos_reconciliations')
      .insert({
        company_id:            req.user.companyId,
        date,
        payment_method:        paymentMethod,
        pos_amount:            posAmount,
        bank_amount:           parsedBankAmount,
        journal_id:            journal?.id || null,
        bank_description:      bankDescription || null,
        notes:                 notes || null,
        reconciled_by_user_id: req.user.id,
      })
      .select()
      .single();

    if (reconInsertError) throw new Error(reconInsertError.message);

    await AuditLogger.logUserAction(
      req, 'SETTLE', 'POS_RECONCILIATION', recon.id,
      null,
      { date, paymentMethod, posAmount, bankAmount: parsedBankAmount, variance },
      `POS ${paymentMethod} reconciled for ${date}`
    );

    res.status(201).json({
      reconciliation: recon,
      journal:        journal ? { id: journal.id, reference: journal.reference } : null,
      salesCount,
      posAmount,
      bankAmount: parsedBankAmount,
      hasVariance: Math.abs(variance) >= 0.01,
      variance,
    });
  } catch (err) {
    console.error('[pos-bridge] settle error:', err);
    res.status(500).json({ error: 'Failed to settle reconciliation' });
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
    const parsedLimit  = parseInt(limit);
    const parsedOffset = parseInt(offset);

    // Build the customer query with optional filters
    let query = supabase
      .from('customers')
      .select(
        'id, customer_number, name, customer_type, contact_person, email, phone, contact_number, address_line_1, city, postal_code, credit_limit, current_balance, is_active, created_at',
        { count: 'exact' }
      )
      .eq('company_id', req.user.companyId);

    if (active === 'true')  query = query.eq('is_active', true);
    if (active === 'false') query = query.eq('is_active', false);

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,customer_number.ilike.%${search}%`);
    }

    query = query.order('name').range(parsedOffset, parsedOffset + parsedLimit - 1);

    const { data: customers, count, error: custError } = await query;
    if (custError) throw new Error(custError.message);

    // Fetch sales aggregates for the returned customers
    const customerIds = (customers || []).map(c => c.id);
    const salesAgg = {};

    if (customerIds.length > 0) {
      const { data: salesData, error: salesError } = await supabase
        .from('sales')
        .select('customer_id, total_amount, created_at, payment_method')
        .eq('company_id', req.user.companyId)
        .eq('status', 'completed')
        .in('customer_id', customerIds);

      if (salesError) throw new Error(salesError.message);

      for (const s of salesData || []) {
        if (!salesAgg[s.customer_id]) {
          salesAgg[s.customer_id] = {
            total_sales: 0, lifetime_value: 0,
            last_purchase_at: null, last_account_sale_at: null,
          };
        }
        const agg    = salesAgg[s.customer_id];
        const amount = parseFloat(s.total_amount) || 0;
        agg.total_sales++;
        agg.lifetime_value += amount;
        if (!agg.last_purchase_at || s.created_at > agg.last_purchase_at) {
          agg.last_purchase_at = s.created_at;
        }
        if (s.payment_method === 'account' &&
            (!agg.last_account_sale_at || s.created_at > agg.last_account_sale_at)) {
          agg.last_account_sale_at = s.created_at;
        }
      }
    }

    // Merge aggregate data into customer rows
    const result = (customers || []).map(c => ({
      ...c,
      total_sales:          salesAgg[c.id]?.total_sales          || 0,
      lifetime_value:       salesAgg[c.id]?.lifetime_value        || 0,
      last_purchase_at:     salesAgg[c.id]?.last_purchase_at      || null,
      last_account_sale_at: salesAgg[c.id]?.last_account_sale_at  || null,
    }));

    res.json({
      customers: result,
      total: count || 0,
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

    const { data: customer, error: custError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('company_id', req.user.companyId)
      .maybeSingle();

    if (custError) throw new Error(custError.message);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { data: salesRows, error: salesError } = await supabase
      .from('sales')
      .select('total_amount, payment_method, created_at')
      .eq('customer_id', id)
      .eq('company_id', req.user.companyId)
      .eq('status', 'completed');

    if (salesError) throw new Error(salesError.message);

    let totalSales = 0, lifetimeValue = 0, cashSales = 0, cardSales = 0,
        accountSales = 0, lastPurchaseAt = null;

    for (const s of salesRows || []) {
      const amount = parseFloat(s.total_amount) || 0;
      totalSales++;
      lifetimeValue += amount;
      if (s.payment_method === 'cash')    cashSales    += amount;
      if (s.payment_method === 'card')    cardSales    += amount;
      if (s.payment_method === 'account') accountSales += amount;
      if (!lastPurchaseAt || s.created_at > lastPurchaseAt) lastPurchaseAt = s.created_at;
    }

    res.json({
      customer,
      salesSummary: {
        totalSales,
        lifetimeValue,
        cashSales,
        cardSales,
        accountSales,
        outstandingBalance: parseFloat(customer.current_balance) || 0,
        lastPurchaseAt,
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
    const parsedLimit  = parseInt(limit);
    const parsedOffset = parseInt(offset);

    // Verify customer belongs to company
    const { data: custCheck, error: custCheckError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', id)
      .eq('company_id', req.user.companyId)
      .maybeSingle();

    if (custCheckError) throw new Error(custCheckError.message);
    if (!custCheck) return res.status(404).json({ error: 'Customer not found' });

    let query = supabase
      .from('sales')
      .select(
        'id, sale_number, created_at, payment_method, total_amount, vat_amount, subtotal, discount_amount, status, payment_status',
        { count: 'exact' }
      )
      .eq('customer_id', id)
      .eq('company_id', req.user.companyId)
      .eq('status', 'completed');

    if (fromDate) {
      query = query.gte('created_at', `${fromDate}T00:00:00.000Z`);
    }
    if (toDate) {
      // Exclusive upper bound: created_at < (toDate + 1 day), matching original SQL
      const exclusiveEnd = new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() + 86400000).toISOString();
      query = query.lt('created_at', exclusiveEnd);
    }
    if (paymentMethod) {
      query = query.eq('payment_method', paymentMethod);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    const { data: salesRows, count, error: salesError } = await query;
    if (salesError) throw new Error(salesError.message);

    // Decorate with SA date/time fields
    const sales = (salesRows || []).map(s => ({
      ...s,
      date: saDateStr(s.created_at),
      time: saTimeStr(s.created_at),
    }));

    res.json({
      sales,
      total: count || 0,
    });
  } catch (err) {
    console.error('[pos-bridge] customer sales error:', err);
    res.status(500).json({ error: 'Failed to load customer sales' });
  }
});

// ─── POST /api/accounting/pos/customers ──────────────────────────────────────
/**
 * Create a new customer scoped to the selected company.
 * company_id is always taken from the authenticated session — never from body.
 *
 * Body fields: name (required), customer_number, contact_person, phone, email,
 *   address_line_1, city, province, postal_code, credit_limit, notes,
 *   tax_reference, id_number, customer_type, is_active
 *
 * Returns: { customer }
 */
router.post('/customers', authenticate, hasPermission('pos.manage'), async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'COMPANY_CONTEXT_REQUIRED' });
    }

    const {
      name,
      customer_number,
      contact_person,
      phone,
      email,
      address_line_1,
      city,
      province,
      postal_code,
      credit_limit,
      notes,
      tax_reference,
      id_number,
      customer_type,
      is_active,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    const insertPayload = {
      company_id:      companyId,
      name:            name.trim(),
      customer_number: customer_number || null,
      contact_person:  contact_person  || null,
      phone:           phone           || null,
      email:           email           || null,
      address_line_1:  address_line_1  || null,
      city:            city            || null,
      province:        province        || null,
      postal_code:     postal_code     || null,
      credit_limit:    parseFloat(credit_limit) || 0,
      notes:           notes           || null,
      tax_reference:   tax_reference   || null,
      id_number:       id_number       || null,
      customer_type:   customer_type   || 'Cash Sale Customer',
      is_active:       is_active !== false,
      updated_at:      new Date().toISOString(),
    };

    const { data: created, error: insertError } = await supabase
      .from('customers')
      .insert(insertPayload)
      .select()
      .single();

    if (insertError) throw new Error(insertError.message);

    await AuditLogger.logUserAction(
      req, 'CUSTOMER_CREATED', 'CUSTOMER', created.id,
      null,
      { name: created.name, customer_number: created.customer_number, companyId },
      'Customer created via accounting customer list'
    );

    res.status(201).json({ customer: created });
  } catch (err) {
    console.error('[pos-bridge] POST /customers error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// ─── PUT /api/accounting/pos/customers/:id ────────────────────────────────────
/**
 * Update an existing customer.
 * Only updates the customer if it belongs to the selected company — no
 * cross-company updates possible. company_id cannot be changed.
 *
 * Returns: { customer }
 */
router.put('/customers/:id', authenticate, hasPermission('pos.manage'), async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'COMPANY_CONTEXT_REQUIRED' });
    }

    const customerId = parseInt(req.params.id, 10);
    if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });

    // Fetch existing — enforces company scope
    const { data: existing, error: fetchError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const {
      name,
      customer_number,
      contact_person,
      phone,
      email,
      address_line_1,
      city,
      province,
      postal_code,
      credit_limit,
      notes,
      tax_reference,
      id_number,
      customer_type,
      is_active,
    } = req.body;

    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Customer name cannot be empty' });
    }

    const updatePayload = { updated_at: new Date().toISOString() };
    if (name            !== undefined) updatePayload.name            = name.trim();
    if (customer_number !== undefined) updatePayload.customer_number = customer_number || null;
    if (contact_person  !== undefined) updatePayload.contact_person  = contact_person  || null;
    if (phone           !== undefined) updatePayload.phone           = phone           || null;
    if (email           !== undefined) updatePayload.email           = email           || null;
    if (address_line_1  !== undefined) updatePayload.address_line_1  = address_line_1  || null;
    if (city            !== undefined) updatePayload.city            = city            || null;
    if (province        !== undefined) updatePayload.province        = province        || null;
    if (postal_code     !== undefined) updatePayload.postal_code     = postal_code     || null;
    if (credit_limit    !== undefined) updatePayload.credit_limit    = parseFloat(credit_limit) || 0;
    if (notes           !== undefined) updatePayload.notes           = notes           || null;
    if (tax_reference   !== undefined) updatePayload.tax_reference   = tax_reference   || null;
    if (id_number       !== undefined) updatePayload.id_number       = id_number       || null;
    if (customer_type   !== undefined) updatePayload.customer_type   = customer_type   || null;
    if (is_active       !== undefined) updatePayload.is_active       = is_active !== false;

    const { data: updated, error: updateError } = await supabase
      .from('customers')
      .update(updatePayload)
      .eq('id', customerId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);

    await AuditLogger.logUserAction(
      req, 'CUSTOMER_UPDATED', 'CUSTOMER', customerId,
      { name: existing.name, email: existing.email, is_active: existing.is_active },
      updatePayload,
      'Customer updated via accounting customer list'
    );

    res.json({ customer: updated });
  } catch (err) {
    console.error('[pos-bridge] PUT /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// ─── DELETE /api/accounting/pos/customers/:id ─────────────────────────────────
/**
 * Soft-deactivate a customer (is_active = false).
 * Company-scoped — returns 404 for customers belonging to other companies.
 * Hard delete is NOT performed because customers may have sales history.
 *
 * Returns: { message, customerId }
 */
router.delete('/customers/:id', authenticate, hasPermission('pos.manage'), async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'COMPANY_CONTEXT_REQUIRED' });
    }

    const customerId = parseInt(req.params.id, 10);
    if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });

    // Verify ownership before deactivating
    const { data: existing, error: fetchError } = await supabase
      .from('customers')
      .select('id, name, is_active')
      .eq('id', customerId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const { error: deactivateError } = await supabase
      .from('customers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', customerId)
      .eq('company_id', companyId);

    if (deactivateError) throw new Error(deactivateError.message);

    await AuditLogger.logUserAction(
      req, 'CUSTOMER_DEACTIVATED', 'CUSTOMER', customerId,
      { name: existing.name, is_active: existing.is_active },
      { is_active: false },
      'Customer deactivated via accounting customer list'
    );

    res.json({ message: 'Customer deactivated', customerId });
  } catch (err) {
    console.error('[pos-bridge] DELETE /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to deactivate customer' });
  }
});

// ============================================================================
// GL Sync — opt-in daily till invoice generation (2026-08-15)
// ============================================================================
// Ruan's explicit requirement: pulling Charlie's sales into the books must
// never happen automatically/silently — a company must opt in via
// Accounting → Settings first. Gated by companies.pos_gl_sync_enabled
// (migration 077), default false.
//
// When enabled, a bookkeeper can generate a DRAFT customer_invoice against a
// dedicated "Checkout Charlie - Sales" debtor for one SA day's till takings.
// It stays DRAFT — no journal, nothing hits the GL or VAT201 report — until
// the bookkeeper reviews it against the actual till count and sends it via
// the EXISTING customer-invoices.js POST /:id/send action, which already
// correctly posts Dr AR / Cr Revenue / Cr VAT Output. This file deliberately
// does not touch JournalService itself, to reuse that already-proven posting
// path instead of duplicating it.
//
// Cash vs card is intentionally NOT split into separate lines here — the
// invoice is one till-total debtor balance. The cash portion gets cleared
// via the bookkeeper's normal till-count reconciliation (against the Petty
// Cash bank account provisioned below); the card portion stays outstanding
// on this same debtor until the card settlement bank deposit arrives and is
// allocated against it — the existing customer-payment-allocation flow
// handles that with no new code needed.

const CHECKOUT_CHARLIE_CUSTOMER_NAME = 'Checkout Charlie - Sales';
const CHECKOUT_CHARLIE_ACCOUNT_NAME  = 'Checkout Charlie - Sales';
const PETTY_CASH_ACCOUNT_NAME        = 'Petty Cash';

// These three provisioning helpers take a `client` (a checked-out pg Pool
// client, i.e. from db.getClient() — NOT the pool itself) and MUST be called
// from inside the same BEGIN/COMMIT transaction as the invoice header+lines
// insert below. Switching all three to db.query() (a previous fix attempt,
// commit 59021cd) was not enough — it moved everything onto the raw pg pool,
// but db.query() and db.getClient() can each hand out a *different* physical
// connection from the pool, and the FK violation on customer_invoice_lines.
// account_id recurred live 2026-08-16 even with both paths on raw pg. Using
// one single client end-to-end (provisioning through COMMIT) removes any
// possibility of a cross-connection visibility gap, regardless of its exact
// cause (RLS policies exist on accounts/customer_invoice_lines per
// migrations 091/138, which remains the leading theory, but this fix no
// longer depends on that theory being correct).
async function ensureCheckoutCharlieCustomer(client, companyId) {
  const existing = await client.query(
    `SELECT id FROM customers WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, CHECKOUT_CHARLIE_CUSTOMER_NAME]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await client.query(
    `INSERT INTO customers (company_id, name, customer_number, is_active, current_balance)
     VALUES ($1, $2, $3, true, 0) RETURNING id`,
    [companyId, CHECKOUT_CHARLIE_CUSTOMER_NAME, `POS-${companyId}`]
  );
  return created.rows[0].id;
}

// Picks a free account code starting at 4090 — clear of the standard chart
// template's own 4000-4080 sales-revenue block (accounting-schema.js) so
// this never collides with a company's existing seeded chart of accounts.
async function ensureCheckoutCharlieRevenueAccount(client, companyId) {
  const existing = await client.query(
    `SELECT id FROM accounts WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, CHECKOUT_CHARLIE_ACCOUNT_NAME]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  let code = 4090;
  for (let i = 0; i < 20; i++) {
    const taken = await client.query(`SELECT id FROM accounts WHERE company_id = $1 AND code = $2 LIMIT 1`, [companyId, String(code)]);
    if (taken.rows.length === 0) break;
    code++;
  }

  const created = await client.query(
    `INSERT INTO accounts (company_id, code, name, type, sub_type, reporting_group, description, is_active)
     VALUES ($1, $2, $3, 'income', 'operating_income', 'operating_income', $4, true) RETURNING id`,
    [companyId, String(code), CHECKOUT_CHARLIE_ACCOUNT_NAME, 'Revenue from Checkout Charlie till sales']
  );
  return created.rows[0].id;
}

async function ensurePettyCashBankAccount(client, companyId) {
  const existing = await client.query(
    `SELECT id FROM bank_accounts WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, PETTY_CASH_ACCOUNT_NAME]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await client.query(
    `INSERT INTO bank_accounts (company_id, name, bank_name, currency, is_active)
     VALUES ($1, $2, 'Cash on Hand', 'ZAR', true) RETURNING id`,
    [companyId, PETTY_CASH_ACCOUNT_NAME]
  );
  return created.rows[0].id;
}

/** Same VAT-inclusive line math as customer-invoices.js's calcLineVAT — kept
 * as a small local copy (pure function, no DB access) rather than a
 * cross-file export for one three-line formula. */
function calcInclusiveVat(totalIncVat, vatRate) {
  const total = Math.round((parseFloat(totalIncVat) || 0) * 100) / 100;
  const rate  = parseFloat(vatRate) || 0;
  const subtotalExVat = Math.round((total / (1 + rate / 100)) * 100) / 100;
  const vatAmount     = Math.round((total - subtotalExVat) * 100) / 100;
  return { subtotalExVat, vatAmount, totalIncVat: total };
}

// ─── GET /api/accounting/pos/gl-sync/status ───────────────────────────────────
router.get('/gl-sync/status', authenticate, hasPermission('pos.view'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('companies').select('pos_gl_sync_enabled').eq('id', req.user.companyId).maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ enabled: !!(data && data.pos_gl_sync_enabled) });
  } catch (err) {
    console.error('[pos-bridge] gl-sync/status GET error:', err);
    res.status(500).json({ error: 'Failed to load GL sync status' });
  }
});

// ─── PUT /api/accounting/pos/gl-sync/status ───────────────────────────────────
// Requires pos.manage — the same tier that already governs reconciliation
// settlement config — since flipping this affects whether real GL-facing
// draft invoices start getting generated for this company.
router.put('/gl-sync/status', authenticate, hasPermission('pos.manage'), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
  try {
    const { error } = await supabase.from('companies').update({ pos_gl_sync_enabled: enabled }).eq('id', req.user.companyId);
    if (error) throw new Error(error.message);
    await AuditLogger.logUserAction(
      req, enabled ? 'POS_GL_SYNC_ENABLED' : 'POS_GL_SYNC_DISABLED', 'COMPANY', req.user.companyId,
      null, { enabled }, `POS GL sync ${enabled ? 'enabled' : 'disabled'}`
    );
    res.json({ enabled });
  } catch (err) {
    console.error('[pos-bridge] gl-sync/status PUT error:', err);
    res.status(500).json({ error: 'Failed to update GL sync status' });
  }
});

// ─── POST /api/accounting/pos/gl-sync/generate-invoice ────────────────────────
/**
 * Body: { date: 'YYYY-MM-DD' }
 * Generates a DRAFT customer_invoice against the Checkout Charlie debtor for
 * one SA calendar day's completed till sales, split into up to two lines by
 * VAT treatment (standard-rated / zero-rated-or-exempt) so the invoice-level
 * VAT is correct regardless of product mix. One invoice per day — refuses a
 * second generation for the same date.
 */
router.post('/gl-sync/generate-invoice', authenticate, hasPermission('pos.reconcile'), async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });

  const companyId = req.user.companyId;

  // Everything from here through COMMIT runs on ONE checked-out pg client —
  // see the comment above ensureCheckoutCharlieCustomer() for why: handing
  // provisioning and the invoice insert to two different connections (even
  // two different raw-pg ones, db.query() vs db.getClient()) let a FK
  // violation on customer_invoice_lines.account_id slip through live
  // 2026-08-16 despite an earlier fix (commit 59021cd) that moved both onto
  // raw pg but not onto the SAME connection. One client end-to-end closes
  // that gap regardless of its exact cause.
  //
  // Uses raw pg rather than the Supabase JS client for customer_invoices/
  // customer_invoice_lines — confirmed live 2026-08-15 that those tables'
  // REAL live columns differ from what 012_accounting_schema.sql's CREATE
  // TABLE IF NOT EXISTS describes (that migration never actually took
  // effect — the tables already existed in an older shape, e.g. no
  // customer_name/reference columns, invoice_date is actually "date",
  // subtotal_ex_vat is actually "subtotal", etc. — see
  // information_schema.columns).
  const dbClient = await db.getClient();
  let committed = false;
  try {
    const { data: company } = await supabase.from('companies').select('pos_gl_sync_enabled').eq('id', companyId).maybeSingle();
    if (!company || !company.pos_gl_sync_enabled) {
      return res.status(403).json({ error: 'POS GL sync is not enabled for this company. Enable it in Settings first.', code: 'GL_SYNC_DISABLED' });
    }

    await dbClient.query('BEGIN');

    // RLS policies exist on accounts/customer_invoice_lines (migrations
    // 091/138) built around app_company_id()/app_is_super_admin(), which
    // read current_setting('app.company_id'/'app.is_super_admin') —
    // session-local variables the migrations' own comments say the backend
    // "will" set via set_config() before each query, once RLS enforcement
    // moves past its documented "Phase 1: completely inert" state. This
    // raw-pg connection never did that. If the connecting Postgres role
    // does NOT carry BYPASSRLS (unlike the Supabase service-role key, which
    // definitely does), those variables are permanently NULL here, RLS's
    // `company_id = app_company_id()` never matches any row — including
    // one this exact transaction just inserted — and the FK check on the
    // subsequent customer_invoice_lines insert sees no row to reference.
    // This is the real explanation for the FK violation persisting live
    // 2026-08-16 even after moving provisioning onto one single
    // transaction (commit 231ff2c) — that fix closed a real inconsistency
    // but was never the actual cause. Setting these now, unconditionally
    // and harmlessly if RLS turns out not to be enforced on this
    // connection after all.
    await dbClient.query(`SELECT set_config('app.company_id', $1, true), set_config('app.is_super_admin', $2, true)`,
      [String(companyId), String(!!req.user.isSuperAdmin)]);

    // No 'reference' column exists to key a dup-check on, so this uses the
    // natural key instead: one till invoice per company per day, identified
    // by the auto-provisioned "Checkout Charlie - Sales" customer_id + date.
    const customerId = await ensureCheckoutCharlieCustomer(dbClient, companyId);
    const dupResult = await dbClient.query(
      `SELECT id FROM customer_invoices WHERE company_id = $1 AND customer_id = $2 AND date = $3 AND status != 'void' LIMIT 1`,
      [companyId, customerId, date]
    );
    if (dupResult.rows.length > 0) {
      return res.status(409).json({ error: `A till invoice for ${date} already exists`, code: 'ALREADY_GENERATED', existingInvoiceId: dupResult.rows[0].id });
    }

    const { data: salesRows, error: salesError } = await supabase
      .from('sales')
      .select('id')
      .eq('company_id', companyId).eq('status', 'completed')
      .gte('created_at', saDateToUtcStart(date)).lte('created_at', saDateToUtcEnd(date));
    if (salesError) throw new Error(salesError.message);
    if (!salesRows || salesRows.length === 0) {
      return res.status(404).json({ error: `No completed sales found for ${date}` });
    }

    const saleIds = salesRows.map(s => s.id);
    const { data: items, error: itemsError } = await supabase
      .from('sale_items')
      .select('sale_id, line_total, vat_rate')
      .in('sale_id', saleIds);
    if (itemsError) throw new Error(itemsError.message);

    const grouped = { standard: 0, zeroOrExempt: 0 };
    for (const i of (items || [])) {
      const lineTotal = parseFloat(i.line_total) || 0;
      const rate = parseFloat(i.vat_rate) || 0;
      if (rate > 0) grouped.standard += lineTotal; else grouped.zeroOrExempt += lineTotal;
    }

    const revenueAccountId = await ensureCheckoutCharlieRevenueAccount(dbClient, companyId);
    await ensurePettyCashBankAccount(dbClient, companyId); // customerId already resolved above, for the dup-check

    const lineDefs = [];
    if (grouped.standard > 0)     lineDefs.push({ description: `Checkout Charlie till sales ${date} (standard-rated)`, totalIncVat: grouped.standard, vatRate: 15 });
    if (grouped.zeroOrExempt > 0) lineDefs.push({ description: `Checkout Charlie till sales ${date} (zero-rated/exempt)`, totalIncVat: grouped.zeroOrExempt, vatRate: 0 });
    if (lineDefs.length === 0) return res.status(404).json({ error: `No sale line items found for ${date}` });

    const processedLines = lineDefs.map((l, idx) => {
      const { subtotalExVat, vatAmount, totalIncVat } = calcInclusiveVat(l.totalIncVat, l.vatRate);
      return { description: l.description, accountId: revenueAccountId, vatRate: l.vatRate, subtotalExVat, vatAmount, totalIncVat, sortOrder: idx };
    });
    const totals = processedLines.reduce((acc, l) => ({
      subtotalExVat: acc.subtotalExVat + l.subtotalExVat,
      vatAmount:     acc.vatAmount     + l.vatAmount,
      totalIncVat:   acc.totalIncVat   + l.totalIncVat,
    }), { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 });

    const countResult = await dbClient.query(`SELECT COUNT(*)::int AS count FROM customer_invoices WHERE company_id = $1`, [companyId]);
    const invoiceNumber = `INV-${String((countResult.rows[0].count || 0) + 1).padStart(4, '0')}`;

    // customer_invoices has date/subtotal/total_amount/balance_due/
    // created_by (not invoice_date/subtotal_ex_vat/total_inc_vat/
    // created_by_user_id, and no customer_name/reference at all);
    // customer_invoice_lines has a single line_total (ex-VAT extended
    // amount, qty x unit_price) rather than a separate subtotal_ex_vat/
    // vat_amount/total_inc_vat/sort_order per line.
    const hdrResult = await dbClient.query(
      `INSERT INTO customer_invoices
         (company_id, customer_id, invoice_number, date, status, vat_mode,
          subtotal, vat_amount, total_amount, amount_paid, balance_due, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        companyId, customerId, invoiceNumber, date, 'draft', 'inclusive',
        totals.subtotalExVat, totals.vatAmount, totals.totalIncVat, 0, totals.totalIncVat,
        'Auto-generated from Checkout Charlie till sales — review against the till count before sending.',
        req.user.id,
      ]
    );
    const invoice = hdrResult.rows[0];

    for (const l of processedLines) {
      await dbClient.query(
        `INSERT INTO customer_invoice_lines
           (invoice_id, description, account_id, line_type, quantity, unit_price, vat_rate, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [invoice.id, l.description, l.accountId, 'account', 1, l.subtotalExVat, l.vatRate, l.subtotalExVat]
      );
    }

    await dbClient.query('COMMIT');
    committed = true;

    await AuditLogger.logUserAction(
      req, 'POS_TILL_INVOICE_GENERATED', 'CUSTOMER_INVOICE', invoice.id,
      null, { date, totalIncVat: totals.totalIncVat, salesCount: salesRows.length },
      `Draft till invoice generated from ${salesRows.length} Checkout Charlie sale(s) for ${date}`
    );

    res.status(201).json({ invoice, salesCount: salesRows.length });
  } catch (err) {
    console.error('[pos-bridge] gl-sync/generate-invoice error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate till invoice' });
  } finally {
    if (!committed) {
      try { await dbClient.query('ROLLBACK'); } catch (_rollbackErr) { /* transaction may never have started (e.g. 403 before BEGIN) — safe to ignore */ }
    }
    dbClient.release();
  }
});

module.exports = router;
