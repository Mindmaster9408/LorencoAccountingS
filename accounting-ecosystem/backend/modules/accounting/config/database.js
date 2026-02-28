/**
 * Accounting Module — Database Connection
 * Uses Supabase direct PostgreSQL connection (same DB as the rest of the ecosystem).
 * Connection string priority: ACCOUNTING_DATABASE_URL → COACHING_DATABASE_URL → DATABASE_URL
 */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.ACCOUNTING_DATABASE_URL ||
      process.env.COACHING_DATABASE_URL ||
      process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        '[Accounting] No database URL configured. ' +
        'Set ACCOUNTING_DATABASE_URL (or COACHING_DATABASE_URL / DATABASE_URL) in environment. ' +
        'Use the Supabase direct connection string (port 5432).'
      );
    }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('[Accounting] Unexpected error on idle client:', err.message);
    });
  }
  return pool;
}

module.exports = {
  query: (text, params) => getPool().query(text, params),
  getClient: () => getPool().connect(),
  get pool() { return getPool(); },
};
