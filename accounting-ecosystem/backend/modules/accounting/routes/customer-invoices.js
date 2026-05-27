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

// ─── Customer List (for dropdowns) ───────────────────────────────────────────

router.get('/customers', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  try {
    // Return distinct customer names from POS customers + existing invoices
    const [posResult, invResult] = await Promise.all([
      supabase
        .from('pos_customers')
        .select('id, name, email, phone')
        .eq('company_id', companyId)
        .order('name')
        .then(r => r.data || [])
        .catch(() => []),
      supabase
        .from('customer_invoices')
        .select('customer_name')
        .eq('company_id', companyId)
        .order('customer_name')
        .then(r => r.data || []),
    ]);

    const posMap = new Map(posResult.map(c => [c.name.toLowerCase().trim(), c]));
    const customers = [...posResult.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, source: 'pos' }))];
    // Add invoice-only names not already in POS
    const seen = new Set(posResult.map(c => c.name.toLowerCase().trim()));
    for (const row of invResult) {
      const key = row.customer_name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        customers.push({ id: null, name: row.customer_name, source: 'invoice' });
      }
    }
    res.json({ customers });
  } catch (err) {
    console.error('GET /customer-invoices/customers error:', err);
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
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status)     query = query.eq('status', status);
    if (customerId) query = query.eq('customer_id', parseInt(customerId));
    if (fromDate)   query = query.gte('invoice_date', fromDate);
    if (toDate)     query = query.lte('invoice_date', toDate);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ invoices: data || [] });
  } catch (err) {
    console.error('GET /customer-invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Invoice Detail ───────────────────────────────────────────────────────

router.get('/:id', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
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
      .order('sort_order');

    if (linesErr) throw new Error(linesErr.message);

    // Flatten nested account fields to match expected shape
    const flatLines = (lines || []).map(l => ({
      ...l,
      account_code: l.accounts?.code || null,
      account_name: l.accounts?.name || null,
      accounts: undefined,
    }));

    res.json({ invoice: { ...invoice, lines: flatLines } });
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
    customerId, customerName, invoiceNumber, reference,
    invoiceDate, dueDate, vatInclusive, lines, notes,
  } = req.body;

  if (!customerName) return res.status(400).json({ error: 'Customer name is required' });
  if (!invoiceDate)  return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
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
           (company_id, customer_id, customer_name, invoice_number, reference,
            invoice_date, due_date, status, subtotal_ex_vat, vat_amount, total_inc_vat,
            amount_paid, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          companyId,
          customerId ? parseInt(customerId) : null,
          customerName,
          invNum,
          reference || null,
          invoiceDate,
          dueDate || null,
          'draft',
          totals.subtotalExVat,
          totals.vatAmount,
          totals.totalIncVat,
          0,
          notes || null,
          userId(req),
        ]
      );
      invoice = hdrResult.rows[0];

      // Bulk-insert all lines in one statement
      const lineVals = [];
      const lineParams = [];
      let p = 1;
      for (const l of processedLines) {
        lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        lineParams.push(
          invoice.id, l.description, l.accountId || null, l.quantity, l.unitPrice,
          l.vatRate, l.subtotalExVat, l.vatAmount, l.totalIncVat, l.sortOrder
        );
      }
      await dbClient.query(
        `INSERT INTO customer_invoice_lines
           (invoice_id, description, account_id, quantity, unit_price,
            vat_rate, subtotal_ex_vat, vat_amount, total_inc_vat, sort_order)
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

    res.status(201).json({ invoice: { ...invoice, lines: processedLines } });
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
    customerName, invoiceNumber, reference, invoiceDate,
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

    // Resolve effective values for fields that are optional in the update payload
    const effectiveCustomerName  = customerName  || existing.customer_name;
    const effectiveInvoiceNumber = invoiceNumber || existing.invoice_number;
    const effectiveInvoiceDate   = invoiceDate   || existing.invoice_date;

    // ── Atomic update: header + lines in a single pg transaction ─────────────
    // The header UPDATE and the line DELETE + INSERT are wrapped in one BEGIN/COMMIT.
    // If any step fails the transaction is rolled back and the invoice remains in
    // its pre-edit state — no partial updates, no zero-line invoices.
    const dbClient = await db.getClient();
    try {
      await dbClient.query('BEGIN');

      await dbClient.query(
        `UPDATE customer_invoices
         SET customer_name    = $1,
             invoice_number   = $2,
             invoice_date     = $3,
             subtotal_ex_vat  = $4,
             vat_amount       = $5,
             total_inc_vat    = $6,
             reference        = $7,
             due_date         = $8,
             notes            = $9,
             updated_at       = $10
         WHERE id = $11 AND company_id = $12`,
        [
          effectiveCustomerName,
          effectiveInvoiceNumber,
          effectiveInvoiceDate,
          totals.subtotalExVat,
          totals.vatAmount,
          totals.totalIncVat,
          reference || null,
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
            lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
            lineParams.push(
              invoiceId, l.description, l.accountId || null, l.quantity, l.unitPrice,
              l.vatRate, l.subtotalExVat, l.vatAmount, l.totalIncVat, l.sortOrder
            );
          }
          await dbClient.query(
            `INSERT INTO customer_invoice_lines
               (invoice_id, description, account_id, quantity, unit_price,
                vat_rate, subtotal_ex_vat, vat_amount, total_inc_vat, sort_order)
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

    // Fetch updated invoice + lines
    const { data: updated, error: updFetchErr } = await supabase
      .from('customer_invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();
    if (updFetchErr) throw new Error(updFetchErr.message);

    const { data: updatedLines, error: updLinesErr } = await supabase
      .from('customer_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
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
        subtotalExVat: parseFloat(existing.subtotal_ex_vat || 0),
        vatAmount: parseFloat(existing.vat_amount || 0),
        totalIncVat: parseFloat(existing.total_inc_vat || 0),
        invoiceDate: existing.invoice_date,
      },
      afterJson: {
        subtotalExVat: totals.subtotalExVat,
        vatAmount: totals.vatAmount,
        totalIncVat: totals.totalIncVat,
        invoiceDate: invoiceDate || existing.invoice_date,
      },
      reason: 'Customer invoice updated (draft)',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ invoice: { ...updated, lines: flatLines } });
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
      .order('sort_order');
    if (linesErr) throw new Error(linesErr.message);

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
      debit:       parseFloat(invoice.total_inc_vat),
      credit:      0,
      description: `AR: ${invoice.customer_name} ${invoice.invoice_number}`,
    });

    // CR Revenue lines
    for (const l of (lines || [])) {
      if (l && l.account_id && parseFloat(l.subtotal_ex_vat) > 0) {
        glLines.push({
          accountId:   l.account_id,
          debit:       0,
          credit:      parseFloat(l.subtotal_ex_vat),
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
      date:             invoice.invoice_date,
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
        totalIncVat: parseFloat(invoice.total_inc_vat),
        customerName: invoice.customer_name,
      },
      reason: 'Customer invoice posted to GL',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ message: 'Invoice posted to General Ledger', journalId: glJournal.id });
  } catch (err) {
    console.error('POST /customer-invoices/:id/post error:', err);
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
    reference, amount, bankLedgerAccountId, notes, allocations,
  } = req.body;

  if (!customerName) return res.status(400).json({ error: 'Customer name is required' });
  if (!paymentDate)  return res.status(400).json({ error: 'Payment date is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
  if (!bankLedgerAccountId) {
    return res.status(422).json({ error: 'Bank ledger account is required before customer payment can be recorded.' });
  }

  const paymentAmount = parseFloat(amount);

  try {
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
          .select('amount_paid, total_inc_vat, invoice_number')
          .eq('id', parseInt(alloc.invoiceId))
          .eq('company_id', companyId)
          .maybeSingle();
        if (!inv) {
          return res.status(422).json({ error: `Invoice ${alloc.invoiceId} not found for this company.` });
        }
        const remaining = parseFloat(inv.total_inc_vat) - parseFloat(inv.amount_paid || 0);
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
      })
      .select()
      .single();

    if (payErr) {
      // GL posted but payment row failed — reverse journal to keep GL clean.
      await JournalService.reverseJournal(glJournal.id, companyId, userId(req)).catch(rErr => {
        console.error(`[CustomerAR] CRITICAL: journal ${glJournal.id} posted but payment insert failed AND reversal failed:`, rErr.message);
      });
      throw new Error(payErr.message);
    }

    // ── Step 6: Apply allocations and update invoice statuses ────────────────
    if (allocations && allocations.length) {
      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount) continue;

        const allocAmount    = parseFloat(alloc.amount);
        const allocInvoiceId = parseInt(alloc.invoiceId);

        const { error: allocErr } = await supabase
          .from('customer_payment_allocations')
          .upsert(
            { payment_id: payment.id, invoice_id: allocInvoiceId, amount_applied: allocAmount },
            { onConflict: 'payment_id,invoice_id' }
          );
        if (allocErr) {
          console.warn(`[CustomerAR] Failed to insert allocation for invoice ${allocInvoiceId}:`, allocErr.message);
          continue;
        }

        const { data: inv } = await supabase
          .from('customer_invoices')
          .select('amount_paid, total_inc_vat, status')
          .eq('id', allocInvoiceId)
          .eq('company_id', companyId)
          .maybeSingle();

        if (inv) {
          const newAmountPaid = parseFloat(inv.amount_paid || 0) + allocAmount;
          const newStatus = newAmountPaid >= parseFloat(inv.total_inc_vat)
            ? 'paid'
            : newAmountPaid > 0
              ? 'part_paid'
              : inv.status;

          await supabase
            .from('customer_invoices')
            .update({ amount_paid: newAmountPaid, status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', allocInvoiceId)
            .eq('company_id', companyId);
        }
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

// ─── Aged Debtors Report ──────────────────────────────────────────────────────
// GET /aging — groups outstanding customer invoices by customer and buckets them
// into ageing periods.  Null due_date → current (with noDueDateCount flag).
// Grouping: customer_id when set, fallback to normalised customer_name.

router.get('/aging', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId       = req.companyId;
  const asAt            = req.query.asAt || new Date().toISOString().slice(0, 10);
  const customerIdFilter = req.query.customerId ? parseInt(req.query.customerId) : null;
  const includeZero     = req.query.includeZero === 'true';
  const asAtDate        = new Date(asAt + 'T00:00:00Z');

  try {
    let q = supabase
      .from('customer_invoices')
      .select('id, customer_id, customer_name, invoice_number, invoice_date, due_date, total_inc_vat, amount_paid')
      .eq('company_id', companyId)
      .not('status', 'in', '("draft","void","cancelled")');

    if (customerIdFilter) q = q.eq('customer_id', customerIdFilter);

    const { data: invoices, error } = await q;
    if (error) throw new Error(error.message);

    const byCustomer = {};

    for (const inv of (invoices || [])) {
      const outstanding = Math.round((parseFloat(inv.total_inc_vat) - parseFloat(inv.amount_paid || 0)) * 100) / 100;
      if (!includeZero && outstanding <= 0.005) continue;

      // Group by customer_id when present, otherwise by normalised name
      const groupKey = inv.customer_id
        ? `id:${inv.customer_id}`
        : `name:${(inv.customer_name || '').toLowerCase().trim()}`;

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

    res.json({ asAt, customers, totals });
  } catch (err) {
    console.error('GET /customer-invoices/aging error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
