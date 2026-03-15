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
const db      = require('../config/database');
const JournalService = require('../services/journalService');

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

async function findAccountByCode(client, companyId, code) {
  try {
    const r = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = $2 AND is_active = true LIMIT 1`,
      [companyId, code]
    );
    return r.rows[0]?.id || null;
  } catch (_) {
    return null;
  }
}

function userId(req) {
  return req.user && req.user.userId ? req.user.userId : null;
}

// ─── Customer List (for dropdowns) ───────────────────────────────────────────

router.get('/customers', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  try {
    const client = await db.getClient();
    try {
      // Return distinct customer names from POS customers + existing invoices
      const [posR, invR] = await Promise.all([
        client.query(
          `SELECT id, name, email, phone FROM pos_customers WHERE company_id = $1 ORDER BY name`,
          [companyId]
        ).catch(() => ({ rows: [] })),
        client.query(
          `SELECT DISTINCT customer_name FROM customer_invoices WHERE company_id = $1 ORDER BY customer_name`,
          [companyId]
        ),
      ]);

      const posMap = new Map(posR.rows.map(c => [c.name.toLowerCase().trim(), c]));
      const customers = [...posR.rows.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, source: 'pos' }))];
      // Add invoice-only names not already in POS
      for (const row of invR.rows) {
        if (!posMap.has(row.customer_name.toLowerCase().trim())) {
          customers.push({ id: null, name: row.customer_name, source: 'invoice' });
        }
      }
      res.json({ customers });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /customer-invoices/customers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List Invoices ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { status, customerId, fromDate, toDate, limit = 100, offset = 0 } = req.query;

  try {
    const client = await db.getClient();
    try {
      let sql = `
        SELECT ci.*
        FROM customer_invoices ci
        WHERE ci.company_id = $1
      `;
      const params = [companyId];
      let p = 1;

      if (status) { sql += ` AND ci.status = $${++p}`; params.push(status); }
      if (customerId) { sql += ` AND ci.customer_id = $${++p}`; params.push(parseInt(customerId)); }
      if (fromDate) { sql += ` AND ci.invoice_date >= $${++p}`; params.push(fromDate); }
      if (toDate)   { sql += ` AND ci.invoice_date <= $${++p}`; params.push(toDate); }

      sql += ` ORDER BY ci.invoice_date DESC, ci.id DESC LIMIT $${++p} OFFSET $${++p}`;
      params.push(parseInt(limit), parseInt(offset));

      const result = await client.query(sql, params);
      res.json({ invoices: result.rows });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /customer-invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Invoice Detail ───────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  try {
    const client = await db.getClient();
    try {
      const invR = await client.query(
        `SELECT ci.* FROM customer_invoices ci WHERE ci.id = $1 AND ci.company_id = $2`,
        [invoiceId, companyId]
      );
      if (!invR.rows.length) return res.status(404).json({ error: 'Invoice not found' });

      const linesR = await client.query(
        `SELECT cil.*, a.code AS account_code, a.name AS account_name
           FROM customer_invoice_lines cil
           LEFT JOIN accounts a ON a.id = cil.account_id
          WHERE cil.invoice_id = $1 ORDER BY cil.sort_order`,
        [invoiceId]
      );
      res.json({ invoice: { ...invR.rows[0], lines: linesR.rows } });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /customer-invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Invoice (draft) ──────────────────────────────────────────────────

router.post('/', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const {
    customerId, customerName, invoiceNumber, reference,
    invoiceDate, dueDate, vatInclusive, lines, notes,
  } = req.body;

  if (!customerName) return res.status(400).json({ error: 'Customer name is required' });
  if (!invoiceDate)  return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const processedLines = lines.map((l, i) => {
        const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
          l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
        );
        return {
          description: l.description || '',
          accountId:   l.accountId ? parseInt(l.accountId) : null,
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
        const cntR = await client.query(
          `SELECT COUNT(*) AS cnt FROM customer_invoices WHERE company_id = $1`, [companyId]);
        invNum = `INV-${String(parseInt(cntR.rows[0].cnt) + 1).padStart(4, '0')}`;
      }

      const invR = await client.query(
        `INSERT INTO customer_invoices
           (company_id, customer_id, customer_name, invoice_number, reference,
            invoice_date, due_date, status, subtotal_ex_vat, vat_amount, total_inc_vat,
            amount_paid, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,0,$11,$12)
         RETURNING *`,
        [companyId, customerId ? parseInt(customerId) : null, customerName,
         invNum, reference || null, invoiceDate, dueDate || null,
         totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
         notes || null, userId(req)]
      );
      const invoice = invR.rows[0];

      for (const l of processedLines) {
        await client.query(
          `INSERT INTO customer_invoice_lines
             (invoice_id, description, account_id, quantity, unit_price, vat_rate,
              subtotal_ex_vat, vat_amount, total_inc_vat, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [invoice.id, l.description, l.accountId, l.quantity, l.unitPrice, l.vatRate,
           l.subtotalExVat, l.vatAmount, l.totalIncVat, l.sortOrder]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ invoice: { ...invoice, lines: processedLines } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /customer-invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Invoice (draft only) ─────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  const {
    customerName, invoiceNumber, reference, invoiceDate,
    dueDate, vatInclusive, lines, notes,
  } = req.body;

  try {
    const client = await db.getClient();
    try {
      const invR = await client.query(
        `SELECT * FROM customer_invoices WHERE id = $1 AND company_id = $2`, [invoiceId, companyId]);
      if (!invR.rows.length) return res.status(404).json({ error: 'Invoice not found' });
      if (invR.rows[0].status !== 'draft') return res.status(409).json({ error: 'Only draft invoices can be edited' });

      await client.query('BEGIN');

      const processedLines = (lines || []).map((l, i) => {
        const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
          l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
        );
        return {
          description: l.description || '',
          accountId:   l.accountId ? parseInt(l.accountId) : null,
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

      await client.query(
        `UPDATE customer_invoices SET
           customer_name = COALESCE($1, customer_name),
           invoice_number = COALESCE($2, invoice_number),
           reference = $3, invoice_date = COALESCE($4, invoice_date),
           due_date = $5, subtotal_ex_vat = $6, vat_amount = $7, total_inc_vat = $8,
           notes = $9, updated_at = NOW()
         WHERE id = $10`,
        [customerName, invoiceNumber, reference || null,
         invoiceDate, dueDate || null,
         totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
         notes || null, invoiceId]
      );

      if (lines) {
        await client.query(`DELETE FROM customer_invoice_lines WHERE invoice_id = $1`, [invoiceId]);
        for (const l of processedLines) {
          await client.query(
            `INSERT INTO customer_invoice_lines
               (invoice_id, description, account_id, quantity, unit_price, vat_rate,
                subtotal_ex_vat, vat_amount, total_inc_vat, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [invoiceId, l.description, l.accountId, l.quantity, l.unitPrice, l.vatRate,
             l.subtotalExVat, l.vatAmount, l.totalIncVat, l.sortOrder]
          );
        }
      }

      await client.query('COMMIT');
      const updated = await client.query(
        `SELECT ci.* FROM customer_invoices ci WHERE ci.id = $1`, [invoiceId]);
      const updatedLines = await client.query(
        `SELECT cil.*, a.code AS account_code, a.name AS account_name
           FROM customer_invoice_lines cil LEFT JOIN accounts a ON a.id = cil.account_id
          WHERE cil.invoice_id = $1 ORDER BY cil.sort_order`, [invoiceId]);
      res.json({ invoice: { ...updated.rows[0], lines: updatedLines.rows } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('PUT /customer-invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Post Invoice to GL ───────────────────────────────────────────────────────

router.post('/:id/post', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);

  try {
    const client = await db.getClient();
    try {
      const invR = await client.query(
        `SELECT ci.*, array_agg(
           json_build_object('accountId', cil.account_id, 'subtotalExVat', cil.subtotal_ex_vat,
                             'vatAmount', cil.vat_amount, 'totalIncVat', cil.total_inc_vat,
                             'description', cil.description)
           ORDER BY cil.sort_order
         ) AS lines
         FROM customer_invoices ci
         LEFT JOIN customer_invoice_lines cil ON cil.invoice_id = ci.id
         WHERE ci.id = $1 AND ci.company_id = $2
         GROUP BY ci.id`,
        [invoiceId, companyId]
      );
      if (!invR.rows.length) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = invR.rows[0];
      if (invoice.status !== 'draft') return res.status(409).json({ error: `Invoice is already ${invoice.status}` });

      await client.query('BEGIN');

      // Resolve required accounts
      const arAccountId = await findAccountByCode(client, companyId, '1100');
      if (!arAccountId) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: 'Accounts Receivable account (code 1100) not found in chart of accounts. Please provision a base chart of accounts first.'
        });
      }

      const glLines = [];

      // DR AR — full invoice amount
      glLines.push({ accountId: arAccountId,
        debit: parseFloat(invoice.total_inc_vat), credit: 0,
        description: `AR: ${invoice.customer_name} ${invoice.invoice_number}` });

      // CR Revenue lines
      for (const l of (invoice.lines || [])) {
        if (l && l.accountId && parseFloat(l.subtotalExVat) > 0) {
          glLines.push({ accountId: l.accountId, debit: 0,
            credit: parseFloat(l.subtotalExVat), description: l.description || 'Revenue' });
        }
      }

      // CR VAT Output (2300) if any VAT
      const totalVat = parseFloat(invoice.vat_amount) || 0;
      if (totalVat > 0) {
        const vatOutputId = await findAccountByCode(client, companyId, '2300');
        if (vatOutputId) {
          glLines.push({ accountId: vatOutputId, debit: 0, credit: totalVat,
            description: 'VAT Output (Payable)' });
        }
      }

      // Create + post journal atomically
      const glJournal = await JournalService.createDraftJournal(client, {
        companyId,
        date: invoice.invoice_date,
        reference: invoice.invoice_number,
        description: `AR Invoice: ${invoice.customer_name}`,
        sourceType: 'customer_invoice',
        createdByUserId: userId(req),
        lines: glLines,
      });
      await JournalService.postJournal(client, glJournal.id, companyId, userId(req));

      // Update invoice: status → 'sent', store journal_id
      await client.query(
        `UPDATE customer_invoices SET status = 'sent', journal_id = $1, updated_at = NOW() WHERE id = $2`,
        [glJournal.id, invoiceId]
      );

      await client.query('COMMIT');
      res.json({ message: 'Invoice posted to General Ledger', journalId: glJournal.id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /customer-invoices/:id/post error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Void Invoice ─────────────────────────────────────────────────────────────

router.post('/:id/void', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);

  try {
    const client = await db.getClient();
    try {
      const invR = await client.query(
        `SELECT * FROM customer_invoices WHERE id = $1 AND company_id = $2`, [invoiceId, companyId]);
      if (!invR.rows.length) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = invR.rows[0];
      if (invoice.status === 'void') return res.status(409).json({ error: 'Invoice is already voided' });
      if (invoice.status === 'paid' || parseFloat(invoice.amount_paid) > 0) {
        return res.status(409).json({ error: 'Cannot void an invoice that has payments applied. Reverse the payments first.' });
      }

      await client.query('BEGIN');

      // Reverse the posted journal if one exists
      if (invoice.journal_id) {
        await JournalService.reverseJournal(client, invoice.journal_id, companyId, userId(req));
      }

      await client.query(
        `UPDATE customer_invoices SET status = 'void', updated_at = NOW() WHERE id = $1`, [invoiceId]);

      await client.query('COMMIT');
      res.json({ message: 'Invoice voided' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /customer-invoices/:id/void error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Record Customer Payment ──────────────────────────────────────────────────

router.post('/payments', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const {
    customerId, customerName, paymentDate, paymentMethod,
    reference, amount, bankLedgerAccountId, notes, allocations,
  } = req.body;

  if (!customerName) return res.status(400).json({ error: 'Customer name is required' });
  if (!paymentDate)  return res.status(400).json({ error: 'Payment date is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
  if (!bankLedgerAccountId) return res.status(400).json({ error: 'Bank account is required for customer payments' });

  try {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const payR = await client.query(
        `INSERT INTO customer_payments
           (company_id, customer_id, customer_name, payment_date, payment_method,
            reference, amount, bank_ledger_account_id, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [companyId, customerId ? parseInt(customerId) : null, customerName,
         paymentDate, paymentMethod || 'bank_transfer', reference || null,
         parseFloat(amount), parseInt(bankLedgerAccountId), notes || null, userId(req)]
      );
      const payment = payR.rows[0];

      // Apply to invoices
      if (allocations && allocations.length) {
        for (const alloc of allocations) {
          if (!alloc.invoiceId || !alloc.amount) continue;
          await client.query(
            `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_applied)
             VALUES ($1,$2,$3) ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount_applied = EXCLUDED.amount_applied`,
            [payment.id, parseInt(alloc.invoiceId), parseFloat(alloc.amount)]
          );
          await client.query(
            `UPDATE customer_invoices
               SET amount_paid = amount_paid + $1,
                   status = CASE
                     WHEN amount_paid + $1 >= total_inc_vat THEN 'paid'
                     WHEN amount_paid + $1 > 0 THEN 'part_paid'
                     ELSE status END,
                   updated_at = NOW()
             WHERE id = $2 AND company_id = $3`,
            [parseFloat(alloc.amount), parseInt(alloc.invoiceId), companyId]
          );
        }
      }

      // ── GL Posting (Payment) ──────────────────────────────────────────────
      // DR Bank / CR AR(1100)
      const arAccountId = await findAccountByCode(client, companyId, '1100');
      if (arAccountId) {
        const glJournal = await JournalService.createDraftJournal(client, {
          companyId,
          date: paymentDate,
          reference: reference || null,
          description: `AR Receipt: ${customerName}`,
          sourceType: 'customer_payment',
          createdByUserId: userId(req),
          lines: [
            { accountId: parseInt(bankLedgerAccountId), debit: parseFloat(amount), credit: 0, description: 'Bank receipt' },
            { accountId: arAccountId, debit: 0, credit: parseFloat(amount), description: `AR cleared: ${customerName}` },
          ],
        });
        await JournalService.postJournal(client, glJournal.id, companyId, userId(req));
        await client.query('UPDATE customer_payments SET journal_id = $1 WHERE id = $2',
          [glJournal.id, payment.id]);
      } else {
        console.warn(`[CustomerAR] AR account (1100) not found for company ${companyId} — GL posting skipped for payment ${payment.id}`);
      }
      // ── End GL Posting ────────────────────────────────────────────────────

      await client.query('COMMIT');
      res.status(201).json({ payment });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /customer-invoices/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
