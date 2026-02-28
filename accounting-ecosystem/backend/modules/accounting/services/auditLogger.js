const db = require('../config/database');

/**
 * Audit Logger Service
 * Logs all significant actions for compliance and traceability
 */
class AuditLogger {
  /**
   * Log an action to the audit log
   * @param {Object} params - Audit log parameters
   * @param {number} params.companyId - Company ID
   * @param {string} params.actorType - USER, AI, or SYSTEM
   * @param {number} params.actorId - ID of the actor (userId for USER type)
   * @param {string} params.actionType - Type of action (e.g., CREATE, UPDATE, DELETE, POST, REVERSE)
   * @param {string} params.entityType - Type of entity (e.g., JOURNAL, ACCOUNT, USER)
   * @param {number} params.entityId - ID of the affected entity
   * @param {Object} params.beforeJson - State before the action
   * @param {Object} params.afterJson - State after the action
   * @param {string} params.reason - Reason for the action
   * @param {Object} params.metadata - Additional metadata
   * @param {string} params.ipAddress - IP address of the requester
   * @param {string} params.userAgent - User agent string
   */
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
      await db.query(
        `INSERT INTO accounting_audit_log
         (company_id, actor_type, actor_id, action_type, entity_type, entity_id,
          before_json, after_json, reason, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          companyId,
          actorType,
          actorId,
          actionType,
          entityType,
          entityId,
          beforeJson ? JSON.stringify(beforeJson) : null,
          afterJson ? JSON.stringify(afterJson) : null,
          reason,
          metadata ? JSON.stringify(metadata) : null,
          ipAddress,
          userAgent
        ]
      );
    } catch (error) {
      console.error('Failed to write audit log:', error);
      // Don't throw - audit logging should not break the main operation
    }
  }

  /**
   * Log a user action
   */
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

  /**
   * Log an AI action
   */
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

  /**
   * Log a system action
   */
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

  /**
   * Query audit log
   */
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

    let query = `
      SELECT al.*, 
             u.email as actor_email,
             u.first_name as actor_first_name,
             u.last_name as actor_last_name
      FROM audit_log al
      LEFT JOIN users u ON al.actor_type = 'USER' AND al.actor_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (companyId) {
      query += ` AND al.company_id = $${paramCount}`;
      params.push(companyId);
      paramCount++;
    }

    if (entityType) {
      query += ` AND al.entity_type = $${paramCount}`;
      params.push(entityType);
      paramCount++;
    }

    if (entityId) {
      query += ` AND al.entity_id = $${paramCount}`;
      params.push(entityId);
      paramCount++;
    }

    if (actorType) {
      query += ` AND al.actor_type = $${paramCount}`;
      params.push(actorType);
      paramCount++;
    }

    if (actionType) {
      query += ` AND al.action_type = $${paramCount}`;
      params.push(actionType);
      paramCount++;
    }

    if (fromDate) {
      query += ` AND al.created_at >= $${paramCount}`;
      params.push(fromDate);
      paramCount++;
    }

    if (toDate) {
      query += ` AND al.created_at <= $${paramCount}`;
      params.push(toDate);
      paramCount++;
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }
}

module.exports = AuditLogger;
