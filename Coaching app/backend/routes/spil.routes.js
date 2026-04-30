// spil.routes.js — SPIL-E Profile API
//
// ROUTE MAP
// ─────────────────────────────────────────────────────────
// AUTHENTICATED (coach / admin)
//   POST /api/spil             Create a new profile (with or without answers)
//   GET  /api/spil             List profiles owned by current user
//   GET  /api/spil/:id         Get a single profile (full data + report)
//   PUT  /api/spil/:id         Update answers → recompute results and regenerate report
// ─────────────────────────────────────────────────────────
//
// SAFETY NOTE: This module is completely isolated from basis_submissions.
//   - Does not import from basis.engine.js or basis.routes.js
//   - Does not modify any existing tables
//   - Does not alter any existing API contracts

import express from 'express';
import { query } from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import {
    buildResults,
    validateAnswers,
    TOTAL_SPIL_QUESTIONS
} from '../domain/spil.engine.js';
import {
    generateReport,
    generateInternalNotes
} from '../domain/spil.report.js';

const router = express.Router();

// ─── Table initialisation ─────────────────────────────────────────────────────
// Self-creates on first startup. Idempotent via CREATE TABLE IF NOT EXISTS.

async function ensureSpilTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS spil_profiles (
            id                  SERIAL PRIMARY KEY,
            respondent_name     TEXT NOT NULL,
            respondent_email    TEXT,
            respondent_phone    TEXT,
            preferred_lang      TEXT DEFAULT 'en',
            answers             JSONB NOT NULL DEFAULT '{}'::jsonb,
            scores              JSONB,
            ranking             JSONB,
            spil_code           TEXT,
            report_generated    JSONB,
            report_internal     JSONB,
            created_by_user_id  INTEGER,
            linked_client_id    INTEGER,
            created_at          TIMESTAMPTZ DEFAULT now(),
            updated_at          TIMESTAMPTZ DEFAULT now()
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_spil_profiles_client ON spil_profiles(linked_client_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_spil_profiles_user   ON spil_profiles(created_by_user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_spil_profiles_email  ON spil_profiles(respondent_email)`);
}

ensureSpilTable().catch(err =>
    console.error('[spil.routes] Failed to ensure spil_profiles table:', err)
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_LANGS = ['en', 'af'];

function sanitiseLang(lang) {
    return VALID_LANGS.includes(lang) ? lang : 'en';
}

function sanitiseString(val, maxLen = 200) {
    if (val === undefined || val === null) return null;
    return String(val).trim().substring(0, maxLen) || null;
}

// Strip any answer keys that are not recognised SPIL keys,
// and coerce values to integers. Returns a clean object.
function sanitiseAnswers(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const clean = {};

    for (const [key, val] of Object.entries(raw)) {
        // Only accept keys matching DIM_N pattern where DIM is a known SPIL dimension
        if (!/^(STRUKTUUR|PRESTASIE|INSIG|LIEFDE|EMOSIE|INISIATIEF)_([1-9]|10)$/.test(key)) continue;
        const n = Number(val);
        if (isNaN(n)) continue;
        if (n < 1 || n > 10) continue;
        clean[key] = n;
    }

    return clean;
}

// ─── POST /api/spil ───────────────────────────────────────────────────────────
// Create a new SPIL profile.
// Answers are optional at creation — coach may save a draft first,
// then populate answers via PUT /:id.
//
// Body: { respondentName, respondentEmail, respondentPhone, preferredLang,
//          linkedClientId, answers? }
router.post('/', authenticateToken, async (req, res) => {
    const {
        respondentName, respondentEmail, respondentPhone,
        preferredLang, linkedClientId, answers
    } = req.body;

    const cleanName = sanitiseString(respondentName, 200);
    if (!cleanName) {
        return res.status(400).json({ error: 'respondentName is required.' });
    }

    const cleanAnswers = answers ? sanitiseAnswers(answers) : {};
    let scores = null, ranking = null, spilCode = null;
    let reportGenerated = null, reportInternal = null;

    // If answers provided at creation, run engine immediately
    if (Object.keys(cleanAnswers).length > 0) {
        const validation = validateAnswers(cleanAnswers);

        if (!validation.valid) {
            return res.status(422).json({
                error: `Incomplete answers. ${validation.answeredCount}/${TOTAL_SPIL_QUESTIONS} valid answers provided.`,
                missingKeys: validation.missingKeys
            });
        }

        const results = buildResults(cleanAnswers);
        scores   = results.scores;
        ranking  = results.ranking;
        spilCode = results.spilCode;

        const report   = generateReport(results, cleanName, sanitiseLang(preferredLang));
        const internal = generateInternalNotes(results, cleanName);
        reportGenerated = report;
        reportInternal  = internal;
    }

    try {
        const result = await query(
            `INSERT INTO spil_profiles
                (respondent_name, respondent_email, respondent_phone, preferred_lang,
                 answers, scores, ranking, spil_code,
                 report_generated, report_internal,
                 created_by_user_id, linked_client_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
                cleanName,
                sanitiseString(respondentEmail, 200),
                sanitiseString(respondentPhone, 50),
                sanitiseLang(preferredLang),
                JSON.stringify(cleanAnswers),
                scores   ? JSON.stringify(scores)   : null,
                ranking  ? JSON.stringify(ranking)  : null,
                spilCode ?? null,
                reportGenerated ? JSON.stringify(reportGenerated) : null,
                reportInternal  ? JSON.stringify(reportInternal)  : null,
                req.user.id,
                linkedClientId ? parseInt(linkedClientId, 10) : null
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[spil] POST /', err);
        res.status(500).json({ error: 'Failed to create SPIL profile.' });
    }
});

// ─── GET /api/spil ────────────────────────────────────────────────────────────
// List all SPIL profiles for the current coach.
// Returns summary fields only — use GET /:id for full data.
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT id, respondent_name, respondent_email, respondent_phone,
                    preferred_lang, spil_code, linked_client_id,
                    (scores IS NOT NULL)           AS has_results,
                    (report_generated IS NOT NULL) AS has_report,
                    created_at, updated_at
             FROM spil_profiles
             WHERE created_by_user_id = $1
             ORDER BY created_at DESC`,
            [req.user.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('[spil] GET /', err);
        res.status(500).json({ error: 'Failed to list SPIL profiles.' });
    }
});

// ─── GET /api/spil/:id ────────────────────────────────────────────────────────
// Return a single SPIL profile including full results and report.
router.get('/:id', authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ error: 'Invalid profile id.' });
    }

    try {
        const result = await query(
            `SELECT * FROM spil_profiles
             WHERE id = $1 AND created_by_user_id = $2`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'SPIL profile not found.' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[spil] GET /:id', err);
        res.status(500).json({ error: 'Failed to retrieve SPIL profile.' });
    }
});

// ─── PUT /api/spil/:id ────────────────────────────────────────────────────────
// Update answers → recompute scores, ranking, spilCode and regenerate report.
// Also allows updating respondent metadata (name, email, phone, lang).
//
// Body: { answers, respondentName?, respondentEmail?, respondentPhone?, preferredLang? }
//
// Validation rule: answers must be complete (all 60 valid) to trigger scoring.
router.put('/:id', authenticateToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ error: 'Invalid profile id.' });
    }

    const {
        answers, respondentName, respondentEmail,
        respondentPhone, preferredLang
    } = req.body;

    if (!answers) {
        return res.status(400).json({ error: 'answers is required for PUT.' });
    }

    const cleanAnswers = sanitiseAnswers(answers);
    const validation   = validateAnswers(cleanAnswers);

    if (!validation.valid) {
        return res.status(422).json({
            error: `Incomplete answers. ${validation.answeredCount}/${TOTAL_SPIL_QUESTIONS} valid answers provided.`,
            missingKeys: validation.missingKeys
        });
    }

    try {
        // Confirm profile exists and belongs to this coach
        const check = await query(
            `SELECT id, respondent_name, preferred_lang FROM spil_profiles
             WHERE id = $1 AND created_by_user_id = $2`,
            [id, req.user.id]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'SPIL profile not found.' });
        }

        const existing = check.rows[0];
        const useName  = sanitiseString(respondentName, 200) ?? existing.respondent_name;
        const useLang  = sanitiseLang(preferredLang ?? existing.preferred_lang);

        // Run engine
        const results       = buildResults(cleanAnswers);
        const report        = generateReport(results, useName, useLang);
        const internalNotes = generateInternalNotes(results, useName);

        const updated = await query(
            `UPDATE spil_profiles
             SET answers             = $1,
                 scores              = $2,
                 ranking             = $3,
                 spil_code           = $4,
                 report_generated    = $5,
                 report_internal     = $6,
                 respondent_name     = $7,
                 respondent_email    = COALESCE($8, respondent_email),
                 respondent_phone    = COALESCE($9, respondent_phone),
                 preferred_lang      = $10,
                 updated_at          = now()
             WHERE id = $11 AND created_by_user_id = $12
             RETURNING *`,
            [
                JSON.stringify(cleanAnswers),
                JSON.stringify(results.scores),
                JSON.stringify(results.ranking),
                results.spilCode,
                JSON.stringify(report),
                JSON.stringify(internalNotes),
                useName,
                sanitiseString(respondentEmail, 200),
                sanitiseString(respondentPhone, 50),
                useLang,
                id,
                req.user.id
            ]
        );

        res.json(updated.rows[0]);
    } catch (err) {
        console.error('[spil] PUT /:id', err);
        res.status(500).json({ error: 'Failed to update SPIL profile.' });
    }
});

export default router;
