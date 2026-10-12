'use strict';

/**
 * Paytime golden regression gate — docs/paytime/REGSTELPLAN_2026-10.md §1.2
 *
 * Fails on ANY difference from baseline.json. When a fix phase intentionally
 * changes results, list the expected changes in the phase, confirm the diff
 * matches exactly, then regenerate: node tests/golden/run-golden.js --update
 */

const fs = require('fs');
const { computeAll, BASELINE_PATH } = require('./run-golden');

describe('Paytime golden scenarios', () => {
  let actual;
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  beforeAll(async () => { actual = await computeAll(); });

  test('scenario list matches baseline', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(baseline).sort());
  });

  for (const id of Object.keys(baseline)) {
    test(`${id} — ${baseline[id].desc}`, () => {
      expect(actual[id].periods).toEqual(baseline[id].periods);
    });
  }
});
