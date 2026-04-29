// basis.engine.js — Server-side BASIS scoring engine
//
// Input:  basis_answers flat object  { "BALANS_1": 7, "AKSIE_3": 5, ... }
//         Values are raw respondent answers on a 1–10 scale.
//
// scoreBasisAnswers() internal output — sectionScores per section:
//   { score: 7.50,  level: 'high', sum: 70 }
//   score = average  1–10 (used for ranking + level)
//   sum   = adjusted integer total 0–100 (legacy-compatible)
//
// toLegacyBasisResults() — output stored in basis_results column:
//   { sectionScores: { BALANS: 70, ... }, basisOrder: [...], timestamp, computedBy: 'server' }
//   sectionScores values are plain integers matching the legacy frontend calculateSectionScore()
//   output exactly (same reverse-scoring formula, same range 0–100).

function buildKeys(prefix, count) {
    return Array.from({ length: count }, (_, i) => `${prefix}_${i + 1}`);
}

const CONFIG = {
    sections: {
        BALANS: {
            questions: buildKeys('BALANS', 10),
            reverse:   new Set(['BALANS_9', 'BALANS_10'])
        },
        AKSIE: {
            questions: buildKeys('AKSIE', 10),
            reverse:   new Set(['AKSIE_9', 'AKSIE_10'])
        },
        SORG: {
            questions: buildKeys('SORG', 10),
            reverse:   new Set(['SORG_9', 'SORG_10'])
        },
        INSIG: {
            questions: buildKeys('INSIG', 10),
            reverse:   new Set(['INSIG_9', 'INSIG_10'])
        },
        STRUKTUUR: {
            questions: buildKeys('STRUKTUUR', 10),
            reverse:   new Set(['STRUKTUUR_9', 'STRUKTUUR_10'])
        }
    },
    interpretation: {
        high:   { threshold: 7 },
        medium: { threshold: 4 }
    }
};

// Patch 5 — determineLevel: defensive against non-numeric input
function determineLevel(score) {
    if (typeof score !== 'number' || isNaN(score)) return 'low';
    if (score >= CONFIG.interpretation.high.threshold)   return 'high';
    if (score >= CONFIG.interpretation.medium.threshold) return 'medium';
    return 'low';
}

// Reverse-scored questions invert the 1–10 scale (1→10, 10→1)
function applyReverseScoring(value, questionKey, section) {
    return section.reverse.has(questionKey) ? 11 - value : value;
}

// Patches 1–4 — calculateSectionScores: unknown keys ignored,
// NaN-safe, division-safe, guaranteed output shape per section
function calculateSectionScores(answers) {
    const sectionScores = {};

    Object.entries(CONFIG.sections).forEach(([sectionKey, section]) => {
        let total = 0;
        let count = 0;

        Object.entries(answers || {}).forEach(([questionKey, rawValue]) => {
            // Patch 1: skip question keys that do not belong to this section
            if (!section.questions.includes(questionKey)) return;

            // Patch 2: numeric safety — coerce and discard non-numeric values
            const value = Number(rawValue);
            if (isNaN(value)) return;

            total += applyReverseScoring(value, questionKey, section);
            count += 1;
        });

        // Patch 3: division safety
        const score = count > 0 ? (total / count) : 0;

        // Patch 4: always return a valid structure with stable numeric precision.
        // sum is the exact integer total that matches the legacy frontend
        // calculateSectionScore() output (same formula, same 0–100 range).
        sectionScores[sectionKey] = {
            score: Number(score.toFixed(2)),
            level: determineLevel(score),
            sum:   Math.round(total)       // integer 0–100, legacy-compatible
        };
    });

    return sectionScores;
}

function rankSections(sectionScores) {
    return Object.entries(sectionScores)
        .sort((a, b) => b[1].score - a[1].score)
        .map(([key]) => key);
}

// Primary export — takes the flat basis_answers object from the DB / request body
export function scoreBasisAnswers(answers) {
    const sectionScores = calculateSectionScores(answers);
    const basisOrder    = rankSections(sectionScores);
    return { sectionScores, basisOrder };
}

// Converts engine output to the legacy format expected by generateBASISReport()
// and the basis-ui.js displayResults() function.
//
// Legacy contract (basis-assessment.js getBASISResults):
//   sectionScores[key] = integer (sum of adjusted answers, 0–100)
//   basisOrder         = string[] (section keys, highest to lowest)
//
// This function produces an identical result to the frontend getBASISResults()
// for fully-answered submissions (all 50 questions present). For partial
// submissions the sum reflects only the answered questions (no defaulting to 5).
export function toLegacyBasisResults(engineOutput) {
    const legacySectionScores = {};

    for (const [key, val] of Object.entries(engineOutput.sectionScores)) {
        legacySectionScores[key] = val.sum;
    }

    return {
        sectionScores: legacySectionScores,
        basisOrder:    engineOutput.basisOrder,
        timestamp:     new Date().toISOString(),
        computedBy:    'server'
    };
}

// Flat set of all valid question keys across all sections — used by routes
// for completeness validation without re-building on every request.
export const ALL_QUESTION_KEYS = new Set(
    Object.values(CONFIG).length > 0
        ? Object.values(CONFIG.sections).flatMap(s => s.questions)
        : []
);

export const TOTAL_QUESTIONS = ALL_QUESTION_KEYS.size; // 50

export { CONFIG, determineLevel, calculateSectionScores };
