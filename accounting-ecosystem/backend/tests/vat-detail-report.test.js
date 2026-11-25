'use strict';

/**
 * VAT Detail Report — classification of posted journals into output/input,
 * standard/no-VAT rows, the summary calculation and the Excel download.
 * Fictional data only.
 */

jest.mock('../modules/accounting/config/database', () => ({ query: jest.fn() }));
jest.mock('../config/database', () => ({ supabase: {} }));

const XLSX = require('xlsx');
const { classifyJournal, buildSummary } = require('../modules/accounting/services/vatDetailReportService');
const { buildVatDetailWorkbook } = require('../modules/accounting/routes/vat-report');

const L = (code, type, sub_type, debit, credit, name = code) => ({ code, type, sub_type, debit, credit, name });
const BANK = (dr, cr) => L('1010', 'asset', 'bank', dr, cr, 'Bank');
const J = (extra = {}) => ({ id: 1, date: '2026-10-05', reference: 'REF1', description: 'Test entry', ...extra });

describe('classifyJournal', () => {
  test('bank purchase with VAT → input standard, real amounts (not VAT ÷ 15%)', () => {
    const rows = classifyJournal(J(), [
      BANK(0, 2210), L('5000', 'expense', 'cost_of_sales', 1921.74, 0, 'Materials'), L('1400', 'asset', 'current_asset', 288.26, 0),
    ]);
    expect(rows).toEqual([expect.objectContaining({
      section: 'input_standard', exclusive: 1921.74, vat: 288.26, inclusive: 2210, account: 'Materials',
    })]);
  });

  test('bank purchase without VAT → input no VAT', () => {
    const rows = classifyJournal(J(), [BANK(0, 320), L('5001', 'expense', 'cost_of_sales', 320, 0)]);
    expect(rows).toEqual([expect.objectContaining({ section: 'input_no_vat', exclusive: 320, vat: 0, inclusive: 320 })]);
  });

  test('customer invoice with VAT → output standard', () => {
    const rows = classifyJournal(J(), [
      L('1100', 'asset', 'current_asset', 1150, 0, 'Debtors'), L('4000', 'income', 'operating_income', 0, 1000, 'Sales'), L('2300', 'liability', 'current_liability', 0, 150),
    ]);
    expect(rows).toEqual([expect.objectContaining({ section: 'output_standard', exclusive: 1000, vat: 150, inclusive: 1150 })]);
  });

  test('invoice with a 15% part and a 0% part is split', () => {
    const rows = classifyJournal(J(), [
      L('1100', 'asset', 'current_asset', 1650, 0), L('4000', 'income', 'operating_income', 0, 1500, 'Sales'), L('2300', 'liability', 'current_liability', 0, 150),
    ]);
    expect(rows.map(r => [r.section, r.exclusive, r.vat])).toEqual([
      ['output_standard', 1000, 150], ['output_no_vat', 500, 0],
    ]);
  });

  test('rounding difference is not split off', () => {
    const rows = classifyJournal(J(), [BANK(0, 768), L('5000', 'expense', null, 667.83, 0), L('1400', 'asset', 'current_asset', 100.17, 0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].exclusive).toBe(667.83);
  });

  test('stock purchase (current asset) with VAT counts as input', () => {
    const rows = classifyJournal(J(), [BANK(0, 115), L('1300', 'asset', 'current_asset', 100, 0, 'Stock'), L('1400', 'asset', 'current_asset', 15, 0)]);
    expect(rows[0]).toEqual(expect.objectContaining({ section: 'input_standard', exclusive: 100, account: 'Stock' }));
  });

  test('balance-sheet only (transfer / customer receipt / VAT payment) → no rows', () => {
    expect(classifyJournal(J(), [BANK(500, 0), L('1100', 'asset', 'current_asset', 0, 500)])).toEqual([]);
    expect(classifyJournal(J(), [BANK(0, 900), L('1010-2', 'asset', 'bank', 900, 0)])).toEqual([]);
  });

  test('VAT with no income/expense line → adjustment', () => {
    const rows = classifyJournal(J(), [L('1400', 'asset', 'current_asset', 50, 0), L('3000', 'equity', 'equity', 0, 50)]);
    expect(rows).toEqual([expect.objectContaining({ section: 'vat_adjustment', vat: 50, account: 'VAT Input (1400)' })]);
  });

  test('credit note comes out negative', () => {
    const rows = classifyJournal(J(), [
      L('1100', 'asset', 'current_asset', 0, 115), L('4000', 'income', 'operating_income', 100, 0), L('2300', 'liability', 'current_liability', 15, 0),
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({ section: 'output_standard', exclusive: -100, vat: -15, inclusive: -115 }));
  });

  test('out-of-period journal is marked', () => {
    const rows = classifyJournal(J({ is_out_of_period: true }), [BANK(0, 320), L('5001', 'expense', null, 320, 0)]);
    expect(rows[0].note).toMatch(/Late item/);
  });
});

describe('buildSummary', () => {
  const rows = [
    { section: 'output_standard', account: 'Sales', exclusive: 1000, vat: 150, inclusive: 1150 },
    { section: 'output_no_vat', account: 'Sales', exclusive: 200, vat: 0, inclusive: 200 },
    { section: 'input_standard', account: 'Materials', exclusive: 400, vat: 60, inclusive: 460 },
    { section: 'input_no_vat', account: 'Wages', exclusive: 300, vat: 0, inclusive: 300 },
    { section: 'vat_adjustment', account: 'VAT Input (1400)', exclusive: 0, vat: 5, inclusive: 5 },
  ];

  test('A − B with adjustments, ties to headline', () => {
    const s = buildSummary(rows, { outputVat: 150, inputVat: 65 });
    expect(s.calculation).toEqual(expect.objectContaining({
      outputVat: 150, outputVatExpected: 150, inputVat: 65, inputVatAdjustments: 5, netVat: 85, result: 'payable',
      outputNoVatExclusive: 200, inputNoVatExclusive: 300,
    }));
    expect(s.tieOut.ties).toBe(true);
  });

  test('flags a mismatch with the control accounts', () => {
    const s = buildSummary(rows, { outputVat: 150, inputVat: 70 });
    expect(s.tieOut.ties).toBe(false);
    expect(s.tieOut.inputDifference).toBe(-5);
  });

  test('refundable when input exceeds output', () => {
    const s = buildSummary([rows[2]], { outputVat: 0, inputVat: 60 });
    expect(s.calculation.result).toBe('refundable');
    expect(s.calculation.netVat).toBe(-60);
  });
});

describe('PDF download', () => {
  const { generateVatDetailPdf } = require('../modules/accounting/services/vatDetailPdfService');
  const makeReport = n => {
    const rows = Array.from({ length: n }, (_, i) => ({
      section: i % 2 ? 'input_no_vat' : 'input_standard', date: '2026-10-02', reference: `R${i}`,
      description: 'Bank: fictional supplier with a long description that must be cut off neatly', account: 'Materials',
      exclusive: 100, vat: i % 2 ? 0 : 15, inclusive: i % 2 ? 100 : 115, note: i === 3 ? 'Late item moved into this period' : '',
    }));
    return {
      periodKey: '2026-10', dateFrom: '2026-10-01', dateTo: '2026-10-31', generatedAt: '2026-11-24T08:00:00.000Z',
      rows, notVatRelatedCount: 2, warnings: [], summary: buildSummary(rows, { outputVat: 0, inputVat: 15 * Math.ceil(n / 2) }),
    };
  };
  const pageCount = buf => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

  test('builds a valid PDF', async () => {
    const buf = await generateVatDetailPdf(makeReport(4), 'Fictional Co');
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    // sections + the summary box need about two landscape pages
    expect(pageCount(buf)).toBeLessThanOrEqual(2);
  });

  test('every cell is ONE line that fits its column (long text and embedded newlines)', async () => {
    const PDFDocument = require('pdfkit');
    const calls = [];
    const orig = PDFDocument.prototype.text;
    const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, x, y, opts) {
      if (opts && opts.width && opts.lineBreak === false) calls.push({ s: String(str), w: opts.width, fits: this.widthOfString(String(str)) <= opts.width + 0.01 });
      return orig.call(this, str, x, y, opts);
    });
    try {
      const report = makeReport(2);
      report.rows[0].description = 'Bank: Digital Payment TURKSTRA-LIKE FICTIONAL (PTY) LTD\n6 FAKE STREET SOMEWHERE 2531\nReturn address: Private Bag X1, Fictiontown 0001, a very long line indeed';
      report.rows[0].account = 'Cost of Sales — Materials - Purchases 15% with an extra long account name';
      await generateVatDetailPdf(report, 'A Fictional Company With A Rather Long Registered Name (Pty) Ltd');
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter(c => /\n/.test(c.s))).toEqual([]);
    expect(calls.filter(c => !c.fits)).toEqual([]);
    expect(calls.some(c => c.s.endsWith('…'))).toBe(true);
  });

  test('long reports flow onto more pages without blank pages', async () => {
    const buf = await generateVatDetailPdf(makeReport(200), 'Fictional Co');
    const pages = pageCount(buf);
    expect(pages).toBeGreaterThan(3);
    expect(pages).toBeLessThan(10);   // ~32 rows a page; a runaway footer would double this
  });
});

describe('Excel download', () => {
  test('workbook has the sections, rows and summary', () => {
    const rows = [
      { section: 'output_standard', date: '2026-10-01', reference: 'INV1', description: 'Sale', account: 'Sales', exclusive: 1000, vat: 150, inclusive: 1150, note: '' },
      { section: 'input_no_vat', date: '2026-10-02', reference: '', description: 'Bank: fictional supplier', account: 'Wages', exclusive: 300, vat: 0, inclusive: 300, note: '' },
    ];
    const report = {
      periodKey: '2026-10', dateFrom: '2026-10-01', dateTo: '2026-10-31',
      generatedAt: '2026-11-24T08:00:00.000Z', rows, notVatRelatedCount: 3, warnings: [],
      summary: buildSummary(rows, { outputVat: 150, inputVat: 0 }),
    };
    const buf = buildVatDetailWorkbook(report, 'Fictional Co');
    const ws = XLSX.read(buf, { type: 'buffer' }).Sheets['VAT Detail'];
    const text = XLSX.utils.sheet_to_csv(ws);
    expect(text).toMatch(/OUTPUT VAT — Standard rate/);
    expect(text).toMatch(/INPUT — Purchases and expenses with no VAT/);
    expect(text).toMatch(/Bank: fictional supplier/);
    expect(text).toMatch(/A. TOTAL OUTPUT VAT/);
    expect(text).toMatch(/VAT PAYABLE TO SARS/);
    expect(text).toMatch(/agree with the VAT control accounts/);
    expect(text).not.toMatch(/VAT adjustments/);   // empty adjustment section is left out
  });
});
