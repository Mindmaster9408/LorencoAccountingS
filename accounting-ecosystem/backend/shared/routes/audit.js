/**
 * ============================================================================
 * Audit Routes - Unified Ecosystem
 * ============================================================================
 * Query audit logs for compliance reporting, user activity,
 * entity history, and suspicious activity detection.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * POST /api/audit
 * Frontend-originated audit events (import confirmations, finalize actions, etc.)
 * These complement the automatic server-side audit middleware.
 */
router.post('/', async (req, res) => {
  try {
    const { action_type, entity_type, entity_id, description, details } = req.body;
    if (!action_type || !entity_type) {
      return res.status(400).json({ error: 'action_type and entity_type are required' });
    }
    await logAudit({
      companyId:  req.companyId,
      userId:     req.user?.userId || null,
      userEmail:  req.user?.email  || 'frontend',
      module:     'payroll',
      actionType: action_type,
      entityType: entity_type,
      entityId:   entity_id   || null,
      metadata:   { description: description || null, details: details || null }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/audit
 * Paginated audit log with filters
 */
router.get('/', requirePermission('AUDIT.VIEW'), async (req, res) => {
  try {
    const { module, action_type, entity_type, user_id, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('audit_log')
      .select('*', { count: 'exact' })
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (module) query = query.eq('module', module);
    if (action_type) query = query.eq('action_type', action_type);
    if (entity_type) query = query.eq('entity_type', entity_type);
    if (user_id) query = query.eq('user_id', user_id);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      audit_logs: data || [],
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil((count || 0) / limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/audit/user-activity/:userId
 * User activity report — all actions by a specific user
 */
router.get('/user-activity/:userId', requirePermission('AUDIT.VIEW'), async (req, res) => {
  try {
    const { from, to, limit = 100 } = req.query;

    let query = supabase
      .from('audit_log')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ user_activity: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/audit/entity-history/:entityType/:entityId
 * Entity history report — all changes to a specific record
 */
router.get('/entity-history/:entityType/:entityId', requirePermission('AUDIT.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('entity_type', req.params.entityType)
      .eq('entity_id', req.params.entityId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ history: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/audit/suspicious
 * Suspicious activity report — voids, price changes, after-hours, permission denials
 */
router.get('/suspicious', requirePermission('AUDIT.VIEW'), async (req, res) => {
  try {
    const { from, to } = req.query;

    const suspiciousActions = ['VOID', 'PRICE_CHANGE', 'PERMISSION_DENIED', 'DELETE', 'REFUND'];

    let query = supabase
      .from('audit_log')
      .select('*')
      .eq('company_id', req.companyId)
      .in('action_type', suspiciousActions)
      .order('created_at', { ascending: false })
      .limit(200);

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Group by action type for summary
    const summary = {};
    for (const entry of (data || [])) {
      summary[entry.action_type] = (summary[entry.action_type] || 0) + 1;
    }

    res.json({
      suspicious_activities: data || [],
      summary,
      total: data?.length || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
