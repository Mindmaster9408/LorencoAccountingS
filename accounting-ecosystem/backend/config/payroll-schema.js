/**
 * ============================================================================
 * Payroll Module — Auto Schema Migration
 * ============================================================================
 * Runs on server startup to ensure all payroll tables exist in Supabase.
 * Uses CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 * so it is safe to run on every startup.
 *
 * Call: await ensurePayrollSchema(pool)
 * where pool is a pg.Pool connected to Supabase direct PostgreSQL.
 * ============================================================================
 */

async function ensurePayrollSchema(pool) {
  const client = await pool.connect();
  try {
    console.log('  🔧 Payroll: Checking/creating schema...');

    // ── payroll_kv_store_eco ──────────────────────────────────────────────────
    // Cloud-backed localStorage bridge. Stores per-company key/value payroll
    // page state (attendance, configs, employee lists) in Supabase so data
    // survives browser clears and works across devices.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_kv_store_eco (
        company_id TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (company_id, key)
      )
    `);

    // ── payroll_kv_store_eco: enable RLS ─────────────────────────────────────
    // Service-role key (used by backend) bypasses RLS automatically.
    await client.query(`
      ALTER TABLE payroll_kv_store_eco ENABLE ROW LEVEL SECURITY
    `);

    console.log('  ✅ Payroll schema ready.');
  } catch (err) {
    console.error('  ❌ Payroll schema migration failed:', err.message);
    // Non-fatal — server continues. Run migration 007 manually if needed.
  } finally {
    client.release();
  }
}

module.exports = { ensurePayrollSchema };
