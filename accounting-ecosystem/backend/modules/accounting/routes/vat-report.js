const express = require('express');
const router = express.Router();
const vatReportService = require('../services/vatReportService');
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

module.exports = router;
