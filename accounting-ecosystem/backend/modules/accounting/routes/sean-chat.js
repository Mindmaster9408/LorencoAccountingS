/**
 * ============================================================================
 * Sean AI Chat — Ledger Leo widget proxy (2026-08-30)
 * ============================================================================
 * The browser never talks to sean-webapp directly — it only ever calls this
 * route, same-origin, with the same Leo JWT every other accounting call
 * already uses. This route makes the outbound, server-to-server call to
 * sean-webapp's app/api/chat/external (already allowlisted in
 * sean-webapp/middleware.ts's apiKeyAuthRoutes, mirroring the same
 * x-api-key/x-system-id pattern app/api/allocations/run/route.ts uses).
 *
 * Keeps sean-webapp's internals (Prisma DB, ECO_SERVICE_TOKEN, /api/codex/*,
 * /api/allocations/*) off the public browser surface entirely — SEAN_API_KEY
 * only ever lives in backend .env files, never in browser JS.
 *
 * TEMPORARY: restricted to super admins only (req.user.isGlobalAdmin) while
 * this feature is first being tested — not the shared PERMISSIONS map, since
 * that scope is expected to widen soon and shouldn't need a second edit to
 * that shared, validated map when it does.
 * ============================================================================
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { supabase } = require('../../../config/database');

router.post('/message', authenticate, async (req, res) => {
  try {
    if (!req.user.isGlobalAdmin) {
      return res.status(403).json({ error: 'Sean AI chat is not yet available for this account.' });
    }

    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const seanWebappUrl = process.env.SEAN_WEBAPP_URL;
    const seanApiKey = process.env.SEAN_API_KEY;
    if (!seanWebappUrl || !seanApiKey) {
      console.error('[sean-chat] SEAN_WEBAPP_URL or SEAN_API_KEY not configured');
      return res.status(503).json({ error: 'Sean AI chat is not configured on this server yet.' });
    }

    // Company display name — looked up once per message. Cheap: single
    // indexed row by primary key, same cost class as any other accounting
    // route's company lookup; not worth caching for a first version.
    const { data: company } = await supabase
      .from('companies')
      .select('company_name, trading_name')
      .eq('id', req.companyId)
      .maybeSingle();
    const companyName = company?.trading_name || company?.company_name || null;

    const response = await fetch(`${seanWebappUrl}/api/chat/external`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': seanApiKey,
        'x-system-id': 'leo-accounting',
      },
      body: JSON.stringify({
        message: message.trim(),
        leoUserEmail: req.user.email,
        ecoCompanyId: req.companyId,
        companyName,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[sean-chat] sean-webapp returned', response.status, data);
      return res.status(502).json({ error: 'Sean AI is temporarily unavailable. Please try again.' });
    }

    res.json({ answer: data.answer, metadata: data.metadata || {} });
  } catch (err) {
    console.error('[sean-chat] error:', err.message);
    res.status(500).json({ error: 'Sean AI is temporarily unavailable. Please try again.' });
  }
});

module.exports = router;
