/**
 * Tests — shared bank rule matcher (used by /bank/rules/suggest and Sean auto-allocation)
 */
const { matchBankRule } = require('../modules/accounting/services/bankRuleMatcher');

const rules = [
  { id: 1, match_type: 'contains', normalized_pattern: 'example power' },
  { id: 2, match_type: 'exact', normalized_pattern: 'example power monthly' },
  { id: 3, match_type: 'starts_with', normalized_pattern: 'debit order' },
  { id: 4, match_type: 'contains', normalized_pattern: 'monthly' }
];

describe('matchBankRule', () => {
  test('exact beats contains even when the contains rule has a higher priority', () => {
    expect(matchBankRule(rules, 'example power monthly').id).toBe(2);
  });
  test('contains: first rule in priority order wins', () => {
    expect(matchBankRule(rules, 'pay example power monthly fee').id).toBe(1);
  });
  test('starts_with only when nothing exact or contains matched', () => {
    expect(matchBankRule(rules, 'debit order gym').id).toBe(3);
  });
  test('no match → null; no rules → null', () => {
    expect(matchBankRule(rules, 'something else')).toBeNull();
    expect(matchBankRule([], 'example power')).toBeNull();
    expect(matchBankRule(null, 'example power')).toBeNull();
  });
});
