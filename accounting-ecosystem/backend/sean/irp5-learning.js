/**
 * ============================================================================
 * SEAN IRP5 Learning Service
 * ============================================================================
 * Core learning engine for Paytime → Sean IRP5 code intelligence.
 *
 * Responsibilities:
 *   1. recordLearningEvent()    — Persist an IRP5 code change from Paytime
 *   2. analyzePatterns()        — Build/update mapping patterns from events
 *   3. getPatterns()            — Return discovered patterns + confidence
 *   4. getProposals()           — Return patterns ready for authorization review
 *   5. approveProposal()        — Authorized user approves propagation
 *   6. rejectProposal()         — Authorized user rejects
 *   7. propagateApproved()      — Apply approved mapping to NULL-code items ONLY
 *   8. getExceptions()          — List clients with conflicting codes
 *   9. getStats()               — Learning system summary stats
 *
 * SAFETY RULES (enforced in code, governed by CLAUDE.md Part B):
 *   - Sean may ONLY write irp5_code where the current value is NULL or empty.
 *   - Sean may NEVER overwrite an existing irp5_code, even if approved.
 *   - No propagation without an approved row in sean_irp5_propagation_approvals.
 *   - Every write (or deliberate skip) is logged in sean_irp5_propagation_log.
 *
 * Reusability:
 *   The event -> pattern -> proposal -> approve/reject workflow itself now
 *   lives once, in `./learning-engine.js` (createLearningDomain) — shared
 *   with `bank-learning.js`, which independently reimplemented the same
 *   shape. This file supplies the IRP5-specific config (tables, column
 *   names, confidence formula, enrichment against payroll_items_master,
 *   propagation write-back) and stays a thin adapter so every existing
 *   caller (items.js, irp5-routes.js, sean-webapp) sees the exact same
 *   function names, signatures, and return shapes as before.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../config/database');
const { createLearningDomain } = require('./learning-engine');

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_APP = 'paytime';

const MIN_CLIENTS_FOR_PROPOSAL = 2;
const MIN_CONFIDENCE_FOR_PROPOSAL = 60;
const CONFIDENCE_OCCURRENCE_WEIGHT = 0.3;
const CONFIDENCE_CLIENT_WEIGHT     = 0.7;

// ─── Name Normalisation ───────────────────────────────────────────────────────

/**
 * Normalize a payroll item name to a consistent form for pattern matching.
 * Intentionally conservative — exact duplicate detection only. Semantic
 * matching (e.g. "Comm" ≡ "Commission") is left to the pattern analyst who
 * reviews proposals, not done automatically.
 */
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(monthly|weekly|annual|yearly|2024|2025|2026|per month|per year)\b/g, '')
    .trim();
}

// ─── Tax Year Derivation ──────────────────────────────────────────────────────

/**
 * Return SA tax year string for a given date, e.g. '2025/2026'.
 * SA tax year: 1 March → end of February.
 */
function currentTaxYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (month >= 2) return `${year}/${year + 1}`;
  return `${year - 1}/${year}`;
}

// ─── Confidence Calculation ───────────────────────────────────────────────────

/**
 * Calculate confidence score (0–100) for a pattern.
 * Frequency score is a share-of-name ratio (how often this code wins vs
 * other codes seen for the same item name); diversity caps at 10 clients.
 */
function calculateConfidence(occurrenceCount, clientsObserved, totalOccurrences) {
  if (!totalOccurrences || !occurrenceCount) return 0;

  const frequencyScore = (occurrenceCount / totalOccurrences) * 100;
  const diversityScore = Math.min(clientsObserved / 10, 1) * 100;
  const raw = (frequencyScore * CONFIDENCE_OCCURRENCE_WEIGHT) + (diversityScore * CONFIDENCE_CLIENT_WEIGHT);

  return Math.min(Math.round(raw * 100) / 100, 100);
}

// ─── Domain-specific: enrichment against payroll_items_master ────────────────

/**
 * For a proposal, query payroll_items_master to find:
 *   - Companies that have a matching item with code = NULL → will be filled
 *   - Companies that have a matching item with a DIFFERENT code → exception
 *   - Companies that have a matching item with the SAME code → already correct
 */
async function _enrichProposal(proposal) {
  const normalizedName = proposal.snapshot_normalized_name;
  const proposedCode   = proposal.snapshot_irp5_code;

  const { data: items, error } = await supabase
    .from('payroll_items_master')
    .select('id, company_id, item_name, irp5_code, is_active')
    .eq('is_active', true);

  if (error || !items) {
    console.error('[Sean IRP5] _enrichProposal fetch error:', error?.message);
    return { ...proposal, missing: [], conflicting: [], alreadyCorrect: [] };
  }

  const matching = items.filter(item => normalizeName(item.item_name) === normalizedName);

  const missing = [];
  const conflicting = [];
  const alreadyCorrect = [];

  for (const item of matching) {
    if (!item.irp5_code) {
      missing.push({ companyId: item.company_id, itemId: item.id, itemName: item.item_name });
    } else if (item.irp5_code === proposedCode) {
      alreadyCorrect.push({ companyId: item.company_id, itemId: item.id, itemName: item.item_name, existingCode: item.irp5_code });
    } else {
      conflicting.push({ companyId: item.company_id, itemId: item.id, itemName: item.item_name, existingCode: item.irp5_code });
    }
  }

  return { ...proposal, missing, conflicting, alreadyCorrect };
}

// ─── Domain-specific: propagation write-back ──────────────────────────────────

/**
 * Execute propagation for one approved proposal.
 * SAFETY RULES:
 *   - irp5_code IS NULL  → write the approved code, log 'applied'
 *   - irp5_code = proposed code → already correct, log 'skipped_existing'
 *   - irp5_code is something ELSE → NEVER overwrite, log 'skipped_exception'
 */
async function _propagate(proposalId, authorizedUserId, proposal) {
  const normalizedName = proposal.snapshot_normalized_name;
  const proposedCode   = proposal.snapshot_irp5_code;

  const { data: allItems, error: itemsError } = await supabase
    .from('payroll_items_master')
    .select('id, company_id, item_name, irp5_code')
    .eq('is_active', true);

  if (itemsError) throw new Error(`propagateApproved items fetch error: ${itemsError.message}`);

  const matching = (allItems || []).filter(item => normalizeName(item.item_name) === normalizedName);

  let applied = 0;
  let skippedExisting = 0;
  let exceptions = 0;
  let errors = 0;
  const logRows = [];

  for (const item of matching) {
    const existing = item.irp5_code;

    if (!existing) {
      const { error: writeError } = await supabase
        .from('payroll_items_master')
        .update({
          irp5_code: proposedCode,
          irp5_code_updated_at: new Date().toISOString(),
          irp5_code_updated_by: authorizedUserId
        })
        .eq('id', item.id);

      if (writeError) {
        console.error(`[Sean IRP5] propagate write error for item ${item.id}:`, writeError.message);
        logRows.push({
          approval_id: proposalId, company_id: item.company_id, payroll_item_id: item.id,
          payroll_item_name: item.item_name, irp5_code_written: proposedCode,
          previous_irp5_code: null, action: 'error', notes: writeError.message,
          created_at: new Date().toISOString()
        });
        errors++;
      } else {
        logRows.push({
          approval_id: proposalId, company_id: item.company_id, payroll_item_id: item.id,
          payroll_item_name: item.item_name, irp5_code_written: proposedCode,
          previous_irp5_code: null, action: 'applied', created_at: new Date().toISOString()
        });
        applied++;
      }
    } else if (existing === proposedCode) {
      logRows.push({
        approval_id: proposalId, company_id: item.company_id, payroll_item_id: item.id,
        payroll_item_name: item.item_name, irp5_code_written: proposedCode,
        previous_irp5_code: existing, action: 'skipped_existing',
        notes: 'Code already matches proposed mapping', created_at: new Date().toISOString()
      });
      skippedExisting++;
    } else {
      logRows.push({
        approval_id: proposalId, company_id: item.company_id, payroll_item_id: item.id,
        payroll_item_name: item.item_name, irp5_code_written: proposedCode,
        previous_irp5_code: existing, action: 'skipped_exception',
        notes: `Client has existing code ${existing} — not overwritten per CLAUDE.md Rule B9`,
        created_at: new Date().toISOString()
      });
      exceptions++;
    }
  }

  if (logRows.length > 0) {
    const { error: logError } = await supabase.from('sean_irp5_propagation_log').insert(logRows);
    if (logError) console.error('[Sean IRP5] propagation log insert error:', logError.message);
  }

  await supabase.from('sean_irp5_propagation_approvals').update({
    propagation_applied_count: applied,
    propagation_skipped_count: skippedExisting,
    propagation_exception_count: exceptions
  }).eq('id', proposalId);

  return { applied, skippedExisting, exceptions, errors };
}

// ─── Shared engine instance ───────────────────────────────────────────────────

const domain = createLearningDomain({
  sourceApp: SOURCE_APP,
  eventTable: 'sean_learning_events',
  eventTableHasSourceApp: true,
  patternTable: 'sean_irp5_mapping_patterns',
  proposalTable: 'sean_irp5_propagation_approvals',
  proposalPatternFkColumn: 'mapping_pattern_id',
  patternSubjectField: 'normalized_item_name',
  patternSuggestionField: 'suggested_irp5_code',
  // sean_learning_events stores only the raw payroll_item_name/new_irp5_code —
  // no pre-normalized columns exist on that table, unlike the pattern table.
  getEventSubject: ev => normalizeName(ev.payroll_item_name),
  getEventSuggestion: ev => ev.new_irp5_code,
  calculateConfidence,
  minClientsForProposal: MIN_CLIENTS_FOR_PROPOSAL,
  minConfidenceForProposal: MIN_CONFIDENCE_FOR_PROPOSAL,
  // 'proposed'/'rejected' patterns CAN still shift on re-analysis (matches
  // original behaviour exactly) — only 'approved'/'propagated' are locked.
  protectedStatuses: ['approved', 'propagated'],
  buildEventRow(event) {
    const {
      companyId, clientId = null, payrollItemId = null, payrollItemName,
      itemCategory = null, previousIrp5Code = null, newIrp5Code, changeType,
      changedBy = null, taxYear = currentTaxYear()
    } = event;

    if (!companyId || !payrollItemName || !newIrp5Code || !changeType) {
      throw new Error('recordLearningEvent: companyId, payrollItemName, newIrp5Code, changeType are required');
    }
    const validChangeTypes = ['new_item', 'code_added', 'code_changed'];
    if (!validChangeTypes.includes(changeType)) {
      throw new Error(`recordLearningEvent: invalid changeType "${changeType}". Must be one of: ${validChangeTypes.join(', ')}`);
    }

    return {
      source_app: SOURCE_APP,
      client_id: clientId,
      company_id: companyId,
      payroll_item_id: payrollItemId,
      payroll_item_name: payrollItemName,
      item_category: itemCategory || null,
      previous_irp5_code: previousIrp5Code || null,
      new_irp5_code: newIrp5Code,
      change_type: changeType,
      changed_by: changedBy || null,
      tax_year: taxYear,
      created_at: new Date().toISOString()
    };
  },
  buildPatternExtra({ sample }) {
    return { item_category: sample.item_category || null };
  },
  buildProposalSnapshot(pattern) {
    return {
      snapshot_normalized_name: pattern.normalized_item_name,
      snapshot_irp5_code: pattern.suggested_irp5_code,
      snapshot_confidence: pattern.confidence_score,
      snapshot_clients_count: pattern.clients_observed
    };
  },
  enrich: _enrichProposal,
  propagate: _propagate
});

// ─── 1. Record Learning Event ─────────────────────────────────────────────────

/**
 * Persist an IRP5 code change event from Paytime.
 * @returns {Promise<object>} Saved event row
 */
async function recordLearningEvent(event) {
  const result = await domain.recordEvent(event);
  if (result.skipped) throw new Error(`Sean learning event save failed: ${result.reason}`);
  return result.event;
}

// ─── 2. Analyze Patterns ─────────────────────────────────────────────────────

async function analyzePatterns({ sourceApp = SOURCE_APP } = {}) {
  return domain.analyzePatterns();
}

// ─── 3. Get Patterns ──────────────────────────────────────────────────────────

async function getPatterns({ sourceApp = SOURCE_APP, status = null, minConfidence = 0 } = {}) {
  return domain.getPatterns({ status, minConfidence });
}

// ─── 4. Get Proposals (Pending Authorization) ─────────────────────────────────

async function getProposals({ sourceApp = SOURCE_APP } = {}) {
  return domain.getProposals();
}

// ─── 5. Approve Proposal ──────────────────────────────────────────────────────

async function approveProposal(approvalId, userId) {
  return domain.approveProposal(approvalId, userId);
}

// ─── 6. Reject Proposal ───────────────────────────────────────────────────────

async function rejectProposal(approvalId, userId, reason = '') {
  return domain.rejectProposal(approvalId, userId, reason);
}

// ─── 7. Propagate Approved Mappings ──────────────────────────────────────────

async function propagateApproved(approvalId, authorizedUserId) {
  if (!approvalId || !authorizedUserId) {
    throw new Error('propagateApproved: approvalId and authorizedUserId are required');
  }
  return domain.propagateApproved(approvalId, authorizedUserId);
}

// ─── 8. Get Exceptions ────────────────────────────────────────────────────────

/**
 * For a given normalized item name and proposed code, return all companies
 * that have a different code set — these are exceptions requiring manual review.
 */
async function getExceptions(normalizedItemName, proposedCode) {
  const { data: items, error } = await supabase
    .from('payroll_items_master')
    .select('id, company_id, item_name, irp5_code')
    .eq('is_active', true)
    .not('irp5_code', 'is', null);

  if (error) throw new Error(`getExceptions error: ${error.message}`);

  return (items || [])
    .filter(item => normalizeName(item.item_name) === normalizedItemName && item.irp5_code !== proposedCode)
    .map(item => ({
      companyId: item.company_id,
      itemId: item.id,
      itemName: item.item_name,
      existingCode: item.irp5_code
    }));
}

// ─── 9. Get Stats ─────────────────────────────────────────────────────────────

async function getStats({ sourceApp = SOURCE_APP } = {}) {
  const base = await domain.getStats();

  const { count: totalPropagations } = await supabase
    .from('sean_irp5_propagation_log')
    .select('action', { count: 'exact', head: true })
    .eq('action', 'applied');

  return {
    sourceApp,
    totalLearningEvents: base.totalEvents,
    totalPatterns: base.totalPatterns,
    patternsByStatus: base.patternsByStatus,
    pendingApprovals: base.pendingProposals,
    totalPropagations: totalPropagations || 0,
    avgConfidence: base.avgConfidence
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  normalizeName,
  calculateConfidence,
  currentTaxYear,
  recordLearningEvent,
  analyzePatterns,
  getPatterns,
  getProposals,
  approveProposal,
  rejectProposal,
  propagateApproved,
  getExceptions,
  getStats,

  SOURCE_APP,
  MIN_CLIENTS_FOR_PROPOSAL,
  MIN_CONFIDENCE_FOR_PROPOSAL
};
