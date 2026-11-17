/**
 * ============================================================================
 * SEAN — Slip layout learning (global, approval-gated)
 * ============================================================================
 * Third domain on the shared learning engine (./learning-engine.js), next to
 * IRP5 codes and bank allocations.
 *
 *   events    slip_layout_events    per company — written by
 *                                   modules/slips/services/slipLayout.js
 *                                   when a person saves a slip
 *   patterns  slip_layout_patterns  global, anonymised: no company ids,
 *                                   only "VAT 4xxx (+ store) → layout value"
 *   proposals slip_layout_proposals the super-user approval queue
 *
 * Rule B2: nothing is used across companies until a super user approves the
 * proposal. A proposal needs >= 2 different companies whose saved slips
 * agree, so one client's own data (e.g. a name on an account line) can never
 * be proposed. Approving writes nothing into any client's data — it only
 * makes the layout available when reading other companies' slips, and a
 * company's own confirmations still win (see slipLayout.resolveLayout).
 * ============================================================================
 */

'use strict';

const { supabase } = require('../config/database');
const { createLearningDomain } = require('./learning-engine');

const MIN_CLIENTS_FOR_PROPOSAL = 2;
const MIN_CONFIDENCE_FOR_PROPOSAL = 70;

/**
 * Agreement (share of this subject's confirmations, 60%) + client
 * diversity (capped at 3 companies, 40%). Two companies that fully agree
 * → 87; a 60/40 split between two values never reaches 70.
 */
function calculateConfidence(occurrenceCount, clientsObserved, totalOccurrences) {
  const share = totalOccurrences > 0 ? occurrenceCount / totalOccurrences : 0;
  const diversity = Math.min(clientsObserved / 3, 1);
  return Math.round(share * 60 + diversity * 40);
}

/** Parse 'vat:4xxx|store:12|total_line' (pure). */
function parseSubject(subject) {
  const [chain, branch, facet] = String(subject || '').split('|');
  return { chainKey: chain || null, branchKey: branch && branch !== '*' ? branch : null, facet: facet || null };
}

/**
 * A branch proposal that says the same as its chain proposal adds nothing
 * (the chain-level one already covers that branch) — hide it (pure).
 */
function isRedundantBranchProposal(pattern, chainPatterns) {
  if (!pattern || !pattern.branch_key) return false;
  return chainPatterns.some(c => !c.branch_key
    && c.chain_key === pattern.chain_key && c.facet === pattern.facet
    && c.layout_value === pattern.layout_value
    && ['proposed', 'approved'].includes(c.status));
}

const domain = createLearningDomain({
  sourceApp: 'slips',
  eventTable: 'slip_layout_events',
  patternTable: 'slip_layout_patterns',
  proposalTable: 'slip_layout_proposals',
  proposalPatternFkColumn: 'pattern_id',
  patternSubjectField: 'layout_subject',
  patternSuggestionField: 'layout_value',
  getEventSubject: ev => ev.global_subject,   // NULL for name-keyed chains → never global
  getEventSuggestion: ev => ev.value,
  calculateConfidence,
  minClientsForProposal: MIN_CLIENTS_FOR_PROPOSAL,
  minConfidenceForProposal: MIN_CONFIDENCE_FOR_PROPOSAL,
  protectedStatuses: ['proposed', 'approved', 'rejected'],
  // Events are written by slipLayout.learnFromSave (batch insert); recordEvent is unused.
  buildEventRow: () => null,
  buildPatternExtra({ sample }) {
    const s = parseSubject(sample.global_subject);
    return { chain_key: s.chainKey, branch_key: s.branchKey, facet: s.facet, supplier_name: sample.supplier_name || null };
  },
  buildProposalSnapshot(pattern) {
    return {
      snapshot_subject: pattern.layout_subject,
      snapshot_value: pattern.layout_value,
      snapshot_supplier: pattern.supplier_name || null,
      snapshot_confidence: pattern.confidence_score,
      snapshot_clients: pattern.clients_observed,
    };
  },
  async enrich(proposal) {
    const pattern = proposal.slip_layout_patterns;
    if (!pattern || !pattern.branch_key) return proposal;
    const { data } = await supabase.from('slip_layout_patterns')
      .select('chain_key, branch_key, facet, layout_value, status')
      .eq('source_app', 'slips').eq('chain_key', pattern.chain_key).is('branch_key', null);
    return isRedundantBranchProposal(pattern, data || []) ? null : proposal;
  },
});

async function analyzePatterns() { return domain.analyzePatterns(); }
async function getPatterns(opts) { return domain.getPatterns(opts); }
async function getProposals() { return domain.getProposals(); }
async function getStats() { return domain.getStats(); }

async function authorizeProposal(proposalId, userId) {
  await domain.approveProposal(proposalId, userId);
  return { authorized: true };
}

/** Rejection is final: the pattern is marked 'rejected' so it is never re-proposed. */
async function rejectProposal(proposalId, userId, reason) {
  const { data: proposal } = await supabase.from('slip_layout_proposals')
    .select('pattern_id').eq('id', proposalId).maybeSingle();
  await domain.rejectProposal(proposalId, userId, reason);
  if (proposal) {
    await supabase.from('slip_layout_patterns').update({ status: 'rejected' }).eq('id', proposal.pattern_id);
  }
  return { rejected: true };
}

module.exports = {
  analyzePatterns, getPatterns, getProposals, getStats, authorizeProposal, rejectProposal,
  calculateConfidence, parseSubject, isRedundantBranchProposal,
};
