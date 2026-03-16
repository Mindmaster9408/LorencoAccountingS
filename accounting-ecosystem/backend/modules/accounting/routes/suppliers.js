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
const { supabase } = require('../../../config/database');
const JournalService = require('../services/journalService');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve an account ID by code within a company's chart of accounts.
 * Returns null (never throws) so callers can skip GL gracefully.
 */
async function findAccountByCode(companyId, code) {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', code)
      .eq('is_active', true)
      .limit(1)
      .single();
    if (error || !data) return null;
    return data.id;
  } catch (_) {
    return null;
  }
}

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

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  try {
    // Total suppliers + active count
    const { data: suppliersData, error: suppliersErr } = await supabase
      .from('suppliers')
      .select('is_active')
      .eq('company_id', companyId);
    if (suppliersErr) throw new Error(suppliersErr.message);

    const totalSuppliers = (suppliersData || []).filter(s => s.is_active).length;

    // Invoice totals — exclude cancelled and draft
    const { data: invoicesData, error: invoicesErr } = await supabase
      .from('supplier_invoices')
      .select('total_inc_vat, amount_paid, due_date, status')
      .eq('company_id', companyId)
      .not('status', 'in', '("cancelled","draft")');
    if (invoicesErr) throw new Error(invoicesErr.message);

    const today = new Date().toISOString().split('T')[0];
    let totalPayable = 0;
    let overdue = 0;
    let overdueCount = 0;

    for (const inv of (invoicesData || [])) {
      const balance = (parseFloat(inv.total_inc_vat) || 0) - (parseFloat(inv.amount_paid) || 0);
      totalPayable += balance;
      const isOverdue = inv.due_date && inv.due_date < today
        && inv.status !== 'paid' && inv.status !== 'cancelled';
      if (isOverdue) {
        overdue += balance;
        overdueCount += 1;
      }
    }

    // Payments this month
    const { data: paymentsData, error: paymentsErr } = await supabase
      .from('supplier_payments')
      .select('amount, payment_date')
      .eq('company_id', companyId);
    if (paymentsErr) throw new Error(paymentsErr.message);

    const nowDate = new Date();
    const monthYear = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}`;
    let monthPayments = 0;
    for (const p of (paymentsData || [])) {
      if (p.payment_date && p.payment_date.startsWith(monthYear)) {
        monthPayments += parseFloat(p.amount) || 0;
      }
    }

    res.json({
      totalSuppliers,
      totalPayable:  Math.round(totalPayable * 100) / 100,
      overdue:       Math.round(overdue * 100) / 100,
      overdueCount,
      monthPayments: Math.round(monthPayments * 100) / 100,
    });
  } catch (err) {
    console.error('GET /suppliers/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Suppliers CRUD ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { search, status } = req.query;
  try {
    // Fetch suppliers
    let suppQuery = supabase
      .from('suppliers')
      .select('*')
      .eq('company_id', companyId)
      .order('name');

    if (status === 'active')   suppQuery = suppQuery.eq('is_active', true);
    if (status === 'inactive') suppQuery = suppQuery.eq('is_active', false);

    const { data: suppliers, error: suppErr } = await suppQuery;
    if (suppErr) throw new Error(suppErr.message);

    let filtered = suppliers || [];

    // Search filter (name, code, email) — done in JS since Supabase ilike requires OR
    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter(s =>
        (s.name  && s.name.toLowerCase().includes(term)) ||
        (s.code  && s.code.toLowerCase().includes(term)) ||
        (s.email && s.email.toLowerCase().includes(term))
      );
    }

    // Fetch unpaid balances for all suppliers in this company
    const { data: invData, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('supplier_id, total_inc_vat, amount_paid, status')
      .eq('company_id', companyId)
      .not('status', 'in', '("paid","cancelled","draft")');
    if (invErr) throw new Error(invErr.message);

    // Build balance map
    const balanceMap = {};
    for (const inv of (invData || [])) {
      const sid = inv.supplier_id;
      if (!balanceMap[sid]) balanceMap[sid] = 0;
      balanceMap[sid] += (parseFloat(inv.total_inc_vat) || 0) - (parseFloat(inv.amount_paid) || 0);
    }

    const result = filtered.map(s => ({
      ...s,
      balance_owing: Math.round((balanceMap[s.id] || 0) * 100) / 100,
    }));

    res.json({ suppliers: result });
  } catch (err) {
    console.error('GET /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const {
    code, name, type, contactName, email, phone,
    vatNumber, registrationNumber, address, city, postalCode,
    paymentTerms, defaultAccountId, bankName, bankAccountNumber, bankBranchCode, notes,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name is required' });

  try {
    // Auto-generate code if not provided
    let supplierCode = code && code.trim() ? code.trim() : null;
    if (!supplierCode) {
      const { count, error: countErr } = await supabase
        .from('suppliers')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId);
      if (countErr) throw new Error(countErr.message);
      const n = (count || 0) + 1;
      supplierCode = `SUP${String(n).padStart(3, '0')}`;
    }

    const { data: supplier, error: insErr } = await supabase
      .from('suppliers')
      .insert({
        company_id:           companyId,
        code:                 supplierCode,
        name:                 name.trim(),
        type:                 type || 'company',
        contact_name:         contactName || null,
        email:                email || null,
        phone:                phone || null,
        vat_number:           vatNumber || null,
        registration_number:  registrationNumber || null,
        address:              address || null,
        city:                 city || null,
        postal_code:          postalCode || null,
        payment_terms:        paymentTerms != null ? parseInt(paymentTerms) : 30,
        default_account_id:   defaultAccountId ? parseInt(defaultAccountId) : null,
        bank_name:            bankName || null,
        bank_account_number:  bankAccountNumber || null,
        bank_branch_code:     bankBranchCode || null,
        notes:                notes || null,
      })
      .select()
      .single();

    if (insErr) throw new Error(insErr.message);
    res.status(201).json({ supplier });
  } catch (err) {
    console.error('POST /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Invoices ────────────────────────────────────────────────────────

router.get('/invoices', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, status, fromDate, toDate } = req.query;
  try {
    let query = supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false });

    if (supplierId) query = query.eq('supplier_id', parseInt(supplierId));
    if (status)     query = query.eq('status', status);
    if (fromDate)   query = query.gte('invoice_date', fromDate);
    if (toDate)     query = query.lte('invoice_date', toDate);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Flatten joined supplier fields
    const invoices = (data || []).map(inv => ({
      ...inv,
      supplier_name: inv.suppliers?.name || null,
      supplier_code: inv.suppliers?.code || null,
      suppliers: undefined,
    }));

    res.json({ invoices });
  } catch (err) {
    console.error('GET /suppliers/invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/invoices', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const {
    supplierId, invoiceNumber, reference, invoiceDate, dueDate,
    vatInclusive, lines, notes,
  } = req.body;

  if (!supplierId)   return res.status(400).json({ error: 'Supplier is required' });
  if (!invoiceDate)  return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    // Verify supplier belongs to company
    const { data: supData, error: supErr } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('id', parseInt(supplierId))
      .eq('company_id', companyId)
      .single();
    if (supErr || !supData) return res.status(400).json({ error: 'Supplier not found for this company' });
    const supplierName = supData.name;

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

    // Insert invoice header
    const { data: invoice, error: invErr } = await supabase
      .from('supplier_invoices')
      .insert({
        company_id:          companyId,
        supplier_id:         parseInt(supplierId),
        invoice_number:      invoiceNumber || null,
        reference:           reference || null,
        invoice_date:        invoiceDate,
        due_date:            dueDate || null,
        vat_inclusive:       vatInclusive === true,
        subtotal_ex_vat:     totals.subtotalExVat,
        vat_amount:          totals.vatAmount,
        total_inc_vat:       totals.totalIncVat,
        amount_paid:         0,
        status:              'unpaid',
        notes:               notes || null,
        created_by_user_id:  req.user && req.user.userId ? req.user.userId : null,
      })
      .select()
      .single();
    if (invErr) throw new Error(invErr.message);

    // Insert invoice lines
    const lineInserts = processedLines.map(l => ({
      invoice_id:           invoice.id,
      description:          l.description,
      account_id:           l.accountId,
      quantity:             l.quantity,
      unit_price:           l.unitPrice,
      line_subtotal_ex_vat: l.lineSubtotalExVat,
      vat_rate:             l.vatRate,
      vat_amount:           l.vatAmount,
      line_total_inc_vat:   l.lineTotalIncVat,
      sort_order:           l.sortOrder,
    }));
    const { error: linesErr } = await supabase.from('supplier_invoice_lines').insert(lineInserts);
    if (linesErr) throw new Error(linesErr.message);

    // ── GL Posting (AP) ───────────────────────────────────────────────────
    // Attempt to post journal. Skip gracefully if required accounts are absent.
    const apAccountId = await findAccountByCode(companyId, '2000');
    if (apAccountId) {
      const glLines = [];

      // DR each expense account line
      for (const l of processedLines) {
        if (l.accountId && l.lineSubtotalExVat > 0) {
          glLines.push({ accountId: l.accountId, debit: l.lineSubtotalExVat, credit: 0,
            description: l.description || 'Supplier Invoice line' });
        }
      }

      // DR VAT Input (code 1400) for total VAT if applicable
      if (totals.vatAmount > 0) {
        const vatInputId = await findAccountByCode(companyId, '1400');
        if (vatInputId) {
          glLines.push({ accountId: vatInputId, debit: totals.vatAmount, credit: 0,
            description: 'VAT Input (Claimable)' });
        }
      }

      // CR Accounts Payable
      glLines.push({ accountId: apAccountId, debit: 0, credit: totals.totalIncVat,
        description: `Supplier: ${supplierName}` });

      // Only post if we have at least one real DR line
      const hasDebits = glLines.some(l => l.debit > 0);
      if (hasDebits) {
        const glJournal = await JournalService.createDraftJournal({
          companyId,
          date: invoiceDate,
          reference: invoiceNumber || null,
          description: `AP Invoice: ${supplierName}${invoiceNumber ? ' ' + invoiceNumber : ''}`,
          sourceType: 'supplier_invoice',
          createdByUserId: req.user && req.user.userId ? req.user.userId : null,
          lines: glLines,
        });
        await JournalService.postJournal(glJournal.id, companyId,
          req.user && req.user.userId ? req.user.userId : null);

        // Link journal to invoice
        const { error: linkErr } = await supabase
          .from('supplier_invoices')
          .update({ journal_id: glJournal.id })
          .eq('id', invoice.id);
        if (linkErr) throw new Error(linkErr.message);
      }
    } else {
      console.warn(`[Suppliers] AP account (2000) not found for company ${companyId} — GL posting skipped for invoice ${invoice.id}`);
    }
    // ── End GL Posting ────────────────────────────────────────────────────

    // Fetch with lines to return
    const { data: fullInv, error: fetchInvErr } = await supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name)')
      .eq('id', invoice.id)
      .single();
    if (fetchInvErr) throw new Error(fetchInvErr.message);

    const { data: invLines, error: fetchLinesErr } = await supabase
      .from('supplier_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoice.id)
      .order('sort_order');
    if (fetchLinesErr) throw new Error(fetchLinesErr.message);

    const flatLines = (invLines || []).map(l => ({
      ...l,
      account_code: l.accounts?.code || null,
      account_name: l.accounts?.name || null,
      accounts: undefined,
    }));

    res.status(201).json({
      invoice: {
        ...fullInv,
        supplier_name: fullInv.suppliers?.name || null,
        suppliers: undefined,
        lines: flatLines,
      },
    });
  } catch (err) {
    console.error('POST /suppliers/invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/invoices/:id', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  try {
    const { data: inv, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name, code, vat_number, email)')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single();
    if (invErr || !inv) return res.status(404).json({ error: 'Invoice not found' });

    const { data: linesData, error: linesErr } = await supabase
      .from('supplier_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    if (linesErr) throw new Error(linesErr.message);

    const lines = (linesData || []).map(l => ({
      ...l,
      account_code: l.accounts?.code || null,
      account_name: l.accounts?.name || null,
      accounts: undefined,
    }));

    res.json({
      invoice: {
        ...inv,
        supplier_name:  inv.suppliers?.name       || null,
        supplier_code:  inv.suppliers?.code       || null,
        supplier_vat:   inv.suppliers?.vat_number || null,
        supplier_email: inv.suppliers?.email      || null,
        suppliers: undefined,
        lines,
      },
    });
  } catch (err) {
    console.error('GET /suppliers/invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/invoices/:id', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  const {
    supplierId, invoiceNumber, reference, invoiceDate, dueDate,
    vatInclusive, lines, notes, status,
  } = req.body;

  if (!invoiceDate) return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    const { data: existing, error: checkErr } = await supabase
      .from('supplier_invoices')
      .select('id, status, supplier_id')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single();
    if (checkErr || !existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status === 'paid') return res.status(400).json({ error: 'Cannot edit a paid invoice' });

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

    // Update invoice header
    const { error: updateErr } = await supabase
      .from('supplier_invoices')
      .update({
        supplier_id:     supplierId ? parseInt(supplierId) : existing.supplier_id,
        invoice_number:  invoiceNumber || null,
        reference:       reference || null,
        invoice_date:    invoiceDate,
        due_date:        dueDate || null,
        vat_inclusive:   vatInclusive === true,
        subtotal_ex_vat: totals.subtotalExVat,
        vat_amount:      totals.vatAmount,
        total_inc_vat:   totals.totalIncVat,
        notes:           notes || null,
        status:          status || existing.status,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .eq('company_id', companyId);
    if (updateErr) throw new Error(updateErr.message);

    // Replace lines
    const { error: delLinesErr } = await supabase
      .from('supplier_invoice_lines')
      .delete()
      .eq('invoice_id', invoiceId);
    if (delLinesErr) throw new Error(delLinesErr.message);

    const lineInserts = processedLines.map(l => ({
      invoice_id:           invoiceId,
      description:          l.description,
      account_id:           l.accountId,
      quantity:             l.quantity,
      unit_price:           l.unitPrice,
      line_subtotal_ex_vat: l.lineSubtotalExVat,
      vat_rate:             l.vatRate,
      vat_amount:           l.vatAmount,
      line_total_inc_vat:   l.lineTotalIncVat,
      sort_order:           l.sortOrder,
    }));
    const { error: insLinesErr } = await supabase.from('supplier_invoice_lines').insert(lineInserts);
    if (insLinesErr) throw new Error(insLinesErr.message);

    // Fetch updated invoice with lines
    const { data: fullInv, error: fetchInvErr } = await supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name)')
      .eq('id', invoiceId)
      .single();
    if (fetchInvErr) throw new Error(fetchInvErr.message);

    const { data: invLines, error: fetchLinesErr } = await supabase
      .from('supplier_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    if (fetchLinesErr) throw new Error(fetchLinesErr.message);

    const flatLines = (invLines || []).map(l => ({
      ...l,
      account_code: l.accounts?.code || null,
      account_name: l.accounts?.name || null,
      accounts: undefined,
    }));

    res.json({
      invoice: {
        ...fullInv,
        supplier_name: fullInv.suppliers?.name || null,
        suppliers: undefined,
        lines: flatLines,
      },
    });
  } catch (err) {
    console.error('PUT /suppliers/invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Purchase Orders ──────────────────────────────────────────────────────────

router.get('/orders', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, status } = req.query;
  try {
    let query = supabase
      .from('purchase_orders')
      .select('*, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId)
      .order('po_date', { ascending: false })
      .order('id', { ascending: false });

    if (supplierId) query = query.eq('supplier_id', parseInt(supplierId));
    if (status)     query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const orders = (data || []).map(po => ({
      ...po,
      supplier_name: po.suppliers?.name || null,
      supplier_code: po.suppliers?.code || null,
      suppliers: undefined,
    }));

    res.json({ orders });
  } catch (err) {
    console.error('GET /suppliers/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, poNumber, poDate, expectedDate, vatInclusive, lines, notes } = req.body;

  if (!poDate)  return res.status(400).json({ error: 'PO date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    // Auto-generate PO number if not provided
    let poNum = poNumber && poNumber.trim() ? poNumber.trim() : null;
    if (!poNum) {
      const { count, error: countErr } = await supabase
        .from('purchase_orders')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId);
      if (countErr) throw new Error(countErr.message);
      const n = (count || 0) + 1;
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

    // Insert PO header
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .insert({
        company_id:          companyId,
        supplier_id:         supplierId ? parseInt(supplierId) : null,
        po_number:           poNum,
        po_date:             poDate,
        expected_date:       expectedDate || null,
        vat_inclusive:       vatInclusive === true,
        subtotal_ex_vat:     totals.subtotalExVat,
        vat_amount:          totals.vatAmount,
        total_inc_vat:       totals.totalIncVat,
        status:              'draft',
        notes:               notes || null,
        created_by_user_id:  req.user && req.user.userId ? req.user.userId : null,
      })
      .select()
      .single();
    if (poErr) throw new Error(poErr.message);

    // Insert PO lines
    const lineInserts = processedLines.map(l => ({
      po_id:                po.id,
      description:          l.description,
      quantity:             l.quantity,
      unit_price:           l.unitPrice,
      line_subtotal_ex_vat: l.lineSubtotalExVat,
      vat_rate:             l.vatRate,
      vat_amount:           l.vatAmount,
      line_total_inc_vat:   l.lineTotalIncVat,
      sort_order:           l.sortOrder,
    }));
    const { error: linesErr } = await supabase.from('purchase_order_lines').insert(lineInserts);
    if (linesErr) throw new Error(linesErr.message);

    res.status(201).json({ order: po });
  } catch (err) {
    console.error('POST /suppliers/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const poId = parseInt(req.params.id);
  try {
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('*, suppliers!supplier_id(name)')
      .eq('id', poId)
      .eq('company_id', companyId)
      .single();
    if (poErr || !po) return res.status(404).json({ error: 'Purchase order not found' });

    const { data: linesData, error: linesErr } = await supabase
      .from('purchase_order_lines')
      .select('*')
      .eq('po_id', poId)
      .order('sort_order');
    if (linesErr) throw new Error(linesErr.message);

    res.json({
      order: {
        ...po,
        supplier_name: po.suppliers?.name || null,
        suppliers: undefined,
        lines: linesData || [],
      },
    });
  } catch (err) {
    console.error('GET /suppliers/orders/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/orders/:id/status', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const poId = parseInt(req.params.id);
  const { status } = req.body;
  const allowed = ['draft', 'approved', 'sent', 'received', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });

  try {
    const { data: po, error: updateErr } = await supabase
      .from('purchase_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', poId)
      .eq('company_id', companyId)
      .select()
      .single();
    if (updateErr || !po) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ order: po });
  } catch (err) {
    console.error('PUT /suppliers/orders/:id/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Payments ────────────────────────────────────────────────────────

router.get('/payments', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, fromDate, toDate } = req.query;
  try {
    let query = supabase
      .from('supplier_payments')
      .select('*, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId)
      .order('payment_date', { ascending: false })
      .order('id', { ascending: false });

    if (supplierId) query = query.eq('supplier_id', parseInt(supplierId));
    if (fromDate)   query = query.gte('payment_date', fromDate);
    if (toDate)     query = query.lte('payment_date', toDate);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const payments = (data || []).map(p => ({
      ...p,
      supplier_name: p.suppliers?.name || null,
      supplier_code: p.suppliers?.code || null,
      suppliers: undefined,
    }));

    res.json({ payments });
  } catch (err) {
    console.error('GET /suppliers/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  const { supplierId, paymentDate, paymentMethod, reference, amount, notes, allocations, bankLedgerAccountId } = req.body;

  if (!supplierId)   return res.status(400).json({ error: 'Supplier is required' });
  if (!paymentDate)  return res.status(400).json({ error: 'Payment date is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

  try {
    // Verify supplier belongs to company
    const { data: supData, error: supErr } = await supabase
      .from('suppliers')
      .select('id')
      .eq('id', parseInt(supplierId))
      .eq('company_id', companyId)
      .single();
    if (supErr || !supData) return res.status(400).json({ error: 'Supplier not found for this company' });

    // Insert payment
    const { data: payment, error: payErr } = await supabase
      .from('supplier_payments')
      .insert({
        company_id:            companyId,
        supplier_id:           parseInt(supplierId),
        payment_date:          paymentDate,
        payment_method:        paymentMethod || 'bank_transfer',
        reference:             reference || null,
        amount:                parseFloat(amount),
        notes:                 notes || null,
        bank_ledger_account_id: bankLedgerAccountId ? parseInt(bankLedgerAccountId) : null,
        created_by_user_id:    req.user && req.user.userId ? req.user.userId : null,
      })
      .select()
      .single();
    if (payErr) throw new Error(payErr.message);

    // Apply allocations to invoices
    if (allocations && allocations.length) {
      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount) continue;

        // Insert allocation record
        const { error: allocErr } = await supabase
          .from('supplier_payment_allocations')
          .insert({
            payment_id: payment.id,
            invoice_id: parseInt(alloc.invoiceId),
            amount:     parseFloat(alloc.amount),
          });
        if (allocErr) throw new Error(allocErr.message);

        // Fetch current invoice amounts
        const { data: inv, error: invFetchErr } = await supabase
          .from('supplier_invoices')
          .select('total_inc_vat, amount_paid')
          .eq('id', parseInt(alloc.invoiceId))
          .eq('company_id', companyId)
          .single();
        if (invFetchErr || !inv) throw new Error('Invoice not found for allocation');

        const newAmountPaid = (parseFloat(inv.amount_paid) || 0) + parseFloat(alloc.amount);
        const newStatus = newAmountPaid >= parseFloat(inv.total_inc_vat)
          ? 'paid'
          : newAmountPaid > 0 ? 'part_paid' : undefined;

        const updatePayload = {
          amount_paid: newAmountPaid,
          updated_at:  new Date().toISOString(),
        };
        if (newStatus) updatePayload.status = newStatus;

        const { error: invUpdateErr } = await supabase
          .from('supplier_invoices')
          .update(updatePayload)
          .eq('id', parseInt(alloc.invoiceId))
          .eq('company_id', companyId);
        if (invUpdateErr) throw new Error(invUpdateErr.message);
      }
    }

    // ── GL Posting (Payment) ──────────────────────────────────────────────
    // DR AP (2000) / CR Bank ledger account — both sides required to post.
    if (bankLedgerAccountId) {
      const apAccountId = await findAccountByCode(companyId, '2000');
      if (apAccountId) {
        const glJournal = await JournalService.createDraftJournal({
          companyId,
          date: paymentDate,
          reference: reference || null,
          description: `AP Payment: ${paymentMethod || 'bank_transfer'}`,
          sourceType: 'supplier_payment',
          createdByUserId: req.user && req.user.userId ? req.user.userId : null,
          lines: [
            { accountId: apAccountId,                  debit: parseFloat(amount), credit: 0, description: 'Accounts Payable cleared' },
            { accountId: parseInt(bankLedgerAccountId), debit: 0, credit: parseFloat(amount), description: 'Bank payment out' },
          ],
        });
        await JournalService.postJournal(glJournal.id, companyId,
          req.user && req.user.userId ? req.user.userId : null);

        // Link journal to payment
        const { error: linkErr } = await supabase
          .from('supplier_payments')
          .update({ journal_id: glJournal.id })
          .eq('id', payment.id);
        if (linkErr) throw new Error(linkErr.message);
      } else {
        console.warn(`[Suppliers] AP account (2000) not found for company ${companyId} — GL posting skipped for payment ${payment.id}`);
      }
    }
    // ── End GL Posting ────────────────────────────────────────────────────

    res.status(201).json({ payment });
  } catch (err) {
    console.error('POST /suppliers/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Aging Report ────────────────────────────────────────────────────

router.get('/aging', async (req, res) => {

  if (!supabase) return res.status(503).json({ error: "Database not available" });

  const companyId = req.companyId;
  try {
    // Unpaid / part-paid invoices — fetch with supplier info
    const { data: rows, error: rowsErr } = await supabase
      .from('supplier_invoices')
      .select('id, invoice_number, invoice_date, due_date, total_inc_vat, amount_paid, status, supplier_id, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId)
      .not('status', 'in', '("paid","cancelled","draft")');
    if (rowsErr) throw new Error(rowsErr.message);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Group by supplier and bucket
    const supplierMap = {};
    for (const row of (rows || [])) {
      const outstanding = (parseFloat(row.total_inc_vat) || 0) - (parseFloat(row.amount_paid) || 0);
      if (outstanding <= 0) continue; // skip fully settled

      const sid = row.supplier_id;
      if (!supplierMap[sid]) {
        supplierMap[sid] = {
          supplier_id:   sid,
          supplier_name: row.suppliers?.name || null,
          supplier_code: row.suppliers?.code || null,
          current: 0, days30: 0, days60: 0, days90: 0, days90plus: 0, total: 0,
        };
      }

      let daysOverdue = 0;
      if (row.due_date) {
        const dueDate = new Date(row.due_date);
        dueDate.setHours(0, 0, 0, 0);
        daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      }

      supplierMap[sid].total += outstanding;
      if (daysOverdue <= 0)        supplierMap[sid].current   += outstanding;
      else if (daysOverdue <= 30)  supplierMap[sid].days30    += outstanding;
      else if (daysOverdue <= 60)  supplierMap[sid].days60    += outstanding;
      else if (daysOverdue <= 90)  supplierMap[sid].days90    += outstanding;
      else                         supplierMap[sid].days90plus += outstanding;
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
    const { data: supplier, error: suppErr } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .single();
    if (suppErr || !supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Calculate balance_owing
    const { data: invData, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('total_inc_vat, amount_paid')
      .eq('supplier_id', supplierId)
      .eq('company_id', companyId)
      .not('status', 'in', '("paid","cancelled","draft")');
    if (invErr) throw new Error(invErr.message);

    const balance_owing = (invData || []).reduce((sum, inv) =>
      sum + (parseFloat(inv.total_inc_vat) || 0) - (parseFloat(inv.amount_paid) || 0), 0);

    res.json({ supplier: { ...supplier, balance_owing: Math.round(balance_owing * 100) / 100 } });
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
    // Verify exists
    const { data: existing, error: checkErr } = await supabase
      .from('suppliers')
      .select('id')
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .single();
    if (checkErr || !existing) return res.status(404).json({ error: 'Supplier not found' });

    const { data: supplier, error: updateErr } = await supabase
      .from('suppliers')
      .update({
        name:                 name.trim(),
        type:                 type || 'company',
        contact_name:         contactName || null,
        email:                email || null,
        phone:                phone || null,
        vat_number:           vatNumber || null,
        registration_number:  registrationNumber || null,
        address:              address || null,
        city:                 city || null,
        postal_code:          postalCode || null,
        payment_terms:        paymentTerms != null ? parseInt(paymentTerms) : 30,
        default_account_id:   defaultAccountId ? parseInt(defaultAccountId) : null,
        bank_name:            bankName || null,
        bank_account_number:  bankAccountNumber || null,
        bank_branch_code:     bankBranchCode || null,
        notes:                notes || null,
        is_active:            isActive !== false,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .select()
      .single();
    if (updateErr) throw new Error(updateErr.message);
    res.json({ supplier });
  } catch (err) {
    console.error('PUT /suppliers/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
