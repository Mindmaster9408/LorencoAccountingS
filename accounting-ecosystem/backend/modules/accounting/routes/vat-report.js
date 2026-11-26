const express = require('express');
const router = express.Router();
const vatReportService = require('../services/vatReportService');
const vatCategoryReportService = require('../services/vatCategoryReportService');
const vatDetailReportService = require('../services/vatDetailReportService');
const db = require('../config/database');
const { supabase } = require('../../../config/database');
const XLSX = require('xlsx');
const { generateVatDetailPdf } = require('../services/vatDetailPdfService');
const { authenticate, PERMISSIONS } = require('../middleware/auth');

function canViewVat(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.isGlobalAdmin) return next();

  const role = req.user.role;
  const vatRoles = PERMISSIONS['vat.view'] || [];
  const reportRoles = PERMISSIONS['report.view'] || [];
  if (vatRoles.includes(role) || reportRoles.includes(role)) return next();

  return res.status(403).json({ error: 'Insufficient permissions' });
}

/**
 * GET /api/accounting/vat/report
 * Query:
 * - periodKey (required): YYYY-MM (legacy YYYY.MM accepted and normalized)
 * - includeSources (optional): true|false, default true
 */
router.get('/report', authenticate, canViewVat, async (req, res) => {
  try {
    const periodKey = req.query.periodKey;
    if (!periodKey) {
      return res.status(400).json({ error: 'periodKey is required (YYYY-MM)' });
    }

    const includeSources = String(req.query.includeSources || 'true').toLowerCase() !== 'false';

    const report = await vatReportService.generateVatReport(req.user.companyId, periodKey, {
      includeSources,
      generatedBy: req.user.id || req.user.userId || null,
    });

    return res.json(report);
  } catch (error) {
    if (String(error.message || '').includes('periodKey')) {
      return res.status(400).json({ error: error.message });
    }

    console.error('[vat-report] GET /report error:', error.message);
    return res.status(500).json({ error: 'Failed to generate VAT report', detail: error.message });
  }
});

/**
 * GET /api/accounting/vat/categorized
 * Query:
 * - periodKey (required): YYYY-MM (legacy YYYY.MM accepted and normalized)
 *
 * Returns the itemized transaction list (grouped by output/input + rate category)
 * used to render both the "VAT Report" (detail) and "VAT201 Calculation Report" views.
 * Uses the Supabase REST client (not the direct-Postgres pool that vatReportService
 * uses) so it works in environments without a direct DB connection configured.
 */
router.get('/categorized', authenticate, canViewVat, async (req, res) => {
  try {
    const periodKey = req.query.periodKey;
    if (!periodKey) {
      return res.status(400).json({ error: 'periodKey is required (YYYY-MM)' });
    }

    // Resolve month boundaries from the period key directly (no DB round-trip,
    // and no dependency on the direct-Postgres pool that vat_periods lookups use).
    const { periodKey: canonicalKey } = vatReportService.normalizeVatPeriodKey(periodKey);
    const [yearStr, monthStr] = canonicalKey.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    let dateFrom = `${yearStr}-${monthStr}-01`;
    let dateTo = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    // Bi-monthly / 4- / 6-monthly companies: use the stored period's dates
    // (the VAT page creates the row from the company's VAT cycle first).
    try {
      const { data: rows } = await supabase
        .from('vat_periods').select('period_key, from_date, to_date')
        .eq('company_id', req.user.companyId)
        .in('period_key', [canonicalKey, canonicalKey.replace('-', '.')]);
      const row = (rows || []).find(r => r.period_key === canonicalKey) || (rows || [])[0];
      if (row && row.from_date && row.to_date) { dateFrom = row.from_date; dateTo = row.to_date; }
    } catch (e) {
      console.warn('[vat-report] categorized: period lookup failed, using the month:', e.message);
    }

    const report = await vatCategoryReportService.getCategorizedReport(
      req.user.companyId,
      dateFrom,
      dateTo
    );

    return res.json({ ...report, periodKey: canonicalKey });
  } catch (error) {
    if (String(error.message || '').includes('periodKey')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[vat-report] GET /categorized error:', error.message);
    return res.status(500).json({ error: 'Failed to generate categorized VAT report', detail: error.message });
  }
});

/**
 * GET /api/accounting/vat/detail?periodKey=YYYY-MM
 * Line-by-line VAT detail straight from the posted GL (vatDetailReportService):
 * output standard / output no-VAT / input standard / input no-VAT / adjustments,
 * plus a summary that shows how the VAT is calculated and ties to /vat/report.
 */
router.get('/detail', authenticate, canViewVat, async (req, res) => {
  try {
    if (!req.query.periodKey) return res.status(400).json({ error: 'periodKey is required (YYYY-MM)' });
    const report = await vatDetailReportService.generate(req.user.companyId, req.query.periodKey);
    return res.json(report);
  } catch (error) {
    if (String(error.message || '').includes('periodKey')) return res.status(400).json({ error: error.message });
    console.error('[vat-report] GET /detail error:', error.message);
    return res.status(500).json({ error: 'Failed to generate VAT detail report', detail: error.message });
  }
});

/**
 * GET /api/accounting/vat/detail/export?periodKey=YYYY-MM (Excel)
 * The same detail report as an Excel download (one sheet: sections, then summary).
 */
router.get('/detail/export', authenticate, canViewVat, async (req, res) => {
  try {
    if (!req.query.periodKey) return res.status(400).json({ error: 'periodKey is required (YYYY-MM)' });
    const report = await vatDetailReportService.generate(req.user.companyId, req.query.periodKey);
    const companyName = await companyNameFor(req.user.companyId);
    const buffer = buildVatDetailWorkbook(report, companyName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="VAT_Detail_${safeFileName(companyName)}_${report.periodKey}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    if (String(error.message || '').includes('periodKey')) return res.status(400).json({ error: error.message });
    console.error('[vat-report] GET /detail/export error:', error.message);
    return res.status(500).json({ error: 'Failed to build VAT detail download', detail: error.message });
  }
});

/**
 * GET /api/accounting/vat/detail/pdf?periodKey=YYYY-MM
 * The same detail report as a PDF (landscape A4) — vatDetailPdfService.
 */
router.get('/detail/pdf', authenticate, canViewVat, async (req, res) => {
  try {
    if (!req.query.periodKey) return res.status(400).json({ error: 'periodKey is required (YYYY-MM)' });
    const report = await vatDetailReportService.generate(req.user.companyId, req.query.periodKey);
    const companyName = await companyNameFor(req.user.companyId);
    const buffer = await generateVatDetailPdf(report, companyName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="VAT_Detail_${safeFileName(companyName)}_${report.periodKey}.pdf"`);
    return res.send(buffer);
  } catch (error) {
    if (String(error.message || '').includes('periodKey')) return res.status(400).json({ error: error.message });
    console.error('[vat-report] GET /detail/pdf error:', error.message);
    return res.status(500).json({ error: 'Failed to build VAT detail PDF', detail: error.message });
  }
});

function safeFileName(name) {
  return String(name || 'Company').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_') || 'Company';
}

async function companyNameFor(companyId) {
  try {
    const { rows } = await db.query('SELECT company_name FROM companies WHERE id = $1', [companyId]);
    return rows[0]?.company_name || '';
  } catch (_) {
    return '';
  }
}

/** Builds the VAT detail workbook. Exported for tests. */
function buildVatDetailWorkbook(report, companyName) {
  const { SECTION_TITLES } = vatDetailReportService;
  const aoa = [];
  aoa.push([`VAT Detail Report — ${companyName || ''}`]);
  aoa.push([`VAT period ${report.periodKey}: ${report.dateFrom} to ${report.dateTo}`]);
  aoa.push([`Generated ${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC — from posted journals in Ledger Leo`]);
  aoa.push([]);

  const header = ['Date', 'Reference', 'Description', 'Account', 'Exclusive', 'VAT', 'Inclusive', 'Note'];
  for (const section of Object.keys(SECTION_TITLES)) {
    const rows = report.rows.filter(r => r.section === section);
    const t = report.summary.totals[section];
    if (section === 'vat_adjustment' && rows.length === 0) continue;
    aoa.push([SECTION_TITLES[section]]);
    aoa.push(header);
    if (rows.length === 0) aoa.push(['', '', 'None in this period']);
    for (const r of rows) {
      aoa.push([r.date, r.reference, r.description, r.account, r.exclusive, r.vat, r.inclusive, r.note || '']);
    }
    aoa.push(['', '', `Total (${t.count})`, '', t.exclusive, t.vat, t.inclusive]);
    aoa.push([]);
  }

  const c = report.summary.calculation;
  const rate = report.summary.rate;
  aoa.push(['SUMMARY — HOW THE VAT IS CALCULATED']);
  aoa.push(['', '', 'OUTPUT VAT (on sales)', '', 'Amount']);
  aoa.push(['', '', 'Standard-rate sales excluding VAT', '', c.outputStandardExclusive]);
  aoa.push(['', '', `× ${rate}% = expected output VAT`, '', c.outputVatExpected]);
  aoa.push(['', '', 'Output VAT actually charged on those sales', '', c.outputVatOnSupplies]);
  if (c.outputVatAdjustments) aoa.push(['', '', 'Output VAT adjustments', '', c.outputVatAdjustments]);
  aoa.push(['', '', 'A. TOTAL OUTPUT VAT', '', c.outputVat]);
  aoa.push(['', '', 'Sales with no VAT (zero-rated / exempt) — no VAT due', '', c.outputNoVatExclusive]);
  aoa.push([]);
  aoa.push(['', '', 'INPUT VAT (on purchases and expenses)', '', 'Amount']);
  aoa.push(['', '', 'Standard-rate purchases excluding VAT', '', c.inputStandardExclusive]);
  aoa.push(['', '', `× ${rate}% = expected input VAT`, '', c.inputVatExpected]);
  aoa.push(['', '', 'Input VAT actually claimed on those purchases', '', c.inputVatOnPurchases]);
  if (c.inputVatAdjustments) aoa.push(['', '', 'Input VAT adjustments', '', c.inputVatAdjustments]);
  aoa.push(['', '', 'B. TOTAL INPUT VAT', '', c.inputVat]);
  aoa.push(['', '', 'Purchases with no VAT claimed — no VAT to claim', '', c.inputNoVatExclusive]);
  aoa.push([]);
  aoa.push(['', '', 'A − B', '', c.netVat]);
  const corr = report.summary.corrections && report.summary.corrections.items.length ? report.summary.corrections : null;
  if (corr) {
    aoa.push([]);
    aoa.push(['', '', 'CORRECTIONS OF EARLIER FILED PERIODS']);
    for (const it of corr.items) {
      if (it.outputVat) aoa.push(['', it.sourcePeriodKey, `Output VAT (field 12): ${it.reason}`, '', it.outputVat]);
      if (it.inputVat) aoa.push(['', it.sourcePeriodKey, `Input VAT (field 18): ${it.reason}`, '', -it.inputVat]);
    }
    aoa.push(['', '', 'A − B INCLUDING CORRECTIONS', '', corr.netVatWithCorrections]);
  }
  const finalNet = corr ? corr.netVatWithCorrections : c.netVat;
  const finalResult = corr ? corr.result : c.result;
  aoa.push(['', '', finalResult === 'payable' ? 'VAT PAYABLE TO SARS' : finalResult === 'refundable' ? 'VAT REFUNDABLE BY SARS' : 'NO VAT DUE', '', Math.abs(finalNet)]);
  aoa.push([]);
  const tie = report.summary.tieOut;
  aoa.push(['', '', tie.ties
    ? 'Check: these totals agree with the VAT control accounts (VAT201 headline figures).'
    : `Check FAILED: output differs by ${tie.outputDifference}, input by ${tie.inputDifference} from the VAT control accounts.`]);
  aoa.push(['', '', `${report.notVatRelatedCount} entries in this period are not part of VAT (bank transfers, loans, receipts from customers, payments to suppliers, VAT payments) and are not listed.`]);
  for (const w of report.warnings) aoa.push(['', '', `Note: ${w}`]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 11 }, { wch: 16 }, { wch: 52 }, { wch: 30 }, { wch: 15 }, { wch: 13 }, { wch: 15 }, { wch: 36 }];
  // money format on the number columns
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (const C of [4, 5, 6]) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.t === 'n') cell.z = '#,##0.00;-#,##0.00';
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'VAT Detail');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = router;
module.exports.buildVatDetailWorkbook = buildVatDetailWorkbook;
