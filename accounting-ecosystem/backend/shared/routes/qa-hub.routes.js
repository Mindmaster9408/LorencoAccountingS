// qa-hub.routes.js
//
// Ecosystem QA Hub — internal smoke-testing session management.
// Super admin only. No business data is read or written here.
//
// Mounted at: /api/ecosystem/qa-sessions
//
// Endpoints:
//   GET    /           — list all QA sessions (newest first)
//   POST   /           — create a new QA session
//   POST   /:id/revoke — revoke an active session
//   GET    /active     — active sessions where qa_user_email == current user's email
//
// Security: all routes require isSuperAdmin in the JWT.
// Coaching App inclusion is blocked unless the requesting admin is Ruan
// AND the target tester email is also Ruan (defence-in-depth).

'use strict';

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireSuperAdmin } = require('../../middleware/auth');

const router = express.Router();

// All routes require authentication + super admin flag
router.use(authenticateToken);
router.use(requireSuperAdmin);

// Coaching App may only be included when both creator and target QA user are Ruan
const COACHING_ALLOWED_EMAIL = 'ruanvlog@lorenco.co.za';

function filterCoachingApp(allowedApps, creatorEmail, targetEmail) {
    return (allowedApps || []).filter(app => {
        if (app !== 'coaching') return true;
        return (
            creatorEmail.toLowerCase() === COACHING_ALLOWED_EMAIL &&
            targetEmail.toLowerCase()  === COACHING_ALLOWED_EMAIL
        );
    });
}

// ─── GET /active ──────────────────────────────────────────────────────────────
// Returns active, non-expired sessions where qa_user_email matches this user.
// Must be registered before /:id routes to avoid Express treating "active" as an ID.
router.get('/active', async (req, res) => {
    try {
        const now = new Date().toISOString();

        // Auto-expire overdue sessions (fire-and-forget)
        supabase
            .from('ecosystem_qa_sessions')
            .update({ status: 'expired' })
            .eq('status', 'active')
            .lt('expires_at', now)
            .then(() => {})
            .catch(err => console.error('[qa-hub] auto-expire error:', err));

        const { data, error } = await supabase
            .from('ecosystem_qa_sessions')
            .select('*')
            .eq('qa_user_email', req.user.email.toLowerCase())
            .eq('status', 'active')
            .gt('expires_at', now)
            .order('expires_at', { ascending: true });

        if (error) throw error;
        res.json({ sessions: data || [] });
    } catch (err) {
        console.error('[qa-hub] GET /active', err);
        res.status(500).json({ error: 'Failed to get active sessions' });
    }
});

// ─── GET / ────────────────────────────────────────────────────────────────────
// List all QA sessions, newest first.
router.get('/', async (req, res) => {
    try {
        const now = new Date().toISOString();

        // Auto-expire overdue sessions (fire-and-forget)
        supabase
            .from('ecosystem_qa_sessions')
            .update({ status: 'expired' })
            .eq('status', 'active')
            .lt('expires_at', now)
            .then(() => {})
            .catch(err => console.error('[qa-hub] auto-expire error:', err));

        const { data, error } = await supabase
            .from('ecosystem_qa_sessions')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ sessions: data || [] });
    } catch (err) {
        console.error('[qa-hub] GET /', err);
        res.status(500).json({ error: 'Failed to list QA sessions' });
    }
});

// ─── POST / ───────────────────────────────────────────────────────────────────
// Create a new QA session.
router.post('/', async (req, res) => {
    const {
        qaUserEmail,
        accessMode       = 'VIEW_ONLY',
        allowedApps      = [],
        allowedCompanyIds = [],
        expiresAt,
        instructions
    } = req.body;

    if (!qaUserEmail || typeof qaUserEmail !== 'string' || !qaUserEmail.trim()) {
        return res.status(400).json({ error: 'qaUserEmail is required' });
    }
    if (!expiresAt) {
        return res.status(400).json({ error: 'expiresAt is required' });
    }

    // SANDBOX_WRITE is not available in Phase 1
    const validModes = ['VIEW_ONLY', 'TEST_ASSISTED'];
    if (!validModes.includes(accessMode)) {
        return res.status(400).json({
            error: 'accessMode must be VIEW_ONLY or TEST_ASSISTED (SANDBOX_WRITE not available in Phase 1)'
        });
    }

    const expiryDate = new Date(expiresAt);
    if (isNaN(expiryDate.getTime()) || expiryDate <= new Date()) {
        return res.status(400).json({ error: 'expiresAt must be a valid future date/time' });
    }

    const cleanEmail = qaUserEmail.trim().toLowerCase();
    const appsToStore = filterCoachingApp(allowedApps, req.user.email, cleanEmail);

    try {
        const { data, error } = await supabase
            .from('ecosystem_qa_sessions')
            .insert({
                created_by_user_id:  req.user.userId,
                qa_user_email:       cleanEmail,
                access_mode:         accessMode,
                allowed_apps:        appsToStore,
                allowed_company_ids: allowedCompanyIds,
                instructions:        instructions || null,
                status:              'active',
                expires_at:          expiresAt
            })
            .select('*')
            .single();

        if (error) throw error;
        res.status(201).json({ session: data });
    } catch (err) {
        console.error('[qa-hub] POST /', err);
        res.status(500).json({ error: 'Failed to create QA session' });
    }
});

// ─── POST /:id/revoke ─────────────────────────────────────────────────────────
// Revoke an active session.
router.post('/:id/revoke', async (req, res) => {
    try {
        const { data: existing, error: fetchErr } = await supabase
            .from('ecosystem_qa_sessions')
            .select('id, status')
            .eq('id', req.params.id)
            .single();

        if (fetchErr || !existing) {
            return res.status(404).json({ error: 'QA session not found' });
        }
        if (existing.status !== 'active') {
            return res.status(400).json({ error: `Session is already ${existing.status}` });
        }

        const { error } = await supabase
            .from('ecosystem_qa_sessions')
            .update({
                status:               'revoked',
                revoked_at:           new Date().toISOString(),
                revoked_by_user_id:   req.user.userId
            })
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('[qa-hub] POST /:id/revoke', err);
        res.status(500).json({ error: 'Failed to revoke session' });
    }
});

module.exports = router;
