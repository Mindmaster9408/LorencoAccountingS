// campaigns.routes.js — Public Assessment Campaign management
//
// A "campaign" is a named, reusable public assessment link that a coach creates.
// The URL becomes:  /public-assessment.html?campaign=<slug>
// Every submission through that link is attributed to the owning coach.
//
// ROUTE MAP
// ─────────────────────────────────────────────────────────
// PUBLIC (no auth)
//   GET  /api/campaigns/public/:slug    Resolve slug → {id, coachId, name}
//
// AUTHENTICATED (coach / admin)
//   POST   /api/campaigns               Create a new campaign
//   GET    /api/campaigns               List campaigns for current coach
//   PATCH  /api/campaigns/:id/toggle    Toggle is_active (deactivate / reactivate)
//   DELETE /api/campaigns/:id           Delete a campaign (and deactivate link)
// ─────────────────────────────────────────────────────────

import express from 'express';
import crypto from 'crypto';
import { query } from '../config/database.js';
import { authenticateToken, requireCoach } from '../middleware/auth.js';

const router = express.Router();

// ─── Table initialisation ────────────────────────────────────────────────────

async function ensureCampaignsTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS public_assessment_campaigns (
            id              SERIAL PRIMARY KEY,
            coach_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            slug            TEXT NOT NULL UNIQUE,
            assessment_type TEXT NOT NULL DEFAULT 'basis',
            is_active       BOOLEAN NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_campaigns_coach ON public_assessment_campaigns(coach_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_campaigns_slug  ON public_assessment_campaigns(slug)`);
}

ensureCampaignsTable().catch(err =>
    console.error('[campaigns] Failed to ensure table:', err)
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitise(val, maxLen = 200) {
    return val ? String(val).trim().substring(0, maxLen) : null;
}

function generateSlug() {
    // 12 random bytes → 24-character hex string — non-guessable, URL-safe
    return crypto.randomBytes(12).toString('hex');
}

// ─── PUBLIC (no auth) ────────────────────────────────────────────────────────

/**
 * GET /api/campaigns/public/:slug
 *
 * Called by public-assessment.html on page load to resolve the campaign slug
 * to a coachId and campaign name. Returns only what is safe to expose publicly.
 * Does NOT return any submission data.
 */
router.get('/public/:slug', async (req, res) => {
    const slug = sanitise(req.params.slug, 100);
    if (!slug) return res.status(400).json({ error: 'Invalid campaign slug.' });

    try {
        const result = await query(
            `SELECT id, name, coach_id, assessment_type, is_active
             FROM public_assessment_campaigns
             WHERE slug = $1`,
            [slug]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found.' });
        }

        const campaign = result.rows[0];
        if (!campaign.is_active) {
            return res.status(410).json({ error: 'This assessment link is no longer active.' });
        }

        res.json({
            id:             campaign.id,
            name:           campaign.name,
            coachId:        campaign.coach_id,
            assessmentType: campaign.assessment_type
        });
    } catch (err) {
        console.error('[campaigns] GET /public/:slug', err);
        res.status(500).json({ error: 'Failed to load campaign.' });
    }
});

// ─── AUTHENTICATED ────────────────────────────────────────────────────────────

router.use(authenticateToken);
router.use(requireCoach);

/**
 * POST /api/campaigns
 * Create a new public assessment campaign for the authenticated coach.
 * Returns the created campaign including its slug (used to build the share URL).
 */
router.post('/', async (req, res) => {
    const name = sanitise(req.body.name, 200);
    if (!name) return res.status(400).json({ error: 'Campaign name is required.' });

    const slug = generateSlug();

    try {
        const result = await query(
            `INSERT INTO public_assessment_campaigns (coach_id, name, slug, assessment_type)
             VALUES ($1, $2, $3, 'basis')
             RETURNING *`,
            [req.user.id, name, slug]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[campaigns] POST /', err);
        res.status(500).json({ error: 'Failed to create campaign.' });
    }
});

/**
 * GET /api/campaigns
 * List all campaigns for the authenticated coach, with submission counts.
 */
router.get('/', async (req, res) => {
    try {
        const result = await query(
            `SELECT c.*,
                    COUNT(l.id)::int AS submission_count
             FROM public_assessment_campaigns c
             LEFT JOIN leads l ON l.campaign_id = c.id
             WHERE c.coach_id = $1
             GROUP BY c.id
             ORDER BY c.created_at DESC`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[campaigns] GET /', err);
        res.status(500).json({ error: 'Failed to list campaigns.' });
    }
});

/**
 * PATCH /api/campaigns/:id/toggle
 * Toggle the is_active flag. Deactivating a campaign makes its public slug
 * return 410 Gone — new submissions are blocked.
 */
router.patch('/:id/toggle', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid campaign ID.' });

    try {
        const result = await query(
            `UPDATE public_assessment_campaigns
             SET is_active = NOT is_active, updated_at = now()
             WHERE id = $1 AND coach_id = $2
             RETURNING *`,
            [id, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[campaigns] PATCH /:id/toggle', err);
        res.status(500).json({ error: 'Failed to toggle campaign.' });
    }
});

/**
 * DELETE /api/campaigns/:id
 * Permanently delete a campaign. Associated leads retain their campaign_id
 * as a historical reference (SET NULL via FK).
 */
router.delete('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid campaign ID.' });

    try {
        const result = await query(
            `DELETE FROM public_assessment_campaigns
             WHERE id = $1 AND coach_id = $2
             RETURNING id`,
            [id, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found.' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[campaigns] DELETE /:id', err);
        res.status(500).json({ error: 'Failed to delete campaign.' });
    }
});

export default router;
