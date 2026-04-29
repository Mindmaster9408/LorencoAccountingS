// basis.engine.js — Server-side BASIS scoring engine
//
// Input:  basis_answers flat object  { "BALANS_1": 7, "AKSIE_3": 5, ... }
//         Values are raw respondent answers on a 1–10 scale.
//
// Output: { sectionScores, basisOrder }
//   sectionScores: { BALANS: { score: 7.50, level: 'high' }, ... }
//   basisOrder:    ['BALANS', 'INSIG', ...]  (highest → lowest)
//
// Scale note: this engine returns averages (1–10). The legacy frontend
// scoring in basis-assessment.js returns sums (10–100). Do not mix the
// two without normalising. Integration with basis.routes.js is out of
// scope for this patch.

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

        // Patch 4: always return a valid structure with stable numeric precision
        sectionScores[sectionKey] = {
            score: Number(score.toFixed(2)),
            level: determineLevel(score)
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

export { CONFIG, determineLevel, calculateSectionScores };
