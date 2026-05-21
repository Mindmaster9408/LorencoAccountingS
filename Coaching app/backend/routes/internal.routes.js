// internal.routes.js
//
// Read-only internal API for the Sean ecosystem backend.
// Protected by COACHING_INTERNAL_API_TOKEN shared secret — NOT user JWT auth.
//
// All routes return data without coach_id scoping. This is intentional:
// the Sean service token is a trusted server-to-server credential that has
// read access to all coaching data. Write access is never exposed here.
//
// Mounted at: /api/internal
//
// Endpoints:
//   GET /clients                                           — all non-archived clients
//   GET /clients/:clientId                                 — full client detail
//   GET /basis                                             — all BASIS submissions (summary)
//   GET /basis/:id                                         — full BASIS submission
//   GET /spil                                              — all SPIL profiles (summary)
//   GET /spil/:id                                          — full SPIL profile
//   GET /question-builder/client/:clientId/context/:key   — questions + answers

import express from 'express';
import { query } from '../config/database.js';
import { requireInternalToken } from '../middleware/internal-auth.js';

const router = express.Router();

// All routes require the internal service token
router.use(requireInternalToken);

// Mirrors the normalizeClientRow helper from clients.routes.js.
// Ensures exercise_data and journey_progress are never null for old rows.
function normalizeClientRow(row) {
    if (!row) return row;
    return {
        ...row,
        exercise_data: row.exercise_data || {},
        journey_progress: row.journey_progress || {
            currentStep: row.current_step || 1,
            completedSteps: [],
            stepNotes: {},
            stepCompletionDates: {}
        }
    };
}

// ─── GET /api/internal/clients ────────────────────────────────────────────────
// All non-archived clients across all coaches, with session count.
// Optional ?status= filter. Defaults to excluding archived.
router.get('/clients', async (req, res) => {
    try {
        const { status } = req.query;

        let queryText = `
            SELECT c.*,
                   COUNT(DISTINCT cs.id) as session_count,
                   MAX(cs.session_date) as last_actual_session
            FROM coaching_clients c
            LEFT JOIN client_sessions cs ON c.id = cs.client_id
            WHERE 1=1
        `;
        const params = [];

        if (status && status !== 'all') {
            queryText += ` AND c.status = $${params.length + 1}`;
            params.push(status);
        } else {
            queryText += ` AND c.status != 'archived'`;
        }

        queryText += ' GROUP BY c.id ORDER BY c.last_session DESC NULLS LAST';

        const result = await query(queryText, params);
        res.json({ success: true, clients: result.rows.map(normalizeClientRow) });
    } catch (err) {
        console.error('[internal] GET /clients', err);
        res.status(500).json({ error: 'Failed to retrieve clients' });
    }
});

// ─── GET /api/internal/clients/:clientId ─────────────────────────────────────
// Full client detail: steps, gauges (latest per key), 10 most recent sessions.
router.get('/clients/:clientId', async (req, res) => {
    try {
        const id = parseInt(req.params.clientId, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid clientId' });

        const clientResult = await query(
            'SELECT * FROM coaching_clients WHERE id = $1',
            [id]
        );

        if (clientResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }

        const [stepsResult, gaugesResult, sessionsResult] = await Promise.all([
            query(
                'SELECT * FROM client_steps WHERE client_id = $1 ORDER BY step_order',
                [id]
            ),
            query(
                `SELECT DISTINCT ON (gauge_key) gauge_key, gauge_value, recorded_at
                 FROM client_gauges
                 WHERE client_id = $1
                 ORDER BY gauge_key, recorded_at DESC`,
                [id]
            ),
            query(
                `SELECT * FROM client_sessions
                 WHERE client_id = $1
                 ORDER BY session_date DESC
                 LIMIT 10`,
                [id]
            )
        ]);

        const gauges = {};
        gaugesResult.rows.forEach(g => { gauges[g.gauge_key] = g.gauge_value; });

        res.json({
            success: true,
            client: {
                ...normalizeClientRow(clientResult.rows[0]),
                steps:    stepsResult.rows,
                gauges,
                sessions: sessionsResult.rows
            }
        });
    } catch (err) {
        console.error('[internal] GET /clients/:id', err);
        res.status(500).json({ error: 'Failed to retrieve client' });
    }
});

// ─── GET /api/internal/basis ──────────────────────────────────────────────────
// All BASIS submissions — summary fields, newest first.
// Same response shape as authenticated GET /api/basis (array of rows).
router.get('/basis', async (req, res) => {
    try {
        const result = await query(
            `SELECT id, mode, status, respondent_name, respondent_email,
                    preferred_lang, linked_client_id, source,
                    submitted_at, created_at, updated_at,
                    (basis_results IS NOT NULL)    AS has_results,
                    (report_generated IS NOT NULL) AS has_report
             FROM basis_submissions
             ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[internal] GET /basis', err);
        res.status(500).json({ error: 'Failed to list submissions' });
    }
});

// ─── GET /api/internal/basis/:id ─────────────────────────────────────────────
// Full BASIS submission including answers and results.
// NOTE: /public/:token MUST NOT be replicated here — public tokens are
// for client-facing intake only and are not part of the internal API.
router.get('/basis/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid submission ID' });

        const result = await query(
            'SELECT * FROM basis_submissions WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[internal] GET /basis/:id', err);
        res.status(500).json({ error: 'Failed to get submission' });
    }
});

// ─── GET /api/internal/spil ───────────────────────────────────────────────────
// All SPIL profiles — summary fields, newest first.
// Same response shape as authenticated GET /api/spil (array of rows).
router.get('/spil', async (req, res) => {
    try {
        const result = await query(
            `SELECT id, respondent_name, respondent_email, respondent_phone,
                    preferred_lang, spil_code, linked_client_id,
                    (scores IS NOT NULL)           AS has_results,
                    (report_generated IS NOT NULL) AS has_report,
                    created_at, updated_at
             FROM spil_profiles
             ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[internal] GET /spil', err);
        res.status(500).json({ error: 'Failed to list SPIL profiles' });
    }
});

// ─── GET /api/internal/spil/:id ───────────────────────────────────────────────
// Full SPIL profile including scores and report.
router.get('/spil/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid profile ID' });

        const result = await query(
            'SELECT * FROM spil_profiles WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'SPIL profile not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[internal] GET /spil/:id', err);
        res.status(500).json({ error: 'Failed to get SPIL profile' });
    }
});

// ─── GET /api/internal/question-builder/client/:clientId/context/:contextKey ──
// Questions assigned to a client/context pair with their saved answers.
// Same response shape as authenticated GET /api/coaching/question-builder/client/:id/context/:key.
// The underlying query has no coach_id column — no scoping change needed.
router.get('/question-builder/client/:clientId/context/:contextKey', async (req, res) => {
    const clientId   = parseInt(req.params.clientId, 10);
    const contextKey = (req.params.contextKey || '').trim().substring(0, 100);

    if (isNaN(clientId) || !contextKey) {
        return res.status(400).json({ error: 'Invalid clientId or contextKey' });
    }

    try {
        const result = await query(
            `SELECT cq.*,
                    ccqa.id              AS assignment_id,
                    ccqa.sort_order      AS assignment_sort_order,
                    ans.id               AS answer_id,
                    ans.answer_text,
                    ans.answer_number,
                    ans.answer_json
             FROM coaching_client_question_assignments ccqa
             JOIN coaching_questions cq ON cq.id = ccqa.question_id
             LEFT JOIN coaching_client_question_answers ans
                    ON ans.client_id   = ccqa.client_id
                   AND ans.question_id = ccqa.question_id
                   AND ans.context_key = ccqa.context_key
             WHERE ccqa.client_id = $1 AND ccqa.context_key = $2 AND ccqa.is_active = true
             ORDER BY ccqa.sort_order ASC, cq.sort_order ASC`,
            [clientId, contextKey]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[internal] GET /question-builder/client/:id/context/:key', err);
        res.status(500).json({ error: 'Failed to get client context questions' });
    }
});

export default router;
