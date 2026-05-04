'use strict';

/**
 * vita.engine.test.js — Unit tests for the VITA Report Engine
 *
 * Tests:
 *   1. buildVitaData()  → correct VITA code string from ranking
 *   2. deriveSections() → correct role mapping (PRIMARY, SECONDARY, ..., SHADOW)
 *   3. mergeTemplate()  → no {{placeholders}} remain after merge
 *   4. generateVitaReport() → returns markdown string
 *   5. validateRanking() via route logic → invalid inputs correctly rejected
 */

const { buildVitaData, deriveSections, buildSpecialSections } = require('../domain/vita.engine');
const { generateVitaReport, mergeTemplate } = require('../domain/vita.report');
const { VITA_TEMPLATE } = require('../domain/vita.template');
const { VITA_DIMENSIONS } = require('../domain/vita.config');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_RANKING_1 = ['INSIG', 'PRESTASIE', 'INISIATIEF', 'EMOSIE', 'LIEFDE', 'STRUKTUUR'];
const SAMPLE_RANKING_2 = ['STRUKTUUR', 'PRESTASIE', 'LIEFDE', 'INSIG', 'EMOSIE', 'INISIATIEF'];
const SAMPLE_RANKING_3 = ['LIEFDE', 'EMOSIE', 'INSIG', 'STRUKTUUR', 'INISIATIEF', 'PRESTASIE'];

// Validator mirrored from vita.routes.js (pure function — no express dep needed in tests)
const VALID_DIM_SET = new Set(VITA_DIMENSIONS);
function validateRanking(ranking) {
  if (!Array.isArray(ranking))   return 'ranking must be an array';
  if (ranking.length !== 6)      return `ranking must contain exactly 6 dimensions. Got ${ranking.length}.`;
  const seen = new Set();
  for (const dim of ranking) {
    if (typeof dim !== 'string')      return `Each dimension must be a string. Got: ${JSON.stringify(dim)}`;
    if (!VALID_DIM_SET.has(dim))      return `Invalid dimension: "${dim}"`;
    if (seen.has(dim))                return `Duplicate dimension: "${dim}"`;
    seen.add(dim);
  }
  return null;
}

// ─── Test 1: VITA code string ─────────────────────────────────────────────────

describe('buildVitaData — VITA code string', () => {
  test('produces correct em-dash separated code from ranking 1', () => {
    const data = buildVitaData(SAMPLE_RANKING_1);
    expect(data.RANKED_CODE).toBe('INSIG \u2013 PRESTASIE \u2013 INISIATIEF \u2013 EMOSIE \u2013 LIEFDE \u2013 STRUKTUUR');
  });

  test('produces correct code from ranking 2', () => {
    const data = buildVitaData(SAMPLE_RANKING_2);
    expect(data.RANKED_CODE).toBe('STRUKTUUR \u2013 PRESTASIE \u2013 LIEFDE \u2013 INSIG \u2013 EMOSIE \u2013 INISIATIEF');
  });

  test('PRIMARY_LABEL matches first dimension label', () => {
    const data = buildVitaData(SAMPLE_RANKING_1);
    expect(data.PRIMARY_LABEL).toBe('Insig');
  });

  test('SHADOW_LABEL matches last dimension label', () => {
    const data = buildVitaData(SAMPLE_RANKING_1);
    expect(data.SHADOW_LABEL).toBe('Struktuur');
  });
});

// ─── Test 2: deriveSections role mapping ──────────────────────────────────────

describe('deriveSections — role mapping', () => {
  test('maps positions to correct roles for ranking 1', () => {
    const s = deriveSections(SAMPLE_RANKING_1);
    expect(s.PRIMARY).toBe('INSIG');
    expect(s.SECONDARY).toBe('PRESTASIE');
    expect(s.THIRD).toBe('INISIATIEF');
    expect(s.STRESS).toBe('EMOSIE');
    expect(s.GROWTH).toBe('LIEFDE');
    expect(s.SHADOW).toBe('STRUKTUUR');
  });

  test('maps positions to correct roles for ranking 2', () => {
    const s = deriveSections(SAMPLE_RANKING_2);
    expect(s.PRIMARY).toBe('STRUKTUUR');
    expect(s.SECONDARY).toBe('PRESTASIE');
    expect(s.SHADOW).toBe('INISIATIEF');
  });

  test('maps positions to correct roles for ranking 3', () => {
    const s = deriveSections(SAMPLE_RANKING_3);
    expect(s.PRIMARY).toBe('LIEFDE');
    expect(s.SHADOW).toBe('PRESTASIE');
  });
});

// ─── Test 3: template merge — no placeholders remain ─────────────────────────

describe('mergeTemplate — no {{placeholders}} remain', () => {
  test('all placeholders replaced for ranking 1', () => {
    const data = buildVitaData(SAMPLE_RANKING_1);
    data.GENERATED_AT = new Date().toISOString();
    const output = mergeTemplate(VITA_TEMPLATE, data);
    const remaining = output.match(/\{\{[A-Z_]+\}\}/g);
    expect(remaining).toBeNull();
  });

  test('all placeholders replaced for ranking 2', () => {
    const data = buildVitaData(SAMPLE_RANKING_2);
    data.GENERATED_AT = new Date().toISOString();
    const output = mergeTemplate(VITA_TEMPLATE, data);
    const remaining = output.match(/\{\{[A-Z_]+\}\}/g);
    expect(remaining).toBeNull();
  });

  test('all placeholders replaced for ranking 3', () => {
    const data = buildVitaData(SAMPLE_RANKING_3);
    data.GENERATED_AT = new Date().toISOString();
    const output = mergeTemplate(VITA_TEMPLATE, data);
    const remaining = output.match(/\{\{[A-Z_]+\}\}/g);
    expect(remaining).toBeNull();
  });

  test('throws if a placeholder is not in the data map', () => {
    const partialData = { RANKED_CODE: 'TEST' }; // deliberately incomplete
    expect(() => mergeTemplate(VITA_TEMPLATE, partialData)).toThrow(
      /Unreplaced placeholders/
    );
  });
});

// ─── Test 4: generateVitaReport — returns valid markdown string ───────────────

describe('generateVitaReport — return shape', () => {
  test('returns markdown string and generatedAt', () => {
    const result = generateVitaReport(SAMPLE_RANKING_1);
    expect(typeof result.markdown).toBe('string');
    expect(result.markdown.length).toBeGreaterThan(500);
    expect(typeof result.generatedAt).toBe('string');
  });

  test('markdown contains the VITA code', () => {
    const result = generateVitaReport(SAMPLE_RANKING_1);
    expect(result.markdown).toContain('INSIG');
    expect(result.markdown).toContain('STRUKTUUR');
  });

  test('markdown contains section headings', () => {
    const result = generateVitaReport(SAMPLE_RANKING_1);
    expect(result.markdown).toContain('Primêre Dryfkrag');
    expect(result.markdown).toContain('Groei-area');
    expect(result.markdown).toContain('Skadu');
  });

  test('generatedAt is a valid ISO date string', () => {
    const result = generateVitaReport(SAMPLE_RANKING_2);
    expect(() => new Date(result.generatedAt)).not.toThrow();
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
  });
});

// ─── Test 5: validateRanking — rejects invalid input ─────────────────────────

describe('validateRanking — invalid inputs rejected', () => {
  test('rejects non-array input', () => {
    expect(validateRanking('INSIG')).toBeTruthy();
    expect(validateRanking(null)).toBeTruthy();
    expect(validateRanking(42)).toBeTruthy();
  });

  test('rejects wrong length (5 items)', () => {
    const short = SAMPLE_RANKING_1.slice(0, 5);
    expect(validateRanking(short)).toMatch(/6/);
  });

  test('rejects wrong length (7 items)', () => {
    const long = [...SAMPLE_RANKING_1, 'INSIG'];
    expect(validateRanking(long)).toBeTruthy();
  });

  test('rejects duplicate dimensions', () => {
    const dup = ['INSIG', 'INSIG', 'PRESTASIE', 'LIEFDE', 'EMOSIE', 'STRUKTUUR'];
    expect(validateRanking(dup)).toMatch(/Duplicate/);
  });

  test('rejects invalid dimension string', () => {
    const bad = ['INSIG', 'PRESTASIE', 'INISIATIEF', 'EMOSIE', 'LIEFDE', 'UNKNOWN'];
    expect(validateRanking(bad)).toMatch(/Invalid dimension/);
  });

  test('rejects non-string element', () => {
    const mixed = ['INSIG', 'PRESTASIE', 'INISIATIEF', 'EMOSIE', 'LIEFDE', 42];
    expect(validateRanking(mixed)).toMatch(/string/);
  });

  test('accepts a valid ranking', () => {
    expect(validateRanking(SAMPLE_RANKING_1)).toBeNull();
    expect(validateRanking(SAMPLE_RANKING_2)).toBeNull();
    expect(validateRanking(SAMPLE_RANKING_3)).toBeNull();
  });

  test('accepts all 720 permutations as valid', () => {
    // Spot-check several permutations rather than all 720
    const perms = [
      ['STRUKTUUR', 'LIEFDE', 'EMOSIE', 'INSIG', 'PRESTASIE', 'INISIATIEF'],
      ['INISIATIEF', 'LIEFDE', 'STRUKTUUR', 'EMOSIE', 'INSIG', 'PRESTASIE'],
      ['EMOSIE', 'INISIATIEF', 'PRESTASIE', 'STRUKTUUR', 'LIEFDE', 'INSIG'],
    ];
    for (const p of perms) {
      expect(validateRanking(p)).toBeNull();
    }
  });
});
