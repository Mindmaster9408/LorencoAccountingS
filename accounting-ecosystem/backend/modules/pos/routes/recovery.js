/**
 * ============================================================================
 * POS Recovery Routes — Workstream 4A
 * ============================================================================
 * Manager-only endpoints for:
 *   - Session health visibility (abandoned, stale, pending cash-up)
 *   - Offline queue audit trail (retry, abandon, note events)
 *   - Supervisor override recording (immutable audit trail)
 *
 * All endpoints require SETTINGS.EDIT permission (management roles).
 * The offline queue itself lives in client IndexedDB — these endpoints
 * record audit events and query session health from the DB only.
 * They never block the checkout flow.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(requireCompany);
// All recovery endpoints are management-only.
// FOLLOW-UP: store_manager role should also have access — requires expanding
// SETTINGS.EDIT or adding a dedicated RECOVERY permission group.
router.use(requirePermission('SETTINGS.EDIT'));

const STALE_SESSION_HOURS = 8;

const ALLOWED_OVERRIDE_TYPES = [
    'negative_stock_manual',
    'price_override',
    'session_force_close',
    'queue_item_cleared',
    'other',
];

/**
 * GET /api/pos/recovery/sessions
 * Session health summary: open sessions, stale sessions (> 8h open),
 * and sessions closed but not yet cashed-up.
 * Fires ABANDONED_SESSION_DETECTED once per stale session per 24-hour window.
 * Deduplication prevents audit log flooding on repeated manager page loads.
 */
router.get('/sessions', async (req, res) => {
    try {
        const { data: allSessions, error } = await supabase
            .from('till_sessions')
            .select('*, tills(till_name, till_number), users:user_id(username, full_name)')
            .eq('company_id', req.companyId)
            .in('status', ['open', 'closed'])
            .order('opened_at', { ascending: false })
            .limit(50);

        if (error) return res.status(500).json({ error: error.message });

        const now = new Date();
        const open = [];
        const stale = [];
        const pending_cashup = [];

        for (const s of (allSessions || [])) {
            if (s.status === 'open') {
                const ageHours = (now - new Date(s.opened_at)) / 3_600_000;
                if (ageHours > STALE_SESSION_HOURS) {
                    stale.push({ ...s, age_hours: Math.round(ageHours) });
                } else {
                    open.push({ ...s, age_hours: Math.round(ageHours * 10) / 10 });
                }
            } else if (s.status === 'closed') {
                const closedAgeHours = s.closed_at
                    ? (now - new Date(s.closed_at)) / 3_600_000
                    : null;
                pending_cashup.push({
                    ...s,
                    closed_age_hours: closedAgeHours !== null
                        ? Math.round(closedAgeHours * 10) / 10
                        : null,
                });
            }
        }

        // Fire ABANDONED_SESSION_DETECTED only for sessions not already reported
        // in the last 24 hours. One batch query covers all stale sessions so the
        // endpoint never floods the audit log on repeated manager page loads.
        if (stale.length > 0) {
            const staleIds = stale.map(s => s.id);
            const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            const { data: recentEvents } = await supabase
                .from('pos_audit_events')
                .select('till_session_id')
                .eq('company_id', req.companyId)
                .eq('action_type', POS_EVENTS.ABANDONED_SESSION_DETECTED)
                .in('till_session_id', staleIds)
                .gte('created_at', since24h);

            const alreadyReported = new Set(
                (recentEvents || []).map(e => e.till_session_id)
            );

            for (const s of stale) {
                if (!alreadyReported.has(s.id)) {
                    posAuditFromReq(req, POS_EVENTS.ABANDONED_SESSION_DETECTED, {
                        tillSessionId: s.id,
                        tillId: s.till_id || null,
                        metadata: {
                            age_hours:    s.age_hours,
                            opened_at:    s.opened_at,
                            session_user: s.users?.username || null,
                        },
                    });
                }
            }
        }

        res.json({ open, stale, pending_cashup });
    } catch (err) {
        console.error('[recovery] GET /sessions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/recovery/queue/retry
 * Log a manager-triggered manual retry of an offline queue item.
 * The frontend handles the actual re-submission via /api/pos/sales.
 */
router.post('/queue/retry', async (req, res) => {
    try {
        const { temp_sale_number, item_count, previous_status, sync_attempts } = req.body;

        posAuditFromReq(req, POS_EVENTS.RECOVERY_RETRY_TRIGGERED, {
            source: 'online',
            metadata: {
                temp_sale_number:  temp_sale_number  || null,
                item_count:        item_count        ?? null,
                previous_status:   previous_status   || null,
                sync_attempts:     sync_attempts     ?? null,
                triggered_by:      req.user?.email   || 'unknown',
            },
        });

        res.json({ logged: true });
    } catch (err) {
        console.error('[recovery] POST /queue/retry error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/recovery/queue/abandon
 * Log a manager marking an offline queue item as permanently unrecoverable.
 * Reason is required — this is an immutable audit record.
 */
router.post('/queue/abandon', async (req, res) => {
    try {
        const { temp_sale_number, item_count, previous_status, reason } = req.body;

        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ error: 'reason is required when abandoning a queue item' });
        }

        posAuditFromReq(req, POS_EVENTS.RECOVERY_MARKED_FAILED, {
            source: 'online',
            notes: String(reason).trim(),
            metadata: {
                temp_sale_number: temp_sale_number || null,
                item_count:       item_count       ?? null,
                previous_status:  previous_status  || null,
                abandoned_by:     req.user?.email  || 'unknown',
            },
        });

        res.json({ logged: true });
    } catch (err) {
        console.error('[recovery] POST /queue/abandon error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/recovery/queue/note
 * Log a recovery note added to an offline queue item by a manager.
 */
router.post('/queue/note', async (req, res) => {
    try {
        const { temp_sale_number, note } = req.body;

        if (!note || !String(note).trim()) {
            return res.status(400).json({ error: 'note is required' });
        }

        posAuditFromReq(req, POS_EVENTS.RECOVERY_NOTE_ADDED, {
            source: 'online',
            notes: String(note).trim(),
            metadata: {
                temp_sale_number: temp_sale_number || null,
                noted_by:         req.user?.email  || 'unknown',
            },
        });

        res.json({ logged: true });
    } catch (err) {
        console.error('[recovery] POST /queue/note error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/pos/recovery/override
 * Record a supervisor override with mandatory type + reason.
 * Creates an immutable SUPERVISOR_OVERRIDE_GRANTED audit event.
 * Does NOT change any data — it is purely an audit record.
 */
router.post('/override', async (req, res) => {
    try {
        const { override_type, reason, target_id, target_type } = req.body;

        if (!override_type || !reason || !String(reason).trim()) {
            return res.status(400).json({ error: 'override_type and reason are both required' });
        }
        if (!ALLOWED_OVERRIDE_TYPES.includes(override_type)) {
            return res.status(400).json({
                error: `override_type must be one of: ${ALLOWED_OVERRIDE_TYPES.join(', ')}`,
            });
        }

        await posAuditFromReq(req, POS_EVENTS.SUPERVISOR_OVERRIDE_GRANTED, {
            source: 'online',
            entityType: target_type ? String(target_type) : null,
            entityId:   target_id   ? String(target_id)   : null,
            notes:      String(reason).trim(),
            metadata: {
                override_type:    override_type,
                override_reason:  String(reason).trim(),
                authorized_by:    req.user?.email || 'unknown',
                authorized_role:  req.user?.role  || 'unknown',
            },
        });

        res.json({ recorded: true, override_type });
    } catch (err) {
        console.error('[recovery] POST /override error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
