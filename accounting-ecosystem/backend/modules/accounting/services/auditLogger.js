const { supabase } = require('../../../config/database');

/**
 * Audit Logger Service
 * Logs all significant actions for compliance and traceability
 */
class AuditLogger {
  static async log({
    companyId,
    actorType,
    actorId,
    actionType,
    entityType,
    entityId,
    beforeJson = null,
    afterJson = null,
    reason = null,
    metadata = null,
    ipAddress = null,
    userAgent = null
  }) {
    try {
      await supabase.from('accounting_audit_log').insert({
        company_id: companyId,
        actor_type: actorType,
        actor_id: actorId,
        action_type: actionType,
        entity_type: entityType,
        entity_id: entityId,
        before_json: beforeJson || null,
        after_json: afterJson || null,
        reason: reason || null,
        metadata: metadata || null,
        ip_address: ipAddress || null,
        user_agent: userAgent || null,
      });
    } catch (error) {
      console.error('Failed to write audit log:', error);
      // Don't throw - audit logging should not break the main operation
    }
  }

  static async logUserAction(req, actionType, entityType, entityId, beforeData, afterData, reason = null) {
    await this.log({
      companyId: req.user.companyId,
      actorType: 'USER',
      actorId: req.user.id,
      actionType,
      entityType,
      entityId,
      beforeJson: beforeData,
      afterJson: afterData,
      reason,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });
  }

  static async logAIAction(companyId, aiActionId, actionType, entityType, entityId, beforeData, afterData, reason) {
    await this.log({
      companyId,
      actorType: 'AI',
      actorId: aiActionId,
      actionType,
      entityType,
      entityId,
      beforeJson: beforeData,
      afterJson: afterData,
      reason
    });
  }

  static async logSystemAction(companyId, actionType, entityType, entityId, beforeData, afterData, reason) {
    await this.log({
      companyId,
      actorType: 'SYSTEM',
      actorId: null,
      actionType,
      entityType,
      entityId,
      beforeJson: beforeData,
      afterJson: afterData,
      reason
    });
  }

  static async query(filters = {}) {
    const {
      companyId,
      entityType,
      entityId,
      actorType,
      actionType,
      fromDate,
      toDate,
      limit = 100,
      offset = 0
    } = filters;

    let q = supabase.from('accounting_audit_log').select('*');

    if (companyId) q = q.eq('company_id', companyId);
    if (entityType) q = q.eq('entity_type', entityType);
    if (entityId)   q = q.eq('entity_id', entityId);
    if (actorType)  q = q.eq('actor_type', actorType);
    if (actionType) q = q.eq('action_type', actionType);
    if (fromDate)   q = q.gte('created_at', fromDate);
    if (toDate)     q = q.lte('created_at', toDate);

    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
}

module.exports = AuditLogger;
