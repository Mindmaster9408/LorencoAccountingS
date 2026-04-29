// basis.routes.js — Phase 2A: BASIS submission lifecycle
//
// ROUTE MAP
// ─────────────────────────────────────────────────────────
// PUBLIC (no auth — for client-facing assessment page)
//   GET  /api/basis/public/:token    Get submission info by access token
//   PUT  /api/basis/public/:token    Submit completed answers by access token
//
// AUTHENTICATED (coach / admin)
//   POST /api/basis                  Create a new draft submission
//   GET  /api/basis                  List submissions owned by current user
//   GET  /api/basis/:id              Get a single submission (full data)
//   PUT  /api/basis/:id              Update answers / results / report / status
//   PUT  /api/basis/:id/report-editable  Update coach-editable report sections
//   POST /api/basis/:id/generate-link   Issue a server-side access token
// ─────────────────────────────────────────────────────────

import express from 'express';
import crypto from 'crypto';
import { query } from '../config/database.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import {
    scoreBasisAnswers,
    toLegacyBasisResults,
    ALL_QUESTION_KEYS,
    TOTAL_QUESTIONS
} from '../domain/basis.engine.js';

const router = express.Router();

// ─── Table initialisation ────────────────────────────────────────────────────
// Self-creates on first startup. Idempotent via CREATE TABLE IF NOT EXISTS.

async function ensureBasisTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS basis_submissions (
            id                  SERIAL PRIMARY KEY,
            mode                TEXT NOT NULL DEFAULT 'coach_capture',
            status              TEXT NOT NULL DEFAULT 'draft',
            access_token        TEXT UNIQUE,
            respondent_name     TEXT NOT NULL,
            respondent_email    TEXT,
            respondent_phone    TEXT,
            preferred_lang      TEXT NOT NULL DEFAULT 'en',
            linked_lead_id      INTEGER,
            linked_client_id    INTEGER,
            created_by_user_id  INTEGER,
            basis_answers       JSONB NOT NULL DEFAULT '{}'::jsonb,
            basis_results       JSONB,
            report_generated    JSONB,
            report_editable     JSONB NOT NULL DEFAULT '{}'::jsonb,
            source              TEXT NOT NULL DEFAULT 'coach_capture',
            submitted_at        TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_basis_subs_token  ON basis_submissions(access_token)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_basis_subs_client ON basis_submissions(linked_client_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_basis_subs_user   ON basis_submissions(created_by_user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_basis_subs_status ON basis_submissions(status)`);
}

ensureBasisTable().catch(err =>
    console.error('[basis.routes] Failed to ensure basis_submissions table:', err)
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_MODES      = ['coach_capture', 'public_link'];
const VALID_STATUSES   = ['draft', 'submitted', 'reviewed', 'converted'];
const VALID_LANGS      = ['en', 'af'];
// Keys the coach is allowed to write into report_editable
const EDITABLE_KEYS    = ['coachNotes', 'productsPage', 'invitationText', 'quotationText'];
const MAX_EDITABLE_LEN = 10000;

function sanitiseLang(lang) {
    return VALID_LANGS.includes(lang) ? lang : 'en';
}

function sanitiseString(val, maxLen = 200) {
    return val ? String(val).trim().substring(0, maxLen) : null;
}

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────────
// These endpoints are intentionally unauthenticated — they serve the
// client-facing client-assessment.html page.

/**
 * GET /api/basis/public/:token
 * Returns just enough info to pre-fill the public assessment form.
 * Does NOT return basis_answers or other private fields.
 */
router.get('/public/:token', async (req, res) => {
    const token = sanitiseString(req.params.token, 200);
    if (!token) return res.status(400).json({ error: 'Invalid token.' });

    try {
        const result = await query(
            `SELECT id, status, respondent_name, preferred_lang
             FROM basis_submissions
             WHERE access_token = $1 AND mode = 'public_link'`,
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Assessment link not found or expired.' });
        }

        const sub = result.rows[0];
        if (sub.status === 'submitted') {
            return res.status(410).json({ error: 'This assessment has already been completed.' });
        }

        res.json({
            id: sub.id,
            respondentName: sub.respondent_name,
            preferredLang: sub.preferred_lang
        });
    } catch (err) {
        console.error('[basis] GET /public/:token', err);
        res.status(500).json({ error: 'Failed to load assessment.' });
    }
});

/**
 * PUT /api/basis/public/:token
 * Client submits their completed answers.
 * Accepts basis_answers in flat format: { "BALANS_1": 7, ... }
 *
 * Any client-provided basisResults are intentionally ignored.
 * The backend recomputes results server-side from basisAnswers using the
 * hardened scoring engine, producing a legacy-compatible basis_results
 * object that matches what generateBASISReport() expects.
 */
router.put('/public/:token', async (req, res) => {
    const token = sanitiseString(req.params.token, 200);
    if (!token) return res.status(400).json({ error: 'Invalid token.' });

    // basisResults from the request body is deliberately not destructured —
    // we do not read it and we do not trust it.
    const { respondentName, respondentEmail, respondentPhone, preferredLang,
            basisAnswers } = req.body;

    if (!basisAnswers || typeof basisAnswers !== 'object' || Array.isArray(basisAnswers)) {
        return res.status(400).json({ error: 'basisAnswers must be a plain object.' });
    }

    // Completeness check: count how many submitted keys are recognised question keys.
    // Unknown keys (e.g. injected garbage) are simply ignored by the engine but we
    // still enforce that all 50 real questions were answered.
    const validCount = Object.keys(basisAnswers).filter(k => ALL_QUESTION_KEYS.has(k)).length;
    if (validCount < TOTAL_QUESTIONS) {
        return res.status(400).json({
            error: `Incomplete assessment: ${validCount} of ${TOTAL_QUESTIONS} questions answered.`
        });
    }

    // Server-side scoring — engine applies all hardening patches internally.
    // toLegacyBasisResults() converts to the integer sum format (0–100 per section)
    // that matches generateBASISReport() and basis-ui.js displayResults().
    const serverBasisResults = toLegacyBasisResults(scoreBasisAnswers(basisAnswers));

    try {
        const check = await query(
            `SELECT id, status FROM basis_submissions
             WHERE access_token = $1 AND mode = 'public_link'`,
            [token]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Assessment link not found.' });
        }
        if (check.rows[0].status === 'submitted') {
            return res.status(410).json({ error: 'This assessment has already been submitted.' });
        }

        const cleanName  = sanitiseString(respondentName, 200);
        const cleanEmail = sanitiseString(respondentEmail, 200);
        const cleanPhone = sanitiseString(respondentPhone, 50);
        const cleanLang  = sanitiseLang(preferredLang);

        const result = await query(
            `UPDATE basis_submissions
             SET basis_answers      = $1,
                 basis_results      = $2,
                 status             = 'submitted',
                 submitted_at       = now(),
                 updated_at         = now(),
                 respondent_name    = COALESCE($3, respondent_name),
                 respondent_email   = COALESCE($4, respondent_email),
                 respondent_phone   = COALESCE($5, respondent_phone),
                 preferred_lang     = $6
             WHERE access_token = $7
             RETURNING id, status`,
            [
                JSON.stringify(basisAnswers),
                JSON.stringify(serverBasisResults),
                cleanName,
                cleanEmail,
                cleanPhone,
                cleanLang,
                token
            ]
        );

        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('[basis] PUT /public/:token', err);
        res.status(500).json({ error: 'Failed to submit assessment.' });
    }
});

// ─── AUTHENTICATED ROUTES ────────────────────────────────────────────────────

/**
 * POST /api/basis
 * Create a new draft submission.
 * For public_link mode: call POST /:id/generate-link after this to get a token.
 */
router.post('/', authenticateToken, async (req, res) => {
    const { respondentName, respondentEmail, respondentPhone, preferredLang,
            mode, linkedClientId } = req.body;

    const cleanName = sanitiseString(respondentName, 200);
    if (!cleanName) return res.status(400).json({ error: 'respondentName is required.' });

    const cleanMode = VALID_MODES.includes(mode) ? mode : 'coach_capture';

    try {
        const result = await query(
            `INSERT INTO basis_submissions
                (respondent_name, respondent_email, respondent_phone, preferred_lang,
                 mode, status, source, created_by_user_id, linked_client_id)
             VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
             RETURNING *`,
            [
                cleanName,
                sanitiseString(respondentEmail, 200),
                sanitiseString(respondentPhone, 50),
                sanitiseLang(preferredLang),
                cleanMode,
                cleanMode,        // source mirrors mode at creation time
                req.user.id,
                linkedClientId ? parseInt(linkedClientId, 10) : null
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[basis] POST /', err);
        res.status(500).json({ error: 'Failed to create submission.' });
    }
});

/**
 * GET /api/basis
 * List all submissions for the current coach.
 * Returns minimal fields — use GET /:id for full data.
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT id, mode, status, respondent_name, respondent_email,
                    preferred_lang, linked_client_id, source,
                    submitted_at, created_at, updated_at,
                    (basis_results IS NOT NULL) AS has_results,
                    (report_generated IS NOT NULL) AS has_report
             FROM basis_submissions
             WHERE created_by_user_id = $1
             ORDER BY created_at DESC`,
            [req.user.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('[basis] GET /', err);
        res.status(500).json({ error: 'Failed to list submissions.' });
    }
});

/**
 * GET /api/basis/:id
 * Get full submission data. Must be owned by the requesting user.
 *
 * NOTE: This route must be declared AFTER /public/:token to avoid
 * Express matching "public" as an :id parameter.
 */
router.get('/:id', authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID.' });

    try {
        const result = await query(
            `SELECT * FROM basis_submissions
             WHERE id = $1 AND created_by_user_id = $2`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Submission not found.' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[basis] GET /:id', err);
        res.status(500).json({ error: 'Failed to get submission.' });
    }
});

/**
 * PUT /api/basis/:id
 * Partial update — only touches fields that are present in the request body.
 * Supports: basisAnswers, reportGenerated, status,
 *           respondentName, preferredLang, linkedClientId
 *
 * basisResults is no longer accepted as a direct input. When basisAnswers is
 * provided, basis_results is always recomputed server-side from those answers.
 * Any basisResults value in the request body is silently ignored.
 */
router.put('/:id', authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID.' });

    const { basisAnswers, reportGenerated, status,
            respondentName, preferredLang, linkedClientId } = req.body;
    // basisResults intentionally not destructured — it is never read from the request body.

    try {
        // Verify ownership before touching
        const check = await query(
            `SELECT id FROM basis_submissions WHERE id = $1 AND created_by_user_id = $2`,
            [id, req.user.id]
        );
        if (check.rows.length === 0) return res.status(404).json({ error: 'Submission not found.' });

        // Build a dynamic partial update — only fields that were sent
        const sets = ['updated_at = now()'];
        const params = [];
        let p = 1;

        if (basisAnswers !== undefined) {
            if (typeof basisAnswers !== 'object' || Array.isArray(basisAnswers)) {
                return res.status(400).json({ error: 'basisAnswers must be a plain object.' });
            }
            sets.push(`basis_answers = $${p++}`);
            params.push(JSON.stringify(basisAnswers));

            // Always recompute results server-side from the provided answers.
            // basisResults from the request body is ignored.
            const serverBasisResults = toLegacyBasisResults(scoreBasisAnswers(basisAnswers));
            sets.push(`basis_results = $${p++}`);
            params.push(JSON.stringify(serverBasisResults));
        }
        if (reportGenerated !== undefined) {
            sets.push(`report_generated = $${p++}`);
            params.push(JSON.stringify(reportGenerated));
        }
        if (status !== undefined) {
            if (!VALID_STATUSES.includes(status)) {
                return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}.` });
            }
            sets.push(`status = $${p++}`);
            params.push(status);
            if (status === 'submitted') sets.push('submitted_at = now()');
        }
        if (respondentName !== undefined) {
            const cleanName = sanitiseString(respondentName, 200);
            if (!cleanName) return res.status(400).json({ error: 'respondentName cannot be empty.' });
            sets.push(`respondent_name = $${p++}`);
            params.push(cleanName);
        }
        if (preferredLang !== undefined) {
            sets.push(`preferred_lang = $${p++}`);
            params.push(sanitiseLang(preferredLang));
        }
        if (linkedClientId !== undefined) {
            sets.push(`linked_client_id = $${p++}`);
            params.push(linkedClientId ? parseInt(linkedClientId, 10) : null);
        }

        params.push(id);
        const result = await query(
            `UPDATE basis_submissions SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
            params
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[basis] PUT /:id', err);
        res.status(500).json({ error: 'Failed to update submission.' });
    }
});

/**
 * PUT /api/basis/:id/report-editable
 * Merge-update coach-editable report sections.
 * Only the whitelisted EDITABLE_KEYS are accepted — anything else is silently ignored.
 * Uses JSONB merge (||) so un-sent keys are preserved.
 */
router.put('/:id/report-editable', authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID.' });

    const { reportEditable } = req.body;
    if (!reportEditable || typeof reportEditable !== 'object' || Array.isArray(reportEditable)) {
        return res.status(400).json({ error: 'reportEditable must be a plain object.' });
    }

    // Whitelist + length-cap each key
    const sanitised = {};
    for (const key of EDITABLE_KEYS) {
        if (reportEditable[key] !== undefined) {
            sanitised[key] = String(reportEditable[key]).substring(0, MAX_EDITABLE_LEN);
        }
    }

    try {
        const check = await query(
            `SELECT id FROM basis_submissions WHERE id = $1 AND created_by_user_id = $2`,
            [id, req.user.id]
        );
        if (check.rows.length === 0) return res.status(404).json({ error: 'Submission not found.' });

        // JSONB merge operator (||) preserves untouched keys
        const result = await query(
            `UPDATE basis_submissions
             SET report_editable = report_editable || $1::jsonb, updated_at = now()
             WHERE id = $2
             RETURNING id, report_editable`,
            [JSON.stringify(sanitised), id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[basis] PUT /:id/report-editable', err);
        res.status(500).json({ error: 'Failed to update report sections.' });
    }
});

/**
 * POST /api/basis/:id/generate-link
 * Issues a secure server-side access token for public_link mode.
 * Idempotent — returns the existing token if one already exists.
 * Flips mode to 'public_link' if it was 'coach_capture'.
 */
router.post('/:id/generate-link', authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID.' });

    try {
        const check = await query(
            `SELECT id, mode, status, access_token FROM basis_submissions
             WHERE id = $1 AND created_by_user_id = $2`,
            [id, req.user.id]
        );

        if (check.rows.length === 0) return res.status(404).json({ error: 'Submission not found.' });

        const sub = check.rows[0];
        if (sub.status === 'submitted') {
            return res.status(409).json({ error: 'Cannot generate a link for a completed submission.' });
        }

        // Return existing token if already issued (idempotent)
        if (sub.access_token) {
            return res.json({ token: sub.access_token });
        }

        // Generate a 64-character hex token using Node crypto — secure, URL-safe
        const token = crypto.randomBytes(32).toString('hex');

        await query(
            `UPDATE basis_submissions
             SET access_token = $1, mode = 'public_link', updated_at = now()
             WHERE id = $2`,
            [token, id]
        );

        res.json({ token });
    } catch (err) {
        console.error('[basis] POST /:id/generate-link', err);
        res.status(500).json({ error: 'Failed to generate link.' });
    }
});

export default router;
