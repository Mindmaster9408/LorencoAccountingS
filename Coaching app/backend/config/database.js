// Database configuration - Supabase PostgreSQL Connection
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Support both Supabase DATABASE_URL and individual env vars
const connectionConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'postgres',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        ssl: { rejectUnauthorized: false },
    };

// --- SAFE DIAGNOSTIC LOGGING (remove after diagnosis) ---
(function logDbConfig() {
    const envUsed = process.env.DATABASE_URL ? 'DATABASE_URL'
        : process.env.COACHING_DATABASE_URL ? 'COACHING_DATABASE_URL'
        : 'individual DB_* vars';
    let host = process.env.DB_HOST || '(not set)';
    let port = process.env.DB_PORT || 5432;
    let database = process.env.DB_NAME || 'postgres';
    let user = process.env.DB_USER || 'postgres';
    let sslNote = 'enabled (rejectUnauthorized: false)';

    const rawUrl = process.env.DATABASE_URL || process.env.COACHING_DATABASE_URL;
    if (rawUrl) {
        try {
            const u = new URL(rawUrl);
            host = u.hostname;
            port = u.port || 5432;
            database = u.pathname.replace(/^\//, '') || 'postgres';
            user = u.username;
        } catch (e) {
            host = '(URL parse failed: ' + e.message + ')';
        }
    }

    console.log('[DB CONFIG] using env:', envUsed);
    console.log('[DB CONFIG] host:', host);
    console.log('[DB CONFIG] port:', port);
    console.log('[DB CONFIG] database:', database);
    console.log('[DB CONFIG] user:', user);
    console.log('[DB CONFIG] ssl:', sslNote);
})();
// --- END SAFE DIAGNOSTIC LOGGING ---

// Create PostgreSQL connection pool
const pool = new Pool({
    ...connectionConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Test database connection
pool.on('connect', () => {
    console.log('✓ Database connected successfully');
});

pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
    process.exit(-1);
});

// Helper function to execute queries
export const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;

        if (process.env.NODE_ENV === 'development') {
            console.log('Executed query', { text, duration, rows: res.rowCount });
        }

        return res;
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
};

// Helper function to get a client from the pool for transactions
export const getClient = () => {
    return pool.connect();
};

// Test database connection
export const testConnection = async () => {
    try {
        const result = await query('SELECT NOW()');
        console.log('Database connection test successful:', result.rows[0].now);
        return true;
    } catch (error) {
        console.error('Database connection test failed:', error);
        return false;
    }
};

// Ensure photo and notes columns exist on clients table.
// Idempotent — ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.
// Runs on every server startup as a safety net.
export const ensureClientPhotoNotesColumns = async () => {
    try {
        await pool.query(`
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS photo TEXT;
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes TEXT;
        `);
        console.log('[DB INIT] clients.photo and clients.notes columns confirmed');
    } catch (err) {
        console.error('[DB INIT] Could not ensure photo/notes columns on clients:', err.message);
    }
};

export default pool;
