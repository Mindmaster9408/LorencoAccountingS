/**
 * Coaching Module — Question Builder Routes (CJS)
 *
 * ROUTE MAP — mounted at /api/coaching/question-builder
 * ──────────────────────────────────────────────────────────────────────────────
 * All routes require authentication.
 *
 * GLOBAL QUESTION BANK:
 *   GET    /questions                                List questions (filters: category, context_key, active)
 *   POST   /questions                               Create question
 *   PUT    /questions/:id                           Update question (partial)
 *   DELETE /questions/:id                           Soft delete (set is_active = false)
 *   GET    /contexts                                List distinct categories/contexts + standard list
 *
 * CLIENT CONTEXT QUESTIONS & ANSWERS:
 *   GET    /client/:clientId/context/:contextKey    Questions assigned to a client/context
 *   POST   /client/:clientId/context/:contextKey/assign   Assign questions to client/context
 *   PUT    /client/:clientId/context/:contextKey/answers  Save answers for assigned questions
 * ──────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const { query } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const VALID_QUESTION_TYPES = ['short_text', 'long_text', 'rating', 'yes_no', 'single_choice', 'multi_choice'];

const STANDARD_CONTEXTS = [
  { key: 'pgf.present',          label: 'PGF — Present Situation',  category: 'PGF' },
  { key: 'pgf.gap',              label: 'PGF — The Gap',            category: 'PGF' },
  { key: 'pgf.future',           label: 'PGF — Future Vision',      category: 'PGF' },
  { key: 'four_quadrants.goals', label: 'Four Quadrants — Goals',   category: 'Four Quadrants' },
  { key: 'four_quadrants.fears', label: 'Four Quadrants — Fears',   category: 'Four Quadrants' },
  { key: 'session.checkin',      label: 'Session — Check-in',       category: 'Session' },
  { key: 'session.reflection',   label: 'Session — Reflection',     category: 'Session' },
  { key: 'general',              label: 'General',                   category: 'General' },
];

// ─── Table self-creation ──────────────────────────────────────────────────────
// Idempotent — CREATE TABLE IF NOT EXISTS. Runs once on server startup.

async function ensureQuestionBuilderTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_questions (
      id                  SERIAL PRIMARY KEY,
      question_text       TEXT NOT NULL,
      question_type       TEXT NOT NULL,
      category            TEXT,
      context_key         TEXT,
      scale_min           INTEGER,
      scale_max           INTEGER,
      scale_label_min     TEXT,
      scale_label_max     TEXT,
      options             JSONB NOT NULL DEFAULT '[]'::jsonb,
      help_text           TEXT,
      is_required         BOOLEAN NOT NULL DEFAULT false,
      is_active           BOOLEAN NOT NULL DEFAULT true,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_by_user_id  INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cq_category    ON coaching_questions(category)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cq_context_key ON coaching_questions(context_key)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cq_is_active   ON coaching_questions(is_active)`);

  await query(`
    CREATE TABLE IF NOT EXISTS coaching_client_question_assignments (
      id                  SERIAL PRIMARY KEY,
      client_id           INTEGER NOT NULL,
      question_id         INTEGER NOT NULL,
      context_key         TEXT NOT NULL,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      is_active           BOOLEAN NOT NULL DEFAULT true,
      created_by_user_id  INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ccqa_client_ctx ON coaching_client_question_assignments(client_id, context_key)`);

  await query(`
    CREATE TABLE IF NOT EXISTS coaching_client_question_answers (
      id                  SERIAL PRIMARY KEY,
      client_id           INTEGER NOT NULL,
      question_id         INTEGER NOT NULL,
      context_key         TEXT NOT NULL,
      answer_text         TEXT,
      answer_number       NUMERIC,
      answer_json         JSONB,
      answered_at         TIMESTAMPTZ DEFAULT now(),
      created_by_user_id  INTEGER,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ccqans_client_ctx ON coaching_client_question_answers(client_id, context_key)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ccqans_question   ON coaching_client_question_answers(question_id)`);
}

ensureQuestionBuilderTables().catch(err =>
  console.error('[coaching/question-builder] Failed to ensure tables:', err)
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitiseStr(val, maxLen = 2000) {
  return val != null ? String(val).trim().substring(0, maxLen) : null;
}

function sanitiseInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function validateQuestionBody(body) {
  const errors = [];
  const { questionType, scaleMin, scaleMax, options } = body;
  if (questionType && !VALID_QUESTION_TYPES.includes(questionType)) {
    errors.push(`questionType must be one of: ${VALID_QUESTION_TYPES.join(', ')}`);
  }
  if (questionType === 'rating') {
    const min = sanitiseInt(scaleMin);
    const max = sanitiseInt(scaleMax);
    if (min === null || max === null) {
      errors.push('rating questions require scaleMin and scaleMax');
    } else if (min >= max) {
      errors.push('scaleMin must be less than scaleMax');
    }
  }
  if (questionType === 'single_choice' || questionType === 'multi_choice') {
    if (!Array.isArray(options) || options.length === 0) {
      errors.push('single_choice and multi_choice questions require at least one option');
    }
  }
  return errors;
}

// ─── All routes require authentication ───────────────────────────────────────
router.use(authenticateToken);

// GET /questions
router.get('/questions', async (req, res) => {
  const { category, context_key, active } = req.query;
  const conditions = [];
  const params = [];
  let p = 1;

  if (category)    { conditions.push(`category = $${p++}`);    params.push(category); }
  if (context_key) { conditions.push(`context_key = $${p++}`); params.push(context_key); }
  if (active !== undefined && active !== '') {
    conditions.push(`is_active = $${p++}`);
    params.push(active === 'true');
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await query(
      `SELECT * FROM coaching_questions ${where} ORDER BY sort_order ASC, created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[coaching/question-builder] GET /questions', err);
    res.status(500).json({ error: 'Failed to list questions.' });
  }
});

// POST /questions
router.post('/questions', async (req, res) => {
  const {
    questionText, questionType, category, contextKey,
    scaleMin, scaleMax, scaleLabelMin, scaleLabelMax,
    options, helpText, isRequired, isActive, sortOrder
  } = req.body;

  const cleanText = sanitiseStr(questionText, 2000);
  if (!cleanText) return res.status(400).json({ error: 'questionText is required.' });
  if (!questionType || !VALID_QUESTION_TYPES.includes(questionType)) {
    return res.status(400).json({ error: `questionType must be one of: ${VALID_QUESTION_TYPES.join(', ')}` });
  }
  const errors = validateQuestionBody(req.body);
  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

  const cleanOptions = Array.isArray(options) ? options.map(o => String(o).trim()).filter(Boolean) : [];

  try {
    const result = await query(
      `INSERT INTO coaching_questions (
        question_text, question_type, category, context_key,
        scale_min, scale_max, scale_label_min, scale_label_max,
        options, help_text, is_required, is_active, sort_order, created_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        cleanText, questionType,
        sanitiseStr(category, 100) || null,
        sanitiseStr(contextKey, 100) || null,
        sanitiseInt(scaleMin), sanitiseInt(scaleMax),
        sanitiseStr(scaleLabelMin, 100) || null,
        sanitiseStr(scaleLabelMax, 100) || null,
        JSON.stringify(cleanOptions),
        sanitiseStr(helpText, 1000) || null,
        Boolean(isRequired),
        isActive !== false,
        sanitiseInt(sortOrder) || 0,
        req.user.id
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[coaching/question-builder] POST /questions', err);
    res.status(500).json({ error: 'Failed to create question.' });
  }
});

// PUT /questions/:id
router.put('/questions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid question ID.' });

  const {
    questionText, questionType, category, contextKey,
    scaleMin, scaleMax, scaleLabelMin, scaleLabelMax,
    options, helpText, isRequired, isActive, sortOrder
  } = req.body;

  if (questionType !== undefined) {
    if (!VALID_QUESTION_TYPES.includes(questionType)) {
      return res.status(400).json({ error: `questionType must be one of: ${VALID_QUESTION_TYPES.join(', ')}` });
    }
    const errors = validateQuestionBody(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });
  }

  try {
    const check = await query('SELECT id FROM coaching_questions WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Question not found.' });

    const sets = ['updated_at = now()'];
    const params = [];
    let p = 1;

    if (questionText !== undefined) { sets.push(`question_text = $${p++}`); params.push(sanitiseStr(questionText, 2000)); }
    if (questionType !== undefined) { sets.push(`question_type = $${p++}`); params.push(questionType); }
    if (category      !== undefined){ sets.push(`category = $${p++}`);      params.push(sanitiseStr(category, 100) || null); }
    if (contextKey    !== undefined){ sets.push(`context_key = $${p++}`);   params.push(sanitiseStr(contextKey, 100) || null); }
    if (scaleMin      !== undefined){ sets.push(`scale_min = $${p++}`);     params.push(sanitiseInt(scaleMin)); }
    if (scaleMax      !== undefined){ sets.push(`scale_max = $${p++}`);     params.push(sanitiseInt(scaleMax)); }
    if (scaleLabelMin !== undefined){ sets.push(`scale_label_min = $${p++}`); params.push(sanitiseStr(scaleLabelMin, 100) || null); }
    if (scaleLabelMax !== undefined){ sets.push(`scale_label_max = $${p++}`); params.push(sanitiseStr(scaleLabelMax, 100) || null); }
    if (options       !== undefined){ sets.push(`options = $${p++}`);       params.push(JSON.stringify(Array.isArray(options) ? options.map(o => String(o).trim()).filter(Boolean) : [])); }
    if (helpText      !== undefined){ sets.push(`help_text = $${p++}`);     params.push(sanitiseStr(helpText, 1000) || null); }
    if (isRequired    !== undefined){ sets.push(`is_required = $${p++}`);   params.push(Boolean(isRequired)); }
    if (isActive      !== undefined){ sets.push(`is_active = $${p++}`);     params.push(Boolean(isActive)); }
    if (sortOrder     !== undefined){ sets.push(`sort_order = $${p++}`);    params.push(sanitiseInt(sortOrder) || 0); }

    params.push(id);
    const result = await query(
      `UPDATE coaching_questions SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      params
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[coaching/question-builder] PUT /questions/:id', err);
    res.status(500).json({ error: 'Failed to update question.' });
  }
});

// DELETE /questions/:id — soft delete only
router.delete('/questions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid question ID.' });

  try {
    const result = await query(
      `UPDATE coaching_questions SET is_active = false, updated_at = now()
       WHERE id = $1 RETURNING id, is_active`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Question not found.' });
    res.json({ success: true, id: result.rows[0].id, isActive: false });
  } catch (err) {
    console.error('[coaching/question-builder] DELETE /questions/:id', err);
    res.status(500).json({ error: 'Failed to deactivate question.' });
  }
});

// GET /contexts
router.get('/contexts', async (req, res) => {
  try {
    const result = await query(
      `SELECT DISTINCT category, context_key FROM coaching_questions
       WHERE is_active = true ORDER BY category, context_key`
    );
    res.json({ standard: STANDARD_CONTEXTS, inUse: result.rows });
  } catch (err) {
    console.error('[coaching/question-builder] GET /contexts', err);
    res.status(500).json({ error: 'Failed to list contexts.' });
  }
});

// GET /client/:clientId/context/:contextKey
router.get('/client/:clientId/context/:contextKey', async (req, res) => {
  const clientId   = parseInt(req.params.clientId, 10);
  const contextKey = sanitiseStr(req.params.contextKey, 100);
  if (isNaN(clientId) || !contextKey) return res.status(400).json({ error: 'Invalid clientId or contextKey.' });

  try {
    const result = await query(
      `SELECT cq.*, ccqa.id AS assignment_id, ccqa.sort_order AS assignment_sort_order
       FROM coaching_client_question_assignments ccqa
       JOIN coaching_questions cq ON cq.id = ccqa.question_id
       WHERE ccqa.client_id = $1 AND ccqa.context_key = $2 AND ccqa.is_active = true
       ORDER BY ccqa.sort_order ASC, cq.sort_order ASC`,
      [clientId, contextKey]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[coaching/question-builder] GET /client/.../context/...', err);
    res.status(500).json({ error: 'Failed to get client context questions.' });
  }
});

// POST /client/:clientId/context/:contextKey/assign
router.post('/client/:clientId/context/:contextKey/assign', async (req, res) => {
  const clientId   = parseInt(req.params.clientId, 10);
  const contextKey = sanitiseStr(req.params.contextKey, 100);
  if (isNaN(clientId) || !contextKey) return res.status(400).json({ error: 'Invalid clientId or contextKey.' });

  const { questionIds } = req.body;
  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    return res.status(400).json({ error: 'questionIds must be a non-empty array.' });
  }

  try {
    let assigned = 0;
    for (let i = 0; i < questionIds.length; i++) {
      const qId = parseInt(questionIds[i], 10);
      if (isNaN(qId)) continue;
      const existing = await query(
        `SELECT id FROM coaching_client_question_assignments
         WHERE client_id = $1 AND question_id = $2 AND context_key = $3`,
        [clientId, qId, contextKey]
      );
      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO coaching_client_question_assignments
            (client_id, question_id, context_key, sort_order, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [clientId, qId, contextKey, i, req.user.id]
        );
        assigned++;
      }
    }
    res.status(201).json({ success: true, assigned });
  } catch (err) {
    console.error('[coaching/question-builder] POST .../assign', err);
    res.status(500).json({ error: 'Failed to assign questions.' });
  }
});

// PUT /client/:clientId/context/:contextKey/answers
router.put('/client/:clientId/context/:contextKey/answers', async (req, res) => {
  const clientId   = parseInt(req.params.clientId, 10);
  const contextKey = sanitiseStr(req.params.contextKey, 100);
  if (isNaN(clientId) || !contextKey) return res.status(400).json({ error: 'Invalid clientId or contextKey.' });

  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: 'answers must be a non-empty array.' });
  }

  try {
    for (const answer of answers) {
      const qId = parseInt(answer.questionId, 10);
      if (isNaN(qId)) continue;
      const answerText   = answer.answerText   != null ? String(answer.answerText)            : null;
      const answerNumber = answer.answerNumber != null ? answer.answerNumber                   : null;
      const answerJson   = answer.answerJson   != null ? JSON.stringify(answer.answerJson)    : null;

      const existing = await query(
        `SELECT id FROM coaching_client_question_answers
         WHERE client_id = $1 AND question_id = $2 AND context_key = $3`,
        [clientId, qId, contextKey]
      );
      if (existing.rows.length > 0) {
        await query(
          `UPDATE coaching_client_question_answers
           SET answer_text = $1, answer_number = $2, answer_json = $3,
               answered_at = now(), updated_at = now()
           WHERE id = $4`,
          [answerText, answerNumber, answerJson, existing.rows[0].id]
        );
      } else {
        await query(
          `INSERT INTO coaching_client_question_answers
            (client_id, question_id, context_key, answer_text, answer_number, answer_json, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [clientId, qId, contextKey, answerText, answerNumber, answerJson, req.user.id]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[coaching/question-builder] PUT .../answers', err);
    res.status(500).json({ error: 'Failed to save answers.' });
  }
});

module.exports = router;
