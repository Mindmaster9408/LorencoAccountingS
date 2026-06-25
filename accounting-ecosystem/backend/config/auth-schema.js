/**
 * ============================================================================
 * Auth — Auto Schema Migration
 * ============================================================================
 * Runs on server startup to ensure auth-related tables exist.
 * Uses CREATE TABLE IF NOT EXISTS — safe to run on every startup.
 *
 * Call: await ensureAuthSchema(pool)
 * where pool is a pg.Pool connected to Supabase direct PostgreSQL.
 * ============================================================================
 */

async function ensureAuthSchema(pool) {
  const client = await pool.connect();
  try {
    console.log('  🔧 Auth: Checking/creating schema...');

    // ── password_reset_tokens ─────────────────────────────────────────────────
    // Secure single-use tokens for the password reset flow.
    // Replaces the unsafe direct-email-only reset (RISK-02, audit 2026-06-25).
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   VARCHAR(128) NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        used_at      TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        requested_ip VARCHAR(45),
        user_agent   TEXT
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pw_reset_user
        ON password_reset_tokens(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pw_reset_expires
        ON password_reset_tokens(expires_at)
        WHERE used_at IS NULL
    `);

    console.log('  ✅ Auth: Schema ready');
  } catch (err) {
    console.warn('  ⚠️  Auth schema migration error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureAuthSchema };
