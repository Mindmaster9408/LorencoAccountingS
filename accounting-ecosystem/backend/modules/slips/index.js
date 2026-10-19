/**
 * ============================================================================
 * Slip Capture (`slips`) — Module Router
 * ============================================================================
 * Mounted at /api/slips in server.js behind authenticateToken +
 * requireModule('slips') + auditMiddleware, like every other module.
 * requireModule() already enforces companies.modules_enabled, per-user app
 * grants, and the super-admin bypass (CLAUDE.md Rule F1).
 *
 * Built to be separable (concept doc: docs/future-build/
 * SLIP_CAPTURE_APP_CONCEPT.md): this module depends only on shared auth,
 * shared storage and the slips table — never on Leo/Paytime/POS internals.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { requireCompany } = require('../../middleware/auth');
const slipsRouter = require('./routes/slips');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ module: 'slips', status: 'active', version: '0.1.0' });
});

router.use(requireCompany);

// Who/where am I — lets the phone app show the company name without keeping
// anything but the auth token in browser storage.
router.get('/context', async (req, res) => {
  const { data: company } = await supabase
    .from('companies')
    .select('id, company_name, trading_name')
    .eq('id', req.companyId)
    .maybeSingle();
  res.json({
    company: company
      ? { id: company.id, name: company.trading_name || company.company_name }
      : { id: req.companyId, name: null },
    user: {
      id: req.user?.userId || null,
      name: req.user?.fullName || req.user?.username || null,
      role: req.user?.role || null,
      isSuperAdmin: !!req.user?.isSuperAdmin,
    },
  });
});

router.use('/', slipsRouter);

module.exports = router;
