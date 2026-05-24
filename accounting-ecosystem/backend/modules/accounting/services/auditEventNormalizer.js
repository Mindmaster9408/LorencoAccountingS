/**
 * Audit Event Normalizer
 *
 * Converts raw rows from different audit tables into one standard shape:
 *   { id, timestamp, companyId, module, eventType, severity,
 *     userId, actorType, entityType, entityId, description,
 *     metadata, beforeData, afterData, ipAddress, source }
 *
 * Used exclusively by GET /api/accounting/audit/events.
 * No DB access — pure transformation functions only.
 */

// ── Severity mapping ──────────────────────────────────────────────────────────
// Checked in priority order: exact match → keyword scan → default 'info'

const SEVERITY_EXACT = {
  // critical
  CROSS_COMPANY_ATTEMPT:    'critical',
  FAILED_REVERSAL:          'critical',
  INTEGRITY_FAILURE:        'critical',
  FINALIZED_EDIT_BLOCKED:   'critical',
  // high
  JOURNAL_REVERSED:         'high',
  REVERSE:                  'high',
  LOCKED_PERIOD_ATTEMPT:    'high',
  YEAR_END_CLOSE:           'high',
  BATCH_FINALIZED:          'high',
  DEACTIVATE:               'high',
  // warning
  BANK_RULE_OVERRIDDEN:     'warning',
  RULE_OVERRIDDEN:          'warning',
  VAT_WARNING:              'warning',
  VAT_PERIOD_LOCKED:        'warning',
  DELETE:                   'warning',
  BATCH_ARCHIVED:           'warning',
};

function resolveSeverity(eventType) {
  if (!eventType) return 'info';
  const et = eventType.toUpperCase();
  if (SEVERITY_EXACT[et]) return SEVERITY_EXACT[et];
  // keyword scan
  if (et.includes('CRITICAL') || et.includes('CROSS_COMPANY') || et.includes('INTEGRITY')) return 'critical';
  if (et.includes('FINALIZED_EDIT_BLOCKED')) return 'critical';
  if (et.includes('REVERSE') || et.includes('YEAR_END') || et.includes('LOCKED_PERIOD')) return 'high';
  if (et.includes('FAILED') && !et.includes('FAILED_RULE')) return 'high';
  if (et.includes('WARNING') || et.includes('OVERRIDDEN') || et.includes('DELETE') || et.includes('DEACTIVATE')) return 'warning';
  if (et.includes('BLOCKED')) return 'high';
  return 'info';
}

// ── Module inference ──────────────────────────────────────────────────────────
// Entity type takes priority over action type for specificity.

function inferModule(actionType, entityType) {
  const et = (entityType || '').toUpperCase();
  const at = (actionType || '').toUpperCase();

  // Entity-type prefix matching
  if (et.startsWith('BANK_ALLOCATION_RULE') || et === 'BANK_ALLOCATION_RULE') return 'bank';
  if (et.startsWith('BANK'))     return 'bank';
  if (et.startsWith('JOURNAL'))  return 'journals';
  if (et.startsWith('VAT'))      return 'vat';
  if (et.startsWith('CUSTOMER')) return 'ar';
  if (et.startsWith('SUPPLIER')) return 'ap';
  if (et === 'ACCOUNT')          return 'accounts';
  if (et.startsWith('HISTORICAL')) return 'historical';
  if (et.startsWith('OPENING_BALANCE')) return 'opening_balances';
  if (et === 'DIAGNOSTICS' || et === 'YEAR_END_CLOSE_RECORD' || et === 'ACCOUNTING_PERIOD') return 'system';
  if (et.startsWith('AI') || et.startsWith('SEAN')) return 'ai';

  // Fall back to action type prefix
  if (at.startsWith('BANK'))     return 'bank';
  if (at.startsWith('JOURNAL'))  return 'journals';
  if (at.startsWith('VAT'))      return 'vat';
  if (at.startsWith('BATCH') || at.startsWith('LINE_CREATED') || at.startsWith('LINE_UP')) return 'historical';
  if (at.startsWith('OPENING'))  return 'opening_balances';
  if (at.startsWith('YEAR_END')) return 'system';
  if (at.startsWith('AI') || at.startsWith('SEAN')) return 'ai';
  if (at.startsWith('BANK_RULE')) return 'bank';

  return 'system';
}

// ── Source normalizers ────────────────────────────────────────────────────────

/**
 * Normalize a row from `accounting_audit_log`.
 * Schema: id, company_id, actor_type, actor_id, action_type, entity_type,
 *         entity_id, before_json, after_json, reason, metadata,
 *         ip_address, user_agent, created_at
 */
function normalizeAccountingLog(row) {
  return {
    id:          String(row.id),
    timestamp:   row.created_at,
    companyId:   row.company_id,
    module:      inferModule(row.action_type, row.entity_type),
    eventType:   row.action_type  || 'UNKNOWN',
    severity:    resolveSeverity(row.action_type),
    userId:      row.actor_id != null ? String(row.actor_id) : null,
    userName:    null,
    actorType:   row.actor_type   || 'USER',
    entityType:  row.entity_type  || null,
    entityId:    row.entity_id != null ? String(row.entity_id) : null,
    description: row.reason       || null,
    metadata:    row.metadata     || null,
    beforeData:  row.before_json  || null,
    afterData:   row.after_json   || null,
    ipAddress:   row.ip_address   || null,
    source:      'accounting_audit_log',
  };
}

/**
 * Normalize a row from `historical_comparative_audit_log`.
 * Schema: id (UUID), company_id, batch_id, line_id, action, old_value,
 *         new_value, reason, performed_by (UUID), performed_at
 */
function normalizeHistoricalLog(row) {
  const entityType = row.line_id  ? 'HISTORICAL_LINE'
                   : row.batch_id ? 'HISTORICAL_BATCH'
                   : 'HISTORICAL';
  const entityId   = row.line_id  ? String(row.line_id)
                   : row.batch_id ? String(row.batch_id)
                   : null;

  return {
    id:          String(row.id),
    timestamp:   row.performed_at,
    companyId:   row.company_id,
    module:      'historical',
    eventType:   row.action        || 'UNKNOWN',
    severity:    resolveSeverity(row.action),
    userId:      row.performed_by  ? String(row.performed_by) : null,
    userName:    null,
    actorType:   'USER',
    entityType,
    entityId,
    description: row.reason        || row.action || null,
    metadata:    (row.batch_id || row.line_id)
                   ? { batchId: row.batch_id || null, lineId: row.line_id || null }
                   : null,
    beforeData:  row.old_value     || null,
    afterData:   row.new_value     || null,
    ipAddress:   null,
    source:      'historical_comparative_audit_log',
  };
}

// ── Merge + sort ──────────────────────────────────────────────────────────────

/**
 * Merge two arrays of normalized events and sort by timestamp descending.
 */
function mergeAndSort(accountingEvents, historicalEvents) {
  return [...accountingEvents, ...historicalEvents].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );
}

// ── Post-normalization filters ────────────────────────────────────────────────

/**
 * Apply module, severity, and free-text search filters to normalized events.
 * These can't be pushed to the DB because they depend on normalized fields.
 */
function applyPostFilters(events, { module: mod, severity, search }) {
  let result = events;
  if (mod)      result = result.filter(e => e.module === mod);
  if (severity) result = result.filter(e => e.severity === severity);
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(e =>
      (e.description && e.description.toLowerCase().includes(q)) ||
      (e.eventType   && e.eventType.toLowerCase().includes(q))   ||
      (e.entityType  && e.entityType.toLowerCase().includes(q))  ||
      (e.entityId    && e.entityId.toLowerCase().includes(q))
    );
  }
  return result;
}

module.exports = {
  normalizeAccountingLog,
  normalizeHistoricalLog,
  mergeAndSort,
  applyPostFilters,
  resolveSeverity,
  inferModule,
};
