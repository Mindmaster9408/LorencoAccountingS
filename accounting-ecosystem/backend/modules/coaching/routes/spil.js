/**
 * Coaching Module — SPIL/VITA Profile Routes (CJS)
 * Mounts under /api/coaching/spil
 */
const express = require('express');
const { query } = require('../db');
const { authenticateToken, requireCoach } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCoach);

// ─── Ensure Table Exists ─────────────────────────────────────────────────────
async function ensureSpilTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_spil_profiles (
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
  await query(`CREATE INDEX IF NOT EXISTS idx_coaching_spil_client ON coaching_spil_profiles(linked_client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_coaching_spil_user   ON coaching_spil_profiles(created_by_user_id)`);
}

ensureSpilTable().catch(err =>
  console.error('[coaching/spil] Failed to ensure table:', err.message)
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SPIL_DIMENSIONS = ['STRUKTUUR', 'PRESTASIE', 'INSIG', 'LIEFDE', 'EMOSIE', 'INISIATIEF'];

function sanitiseAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!/^(STRUKTUUR|PRESTASIE|INSIG|LIEFDE|EMOSIE|INISIATIEF)_([1-9]|10)$/.test(key)) continue;
    const n = Number(val);
    if (isNaN(n) || n < 1 || n > 10) continue;
    clean[key] = n;
  }
  return clean;
}

function calculateScores(answers) {
  const scores = {};
  for (const dim of SPIL_DIMENSIONS) {
    let sum = 0;
    for (let i = 1; i <= 10; i++) {
      sum += answers[`${dim}_${i}`] || 0;
    }
    scores[dim] = sum;
  }
  return scores;
}

const TIE_BREAKER = ['STRUKTUUR', 'PRESTASIE', 'INSIG', 'LIEFDE', 'EMOSIE', 'INISIATIEF'];

function rankDimensions(scores) {
  return [...SPIL_DIMENSIONS].sort((a, b) => {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return TIE_BREAKER.indexOf(a) - TIE_BREAKER.indexOf(b);
  });
}

function buildResults(answers) {
  const scores = calculateScores(answers);
  const ranking = rankDimensions(scores);
  const spil_code = ranking.join(' – ');
  const answeredCount = Object.keys(answers).length;
  return { scores, ranking, spil_code, answeredCount, isComplete: answeredCount === 60 };
}

// ─── GET /api/coaching/spil ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, respondent_name, respondent_email, respondent_phone,
              preferred_lang, spil_code, linked_client_id,
              (scores IS NOT NULL) AS has_results,
              (report_generated IS NOT NULL) AS has_report,
              created_at, updated_at
       FROM coaching_spil_profiles
       WHERE created_by_user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[coaching/spil] GET /', err.message);
    res.status(500).json({ error: 'Failed to list VITA profiles.' });
  }
});

// ─── POST /api/coaching/spil ─────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { respondent_name, respondent_email, respondent_phone, preferred_lang, linked_client_id, answers } = req.body;

  if (!respondent_name || !String(respondent_name).trim()) {
    return res.status(400).json({ error: 'respondent_name is required.' });
  }

  const cleanAnswers = answers ? sanitiseAnswers(answers) : {};
  let scores = null, ranking = null, spil_code = null;

  if (Object.keys(cleanAnswers).length === 60) {
    const results = buildResults(cleanAnswers);
    scores = results.scores;
    ranking = results.ranking;
    spil_code = results.spil_code;
  }

  try {
    const result = await query(
      `INSERT INTO coaching_spil_profiles
         (respondent_name, respondent_email, respondent_phone, preferred_lang,
          answers, scores, ranking, spil_code, created_by_user_id, linked_client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        String(respondent_name).trim(),
        respondent_email || null,
        respondent_phone || null,
        preferred_lang || 'en',
        JSON.stringify(cleanAnswers),
        scores   ? JSON.stringify(scores)  : null,
        ranking  ? JSON.stringify(ranking) : null,
        spil_code || null,
        req.user.id,
        linked_client_id ? parseInt(linked_client_id, 10) : null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[coaching/spil] POST /', err.message);
    res.status(500).json({ error: 'Failed to create VITA profile.' });
  }
});

// ─── GET /api/coaching/spil/:id ──────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id.' });

  try {
    const result = await query(
      `SELECT * FROM coaching_spil_profiles WHERE id = $1 AND created_by_user_id = $2`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'VITA profile not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[coaching/spil] GET /:id', err.message);
    res.status(500).json({ error: 'Failed to retrieve VITA profile.' });
  }
});

// ─── PUT /api/coaching/spil/:id ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id.' });

  const { answers, respondent_name, respondent_email, respondent_phone, preferred_lang } = req.body;
  if (!answers) return res.status(400).json({ error: 'answers is required.' });

  const cleanAnswers = sanitiseAnswers(answers);
  if (Object.keys(cleanAnswers).length < 60) {
    return res.status(422).json({ error: `Incomplete answers. ${Object.keys(cleanAnswers).length}/60 valid answers provided.` });
  }

  const results = buildResults(cleanAnswers);

  try {
    const check = await query(
      `SELECT id, respondent_name FROM coaching_spil_profiles WHERE id = $1 AND created_by_user_id = $2`,
      [id, req.user.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'VITA profile not found.' });

    const updated = await query(
      `UPDATE coaching_spil_profiles
       SET answers          = $1,
           scores           = $2,
           ranking          = $3,
           spil_code        = $4,
           respondent_name  = COALESCE($5, respondent_name),
           respondent_email = COALESCE($6, respondent_email),
           respondent_phone = COALESCE($7, respondent_phone),
           preferred_lang   = COALESCE($8, preferred_lang),
           updated_at       = now()
       WHERE id = $9 AND created_by_user_id = $10
       RETURNING *`,
      [
        JSON.stringify(cleanAnswers),
        JSON.stringify(results.scores),
        JSON.stringify(results.ranking),
        results.spil_code,
        respondent_name ? String(respondent_name).trim() : null,
        respondent_email || null,
        respondent_phone || null,
        preferred_lang || null,
        id,
        req.user.id
      ]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    console.error('[coaching/spil] PUT /:id', err.message);
    res.status(500).json({ error: 'Failed to update VITA profile.' });
  }
});

module.exports = router;