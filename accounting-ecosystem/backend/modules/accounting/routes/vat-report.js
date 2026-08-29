const express = require('express');
const router = express.Router();
const vatReportService = require('../services/vatReportService');
const vatCategoryReportService = require('../services/vatCategoryReportService');
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
    const dateFrom = `${yearStr}-${monthStr}-01`;
    const dateTo = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

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

module.exports = router;
