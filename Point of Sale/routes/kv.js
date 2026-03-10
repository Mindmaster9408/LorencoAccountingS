/**
 * KV Store Route — Point of Sale (standalone)
 * All business data that previously lived in browser localStorage is stored
 * here in PostgreSQL (cloud) so that clearing browser history never loses data.
 *
 * Table: pos_kv_store (company_id, key, value JSONB, updated_at)
 *
 * Routes (all require auth + company context):
 *   GET    /api/kv          → all KV pairs for the company
 *   PUT    /api/kv/:key     → upsert a key
 *   DELETE /api/kv/:key     → remove a key
 */

'use strict';

const express = require('express');
const db      = require('../database');
const { authenticateToken, requireCompany } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

// Ensure table exists (creates on first request if not already present)
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS pos_kv_store (
    company_id  TEXT        NOT NULL,
    key         TEXT        NOT NULL,
    value       JSONB,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, key)
  )`;

db.query(CREATE_TABLE).catch(e =>
  console.error('pos_kv_store create error:', e.message)
);

// GET /api/kv  — return all KV pairs as a flat { key: value } object
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT key, value FROM pos_kv_store WHERE company_id = $1',
      [req.companyId]
    );
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    res.json(result);
  } catch (err) {
    console.error('GET /api/kv error:', err.message);
    res.status(500).json({ error: 'Failed to load KV store' });
  }
});

// PUT /api/kv/:key  — upsert a key
router.put('/:key', async (req, res) => {
  const key   = req.params.key;
  const value = req.body.value !== undefined ? req.body.value : req.body;
  try {
    await db.query(
      `INSERT INTO pos_kv_store (company_id, key, value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (company_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.companyId, key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/kv/:key error:', err.message);
    res.status(500).json({ error: 'Failed to save KV entry' });
  }
});

// DELETE /api/kv/:key  — remove a key
router.delete('/:key', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM pos_kv_store WHERE company_id = $1 AND key = $2',
      [req.companyId, req.params.key]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/kv/:key error:', err.message);
    res.status(500).json({ error: 'Failed to delete KV entry' });
  }
});

module.exports = router;
