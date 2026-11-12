/**
 * ============================================================================
 * App subscription routes — /api/app-subscriptions (2026-11-11)
 * ============================================================================
 * Client side (anyone who manages the client — same rule as editing it):
 *   GET  /client/:clientId                  per-app state for "Manage apps"
 *   POST /client/:clientId/request          { app_key, accepted_terms }
 *   POST /client/:clientId/cancel           { app_key } → off on next billing date
 *   POST /client/:clientId/requests/:reqId/withdraw   withdraw / undo cancel
 *
 * Lorenco side (super admin only):
 *   GET  /queue                             pending requests + scheduled cancels
 *   POST /requests/:reqId/approve           { billing_day? }
 *   POST /requests/:reqId/decline           { reason? }
 *   PUT  /client/:clientId/billing-day      { billing_day }
 *
 * Logic lives in shared/services/appSubscriptions.js.
 * ============================================================================
 */

const express = require('express');
const svc = require('../services/appSubscriptions');
const { loadManagedClient, isAdminUser } = require('./eco-clients');

const router = express.Router();

const send = (res, r, okStatus = 200) =>
  r && r.error ? res.status(r.status || 500).json({ error: r.error, code: r.code })
               : res.status(okStatus).json(r);

function requireLorenco(req, res, next) {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Super admin access required' });
  next();
}

async function managedClient(req, res) {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) { res.status(400).json({ error: 'Invalid client id' }); return null; }
  const loaded = await loadManagedClient(req, clientId);
  if (loaded.error) { res.status(loaded.status).json({ error: loaded.error }); return null; }
  return loaded.client;
}

const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    console.error(`[app-subscriptions] ${req.method} ${req.path} error:`, err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Lorenco ────────────────────────────────────────────────────────────────

router.get('/queue', requireLorenco, wrap(async (req, res) => {
  res.json(await svc.listQueue());
}));

router.post('/requests/:reqId/approve', requireLorenco, wrap(async (req, res) => {
  send(res, await svc.approve(req, parseInt(req.params.reqId, 10), { billingDay: req.body && req.body.billing_day }));
}));

router.post('/requests/:reqId/decline', requireLorenco, wrap(async (req, res) => {
  send(res, await svc.decline(req, parseInt(req.params.reqId, 10), { reason: req.body && req.body.reason }));
}));

router.put('/client/:clientId/billing-day', requireLorenco, wrap(async (req, res) => {
  const client = await managedClient(req, res);
  if (!client) return;
  send(res, await svc.setBillingDay(req, client, req.body ? req.body.billing_day : null));
}));

// ─── Client ─────────────────────────────────────────────────────────────────

router.get('/client/:clientId', wrap(async (req, res) => {
  const client = await managedClient(req, res);
  if (!client) return;
  const state = await svc.clientState(client);
  res.json({ ...state, can_switch_directly: isAdminUser(req.user) });
}));

router.post('/client/:clientId/request', wrap(async (req, res) => {
  const client = await managedClient(req, res);
  if (!client) return;
  const { app_key, accepted_terms } = req.body || {};
  send(res, await svc.requestAdd(req, client, String(app_key || ''), { acceptedTerms: accepted_terms === true }), 201);
}));

router.post('/client/:clientId/cancel', wrap(async (req, res) => {
  const client = await managedClient(req, res);
  if (!client) return;
  send(res, await svc.scheduleCancel(req, client, String((req.body && req.body.app_key) || '')), 201);
}));

router.post('/client/:clientId/requests/:reqId/withdraw', wrap(async (req, res) => {
  const client = await managedClient(req, res);
  if (!client) return;
  send(res, await svc.withdraw(req, client, parseInt(req.params.reqId, 10)));
}));

module.exports = router;
