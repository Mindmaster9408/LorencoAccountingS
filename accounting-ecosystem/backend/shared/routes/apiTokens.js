'use strict';

/**
 * Personal access tokens for the signed-in user (migration 186).
 *   GET    /api/api-tokens          my keys (never the secret)
 *   POST   /api/api-tokens          { name, expires_in_days? } → { token } shown ONCE
 *   PUT    /api/api-tokens/:id/policy  { policy } — what a bot using this key may do on its own
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

// Keys and their bot policy are managed by a PERSON. A bot (a token minted for the bot
// connection) may never create keys or change what it is allowed to do.
router.use((req, res, next) => {
  if (req.user && req.user.via === 'api_token') {
    return res.status(403).json({ success: false, error: 'Bot keys can only be managed by a person signed in to Lorenco' });
  }
  next();
});

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
    const { name, expires_in_days, policy } = req.body || {};
    const { token, record } = await ApiTokens.createToken(supabase, req.user.userId, { name, expiresInDays: expires_in_days, policy });
    await auditFromReq(req, 'CREATE', 'api_token', record.id, { name: record.name, prefix: record.prefix, expires_at: record.expires_at, policy: record.policy });
    res.status(201).json({ success: true, token, key: record,
      warning: 'Copy this key now — it is shown only once. Anyone with it can act as you.' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.put('/:id/policy', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(id > 0)) return res.status(400).json({ success: false, error: 'Invalid key id' });
    const policy = await ApiTokens.setTokenPolicy(supabase, req.user.userId, id, (req.body || {}).policy);
    if (!policy) return res.status(404).json({ success: false, error: 'Key not found or revoked' });
    await auditFromReq(req, 'UPDATE', 'api_token', id, { policy });
    res.json({ success: true, policy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
