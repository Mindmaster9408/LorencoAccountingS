/**
 * ============================================================================
 * SEAN Controlled Learning Engine — shared, domain-agnostic implementation
 * ============================================================================
 * Extracted from `irp5-learning.js` (Paytime IRP5 codes) and `bank-learning.js`
 * (bank transaction allocation), which had independently reimplemented the
 * same event -> pattern -> confidence -> proposal -> approve/reject workflow
 * against their own separate tables. This module holds that shared shape
 * ONCE; each domain supplies its own tables, field names, and confidence
 * formula via `createLearningDomain(config)`.
 *
 * This is the reusable core Rule B10/B11 (CLAUDE.md) already calls for:
 * Learning Event Capture, Knowledge Store, Proposal Engine, Approval
 * Workflow, Propagation Engine (optional), Exception Reporter (optional),
 * stats. Sean must not make cross-company changes without explicit Super
 * Admin authorization (Rule B2) — every domain built on this engine gets
 * that gate for free.
 *
 * Deliberately NOT unified here: the two existing domains' confidence
 * formulas and "which pattern statuses are protected from re-analysis"
 * differ in real, working ways (IRP5's frequency score is a share-of-name
 * ratio; bank's is an absolute-occurrence cap). Forcing one formula onto
 * both would silently change already-live pattern confidence scores and
 * statuses, which Rule A2 forbids. Config carries each domain's real
 * existing formula/protected-status list untouched.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../config/database');

/**
 * @param {object} config
 * @param {string}   config.sourceApp
 * @param {string}   config.eventTable
 * @param {boolean}  [config.eventTableHasSourceApp=false] — set true only if
 *   eventTable itself carries a source_app column (e.g. IRP5's shared
 *   sean_learning_events table, designed to hold multiple source apps).
 *   Bank's sean_bank_learning_events is a domain-dedicated table with no
 *   such column — filtering by it there would silently match zero rows.
 * @param {string}   config.patternTable
 * @param {string}   config.proposalTable
 * @param {string}   config.proposalPatternFkColumn   — FK column on proposalTable pointing at patternTable.id
 * @param {string}   config.patternSubjectField        — normalized-name column on patternTable (e.g. 'normalized_description')
 * @param {string}   config.patternSuggestionField     — suggested-value column on patternTable (e.g. 'suggested_account_code')
 * @param {function} config.getEventSubject(ev)         — pull/normalize the subject string from a raw event row (event and pattern tables often use different column names/raw-vs-normalized values)
 * @param {function} config.getEventSuggestion(ev)      — pull the suggestion value from a raw event row
 * @param {function} config.calculateConfidence(occurrenceCount, clientsObserved, totalOccurrencesForSubject)
 * @param {number}   config.minClientsForProposal
 * @param {number}   config.minConfidenceForProposal
 * @param {string[]} config.protectedStatuses           — pattern statuses analyzePatterns() must never silently change
 * @param {function} [config.buildEventRow(event)]       — map a caller's event object to eventTable insert columns
 * @param {function} [config.buildPatternExtra(group)]   — extra columns to upsert onto the pattern row (e.g. item_category, bank_name)
 * @param {function} [config.buildProposalSnapshot(pattern)] — extra snapshot_* columns for the proposal row
 * @param {function} [config.enrich(proposal)]           — OPTIONAL: enrich a proposal with missing/conflicting/correct buckets (IRP5 only)
 * @param {function} [config.propagate(proposalId, userId, proposal)] — OPTIONAL: write approved value into domain data (IRP5 only)
 */
function createLearningDomain(config) {
  const {
    sourceApp, eventTable, eventTableHasSourceApp = false,
    patternTable, proposalTable, proposalPatternFkColumn,
    patternSubjectField, patternSuggestionField, getEventSubject, getEventSuggestion,
    calculateConfidence,
    minClientsForProposal, minConfidenceForProposal, protectedStatuses,
    buildEventRow, buildPatternExtra, buildProposalSnapshot,
    enrich, propagate
  } = config;

  // ─── Learning Event Capture ────────────────────────────────────────────────

  async function recordEvent(event) {
    const row = buildEventRow(event);
    if (row === null) return { skipped: true, reason: row };

    const { data, error } = await supabase.from(eventTable).insert(row).select().single();
    if (error) {
      return { skipped: true, reason: error.message };
    }

    analyzePatterns().catch(err =>
      console.error(`[Sean Learning:${sourceApp}] Background analyzePatterns error:`, err.message)
    );

    return { recorded: true, event: data };
  }

  // ─── Proposal Engine (pattern aggregation + confidence) ───────────────────

  async function analyzePatterns() {
    let eventQuery = supabase.from(eventTable).select('*');
    if (eventTableHasSourceApp) eventQuery = eventQuery.eq('source_app', sourceApp);

    const { data: events, error } = await eventQuery;

    if (error) {
      console.error(`[Sean Learning:${sourceApp}] analyzePatterns fetch error:`, error.message);
      return { analyzed: 0 };
    }
    if (!events) return { analyzed: 0 };
    if (events.length === 0) return { analyzed: 0 };

    // Group: { normalizedSubject -> { suggestion -> { count, companies: Set, extra } } }
    const bySubject = {};
    for (const ev of events) {
      const norm = getEventSubject(ev);
      const suggestion = getEventSuggestion(ev);
      if (!norm || !suggestion) continue;

      if (!bySubject[norm]) bySubject[norm] = {};
      if (!bySubject[norm][suggestion]) {
        bySubject[norm][suggestion] = { count: 0, companies: new Set(), sample: ev };
      }
      bySubject[norm][suggestion].count++;
      if (ev.company_id) bySubject[norm][suggestion].companies.add(ev.company_id);
    }

    let proposedCount = 0;

    for (const [normalizedSubject, suggestions] of Object.entries(bySubject)) {
      const totalOccurrences = Object.values(suggestions).reduce((s, v) => s + v.count, 0);

      for (const [suggestion, { count, companies, sample }] of Object.entries(suggestions)) {
        const clientsObserved = companies.size;
        const confidence = calculateConfidence(count, clientsObserved, totalOccurrences);

        const { data: existing } = await supabase
          .from(patternTable)
          .select('id, status')
          .eq('source_app', sourceApp)
          .eq(patternSubjectField, normalizedSubject)
          .eq(patternSuggestionField, suggestion)
          .maybeSingle();

        const extra = buildPatternExtra ? buildPatternExtra({ sample, companies }) : {};

        if (existing) {
          const newStatus = protectedStatuses.includes(existing.status)
            ? existing.status
            : (confidence >= minConfidenceForProposal && clientsObserved >= minClientsForProposal
                ? 'proposed' : 'candidate');

          await supabase.from(patternTable).update({
            confidence_score: confidence,
            occurrence_count: count,
            clients_observed: clientsObserved,
            status: newStatus,
            last_analyzed_at: new Date().toISOString(),
            ...extra
          }).eq('id', existing.id);

          if (newStatus === 'proposed' && existing.status !== 'proposed') proposedCount++;
        } else {
          const newStatus = (confidence >= minConfidenceForProposal && clientsObserved >= minClientsForProposal)
            ? 'proposed' : 'candidate';

          await supabase.from(patternTable).insert({
            source_app: sourceApp,
            [patternSubjectField]: normalizedSubject,
            [patternSuggestionField]: suggestion,
            confidence_score: confidence,
            occurrence_count: count,
            clients_observed: clientsObserved,
            status: newStatus,
            last_analyzed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            ...extra
          });

          if (newStatus === 'proposed') proposedCount++;
        }
      }
    }

    if (proposedCount > 0) await _ensureProposalRows();

    return { analyzed: events.length, proposed: proposedCount };
  }

  async function _ensureProposalRows() {
    const { data: patterns } = await supabase
      .from(patternTable)
      .select('*')
      .eq('source_app', sourceApp)
      .eq('status', 'proposed');

    if (!patterns || patterns.length === 0) return;

    for (const pattern of patterns) {
      const { data: existingProposal } = await supabase
        .from(proposalTable)
        .select('id')
        .eq(proposalPatternFkColumn, pattern.id)
        .eq('status', 'pending')
        .maybeSingle();

      if (existingProposal) continue;

      const snapshotExtra = buildProposalSnapshot ? buildProposalSnapshot(pattern) : {};

      await supabase.from(proposalTable).insert({
        [proposalPatternFkColumn]: pattern.id,
        status: 'pending',
        proposed_by_system: true,
        proposed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...snapshotExtra
      });
    }
  }

  // ─── Knowledge Store reads ─────────────────────────────────────────────────

  async function getPatterns({ status, minConfidence } = {}) {
    let q = supabase.from(patternTable).select('*')
      .eq('source_app', sourceApp)
      .order('confidence_score', { ascending: false });

    if (status) q = q.eq('status', status);
    if (minConfidence) q = q.gte('confidence_score', minConfidence);

    const { data, error } = await q;
    if (error) throw new Error(`getPatterns error: ${error.message}`);
    return data || [];
  }

  async function getProposals() {
    // No custom embed alias — PostgREST keys the joined row by the raw table
    // name (`sean_bank_allocation_patterns`, `sean_irp5_mapping_patterns`),
    // matching each domain's existing frontend contract exactly.
    const { data: proposals, error } = await supabase
      .from(proposalTable)
      .select(`*, ${patternTable} (*)`)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw new Error(`getProposals error: ${error.message}`);
    if (!proposals || proposals.length === 0) return [];

    if (!enrich) return proposals;

    const enriched = await Promise.all(proposals.map(p => enrich(p)));
    return enriched.filter(Boolean);
  }

  // ─── Approval Workflow ─────────────────────────────────────────────────────

  async function approveProposal(proposalId, userId) {
    if (!proposalId || !userId) throw new Error('approveProposal: proposalId and userId are required');

    const { data: proposal, error } = await supabase
      .from(proposalTable).select('*').eq('id', proposalId).single();
    if (error || !proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is not pending (current: ${proposal.status})`);

    const { data: updated, error: updateError } = await supabase
      .from(proposalTable)
      .update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', proposalId).select().single();
    if (updateError) throw new Error(`approveProposal update failed: ${updateError.message}`);

    await supabase.from(patternTable).update({ status: 'approved' }).eq('id', proposal[proposalPatternFkColumn]);

    return updated;
  }

  async function rejectProposal(proposalId, userId, reason = '') {
    if (!proposalId || !userId) throw new Error('rejectProposal: proposalId and userId are required');

    const { data: proposal, error } = await supabase
      .from(proposalTable).select('*').eq('id', proposalId).single();
    if (error || !proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is not pending (current: ${proposal.status})`);

    const { data: updated, error: updateError } = await supabase
      .from(proposalTable)
      .update({ status: 'rejected', rejected_by: userId, rejected_at: new Date().toISOString(), rejection_reason: reason || null, updated_at: new Date().toISOString() })
      .eq('id', proposalId).select().single();
    if (updateError) throw new Error(`rejectProposal update failed: ${updateError.message}`);

    await supabase.from(patternTable).update({ status: 'candidate' }).eq('id', proposal[proposalPatternFkColumn]);

    return updated;
  }

  // ─── Propagation Engine (optional — only domains with a write-back target) ─

  async function propagateApproved(proposalId, userId) {
    if (!propagate) throw new Error(`propagateApproved is not supported for domain "${sourceApp}"`);

    const { data: proposal, error } = await supabase
      .from(proposalTable).select('*').eq('id', proposalId).single();
    if (error || !proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== 'approved') throw new Error(`Proposal ${proposalId} is not approved (current: ${proposal.status}). Cannot propagate.`);

    const result = await propagate(proposalId, userId, proposal);

    await supabase.from(proposalTable).update({
      status: 'propagated', propagation_ran_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq('id', proposalId);
    await supabase.from(patternTable).update({ status: 'propagated' }).eq('id', proposal[proposalPatternFkColumn]);

    return result;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async function getStats() {
    let eventCountQuery = supabase.from(eventTable).select('id', { count: 'exact', head: true });
    if (eventTableHasSourceApp) eventCountQuery = eventCountQuery.eq('source_app', sourceApp);

    const [eventsRes, patternsRes, proposalsRes] = await Promise.all([
      eventCountQuery,
      supabase.from(patternTable).select('id, status, confidence_score').eq('source_app', sourceApp),
      supabase.from(proposalTable).select('id', { count: 'exact', head: true }).eq('status', 'pending')
    ]);

    const patterns = patternsRes.data || [];
    const patternsByStatus = patterns.reduce((acc, p) => {
      acc[p.status] = (acc[p.status] || 0) + 1;
      return acc;
    }, {});

    return {
      totalEvents: eventsRes.count || 0,
      totalPatterns: patterns.length,
      patternsByStatus,
      pendingProposals: proposalsRes.count || 0,
      approvedProposals: patternsByStatus.approved || 0,
      avgConfidence: patterns.length > 0
        ? Math.round(patterns.reduce((s, p) => s + (p.confidence_score || 0), 0) / patterns.length * 10) / 10
        : 0
    };
  }

  const domain = {
    recordEvent, analyzePatterns, getPatterns, getProposals,
    approveProposal, rejectProposal, getStats
  };
  if (propagate) domain.propagateApproved = propagateApproved;
  return domain;
}

module.exports = { createLearningDomain };
