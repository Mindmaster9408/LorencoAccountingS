/**
 * ============================================================================
 * POS Support Routes — Workstream 11A
 * ============================================================================
 * Manager-only read-only endpoints for the Pilot Operations Toolkit:
 *   - GET /events          — recent operational audit event timeline
 *   - GET /negative-stock  — count of active products at negative stock
 *
 * Requires SETTINGS.EDIT permission (same as recovery panel).
 * All endpoints are read-only. No state changes. No audit events fired here.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();

router.use(requireCompany);
router.use(requirePermission('SETTINGS.EDIT'));

// Operational categories shown in the support timeline.
// Auth events are excluded — they add noise without pilot-ops value.
const TIMELINE_CATEGORIES = ['sale', 'session', 'sync', 'recovery', 'override', 'inventory'];

/**
 * GET /api/pos/support/events
 * Returns the most recent operational audit events for the company.
 * Ordered newest-first. ?limit=N (max 200, default 50).
 */
router.get('/events', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

        const { data, error } = await supabase
            .from('pos_audit_events')
            .select('id, action_type, action_category, user_email, user_role, till_id, till_session_id, sale_id, source, notes, metadata, created_at')
            .eq('company_id', req.companyId)
            .in('action_category', TIMELINE_CATEGORIES)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) return res.status(500).json({ error: error.message });

        res.json({ events: data || [] });
    } catch (err) {
        console.error('[support] GET /events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/pos/support/negative-stock
 * Count of active products currently at negative stock_quantity.
 * Used by the health panel warning indicator.
 */
router.get('/negative-stock', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('products')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', req.companyId)
            .eq('is_active', true)
            .lt('stock_quantity', 0);

        if (error) return res.status(500).json({ error: error.message });

        res.json({ negative_stock_count: count || 0 });
    } catch (err) {
        console.error('[support] GET /negative-stock error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
