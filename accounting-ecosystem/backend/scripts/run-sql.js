'use strict';

/**
 * ============================================================================
 * run-sql.js — run SQL against the ecosystem Supabase Postgres (all apps)
 * ============================================================================
 * One Supabase project serves every app in accounting-ecosystem (Paytime,
 * Ledger Leo, Checkout Charlie, Stockton, Firmflow, Collector, Sean), so one
 * connection string covers all of them.
 *
 * Needs SUPABASE_DB_URL in backend/.env (local only — never on Zeabur, never
 * committed; .env is gitignored). The URL / password is never printed.
 *
 * Usage (from accounting-ecosystem/backend):
 *   node scripts/run-sql.js check                      connection test, read-only
 *   node scripts/run-sql.js query "SELECT …"           READ ONLY transaction, prints rows
 *   node scripts/run-sql.js file migrations/027_x.sql  runs the file in ONE transaction:
 *                                                      any error → everything rolled back
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('SUPABASE_DB_URL is not set in accounting-ecosystem/backend/.env');
  process.exit(1);
}
if (!/supabase\.(co|com)/.test(url)) {
  console.error('SUPABASE_DB_URL does not point at Supabase — refusing (DATABASE_URL is a different database).');
  process.exit(1);
}

const [mode, arg] = process.argv.slice(2);

async function main() {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  client.on('notice', n => console.log('NOTICE:', n.message));
  await client.connect();
  try {
    if (mode === 'check') {
      await client.query('BEGIN READ ONLY');
      const r = await client.query("SELECT current_database() AS db, current_user AS usr, split_part(version(), ' ', 2) AS pg, (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS public_tables");
      await client.query('ROLLBACK');
      console.log('Connected OK:', r.rows[0]);
    } else if (mode === 'query' && arg) {
      await client.query('BEGIN READ ONLY');
      const r = await client.query(arg);
      await client.query('ROLLBACK');
      console.table(r.rows);
      console.log(r.rowCount + ' row(s)');
    } else if (mode === 'file' && arg) {
      const file = path.resolve(process.cwd(), arg);
      const sql = fs.readFileSync(file, 'utf8');
      console.log('Running', path.basename(file), '(' + sql.length + ' chars) in one transaction…');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log('COMMITTED:', path.basename(file));
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('FAILED — rolled back, nothing changed:', err.message);
        process.exitCode = 1;
      }
    } else {
      console.error('Usage: node scripts/run-sql.js check | query "<SELECT…>" | file <path.sql>');
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
