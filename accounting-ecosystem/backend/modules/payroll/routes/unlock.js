/**
 * ============================================================================
 * Payroll Payslip Unlock — Server-Side Authorization
 * ============================================================================
 * POST /api/payroll/unlock
 *
 * Unlocks ONE finalized payslip that is not part of a finalized pay run (e.g. an
 * individually finalized or imported month). A payslip in a finalized run must be
 * corrected by reversing the whole run (POST /api/payroll/reverse).
 *
 * Fase 10 (spec 07 UF-10, spec 13 TS-04, finding B6) — fail-closed rules:
 *   1. The approver must be a manager IN THIS COMPANY (active user_company_access
 *      row with a PAYSLIPS.UNLOCK role) or a super user. A manager of another
 *      company used to be accepted (the global users.role was checked).
 *   2. The approver may not be the person asking for the unlock.
 *   3. At most 5 failed attempts per requesting user per company per 15 minutes.
 *   4. Wrong e-mail and wrong password give the same answer (no account probing).
 *   5. Any check that cannot be completed → refused (it used to carry on).
 *   6. Every attempt is written to audit_log (it wrote to `audit_logs`, a table
 *      that does not exist — no unlock was ever recorded).
 * ============================================================================
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { PERMISSIONS } = require('../../../config/permissions');

const router = express.Router();
// Own auth (it used to rely on another router mounted earlier at '/' having set req.user).
router.use(authenticateToken);
router.use(requireCompany);
const KV_TABLE = 'payroll_kv_store_eco';

// Company roles that may authorize an unlock — same list as the PAYSLIPS.UNLOCK permission.
const UNLOCK_AUTHORIZER_ROLES = PERMISSIONS.PAYSLIPS.UNLOCK;
const MAX_FAILED = 5;
const WINDOW_MINUTES = 15;
const GENERIC_DENIED = 'Manager authorization failed — the e-mail or password is wrong, or this person may not approve unlocks for this company.';

class Refused extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Write one unlock attempt to audit_log. Throws when it cannot be written. */
async function audit(req, actionType, empId, period, metadata) {
    const { error } = await supabase.from('audit_log').insert({
        company_id: req.companyId,
        user_id: (req.user && req.user.userId) || null,
        user_email: (req.user && req.user.email) || null,
        module: 'payroll',
        action_type: actionType,
        entity_type: 'payslip',
        entity_id: `${empId}_${period}`,
        ip_address: req.ip || null,
        user_agent: req.headers['user-agent'] || null,
        metadata: JSON.stringify(Object.assign({ emp_id: empId, period }, metadata || {})),
        created_at: new Date().toISOString()
    });
    if (error) throw new Error('audit_log: ' + error.message);
}

async function recentFailures(req) {
    const since = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
    const { data, error } = await supabase.from('audit_log')
        .select('id')
        .eq('company_id', req.companyId)
        .eq('user_id', req.user.userId)
        .eq('action_type', 'PAYSLIP_UNLOCK_FAILED')
        .gte('created_at', since);
    if (error) throw new Refused(503, 'CHECK_FAILED', 'Unlock is temporarily unavailable — please try again shortly.');
    return (data || []).length;
}

// ── POST /api/payroll/unlock ──────────────────────────────────────────────────
// Body:  { empId, period, managerEmail, managerPassword }
// Auth:  Bearer token of the REQUESTING user (must have PAYSLIPS.UNLOCK)
router.post('/', requirePermission('PAYSLIPS.UNLOCK'), async (req, res) => {
    const { empId, period, managerEmail, managerPassword } = req.body || {};
    const companyId = req.companyId;
    const requester = req.user || {};
    const empIdInt = parseInt(empId, 10);

    try {
        if (!Number.isInteger(empIdInt) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) {
            throw new Refused(400, 'BAD_REQUEST', 'empId and period (YYYY-MM) are required');
        }
        if (!managerEmail || !managerPassword) {
            throw new Refused(400, 'BAD_REQUEST', 'Manager credentials required for unlock authorization');
        }

        // ── 3. attempt limit (checked before any password work) ──
        if (await recentFailures(req) >= MAX_FAILED) {
            throw new Refused(429, 'TOO_MANY_ATTEMPTS', `Too many failed unlock attempts. Try again in ${WINDOW_MINUTES} minutes.`);
        }

        // ── the payslip must be locked and not part of a finalized run ──
        const { data: snap, error: snapErr } = await supabase
            .from('payroll_snapshots')
            .select('id, payroll_run_id, is_locked')
            .eq('company_id', companyId)
            .eq('employee_id', empIdInt)
            .eq('period_key', String(period))
            .eq('is_locked', true)
            .neq('status', 'reversed')
            .maybeSingle();
        if (snapErr) throw new Refused(503, 'CHECK_FAILED', 'Could not check the payslip — nothing was unlocked.');
        if (!snap) throw new Refused(404, 'NOT_LOCKED', 'This payslip is not finalized — nothing to unlock.');
        if (snap.payroll_run_id) {
            const { data: run, error: runErr } = await supabase
                .from('payroll_runs').select('id, status')
                .eq('id', snap.payroll_run_id).eq('company_id', companyId).maybeSingle();
            if (runErr) throw new Refused(503, 'CHECK_FAILED', 'Could not check the pay run — nothing was unlocked.');
            if (run && run.status === 'finalized') {
                return res.status(422).json({
                    error: 'This payslip is part of a finalised pay run. To make corrections, reverse the entire pay run in Execute Payroll, then re-run and re-finalise.',
                    code: 'REQUIRES_RUN_REVERSAL',
                    run_id: run.id
                });
            }
        }

        // ── verify the approver ──
        const { data: mgrs, error: mgrErr } = await supabase
            .from('users')
            .select('id, email, password_hash, full_name, is_super_admin, is_active')
            .ilike('email', String(managerEmail).trim())
            .limit(2);
        if (mgrErr) throw new Refused(503, 'CHECK_FAILED', 'Could not verify the manager — nothing was unlocked.');
        const mgr = (mgrs || []).length === 1 ? mgrs[0] : null;
        // Compare against a dummy hash when the user doesn't exist, so timing doesn't reveal it.
        const ok = await bcrypt.compare(String(managerPassword), (mgr && mgr.password_hash) || '$2a$10$CwTycUXWue0Thq9StjUM0uJ8zN0ZnUnL5VqfGxYQ3Wk3Jxk4Gq1Fe');
        if (!mgr || !ok || mgr.is_active === false) {
            await audit(req, 'PAYSLIP_UNLOCK_FAILED', empIdInt, period, { reason: 'credentials', manager_email: managerEmail });
            throw new Refused(401, 'DENIED', GENERIC_DENIED);
        }

        // ── 2. no self-approval ──
        if (String(mgr.id) === String(requester.userId)) {
            await audit(req, 'PAYSLIP_UNLOCK_FAILED', empIdInt, period, { reason: 'self_approval', manager_id: mgr.id });
            throw new Refused(403, 'SELF_APPROVAL', 'You cannot approve your own unlock — another manager of this company must approve it.');
        }

        // ── 1. approver must be a manager of THIS company (or a super user) ──
        let allowed = mgr.is_super_admin === true;
        if (!allowed) {
            const { data: acc, error: accErr } = await supabase
                .from('user_company_access')
                .select('role, is_active')
                .eq('user_id', mgr.id)
                .eq('company_id', companyId);
            if (accErr) throw new Refused(503, 'CHECK_FAILED', 'Could not verify the manager\'s access — nothing was unlocked.');
            allowed = (acc || []).some(a => a.is_active !== false && UNLOCK_AUTHORIZER_ROLES.includes(a.role));
        }
        if (!allowed) {
            await audit(req, 'PAYSLIP_UNLOCK_FAILED', empIdInt, period, { reason: 'not_company_manager', manager_id: mgr.id });
            throw new Refused(401, 'DENIED', GENERIC_DENIED);
        }

        // ── unlock (DB is authoritative; legacy KV keys removed best effort) ──
        const { data: updated, error: upErr } = await supabase
            .from('payroll_snapshots')
            .update({ is_locked: false, status: 'draft' })
            .eq('id', snap.id)
            .eq('company_id', companyId)
            .eq('is_locked', true)
            .select('id');
        if (upErr || !(updated || []).length) {
            throw new Refused(500, 'UNLOCK_FAILED', 'Unlock failed — the payslip could not be updated.');
        }
        try {
            await supabase.from(KV_TABLE).delete().eq('company_id', companyId)
                .in('key', [`emp_payslip_status_${companyId}_${empIdInt}_${period}`, `emp_historical_${companyId}_${empIdInt}_${period}`]);
        } catch (_) { /* legacy keys — not authoritative */ }

        // ── 6. audit (the unlock already happened; a failed write is logged loudly) ──
        try {
            await audit(req, 'PAYSLIP_UNLOCK', empIdInt, period, {
                snapshot_id: snap.id, manager_id: mgr.id, manager_email: mgr.email, manager_name: mgr.full_name || null
            });
        } catch (e) {
            console.error('[unlock] AUDIT WRITE FAILED after unlock of snapshot', snap.id, e.message);
        }

        return res.json({
            ok: true,
            message: 'Payslip unlocked successfully',
            unlockedBy: {
                requestingUser: requester.email || requester.userId,
                authorizedBy: mgr.email,
                authorizedByName: mgr.full_name || mgr.email,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        if (err instanceof Refused) return res.status(err.status).json({ error: err.message, code: err.code });
        console.error('[unlock] error:', err.message);
        // A failure to record a failed attempt also ends here — refused, never unlocked.
        return res.status(503).json({ error: 'Unlock is temporarily unavailable — nothing was unlocked.', code: 'CHECK_FAILED' });
    }
});

module.exports = router;
