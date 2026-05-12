const express = require('express');
const db = require('../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');

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

module.exports = router;
