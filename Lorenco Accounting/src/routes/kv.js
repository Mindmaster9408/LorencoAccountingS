/**
 * ============================================================================
 * KV Store Routes — Lorenco Accounting (standalone PostgreSQL)
 * ============================================================================
 * Generic key-value storage scoped per company.
 * Used by the accounting frontend localStorage bridge so all accounting
 * page data (journals, customers, bank allocations, etc.) is stored in
 * PostgreSQL — survives browser history clears and works across all browsers.
 *
 * The table is auto-created on first request if it does not yet exist.
 * ============================================================================
 */

const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── Ensure the table exists (idempotent, runs on first request) ───────────────
let tableReady = false;
async function ensureTable() {
    if (tableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS lorenco_kv_store (
            company_id  TEXT        NOT NULL,
            key         TEXT        NOT NULL,
            value       JSONB,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (company_id, key)
        )
    `);
    tableReady = true;
}

// All KV endpoints require authentication
router.use(authenticate);

// ── GET /api/kv  →  all key/value pairs for the authenticated company ─────────
router.get('/', async (req, res) => {
    try {
        await ensureTable();
        const result = await db.query(
            'SELECT key, value FROM lorenco_kv_store WHERE company_id = $1',
            [req.user.companyId]
        );
        const out = {};
        for (const row of result.rows) {
            out[row.key] = row.value;
        }
        res.json(out);
    } catch (err) {
        console.error('GET /api/kv error:', err.message);
        res.status(500).json({ error: 'Database read failed' });
    }
});

// ── PUT /api/kv/:key  →  upsert a key ────────────────────────────────────────
router.put('/:key', async (req, res) => {
    try {
        await ensureTable();
        const key = req.params.key;
        let val = req.body.value;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) {}
        }

        await db.query(
            `INSERT INTO lorenco_kv_store (company_id, key, value, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (company_id, key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = now()`,
            [req.user.companyId, key, JSON.stringify(val)]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database write failed' });
    }
});

// ── DELETE /api/kv/:key  →  remove a key ──────────────────────────────────────
router.delete('/:key', async (req, res) => {
    try {
        await ensureTable();
        await db.query(
            'DELETE FROM lorenco_kv_store WHERE company_id = $1 AND key = $2',
            [req.user.companyId, req.params.key]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database delete failed' });
    }
});

module.exports = router;
