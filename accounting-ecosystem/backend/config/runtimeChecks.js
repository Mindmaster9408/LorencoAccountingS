/**
 * ============================================================================
 * Runtime configuration checks
 * ============================================================================
 * Answers "is this server actually configured?" without ever exposing a
 * secret: only yes/no, and for the database only which PROVIDER the URL
 * points at (supabase / zeabur / other), never the URL itself.
 *
 * Why (2026-11-11): Zeabur was retired today and the app moved to Render.
 * The accounting module's direct Postgres pool (ACCOUNTING_DATABASE_URL →
 * COACHING_DATABASE_URL → DATABASE_URL) is used for every invoice create,
 * the monthly billing plans and more — but /api/health only tested the
 * Supabase JS client, so a pool pointing at a dead host looked "healthy".
 *
 * Used by:
 *   - server.js startup → logStartupConfigReport() (shows in Render logs)
 *   - GET /api/health   → getConfigChecks() (adds a `checks` block)
 *   - Leo Monthly Plans → isEmailConfigured() (warning banner)
 * ============================================================================
 */

'use strict';

const { isEmailConfigured } = require('../shared/services/email');

const CACHE_MS = 60 * 1000;
let _dbCache = null; // { at, result }

function dbUrlSource() {
  if (process.env.ACCOUNTING_DATABASE_URL) return 'ACCOUNTING_DATABASE_URL';
  if (process.env.COACHING_DATABASE_URL) return 'COACHING_DATABASE_URL';
  if (process.env.DATABASE_URL) return 'DATABASE_URL';
  return null;
}

function dbProvider() {
  const src = dbUrlSource();
  if (!src) return 'none';
  let host = '';
  try { host = new URL(process.env[src]).hostname || ''; } catch (_) { return 'unparseable'; }
  if (/supabase\.(co|com)$/i.test(host)) return 'supabase';
  if (/zeabur/i.test(host)) return 'zeabur';
  if (/^(localhost|127\.0\.0\.1)$/i.test(host)) return 'local';
  return 'other';
}

/** Runs SELECT 1 on the accounting pool (cached 60s). Never throws. */
async function checkAccountingDb({ fresh = false } = {}) {
  if (!fresh && _dbCache && Date.now() - _dbCache.at < CACHE_MS) return _dbCache.result;
  const result = { ok: false, source: dbUrlSource(), provider: dbProvider(), error: null };
  if (!result.source) {
    result.error = 'no database URL set';
  } else {
    try {
      const db = require('../modules/accounting/config/database');
      await Promise.race([
        db.query('SELECT 1'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 6s')), 6000)),
      ]);
      result.ok = true;
    } catch (err) {
      // Message only (e.g. "connection timeout") — never the connection string.
      result.error = String(err.message || err).replace(/postgres(ql)?:\/\/\S+/gi, '[url]').slice(0, 160);
    }
  }
  _dbCache = { at: Date.now(), result };
  return result;
}

function recurringSchedulerState() {
  try {
    return require('../modules/accounting/services/recurringInvoiceService').isSchedulerRunning() ? 'running' : 'off';
  } catch (_) {
    return 'unavailable';
  }
}

/** Compact, secret-free status block for /api/health. */
async function getConfigChecks() {
  const db = await checkAccountingDb();
  return {
    accountingDb: db.ok ? 'ok' : 'failed',
    accountingDbProvider: db.provider,
    ...(db.ok ? {} : { accountingDbError: db.error }),
    email: isEmailConfigured() ? 'configured' : 'not_configured',
    recurringInvoiceScheduler: recurringSchedulerState(),
  };
}

/** Logs a clear ✅ / ⚠️ list at startup so a missing variable is visible in the Render logs. */
async function logStartupConfigReport() {
  const db = await checkAccountingDb({ fresh: true });
  const lines = [];
  lines.push(db.ok
    ? `  ✅ Accounting DB (${db.source} → ${db.provider}) reachable`
    : `  ❌ Accounting DB NOT reachable (${db.source || 'no URL'} → ${db.provider}): ${db.error}. Leo invoices, quotes and monthly plans will fail. Set ACCOUNTING_DATABASE_URL to the Supabase direct connection string.`);
  if (db.provider === 'zeabur') lines.push('  ⚠️  Accounting DB URL still points at Zeabur, which was retired on 2026-11-11.');
  lines.push(isEmailConfigured()
    ? '  ✅ Email (Resend) configured'
    : '  ⚠️  Email NOT configured (RESEND_API_KEY + EMAIL_FROM). Invoice/payslip emails and monthly-plan auto-emails will not be sent.');
  console.log('🔎 Configuration check:\n' + lines.join('\n'));
}

module.exports = { checkAccountingDb, getConfigChecks, logStartupConfigReport, isEmailConfigured };
