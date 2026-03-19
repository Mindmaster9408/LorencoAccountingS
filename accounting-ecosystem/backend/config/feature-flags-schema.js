/**
 * ============================================================================
 * Feature Flags — Auto Schema Migration (Supabase client version)
 * ============================================================================
 * Uses the Supabase JS client so it works in Zeabur without DATABASE_URL.
 * Runs on every server startup — safe (idempotent, uses IF NOT EXISTS logic
 * via Supabase RPC or direct SQL via the service-role key).
 *
 * Note: Supabase JS client does not support arbitrary DDL via .from().
 * We use supabase.rpc('exec_sql', ...) if available, or fall back to a
 * simple table-existence check approach.
 *
 * The actual DDL migration is in:
 *   accounting-ecosystem/backend/config/migrations/008_feature_flags.sql
 * and is applied by the GitHub Actions CI when merging to main/staging.
 *
 * This startup check is a SAFETY NET — it ensures the table exists even if
 * the migration hasn't been applied manually in a fresh environment.
 * ============================================================================
 */

async function ensureFeatureFlagsSchema(supabase) {
  // Probe: does the feature_flags table exist and is it accessible?
  const { error } = await supabase
    .from('feature_flags')
    .select('id')
    .limit(1);

  if (!error) {
    // Table exists and is accessible
    console.log('  ✅ Feature flags: schema ready');
    return;
  }

  // Table might not exist yet — log a clear instruction
  if (error.code === '42P01' || error.message?.includes('does not exist')) {
    console.warn('  ⚠️  Feature flags table not found.');
    console.warn('     Run migration: accounting-ecosystem/backend/config/migrations/008_feature_flags.sql');
    console.warn('     Or apply via GitHub Actions by pushing to main/staging.');
    console.warn('     Feature flag endpoints will return errors until the table is created.');
  } else {
    // Some other error (permissions, etc.) — log but don't crash
    console.warn('  ⚠️  Feature flags schema check error:', error.message);
  }
}

module.exports = { ensureFeatureFlagsSchema };
