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

const { supabase, checkConnection } = require('./config/database');

const app  = express();
const PORT = process.env.PORT || 3131;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const ok = await checkConnection(1, 0);
    res.json({ status: ok ? 'ok' : 'degraded', database: ok ? 'connected' : 'unreachable' });
});

// ── GET /api/storage  →  return all stored key/value pairs ───────────────────
app.get('/api/storage', async (req, res) => {
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
app.post('/api/storage-bulk', async (req, res) => {
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
app.get('/api/storage/:key', async (req, res) => {
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
app.put('/api/storage/:key', async (req, res) => {
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
app.delete('/api/storage/:key', async (req, res) => {
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

// ── Static file serving (Payroll_App frontend) ───────────────────────────────
const STATIC_DIR = path.join(__dirname, 'Payroll_App');
app.use(express.static(STATIC_DIR, { extensions: ['html'] }));

// Fallback: serve index.html for unmatched routes (SPA support)
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
