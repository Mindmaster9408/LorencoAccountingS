/**
 * ============================================================================
 * Payroll Payslip Unlock — Server-Side Authorization
 * ============================================================================
 * POST /api/payroll/unlock
 *
 * Replaces the previous client-controlled pattern where the frontend would:
 *   1. Call /api/auth/login with manager credentials
 *   2. On success, directly DELETE the payslip status KV key
 *
 * This endpoint owns the full unlock flow on the server:
 *   1. Validates the requesting user's JWT (PAYSLIPS.UNLOCK permission)
 *   2. Verifies the manager's credentials against the auth system
 *   3. Checks the manager has a management-level role
 *   4. Deletes the finalization state keys from the KV store
 *   5. Records an authoritative server-side audit log entry
 *
 * Client trust boundary: no client-side state change gates this operation.
 * The server owns all authorization decisions and state mutations.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../../config/database');
const { requirePermission } = require('../../../middleware/auth');

const router = express.Router();
const KV_TABLE = 'payroll_kv_store_eco';

// Roles that may authorize an unlock (manager-level and above)
const UNLOCK_AUTHORIZER_ROLES = ['super_admin', 'business_owner', 'practice_manager', 'administrator', 'accountant', 'manager', 'admin'];

// ── POST /api/payroll/unlock ──────────────────────────────────────────────────
//
// Body:  { empId, period, managerEmail, managerPassword }
// Auth:  Bearer token of the REQUESTING user (must have PAYSLIPS.UNLOCK)
// Logic: Verifies manager credentials, then removes payslip state keys
//
router.post('/', requirePermission('PAYSLIPS.UNLOCK'), async (req, res) => {
    const { empId, period, managerEmail, managerPassword } = req.body || {};
    const companyId = req.companyId;
    const requestingUser = req.user;

    // ── Input validation ─────────────────────────────────────────────────────
    if (!empId || !period) {
        return res.status(400).json({ error: 'empId and period are required' });
    }
    if (!managerEmail || !managerPassword) {
        return res.status(400).json({ error: 'Manager credentials required for unlock authorization' });
    }

    // ── Verify manager credentials via the ecosystem auth system ────────────
    // We call the internal login logic to verify the manager's email/password.
    // This check is performed server-to-server — the credentials never go
    // back to the browser as a usable token.
    let managerUser = null;
    try {
        // Look up the manager in Supabase users table
        const { data: mgr, error: mgrErr } = await supabase
            .from('users')
            .select('id, email, password_hash, role, full_name')
            .ilike('email', managerEmail)
            .single();

        if (mgrErr || !mgr) {
            return res.status(401).json({
                error: 'Manager authorization failed — credentials not recognized',
                code: 'MANAGER_NOT_FOUND'
            });
        }

        // Verify password using bcrypt
        const bcrypt = require('bcryptjs');
        const passwordOk = await bcrypt.compare(managerPassword, mgr.password_hash || '');
        if (!passwordOk) {
            // Log failed unlock attempt for audit
            await recordUnlockAudit(supabase, companyId, requestingUser, managerEmail, empId, period, 'FAILED_AUTH');
            return res.status(401).json({
                error: 'Manager authorization failed — invalid credentials',
                code: 'INVALID_CREDENTIALS'
            });
        }

        // Verify the manager has a role that qualifies as an authorizer
        if (!UNLOCK_AUTHORIZER_ROLES.includes(mgr.role)) {
            await recordUnlockAudit(supabase, companyId, requestingUser, managerEmail, empId, period, 'DENIED_ROLE');
            return res.status(403).json({
                error: 'Authorization denied — manager role insufficient for unlock',
                required: UNLOCK_AUTHORIZER_ROLES.join(' | '),
                managerRole: mgr.role,
                code: 'INSUFFICIENT_ROLE'
            });
        }

        managerUser = mgr;
    } catch (e) {
        console.error('Unlock: manager credential verification failed:', e.message);
        return res.status(500).json({ error: 'Credential verification failed — server error' });
    }

    // ── Reset backend payroll snapshot lock ──────────────────────────────────
    // CRITICAL: Must reset is_locked in payroll_snapshots BEFORE deleting KV keys.
    // If skipped, the frontend _syncSnapshotFromBackend() would immediately re-lock
    // the payslip on next page load by reading the still-locked DB record.
    // We reset to draft so the payrun endpoint can accept a corrective re-run.
    try {
        const { error: snapErr } = await supabase
            .from('payroll_snapshots')
            .update({ is_locked: false, status: 'draft' })
            .eq('company_id', companyId)
            .eq('employee_id', parseInt(empId))
            .eq('period_key', String(period))
            .eq('is_locked', true); // Only update if currently locked (idempotent safe)

        if (snapErr) {
            console.error('Unlock: failed to reset snapshot lock:', snapErr.message);
            return res.status(500).json({ error: 'Unlock failed — could not reset payroll snapshot state' });
        }
    } catch (e) {
        console.error('Unlock: snapshot reset error:', e.message);
        return res.status(500).json({ error: 'Unlock failed — snapshot database error' });
    }

    // ── Remove payslip finalization state keys ───────────────────────────────
    const statusKey   = `emp_payslip_status_${companyId}_${empId}_${period}`;
    const historicalKey = `emp_historical_${companyId}_${empId}_${period}`;

    try {
        const { error: delErr } = await supabase
            .from(KV_TABLE)
            .delete()
            .eq('company_id', companyId)
            .in('key', [statusKey, historicalKey]);

        if (delErr) throw delErr;
    } catch (e) {
        console.error('Unlock: failed to remove KV keys:', e.message);
        return res.status(500).json({ error: 'Unlock state update failed — database error' });
    }

    // ── Record authoritative audit log entry ─────────────────────────────────
    await recordUnlockAudit(supabase, companyId, requestingUser, managerEmail, empId, period, 'SUCCESS', managerUser);

    return res.json({
        ok: true,
        message: 'Payslip unlocked successfully',
        unlockedBy: {
            requestingUser: requestingUser.email || requestingUser.userId,
            authorizedBy: managerEmail,
            authorizedByName: managerUser ? managerUser.full_name : managerEmail,
            timestamp: new Date().toISOString()
        }
    });
});

// ── Audit helper ─────────────────────────────────────────────────────────────
async function recordUnlockAudit(supabase, companyId, requestingUser, managerEmail, empId, period, result, managerUser) {
    try {
        await supabase.from('audit_logs').insert({
            company_id: companyId,
            user_id: requestingUser.userId || requestingUser.id || null,
            user_email: requestingUser.email || null,
            action: 'PAYSLIP_UNLOCK',
            entity_type: 'payslip',
            entity_id: `${empId}_${period}`,
            metadata: {
                result,
                emp_id: empId,
                period,
                manager_email: managerEmail,
                manager_name: managerUser ? managerUser.full_name : null,
                manager_role: managerUser ? managerUser.role : null,
                requesting_user: requestingUser.email || requestingUser.userId
            },
            created_at: new Date().toISOString()
        });
    } catch (e) {
        // Non-fatal — audit log failure must not block the unlock
        console.error('Unlock audit log failed (non-fatal):', e.message);
    }
}

module.exports = router;
