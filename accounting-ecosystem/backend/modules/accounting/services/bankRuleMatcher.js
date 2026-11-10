/**
 * Bank allocation rule matching — single source of truth.
 *
 * Used by GET /bank/rules/suggest (prefill on the bank page) and by Sean
 * auto-allocation (which must leave any line a company rule matches to the
 * human, since rules are suggest-only).
 *
 * Pipeline (unchanged from the original /rules/suggest):
 *   1. exact       — normalized description === rule.normalized_pattern
 *   2. contains    — normalized description includes rule.normalized_pattern
 *   3. starts_with — normalized description starts with rule.normalized_pattern
 * Within a pass the first rule wins, so callers pass rules ordered by
 * priority ASC, updated_at DESC.
 *
 * @param {Array<{match_type: string, normalized_pattern: string}>} rules
 * @param {string} normalizedDesc  output of normalizeBankDescription()
 * @returns {object|null} the matching rule
 */
function matchBankRule(rules, normalizedDesc) {
  for (const rule of rules || []) {
    if (rule.match_type === 'exact' && normalizedDesc === rule.normalized_pattern) return rule;
  }
  for (const rule of rules || []) {
    if (rule.match_type === 'contains' && normalizedDesc.includes(rule.normalized_pattern)) return rule;
  }
  for (const rule of rules || []) {
    if (rule.match_type === 'starts_with' && normalizedDesc.startsWith(rule.normalized_pattern)) return rule;
  }
  return null;
}

module.exports = { matchBankRule };
