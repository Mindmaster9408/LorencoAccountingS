// Client management routes
import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateToken, requireCoach, requireClientAccess } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);
router.use(requireCoach);

// Normalize a raw DB client row before sending to the frontend.
// Ensures exercise_data and journey_progress are never null (old rows pre-migration).
// This is defensive — new rows always have these columns populated via DEFAULT.
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

// Get all clients for the logged-in coach
router.get('/', async (req, res) => {
    try {
        const { status } = req.query;

        let queryText = `
            SELECT c.*,
                   COUNT(DISTINCT cs.id) as session_count,
                   MAX(cs.session_date) as last_actual_session
            FROM clients c
            LEFT JOIN client_sessions cs ON c.id = cs.client_id
            WHERE c.coach_id = $1
        `;

        const params = [req.user.id];

        // Filter by status if provided
        if (status && status !== 'all') {
            queryText += ' AND c.status = $2';
            params.push(status);
        }

        queryText += ' GROUP BY c.id ORDER BY c.last_session DESC NULLS LAST';

        const result = await query(queryText, params);

        res.json({
            success: true,
            clients: result.rows.map(normalizeClientRow)
        });

    } catch (error) {
        console.error('Get clients error:', error);
        res.status(500).json({ error: 'Failed to retrieve clients' });
    }
});

// Get single client with full details
router.get('/:clientId', requireClientAccess, async (req, res) => {
    try {
        const { clientId } = req.params;

        // Get client basic info
        const clientResult = await query(
            'SELECT * FROM clients WHERE id = $1',
            [clientId]
        );

        if (clientResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }

        const client = clientResult.rows[0];
        const stepsResult = await query(
            'SELECT * FROM client_steps WHERE client_id = $1 ORDER BY step_order',
            [clientId]
        );

        // Get latest gauges
        const gaugesResult = await query(
            `SELECT DISTINCT ON (gauge_key) gauge_key, gauge_value, recorded_at
             FROM client_gauges
             WHERE client_id = $1
             ORDER BY gauge_key, recorded_at DESC`,
            [clientId]
        );

        // Get recent sessions
        const sessionsResult = await query(
            `SELECT * FROM client_sessions
             WHERE client_id = $1
             ORDER BY session_date DESC
             LIMIT 10`,
            [clientId]
        );

        // Format gauges as object
        const gauges = {};
        gaugesResult.rows.forEach(g => {
            gauges[g.gauge_key] = g.gauge_value;
        });

        res.json({
            success: true,
            client: {
                ...normalizeClientRow(client),
                steps: stepsResult.rows,
                gauges,
                sessions: sessionsResult.rows
            }
        });

    } catch (error) {
        console.error('Get client error:', error);
        res.status(500).json({ error: 'Failed to retrieve client' });
    }
});

// Create new client
router.post('/',
    [
        body('name').notEmpty().trim(),
        body('email').optional().isEmail().normalizeEmail(),
        body('preferred_lang').optional(),
        body('dream').optional()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { name, email, phone, preferred_lang, dream } = req.body;

            // Create client with initial journey_progress (step 1 is Four Quadrants)
            const result = await query(
                `INSERT INTO clients (coach_id, name, email, phone, preferred_lang, dream, current_step, exercise_data, journey_progress, last_session)
                 VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, '{"currentStep": 1, "completedSteps": [], "stepNotes": {}, "stepCompletionDates": {}}'::jsonb, CURRENT_DATE)
                 RETURNING *`,
                [req.user.id, name, email || null, phone || null, preferred_lang || 'English', dream || '']
            );

            const newClient = result.rows[0];

            // Create default journey steps (15 steps from config)
            const steps = [
                {id:'kwadrant', name:'4 Quadrant Exercise', order:1},
                {id:'present-gap-future', name:'Present-Gap-Future', order:2},
                {id:'flight-plan', name:'Flight Plan', order:3},
                {id:'deep-dive', name:'Deep Dive', order:4},
                {id:'assessments', name:'Assessments & Ecochart', order:5},
                {id:'dashboard-step', name:'The Dashboard', order:6},
                {id:'psycho-edu', name:'Psycho Education', order:7},
                {id:'mlnp', name:'MLNP (Gesigkaarte)', order:8},
                {id:'reassessment', name:'Reassessment', order:9},
                {id:'revisit', name:'Revisit', order:10},
                {id:'dream-spot', name:'The Dream-Spot', order:11},
                {id:'values-beliefs', name:'Values & Beliefs', order:12},
                {id:'success-traits', name:'Success Traits', order:13},
                {id:'curiosity', name:'Curiosity/Passion/Purpose', order:14},
                {id:'creativity-flow', name:'Creativity & Flow', order:15}
            ];

            for (const step of steps) {
                await query(
                    `INSERT INTO client_steps (client_id, step_id, step_name, step_order)
                     VALUES ($1, $2, $3, $4)`,
                    [newClient.id, step.id, step.name, step.order]
                );
            }

            // Create initial gauge readings (all at 50)
            const gaugeKeys = ['fuel', 'horizon', 'thrust', 'engine', 'compass', 'positive', 'weight', 'nav', 'negative'];
            for (const gaugeKey of gaugeKeys) {
                await query(
                    `INSERT INTO client_gauges (client_id, gauge_key, gauge_value)
                     VALUES ($1, $2, 50)`,
                    [newClient.id, gaugeKey]
                );
            }

            res.status(201).json({
                success: true,
                message: 'Client created successfully',
                client: normalizeClientRow(newClient)
            });

        } catch (error) {
            console.error('Create client error:', error);
            res.status(500).json({ error: 'Failed to create client' });
        }
    }
);

// Update client
router.put('/:clientId',
    requireClientAccess,
    async (req, res) => {
        try {
            const { clientId } = req.params;
            const { name, email, phone, preferred_lang, status, dream, current_step, progress_completed, exerciseData, journeyProgress } = req.body;

            // Validate JSONB fields if provided
            if (exerciseData !== undefined && (typeof exerciseData !== 'object' || exerciseData === null)) {
                return res.status(400).json({ error: 'exerciseData must be an object' });
            }
            if (journeyProgress !== undefined && (typeof journeyProgress !== 'object' || journeyProgress === null)) {
                return res.status(400).json({ error: 'journeyProgress must be an object' });
            }

            // SERVER-SIDE STEP-1 ENFORCEMENT:
            // Four Quadrants (Step 1) must be completed before any other step can be
            // marked as current or completed. This mirrors the UI guard but is enforced
            // server-side so API calls cannot bypass it.
            if (journeyProgress) {
                const jpCompletedSteps = Array.isArray(journeyProgress.completedSteps)
                    ? journeyProgress.completedSteps
                    : [];
                const jpCurrentStep = journeyProgress.currentStep || 1;

                if (jpCurrentStep > 1 && !jpCompletedSteps.includes(1)) {
                    return res.status(400).json({
                        error: 'Step 1 (Four Quadrants) must be completed before advancing to another step'
                    });
                }
                if (jpCompletedSteps.some(s => s > 1) && !jpCompletedSteps.includes(1)) {
                    return res.status(400).json({
                        error: 'Step 1 (Four Quadrants) must be completed before completing other steps'
                    });
                }
            }

            // EXTEND STEP-1 ENFORCEMENT: cover current_step-only updates (journeyProgress absent).
            // If a raw current_step > 1 is sent without journeyProgress, we must verify the persisted
            // journey_progress still has step 1 completed. This prevents bypassing the UI guard via
            // a direct API call with only current_step in the payload.
            if (current_step !== undefined && Number(current_step) > 1 && !journeyProgress) {
                const progressResult = await query(
                    'SELECT journey_progress FROM clients WHERE id = $1',
                    [clientId]
                );
                if (progressResult.rows.length > 0) {
                    const persistedJP = progressResult.rows[0].journey_progress;
                    const persistedCompleted = (persistedJP && Array.isArray(persistedJP.completedSteps))
                        ? persistedJP.completedSteps
                        : [];
                    if (!persistedCompleted.includes(1)) {
                        return res.status(400).json({
                            error: 'Four Quadrants (Step 1) must be completed before progressing to later steps.'
                        });
                    }
                }
            }

            // SOURCE-OF-TRUTH SYNC: journeyProgress.currentStep is the single source of truth.
            // When journeyProgress is provided, derive current_step from it to prevent drift
            // between the current_step column and journeyProgress.currentStep in JSONB.
            let safeCurrentStep = current_step;
            if (journeyProgress && journeyProgress.currentStep) {
                safeCurrentStep = journeyProgress.currentStep;
            }

            const result = await query(
                `UPDATE clients
                 SET name = COALESCE($1, name),
                     email = COALESCE($2, email),
                     phone = COALESCE($3, phone),
                     preferred_lang = COALESCE($4, preferred_lang),
                     status = COALESCE($5, status),
                     dream = COALESCE($6, dream),
                     current_step = COALESCE($7, current_step),
                     progress_completed = COALESCE($8, progress_completed),
                     exercise_data = COALESCE($9::jsonb, exercise_data),
                     journey_progress = COALESCE($10::jsonb, journey_progress),
                     last_session = CURRENT_DATE
                 WHERE id = $11
                 RETURNING *`,
                [name, email, phone, preferred_lang, status, dream, safeCurrentStep, progress_completed,
                 exerciseData ? JSON.stringify(exerciseData) : null,
                 journeyProgress ? JSON.stringify(journeyProgress) : null,
                 clientId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Client not found' });
            }

            res.json({
                success: true,
                message: 'Client updated successfully',
                client: normalizeClientRow(result.rows[0])
            });

        } catch (error) {
            console.error('Update client error:', error);
            res.status(500).json({ error: 'Failed to update client' });
        }
    }
);

// Update client gauges
router.put('/:clientId/gauges',
    requireClientAccess,
    async (req, res) => {
        try {
            const { clientId } = req.params;
            const { gauges } = req.body;

            if (!gauges || typeof gauges !== 'object') {
                return res.status(400).json({ error: 'Gauges object required' });
            }

            // Insert new gauge readings
            for (const [gaugeKey, gaugeValue] of Object.entries(gauges)) {
                await query(
                    `INSERT INTO client_gauges (client_id, gauge_key, gauge_value)
                     VALUES ($1, $2, $3)`,
                    [clientId, gaugeKey, gaugeValue]
                );
            }

            // Update client last_session
            await query(
                'UPDATE clients SET last_session = CURRENT_DATE WHERE id = $1',
                [clientId]
            );

            res.json({
                success: true,
                message: 'Gauges updated successfully'
            });

        } catch (error) {
            console.error('Update gauges error:', error);
            res.status(500).json({ error: 'Failed to update gauges' });
        }
    }
);

// Delete client (soft delete - archive)
router.delete('/:clientId', requireClientAccess, async (req, res) => {
    try {
        const { clientId } = req.params;

        await query(
            `UPDATE clients
             SET status = 'archived', archived_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [clientId]
        );

        res.json({
            success: true,
            message: 'Client archived successfully'
        });

    } catch (error) {
        console.error('Archive client error:', error);
        res.status(500).json({ error: 'Failed to archive client' });
    }
});

export default router;
