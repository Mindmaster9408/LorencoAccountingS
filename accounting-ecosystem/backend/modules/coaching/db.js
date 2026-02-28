/**
 * Coaching Module — Database Connection
 * Uses a direct PostgreSQL pool (raw pg) for the coaching tables.
 * Set COACHING_DATABASE_URL in your .env to the Supabase direct connection string.
 * Get it from: Supabase dashboard → Settings → Database → Connection string (URI)
 */
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.COACHING_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'COACHING_DATABASE_URL is not set. Add it to your .env file.\n' +
        'Get it from: Supabase dashboard → Settings → Database → Connection string (URI)\n' +
        'Use the "Session mode" connection string (port 5432).'
      );
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('[Coaching] Unexpected DB pool error:', err.message);
    });
    console.log('  ✅ Coaching module — DB pool ready');
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  const res = await p.query(text, params);
  return res;
}

module.exports = { query, getPool };
