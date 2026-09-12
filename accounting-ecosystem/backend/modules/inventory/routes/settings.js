/**
 * ============================================================================
 * Inventory Settings — company display config (international rollout)
 * ============================================================================
 * GET /api/inventory/settings — jurisdiction/currency display config for the
 * authenticated company. This is Stockton's first-ever query against
 * `companies` (confirmed via audit, 2026-09-12) — entirely new/additive,
 * zero risk to any existing Inventory behaviour. Every currency-display
 * string in the frontend (fmtR() etc.) should source its symbol/label from
 * here instead of being hardcoded, per the international-rollout plan.
 * ============================================================================
 */

const express = require('express');
const { buildDisplayConfig } = require('../../../shared/services/jurisdiction');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const supabase = req.supabase;
    const { data: company, error } = await supabase
      .from('companies')
      .select('jurisdiction, currency_code')
      .eq('id', req.companyId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ settings: buildDisplayConfig(company) });
  } catch (err) {
    console.error('[inventory settings] GET error:', err.message);
    // Fail safe to the South African defaults rather than erroring — a
    // display-config fetch must never block the rest of the app from
    // loading, and 'ZA'/'ZAR' is exactly today's behaviour anyway.
    res.json({ settings: buildDisplayConfig(null) });
  }
});

module.exports = router;
