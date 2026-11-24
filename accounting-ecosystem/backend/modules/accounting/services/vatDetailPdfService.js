'use strict';

/**
 * VAT Detail Report → PDF (landscape A4). Same content as the Excel download
 * (routes/vat-report.js buildVatDetailWorkbook): the five sections, each with
 * its rows and total, then the "how the VAT is calculated" summary and the
 * tie-out check. Input is the object from vatDetailReportService.generate().
 * Colours follow invoicePdfService (Leo blue).
 */

const PDFDocument = require('pdfkit');
const { SECTION_TITLES } = require('./vatDetailReportService');

const ACCENT   = '#1d4ed8';
const DARKTEXT = '#111827';
const MUTED    = '#6b7280';
const BORDER   = '#e5e7eb';
const HDR_BG   = '#eff6ff';
const GOOD     = '#15803d';
const BAD      = '#b91c1c';

// pdfkit's built-in Helvetica can't draw the narrow no-break space some ICU
// builds use as the en-ZA thousands separator — swap it for a normal space.
function fmtMoney(v) {
  const n = Number(v) || 0;
  return 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/[  ]/g, ' ');
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const COLS = [
  { key: 'date',        label: 'Date',        w: 56 },
  { key: 'reference',   label: 'Reference',   w: 70 },
  { key: 'description', label: 'Description', w: 0 },     // takes the remaining width
  { key: 'account',     label: 'Account',     w: 150 },
  { key: 'exclusive',   label: 'Exclusive',   w: 78, num: true },
  { key: 'vat',         label: 'VAT',         w: 70, num: true },
  { key: 'inclusive',   label: 'Inclusive',   w: 78, num: true },
];

function generateVatDetailPdf(report, companyName) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', layout: 'landscape', margin: 36, bufferPages: true,
        info: { Title: `VAT Detail ${report.periodKey}`, Author: companyName || 'Ledger Leo' },
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const BOTTOM = doc.page.height - doc.page.margins.bottom - 18;   // room for footer
      const fixed = COLS.reduce((s, c) => s + c.w, 0);
      const cols = COLS.map(c => ({ ...c, w: c.w || W - fixed }));
      let x0 = L;
      for (const c of cols) { c.x = x0; x0 += c.w; }

      let y;

      const pageHeader = () => {
        y = doc.page.margins.top;
        doc.font('Helvetica-Bold').fontSize(15).fillColor(ACCENT).text('VAT Detail Report', L, y, { width: W, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(DARKTEXT)
          .text(companyName || '', L, y + 2, { width: W, align: 'right', lineBreak: false });
        y += 20;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text(`VAT period ${report.periodKey}: ${fmtDate(report.dateFrom)} to ${fmtDate(report.dateTo)}  ·  from posted journals in Ledger Leo`, L, y, { width: W, lineBreak: false });
        y += 18;
      };

      const ensure = (h, onNewPage) => {
        if (y + h > BOTTOM) {
          doc.addPage();
          pageHeader();
          if (onNewPage) onNewPage();
        }
      };

      const cell = (text, c, opts = {}) => {
        doc.text(String(text == null ? '' : text), c.x + 3, y + (opts.dy || 4), {
          width: c.w - 6, align: c.num ? 'right' : 'left', lineBreak: false, ellipsis: true,
        });
      };

      const tableHeader = () => {
        doc.rect(L, y, W, 16).fill(HDR_BG);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARKTEXT);
        for (const c of cols) cell(c.label, c);
        y += 16;
      };

      const sectionTitle = (title, cont) => {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(ACCENT)
          .text(title + (cont ? ' (continued)' : ''), L, y, { width: W, lineBreak: false, ellipsis: true });
        y += 15;
      };

      pageHeader();

      for (const section of Object.keys(SECTION_TITLES)) {
        const rows = report.rows.filter(r => r.section === section);
        if (section === 'vat_adjustment' && rows.length === 0) continue;
        const title = SECTION_TITLES[section];
        const t = report.summary.totals[section];

        ensure(15 + 16 + 14 + 16);            // title + header + one row + total
        sectionTitle(title);
        tableHeader();

        const repeatHeader = () => { sectionTitle(title, true); tableHeader(); };

        if (rows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text('None in this period', L + 3, y + 4, { lineBreak: false });
          y += 14;
        }
        for (const r of rows) {
          const h = r.note ? 22 : 14;
          ensure(h, repeatHeader);
          doc.font('Helvetica').fontSize(7.5).fillColor(DARKTEXT);
          cell(fmtDate(r.date), cols[0]);
          cell(r.reference, cols[1]);
          cell(r.description, cols[2]);
          cell(r.account, cols[3]);
          cell(fmtMoney(r.exclusive), cols[4]);
          cell(fmtMoney(r.vat), cols[5]);
          cell(fmtMoney(r.inclusive), cols[6]);
          if (r.note) {
            doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(MUTED);
            cell(r.note, cols[2], { dy: 13 });
          }
          y += h;
          doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.4).strokeColor(BORDER).stroke();
        }

        ensure(16, repeatHeader);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(DARKTEXT);
        doc.text(`Total — ${t.count} entr${t.count === 1 ? 'y' : 'ies'}`, L + 3, y + 4, { width: cols[3].x + cols[3].w - L - 6, lineBreak: false });
        cell(fmtMoney(t.exclusive), cols[4]);
        cell(fmtMoney(t.vat), cols[5]);
        cell(fmtMoney(t.inclusive), cols[6]);
        y += 16;
        doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1).strokeColor(DARKTEXT).stroke();
        y += 14;
      }

      // ── Summary ─────────────────────────────────────────────────────────
      const c = report.summary.calculation;
      const rate = report.summary.rate;
      const tie = report.summary.tieOut;
      const resultLabel = c.result === 'payable' ? 'VAT PAYABLE TO SARS'
        : c.result === 'refundable' ? 'VAT REFUNDABLE BY SARS' : 'NO VAT DUE';

      const lines = [
        ['head', 'OUTPUT VAT (on sales)'],
        ['', 'Standard-rate sales excluding VAT', c.outputStandardExclusive],
        ['muted', `× ${rate}% = expected output VAT`, c.outputVatExpected],
        ['', 'Output VAT actually charged', c.outputVatOnSupplies],
        ...(c.outputVatAdjustments ? [['', 'Output VAT adjustments', c.outputVatAdjustments]] : []),
        ['sub', 'A. Total output VAT', c.outputVat],
        ['muted', 'Sales with no VAT (zero-rated / exempt) — no VAT due', c.outputNoVatExclusive],
        ['head', 'INPUT VAT (on purchases and expenses)'],
        ['', 'Standard-rate purchases excluding VAT', c.inputStandardExclusive],
        ['muted', `× ${rate}% = expected input VAT`, c.inputVatExpected],
        ['', 'Input VAT actually claimed', c.inputVatOnPurchases],
        ...(c.inputVatAdjustments ? [['', 'Input VAT adjustments', c.inputVatAdjustments]] : []),
        ['sub', 'B. Total input VAT', c.inputVat],
        ['muted', 'Purchases with no VAT claimed — nothing to claim', c.inputNoVatExclusive],
        ['sub', 'A - B', c.netVat],   // plain hyphen: Helvetica (WinAnsi) has no U+2212 minus
        ['result', resultLabel, Math.abs(c.netVat)],
      ];
      const sumH = 24 + lines.length * 15 + 60;
      if (y + sumH > BOTTOM) { doc.addPage(); pageHeader(); }

      const boxW = 430;
      const boxTop = y;
      y += 10;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text('Summary — how the VAT is calculated', L + 12, y, { lineBreak: false });
      y += 20;
      for (const [kind, label, value] of lines) {
        if (kind === 'head') y += 4;
        if (kind === 'result') {
          doc.moveTo(L + 12, y).lineTo(L + boxW - 12, y).lineWidth(1).strokeColor(DARKTEXT).stroke();
          y += 4;
        }
        const bold = kind === 'head' || kind === 'sub' || kind === 'result';
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(kind === 'result' ? 11 : 9)
          .fillColor(kind === 'muted' ? MUTED : DARKTEXT);
        doc.text(label, L + 12, y, { width: boxW - 150, lineBreak: false, ellipsis: true });
        if (value !== undefined) doc.text(fmtMoney(value), L + boxW - 140, y, { width: 128, align: 'right', lineBreak: false });
        y += kind === 'result' ? 18 : 15;
      }
      doc.lineWidth(1).roundedRect(L, boxTop, boxW, y - boxTop + 6, 6).strokeColor(ACCENT).stroke();
      y += 16;

      doc.font('Helvetica-Bold').fontSize(9).fillColor(tie.ties ? GOOD : BAD).text(
        tie.ties
          ? 'Check: these totals agree with the VAT control accounts (the VAT201 headline figures).'
          : `Check FAILED: output differs by ${fmtMoney(tie.outputDifference)}, input by ${fmtMoney(tie.inputDifference)} from the VAT control accounts.`,
        L, y, { width: W });
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
        `${report.notVatRelatedCount} entries in this period are not part of VAT (bank transfers, loans, receipts from customers, payments to suppliers, VAT payments) and are not listed. ` +
        'Small differences between "expected" and "actually charged/claimed" are rounding per invoice or bank line.',
        L, y, { width: W });
      for (const w of report.warnings || []) {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Note: ${w}`, L, doc.y + 3, { width: W });
      }

      // ── Footer with page numbers ────────────────────────────────────────
      const range = doc.bufferedPageRange();
      const generated = String(report.generatedAt || '').slice(0, 16).replace('T', ' ');
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        // Writing inside the bottom margin would make pdfkit start a new page —
        // lift the margin while drawing the footer.
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const fy = doc.page.height - savedBottom - 8;
        doc.font('Helvetica').fontSize(7).fillColor(MUTED);
        doc.text(`Generated ${generated} UTC · Ledger Leo`, L, fy, { width: W / 2, lineBreak: false });
        doc.text(`Page ${i + 1} of ${range.count}`, L + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateVatDetailPdf };
