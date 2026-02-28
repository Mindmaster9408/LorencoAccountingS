/**
 * Coaching Module — Client Routes (CJS)
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticateToken, requireCoach, requireClientAccess } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCoach);

// Get all clients for the logged-in coach
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;

    let queryText = `
      SELECT c.*,
             COUNT(DISTINCT cs.id) as session_count,
             MAX(cs.session_date) as last_actual_session
      FROM coaching_clients c
      LEFT JOIN coaching_client_sessions cs ON c.id = cs.client_id
      WHERE c.coach_id = $1
    `;
    const params = [req.user.id];

    if (status && status !== 'all') {
      queryText += ' AND c.status = $2';
      params.push(status);
    }

    queryText += ' GROUP BY c.id ORDER BY c.last_session DESC NULLS LAST';

    const result = await query(queryText, params);
    res.json({ success: true, clients: result.rows });
  } catch (error) {
    console.error('[Coaching] Get clients error:', error.message);
    res.status(500).json({ error: 'Failed to retrieve clients' });
  }
});

// Get single client with full details
router.get('/:clientId', requireClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;

    const clientResult = await query('SELECT * FROM coaching_clients WHERE id = $1', [clientId]);
    if (clientResult.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    const client = clientResult.rows[0];

    const [stepsResult, gaugesResult, sessionsResult] = await Promise.all([
      query('SELECT * FROM coaching_client_steps WHERE client_id = $1 ORDER BY step_order', [clientId]),
      query(
        `SELECT DISTINCT ON (gauge_key) gauge_key, gauge_value, recorded_at
         FROM coaching_client_gauges WHERE client_id = $1
         ORDER BY gauge_key, recorded_at DESC`,
        [clientId]
      ),
      query(
        `SELECT * FROM coaching_client_sessions WHERE client_id = $1
         ORDER BY session_date DESC LIMIT 10`,
        [clientId]
      )
    ]);

    const gauges = {};
    gaugesResult.rows.forEach(g => { gauges[g.gauge_key] = g.gauge_value; });

    res.json({
      success: true,
      client: { ...client, steps: stepsResult.rows, gauges, sessions: sessionsResult.rows }
    });
  } catch (error) {
    console.error('[Coaching] Get client error:', error.message);
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
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, email, phone, preferred_lang, dream } = req.body;

      const result = await query(
        `INSERT INTO coaching_clients (coach_id, name, email, phone, preferred_lang, dream, last_session)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE) RETURNING *`,
        [req.user.id, name, email || null, phone || null, preferred_lang || 'English', dream || '']
      );
      const newClient = result.rows[0];

      // Create default journey steps
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
          `INSERT INTO coaching_client_steps (client_id, step_id, step_name, step_order)
           VALUES ($1, $2, $3, $4)`,
          [newClient.id, step.id, step.name, step.order]
        );
      }

      // Create initial gauge readings (all at 50)
      const gaugeKeys = ['fuel', 'horizon', 'thrust', 'engine', 'compass', 'positive', 'weight', 'nav', 'negative'];
      for (const gaugeKey of gaugeKeys) {
        await query(
          `INSERT INTO coaching_client_gauges (client_id, gauge_key, gauge_value) VALUES ($1, $2, 50)`,
          [newClient.id, gaugeKey]
        );
      }

      res.status(201).json({ success: true, message: 'Client created successfully', client: newClient });
    } catch (error) {
      console.error('[Coaching] Create client error:', error.message);
      res.status(500).json({ error: 'Failed to create client' });
    }
  }
);

// Update client
router.put('/:clientId', requireClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, email, phone, preferred_lang, status, dream, current_step, progress_completed } = req.body;

    const result = await query(
      `UPDATE coaching_clients
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           phone = COALESCE($3, phone),
           preferred_lang = COALESCE($4, preferred_lang),
           status = COALESCE($5, status),
           dream = COALESCE($6, dream),
           current_step = COALESCE($7, current_step),
           progress_completed = COALESCE($8, progress_completed),
           last_session = CURRENT_DATE
       WHERE id = $9 RETURNING *`,
      [name, email, phone, preferred_lang, status, dream, current_step, progress_completed, clientId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    res.json({ success: true, message: 'Client updated successfully', client: result.rows[0] });
  } catch (error) {
    console.error('[Coaching] Update client error:', error.message);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// Update client gauges
router.put('/:clientId/gauges', requireClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { gauges } = req.body;

    if (!gauges || typeof gauges !== 'object') {
      return res.status(400).json({ error: 'Gauges object required' });
    }

    for (const [gaugeKey, gaugeValue] of Object.entries(gauges)) {
      await query(
        `INSERT INTO coaching_client_gauges (client_id, gauge_key, gauge_value) VALUES ($1, $2, $3)`,
        [clientId, gaugeKey, gaugeValue]
      );
    }

    await query('UPDATE coaching_clients SET last_session = CURRENT_DATE WHERE id = $1', [clientId]);

    res.json({ success: true, message: 'Gauges updated successfully' });
  } catch (error) {
    console.error('[Coaching] Update gauges error:', error.message);
    res.status(500).json({ error: 'Failed to update gauges' });
  }
});

// Archive client
router.delete('/:clientId', requireClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    await query(
      `UPDATE coaching_clients SET status = 'archived', archived_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [clientId]
    );
    res.json({ success: true, message: 'Client archived successfully' });
  } catch (error) {
    console.error('[Coaching] Archive client error:', error.message);
    res.status(500).json({ error: 'Failed to archive client' });
  }
});

module.exports = router;
