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
 * Resolve an account by code within a company's chart of accounts.
 * Returns the full account row or null (never throws) so callers can skip GL gracefully.
 */
async function findAccountByCode(companyId, code) {
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id,code,name')
      .eq('company_id', companyId)
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();
    return data || null;
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
  if (balance <= 0)               return 'paid';
  if (parseFloat(amountPaid) > 0) return 'part_paid';
  return 'unpaid';
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  const companyId = req.companyId;
  try {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split('T')[0];

    const [
      suppliersActive,
      invoicesResult,
      paymentsResult,
    ] = await Promise.all([
      supabase
        .from('suppliers')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('is_active', true),
      supabase
        .from('supplier_invoices')
        .select('total_inc_vat, amount_paid, due_date, status')
        .eq('company_id', companyId)
        .neq('status', 'cancelled')
        .neq('status', 'draft'),
      supabase
        .from('supplier_payments')
        .select('amount')
        .eq('company_id', companyId)
        .gte('payment_date', startOfMonth)
        .lt('payment_date', startOfNextMonth),
    ]);

    // Aggregate invoice stats client-side
    let totalPayable = 0;
    let overdue = 0;
    let overdueCount = 0;
    for (const inv of invoicesResult.data || []) {
      const balance = parseFloat(inv.total_inc_vat) - parseFloat(inv.amount_paid);
      totalPayable += balance;
      if (inv.due_date < today && inv.status !== 'paid' && inv.status !== 'cancelled') {
        overdue += balance;
        overdueCount++;
      }
    }

    const monthPayments = (paymentsResult.data || []).reduce(
      (sum, p) => sum + (parseFloat(p.amount) || 0), 0
    );

    res.json({
      totalSuppliers: suppliersActive.count || 0,
      totalPayable:   Math.round(totalPayable * 100) / 100,
      overdue:        Math.round(overdue * 100) / 100,
      overdueCount,
      monthPayments:  Math.round(monthPayments * 100) / 100,
    });
  } catch (err) {
    console.error('GET /suppliers/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Suppliers CRUD ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const companyId = req.companyId;
  const { search, status } = req.query;
  try {
    // Build supplier query with optional filters
    let query = supabase
      .from('suppliers')
      .select('*')
      .eq('company_id', companyId);

    if (status === 'active')   query = query.eq('is_active', true);
    if (status === 'inactive') query = query.eq('is_active', false);
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,code.ilike.%${search}%,email.ilike.%${search}%`
      );
    }
    query = query.order('name');

    const { data: suppliers, error: supErr } = await query;
    if (supErr) throw new Error(supErr.message);

    // Fetch outstanding invoice balances for the company to compute balance_owing per supplier
    const { data: balanceRows, error: balErr } = await supabase
      .from('supplier_invoices')
      .select('supplier_id, total_inc_vat, amount_paid')
      .eq('company_id', companyId)
      .neq('status', 'paid')
      .neq('status', 'cancelled')
      .neq('status', 'draft');
    if (balErr) throw new Error(balErr.message);

    const balanceMap = {};
    for (const row of balanceRows || []) {
      const b = parseFloat(row.total_inc_vat) - parseFloat(row.amount_paid);
      balanceMap[row.supplier_id] = (balanceMap[row.supplier_id] || 0) + b;
    }

    const result = (suppliers || []).map(s => ({
      ...s,
      balance_owing: Math.round(((balanceMap[s.id] || 0)) * 100) / 100,
    }));

    res.json({ suppliers: result });
  } catch (err) {
    console.error('GET /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
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
        .select('id', { count: 'exact', head: true })
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
  const companyId = req.companyId;
  const { supplierId, status, fromDate, toDate } = req.query;
  try {
    let query = supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId);

    if (supplierId) query = query.eq('supplier_id', parseInt(supplierId));
    if (status)     query = query.eq('status', status);
    if (fromDate)   query = query.gte('invoice_date', fromDate);
    if (toDate)     query = query.lte('invoice_date', toDate);

    query = query
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Flatten nested supplier relation to match original response shape
    const invoices = (data || []).map(row => {
      const { suppliers: sup, ...rest } = row;
      return { ...rest, supplier_name: sup?.name || null, supplier_code: sup?.code || null };
    });

    res.json({ invoices });
  } catch (err) {
    console.error('GET /suppliers/invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/invoices', async (req, res) => {
  const companyId = req.companyId;
  const {
    supplierId, invoiceNumber, reference, invoiceDate, dueDate,
    vatInclusive, lines, notes,
  } = req.body;

  if (!supplierId)  return res.status(400).json({ error: 'Supplier is required' });
  if (!invoiceDate) return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    // Verify supplier belongs to company
    const { data: supRow, error: supErr } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('id', parseInt(supplierId))
      .eq('company_id', companyId)
      .maybeSingle();
    if (supErr) throw new Error(supErr.message);
    if (!supRow) return res.status(400).json({ error: 'Supplier not found for this company' });
    const supplierName = supRow.name;

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

    const userId = req.user && req.user.userId ? req.user.userId : null;

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
        created_by_user_id:  userId,
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
    // Attempt to post journal atomically with the invoice.
    // Skip gracefully if required accounts are absent from the company's COA.
    const apAccount = await findAccountByCode(companyId, '2000');
    if (apAccount) {
      const glLines = [];

      // DR each expense account line
      for (const l of processedLines) {
        if (l.accountId && l.lineSubtotalExVat > 0) {
          glLines.push({
            accountId:   l.accountId,
            debit:       l.lineSubtotalExVat,
            credit:      0,
            description: l.description || 'Supplier Invoice line',
          });
        }
      }

      // DR VAT Input (code 1400) for total VAT if applicable
      if (totals.vatAmount > 0) {
        const vatInputAccount = await findAccountByCode(companyId, '1400');
        if (vatInputAccount) {
          glLines.push({
            accountId:   vatInputAccount.id,
            debit:       totals.vatAmount,
            credit:      0,
            description: 'VAT Input (Claimable)',
          });
        }
      }

      // CR Accounts Payable
      glLines.push({
        accountId:   apAccount.id,
        debit:       0,
        credit:      totals.totalIncVat,
        description: `Supplier: ${supplierName}`,
      });

      // Only post if we have at least one real DR line (debit lines + AP credit)
      const hasDebits = glLines.some(l => l.debit > 0);
      if (hasDebits) {
        const glJournal = await JournalService.createDraftJournal({
          companyId,
          date: invoiceDate,
          reference: invoiceNumber || null,
          description: `AP Invoice: ${supplierName}${invoiceNumber ? ' ' + invoiceNumber : ''}`,
          sourceType: 'supplier_invoice',
          createdByUserId: userId,
          lines: glLines,
        });
        await JournalService.postJournal(glJournal.id, companyId, userId);
        const { error: jidErr } = await supabase
          .from('supplier_invoices')
          .update({ journal_id: glJournal.id })
          .eq('id', invoice.id);
        if (jidErr) console.warn(`[Suppliers] Failed to link journal_id to invoice ${invoice.id}:`, jidErr.message);
      }
    } else {
      console.warn(`[Suppliers] AP account (2000) not found for company ${companyId} — GL posting skipped for invoice ${invoice.id}`);
    }
    // ── End GL Posting ────────────────────────────────────────────────────

    // Fetch full invoice with supplier name for response
    const { data: fullInv, error: fullErr } = await supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name)')
      .eq('id', invoice.id)
      .single();
    if (fullErr) throw new Error(fullErr.message);

    const { data: invLines, error: ilErr } = await supabase
      .from('supplier_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoice.id)
      .order('sort_order');
    if (ilErr) throw new Error(ilErr.message);

    const { suppliers: sup, ...invRest } = fullInv;
    const flatLines = (invLines || []).map(row => {
      const { accounts: acct, ...lineRest } = row;
      return { ...lineRest, account_code: acct?.code || null, account_name: acct?.name || null };
    });

    res.status(201).json({
      invoice: { ...invRest, supplier_name: sup?.name || null, lines: flatLines },
    });
  } catch (err) {
    console.error('POST /suppliers/invoices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/invoices/:id', async (req, res) => {
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  try {
    const { data: inv, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name, code, vat_number, email)')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (invErr) throw new Error(invErr.message);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const { data: linesData, error: lErr } = await supabase
      .from('supplier_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    if (lErr) throw new Error(lErr.message);

    const { suppliers: sup, ...invRest } = inv;
    const flatLines = (linesData || []).map(row => {
      const { accounts: acct, ...lineRest } = row;
      return { ...lineRest, account_code: acct?.code || null, account_name: acct?.name || null };
    });

    res.json({
      invoice: {
        ...invRest,
        supplier_name:  sup?.name       || null,
        supplier_code:  sup?.code       || null,
        supplier_vat:   sup?.vat_number || null,
        supplier_email: sup?.email      || null,
        lines: flatLines,
      },
    });
  } catch (err) {
    console.error('GET /suppliers/invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/invoices/:id', async (req, res) => {
  const companyId = req.companyId;
  const invoiceId = parseInt(req.params.id);
  const {
    supplierId, invoiceNumber, reference, invoiceDate, dueDate,
    vatInclusive, lines, notes, status,
  } = req.body;

  if (!invoiceDate) return res.status(400).json({ error: 'Invoice date is required' });
  if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  try {
    // FIX (P4): select includes journal_id and current accounting amounts so that:
    //   (a) the VAT lock guard below actually fires (previously journal_id was not
    //       selected so existing.journal_id was always undefined → guard never ran)
    //   (b) we can detect accounting-impacting changes and trigger GL correction
    const { data: existing, error: chkErr } = await supabase
      .from('supplier_invoices')
      .select('id, status, supplier_id, journal_id, invoice_date, subtotal_ex_vat, vat_amount, total_inc_vat')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (chkErr) throw new Error(chkErr.message);
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status === 'paid') return res.status(400).json({ error: 'Cannot edit a paid invoice' });

    // VAT period lock guard (now works correctly — journal_id is selected above)
    if (existing.journal_id) {
      const vatLock = await JournalService.isVatPeriodLocked(existing.journal_id);
      if (vatLock.locked) {
        return res.status(403).json({
          error: `Cannot edit this invoice — it is included in locked VAT period ${vatLock.periodKey}. VAT periods that have been locked cannot be changed.`,
        });
      }
    }

    // Calculate new totals from submitted lines (unchanged logic)
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

    const newTotals = processedLines.reduce(
      (acc, l) => ({
        subtotalExVat: acc.subtotalExVat + l.lineSubtotalExVat,
        vatAmount:     acc.vatAmount     + l.vatAmount,
        totalIncVat:   acc.totalIncVat   + l.lineTotalIncVat,
      }),
      { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
    );

    // ── Detect accounting-impacting changes ───────────────────────────────────
    // Compares header totals, invoice date, and expense account IDs.
    // Any change here means the original posted journal no longer matches the
    // invoice — GL correction (reverse + replace) is required.
    const amountsChanged = (
      Math.abs(parseFloat(existing.subtotal_ex_vat || 0) - newTotals.subtotalExVat) > 0.005 ||
      Math.abs(parseFloat(existing.vat_amount      || 0) - newTotals.vatAmount)      > 0.005 ||
      Math.abs(parseFloat(existing.total_inc_vat   || 0) - newTotals.totalIncVat)    > 0.005
    );
    const dateChanged = existing.invoice_date !== invoiceDate;

    // Fetch existing line accounts to detect expense account reassignment
    const { data: existingLineRows } = await supabase
      .from('supplier_invoice_lines')
      .select('account_id')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    const existingAcctIds = (existingLineRows || []).map(l => String(l.account_id || '')).sort().join(',');
    const newAcctIds      = processedLines.map(l => String(l.accountId || '')).sort().join(',');
    const accountsChanged = existingAcctIds !== newAcctIds;

    // GL correction is needed when the invoice has an original journal AND
    // at least one accounting-impacting field has changed.
    const needsGlCorrection = !!(existing.journal_id && (amountsChanged || dateChanged || accountsChanged));

    const userId = req.user && req.user.userId ? req.user.userId : null;

    // ── GL Correction (reverse original + post replacement) ───────────────────
    // Runs BEFORE the invoice row update so that if GL correction fails, the
    // invoice record is left unchanged (safe failure mode).
    //
    // Sequence:
    //   1. Create and post replacement journal   ← if this fails, abort cleanly
    //   2. Reverse the original journal          ← if this fails, undo step 1 and abort
    //   3. Update invoice row with new journal_id
    //   4. Replace invoice lines
    //
    // If no GL correction is needed (no accounting change, or no journal linked),
    // steps 1–2 are skipped and only the invoice record / lines are updated.
    let newJournalId = existing.journal_id; // default: keep existing link unchanged

    if (needsGlCorrection) {
      // Load supplier name for journal description
      const { data: supRow } = await supabase
        .from('suppliers')
        .select('name')
        .eq('id', existing.supplier_id)
        .eq('company_id', companyId)
        .maybeSingle();
      const supplierName = supRow?.name || 'Supplier';

      // AP account is mandatory for GL correction
      const apAccount = await findAccountByCode(companyId, '2000');
      if (!apAccount) {
        return res.status(400).json({
          error: 'GL correction cannot proceed: Accounts Payable account (code 2000) was not found in this company\'s chart of accounts. Please create the AP account before editing this invoice.',
        });
      }

      // Build new GL lines from edited invoice data
      const newGlLines = [];
      for (const l of processedLines) {
        if (l.accountId && l.lineSubtotalExVat > 0) {
          newGlLines.push({
            accountId:   l.accountId,
            debit:       l.lineSubtotalExVat,
            credit:      0,
            description: l.description || 'Supplier Invoice line',
          });
        }
      }
      if (newTotals.vatAmount > 0) {
        const vatInputAccount = await findAccountByCode(companyId, '1400');
        if (vatInputAccount) {
          newGlLines.push({
            accountId:   vatInputAccount.id,
            debit:       newTotals.vatAmount,
            credit:      0,
            description: 'VAT Input (Claimable)',
          });
        }
      }
      newGlLines.push({
        accountId:   apAccount.id,
        debit:       0,
        credit:      newTotals.totalIncVat,
        description: `Supplier: ${supplierName}`,
      });

      if (!newGlLines.some(l => l.debit > 0)) {
        return res.status(400).json({
          error: 'GL correction aborted: no debit lines could be built from the edited invoice. Ensure expense accounts are assigned to all line items.',
        });
      }

      // ── Step 1: Create and post replacement journal ───────────────────────
      let replacementJournalId;
      try {
        const replacementDraft = await JournalService.createDraftJournal({
          companyId,
          date:            invoiceDate,
          reference:       invoiceNumber || null,
          description:     `AP Invoice (Corrected): ${supplierName}${invoiceNumber ? ' ' + invoiceNumber : ''}`,
          sourceType:      'supplier_invoice',
          createdByUserId: userId,
          lines:           newGlLines,
          metadata:        { correctedInvoiceId: invoiceId, replacesJournalId: existing.journal_id },
        });
        await JournalService.postJournal(replacementDraft.id, companyId, userId);
        replacementJournalId = replacementDraft.id;
      } catch (replErr) {
        // Replacement failed before any reversal — invoice unchanged, fully safe
        throw new Error(`GL correction failed — replacement journal could not be created or posted: ${replErr.message}. Invoice has not been changed.`);
      }

      // ── Step 2: Reverse the original journal ─────────────────────────────
      try {
        await JournalService.reverseJournal(
          existing.journal_id,
          companyId,
          userId,
          `Invoice #${invoiceId} edited — original posting voided; replaced by journal ${replacementJournalId}`
        );
      } catch (revErr) {
        // Reversal failed after replacement was posted — attempt to undo the
        // replacement by reversing it so we return to a clean slate.
        console.error(`[Suppliers] P4: original journal ${existing.journal_id} reversal failed for invoice ${invoiceId} after replacement ${replacementJournalId} was posted. Attempting cleanup reversal...`);
        try {
          await JournalService.reverseJournal(
            replacementJournalId,
            companyId,
            userId,
            `Cleanup: reversal of failed GL correction for invoice ${invoiceId}`
          );
          // Cleanup succeeded — return error, invoice unchanged
          throw new Error(`GL correction failed — original journal reversal failed and has been rolled back: ${revErr.message}. Invoice has not been changed.`);
        } catch (cleanupErr) {
          if (cleanupErr.message.startsWith('GL correction failed')) throw cleanupErr;
          // Cleanup also failed — this is a critical inconsistent state
          console.error(`[Suppliers] CRITICAL: GL cleanup failed for invoice ${invoiceId}. Replacement journal ${replacementJournalId} is posted AND original journal ${existing.journal_id} is NOT reversed. Manual correction required.`, cleanupErr.message);
          throw new Error(
            `GL correction entered inconsistent state for invoice ${invoiceId}. ` +
            `Replacement journal ${replacementJournalId} was posted but original journal ${existing.journal_id} could not be reversed. ` +
            `Manual correction is required — contact your accountant.`
          );
        }
      }

      newJournalId = replacementJournalId;
    }

    // ── Update invoice record ─────────────────────────────────────────────────
    // Runs after GL correction completes (or after confirming no GL change needed).
    // Includes journal_id update so invoice always points to the active journal.
    const { error: updErr } = await supabase
      .from('supplier_invoices')
      .update({
        supplier_id:     supplierId ? parseInt(supplierId) : existing.supplier_id,
        invoice_number:  invoiceNumber || null,
        reference:       reference || null,
        invoice_date:    invoiceDate,
        due_date:        dueDate || null,
        vat_inclusive:   vatInclusive === true,
        subtotal_ex_vat: newTotals.subtotalExVat,
        vat_amount:      newTotals.vatAmount,
        total_inc_vat:   newTotals.totalIncVat,
        notes:           notes || null,
        status:          status || existing.status,
        journal_id:      newJournalId,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .eq('company_id', companyId);
    if (updErr) throw new Error(updErr.message);

    // Replace invoice lines
    const { error: delErr } = await supabase
      .from('supplier_invoice_lines')
      .delete()
      .eq('invoice_id', invoiceId);
    if (delErr) throw new Error(delErr.message);

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
    const { error: lInsErr } = await supabase.from('supplier_invoice_lines').insert(lineInserts);
    if (lInsErr) throw new Error(lInsErr.message);

    // Fetch updated invoice with lines for response
    const { data: fullInv, error: fullErr } = await supabase
      .from('supplier_invoices')
      .select('*, suppliers!supplier_id(name)')
      .eq('id', invoiceId)
      .single();
    if (fullErr) throw new Error(fullErr.message);

    const { data: invLines, error: ilErr } = await supabase
      .from('supplier_invoice_lines')
      .select('*, accounts!account_id(code, name)')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    if (ilErr) throw new Error(ilErr.message);

    const { suppliers: sup, ...invRest } = fullInv;
    const flatLines = (invLines || []).map(row => {
      const { accounts: acct, ...lineRest } = row;
      return { ...lineRest, account_code: acct?.code || null, account_name: acct?.name || null };
    });

    res.json({
      invoice:        { ...invRest, supplier_name: sup?.name || null, lines: flatLines },
      journalCorrected: needsGlCorrection, // true when a GL reversal + replacement was performed
    });
  } catch (err) {
    console.error('PUT /suppliers/invoices/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Purchase Orders ──────────────────────────────────────────────────────────

router.get('/orders', async (req, res) => {
  const companyId = req.companyId;
  const { supplierId, status } = req.query;
  try {
    let query = supabase
      .from('purchase_orders')
      .select('*, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId);

    if (supplierId) query = query.eq('supplier_id', parseInt(supplierId));
    if (status)     query = query.eq('status', status);
    query = query.order('po_date', { ascending: false }).order('id', { ascending: false });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const orders = (data || []).map(row => {
      const { suppliers: sup, ...rest } = row;
      return { ...rest, supplier_name: sup?.name || null, supplier_code: sup?.code || null };
    });

    res.json({ orders });
  } catch (err) {
    console.error('GET /suppliers/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', async (req, res) => {
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
        .select('id', { count: 'exact', head: true })
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
        description:       l.description || '',
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

    const userId = req.user && req.user.userId ? req.user.userId : null;
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
        created_by_user_id:  userId,
      })
      .select()
      .single();
    if (poErr) throw new Error(poErr.message);

    const poLineInserts = processedLines.map(l => ({
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
    const { error: plErr } = await supabase.from('purchase_order_lines').insert(poLineInserts);
    if (plErr) throw new Error(plErr.message);

    res.status(201).json({ order: po });
  } catch (err) {
    console.error('POST /suppliers/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  const companyId = req.companyId;
  const poId = parseInt(req.params.id);
  try {
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('*, suppliers!supplier_id(name)')
      .eq('id', poId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (poErr) throw new Error(poErr.message);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const { data: linesData, error: lErr } = await supabase
      .from('purchase_order_lines')
      .select('*')
      .eq('po_id', poId)
      .order('sort_order');
    if (lErr) throw new Error(lErr.message);

    const { suppliers: sup, ...poRest } = po;
    res.json({ order: { ...poRest, supplier_name: sup?.name || null, lines: linesData || [] } });
  } catch (err) {
    console.error('GET /suppliers/orders/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/orders/:id/status', async (req, res) => {
  const companyId = req.companyId;
  const poId = parseInt(req.params.id);
  const { status } = req.body;
  const allowed = ['draft', 'approved', 'sent', 'received', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', poId)
      .eq('company_id', companyId)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ order: po });
  } catch (err) {
    console.error('PUT /suppliers/orders/:id/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supplier Payments ────────────────────────────────────────────────────────

router.get('/payments', async (req, res) => {
  const companyId = req.companyId;
  const { supplierId, fromDate, toDate } = req.query;
  try {
    let query = supabase
      .from('supplier_payments')
      .select('*, suppliers!supplier_id(name, code)')
      .eq('company_id', companyId);

    if (supplierId) query = query.eq('supplier_id', parseInt(supplierId));
    if (fromDate)   query = query.gte('payment_date', fromDate);
    if (toDate)     query = query.lte('payment_date', toDate);
    query = query.order('payment_date', { ascending: false }).order('id', { ascending: false });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const payments = (data || []).map(row => {
      const { suppliers: sup, ...rest } = row;
      return { ...rest, supplier_name: sup?.name || null, supplier_code: sup?.code || null };
    });

    res.json({ payments });
  } catch (err) {
    console.error('GET /suppliers/payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments', async (req, res) => {
  const companyId = req.companyId;
  const {
    supplierId, paymentDate, paymentMethod, reference, amount, notes,
    allocations, bankLedgerAccountId,
  } = req.body;

  if (!supplierId)  return res.status(400).json({ error: 'Supplier is required' });
  if (!paymentDate) return res.status(400).json({ error: 'Payment date is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

  try {
    // Verify supplier belongs to company
    const { data: supRow, error: supErr } = await supabase
      .from('suppliers')
      .select('id')
      .eq('id', parseInt(supplierId))
      .eq('company_id', companyId)
      .maybeSingle();
    if (supErr) throw new Error(supErr.message);
    if (!supRow) return res.status(400).json({ error: 'Supplier not found for this company' });

    const userId = req.user && req.user.userId ? req.user.userId : null;

    // Insert payment
    const { data: payment, error: payErr } = await supabase
      .from('supplier_payments')
      .insert({
        company_id:             companyId,
        supplier_id:            parseInt(supplierId),
        payment_date:           paymentDate,
        payment_method:         paymentMethod || 'bank_transfer',
        reference:              reference || null,
        amount:                 parseFloat(amount),
        notes:                  notes || null,
        bank_ledger_account_id: bankLedgerAccountId ? parseInt(bankLedgerAccountId) : null,
        created_by_user_id:     userId,
      })
      .select()
      .single();
    if (payErr) throw new Error(payErr.message);

    // Apply allocations to invoices
    if (allocations && allocations.length) {
      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount) continue;

        const { error: allocErr } = await supabase
          .from('supplier_payment_allocations')
          .insert({
            payment_id: payment.id,
            invoice_id: parseInt(alloc.invoiceId),
            amount:     parseFloat(alloc.amount),
          });
        if (allocErr) throw new Error(allocErr.message);

        // Fetch current invoice totals to recompute status
        const { data: invRow, error: invFetchErr } = await supabase
          .from('supplier_invoices')
          .select('total_inc_vat, amount_paid')
          .eq('id', parseInt(alloc.invoiceId))
          .eq('company_id', companyId)
          .maybeSingle();
        if (invFetchErr) throw new Error(invFetchErr.message);
        if (invRow) {
          const newAmountPaid = parseFloat(invRow.amount_paid) + parseFloat(alloc.amount);
          const newStatus = invoiceStatus(invRow.total_inc_vat, newAmountPaid);
          const { error: invUpdErr } = await supabase
            .from('supplier_invoices')
            .update({
              amount_paid: newAmountPaid,
              status:      newStatus,
              updated_at:  new Date().toISOString(),
            })
            .eq('id', parseInt(alloc.invoiceId))
            .eq('company_id', companyId);
          if (invUpdErr) throw new Error(invUpdErr.message);
        }
      }
    }

    // ── GL Posting (Payment) ──────────────────────────────────────────────
    // DR AP (2000) / CR Bank ledger account — both sides required to post.
    if (bankLedgerAccountId) {
      const apAccount = await findAccountByCode(companyId, '2000');
      if (apAccount) {
        const glJournal = await JournalService.createDraftJournal({
          companyId,
          date: paymentDate,
          reference: reference || null,
          description: `AP Payment: ${paymentMethod || 'bank_transfer'}`,
          sourceType: 'supplier_payment',
          createdByUserId: userId,
          lines: [
            {
              accountId:   apAccount.id,
              debit:       parseFloat(amount),
              credit:      0,
              description: 'Accounts Payable cleared',
            },
            {
              accountId:   parseInt(bankLedgerAccountId),
              debit:       0,
              credit:      parseFloat(amount),
              description: 'Bank payment out',
            },
          ],
        });
        await JournalService.postJournal(glJournal.id, companyId, userId);
        const { error: jidErr } = await supabase
          .from('supplier_payments')
          .update({ journal_id: glJournal.id })
          .eq('id', payment.id);
        if (jidErr) console.warn(`[Suppliers] Failed to link journal_id to payment ${payment.id}:`, jidErr.message);
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
  const companyId = req.companyId;
  try {
    // Fetch unpaid / part-paid invoices with supplier details
    const { data: rows, error } = await supabase
      .from('supplier_invoices')
      .select('id, invoice_number, invoice_date, due_date, total_inc_vat, amount_paid, supplier_id, suppliers!supplier_id(id, name, code)')
      .eq('company_id', companyId)
      .neq('status', 'paid')
      .neq('status', 'cancelled')
      .neq('status', 'draft')
      .order('due_date');
    if (error) throw new Error(error.message);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Group by supplier and bucket into aging periods
    const supplierMap = {};
    for (const row of rows || []) {
      const outstanding = parseFloat(row.total_inc_vat) - parseFloat(row.amount_paid);
      if (outstanding <= 0) continue; // skip fully-covered invoices

      const sup = row.suppliers;
      if (!sup) continue; // skip invoices with no linked supplier

      const sid = sup.id;
      if (!supplierMap[sid]) {
        supplierMap[sid] = {
          supplier_id:   sid,
          supplier_name: sup.name,
          supplier_code: sup.code,
          current:    0,
          days30:     0,
          days60:     0,
          days90:     0,
          days90plus: 0,
          total:      0,
        };
      }

      const dueDate = new Date(row.due_date);
      dueDate.setHours(0, 0, 0, 0);
      const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));

      supplierMap[sid].total += outstanding;
      if (daysOverdue <= 0)        supplierMap[sid].current    += outstanding;
      else if (daysOverdue <= 30)  supplierMap[sid].days30     += outstanding;
      else if (daysOverdue <= 60)  supplierMap[sid].days60     += outstanding;
      else if (daysOverdue <= 90)  supplierMap[sid].days90     += outstanding;
      else                         supplierMap[sid].days90plus += outstanding;
    }

    // Round to 2dp
    const aging = Object.values(supplierMap).map(s => ({
      ...s,
      current:    Math.round(s.current    * 100) / 100,
      days30:     Math.round(s.days30     * 100) / 100,
      days60:     Math.round(s.days60     * 100) / 100,
      days90:     Math.round(s.days90     * 100) / 100,
      days90plus: Math.round(s.days90plus * 100) / 100,
      total:      Math.round(s.total      * 100) / 100,
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
    const { data: supplier, error: supErr } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (supErr) throw new Error(supErr.message);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Compute balance_owing: sum of (total_inc_vat - amount_paid) for unpaid/part-paid invoices
    const { data: invRows, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('total_inc_vat, amount_paid')
      .eq('company_id', companyId)
      .eq('supplier_id', supplierId)
      .neq('status', 'paid')
      .neq('status', 'cancelled')
      .neq('status', 'draft');
    if (invErr) throw new Error(invErr.message);

    const balance_owing = Math.round(
      (invRows || []).reduce(
        (sum, r) => sum + (parseFloat(r.total_inc_vat) - parseFloat(r.amount_paid)), 0
      ) * 100
    ) / 100;

    res.json({ supplier: { ...supplier, balance_owing } });
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
    // Check supplier exists for this company
    const { data: existing, error: chkErr } = await supabase
      .from('suppliers')
      .select('id')
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (chkErr) throw new Error(chkErr.message);
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });

    const { data: supplier, error: updErr } = await supabase
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
    if (updErr) throw new Error(updErr.message);

    res.json({ supplier });
  } catch (err) {
    console.error('PUT /suppliers/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
