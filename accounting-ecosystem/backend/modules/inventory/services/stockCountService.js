'use strict';

/**
 * ============================================================================
 * Stock Count Service — Codebox 03
 * ============================================================================
 * Forensic-grade stock counting and variance control.
 *
 * ALL stock variance mutations MUST go through adjustStockTx().
 * No direct UPDATE to current_stock is ever permitted here.
 *
 * Workflow:
 *   createCountSession()     → status: in_progress (lines snapshot system qty)
 *   updateCountLine()        → counter enters counted_quantity per line
 *   submitCount()            → calculates variance; status: submitted
 *   approveCountSession()    → approved | rejected | recount_required
 *   applyApprovedVariance()  → calls adjustStockTx per line; status: applied
 *
 * Key invariants:
 *   - applyApprovedVariance ONLY runs on status='approved'
 *   - Status is flipped to 'applied' before processing (idempotency guard)
 *   - Rejected sessions CANNOT mutate stock
 *   - Applied sessions are immutable
 * ============================================================================
 */

const { adjustStockTx } = require('./stockMutationService');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a unique-enough session number.
 * Format: SC-YYYYMMDD-XXXX (e.g. SC-20260601-4721)
 */
function generateSessionNumber() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `SC-${date}-${rand}`;
}

// ─── createCountSession ───────────────────────────────────────────────────────
/**
 * Create a new count session and snapshot all relevant items into count lines.
 *
 * @param {object} supabase   Supabase client
 * @param {number} companyId  Company scope (from JWT)
 * @param {object} options
 *   @param {number|null} warehouseId    Filter items by warehouse (null = all)
 *   @param {string}      countType      'full' | 'cycle' | 'spot' | 'recount'
 *   @param {string|null} notes
 *   @param {boolean}     blindCount     Hide system_qty until submitted
 *   @param {boolean}     freezeInventory Flag only (enforcement deferred)
 *   @param {number|null} startedBy      User ID from JWT
 *   @param {string}      mode           'full' | 'category' | 'low_stock' | 'items'
 *   @param {string|null} category       Filter by category (mode=category)
 *   @param {number[]}    itemIds        Specific item IDs (mode=items)
 * @returns {{ success, session, lines } | { success: false, error }}
 */
async function createCountSession(supabase, companyId, {
  warehouseId    = null,
  countType      = 'full',
  notes          = null,
  blindCount     = false,
  freezeInventory = false,
  startedBy      = null,
  mode           = 'full',
  category       = null,
  itemIds        = null,
} = {}) {
  const validCountTypes = ['full', 'cycle', 'spot', 'recount'];
  if (!validCountTypes.includes(countType)) {
    return { success: false, error: `count_type must be one of: ${validCountTypes.join(', ')}` };
  }

  const sessionNumber = generateSessionNumber();

  const { data: session, error: sessionErr } = await supabase
    .from('stock_count_sessions')
    .insert({
      company_id:      companyId,
      session_number:  sessionNumber,
      warehouse_id:    warehouseId || null,
      count_type:      countType,
      status:          'in_progress',
      started_by:      startedBy || null,
      started_at:      new Date().toISOString(),
      notes:           notes || null,
      blind_count:     !!blindCount,
      freeze_inventory: !!freezeInventory,
    })
    .select()
    .single();

  if (sessionErr) return { success: false, error: sessionErr.message };

  const linesResult = await generateCountLines(supabase, companyId, session.id, {
    mode, category, itemIds, warehouseId,
  });

  if (!linesResult.success) {
    // Roll back session if lines failed
    await supabase.from('stock_count_sessions').delete().eq('id', session.id);
    return { success: false, error: linesResult.error };
  }

  return { success: true, session, lines: linesResult.lines };
}

// ─── generateCountLines ───────────────────────────────────────────────────────
/**
 * Snapshot current_stock for relevant items into stock_count_lines.
 * Called by createCountSession — not exposed directly in routes.
 *
 * @param {object}   supabase
 * @param {number}   companyId
 * @param {number}   sessionId
 * @param {object}   options
 *   @param {string}      mode       'full' | 'category' | 'low_stock' | 'items'
 *   @param {string|null} category
 *   @param {number[]|null} itemIds
 *   @param {number|null}   warehouseId
 * @returns {{ success, lines } | { success: false, error }}
 */
async function generateCountLines(supabase, companyId, sessionId, {
  mode        = 'full',
  category    = null,
  itemIds     = null,
  warehouseId = null,
} = {}) {
  let query = supabase
    .from('inventory_items')
    .select('id, name, sku, current_stock, min_stock, average_cost, unit, costing_method, item_type')
    .eq('company_id', companyId)
    .eq('is_active', true);

  if (warehouseId) query = query.eq('warehouse_id', parseInt(warehouseId));
  if (mode === 'category' && category)   query = query.eq('category', category);
  if (mode === 'items' && Array.isArray(itemIds) && itemIds.length > 0) {
    query = query.in('id', itemIds.map(Number));
  }

  query = query.order('name');

  const { data: items, error: itemsErr } = await query;
  if (itemsErr) return { success: false, error: itemsErr.message };
  if (!items || items.length === 0) {
    return { success: false, error: 'No active items found matching the count criteria' };
  }

  let filteredItems = items;
  if (mode === 'low_stock') {
    // Filter items at or below min_stock
    filteredItems = items.filter(i =>
      (parseFloat(i.current_stock) || 0) <= (parseFloat(i.min_stock) || 0)
    );
    if (filteredItems.length === 0) {
      return { success: false, error: 'No low-stock items found to count' };
    }
  }

  const lines = filteredItems.map(item => ({
    company_id:       companyId,
    session_id:       sessionId,
    item_id:          item.id,
    system_quantity:  parseFloat(item.current_stock) || 0,
    counted_quantity: null,
    variance_quantity: null,
    average_cost:     parseFloat(item.average_cost) || 0,
    variance_value:   null,
    variance_reason:  null,
    variance_notes:   null,
    recounted:        false,
  }));

  const { data: insertedLines, error: linesErr } = await supabase
    .from('stock_count_lines')
    .insert(lines)
    .select('*, inventory_items:item_id(name, sku, unit, item_type)');

  if (linesErr) return { success: false, error: linesErr.message };

  return { success: true, lines: insertedLines };
}

// ─── updateCountLine ──────────────────────────────────────────────────────────
/**
 * Update counted_quantity and optional variance reason for one line.
 * Only allowed when session status is 'in_progress' or 'draft'.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} sessionId
 * @param {number} lineId
 * @param {object} options
 *   @param {number}      countedQuantity  >= 0
 *   @param {string|null} varianceReason
 *   @param {string|null} varianceNotes
 * @returns {{ success, line } | { success: false, error }}
 */
async function updateCountLine(supabase, companyId, sessionId, lineId, {
  countedQuantity,
  varianceReason = null,
  varianceNotes  = null,
} = {}) {
  if (countedQuantity === null || countedQuantity === undefined) {
    return { success: false, error: 'counted_quantity is required' };
  }
  const qty = parseFloat(countedQuantity);
  if (isNaN(qty) || qty < 0) {
    return { success: false, error: 'counted_quantity must be a non-negative number' };
  }

  // Verify session belongs to company and is still editable
  const { data: session } = await supabase
    .from('stock_count_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .eq('company_id', companyId)
    .single();

  if (!session) return { success: false, error: 'Count session not found' };
  if (!['in_progress', 'draft'].includes(session.status)) {
    return { success: false, error: `Cannot update lines on a session with status '${session.status}'` };
  }

  const { data: line, error: lineErr } = await supabase
    .from('stock_count_lines')
    .update({
      counted_quantity: qty,
      variance_reason:  varianceReason || null,
      variance_notes:   varianceNotes  || null,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', lineId)
    .eq('session_id', sessionId)
    .eq('company_id', companyId)
    .select('*, inventory_items:item_id(name, sku, unit)')
    .single();

  if (lineErr) return { success: false, error: lineErr.message };

  return { success: true, line };
}

// ─── submitCount ──────────────────────────────────────────────────────────────
/**
 * Submit a count session for approval.
 * Calculates variance_quantity and variance_value for every line.
 * All lines must have a counted_quantity before submission is allowed.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} sessionId
 * @param {number} userId
 * @returns {{ success, session_id, status, summary } | { success: false, error }}
 */
async function submitCount(supabase, companyId, sessionId, userId) {
  const { data: session } = await supabase
    .from('stock_count_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('company_id', companyId)
    .single();

  if (!session) return { success: false, error: 'Count session not found' };
  if (!['in_progress', 'draft'].includes(session.status)) {
    return { success: false, error: `Session status '${session.status}' cannot be submitted` };
  }

  const { data: lines, error: linesErr } = await supabase
    .from('stock_count_lines')
    .select('*')
    .eq('session_id', sessionId)
    .eq('company_id', companyId);

  if (linesErr) return { success: false, error: linesErr.message };
  if (!lines || lines.length === 0) {
    return { success: false, error: 'No count lines found for this session' };
  }

  const uncounted = lines.filter(l => l.counted_quantity === null || l.counted_quantity === undefined);
  if (uncounted.length > 0) {
    return {
      success: false,
      error: `${uncounted.length} line(s) have no counted quantity. Count all items before submitting.`,
    };
  }

  // Calculate and update variances for each line
  for (const line of lines) {
    const varQty   = parseFloat(line.counted_quantity) - parseFloat(line.system_quantity);
    const varValue = varQty * (parseFloat(line.average_cost) || 0);

    const { error: updateErr } = await supabase
      .from('stock_count_lines')
      .update({
        variance_quantity: varQty,
        variance_value:    varValue,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', line.id)
      .eq('company_id', companyId);

    if (updateErr) {
      return { success: false, error: `Failed to calculate variance for line ${line.id}: ${updateErr.message}` };
    }
  }

  const { error: sessionErr } = await supabase
    .from('stock_count_sessions')
    .update({
      status:       'submitted',
      submitted_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq('id', sessionId)
    .eq('company_id', companyId);

  if (sessionErr) return { success: false, error: sessionErr.message };

  const variantLines        = lines.filter(l => {
    const v = parseFloat(l.counted_quantity) - parseFloat(l.system_quantity);
    return v !== 0;
  });
  const totalVarianceValue  = variantLines.reduce((sum, l) => {
    const v = parseFloat(l.counted_quantity) - parseFloat(l.system_quantity);
    return sum + (v * (parseFloat(l.average_cost) || 0));
  }, 0);

  return {
    success: true,
    session_id:           sessionId,
    status:               'submitted',
    total_lines:          lines.length,
    variant_lines:        variantLines.length,
    total_variance_value: totalVarianceValue,
  };
}

// ─── approveCountSession ──────────────────────────────────────────────────────
/**
 * Approve, reject, or request recount on a submitted session.
 * Creates an immutable approval record regardless of action.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} sessionId
 * @param {number} userId
 * @param {string} action    'approved' | 'rejected' | 'recount_required'
 * @param {string|null} notes
 * @returns {{ success, session_id, status, action } | { success: false, error }}
 */
async function approveCountSession(supabase, companyId, sessionId, userId, action, notes = null) {
  const validActions = ['approved', 'rejected', 'recount_required'];
  if (!validActions.includes(action)) {
    return { success: false, error: `action must be one of: ${validActions.join(', ')}` };
  }

  const { data: session } = await supabase
    .from('stock_count_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .eq('company_id', companyId)
    .single();

  if (!session) return { success: false, error: 'Count session not found' };
  if (session.status !== 'submitted') {
    return {
      success: false,
      error: `Only submitted sessions can be approved/rejected (current: ${session.status})`,
    };
  }

  // Create immutable approval record
  const { error: approvalErr } = await supabase
    .from('stock_count_approvals')
    .insert({
      company_id:      companyId,
      session_id:      sessionId,
      approved_by:     userId,
      approval_action: action,
      approval_notes:  notes || null,
    });

  if (approvalErr) return { success: false, error: approvalErr.message };

  // Map action to new session status
  const statusMap = {
    approved:         'approved',
    rejected:         'rejected',
    recount_required: 'in_progress',   // Re-open for recount
  };
  const newStatus = statusMap[action];

  const sessionUpdates = {
    status:     newStatus,
    updated_at: new Date().toISOString(),
  };
  if (action === 'approved') {
    sessionUpdates.approved_by = userId;
    sessionUpdates.approved_at = new Date().toISOString();
  }

  const { error: sessionErr } = await supabase
    .from('stock_count_sessions')
    .update(sessionUpdates)
    .eq('id', sessionId)
    .eq('company_id', companyId);

  if (sessionErr) return { success: false, error: sessionErr.message };

  return { success: true, session_id: sessionId, status: newStatus, action };
}

// ─── applyApprovedVariance ────────────────────────────────────────────────────
/**
 * Apply all non-zero variances from an approved session to actual stock.
 *
 * CRITICAL RULES:
 *   1. Only runs on sessions with status='approved'
 *   2. Status is flipped to 'applied' BEFORE processing (idempotency guard)
 *      — if the server dies mid-apply, the session is already marked applied
 *      — re-running returns an error (status already 'applied')
 *   3. ALL stock mutations go through adjustStockTx() — no direct DB writes
 *   4. movement_type = 'count_adjustment_in' (gain) or 'count_adjustment_out' (loss)
 *   5. source_type = 'stock_count', source_id = sessionId
 *   6. Zero-variance lines are skipped (no movement created)
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} sessionId
 * @param {number} userId
 * @returns {{ success, session_id, applied, skipped, failed, results } | { success: false, error }}
 */
async function applyApprovedVariance(supabase, companyId, sessionId, userId) {
  const { data: session } = await supabase
    .from('stock_count_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('company_id', companyId)
    .single();

  if (!session) return { success: false, error: 'Count session not found' };
  if (session.status !== 'approved') {
    return { success: false, error: `Only approved sessions can be applied (current: ${session.status})` };
  }

  // Idempotency guard: flip to 'applied' using a conditional update.
  // The .eq('status', 'approved') ensures this only succeeds once.
  const { data: lockResult, error: lockErr } = await supabase
    .from('stock_count_sessions')
    .update({
      status:     'applied',
      applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .eq('company_id', companyId)
    .eq('status', 'approved')
    .select('id');

  if (lockErr) return { success: false, error: lockErr.message };
  if (!lockResult || lockResult.length === 0) {
    return { success: false, error: 'Session was already applied or status changed concurrently' };
  }

  const { data: lines, error: linesErr } = await supabase
    .from('stock_count_lines')
    .select('*')
    .eq('session_id', sessionId)
    .eq('company_id', companyId);

  if (linesErr) return { success: false, error: linesErr.message };

  let applied = 0;
  let skipped = 0;
  let failed  = 0;
  const results = [];

  for (const line of lines || []) {
    const varQty = parseFloat(line.variance_quantity);

    if (isNaN(varQty) || varQty === 0) {
      skipped++;
      continue;
    }

    // Positive variance = stock gained (count_adjustment_in)
    // Negative variance = stock lost  (count_adjustment_out)
    const movementType = varQty > 0 ? 'count_adjustment_in' : 'count_adjustment_out';
    const notesParts   = [`Stock count variance`];
    if (line.variance_reason) notesParts.push(line.variance_reason);
    if (line.variance_notes)  notesParts.push(line.variance_notes);

    const result = await adjustStockTx(supabase, {
      companyId:    companyId,
      itemId:       line.item_id,
      delta:        varQty,                          // positive or negative
      movementType: movementType,
      warehouseId:  session.warehouse_id || null,
      reference:    session.session_number,
      notes:        notesParts.join(' — '),
      unitCost:     parseFloat(line.average_cost) || null,
      createdBy:    userId,
      sourceType:   'stock_count',
      sourceId:     String(sessionId),
    });

    if (result.success) {
      applied++;
      results.push({
        line_id:      line.id,
        item_id:      line.item_id,
        variance:     varQty,
        new_stock:    result.new_stock,
        new_avg_cost: result.new_avg_cost,
        status:       'applied',
      });
    } else {
      failed++;
      results.push({
        line_id:  line.id,
        item_id:  line.item_id,
        variance: varQty,
        status:   'failed',
        error:    result.error,
      });
    }
  }

  return {
    success:    true,
    session_id: sessionId,
    status:     'applied',
    applied,
    skipped,
    failed,
    results,
  };
}

// ─── getCountSession ──────────────────────────────────────────────────────────
/**
 * Fetch a session with its lines and approval history.
 * Enforces blind_count: system_quantity and variance are hidden until submitted.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} sessionId
 * @returns {{ success, session, lines, approvals } | { success: false, error }}
 */
async function getCountSession(supabase, companyId, sessionId) {
  const { data: session, error: sessionErr } = await supabase
    .from('stock_count_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('company_id', companyId)
    .single();

  if (sessionErr || !session) return { success: false, error: 'Count session not found' };

  const { data: lines, error: linesErr } = await supabase
    .from('stock_count_lines')
    .select('*, inventory_items:item_id(name, sku, unit, item_type)')
    .eq('session_id', sessionId)
    .eq('company_id', companyId)
    .order('created_at');

  if (linesErr) return { success: false, error: linesErr.message };

  const { data: approvals } = await supabase
    .from('stock_count_approvals')
    .select('*')
    .eq('session_id', sessionId)
    .eq('company_id', companyId)
    .order('created_at');

  // Blind count: hide system_quantity and variance until session is submitted/approved/applied
  const isBlind     = session.blind_count;
  const isSubmitted = ['submitted', 'approved', 'rejected', 'applied'].includes(session.status);
  const reveal      = !isBlind || isSubmitted;

  const processedLines = (lines || []).map(line => {
    const l = { ...line };
    if (!reveal) {
      l.system_quantity  = null;   // Hidden: counter must count blind
      l.variance_quantity = null;
      l.variance_value    = null;
    }
    return l;
  });

  return {
    success:   true,
    session,
    lines:     processedLines,
    approvals: approvals || [],
    blind_revealed: reveal,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createCountSession,
  generateCountLines,
  updateCountLine,
  submitCount,
  approveCountSession,
  applyApprovedVariance,
  getCountSession,
};
