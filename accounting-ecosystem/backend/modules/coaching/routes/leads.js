/**
 * Coaching Module — Leads Routes (CJS)
 * Public POST to submit a lead, authenticated GET/PUT/DELETE for coaches.
 */
const express = require('express');
const { query } = require('../db');
const { authenticateToken, requireCoach } = require('../middleware/auth');

const router = express.Router();

// Auto-create table on startup
let tableReady = false;
async function ensureLeadsTable() {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_leads (
      id              BIGSERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT,
      phone           TEXT,
      company         TEXT,
      preferred_lang  TEXT,
      basis_answers   JSONB,
      basis_results   JSONB,
      coaching_goals  TEXT,
      wants_coaching  BOOLEAN DEFAULT FALSE,
      status          TEXT NOT NULL DEFAULT 'new',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  tableReady = true;
}
ensureLeadsTable().catch(err => console.error('[Coaching] leads table init:', err.message));

// POST /api/coaching/leads — public, no auth required
router.post('/', async (req, res) => {
  try {
    await ensureLeadsTable();
    const { name, email, phone, company, preferred_lang,
            basisAnswers, basisResults, coachingGoals, wantsCoaching } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await query(
      `INSERT INTO coaching_leads
         (name, email, phone, company, preferred_lang,
          basis_answers, basis_results, coaching_goals, wants_coaching, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
        wantsCoaching ? 'interested' : 'new'
      ]
    );
    res.status(201).json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    console.error('[Coaching] POST /leads error:', err.message);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

// All routes below require authentication
router.use(authenticateToken);
router.use(requireCoach);

// GET /api/coaching/leads
router.get('/', async (req, res) => {
  try {
    await ensureLeadsTable();
    const result = await query('SELECT * FROM coaching_leads ORDER BY created_at DESC');
    res.json({ leads: result.rows });
  } catch (err) {
    console.error('[Coaching] GET /leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// PUT /api/coaching/leads/:id
router.put('/:id', async (req, res) => {
  try {
    await ensureLeadsTable();
    const { status } = req.body;
    const result = await query(
      `UPDATE coaching_leads SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    console.error('[Coaching] PUT /leads/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// DELETE /api/coaching/leads/:id
router.delete('/:id', async (req, res) => {
  try {
    await ensureLeadsTable();
    await query('DELETE FROM coaching_leads WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Coaching] DELETE /leads/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
