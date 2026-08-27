/**
 * SEAN Bank Learning Service
 * ============================================================================
 * Learns bank allocation patterns from TRUSTED sources only.
 *
 * TRUSTED: 'pdf' (verified bank PDF statements), 'api' (direct bank API feeds)
 * UNTRUSTED: 'csv', 'manual' — ignored per Section 5 of SEAN architecture spec
 *
 * Privacy Rule (Section 13): patterns are anonymised. Company names / client
 * identifiers are never stored in global pattern tables — only the normalised
 * description and the suggested account code.
 *
 * Authorization Rule (Section 7 / CLAUDE.md Rule B2):
 * Patterns are never automatically promoted to global learning. They must be
 * reviewed and authorized by a Super Admin first.
 *
 * Reusability:
 *   The event -> pattern -> proposal -> approve/reject workflow itself now
 *   lives once, in `./learning-engine.js` (createLearningDomain) — shared
 *   with `irp5-learning.js`, which independently reimplemented the same
 *   shape first (and was explicitly designed to generalize). This file
 *   supplies the bank-specific config and stays a thin adapter so bank.js /
 *   bank.html see the exact same function names and return shapes as
 *   before. `suggestAllocation()`/`getCodexArticles()` have no IRP5
 *   equivalent and remain bespoke.
 * ============================================================================
 */

const { supabase } = require('../config/database');
const { createLearningDomain } = require('./learning-engine');

// ─── Constants ───────────────────────────────────────────────────────────────
const TRUSTED_SOURCES        = ['pdf', 'api'];
const MIN_CLIENTS_FOR_PROPOSAL  = 2;   // Pattern must appear in ≥2 companies
const MIN_CONFIDENCE_FOR_PROPOSAL = 55; // Confidence score threshold

// ─── Normalisation ────────────────────────────────────────────────────────────
/**
 * Normalise a transaction description for pattern matching.
 * Strips account numbers, dates, amounts, and noise while preserving
 * the meaningful merchant/vendor identifier.
 */
function normalizeDescription(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\d{4,}/g, '')          // remove long digit sequences (account numbers, refs)
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, '')  // remove dates
    .replace(/r\s?\d+[\d,.]*/gi, '')  // remove rand amounts
    .replace(/[^a-z\s]/g, ' ')        // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate confidence score for a pattern.
 * Weighted: client diversity (70%) + occurrence frequency (30%), both
 * capped (occurrence at 10, clients at 5) rather than IRP5's share-of-name
 * ratio — kept exactly as-is, not unified, per learning-engine.js's header.
 */
function calculateConfidence(occurrenceCount, clientsObserved) {
  const freqScore      = Math.min(occurrenceCount / 10, 1) * 100;
  const diversityScore = Math.min(clientsObserved / 5, 1) * 100;
  return Math.round(freqScore * 0.3 + diversityScore * 0.7);
}

// ─── Shared engine instance ───────────────────────────────────────────────────

const domain = createLearningDomain({
  sourceApp: 'accounting',
  eventTable: 'sean_bank_learning_events',
  patternTable: 'sean_bank_allocation_patterns',
  proposalTable: 'sean_bank_learning_proposals',
  proposalPatternFkColumn: 'pattern_id',
  patternSubjectField: 'normalized_description',
  patternSuggestionField: 'suggested_account_code',
  getEventSubject: ev => ev.normalized_description,
  getEventSuggestion: ev => ev.allocated_account_code,
  calculateConfidence,
  minClientsForProposal: MIN_CLIENTS_FOR_PROPOSAL,
  minConfidenceForProposal: MIN_CONFIDENCE_FOR_PROPOSAL,
  // Matches bank's original candidate->proposed gate exactly — once a
  // pattern leaves 'candidate' it's never silently changed by re-analysis.
  protectedStatuses: ['proposed', 'approved', 'rejected'],
  buildEventRow(event) {
    const {
      companyId, bankTransactionId, importSource, bankName,
      rawDescription, allocatedAccountId, allocatedAccountCode,
      allocatedAccountName, journalId, createdByUserId
    } = event;

    if (!TRUSTED_SOURCES.includes(importSource)) return null;

    const normalized = normalizeDescription(rawDescription);
    if (!normalized || normalized.length < 3) return null;

    return {
      company_id: companyId,
      bank_transaction_id: bankTransactionId || null,
      import_source: importSource,
      bank_name: bankName || null,
      raw_description: rawDescription,
      normalized_description: normalized,
      allocated_account_id: allocatedAccountId || null,
      allocated_account_code: allocatedAccountCode || null,
      allocated_account_name: allocatedAccountName || null,
      journal_id: journalId || null,
      created_by_user_id: createdByUserId || null
    };
  },
  buildPatternExtra({ sample }) {
    return {
      suggested_account_name: sample.allocated_account_name || null,
      bank_name: sample.bank_name || null
    };
  },
  buildProposalSnapshot(pattern) {
    return {
      snapshot_description: pattern.normalized_description,
      snapshot_account_code: pattern.suggested_account_code,
      snapshot_confidence: pattern.confidence_score,
      snapshot_clients: pattern.clients_observed
    };
  }
  // No enrich/propagate — approving a bank pattern just makes it eligible
  // as a global suggestion; nothing is written back into any client's data.
});

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Record a bank allocation learning event.
 * Called after a bank transaction is allocated (from accounting bank.js).
 * Only fires for TRUSTED import sources — silently ignores untrusted.
 */
async function recordBankAllocationEvent(event) {
  const result = await domain.recordEvent(event);
  if (result.skipped) return { skipped: true, reason: result.reason };
  return { recorded: true };
}

/**
 * Analyse bank learning events and update/create global patterns.
 */
async function analyzePatterns() {
  return domain.analyzePatterns();
}

/**
 * Get learning patterns (for Super Admin review panel).
 */
async function getPatterns({ status, minConfidence, sourceApp = 'accounting' } = {}) {
  return domain.getPatterns({ status, minConfidence });
}

/**
 * Get pending proposals for Super Admin review.
 */
async function getProposals() {
  return domain.getProposals();
}

/**
 * Authorize a learning proposal → pattern promoted to 'approved'.
 */
async function authorizeProposal(proposalId, userId) {
  await domain.approveProposal(proposalId, userId);
  return { authorized: true };
}

/**
 * Reject a learning proposal.
 */
async function rejectProposal(proposalId, userId, reason) {
  await domain.rejectProposal(proposalId, userId, reason);
  return { rejected: true };
}

/**
 * Suggest an allocation for a bank transaction description.
 * Checks approved global patterns first, then falls back to local patterns.
 * Returns null if no suggestion found.
 */
async function suggestAllocation(description, bankName) {
  const normalized = normalizeDescription(description);
  if (!normalized) return null;

  const patterns = await domain.getPatterns({ status: 'approved' });
  const sorted = [...patterns].sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0));

  for (const p of sorted) {
    if (normalized.includes(p.normalized_description) ||
        p.normalized_description.includes(normalized) ||
        _wordOverlap(normalized, p.normalized_description) >= 0.6) {
      const codexArticles = await getCodexArticles(normalized, p.suggested_account_code);
      return {
        accountCode: p.suggested_account_code,
        accountName: p.suggested_account_name,
        confidence: p.confidence_score,
        reason: `Pattern matched across ${p.clients_observed} ${p.clients_observed === 1 ? 'company' : 'companies'} (${p.occurrence_count} occurrences)`,
        source: 'sean_global_pattern',
        codexArticles
      };
    }
  }

  // Check seeded global patterns from sean_patterns_global (existing table)
  const { data: legacyPatterns } = await supabase
    .from('sean_patterns_global')
    .select('*')
    .eq('type', 'merchant')
    .order('confidence', { ascending: false });

  if (legacyPatterns) {
    for (const p of legacyPatterns) {
      const patternNorm = normalizeDescription(p.pattern || '');
      if (normalized.includes(patternNorm) || patternNorm.includes(normalized)) {
        return {
          accountCode: p.suggested_category || null,
          accountName: p.metadata?.account_name || null,
          confidence: p.confidence || 70,
          reason: p.reasoning || 'Matched against SEAN global merchant patterns',
          source: 'sean_merchant_pattern',
          codexArticles: []
        };
      }
    }
  }

  return null;
}

/**
 * Get Codex articles relevant to a description and/or account code.
 */
async function getCodexArticles(description, accountCode) {
  const { data: articles } = await supabase
    .from('sean_codex_articles')
    .select('id, category, title, law_reference, explanation, example')
    .eq('is_active', true);

  if (!articles) return [];

  const descWords = new Set(description.toLowerCase().split(/\s+/));
  const scored = articles
    .map(a => {
      const keywords = a.keywords || [];  // stored as array in DB
      const acctMatch = accountCode && (a.related_accounts || []).includes(accountCode);
      const kwMatches = keywords.filter(kw => descWords.has(kw)).length;
      return { ...a, score: (acctMatch ? 50 : 0) + kwMatches * 10 };
    })
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored;
}

/**
 * Get learning stats for the SEAN dashboard.
 */
async function getStats() {
  const base = await domain.getStats();
  return {
    totalEvents: base.totalEvents,
    totalPatterns: base.totalPatterns,
    pendingProposals: base.pendingProposals
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function _wordOverlap(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

module.exports = {
  TRUSTED_SOURCES,
  normalizeDescription,
  recordBankAllocationEvent,
  analyzePatterns,
  getPatterns,
  getProposals,
  authorizeProposal,
  rejectProposal,
  suggestAllocation,
  getCodexArticles,
  getStats
};
