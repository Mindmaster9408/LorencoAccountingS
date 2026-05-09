/**
 * TEMPORARY DEBUG ROUTE — remove after diagnosis
 * GET /api/coaching/debug/client/:id
 * Returns exact rows from coaching_clients and clients (ghost) so we can prove
 * where the PUT route is actually writing data.
 */
const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/client/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  // Safe short host from COACHING_DATABASE_URL or DATABASE_URL
  let dbHost = '(unknown)';
  const rawUrl = process.env.COACHING_DATABASE_URL || process.env.DATABASE_URL;
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      const h = u.hostname;
      dbHost = h.length > 16 ? h.slice(0, 8) + '...' + h.slice(-8) : h;
    } catch (_) {
      dbHost = '(URL parse error)';
    }
  }

  // Which tables actually exist?
  let existingTables = [];
  try {
    const r = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('clients', 'coaching_clients')
       ORDER BY table_name`,
      []
    );
    existingTables = r.rows.map(row => row.table_name);
  } catch (e) {
    return res.status(500).json({ error: 'table check failed', detail: e.message });
  }

  // Row from coaching_clients
  let coachingRow = null;
  let coachingError = null;
  if (existingTables.includes('coaching_clients')) {
    try {
      const r = await query(
        `SELECT id, name, status,
                LENGTH(notes) AS notes_len, LEFT(notes, 100) AS notes_preview,
                LENGTH(photo) AS photo_len,
                updated_at
         FROM public.coaching_clients WHERE id = $1`,
        [id]
      );
      coachingRow = r.rows[0] ?? null;
    } catch (e) {
      coachingError = e.message;
    }
  } else {
    coachingError = 'table does not exist';
  }

  // Row from clients (ghost table)
  let clientsRow = null;
  let clientsError = null;
  if (existingTables.includes('clients')) {
    try {
      const r = await query(
        `SELECT id, name, status,
                LENGTH(notes) AS notes_len, LEFT(notes, 100) AS notes_preview,
                LENGTH(photo) AS photo_len,
                updated_at
         FROM public.clients WHERE id = $1`,
        [id]
      );
      clientsRow = r.rows[0] ?? null;
    } catch (e) {
      clientsError = e.message;
    }
  } else {
    clientsError = 'table does not exist';
  }

  // Column existence check on coaching_clients
  let columnCheck = [];
  try {
    const r = await query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'coaching_clients'
         AND column_name IN ('notes', 'photo')
       ORDER BY column_name`,
      []
    );
    columnCheck = r.rows;
  } catch (e) {
    columnCheck = [{ error: e.message }];
  }

  res.json({
    debug_timestamp: new Date().toISOString(),
    db_host_short: dbHost,
    db_env_used: process.env.COACHING_DATABASE_URL ? 'COACHING_DATABASE_URL' : 'DATABASE_URL (fallback)',
    tables_found_in_public: existingTables,
    put_route_updates_table: 'coaching_clients',
    coaching_clients: {
      row: coachingRow,
      error: coachingError,
    },
    clients_ghost: {
      row: clientsRow,
      error: clientsError,
    },
    coaching_clients_columns_notes_photo: columnCheck,
  });
});

module.exports = router;
