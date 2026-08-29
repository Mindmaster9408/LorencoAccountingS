const { supabase } = require('../../../config/database');

/**
 * VAT Category Report Service
 *
 * Produces two views from the same underlying transaction set:
 *  - an itemized "VAT Report" (per-transaction, grouped by output/input + rate category)
 *  - a "VAT201 Calculation Report" (SARS VAT201 field-code summary)
 *
 * Rate classification source-by-source:
 *  - customer_invoice_lines / supplier_invoice_lines: real per-line vat_rate (15 or 0).
 *  - bank/manual journal lines hitting the VAT control accounts (1400/2300): these do
 *    NOT currently carry a reliable rate/category tag anywhere in the schema
 *    (bank_transactions.vat_setting_id and accounts.vat_code both exist but are not
 *    populated in practice — confirmed against live data). They are grouped into a
 *    single disclosed "Bank Allocations & Manual Adjustments" bucket, assumed standard
 *    rate, with a warning — never silently folded into the invoice-based standard-rate
 *    total without disclosure.
 */

const STANDARD_RATE = 15;

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function blankVatAmounts() {
  return { exclusive: 0, inclusive: 0, vat: 0, count: 0 };
}

function addAmounts(bucket, exclusive, inclusive, vat) {
  bucket.exclusive = round2(bucket.exclusive + exclusive);
  bucket.inclusive = round2(bucket.inclusive + inclusive);
  bucket.vat = round2(bucket.vat + vat);
  bucket.count += 1;
}

class VatCategoryReportService {

  async _getCustomerInvoiceItems(companyId, dateFrom, dateTo) {
    const { data, error } = await supabase
      .from('customer_invoices')
      .select(`
        id, invoice_number, date, status, customer_id,
        customers:customer_id ( name ),
        customer_invoice_lines ( id, description, vat_rate, line_total, account_id, accounts:account_id ( code, name ) )
      `)
      .eq('company_id', companyId)
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .neq('status', 'draft')
      .neq('status', 'void');

    if (error) throw new Error(error.message);

    const items = [];
    for (const inv of data || []) {
      const customerName = inv.customers ? inv.customers.name : 'Unknown Customer';
      for (const line of inv.customer_invoice_lines || []) {
        const exclusive = round2(line.line_total);
        const rate = Number(line.vat_rate) || 0;
        const vat = round2(exclusive * (rate / 100));
        items.push({
          date: inv.date,
          reference: inv.invoice_number,
          party: customerName,
          description: line.description || (line.accounts ? line.accounts.name : '') || 'Tax Invoice',
          direction: 'output',
          rate,
          exclusive,
          inclusive: round2(exclusive + vat),
          vat,
          source: 'customer_invoice',
        });
      }
    }
    return items;
  }

  async _getSupplierInvoiceItems(companyId, dateFrom, dateTo) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select(`
        id, invoice_number, date, status, supplier_id,
        suppliers:supplier_id ( name ),
        supplier_invoice_lines ( id, description, vat_rate, line_total, account_id, accounts:account_id ( code, name ) )
      `)
      .eq('company_id', companyId)
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .neq('status', 'draft')
      .neq('status', 'void');

    if (error) throw new Error(error.message);

    const items = [];
    for (const inv of data || []) {
      const supplierName = inv.suppliers ? inv.suppliers.name : 'Unknown Supplier';
      for (const line of inv.supplier_invoice_lines || []) {
        const exclusive = round2(line.line_total);
        const rate = Number(line.vat_rate) || 0;
        const vat = round2(exclusive * (rate / 100));
        items.push({
          date: inv.date,
          reference: inv.invoice_number,
          party: supplierName,
          description: line.description || (line.accounts ? line.accounts.name : '') || 'Tax Invoice',
          direction: 'input',
          rate,
          exclusive,
          inclusive: round2(exclusive + vat),
          vat,
          source: 'supplier_invoice',
        });
      }
    }
    return items;
  }

  /**
   * Bank allocations + manual journals that hit the VAT control accounts directly
   * (not via a customer/supplier invoice). These cannot be split by rate category
   * from current data — see class-level comment — so they are returned as a single
   * disclosed bucket, not silently merged into the invoice-based standard-rate total.
   */
  async _getBankAndManualItems(companyId, dateFrom, dateTo) {
    const { data: journals, error: jErr } = await supabase
      .from('journals')
      .select('id, date, reference, description, source_type')
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .not('source_type', 'in', '(customer_invoice,supplier_invoice)');

    if (jErr) throw new Error(jErr.message);
    if (!journals || journals.length === 0) return [];

    const journalIds = journals.map(j => j.id);
    const { data: lines, error: lErr } = await supabase
      .from('journal_lines')
      .select('journal_id, account_id, debit, credit, accounts:account_id ( code, name )')
      .in('journal_id', journalIds);

    if (lErr) throw new Error(lErr.message);

    const journalMap = {};
    for (const j of journals) journalMap[j.id] = j;

    const items = [];
    for (const line of lines || []) {
      const code = line.accounts ? line.accounts.code : null;
      if (code !== '1400' && code !== '2300') continue;

      const j = journalMap[line.journal_id];
      if (!j) continue;

      if (code === '2300') {
        // Output VAT: credit increases the liability
        const vat = round2((parseFloat(line.credit) || 0) - (parseFloat(line.debit) || 0));
        if (Math.abs(vat) < 0.005) continue;
        const exclusive = round2(vat / (STANDARD_RATE / 100));
        items.push({
          date: j.date, reference: j.reference, party: '—',
          description: j.description || 'Bank/Manual — Output VAT', direction: 'output',
          rate: STANDARD_RATE, exclusive, inclusive: round2(exclusive + vat), vat,
          source: 'bank_or_manual',
        });
      } else {
        // Input VAT: debit increases the asset
        const vat = round2((parseFloat(line.debit) || 0) - (parseFloat(line.credit) || 0));
        if (Math.abs(vat) < 0.005) continue;
        const exclusive = round2(vat / (STANDARD_RATE / 100));
        items.push({
          date: j.date, reference: j.reference, party: '—',
          description: j.description || 'Bank/Manual — Input VAT', direction: 'input',
          rate: STANDARD_RATE, exclusive, inclusive: round2(exclusive + vat), vat,
          source: 'bank_or_manual',
        });
      }
    }
    return items;
  }

  /** Assigns each item to a display category bucket for the itemized VAT Report. */
  _categoryFor(item) {
    if (item.source === 'bank_or_manual') return 'bank_manual';
    if (item.rate === STANDARD_RATE) return 'standard';
    if (item.rate === 0) return 'zero';
    return 'old_rate';
  }

  async getCategorizedReport(companyId, dateFrom, dateTo) {
    const [custItems, supItems, bankItems] = await Promise.all([
      this._getCustomerInvoiceItems(companyId, dateFrom, dateTo),
      this._getSupplierInvoiceItems(companyId, dateFrom, dateTo),
      this._getBankAndManualItems(companyId, dateFrom, dateTo),
    ]);

    const allItems = [...custItems, ...supItems, ...bankItems]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Category totals for the itemized VAT Report groupings.
    const totals = {
      output: { standard: blankVatAmounts(), zero: blankVatAmounts(), old_rate: blankVatAmounts() },
      input: { standard: blankVatAmounts(), zero: blankVatAmounts(), old_rate: blankVatAmounts(), bank_manual: blankVatAmounts() },
      output_bank_manual: blankVatAmounts(),
    };

    for (const item of allItems) {
      const cat = this._categoryFor(item);
      if (item.direction === 'output') {
        const bucket = cat === 'bank_manual' ? totals.output_bank_manual : totals.output[cat];
        addAmounts(bucket, item.exclusive, item.inclusive, item.vat);
      } else {
        const bucket = totals.input[cat] || totals.input.bank_manual;
        addAmounts(bucket, item.exclusive, item.inclusive, item.vat);
      }
    }

    // ── VAT201 field mapping ────────────────────────────────────────────
    // Only fields we have real, disclosed data for are populated; the rest
    // mirror the real SARS VAT201 layout at R0.00 (capital goods, imports,
    // second-hand goods change-in-use, and bad debts adjustments have no
    // data support in this system yet).
    const outputStandardVat = round2(totals.output.standard.vat + totals.output_bank_manual.vat);
    const outputStandardIncl = round2(totals.output.standard.inclusive + totals.output_bank_manual.inclusive);
    const outputZeroExcl = totals.output.zero.exclusive;
    const inputStandardVat = round2(totals.input.standard.vat + totals.input.bank_manual.vat);
    const inputStandardIncl = round2(totals.input.standard.inclusive + totals.input.bank_manual.inclusive);

    const totalA = round2(outputStandardVat);
    const totalB = round2(inputStandardVat);

    const vat201 = {
      field1:  { label: 'Standard Rate (excluding capital goods and/or services and accommodation)', considerationInclVat: outputStandardIncl, vat: outputStandardVat },
      field1a: { label: 'Standard Rate (only capital goods and/or services)', considerationInclVat: 0, vat: 0 },
      field2:  { label: 'Zero Rate (excluding goods exported)', considerationInclVat: outputZeroExcl, vat: 0 },
      field2a: { label: 'Zero Rate (only exported goods)', considerationInclVat: 0, vat: 0 },
      field3:  { label: 'Exempt and non-supplies', considerationInclVat: 0, vat: 0 },
      field4:  { label: 'VAT on Standard Rate Goods and Services', considerationInclVat: null, vat: outputStandardVat },
      field4a: { label: 'VAT on Capital Goods and Services at Standard Rate', considerationInclVat: null, vat: 0 },
      field11: { label: 'Change in use and export of second-hand goods', considerationInclVat: 0, vat: 0 },
      field11a:{ label: 'VAT on Change in Use and Export of Second-Hand Goods', considerationInclVat: null, vat: 0 },
      field12: { label: 'Other Adjustments', considerationInclVat: null, vat: 0 },
      totalA:  { label: 'TOTAL A: TOTAL OUTPUT (4 + 4A + 11 + 12)', considerationInclVat: null, vat: totalA },

      field14:  { label: 'Capital goods and/or services supplied to you', considerationInclVat: null, vat: 0 },
      field14a: { label: 'Capital goods imported by you', considerationInclVat: null, vat: 0 },
      field15:  { label: 'Other goods and services supplied to you (not capital goods)', considerationInclVat: inputStandardIncl, vat: inputStandardVat },
      field15a: { label: 'Other goods imported by you', considerationInclVat: 0, vat: 0 },
      field16:  { label: 'Change in Use (Input VAT Adjustment)', considerationInclVat: null, vat: 0 },
      field17:  { label: 'Bad Debts (Input VAT Adjustment)', considerationInclVat: null, vat: 0 },
      field18:  { label: 'Other Input VAT Adjustments', considerationInclVat: null, vat: 0 },
      totalB:   { label: 'TOTAL B: TOTAL INPUT (14+14A+15+15A+16+17+18)', considerationInclVat: null, vat: totalB },

      field20: { label: 'VAT Payable (TOTAL A - TOTAL B)', considerationInclVat: null, vat: round2(totalA - totalB) },
    };

    const warnings = [];
    if (totals.output_bank_manual.count > 0 || totals.input.bank_manual.count > 0) {
      warnings.push(
        `${totals.output_bank_manual.count + totals.input.bank_manual.count} bank/manual journal ` +
        `item(s) hit the VAT control accounts directly (not via a customer/supplier invoice). ` +
        `These cannot be split into rate categories from current data and are assumed Standard ` +
        `Rate (15%) — verify manually if any of these were actually zero-rated or capital items.`
      );
    }

    return {
      companyId, dateFrom, dateTo,
      items: allItems,
      totals,
      vat201,
      warnings,
      calculationVersion: 'VAT_CATEGORY_ENGINE_V1',
    };
  }
}

module.exports = new VatCategoryReportService();
