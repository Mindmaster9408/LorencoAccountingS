/**
 * ============================================================================
 * Accounting Module — Route Aggregator (Lorenco Accounting Integration)
 * ============================================================================
 * Mounts all Lorenco Accounting sub-routes under the /api/accounting/ prefix.
 * The ECO server.js mounts this at app.use('/api/accounting', ...) so:
 *   /accounts here → /api/accounting/accounts in the full URL
 *   /bank here     → /api/accounting/bank in the full URL
 *   etc.
 * ============================================================================
 */

const express = require('express');
const router = express.Router();

// Accounting-specific middleware
const { enforceCompanyStatus } = require('./middleware/companyStatus');

// Apply company status enforcement to all accounting routes
router.use(enforceCompanyStatus);

// ─── Status endpoint (backward compatibility with ECO dashboard) ────────────
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    module: 'accounting',
    name: 'Lorenco Accounting',
    version: '2.0.0',
    features: [
      'chart-of-accounts',
      'journal-entries',
      'bank-reconciliation',
      'vat-reconciliation',
      'paye-reconciliation',
      'financial-reports',
      'ai-assistant',
      'integrations-api',
      'audit-trail'
    ]
  });
});

// ─── Sub-route mounting ─────────────────────────────────────────────────────
// These are mounted UNDER /api/accounting/ by server.js

// Core accounting
router.use('/accounts', require('./routes/accounts'));
router.use('/journals', require('./routes/journals'));
router.use('/bank', require('./routes/bank'));
router.use('/pos', require('./routes/pos-bridge'));
router.use('/reports', require('./routes/reports'));
router.use('/suppliers', require('./routes/suppliers'));
router.use('/segments', require('./routes/segments'));

// Tax & compliance
router.use('/vat-recon', require('./routes/vatRecon'));
router.use('/paye/config', require('./routes/payeConfig'));
router.use('/paye/reconciliation', require('./routes/payeReconciliation'));

// AI features
router.use('/ai', require('./routes/ai'));

// Audit & administration
router.use('/audit', require('./routes/audit'));

// Company & employees (accounting-specific, does not conflict with ECO shared routes)
router.use('/company', require('./routes/company'));
router.use('/employees', require('./routes/employees'));

// External integrations API
router.use('/integrations', require('./routes/integrations'));
router.use('/kv', require('./routes/kv'));

module.exports = router;
