/**
 * ============================================================================
 * Customer Invoices / Accounts Receivable Routes
 * ============================================================================
 * Mounted at /api/accounting/customer-invoices
 * All routes are company-scoped via req.companyId (set by auth middleware).
 *
 * GL Posting:
 *   POST /:id/post  → DR AR(1100) / CR Revenue(line.account_id) / CR VAT Output(2300)
 *   POST /payments  → DR Bank(bankLedgerAccountId) / CR AR(1100)
 *
 * VAT Logic:
 *   vatInclusive=false (EX VAT): entered amount is base; VAT added on top
 *   vatInclusive=true  (INC VAT): entered amount is gross; VAT extracted
 * ============================================================================
 */

const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const db = require('../config/database');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');
const { authenticate, hasPermission } = require('../middleware/auth');
const { generateInvoicePdf } = require('../services/invoicePdfService');
const { generateAgingPdf, generateAnalysisPdf } = require('../services/reportPdfService');
const { sendEmail } = require('../../../shared/services/email');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcLineVAT(quantity, unitPrice, vatRate, vatInclusive) {
  const qty     = parseFloat(quantity)  || 1;
  const price   = parseFloat(unitPrice) || 0;
  const _parsed = parseFloat(vatRate);
  const rate    = isNaN(_parsed) ? 15 : _parsed;
  const entered = Math.round(qty * price * 10000) / 10000;

  let subtotalExVat, vatAmount, totalIncVat;
  if (vatInclusive) {
    totalIncVat   = Math.round(entered * 100) / 100;
    subtotalExVat = Math.round((entered / (1 + rate / 100)) * 100) / 100;
    vatAmount     = Math.round((totalIncVat - subtotalExVat) * 100) / 100;
  } else {
    subtotalExVat = Math.round(entered * 100) / 100;
    vatAmount     = Math.round((entered * rate / 100) * 100) / 100;
    totalIncVat   = Math.round((subtotalExVat + vatAmount) * 100) / 100;
  }
  return { subtotalExVat, vatAmount, totalIncVat };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function findAccountByCode(companyId, code) {
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();
    return data?.id || null;
  } catch (_) {
    return null;
  }
}

function userId(req) {
  return req.user && req.user.userId ? req.user.userId : null;
}

// ── Tenant ownership validators ───────────────────────────────────────────────

// Verifies that a POS customer ID belongs to companyId.
// Returns true  = valid (customer exists and belongs to this company).
// Returns false = rejected (ID exists but belongs to another company, or is malformed).
// Returns null  = no validation needed (customerId is null/falsy).
async function validateCustomerId(companyId, customerId) {
  if (!customerId) return null;
  const parsed = parseInt(customerId);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  const { data } = await supabase
    .from('customers')
    .select('id')
    .eq('id', parsed)
    .eq('company_id', companyId)
    .maybeSingle();
  return !!data;
}

// Verifies that every non-null accountId in the lines array belongs to companyId.
// Returns null  = all valid (or no account IDs provided).
// Returns array = one or more foreign/unknown account IDs found (the bad IDs).
async function validateLineAccountIds(companyId, lines) {
  const ids = [...new Set(
    (lines || [])
      .map(l => (l.accountId != null ? parseInt(l.accountId) : null))
      .filter(id => Number.isFinite(id) && id > 0)
  )];
  if (ids.length === 0) return null;
  const { data } = await supabase
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
    .in('id', ids);
  const valid   = new Set((data || []).map(a => a.id));
  const foreign = ids.filter(id => !valid.has(id));
  return foreign.length > 0 ? foreign : null;
}

// ── customer_invoices schema-drift helpers (2026-08-16) ──────────────────────
// The live customer_invoices table has no customer_name/reference columns and
// uses date/subtotal/total_amount/created_by/balance_due, not
// invoice_date/subtotal_ex_vat/total_inc_vat/created_by_user_id (confirmed
// via information_schema.columns — 012_accounting_schema.sql's CREATE TABLE
// IF NOT EXISTS never actually applied because the table already existed in
// this older shape). customer_invoice_lines similarly has one line_total
// column, not separate subtotal_ex_vat/vat_amount/total_inc_vat/sort_order.
// See the [[project_customer_invoices_postgrest_cache_bug]] memory note.
//
// Resolves a customer_id to write against this schema's FK-only design.
// Preserves the existing "type a name, no customerId required" API contract
// (customers.js's inline-create pattern) by finding-or-creating a customers
// row when only a name is given, rather than requiring every caller to be
// rewritten to always pass a real customerId.
async function resolveCustomerId(companyId, customerId, customerName) {
  if (customerId) {
    const parsed = parseInt(customerId);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (!customerName || !customerName.trim()) return null;

  const name = customerName.trim();
  const { data: existing } = await supabase
    .from('customers').select('id')
    .eq('company_id', companyId).ilike('name', name)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('customers').insert({ company_id: companyId, name })
    .select('id').single();
  if (error) throw new Error(`Could not resolve/create customer "${name}": ${error.message}`);
  return created.id;
}

// Batch-attaches API-response backward-compatibility fields to a list of
// invoice-like rows (or a single row): customer_name (DB no longer stores a
// name on the invoice row) plus the "intended" schema field names the
// frontend was written against (invoice_date/subtotal_ex_vat/total_inc_vat)
// but which never actually existed on the live customer_invoices table (see
// the schema-drift comment above resolveCustomerId). Fixing it here — the
// one place every list/detail/update response passes through — avoids
// touching every render call site in invoices.html individually.
/**
 * Company-link invoice pull-through (2026-08-21, migration 156).
 *
 * When a posted customer invoice's customer is a linked company
 * (customers.eco_client_id set, link_status='active' — see
 * shared/routes/client-links.js), this creates a DRAFT on the other
 * company's side using the exact same review/approve mechanism
 * supplierOcrDrafts.js already uses for OCR uploads — reused rather than
 * duplicated (see docs/leo-customer-supplier-linking-and-invoice-pullthrough.md).
 * A real supplier_invoice is only ever created there once THEY explicitly
 * approve it (POST /invoice-ocr-drafts/:id/approve), same forensic
 * guarantee as any OCR-sourced invoice: nothing lands in their GL without
 * a human choosing the GL account for every line and confirming it.
 *
 * Best-effort and non-fatal by design — called after this company's own
 * invoice has already been successfully posted; a failure here must never
 * roll back or fail that already-completed action for the sending company.
 */
async function pushInvoiceToLinkedSupplier({ companyId, invoice, lines }) {
  const { data: customer } = await supabase
    .from('customers').select('eco_client_id, link_status')
    .eq('id', invoice.customer_id).eq('company_id', companyId).maybeSingle();
  if (!customer || !customer.eco_client_id || customer.link_status !== 'active') return;

  const { data: targetEcoClient } = await supabase
    .from('eco_clients').select('client_company_id')
    .eq('id', customer.eco_client_id).maybeSingle();
  if (!targetEcoClient || !targetEcoClient.client_company_id) return;
  const targetCompanyId = targetEcoClient.client_company_id;

  // My own eco_client identity — same resolution rule as
  // client-links.js's getOwnEcoClient() (first by id if more than one).
  const { data: ownRows } = await supabase
    .from('eco_clients').select('id, name')
    .eq('client_company_id', companyId)
    .order('id', { ascending: true }).limit(1);
  const own = (ownRows && ownRows[0]) || null;
  if (!own) return; // no client_code identity — nothing to attribute the draft to

  // The supplier record on their side representing ME — created when the
  // link was established (client-links.js). If it's missing, the link was
  // never actually completed; skip rather than guessing at a supplier.
  const { data: supplierRow } = await supabase
    .from('suppliers').select('id')
    .eq('company_id', targetCompanyId).eq('eco_client_id', own.id).maybeSingle();
  if (!supplierRow) return;

  // Duplicate guard — POST /:id/post is already blocked from running twice
  // for the same invoice (journal_id check), but this is a cheap extra
  // safety net against ever pushing the same source invoice twice.
  const { data: existingDraft } = await supabase
    .from('supplier_invoice_ocr_drafts').select('id')
    .eq('source_customer_invoice_id', invoice.id).eq('source_company_id', companyId)
    .maybeSingle();
  if (existingDraft) return;

  const { data: myCompany } = await supabase
    .from('companies').select('company_name, trading_name').eq('id', companyId).maybeSingle();
  const myName = (myCompany && (myCompany.trading_name || myCompany.company_name)) || own.name;

  const header = {
    supplier_name:   myName,
    invoice_number:  invoice.invoice_number,
    invoice_date:    invoice.date,
    due_date:        invoice.due_date || null,
    vat_inclusive:   false, // customer_invoice_lines.line_total is always ex-VAT
    subtotal_ex_vat: parseFloat(invoice.subtotal) || 0,
    vat_amount:      parseFloat(invoice.vat_amount) || 0,
    total_inc_vat:   parseFloat(invoice.total_amount) || 0,
    warnings: [],
  };
  const draftLines = (lines || []).map((l, i) => ({
    sort_order:  i,
    description: l.description || '',
    quantity:    parseFloat(l.quantity)   || 1,
    unit_price:  parseFloat(l.unit_price) || 0,
    line_total:  parseFloat(l.line_total) || 0,
    vat_rate:    parseFloat(l.vat_rate)   || 0,
    // GL account is deliberately left unmapped — the receiving company's
    // chart of accounts is its own; POST /:id/approve already refuses to
    // convert a draft with any unmapped line, which is exactly right here.
    account_id:  null,
  }));

  await supabase.from('supplier_invoice_ocr_drafts').insert({
    company_id:                 targetCompanyId,
    supplier_id:                supplierRow.id,
    status:                     'draft',
    original_filename:          `Company Link — Invoice ${invoice.invoice_number}`,
    file_mime_type:             'application/x-company-link',
    file_size_bytes:            0,
    file_path:                  null,
    ocr_raw:                    null,
    extracted_header:           header,
    extracted_lines:            draftLines,
    confidence_summary:         null,
    reviewer_header:            header,
    reviewer_lines:             draftLines,
    created_by_user_id:         null,
    source:                     'company_link',
    source_customer_invoice_id: invoice.id,
    source_company_id:          companyId,
  });
}

async function attachCustomerNames(companyId, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const ids = [...new Set(list.map(r => r.customer_id).filter(Boolean))];
  let nameById = {};
  if (ids.length > 0) {
    const { data } = await supabase.from('customers').select('id, name').eq('company_id', companyId).in('id', ids);
    nameById = Object.fromEntries((data || []).map(c => [c.id, c.name]));
  }
  for (const r of list) {
    r.customer_name = r.customer_id ? (nameById[r.customer_id] || `Customer #${r.customer_id}`) : 'Unknown Customer';
    if (r.date !== undefined)         r.invoice_date    = r.date;
    if (r.subtotal !== undefined)     r.subtotal_ex_vat = r.subtotal;
    if (r.total_amount !== undefined) r.total_inc_vat   = r.total_amount;
  }
  return Array.isArray(rows) ? list : list[0];
}

// ─── Customer List (for dropdowns) ───────────────────────────────────────────

router.get('/customers', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  try {
    // customer_invoices has no customer_name column to merge in "invoice-only"
    // names from (see the schema-drift note above) — every invoice now
    // resolves to a real customers row via resolveCustomerId(), so the POS
    // customers list alone is already the complete set.
    const { data: posResult } = await supabase
      .from('customers')
      .select('id, name, email, phone')
      .eq('company_id', companyId)
      .order('name');

    const customers = (posResult || []).map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, source: 'pos' }));
    res.json({ customers });
  } catch (err) {
    console.error('GET /customer-invoices/customers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Customer (inline add from invoice form) ──────────────────────────
// Creates in customers so the new record immediately appears in the
// GET /customers dropdown. Rejects cross-company mutation and blank names.

router.post('/customers', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { name, email, phone, vatNumber } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Customer name is required' });

  // Exact-match duplicate guard (case-insensitive)
  const { data: existing } = await supabase
    .from('customers')
    .select('id, name')
    .eq('company_id', companyId)
    .ilike('name', name.trim())
    .maybeSingle();

  if (existing) {
    return res.status(409).json({
      error: `Customer "${existing.name}" already exists`,
      customer: existing,
    });
  }

  try {
    const insertPayload = {
      company_id: companyId,
      name:       name.trim(),
      email:      email?.trim() || null,
      phone:      phone?.trim() || null,
    };
    // vat_number column added by migration 029; insert only when provided
    if (vatNumber?.trim()) insertPayload.vat_number = vatNumber.trim();

    const { data: created, error } = await supabase
      .from('customers')
      .insert(insertPayload)
      .select('id, name, email, phone')
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json({ customer: created });
  } catch (err) {
    console.error('POST /customer-invoices/customers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List Invoices ───────────────────────────────────────────────────────────

router.get('/', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { status, customerId, fromDate, toDate, limit = 100, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('customer_invoices')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status)     query = query.eq('status', status);
    if (customerId) query = query.eq('customer_id', parseInt(customerId));
    if (fromDate)   query = query.gte('date', fromDate);
    if (toDate)     query = query.lte('date', toDate);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ invoices: await attachCustomerNames(companyId, data || []) });
  } catch (err) {
    console.error('GET /customer-invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sales Analysis ───────────────────────────────────────────────────────────
// Real replacement for the previously 100%-hardcoded sales-analysis.html.
// Deliberately omits Cost/Profit/Margin columns the old mockup showed at a
// fixed, invented 40% margin — there is no per-line cost/COGS data anywhere
// in this schema to compute those honestly, so they're left out rather than
// guessed. Revenue is ex-VAT (subtotal), matching how income is recognized.
// Registered before GET /:id so "sales-analysis" is never captured as an :id.
router.get('/sales-analysis', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { fromDate, toDate } = req.query;

  try {
    let q = supabase
      .from('customer_invoices')
      .select('id, customer_id, date, subtotal, total_amount')
      .eq('company_id', companyId)
      .not('status', 'in', '("draft","void","cancelled")');

    if (fromDate) q = q.gte('date', fromDate);
    if (toDate)   q = q.lte('date', toDate);

    const { data: rawInvoices, error } = await q;
    if (error) throw new Error(error.message);
    const invoices = await attachCustomerNames(companyId, rawInvoices || []);

    const byCustomerMap = {};
    const byMonthMap = {};
    for (const inv of invoices) {
      const revenue = parseFloat(inv.subtotal) || 0;
      const custKey = inv.customer_id ? `id:${inv.customer_id}` : 'unknown';
      if (!byCustomerMap[custKey]) {
        byCustomerMap[custKey] = { customerId: inv.customer_id || null, customerName: inv.customer_name, invoiceCount: 0, revenue: 0 };
      }
      byCustomerMap[custKey].invoiceCount++;
      byCustomerMap[custKey].revenue = Math.round((byCustomerMap[custKey].revenue + revenue) * 100) / 100;

      const monthKey = (inv.date || '').slice(0, 7);
      if (monthKey) byMonthMap[monthKey] = Math.round(((byMonthMap[monthKey] || 0) + revenue) * 100) / 100;
    }

    // Revenue by income account, via the invoices' own lines.
    let byAccount = [];
    if (invoices.length) {
      const invoiceIds = invoices.map(i => i.id);
      const { data: lines } = await supabase
        .from('customer_invoice_lines')
        .select('line_total, account_id, accounts!account_id(code, name)')
        .in('invoice_id', invoiceIds);
      const byAccountMap = {};
      (lines || []).forEach(l => {
        const key = l.account_id || 'unassigned';
        if (!byAccountMap[key]) {
          byAccountMap[key] = { accountId: l.account_id || null, accountCode: l.accounts?.code || null, accountName: l.accounts?.name || 'Unassigned', revenue: 0 };
        }
        byAccountMap[key].revenue = Math.round((byAccountMap[key].revenue + (parseFloat(l.line_total) || 0)) * 100) / 100;
      });
      byAccount = Object.values(byAccountMap).sort((a, b) => b.revenue - a.revenue);
    }

    const byCustomer = Object.values(byCustomerMap).sort((a, b) => b.revenue - a.revenue);
    const monthlyTrend = Object.entries(byMonthMap).sort(([a], [b]) => a.localeCompare(b)).map(([monthKey, revenue]) => ({ monthKey, revenue }));
    const totals = {
      invoiceCount: invoices.length,
      revenue: Math.round(byCustomer.reduce((s, c) => s + c.revenue, 0) * 100) / 100,
    };

    res.json({ byCustomer, byAccount, monthlyTrend, totals });
  } catch (err) {
    console.error('GET /customer-invoices/sales-analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sales-analysis/pdf
 * Re-fetches via the same query shape as /sales-analysis above (kept as a
 * second, independent query for the same reason as purchase-analysis/pdf —
 * see that route's comment).
 */
router.get('/sales-analysis/pdf', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { fromDate, toDate } = req.query;

  try {
    let q = supabase
      .from('customer_invoices')
      .select('id, customer_id, date, subtotal, total_amount')
      .eq('company_id', companyId)
      .not('status', 'in', '("draft","void","cancelled")');
    if (fromDate) q = q.gte('date', fromDate);
    if (toDate)   q = q.lte('date', toDate);
    const { data: rawInvoices, error } = await q;
    if (error) throw new Error(error.message);
    const invoices = await attachCustomerNames(companyId, rawInvoices || []);

    const byCustomerMap = {};
    const byMonthMap = {};
    for (const inv of invoices) {
      const revenue = parseFloat(inv.subtotal) || 0;
      const custKey = inv.customer_id ? `id:${inv.customer_id}` : 'unknown';
      if (!byCustomerMap[custKey]) byCustomerMap[custKey] = { name: inv.customer_name, invoiceCount: 0, amount: 0 };
      byCustomerMap[custKey].invoiceCount++;
      byCustomerMap[custKey].amount = Math.round((byCustomerMap[custKey].amount + revenue) * 100) / 100;
      const monthKey = (inv.date || '').slice(0, 7);
      if (monthKey) byMonthMap[monthKey] = Math.round(((byMonthMap[monthKey] || 0) + revenue) * 100) / 100;
    }

    let byAccount = [];
    if (invoices.length) {
      const invoiceIds = invoices.map(i => i.id);
      const { data: lines } = await supabase
        .from('customer_invoice_lines')
        .select('line_total, account_id, accounts!account_id(code, name)')
        .in('invoice_id', invoiceIds);
      const byAccountMap = {};
      (lines || []).forEach(l => {
        const key = l.account_id || 'unassigned';
        if (!byAccountMap[key]) byAccountMap[key] = { accountCode: l.accounts?.code || null, accountName: l.accounts?.name || 'Unassigned', amount: 0 };
        byAccountMap[key].amount = Math.round((byAccountMap[key].amount + (parseFloat(l.line_total) || 0)) * 100) / 100;
      });
      byAccount = Object.values(byAccountMap).sort((a, b) => b.amount - a.amount);
    }

    const byEntity = Object.values(byCustomerMap).sort((a, b) => b.amount - a.amount);
    const monthlyTrend = Object.entries(byMonthMap).sort(([a], [b]) => a.localeCompare(b)).map(([monthKey, amount]) => ({ monthKey, amount }));
    const totals = { invoiceCount: invoices.length, amount: Math.round(byEntity.reduce((s, c) => s + c.amount, 0) * 100) / 100 };

    const { data: company } = await supabase.from('companies').select('company_name, trading_name, registration_number, vat_number').eq('id', companyId).maybeSingle();
    const pdfBuffer = await generateAnalysisPdf({
      company: company || {}, title: 'SALES ANALYSIS', entityLabel: 'CUSTOMER', amountLabel: 'REVENUE',
      fromDate: fromDate || '—', toDate: toDate || '—', byEntity, byAccount, monthlyTrend, totals,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sales-analysis.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('GET /customer-invoices/sales-analysis/pdf error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Invoice Detail ───────────────────────────────────────────────────────
// :id constrained to digits only — otherwise this single-segment wildcard
// silently swallows every later-registered literal route with no additional
// path segments (confirmed real: /aging at the bottom of this file and
// /payments further down both fall in this trap; a request to either
// currently gets captured here first, parseInt()s to NaN, finds no matching
// invoice, and returns a misleading 404 "Invoice not found" instead of ever
// reaching its real handler). Registration order still matters for /payments
// specifically since path-to-regexp evaluates in order — but constraining
// this pattern to digits removes the conflict without having to relocate
// any of the affected routes.
router.get('/:id(\\d+)', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  try {
    const { data: invoice, error: invErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (invErr) throw new Error(invErr.message);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const { data: lines, error: linesErr } = await supabase
      .from('customer_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('id');

    if (linesErr) throw new Error(linesErr.message);

    // Flatten nested account fields to match expected shape
    const flatLines = (lines || []).map(l => ({
      ...l,
      account_code: l.accounts?.code || null,
      account_name: l.accounts?.name || null,
      accounts: undefined,
    }));

    res.json({ invoice: { ...(await attachCustomerNames(companyId, invoice)), lines: flatLines } });
  } catch (err) {
    console.error('GET /customer-invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Invoice (draft) ──────────────────────────────────────────────────

router.post('/', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const {
    customerId, customerName, invoiceNumber,
    invoiceDate, dueDate, vatInclusive, lines, notes,
  } = req.body;

  if (!customerId && !customerName) return res.status(400).json({ error: 'A customer is required — select an existing customer or provide a name.' });
  if (!invoiceDate)  return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    // ── Tenant ownership guards ────────────────────────────────────────────────
    // These run before any expensive work so a bad payload is rejected cheaply.

    // Guard 1: if a customer_id is supplied it MUST belong to this company.
    if (customerId) {
      const custOk = await validateCustomerId(companyId, customerId);
      if (custOk === false) {
        await AuditLogger.log({
          companyId,
          actorType: 'USER', actorId: userId(req),
          actionType: 'CUSTOMER_INVOICE_TENANT_VIOLATION',
          entityType: 'CUSTOMER_INVOICE', entityId: null,
          beforeJson: null,
          afterJson: { suppliedCustomerId: customerId, reasonCode: 'CUSTOMER_TENANT_VIOLATION' },
          reason: 'Invoice create blocked: supplied customer_id does not belong to this company',
          ipAddress: req.ip, userAgent: req.get('user-agent'),
        });
        return res.status(403).json({
          error: 'Customer not found or does not belong to this company.',
          errorCode: 'CUSTOMER_TENANT_VIOLATION',
        });
      }
    }
    // customer_invoices has no customer_name column (schema-drift note above)
    // — resolves to a real customers row, creating one by name if the caller
    // only sent a name (preserves the existing "name-only" form behaviour).
    const resolvedCustomerId = await resolveCustomerId(companyId, customerId, customerName);
    if (!resolvedCustomerId) {
      return res.status(400).json({ error: 'A customer is required — select an existing customer or provide a name.' });
    }

    // Guard 2: every line account_id must belong to this company.
    // Prevents cross-tenant account injection into invoice line items.
    const foreignLineAccounts = await validateLineAccountIds(companyId, lines);
    if (foreignLineAccounts) {
      return res.status(403).json({
        error: 'One or more line item accounts do not belong to this company.',
        errorCode: 'ACCOUNT_TENANT_VIOLATION',
      });
    }

    // ── Duplicate invoice guard ────────────────────────────────────────────────
    // If an explicit invoice number is provided, reject a second creation for the
    // same company + invoice number. Covers accidental double-submission.
    if (invoiceNumber && invoiceNumber.trim()) {
      const { data: dup } = await supabase
        .from('customer_invoices')
        .select('id')
        .eq('company_id', companyId)
        .eq('invoice_number', invoiceNumber.trim())
        .not('status', 'in', '("void","cancelled")')
        .maybeSingle();
      if (dup) {
        return res.status(409).json({
          error: `Invoice number '${invoiceNumber.trim()}' already exists`,
          errorCode: 'DUPLICATE_INVOICE',
          existingInvoiceId: dup.id,
        });
      }
    }
    // ── End duplicate guard ────────────────────────────────────────────────────

    const processedLines = lines.map((l, i) => {
      const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
        l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
      );
      return {
        description: l.description || '',
        accountId:   l.accountId ? parseInt(l.accountId) : null,
        lineType:    l.lineType === 'item' ? 'item' : 'account',
        itemId:      l.itemId   ? parseInt(l.itemId)   : null,
        quantity:    parseFloat(l.quantity) || 1,
        unitPrice:   parseFloat(l.unitPrice) || 0,
        vatRate:     l.vatRate != null ? parseFloat(l.vatRate) : 15,
        subtotalExVat, vatAmount, totalIncVat,
        sortOrder:   i,
      };
    });

    const totals = processedLines.reduce(
      (acc, l) => ({
        subtotalExVat: acc.subtotalExVat + l.subtotalExVat,
        vatAmount:     acc.vatAmount     + l.vatAmount,
        totalIncVat:   acc.totalIncVat   + l.totalIncVat,
      }),
      { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
    );

    // Generate invoice number if not provided
    let invNum = invoiceNumber;
    if (!invNum) {
      const { count } = await supabase
        .from('customer_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId);
      invNum = `INV-${String((count || 0) + 1).padStart(4, '0')}`;
    }

    // ── Atomic create: header + lines in a single pg transaction ─────────────
    // Both inserts succeed or both are rolled back. No orphan header rows.
    const dbClient = await db.getClient();
    let invoice;
    try {
      await dbClient.query('BEGIN');

      const hdrResult = await dbClient.query(
        `INSERT INTO customer_invoices
           (company_id, customer_id, invoice_number, date, due_date, status, vat_mode,
            subtotal, vat_amount, total_amount, amount_paid, balance_due, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          companyId,
          resolvedCustomerId,
          invNum,
          invoiceDate,
          dueDate || null,
          'draft',
          vatInclusive === true ? 'inclusive' : 'exclusive',
          totals.subtotalExVat,
          totals.vatAmount,
          totals.totalIncVat,
          0,
          totals.totalIncVat,
          notes || null,
          userId(req),
        ]
      );
      invoice = hdrResult.rows[0];

      // Bulk-insert all lines in one statement. line_total is the ex-VAT
      // extended amount (quantity x unit_price) -- there's no separate
      // subtotal_ex_vat/vat_amount/total_inc_vat/sort_order per line in the
      // real schema, only the invoice header carries those totals.
      const lineVals = [];
      const lineParams = [];
      let p = 1;
      for (const l of processedLines) {
        lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        lineParams.push(
          invoice.id, l.description, l.accountId || null, l.lineType, l.itemId || null,
          l.quantity, l.unitPrice, l.vatRate, l.subtotalExVat
        );
      }
      await dbClient.query(
        `INSERT INTO customer_invoice_lines
           (invoice_id, description, account_id, line_type, item_id, quantity, unit_price,
            vat_rate, line_total)
         VALUES ${lineVals.join(',')}`,
        lineParams
      );

      await dbClient.query('COMMIT');
    } catch (txErr) {
      await dbClient.query('ROLLBACK');
      throw txErr;
    } finally {
      dbClient.release();
    }
    // ── End atomic create ─────────────────────────────────────────────────────

    await AuditLogger.log({
      companyId,
      actorType: 'USER',
      actorId: userId(req),
      actionType: 'CUSTOMER_INVOICE_CREATED',
      entityType: 'CUSTOMER_INVOICE',
      entityId: invoice.id,
      beforeJson: null,
      afterJson: {
        customerName,
        invoiceNumber: invoice.invoice_number,
        invoiceDate,
        subtotalExVat: totals.subtotalExVat,
        vatAmount: totals.vatAmount,
        totalIncVat: totals.totalIncVat,
        status: 'draft',
      },
      reason: 'Customer invoice created',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json({ invoice: { ...(await attachCustomerNames(companyId, invoice)), lines: processedLines } });
  } catch (err) {
    console.error('POST /customer-invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Invoice (draft only) ─────────────────────────────────────────────

router.put('/:id', authenticate, hasPermission('ar.invoice.edit'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  const {
    customerId, customerName, invoiceNumber, invoiceDate,
    dueDate, vatInclusive, lines, notes,
  } = req.body;

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status !== 'draft') {
      await AuditLogger.log({
        companyId,
        actorType: 'USER', actorId: userId(req),
        actionType: 'CUSTOMER_INVOICE_EDIT_BLOCKED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: null,
        afterJson: { invoiceId, status: existing.status, reasonCode: 'NOT_DRAFT', reasonMessage: 'Only draft invoices can be edited' },
        reason: `Customer invoice edit blocked: status is ${existing.status}`,
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(409).json({ error: 'Only draft invoices can be edited' });
    }

    // vatInclusive is a strict boolean sent by the edit form on every save, but
    // fall back to the invoice's existing stored mode if a caller omits it
    // entirely — never silently downgrade an Inclusive invoice to Exclusive
    // just because a field was left out of a partial payload.
    const effectiveVatMode = vatInclusive === true ? 'inclusive'
      : vatInclusive === false ? 'exclusive'
      : (existing.vat_mode || 'exclusive');

    const processedLines = (lines || []).map((l, i) => {
      const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
        l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, effectiveVatMode === 'inclusive'
      );
      return {
        description: l.description || '',
        accountId:   l.accountId ? parseInt(l.accountId) : null,
        lineType:    l.lineType === 'item' ? 'item' : 'account',
        itemId:      l.itemId   ? parseInt(l.itemId)   : null,
        quantity:    parseFloat(l.quantity) || 1,
        unitPrice:   parseFloat(l.unitPrice) || 0,
        vatRate:     l.vatRate != null ? parseFloat(l.vatRate) : 15,
        subtotalExVat, vatAmount, totalIncVat,
        sortOrder:   i,
      };
    });

    const totals = processedLines.reduce(
      (acc, l) => ({ subtotalExVat: acc.subtotalExVat + l.subtotalExVat,
        vatAmount: acc.vatAmount + l.vatAmount, totalIncVat: acc.totalIncVat + l.totalIncVat }),
      { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
    );

    // ── Tenant guard: all supplied line account_ids must belong to this company ─
    // Runs after status check and before the transaction so a bad payload is
    // rejected without opening a DB transaction.
    if (lines && lines.length > 0) {
      const foreignLineAccounts = await validateLineAccountIds(companyId, lines);
      if (foreignLineAccounts) {
        return res.status(403).json({
          error: 'One or more line item accounts do not belong to this company.',
          errorCode: 'ACCOUNT_TENANT_VIOLATION',
        });
      }
    }

    // Resolve effective values for fields that are optional in the update payload.
    // customer_invoices has no customer_name column — resolve/create a real
    // customers row the same way POST / does, falling back to the invoice's
    // existing customer_id if neither customerId nor customerName was sent.
    const effectiveCustomerId    = (customerId || customerName)
      ? await resolveCustomerId(companyId, customerId, customerName)
      : existing.customer_id;
    const effectiveInvoiceNumber = invoiceNumber || existing.invoice_number;
    const effectiveInvoiceDate   = invoiceDate   || existing.date;
    const effectiveBalanceDue    = Math.round((totals.totalIncVat - parseFloat(existing.amount_paid || 0)) * 100) / 100;

    // ── Atomic update: header + lines in a single pg transaction ─────────────
    // The header UPDATE and the line DELETE + INSERT are wrapped in one BEGIN/COMMIT.
    // If any step fails the transaction is rolled back and the invoice remains in
    // its pre-edit state — no partial updates, no zero-line invoices.
    const dbClient = await db.getClient();
    try {
      await dbClient.query('BEGIN');

      await dbClient.query(
        `UPDATE customer_invoices
         SET customer_id      = $1,
             invoice_number   = $2,
             date             = $3,
             vat_mode         = $4,
             subtotal         = $5,
             vat_amount       = $6,
             total_amount     = $7,
             balance_due      = $8,
             due_date         = $9,
             notes            = $10,
             updated_at       = $11
         WHERE id = $12 AND company_id = $13`,
        [
          effectiveCustomerId,
          effectiveInvoiceNumber,
          effectiveInvoiceDate,
          effectiveVatMode,
          totals.subtotalExVat,
          totals.vatAmount,
          totals.totalIncVat,
          effectiveBalanceDue,
          dueDate || null,
          notes || null,
          new Date().toISOString(),
          invoiceId,
          companyId,
        ]
      );

      if (lines) {
        // Delete all existing lines then re-insert the new set
        await dbClient.query(
          `DELETE FROM customer_invoice_lines WHERE invoice_id = $1`,
          [invoiceId]
        );

        if (processedLines.length) {
          const lineVals = [];
          const lineParams = [];
          let p = 1;
          for (const l of processedLines) {
            lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
            lineParams.push(
              invoiceId, l.description, l.accountId || null, l.lineType, l.itemId || null,
              l.quantity, l.unitPrice, l.vatRate, l.subtotalExVat
            );
          }
          await dbClient.query(
            `INSERT INTO customer_invoice_lines
               (invoice_id, description, account_id, line_type, item_id, quantity, unit_price,
                vat_rate, line_total)
             VALUES ${lineVals.join(',')}`,
            lineParams
          );
        }
      }

      await dbClient.query('COMMIT');
    } catch (txErr) {
      await dbClient.query('ROLLBACK');
      throw txErr;
    } finally {
      dbClient.release();
    }
    // ── End atomic update ─────────────────────────────────────────────────────

    // Fetch updated invoice + lines — company_id filter is defense-in-depth
    const { data: updated, error: updFetchErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single();
    if (updFetchErr) throw new Error(updFetchErr.message);

    const { data: updatedLines, error: updLinesErr } = await supabase
      .from('customer_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('id');
    if (updLinesErr) throw new Error(updLinesErr.message);

    const flatLines = (updatedLines || []).map(l => ({
      ...l,
      account_code: l.accounts?.code || null,
      account_name: l.accounts?.name || null,
      accounts: undefined,
    }));

    await AuditLogger.log({
      companyId,
      actorType: 'USER',
      actorId: userId(req),
      actionType: 'CUSTOMER_INVOICE_UPDATED',
      entityType: 'CUSTOMER_INVOICE',
      entityId: invoiceId,
      beforeJson: {
        subtotalExVat: parseFloat(existing.subtotal || 0),
        vatAmount: parseFloat(existing.vat_amount || 0),
        totalIncVat: parseFloat(existing.total_amount || 0),
        invoiceDate: existing.date,
      },
      afterJson: {
        subtotalExVat: totals.subtotalExVat,
        vatAmount: totals.vatAmount,
        totalIncVat: totals.totalIncVat,
        invoiceDate: invoiceDate || existing.date,
      },
      reason: 'Customer invoice updated (draft)',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ invoice: { ...(await attachCustomerNames(companyId, updated)), lines: flatLines } });
  } catch (err) {
    console.error('PUT /customer-invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Post Invoice to GL ───────────────────────────────────────────────────────

router.post('/:id/post', authenticate, hasPermission('ar.invoice.post'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);

  try {
    const { data: invoice, error: invErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (invErr) throw new Error(invErr.message);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'draft') {
      await AuditLogger.log({
        companyId,
        actorType: 'USER', actorId: userId(req),
        actionType: 'CUSTOMER_INVOICE_POST_BLOCKED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: null,
        afterJson: { invoiceId, status: invoice.status, reasonCode: 'NOT_DRAFT', reasonMessage: `Invoice is already ${invoice.status}` },
        reason: `Customer invoice post blocked: status is ${invoice.status}`,
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(409).json({ error: `Invoice is already ${invoice.status}` });
    }

    // Double-post guard: journal_id already set means a GL entry exists for this invoice.
    // Block immediately — re-running the post would create a second GL entry.
    if (invoice.journal_id != null) {
      await AuditLogger.log({
        companyId,
        actorType: 'USER', actorId: userId(req),
        actionType: 'CUSTOMER_INVOICE_DOUBLE_POST_BLOCKED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: null,
        afterJson: { invoiceId, journalId: invoice.journal_id, status: invoice.status, reasonCode: 'JOURNAL_ALREADY_LINKED' },
        reason: 'Customer invoice double-post blocked: journal already linked',
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(409).json({
        error: 'Invoice already has a linked journal and cannot be posted again.',
        journalId: invoice.journal_id,
      });
    }

    const { data: lines, error: linesErr } = await supabase
      .from('customer_invoice_lines')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('id');
    if (linesErr) throw new Error(linesErr.message);

    await attachCustomerNames(companyId, invoice);

    // Resolve required accounts
    const arAccountId = await findAccountByCode(companyId, '1100');
    if (!arAccountId) {
      return res.status(422).json({
        error: 'Accounts Receivable account (code 1100) not found in chart of accounts. Please provision a base chart of accounts first.'
      });
    }

    const glLines = [];

    // DR AR — full invoice amount
    glLines.push({
      accountId:   arAccountId,
      debit:       parseFloat(invoice.total_amount),
      credit:      0,
      description: `AR: ${invoice.customer_name} ${invoice.invoice_number}`,
    });

    // CR Revenue lines (line_total is the ex-VAT extended amount)
    for (const l of (lines || [])) {
      if (l && l.account_id && parseFloat(l.line_total) > 0) {
        glLines.push({
          accountId:   l.account_id,
          debit:       0,
          credit:      parseFloat(l.line_total),
          description: l.description || 'Revenue',
        });
      }
    }

    // CR VAT Output (2300) if any VAT — account must exist; missing account is an explicit error
    const totalVat = parseFloat(invoice.vat_amount) || 0;
    if (totalVat > 0) {
      const vatOutputId = await findAccountByCode(companyId, '2300');
      if (!vatOutputId) {
        return res.status(422).json({
          error: 'VAT Output account (code 2300) not found. Please provision the base chart of accounts before posting VAT-bearing customer invoices.'
        });
      }
      glLines.push({
        accountId:   vatOutputId,
        debit:       0,
        credit:      totalVat,
        description: 'VAT Output (Payable)',
      });
    }

    // Create + post journal
    const glJournal = await JournalService.createDraftJournal({
      companyId,
      date:             invoice.date,
      reference:        invoice.invoice_number,
      description:      `AR Invoice: ${invoice.customer_name}`,
      sourceType:       'customer_invoice',
      createdByUserId:  userId(req),
      lines:            glLines,
    });
    await JournalService.postJournal(glJournal.id, companyId, userId(req));

    // Update invoice: status → 'sent', store journal_id
    const { error: updErr } = await supabase
      .from('customer_invoices')
      .update({ status: 'sent', journal_id: glJournal.id, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('company_id', companyId);

    if (updErr) {
      // GL posted but invoice status update failed.
      // Reverse the journal immediately — a posted journal must not remain linked to a draft invoice.
      try {
        await JournalService.reverseJournal(
          glJournal.id, companyId, userId(req),
          `Auto-reversal: invoice ${invoiceId} status update failed after GL post`
        );
        await AuditLogger.log({
          companyId,
          actorType: 'SYSTEM', actorId: userId(req),
          actionType: 'CUSTOMER_INVOICE_POST_FAILED_REVERSED',
          entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
          beforeJson: { status: 'draft' },
          afterJson: { invoiceId, journalId: glJournal.id, updateError: updErr.message, reversalResult: 'reversed' },
          reason: `Invoice post failed after GL creation. Journal ${glJournal.id} reversed. Invoice remains draft.`,
          ipAddress: req.ip, userAgent: req.get('user-agent'),
        });
        return res.status(500).json({
          error: 'Invoice posting failed after GL journal creation. The journal was reversed to prevent double posting. Please retry.',
        });
      } catch (revErr) {
        console.error(`[CustomerAR] CRITICAL: journal ${glJournal.id} posted for invoice ${invoiceId}, status update failed, AND reversal failed:`, revErr.message);
        await AuditLogger.log({
          companyId,
          actorType: 'SYSTEM', actorId: userId(req),
          actionType: 'CUSTOMER_INVOICE_POST_FAILED_REVERSAL_FAILED',
          entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
          beforeJson: { status: 'draft' },
          afterJson: { invoiceId, journalId: glJournal.id, updateError: updErr.message, reversalError: revErr.message },
          reason: `CRITICAL: Invoice post failed AND reversal failed. Journal ${glJournal.id} may be dangling. Manual investigation required.`,
          ipAddress: req.ip, userAgent: req.get('user-agent'),
        });
        return res.status(500).json({
          error: 'Invoice posting failed after GL journal creation and automatic reversal failed. Manual investigation required.',
          journalId: glJournal.id,
        });
      }
    }

    await AuditLogger.log({
      companyId,
      actorType: 'USER',
      actorId: userId(req),
      actionType: 'CUSTOMER_INVOICE_POSTED',
      entityType: 'CUSTOMER_INVOICE',
      entityId: invoiceId,
      beforeJson: { status: 'draft' },
      afterJson: {
        status: 'sent',
        journalId: glJournal.id,
        totalIncVat: parseFloat(invoice.total_amount),
        customerName: invoice.customer_name,
      },
      reason: 'Customer invoice posted to GL',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Company-link pull-through (2026-08-21) — best-effort, never blocks or
    // fails the response for this invoice, which has already posted
    // successfully above. See pushInvoiceToLinkedSupplier() for the full
    // explanation.
    try {
      await pushInvoiceToLinkedSupplier({ companyId, invoice, lines: lines || [] });
    } catch (pushErr) {
      console.error('[CustomerAR] Company-link invoice push failed (non-fatal):', pushErr.message);
    }

    res.json({ message: 'Invoice posted to General Ledger', journalId: glJournal.id });
  } catch (err) {
    console.error('POST /customer-invoices/:id/post error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Email Invoice to Customer ──────────────────────────────────────────────
// Separate, additive fact from `status` — GL-posting flips status to 'sent'
// as a bookkeeping transition unrelated to whether anyone actually emailed
// the customer (see 160_customer_invoice_email_tracking.sql). Sending is
// allowed any number of times (re-send is a normal, expected action), so
// this only ever 200s or fails — it never blocks on "already sent".

router.post('/:id/send', authenticate, hasPermission('ar.invoice.send'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);

  try {
    const { data: invoice, error: invErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (invErr) throw new Error(invErr.message);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'draft') {
      return res.status(409).json({ error: 'Post this invoice to the General Ledger before emailing it to the customer.' });
    }

    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, name, email, vat_number')
      .eq('id', invoice.customer_id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (custErr) throw new Error(custErr.message);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Explicit override lets a one-off send go to a different address
    // (e.g. the customer asked for a copy at a second address) without
    // requiring the customer record itself to be edited first.
    const recipientEmail = (req.body?.email || customer.email || '').trim();
    if (!recipientEmail) {
      return res.status(400).json({
        error: `${customer.name} has no email address on file. Add one to the customer record, or provide one for this send.`,
        errorCode: 'NO_CUSTOMER_EMAIL',
      });
    }

    const { data: lines, error: linesErr } = await supabase
      .from('customer_invoice_lines')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('id');
    if (linesErr) throw new Error(linesErr.message);

    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .select('company_name, trading_name, registration_number, vat_number, address_street, address_suburb, address_city, contact_email, contact_phone, logo_url, bank_name, bank_account_holder, bank_account_number, bank_branch_code')
      .eq('id', companyId)
      .maybeSingle();
    if (companyErr) throw new Error(companyErr.message);

    const pdfBuffer = await generateInvoicePdf(invoice, lines || [], company || {}, customer);

    const emailResult = await sendEmail({
      to: recipientEmail,
      subject: `Invoice ${invoice.invoice_number} from ${company?.trading_name || company?.company_name || 'us'}`,
      html: `<p>Dear ${escapeHtml(customer.name)},</p><p>Please find attached invoice ${escapeHtml(invoice.invoice_number)} for ${escapeHtml(String(invoice.total_amount))}.</p><p>Kind regards</p>`,
      body: `Dear ${customer.name},\n\nPlease find attached invoice ${invoice.invoice_number}.\n\nKind regards`,
      attachments: [{ filename: `Invoice-${invoice.invoice_number}.pdf`, content: pdfBuffer }],
    });

    if (!emailResult.success) {
      return res.status(502).json({ error: emailResult.message || 'Failed to send email.' });
    }

    const { data: updated, error: updErr } = await supabase
      .from('customer_invoices')
      .update({
        emailed_at: new Date().toISOString(),
        emailed_to: recipientEmail,
        email_count: (invoice.email_count || 0) + 1,
      })
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .select()
      .maybeSingle();
    if (updErr) console.error('[CustomerAR] Failed to record invoice email send (email itself succeeded):', updErr.message);

    await AuditLogger.log({
      companyId,
      actorType: 'USER', actorId: userId(req),
      actionType: 'CUSTOMER_INVOICE_EMAILED',
      entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
      beforeJson: null,
      afterJson: { invoiceId, recipientEmail, emailCount: (invoice.email_count || 0) + 1 },
      reason: 'Invoice emailed to customer',
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });

    res.json({ message: `Invoice emailed to ${recipientEmail}`, emailedAt: updated?.emailed_at || new Date().toISOString(), emailedTo: recipientEmail });
  } catch (err) {
    console.error('POST /customer-invoices/:id/send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Void Invoice ─────────────────────────────────────────────────────────────

router.post('/:id/void', authenticate, hasPermission('ar.invoice.void'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);

  try {
    const { data: invoice, error: fetchErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'void') {
      await AuditLogger.log({
        companyId,
        actorType: 'USER', actorId: userId(req),
        actionType: 'CUSTOMER_INVOICE_VOID_BLOCKED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: null,
        afterJson: { invoiceId, status: invoice.status, reasonCode: 'ALREADY_VOIDED', reasonMessage: 'Invoice is already voided' },
        reason: 'Customer invoice void blocked: already voided',
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(409).json({ error: 'Invoice is already voided' });
    }
    if (invoice.status === 'paid' || parseFloat(invoice.amount_paid) > 0) {
      await AuditLogger.log({
        companyId,
        actorType: 'USER', actorId: userId(req),
        actionType: 'CUSTOMER_INVOICE_VOID_BLOCKED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: null,
        afterJson: { invoiceId, status: invoice.status, amountPaid: parseFloat(invoice.amount_paid || 0), reasonCode: 'HAS_PAYMENTS', reasonMessage: 'Cannot void an invoice that has payments applied' },
        reason: 'Customer invoice void blocked: payments applied',
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(409).json({ error: 'Cannot void an invoice that has payments applied. Reverse the payments first.' });
    }

    // VAT period lock guard: block void if invoice GL journal is in a locked VAT period
    if (invoice.journal_id) {
      const vatLock = await JournalService.isVatPeriodLocked(invoice.journal_id);
      if (vatLock.locked) {
        await AuditLogger.log({
          companyId,
          actorType: 'USER', actorId: userId(req),
          actionType: 'CUSTOMER_INVOICE_VOID_BLOCKED',
          entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
          beforeJson: null,
          afterJson: { invoiceId, status: invoice.status, journalId: invoice.journal_id, vatPeriodKey: vatLock.periodKey, reasonCode: 'VAT_PERIOD_LOCKED', reasonMessage: `Invoice is in locked VAT period ${vatLock.periodKey}` },
          reason: `Customer invoice void blocked: VAT period ${vatLock.periodKey} is locked`,
          ipAddress: req.ip, userAgent: req.get('user-agent'),
        });
        return res.status(403).json({
          error: `Cannot void this invoice — it is included in locked VAT period ${vatLock.periodKey}. VAT periods that have been locked cannot be changed.`,
        });
      }
    }

    // Reverse the posted journal if one exists
    if (invoice.journal_id) {
      await JournalService.reverseJournal(invoice.journal_id, companyId, userId(req));
    }

    const { error: voidErr } = await supabase
      .from('customer_invoices')
      .update({ status: 'void', updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('company_id', companyId);

    if (voidErr) throw new Error(voidErr.message);

    await AuditLogger.log({
      companyId,
      actorType: 'USER',
      actorId: userId(req),
      actionType: 'CUSTOMER_INVOICE_VOIDED',
      entityType: 'CUSTOMER_INVOICE',
      entityId: invoiceId,
      beforeJson: { status: invoice.status, journalId: invoice.journal_id || null },
      afterJson: {
        status: 'void',
        journalReversed: !!invoice.journal_id,
        reversedJournalId: invoice.journal_id || null,
      },
      reason: 'Customer invoice voided',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ message: 'Invoice voided' });
  } catch (err) {
    console.error('POST /customer-invoices/:id/void error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Record Customer Payment ──────────────────────────────────────────────────
// STRICT mode: GL journal is created BEFORE payment is inserted.
// If GL posting fails for any reason the payment is never saved and the
// invoice amount_paid is never updated. No silent GL failures are permitted.

router.post('/payments', authenticate, hasPermission('ar.payment.record'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const {
    customerId, customerName, paymentDate, paymentMethod,
    reference, amount, bankLedgerAccountId, notes, allocations, idempotencyKey,
  } = req.body;

  if (!customerName) return res.status(400).json({ error: 'Customer name is required' });
  if (!paymentDate)  return res.status(400).json({ error: 'Payment date is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
  if (!bankLedgerAccountId) {
    return res.status(422).json({ error: 'Bank ledger account is required before customer payment can be recorded.' });
  }

  const paymentAmount = parseFloat(amount);

  try {
    // ── Step 0: Idempotency pre-check ────────────────────────────────────────
    // Fast path: if this key was already committed, return the existing payment
    // without touching GL. Handles sequential retries and slow-network replays.
    if (idempotencyKey) {
      const { data: existingPay } = await supabase
        .from('customer_payments')
        .select('*')
        .eq('company_id', companyId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (existingPay) {
        return res.status(200).json({ payment: existingPay, idempotentReplay: true });
      }
    }

    // ── Step 1: Validate AR account exists ──────────────────────────────────
    const arAccountId = await findAccountByCode(companyId, '1100');
    if (!arAccountId) {
      return res.status(422).json({
        error: 'Accounts Receivable account (code 1100) not found. Please provision the base chart of accounts before recording customer payments.'
      });
    }

    // ── Step 2: Validate bank ledger account is active and postable ─────────
    const { data: bankAcct } = await supabase
      .from('accounts')
      .select('id, is_postable, is_active')
      .eq('id', parseInt(bankLedgerAccountId))
      .eq('company_id', companyId)
      .maybeSingle();

    if (!bankAcct || bankAcct.is_active === false) {
      return res.status(422).json({ error: 'Valid bank ledger account is required before customer payment can be recorded.' });
    }
    if (bankAcct.is_postable === false) {
      return res.status(422).json({ error: 'The selected bank ledger account is a parent/header account and cannot be posted to directly. Select a posting sub-account.' });
    }

    // ── Step 3: Validate allocations ────────────────────────────────────────
    if (allocations && allocations.length > 0) {
      const allocTotal = allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
      if (Math.abs(allocTotal - paymentAmount) > 0.01) {
        return res.status(422).json({
          error: `Allocation total (${allocTotal.toFixed(2)}) does not equal payment amount (${paymentAmount.toFixed(2)}). Allocations must sum to the full payment amount.`
        });
      }

      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount) continue;
        const allocAmount = parseFloat(alloc.amount);
        const { data: inv } = await supabase
          .from('customer_invoices')
          .select('amount_paid, total_amount, invoice_number')
          .eq('id', parseInt(alloc.invoiceId))
          .eq('company_id', companyId)
          .maybeSingle();
        if (!inv) {
          return res.status(422).json({ error: `Invoice ${alloc.invoiceId} not found for this company.` });
        }
        const remaining = parseFloat(inv.total_amount) - parseFloat(inv.amount_paid || 0);
        if (allocAmount > remaining + 0.01) {
          return res.status(422).json({
            error: `Allocation of ${allocAmount.toFixed(2)} exceeds outstanding balance of ${remaining.toFixed(2)} on invoice ${inv.invoice_number || alloc.invoiceId}.`
          });
        }
      }
    }

    // ── Step 4: Create and post GL journal BEFORE inserting the payment ──────
    // Ordering: GL first means a GL failure leaves nothing saved.
    // DR Bank / CR AR(1100)
    const glJournal = await JournalService.createDraftJournal({
      companyId,
      date:            paymentDate,
      reference:       reference || null,
      description:     `AR Receipt: ${customerName}`,
      sourceType:      'customer_payment',
      createdByUserId: userId(req),
      lines: [
        { accountId: parseInt(bankLedgerAccountId), debit: paymentAmount, credit: 0, description: 'Bank receipt' },
        { accountId: arAccountId, debit: 0, credit: paymentAmount, description: `AR cleared: ${customerName}` },
      ],
    });
    await JournalService.postJournal(glJournal.id, companyId, userId(req));

    // ── Step 5: Insert payment (journal_id already known) ────────────────────
    const { data: payment, error: payErr } = await supabase
      .from('customer_payments')
      .insert({
        company_id:             companyId,
        customer_id:            customerId ? parseInt(customerId) : null,
        customer_name:          customerName,
        payment_date:           paymentDate,
        payment_method:         paymentMethod || 'bank_transfer',
        reference:              reference || null,
        amount:                 paymentAmount,
        bank_ledger_account_id: parseInt(bankLedgerAccountId),
        notes:                  notes || null,
        created_by_user_id:     userId(req),
        journal_id:             glJournal.id,
        idempotency_key:        idempotencyKey || null,
      })
      .select()
      .single();

    if (payErr) {
      // Handle idempotency key conflict: a concurrent request already committed
      // this payment. Reverse the duplicate GL journal we just posted and return
      // the winning payment record.
      if (idempotencyKey && payErr.code === '23505') {
        await JournalService.reverseJournal(glJournal.id, companyId, userId(req)).catch(rErr => {
          console.error(`[CustomerAR] IDEMPOTENCY: journal ${glJournal.id} reversed for concurrent duplicate key ${idempotencyKey}:`, rErr.message);
        });
        const { data: winnerPay } = await supabase
          .from('customer_payments')
          .select('*')
          .eq('company_id', companyId)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (winnerPay) {
          return res.status(200).json({ payment: winnerPay, idempotentReplay: true });
        }
      }
      // GL posted but payment row failed for a non-idempotency reason — reverse journal.
      await JournalService.reverseJournal(glJournal.id, companyId, userId(req)).catch(rErr => {
        console.error(`[CustomerAR] CRITICAL: journal ${glJournal.id} posted but payment insert failed AND reversal failed:`, rErr.message);
      });
      throw new Error(payErr.message);
    }

    // ── Step 6: Apply allocations atomically under row-level locks ─────────────
    // Uses SELECT FOR UPDATE to serialize concurrent allocation writes on the
    // same invoice row. All allocations for this payment commit as one unit —
    // no partial states, no stale-read balance corruption.
    //
    // Why here and not in Step 3: Step 3 is a fast pre-check (catches obvious
    // errors before the expensive GL journal path). Step 6 is the authoritative
    // check — the balance is read inside the lock so concurrent payments cannot
    // both pass validation and then both over-allocate the same invoice.
    if (allocations && allocations.length) {
      const allocClient = await db.getClient();
      try {
        await allocClient.query('BEGIN');

        for (const alloc of allocations) {
          if (!alloc.invoiceId || !alloc.amount) continue;

          const allocAmount    = parseFloat(alloc.amount);
          const allocInvoiceId = parseInt(alloc.invoiceId);

          // Lock the invoice row — no other transaction can update amount_paid
          // for this invoice until this transaction commits or rolls back.
          const { rows: lockRows } = await allocClient.query(
            `SELECT id, amount_paid, total_amount
             FROM customer_invoices
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [allocInvoiceId, companyId]
          );
          if (!lockRows.length) {
            await allocClient.query('ROLLBACK');
            return res.status(422).json({ error: `Invoice ${allocInvoiceId} not found — allocation aborted.` });
          }

          const inv               = lockRows[0];
          const currentAmountPaid = parseFloat(inv.amount_paid || 0);
          const newAmountPaid     = Math.round((currentAmountPaid + allocAmount) * 100) / 100;
          const totalIncVat       = parseFloat(inv.total_amount);

          // Authoritative overpayment guard — checked with locked, current data.
          if (newAmountPaid > totalIncVat + 0.015) {
            await allocClient.query('ROLLBACK');
            const remaining = Math.round((totalIncVat - currentAmountPaid) * 100) / 100;
            return res.status(422).json({
              error: `Allocation of ${allocAmount.toFixed(2)} would exceed the outstanding balance of ${remaining.toFixed(2)} on invoice ${allocInvoiceId}. A concurrent payment may have already been applied.`,
              errorCode: 'ALLOCATION_OVERPAYMENT',
            });
          }

          const newStatus = newAmountPaid >= totalIncVat - 0.005 ? 'paid'
                          : newAmountPaid > 0                    ? 'part_paid'
                          : 'sent';

          await allocClient.query(
            `UPDATE customer_invoices
             SET amount_paid = $1, balance_due = $2, status = $3, updated_at = NOW()
             WHERE id = $4 AND company_id = $5`,
            [newAmountPaid, Math.round((totalIncVat - newAmountPaid) * 100) / 100, newStatus, allocInvoiceId, companyId]
          );

          // Idempotent insert: ON CONFLICT replaces amount_applied so a replayed
          // request does not create a duplicate allocation row.
          await allocClient.query(
            `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_applied)
             VALUES ($1, $2, $3)
             ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount_applied = EXCLUDED.amount_applied`,
            [payment.id, allocInvoiceId, allocAmount]
          );
        }

        await allocClient.query('COMMIT');
      } catch (allocTxErr) {
        await allocClient.query('ROLLBACK');
        throw allocTxErr;
      } finally {
        allocClient.release();
      }
    }

    // ── Step 7: Audit log ────────────────────────────────────────────────────
    await AuditLogger.log({
      companyId,
      actorType: 'USER',
      actorId: userId(req),
      actionType: 'CUSTOMER_PAYMENT_RECORDED',
      entityType: 'CUSTOMER_PAYMENT',
      entityId: payment.id,
      beforeJson: null,
      afterJson: {
        customerName,
        paymentDate,
        paymentMethod: paymentMethod || 'bank_transfer',
        amount: paymentAmount,
        allocationCount: allocations ? allocations.length : 0,
        journalId: glJournal.id,
      },
      reason: 'Customer payment recorded',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json({ payment });
  } catch (err) {
    console.error('POST /customer-invoices/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List Customer Payments ───────────────────────────────────────────────────
// GET /payments — returns all customer payments for the company, newest first.
// Includes reversal metadata so the frontend can render reversed badges and
// conditionally show the void button.

router.get('/payments', authenticate, hasPermission('ar.payment.record'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  try {
    const { data: payments, error } = await supabase
      .from('customer_payments')
      .select('*')
      .eq('company_id', companyId)
      .order('payment_date', { ascending: false })
      .order('id',           { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ payments: payments || [] });
  } catch (err) {
    console.error('GET /customer-invoices/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Customer Payment Detail ──────────────────────────────────────────────────
// GET /payments/:id
//
// Forensic detail view for a single customer payment (ACC-HARDEN-022).
// Returns the payment header, all allocations with joined invoice data,
// the original GL journal with account names, and the reversal GL journal
// if the payment has been reversed.
//
// Data enrichment (parallel where possible):
//   - bank ledger account: code + name from accounts table
//   - created_by user:     full_name + username from users table
//   - reversed_by user:    full_name + username from users table (if reversed)
//   - allocations:         joined with customer_invoices for number, date, totals
//   - original journal:    lines joined with accounts for code + name
//   - reversal journal:    same, only if reversal_journal_id is set
//
// All queries are company-scoped. Cross-company access returns 404.

router.get('/payments/:id', authenticate, hasPermission('ar.payment.record'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const paymentId = parseInt(req.params.id);

  if (isNaN(paymentId)) {
    return res.status(400).json({ error: 'Invalid payment ID' });
  }

  try {
    // ── 1. Fetch payment — company-scoped ────────────────────────────────────
    const { data: payment, error: payErr } = await supabase
      .from('customer_payments')
      .select('*')
      .eq('id', paymentId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (payErr) throw new Error(payErr.message);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found', errorCode: 'PAYMENT_NOT_FOUND' });
    }

    // ── 2. Parallel enrichment fetches ───────────────────────────────────────
    const [
      allocResult,
      bankAcctResult,
      createdByResult,
      reversedByResult,
      journalResult,
      revJournalResult,
    ] = await Promise.all([

      // Allocations + joined invoice header data
      supabase
        .from('customer_payment_allocations')
        .select('invoice_id, amount_applied')
        .eq('payment_id', paymentId),

      // Bank ledger account name + code
      payment.bank_ledger_account_id
        ? supabase
            .from('accounts')
            .select('id, code, name')
            .eq('id', payment.bank_ledger_account_id)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),

      // Created-by user
      payment.created_by_user_id
        ? supabase
            .from('users')
            .select('id, full_name, username, email')
            .eq('id', payment.created_by_user_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),

      // Reversed-by user (only relevant if reversed)
      payment.reversed_by_user_id
        ? supabase
            .from('users')
            .select('id, full_name, username, email')
            .eq('id', payment.reversed_by_user_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),

      // Original GL journal with lines
      payment.journal_id
        ? supabase
            .from('journals')
            .select('id, date, reference, description, status, source_type, created_at')
            .eq('id', payment.journal_id)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),

      // Reversal GL journal with lines
      payment.reversal_journal_id
        ? supabase
            .from('journals')
            .select('id, date, reference, description, status, source_type, created_at')
            .eq('id', payment.reversal_journal_id)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    if (allocResult.error) throw new Error(allocResult.error.message);

    // ── 3. Enrich allocations with invoice data ───────────────────────────────
    const rawAllocs = allocResult.data || [];
    let allocations = [];

    if (rawAllocs.length > 0) {
      const invoiceIds = [...new Set(rawAllocs.map(a => a.invoice_id))];
      const { data: invoices } = await supabase
        .from('customer_invoices')
        .select('id, invoice_number, date, due_date, total_amount, amount_paid, status')
        .eq('company_id', companyId)
        .in('id', invoiceIds);

      const invMap = new Map((invoices || []).map(i => [i.id, i]));

      allocations = rawAllocs.map(alloc => {
        const inv     = invMap.get(alloc.invoice_id) || {};
        const total   = parseFloat(inv.total_amount || 0);
        const paid    = parseFloat(inv.amount_paid   || 0);
        const applied = parseFloat(alloc.amount_applied || 0);
        return {
          invoiceId:         alloc.invoice_id,
          invoiceNumber:     inv.invoice_number     || `#${alloc.invoice_id}`,
          invoiceDate:       inv.date               || null,
          invoiceDueDate:    inv.due_date           || null,
          invoiceTotal:      total,
          invoiceAmountPaid: paid,
          invoiceOutstanding: Math.max(0, Math.round((total - paid) * 100) / 100),
          invoiceStatus:     inv.status             || null,
          amountApplied:     applied,
        };
      });
    }

    // ── 4. Fetch journal lines with account codes + names ────────────────────
    async function enrichJournalWithLines(journal) {
      if (!journal) return null;
      const { data: lines } = await supabase
        .from('journal_lines')
        .select('id, account_id, line_number, description, debit, credit')
        .eq('journal_id', journal.id)
        .order('line_number', { ascending: true });

      const accountIds = [...new Set((lines || []).map(l => l.account_id).filter(Boolean))];
      let accountMap = {};
      if (accountIds.length > 0) {
        const { data: accts } = await supabase
          .from('accounts')
          .select('id, code, name')
          .eq('company_id', companyId)
          .in('id', accountIds);
        (accts || []).forEach(a => { accountMap[a.id] = a; });
      }

      return {
        ...journal,
        lines: (lines || []).map(l => ({
          ...l,
          accountCode: accountMap[l.account_id]?.code || null,
          accountName: accountMap[l.account_id]?.name || null,
        })),
      };
    }

    const [originalJournal, reversalJournal] = await Promise.all([
      enrichJournalWithLines(journalResult.data || null),
      enrichJournalWithLines(revJournalResult.data || null),
    ]);

    // ── 5. Build response ────────────────────────────────────────────────────
    const createdByUser  = createdByResult.data  || null;
    const reversedByUser = reversedByResult.data || null;
    const bankAcct       = bankAcctResult.data   || null;

    res.json({
      payment: {
        ...payment,
        bankLedgerAccountCode: bankAcct?.code || null,
        bankLedgerAccountName: bankAcct?.name || null,
        createdByUserName:     createdByUser?.full_name || createdByUser?.username || null,
        createdByUsername:     createdByUser?.username  || null,
        reversedByUserName:    reversedByUser?.full_name || reversedByUser?.username || null,
        reversedByUsername:    reversedByUser?.username  || null,
      },
      allocations,
      journal:        originalJournal,
      reversalJournal,
    });
  } catch (err) {
    console.error('GET /customer-invoices/payments/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Reverse / Void Customer Payment ─────────────────────────────────────────
// POST /payments/:id/void
//
// Formal reversal path for customer payments (ACC-HARDEN-020).
//
// Execution order (DB-first):
//   1. Fetch payment — company-scoped
//   2. Guard: already reversed  → 409 PAYMENT_ALREADY_REVERSED
//   3. Load allocations for this payment from customer_payment_allocations
//   4. Atomic pg transaction (BEGIN/COMMIT/ROLLBACK):
//      a. Lock payment row FOR UPDATE — re-check is_reversed under lock
//      b. For each allocation: lock customer_invoices row FOR UPDATE
//      c. Reduce invoice amount_paid + recalculate status (paid/part_paid/sent)
//      d. UPDATE customer_payments SET is_reversed=true WHERE is_reversed=false
//         (rowCount=0 → concurrent reversal guard → ROLLBACK → 409)
//      e. COMMIT
//   5. Reverse GL journal (JournalService — concurrency-safe per ACC-HARDEN-017)
//      If GL reversal fails: payment is already marked reversed (AR correct),
//      GL requires manual correction. CRITICAL audit event logged.
//   6. Link reversal_journal_id back to payment row
//   7. Audit log — CUSTOMER_PAYMENT_REVERSED
//
// Why DB before GL:
//   If DB transaction fails → GL untouched → clean state.
//   If DB commits but GL fails → payment marked reversed, AR/invoices correct,
//   GL requires manual correction. Retry sees is_reversed=true → 409 (no dup).
//
// Permission: ar.payment.void (admin + accountant only)

router.post('/payments/:id/void', authenticate, hasPermission('ar.payment.void'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const paymentId = parseInt(req.params.id);
  const { reason } = req.body;
  const reqUserId  = userId(req);

  if (isNaN(paymentId)) {
    return res.status(400).json({ error: 'Invalid payment ID' });
  }

  try {
    // ── 1. Fetch payment — company-scoped ────────────────────────────────────
    const { data: payment, error: fetchErr } = await supabase
      .from('customer_payments')
      .select('*')
      .eq('id', paymentId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!payment) {
      return res.status(404).json({ error: 'Customer payment not found', errorCode: 'PAYMENT_NOT_FOUND' });
    }

    // ── 2. Already-reversed guard ────────────────────────────────────────────
    if (payment.is_reversed) {
      await AuditLogger.log({
        companyId,
        actorType: 'USER', actorId: reqUserId,
        actionType: 'CUSTOMER_PAYMENT_REVERSAL_BLOCKED',
        entityType: 'CUSTOMER_PAYMENT', entityId: paymentId,
        beforeJson: null,
        afterJson: { paymentId, reasonCode: 'PAYMENT_ALREADY_REVERSED' },
        reason: 'Customer payment reversal blocked: already reversed',
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(409).json({ error: 'Payment has already been reversed', errorCode: 'PAYMENT_ALREADY_REVERSED' });
    }

    // ── 3. Load allocations for this payment ─────────────────────────────────
    // customer_payment_allocations uses amount_applied (not amount as in AP)
    const { data: allocations, error: allocFetchErr } = await supabase
      .from('customer_payment_allocations')
      .select('invoice_id, amount_applied')
      .eq('payment_id', paymentId);

    if (allocFetchErr) throw new Error(allocFetchErr.message);

    // ── 4. Atomic DB transaction: reverse allocations + mark payment ──────────
    // DB-first: if this fails GL is untouched (clean state).
    // If DB commits but GL fails: AR/invoice balances are correct;
    // only the GL bank/AR entries require manual correction.
    const revClient = await db.getClient();
    try {
      await revClient.query('BEGIN');

      // Lock the payment row — prevents concurrent reversal from proceeding
      const { rows: payLock } = await revClient.query(
        `SELECT id, is_reversed
           FROM customer_payments
          WHERE id = $1 AND company_id = $2
          FOR UPDATE`,
        [paymentId, companyId]
      );
      if (!payLock.length || payLock[0].is_reversed) {
        await revClient.query('ROLLBACK');
        return res.status(409).json({ error: 'Payment has already been reversed', errorCode: 'PAYMENT_ALREADY_REVERSED' });
      }

      // For each allocated invoice: lock row, reduce amount_paid, recalculate status
      for (const alloc of (allocations || [])) {
        const allocAmount  = parseFloat(alloc.amount_applied);
        const allocInvId   = parseInt(alloc.invoice_id);

        const { rows: invLock } = await revClient.query(
          `SELECT id, amount_paid, total_amount
             FROM customer_invoices
            WHERE id = $1 AND company_id = $2
            FOR UPDATE`,
          [allocInvId, companyId]
        );
        if (!invLock.length) continue; // invoice may have been voided

        const inv           = invLock[0];
        const newAmountPaid = Math.max(
          0,
          Math.round((parseFloat(inv.amount_paid) - allocAmount) * 100) / 100
        );
        const totalIncVat   = parseFloat(inv.total_amount);
        const newStatus     = newAmountPaid >= totalIncVat - 0.005 ? 'paid'
                            : newAmountPaid > 0                    ? 'part_paid'
                            : 'sent';

        await revClient.query(
          `UPDATE customer_invoices
              SET amount_paid = $1, balance_due = $2, status = $3, updated_at = NOW()
            WHERE id = $4 AND company_id = $5`,
          [newAmountPaid, Math.round((totalIncVat - newAmountPaid) * 100) / 100, newStatus, allocInvId, companyId]
        );
      }

      // Mark payment as reversed — conditional UPDATE (is_reversed = false predicate)
      // guards against any concurrent request that slipped past guard 2.
      const markResult = await revClient.query(
        `UPDATE customer_payments
            SET is_reversed         = true,
                reversed_at         = NOW(),
                reversed_by_user_id = $1,
                reversal_reason     = $2
          WHERE id = $3 AND company_id = $4
            AND is_reversed = false`,
        [reqUserId, reason || null, paymentId, companyId]
      );
      if (markResult.rowCount === 0) {
        await revClient.query('ROLLBACK');
        return res.status(409).json({ error: 'Payment was concurrently reversed by another request', errorCode: 'PAYMENT_ALREADY_REVERSED' });
      }

      await revClient.query('COMMIT');
    } catch (txErr) {
      await revClient.query('ROLLBACK');
      throw txErr;
    } finally {
      revClient.release();
    }

    // ── 5. Reverse GL journal ─────────────────────────────────────────────────
    // Runs AFTER the DB commit. A GL failure leaves a known auditable state:
    // payment marked reversed (AR + invoice balances correct), GL needs manual fix.
    let reversalJournalId = null;
    if (payment.journal_id) {
      try {
        const reversalJournal = await JournalService.reverseJournal(
          payment.journal_id,
          companyId,
          reqUserId,
          reason ? `Payment reversal: ${reason}` : `Customer payment ${paymentId} reversed`
        );
        reversalJournalId = reversalJournal.id;

        // Link reversal journal back to the payment record (best-effort)
        await supabase
          .from('customer_payments')
          .update({ reversal_journal_id: reversalJournalId })
          .eq('id', paymentId)
          .eq('company_id', companyId);

      } catch (glErr) {
        // GL reversal failed after the DB commit. Payment is marked reversed
        // and invoice balances are correct, but the bank/AR GL entries still
        // show the original receipt. Manual journal reversal required.
        console.error(`[CustomerAR] CRITICAL: payment ${paymentId} marked reversed but GL journal ${payment.journal_id} reversal failed:`, glErr.message);
        await AuditLogger.log({
          companyId,
          actorType: 'SYSTEM', actorId: reqUserId,
          actionType: 'CUSTOMER_PAYMENT_REVERSAL_GL_FAILED',
          entityType: 'CUSTOMER_PAYMENT', entityId: paymentId,
          beforeJson: { journalId: payment.journal_id },
          afterJson: { paymentMarkedReversed: true, glReversalError: glErr.message },
          reason: `CRITICAL: Payment ${paymentId} DB-reversed but GL journal ${payment.journal_id} reversal failed. Manual GL correction required.`,
          ipAddress: req.ip, userAgent: req.get('user-agent'),
        });
        return res.json({
          message: 'Payment reversed. WARNING: GL journal reversal failed — manual correction of journal ' + payment.journal_id + ' is required.',
          reversalJournalId: null,
          glReversalFailed:  true,
          journalId:         payment.journal_id,
        });
      }
    }

    // ── 6. Audit log ──────────────────────────────────────────────────────────
    await AuditLogger.log({
      companyId,
      actorType: 'USER',
      actorId:   reqUserId,
      actionType: 'CUSTOMER_PAYMENT_REVERSED',
      entityType: 'CUSTOMER_PAYMENT',
      entityId:   paymentId,
      beforeJson: {
        is_reversed:     false,
        journalId:       payment.journal_id || null,
        amount:          parseFloat(payment.amount),
        allocationCount: (allocations || []).length,
      },
      afterJson: {
        is_reversed:      true,
        reversalJournalId,
        reversalReason:   reason || null,
        glReversed:       !!reversalJournalId,
      },
      reason:    reason || 'Customer payment reversed',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ message: 'Customer payment reversed', reversalJournalId });
  } catch (err) {
    console.error('POST /customer-invoices/payments/:id/void error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Aged Debtors Report ──────────────────────────────────────────────────────
// GET /aging — groups outstanding customer invoices by customer and buckets them
// into ageing periods.  Null due_date → current (with noDueDateCount flag).
// Grouping: customer_id when set, fallback to normalised customer_name.

async function computeAgedDebtors(companyId, asAt, customerIdFilter, includeZero) {
  const asAtDate = new Date(asAt + 'T00:00:00Z');
  {
    let q = supabase
      .from('customer_invoices')
      .select('id, customer_id, invoice_number, date, due_date, total_amount, amount_paid')
      .eq('company_id', companyId)
      .not('status', 'in', '("draft","void","cancelled")');

    if (customerIdFilter) q = q.eq('customer_id', customerIdFilter);

    const { data: rawInvoices, error } = await q;
    if (error) throw new Error(error.message);
    const invoices = await attachCustomerNames(companyId, rawInvoices || []);

    const byCustomer = {};

    for (const inv of invoices) {
      const outstanding = Math.round((parseFloat(inv.total_amount) - parseFloat(inv.amount_paid || 0)) * 100) / 100;
      if (!includeZero && outstanding <= 0.005) continue;

      // Every invoice resolves to a real customer_id (resolveCustomerId at
      // create/update time) — group by that; the name-fallback grouping key
      // this used to need for "name-only" invoices no longer applies since
      // there's no customer_name column left to fall back to.
      const groupKey = inv.customer_id ? `id:${inv.customer_id}` : 'unknown';

      if (!byCustomer[groupKey]) {
        byCustomer[groupKey] = {
          customerId:     inv.customer_id || null,
          customerName:   inv.customer_name,
          current:        0,
          days30:         0,
          days60:         0,
          days90:         0,
          days90plus:     0,
          total:          0,
          invoiceCount:   0,
          noDueDateCount: 0,
        };
      }

      const entry = byCustomer[groupKey];
      entry.invoiceCount++;
      entry.total = Math.round((entry.total + outstanding) * 100) / 100;

      if (!inv.due_date) {
        entry.current = Math.round((entry.current + outstanding) * 100) / 100;
        entry.noDueDateCount++;
      } else {
        const dueDate    = new Date(inv.due_date + 'T00:00:00Z');
        const msPerDay   = 1000 * 60 * 60 * 24;
        const daysOverdue = Math.floor((asAtDate - dueDate) / msPerDay);

        if      (daysOverdue <= 0)  entry.current    = Math.round((entry.current    + outstanding) * 100) / 100;
        else if (daysOverdue <= 30) entry.days30     = Math.round((entry.days30     + outstanding) * 100) / 100;
        else if (daysOverdue <= 60) entry.days60     = Math.round((entry.days60     + outstanding) * 100) / 100;
        else if (daysOverdue <= 90) entry.days90     = Math.round((entry.days90     + outstanding) * 100) / 100;
        else                        entry.days90plus = Math.round((entry.days90plus + outstanding) * 100) / 100;
      }
    }

    const customers = Object.values(byCustomer).sort((a, b) =>
      (a.customerName || '').localeCompare(b.customerName || '')
    );

    const totals = customers.reduce((acc, c) => ({
      current:    Math.round((acc.current    + c.current)    * 100) / 100,
      days30:     Math.round((acc.days30     + c.days30)     * 100) / 100,
      days60:     Math.round((acc.days60     + c.days60)     * 100) / 100,
      days90:     Math.round((acc.days90     + c.days90)     * 100) / 100,
      days90plus: Math.round((acc.days90plus + c.days90plus) * 100) / 100,
      total:      Math.round((acc.total      + c.total)      * 100) / 100,
    }), { current: 0, days30: 0, days60: 0, days90: 0, days90plus: 0, total: 0 });

    return { asAt, customers, totals };
  }
}

router.get('/aging', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  try {
    const asAt = req.query.asAt || new Date().toISOString().slice(0, 10);
    const customerIdFilter = req.query.customerId ? parseInt(req.query.customerId) : null;
    const includeZero = req.query.includeZero === 'true';
    const result = await computeAgedDebtors(req.companyId, asAt, customerIdFilter, includeZero);
    res.json(result);
  } catch (err) {
    console.error('GET /customer-invoices/aging error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /aging/pdf
 * Same computeAgedDebtors() as /aging above, rendered as a downloadable PDF.
 */
router.get('/aging/pdf', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  try {
    const asAt = req.query.asAt || new Date().toISOString().slice(0, 10);
    const customerIdFilter = req.query.customerId ? parseInt(req.query.customerId) : null;
    const includeZero = req.query.includeZero === 'true';
    const { customers, totals } = await computeAgedDebtors(req.companyId, asAt, customerIdFilter, includeZero);

    const { data: company } = await supabase
      .from('companies')
      .select('company_name, trading_name, registration_number, vat_number')
      .eq('id', req.companyId)
      .maybeSingle();

    const pdfBuffer = await generateAgingPdf({ company: company || {}, asAt, title: 'AGED DEBTORS', customers, totals });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="aged-debtors-${asAt}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('GET /customer-invoices/aging/pdf error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Credit Notes for Invoice (ACC-CORE-036) ─────────────────────────────
// Returns all credit notes linked to a specific invoice.
// Mounted on customer-invoices so the invoice detail page can call
//   GET /api/accounting/customer-invoices/:id/credit-notes
// without any cross-router dependency.
//
// NOT verified against information_schema.columns during the 2026-08-16
// customer_invoices/customer_invoice_lines schema-drift fix (see the note
// above this file's other routes) — this queries a DIFFERENT table,
// customer_credit_notes, which was untouched by that audit. If this route
// errors with "column does not exist", check its real columns the same way
// (SELECT column_name FROM information_schema.columns WHERE table_name =
// 'customer_credit_notes') before assuming the fix — don't guess again.

router.get('/:id/credit-notes', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);

  // Verify the invoice itself belongs to this company first (tenant safety)
  const { data: inv } = await supabase
    .from('customer_invoices')
    .select('id')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  const { data, error } = await supabase
    .from('customer_credit_notes')
    .select('id, credit_note_number, credit_note_date, status, total_inc_vat, reason')
    .eq('company_id', companyId)
    .eq('source_invoice_id', invoiceId)
    .order('id', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ creditNotes: data || [] });
});

module.exports = router;
