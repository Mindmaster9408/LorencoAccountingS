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
 * ============================================================================
 */

const { supabase } = require('../config/database');

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
 * Weighted: client diversity (70%) + occurrence frequency (30%).
 */
function calculateConfidence(occurrenceCount, clientsObserved) {
  const freqScore      = Math.min(occurrenceCount / 10, 1) * 100;
  const diversityScore = Math.min(clientsObserved / 5, 1) * 100;
  return Math.round(freqScore * 0.3 + diversityScore * 0.7);
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Record a bank allocation learning event.
 * Called after a bank transaction is allocated (from accounting bank.js).
 *
 * Only fires for TRUSTED import sources — silently ignores untrusted.
 *
 * @param {object} event
 * @param {number} event.companyId
 * @param {number} event.bankTransactionId
 * @param {string} event.importSource        — 'pdf' | 'api' | 'csv' | 'manual'
 * @param {string} event.bankName            — e.g. 'ABSA'
 * @param {string} event.rawDescription      — original transaction description
 * @param {number} event.allocatedAccountId
 * @param {string} event.allocatedAccountCode
 * @param {string} event.allocatedAccountName
 * @param {number} event.journalId
 * @param {number} event.createdByUserId
 */
async function recordBankAllocationEvent(event) {
  const {
    companyId, bankTransactionId, importSource, bankName,
    rawDescription, allocatedAccountId, allocatedAccountCode,
    allocatedAccountName, journalId, createdByUserId
  } = event;

  // TRUSTED SOURCE FILTER — Rule from Section 5
  if (!TRUSTED_SOURCES.includes(importSource)) {
    return { skipped: true, reason: `Source '${importSource}' is not trusted for learning` };
  }

  const normalized = normalizeDescription(rawDescription);
  if (!normalized || normalized.length < 3) {
    return { skipped: true, reason: 'Description too short after normalisation' };
  }

  const { error } = await supabase.from('sean_bank_learning_events').insert({
    company_id:             companyId,
    bank_transaction_id:    bankTransactionId || null,
    import_source:          importSource,
    bank_name:              bankName || null,
    raw_description:        rawDescription,
    normalized_description: normalized,
    allocated_account_id:   allocatedAccountId || null,
    allocated_account_code: allocatedAccountCode || null,
    allocated_account_name: allocatedAccountName || null,
    journal_id:             journalId || null,
    created_by_user_id:     createdByUserId || null
  });

  if (error) {
    console.error('[SEAN Bank Learning] Failed to record event:', error.message);
    return { skipped: true, reason: error.message };
  }

  // Trigger async pattern analysis (non-blocking)
  analyzePatterns().catch(err =>
    console.error('[SEAN Bank Learning] Pattern analysis error:', err.message)
  );

  return { recorded: true };
}

/**
 * Analyse bank learning events and update/create global patterns.
 * Groups events by (normalised_description, allocated_account_code).
 * Creates or updates patterns. Auto-proposes high-confidence patterns.
 */
async function analyzePatterns() {
  // Fetch all events grouped by description + account code
  const { data: events, error } = await supabase
    .from('sean_bank_learning_events')
    .select('normalized_description, allocated_account_code, allocated_account_name, bank_name, company_id');

  if (error || !events) return;

  // Group in JS: { "description|account_code": { count, companies: Set, accountName, bankName } }
  const groups = {};
  for (const ev of events) {
    if (!ev.normalized_description || !ev.allocated_account_code) continue;
    const key = `${ev.normalized_description}|${ev.allocated_account_code}`;
    if (!groups[key]) {
      groups[key] = {
        description:   ev.normalized_description,
        accountCode:   ev.allocated_account_code,
        accountName:   ev.allocated_account_name,
        bankName:      ev.bank_name,
        count:         0,
        companies:     new Set()
      };
    }
    groups[key].count++;
    if (ev.company_id) groups[key].companies.add(ev.company_id);
  }

  for (const [, g] of Object.entries(groups)) {
    const clientsObserved = g.companies.size;
    const confidence      = calculateConfidence(g.count, clientsObserved);

    // Upsert pattern
    const { data: existing } = await supabase
      .from('sean_bank_allocation_patterns')
      .select('id, status')
      .eq('normalized_description', g.description)
      .eq('suggested_account_code', g.accountCode)
      .eq('source_app', 'accounting')
      .maybeSingle();

    if (existing) {
      await supabase.from('sean_bank_allocation_patterns').update({
        occurrence_count:  g.count,
        clients_observed:  clientsObserved,
        confidence_score:  confidence,
        suggested_account_name: g.accountName || existing.suggested_account_name,
        last_analyzed_at:  new Date().toISOString()
      }).eq('id', existing.id);

      // Auto-propose if threshold met and not already proposed/approved
      if (
        confidence >= MIN_CONFIDENCE_FOR_PROPOSAL &&
        clientsObserved >= MIN_CLIENTS_FOR_PROPOSAL &&
        existing.status === 'candidate'
      ) {
        await supabase.from('sean_bank_allocation_patterns')
          .update({ status: 'proposed' }).eq('id', existing.id);
        await createProposal(existing.id, g.description, g.accountCode, confidence, clientsObserved);
      }
    } else {
      const { data: newPattern } = await supabase
        .from('sean_bank_allocation_patterns')
        .insert({
          source_app:             'accounting',
          normalized_description: g.description,
          suggested_account_code: g.accountCode,
          suggested_account_name: g.accountName || null,
          bank_name:              g.bankName || null,
          occurrence_count:       g.count,
          clients_observed:       clientsObserved,
          confidence_score:       confidence,
          status:                 confidence >= MIN_CONFIDENCE_FOR_PROPOSAL && clientsObserved >= MIN_CLIENTS_FOR_PROPOSAL
                                    ? 'proposed' : 'candidate',
          last_analyzed_at:       new Date().toISOString()
        })
        .select('id').single();

      if (newPattern && confidence >= MIN_CONFIDENCE_FOR_PROPOSAL && clientsObserved >= MIN_CLIENTS_FOR_PROPOSAL) {
        await createProposal(newPattern.id, g.description, g.accountCode, confidence, clientsObserved);
      }
    }
  }
}

async function createProposal(patternId, description, accountCode, confidence, clients) {
  // One active proposal per pattern — ignore if already exists
  const { data: existing } = await supabase
    .from('sean_bank_learning_proposals')
    .select('id')
    .eq('pattern_id', patternId)
    .maybeSingle();

  if (existing) return; // already proposed

  await supabase.from('sean_bank_learning_proposals').insert({
    pattern_id:           patternId,
    status:               'pending',
    proposed_by_system:   true,
    snapshot_description: description,
    snapshot_account_code: accountCode,
    snapshot_confidence:  confidence,
    snapshot_clients:     clients
  });
}

/**
 * Get learning patterns (for Super Admin review panel).
 */
async function getPatterns({ status, minConfidence, sourceApp = 'accounting' } = {}) {
  let q = supabase.from('sean_bank_allocation_patterns')
    .select('*')
    .eq('source_app', sourceApp)
    .order('confidence_score', { ascending: false });

  if (status)        q = q.eq('status', status);
  if (minConfidence) q = q.gte('confidence_score', minConfidence);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Get pending proposals for Super Admin review.
 */
async function getProposals() {
  const { data, error } = await supabase
    .from('sean_bank_learning_proposals')
    .select('*, sean_bank_allocation_patterns(*)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Authorize a learning proposal → pattern promoted to 'approved'.
 * Privacy: only the normalised description + account code are stored globally.
 * No company data is exposed.
 */
async function authorizeProposal(proposalId, userId) {
  const { data: proposal, error } = await supabase
    .from('sean_bank_learning_proposals')
    .select('*, sean_bank_allocation_patterns(id, status)')
    .eq('id', proposalId)
    .single();

  if (error || !proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is already ${proposal.status}`);

  // Update proposal
  await supabase.from('sean_bank_learning_proposals').update({
    status:      'approved',
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    updated_at:  new Date().toISOString()
  }).eq('id', proposalId);

  // Update pattern status
  await supabase.from('sean_bank_allocation_patterns').update({
    status:         'approved',
    authorized_by:  userId,
    authorized_at:  new Date().toISOString()
  }).eq('id', proposal.pattern_id);

  return { authorized: true };
}

/**
 * Reject a learning proposal.
 */
async function rejectProposal(proposalId, userId, reason) {
  const { data: proposal, error } = await supabase
    .from('sean_bank_learning_proposals')
    .select('pattern_id, status')
    .eq('id', proposalId)
    .single();

  if (error || !proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is already ${proposal.status}`);

  await supabase.from('sean_bank_learning_proposals').update({
    status:           'rejected',
    reviewed_by:      userId,
    reviewed_at:      new Date().toISOString(),
    rejection_reason: reason || null,
    updated_at:       new Date().toISOString()
  }).eq('id', proposalId);

  await supabase.from('sean_bank_allocation_patterns')
    .update({ status: 'candidate' })
    .eq('id', proposal.pattern_id);

  return { rejected: true };
}

/**
 * Suggest an allocation for a bank transaction description.
 * Checks approved global patterns first, then falls back to local patterns.
 * Returns null if no suggestion found.
 *
 * @param {string} description - raw bank transaction description
 * @param {string} [bankName]  - bank name for context
 * @returns {object|null} { accountCode, accountName, confidence, reason, codexArticles }
 */
async function suggestAllocation(description, bankName) {
  const normalized = normalizeDescription(description);
  if (!normalized) return null;

  // 1. Check approved global patterns (exact or partial match)
  const { data: patterns } = await supabase
    .from('sean_bank_allocation_patterns')
    .select('*')
    .eq('status', 'approved')
    .order('confidence_score', { ascending: false });

  if (patterns) {
    for (const p of patterns) {
      if (normalized.includes(p.normalized_description) ||
          p.normalized_description.includes(normalized) ||
          _wordOverlap(normalized, p.normalized_description) >= 0.6) {
        // Find Codex articles for this account code
        const codexArticles = await getCodexArticles(normalized, p.suggested_account_code);
        return {
          accountCode:   p.suggested_account_code,
          accountName:   p.suggested_account_name,
          confidence:    p.confidence_score,
          reason:        `Pattern matched across ${p.clients_observed} ${p.clients_observed === 1 ? 'company' : 'companies'} (${p.occurrence_count} occurrences)`,
          source:        'sean_global_pattern',
          codexArticles
        };
      }
    }
  }

  // 2. Check seeded global patterns from sean_patterns_global (existing table)
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
          accountCode:   p.suggested_category || null,
          accountName:   p.metadata?.account_name || null,
          confidence:    p.confidence || 70,
          reason:        p.reasoning || 'Matched against SEAN global merchant patterns',
          source:        'sean_merchant_pattern',
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
  const [eventsRes, patternsRes, proposalsRes] = await Promise.all([
    supabase.from('sean_bank_learning_events').select('id', { count: 'exact', head: true }),
    supabase.from('sean_bank_allocation_patterns').select('id', { count: 'exact', head: true }),
    supabase.from('sean_bank_learning_proposals').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  ]);

  return {
    totalEvents:      eventsRes.count  || 0,
    totalPatterns:    patternsRes.count || 0,
    pendingProposals: proposalsRes.count || 0
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
