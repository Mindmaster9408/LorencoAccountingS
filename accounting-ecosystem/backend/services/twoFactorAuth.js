/**
 * ============================================================================
 * Two-Factor Authentication Service — Lorenco Ecosystem
 * ============================================================================
 * TOTP (RFC 6238) compatible with Google Authenticator, Microsoft Authenticator,
 * Authy, 1Password, Bitwarden, and any standards-compliant authenticator app.
 *
 * THIS SERVICE IS DORMANT.
 * No route calls this service during active login unless:
 *   1. TWO_FACTOR_AUTH_ENABLED=true in environment
 *   2. The TWO_FACTOR_AUTH feature flag is active
 *   3. The individual user has two_factor_enabled=true + confirmed_at set
 *
 * Security properties:
 *   - TOTP secret encrypted with AES-256-GCM before DB storage
 *   - Backup codes hashed with bcrypt (never stored plain)
 *   - Encrypted secret never exposed via any API response
 *   - Backup code hashes never exposed via any API response
 *   - No localStorage — all state is server-side DB
 * ============================================================================
 */

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { generateSecret, generateSync, verifySync, generateURI } = require('otplib');
const QRCode = require('qrcode');

// ── Encryption key setup ─────────────────────────────────────────────────────
// TOTP_ENCRYPTION_KEY must be set as a dedicated environment variable.
// JWT_SECRET is for signing login tokens ONLY and must never be reused here.
//
// If TOTP_ENCRYPTION_KEY is absent the app starts normally — normal login,
// dashboard, registration and all apps are unaffected.
// Only 2FA setup/confirm/verify/disable endpoints return 503 until the key is set.

const _TOTP_KEY_RAW = process.env.TOTP_ENCRYPTION_KEY || null;
const _TOTP_KEY_CONFIGURED = !!_TOTP_KEY_RAW;

if (!_TOTP_KEY_CONFIGURED) {
  console.warn('[2FA] TOTP_ENCRYPTION_KEY is not configured. 2FA setup and verification endpoints are disabled until this env var is set in Zeabur Variables. Normal login and all app access are unaffected.');
}

function _deriveEncryptionKey() {
  // _TOTP_KEY_RAW is guaranteed non-null here — callers check _TOTP_KEY_CONFIGURED first
  return crypto.createHash('sha256')
    .update(_TOTP_KEY_RAW + ':lorenco-2fa-key-v1')
    .digest(); // 32 bytes → AES-256
}

// Cache derived key — computed once, reused for the lifetime of the process
let _encKey = null;
function _getEncKey() {
  if (!_TOTP_KEY_CONFIGURED) {
    // Typed error so routes can distinguish this from other failures
    const err = new Error('2FA encryption key is not configured.');
    err.code = 'TOTP_ENCRYPTION_KEY_NOT_CONFIGURED';
    throw err;
  }
  if (!_encKey) _encKey = _deriveEncryptionKey();
  return _encKey;
}

/**
 * Returns true when TOTP_ENCRYPTION_KEY is set and 2FA crypto operations are available.
 * Routes must call this before any encrypt/decrypt/setup/verify operation.
 */
function isEncryptionKeyConfigured() {
  return _TOTP_KEY_CONFIGURED;
}

// ── TOTP constants ───────────────────────────────────────────────────────────
// RFC 6238 defaults — compatible with all major authenticator apps.
// otplib v13 sync API uses { type, secret, window, ... } call options.
const TOTP_OPTIONS = {
  type: 'totp',
  window: 1,   // Accept 1 time-step before/after to tolerate clock skew
  // period: 30 and digits: 6 are otplib defaults — no need to override
};

const ISSUER = 'Lorenco Ecosystem';
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 10; // characters (alphanumeric)
const BCRYPT_ROUNDS = 10;

// ── Encryption / Decryption ──────────────────────────────────────────────────

/**
 * Encrypt a TOTP secret using AES-256-GCM.
 * Returns a base64-encoded string: iv:authTag:ciphertext
 */
function encryptSecret(plaintext) {
  const key = _getEncKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * Decrypt a previously encrypted TOTP secret.
 */
function decryptSecret(encryptedValue) {
  const key = _getEncKey();
  const [ivB64, authTagB64, ciphertextB64] = encryptedValue.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('[2FA] Malformed encrypted secret — expected iv:authTag:ciphertext');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── TOTP Setup ───────────────────────────────────────────────────────────────

/**
 * Generate a new TOTP setup bundle for a user.
 * Returns { secret, otpauthUrl, qrCodeDataUrl, encryptedSecret }
 *
 * encryptedSecret is what gets stored in the DB (only after confirm).
 * secret is used only temporarily during setup — do NOT store it plain.
 * qrCodeDataUrl is the base64 PNG the frontend renders as a QR code.
 */
async function generateSetupData(username, email) {
  const secret = generateSecret();
  const accountLabel = email || username;
  const otpauthUrl = generateURI({ type: 'totp', label: accountLabel, secret, issuer: ISSUER });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    width: 256,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  const encryptedSecret = encryptSecret(secret);
  return { secret, otpauthUrl, qrCodeDataUrl, encryptedSecret };
}

// ── TOTP Verification ────────────────────────────────────────────────────────

/**
 * Verify a 6-digit TOTP code against an encrypted secret.
 * Returns true if valid, false otherwise.
 * Never throws — errors are treated as invalid.
 */
function verifyCode(encryptedSecret, code) {
  try {
    const secret = decryptSecret(encryptedSecret);
    const result = verifySync({ ...TOTP_OPTIONS, token: String(code).trim(), secret });
    // otplib v13 verifySync returns { valid, delta, ... } or throws
    return result?.valid === true;
  } catch {
    return false;
  }
}

// ── Backup Codes ─────────────────────────────────────────────────────────────

/**
 * Generate BACKUP_CODE_COUNT one-time backup codes.
 * Returns { plainCodes, hashedCodes }
 *
 * plainCodes: show to the user ONCE, then discard from memory.
 * hashedCodes: store in users.two_factor_backup_codes_hash (bcrypt, never plain).
 */
async function generateBackupCodes() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O/I/1)
  const plainCodes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let code = '';
    const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
    for (let j = 0; j < BACKUP_CODE_LENGTH; j++) {
      code += chars[bytes[j] % chars.length];
    }
    // Format as XXXXX-XXXXX for readability
    plainCodes.push(code.slice(0, 5) + '-' + code.slice(5));
  }
  const hashedCodes = await Promise.all(
    plainCodes.map(c => bcrypt.hash(c.replace('-', ''), BCRYPT_ROUNDS))
  );
  return { plainCodes, hashedCodes };
}

/**
 * Verify a backup code against the stored hashes.
 * Returns the index of the matched hash (for single-use removal), or -1 if none match.
 * Normalises input: strips hyphens, uppercases.
 */
async function verifyBackupCode(inputCode, hashedCodes) {
  if (!Array.isArray(hashedCodes) || hashedCodes.length === 0) return -1;
  const normalised = String(inputCode).replace(/-/g, '').toUpperCase().trim();
  for (let i = 0; i < hashedCodes.length; i++) {
    const match = await bcrypt.compare(normalised, hashedCodes[i]);
    if (match) return i;
  }
  return -1;
}

// ── Feature flag / env gate ──────────────────────────────────────────────────

/**
 * Returns true only when the hard-coded env gate AND the feature flag are both active.
 * During the dormant phase, process.env.TWO_FACTOR_AUTH_ENABLED is unset → false.
 */
function isTwoFactorEnforcementActive() {
  return process.env.TWO_FACTOR_AUTH_ENABLED === 'true';
}

// ── Future enforcement policy documentation ──────────────────────────────────
/*
  ROLES — PLANNED ENFORCEMENT ORDER (do not activate without separate authorisation):

  Phase 1 — Internal superusers only:
    - super_admin (Ruan, Anton, MJ and designated superusers): REQUIRED
    - Any user with is_super_admin = true: REQUIRED

  Phase 2 — Admin roles:
    - administrator: REQUIRED
    - practice_manager: REQUIRED
    - business_owner: REQUIRED

  Phase 3 — Practitioner roles (company policy decision):
    - accountant: company policy
    - payroll_user / employee: company policy

  EXCLUDED — use PIN flow instead:
    - cashier (POS): uses PIN, not TOTP authenticator
    - cashier_supervisor (POS): uses PIN, not TOTP authenticator

  Enforcement is NOT implemented here yet. The above is the planned policy for
  when isTwoFactorEnforcementActive() returns true and a per-role gate is added.
*/

module.exports = {
  isEncryptionKeyConfigured,
  encryptSecret,
  decryptSecret,
  generateSetupData,
  verifyCode,
  generateBackupCodes,
  verifyBackupCode,
  isTwoFactorEnforcementActive,
};
