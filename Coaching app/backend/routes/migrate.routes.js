// One-time migration endpoint — renames old tables to coaching_ prefix
// Protected by MIGRATION_SECRET env var. Remove this file after migration runs.
import express from 'express';
import { query } from '../config/database.js';

const router = express.Router();

// POST /api/migrate/rename-tables?secret=YOUR_SECRET
router.post('/rename-tables', async (req, res) => {
    const secret = req.query.secret || req.body.secret;
    const expectedSecret = process.env.MIGRATION_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const results = [];
    const errors = [];

    // Rename each table from old name to coaching_ prefix, only if old name exists
    const renames = [
        ['clients', 'coaching_clients'],
        ['users', 'coaching_users'],
        ['client_sessions', 'coaching_client_sessions'],
        ['client_steps', 'coaching_client_steps'],
        ['client_gauges', 'coaching_client_gauges'],
        ['leads', 'coaching_leads'],
        ['spil_profiles', 'coaching_spil_profiles'],
        ['coach_program_access', 'coaching_coach_program_access'],
        ['program_modules', 'coaching_program_modules'],
        ['ai_conversations', 'coaching_ai_conversations'],
        ['ai_learning_data', 'coaching_ai_learning_data'],
        ['basis_submissions', 'coaching_basis_submissions'],
    ];

    for (const [oldName, newName] of renames) {
        try {
            // Check if old table exists
            const existsOld = await query(
                "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
                [oldName]
            );
            // Check if new table already exists
            const existsNew = await query(
                "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
                [newName]
            );

            if (existsOld.rows.length > 0 && existsNew.rows.length === 0) {
                await query(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
                results.push(`✓ Renamed ${oldName} → ${newName}`);
            } else if (existsNew.rows.length > 0) {
                results.push(`⏭ ${newName} already exists — skipped`);
            } else {
                results.push(`⚠ ${oldName} not found — skipped`);
            }
        } catch (err) {
            errors.push(`✗ ${oldName}: ${err.message}`);
        }
    }

    // Add photo/notes to coaching_clients if missing
    const colRenames = [
        `ALTER TABLE coaching_clients ADD COLUMN IF NOT EXISTS photo TEXT`,
        `ALTER TABLE coaching_clients ADD COLUMN IF NOT EXISTS notes TEXT`,
        `ALTER TABLE coaching_users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`,
    ];
    for (const sql of colRenames) {
        try {
            await query(sql);
            results.push(`✓ Column: ${sql.split('ADD COLUMN IF NOT EXISTS')[1]?.trim() || sql}`);
        } catch (err) {
            errors.push(`✗ Column error: ${err.message}`);
        }
    }

    res.json({
        success: errors.length === 0,
        results,
        errors,
        message: errors.length === 0
            ? 'Migration complete. Remove routes/migrate.routes.js and its mount in server.js.'
            : 'Migration completed with some errors — review above.'
    });
});

// GET /api/migrate/status?secret=YOUR_SECRET — check which tables exist
router.get('/status', async (req, res) => {
    const secret = req.query.secret;
    const expectedSecret = process.env.MIGRATION_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const tableNames = [
        'clients', 'coaching_clients',
        'users', 'coaching_users',
        'client_sessions', 'coaching_client_sessions',
        'leads', 'coaching_leads',
    ];

    const found = [];
    for (const t of tableNames) {
        const r = await query(
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
            [t]
        );
        if (r.rows.length > 0) found.push(t);
    }

    res.json({ tables_found: found });
});

export default router;
