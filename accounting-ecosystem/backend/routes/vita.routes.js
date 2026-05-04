'use strict';

/**
 * vita.routes.js — VITA Report API Routes
 *
 * Mounted at /api/vita in server.js
 *
 * POST /api/vita/report
 *   Body:    { ranking: string[] }  — 6 ordered VITA dimension keys
 *   Returns: { report: { markdown, generatedAt } }
 *
 * Validation:
 *   - ranking must be an array of exactly 6 strings
 *   - all 6 VITA dimensions must be present
 *   - no duplicates
 *   - no invalid strings
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { generateVitaReport } = require('../domain/vita.report');

const router = express.Router();

router.use(authenticateToken);

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_DIMENSIONS = new Set([
  'STRUKTUUR', 'PRESTASIE', 'INSIG', 'LIEFDE', 'EMOSIE', 'INISIATIEF',
]);

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate the ranking array.
 * @param {*} ranking
 * @returns {string|null} — error message, or null if valid
 */
function validateRanking(ranking) {
  if (!Array.isArray(ranking)) {
    return 'ranking must be an array of 6 dimension strings.';
  }
  if (ranking.length !== 6) {
    return `ranking must contain exactly 6 dimensions. Got ${ranking.length}.`;
  }
  const seen = new Set();
  for (const dim of ranking) {
    if (typeof dim !== 'string') {
      return `Each dimension must be a string. Got: ${JSON.stringify(dim)}`;
    }
    if (!VALID_DIMENSIONS.has(dim)) {
      return `Invalid dimension: "${dim}". Must be one of: ${[...VALID_DIMENSIONS].join(', ')}`;
    }
    if (seen.has(dim)) {
      return `Duplicate dimension: "${dim}". Each dimension must appear exactly once.`;
    }
    seen.add(dim);
  }
  return null;
}

// ─── POST /api/vita/report ────────────────────────────────────────────────────

router.post('/report', (req, res) => {
  const { ranking } = req.body;

  const validationError = validateRanking(ranking);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const report = generateVitaReport(ranking);
    return res.status(200).json({ report });
  } catch (err) {
    console.error('[vita] POST /report engine error:', err.message);
    return res.status(500).json({ error: 'Failed to generate VITA report. Internal error.' });
  }
});

module.exports = router;
