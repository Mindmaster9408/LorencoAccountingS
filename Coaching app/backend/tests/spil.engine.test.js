// spil.engine.test.js — SPIL-E Engine unit tests
// Run: node backend/tests/spil.engine.test.js
// Requires Node >= 18 (uses built-in node:test + node:assert)
//
// Test coverage:
//  1. All 60 answers → correct dimension totals
//  2. Ranking order is correct (highest → lowest)
//  3. Tie-breaker resolves correctly
//  4. SPIL code string has correct format
//  5. Missing answers are handled safely (no crash, no throw)
//  6. Invalid values (out-of-range, non-numeric) are ignored
//  7. INISIATIEF top-3 detection works correctly
//  8. Lowest dimension is detected correctly

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateScores,
    rankDimensions,
    generateSpilCode,
    buildResults,
    validateAnswers,
    SPIL_DIMENSIONS,
    TOTAL_SPIL_QUESTIONS
} from '../domain/spil.engine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIMS = ['STRUKTUUR', 'PRESTASIE', 'INSIG', 'LIEFDE', 'EMOSIE', 'INISIATIEF'];

// Build a full answer set for one dimension where every question = value
function fullDimAnswers(dim, value) {
    const answers = {};
    for (let i = 1; i <= 10; i++) {
        answers[`${dim}_${i}`] = value;
    }
    return answers;
}

// Build a complete answer set across all dimensions
function allAnswers(valueByDim) {
    let result = {};
    for (const [dim, value] of Object.entries(valueByDim)) {
        Object.assign(result, fullDimAnswers(dim, value));
    }
    return result;
}

// ─── Test 1: All 60 answers → correct dimension totals ───────────────────────
test('all 60 answers produce correct SUM totals per dimension', () => {
    const answers = allAnswers({
        STRUKTUUR:  7,   // 10 × 7 = 70
        PRESTASIE:  6,   // 10 × 6 = 60
        INSIG:      8,   // 10 × 8 = 80
        LIEFDE:     5,   // 10 × 5 = 50
        EMOSIE:     4,   // 10 × 4 = 40
        INISIATIEF: 9    // 10 × 9 = 90
    });

    const scores = calculateScores(answers);

    assert.equal(scores.STRUKTUUR,  70, 'STRUKTUUR should be 70');
    assert.equal(scores.PRESTASIE,  60, 'PRESTASIE should be 60');
    assert.equal(scores.INSIG,      80, 'INSIG should be 80');
    assert.equal(scores.LIEFDE,     50, 'LIEFDE should be 50');
    assert.equal(scores.EMOSIE,     40, 'EMOSIE should be 40');
    assert.equal(scores.INISIATIEF, 90, 'INISIATIEF should be 90');
});

test('maximum answers (all 10) produce maximum total 100 per dimension', () => {
    const answers = allAnswers(Object.fromEntries(DIMS.map(d => [d, 10])));
    const scores = calculateScores(answers);
    for (const dim of DIMS) {
        assert.equal(scores[dim], 100, `${dim} should be 100`);
    }
});

test('minimum answers (all 1) produce minimum total 10 per dimension', () => {
    const answers = allAnswers(Object.fromEntries(DIMS.map(d => [d, 1])));
    const scores = calculateScores(answers);
    for (const dim of DIMS) {
        assert.equal(scores[dim], 10, `${dim} should be 10`);
    }
});

// ─── Test 2: Ranking correct ─────────────────────────────────────────────────
test('ranking returns all 6 dimensions sorted highest to lowest', () => {
    const answers = allAnswers({
        STRUKTUUR:  7,
        PRESTASIE:  6,
        INSIG:      8,
        LIEFDE:     5,
        EMOSIE:     4,
        INISIATIEF: 9
    });

    const scores  = calculateScores(answers);
    const ranking = rankDimensions(scores);

    assert.equal(ranking.length, 6, 'ranking must include all 6 dimensions');
    assert.equal(ranking[0], 'INISIATIEF', 'highest should be INISIATIEF (90)');
    assert.equal(ranking[1], 'INSIG',      'second should be INSIG (80)');
    assert.equal(ranking[2], 'STRUKTUUR',  'third should be STRUKTUUR (70)');
    assert.equal(ranking[3], 'PRESTASIE',  'fourth should be PRESTASIE (60)');
    assert.equal(ranking[4], 'LIEFDE',     'fifth should be LIEFDE (50)');
    assert.equal(ranking[5], 'EMOSIE',     'sixth should be EMOSIE (40)');
});

// ─── Test 3: Tie-breaker ─────────────────────────────────────────────────────
// tieBreakerOrder: INISIATIEF > INSIG > PRESTASIE > STRUKTUUR > LIEFDE > EMOSIE
// When all equal, INISIATIEF ranks highest, EMOSIE ranks lowest.
test('tie-breaker order applied correctly when all dimensions are equal', () => {
    const scores = Object.fromEntries(DIMS.map(d => [d, 50]));
    const ranking = rankDimensions(scores);

    assert.equal(ranking[0], 'INISIATIEF', 'INISIATIEF should win tie-break at position 1');
    assert.equal(ranking[1], 'INSIG',      'INSIG should win tie-break at position 2');
    assert.equal(ranking[2], 'PRESTASIE',  'PRESTASIE should win tie-break at position 3');
    assert.equal(ranking[3], 'STRUKTUUR',  'STRUKTUUR should win tie-break at position 4');
    assert.equal(ranking[4], 'LIEFDE',     'LIEFDE should win tie-break at position 5');
    assert.equal(ranking[5], 'EMOSIE',     'EMOSIE should rank last on tie-break');
});

test('tie-breaker applied to only tied pair, others rank by score', () => {
    const scores = {
        STRUKTUUR:  80,
        PRESTASIE:  60,
        INSIG:      60,  // tied with PRESTASIE — INSIG wins tie-break
        LIEFDE:     40,
        EMOSIE:     30,
        INISIATIEF: 20
    };

    const ranking = rankDimensions(scores);

    assert.equal(ranking[0], 'STRUKTUUR', 'STRUKTUUR highest (80)');
    assert.equal(ranking[1], 'INSIG',     'INSIG before PRESTASIE when tied (tie-break rule)');
    assert.equal(ranking[2], 'PRESTASIE', 'PRESTASIE after INSIG when tied');
    assert.equal(ranking[5], 'INISIATIEF','INISIATIEF lowest (20)');
});

// ─── Test 4: SPIL code string format ─────────────────────────────────────────
test('generateSpilCode returns correct en-dash separated string', () => {
    const ranking = ['INSIG', 'PRESTASIE', 'INISIATIEF', 'EMOSIE', 'LIEFDE', 'STRUKTUUR'];
    const code    = generateSpilCode(ranking);

    assert.equal(
        code,
        'INSIG \u2013 PRESTASIE \u2013 INISIATIEF \u2013 EMOSIE \u2013 LIEFDE \u2013 STRUKTUUR',
        'SPIL code must be en-dash separated (U+2013)'
    );
    assert.ok(code.includes('\u2013'), 'must use en-dash, not hyphen');
    assert.ok(!code.includes('-'), 'must not use plain hyphen');
});

test('generateSpilCode from buildResults matches expected format', () => {
    const answers = allAnswers({
        STRUKTUUR: 5, PRESTASIE: 9, INSIG: 7,
        LIEFDE: 3, EMOSIE: 6, INISIATIEF: 8
    });

    const results = buildResults(answers);

    assert.ok(typeof results.spilCode === 'string', 'spilCode must be a string');
    assert.ok(results.spilCode.length > 0, 'spilCode must not be empty');
    assert.equal(results.spilCode.split(' \u2013 ').length, 6, 'must have 6 dimensions in code');
    assert.equal(results.spilCode.split(' \u2013 ')[0], 'PRESTASIE', 'first dim should be highest (PRESTASIE = 90)');
});

// ─── Test 5: Missing answers handled safely ───────────────────────────────────
test('null answers do not throw and return zero scores for all dimensions', () => {
    assert.doesNotThrow(() => calculateScores(null));
    const scores = calculateScores(null);
    for (const dim of DIMS) {
        assert.equal(scores[dim], 0, `${dim} should be 0 for null input`);
    }
});

test('undefined answers do not throw', () => {
    assert.doesNotThrow(() => calculateScores(undefined));
    const scores = calculateScores(undefined);
    for (const dim of DIMS) {
        assert.equal(scores[dim], 0);
    }
});

test('empty answers object returns zero scores', () => {
    const scores = calculateScores({});
    for (const dim of DIMS) {
        assert.equal(scores[dim], 0);
    }
});

test('partial answers calculate from answered questions only', () => {
    // Only 3 STRUKTUUR questions answered, others missing
    const answers = {
        STRUKTUUR_1: 8,
        STRUKTUUR_2: 6,
        STRUKTUUR_3: 10
    };
    const scores = calculateScores(answers);
    assert.equal(scores.STRUKTUUR, 24, 'STRUKTUUR should sum only answered questions: 8+6+10=24');
    assert.equal(scores.PRESTASIE, 0,  'PRESTASIE should be 0 (no answers)');
});

test('buildResults with empty answers returns valid object without throwing', () => {
    assert.doesNotThrow(() => buildResults({}));
    const results = buildResults({});
    assert.ok(results.scores,   'scores must be present');
    assert.ok(results.ranking,  'ranking must be present');
    assert.ok(results.spilCode !== undefined, 'spilCode must be present');
    assert.ok(results.generatedAt, 'generatedAt must be present');
});

// ─── Test 6: Invalid values ignored ──────────────────────────────────────────
test('non-numeric string values are discarded', () => {
    const answers = {
        STRUKTUUR_1: 'abc',
        STRUKTUUR_2: 7,
        STRUKTUUR_3: 'N/A'
    };
    const scores = calculateScores(answers);
    // Only STRUKTUUR_2 (7) is valid
    assert.equal(scores.STRUKTUUR, 7);
});

test('out-of-range values (0, 11, negative) are discarded', () => {
    const answers = {
        STRUKTUUR_1:  0,   // below minimum
        STRUKTUUR_2: 11,   // above maximum
        STRUKTUUR_3: -5,   // negative
        STRUKTUUR_4:  7    // valid
    };
    const scores = calculateScores(answers);
    assert.equal(scores.STRUKTUUR, 7, 'only valid answer (7) should count');
});

test('unknown dimension keys are silently ignored', () => {
    const answers = {
        STRUKTUUR_1: 8,
        UNKNOWN_DIM_1: 5,     // not a SPIL dimension
        BALANS_1: 9,          // BASIS key, not SPIL
        STRUKTUUR_99: 7       // invalid question number
    };
    // Should not throw, only STRUKTUUR_1 should be counted
    assert.doesNotThrow(() => calculateScores(answers));
    const scores = calculateScores(answers);
    assert.equal(scores.STRUKTUUR, 8);
});

// ─── Test 7: INISIATIEF top-3 detection ──────────────────────────────────────
test('INISIATIEF detected in top 3 when it ranks 1st', () => {
    const answers = allAnswers({
        STRUKTUUR: 5, PRESTASIE: 6, INSIG: 7,
        LIEFDE: 4, EMOSIE: 3, INISIATIEF: 9
    });
    const results = buildResults(answers);
    const top3    = results.ranking.slice(0, 3);
    assert.ok(top3.includes('INISIATIEF'), 'INISIATIEF should be in top 3');
});

test('INISIATIEF detected in top 3 when it ranks 2nd', () => {
    const answers = allAnswers({
        STRUKTUUR: 5, PRESTASIE: 6, INSIG: 9,
        LIEFDE: 4, EMOSIE: 3, INISIATIEF: 8
    });
    const results = buildResults(answers);
    const top3    = results.ranking.slice(0, 3);
    assert.ok(top3.includes('INISIATIEF'), 'INISIATIEF (rank 2) should be in top 3');
});

test('INISIATIEF NOT in top 3 when it ranks 4th or lower', () => {
    const answers = allAnswers({
        STRUKTUUR: 9, PRESTASIE: 8, INSIG: 7,
        LIEFDE: 5, EMOSIE: 4, INISIATIEF: 6
    });
    const results = buildResults(answers);
    const top3    = results.ranking.slice(0, 3);
    assert.ok(!top3.includes('INISIATIEF'), 'INISIATIEF should NOT be in top 3 when ranked 4th');
});

// ─── Test 8: Lowest dimension correctly detected ──────────────────────────────
test('lowest dimension is the last item in the ranking array', () => {
    const answers = allAnswers({
        STRUKTUUR: 7, PRESTASIE: 6, INSIG: 8,
        LIEFDE: 5, EMOSIE: 3, INISIATIEF: 9
    });
    const results = buildResults(answers);
    assert.equal(results.ranking[results.ranking.length - 1], 'EMOSIE', 'EMOSIE should be lowest');
});

test('lowest dimension detected correctly with tie-break resolution', () => {
    // EMOSIE and LIEFDE tied at 20 — LIEFDE wins tie-break (rank 5 vs EMOSIE rank 6)
    // so EMOSIE remains last
    const answers = allAnswers({
        STRUKTUUR: 8, PRESTASIE: 7, INSIG: 9,
        LIEFDE: 2, EMOSIE: 2, INISIATIEF: 6
    });
    const results = buildResults(answers);
    assert.equal(results.ranking[results.ranking.length - 1], 'EMOSIE', 'EMOSIE should rank last when tied with LIEFDE');
    assert.equal(results.ranking[results.ranking.length - 2], 'LIEFDE', 'LIEFDE should rank second-last when tied with EMOSIE');
});

// ─── Test: validateAnswers ────────────────────────────────────────────────────
test('validateAnswers returns valid=true for complete correct set', () => {
    const answers = allAnswers(Object.fromEntries(DIMS.map(d => [d, 7])));
    const v = validateAnswers(answers);
    assert.equal(v.valid, true);
    assert.equal(v.answeredCount, TOTAL_SPIL_QUESTIONS);
    assert.equal(v.missingKeys.length, 0);
});

test('validateAnswers returns valid=false and lists missing keys for partial set', () => {
    const answers = fullDimAnswers('STRUKTUUR', 7); // only 10 of 60
    const v = validateAnswers(answers);
    assert.equal(v.valid, false);
    assert.equal(v.answeredCount, 10);
    assert.equal(v.totalRequired, 60);
    assert.equal(v.missingKeys.length, 50);
});

test('TOTAL_SPIL_QUESTIONS is exactly 60', () => {
    assert.equal(TOTAL_SPIL_QUESTIONS, 60);
});

console.log('✅ All SPIL engine tests completed.');
