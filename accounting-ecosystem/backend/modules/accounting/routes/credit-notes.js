'use strict';

/**
 * ============================================================================
 * Customer Credit Notes Routes (ACC-CORE-036)
 * ============================================================================
 * Mounted at /api/accounting/credit-notes
 *
 * Business rules enforced here:
 *   - NO modification of historical posted invoices — ever
 *   - NO deletion of posted credit notes — only void via reversal journal
 *   - Credit notes are append-only accounting events
 *   - source_invoice_id always cross-checked against company_id (tenant safety)
 *   - Double-post guard on every credit note
 *   - VAT period lock checked before voiding posted credit notes
 *   - NO localStorage — all state is DB-authoritative
 *
 * GL posting (reversing vs invoice):
 *   Invoice:     DR AR(1100) / CR Revenue(per line) / CR VAT Output(2300)
 *   Credit Note: DR Revenue(per line) / DR VAT Output(2300) / CR AR(1100)
 *
 * Routes:
 *   GET  /                          — list (filters: status, customerId, fromDate, toDate)
 *   GET  /:id                       — detail with lines + source invoice stub
 *   POST /                          — create draft (standalone or invoice-linked)
 *   POST /from-invoice/:invoiceId   — create full-credit draft from invoice
 *   PUT  /:id                       — update draft only
 *   POST /:id/post                  — post to GL (reversing entries)
 *   POST /:id/void                  — void draft (soft) or posted (reversal journal)
 *   GET  /by-invoice/:invoiceId     — credit notes linked to a specific invoice
 * ============================================================================
 */

const express        = require('express');
const router         = express.Router();
const { supabase, db } = require('../../../config/database');
const JournalService = require('../services/journalService');
const AuditLogger    = require('../services/auditLogger');
const { authenticate, hasPermission } = require('../middleware/auth');

// ─── Shared helpers (mirrors customer-invoices.js exactly) ──────────────────

function userId(req) {
  return req.user && req.user.userId ? req.user.userId : (req.user && req.user.id ? req.user.id : null);
}

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
  } catch (_) { return null; }
}

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

// Process lines array into normalised objects with calculated VAT
function processLines(lines, vatInclusive) {
  return (lines || []).map((l, i) => {
    const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
      l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
    );
    return {
      description: l.description || '',
      accountId:   l.accountId  ? parseInt(l.accountId)  : null,
      lineType:    l.lineType === 'item' ? 'item' : 'account',
      itemId:      l.itemId    ? parseInt(l.itemId)    : null,
      quantity:    parseFloat(l.quantity)  || 1,
      unitPrice:   parseFloat(l.unitPrice) || 0,
      vatRate:     l.vatRate != null ? parseFloat(l.vatRate) : 15,
      subtotalExVat, vatAmount, totalIncVat,
      sortOrder: i,
    };
  });
}

function sumLines(processedLines) {
  return processedLines.reduce(
    (acc, l) => ({
      subtotalExVat: acc.subtotalExVat + l.subtotalExVat,
      vatAmount:     acc.vatAmount     + l.vatAmount,
      totalIncVat:   acc.totalIncVat   + l.totalIncVat,
    }),
    { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
  );
}

// Bulk-insert credit note lines inside an already-open pg client
async function insertLines(pgClient, creditNoteId, processedLines) {
  if (!processedLines.length) return;
  const lineVals   = [];
  const lineParams = [];
  let p = 1;
  for (const l of processedLines) {
    lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
    lineParams.push(
      creditNoteId, l.sortOrder, l.lineType, l.itemId || null, l.accountId || null,
      l.description, l.quantity, l.unitPrice, l.vatRate,
      l.subtotalExVat, l.vatAmount, l.totalIncVat
    );
  }
  await pgClient.query(
    `INSERT INTO customer_credit_note_lines
       (credit_note_id, sort_order, line_type, item_id, account_id, description,
        quantity, unit_price, vat_rate, subtotal_ex_vat, vat_amount, total_inc_vat)
     VALUES ${lineVals.join(',')}`,
    lineParams
  );
}

// Fetch lines with account details joined
async function fetchLines(creditNoteId) {
  const { data, error } = await supabase
    .from('customer_credit_note_lines')
    .select('*, accounts!account_id(code, name)')
    .eq('credit_note_id', creditNoteId)
    .order('sort_order');
  if (error) throw new Error(error.message);
  return (data || []).map(l => ({
    ...l,
    account_code: l.accounts?.code || null,
    account_name: l.accounts?.name || null,
    accounts: undefined,
  }));
}

// Generate next CN number for a company
async function nextCNNumber(companyId) {
  const { count } = await supabase
    .from('customer_credit_notes')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  return `CN-${String((count || 0) + 1).padStart(4, '0')}`;
}

// ─── GET / — List credit notes ───────────────────────────────────────────────

router.get('/', authenticate, hasPermission('ar.credit_note.view'), async (req, res) => {
  const companyId = req.companyId;
  const { status, customerId, fromDate, toDate, sourceInvoiceId, limit = 100, offset = 0 } = req.query;

  let query = supabase
    .from('customer_credit_notes')
    .select('*')
    .eq('company_id', companyId)
    .order('credit_note_date', { ascending: false })
    .order('id', { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (status)          query = query.eq('status', status);
  if (customerId)      query = query.eq('customer_id', parseInt(customerId));
  if (fromDate)        query = query.gte('credit_note_date', fromDate);
  if (toDate)          query = query.lte('credit_note_date', toDate);
  if (sourceInvoiceId) query = query.eq('source_invoice_id', parseInt(sourceInvoiceId));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ creditNotes: data || [] });
});

// ─── GET /by-invoice/:invoiceId — CNs linked to an invoice ──────────────────

router.get('/by-invoice/:invoiceId', authenticate, hasPermission('ar.credit_note.view'), async (req, res) => {
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.invoiceId);

  // Verify invoice belongs to this company (tenant safety)
  const { data: inv } = await supabase
    .from('customer_invoices')
    .select('id')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  const { data, error } = await supabase
    .from('customer_credit_notes')
    .select('id,credit_note_number,credit_note_date,status,total_inc_vat,reason')
    .eq('company_id', companyId)
    .eq('source_invoice_id', invoiceId)
    .order('id', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ creditNotes: data || [] });
});

// ─── GET /:id — Credit note detail ──────────────────────────────────────────

router.get('/:id', authenticate, hasPermission('ar.credit_note.view'), async (req, res) => {
  const companyId    = req.companyId;
  const creditNoteId = parseInt(req.params.id);

  const { data: cn, error } = await supabase
    .from('customer_credit_notes')
    .select('*')
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (error)  return res.status(500).json({ error: error.message });
  if (!cn)    return res.status(404).json({ error: 'Credit note not found' });

  const lines = await fetchLines(creditNoteId);

  // Fetch source invoice stub (if linked)
  let sourceInvoice = null;
  if (cn.source_invoice_id) {
    const { data: inv } = await supabase
      .from('customer_invoices')
      .select('id, invoice_number, invoice_date, total_inc_vat, status')
      .eq('id', cn.source_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle();
    sourceInvoice = inv || null;
  }

  res.json({ creditNote: { ...cn, lines, sourceInvoice } });
});

// ─── POST / — Create draft credit note ──────────────────────────────────────

router.post('/', authenticate, hasPermission('ar.credit_note.create'), async (req, res) => {
  const companyId = req.companyId;
  const {
    customerId, customerName, creditNoteNumber, creditNoteDate,
    reason, notes, sourceInvoiceId, vatInclusive, lines,
  } = req.body;

  if (!customerName)  return res.status(400).json({ error: 'Customer name is required' });
  if (!creditNoteDate) return res.status(400).json({ error: 'Credit note date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  // Tenant guard: customer_id must belong to this company
  if (customerId) {
    const custOk = await validateCustomerId(companyId, customerId);
    if (custOk === false) {
      return res.status(403).json({ error: 'Customer not found or does not belong to this company.', errorCode: 'CUSTOMER_TENANT_VIOLATION' });
    }
  }

  // Tenant guard: all line account_ids must belong to this company
  const foreignAccts = await validateLineAccountIds(companyId, lines);
  if (foreignAccts) {
    return res.status(403).json({ error: 'One or more line item accounts do not belong to this company.', errorCode: 'ACCOUNT_TENANT_VIOLATION' });
  }

  // Tenant guard: source_invoice_id must belong to this company
  if (sourceInvoiceId) {
    const { data: srcInv } = await supabase
      .from('customer_invoices')
      .select('id, company_id')
      .eq('id', parseInt(sourceInvoiceId))
      .eq('company_id', companyId)
      .maybeSingle();
    if (!srcInv) {
      return res.status(403).json({ error: 'Source invoice not found or does not belong to this company.', errorCode: 'INVOICE_TENANT_VIOLATION' });
    }
  }

  // Duplicate CN number guard
  let cnNum = creditNoteNumber;
  if (cnNum && cnNum.trim()) {
    const { data: dup } = await supabase
      .from('customer_credit_notes')
      .select('id')
      .eq('company_id', companyId)
      .eq('credit_note_number', cnNum.trim())
      .not('status', 'eq', 'void')
      .maybeSingle();
    if (dup) {
      return res.status(409).json({ error: `Credit note number '${cnNum.trim()}' already exists`, errorCode: 'DUPLICATE_CN', existingId: dup.id });
    }
  } else {
    cnNum = await nextCNNumber(companyId);
  }

  const processedLines = processLines(lines, vatInclusive);
  const totals = sumLines(processedLines);

  const dbClient = await db.getClient();
  let creditNote;
  try {
    await dbClient.query('BEGIN');

    const hdr = await dbClient.query(
      `INSERT INTO customer_credit_notes
         (company_id, customer_id, customer_name, credit_note_number, credit_note_date,
          status, reason, notes, source_invoice_id,
          subtotal_ex_vat, vat_amount, total_inc_vat, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        companyId,
        customerId ? parseInt(customerId) : null,
        customerName,
        cnNum,
        creditNoteDate,
        reason || null,
        notes || null,
        sourceInvoiceId ? parseInt(sourceInvoiceId) : null,
        totals.subtotalExVat,
        totals.vatAmount,
        totals.totalIncVat,
        userId(req),
      ]
    );
    creditNote = hdr.rows[0];

    await insertLines(dbClient, creditNote.id, processedLines);
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    dbClient.release();
    console.error('[credit-notes] POST / error:', err);
    return res.status(500).json({ error: err.message });
  }
  dbClient.release();

  await AuditLogger.log({
    companyId,
    actorType: 'USER', actorId: userId(req),
    actionType: sourceInvoiceId ? 'CREDIT_NOTE_CREATED_FROM_INVOICE' : 'CREDIT_NOTE_CREATED',
    entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNote.id,
    beforeJson: null,
    afterJson: {
      customerName, creditNoteNumber: cnNum, creditNoteDate,
      subtotalExVat: totals.subtotalExVat, vatAmount: totals.vatAmount, totalIncVat: totals.totalIncVat,
      sourceInvoiceId: sourceInvoiceId || null, status: 'draft',
    },
    reason: 'Customer credit note created',
    ipAddress: req.ip, userAgent: req.get('user-agent'),
  });

  res.status(201).json({ creditNote: { ...creditNote, lines: processedLines } });
});

// ─── POST /from-invoice/:invoiceId — full-credit draft from invoice ──────────

router.post('/from-invoice/:invoiceId', authenticate, hasPermission('ar.credit_note.create'), async (req, res) => {
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.invoiceId);

  // Fetch source invoice + lines — MUST belong to same company (tenant safety)
  const { data: invoice, error: invErr } = await supabase
    .from('customer_invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) {
    return res.status(404).json({
      error: 'Invoice not found or does not belong to this company.',
      errorCode: 'INVOICE_TENANT_VIOLATION',
    });
  }
  if (invoice.status === 'draft') {
    return res.status(422).json({ error: 'Cannot create a credit note for a draft invoice — post the invoice first.' });
  }
  if (invoice.status === 'void') {
    return res.status(422).json({ error: 'Cannot create a credit note for a voided invoice.' });
  }

  const { data: invLines } = await supabase
    .from('customer_invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('sort_order');

  // Check for existing non-void credit notes for this invoice
  const { data: existingCNs } = await supabase
    .from('customer_credit_notes')
    .select('id, credit_note_number, total_inc_vat, status')
    .eq('company_id', companyId)
    .eq('source_invoice_id', invoiceId)
    .neq('status', 'void');

  // Copy invoice lines verbatim into CN lines (full credit)
  const cnLines = (invLines || []).map((l, i) => ({
    description: l.description,
    accountId:   l.account_id,
    lineType:    l.line_type,
    itemId:      l.item_id,
    quantity:    parseFloat(l.quantity),
    unitPrice:   parseFloat(l.unit_price),
    vatRate:     parseFloat(l.vat_rate),
    sortOrder:   i,
    // Use pre-calculated totals from the invoice lines (no re-calculation)
    subtotalExVat: parseFloat(l.subtotal_ex_vat),
    vatAmount:     parseFloat(l.vat_amount),
    totalIncVat:   parseFloat(l.total_inc_vat),
  }));

  const totals = {
    subtotalExVat: parseFloat(invoice.subtotal_ex_vat),
    vatAmount:     parseFloat(invoice.vat_amount),
    totalIncVat:   parseFloat(invoice.total_inc_vat),
  };

  const cnNum = await nextCNNumber(companyId);
  const cnDate = req.body.creditNoteDate || new Date().toISOString().slice(0, 10);
  const reason = req.body.reason || `Full credit for ${invoice.invoice_number}`;

  const dbClient = await db.getClient();
  let creditNote;
  try {
    await dbClient.query('BEGIN');

    const hdr = await dbClient.query(
      `INSERT INTO customer_credit_notes
         (company_id, customer_id, customer_name, credit_note_number, credit_note_date,
          status, reason, notes, source_invoice_id,
          subtotal_ex_vat, vat_amount, total_inc_vat, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        companyId,
        invoice.customer_id || null,
        invoice.customer_name,
        cnNum,
        cnDate,
        reason,
        req.body.notes || null,
        invoiceId,
        totals.subtotalExVat,
        totals.vatAmount,
        totals.totalIncVat,
        userId(req),
      ]
    );
    creditNote = hdr.rows[0];

    // Insert CN lines (using raw pre-calculated values from the invoice)
    if (cnLines.length) {
      const lineVals   = [];
      const lineParams = [];
      let p = 1;
      for (const l of cnLines) {
        lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        lineParams.push(
          creditNote.id, l.sortOrder, l.lineType, l.itemId || null, l.accountId || null,
          l.description, l.quantity, l.unitPrice, l.vatRate,
          l.subtotalExVat, l.vatAmount, l.totalIncVat
        );
      }
      await dbClient.query(
        `INSERT INTO customer_credit_note_lines
           (credit_note_id, sort_order, line_type, item_id, account_id, description,
            quantity, unit_price, vat_rate, subtotal_ex_vat, vat_amount, total_inc_vat)
         VALUES ${lineVals.join(',')}`,
        lineParams
      );
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    dbClient.release();
    console.error('[credit-notes] from-invoice error:', err);
    return res.status(500).json({ error: err.message });
  }
  dbClient.release();

  await AuditLogger.log({
    companyId,
    actorType: 'USER', actorId: userId(req),
    actionType: 'CREDIT_NOTE_CREATED_FROM_INVOICE',
    entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNote.id,
    beforeJson: null,
    afterJson: {
      creditNoteNumber: cnNum, creditNoteDate: cnDate,
      sourceInvoiceId: invoiceId, sourceInvoiceNumber: invoice.invoice_number,
      customerName: invoice.customer_name,
      subtotalExVat: totals.subtotalExVat, vatAmount: totals.vatAmount, totalIncVat: totals.totalIncVat,
      status: 'draft', existingCreditNoteCount: (existingCNs || []).length,
    },
    reason: `Full credit created from invoice ${invoice.invoice_number}`,
    ipAddress: req.ip, userAgent: req.get('user-agent'),
  });

  res.status(201).json({
    creditNote: { ...creditNote, lines: cnLines },
    sourceInvoice: { id: invoice.id, invoice_number: invoice.invoice_number },
    existingCreditNotes: existingCNs || [],
  });
});

// ─── PUT /:id — Update draft credit note ─────────────────────────────────────

router.put('/:id', authenticate, hasPermission('ar.credit_note.create'), async (req, res) => {
  const companyId    = req.companyId;
  const creditNoteId = parseInt(req.params.id);
  const { customerName, creditNoteDate, reason, notes, vatInclusive, lines } = req.body;

  const { data: existing, error: fetchErr } = await supabase
    .from('customer_credit_notes')
    .select('*')
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!existing) return res.status(404).json({ error: 'Credit note not found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ error: 'Only draft credit notes can be edited' });
  }

  // Tenant guard: all line account_ids must belong to this company
  if (lines && lines.length > 0) {
    const foreignAccts = await validateLineAccountIds(companyId, lines);
    if (foreignAccts) {
      return res.status(403).json({ error: 'One or more line item accounts do not belong to this company.', errorCode: 'ACCOUNT_TENANT_VIOLATION' });
    }
  }

  const processedLines = lines ? processLines(lines, vatInclusive) : null;
  const totals = processedLines ? sumLines(processedLines) : {
    subtotalExVat: parseFloat(existing.subtotal_ex_vat),
    vatAmount:     parseFloat(existing.vat_amount),
    totalIncVat:   parseFloat(existing.total_inc_vat),
  };

  const dbClient = await db.getClient();
  try {
    await dbClient.query('BEGIN');

    await dbClient.query(
      `UPDATE customer_credit_notes
       SET customer_name    = $1,
           credit_note_date = $2,
           reason           = $3,
           notes            = $4,
           subtotal_ex_vat  = $5,
           vat_amount       = $6,
           total_inc_vat    = $7,
           updated_at       = $8
       WHERE id = $9 AND company_id = $10`,
      [
        customerName       || existing.customer_name,
        creditNoteDate     || existing.credit_note_date,
        reason             !== undefined ? reason : existing.reason,
        notes              !== undefined ? notes  : existing.notes,
        totals.subtotalExVat,
        totals.vatAmount,
        totals.totalIncVat,
        new Date().toISOString(),
        creditNoteId, companyId,
      ]
    );

    if (processedLines) {
      await dbClient.query(`DELETE FROM customer_credit_note_lines WHERE credit_note_id = $1`, [creditNoteId]);
      await insertLines(dbClient, creditNoteId, processedLines);
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    dbClient.release();
    console.error('[credit-notes] PUT /:id error:', err);
    return res.status(500).json({ error: err.message });
  }
  dbClient.release();

  await AuditLogger.log({
    companyId,
    actorType: 'USER', actorId: userId(req),
    actionType: 'CREDIT_NOTE_UPDATED',
    entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNoteId,
    beforeJson: { subtotalExVat: parseFloat(existing.subtotal_ex_vat), vatAmount: parseFloat(existing.vat_amount), totalIncVat: parseFloat(existing.total_inc_vat) },
    afterJson:  { subtotalExVat: totals.subtotalExVat, vatAmount: totals.vatAmount, totalIncVat: totals.totalIncVat },
    reason: 'Credit note updated (draft)',
    ipAddress: req.ip, userAgent: req.get('user-agent'),
  });

  const updated = await supabase.from('customer_credit_notes').select('*').eq('id', creditNoteId).eq('company_id', companyId).single();
  const updatedLines = await fetchLines(creditNoteId);
  res.json({ creditNote: { ...updated.data, lines: updatedLines } });
});

// ─── POST /:id/post — Post credit note to GL ─────────────────────────────────
//
// GL entries (reversing vs invoice):
//   DR Revenue(per line account_id, subtotal_ex_vat)
//   DR VAT Output(2300, total vat_amount)   ← if vat > 0
//   CR AR(1100, total_inc_vat)

router.post('/:id/post', authenticate, hasPermission('ar.credit_note.post'), async (req, res) => {
  const companyId    = req.companyId;
  const creditNoteId = parseInt(req.params.id);

  const { data: cn, error: cnErr } = await supabase
    .from('customer_credit_notes')
    .select('*')
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (cnErr)  return res.status(500).json({ error: cnErr.message });
  if (!cn)    return res.status(404).json({ error: 'Credit note not found' });
  if (cn.status !== 'draft') {
    await AuditLogger.log({
      companyId, actorType: 'USER', actorId: userId(req),
      actionType: 'CREDIT_NOTE_POST_BLOCKED', entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNoteId,
      beforeJson: null, afterJson: { status: cn.status, reasonCode: 'NOT_DRAFT' },
      reason: `Credit note post blocked: status is ${cn.status}`,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });
    return res.status(409).json({ error: `Credit note is already ${cn.status}` });
  }

  // Double-post guard
  if (cn.posted_journal_id != null) {
    return res.status(409).json({ error: 'Credit note already has a linked journal and cannot be posted again.', journalId: cn.posted_journal_id });
  }

  const { data: lines, error: linesErr } = await supabase
    .from('customer_credit_note_lines')
    .select('*')
    .eq('credit_note_id', creditNoteId)
    .order('sort_order');
  if (linesErr) return res.status(500).json({ error: linesErr.message });

  // Resolve AR account (required)
  const arAccountId = await findAccountByCode(companyId, '1100');
  if (!arAccountId) {
    return res.status(422).json({ error: 'Accounts Receivable account (code 1100) not found. Please provision a base chart of accounts first.' });
  }

  const glLines = [];

  // DR Revenue per line (reduces revenue — contra entry to invoice CR Revenue)
  for (const l of (lines || [])) {
    if (l && l.account_id && parseFloat(l.subtotal_ex_vat) > 0) {
      glLines.push({
        accountId:   l.account_id,
        debit:       parseFloat(l.subtotal_ex_vat),
        credit:      0,
        description: `Credit: ${l.description || 'Revenue'}`,
      });
    }
  }

  // DR VAT Output (reduces VAT liability)
  const totalVat = parseFloat(cn.vat_amount) || 0;
  if (totalVat > 0) {
    const vatOutputId = await findAccountByCode(companyId, '2300');
    if (!vatOutputId) {
      return res.status(422).json({ error: 'VAT Output account (code 2300) not found. Please provision the base chart of accounts before posting VAT-bearing credit notes.' });
    }
    glLines.push({
      accountId:   vatOutputId,
      debit:       totalVat,
      credit:      0,
      description: 'Credit: VAT Output',
    });
  }

  // CR AR (reduces receivable)
  glLines.push({
    accountId:   arAccountId,
    debit:       0,
    credit:      parseFloat(cn.total_inc_vat),
    description: `Credit: ${cn.customer_name} ${cn.credit_note_number}`,
  });

  let glJournal;
  try {
    glJournal = await JournalService.createDraftJournal({
      companyId,
      date:            cn.credit_note_date,
      reference:       cn.credit_note_number,
      description:     `AR Credit Note: ${cn.customer_name}`,
      sourceType:      'customer_credit_note',
      createdByUserId: userId(req),
      lines:           glLines,
    });
    await JournalService.postJournal(glJournal.id, companyId, userId(req));
  } catch (err) {
    console.error('[credit-notes] GL post error:', err);
    return res.status(500).json({ error: `GL posting failed: ${err.message}` });
  }

  // Update credit note: status → 'posted', store posted_journal_id
  const { error: updErr } = await supabase
    .from('customer_credit_notes')
    .update({ status: 'posted', posted_journal_id: glJournal.id, updated_at: new Date().toISOString() })
    .eq('id', creditNoteId)
    .eq('company_id', companyId);

  if (updErr) {
    // GL posted but status update failed — reverse the journal immediately
    try {
      await JournalService.reverseJournal(glJournal.id, companyId, userId(req), `Auto-reversal: credit note ${creditNoteId} status update failed after GL post`);
    } catch (revErr) {
      console.error(`[credit-notes] CRITICAL: journal ${glJournal.id} posted for CN ${creditNoteId}, status update AND reversal failed:`, revErr.message);
    }
    return res.status(500).json({ error: 'Credit note posting failed after GL journal creation. Please retry.' });
  }

  await AuditLogger.log({
    companyId, actorType: 'USER', actorId: userId(req),
    actionType: 'CREDIT_NOTE_POSTED',
    entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNoteId,
    beforeJson: { status: 'draft' },
    afterJson: { status: 'posted', journalId: glJournal.id, totalIncVat: parseFloat(cn.total_inc_vat), customerName: cn.customer_name },
    reason: 'Customer credit note posted to GL',
    ipAddress: req.ip, userAgent: req.get('user-agent'),
  });

  res.json({ message: 'Credit note posted to General Ledger', journalId: glJournal.id });
});

// ─── POST /:id/void — Void a credit note ─────────────────────────────────────
//
// Draft CN:  set status='void' (no GL impact — GL never posted)
// Posted CN: create reversal journal via JournalService.reverseJournal,
//            then set status='void'. This nullifies the credit note's
//            GL impact (net effect = zero).

router.post('/:id/void', authenticate, hasPermission('ar.credit_note.void'), async (req, res) => {
  const companyId    = req.companyId;
  const creditNoteId = parseInt(req.params.id);

  const { data: cn, error: fetchErr } = await supabase
    .from('customer_credit_notes')
    .select('*')
    .eq('id', creditNoteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!cn)      return res.status(404).json({ error: 'Credit note not found' });
  if (cn.status === 'void') {
    return res.status(409).json({ error: 'Credit note is already voided' });
  }

  // For posted credit notes: check VAT period lock before reversing
  if (cn.status === 'posted' && cn.posted_journal_id) {
    const vatLock = await JournalService.isVatPeriodLocked(cn.posted_journal_id);
    if (vatLock.locked) {
      await AuditLogger.log({
        companyId, actorType: 'USER', actorId: userId(req),
        actionType: 'CREDIT_NOTE_VOID_BLOCKED',
        entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNoteId,
        beforeJson: null,
        afterJson: { status: cn.status, journalId: cn.posted_journal_id, vatPeriodKey: vatLock.periodKey, reasonCode: 'VAT_PERIOD_LOCKED' },
        reason: `Credit note void blocked: VAT period ${vatLock.periodKey} is locked`,
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      });
      return res.status(403).json({ error: `Cannot void this credit note — it is included in locked VAT period ${vatLock.periodKey}.` });
    }

    // Reverse the posted journal
    try {
      await JournalService.reverseJournal(cn.posted_journal_id, companyId, userId(req), `Reversal: credit note ${cn.credit_note_number} voided`);
    } catch (err) {
      console.error('[credit-notes] reversal error:', err);
      return res.status(500).json({ error: `Journal reversal failed: ${err.message}` });
    }
  }

  const { error: voidErr } = await supabase
    .from('customer_credit_notes')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', creditNoteId)
    .eq('company_id', companyId);

  if (voidErr) return res.status(500).json({ error: voidErr.message });

  await AuditLogger.log({
    companyId, actorType: 'USER', actorId: userId(req),
    actionType: 'CREDIT_NOTE_VOIDED',
    entityType: 'CUSTOMER_CREDIT_NOTE', entityId: creditNoteId,
    beforeJson: { status: cn.status, journalId: cn.posted_journal_id || null },
    afterJson:  { status: 'void', journalReversed: cn.status === 'posted' && !!cn.posted_journal_id },
    reason: req.body.reason || 'Customer credit note voided',
    ipAddress: req.ip, userAgent: req.get('user-agent'),
  });

  res.json({ message: 'Credit note voided' });
});

module.exports = router;
