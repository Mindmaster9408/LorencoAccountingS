'use strict';

/**
 * Personal access tokens for the signed-in user (migration 186).
 *   GET    /api/api-tokens          my keys (never the secret)
 *   POST   /api/api-tokens          { name, expires_in_days? } → { token } shown ONCE
 *   DELETE /api/api-tokens/:id      revoke one of my keys
 *
 * Mounted behind authenticateToken (a normal interactive login — which passed 2FA when the
 * user has it on). A key gives no extra rights: it acts as this user, nothing more.
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');
const ApiTokens = require('../services/apiTokens');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json({ success: true, tokens: await ApiTokens.listTokens(supabase, req.user.userId),
      mcp_url: (process.env.PUBLIC_APP_URL || 'https://app.lorencoecosystem.com').replace(/\/$/, '') + '/mcp',
      mcp_enabled: String(process.env.MCP_ENABLED || '').toLowerCase() === 'true' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    if (ApiTokens.isPlatformAdmin(req.user)) {
      return res.status(403).json({ success: false,
        error: 'Lorenco platform admin accounts cannot have bot keys (they can open every company). Create a separate user for the bot, give it the role you want, and create the key there.' });
    }
    const { name, expires_in_days } = req.body || {};
    const { token, record } = await ApiTokens.createToken(supabase, req.user.userId, { name, expiresInDays: expires_in_days });
    await auditFromReq(req, 'CREATE', 'api_token', record.id, { name: record.name, prefix: record.prefix, expires_at: record.expires_at });
    res.status(201).json({ success: true, token, key: record,
      warning: 'Copy this key now — it is shown only once. Anyone with it can act as you.' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(id > 0)) return res.status(400).json({ success: false, error: 'Invalid key id' });
    const ok = await ApiTokens.revokeToken(supabase, req.user.userId, id, req.user.userId);
    if (!ok) return res.status(404).json({ success: false, error: 'Key not found or already revoked' });
    await auditFromReq(req, 'DELETE', 'api_token', id, { action: 'revoked' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
