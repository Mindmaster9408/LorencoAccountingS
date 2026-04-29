/**
 * Coaching Module — Assessment Token Routes (CJS)
 *
 * POST /api/coaching/assessment-tokens              — coach creates a single-use link
 * GET  /api/coaching/assessment-tokens/:token       — client validates their link (public)
 * PUT  /api/coaching/assessment-tokens/:token/complete — client submits results (public)
 *
 * Previously the entire token system lived in browser localStorage, which meant the
 * assessment link only worked in the coach's own browser.  These routes move tokens
 * to the database so any browser can validate and submit.
 */
const express = require('express');
const { query } = require('../db');
const { authenticateToken, requireCoach } = require('../middleware/auth');

const router = express.Router();

// POST /api/coaching/assessment-tokens — authenticated coach creates a token
router.post('/', authenticateToken, requireCoach, async (req, res) => {
  const { clientId, clientName } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  // Verify the client belongs to this coach
  try {
    const check = await query(
      'SELECT id FROM coaching_clients WHERE id = $1 AND coach_id = $2',
      [clientId, req.user.id]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Client not found or access denied' });
    }
  } catch (err) {
    console.error('[Coaching] Assessment token ownership check error:', err.message);
    return res.status(500).json({ error: 'Failed to verify client' });
  }

  // Generate a URL-safe token
  const raw = `${clientId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const token = Buffer.from(raw).toString('base64').replace(/[=+/]/g, '');

  try {
    await query(
      `INSERT INTO coaching_assessment_tokens (token, client_id, client_name)
       VALUES ($1, $2, $3)`,
      [token, clientId, clientName || '']
    );
    res.json({ success: true, token });
  } catch (err) {
    // Table may not exist yet (migration 022 not run)
    if (err.code === '42P01') {
      console.warn('[Coaching] coaching_assessment_tokens table missing — run migration 022.');
      return res.status(503).json({ error: 'Assessment token feature not ready. Run migration 022.' });
    }
    console.error('[Coaching] Create assessment token error:', err.message);
    res.status(500).json({ error: 'Failed to create assessment token' });
  }
});

// GET /api/coaching/assessment-tokens/:token — public, called by client portal
router.get('/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await query(
      `SELECT token, client_id, client_name, completed, expires_at
       FROM coaching_assessment_tokens
       WHERE token = $1`,
      [token]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Invalid token' });
    }
    const row = result.rows[0];

    if (row.completed) {
      return res.status(410).json({ error: 'Assessment already completed' });
    }
    if (new Date(row.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Token expired' });
    }

    res.json({
      success: true,
      tokenData: { clientId: row.client_id, clientName: row.client_name }
    });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(404).json({ error: 'Invalid token' });
    }
    console.error('[Coaching] Validate assessment token error:', err.message);
    res.status(500).json({ error: 'Failed to validate token' });
  }
});

// PUT /api/coaching/assessment-tokens/:token/complete — public, called by client portal on submit
router.put('/:token/complete', async (req, res) => {
  const { token } = req.params;
  const { clientInfo, basisAnswers, basisResults } = req.body;

  if (!basisAnswers || typeof basisAnswers !== 'object') {
    return res.status(400).json({ error: 'basisAnswers object required' });
  }
  if (!basisResults || typeof basisResults !== 'object') {
    return res.status(400).json({ error: 'basisResults object required' });
  }

  try {
    // Validate the token first
    const tokenResult = await query(
      'SELECT * FROM coaching_assessment_tokens WHERE token = $1 AND completed = FALSE',
      [token]
    );
    if (!tokenResult.rows[0]) {
      return res.status(404).json({ error: 'Invalid or already completed token' });
    }
    const row = tokenResult.rows[0];

    // Build the UPDATE for coaching_clients — always update basis data
    const updateParams = [JSON.stringify(basisAnswers), JSON.stringify(basisResults)];
    let updateSql =
      `UPDATE coaching_clients
       SET basis_answers = $1::jsonb,
           basis_results = $2::jsonb,
           last_session  = CURRENT_DATE`;
    let idx = 3;

    if (clientInfo) {
      if (clientInfo.name)           { updateSql += `, name           = $${idx++}`; updateParams.push(clientInfo.name); }
      if (clientInfo.email)          { updateSql += `, email          = $${idx++}`; updateParams.push(clientInfo.email); }
      if (clientInfo.phone)          { updateSql += `, phone          = $${idx++}`; updateParams.push(clientInfo.phone); }
      if (clientInfo.preferred_lang) { updateSql += `, preferred_lang = $${idx++}`; updateParams.push(clientInfo.preferred_lang); }
    }

    updateSql += ` WHERE id = $${idx}`;
    updateParams.push(row.client_id);

    await query(updateSql, updateParams);

    // Mark token used
    await query(
      'UPDATE coaching_assessment_tokens SET completed = TRUE, completed_at = NOW() WHERE token = $1',
      [token]
    );

    res.json({ success: true });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Assessment token feature not ready. Run migration 022.' });
    }
    console.error('[Coaching] Complete assessment error:', err.message);
    res.status(500).json({ error: 'Failed to save assessment results' });
  }
});

module.exports = router;
