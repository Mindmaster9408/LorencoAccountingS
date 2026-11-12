/**
 * ============================================================================
 * Invoice / Statement PDF Service (Ledger Leo)
 * ============================================================================
 * Server-side PDF generation for customer-facing documents — invoices and
 * account statements — built to be emailed as attachments (buffered, not
 * streamed straight to a response). Modeled on the pdfkit layout pattern
 * already proven in backend/modules/practice/billing.js (report-pdf route):
 * manual rect()/text() positioning with small section-header/table helpers,
 * rather than a heavier templating layer.
 *
 * Two generators, one shared header/footer style — a document is either an
 * invoice or a statement, never both, so each has its own top-level function,
 * but they share the same company-branding header and money-formatting.
 * ============================================================================
 */
const PDFDocument = require('pdfkit');

const ACCENT   = '#1d4ed8'; // Leo blue — distinct from Practice's purple report-pack branding
const DARKTEXT = '#111827';
const MUTED    = '#6b7280';
const BORDER   = '#e5e7eb';
const HDR_BG   = '#eff6ff';

function fmtMoney(v) {
  const n = parseFloat(v) || 0;
  return 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  const s = typeof d === 'string' ? d.split('T')[0] : d.toISOString().split('T')[0];
  const [y, m, day] = s.split('-');
  return `${day}/${m}/${y}`;
}

/**
 * Draws the shared company-branding header. Returns the y-coordinate to
 * continue drawing below it. Logo is optional — falls back to text-only
 * (same graceful-degradation the rest of this codebase uses for company
 * branding, e.g. Paytime's pdf-branding.js) since not every company has
 * uploaded one.
 */
function drawCompanyHeader(doc, company, docTitleText) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  let y = doc.y;

  doc.rect(L, y, W, 70).fill(HDR_BG);

  if (company.logo_url) {
    // Caller is responsible for resolving logo_url to a Buffer/data URI
    // before calling this service — pdfkit's doc.image() needs raw bytes,
    // not a remote URL, and this service must stay side-effect-free (no
    // network fetches of its own) so it can be unit-tested without a
    // running server. company.logoBuffer is the field actually read here.
    try {
      if (company.logoBuffer) doc.image(company.logoBuffer, L + 12, y + 10, { fit: [90, 50] });
    } catch (_) {
      // Corrupt/unreadable logo data must never break document generation —
      // fall through to text-only branding.
    }
  }

  const textX = company.logoBuffer ? L + 112 : L + 12;
  doc.fontSize(14).font('Helvetica-Bold').fillColor(DARKTEXT)
    .text(company.trading_name || company.company_name || 'Company', textX, y + 10, { width: W - 200, lineBreak: false });
  doc.fontSize(8).font('Helvetica').fillColor(MUTED);
  const addrLine = [company.address_street, company.address_suburb, company.address_city]
    .filter(Boolean).join(', ');
  if (addrLine) doc.text(addrLine, textX, y + 28, { width: W - 200, lineBreak: false });
  const regLine = [
    company.registration_number ? `Reg: ${company.registration_number}` : null,
    company.vat_number ? `VAT: ${company.vat_number}` : null,
  ].filter(Boolean).join('   ');
  if (regLine) doc.text(regLine, textX, y + 40, { width: W - 200, lineBreak: false });
  const contactLine = [company.contact_email, company.contact_phone].filter(Boolean).join('   ');
  if (contactLine) doc.text(contactLine, textX, y + 52, { width: W - 200, lineBreak: false });

  doc.fontSize(18).font('Helvetica-Bold').fillColor(ACCENT)
    .text(docTitleText, L, y + 10, { width: W - 12, align: 'right' });

  return y + 82;
}

function drawTableHeader(doc, L, W, y, cols) {
  doc.rect(L, y, W, 20).fill(ACCENT);
  let x = L;
  for (const col of cols) {
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff')
      .text(col.label, x + 6, y + 6, { width: col.width - 12, align: col.align || 'left', lineBreak: false });
    x += col.width;
  }
  return y + 20;
}

function drawTableRow(doc, L, y, cols, values, opts = {}) {
  const rh = 18;
  if (opts.zebra) { doc.rect(L, y, cols.reduce((s, c) => s + c.width, 0), rh).fill('#f9fafb'); }
  let x = L;
  for (let i = 0; i < cols.length; i++) {
    doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT)
      .text(String(values[i] ?? ''), x + 6, y + 5, { width: cols[i].width - 12, align: cols[i].align || 'left', lineBreak: false });
    x += cols[i].width;
  }
  return y + rh;
}

/**
 * @param {object} invoice - customer_invoices row (subtotal, vat_amount, total_amount, amount_paid, invoice_number, date, due_date, notes)
 * @param {object[]} lines - customer_invoice_lines rows (description, quantity, unit_price, vat_rate, line_total)
 * @param {object} company - companies row, plus optional company.logoBuffer (Buffer, pre-fetched by the caller)
 * @param {object} customer - customers row (name, email, vat_number)
 * @param {object} [opts]
 * @param {object} [opts.plan] - customer_invoice_recurring_plans row (instalments_total, annual_total) when the invoice is a monthly instalment
 * @returns {Buffer}
 */
// ─── Annual / monthly billing blocks (migration 178) ─────────────────────────

const MONTHS_IN_PLAN = 12;

/** "PAYMENT OPTIONS" box — annual once-off vs monthly x 12. Returns new y. */
function drawPaymentOptions(doc, L, W, y, annualTotal) {
  const annual  = parseFloat(annualTotal) || 0;
  const monthly = Math.round((annual / MONTHS_IN_PLAN) * 100) / 100;
  const h = 58;
  doc.rect(L, y, W, h).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('PAYMENT OPTIONS', L + 10, y + 8);
  const colW = (W - 20) / 2;
  doc.fontSize(8).font('Helvetica').fillColor(MUTED).text('Option 1 — Annual (once-off)', L + 10, y + 22, { width: colW });
  doc.fontSize(11).font('Helvetica-Bold').fillColor(DARKTEXT).text(fmtMoney(annual), L + 10, y + 34, { width: colW });
  doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`Option 2 — Monthly (${MONTHS_IN_PLAN} months)`, L + 10 + colW, y + 22, { width: colW });
  doc.fontSize(11).font('Helvetica-Bold').fillColor(ACCENT).text(`${fmtMoney(monthly)} x ${MONTHS_IN_PLAN}`, L + 10 + colW, y + 34, { width: colW });
  return y + h + 4;
}

/** "Monthly instalment n of N" line on a plan instalment. Returns new y. */
function drawInstalmentNote(doc, L, W, y, instalmentNo, plan) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(ACCENT)
    .text(`Monthly instalment ${instalmentNo} of ${plan.instalments_total}`, L, y, { width: W });
  doc.fontSize(8).font('Helvetica').fillColor(MUTED)
    .text(`Annual agreement: ${fmtMoney(plan.annual_total)}, billed monthly`, L, y + 12, { width: W });
  return y + 26;
}

function generateInvoicePdf(invoice, lines, company, customer, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 45,
        info: { Title: `Invoice ${invoice.invoice_number}`, Author: company.trading_name || company.company_name || 'Ledger Leo' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawCompanyHeader(doc, company, 'TAX INVOICE');

      // Customer + invoice meta, two columns. The bill-to box grows with the
      // buyer's address (a full SA tax invoice needs it) — 60pt minimum as before.
      const cityLine = [customer?.city, customer?.province, customer?.postal_code].filter(Boolean).join(', ');
      const billLines = [customer?.address_line_1, customer?.address_line_2, cityLine, customer?.email,
        customer?.vat_number ? `VAT: ${customer.vat_number}` : null,
        customer?.registration_number ? `Reg: ${customer.registration_number}` : null].filter(Boolean);
      const boxH = Math.max(60, 34 + billLines.length * 11 + 4);
      doc.rect(L, y, W / 2 - 6, boxH).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.rect(L + W / 2 + 6, y, W / 2 - 6, boxH).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();

      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('BILL TO', L + 10, y + 8);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARKTEXT).text(customer?.name || 'Customer', L + 10, y + 20, { width: W / 2 - 30, lineBreak: false });
      billLines.forEach((t, i) => {
        doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(t, L + 10, y + 34 + i * 11, { width: W / 2 - 30, lineBreak: false });
      });

      const rx = L + W / 2 + 16;
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('INVOICE #', rx, y + 8);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARKTEXT).text(invoice.invoice_number, rx, y + 20);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('DATE', rx, y + 34);
      doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(fmtDate(invoice.date), rx + 40, y + 34);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('DUE', rx, y + 46);
      doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(fmtDate(invoice.due_date), rx + 40, y + 46);

      y += boxH + 14;

      const cols = [
        { label: 'DESCRIPTION', width: W * 0.44 },
        { label: 'QTY',         width: W * 0.10, align: 'right' },
        { label: 'UNIT PRICE',  width: W * 0.16, align: 'right' },
        { label: 'VAT',         width: W * 0.10, align: 'right' },
        { label: 'TOTAL',       width: W * 0.20, align: 'right' },
      ];
      y = drawTableHeader(doc, L, W, y, cols);
      (lines || []).forEach((l, i) => {
        const lineExVat = parseFloat(l.line_total) || 0;
        const vatRate   = l.vat_rate != null ? l.vat_rate : 15;
        const lineTotal = lineExVat * (1 + vatRate / 100);
        y = drawTableRow(doc, L, y, cols, [
          l.description || '',
          l.quantity,
          fmtMoney(l.unit_price),
          `${vatRate}%`,
          fmtMoney(lineTotal),
        ], { zebra: i % 2 === 1 });
      });

      y += 8;
      const totalsX = L + W - 200;
      const totalRow = (label, value, bold) => {
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? ACCENT : DARKTEXT)
          .text(label, totalsX, y, { width: 100 });
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? ACCENT : DARKTEXT)
          .text(value, totalsX + 100, y, { width: 100, align: 'right' });
        y += 16;
      };
      totalRow('Subtotal', fmtMoney(invoice.subtotal));
      totalRow('VAT', fmtMoney(invoice.vat_amount));
      totalRow('Total Due', fmtMoney(invoice.total_amount), true);
      if (parseFloat(invoice.amount_paid) > 0) {
        totalRow('Paid', fmtMoney(invoice.amount_paid));
        totalRow('Balance', fmtMoney((parseFloat(invoice.total_amount) || 0) - (parseFloat(invoice.amount_paid) || 0)), true);
      }

      // Annual / monthly billing (migration 178)
      if (invoice.recurring_plan_id && invoice.recurring_instalment_no && opts.plan) {
        y += 6;
        y = drawInstalmentNote(doc, L, W, y, invoice.recurring_instalment_no, opts.plan);
      } else if (invoice.billing_option_enabled && !invoice.billing_choice) {
        y += 10;
        y = drawPaymentOptions(doc, L, W, y, invoice.total_amount);
      }

      if (company.bank_name && company.bank_account_number) {
        y += 16;
        doc.rect(L, y, W, 56).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
        doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('BANKING DETAILS', L + 10, y + 8);
        doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(
          `${company.bank_name}   |   ${company.bank_account_holder || company.trading_name || ''}   |   Acc: ${company.bank_account_number}   |   Branch: ${company.bank_branch_code || ''}`,
          L + 10, y + 22, { width: W - 20 }
        );
        doc.fontSize(8).font('Helvetica-Bold').fillColor(ACCENT).text(`Reference: ${invoice.invoice_number}`, L + 10, y + 38);
      }

      if (invoice.notes) {
        y += 70;
        doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(invoice.notes, L, y, { width: W });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * @param {object} params.customer
 * @param {object} params.company
 * @param {string} params.periodStart, params.periodEnd (YYYY-MM-DD)
 * @param {number} params.openingBalance
 * @param {object[]} params.movements - [{date, type: 'invoice'|'payment', reference, amount, runningBalance}]
 * @returns {Buffer}
 */
function generateStatementPdf({ customer, company, periodStart, periodEnd, openingBalance, movements }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 45,
        info: { Title: `Statement - ${customer.name}`, Author: company.trading_name || company.company_name || 'Ledger Leo' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawCompanyHeader(doc, company, 'STATEMENT');

      doc.rect(L, y, W, 40).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('ACCOUNT', L + 10, y + 8);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARKTEXT).text(customer.name, L + 10, y + 20);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('PERIOD', L + W - 200, y + 8);
      doc.fontSize(9).font('Helvetica').fillColor(DARKTEXT).text(`${fmtDate(periodStart)} — ${fmtDate(periodEnd)}`, L + W - 200, y + 20);
      y += 54;

      const cols = [
        { label: 'DATE',      width: W * 0.16 },
        { label: 'TYPE',      width: W * 0.16 },
        { label: 'REFERENCE', width: W * 0.34 },
        { label: 'AMOUNT',    width: W * 0.17, align: 'right' },
        { label: 'BALANCE',   width: W * 0.17, align: 'right' },
      ];
      y = drawTableHeader(doc, L, W, y, cols);
      y = drawTableRow(doc, L, y, cols, ['', '', 'Opening Balance', '', fmtMoney(openingBalance)], { zebra: false });
      (movements || []).forEach((m, i) => {
        y = drawTableRow(doc, L, y, cols, [
          fmtDate(m.date),
          m.type === 'invoice' ? 'Invoice' : 'Payment',
          m.reference || '',
          fmtMoney(m.amount),
          fmtMoney(m.runningBalance),
        ], { zebra: i % 2 === 1 });
      });

      const closing = movements && movements.length ? movements[movements.length - 1].runningBalance : openingBalance;
      y += 12;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(ACCENT)
        .text('Amount Due', L + W - 200, y, { width: 100 });
      doc.fontSize(11).font('Helvetica-Bold').fillColor(ACCENT)
        .text(fmtMoney(closing), L + W - 100, y, { width: 100, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Quotation PDF — same look as the invoice. Added 2026-11-11 so a client can
 * actually be shown a quote (including the annual / monthly options block);
 * quotes previously had no printable/sendable form at all.
 *
 * @param {object} quote - customer_quotes row (quote_number, quote_date, expiry_date, customer_name, subtotal_ex_vat, vat_amount, total_inc_vat, notes, terms, billing_option_enabled)
 * @param {object[]} lines - customer_quote_lines rows (description, quantity, unit_price, vat_rate, total_inc_vat)
 * @param {object} company - companies row
 * @param {object|null} customer - customers row (name, email, vat_number) if linked
 * @returns {Promise<Buffer>}
 */
function generateQuotePdf(quote, lines, company, customer) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 45,
        info: { Title: `Quotation ${quote.quote_number}`, Author: company.trading_name || company.company_name || 'Ledger Leo' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawCompanyHeader(doc, company, 'QUOTATION');

      doc.rect(L, y, W / 2 - 6, 60).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.rect(L + W / 2 + 6, y, W / 2 - 6, 60).fill('#f9fafb').strokeColor(BORDER).lineWidth(0.5).stroke();

      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('QUOTE FOR', L + 10, y + 8);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARKTEXT).text(customer?.name || quote.customer_name || 'Customer', L + 10, y + 20, { width: W / 2 - 30, lineBreak: false });
      if (customer?.email) doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(customer.email, L + 10, y + 34, { width: W / 2 - 30, lineBreak: false });
      if (customer?.vat_number) doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`VAT: ${customer.vat_number}`, L + 10, y + 46, { width: W / 2 - 30, lineBreak: false });

      const rx = L + W / 2 + 16;
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('QUOTE #', rx, y + 8);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARKTEXT).text(quote.quote_number, rx, y + 20);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('DATE', rx, y + 34);
      doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(fmtDate(quote.quote_date), rx + 50, y + 34);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('VALID UNTIL', rx, y + 46);
      doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(fmtDate(quote.expiry_date), rx + 50, y + 46);

      y += 74;

      const cols = [
        { label: 'DESCRIPTION', width: W * 0.44 },
        { label: 'QTY',         width: W * 0.10, align: 'right' },
        { label: 'UNIT PRICE',  width: W * 0.16, align: 'right' },
        { label: 'VAT',         width: W * 0.10, align: 'right' },
        { label: 'TOTAL',       width: W * 0.20, align: 'right' },
      ];
      y = drawTableHeader(doc, L, W, y, cols);
      (lines || []).forEach((l, i) => {
        const vatRate = l.vat_rate != null ? l.vat_rate : 15;
        y = drawTableRow(doc, L, y, cols, [
          l.description || '',
          l.quantity,
          fmtMoney(l.unit_price),
          `${vatRate}%`,
          fmtMoney(l.total_inc_vat),
        ], { zebra: i % 2 === 1 });
      });

      y += 8;
      const totalsX = L + W - 200;
      const totalRow = (label, value, bold) => {
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? ACCENT : DARKTEXT)
          .text(label, totalsX, y, { width: 100 });
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? ACCENT : DARKTEXT)
          .text(value, totalsX + 100, y, { width: 100, align: 'right' });
        y += 16;
      };
      totalRow('Subtotal', fmtMoney(quote.subtotal_ex_vat));
      totalRow('VAT', fmtMoney(quote.vat_amount));
      totalRow('Total', fmtMoney(quote.total_inc_vat), true);

      if (quote.billing_option_enabled) {
        y += 10;
        y = drawPaymentOptions(doc, L, W, y, quote.total_inc_vat);
      }

      const extra = [quote.notes, quote.terms].filter(Boolean).join('\n\n');
      if (extra) {
        y += 14;
        doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(extra, L, y, { width: W });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoicePdf, generateQuotePdf, generateStatementPdf, fmtMoney, fmtDate };
