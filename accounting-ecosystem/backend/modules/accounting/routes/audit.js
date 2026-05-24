const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');
const {
  normalizeAccountingLog,
  normalizeHistoricalLog,
  mergeAndSort,
  applyPostFilters,
} = require('../services/auditEventNormalizer');

const router = express.Router();

/**
 * GET /api/audit
 * Query audit log
 */
router.get('/', authenticate, hasPermission('audit.view'), async (req, res) => {
  try {
    const { 
      entityType, 
      entityId, 
      actorType, 
      actionType,
      userId,
      batchId,
      fromDate,
      toDate,
      limit = 100,
      offset = 0 
    } = req.query;

    const filters = {
      companyId: req.user.companyId,
      entityType,
      entityId: entityId ? parseInt(entityId) : undefined,
      actorType,
      actionType,
      userId: userId || undefined,
      batchId: batchId || undefined,
      fromDate,
      toDate,
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    const logs = await AuditLogger.query(filters);

    res.json({
      logs,
      count: logs.length,
      filters
    });

  } catch (error) {
    console.error('Error querying audit log:', error);
    res.status(500).json({ error: 'Failed to query audit log' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounting/audit/events
// Forensic audit trail explorer — normalized events from all audit sources.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/events', authenticate, hasPermission('audit.view'), async (req, res) => {
  try {
    const {
      fromDate,
      toDate,
      module: mod,
      eventType,
      severity,
      userId,
      search,
      limit  = 100,
      offset = 0,
    } = req.query;

    const companyId   = req.user.companyId;
    const limitNum    = Math.min(parseInt(limit)  || 100, 500);
    const offsetNum   = Math.max(parseInt(offset) || 0,   0);

    // Fetch cap: enough to cover pagination after post-normalization filters.
    // For module/severity/search filters we can't push the limit to the DB,
    // so we fetch a larger window and filter in application code.
    const fetchCap = offsetNum + limitNum + 200;

    // ── Query 1: accounting_audit_log ────────────────────────────────────────
    let q1 = supabase
      .from('accounting_audit_log')
      .select('*')
      .eq('company_id', companyId);

    if (fromDate)  q1 = q1.gte('created_at', fromDate);
    if (toDate)    q1 = q1.lte('created_at', toDate + 'T23:59:59.999Z');
    if (eventType) q1 = q1.eq('action_type', eventType);
    if (userId)    q1 = q1.eq('actor_id', userId);
    if (search)    q1 = q1.ilike('reason', `%${search}%`);

    q1 = q1.order('created_at', { ascending: false }).limit(fetchCap);

    // ── Query 2: historical_comparative_audit_log ────────────────────────────
    let q2 = supabase
      .from('historical_comparative_audit_log')
      .select('*')
      .eq('company_id', companyId);

    if (fromDate)  q2 = q2.gte('performed_at', fromDate);
    if (toDate)    q2 = q2.lte('performed_at', toDate + 'T23:59:59.999Z');
    if (eventType) q2 = q2.eq('action', eventType);
    // Note: historical log uses UUID performed_by — skip userId filter if it
    // looks like an integer (accounting_audit_log uses integer actor_id).
    // Integer userId filters only apply to accounting_audit_log.

    q2 = q2.order('performed_at', { ascending: false }).limit(fetchCap);

    // Fire both queries in parallel
    const [r1, r2] = await Promise.all([q1, q2]);

    // Non-critical: if historical_comparative_audit_log doesn't exist yet
    // (migration 042 not applied), treat it as empty — never fail the request.
    const accountingRows  = r1.data  || [];
    const historicalRows  = r2.error ? [] : (r2.data || []);

    // ── Normalize ────────────────────────────────────────────────────────────
    const accountingEvents  = accountingRows.map(normalizeAccountingLog);
    const historicalEvents  = historicalRows.map(normalizeHistoricalLog);

    // ── Merge + sort descending by timestamp ─────────────────────────────────
    const merged = mergeAndSort(accountingEvents, historicalEvents);

    // ── Post-normalization filters (module, severity, search fallback) ────────
    const filtered = applyPostFilters(merged, { module: mod, severity, search });

    // ── Paginate ─────────────────────────────────────────────────────────────
    const total  = filtered.length;
    const events = filtered.slice(offsetNum, offsetNum + limitNum);

    res.json({ events, total });

  } catch (error) {
    console.error('[audit/events] Error:', error.message);
    res.status(500).json({ error: 'Failed to load audit events', detail: error.message });
  }
});

module.exports = router;
