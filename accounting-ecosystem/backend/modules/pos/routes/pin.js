/**
 * ============================================================================
 * POS PIN Management Routes — Workstream 18
 * ============================================================================
 * Mounted at /api/pos/users (see pos/index.js)
 *
 * GET    /api/pos/users/:userId/pin-status  — check if user has a PIN
 * POST   /api/pos/users/:userId/pin         — set or replace a user's PIN
 * DELETE /api/pos/users/:userId/pin         — remove a user's PIN
 *
 * All routes require the caller to be authenticated (authenticateToken applied
 * at the POS module mount) and to have SETTINGS.EDIT permission (management).
 *
 * PIN-eligible roles: all roles — any user may need to work the till.
 *
 * Security rules enforced here:
 *   - PINs never returned in any response
 *   - PINs stored as bcrypt hash (12 rounds) only
 *   - Target user must be in the same company as the caller
 *   - Target user must have a PIN-eligible role
 *   - Weak PINs (all-same-digit, sequential) are rejected
 * ============================================================================
 */

const express  = require('express');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { supabase }           = require('../../../config/database');
const { requirePermission }  = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

// All roles can receive a PIN — any user may need to work the till.
// Managers and owners use password login by default but may also set a PIN for quick access.
const PIN_ELIGIBLE_ROLES = new Set([
    'cashier', 'senior_cashier', 'shift_supervisor', 'assistant_manager',
    'store_manager', 'district_manager', 'district_trainer', 'regional_manager', 'regional_analyst',
    'corporate_admin', 'corporate_finance', 'corporate_ops',
    'business_owner', 'accountant', 'administrator', 'admin',
    'practice_manager', 'payroll_admin', 'leave_admin', 'trainee', 'super_admin',
]);

const WEAK_PINS = new Set([
    '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
    '1234','2345','3456','4567','5678','6789','0123','9876','8765','7654',
    '6543','5432','4321','3210',
]);

function isWeakPin(pin) {
    return WEAK_PINS.has(pin) || /^(.)\1+$/.test(pin);
}

/**
 * Checks whether `candidatePin` already belongs to some OTHER active PIN
 * holder in this company. Required now that PIN-only login (Workstream 101 —
 * no employee code typed, just the PIN, on a locked/trusted device) resolves
 * the user by scanning every PIN-eligible user's hash for a match: two
 * people sharing a PIN in the same company would make that lookup
 * ambiguous/wrong. bcrypt hashes are salted, so this can't be an index
 * lookup — it bcrypt-compares against every other active PIN in the company.
 * Company-scoped is small in practice (one store's staff), so this is cheap.
 */
async function findPinCollision(companyId, candidatePin, excludeUserId) {
    const { data: others } = await supabase
        .from('user_pos_pins')
        .select('user_id, pin_hash')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .neq('user_id', excludeUserId);

    for (const row of (others || [])) {
        if (await bcrypt.compare(candidatePin, row.pin_hash)) return true;
    }
    return false;
}

// ── GET /api/pos/users/:userId/pin-status ────────────────────────────────────
router.get('/:userId/pin-status', requirePermission('SETTINGS.EDIT'), async (req, res) => {
    try {
        const userId    = parseInt(req.params.userId);
        const companyId = req.companyId;
        if (!userId) return res.status(400).json({ error: 'Invalid userId' });

        // Confirm target user belongs to this company and is PIN-eligible
        const { data: access } = await supabase
            .from('user_company_access')
            .select('role, is_active, users:user_id(id, username, full_name)')
            .eq('company_id', companyId)
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!access) return res.status(404).json({ error: 'User not found in this company' });

        const { data: pinRecord } = await supabase
            .from('user_pos_pins')
            .select('id, is_active, updated_at')
            .eq('company_id', companyId)
            .eq('user_id', userId)
            .maybeSingle();

        res.json({
            userId,
            username:      access.users?.username,
            fullName:      access.users?.full_name,
            role:          access.role,
            pinEligible:   true, // all roles can have a PIN
            hasPinSet:     !!(pinRecord && pinRecord.is_active),
            pinUpdatedAt:  pinRecord?.updated_at || null,
        });
    } catch (err) {
        console.error('[pos/pin] GET pin-status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── POST /api/pos/users/:userId/pin ─────────────────────────────────────────
router.post('/:userId/pin', requirePermission('SETTINGS.EDIT'), async (req, res) => {
    try {
        const userId    = parseInt(req.params.userId);
        const companyId = req.companyId;
        const { pin }   = req.body;

        if (!userId) return res.status(400).json({ error: 'Invalid userId' });
        if (!pin || !/^\d{4,6}$/.test(String(pin))) {
            return res.status(400).json({ error: 'PIN must be 4–6 digits' });
        }
        if (isWeakPin(String(pin))) {
            return res.status(400).json({ error: 'PIN is too simple. Use a less predictable combination.' });
        }

        // Confirm target user belongs to this company with a PIN-eligible role
        const { data: access } = await supabase
            .from('user_company_access')
            .select('role, is_active, users:user_id(id, username, full_name)')
            .eq('company_id', companyId)
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!access) return res.status(404).json({ error: 'User not found in this company' });
        // All roles are PIN-eligible — any user may need to work the till

        // Must be unique within the company — PIN-only login (no employee code
        // typed) resolves the user purely by which PIN matches.
        if (await findPinCollision(companyId, String(pin), userId)) {
            return res.status(409).json({ error: 'This PIN is already in use by another employee in this company. Choose a different PIN.' });
        }

        // Hash the PIN — 12 rounds, same policy as password hashing in auth.js
        const pinHash = await bcrypt.hash(String(pin), 12);

        // Upsert: insert if no record, update pin_hash if exists
        const { error: upsertErr } = await supabase
            .from('user_pos_pins')
            .upsert({
                company_id: companyId,
                user_id:    userId,
                pin_hash:   pinHash,
                is_active:  true,
                updated_at: new Date().toISOString(),
                updated_by: req.user.userId,
            }, { onConflict: 'company_id,user_id' });

        if (upsertErr) {
            console.error('[pos/pin] upsert error:', upsertErr.message);
            return res.status(500).json({ error: 'Failed to save PIN' });
        }

        posAuditFromReq(req, POS_EVENTS.USER_PIN_SET, {
            entityType: 'user',
            entityId:   String(userId),
            notes:      `PIN set for ${access.users?.username || userId} (role: ${access.role})`,
        });

        res.json({ success: true, message: 'PIN set successfully' });
    } catch (err) {
        console.error('[pos/pin] POST pin error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── POST /api/pos/users/:userId/pin/generate ─────────────────────────────────
// Server-generates a random 4-digit PIN instead of the manager typing one in —
// requested so managers don't have to invent PINs themselves, and so PINs are
// uniformly random rather than picking predictable numbers (birthdays, etc.),
// which also makes company-wide PIN-only login (no employee code, see
// auth.js /pos/pin-login) meaningfully harder to brute-force per guess.
// The plaintext PIN is returned exactly once, in this response only — it is
// never logged, never stored, and can never be retrieved again afterwards
// (same "PINs never returned" invariant as everywhere else in this file,
// except for this one intentional, one-time reveal at creation).
router.post('/:userId/pin/generate', requirePermission('SETTINGS.EDIT'), async (req, res) => {
    try {
        const userId    = parseInt(req.params.userId);
        const companyId = req.companyId;
        if (!userId) return res.status(400).json({ error: 'Invalid userId' });

        const { data: access } = await supabase
            .from('user_company_access')
            .select('role, is_active, users:user_id(id, username, full_name)')
            .eq('company_id', companyId)
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!access) return res.status(404).json({ error: 'User not found in this company' });

        let pin = null;
        const MAX_ATTEMPTS = 30;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const candidate = String(crypto.randomInt(0, 10000)).padStart(4, '0');
            if (isWeakPin(candidate)) continue;
            if (await findPinCollision(companyId, candidate, userId)) continue;
            pin = candidate;
            break;
        }

        if (!pin) {
            // Extremely unlikely at realistic company staff sizes (4-digit space
            // is 10,000, minus ~34 weak PINs) — surfaced rather than silently
            // looping forever or saving a colliding PIN.
            return res.status(500).json({ error: 'Could not generate a unique PIN — please try again.' });
        }

        const pinHash = await bcrypt.hash(pin, 12);
        const { error: upsertErr } = await supabase
            .from('user_pos_pins')
            .upsert({
                company_id: companyId,
                user_id:    userId,
                pin_hash:   pinHash,
                is_active:  true,
                updated_at: new Date().toISOString(),
                updated_by: req.user.userId,
            }, { onConflict: 'company_id,user_id' });

        if (upsertErr) {
            console.error('[pos/pin] generate upsert error:', upsertErr.message);
            return res.status(500).json({ error: 'Failed to save PIN' });
        }

        posAuditFromReq(req, POS_EVENTS.USER_PIN_SET, {
            entityType: 'user',
            entityId:   String(userId),
            notes:      `PIN auto-generated for ${access.users?.username || userId} (role: ${access.role})`,
        });

        res.json({ success: true, pin, message: 'PIN generated. Write it down now — it will not be shown again.' });
    } catch (err) {
        console.error('[pos/pin] POST pin/generate error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── DELETE /api/pos/users/:userId/pin ───────────────────────────────────────
router.delete('/:userId/pin', requirePermission('SETTINGS.EDIT'), async (req, res) => {
    try {
        const userId    = parseInt(req.params.userId);
        const companyId = req.companyId;
        if (!userId) return res.status(400).json({ error: 'Invalid userId' });

        const { data: access } = await supabase
            .from('user_company_access')
            .select('role, users:user_id(username)')
            .eq('company_id', companyId)
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (!access) return res.status(404).json({ error: 'User not found in this company' });

        const { error: delErr } = await supabase
            .from('user_pos_pins')
            .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: req.user.userId })
            .eq('company_id', companyId)
            .eq('user_id', userId);

        if (delErr) {
            console.error('[pos/pin] delete error:', delErr.message);
            return res.status(500).json({ error: 'Failed to remove PIN' });
        }

        posAuditFromReq(req, POS_EVENTS.USER_PIN_REMOVED, {
            entityType: 'user',
            entityId:   String(userId),
            notes:      `PIN removed for ${access.users?.username || userId}`,
        });

        res.json({ success: true, message: 'PIN removed' });
    } catch (err) {
        console.error('[pos/pin] DELETE pin error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
