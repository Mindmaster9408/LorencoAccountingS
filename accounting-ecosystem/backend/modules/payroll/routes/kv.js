/**
 * ============================================================================
 * Payroll KV Store Routes — ECO Backend
 * ============================================================================
 * Generic key-value storage scoped per company.
 * Used by the frontend localStorage bridge so all payroll page data
 * (attendance records, payroll configs, employee lists, etc.) is stored
 * in Supabase instead of the browser — survives history clears and works
 * across all browsers / devices.
 *
 * Table (create in Supabase SQL editor if not present):
 *   CREATE TABLE IF NOT EXISTS payroll_kv_store_eco (
 *     company_id TEXT NOT NULL,
 *     key        TEXT NOT NULL,
 *     value      JSONB,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     PRIMARY KEY (company_id, key)
 *   );
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();
const TABLE = 'payroll_kv_store_eco';

// SECURITY: All KV routes require authentication and company context.
// Read operations require PAYROLL.VIEW; write/delete operations require PAYROLL.CREATE.
router.use(authenticateToken);
router.use(requireCompany);

// ── Sensitive key guard ───────────────────────────────────────────────────────
// Certain key patterns represent critical finalization state and require elevated
// permissions to mutate (PAYROLL.APPROVE). These keys cannot be freely deleted
// by any PAYROLL.CREATE user — they must use the dedicated unlock endpoint.
//
// Protected patterns:
//   emp_payslip_status_*   — payslip finalization state
//   emp_historical_*       — frozen payroll snapshots
//   payslip_archive_*      — long-term payslip archive (11-year retention)
//
const SENSITIVE_KEY_PATTERNS = [
    /^emp_payslip_status_/,
    /^emp_historical_/,
    /^payslip_archive_/,
];

function isSensitiveKey(key) {
    return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

// Middleware: block direct mutations of sensitive finalization-state keys
// unless the user has PAYROLL.APPROVE (business_owner / super_admin).
function guardSensitiveKey(req, res, next) {
    const key = req.params.key;
    if (!key || !isSensitiveKey(key)) return next();

    const userRole = req.user && req.user.role;
    const approveRoles = ['super_admin', 'business_owner'];
    if (!approveRoles.includes(userRole)) {
        return res.status(403).json({
            error: 'Insufficient permissions to modify payslip state directly',
            hint: 'Use the dedicated payslip unlock endpoint for authorized state changes',
            required: 'PAYROLL.APPROVE',
            userRole
        });
    }
    next();
}

// ── GET /api/payroll/kv  →  all key/value pairs for this company ─────────────
router.get('/', requirePermission('PAYROLL.VIEW'), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select('key, value')
            .eq('company_id', req.companyId);

        if (error) throw error;

        const result = {};
        for (const row of (data || [])) {
            result[row.key] = row.value;
        }
        res.json(result);
    } catch (err) {
        console.error('GET /api/payroll/kv error:', err.message);
        res.status(500).json({ error: 'Database read failed' });
    }
});

// ── PUT /api/payroll/kv/:key  →  upsert a single key ─────────────────────────
router.put('/:key', requirePermission('PAYROLL.CREATE'), guardSensitiveKey, async (req, res) => {
    try {
        const key = req.params.key;
        let val = req.body.value;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) {}
        }

        const { error } = await supabase
            .from(TABLE)
            .upsert(
                { company_id: req.companyId, key, value: val, updated_at: new Date().toISOString() },
                { onConflict: 'company_id,key' }
            );

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/payroll/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database write failed' });
    }
});

// ── DELETE /api/payroll/kv/:key  →  remove a key ─────────────────────────────
router.delete('/:key', requirePermission('PAYROLL.CREATE'), guardSensitiveKey, async (req, res) => {
    try {
        const key = req.params.key;

        const { error } = await supabase
            .from(TABLE)
            .delete()
            .eq('company_id', req.companyId)
            .eq('key', key);

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/payroll/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database delete failed' });
    }
});

// ── PUT /api/payroll/kv/global/:key  →  upsert an ecosystem-wide default ─────
// Requires super_admin or business_owner role.
// Writes with the sentinel company_id = '__global__' so all companies without
// a company-specific override will fall through to this value.
// Used by the Tax Configuration UI in the managing-practice (Infinite Legacy)
// account to propagate standard tax tables to all clients.
router.put('/global/:key', async (req, res) => {
    const userRole = req.user && req.user.role;
    if (!['super_admin', 'business_owner'].includes(userRole)) {
        return res.status(403).json({
            error: 'Insufficient permissions to write global ecosystem defaults',
            required: 'super_admin or business_owner'
        });
    }
    try {
        const key = req.params.key;
        let val = req.body.value;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) {}
        }

        const { error } = await supabase
            .from(TABLE)
            .upsert(
                { company_id: '__global__', key, value: val, updated_at: new Date().toISOString() },
                { onConflict: 'company_id,key' }
            );

        if (error) throw error;
        console.log(`[payroll/kv] Global key '${key}' updated by user role '${userRole}'.`);
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/payroll/kv/global/:key error:', err.message);
        res.status(500).json({ error: 'Database write failed' });
    }
});

module.exports = router;
