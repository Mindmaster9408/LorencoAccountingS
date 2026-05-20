// Leads management routes
//
// PUBLIC assessment submissions arrive unauthenticated (POST /api/leads).
// Every submission creates a NEW row — never overwrites an existing one.
// Coach attribution is done via campaign_id resolved at submit time.
//
// ROUTE MAP
// ─────────────────────────────────────────────────────────
// PUBLIC (no auth)
//   POST /api/leads              Submit a new lead from public-assessment.html
//
// AUTHENTICATED (coach / admin)
//   GET  /api/leads              List leads owned by this coach
//   GET  /api/leads/:id          Get a single lead including full basis_answers
//   PUT  /api/leads/:id          Update status / notes
//   DELETE /api/leads/:id        Delete a lead owned by this coach
// ─────────────────────────────────────────────────────────

import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateToken, requireCoach } from '../middleware/auth.js';
import {
    scoreBasisAnswers,
    toLegacyBasisResults,
    ALL_QUESTION_KEYS,
    TOTAL_QUESTIONS
} from '../domain/basis.engine.js';

const router = express.Router();

// ── Ensure table exists on startup ───────────────────────────────────────────
let tableReady = false;
async function ensureLeadsTable() {
    if (tableReady) return;

    // Base table
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
            wants_coaching  BOOLEAN NOT NULL DEFAULT FALSE,
            source          TEXT NOT NULL DEFAULT 'public_assessment',
            status          TEXT NOT NULL DEFAULT 'new',
            coach_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
            campaign_id     INTEGER,
            is_duplicate    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // Add columns that may be missing in pre-existing tables (idempotent)
    const alterCols = [
        'ADD COLUMN IF NOT EXISTS company         TEXT',
        'ADD COLUMN IF NOT EXISTS preferred_lang  TEXT',
        'ADD COLUMN IF NOT EXISTS basis_answers   JSONB',
        'ADD COLUMN IF NOT EXISTS basis_results   JSONB',
        'ADD COLUMN IF NOT EXISTS coaching_goals  TEXT',
        'ADD COLUMN IF NOT EXISTS wants_coaching  BOOLEAN NOT NULL DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS campaign_id     INTEGER',
        'ADD COLUMN IF NOT EXISTS is_duplicate    BOOLEAN NOT NULL DEFAULT FALSE',
    ];
    for (const col of alterCols) {
        await query(`ALTER TABLE leads ${col}`).catch(() => {});
    }

    await query(`CREATE INDEX IF NOT EXISTS idx_leads_coach     ON leads(coach_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_leads_campaign  ON leads(campaign_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_leads_email     ON leads(email)`);

    tableReady = true;
}
ensureLeadsTable().catch(err => console.error('[leads] table init error:', err.message));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitiseStr(val, maxLen = 300) {
    return val ? String(val).trim().substring(0, maxLen) : null;
}

// ── POST /api/leads ───────────────────────────────────────────────────────────
// Public — no auth required.
//
// Accepts campaignId (resolved by public-assessment.html from the campaign slug).
// If campaignId is provided, resolves coach_id from public_assessment_campaigns.
// basisResults from the client is IGNORED — server recomputes from basisAnswers.
// Every call inserts a fresh row. Duplicate detection (same email, same coach)
// sets is_duplicate = true so the coach can review without losing either record.
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

            const {
                name, email, phone, company, preferred_lang,
                basisAnswers,
                // basisResults intentionally destructured but not used — client value ignored
                coachingGoals, wantsCoaching, source, campaignId
            } = req.body;

            // ── Resolve campaign → coach_id ───────────────────────────────
            let resolvedCoachId   = null;
            let resolvedCampaignId = campaignId ? parseInt(campaignId, 10) || null : null;

            if (resolvedCampaignId) {
                const campRow = await query(
                    `SELECT coach_id, is_active FROM public_assessment_campaigns WHERE id = $1`,
                    [resolvedCampaignId]
                );
                if (campRow.rows.length > 0 && campRow.rows[0].is_active) {
                    resolvedCoachId = campRow.rows[0].coach_id;
                } else {
                    // Campaign inactive or not found — clear campaign reference
                    resolvedCampaignId = null;
                }
            }

            // ── Server-side scoring ───────────────────────────────────────
            // basisResults from the client is NEVER used.
            let serverBasisResults = null;
            if (basisAnswers && typeof basisAnswers === 'object' && !Array.isArray(basisAnswers)) {
                const validCount = Object.keys(basisAnswers).filter(k => ALL_QUESTION_KEYS.has(k)).length;
                if (validCount >= TOTAL_QUESTIONS) {
                    serverBasisResults = toLegacyBasisResults(scoreBasisAnswers(basisAnswers));
                }
            }

            // ── Duplicate detection ───────────────────────────────────────
            // Same email for same coach → flag as possible duplicate.
            // Both records are preserved; the coach decides which to keep.
            let isDuplicate = false;
            const cleanEmail = sanitiseStr(email, 300);
            if (cleanEmail && resolvedCoachId) {
                const dupCheck = await query(
                    `SELECT id FROM leads WHERE email = $1 AND coach_id = $2 LIMIT 1`,
                    [cleanEmail, resolvedCoachId]
                );
                if (dupCheck.rows.length > 0) isDuplicate = true;
            }

            // ── Insert new row — always INSERT, never UPDATE ──────────────
            const result = await query(
                `INSERT INTO leads
                    (name, email, phone, company, preferred_lang, basis_answers, basis_results,
                     coaching_goals, wants_coaching, source, status, coach_id, campaign_id, is_duplicate)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 RETURNING id, name, email, created_at`,
                [
                    sanitiseStr(name, 300),
                    cleanEmail,
                    sanitiseStr(phone, 50),
                    sanitiseStr(company, 300),
                    sanitiseStr(preferred_lang, 20),
                    basisAnswers ? JSON.stringify(basisAnswers) : null,
                    serverBasisResults ? JSON.stringify(serverBasisResults) : null,
                    sanitiseStr(coachingGoals, 2000),
                    !!wantsCoaching,
                    source || 'public_assessment',
                    wantsCoaching ? 'interested' : 'new',
                    resolvedCoachId,
                    resolvedCampaignId,
                    isDuplicate
                ]
            );

            res.status(201).json({ ok: true, lead: result.rows[0] });
        } catch (err) {
            console.error('[leads] POST / error:', err.message);
            res.status(500).json({ error: 'Failed to save lead.' });
        }
    }
);

// All routes below require authentication
router.use(authenticateToken);
router.use(requireCoach);

// ── GET /api/leads ────────────────────────────────────────────────────────────
// Returns only leads owned by (coach_id = req.user.id).
// Also returns leads from campaigns owned by this coach even if coach_id is null
// (legacy submissions before campaign attribution was introduced).
router.get('/', async (req, res) => {
    try {
        await ensureLeadsTable();
        const { status, campaignId } = req.query;

        const params = [req.user.id];
        const conditions = ['l.coach_id = $1'];

        if (status) {
            params.push(status);
            conditions.push(`l.status = $${params.length}`);
        }
        if (campaignId) {
            params.push(parseInt(campaignId, 10));
            conditions.push(`l.campaign_id = $${params.length}`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await query(
            `SELECT l.id, l.name, l.email, l.phone, l.company, l.preferred_lang,
                    l.coaching_goals, l.wants_coaching, l.source, l.status,
                    l.campaign_id, l.is_duplicate, l.created_at, l.updated_at,
                    l.basis_results,
                    (l.basis_answers IS NOT NULL) AS has_answers
             FROM leads l
             ${whereClause}
             ORDER BY l.created_at DESC`,
            params
        );

        res.json({ leads: result.rows });
    } catch (err) {
        console.error('[leads] GET / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch leads.' });
    }
});

// ── GET /api/leads/:id ────────────────────────────────────────────────────────
// Returns a single lead with full basis_answers.
// Must be owned by the authenticated coach.
router.get('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead ID.' });

    try {
        await ensureLeadsTable();
        const result = await query(
            `SELECT * FROM leads WHERE id = $1 AND coach_id = $2`,
            [id, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found.' });
        }
        res.json({ lead: result.rows[0] });
    } catch (err) {
        console.error('[leads] GET /:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch lead.' });
    }
});

// ── PUT /api/leads/:id ────────────────────────────────────────────────────────
// Update status or notes. Ownership verified before update.
router.put('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead ID.' });

    try {
        await ensureLeadsTable();
        const { status } = req.body;

        const result = await query(
            `UPDATE leads
             SET status     = COALESCE($1, status),
                 updated_at = now()
             WHERE id = $2 AND coach_id = $3
             RETURNING *`,
            [status || null, id, req.user.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Lead not found.' });
        res.json({ lead: result.rows[0] });
    } catch (err) {
        console.error('[leads] PUT /:id error:', err.message);
        res.status(500).json({ error: 'Failed to update lead.' });
    }
});

// ── DELETE /api/leads/:id ─────────────────────────────────────────────────────
// Ownership verified before delete.
router.delete('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead ID.' });

    try {
        await ensureLeadsTable();
        const result = await query(
            `DELETE FROM leads WHERE id = $1 AND coach_id = $2 RETURNING id`,
            [id, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found.' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[leads] DELETE /:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete lead.' });
    }
});

export default router;
