/**
 * ============================================================================
 * Link an existing company — /api/link-requests (2026-11-12)
 * ============================================================================
 * Practice side (management of the current company, or super admin):
 *   POST /lookup                 { query }  client code (CLT-…) or email
 *   POST /                       { target_company_id, apps[], message? }
 *   GET  /outgoing               this practice's requests
 *   POST /:id/withdraw
 *
 * Company side (its own management only — no super-admin bypass):
 *   GET  /incoming               open requests for companies I manage
 *   POST /:id/decide             { approved_apps[], note? }  [] = decline
 *
 * Logic lives in shared/services/linkRequests.js.
 * ============================================================================
 */

const express = require('express');
const svc = require('../services/linkRequests');

const router = express.Router();

const wrap = (fn, okStatus = 200) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r && r.error) return res.status(r.status || 500).json({ error: r.error, code: r.code });
    res.status(okStatus).json(r);
  } catch (err) {
    console.error('[link-requests]', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
};
const id = req => parseInt(req.params.id, 10);

router.post('/lookup', wrap(req => svc.lookup(req, req.body || {})));
router.post('/', wrap(req => svc.createRequest(req, req.body || {}), 201));
router.get('/outgoing', wrap(req => svc.listOutgoing(req)));
router.get('/incoming', wrap(req => svc.listIncoming(req)));
router.post('/:id/withdraw', wrap(req => svc.withdraw(req, id(req))));
router.post('/:id/decide', wrap(req => svc.decide(req, id(req), req.body || {})));

module.exports = router;
