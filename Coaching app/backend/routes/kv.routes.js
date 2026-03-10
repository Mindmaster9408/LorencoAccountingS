/**
 * KV Store Route — Coaching App
 * All business data that previously lived in browser localStorage is stored
 * here in PostgreSQL (Supabase) so that clearing browser history never loses
 * client records, assessment data, or coach store data.
 *
 * Table: coaching_app_kv_store (user_id, key, value JSONB, updated_at)
 *
 * Routes (all require authentication):
 *   GET    /api/kv          → all KV pairs for the authenticated user
 *   PUT    /api/kv/:key     → upsert a key for the authenticated user
 *   DELETE /api/kv/:key     → remove a key for the authenticated user
 */

import express from 'express';
import { query } from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All routes require a valid JWT
router.use(authenticateToken);

// Ensure table exists on first boot (idempotent)
query(`
  CREATE TABLE IF NOT EXISTS coaching_app_kv_store (
    user_id    TEXT        NOT NULL,
    key        TEXT        NOT NULL,
    value      JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
  )
`).catch(e => console.error('coaching_app_kv_store create error:', e.message));

// GET /api/kv — return all KV pairs as a flat { key: value } object
router.get('/', async (req, res) => {
    try {
        const { rows } = await query(
            'SELECT key, value FROM coaching_app_kv_store WHERE user_id = $1',
            [String(req.user.id)]
        );
        const result = {};
        rows.forEach(r => { result[r.key] = r.value; });
        res.json(result);
    } catch (err) {
        console.error('GET /api/kv error:', err.message);
        res.status(500).json({ error: 'Failed to load KV store' });
    }
});

// PUT /api/kv/:key — upsert a key
router.put('/:key', async (req, res) => {
    const key   = req.params.key;
    const value = req.body.value !== undefined ? req.body.value : req.body;
    try {
        await query(
            `INSERT INTO coaching_app_kv_store (user_id, key, value, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (user_id, key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [String(req.user.id), key, JSON.stringify(value)]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/kv/:key error:', err.message);
        res.status(500).json({ error: 'Failed to save KV entry' });
    }
});

// DELETE /api/kv/:key — remove a key
router.delete('/:key', async (req, res) => {
    try {
        await query(
            'DELETE FROM coaching_app_kv_store WHERE user_id = $1 AND key = $2',
            [String(req.user.id), req.params.key]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/kv/:key error:', err.message);
        res.status(500).json({ error: 'Failed to delete KV entry' });
    }
});

export default router;
