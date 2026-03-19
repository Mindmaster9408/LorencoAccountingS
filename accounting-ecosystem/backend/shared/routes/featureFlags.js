/**
 * ============================================================================
 * Feature Flags API Routes
 * ============================================================================
 * Admin management + client-facing check endpoints.
 *
 * Admin endpoints (super admin only):
 *   GET    /api/feature-flags              — list all flags
 *   POST   /api/feature-flags              — create flag
 *   GET    /api/feature-flags/:key         — get single flag
 *   PUT    /api/feature-flags/:key         — update flag
 *   DELETE /api/feature-flags/:key         — delete flag
 *
 * Client endpoints (any authenticated user):
 *   GET  /api/feature-flags/check/:key     — is this flag enabled for me?
 *   GET  /api/feature-flags/my-flags       — all flags enabled for my context
 *   GET  /api/feature-flags/app/:app       — flags for a specific app (super admin)
 * ============================================================================
 */

const express = require('express');
const router  = express.Router();

const { requireSuperAdmin } = require('../../middleware/auth');
const { featureFlags }      = require('../../services/featureFlags');

const VALID_ROLLOUT_LEVELS = ['disabled', 'superuser', 'test_client', 'selected_clients', 'all'];
const VALID_APPS = ['global', 'paytime', 'pos', 'accounting', 'sean', 'coaching'];

// ── Admin: list all flags ────────────────────────────────────────────────────

router.get('/', requireSuperAdmin, async (req, res) => {
  try {
    const { app } = req.query;
    const flags = await featureFlags.listFlags(app || null);
    res.json({ flags, total: flags.length });
  } catch (err) {
    console.error('[FF] list error:', err.message);
    res.status(500).json({ error: 'Failed to load feature flags' });
  }
});

// ── Admin: get flags for a specific app ──────────────────────────────────────

router.get('/app/:app', requireSuperAdmin, async (req, res) => {
  try {
    const flags = await featureFlags.listFlags(req.params.app);
    res.json({ flags, app: req.params.app });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// ── Client: get all flags enabled for my context ─────────────────────────────
// Must be registered BEFORE /:key to avoid route conflict

router.get('/my-flags', async (req, res) => {
  try {
    const context = {
      companyId:    req.companyId    || req.user?.companyId    || null,
      isSuperAdmin: req.user?.isSuperAdmin ?? false
    };
    const enabled = await featureFlags.getEnabledFlagsForContext(context);
    res.json({ flags: enabled, companyId: context.companyId });
  } catch (err) {
    console.error('[FF] my-flags error:', err.message);
    res.status(500).json({ error: 'Failed to check flags' });
  }
});

// ── Client: check a single flag ───────────────────────────────────────────────

router.get('/check/:key', async (req, res) => {
  try {
    const context = {
      companyId:    req.companyId    || req.user?.companyId    || null,
      isSuperAdmin: req.user?.isSuperAdmin ?? false
    };
    const enabled = await featureFlags.isEnabled(req.params.key, context);
    res.json({ flag: req.params.key.toUpperCase(), enabled, companyId: context.companyId });
  } catch (err) {
    console.error('[FF] check error:', err.message);
    res.status(500).json({ error: 'Failed to check flag' });
  }
});

// ── Admin: get single flag ───────────────────────────────────────────────────

router.get('/:key', requireSuperAdmin, async (req, res) => {
  try {
    const flag = await featureFlags.getFlag(req.params.key);
    if (!flag) return res.status(404).json({ error: 'Flag not found' });
    res.json({ flag });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load flag' });
  }
});

// ── Admin: create flag ───────────────────────────────────────────────────────

router.post('/', requireSuperAdmin, async (req, res) => {
  const { flag_key, display_name, description, app, is_active, rollout_level, allowed_company_ids } = req.body;

  if (!flag_key || !display_name) {
    return res.status(400).json({ error: 'flag_key and display_name are required' });
  }

  if (rollout_level && !VALID_ROLLOUT_LEVELS.includes(rollout_level)) {
    return res.status(400).json({ error: `rollout_level must be one of: ${VALID_ROLLOUT_LEVELS.join(', ')}` });
  }

  if (app && !VALID_APPS.includes(app)) {
    return res.status(400).json({ error: `app must be one of: ${VALID_APPS.join(', ')}` });
  }

  try {
    const flag = await featureFlags.createFlag(
      { flag_key, display_name, description, app, is_active, rollout_level, allowed_company_ids },
      req.user?.userId
    );
    res.status(201).json({ flag, message: 'Feature flag created' });
  } catch (err) {
    if (err.message.includes('duplicate') || err.message.includes('unique')) {
      return res.status(409).json({ error: 'A flag with that key already exists' });
    }
    console.error('[FF] create error:', err.message);
    res.status(500).json({ error: 'Failed to create feature flag' });
  }
});

// ── Admin: update flag ───────────────────────────────────────────────────────

router.put('/:key', requireSuperAdmin, async (req, res) => {
  const { display_name, description, app, is_active, rollout_level, allowed_company_ids } = req.body;

  if (rollout_level && !VALID_ROLLOUT_LEVELS.includes(rollout_level)) {
    return res.status(400).json({ error: `rollout_level must be one of: ${VALID_ROLLOUT_LEVELS.join(', ')}` });
  }

  try {
    const flag = await featureFlags.updateFlag(
      req.params.key,
      { display_name, description, app, is_active, rollout_level, allowed_company_ids },
      req.user?.userId
    );
    res.json({ flag, message: 'Feature flag updated' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('0 rows')) {
      return res.status(404).json({ error: 'Flag not found' });
    }
    console.error('[FF] update error:', err.message);
    res.status(500).json({ error: 'Failed to update feature flag' });
  }
});

// ── Admin: delete flag ───────────────────────────────────────────────────────

router.delete('/:key', requireSuperAdmin, async (req, res) => {
  try {
    await featureFlags.deleteFlag(req.params.key);
    res.json({ message: 'Feature flag deleted' });
  } catch (err) {
    console.error('[FF] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete feature flag' });
  }
});

module.exports = router;
