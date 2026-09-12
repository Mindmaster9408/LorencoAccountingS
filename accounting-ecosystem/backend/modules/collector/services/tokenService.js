/**
 * ============================================================================
 * Collector — Upload Token Service
 * ============================================================================
 * Same cryptographic primitive as the password-reset flow
 * (shared/routes/auth.js: crypto.randomBytes(32) raw, SHA-256 hash stored,
 * raw token only ever exists in memory + the outbound email) — but with one
 * deliberate divergence: this token stays VALID and REUSABLE across many
 * client visits/uploads over the whole open period (up to 45 days), not
 * single-use like a password reset.
 *
 * A raw token can never be retrieved once issued (only its hash is stored),
 * so — exactly like the password-reset flow already does on every new
 * request ("invalidate any existing unused token before issuing a new
 * one") — every call to issueToken() rotates the hash and returns a fresh
 * raw value. This means: the client's already-bookmarked link keeps working
 * indefinitely as long as nobody explicitly resends (validateToken() below
 * doesn't care how many times it's called); a staff-triggered resend
 * naturally supersedes the old link with a new one in the same step,
 * matching this codebase's own established token-rotation convention.
 *
 * `collector_upload_tokens.period_id` has a DB-level UNIQUE constraint, so
 * issueToken()'s upsert-by-period_id is race-safe by construction — two
 * concurrent "send" calls for the same period can never both insert a row.
 *
 * Validity = expires_at > NOW() AND revoked_at IS NULL AND period.status =
 * 'open'. Closing a period is the real kill-switch — independent of expiry.
 * ============================================================================
 */

const crypto = require('crypto');
const { supabase } = require('../../../config/database');

const TOKEN_VALIDITY_DAYS = 45; // covers a ~30-day open period plus reminder slack

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mints a fresh raw token for the period, replacing any existing one
 * (upsert on period_id). Called every time an email is about to go out —
 * both the very first request and every subsequent reminder/resend.
 * Returns the RAW token — only ever held in memory for the duration of
 * building the outbound email, never persisted.
 */
async function issueToken(period, userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('collector_upload_tokens')
    .upsert({
      company_id: period.company_id,
      client_id: period.client_id,
      period_id: period.id,
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
      created_by_user_id: userId || null,
    }, { onConflict: 'period_id' })
    .select('id, expires_at')
    .single();

  if (error) throw new Error(error.message);

  return { tokenRow: data, rawToken };
}

/**
 * Validate a raw token from an incoming public request. Returns the full
 * context (client + period) needed to serve the request, or null for ANY
 * failure reason (bad hash, expired, revoked, period closed, client
 * inactive) — callers must return one generic 404 regardless of which
 * reason it was, to prevent enumeration (same principle as password reset).
 */
async function validateToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) return null;

  const tokenHash = hashToken(rawToken);

  const { data: tokenRow, error } = await supabase
    .from('collector_upload_tokens')
    .select('id, company_id, client_id, period_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !tokenRow) return null;
  if (tokenRow.revoked_at) return null;
  if (new Date(tokenRow.expires_at) <= new Date()) return null;

  const { data: period } = await supabase
    .from('collector_periods')
    .select('id, company_id, client_id, period_label, period_start, period_end, status')
    .eq('id', tokenRow.period_id)
    .maybeSingle();

  if (!period || period.status !== 'open') return null;

  const { data: client } = await supabase
    .from('collector_clients')
    .select('id, company_id, display_name, jurisdiction, status')
    .eq('id', tokenRow.client_id)
    .maybeSingle();

  if (!client || client.status !== 'active') return null;

  // Telemetry only — never gates validity. Fire-and-forget.
  supabase
    .from('collector_upload_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenRow.id)
    .then(() => {})
    .catch(() => {});

  return { tokenRow, period, client };
}

async function revokeTokenForPeriod(periodId) {
  await supabase
    .from('collector_upload_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('period_id', periodId);
}

module.exports = {
  issueToken,
  validateToken,
  revokeTokenForPeriod,
};
