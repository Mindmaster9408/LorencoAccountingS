// basis.engine.test.js
// Run: node tests/basis.engine.test.js
// Requires Node >= 18 (uses built-in node:test + node:assert)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    scoreBasisAnswers,
    toLegacyBasisResults,
    calculateSectionScores,
    determineLevel,
    CONFIG,
    ALL_QUESTION_KEYS,
    TOTAL_QUESTIONS
} from '../domain/basis.engine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Build a full answer set for one section where every question has the given value
function fullSectionAnswers(sectionKey, rawValue) {
    const section = CONFIG.sections[sectionKey];
    return Object.fromEntries(section.questions.map(k => [k, rawValue]));
}

// Build a complete answer set for all sections
function allSectionAnswers(valueBySection) {
    let answers = {};
    for (const [sectionKey, rawValue] of Object.entries(valueBySection)) {
        Object.assign(answers, fullSectionAnswers(sectionKey, rawValue));
    }
    return answers;
}

// ─── Test 1: Unknown question keys are ignored — no crash ─────────────────────
test('unknown question keys are ignored and do not cause a crash', () => {
    const answers = {
        BALANS_1: 7,
        UNKNOWN_KEY: 5,       // not in any section
        AKSIE_99: 3,          // valid section, invalid question number
        FUTURE_QUESTION: 10   // hypothetical future key
    };

    // Must not throw
    const result = scoreBasisAnswers(answers);

    // Only BALANS_1 should be counted for BALANS
    assert.equal(result.sectionScores.BALANS.score, 7);
    // AKSIE should have score 0 — AKSIE_99 is not a recognised key
    assert.equal(result.sectionScores.AKSIE.score, 0);
    assert.ok(result.basisOrder.length === 5, 'basisOrder must contain all 5 sections');
});

// ─── Test 2: Null / undefined / empty answers — no crash ─────────────────────
test('null answers returns all sections with score 0', () => {
    const result = scoreBasisAnswers(null);
    for (const sectionKey of Object.keys(CONFIG.sections)) {
        assert.equal(result.sectionScores[sectionKey].score, 0);
        assert.equal(result.sectionScores[sectionKey].level, 'low');
    }
});

test('undefined answers returns all sections with score 0', () => {
    const result = scoreBasisAnswers(undefined);
    for (const sectionKey of Object.keys(CONFIG.sections)) {
        assert.equal(result.sectionScores[sectionKey].score, 0);
    }
});

test('empty answers object returns all sections with score 0', () => {
    const result = scoreBasisAnswers({});
    for (const sectionKey of Object.keys(CONFIG.sections)) {
        assert.equal(result.sectionScores[sectionKey].score, 0);
    }
});

// ─── Test 3: String values are safely converted to numbers ───────────────────
test('string numeric values are coerced correctly', () => {
    const answers = { BALANS_1: '8', BALANS_2: '6' };
    const result  = scoreBasisAnswers(answers);
    // avg(8, 6) = 7.0
    assert.equal(result.sectionScores.BALANS.score, 7);
    assert.equal(result.sectionScores.BALANS.level, 'high');
});

test('non-numeric strings are discarded — section still calculates from valid values', () => {
    const answers = { BALANS_1: 8, BALANS_2: 'abc', BALANS_3: 6 };
    const result  = scoreBasisAnswers(answers);
    // Only BALANS_1 (8) and BALANS_3 (6) count → avg(8,6) = 7.0
    assert.equal(result.sectionScores.BALANS.score, 7);
});

// ─── Test 4: Empty section (no answers for that section) ─────────────────────
test('section with no answers returns score 0, level low', () => {
    // Only provide AKSIE answers — BALANS should be 0
    const answers = fullSectionAnswers('AKSIE', 7);
    const result  = scoreBasisAnswers(answers);

    assert.equal(result.sectionScores.BALANS.score, 0);
    assert.equal(result.sectionScores.BALANS.level, 'low');
});

// ─── Test 5: Partial answers still calculate correctly ───────────────────────
test('partial section answers calculate average of answered questions only', () => {
    const answers = { BALANS_1: 8, BALANS_3: 6 };
    const result  = scoreBasisAnswers(answers);
    // avg(8, 6) = 7.0 — count is 2, not 10
    assert.equal(result.sectionScores.BALANS.score, 7);
    assert.equal(result.sectionScores.BALANS.level, 'high');
});

// ─── Test 6: Full answers produce correct average with reverse scoring ────────
test('full BALANS section with rawValue 8 produces correct reverse-adjusted average', () => {
    // q1–q8 (normal):  8 × 8 = 64
    // q9, q10 (reverse): 11 - 8 = 3, × 2 = 6
    // total = 70, count = 10, avg = 7.00 → level 'high'
    const answers = fullSectionAnswers('BALANS', 8);
    const result  = scoreBasisAnswers(answers);

    assert.equal(result.sectionScores.BALANS.score, 7.00);
    assert.equal(result.sectionScores.BALANS.level, 'high');
});

test('full section with all answers 5 (midpoint) produces correct average', () => {
    // q1–q8 (normal):  5 × 8 = 40
    // q9, q10 (reverse): 11 - 5 = 6, × 2 = 12
    // total = 52, count = 10, avg = 5.20 → level 'medium'
    const answers = fullSectionAnswers('AKSIE', 5);
    const result  = scoreBasisAnswers(answers);

    assert.equal(result.sectionScores.AKSIE.score, 5.20);
    assert.equal(result.sectionScores.AKSIE.level, 'medium');
});

// ─── Test 7: Ranking order is correct ────────────────────────────────────────
test('basisOrder ranks sections from highest to lowest score', () => {
    // Design inputs so each section scores distinctly:
    //   INSIG: rawValue 10 → q1-8: 10×8=80, q9-10 reverse: (11-1)×2=20 → avg=10.0
    //   AKSIE: rawValue 9  → q1-8: 9×8=72,  q9-10: (11-2)×2=18  → avg=9.0
    //   BALANS:rawValue 8  → q1-8: 8×8=64,  q9-10: (11-3)×2=16  → avg=8.0
    //   SORG:  rawValue 7  → q1-8: 7×8=56,  q9-10: (11-4)×2=14  → avg=7.0
    //   STRUKTUUR: rawValue 5 → q1-8: 5×8=40, q9-10: (11-6)×2=10 → avg=5.0
    // Note: reverse answers are set to make adjusted score match intended avg
    const buildWithReverse = (sectionKey, normalVal, reverseAdjVal) => {
        const section = CONFIG.sections[sectionKey];
        return Object.fromEntries(section.questions.map(k => [
            k,
            section.reverse.has(k) ? reverseAdjVal : normalVal
        ]));
    };

    const answers = {
        ...buildWithReverse('INSIG',     10, 1),  // reverse 11-1=10 → avg 10.0
        ...buildWithReverse('AKSIE',     9,  2),  // reverse 11-2=9  → avg 9.0
        ...buildWithReverse('BALANS',    8,  3),  // reverse 11-3=8  → avg 8.0
        ...buildWithReverse('SORG',      7,  4),  // reverse 11-4=7  → avg 7.0
        ...buildWithReverse('STRUKTUUR', 5,  6)   // reverse 11-6=5  → avg 5.0
    };

    const result = scoreBasisAnswers(answers);

    assert.deepEqual(result.basisOrder, ['INSIG', 'AKSIE', 'BALANS', 'SORG', 'STRUKTUUR']);
    assert.equal(result.sectionScores.INSIG.score,     10.00);
    assert.equal(result.sectionScores.AKSIE.score,      9.00);
    assert.equal(result.sectionScores.BALANS.score,     8.00);
    assert.equal(result.sectionScores.SORG.score,       7.00);
    assert.equal(result.sectionScores.STRUKTUUR.score,  5.00);
});

// ─── Test 8: Output contract is stable and deterministic ─────────────────────
test('same inputs always produce identical output (deterministic)', () => {
    const answers = allSectionAnswers({ BALANS: 7, AKSIE: 6, SORG: 5, INSIG: 8, STRUKTUUR: 4 });

    const first  = scoreBasisAnswers(answers);
    const second = scoreBasisAnswers(answers);

    assert.deepEqual(first.sectionScores, second.sectionScores);
    assert.deepEqual(first.basisOrder,    second.basisOrder);
});

test('output always contains all 5 sections regardless of partial input', () => {
    const result = scoreBasisAnswers({ BALANS_1: 9 });

    const expected = ['BALANS', 'AKSIE', 'SORG', 'INSIG', 'STRUKTUUR'];
    for (const key of expected) {
        assert.ok(key in result.sectionScores, `Missing section: ${key}`);
        assert.ok('score' in result.sectionScores[key]);
        assert.ok('level' in result.sectionScores[key]);
    }
    assert.equal(result.basisOrder.length, 5);
});

// ─── determineLevel unit tests ────────────────────────────────────────────────
test('determineLevel handles non-number inputs defensively', () => {
    assert.equal(determineLevel(NaN),       'low');
    assert.equal(determineLevel(null),      'low');
    assert.equal(determineLevel(undefined), 'low');
    assert.equal(determineLevel('high'),    'low');
});

test('determineLevel returns correct level for boundary values', () => {
    assert.equal(determineLevel(7),   'high');    // at threshold
    assert.equal(determineLevel(8),   'high');
    assert.equal(determineLevel(6.99),'medium');
    assert.equal(determineLevel(4),   'medium');  // at threshold
    assert.equal(determineLevel(3.99),'low');
    assert.equal(determineLevel(0),   'low');
});

// ─── CONFIG / constants ───────────────────────────────────────────────────────
test('ALL_QUESTION_KEYS contains exactly 50 keys (5 sections × 10 questions)', () => {
    assert.equal(TOTAL_QUESTIONS, 50);
    assert.equal(ALL_QUESTION_KEYS.size, 50);
    assert.ok(ALL_QUESTION_KEYS.has('BALANS_1'));
    assert.ok(ALL_QUESTION_KEYS.has('STRUKTUUR_10'));
    assert.ok(!ALL_QUESTION_KEYS.has('BALANS_0'));
    assert.ok(!ALL_QUESTION_KEYS.has('BALANS_11'));
    assert.ok(!ALL_QUESTION_KEYS.has('UNKNOWN_1'));
});

// ─── toLegacyBasisResults — output contract ───────────────────────────────────
test('toLegacyBasisResults output has correct shape', () => {
    const engineOutput = scoreBasisAnswers(allSectionAnswers(
        { BALANS: 7, AKSIE: 6, SORG: 5, INSIG: 8, STRUKTUUR: 4 }
    ));
    const legacy = toLegacyBasisResults(engineOutput);

    // Shape
    assert.ok('sectionScores' in legacy);
    assert.ok('basisOrder'    in legacy);
    assert.ok('timestamp'     in legacy);
    assert.ok('computedBy'    in legacy);
    assert.equal(legacy.computedBy, 'server');

    // sectionScores values must be plain numbers, not objects
    for (const [key, val] of Object.entries(legacy.sectionScores)) {
        assert.equal(typeof val, 'number', `sectionScores.${key} must be a number`);
    }

    // basisOrder must be an array of all 5 section keys
    assert.ok(Array.isArray(legacy.basisOrder));
    assert.equal(legacy.basisOrder.length, 5);
});

test('toLegacyBasisResults sectionScores are integers in range 0–100', () => {
    const engineOutput = scoreBasisAnswers(allSectionAnswers(
        { BALANS: 8, AKSIE: 5, SORG: 3, INSIG: 9, STRUKTUUR: 6 }
    ));
    const legacy = toLegacyBasisResults(engineOutput);

    for (const [key, val] of Object.entries(legacy.sectionScores)) {
        assert.ok(Number.isInteger(val),       `${key} score must be an integer`);
        assert.ok(val >= 0 && val <= 100,      `${key} score must be 0–100, got ${val}`);
    }
});

test('toLegacyBasisResults sum exactly matches legacy frontend calculateSectionScore', () => {
    // Full BALANS section, all raw answers = 8:
    //   q1–q8 (normal)  : 8 × 8 = 64
    //   q9  (reverse)   : 11 - 8 = 3
    //   q10 (reverse)   : 11 - 8 = 3
    //   total           = 70
    // The legacy frontend calculateSectionScore() produces the same 70.
    const answers     = fullSectionAnswers('BALANS', 8);
    const engineOut   = scoreBasisAnswers(answers);
    const legacy      = toLegacyBasisResults(engineOut);

    assert.equal(legacy.sectionScores.BALANS, 70);
});

test('toLegacyBasisResults sum matches for all-5 midpoint answers', () => {
    // Full AKSIE section, all raw answers = 5:
    //   q1–q8 (normal)  : 5 × 8 = 40
    //   q9  (reverse)   : 11 - 5 = 6
    //   q10 (reverse)   : 11 - 5 = 6
    //   total           = 52
    const answers   = fullSectionAnswers('AKSIE', 5);
    const engineOut = scoreBasisAnswers(answers);
    const legacy    = toLegacyBasisResults(engineOut);

    assert.equal(legacy.sectionScores.AKSIE, 52);
});

test('toLegacyBasisResults basisOrder matches engine basisOrder', () => {
    const buildWithReverse = (sectionKey, normalVal, reverseAdjVal) => {
        const section = CONFIG.sections[sectionKey];
        return Object.fromEntries(section.questions.map(k => [
            k,
            section.reverse.has(k) ? reverseAdjVal : normalVal
        ]));
    };
    const answers = {
        ...buildWithReverse('INSIG',     10, 1),
        ...buildWithReverse('AKSIE',      9, 2),
        ...buildWithReverse('BALANS',     8, 3),
        ...buildWithReverse('SORG',       7, 4),
        ...buildWithReverse('STRUKTUUR',  5, 6)
    };

    const engineOut = scoreBasisAnswers(answers);
    const legacy    = toLegacyBasisResults(engineOut);

    assert.deepEqual(legacy.basisOrder,    engineOut.basisOrder);
    assert.deepEqual(legacy.basisOrder,    ['INSIG', 'AKSIE', 'BALANS', 'SORG', 'STRUKTUUR']);
    assert.equal(legacy.sectionScores.INSIG, 100);  // 10×10 = 100
});

test('toLegacyBasisResults with empty answers returns all zeros', () => {
    const legacy = toLegacyBasisResults(scoreBasisAnswers({}));
    for (const val of Object.values(legacy.sectionScores)) {
        assert.equal(val, 0);
    }
});

test('frontend-provided basisResults are irrelevant — engine recomputes from answers', () => {
    // Simulate what the frontend sends: basisAnswers (truth) + basisResults (untrusted)
    const basisAnswers = allSectionAnswers({ BALANS: 8, AKSIE: 7, SORG: 6, INSIG: 9, STRUKTUUR: 5 });

    // Frontend claims BALANS scored 999 (malicious/wrong)
    const frontendBasisResults = { sectionScores: { BALANS: 999 }, basisOrder: ['BALANS'] };

    // Backend ignores frontendBasisResults entirely and recomputes
    const serverResults = toLegacyBasisResults(scoreBasisAnswers(basisAnswers));

    // Server result must NOT contain the poisoned value
    assert.notEqual(serverResults.sectionScores.BALANS, frontendBasisResults.sectionScores.BALANS);
    // Server result must be a valid integer 0–100
    assert.ok(Number.isInteger(serverResults.sectionScores.BALANS));
    assert.ok(serverResults.sectionScores.BALANS >= 0 && serverResults.sectionScores.BALANS <= 100);
    // computedBy confirms server origin
    assert.equal(serverResults.computedBy, 'server');
});

test('report generator receives expected shape from toLegacyBasisResults', () => {
    // generateBASISReport() destructures: const { basisOrder, sectionScores } = client.basisResults
    // Then accesses sectionScores[type] as a number for display
    const answers = allSectionAnswers({ BALANS: 7, AKSIE: 8, SORG: 6, INSIG: 9, STRUKTUUR: 5 });
    const stored  = toLegacyBasisResults(scoreBasisAnswers(answers));

    // Simulate what the report generator does
    const { basisOrder, sectionScores } = stored;

    // basisOrder[0] is the primary type — used as BASIS_DEFINITIONS key
    assert.ok(typeof basisOrder[0] === 'string');
    assert.ok(['BALANS', 'AKSIE', 'SORG', 'INSIG', 'STRUKTUUR'].includes(basisOrder[0]));

    // sectionScores[type] used as: `${sectionScores[type]}/100` and `width: ${score}%`
    for (const type of basisOrder) {
        const score = sectionScores[type];
        assert.equal(typeof score, 'number');
        assert.ok(score >= 0 && score <= 100, `score for ${type} must be 0–100`);
    }
});
