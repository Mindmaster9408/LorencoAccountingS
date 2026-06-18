/**
 * ============================================================================
 * Quotes / Estimates Routes
 * ============================================================================
 * Mounted at /api/accounting/quotes
 *
 * Routes:
 *   GET  /                          — list quotes
 *   GET  /:id                       — single quote with lines
 *   POST /                          — create draft quote
 *   PUT  /:id                       — update quote (draft/sent only)
 *   POST /:id/send                  — draft → sent
 *   POST /:id/accept                — draft|sent → accepted
 *   POST /:id/decline               — draft|sent|accepted → declined
 *   POST /:id/void                  — any non-final → void
 *   POST /:id/convert-to-invoice    — create draft invoice from quote
 *
 * Accounting impact: NONE until convert-to-invoice.
 * GL, AR, VAT, stock — all unaffected until the resulting invoice is posted.
 * ============================================================================
 */

const express        = require('express');
const router         = express.Router();
const { supabase, db } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

function userId(req) {
  return req.user && req.user.userId ? req.user.userId : null;
}

// ─── Editable statuses ────────────────────────────────────────────────────────
const EDITABLE_STATUSES = ['draft', 'sent'];

// ─── Validate and normalise line items ───────────────────────────────────────
function processLines(lines) {
  return (lines || [])
    .map((l, idx) => {
      const qty      = Math.max(parseFloat(l.quantity)  || 1, 0);
      const price    = parseFloat(l.unitPrice)           || 0;  // always ex-VAT
      const vatRate  = isNaN(parseFloat(l.vatRate)) ? 0 : parseFloat(l.vatRate);
      const subEx    = parseFloat((qty * price).toFixed(2));
      const vatAmt   = parseFloat((subEx * vatRate / 100).toFixed(2));
      const total    = parseFloat((subEx + vatAmt).toFixed(2));
      const lineType = l.lineType === 'item' ? 'item' : 'account';
      return {
        lineType,
        itemId:        lineType === 'item' && l.itemId ? parseInt(l.itemId) : null,
        accountId:     l.accountId ? parseInt(l.accountId) : null,
        description:   String(l.description || '').trim(),
        quantity:      qty,
        unitPrice:     price,
        vatRate,
        subtotalExVat: subEx,
        vatAmount:     vatAmt,
        totalIncVat:   total,
        sortOrder:     idx,
      };
    })
    .filter(l => l.description || l.unitPrice > 0);
}

// ─── Build header totals from processed lines ─────────────────────────────────
function lineTotals(lines) {
  return {
    subtotalExVat: parseFloat(lines.reduce((s, l) => s + l.subtotalExVat, 0).toFixed(2)),
    vatAmount:     parseFloat(lines.reduce((s, l) => s + l.vatAmount,     0).toFixed(2)),
    totalIncVat:   parseFloat(lines.reduce((s, l) => s + l.totalIncVat,   0).toFixed(2)),
  };
}

// ─── Bulk-insert lines ────────────────────────────────────────────────────────
// Used for both create and update (after delete-existing).
async function insertQuoteLines(pgClient, quoteId, lines) {
  if (!lines.length) return;
  const vals   = [];
  const params = [];
  let p = 1;
  for (const l of lines) {
    vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11})`);
    p += 12;
    params.push(
      quoteId, l.lineType, l.itemId, l.accountId, l.description,
      l.quantity, l.unitPrice, l.vatRate,
      l.subtotalExVat, l.vatAmount, l.totalIncVat, l.sortOrder
    );
  }
  await pgClient.query(
    `INSERT INTO customer_quote_lines
       (quote_id, line_type, item_id, account_id, description,
        quantity, unit_price, vat_rate,
        subtotal_ex_vat, vat_amount, total_inc_vat, sort_order)
     VALUES ${vals.join(',')}`,
    params
  );
}

// ─── Validate request header fields ──────────────────────────────────────────
function validateHeader(body) {
  const customerName = (body.customerName || '').trim();
  if (!customerName) return { error: 'Customer name is required' };
  const quoteDate = body.quoteDate || new Date().toISOString().slice(0, 10);
  return {
    customerName,
    customerId:  body.customerId ? parseInt(body.customerId) : null,
    quoteDate,
    expiryDate:  body.expiryDate  || null,
    vatMode:     body.vatMode === 'inclusive' ? 'inclusive' : 'exclusive',
    notes:       (body.notes  || '').trim() || null,
    terms:       (body.terms  || '').trim() || null,
  };
}

// ─── GET / — list quotes ──────────────────────────────────────────────────────

router.get('/', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { status, search } = req.query;
  try {
    let q = supabase
      .from('customer_quotes')
      .select('id, quote_number, customer_name, customer_id, quote_date, expiry_date, status, vat_mode, subtotal_ex_vat, vat_amount, total_inc_vat, converted_invoice_id, created_at')
      .eq('company_id', companyId)
      .order('id', { ascending: false });
    if (status)  q = q.eq('status', status);
    if (search)  q = q.ilike('customer_name', `%${search}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ quotes: data || [] });
  } catch (err) {
    console.error('GET /accounting/quotes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:id — single quote with lines ──────────────────────────────────────

router.get('/:id', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const quoteId   = parseInt(req.params.id);
  if (isNaN(quoteId)) return res.status(400).json({ error: 'Invalid quote ID' });
  try {
    const [{ data: quote, error: qErr }, { data: lines, error: lErr }] = await Promise.all([
      supabase.from('customer_quotes').select('*').eq('id', quoteId).eq('company_id', companyId).maybeSingle(),
      supabase.from('customer_quote_lines').select('*').eq('quote_id', quoteId).order('sort_order'),
    ]);
    if (qErr) throw new Error(qErr.message);
    if (lErr) throw new Error(lErr.message);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    res.json({ quote: { ...quote, lines: lines || [] } });
  } catch (err) {
    console.error('GET /accounting/quotes/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST / — create draft quote ─────────────────────────────────────────────

router.post('/', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const hdr = validateHeader(req.body);
  if (hdr.error) return res.status(400).json({ error: hdr.error });

  const lines  = processLines(req.body.lines);
  const totals = lineTotals(lines);

  // Generate quote number before entering transaction (count + 1)
  const { count } = await supabase
    .from('customer_quotes')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  const quoteNumber = `QUO-${String((count || 0) + 1).padStart(4, '0')}`;

  let pgClient;
  try {
    pgClient = await db.getClient();
    await pgClient.query('BEGIN');

    const { rows } = await pgClient.query(
      `INSERT INTO customer_quotes
         (company_id, customer_id, customer_name, quote_number, quote_date,
          expiry_date, status, vat_mode, notes, terms,
          subtotal_ex_vat, vat_amount, total_inc_vat)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        companyId, hdr.customerId, hdr.customerName, quoteNumber,
        hdr.quoteDate, hdr.expiryDate, hdr.vatMode,
        hdr.notes, hdr.terms,
        totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
      ]
    );
    const quote = rows[0];
    await insertQuoteLines(pgClient, quote.id, lines);
    await pgClient.query('COMMIT');

    const { data: fullLines } = await supabase
      .from('customer_quote_lines').select('*').eq('quote_id', quote.id).order('sort_order');
    res.status(201).json({ quote: { ...quote, lines: fullLines || [] } });
  } catch (err) {
    if (pgClient) await pgClient.query('ROLLBACK').catch(() => {});
    console.error('POST /accounting/quotes error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (pgClient) pgClient.release();
  }
});

// ─── PUT /:id — update quote ──────────────────────────────────────────────────

router.put('/:id', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const quoteId   = parseInt(req.params.id);
  if (isNaN(quoteId)) return res.status(400).json({ error: 'Invalid quote ID' });

  const { data: existing } = await supabase.from('customer_quotes').select('id, status')
    .eq('id', quoteId).eq('company_id', companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Quote not found' });
  if (!EDITABLE_STATUSES.includes(existing.status))
    return res.status(409).json({ error: `Cannot edit a quote with status '${existing.status}'` });

  const hdr = validateHeader(req.body);
  if (hdr.error) return res.status(400).json({ error: hdr.error });

  const lines  = processLines(req.body.lines);
  const totals = lineTotals(lines);

  let pgClient;
  try {
    pgClient = await db.getClient();
    await pgClient.query('BEGIN');

    await pgClient.query(
      `UPDATE customer_quotes SET
         customer_id=$1, customer_name=$2, quote_date=$3, expiry_date=$4,
         vat_mode=$5, notes=$6, terms=$7,
         subtotal_ex_vat=$8, vat_amount=$9, total_inc_vat=$10, updated_at=NOW()
       WHERE id=$11 AND company_id=$12`,
      [
        hdr.customerId, hdr.customerName, hdr.quoteDate, hdr.expiryDate,
        hdr.vatMode, hdr.notes, hdr.terms,
        totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
        quoteId, companyId,
      ]
    );
    await pgClient.query('DELETE FROM customer_quote_lines WHERE quote_id=$1', [quoteId]);
    await insertQuoteLines(pgClient, quoteId, lines);
    await pgClient.query('COMMIT');

    const { data: quote }     = await supabase.from('customer_quotes').select('*').eq('id', quoteId).maybeSingle();
    const { data: fullLines } = await supabase.from('customer_quote_lines').select('*').eq('quote_id', quoteId).order('sort_order');
    res.json({ quote: { ...quote, lines: fullLines || [] } });
  } catch (err) {
    if (pgClient) await pgClient.query('ROLLBACK').catch(() => {});
    console.error('PUT /accounting/quotes/:id error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (pgClient) pgClient.release();
  }
});

// ─── Status transitions ───────────────────────────────────────────────────────

async function setQuoteStatus(req, res, newStatus, allowedFrom) {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const quoteId   = parseInt(req.params.id);
  if (isNaN(quoteId)) return res.status(400).json({ error: 'Invalid quote ID' });

  const { data: existing } = await supabase.from('customer_quotes').select('id, status')
    .eq('id', quoteId).eq('company_id', companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Quote not found' });
  if (!allowedFrom.includes(existing.status))
    return res.status(409).json({ error: `Cannot change status from '${existing.status}' to '${newStatus}'` });

  const { data: quote, error } = await supabase.from('customer_quotes')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', quoteId).eq('company_id', companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ quote });
}

router.post('/:id/send',    authenticate, hasPermission('ar.invoice.create'), (req, res) =>
  setQuoteStatus(req, res, 'sent',     ['draft']));
router.post('/:id/accept',  authenticate, hasPermission('ar.invoice.create'), (req, res) =>
  setQuoteStatus(req, res, 'accepted', ['draft', 'sent']));
router.post('/:id/decline', authenticate, hasPermission('ar.invoice.create'), (req, res) =>
  setQuoteStatus(req, res, 'declined', ['draft', 'sent', 'accepted']));
router.post('/:id/void',    authenticate, hasPermission('ar.invoice.create'), (req, res) =>
  setQuoteStatus(req, res, 'void',     ['draft', 'sent', 'accepted', 'declined', 'expired']));

// ─── POST /:id/convert-to-invoice ─────────────────────────────────────────────
// Creates a draft customer_invoice from the quote. No GL posting.
// Sets quote.converted_invoice_id and status='converted'.
// Prevents double conversion.

router.post('/:id/convert-to-invoice', authenticate, hasPermission('ar.invoice.create'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const quoteId   = parseInt(req.params.id);
  if (isNaN(quoteId)) return res.status(400).json({ error: 'Invalid quote ID' });

  // Fetch quote + lines
  const [{ data: quote, error: qErr }, { data: quoteLines, error: lErr }] = await Promise.all([
    supabase.from('customer_quotes').select('*').eq('id', quoteId).eq('company_id', companyId).maybeSingle(),
    supabase.from('customer_quote_lines').select('*').eq('quote_id', quoteId).order('sort_order'),
  ]);
  if (qErr || lErr) return res.status(500).json({ error: (qErr || lErr).message });
  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  if (quote.status === 'void')
    return res.status(409).json({ error: 'A voided quote cannot be converted to an invoice' });
  if (quote.status === 'converted' && quote.converted_invoice_id)
    return res.status(409).json({
      error:     'This quote has already been converted',
      invoiceId: quote.converted_invoice_id,
    });

  // Generate invoice number (count + 1, matching invoice router pattern)
  const { count: invCount } = await supabase
    .from('customer_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  const invoiceNumber = `INV-${String((invCount || 0) + 1).padStart(4, '0')}`;
  const today = new Date().toISOString().slice(0, 10);

  let pgClient;
  try {
    pgClient = await db.getClient();
    await pgClient.query('BEGIN');

    // Insert draft invoice — exact same columns as customer-invoices.js POST /
    const { rows: invRows } = await pgClient.query(
      `INSERT INTO customer_invoices
         (company_id, customer_id, customer_name, invoice_number, reference,
          invoice_date, due_date, status,
          subtotal_ex_vat, vat_amount, total_inc_vat,
          amount_paid, notes, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        companyId,
        quote.customer_id,
        quote.customer_name,
        invoiceNumber,
        `Converted from ${quote.quote_number}`,  // reference field
        today,
        null,                                      // due_date — user sets on invoice
        quote.subtotal_ex_vat,
        quote.vat_amount,
        quote.total_inc_vat,
        0,                                         // amount_paid
        quote.notes,
        userId(req),
      ]
    );
    const invoice = invRows[0];

    // Copy quote lines into invoice lines
    if ((quoteLines || []).length > 0) {
      const lineVals   = [];
      const lineParams = [];
      let p = 1;
      quoteLines.forEach((l, i) => {
        lineVals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11})`);
        p += 12;
        lineParams.push(
          invoice.id, l.description, l.account_id, l.line_type, l.item_id,
          l.quantity, l.unit_price, l.vat_rate,
          l.subtotal_ex_vat, l.vat_amount, l.total_inc_vat, i
        );
      });
      await pgClient.query(
        `INSERT INTO customer_invoice_lines
           (invoice_id, description, account_id, line_type, item_id,
            quantity, unit_price, vat_rate,
            subtotal_ex_vat, vat_amount, total_inc_vat, sort_order)
         VALUES ${lineVals.join(',')}`,
        lineParams
      );
    }

    // Mark quote as converted
    await pgClient.query(
      `UPDATE customer_quotes SET status='converted', converted_invoice_id=$1, updated_at=NOW()
       WHERE id=$2 AND company_id=$3`,
      [invoice.id, quoteId, companyId]
    );

    await pgClient.query('COMMIT');
    res.status(201).json({ invoice, quoteId, quoteNumber: quote.quote_number });
  } catch (err) {
    if (pgClient) await pgClient.query('ROLLBACK').catch(() => {});
    console.error('POST /accounting/quotes/:id/convert-to-invoice error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (pgClient) pgClient.release();
  }
});

module.exports = router;
