/**
 * Coaching Module — Settings Routes (CJS)
 *
 * GET  /api/coaching/settings   — load global app settings (public, no auth required
 *                                 so branding loads even on the login page)
 * PUT  /api/coaching/settings   — save global settings (authenticated coach only)
 */
const express = require('express');
const { query } = require('../db');
const { authenticateToken, requireCoach } = require('../middleware/auth');

const router = express.Router();

// GET /api/coaching/settings — readable without auth (needed for sidebar branding)
router.get('/', async (req, res) => {
  try {
    const result = await query(
      "SELECT settings_data FROM coaching_settings WHERE settings_key = 'global'"
    );
    const settings = result.rows[0]?.settings_data || {};
    res.json({ success: true, settings });
  } catch (err) {
    // Table may not exist yet (migration 021 not run) — return empty settings
    if (err.code === '42P01') {
      return res.json({ success: true, settings: {} });
    }
    console.error('[Coaching] Get settings error:', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/coaching/settings — authenticated write
router.put('/', authenticateToken, requireCoach, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object required' });
  }
  try {
    await query(
      `INSERT INTO coaching_settings (settings_key, settings_data, updated_at)
       VALUES ('global', $1::jsonb, NOW())
       ON CONFLICT (settings_key)
       DO UPDATE SET settings_data = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(settings)]
    );
    res.json({ success: true });
  } catch (err) {
    // Table may not exist yet — warn and return success so the UI does not break
    if (err.code === '42P01') {
      console.warn('[Coaching] coaching_settings table missing — run migration 021.');
      return res.json({ success: true, warning: 'Settings not persisted — run migration 021.' });
    }
    console.error('[Coaching] Save settings error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
