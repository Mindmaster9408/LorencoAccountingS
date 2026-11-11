/**
 * ============================================================================
 * Customer Invoice Core — shared AR invoice logic
 * ============================================================================
 * Single home for the customer-invoice operations that more than one caller
 * needs (CLAUDE.md "Shared > duplicated"):
 *
 *   - routes/customer-invoices.js  — the user clicking Post / Send
 *   - services/recurringInvoiceService.js — monthly billing plans posting and
 *     emailing instalments automatically (migration 178)
 *
 * postCustomerInvoice / emailCustomerInvoice were lifted VERBATIM out of the
 * POST /:id/post and POST /:id/send route handlers (2026-11-11) — same
 * guards, same audit events, same status codes — so a system-run post and a
 * user-run post can never drift apart. Both return { status, body } instead
 * of writing to `res`, so the route maps it 1:1 and the engine inspects it.
 *
 * The helper block below (calcLineVAT … attachCustomerNames) was moved here
 * unchanged from the top of customer-invoices.js.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../../config/database');
const JournalService = require('./journalService');
const AuditLogger = require('./auditLogger');
const { generateInvoicePdf } = require('./invoicePdfService');
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
// ─── Post a draft invoice to the General Ledger ──────────────────────────────
//
// DR AR (1100) / CR Revenue (line.account_id) / CR VAT Output (2300).
// ctx = { companyId, invoiceId, actorId, actorType ('USER'|'SYSTEM'), ipAddress, userAgent }
// Returns { status, body }.

async function postCustomerInvoice(ctx) {
  const { companyId, invoiceId, actorId = null, actorType = 'USER', ipAddress = null, userAgent = null } = ctx;
  const audit = (fields) => AuditLogger.log({ companyId, actorType, actorId, ipAddress, userAgent, ...fields });

  const { data: invoice, error: invErr } = await supabase
    .from('customer_invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (invErr) throw new Error(invErr.message);
  if (!invoice) return { status: 404, body: { error: 'Invoice not found' } };
  if (invoice.status !== 'draft') {
    await audit({
      actionType: 'CUSTOMER_INVOICE_POST_BLOCKED',
      entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
      beforeJson: null,
      afterJson: { invoiceId, status: invoice.status, reasonCode: 'NOT_DRAFT', reasonMessage: `Invoice is already ${invoice.status}` },
      reason: `Customer invoice post blocked: status is ${invoice.status}`,
    });
    return { status: 409, body: { error: `Invoice is already ${invoice.status}` } };
  }

  // Double-post guard: journal_id already set means a GL entry exists for this invoice.
  // Block immediately — re-running the post would create a second GL entry.
  if (invoice.journal_id != null) {
    await audit({
      actionType: 'CUSTOMER_INVOICE_DOUBLE_POST_BLOCKED',
      entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
      beforeJson: null,
      afterJson: { invoiceId, journalId: invoice.journal_id, status: invoice.status, reasonCode: 'JOURNAL_ALREADY_LINKED' },
      reason: 'Customer invoice double-post blocked: journal already linked',
    });
    return {
      status: 409,
      body: { error: 'Invoice already has a linked journal and cannot be posted again.', journalId: invoice.journal_id },
    };
  }

  // Billing-option guard (migration 178). An invoice that offers the client
  // "annual or monthly" must not be posted for the full annual amount until
  // the client's choice is recorded — if they then chose monthly, the annual
  // revenue would already be in the GL. Only affects invoices where the
  // option was explicitly switched on (default off).
  if (invoice.billing_option_enabled === true && !invoice.billing_choice) {
    return {
      status: 409,
      body: {
        error: "This invoice offers the client an annual or monthly option. Record the client's choice (Annual or Monthly) before posting.",
        errorCode: 'BILLING_CHOICE_REQUIRED',
      },
    };
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
    return {
      status: 422,
      body: { error: 'Accounts Receivable account (code 1100) not found in chart of accounts. Please provision a base chart of accounts first.' },
    };
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
      return {
        status: 422,
        body: { error: 'VAT Output account (code 2300) not found. Please provision the base chart of accounts before posting VAT-bearing customer invoices.' },
      };
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
    createdByUserId:  actorId,
    lines:            glLines,
  });
  await JournalService.postJournal(glJournal.id, companyId, actorId);

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
        glJournal.id, companyId, actorId,
        `Auto-reversal: invoice ${invoiceId} status update failed after GL post`
      );
      await audit({
        actorType: 'SYSTEM',
        actionType: 'CUSTOMER_INVOICE_POST_FAILED_REVERSED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: { status: 'draft' },
        afterJson: { invoiceId, journalId: glJournal.id, updateError: updErr.message, reversalResult: 'reversed' },
        reason: `Invoice post failed after GL creation. Journal ${glJournal.id} reversed. Invoice remains draft.`,
      });
      return {
        status: 500,
        body: { error: 'Invoice posting failed after GL journal creation. The journal was reversed to prevent double posting. Please retry.' },
      };
    } catch (revErr) {
      console.error(`[CustomerAR] CRITICAL: journal ${glJournal.id} posted for invoice ${invoiceId}, status update failed, AND reversal failed:`, revErr.message);
      await audit({
        actorType: 'SYSTEM',
        actionType: 'CUSTOMER_INVOICE_POST_FAILED_REVERSAL_FAILED',
        entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
        beforeJson: { status: 'draft' },
        afterJson: { invoiceId, journalId: glJournal.id, updateError: updErr.message, reversalError: revErr.message },
        reason: `CRITICAL: Invoice post failed AND reversal failed. Journal ${glJournal.id} may be dangling. Manual investigation required.`,
      });
      return {
        status: 500,
        body: { error: 'Invoice posting failed after GL journal creation and automatic reversal failed. Manual investigation required.', journalId: glJournal.id },
      };
    }
  }

  await audit({
    actionType: 'CUSTOMER_INVOICE_POSTED',
    entityType: 'CUSTOMER_INVOICE',
    entityId: invoiceId,
    beforeJson: { status: 'draft' },
    afterJson: {
      status: 'sent',
      journalId: glJournal.id,
      totalIncVat: parseFloat(invoice.total_amount),
      customerName: invoice.customer_name,
      ...(invoice.recurring_plan_id ? { recurringPlanId: invoice.recurring_plan_id, instalmentNo: invoice.recurring_instalment_no } : {}),
    },
    reason: actorType === 'SYSTEM' ? 'Customer invoice posted to GL automatically (monthly billing plan)' : 'Customer invoice posted to GL',
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

  return { status: 200, body: { message: 'Invoice posted to General Ledger', journalId: glJournal.id } };
}

// ─── Build the invoice PDF (shared by Send and the PDF download) ─────────────

async function buildInvoicePdf(companyId, invoice) {
  const [{ data: customer, error: custErr }, { data: lines, error: linesErr }, { data: company, error: companyErr }] = await Promise.all([
    supabase.from('customers').select('id, name, email, vat_number')
      .eq('id', invoice.customer_id).eq('company_id', companyId).maybeSingle(),
    supabase.from('customer_invoice_lines').select('*').eq('invoice_id', invoice.id).order('id'),
    supabase.from('companies')
      .select('company_name, trading_name, registration_number, vat_number, address_street, address_suburb, address_city, contact_email, contact_phone, logo_url, bank_name, bank_account_holder, bank_account_number, bank_branch_code')
      .eq('id', companyId).maybeSingle(),
  ]);
  if (custErr) throw new Error(custErr.message);
  if (linesErr) throw new Error(linesErr.message);
  if (companyErr) throw new Error(companyErr.message);

  // Monthly instalments show "Instalment n of N" — needs the plan's size.
  let plan = null;
  if (invoice.recurring_plan_id) {
    const { data } = await supabase.from('customer_invoice_recurring_plans')
      .select('instalments_total, annual_total').eq('id', invoice.recurring_plan_id).eq('company_id', companyId).maybeSingle();
    plan = data || null;
  }

  const pdfBuffer = await generateInvoicePdf(invoice, lines || [], company || {}, customer, { plan });
  return { pdfBuffer, customer, company };
}

// ─── Email a posted invoice to the customer ──────────────────────────────────
//
// Separate, additive fact from `status` — GL-posting flips status to 'sent'
// as a bookkeeping transition unrelated to whether anyone actually emailed
// the customer (see 160_customer_invoice_email_tracking.sql). Sending is
// allowed any number of times (re-send is a normal, expected action).
// ctx = { companyId, invoiceId, recipientOverride, actorId, actorType, ipAddress, userAgent }

async function emailCustomerInvoice(ctx) {
  const { companyId, invoiceId, recipientOverride = null, actorId = null, actorType = 'USER', ipAddress = null, userAgent = null } = ctx;

  const { data: invoice, error: invErr } = await supabase
    .from('customer_invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (invErr) throw new Error(invErr.message);
  if (!invoice) return { status: 404, body: { error: 'Invoice not found' } };
  if (invoice.status === 'draft') {
    return { status: 409, body: { error: 'Post this invoice to the General Ledger before emailing it to the customer.' } };
  }

  const { pdfBuffer, customer, company } = await buildInvoicePdf(companyId, invoice);
  if (!customer) return { status: 404, body: { error: 'Customer not found' } };

  // Explicit override lets a one-off send go to a different address
  // (e.g. the customer asked for a copy at a second address) without
  // requiring the customer record itself to be edited first.
  const recipientEmail = (recipientOverride || customer.email || '').trim();
  if (!recipientEmail) {
    return {
      status: 400,
      body: {
        error: `${customer.name} has no email address on file. Add one to the customer record, or provide one for this send.`,
        errorCode: 'NO_CUSTOMER_EMAIL',
      },
    };
  }

  const emailResult = await sendEmail({
    to: recipientEmail,
    subject: `Invoice ${invoice.invoice_number} from ${company?.trading_name || company?.company_name || 'us'}`,
    html: `<p>Dear ${escapeHtml(customer.name)},</p><p>Please find attached invoice ${escapeHtml(invoice.invoice_number)} for ${escapeHtml(String(invoice.total_amount))}.</p><p>Kind regards</p>`,
    body: `Dear ${customer.name},\n\nPlease find attached invoice ${invoice.invoice_number}.\n\nKind regards`,
    attachments: [{ filename: `Invoice-${invoice.invoice_number}.pdf`, content: pdfBuffer }],
    // One sending mailbox serves every company: show this company as the sender and
    // send the customer's replies to this company's own email (Company Profile).
    fromName: company?.trading_name || company?.company_name || undefined,
    replyTo: company?.contact_email || undefined,
  });

  if (!emailResult.success) {
    return { status: 502, body: { error: emailResult.message || 'Failed to send email.' } };
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
    actorType, actorId,
    actionType: 'CUSTOMER_INVOICE_EMAILED',
    entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
    beforeJson: null,
    afterJson: { invoiceId, recipientEmail, emailCount: (invoice.email_count || 0) + 1 },
    reason: actorType === 'SYSTEM' ? 'Invoice emailed to customer automatically (monthly billing plan)' : 'Invoice emailed to customer',
    ipAddress, userAgent,
  });

  return {
    status: 200,
    body: { message: `Invoice emailed to ${recipientEmail}`, emailedAt: updated?.emailed_at || new Date().toISOString(), emailedTo: recipientEmail },
  };
}

module.exports = {
  calcLineVAT,
  escapeHtml,
  findAccountByCode,
  userId,
  validateCustomerId,
  validateLineAccountIds,
  resolveCustomerId,
  pushInvoiceToLinkedSupplier,
  attachCustomerNames,
  postCustomerInvoice,
  emailCustomerInvoice,
  buildInvoicePdf,
};
