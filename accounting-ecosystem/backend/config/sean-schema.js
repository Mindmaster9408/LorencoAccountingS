/**
 * ============================================================================
 * Sean Coaching — Startup Schema Probe
 * ============================================================================
 * Uses the Supabase JS client (no DATABASE_URL required) to verify that the
 * Sean coaching tables and the users.has_coaching_access column are present.
 *
 * This is a DIAGNOSTIC / SAFETY NET only — it does NOT create tables.
 * The DDL lives in:
 *   config/migrations/023_sean_coaching_cases.sql  — coaching tables + audit log
 *   config/migrations/025_sean_coaching_access.sql — users.has_coaching_access
 *
 * These are applied automatically by GitHub Actions on push to main/staging
 * (see .github/workflows/apply-migrations.yml).
 *
 * If SUPABASE_DB_URL is not set in GitHub Secrets, migrations can be applied
 * manually by pasting each SQL file into the Supabase SQL Editor.
 * ============================================================================
 */

'use strict';

async function ensureSeanSchema(supabase) {
    const issues = [];

    // Probe 1: sean_coaching_cases table
    const { error: casesErr } = await supabase
        .from('sean_coaching_cases')
        .select('id')
        .limit(1);

    if (casesErr) {
        const isMissing = casesErr.code === '42P01'
            || (casesErr.message || '').includes('does not exist')
            || (casesErr.message || '').includes('sean_coaching_cases');
        issues.push(
            isMissing
                ? '  ⚠️  sean_coaching_cases missing → run config/migrations/023_sean_coaching_cases.sql'
                : '  ⚠️  sean_coaching_cases probe error: ' + casesErr.message
        );
    }

    // Probe 2: sean_coaching_audit_log table
    const { error: auditErr } = await supabase
        .from('sean_coaching_audit_log')
        .select('id')
        .limit(1);

    if (auditErr) {
        const isMissing = auditErr.code === '42P01'
            || (auditErr.message || '').includes('does not exist')
            || (auditErr.message || '').includes('sean_coaching_audit_log');
        issues.push(
            isMissing
                ? '  ⚠️  sean_coaching_audit_log missing → run config/migrations/023_sean_coaching_cases.sql'
                : '  ⚠️  sean_coaching_audit_log probe error: ' + auditErr.message
        );
    }

    // Probe 3: users.has_coaching_access column.
    // Supabase JS does not provide column-level introspection, so we select
    // the column directly. If it does not exist, PostgREST returns PGRST204
    // or a message referencing the missing column name.
    const { error: colErr } = await supabase
        .from('users')
        .select('has_coaching_access')
        .limit(1);

    if (colErr) {
        const isMissing = (colErr.code === 'PGRST204')
            || (colErr.message || '').includes('has_coaching_access')
            || (colErr.message || '').includes('does not exist');
        issues.push(
            isMissing
                ? '  ⚠️  users.has_coaching_access missing → run config/migrations/025_sean_coaching_access.sql'
                : '  ⚠️  users.has_coaching_access probe error: ' + colErr.message
        );
    }

    if (issues.length === 0) {
        console.log('  ✅ Sean coaching: schema ready');
        return;
    }

    issues.forEach(msg => console.warn(msg));
    console.warn('  ℹ️  Sean coaching client features degraded until missing migrations are applied.');
    console.warn('     Push to main → GitHub Actions applies them (requires SUPABASE_DB_URL secret).');
    console.warn('     Or paste each SQL file into Supabase SQL Editor → Run.');
}

module.exports = { ensureSeanSchema };
