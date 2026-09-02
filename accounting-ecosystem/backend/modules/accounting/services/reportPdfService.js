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

module.exports = { generateTrialBalancePdf, fmtMoney, fmtDate };
