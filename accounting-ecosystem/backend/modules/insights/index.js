/**
 * ============================================================================
 * Insights (`insights`) — Module Router
 * ============================================================================
 * Owner reporting app (Syft-style). Concept + decisions:
 * docs/future-build/OWNER_REPORTING_APP_CONCEPT.md. Will carry the name
 * "Commander" later, once that name is moved off the Firmflow copy — the
 * internal key stays `insights` so that move needs no data migration.
 *
 * Mounted at /api/insights in server.js behind authenticateToken +
 * requireModule('insights') + auditMiddleware, like every other module.
 * requireModule() enforces companies.modules_enabled, per-user app grants and
 * the super-admin bypass (CLAUDE.md Rule F1).
 *
 * READ-ONLY: no route in this module writes anything. Numbers come from
 * Ledger Leo's and Checkout Charlie's own report code (see
 * services/overviewService.js) — never from a parallel calculation.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { requireCompany } = require('../../middleware/auth');
const { buildOverview, _internal: { isValidDate } } = require('./services/overviewService');

const router = express.Router();
const MAX_RANGE_DAYS = 3 * 366; // keeps one request bounded

router.get('/status', (req, res) => {
  res.json({ module: 'insights', status: 'active', version: '0.1.0' });
});

router.use(requireCompany);

// Company name + who is looking — the page keeps nothing but its auth token
// in browser storage (CLAUDE.md Part D).
router.get('/context', async (req, res) => {
  try {
    const { data: company } = await supabase
      .from('companies')
      .select('id, company_name, trading_name, modules_enabled')
      .eq('id', req.companyId)
      .maybeSingle();
    res.json({
      company: company
        ? { id: company.id, name: company.trading_name || company.company_name }
        : { id: req.companyId, name: null },
      user: {
        name: req.user?.fullName || req.user?.username || null,
        role: req.user?.role || null,
        isSuperAdmin: !!req.user?.isSuperAdmin,
      },
    });
  } catch (err) {
    console.error('[insights] context:', err.message);
    res.status(500).json({ error: 'Could not load company context' });
  }
});

/**
 * GET /api/insights/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
 *     [&store=…&category=…&paymentMethod=…]   (sales slicers, optional)
 */
router.get('/overview', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD dates' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must be on or before to' });
  }
  const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
  if (days > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: 'Date range may be at most 3 years' });
  }

  const pick = v => (typeof v === 'string' && v.trim() && v.length <= 200 ? v.trim() : null);
  const filters = {
    store: pick(req.query.store),
    category: pick(req.query.category),
    paymentMethod: pick(req.query.paymentMethod),
  };

  try {
    const overview = await buildOverview({
      companyId: req.companyId, user: req.user, from, to, filters,
    });
    res.json({ ...overview, filters });
  } catch (err) {
    console.error('[insights] overview:', err.message);
    res.status(500).json({ error: 'Could not build the dashboard' });
  }
});

module.exports = router;
