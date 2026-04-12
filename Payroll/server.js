/**
 * Lorenco Paytime — Payroll Cloud Server
 *
 * Serves the Payroll_App frontend AND provides a storage API backed
 * by Supabase (cloud PostgreSQL), just like the accounting ecosystem.
 *
 * NO local file storage — all data lives in Supabase.
 *
 * Usage:
 *   npm install
 *   cp .env.example .env   # fill in Supabase creds
 *   npm start
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');

const { supabase, checkConnection } = require('./config/database');
const { registerPayrollEmployeeSyncRoutes } = require('./routes/payroll-employee-sync');

// ── Build Version ────────────────────────────────────────────────────────────
// Each server restart = new timestamp = new SW bytes = browsers detect update.
// Override with BUILD_VERSION env var for deterministic versioning.
const BUILD_VERSION = process.env.BUILD_VERSION || Date.now().toString(36);

const app  = express();
const PORT = process.env.PORT || 3131;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Security: API authentication ─────────────────────────────────────────────
//
// PAYROLL_API_SECRET in .env gates all /api/storage routes.
// If the env var is not set, storage routes remain OPEN (backward compat for
// local dev — emit a loud warning instead of silently accepting all traffic).
//
// Clients must send one of:
//   Authorization: Bearer <PAYROLL_API_SECRET>
//   X-Payroll-Secret: <PAYROLL_API_SECRET>
//
const PAYROLL_API_SECRET = process.env.PAYROLL_API_SECRET || null;
if (!PAYROLL_API_SECRET) {
    console.warn('');
    console.warn('  ⚠️  WARNING: PAYROLL_API_SECRET is not set.');
    console.warn('  Storage endpoints are UNPROTECTED. Set PAYROLL_API_SECRET in .env to enable auth.');
    console.warn('');
}

function requireStorageAuth(req, res, next) {
    if (!PAYROLL_API_SECRET) {
        // Not configured — allow access but log it (dev mode only)
        return next();
    }
    const authHeader = req.headers['authorization'] || '';
    const headerSecret = req.headers['x-payroll-secret'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const provided = bearerToken || headerSecret;

    if (!provided) {
        return res.status(401).json({ error: 'Authentication required', hint: 'Send Authorization: Bearer <token>' });
    }
    if (provided !== PAYROLL_API_SECRET) {
        return res.status(403).json({ error: 'Invalid credentials' });
    }
    next();
}

// ── Admin user list for server-side auth (loaded from env, never in client JS) ──
// Set ADMIN_USERS as JSON in .env:  [{"email":"a@b.com","password":"secret","role":"super_admin","name":"Admin"}]
// Falls back to a single ADMIN_EMAIL / ADMIN_PASSWORD pair for simpler configs.
function getAdminUsers() {
    try {
        const raw = process.env.ADMIN_USERS;
        if (raw) return JSON.parse(raw);
    } catch (e) {
        console.error('ADMIN_USERS env var is not valid JSON:', e.message);
    }
    // Simple single-admin fallback
    const email    = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    const role     = process.env.ADMIN_ROLE || 'super_admin';
    const name     = process.env.ADMIN_NAME || 'Admin';
    if (email && password) return [{ email, password, role, name }];
    return [];
}

// ── POST /api/auth/verify  →  verify admin credentials (server-side only) ──────
// Used by the Paytime frontend to authenticate WITHOUT exposing passwords in JS.
// Returns a minimal session token (the API secret) on success.
app.post('/api/auth/verify', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    const admins = getAdminUsers();
    const match = admins.find(a => a.email && a.email.toLowerCase() === email.toLowerCase() && a.password === password);
    if (!match) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    // Return session info (never return the password back)
    res.json({
        success: true,
        user: { email: match.email, name: match.name || '', role: match.role || 'super_admin' },
        // Provide the API secret as a bearer token so the client can authenticate storage requests
        token: PAYROLL_API_SECRET || 'dev-mode'
    });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const ok = await checkConnection(1, 0);
    res.json({ status: ok ? 'ok' : 'degraded', database: ok ? 'connected' : 'unreachable' });
});

// ── Version check for app updates ──────────────────────────────────────────
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({ version: BUILD_VERSION, timestamp: new Date().toISOString() });
});

// ── GET /api/storage  →  return all stored key/value pairs ───────────────────
app.get('/api/storage', requireStorageAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('payroll_kv_store')
            .select('key, value');

        if (error) throw error;

        const result = {};
        for (const row of data) {
            result[row.key] = row.value;
        }
        res.json(result);
    } catch (err) {
        console.error('GET /api/storage error:', err.message);
        res.status(500).json({ error: 'Database read failed' });
    }
});

// ── POST /api/storage-bulk  →  write many keys at once ───────────────────────
app.post('/api/storage-bulk', requireStorageAuth, async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body !== 'object') {
            return res.status(400).json({ error: 'Body must be a JSON object' });
        }

        const rows = Object.entries(body).map(([key, value]) => ({
            key,
            value: typeof value === 'string' ? JSON.parse(value) : value
        }));

        if (rows.length === 0) {
            return res.json({ ok: true, count: 0 });
        }

        const { error } = await supabase
            .from('payroll_kv_store')
            .upsert(rows, { onConflict: 'key' });

        if (error) throw error;
        res.json({ ok: true, count: rows.length });
    } catch (err) {
        console.error('POST /api/storage-bulk error:', err.message);
        res.status(500).json({ error: 'Database bulk write failed' });
    }
});

// ── GET /api/storage/:key  →  get a single key ──────────────────────────────
app.get('/api/storage/:key', requireStorageAuth, async (req, res) => {
    try {
        const key = req.params.key;
        const { data, error } = await supabase
            .from('payroll_kv_store')
            .select('value')
            .eq('key', key)
            .maybeSingle();

        if (error) throw error;
        res.json({ value: data ? data.value : null });
    } catch (err) {
        console.error('GET /api/storage/:key error:', err.message);
        res.status(500).json({ error: 'Database read failed' });
    }
});

// ── PUT /api/storage/:key  →  create or update a single key ─────────────────
app.put('/api/storage/:key', requireStorageAuth, async (req, res) => {
    try {
        const key = req.params.key;
        let val = req.body.value;

        // Parse string values to store as proper JSONB
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) { /* keep as string */ }
        }

        const { error } = await supabase
            .from('payroll_kv_store')
            .upsert({ key, value: val }, { onConflict: 'key' });

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/storage/:key error:', err.message);
        res.status(500).json({ error: 'Database write failed' });
    }
});

// ── DELETE /api/storage/:key  →  remove a key ────────────────────────────────
app.delete('/api/storage/:key', requireStorageAuth, async (req, res) => {
    try {
        const key = req.params.key;
        const { error } = await supabase
            .from('payroll_kv_store')
            .delete()
            .eq('key', key);

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/storage/:key error:', err.message);
        res.status(500).json({ error: 'Database delete failed' });
    }
});

// ── Service Worker Dynamic Version Injection ──────────────────────────────
// Serve service-worker.js with __BUILD_VERSION__ replaced at request time.
// This guarantees the SW bytes change on every server restart → browser
// detects new SW → installs + activates → deletes old caches automatically.
app.get('/service-worker.js', (req, res) => {
    const swPath = path.join(__dirname, 'Payroll_App', 'service-worker.js');
    try {
        const content = fs.readFileSync(swPath, 'utf8').replace(/__BUILD_VERSION__/g, BUILD_VERSION);
        res.type('application/javascript');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(content);
    } catch (err) {
        console.error('Service worker not found:', err.message);
        res.status(404).json({ error: 'Service worker not found' });
    }
});

// ── Payroll Employee Sync Routes ──────────────────────────────────────────────
// Register sync detection and execution endpoints
registerPayrollEmployeeSyncRoutes(app, supabase);

// ── HTML Cache Control ────────────────────────────────────────────────────────
// Ensure HTML is never cached by browser — always check for new version.
app.get('*.html', (req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});

// ── Static file serving (Payroll_App frontend) ───────────────────────────────
const STATIC_DIR = path.join(__dirname, 'Payroll_App');
app.use(express.static(STATIC_DIR, { extensions: ['html'] }));

// ── Fallback: serve index.html for unmatched routes (SPA support) ─────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ── Start server ─────────────────────────────────────────────────────────────
async function start() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════════════╗');
    console.log('  ║  ⚠️  LEGACY STANDALONE SERVER — DEPRECATED                       ║');
    console.log('  ║                                                                  ║');
    console.log('  ║  This standalone Payroll server (port 3131) is the LEGACY app.  ║');
    console.log('  ║  The AUTHORITATIVE system is:                                   ║');
    console.log('  ║    accounting-ecosystem/backend/ (port 3000)                    ║');
    console.log('  ║    → module: payroll  (MODULE_PAYROLL_ENABLED=true)             ║');
    console.log('  ║    → API:    /api/payroll/*                                     ║');
    console.log('  ║    → DB:     Supabase payroll_periods, payroll_transactions      ║');
    console.log('  ║                                                                  ║');
    console.log('  ║  This server uses a schemaless KV store (payroll_kv_store)      ║');
    console.log('  ║  which is NOT compatible with the ecosystem payroll module.     ║');
    console.log('  ║                                                                  ║');
    console.log('  ║  DO NOT run both servers against the same Supabase instance.    ║');
    console.log('  ║  Migrate to the ecosystem server before decommissioning this.   ║');
    console.log('  ╚══════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('  ⏳ Connecting to Supabase...');

    const connected = await checkConnection();
    if (!connected) {
        console.error('  ❌ Could not connect to Supabase. Check your .env credentials.');
        process.exit(1);
    }

    console.log('  ✅ Supabase connected');

    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('  ╔══════════════════════════════════════════════════╗');
        console.log('  ║    Lorenco Paytime — Cloud Payroll Server        ║');
        console.log('  ╠══════════════════════════════════════════════════╣');
        console.log('  ║                                                  ║');
        console.log('  ║  Storage:  Supabase (cloud PostgreSQL)           ║');
        console.log('  ║  Server:   http://localhost:' + PORT + '                 ║');
        console.log('  ║                                                  ║');
        console.log('  ║  All data is stored in the cloud.                ║');
        console.log('  ║  No local files — deploy on Zeabur or anywhere.  ║');
        console.log('  ║                                                  ║');
        console.log('  ║  Press Ctrl+C to stop the server.                ║');
        console.log('  ╚══════════════════════════════════════════════════╝');
        console.log('');
    });
}

start().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
