/**
 * ============================================================================
 * SEAN AI — Coaching Engine (Rule-Based)
 * ============================================================================
 * Rule-based pattern matching and signal detection for the coaching module.
 *
 * IMPORTANT DISCLAIMERS:
 *   - This engine detects COACHING SIGNALS only.
 *   - Signals are NOT medical, psychiatric, or psychological diagnoses.
 *   - Labels like "anxious" or "isolated" describe the input text pattern,
 *     not a clinical assessment of the person.
 *   - The engine must never present output as a diagnosis or therapy.
 *   - Uncertainty must be expressed clearly when confidence is low.
 *
 * Design mirrors knowledge-base.js scoring:
 *   - trigger_phrase match: +10 per keyword (high weight, like title match)
 *   - context match:        +1  per keyword (lower weight, like content match)
 *   - emotional_state match: +5  bonus
 *   - Confidence normalised to [0..1]
 *
 * No external APIs. No LLM. No browser-side state. Pure server-side logic.
 * ============================================================================
 */

'use strict';

// ─── Personality / Emotional Signal Rules ─────────────────────────────────────
// Each rule defines a coaching signal label, the keyword patterns that indicate
// it, and a weight multiplier.
//
// These are COACHING SIGNALS — not clinical diagnoses.
// Adding more keywords here refines detection without changing any other code.
const SIGNAL_RULES = [
    {
        label: 'control_perfectionism',
        description: 'Signals around need for control, perfectionism, or rigid rule-following',
        keywords: [
            'moet', 'perfek', 'beheer', 'reg doen', 'reël', 'stiptelik',
            'altyd reg', 'nooit fout', 'fout', 'perfeksie', 'standaard',
            'should', 'must', 'perfect', 'control', 'rules', 'always right',
            'never wrong', 'correct', 'strict'
        ],
        weight: 1.5
    },
    {
        label: 'isolated_disconnected',
        description: 'Signals around feeling alone, misunderstood, or cut off from others',
        keywords: [
            'niemand verstaan', 'alleen', 'ek is afgesonder', 'eensaam',
            'afgesny', 'niemand luister', 'isolasie', 'misunderstood',
            'alone', 'isolated', 'no one understands', 'cut off', 'lonely',
            'nobody listens', 'disconnected'
        ],
        weight: 1.5
    },
    {
        label: 'passive_stuck',
        description: 'Signals around feeling trapped, unable to act, or helpless',
        keywords: [
            'vasgevang', 'kan nie beweeg', 'ek weet nie wat om te doen nie',
            'verlam', 'vasval', 'geen keuse', 'hopeloos', 'trapped',
            'stuck', 'cant move', "don't know what to do", 'paralysed',
            'no choice', 'hopeless', 'helpless', 'frozen'
        ],
        weight: 1.5
    },
    {
        label: 'anxious_overwhelmed',
        description: 'Signals around fear, anxiety, stress, or feeling overwhelmed',
        keywords: [
            'bang', 'angstig', 'oorweldig', 'stres', 'bekommerd', 'angs',
            'oorlaai', 'vrees', 'afraid', 'anxious', 'overwhelmed', 'stress',
            'worried', 'fear', 'overloaded', 'panic', 'scared', 'nervous'
        ],
        weight: 1.3
    },
    {
        label: 'motivated_action',
        description: 'Signals around readiness to act, motivation, and forward movement',
        keywords: [
            'ek wil', 'ek gaan', 'kom ons doen', 'regkom', 'vooruit',
            'verandering', 'besluit', 'doen', 'i want', 'i will', "let's do",
            'move forward', 'change', 'decide', 'action', 'ready', 'going to'
        ],
        weight: 1.0
    },
    {
        label: 'grief_loss',
        description: 'Signals around grief, loss, or mourning',
        keywords: [
            'verlies', 'rou', 'gemis', 'oorlede', 'dood', 'hartseer',
            'loss', 'grief', 'missing', 'deceased', 'death', 'sad', 'heartbreak',
            'mourning', 'bereaved'
        ],
        weight: 1.4
    },
    {
        label: 'relationship_conflict',
        description: 'Signals around conflict, tension, or issues in relationships',
        keywords: [
            'konflik', 'rusie', 'verhouding', 'vrou', 'man', 'kind', 'ouers',
            'conflict', 'fight', 'relationship', 'wife', 'husband', 'child',
            'parents', 'argument', 'tension', 'friction'
        ],
        weight: 1.2
    }
];

// ─── identifyPersonalitySignals ───────────────────────────────────────────────

/**
 * Detects coaching signals in the input text by matching against SIGNAL_RULES.
 *
 * Returns:
 *   {
 *     signals: [{ label, score, matchedKeywords, weight }],
 *     dominant: string | null,   — label with highest score
 *     signalCount: number
 *   }
 *
 * COACHING SIGNALS ONLY — not medical diagnoses.
 *
 * @param {string} inputText
 * @returns {{ signals: Array, dominant: string|null, signalCount: number }}
 */
function identifyPersonalitySignals(inputText) {
    const text = (inputText || '').toLowerCase();
    const detected = [];

    for (const rule of SIGNAL_RULES) {
        let score = 0;
        const matchedKeywords = [];

        for (const keyword of rule.keywords) {
            if (text.includes(keyword.toLowerCase())) {
                score += rule.weight;
                matchedKeywords.push(keyword);
            }
        }

        if (score > 0) {
            detected.push({
                label: rule.label,
                score: parseFloat(score.toFixed(4)),
                matchedKeywords,
                weight: rule.weight
            });
        }
    }

    detected.sort((a, b) => b.score - a.score);

    return {
        signals: detected,
        dominant: detected.length > 0 ? detected[0].label : null,
        signalCount: detected.length
    };
}

// ─── scoreCaseMatch ───────────────────────────────────────────────────────────

/**
 * Score how well a single coaching case matches the input.
 * Scoring mirrors knowledge-base.js:
 *   - trigger_phrase keyword match: +10 per keyword (high weight)
 *   - context keyword match:        +1  per keyword
 *   - emotional_state exact match:  +5  bonus
 *   - dominant signal match:        +3  bonus
 *
 * @param {string}   inputText
 * @param {string|null} emotionalState
 * @param {string|null} dominantSignal
 * @param {object}   caseRecord   — row from sean_coaching_cases
 * @returns {number} rawScore
 */
function scoreCaseMatch(inputText, emotionalState, dominantSignal, caseRecord) {
    const text = inputText.toLowerCase();
    const keywords = text.split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return 0;

    let score = 0;

    // Trigger phrase match — high weight (like title in knowledge-base.js)
    const trigger = (caseRecord.trigger_phrase || '').toLowerCase();
    for (const kw of keywords) {
        if (trigger.includes(kw)) score += 10;
    }

    // Context match — lower weight (like content in knowledge-base.js)
    const context = (caseRecord.context || '').toLowerCase();
    for (const kw of keywords) {
        if (context.includes(kw)) score += 1;
    }

    // Emotional state exact match bonus
    if (emotionalState && caseRecord.emotional_state &&
        caseRecord.emotional_state.toLowerCase() === emotionalState.toLowerCase()) {
        score += 5;
    }

    // Dominant signal alignment bonus
    if (dominantSignal && caseRecord.personality_signals) {
        const storedSignals = caseRecord.personality_signals;
        const storedDominant = storedSignals.dominant;
        if (storedDominant && storedDominant === dominantSignal) {
            score += 3;
        }
    }

    return score;
}

// ─── findSimilarCases ─────────────────────────────────────────────────────────

/**
 * Retrieve cases from the DB for the given company, score each one against the
 * input, and return those above the minimum threshold — sorted by confidence
 * descending.
 *
 * Confidence is normalised by the theoretical maximum score:
 *   maxPossible = keywords.length × 10  (all keywords match trigger_phrase)
 * Capped at 1.0.
 *
 * @param {string}   inputText
 * @param {number}   companyId
 * @param {object}   supabase       — Supabase client from config/database
 * @param {object}   [signalResult] — result of identifyPersonalitySignals()
 * @param {number}   [minConfidence=0.0] — minimum confidence to include
 * @returns {Promise<Array<{ case: object, confidence: number, rawScore: number }>>}
 */
async function findSimilarCases(inputText, companyId, supabase, signalResult, minConfidence = 0.0) {
    const { data: cases, error } = await supabase
        .from('sean_coaching_cases')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(200); // Score top 200 most recent; sufficient for company-scale coaching stores

    if (error) {
        console.error('[coaching-engine] findSimilarCases DB error:', error.message);
        return [];
    }

    if (!cases || cases.length === 0) return [];

    const keywords = inputText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const maxPossible = keywords.length * 10 || 1; // avoid division by zero

    const emotionalState = signalResult?.dominant || null;
    const dominantSignal = signalResult?.dominant || null;

    const scored = cases.map(c => {
        const rawScore = scoreCaseMatch(inputText, emotionalState, dominantSignal, c);
        const confidence = Math.min(rawScore / maxPossible, 1.0);
        return { case: c, confidence: parseFloat(confidence.toFixed(4)), rawScore };
    });

    return scored
        .filter(s => s.confidence >= minConfidence)
        .sort((a, b) => b.confidence - a.confidence);
}

// ─── buildPattern ─────────────────────────────────────────────────────────────

/**
 * Given a set of scored similar cases, builds a summary pattern:
 * - Finds the dominant pattern_group
 * - Finds the dominant emotional_state
 * - Finds the most frequently used response
 * - Aggregates confidence
 *
 * @param {Array<{ case: object, confidence: number }>} scoredCases
 * @returns {{ patternGroup: string|null, emotionalState: string|null, bestResponse: string|null, avgConfidence: number, caseCount: number }}
 */
function buildPattern(scoredCases) {
    if (!scoredCases || scoredCases.length === 0) {
        return { patternGroup: null, emotionalState: null, bestResponse: null, avgConfidence: 0, caseCount: 0 };
    }

    // Count pattern_group occurrences (weighted by confidence)
    const groupScores = {};
    const emotionScores = {};
    const responseScores = {};

    for (const sc of scoredCases) {
        const c = sc.case;
        const weight = sc.confidence;

        if (c.pattern_group) {
            groupScores[c.pattern_group] = (groupScores[c.pattern_group] || 0) + weight;
        }
        if (c.emotional_state) {
            emotionScores[c.emotional_state] = (emotionScores[c.emotional_state] || 0) + weight;
        }
        if (c.response_used) {
            responseScores[c.response_used] = (responseScores[c.response_used] || 0) + weight;
        }
    }

    const topGroup    = Object.entries(groupScores).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topEmotion  = Object.entries(emotionScores).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topResponse = Object.entries(responseScores).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const avgConfidence = scoredCases.reduce((s, c) => s + c.confidence, 0) / scoredCases.length;

    return {
        patternGroup:   topGroup,
        emotionalState: topEmotion,
        bestResponse:   topResponse,
        avgConfidence:  parseFloat(avgConfidence.toFixed(4)),
        caseCount:      scoredCases.length
    };
}

// ─── suggestResponse ──────────────────────────────────────────────────────────

/**
 * Given a built pattern, returns the suggested coaching response text.
 *
 * If the pattern has a bestResponse, returns it.
 * If confidence is high enough but no stored response exists, returns a
 * signal-aware placeholder framing.
 * If confidence is too low, returns the uncertainty prompt.
 *
 * @param {object}      pattern        — output of buildPattern()
 * @param {string|null} emotionalState — detected emotional state from signals
 * @param {number}      confidence     — top case confidence score
 * @returns {{ response: string, source: 'stored'|'signal_aware'|'uncertain' }}
 */
function suggestResponse(pattern, emotionalState, confidence) {
    const CONFIDENCE_THRESHOLD = 0.65;

    if (confidence < CONFIDENCE_THRESHOLD) {
        return {
            response: 'Ek leer nog hieroor. Kan jy my help om hierdie situasie beter te verstaan?',
            source: 'uncertain'
        };
    }

    if (pattern.bestResponse) {
        return {
            response: pattern.bestResponse,
            source: 'stored'
        };
    }

    // No stored response, but we have a pattern — produce a signal-aware placeholder
    const stateHint = emotionalState || pattern.emotionalState || 'hierdie';
    const signalFrames = {
        'control_perfectionism': `Dit klink asof daar 'n sterk behoefte aan orde en korrektheid is. Gesamentlik kan ons kyk hoe om balans te vind.`,
        'isolated_disconnected': `Dit klink asof verbinding en begrip op hierdie oomblik belangrik is. Jy is nie alleen nie.`,
        'passive_stuck':         `Dit klink asof jy op hierdie oomblik vasgevang voel. Watter een klein stap kan ons saam identifiseer?`,
        'anxious_overwhelmed':   `Dit klink asof angs en oorweldiging teenwoordig is. Kom ons kyk saam wat die druk kan verlig.`,
        'motivated_action':      `Dit klink asof jy gereed is vir beweging. Watter konkrete stappe kan ons saam beplan?`,
        'grief_loss':            `Dit klink asof verlies teenwoordig is. Ek is hier om te luister — wanneer is jy gereed om te deel?`,
        'relationship_conflict': `Dit klink asof daar spanning in 'n verhouding is. Watter perspektief wil jy eerste deel?`
    };

    const frame = signalFrames[stateHint] || `Ek hoor jou. Vertel my meer sodat ek beter kan help.`;

    return {
        response: frame,
        source: 'signal_aware'
    };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    identifyPersonalitySignals,
    findSimilarCases,
    buildPattern,
    suggestResponse,
    SIGNAL_RULES,
    CONFIDENCE_THRESHOLD: 0.65
};
