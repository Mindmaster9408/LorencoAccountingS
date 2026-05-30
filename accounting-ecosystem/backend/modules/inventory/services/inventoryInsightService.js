'use strict';

/**
 * ============================================================================
 * Inventory Insight Service — Codebox 12 Pilot Lockdown
 * ============================================================================
 * Structured operational explanations for Lorenco Storehouse.
 *
 * Provides context-aware explanations tied to operational states.
 * This is the safe AI advisory layer:
 *
 *   ✓ Reads operational data and produces human-readable insight
 *   ✓ Recommends actions
 *   ✓ Explains causes and impacts
 *   ✗ Never mutates any data
 *   ✗ Never bypasses permissions or approvals
 *   ✗ Never becomes source of truth
 *   ✗ Never makes autonomous decisions
 *
 * Sean AI Integration Note:
 *   These functions expose the data-context layer Sean will consume.
 *   Sean can call these endpoints to understand the operational state
 *   before generating its own natural-language guidance.
 *   The structured output here is the authoritative data; Sean adds narrative.
 *
 * Hard rules:
 *   - Read-only. No mutations.
 *   - All queries scoped to companyId.
 *   - Returns null for unknown/inapplicable insight types.
 * ============================================================================
 */

// ─── Explanation library ──────────────────────────────────────────────────────
// Each entry maps to a health check 'type' or a named operational context.
// Extended as new operational patterns are identified.

const INSIGHTS = {

  stock_valuation_gap: {
    title:       'Why is my stock valuation showing R0 for some items?',
    explanation: 'When items are created without a purchase receipt, Storehouse has no cost basis to assign. The weighted average cost remains R0 until the first stock receipt is processed. Any stock on hand at R0 will appear in your valuation report with zero value — understating your actual inventory worth.',
    impact:      'Stock valuation reports will understate total inventory value. Gross profit calculations may be affected if sell prices reference cost.',
    recommendation: 'Process a Quick Receive or raise a Purchase Order for these items. Once received, the weighted average cost is automatically calculated from the receipt price.',
    prevention:  'Always receive stock through Quick Receive or Purchase Orders — never through manual stock adjustments that do not carry a unit cost.'
  },

  overdue_procurement: {
    title:       'Why are some purchase orders overdue?',
    explanation: 'A purchase order is marked overdue when the expected delivery date has passed and the order is still in Approved or Ordered status. This means stock that was planned to arrive has not been received.',
    impact:      'Reserved stock waiting for these POs may cause fulfilment shortages. Production work orders requiring these materials may be blocked.',
    recommendation: 'Contact the supplier to confirm the revised delivery date and update the PO accordingly, or cancel and re-raise with a new supplier.',
    prevention:  'Set realistic expected dates when creating POs. Use the Procurement tab to monitor lead times against actual delivery performance.'
  },

  production_blockage: {
    title:       'Why are some work orders stuck In Progress?',
    explanation: 'A work order enters "in progress" status when it is started. If it remains in that status for an extended period (7+ days), it typically means materials were never fully issued, the batch was physically completed but not recorded in the system, or the completion step was skipped.',
    impact:      'Materials reserved for stuck work orders remain unavailable for other production runs. Production costing cannot be finalized until the WO is completed or cancelled.',
    recommendation: 'Review each stuck WO: issue any missing materials, record actual output, and complete or cancel the WO. Cancelled WOs automatically release their material reservations.',
    prevention:  'Adopt a discipline of completing or cancelling work orders within 24 hours of the last production activity.'
  },

  stock_shortage: {
    title:       'Why are some items overcommitted?',
    explanation: 'An item becomes overcommitted when the sum of active stock reservations exceeds the quantity currently on hand. This happens when sales orders or work orders were confirmed against a stock level that has since changed — for example, because other orders consumed the available stock first.',
    impact:      'Fulfilment of reserved orders will fail or be partial when stock is actually picked. Overcommitted items risk causing production stoppages or customer delivery failures.',
    recommendation: 'Either receive additional stock for these items immediately, or cancel/reduce reservations for lower-priority orders to free availability for the highest-priority commitment.',
    prevention:  'Use ATP (Available-to-Promise) checks before confirming sales orders. The Sales Orders tab shows real-time available quantity before allocation.'
  },

  warehouse_gap: {
    title:       'Why are some items not assigned to a warehouse?',
    explanation: 'Items without a warehouse assignment are not physically tracked to a specific storage location. While stock quantities are still accurate at the company level, warehouse-level stock reports and bin-level location tracking will not reflect these items.',
    impact:      'Warehouse stock reports will be incomplete. Warehouse transfers cannot source items without a warehouse. Cycle counts by warehouse will miss unassigned items.',
    recommendation: 'Edit each item and assign it to the appropriate warehouse. If your operation uses a single main warehouse, bulk-assign all items to that location.',
    prevention:  'Set a default warehouse in the Warehouses tab — new items will then automatically suggest that location.'
  },

  uom_gap: {
    title:       'Why should I set a base unit on items?',
    explanation: 'The base unit is the canonical stock unit for an item — the unit all quantities are expressed in (e.g., kg for flour, each for bottles). Without a base unit, Storehouse cannot convert purchase pack sizes (like 25kg bags) to the correct stock quantity, and BOM recipes cannot be written in grams while stock is tracked in kilograms.',
    impact:      'Without base units, pack-size purchasing will not apply correct cost-per-unit to weighted average. BOM cost summaries may be incorrect by a factor of 1000 or more (e.g., 500g vs 0.5 kg).',
    recommendation: 'For each item: set the base_unit (e.g., "kg"), then click the UOM button to add purchase pack conversions (e.g., 1 bag_25kg = 25 kg).',
    prevention:  'Configure UOM before entering any purchase orders or BOMs for the item.'
  },

  count_backlog: {
    title:       'Why are stock count sessions waiting for approval?',
    explanation: 'A stock count session moves to "submitted" status when the operator finishes entering counted quantities and submits it for review. The session then waits for a supervisor (with COUNT_APPROVE permission) to approve, reject, or request a recount.',
    impact:      'Until approved, the count variance is not applied to stock. If the count has found significant discrepancies, those corrections are not reflected in current stock levels or valuation.',
    recommendation: 'Review each submitted count session in the Stock Counts tab. Compare expected vs counted quantities. Approve to apply variances, or reject with notes if the count appears inaccurate.',
    prevention:  'Designate a regular review cadence (e.g., review within 24 hours of submission) and assign COUNT_APPROVE permission to your store manager role.'
  },

  yield_variance: {
    title:       'Why is my production yield below target?',
    explanation: 'Yield variance occurs when a production batch produces fewer units than expected. Common causes include raw material quality issues, process inefficiency, machine calibration problems, or operator error. The yield percentage (produced ÷ expected × 100) below 90% flags batches that warrant investigation.',
    impact:      'Low yield increases the cost per produced unit. A batch that expected 100 tarts but produced 80 has the same material cost spread over fewer units — meaning each tart costs 25% more than planned.',
    recommendation: 'Review wastage records for these batches to identify the reason (spoilage, trimming loss, machine error, etc.). If the pattern recurs, adjust the BOM scrap percentage to better reflect actual production reality.',
    prevention:  'Record wastage reasons in detail when completing each work order. Use the yield report to track trends by item and identify chronic underperformers.'
  },

  config_gap: {
    title:       'Why should I set a default warehouse?',
    explanation: 'The default warehouse is pre-selected on receiving, movement, and transfer forms, reducing data entry errors. Without a default, users must manually select a warehouse on every stock operation, increasing the risk of items being received without a location.',
    impact:      'Items received without warehouse assignment are harder to track in warehouse-level reports and cycle counts.',
    recommendation: 'Go to the Warehouses tab, edit your main warehouse, and enable "Default". Only one warehouse can be default at a time.',
    prevention:  'Set the default warehouse as part of initial company setup.'
  },

  onboarding: {
    title:       'Getting started with Lorenco Storehouse',
    explanation: 'Storehouse requires a basic configuration to function correctly: at least one warehouse, one supplier, and opening stock for your items. Without these, reporting will be incomplete and operational workflows cannot be tested.',
    impact:      'Missing configuration prevents purchase orders, production, and accurate stock reporting from functioning.',
    recommendation: 'Follow the Getting Started checklist in the dashboard to complete initial setup. Each step builds on the previous one.',
    prevention:  'Complete all "Required" checklist items before inviting additional users or entering live operational data.'
  }
};

/**
 * Return the structured insight for a given type.
 *
 * @param {string} insightType — one of the INSIGHTS keys or a health check sean_hook
 * @param {object} [context]   — optional contextual data to enrich the response
 * @returns {{ type, title, explanation, impact, recommendation, prevention } | null}
 */
function getInsight(insightType, context = {}) {
  const insight = INSIGHTS[insightType];
  if (!insight) return null;
  return { type: insightType, ...insight, context };
}

/**
 * Get insights for all issues returned by the health engine.
 * Returns a map of { issue_type → insight }.
 *
 * @param {Array} issues — from operationalHealthService.runHealthChecks
 * @returns {object}
 */
function getInsightsForIssues(issues) {
  const result = {};
  for (const issue of (issues || [])) {
    const hook = issue.sean_hook;
    if (hook && INSIGHTS[hook]) {
      result[issue.type] = getInsight(hook);
    }
  }
  return result;
}

/**
 * Return a read-only operational summary context for Sean AI.
 * Sean can fetch this to understand current system state before generating guidance.
 *
 * @param {object} healthResult — from operationalHealthService.runHealthChecks
 * @param {Array}  onboarding   — from operationalHealthService.buildOnboardingChecklist
 * @returns {object} sean_context
 */
function buildSeanContext(healthResult, onboarding) {
  const { overallSeverity, issues } = healthResult;
  const criticalIssues = issues.filter(i => i.severity === 'critical').map(i => ({
    type: i.type, title: i.title, count: i.count, recommendation: i.recommendation
  }));
  const warnings = issues.filter(i => i.severity === 'warning').map(i => ({
    type: i.type, title: i.title, count: i.count
  }));
  const onboardingSteps = (onboarding || []).filter(s => !s.done).map(s => ({
    step: s.step, title: s.title, priority: s.priority
  }));

  return {
    system_status:       overallSeverity,
    critical_issues:     criticalIssues,
    warnings:            warnings,
    onboarding_pending:  onboardingSteps,
    insights_available:  Object.keys(INSIGHTS),
    read_only:           true,
    mutation_allowed:    false,
    generated_at:        new Date().toISOString()
  };
}

/**
 * Return all available insight types for discovery.
 * Used by Sean to know what topics it can ask about.
 */
function listInsightTypes() {
  return Object.entries(INSIGHTS).map(([type, ins]) => ({
    type,
    title: ins.title
  }));
}

module.exports = { getInsight, getInsightsForIssues, buildSeanContext, listInsightTypes };
