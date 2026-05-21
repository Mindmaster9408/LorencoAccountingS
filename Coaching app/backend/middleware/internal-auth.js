// internal-auth.js
//
// Middleware for server-to-server requests from the Sean ecosystem backend.
// Validates a pre-shared secret token (COACHING_INTERNAL_API_TOKEN) using
// constant-time comparison to prevent timing attacks.
//
// Completely independent of user JWT auth — never reads JWT_SECRET, never
// queries the users table. Safe to apply to routes that must not require
// a logged-in user.
//
// Token must be set in BOTH services' Zeabur env vars with the same value:
//   COACHING_INTERNAL_API_TOKEN=<strong-random-secret>
//
// Usage:
//   import { requireInternalToken } from '../middleware/internal-auth.js';
//   router.use(requireInternalToken);

import crypto from 'crypto';

export function requireInternalToken(req, res, next) {
    const INTERNAL_TOKEN = process.env.COACHING_INTERNAL_API_TOKEN;

    if (!INTERNAL_TOKEN) {
        console.error('[internal-auth] COACHING_INTERNAL_API_TOKEN is not set — blocking internal request');
        return res.status(503).json({ error: 'Internal API not configured on this server' });
    }

    const authHeader = (req.headers.authorization || '').trim();
    const spaceIdx = authHeader.indexOf(' ');
    const scheme   = spaceIdx >= 0 ? authHeader.slice(0, spaceIdx) : authHeader;
    const token    = spaceIdx >= 0 ? authHeader.slice(spaceIdx + 1).trim() : '';

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Internal API token required' });
    }

    // Constant-time comparison — prevents timing-based token enumeration
    let valid = false;
    try {
        const expected = Buffer.from(INTERNAL_TOKEN, 'utf8');
        const provided  = Buffer.from(token, 'utf8');
        valid = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    } catch {
        valid = false;
    }

    if (!valid) {
        console.warn('[internal-auth] Invalid internal token attempt — IP:', req.ip);
        return res.status(401).json({ error: 'Invalid internal API token' });
    }

    req.isInternalService = true;
    next();
}
