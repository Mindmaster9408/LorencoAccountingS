/**
 * Canonical bank description normaliser for bank allocation rules.
 *
 * This is the single source of truth for normalising bank transaction
 * descriptions within the bank rules feature. Used at:
 *   - Rule creation (normalise match_pattern before saving)
 *   - Rule matching (normalise incoming description before comparison)
 *
 * Do NOT use this to replace the existing normalisers in bank-learning.js
 * or allocations.js — those are separate concerns. Only new bank rules code
 * should import this module.
 */

/**
 * Normalise a raw bank transaction description for rule matching.
 *
 * Strips:
 *   - Sequences of 4+ digits (account numbers, reference numbers)
 *   - Date patterns (DD/MM/YY, DD/MM/YYYY)
 *   - Rand amounts (R followed by digits/commas)
 *   - All punctuation except spaces
 *
 * Preserves the core merchant/vendor identifier so that
 * "ESKOM 202405 REF 123456789" normalises to "eskom" and
 * a rule with pattern "eskom" will match it.
 *
 * @param {string} raw - raw bank transaction description
 * @returns {string} normalised string, lowercased, trimmed
 */
function normalizeBankDescription(raw) {
  if (!raw || typeof raw !== 'string') return '';

  return raw
    .toLowerCase()
    .replace(/\d{4,}/g, '')                          // remove long digit sequences
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, '')   // remove date patterns
    .replace(/r\s?\d+[\d,.']*/gi, '')                 // remove rand amounts
    .replace(/[^a-z\s]/g, ' ')                        // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalizeBankDescription };
