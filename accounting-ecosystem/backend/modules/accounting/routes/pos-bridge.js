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

module.exports = router;
