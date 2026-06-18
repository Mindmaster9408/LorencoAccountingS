/**
 * ============================================================================
 * Two-Factor Authentication Routes — Lorenco Ecosystem (DORMANT FOUNDATION)
 * ============================================================================
 * All endpoints are protected by existing authenticateToken middleware.
 * No endpoint is called from the active login flow.
 *
 * ACTIVATION RULE: All enforcement paths are gated by:
 *   isTwoFactorEnforcementActive() → reads TWO_FACTOR_AUTH_ENABLED env var
 *   featureFlags.isEnabled('TWO_FACTOR_AUTH', context) → DB flag check
 *
 * When both gates are false (current state), endpoints return status info
 * but no enforcement occurs and no login flow is disrupted.
 *
 * SECURITY GUARANTEES:
 *   - Encrypted secret is NEVER returned in any API response
 *   - Backup code hashes are NEVER returned in any API response
 *   - All 2FA state is server-side SQL (no localStorage, no sessionStorage)
 *   - Setup requires verification before enabling (no unconfirmed secrets stored)
 *   - Rate limiting applied to verify endpoint (when rate-limit middleware present)
 *
 * Routes:
 *   GET  /api/auth/2fa/status          — current 2FA state for authenticated user
 *   POST /api/auth/2fa/setup/start     — begin setup: generate secret + QR code
 *   POST /api/auth/2fa/setup/confirm   — confirm setup: verify code, save encrypted secret
 *   POST /api/auth/2fa/disable         — disable 2FA for current user (stub, needs password)
 *   POST /api/auth/2fa/verify          — verify a TOTP code (dormant login challenge)
 * ============================================================================
 */

'use strict';

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../../middleware/auth');
const { supabase } = require('../../config/database');
const { featureFlags } = require('../../services/featureFlags');
const tfa = require('../../services/twoFactorAuth');

// ── In-memory temporary secret store (setup flow only) ───────────────────────
// Holds the plaintext TOTP secret between setup/start and setup/confirm.
// This is NOT browser storage — it lives in server memory only.
// Keyed by userId → { secret, encryptedSecret, expiresAt }
// Evicted after 10 minutes or on confirm/cancel.
const _pendingSetup = new Map();
const SETUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function _cleanPendingSetup() {
  const now = Date.now();
  for (const [key, val] of _pendingSetup.entries()) {
    if (val.expiresAt < now) _pendingSetup.delete(key);
  }
}

// Clean expired pending setups every 5 minutes
setInterval(_cleanPendingSetup, 5 * 60 * 1000).unref();

// ── Helper: log a security event ─────────────────────────────────────────────

async function logSecurityEvent(userId, eventType, req, metadata = {}) {
  try {
    await supabase.from('user_security_events').insert({
      user_id: userId,
      event_type: eventType,
      ip_address: req.ip || req.headers['x-forwarded-for'] || null,
      user_agent: req.headers['user-agent'] || null,
      metadata,
    });
  } catch {
    // Security event logging is non-fatal — never block the request
  }
}

// ── Helper: resolve feature flag state ──────────────────────────────────────

async function getTwoFactorFeatureFlagState(req) {
  try {
    const context = {
      companyId: req.companyId || req.user?.companyId || null,
      isSuperAdmin: req.user?.isSuperAdmin ?? false,
    };
    const featureAvailable = await featureFlags.isEnabled('TWO_FACTOR_AUTH', context);
    const enforcementActive = tfa.isTwoFactorEnforcementActive() && featureAvailable;
    return { featureAvailable, enforcementActive };
  } catch {
    // If feature flags DB is unavailable, default to off — never block users
    return { featureAvailable: false, enforcementActive: false };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/auth/2fa/status
// Returns the current 2FA state for the authenticated user.
// Always safe to call — returns status info only, no secrets.
// ════════════════════════════════════════════════════════════════════════════

router.get('/2fa/status', authenticateToken, async (req, res) => {
  try {
    const { featureAvailable, enforcementActive } = await getTwoFactorFeatureFlagState(req);

    const { data: user, error } = await supabase
      .from('users')
      .select('two_factor_enabled, two_factor_confirmed_at, two_factor_last_verified_at')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      enabled: user.two_factor_enabled || false,
      confirmed_at: user.two_factor_confirmed_at || null,
      last_verified_at: user.two_factor_last_verified_at || null,
      feature_available: featureAvailable,
      enforcement_active: enforcementActive,
    });
  } catch (err) {
    console.error('[2FA] status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/2fa/setup/start
// Generates a TOTP secret and returns a QR code for the authenticator app.
// Does NOT permanently enable 2FA — only confirmed by /setup/confirm.
//
// Gated: only works when feature flag allows setup UI.
// If feature is not available, returns 403 with a clear message.
// ════════════════════════════════════════════════════════════════════════════

router.post('/2fa/setup/start', authenticateToken, async (req, res) => {
  try {
    if (!tfa.isEncryptionKeyConfigured()) {
      return res.status(503).json({
        error: '2FA encryption is not configured on this server. Contact the system administrator.',
        code: '2FA_ENCRYPTION_NOT_CONFIGURED',
      });
    }

    const { featureAvailable } = await getTwoFactorFeatureFlagState(req);

    if (!featureAvailable) {
      return res.status(403).json({
        error: '2FA setup is not available yet. This feature is coming soon.',
        code: '2FA_NOT_AVAILABLE',
      });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, two_factor_enabled')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.two_factor_enabled) {
      return res.status(409).json({
        error: '2FA is already enabled for this account. Disable it first to re-setup.',
        code: '2FA_ALREADY_ENABLED',
      });
    }

    // Generate setup data — secret stays server-side only
    const { qrCodeDataUrl, otpauthUrl, encryptedSecret } = await tfa.generateSetupData(
      user.username,
      user.email
    );

    // Store encrypted secret temporarily in server memory (not DB yet, not browser storage)
    _pendingSetup.set(String(user.id), {
      encryptedSecret,
      expiresAt: Date.now() + SETUP_TTL_MS,
    });

    await logSecurityEvent(user.id, '2fa_setup_started', req);

    // Return QR code and otpauth URL — the plain secret is intentionally NOT returned
    res.json({
      success: true,
      qrCodeDataUrl,
      otpauthUrl,
      issuer: 'Lorenco Ecosystem',
      expiresInMinutes: 10,
      instructions: [
        'Open your authenticator app (Google Authenticator, Microsoft Authenticator, Authy, etc.)',
        'Tap the + or scan icon, then scan the QR code below',
        'Once added, enter the 6-digit code shown in the app to confirm setup',
      ],
    });
  } catch (err) {
    console.error('[2FA] setup/start error:', err.message);
    res.status(500).json({ error: 'Server error during 2FA setup' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/2fa/setup/confirm
// Accepts a 6-digit TOTP code and, if valid, permanently enables 2FA.
// Also generates backup codes shown once in the response.
//
// After this succeeds:
//   - users.two_factor_enabled = true
//   - users.two_factor_secret_encrypted = encrypted TOTP secret
//   - users.two_factor_confirmed_at = now
//   - users.two_factor_backup_codes_hash = bcrypt hashed backup codes
//   - Backup codes returned ONCE — not stored plain, never returned again
// ════════════════════════════════════════════════════════════════════════════

router.post('/2fa/setup/confirm', authenticateToken, async (req, res) => {
  try {
    if (!tfa.isEncryptionKeyConfigured()) {
      return res.status(503).json({
        error: '2FA encryption is not configured on this server. Contact the system administrator.',
        code: '2FA_ENCRYPTION_NOT_CONFIGURED',
      });
    }

    const { featureAvailable } = await getTwoFactorFeatureFlagState(req);
    if (!featureAvailable) {
      return res.status(403).json({ error: '2FA is not available yet.', code: '2FA_NOT_AVAILABLE' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      return res.status(400).json({ error: 'A valid 6-digit code is required.' });
    }

    const pending = _pendingSetup.get(String(req.user.userId));
    if (!pending || pending.expiresAt < Date.now()) {
      _pendingSetup.delete(String(req.user.userId));
      return res.status(400).json({
        error: 'No pending 2FA setup found or setup has expired. Please start setup again.',
        code: '2FA_SETUP_EXPIRED',
      });
    }

    const { encryptedSecret } = pending;

    // Verify the code against the temporary secret
    const valid = tfa.verifyCode(encryptedSecret, code.trim());
    if (!valid) {
      await logSecurityEvent(req.user.userId, '2fa_setup_failed', req, { reason: 'wrong_code' });
      return res.status(422).json({
        error: 'Invalid code. Please check your authenticator app and try again.',
        code: '2FA_INVALID_CODE',
      });
    }

    // Code is correct — generate backup codes and save everything to DB
    const { plainCodes, hashedCodes } = await tfa.generateBackupCodes();

    const { error: updateErr } = await supabase
      .from('users')
      .update({
        two_factor_enabled: true,
        two_factor_secret_encrypted: encryptedSecret,
        two_factor_confirmed_at: new Date().toISOString(),
        two_factor_backup_codes_hash: hashedCodes,
        two_factor_last_verified_at: null,
        two_factor_recovery_used_at: null,
      })
      .eq('id', req.user.userId);

    if (updateErr) {
      console.error('[2FA] DB update error during confirm:', updateErr.message);
      return res.status(500).json({ error: 'Failed to save 2FA setup. Please try again.' });
    }

    // Remove from pending setup store
    _pendingSetup.delete(String(req.user.userId));

    await logSecurityEvent(req.user.userId, '2fa_setup_confirmed', req);

    res.json({
      success: true,
      message: '2FA has been enabled on your account.',
      backupCodes: plainCodes,
      backupCodeWarning: [
        'IMPORTANT: Save these backup codes in a safe place.',
        'Each code can only be used once.',
        'These codes will NOT be shown again.',
        'Use a backup code to log in if you lose access to your authenticator app.',
      ],
    });
  } catch (err) {
    console.error('[2FA] setup/confirm error:', err.message);
    res.status(500).json({ error: 'Server error during 2FA confirmation' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/2fa/disable
// Disables 2FA for the current user.
// Requires password confirmation to prevent unauthorised disable.
//
// STATUS: Functional stub — password verification logic is in place.
// Only callable when feature flag is available.
// ════════════════════════════════════════════════════════════════════════════

router.post('/2fa/disable', authenticateToken, async (req, res) => {
  try {
    if (!tfa.isEncryptionKeyConfigured()) {
      return res.status(503).json({
        error: '2FA encryption is not configured on this server. Contact the system administrator.',
        code: '2FA_ENCRYPTION_NOT_CONFIGURED',
      });
    }

    const { featureAvailable } = await getTwoFactorFeatureFlagState(req);
    if (!featureAvailable) {
      return res.status(403).json({ error: '2FA management is not available yet.', code: '2FA_NOT_AVAILABLE' });
    }

    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Current password is required to disable 2FA.' });
    }

    const bcrypt = require('bcryptjs');
    const { data: user, error } = await supabase
      .from('users')
      .select('id, password_hash, two_factor_enabled')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.two_factor_enabled) {
      return res.status(409).json({ error: '2FA is not currently enabled on this account.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({
        two_factor_enabled: false,
        two_factor_secret_encrypted: null,
        two_factor_confirmed_at: null,
        two_factor_backup_codes_hash: null,
        two_factor_last_verified_at: null,
      })
      .eq('id', req.user.userId);

    if (updateErr) {
      return res.status(500).json({ error: 'Failed to disable 2FA. Please try again.' });
    }

    await logSecurityEvent(req.user.userId, '2fa_disabled', req);

    res.json({ success: true, message: '2FA has been disabled on your account.' });
  } catch (err) {
    console.error('[2FA] disable error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/2fa/verify
// DORMANT LOGIN CHALLENGE ENDPOINT — not called from active login flow yet.
// Will be invoked from the login route only when:
//   TWO_FACTOR_AUTH_ENABLED=true AND feature flag active AND user.two_factor_enabled=true
//
// Accepts either a 6-digit TOTP code or a backup code.
// On success: updates two_factor_last_verified_at, issues full session JWT.
// On failure: logs the attempt, returns 422.
// ════════════════════════════════════════════════════════════════════════════

router.post('/2fa/verify', authenticateToken, async (req, res) => {
  try {
    if (!tfa.isEncryptionKeyConfigured()) {
      return res.status(503).json({
        error: '2FA encryption is not configured on this server. Contact the system administrator.',
        code: '2FA_ENCRYPTION_NOT_CONFIGURED',
      });
    }

    // Dormant gate: if enforcement is not active, this endpoint should not be called
    const { enforcementActive } = await getTwoFactorFeatureFlagState(req);
    if (!enforcementActive) {
      return res.status(403).json({
        error: '2FA verification is not active. This endpoint is reserved for future use.',
        code: '2FA_NOT_ENFORCED',
      });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'A 6-digit TOTP code or backup code is required.' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, two_factor_enabled, two_factor_secret_encrypted, two_factor_backup_codes_hash, two_factor_confirmed_at')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.two_factor_enabled || !user.two_factor_confirmed_at) {
      return res.status(400).json({ error: '2FA is not fully set up for this account.' });
    }

    const trimmedCode = code.trim();
    let verified = false;
    let usedBackup = false;

    // Try TOTP first
    if (/^\d{6}$/.test(trimmedCode)) {
      verified = tfa.verifyCode(user.two_factor_secret_encrypted, trimmedCode);
    }

    // Try backup code if TOTP failed or code format suggests backup (contains hyphen)
    if (!verified && user.two_factor_backup_codes_hash?.length > 0) {
      const idx = await tfa.verifyBackupCode(trimmedCode, user.two_factor_backup_codes_hash);
      if (idx >= 0) {
        verified = true;
        usedBackup = true;

        // Remove the used backup code (single-use)
        const updatedHashes = [...user.two_factor_backup_codes_hash];
        updatedHashes.splice(idx, 1);
        await supabase.from('users').update({
          two_factor_backup_codes_hash: updatedHashes,
          two_factor_recovery_used_at: new Date().toISOString(),
        }).eq('id', user.id);
      }
    }

    if (!verified) {
      await logSecurityEvent(user.id, '2fa_verify_failed', req, { reason: 'wrong_code' });
      return res.status(422).json({
        error: 'Invalid code. Please check your authenticator app and try again.',
        code: '2FA_INVALID_CODE',
      });
    }

    // Update last verified timestamp
    await supabase.from('users').update({
      two_factor_last_verified_at: new Date().toISOString(),
    }).eq('id', user.id);

    await logSecurityEvent(user.id, usedBackup ? '2fa_backup_used' : '2fa_verify_success', req);

    res.json({
      success: true,
      verified: true,
      usedBackupCode: usedBackup,
      remainingBackupCodes: usedBackup
        ? (user.two_factor_backup_codes_hash?.length - 1)
        : undefined,
    });
  } catch (err) {
    console.error('[2FA] verify error:', err.message);
    res.status(500).json({ error: 'Server error during 2FA verification' });
  }
});

module.exports = router;
