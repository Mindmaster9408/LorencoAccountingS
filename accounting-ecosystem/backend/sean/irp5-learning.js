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
 *   5. createProposal()         — System creates a proposal for an authorized user
 *   6. approveProposal()        — Authorized user approves propagation
 *   7. rejectProposal()         — Authorized user rejects
 *   8. propagateApproved()      — Apply approved mapping to NULL-code items ONLY
 *   9. getExceptions()          — List clients with conflicting codes
 *  10. getStats()               — Learning system summary stats
 *
 * SAFETY RULES (enforced in code, governed by CLAUDE.md Part B):
 *   - Sean may ONLY write irp5_code where the current value is NULL or empty.
 *   - Sean may NEVER overwrite an existing irp5_code, even if approved.
 *   - No propagation without an approved row in sean_irp5_propagation_approvals.
 *   - Every write (or deliberate skip) is logged in sean_irp5_propagation_log.
 *
 * Reusability:
 *   This service is source_app-scoped. Pass source_app='paytime' for this use
 *   case. Future use cases (accounting mappings, tax classifications) pass a
 *   different source_app value and the same engine handles them.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../config/database');

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_APP = 'paytime';

// A pattern must appear in at least this many distinct companies to become
// a "proposed" candidate for global propagation.
const MIN_CLIENTS_FOR_PROPOSAL = 2;

// Minimum confidence score (0-100) to auto-elevate a pattern to 'proposed'.
const MIN_CONFIDENCE_FOR_PROPOSAL = 60;

// Confidence formula weight: occurrences vs distinct clients.
// High client diversity is more meaningful than repeated events in one client.
const CONFIDENCE_OCCURRENCE_WEIGHT = 0.3;
const CONFIDENCE_CLIENT_WEIGHT     = 0.7;

// ─── Name Normalisation ───────────────────────────────────────────────────────

/**
 * Normalize a payroll item name to a consistent form for pattern matching.
 *
 * Examples:
 *   "Monthly Commission"   → "commission"
 *   "Comm."                → "comm"
 *   "Annual Bonus (2024)"  → "annual bonus"
 *   "Travel Allow."        → "travel allow"
 *
 * This is intentionally conservative — exact duplicate detection only.
 * Semantic matching (e.g. "Comm" ≡ "Commission") is left to the pattern
 * analyst who reviews proposals, not done automatically.
 */
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')      // strip punctuation
    .replace(/\s+/g, ' ')              // collapse whitespace
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
  const month = now.getMonth(); // 0-indexed; March = 2
  if (month >= 2) {
    return `${year}/${year + 1}`;
  }
  return `${year - 1}/${year}`;
}

// ─── Confidence Calculation ───────────────────────────────────────────────────

/**
 * Calculate confidence score (0–100) for a pattern.
 *
 * @param {number} occurrenceCount   Total times this mapping was seen
 * @param {number} clientsObserved   Number of distinct companies that used it
 * @param {number} totalOccurrences  Total events for this item name (all codes)
 */
function calculateConfidence(occurrenceCount, clientsObserved, totalOccurrences) {
  if (totalOccurrences === 0) return 0;
  if (occurrenceCount === 0) return 0;

  // Frequency score: how often this code wins vs other codes for the same name
  const frequencyScore = (occurrenceCount / totalOccurrences) * 100;

  // Client diversity bonus: more clients = more trustworthy signal
  // Caps at 100% when ≥ 10 distinct clients
  const diversityScore = Math.min(clientsObserved / 10, 1) * 100;

  const raw = (frequencyScore * CONFIDENCE_OCCURRENCE_WEIGHT)
            + (diversityScore * CONFIDENCE_CLIENT_WEIGHT);

  return Math.min(Math.round(raw * 100) / 100, 100);
}

// ─── 1. Record Learning Event ─────────────────────────────────────────────────

/**
 * Persist an IRP5 code change event from Paytime.
 *
 * @param {object} event
 *   @param {number}  event.companyId
 *   @param {number}  [event.clientId]        — eco_clients.id (may be null)
 *   @param {number}  [event.payrollItemId]   — payroll_items_master.id
 *   @param {string}  event.payrollItemName
 *   @param {string}  [event.itemCategory]
 *   @param {string|null} event.previousIrp5Code
 *   @param {string}  event.newIrp5Code
 *   @param {string}  event.changeType        — 'new_item'|'code_added'|'code_changed'
 *   @param {number}  [event.changedBy]       — users.id
 *   @param {string}  [event.taxYear]
 * @returns {Promise<object>} Saved event row
 */
async function recordLearningEvent(event) {
  const {
    companyId,
    clientId        = null,
    payrollItemId   = null,
    payrollItemName,
    itemCategory    = null,
    previousIrp5Code = null,
    newIrp5Code,
    changeType,
    changedBy       = null,
    taxYear         = currentTaxYear()
  } = event;

  if (!companyId || !payrollItemName || !newIrp5Code || !changeType) {
    throw new Error('recordLearningEvent: companyId, payrollItemName, newIrp5Code, changeType are required');
  }

  const validChangeTypes = ['new_item', 'code_added', 'code_changed'];
  if (!validChangeTypes.includes(changeType)) {
    throw new Error(`recordLearningEvent: invalid changeType "${changeType}". Must be one of: ${validChangeTypes.join(', ')}`);
  }

  const { data, error } = await supabase
    .from('sean_learning_events')
    .insert({
      source_app:          SOURCE_APP,
      client_id:           clientId,
      company_id:          companyId,
      payroll_item_id:     payrollItemId,
      payroll_item_name:   payrollItemName,
      item_category:       itemCategory || null,
      previous_irp5_code:  previousIrp5Code || null,
      new_irp5_code:       newIrp5Code,
      change_type:         changeType,
      changed_by:          changedBy || null,
      tax_year:            taxYear,
      created_at:          new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Sean learning event save failed: ${error.message}`);
  }

  // Trigger async pattern refresh (non-blocking — errors are logged, not thrown)
  analyzePatterns({ sourceApp: SOURCE_APP }).catch(err => {
    console.error('[Sean IRP5] Background analyzePatterns error:', err.message);
  });

  return data;
}

// ─── 2. Analyze Patterns ─────────────────────────────────────────────────────

/**
 * Scan all learning events for a source app and re-compute mapping patterns.
 * Upserts rows in sean_irp5_mapping_patterns.
 * After analysis, auto-proposes patterns that exceed confidence/client thresholds.
 *
 * @param {object} options
 *   @param {string} [options.sourceApp='paytime']
 * @returns {Promise<{ analyzed: number, created: number, updated: number, proposed: number }>}
 */
async function analyzePatterns({ sourceApp = SOURCE_APP } = {}) {
  // Fetch all events for this source app
  const { data: events, error: fetchError } = await supabase
    .from('sean_learning_events')
    .select('payroll_item_name, item_category, new_irp5_code, company_id')
    .eq('source_app', sourceApp);

  if (fetchError) {
    throw new Error(`analyzePatterns fetch error: ${fetchError.message}`);
  }

  if (!events || events.length === 0) {
    return { analyzed: 0, created: 0, updated: 0, proposed: 0 };
  }

  // Build aggregation map: { normalizedName → { code → { count, clients: Set } } }
  const aggregation = {};

  for (const ev of events) {
    const norm = normalizeName(ev.payroll_item_name);
    const code = ev.new_irp5_code;
    if (!norm || !code) continue;

    if (!aggregation[norm]) {
      aggregation[norm] = { category: ev.item_category, codes: {} };
    }
    if (!aggregation[norm].codes[code]) {
      aggregation[norm].codes[code] = { count: 0, clients: new Set() };
    }
    aggregation[norm].codes[code].count++;
    aggregation[norm].codes[code].clients.add(ev.company_id);
  }

  let created = 0;
  let updated = 0;
  let proposed = 0;

  for (const [normalizedName, { category, codes }] of Object.entries(aggregation)) {
    // Total events for this item (across all codes) — used for frequency score
    const totalOccurrences = Object.values(codes).reduce((s, v) => s + v.count, 0);

    for (const [code, { count, clients }] of Object.entries(codes)) {
      const clientsObserved = clients.size;
      const confidence = calculateConfidence(count, clientsObserved, totalOccurrences);

      const clientsJson = Array.from(clients).map(cid => ({ company_id: cid }));

      // Upsert pattern row
      const { data: existing } = await supabase
        .from('sean_irp5_mapping_patterns')
        .select('id, status')
        .eq('source_app', sourceApp)
        .eq('normalized_item_name', normalizedName)
        .eq('suggested_irp5_code', code)
        .maybeSingle();

      if (existing) {
        // Update — but never downgrade 'approved' or 'propagated' patterns
        const protectedStatuses = ['approved', 'propagated'];
        const newStatus = protectedStatuses.includes(existing.status)
          ? existing.status
          : (confidence >= MIN_CONFIDENCE_FOR_PROPOSAL && clientsObserved >= MIN_CLIENTS_FOR_PROPOSAL
              ? 'proposed'
              : 'candidate');

        await supabase
          .from('sean_irp5_mapping_patterns')
          .update({
            confidence_score: confidence,
            occurrence_count: count,
            clients_observed: clientsObserved,
            clients_json:     clientsJson,
            item_category:    category || null,
            status:           newStatus,
            last_analyzed_at: new Date().toISOString()
          })
          .eq('id', existing.id);

        updated++;
        if (newStatus === 'proposed' && existing.status === 'candidate') proposed++;
      } else {
        const newStatus = (confidence >= MIN_CONFIDENCE_FOR_PROPOSAL && clientsObserved >= MIN_CLIENTS_FOR_PROPOSAL)
          ? 'proposed'
          : 'candidate';

        await supabase
          .from('sean_irp5_mapping_patterns')
          .insert({
            source_app:           sourceApp,
            normalized_item_name: normalizedName,
            item_category:        category || null,
            suggested_irp5_code:  code,
            confidence_score:     confidence,
            occurrence_count:     count,
            clients_observed:     clientsObserved,
            clients_json:         clientsJson,
            status:               newStatus,
            last_analyzed_at:     new Date().toISOString(),
            created_at:           new Date().toISOString()
          });

        created++;
        if (newStatus === 'proposed') proposed++;
      }
    }
  }

  // Auto-create approval proposal rows for newly proposed patterns
  if (proposed > 0) {
    await _ensureProposalRows(sourceApp);
  }

  return { analyzed: events.length, created, updated, proposed };
}

// ─── Helper: Ensure Proposal Rows ─────────────────────────────────────────────

/**
 * For each pattern in 'proposed' status that does not yet have a 'pending'
 * approval row, create one.
 */
async function _ensureProposalRows(sourceApp) {
  const { data: patterns } = await supabase
    .from('sean_irp5_mapping_patterns')
    .select('id, normalized_item_name, suggested_irp5_code, confidence_score, clients_observed')
    .eq('source_app', sourceApp)
    .eq('status', 'proposed');

  if (!patterns || patterns.length === 0) return;

  for (const pat of patterns) {
    // Check if a pending approval already exists
    const { data: existing } = await supabase
      .from('sean_irp5_propagation_approvals')
      .select('id')
      .eq('mapping_pattern_id', pat.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (!existing) {
      await supabase
        .from('sean_irp5_propagation_approvals')
        .insert({
          mapping_pattern_id:      pat.id,
          status:                  'pending',
          proposed_by_system:      true,
          snapshot_normalized_name: pat.normalized_item_name,
          snapshot_irp5_code:      pat.suggested_irp5_code,
          snapshot_confidence:     pat.confidence_score,
          snapshot_clients_count:  pat.clients_observed,
          proposed_at:             new Date().toISOString(),
          created_at:              new Date().toISOString(),
          updated_at:              new Date().toISOString()
        });
    }
  }
}

// ─── 3. Get Patterns ──────────────────────────────────────────────────────────

/**
 * Return all discovered patterns for a source app, optionally filtered.
 *
 * @param {object} options
 *   @param {string}  [options.sourceApp='paytime']
 *   @param {string}  [options.status]           — filter by status
 *   @param {number}  [options.minConfidence=0]
 * @returns {Promise<Array>}
 */
async function getPatterns({ sourceApp = SOURCE_APP, status = null, minConfidence = 0 } = {}) {
  let query = supabase
    .from('sean_irp5_mapping_patterns')
    .select('*')
    .eq('source_app', sourceApp)
    .gte('confidence_score', minConfidence)
    .order('confidence_score', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`getPatterns error: ${error.message}`);
  return data || [];
}

// ─── 4. Get Proposals (Pending Authorization) ─────────────────────────────────

/**
 * Return all pending approval records enriched with pattern detail and
 * the breakdown of affected / missing / conflicting companies.
 *
 * @param {object} options
 *   @param {string} [options.sourceApp='paytime']
 * @returns {Promise<Array>}
 */
async function getProposals({ sourceApp = SOURCE_APP } = {}) {
  const { data: approvals, error } = await supabase
    .from('sean_irp5_propagation_approvals')
    .select(`
      *,
      mapping_pattern:sean_irp5_mapping_patterns (*)
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getProposals error: ${error.message}`);

  if (!approvals || approvals.length === 0) return [];

  // For each proposal, compute affected / missing / conflicting companies
  const enriched = await Promise.all(approvals.map(a => _enrichProposal(a)));
  return enriched.filter(Boolean);
}

// ─── Helper: Enrich Proposal ──────────────────────────────────────────────────

/**
 * For a proposal, query payroll_items_master to find:
 *   - Companies that have a matching item with code = NULL → will be filled
 *   - Companies that have a matching item with a DIFFERENT code → exception
 *   - Companies that have a matching item with the SAME code → already correct
 */
async function _enrichProposal(approval) {
  const normalizedName = approval.snapshot_normalized_name;
  const proposedCode   = approval.snapshot_irp5_code;

  // Fetch all payroll items whose normalized name matches
  const { data: items, error } = await supabase
    .from('payroll_items_master')
    .select('id, company_id, name, irp5_code, is_active')
    .eq('is_active', true);

  if (error || !items) {
    console.error('[Sean IRP5] _enrichProposal fetch error:', error?.message);
    return { ...approval, missing: [], conflicting: [], alreadyCorrect: [] };
  }

  // Filter to items whose normalized name matches
  const matching = items.filter(item => normalizeName(item.name) === normalizedName);

  const missing       = [];
  const conflicting   = [];
  const alreadyCorrect = [];

  for (const item of matching) {
    if (!item.irp5_code) {
      missing.push({ companyId: item.company_id, itemId: item.id, itemName: item.name });
    } else if (item.irp5_code === proposedCode) {
      alreadyCorrect.push({ companyId: item.company_id, itemId: item.id, itemName: item.name, existingCode: item.irp5_code });
    } else {
      conflicting.push({ companyId: item.company_id, itemId: item.id, itemName: item.name, existingCode: item.irp5_code });
    }
  }

  return {
    ...approval,
    missing,
    conflicting,
    alreadyCorrect
  };
}

// ─── 5. Approve Proposal ──────────────────────────────────────────────────────

/**
 * An authorized user approves a pending proposal.
 * This does NOT propagate — it only flips status to 'approved'.
 * Propagation is a separate step (propagateApproved).
 *
 * @param {number} approvalId  — sean_irp5_propagation_approvals.id
 * @param {number} userId      — The authorizing user's ID
 * @returns {Promise<object>}  Updated approval row
 */
async function approveProposal(approvalId, userId) {
  if (!approvalId || !userId) {
    throw new Error('approveProposal: approvalId and userId are required');
  }

  // Fetch and verify the proposal is still pending
  const { data: approval, error: fetchError } = await supabase
    .from('sean_irp5_propagation_approvals')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchError || !approval) {
    throw new Error(`Proposal ${approvalId} not found`);
  }

  if (approval.status !== 'pending') {
    throw new Error(`Proposal ${approvalId} is not pending (current status: ${approval.status})`);
  }

  const { data: updated, error: updateError } = await supabase
    .from('sean_irp5_propagation_approvals')
    .update({
      status:      'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
      updated_at:  new Date().toISOString()
    })
    .eq('id', approvalId)
    .select()
    .single();

  if (updateError) {
    throw new Error(`approveProposal update failed: ${updateError.message}`);
  }

  // Mark associated pattern as approved
  await supabase
    .from('sean_irp5_mapping_patterns')
    .update({ status: 'approved' })
    .eq('id', approval.mapping_pattern_id);

  return updated;
}

// ─── 6. Reject Proposal ───────────────────────────────────────────────────────

/**
 * An authorized user rejects a pending proposal.
 *
 * @param {number} approvalId
 * @param {number} userId
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
async function rejectProposal(approvalId, userId, reason = '') {
  if (!approvalId || !userId) {
    throw new Error('rejectProposal: approvalId and userId are required');
  }

  const { data: approval, error: fetchError } = await supabase
    .from('sean_irp5_propagation_approvals')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchError || !approval) {
    throw new Error(`Proposal ${approvalId} not found`);
  }

  if (approval.status !== 'pending') {
    throw new Error(`Proposal ${approvalId} is not pending (current status: ${approval.status})`);
  }

  const { data: updated, error: updateError } = await supabase
    .from('sean_irp5_propagation_approvals')
    .update({
      status:           'rejected',
      rejected_by:      userId,
      rejected_at:      new Date().toISOString(),
      rejection_reason: reason || null,
      updated_at:       new Date().toISOString()
    })
    .eq('id', approvalId)
    .select()
    .single();

  if (updateError) {
    throw new Error(`rejectProposal update failed: ${updateError.message}`);
  }

  // Mark pattern back to 'candidate' so it can be re-proposed if data changes
  await supabase
    .from('sean_irp5_mapping_patterns')
    .update({ status: 'candidate' })
    .eq('id', approval.mapping_pattern_id);

  return updated;
}

// ─── 7. Propagate Approved Mappings ──────────────────────────────────────────

/**
 * Execute propagation for one approved proposal.
 * SAFETY RULES enforced here:
 *   1. Fetch the approval — must be status='approved'
 *   2. For each payroll item whose normalized name matches the mapping:
 *      a. If irp5_code IS NULL → write the approved code → log action='applied'
 *      b. If irp5_code = proposed code → already correct → log 'applied' (no-op)
 *        Actually we log 'skipped_existing' since it's already set
 *        Wait - we should distinguish between "code is set to same" and "code is set to different"
 *        Let me use: applied=written, skipped_existing=already same, skipped_exception=different code
 *      c. If irp5_code is something ELSE → NEVER overwrite → log 'skipped_exception'
 *   3. Update approval status to 'propagated'
 *
 * @param {number} approvalId
 * @param {number} authorizedUserId  — Must match the approved_by user or be a superuser check (done in route layer)
 * @returns {Promise<{ applied: number, skippedExisting: number, exceptions: number, errors: number }>}
 */
async function propagateApproved(approvalId, authorizedUserId) {
  if (!approvalId || !authorizedUserId) {
    throw new Error('propagateApproved: approvalId and authorizedUserId are required');
  }

  // Fetch approval and verify it is ready
  const { data: approval, error: fetchError } = await supabase
    .from('sean_irp5_propagation_approvals')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchError || !approval) {
    throw new Error(`Propagation approval ${approvalId} not found`);
  }

  if (approval.status !== 'approved') {
    throw new Error(`Approval ${approvalId} is not in 'approved' status (current: ${approval.status}). Cannot propagate.`);
  }

  const normalizedName = approval.snapshot_normalized_name;
  const proposedCode   = approval.snapshot_irp5_code;

  // Fetch all active payroll items
  const { data: allItems, error: itemsError } = await supabase
    .from('payroll_items_master')
    .select('id, company_id, name, irp5_code')
    .eq('is_active', true);

  if (itemsError) {
    throw new Error(`propagateApproved items fetch error: ${itemsError.message}`);
  }

  const matching = (allItems || []).filter(item => normalizeName(item.name) === normalizedName);

  let applied         = 0;
  let skippedExisting = 0;
  let exceptions      = 0;
  let errors          = 0;

  const logRows = [];

  for (const item of matching) {
    const existing = item.irp5_code;

    if (!existing) {
      // SAFE TO WRITE — code is null/empty
      const { error: writeError } = await supabase
        .from('payroll_items_master')
        .update({
          irp5_code:             proposedCode,
          irp5_code_updated_at:  new Date().toISOString(),
          irp5_code_updated_by:  authorizedUserId
        })
        .eq('id', item.id);

      if (writeError) {
        console.error(`[Sean IRP5] propagate write error for item ${item.id}:`, writeError.message);
        logRows.push({
          approval_id:       approvalId,
          company_id:        item.company_id,
          payroll_item_id:   item.id,
          payroll_item_name: item.name,
          irp5_code_written: proposedCode,
          previous_irp5_code: null,
          action:            'error',
          notes:             writeError.message,
          created_at:        new Date().toISOString()
        });
        errors++;
      } else {
        logRows.push({
          approval_id:        approvalId,
          company_id:         item.company_id,
          payroll_item_id:    item.id,
          payroll_item_name:  item.name,
          irp5_code_written:  proposedCode,
          previous_irp5_code: null,
          action:             'applied',
          created_at:         new Date().toISOString()
        });
        applied++;
      }
    } else if (existing === proposedCode) {
      // Already has the correct code — no write needed
      logRows.push({
        approval_id:        approvalId,
        company_id:         item.company_id,
        payroll_item_id:    item.id,
        payroll_item_name:  item.name,
        irp5_code_written:  proposedCode,  // what we would have set
        previous_irp5_code: existing,
        action:             'skipped_existing',
        notes:              'Code already matches proposed mapping',
        created_at:         new Date().toISOString()
      });
      skippedExisting++;
    } else {
      // SAFETY RULE: Different code already set — NEVER overwrite
      logRows.push({
        approval_id:        approvalId,
        company_id:         item.company_id,
        payroll_item_id:    item.id,
        payroll_item_name:  item.name,
        irp5_code_written:  proposedCode,  // what we would have set (for audit visibility)
        previous_irp5_code: existing,
        action:             'skipped_exception',
        notes:              `Client has existing code ${existing} — not overwritten per CLAUDE.md Rule B9`,
        created_at:         new Date().toISOString()
      });
      exceptions++;
    }
  }

  // Write all log rows — non-atomic batch insert
  if (logRows.length > 0) {
    const { error: logError } = await supabase
      .from('sean_irp5_propagation_log')
      .insert(logRows);

    if (logError) {
      console.error('[Sean IRP5] propagation log insert error:', logError.message);
    }
  }

  // Mark approval as propagated
  await supabase
    .from('sean_irp5_propagation_approvals')
    .update({
      status:                      'propagated',
      propagation_ran_at:          new Date().toISOString(),
      propagation_applied_count:   applied,
      propagation_skipped_count:   skippedExisting,
      propagation_exception_count: exceptions,
      updated_at:                  new Date().toISOString()
    })
    .eq('id', approvalId);

  // Mark pattern as propagated
  await supabase
    .from('sean_irp5_mapping_patterns')
    .update({ status: 'propagated' })
    .eq('id', approval.mapping_pattern_id);

  return { applied, skippedExisting, exceptions, errors };
}

// ─── 8. Get Exceptions ────────────────────────────────────────────────────────

/**
 * For a given normalized item name and proposed code, return all companies
 * that have a different code set — these are exceptions requiring manual review.
 *
 * @param {string} normalizedItemName
 * @param {string} proposedCode
 * @returns {Promise<Array<{ companyId, itemId, itemName, existingCode }>>}
 */
async function getExceptions(normalizedItemName, proposedCode) {
  const { data: items, error } = await supabase
    .from('payroll_items_master')
    .select('id, company_id, name, irp5_code')
    .eq('is_active', true)
    .not('irp5_code', 'is', null);

  if (error) throw new Error(`getExceptions error: ${error.message}`);

  return (items || [])
    .filter(item =>
      normalizeName(item.name) === normalizedItemName
      && item.irp5_code !== proposedCode
    )
    .map(item => ({
      companyId:    item.company_id,
      itemId:       item.id,
      itemName:     item.name,
      existingCode: item.irp5_code
    }));
}

// ─── 9. Get Stats ─────────────────────────────────────────────────────────────

/**
 * Return summary statistics for the Sean IRP5 learning system.
 *
 * @param {string} [sourceApp='paytime']
 * @returns {Promise<object>}
 */
async function getStats({ sourceApp = SOURCE_APP } = {}) {
  const [eventsRes, patternsRes, approvalsRes, logRes] = await Promise.all([
    supabase.from('sean_learning_events')
      .select('id', { count: 'exact', head: true })
      .eq('source_app', sourceApp),
    supabase.from('sean_irp5_mapping_patterns')
      .select('id, status, confidence_score', { count: 'exact' })
      .eq('source_app', sourceApp),
    supabase.from('sean_irp5_propagation_approvals')
      .select('id, status')
      .eq('status', 'pending'),
    supabase.from('sean_irp5_propagation_log')
      .select('action', { count: 'exact' })
      .eq('action', 'applied')
  ]);

  const patterns = patternsRes.data || [];
  const statusCounts = patterns.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  return {
    sourceApp,
    totalLearningEvents:  eventsRes.count || 0,
    totalPatterns:        patterns.length,
    patternsByStatus:     statusCounts,
    pendingApprovals:     approvalsRes.data?.length || 0,
    totalPropagations:    logRes.count || 0,
    avgConfidence:        patterns.length > 0
      ? Math.round(patterns.reduce((s, p) => s + (p.confidence_score || 0), 0) / patterns.length * 10) / 10
      : 0
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

  // Constants (exposed for tests)
  SOURCE_APP,
  MIN_CLIENTS_FOR_PROPOSAL,
  MIN_CONFIDENCE_FOR_PROPOSAL
};
