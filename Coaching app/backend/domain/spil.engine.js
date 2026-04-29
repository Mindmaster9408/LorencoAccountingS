// spil.engine.js — SPIL-E Profile scoring engine
//
// Input:  answers flat object  { "STRUKTUUR_1": 7, "PRESTASIE_3": 5, ... }
//         Values are respondent answers on a 1–10 scale.
//
// Scoring model: simple SUM per dimension (no reverse scoring).
//   Dimension total = sum of valid answers for that dimension's 10 questions.
//   Range: 0 (unanswered) → 100 (all 10 answered at max 10).
//
// Safe-by-default: unknown keys are silently ignored, NaN values are discarded,
// partial answers calculate from answered questions only (no defaulting to 5),
// null/undefined input returns zero scores without throwing.

import {
    SPIL_STRUCTURE,
    ALL_SPIL_KEYS,
    SPIL_DIMENSIONS,
    TOTAL_SPIL_QUESTIONS
} from './spil.config.js';

const { dimensions, tieBreakerOrder } = SPIL_STRUCTURE;

// ─── calculateScores ─────────────────────────────────────────────────────────
// Returns raw dimension totals.
//
// Output: { STRUKTUUR: 72, PRESTASIE: 65, INSIG: 80, LIEFDE: 55, EMOSIE: 60, INISIATIEF: 78 }
//
// Partial answers: only answered questions are summed.
// Missing dimension keys get 0.
export function calculateScores(answers) {
    const scores = {};
    const safe = answers && typeof answers === 'object' ? answers : {};

    for (const dim of SPIL_DIMENSIONS) {
        let total = 0;

        for (let i = 1; i <= SPIL_STRUCTURE.scoring.questionsPerDimension; i++) {
            const key = `${dim}_${i}`;
            const raw = safe[key];

            // Discard missing, non-numeric, and out-of-range values
            if (raw === undefined || raw === null) continue;
            const value = Number(raw);
            if (isNaN(value)) continue;
            if (value < SPIL_STRUCTURE.scoring.minPerQuestion ||
                value > SPIL_STRUCTURE.scoring.maxPerQuestion) continue;

            total += value;
        }

        scores[dim] = total;
    }

    return scores;
}

// ─── rankDimensions ───────────────────────────────────────────────────────────
// Sort dimensions highest to lowest score.
// Tie-breaker: the dimension that appears earlier in tieBreakerOrder ranks higher
// when two dimensions share the same score.
//
// Input:  { STRUKTUUR: 72, PRESTASIE: 65, ... }
// Output: ["INSIG", "INISIATIEF", "PRESTASIE", "STRUKTUUR", "EMOSIE", "LIEFDE"]
export function rankDimensions(scores) {
    return Object.keys(scores).sort((a, b) => {
        const scoreDiff = (scores[b] ?? 0) - (scores[a] ?? 0);
        if (scoreDiff !== 0) return scoreDiff;

        // Equal scores — apply tie-breaker order
        const tieA = tieBreakerOrder.indexOf(a);
        const tieB = tieBreakerOrder.indexOf(b);

        // Unknown dimensions (not in tieBreakerOrder) go last
        const safeA = tieA === -1 ? 999 : tieA;
        const safeB = tieB === -1 ? 999 : tieB;

        return safeA - safeB;
    });
}

// ─── generateSpilCode ─────────────────────────────────────────────────────────
// Converts ranked array into the human-readable SPIL code string.
//
// Input:  ["INSIG", "INISIATIEF", "PRESTASIE", "EMOSIE", "LIEFDE", "STRUKTUUR"]
// Output: "INSIG – INISIATIEF – PRESTASIE – EMOSIE – LIEFDE – STRUKTUUR"
export function generateSpilCode(ranking) {
    if (!Array.isArray(ranking) || ranking.length === 0) return '';
    return ranking.join(' \u2013 '); // en-dash, as per brief
}

// ─── buildResults ─────────────────────────────────────────────────────────────
// Full pipeline: answers → scores → ranking → SPIL code.
//
// Output:
// {
//   scores:      { STRUKTUUR: 72, PRESTASIE: 65, ... },
//   ranking:     ["INSIG", "INISIATIEF", ...],
//   spilCode:    "INSIG – INISIATIEF – ...",
//   generatedAt: "2026-04-29T10:00:00.000Z"
// }
export function buildResults(answers) {
    const scores      = calculateScores(answers);
    const ranking     = rankDimensions(scores);
    const spilCode    = generateSpilCode(ranking);
    const generatedAt = new Date().toISOString();

    return { scores, ranking, spilCode, generatedAt };
}

// ─── validateAnswers ──────────────────────────────────────────────────────────
// Returns { valid: bool, answeredCount: int, missingKeys: string[] }
// Routes use this to reject incomplete submissions.
export function validateAnswers(answers) {
    const safe = answers && typeof answers === 'object' ? answers : {};
    const missingKeys = [];
    let answeredCount = 0;

    for (const key of ALL_SPIL_KEYS) {
        const raw = safe[key];
        if (raw === undefined || raw === null) {
            missingKeys.push(key);
            continue;
        }
        const value = Number(raw);
        if (isNaN(value) ||
            value < SPIL_STRUCTURE.scoring.minPerQuestion ||
            value > SPIL_STRUCTURE.scoring.maxPerQuestion) {
            missingKeys.push(key);
            continue;
        }
        answeredCount++;
    }

    return {
        valid: missingKeys.length === 0,
        answeredCount,
        totalRequired: TOTAL_SPIL_QUESTIONS,
        missingKeys
    };
}

export { SPIL_DIMENSIONS, TOTAL_SPIL_QUESTIONS, ALL_SPIL_KEYS };
