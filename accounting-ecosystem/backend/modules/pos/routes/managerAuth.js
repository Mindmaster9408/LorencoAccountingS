/**
 * ============================================================================
 * POS Manager Authorization Routes - Checkout Charlie Module
 * ============================================================================
 * One shared "a manager approves a cashier-initiated action by entering
 * their PIN" mechanism — currently used for:
 *   - a manual checkout discount a non-manager cashier wants to give
 *   - a return, when the cashier processing it isn't management-tier
 *
 * Replaces the previous mechanism (frontend managerAuthModal calling
 * POST /auth/verify-manager), which never had a real backend endpoint at
 * all — found live 2026-07-31, every cashier-initiated return had been
 * failing manager authorization outright since that flow was written.
 *
 * Not a token — a short-lived DB row (pos_manager_authorizations), the
 * same pattern the rest of this codebase uses for audit/authorization
 * state. A manager's PIN is verified the same bcrypt-loop, timing-safe way
 * as POST /api/auth/pos/pin-login (shared/routes/auth.js) — that endpoint
 * logs a user IN; this one only proves, briefly, that a manager approved
 * one specific action, without creating a session for them.
 * ============================================================================
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const { supabase } = require('../../../config/database');
const { requireCompany } = require('../../../middleware/auth');
const { MANAGEMENT_ROLES } = require('../../../config/permissions');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(requireCompany);

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACTION_TYPES = new Set(['discount', 'return']);

// Timing protection: always run one bcrypt.compare even when no PIN row
// could possibly match, so response time doesn't leak whether ANY manager
// PIN was close — same defense as pin-login's _PIN_TIMING_DUMMY.
const _PIN_TIMING_DUMMY = bcrypt.hashSync('__cc_manager_auth_timing_dummy__', 10);

/**
 * POST /api/pos/manager-auth/verify
 * Body: { pin, action_type: 'discount'|'return', till_session_id, discount_percent? }
 */
router.post('/verify', async (req, res) => {
  try {
    const { pin, action_type, till_session_id, discount_percent } = req.body;

    if (!pin || !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: 'A valid PIN is required' });
    }
    if (!ACTION_TYPES.has(action_type)) {
      return res.status(400).json({ error: "action_type must be 'discount' or 'return'" });
    }
    let discountPercentValue = null;
    if (action_type === 'discount') {
      discountPercentValue = parseFloat(discount_percent);
      if (isNaN(discountPercentValue) || discountPercentValue <= 0 || discountPercentValue > 100) {
        return res.status(400).json({ error: 'discount_percent must be a number greater than 0 and up to 100' });
      }
    }

    // Scan every management-tier user in this company with an active PIN —
    // same two-query pattern as pin-login's PIN-only path (user_pos_pins has
    // no FK to user_company_access, so each is joined to users independently).
    const [{ data: pinRows }, { data: accessRows }] = await Promise.all([
      supabase.from('user_pos_pins')
        .select('user_id, pin_hash, users:user_id(id, full_name, username, is_active)')
        .eq('company_id', req.companyId)
        .eq('is_active', true),
      supabase.from('user_company_access')
        .select('user_id, role')
        .eq('company_id', req.companyId)
        .eq('is_active', true)
        .in('role', MANAGEMENT_ROLES),
    ]);

    const managerRoleByUserId = new Map((accessRows || []).map(r => [r.user_id, r.role]));

    let matchedRow = null;
    for (const row of (pinRows || [])) {
      if (!managerRoleByUserId.has(row.user_id)) continue; // not management-tier
      if (!row.users || !row.users.is_active) continue;
      if (!row.pin_hash) continue;
      if (await bcrypt.compare(String(pin), row.pin_hash)) {
        matchedRow = row;
        break;
      }
    }

    // Always run one compare even on an empty/no-match scan — timing-safe.
    if (!matchedRow) await bcrypt.compare(String(pin), _PIN_TIMING_DUMMY);

    if (!matchedRow) {
      posAuditFromReq(req, POS_EVENTS.MANAGER_OVERRIDE, {
        tillSessionId: till_session_id || null,
        metadata: { action_type, discount_percent: discountPercentValue, result: 'denied' },
      });
      return res.status(401).json({ authorized: false, error: 'Invalid manager PIN' });
    }

    const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS).toISOString();
    const { data: authRow, error } = await supabase
      .from('pos_manager_authorizations')
      .insert({
        company_id:       req.companyId,
        till_session_id:  till_session_id || null,
        action_type,
        discount_percent: discountPercentValue,
        authorized_by:    matchedRow.user_id,
        expires_at:       expiresAt,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.MANAGER_OVERRIDE, {
      tillSessionId: till_session_id || null,
      metadata: {
        action_type, discount_percent: discountPercentValue, result: 'granted',
        authorization_id: authRow.id, authorized_by: matchedRow.user_id,
      },
    });

    res.json({
      authorized:       true,
      authorization_id: authRow.id,
      manager_name:     matchedRow.users.full_name || matchedRow.users.username,
    });
  } catch (err) {
    console.error('[managerAuth] verify error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
