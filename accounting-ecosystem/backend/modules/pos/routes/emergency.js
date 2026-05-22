/**
 * ============================================================================
 * POS Emergency Routes — Workstream 11B
 * ============================================================================
 * Manager-only "break glass" operational controls:
 *   POST /session/:id/force-close   — force-close an abandoned/stuck session
 *   POST /till/:id/lock             — lock a till (blocks new sales)
 *   POST /till/:id/unlock           — unlock a till
 *   POST /till/:id/printer-degraded — mark till printer as degraded
 *   POST /till/:id/printer-restored — mark till printer as restored
 *   GET  /state                     — current company emergency state
 *   POST /sync/pause                — pause offline sale replay
 *   POST /sync/resume               — resume offline sale replay
 *   POST /user/force-logout         — close all open sessions for a user
 *
 * All endpoints require SETTINGS.EDIT permission (same gate as recovery/support).
 * All actions create an immutable audit event in pos_audit_events.
 * No destructive deletes. No sales or audit records altered.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(requireCompany);
router.use(requirePermission('SETTINGS.EDIT'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userEmail(req) {
    const u = req.user || {};
    return u.email || u.username || 'unknown';
}

// ─── Force Close Session ──────────────────────────────────────────────────────

/**
 * POST /api/pos/emergency/session/:id/force-close
 * Force-close an open till session abandoned by a cashier.
 * Sets status='force_closed'. Sales and audit trail are preserved.
 */
router.post('/session/:id/force-close', async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason?.trim()) return res.status(400).json({ error: 'reason is required' });

        const sessionId = parseInt(req.params.id, 10);
        if (!sessionId) return res.status(400).json({ error: 'invalid session id' });

        const { data: session, error: fetchErr } = await supabase
            .from('till_sessions')
            .select('id, status, till_id, user_id')
            .eq('id', sessionId)
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (fetchErr || !session) return res.status(404).json({ error: 'Session not found' });
        if (session.status !== 'open') {
            return res.status(409).json({ error: `Session is already ${session.status}` });
        }

        const { error: updateErr } = await supabase
            .from('till_sessions')
            .update({
                status:    'force_closed',
                closed_at: new Date().toISOString(),
                notes:     `FORCE CLOSED by ${userEmail(req)}: ${reason.trim()}`,
            })
            .eq('id', sessionId)
            .eq('company_id', req.companyId);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_SESSION_FORCE_CLOSED, {
            tillSessionId: sessionId,
            tillId:        session.till_id,
            notes:         reason.trim(),
            metadata:      { previous_status: 'open', new_status: 'force_closed' },
        });

        res.json({ success: true, sessionId, status: 'force_closed' });
    } catch (err) {
        console.error('[emergency] POST /session/:id/force-close error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Till Lock ────────────────────────────────────────────────────────────────

/**
 * POST /api/pos/emergency/till/:id/lock
 * Lock a till. Prevents new sales. Existing session remains visible.
 */
router.post('/till/:id/lock', async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason?.trim()) return res.status(400).json({ error: 'reason is required' });

        const tillId = parseInt(req.params.id, 10);
        if (!tillId) return res.status(400).json({ error: 'invalid till id' });

        const { data: till, error: fetchErr } = await supabase
            .from('tills')
            .select('id, till_name, is_locked')
            .eq('id', tillId)
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (fetchErr || !till) return res.status(404).json({ error: 'Till not found' });
        if (till.is_locked) return res.status(409).json({ error: 'Till is already locked' });

        const { error: updateErr } = await supabase
            .from('tills')
            .update({
                is_locked:       true,
                locked_reason:   reason.trim(),
                locked_at:       new Date().toISOString(),
                locked_by_email: userEmail(req),
            })
            .eq('id', tillId)
            .eq('company_id', req.companyId);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_TILL_LOCKED, {
            tillId,
            notes:    reason.trim(),
            metadata: { till_name: till.till_name },
        });

        res.json({ success: true, tillId, locked: true });
    } catch (err) {
        console.error('[emergency] POST /till/:id/lock error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/emergency/till/:id/unlock
 * Unlock a till. Resumes normal sale processing.
 */
router.post('/till/:id/unlock', async (req, res) => {
    try {
        const { reason } = req.body;
        const tillId = parseInt(req.params.id, 10);
        if (!tillId) return res.status(400).json({ error: 'invalid till id' });

        const { data: till, error: fetchErr } = await supabase
            .from('tills')
            .select('id, till_name, is_locked')
            .eq('id', tillId)
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (fetchErr || !till) return res.status(404).json({ error: 'Till not found' });

        const { error: updateErr } = await supabase
            .from('tills')
            .update({
                is_locked:       false,
                locked_reason:   null,
                locked_at:       null,
                locked_by_email: null,
            })
            .eq('id', tillId)
            .eq('company_id', req.companyId);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_TILL_UNLOCKED, {
            tillId,
            notes:    reason?.trim() || 'Till unlocked by manager',
            metadata: { till_name: till.till_name, was_locked: till.is_locked },
        });

        res.json({ success: true, tillId, locked: false });
    } catch (err) {
        console.error('[emergency] POST /till/:id/unlock error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Printer Degraded Mode ────────────────────────────────────────────────────

/**
 * POST /api/pos/emergency/till/:id/printer-degraded
 * Mark a till's printer as degraded. Cashier sees warning. Checkout still allowed.
 */
router.post('/till/:id/printer-degraded', async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason?.trim()) return res.status(400).json({ error: 'reason is required' });

        const tillId = parseInt(req.params.id, 10);
        if (!tillId) return res.status(400).json({ error: 'invalid till id' });

        const { data: till, error: fetchErr } = await supabase
            .from('tills')
            .select('id, till_name')
            .eq('id', tillId)
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (fetchErr || !till) return res.status(404).json({ error: 'Till not found' });

        const { error: updateErr } = await supabase
            .from('tills')
            .update({
                is_printer_degraded:       true,
                printer_degraded_reason:   reason.trim(),
                printer_degraded_at:       new Date().toISOString(),
                printer_degraded_by_email: userEmail(req),
            })
            .eq('id', tillId)
            .eq('company_id', req.companyId);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_PRINTER_DEGRADED, {
            tillId,
            notes:    reason.trim(),
            metadata: { till_name: till.till_name },
        });

        res.json({ success: true, tillId, printer_degraded: true });
    } catch (err) {
        console.error('[emergency] POST /till/:id/printer-degraded error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/emergency/till/:id/printer-restored
 * Mark a till's printer as restored.
 */
router.post('/till/:id/printer-restored', async (req, res) => {
    try {
        const tillId = parseInt(req.params.id, 10);
        if (!tillId) return res.status(400).json({ error: 'invalid till id' });

        const { data: till, error: fetchErr } = await supabase
            .from('tills')
            .select('id, till_name')
            .eq('id', tillId)
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (fetchErr || !till) return res.status(404).json({ error: 'Till not found' });

        const { error: updateErr } = await supabase
            .from('tills')
            .update({
                is_printer_degraded:       false,
                printer_degraded_reason:   null,
                printer_degraded_at:       null,
                printer_degraded_by_email: null,
            })
            .eq('id', tillId)
            .eq('company_id', req.companyId);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_PRINTER_RESTORED, {
            tillId,
            notes:    'Printer restored by manager',
            metadata: { till_name: till.till_name },
        });

        res.json({ success: true, tillId, printer_degraded: false });
    } catch (err) {
        console.error('[emergency] POST /till/:id/printer-restored error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Emergency State ──────────────────────────────────────────────────────────

/**
 * GET /api/pos/emergency/state
 * Returns current company-level emergency state (sync pause, future flags).
 * Called on login to initialise frontend emergency flags.
 */
router.get('/state', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pos_emergency_state')
            .select('sync_paused, sync_paused_by, sync_paused_reason, sync_paused_at')
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });

        res.json({
            syncPaused:       data?.sync_paused       || false,
            syncPausedBy:     data?.sync_paused_by     || null,
            syncPausedReason: data?.sync_paused_reason || null,
            syncPausedAt:     data?.sync_paused_at     || null,
        });
    } catch (err) {
        console.error('[emergency] GET /state error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Sync Pause / Resume ──────────────────────────────────────────────────────

/**
 * POST /api/pos/emergency/sync/pause
 * Pause offline sale replay for this company. Prevents retry storms during incidents.
 */
router.post('/sync/pause', async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason?.trim()) return res.status(400).json({ error: 'reason is required' });

        const { error } = await supabase
            .from('pos_emergency_state')
            .upsert({
                company_id:        req.companyId,
                sync_paused:       true,
                sync_paused_by:    userEmail(req),
                sync_paused_reason: reason.trim(),
                sync_paused_at:    new Date().toISOString(),
                updated_at:        new Date().toISOString(),
            }, { onConflict: 'company_id' });

        if (error) return res.status(500).json({ error: error.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_SYNC_PAUSED, {
            notes: reason.trim(),
        });

        res.json({ success: true, syncPaused: true });
    } catch (err) {
        console.error('[emergency] POST /sync/pause error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/emergency/sync/resume
 * Resume offline sale replay.
 */
router.post('/sync/resume', async (req, res) => {
    try {
        const { error } = await supabase
            .from('pos_emergency_state')
            .upsert({
                company_id:        req.companyId,
                sync_paused:       false,
                sync_paused_by:    null,
                sync_paused_reason: null,
                sync_paused_at:    null,
                updated_at:        new Date().toISOString(),
            }, { onConflict: 'company_id' });

        if (error) return res.status(500).json({ error: error.message });

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_SYNC_RESUMED, {
            notes: 'Sync resumed by manager',
        });

        res.json({ success: true, syncPaused: false });
    } catch (err) {
        console.error('[emergency] POST /sync/resume error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Force Logout User ────────────────────────────────────────────────────────

/**
 * POST /api/pos/emergency/user/force-logout
 * Force-close all open till sessions for a specific user.
 * The user's JWT remains valid until expiry (stateless — cannot revoke),
 * but without an open session they cannot process sales.
 */
router.post('/user/force-logout', async (req, res) => {
    try {
        const { user_email, reason } = req.body;
        if (!user_email?.trim()) return res.status(400).json({ error: 'user_email is required' });
        if (!reason?.trim())     return res.status(400).json({ error: 'reason is required' });

        // Look up the user by email
        const { data: userData, error: userErr } = await supabase
            .from('users')
            .select('id, email')
            .eq('email', user_email.trim().toLowerCase())
            .maybeSingle();

        if (userErr || !userData) {
            return res.status(404).json({ error: `User '${user_email.trim()}' not found` });
        }

        // Force-close all open sessions for this user in this company
        const { data: closedSessions, error: closeErr } = await supabase
            .from('till_sessions')
            .update({
                status:    'force_closed',
                closed_at: new Date().toISOString(),
                notes:     `FORCE LOGOUT by ${userEmail(req)}: ${reason.trim()}`,
            })
            .eq('company_id', req.companyId)
            .eq('user_id', userData.id)
            .eq('status', 'open')
            .select('id, till_id');

        if (closeErr) return res.status(500).json({ error: closeErr.message });

        const sessionCount = (closedSessions || []).length;

        posAuditFromReq(req, POS_EVENTS.EMERGENCY_USER_FORCE_LOGOUT, {
            notes: reason.trim(),
            metadata: {
                target_email:     userData.email,
                sessions_closed:  sessionCount,
                note: 'JWT cannot be revoked server-side — user loses active session only',
            },
        });

        res.json({
            success:        true,
            targetEmail:    userData.email,
            sessionsClosed: sessionCount,
        });
    } catch (err) {
        console.error('[emergency] POST /user/force-logout error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
