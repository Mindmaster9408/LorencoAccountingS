/**
 * ============================================================================
 * Financial Report PDF Service (Ledger Leo)
 * ============================================================================
 * Server-side PDF generation for internal/accountant-facing financial
 * reports — starting with Trial Balance. Kept separate from
 * invoicePdfService.js (customer-facing documents — invoices/statements):
 * different audience, different content shape, no reason to force them
 * through one file. Same pdfkit layout approach either way (manual
 * rect()/text() positioning, proven in practice/billing.js).
 * ============================================================================
 */
const PDFDocument = require('pdfkit');

const ACCENT   = '#1d4ed8';
const DARKTEXT = '#111827';
const MUTED    = '#6b7280';
const HDR_BG   = '#eff6ff';

function fmtMoney(v) {
  const n = parseFloat(v) || 0;
  return n === 0 ? '-' : 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  const s = typeof d === 'string' ? d.split('T')[0] : d.toISOString().split('T')[0];
  const [y, m, day] = s.split('-');
  return `${day}/${m}/${y}`;
}

function drawReportHeader(doc, company, title, subtitle) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const y = doc.y;

  doc.rect(L, y, W, 60).fill(HDR_BG);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(DARKTEXT)
    .text(company.trading_name || company.company_name || 'Company', L + 12, y + 10, { width: W - 12, lineBreak: false });
  const regLine = [
    company.registration_number ? `Reg: ${company.registration_number}` : null,
    company.vat_number ? `VAT: ${company.vat_number}` : null,
  ].filter(Boolean).join('   ');
  if (regLine) doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(regLine, L + 12, y + 28, { width: W - 12, lineBreak: false });

  doc.fontSize(16).font('Helvetica-Bold').fillColor(ACCENT).text(title, L, y + 8, { width: W - 12, align: 'right' });
  if (subtitle) doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(subtitle, L, y + 30, { width: W - 12, align: 'right' });

  return y + 76;
}

function drawSectionHeader(doc, L, W, y, label) {
  doc.rect(L, y, W, 18).fill('#f3f4f6');
  doc.fontSize(8).font('Helvetica-Bold').fillColor(ACCENT)
    .text(label, L + 8, y + 5, { width: W - 16, lineBreak: false });
  return y + 18;
}

function drawRow(doc, L, W, y, code, name, dr, cr, opts = {}) {
  const rh = 16;
  if (opts.zebra) doc.rect(L, y, W, rh).fill('#fafafa');
  const codeW = 60, nameW = W - 60 - 130 - 130, amtW = 130;
  doc.fontSize(8).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(DARKTEXT)
    .text(code, L + 8, y + 4, { width: codeW - 8, lineBreak: false });
  doc.text(name, L + codeW, y + 4, { width: nameW, lineBreak: false });
  doc.text(dr, L + codeW + nameW, y + 4, { width: amtW - 8, align: 'right', lineBreak: false });
  doc.text(cr, L + codeW + nameW + amtW, y + 4, { width: amtW - 8, align: 'right', lineBreak: false });
  return y + rh;
}

/**
 * @param {object} params.company - companies row
 * @param {string} params.fromDate, params.toDate - YYYY-MM-DD
 * @param {object[]} params.accounts - [{code, name, type, balance}], balance = debit - credit
 * @param {{debit:number, credit:number}} params.totals - sum of the dr/cr actually shown (not gross activity)
 * @returns {Promise<Buffer>}
 */
function generateTrialBalancePdf({ company, fromDate, toDate, accounts }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 45,
        info: { Title: 'Trial Balance', Author: company.trading_name || company.company_name || 'Ledger Leo' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawReportHeader(doc, company, 'TRIAL BALANCE', `${fmtDate(fromDate)} — ${fmtDate(toDate)}`);

      // Column header row
      doc.rect(L, y, W, 18).fill(ACCENT);
      const codeW = 60, nameW = W - 60 - 130 - 130, amtW = 130;
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('CODE', L + 8, y + 5, { width: codeW - 8, lineBreak: false });
      doc.text('ACCOUNT NAME', L + codeW, y + 5, { width: nameW, lineBreak: false });
      doc.text('DEBIT (ZAR)', L + codeW + nameW, y + 5, { width: amtW - 8, align: 'right', lineBreak: false });
      doc.text('CREDIT (ZAR)', L + codeW + nameW + amtW, y + 5, { width: amtW - 8, align: 'right', lineBreak: false });
      y += 18;

      const groups = [
        { type: 'asset', label: 'ASSETS' },
        { type: 'liability', label: 'LIABILITIES' },
        { type: 'equity', label: 'EQUITY' },
        { type: 'income', label: 'INCOME' },
        { type: 'expense', label: 'EXPENSES' },
      ];

      // Same convention as the on-screen report and CSV export: TOTAL is the
      // sum of the dr/cr values actually drawn per row, not the backend's
      // gross debit/credit activity figure — see 2026-09-02 fix, same reasoning
      // applies here so the PDF never shows a different number than the screen.
      let totalDr = 0, totalCr = 0;
      let zebra = false;

      for (const group of groups) {
        const rows = accounts.filter(a => a.type === group.type);
        if (!rows.length) continue;

        if (y > doc.page.height - 100) { doc.addPage(); y = doc.page.margins.top; }
        y = drawSectionHeader(doc, L, W, y, group.label);

        for (const acct of rows) {
          const bal = parseFloat(acct.balance || 0);
          const dr = bal > 0 ? bal : 0;
          const cr = bal < 0 ? -bal : 0;
          totalDr += dr;
          totalCr += cr;

          if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          y = drawRow(doc, L, W, y, acct.code, acct.name, fmtMoney(dr), fmtMoney(cr), { zebra });
          zebra = !zebra;
        }
        y += 6;
      }

      y += 6;
      if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
      doc.rect(L, y, W, 20).fill('#111827');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('TOTAL', L + 8, y + 6, { width: codeW + nameW - 8, lineBreak: false });
      doc.text(fmtMoney(totalDr), L + codeW + nameW, y + 6, { width: amtW - 8, align: 'right', lineBreak: false });
      doc.text(fmtMoney(totalCr), L + codeW + nameW + amtW, y + 6, { width: amtW - 8, align: 'right', lineBreak: false });
      y += 28;

      const isBalanced = Math.abs(totalDr - totalCr) < 0.01;
      doc.fontSize(8).font('Helvetica').fillColor(isBalanced ? MUTED : '#dc2626')
        .text(isBalanced ? 'Books balanced.' : `Out of balance by R ${Math.abs(totalDr - totalCr).toFixed(2)}.`, L, y);

      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(`Generated ${fmtDate(new Date().toISOString())} via Ledger Leo`, L, doc.page.height - doc.page.margins.bottom - 12, { width: W, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * @param {object} params.company
 * @param {string} params.asOfDate
 * @param {object[]} params.assets, params.liabilities, params.equity - [{code, name, balance}]
 * @param {number} params.currentYearEarnings
 * @param {object} params.totals - {assets, liabilities, equity, liabilitiesAndEquity}
 * @returns {Promise<Buffer>}
 */
function generateBalanceSheetPdf({ company, asOfDate, assets, liabilities, equity, currentYearEarnings, totals }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45, info: { Title: 'Balance Sheet', Author: company.trading_name || company.company_name || 'Ledger Leo' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const nameW = W - 130;
      let y = drawReportHeader(doc, company, 'BALANCE SHEET', `As at ${fmtDate(asOfDate)}`);

      const section = (label, rows, total, extraRow) => {
        if (y > doc.page.height - 100) { doc.addPage(); y = doc.page.margins.top; }
        y = drawSectionHeader(doc, L, W, y, label);
        let zebra = false;
        for (const a of rows) {
          if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          doc.rect(L, y, W, 16).fill(zebra ? '#fafafa' : '#ffffff');
          doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(`${a.code}  ${a.name}`, L + 8, y + 4, { width: nameW - 8, lineBreak: false });
          doc.text(fmtMoney(a.balance), L + nameW, y + 4, { width: 130 - 8, align: 'right', lineBreak: false });
          y += 16;
          zebra = !zebra;
        }
        if (extraRow) {
          doc.fontSize(8).font('Helvetica-Oblique').fillColor(MUTED).text(extraRow.label, L + 8, y + 4, { width: nameW - 8, lineBreak: false });
          doc.text(fmtMoney(extraRow.value), L + nameW, y + 4, { width: 130 - 8, align: 'right', lineBreak: false });
          y += 16;
        }
        doc.rect(L, y, W, 18).fill('#e5e7eb');
        doc.fontSize(8).font('Helvetica-Bold').fillColor(DARKTEXT).text(`Total ${label}`, L + 8, y + 5, { width: nameW - 8, lineBreak: false });
        doc.text(fmtMoney(total), L + nameW, y + 5, { width: 130 - 8, align: 'right', lineBreak: false });
        y += 30;
      };

      section('ASSETS', assets, totals.assets);
      section('LIABILITIES', liabilities, totals.liabilities);
      section('EQUITY', equity, totals.equity, { label: 'Current Year Earnings', value: currentYearEarnings });

      if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
      doc.rect(L, y, W, 20).fill('#111827');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('TOTAL LIABILITIES + EQUITY', L + 8, y + 6, { width: nameW - 8, lineBreak: false });
      doc.text(fmtMoney(totals.liabilitiesAndEquity), L + nameW, y + 6, { width: 130 - 8, align: 'right', lineBreak: false });

      doc.end();
    } catch (err) { reject(err); }
  });
}

/**
 * @param {object} params.company
 * @param {string} params.fromDate, params.toDate
 * @param {object[]} params.operatingIncome, params.costOfSales, params.otherIncome,
 *   params.operatingExpenses, params.depreciation, params.financeCosts - [{code, name, balance}]
 * @param {object} params.totals
 * @returns {Promise<Buffer>}
 */
function generateProfitLossPdf({ company, fromDate, toDate, operatingIncome, costOfSales, otherIncome, operatingExpenses, depreciation, financeCosts, totals }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45, info: { Title: 'Profit & Loss', Author: company.trading_name || company.company_name || 'Ledger Leo' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const nameW = W - 130;
      let y = drawReportHeader(doc, company, 'PROFIT & LOSS', `${fmtDate(fromDate)} — ${fmtDate(toDate)}`);

      const section = (label, rows) => {
        if (!rows.length) return;
        if (y > doc.page.height - 100) { doc.addPage(); y = doc.page.margins.top; }
        y = drawSectionHeader(doc, L, W, y, label);
        let zebra = false;
        for (const a of rows) {
          if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          doc.rect(L, y, W, 16).fill(zebra ? '#fafafa' : '#ffffff');
          doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(`${a.code}  ${a.name}`, L + 8, y + 4, { width: nameW - 8, lineBreak: false });
          doc.text(fmtMoney(a.balance), L + nameW, y + 4, { width: 130 - 8, align: 'right', lineBreak: false });
          y += 16;
          zebra = !zebra;
        }
        y += 4;
      };
      const subtotal = (label, value, bold) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
        doc.rect(L, y, W, 18).fill(bold ? '#111827' : '#e5e7eb');
        doc.fontSize(bold ? 9 : 8).font('Helvetica-Bold').fillColor(bold ? '#ffffff' : DARKTEXT)
          .text(label, L + 8, y + 5, { width: nameW - 8, lineBreak: false });
        doc.text(fmtMoney(value), L + nameW, y + 5, { width: 130 - 8, align: 'right', lineBreak: false });
        y += 26;
      };

      section('OPERATING INCOME', operatingIncome);
      section('COST OF SALES', costOfSales);
      if (costOfSales.length) subtotal('Gross Profit', totals.grossProfit);
      section('OTHER INCOME', otherIncome);
      section('OPERATING EXPENSES', operatingExpenses);
      section('DEPRECIATION & AMORTISATION', depreciation);
      subtotal('Operating Profit', totals.operatingProfit);
      section('FINANCE COSTS', financeCosts);
      subtotal('Net Profit', totals.netProfit, true);

      doc.end();
    } catch (err) { reject(err); }
  });
}

/**
 * Shared by Aged Debtors and Aged Creditors — same shape, different label/title.
 * @param {object} params.company
 * @param {string} params.asAt
 * @param {string} params.title - 'AGED DEBTORS' | 'AGED CREDITORS'
 * @param {object[]} params.customers - [{customerName, current, days30, days60, days90, days90plus, total, invoiceCount}]
 * @param {object} params.totals
 * @returns {Promise<Buffer>}
 */
function generateAgingPdf({ company, asAt, title, customers, totals }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40, info: { Title: title, Author: company.trading_name || company.company_name || 'Ledger Leo' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawReportHeader(doc, company, title, `As at ${fmtDate(asAt)}`);

      const cols = [
        { label: 'NAME',    width: W * 0.28 },
        { label: 'CURRENT', width: W * 0.12, align: 'right' },
        { label: '0-30',    width: W * 0.12, align: 'right' },
        { label: '31-60',   width: W * 0.12, align: 'right' },
        { label: '61-90',   width: W * 0.12, align: 'right' },
        { label: '90+',     width: W * 0.12, align: 'right' },
        { label: 'TOTAL',   width: W * 0.12, align: 'right' },
      ];
      doc.rect(L, y, W, 18).fill(ACCENT);
      let x = L;
      for (const col of cols) {
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff').text(col.label, x + 6, y + 5, { width: col.width - 12, align: col.align || 'left', lineBreak: false });
        x += col.width;
      }
      y += 18;

      let zebra = false;
      for (const c of customers) {
        if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
        if (zebra) doc.rect(L, y, W, 16).fill('#fafafa');
        const vals = [c.customerName, fmtMoney(c.current), fmtMoney(c.days30), fmtMoney(c.days60), fmtMoney(c.days90), fmtMoney(c.days90plus), fmtMoney(c.total)];
        x = L;
        for (let i = 0; i < cols.length; i++) {
          doc.fontSize(8).font(i === 0 ? 'Helvetica' : 'Helvetica').fillColor(DARKTEXT)
            .text(vals[i], x + 6, y + 4, { width: cols[i].width - 12, align: cols[i].align || 'left', lineBreak: false });
          x += cols[i].width;
        }
        y += 16;
        zebra = !zebra;
      }

      y += 6;
      doc.rect(L, y, W, 20).fill('#111827');
      const totalVals = ['TOTAL', fmtMoney(totals.current), fmtMoney(totals.days30), fmtMoney(totals.days60), fmtMoney(totals.days90), fmtMoney(totals.days90plus), fmtMoney(totals.total)];
      x = L;
      for (let i = 0; i < cols.length; i++) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff').text(totalVals[i], x + 6, y + 5, { width: cols[i].width - 12, align: cols[i].align || 'left', lineBreak: false });
        x += cols[i].width;
      }

      doc.end();
    } catch (err) { reject(err); }
  });
}

/**
 * @param {object} params.company, params.account - {code, name}
 * @param {string} params.fromDate, params.toDate
 * @param {number} params.openingBalance
 * @param {object[]} params.transactions - [{date, reference, journal_description, line_description, debit, credit, balance}]
 * @returns {Promise<Buffer>}
 */
function generateGeneralLedgerPdf({ company, account, fromDate, toDate, openingBalance, transactions }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45, info: { Title: `General Ledger - ${account.code}`, Author: company.trading_name || company.company_name || 'Ledger Leo' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawReportHeader(doc, company, 'GENERAL LEDGER', `${account.code} — ${account.name}   |   ${fmtDate(fromDate)} — ${fmtDate(toDate)}`);

      const cols = [
        { label: 'DATE',   width: W * 0.12 },
        { label: 'REF',    width: W * 0.12 },
        { label: 'DESCRIPTION', width: W * 0.36 },
        { label: 'DEBIT',  width: W * 0.13, align: 'right' },
        { label: 'CREDIT', width: W * 0.13, align: 'right' },
        { label: 'BALANCE', width: W * 0.14, align: 'right' },
      ];
      doc.rect(L, y, W, 18).fill(ACCENT);
      let x = L;
      for (const col of cols) {
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff').text(col.label, x + 6, y + 5, { width: col.width - 12, align: col.align || 'left', lineBreak: false });
        x += col.width;
      }
      y += 18;

      doc.rect(L, y, W, 16).fill('#f3f4f6');
      doc.fontSize(8).font('Helvetica-Bold').fillColor(DARKTEXT).text('Opening Balance', L + 6, y + 4, { width: W * 0.6 - 6, lineBreak: false });
      doc.text(fmtMoney(openingBalance), L + W * 0.86, y + 4, { width: W * 0.14 - 6, align: 'right', lineBreak: false });
      y += 16;

      let zebra = false;
      for (const t of transactions) {
        if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
        if (zebra) doc.rect(L, y, W, 16).fill('#fafafa');
        const desc = t.line_description || t.journal_description || '';
        const vals = [fmtDate(t.date), t.reference || '—', desc, fmtMoney(t.debit), fmtMoney(t.credit), fmtMoney(t.balance)];
        x = L;
        for (let i = 0; i < cols.length; i++) {
          doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT).text(vals[i], x + 6, y + 4, { width: cols[i].width - 12, align: cols[i].align || 'left', lineBreak: false });
          x += cols[i].width;
        }
        y += 16;
        zebra = !zebra;
      }

      doc.end();
    } catch (err) { reject(err); }
  });
}

/**
 * @param {object} params.company
 * @param {string} params.fromDate, params.toDate
 * @param {number} params.netIncome, params.depreciationAddBack, params.openingCash, params.closingCash
 * @param {object[]} params.operatingWorkingCapital, params.investing, params.financing - [{code, name, movement}]
 * @param {object} params.totals - {operating, investing, financing, netChangeInCash}
 * @returns {Promise<Buffer>}
 */
function generateCashFlowPdf({ company, fromDate, toDate, netIncome, depreciationAddBack, operatingWorkingCapital, investing, financing, totals, openingCash, closingCash }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45, info: { Title: 'Cash Flow Statement', Author: company.trading_name || company.company_name || 'Ledger Leo' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const nameW = W - 130;
      let y = drawReportHeader(doc, company, 'CASH FLOW STATEMENT', `${fmtDate(fromDate)} — ${fmtDate(toDate)}`);

      const line = (label, value, opts = {}) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
        if (opts.fill) doc.rect(L, y, W, 16).fill(opts.fill);
        doc.fontSize(opts.bold ? 9 : 8).font(opts.bold ? 'Helvetica-Bold' : (opts.italic ? 'Helvetica-Oblique' : 'Helvetica'))
          .fillColor(opts.color || DARKTEXT)
          .text(label, L + (opts.indent || 8), y + 4, { width: nameW - (opts.indent || 8), lineBreak: false });
        if (value != null) {
          doc.fontSize(opts.bold ? 9 : 8).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(opts.color || DARKTEXT)
            .text(fmtMoney(value), L + nameW, y + 4, { width: 130 - 8, align: 'right', lineBreak: false });
        }
        y += 16;
      };

      y = drawSectionHeader(doc, L, W, y, 'OPERATING ACTIVITIES');
      line('Net Income', netIncome);
      line('Depreciation & Amortisation', depreciationAddBack);
      for (const a of operatingWorkingCapital) line(`${a.code}  ${a.name}`, a.movement, { indent: 16 });
      line('Net Cash from Operating Activities', totals.operating, { bold: true, fill: '#e5e7eb' });
      y += 6;

      y = drawSectionHeader(doc, L, W, y, 'INVESTING ACTIVITIES');
      for (const a of investing) line(`${a.code}  ${a.name}`, a.movement, { indent: 16 });
      if (!investing.length) line('No investing activity in this period', null, { italic: true, color: MUTED });
      line('Net Cash from Investing Activities', totals.investing, { bold: true, fill: '#e5e7eb' });
      y += 6;

      y = drawSectionHeader(doc, L, W, y, 'FINANCING ACTIVITIES');
      for (const a of financing) line(`${a.code}  ${a.name}`, a.movement, { indent: 16 });
      if (!financing.length) line('No financing activity in this period', null, { italic: true, color: MUTED });
      line('Net Cash from Financing Activities', totals.financing, { bold: true, fill: '#e5e7eb' });
      y += 10;

      line('Net Change in Cash', totals.netChangeInCash, { bold: true, fill: '#111827', color: '#ffffff' });
      line('Opening Cash Balance', openingCash);
      line('Closing Cash Balance', closingCash, { bold: true });

      doc.end();
    } catch (err) { reject(err); }
  });
}

/**
 * Shared by Purchase Analysis and Sales Analysis — same shape (an entity
 * breakdown, an account breakdown, a monthly trend), different labels.
 * @param {object} params.company
 * @param {string} params.title - 'PURCHASE ANALYSIS' | 'SALES ANALYSIS'
 * @param {string} params.entityLabel - 'SUPPLIER' | 'CUSTOMER'
 * @param {string} params.amountLabel - 'SPEND' | 'REVENUE'
 * @param {string} params.fromDate, params.toDate
 * @param {object[]} params.byEntity - [{name, invoiceCount, amount}]
 * @param {object[]} params.byAccount - [{accountCode, accountName, amount}]
 * @param {object[]} params.monthlyTrend - [{monthKey, amount}]
 * @param {object} params.totals - {invoiceCount, amount}
 * @returns {Promise<Buffer>}
 */
function generateAnalysisPdf({ company, title, entityLabel, amountLabel, fromDate, toDate, byEntity, byAccount, monthlyTrend, totals }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45, info: { Title: title, Author: company.trading_name || company.company_name || 'Ledger Leo' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      let y = drawReportHeader(doc, company, title, `${fmtDate(fromDate)} — ${fmtDate(toDate)}`);

      const table = (heading, cols, rows, valueKeys) => {
        if (!rows.length) return;
        if (y > doc.page.height - 100) { doc.addPage(); y = doc.page.margins.top; }
        y = drawSectionHeader(doc, L, W, y, heading);
        doc.rect(L, y, W, 16).fill(ACCENT);
        let x = L;
        for (const col of cols) {
          doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff').text(col.label, x + 6, y + 4, { width: col.width - 12, align: col.align || 'left', lineBreak: false });
          x += col.width;
        }
        y += 16;
        let zebra = false;
        for (const row of rows) {
          if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          if (zebra) doc.rect(L, y, W, 15).fill('#fafafa');
          x = L;
          for (let i = 0; i < cols.length; i++) {
            const raw = valueKeys[i](row);
            doc.fontSize(8).font('Helvetica').fillColor(DARKTEXT)
              .text(typeof raw === 'number' ? fmtMoney(raw) : raw, x + 6, y + 3, { width: cols[i].width - 12, align: cols[i].align || 'left', lineBreak: false });
            x += cols[i].width;
          }
          y += 15;
          zebra = !zebra;
        }
        y += 10;
      };

      table(`BY ${entityLabel}`, [
        { label: entityLabel, width: W * 0.5 },
        { label: 'INVOICES', width: W * 0.2, align: 'right' },
        { label: amountLabel, width: W * 0.3, align: 'right' },
      ], byEntity, [r => r.name, r => String(r.invoiceCount), r => r.amount]);

      table('BY ACCOUNT', [
        { label: 'CODE', width: W * 0.15 },
        { label: 'ACCOUNT', width: W * 0.55 },
        { label: amountLabel, width: W * 0.3, align: 'right' },
      ], byAccount, [r => r.accountCode || '—', r => r.accountName, r => r.amount]);

      table('MONTHLY TREND', [
        { label: 'MONTH', width: W * 0.7 },
        { label: amountLabel, width: W * 0.3, align: 'right' },
      ], monthlyTrend, [r => r.monthKey, r => r.amount]);

      if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
      doc.rect(L, y, W, 20).fill('#111827');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text(`TOTAL (${totals.invoiceCount} invoices)`, L + 8, y + 6, { width: W - 150, lineBreak: false });
      doc.text(fmtMoney(totals.amount), L + W - 138, y + 6, { width: 130, align: 'right', lineBreak: false });

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = {
  generateTrialBalancePdf,
  generateBalanceSheetPdf,
  generateProfitLossPdf,
  generateAgingPdf,
  generateGeneralLedgerPdf,
  generateCashFlowPdf,
  generateAnalysisPdf,
  fmtMoney,
  fmtDate,
};
