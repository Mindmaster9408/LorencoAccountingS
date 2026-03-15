/**
 * ============================================================================
 * Suppliers / Accounts Payable Routes
 * ============================================================================
 * Mounted at /api/accounting/suppliers
 * All routes are company-scoped via req.companyId (set by auth middleware).
 *
 * VAT Logic:
 *   vat_inclusive=false (EX VAT): entered amount is base; VAT added on top
 *   vat_inclusive=true  (INC VAT): entered amount is gross; VAT extracted
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Calculate line-item VAT amounts for a given mode.
 * Returns { subtotalExVat, vatAmount, totalIncVat } — all rounded to 2dp.
 */
function calcLineVAT(quantity, unitPrice, vatRate, vatInclusive) {
  const qty      = parseFloat(quantity)  || 1;
  const price    = parseFloat(unitPrice) || 0;
  const _parsed  = parseFloat(vatRate);
  const rate     = isNaN(_parsed) ? 15 : _parsed; // 0% is valid; only default on null/undefined/NaN
  const entered  = Math.round(qty * price * 10000) / 10000; // preserve 4dp during calc

  let subtotalExVat, vatAmount, totalIncVat;

  if (vatInclusive) {
    // INC VAT: entered amount already includes VAT — extract it
    totalIncVat   = Math.round(entered * 100) / 100;
    subtotalExVat = Math.round((entered / (1 + rate / 100)) * 100) / 100;
    vatAmount     = Math.round((totalIncVat - subtotalExVat) * 100) / 100;
  } else {
    // EX VAT: entered amount excludes VAT — add it
    subtotalExVat = Math.round(entered * 100) / 100;
    vatAmount     = Math.round((entered * rate / 100) * 100) / 100;
    totalIncVat   = Math.round((subtotalExVat + vatAmount) * 100) / 100;
  }

  return { subtotalExVat, vatAmount, totalIncVat };
}

/** Sum line totals for an invoice/PO header. */
function sumLines(lines) {
  return lines.reduce((acc, l) => ({
    subtotalExVat: acc.subtotalExVat + (parseFloat(l.line_subtotal_ex_vat) || 0),
    vatAmount:     acc.vatAmount     + (parseFloat(l.vat_amount) || 0),
    totalIncVat:   acc.totalIncVat   + (parseFloat(l.line_total_inc_vat) || 0),
  }), { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 });
}

/** Determine effective invoice balance status. */
function invoiceStatus(totalIncVat, amountPaid) {
  const balance = parseFloat(totalIncVat) - parseFloat(amountPaid);
  if (balance <= 0)           return 'paid';
  if (parseFloat(amountPaid) > 0) return 'part_paid';
  return 'unpaid';
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  try {
    const client = await db.getClient();
    try {
      const [suppliersR, invoicesR, paymentsR] = await Promise.all([
        client.query(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active
             FROM suppliers WHERE company_id = $1`, [companyId]),
        client.query(
          `SELECT
             COALESCE(SUM(total_inc_vat - amount_paid), 0)               AS total_payable,
             COALESCE(SUM(total_inc_vat - amount_paid)
               FILTER (WHERE due_date < CURRENT_DATE AND status != 'paid' AND status != 'cancelled'), 0) AS overdue,
             COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status != 'paid' AND status != 'cancelled') AS overdue_count
           FROM supplier_invoices
           WHERE company_id = $1 AND status NOT IN ('cancelled', 'draft')`, [companyId]),
        client.query(
          `SELECT COALESCE(SUM(amount), 0) AS month_payments
             FROM supplier_payments
            WHERE company_id = $1
              AND date_trunc('month', payment_date) = date_trunc('month', CURRENT_DATE)`, [companyId]),
      ]);

      res.json({
        totalSuppliers:    parseInt(suppliersR.rows[0].active) || 0,
        totalPayable:      parseFloat(invoicesR.rows[0].total_payable) || 0,
        overdue:           parseFloat(invoicesR.rows[0].overdue) || 0,
        overdueCount:      parseInt(invoicesR.rows[0].overdue_count) || 0,
        monthPayments:     parseFloat(paymentsR.rows[0].month_payments) || 0,
      });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Suppliers CRUD ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { search, status } = req.query;
  try {
    const client = await db.getClient();
    try {
      let sql = `
        SELECT s.*,
          COALESCE(
            (SELECT SUM(si.total_inc_vat - si.amount_paid)
               FROM supplier_invoices si
              WHERE si.supplier_id = s.id
                AND si.status NOT IN ('paid','cancelled','draft')), 0
          ) AS balance_owing
        FROM suppliers s
        WHERE s.company_id = $1
      `;
      const params = [companyId];
      if (status === 'active')   { sql += ` AND s.is_active = true`;  }
      if (status === 'inactive') { sql += ` AND s.is_active = false`; }
      if (search) {
        params.push(`%${search}%`);
        sql += ` AND (s.name ILIKE $${params.length} OR s.code ILIKE $${params.length} OR s.email ILIKE $${params.length})`;
      }
      sql += ' ORDER BY s.name';
      const result = await client.query(sql, params);
      res.json({ suppliers: result.rows });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const {
    code, name, type, contactName, email, phone,
    vatNumber, registrationNumber, address, city, postalCode,
    paymentTerms, defaultAccountId, bankName, bankAccountNumber, bankBranchCode, notes,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name is required' });

  try {
    const client = await db.getClient();
    try {
      // Auto-generate code if not provided
      let supplierCode = code && code.trim() ? code.trim() : null;
      if (!supplierCode) {
        const countR = await client.query(
          `SELECT COUNT(*) FROM suppliers WHERE company_id = $1`, [companyId]);
        const n = parseInt(countR.rows[0].count) + 1;
        supplierCode = `SUP${String(n).padStart(3, '0')}`;
      }

      const result = await client.query(
        `INSERT INTO suppliers
           (company_id, code, name, type, contact_name, email, phone,
            vat_number, registration_number, address, city, postal_code,
            payment_terms, default_account_id, bank_name, bank_account_number, bank_branch_code, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [companyId, supplierCode, name.trim(), type || 'company', contactName || null,
         email || null, phone || null, vatNumber || null, registrationNumber || null,
         address || null, city || null, postalCode || null,
         paymentTerms != null ? parseInt(paymentTerms) : 30,
         defaultAccountId ? parseInt(defaultAccountId) : null,
         bankName || null, bankAccountNumber || null, bankBranchCode || null, notes || null]
      );
      res.status(201).json({ supplier: result.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Invoices ────────────────────────────────────────────────────────

router.get('/invoices', async (req, res) => {

  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, status, fromDate, toDate } = req.query;
  try {
    const client = await db.getClient();
    try {
      let sql = `
        SELECT si.*, s.name AS supplier_name, s.code AS supplier_code
          FROM supplier_invoices si
          JOIN suppliers s ON s.id = si.supplier_id
         WHERE si.company_id = $1
      `;
      const params = [companyId];
      if (supplierId) { params.push(parseInt(supplierId)); sql += ` AND si.supplier_id = $${params.length}`; }
      if (status)     { params.push(status);               sql += ` AND si.status = $${params.length}`; }
      if (fromDate)   { params.push(fromDate);             sql += ` AND si.invoice_date >= $${params.length}`; }
      if (toDate)     { params.push(toDate);               sql += ` AND si.invoice_date <= $${params.length}`; }
      sql += ' ORDER BY si.invoice_date DESC, si.id DESC';

      const result = await client.query(sql, params);
      res.json({ invoices: result.rows });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/invoices', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const {
    supplierId, invoiceNumber, reference, invoiceDate, dueDate,
    vatInclusive, lines, notes,
  } = req.body;

  if (!supplierId)   return res.status(400).json({ error: 'Supplier is required' });
  if (!invoiceDate)  return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    const client = await db.getClient();
    try {
      // Verify supplier belongs to company
      const supCheck = await client.query(
        'SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplierId, companyId]);
      if (!supCheck.rows.length) return res.status(400).json({ error: 'Supplier not found for this company' });

      await client.query('BEGIN');

      // Calculate line totals
      const processedLines = lines.map((l, i) => {
        const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
          l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
        );
        return {
          description:       l.description || '',
          accountId:         l.accountId ? parseInt(l.accountId) : null,
          quantity:          parseFloat(l.quantity) || 1,
          unitPrice:         parseFloat(l.unitPrice) || 0,
          lineSubtotalExVat: subtotalExVat,
          vatRate:           l.vatRate != null ? parseFloat(l.vatRate) : 15,
          vatAmount,
          lineTotalIncVat:   totalIncVat,
          sortOrder:         i,
        };
      });

      const totals = processedLines.reduce(
        (acc, l) => ({
          subtotalExVat: acc.subtotalExVat + l.lineSubtotalExVat,
          vatAmount:     acc.vatAmount     + l.vatAmount,
          totalIncVat:   acc.totalIncVat   + l.lineTotalIncVat,
        }),
        { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
      );

      const invResult = await client.query(
        `INSERT INTO supplier_invoices
           (company_id, supplier_id, invoice_number, reference, invoice_date, due_date,
            vat_inclusive, subtotal_ex_vat, vat_amount, total_inc_vat, amount_paid, status, notes,
            created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 0, 'unpaid', $11, $12)
         RETURNING *`,
        [companyId, parseInt(supplierId), invoiceNumber || null, reference || null,
         invoiceDate, dueDate || null, vatInclusive === true,
         totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
         notes || null, req.user && req.user.userId ? req.user.userId : null || null]
      );
      const invoice = invResult.rows[0];

      for (const l of processedLines) {
        await client.query(
          `INSERT INTO supplier_invoice_lines
             (invoice_id, description, account_id, quantity, unit_price,
              line_subtotal_ex_vat, vat_rate, vat_amount, line_total_inc_vat, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [invoice.id, l.description, l.accountId, l.quantity, l.unitPrice,
           l.lineSubtotalExVat, l.vatRate, l.vatAmount, l.lineTotalIncVat, l.sortOrder]
        );
      }

      await client.query('COMMIT');

      // Fetch with lines to return
      const fullInv = await client.query(
        `SELECT si.*, s.name AS supplier_name FROM supplier_invoices si
           JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = $1`, [invoice.id]);
      const invLines = await client.query(
        `SELECT sil.*, a.code AS account_code, a.name AS account_name
           FROM supplier_invoice_lines sil
           LEFT JOIN accounts a ON a.id = sil.account_id
          WHERE sil.invoice_id = $1 ORDER BY sil.sort_order`, [invoice.id]);

      res.status(201).json({
        invoice: { ...fullInv.rows[0], lines: invLines.rows },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /suppliers/invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/invoices/:id', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  try {
    const client = await db.getClient();
    try {
      const invResult = await client.query(
        `SELECT si.*, s.name AS supplier_name, s.code AS supplier_code,
                s.vat_number AS supplier_vat, s.email AS supplier_email
           FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
          WHERE si.id = $1 AND si.company_id = $2`, [invoiceId, companyId]);
      if (!invResult.rows.length) return res.status(404).json({ error: 'Invoice not found' });

      const linesResult = await client.query(
        `SELECT sil.*, a.code AS account_code, a.name AS account_name
           FROM supplier_invoice_lines sil
           LEFT JOIN accounts a ON a.id = sil.account_id
          WHERE sil.invoice_id = $1 ORDER BY sil.sort_order`, [invoiceId]);

      res.json({ invoice: { ...invResult.rows[0], lines: linesResult.rows } });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/invoices/:id', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  const {
    supplierId, invoiceNumber, reference, invoiceDate, dueDate,
    vatInclusive, lines, notes, status,
  } = req.body;

  if (!invoiceDate) return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    const client = await db.getClient();
    try {
      const check = await client.query(
        `SELECT id, status FROM supplier_invoices WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId]);
      if (!check.rows.length) return res.status(404).json({ error: 'Invoice not found' });
      if (check.rows[0].status === 'paid') return res.status(400).json({ error: 'Cannot edit a paid invoice' });

      await client.query('BEGIN');

      const processedLines = lines.map((l, i) => {
        const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
          l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
        );
        return {
          description: l.description || '', accountId: l.accountId ? parseInt(l.accountId) : null,
          quantity: parseFloat(l.quantity) || 1, unitPrice: parseFloat(l.unitPrice) || 0,
          lineSubtotalExVat: subtotalExVat, vatRate: l.vatRate != null ? parseFloat(l.vatRate) : 15,
          vatAmount, lineTotalIncVat: totalIncVat, sortOrder: i,
        };
      });

      const totals = processedLines.reduce(
        (acc, l) => ({ subtotalExVat: acc.subtotalExVat + l.lineSubtotalExVat,
          vatAmount: acc.vatAmount + l.vatAmount, totalIncVat: acc.totalIncVat + l.lineTotalIncVat }),
        { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
      );

      await client.query(
        `UPDATE supplier_invoices SET
           supplier_id=$1, invoice_number=$2, reference=$3, invoice_date=$4, due_date=$5,
           vat_inclusive=$6, subtotal_ex_vat=$7, vat_amount=$8, total_inc_vat=$9,
           notes=$10, status=$11, updated_at=NOW()
         WHERE id=$12 AND company_id=$13`,
        [supplierId ? parseInt(supplierId) : check.rows[0].supplier_id,
         invoiceNumber || null, reference || null, invoiceDate, dueDate || null,
         vatInclusive === true, totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
         notes || null, status || check.rows[0].status, invoiceId, companyId]
      );

      await client.query('DELETE FROM supplier_invoice_lines WHERE invoice_id = $1', [invoiceId]);
      for (const l of processedLines) {
        await client.query(
          `INSERT INTO supplier_invoice_lines
             (invoice_id, description, account_id, quantity, unit_price,
              line_subtotal_ex_vat, vat_rate, vat_amount, line_total_inc_vat, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [invoiceId, l.description, l.accountId, l.quantity, l.unitPrice,
           l.lineSubtotalExVat, l.vatRate, l.vatAmount, l.lineTotalIncVat, l.sortOrder]
        );
      }
      await client.query('COMMIT');

      const fullInv = await client.query(
        `SELECT si.*, s.name AS supplier_name FROM supplier_invoices si
           JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = $1`, [invoiceId]);
      const invLines = await client.query(
        `SELECT sil.*, a.code AS account_code, a.name AS account_name
           FROM supplier_invoice_lines sil LEFT JOIN accounts a ON a.id = sil.account_id
          WHERE sil.invoice_id = $1 ORDER BY sil.sort_order`, [invoiceId]);

      res.json({ invoice: { ...fullInv.rows[0], lines: invLines.rows } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('PUT /suppliers/invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Purchase Orders ──────────────────────────────────────────────────────────

router.get('/orders', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, status } = req.query;
  try {
    const client = await db.getClient();
    try {
      let sql = `
        SELECT po.*, s.name AS supplier_name, s.code AS supplier_code
          FROM purchase_orders po
          LEFT JOIN suppliers s ON s.id = po.supplier_id
         WHERE po.company_id = $1
      `;
      const params = [companyId];
      if (supplierId) { params.push(parseInt(supplierId)); sql += ` AND po.supplier_id = $${params.length}`; }
      if (status)     { params.push(status);               sql += ` AND po.status = $${params.length}`; }
      sql += ' ORDER BY po.po_date DESC, po.id DESC';

      const result = await client.query(sql, params);
      res.json({ orders: result.rows });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, poNumber, poDate, expectedDate, vatInclusive, lines, notes } = req.body;

  if (!poDate)  return res.status(400).json({ error: 'PO date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Auto-generate PO number if not provided
      let poNum = poNumber && poNumber.trim() ? poNumber.trim() : null;
      if (!poNum) {
        const countR = await client.query(
          'SELECT COUNT(*) FROM purchase_orders WHERE company_id = $1', [companyId]);
        const n = parseInt(countR.rows[0].count) + 1;
        const yr = new Date().getFullYear();
        poNum = `PO-${yr}-${String(n).padStart(4, '0')}`;
      }

      const processedLines = lines.map((l, i) => {
        const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
          l.quantity, l.unitPrice, l.vatRate != null ? l.vatRate : 15, vatInclusive === true
        );
        return {
          description: l.description || '', quantity: parseFloat(l.quantity) || 1,
          unitPrice: parseFloat(l.unitPrice) || 0, lineSubtotalExVat: subtotalExVat,
          vatRate: l.vatRate != null ? parseFloat(l.vatRate) : 15,
          vatAmount, lineTotalIncVat: totalIncVat, sortOrder: i,
        };
      });

      const totals = processedLines.reduce(
        (acc, l) => ({ subtotalExVat: acc.subtotalExVat + l.lineSubtotalExVat,
          vatAmount: acc.vatAmount + l.vatAmount, totalIncVat: acc.totalIncVat + l.lineTotalIncVat }),
        { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
      );

      const poResult = await client.query(
        `INSERT INTO purchase_orders
           (company_id, supplier_id, po_number, po_date, expected_date, vat_inclusive,
            subtotal_ex_vat, vat_amount, total_inc_vat, status, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11)
         RETURNING *`,
        [companyId, supplierId ? parseInt(supplierId) : null, poNum, poDate,
         expectedDate || null, vatInclusive === true,
         totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
         notes || null, req.user && req.user.userId ? req.user.userId : null || null]
      );
      const po = poResult.rows[0];

      for (const l of processedLines) {
        await client.query(
          `INSERT INTO purchase_order_lines
             (po_id, description, quantity, unit_price,
              line_subtotal_ex_vat, vat_rate, vat_amount, line_total_inc_vat, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [po.id, l.description, l.quantity, l.unitPrice,
           l.lineSubtotalExVat, l.vatRate, l.vatAmount, l.lineTotalIncVat, l.sortOrder]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ order: po });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /suppliers/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const poId = parseInt(req.params.id);
  try {
    const client = await db.getClient();
    try {
      const poResult = await client.query(
        `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.id = $1 AND po.company_id = $2`, [poId, companyId]);
      if (!poResult.rows.length) return res.status(404).json({ error: 'Purchase order not found' });

      const linesResult = await client.query(
        'SELECT * FROM purchase_order_lines WHERE po_id = $1 ORDER BY sort_order', [poId]);
      res.json({ order: { ...poResult.rows[0], lines: linesResult.rows } });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/orders/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/orders/:id/status', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const poId = parseInt(req.params.id);
  const { status } = req.body;
  const allowed = ['draft', 'approved', 'sent', 'received', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });

  try {
    const client = await db.getClient();
    try {
      const result = await client.query(
        `UPDATE purchase_orders SET status=$1, updated_at=NOW()
          WHERE id=$2 AND company_id=$3 RETURNING *`,
        [status, poId, companyId]);
      if (!result.rows.length) return res.status(404).json({ error: 'Purchase order not found' });
      res.json({ order: result.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('PUT /suppliers/orders/:id/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Payments ────────────────────────────────────────────────────────

router.get('/payments', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, fromDate, toDate } = req.query;
  try {
    const client = await db.getClient();
    try {
      let sql = `
        SELECT sp.*, s.name AS supplier_name, s.code AS supplier_code
          FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id
         WHERE sp.company_id = $1
      `;
      const params = [companyId];
      if (supplierId) { params.push(parseInt(supplierId)); sql += ` AND sp.supplier_id = $${params.length}`; }
      if (fromDate)   { params.push(fromDate);             sql += ` AND sp.payment_date >= $${params.length}`; }
      if (toDate)     { params.push(toDate);               sql += ` AND sp.payment_date <= $${params.length}`; }
      sql += ' ORDER BY sp.payment_date DESC, sp.id DESC';

      const result = await client.query(sql, params);
      res.json({ payments: result.rows });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, paymentDate, paymentMethod, reference, amount, notes, allocations } = req.body;

  if (!supplierId)   return res.status(400).json({ error: 'Supplier is required' });
  if (!paymentDate)  return res.status(400).json({ error: 'Payment date is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

  try {
    const client = await db.getClient();
    try {
      const supCheck = await client.query(
        'SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplierId, companyId]);
      if (!supCheck.rows.length) return res.status(400).json({ error: 'Supplier not found for this company' });

      await client.query('BEGIN');

      const payResult = await client.query(
        `INSERT INTO supplier_payments
           (company_id, supplier_id, payment_date, payment_method, reference, amount, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [companyId, parseInt(supplierId), paymentDate, paymentMethod || 'bank_transfer',
         reference || null, parseFloat(amount), notes || null, req.user && req.user.userId ? req.user.userId : null || null]
      );
      const payment = payResult.rows[0];

      // Apply allocations to invoices
      if (allocations && allocations.length) {
        for (const alloc of allocations) {
          if (!alloc.invoiceId || !alloc.amount) continue;
          await client.query(
            `INSERT INTO supplier_payment_allocations (payment_id, invoice_id, amount)
             VALUES ($1,$2,$3)`,
            [payment.id, parseInt(alloc.invoiceId), parseFloat(alloc.amount)]
          );
          // Update amount_paid on invoice
          await client.query(
            `UPDATE supplier_invoices
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

      await client.query('COMMIT');
      res.status(201).json({ payment });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /suppliers/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Aging Report ────────────────────────────────────────────────────

router.get('/aging', async (req, res) => {
  
  if (!db) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  try {
    const client = await db.getClient();
    try {
      // Unpaid / part-paid invoices only — calculate days overdue from due_date
      const result = await client.query(
        `SELECT
           s.id AS supplier_id,
           s.name AS supplier_name,
           s.code AS supplier_code,
           si.id AS invoice_id,
           si.invoice_number,
           si.invoice_date,
           si.due_date,
           (si.total_inc_vat - si.amount_paid) AS outstanding,
           (CURRENT_DATE - si.due_date::date) AS days_overdue
         FROM supplier_invoices si
         JOIN suppliers s ON s.id = si.supplier_id
         WHERE si.company_id = $1
           AND si.status NOT IN ('paid','cancelled','draft')
           AND (si.total_inc_vat - si.amount_paid) > 0
         ORDER BY s.name, si.due_date`,
        [companyId]
      );

      // Group by supplier and bucket
      const supplierMap = {};
      for (const row of result.rows) {
        const sid = row.supplier_id;
        if (!supplierMap[sid]) {
          supplierMap[sid] = {
            supplier_id: sid, supplier_name: row.supplier_name,
            supplier_code: row.supplier_code,
            current: 0, days30: 0, days60: 0, days90: 0, days90plus: 0, total: 0,
          };
        }
        const outstanding = parseFloat(row.outstanding) || 0;
        const days = parseInt(row.days_overdue) || 0;

        supplierMap[sid].total += outstanding;
        if (days <= 0)        supplierMap[sid].current  += outstanding;
        else if (days <= 30)  supplierMap[sid].days30   += outstanding;
        else if (days <= 60)  supplierMap[sid].days60   += outstanding;
        else if (days <= 90)  supplierMap[sid].days90   += outstanding;
        else                  supplierMap[sid].days90plus += outstanding;
      }

      // Round to 2dp
      const aging = Object.values(supplierMap).map(s => ({
        ...s,
        current:    Math.round(s.current * 100) / 100,
        days30:     Math.round(s.days30 * 100) / 100,
        days60:     Math.round(s.days60 * 100) / 100,
        days90:     Math.round(s.days90 * 100) / 100,
        days90plus: Math.round(s.days90plus * 100) / 100,
        total:      Math.round(s.total * 100) / 100,
      }));

      res.json({ aging });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/aging error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier GET/:id and PUT/:id — must be last to avoid shadowing named routes ─

router.get('/:id', async (req, res) => {
  const companyId = req.companyId;
  const supplierId = parseInt(req.params.id);
  if (isNaN(supplierId)) return res.status(400).json({ error: 'Invalid supplier ID' });
  try {
    const client = await db.getClient();
    try {
      const result = await client.query(
        `SELECT s.*,
           COALESCE(
             (SELECT SUM(si.total_inc_vat - si.amount_paid)
                FROM supplier_invoices si
               WHERE si.supplier_id = s.id
                 AND si.status NOT IN ('paid','cancelled','draft')), 0
           ) AS balance_owing
         FROM suppliers s WHERE s.id = $1 AND s.company_id = $2`,
        [supplierId, companyId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Supplier not found' });
      res.json({ supplier: result.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /suppliers/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const companyId = req.companyId;
  const supplierId = parseInt(req.params.id);
  if (isNaN(supplierId)) return res.status(400).json({ error: 'Invalid supplier ID' });
  const {
    name, type, contactName, email, phone,
    vatNumber, registrationNumber, address, city, postalCode,
    paymentTerms, defaultAccountId, bankName, bankAccountNumber, bankBranchCode, notes, isActive,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name is required' });

  try {
    const client = await db.getClient();
    try {
      const check = await client.query(
        'SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplierId, companyId]);
      if (!check.rows.length) return res.status(404).json({ error: 'Supplier not found' });

      const result = await client.query(
        `UPDATE suppliers SET
           name=$1, type=$2, contact_name=$3, email=$4, phone=$5,
           vat_number=$6, registration_number=$7, address=$8, city=$9, postal_code=$10,
           payment_terms=$11, default_account_id=$12, bank_name=$13,
           bank_account_number=$14, bank_branch_code=$15, notes=$16,
           is_active=$17, updated_at=NOW()
         WHERE id=$18 AND company_id=$19
         RETURNING *`,
        [name.trim(), type || 'company', contactName || null, email || null, phone || null,
         vatNumber || null, registrationNumber || null, address || null,
         city || null, postalCode || null,
         paymentTerms != null ? parseInt(paymentTerms) : 30,
         defaultAccountId ? parseInt(defaultAccountId) : null,
         bankName || null, bankAccountNumber || null, bankBranchCode || null,
         notes || null, isActive !== false,
         supplierId, companyId]
      );
      res.json({ supplier: result.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('PUT /suppliers/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
