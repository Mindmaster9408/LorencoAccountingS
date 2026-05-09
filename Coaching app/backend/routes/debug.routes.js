// TEMPORARY DEBUG ROUTE — remove after diagnosis
// GET /api/debug/client/:id
// Returns exact rows from both tables + DB host info so we can prove where writes go.
import express from 'express';
import { query } from '../config/database.js';

const router = express.Router();

router.get('/client/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ error: 'invalid id' });
    }

    // Resolve DB host from DATABASE_URL or DB_HOST
    let dbHost = '(unknown)';
    const rawUrl = process.env.DATABASE_URL || process.env.COACHING_DATABASE_URL;
    if (rawUrl) {
        try {
            const u = new URL(rawUrl);
            const h = u.hostname;
            // Shorten: show first segment + last 8 chars to avoid leaking full host
            dbHost = h.length > 16 ? h.slice(0, 8) + '...' + h.slice(-8) : h;
        } catch (_) {
            dbHost = '(URL parse error)';
        }
    } else if (process.env.DB_HOST) {
        const h = process.env.DB_HOST;
        dbHost = h.length > 16 ? h.slice(0, 8) + '...' + h.slice(-8) : h;
    }

    // Check which tables actually exist
    const tableCheckResult = await query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('clients', 'coaching_clients')
         ORDER BY table_name`,
        []
    ).catch(e => ({ rows: [], error: e.message }));

    const existingTables = (tableCheckResult.rows || []).map(r => r.table_name);

    // Read from coaching_clients
    let coachingRow = null;
    let coachingError = null;
    if (existingTables.includes('coaching_clients')) {
        const r = await query(
            `SELECT id, name, status,
                    LENGTH(notes) AS notes_len, LEFT(notes, 80) AS notes_preview,
                    LENGTH(photo) AS photo_len,
                    updated_at
             FROM public.coaching_clients WHERE id = $1`,
            [id]
        ).catch(e => ({ rows: [], error: e.message }));
        coachingRow = r.rows?.[0] ?? null;
        coachingError = r.error ?? null;
    } else {
        coachingError = 'table does not exist';
    }

    // Read from clients (ghost table)
    let clientsRow = null;
    let clientsError = null;
    if (existingTables.includes('clients')) {
        const r = await query(
            `SELECT id, name, status,
                    LENGTH(notes) AS notes_len, LEFT(notes, 80) AS notes_preview,
                    LENGTH(photo) AS photo_len,
                    updated_at
             FROM public.clients WHERE id = $1`,
            [id]
        ).catch(e => ({ rows: [], error: e.message }));
        clientsRow = r.rows?.[0] ?? null;
        clientsError = r.error ?? null;
    } else {
        clientsError = 'table does not exist';
    }

    // Check column existence on coaching_clients
    let columnCheck = null;
    if (existingTables.includes('coaching_clients')) {
        const r = await query(
            `SELECT column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'coaching_clients'
               AND column_name IN ('notes', 'photo')
             ORDER BY column_name`,
            []
        ).catch(e => ({ rows: [], error: e.message }));
        columnCheck = r.rows ?? [];
    }

    res.json({
        debug_timestamp: new Date().toISOString(),
        db_host_short: dbHost,
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

export default router;
