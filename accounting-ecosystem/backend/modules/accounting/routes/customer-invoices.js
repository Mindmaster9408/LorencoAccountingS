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

router.get('/customers', async (req, res) => {
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

router.get('/', async (req, res) => {
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

router.get('/:id', async (req, res) => {
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

router.post('/', async (req, res) => {
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

    const { data: invoice, error: invErr } = await supabase
      .from('customer_invoices')
      .insert({
        company_id:         companyId,
        customer_id:        customerId ? parseInt(customerId) : null,
        customer_name:      customerName,
        invoice_number:     invNum,
        reference:          reference || null,
        invoice_date:       invoiceDate,
        due_date:           dueDate || null,
        status:             'draft',
        subtotal_ex_vat:    totals.subtotalExVat,
        vat_amount:         totals.vatAmount,
        total_inc_vat:      totals.totalIncVat,
        amount_paid:        0,
        notes:              notes || null,
        created_by_user_id: userId(req),
      })
      .select()
      .single();

    if (invErr) throw new Error(invErr.message);

    const lineInserts = processedLines.map(l => ({
      invoice_id:      invoice.id,
      description:     l.description,
      account_id:      l.accountId,
      quantity:        l.quantity,
      unit_price:      l.unitPrice,
      vat_rate:        l.vatRate,
      subtotal_ex_vat: l.subtotalExVat,
      vat_amount:      l.vatAmount,
      total_inc_vat:   l.totalIncVat,
      sort_order:      l.sortOrder,
    }));

    const { error: linesErr } = await supabase.from('customer_invoice_lines').insert(lineInserts);
    if (linesErr) throw new Error(linesErr.message);

    res.status(201).json({ invoice: { ...invoice, lines: processedLines } });
  } catch (err) {
    console.error('POST /customer-invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Invoice (draft only) ─────────────────────────────────────────────

router.put('/:id', async (req, res) => {
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
    if (existing.status !== 'draft') return res.status(409).json({ error: 'Only draft invoices can be edited' });

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

    const updatePayload = {
      subtotal_ex_vat: totals.subtotalExVat,
      vat_amount:      totals.vatAmount,
      total_inc_vat:   totals.totalIncVat,
      reference:       reference || null,
      due_date:        dueDate || null,
      notes:           notes || null,
      updated_at:      new Date().toISOString(),
    };
    if (customerName)   updatePayload.customer_name   = customerName;
    if (invoiceNumber)  updatePayload.invoice_number  = invoiceNumber;
    if (invoiceDate)    updatePayload.invoice_date     = invoiceDate;

    const { error: updateErr } = await supabase
      .from('customer_invoices')
      .update(updatePayload)
      .eq('id', invoiceId);

    if (updateErr) throw new Error(updateErr.message);

    if (lines) {
      const { error: delErr } = await supabase
        .from('customer_invoice_lines')
        .delete()
        .eq('invoice_id', invoiceId);
      if (delErr) throw new Error(delErr.message);

      if (processedLines.length) {
        const lineInserts = processedLines.map(l => ({
          invoice_id:      invoiceId,
          description:     l.description,
          account_id:      l.accountId,
          quantity:        l.quantity,
          unit_price:      l.unitPrice,
          vat_rate:        l.vatRate,
          subtotal_ex_vat: l.subtotalExVat,
          vat_amount:      l.vatAmount,
          total_inc_vat:   l.totalIncVat,
          sort_order:      l.sortOrder,
        }));
        const { error: insErr } = await supabase.from('customer_invoice_lines').insert(lineInserts);
        if (insErr) throw new Error(insErr.message);
      }
    }

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

    res.json({ invoice: { ...updated, lines: flatLines } });
  } catch (err) {
    console.error('PUT /customer-invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Post Invoice to GL ───────────────────────────────────────────────────────

router.post('/:id/post', async (req, res) => {
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
    if (invoice.status !== 'draft') return res.status(409).json({ error: `Invoice is already ${invoice.status}` });

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

    // CR VAT Output (2300) if any VAT
    const totalVat = parseFloat(invoice.vat_amount) || 0;
    if (totalVat > 0) {
      const vatOutputId = await findAccountByCode(companyId, '2300');
      if (vatOutputId) {
        glLines.push({
          accountId:   vatOutputId,
          debit:       0,
          credit:      totalVat,
          description: 'VAT Output (Payable)',
        });
      }
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
      .eq('id', invoiceId);

    if (updErr) {
      console.warn(`[CustomerAR] Invoice ${invoiceId} posted to GL (journal ${glJournal.id}) but status update failed:`, updErr.message);
    }

    res.json({ message: 'Invoice posted to General Ledger', journalId: glJournal.id });
  } catch (err) {
    console.error('POST /customer-invoices/:id/post error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Void Invoice ─────────────────────────────────────────────────────────────

router.post('/:id/void', async (req, res) => {
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
    if (invoice.status === 'void') return res.status(409).json({ error: 'Invoice is already voided' });
    if (invoice.status === 'paid' || parseFloat(invoice.amount_paid) > 0) {
      return res.status(409).json({ error: 'Cannot void an invoice that has payments applied. Reverse the payments first.' });
    }

    // Reverse the posted journal if one exists
    if (invoice.journal_id) {
      await JournalService.reverseJournal(invoice.journal_id, companyId, userId(req));
    }

    const { error: voidErr } = await supabase
      .from('customer_invoices')
      .update({ status: 'void', updated_at: new Date().toISOString() })
      .eq('id', invoiceId);

    if (voidErr) throw new Error(voidErr.message);

    res.json({ message: 'Invoice voided' });
  } catch (err) {
    console.error('POST /customer-invoices/:id/void error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Record Customer Payment ──────────────────────────────────────────────────

router.post('/payments', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
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
    const { data: payment, error: payErr } = await supabase
      .from('customer_payments')
      .insert({
        company_id:            companyId,
        customer_id:           customerId ? parseInt(customerId) : null,
        customer_name:         customerName,
        payment_date:          paymentDate,
        payment_method:        paymentMethod || 'bank_transfer',
        reference:             reference || null,
        amount:                parseFloat(amount),
        bank_ledger_account_id: parseInt(bankLedgerAccountId),
        notes:                 notes || null,
        created_by_user_id:    userId(req),
      })
      .select()
      .single();

    if (payErr) throw new Error(payErr.message);

    // Apply to invoices
    if (allocations && allocations.length) {
      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount) continue;

        const allocAmount = parseFloat(alloc.amount);
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

        // Fetch current invoice totals to compute new status
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

    // ── GL Posting (Payment) ──────────────────────────────────────────────
    // DR Bank / CR AR(1100)
    const arAccountId = await findAccountByCode(companyId, '1100');
    if (arAccountId) {
      try {
        const glJournal = await JournalService.createDraftJournal({
          companyId,
          date:            paymentDate,
          reference:       reference || null,
          description:     `AR Receipt: ${customerName}`,
          sourceType:      'customer_payment',
          createdByUserId: userId(req),
          lines: [
            { accountId: parseInt(bankLedgerAccountId), debit: parseFloat(amount), credit: 0, description: 'Bank receipt' },
            { accountId: arAccountId, debit: 0, credit: parseFloat(amount), description: `AR cleared: ${customerName}` },
          ],
        });
        await JournalService.postJournal(glJournal.id, companyId, userId(req));

        const { error: jUpdErr } = await supabase
          .from('customer_payments')
          .update({ journal_id: glJournal.id })
          .eq('id', payment.id);

        if (jUpdErr) {
          console.warn(`[CustomerAR] Payment ${payment.id} GL posted (journal ${glJournal.id}) but journal_id update failed:`, jUpdErr.message);
        }
      } catch (glErr) {
        console.warn(`[CustomerAR] GL posting failed for payment ${payment.id} — payment still recorded:`, glErr.message);
      }
    } else {
      console.warn(`[CustomerAR] AR account (1100) not found for company ${companyId} — GL posting skipped for payment ${payment.id}`);
    }
    // ── End GL Posting ────────────────────────────────────────────────────

    res.status(201).json({ payment });
  } catch (err) {
    console.error('POST /customer-invoices/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
