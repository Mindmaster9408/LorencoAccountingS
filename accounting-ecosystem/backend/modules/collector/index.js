/**
 * ============================================================================
 * Smart Client Document Collector — Module Router (staff, authenticated)
 * ============================================================================
 * Mounted at /api/collector in server.js behind authenticateToken +
 * requireModule('collector') + auditMiddleware, exactly like every other
 * module. This file only aggregates the STAFF-side routers; the public,
 * unauthenticated upload portal (routes/public-portal.js) is mounted
 * SEPARATELY in server.js at /api/collector/public, outside this middleware
 * chain entirely — see server.js for why that separation matters.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { requireCompany } = require('../../middleware/auth');

const clientsRouter = require('./routes/clients');
const templatesRouter = require('./routes/templates');
const periodsRouter = require('./routes/periods');
const documentsRouter = require('./routes/documents');

const router = express.Router();

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ module: 'collector', status: 'active', version: '0.1.0' });
});

// All routes below require a company context in the JWT. /status is exempt.
router.use(requireCompany);

// Collector is gated purely on companies.modules_enabled — there is no
// "account_holder_type" restriction (unlike Commander/Firmflow, this module
// is not accounting-practice-specific by nature, though its only real user
// today is Lorenco's own practice). Super admins bypass the check (Rule F1).
async function requireCollectorModule(req, res, next) {
  if (req.user?.isSuperAdmin) return next();
  if (!req.companyId) return next(); // requireCompany already handled
  try {
    const { data: co } = await supabase
      .from('companies')
      .select('modules_enabled')
      .eq('id', req.companyId)
      .single();
    if (!co) {
      return res.status(403).json({ error: 'Company not found.', code: 'COMPANY_NOT_FOUND' });
    }
    if (!Array.isArray(co.modules_enabled) || !co.modules_enabled.includes('collector')) {
      return res.status(403).json({
        error: 'Document Collector is not enabled for your company.',
        code: 'COLLECTOR_MODULE_NOT_ENABLED',
      });
    }
    next();
  } catch (err) {
    console.error('[collector] requireCollectorModule error:', err.message);
    return res.status(500).json({ error: 'Failed to verify Collector module access.' });
  }
}
router.use(requireCollectorModule);

router.use('/clients', clientsRouter);
router.use('/', templatesRouter);
router.use('/', periodsRouter);
router.use('/documents', documentsRouter);

module.exports = router;
