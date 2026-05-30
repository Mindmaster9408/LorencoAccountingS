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
const { validatePermissionMap } = require('./middleware/auth');

// Validate PERMISSIONS map integrity at startup — fails loudly if misconfigured.
// Unknown or structurally broken permissions must never be discovered at request time.
const permissionErrors = validatePermissionMap();
if (permissionErrors.length > 0) {
  throw new Error(
    `[accounting] Startup aborted — PERMISSIONS map has ${permissionErrors.length} error(s):\n` +
    permissionErrors.map(e => `  - ${e}`).join('\n')
  );
}

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
      'accounts-payable',
      'accounts-receivable',
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
router.use('/accounts',  require('./routes/accounts'));
router.use('/journals',  require('./routes/journals'));
router.use('/periods',   require('./routes/accounting-periods'));
router.use('/year-end',  require('./routes/yearEnd'));
// Bank rules must be mounted BEFORE the generic /bank mount so that
// /bank/rules/* is matched specifically rather than falling into bank.js.
router.use('/bank/rules',   require('./routes/bankRules'));
router.use('/bank',         require('./routes/bank'));
router.use('/bank/staging', require('./routes/bankStaging'));
router.use('/pos', require('./routes/pos-bridge'));
router.use('/reports', require('./routes/reports'));
// OCR drafts mounted BEFORE the generic /suppliers router so the more-specific
// path /suppliers/invoice-ocr-drafts/* is resolved first without ambiguity.
router.use('/suppliers/invoice-ocr-drafts', require('./routes/supplierOcrDrafts'));
router.use('/suppliers', require('./routes/suppliers'));
router.use('/customer-invoices', require('./routes/customer-invoices'));
router.use('/segments', require('./routes/segments'));

// Tax & compliance
router.use('/vat', require('./routes/vat-report'));
router.use('/vat-settings', require('./routes/vat-settings'));
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

// Diagnostics & repair tooling
router.use('/diagnostics', require('./routes/diagnostics'));

// Historical Comparative Financial Engine
router.use('/historical-comparatives', require('./routes/historicalComparatives'));

// Opening Balance / Prior Year Trial Balance Import Engine
router.use('/opening-balances', require('./routes/openingBalances'));

// QA — Pilot Smoke Test Pack
router.use('/pilot-smoke-tests', require('./routes/pilot-smoke-tests'));

// Dashboard — Pilot Action Queue
router.use('/dashboard', require('./routes/dashboard'));

module.exports = router;
