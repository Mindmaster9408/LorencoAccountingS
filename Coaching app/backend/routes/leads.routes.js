// Leads management routes
// Public assessment submissions arrive unauthenticated (POST).
// Coaches read/manage their own leads (requires auth).
import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateToken, requireCoach } from '../middleware/auth.js';

const router = express.Router();

// ── Ensure table exists on startup ───────────────────────────────────────────
let tableReady = false;
async function ensureLeadsTable() {
    if (tableReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS leads (
            id              SERIAL PRIMARY KEY,
            name            TEXT NOT NULL,
            email           TEXT,
            phone           TEXT,
            company         TEXT,
            preferred_lang  TEXT,
            message         TEXT,
            basis_answers   JSONB,
            basis_results   JSONB,
            coaching_goals  TEXT,
            wants_coaching  BOOLEAN DEFAULT FALSE,
            source          TEXT DEFAULT 'public_assessment',
            status          TEXT NOT NULL DEFAULT 'new',
            coach_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    // Add columns that may be missing in existing tables
    const newCols = [
        'ADD COLUMN IF NOT EXISTS company         TEXT',
        'ADD COLUMN IF NOT EXISTS preferred_lang  TEXT',
        'ADD COLUMN IF NOT EXISTS basis_answers   JSONB',
        'ADD COLUMN IF NOT EXISTS basis_results   JSONB',
        'ADD COLUMN IF NOT EXISTS coaching_goals  TEXT',
        'ADD COLUMN IF NOT EXISTS wants_coaching  BOOLEAN DEFAULT FALSE',
    ];
    for (const col of newCols) {
        await query(`ALTER TABLE leads ${col}`).catch(() => {});
    }
    tableReady = true;
}
ensureLeadsTable().catch(err => console.error('leads table init:', err.message));

// ── POST /api/leads  →  submit a new lead (no auth required — public form) ───
router.post('/',
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().trim(),
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        try {
            await ensureLeadsTable();
            const { name, email, phone, company, preferred_lang, basisAnswers, basisResults,
                    coachingGoals, wantsCoaching, source } = req.body;
            const result = await query(
                `INSERT INTO leads
                    (name, email, phone, company, preferred_lang, basis_answers, basis_results,
                     coaching_goals, wants_coaching, source, status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 RETURNING id, name, email, created_at`,
                [
                    name,
                    email || null,
                    phone || null,
                    company || null,
                    preferred_lang || null,
                    basisAnswers ? JSON.stringify(basisAnswers) : null,
                    basisResults ? JSON.stringify(basisResults) : null,
                    coachingGoals || null,
                    !!wantsCoaching,
                    source || 'public_assessment',
                    wantsCoaching ? 'interested' : 'new'
                ]
            );
            res.status(201).json({ ok: true, lead: result.rows[0] });
        } catch (err) {
            console.error('POST /api/leads error:', err.message);
            res.status(500).json({ error: 'Failed to save lead' });
        }
    }
);

// All routes below require authentication
router.use(authenticateToken);
router.use(requireCoach);

// ── GET /api/leads  →  get all leads (coaches only) ──────────────────────────
router.get('/', async (req, res) => {
    try {
        await ensureLeadsTable();
        const { status } = req.query;
        let queryText = 'SELECT * FROM leads';
        const params = [];
        if (status) {
            queryText += ' WHERE status = $1';
            params.push(status);
        }
        queryText += ' ORDER BY created_at DESC';
        const result = await query(queryText, params);
        res.json({ leads: result.rows });
    } catch (err) {
        console.error('GET /api/leads error:', err.message);
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});

// ── PUT /api/leads/:id  →  update lead status / assign coach ─────────────────
router.put('/:id', async (req, res) => {
    try {
        await ensureLeadsTable();
        const { status, coach_id } = req.body;
        const result = await query(
            `UPDATE leads SET status = COALESCE($1, status),
                              coach_id = COALESCE($2, coach_id),
                              updated_at = now()
             WHERE id = $3 RETURNING *`,
            [status || null, coach_id || null, req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });
        res.json({ lead: result.rows[0] });
    } catch (err) {
        console.error('PUT /api/leads/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// ── DELETE /api/leads/:id  →  delete a lead ───────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        await ensureLeadsTable();
        await query('DELETE FROM leads WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/leads/:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete lead' });
    }
});

export default router;
