/**
 * ============================================================================
 * Forensic Audit Logging Middleware - Unified Ecosystem
 * ============================================================================
 * Comprehensive audit trail for security, compliance, and fraud detection.
 * Logs every significant action across all modules.
 *
 * Compliance: POPI Act (SA), SARS audit requirements
 * Retention: Minimum 7 years per SA tax law
 * Architecture: Append-only — audit logs are NEVER deleted
 * ============================================================================
 */

const { supabase } = require('../config/database');

/**
 * Log an audit event to the audit_log table
 *
 * @param {Object} params
 * @param {number|null} params.companyId
 * @param {number|null} params.userId
 * @param {string} params.userEmail
 * @param {string} params.module - 'shared', 'pos', 'payroll', 'accounting'
 * @param {string} params.actionType - CREATE, UPDATE, DELETE, VOID, LOGIN, LOGOUT, PRICE_CHANGE, PERMISSION_DENIED
 * @param {string} params.entityType - product, sale, user, employee, payrun, etc.
 * @param {string|number|null} params.entityId
 * @param {string|null} params.fieldName - specific field changed
 * @param {*} params.oldValue
 * @param {*} params.newValue
 * @param {string|null} params.ipAddress
 * @param {string|null} params.userAgent
 * @param {Object} params.metadata - extra context
 */
async function logAudit({
  companyId = null,
  userId = null,
  userEmail = 'system',
  module = 'shared',
  actionType,
  entityType,
  entityId = null,
  fieldName = null,
  oldValue = null,
  newValue = null,
  ipAddress = null,
  userAgent = null,
  metadata = {}
}) {
  try {
    const { error } = await supabase.from('audit_log').insert({
      company_id: companyId,
      user_id: userId,
      user_email: userEmail,
      module,
      action_type: actionType,
      entity_type: entityType,
      entity_id: entityId != null ? String(entityId) : null,
      field_name: fieldName,
      old_value: oldValue !== null && oldValue !== undefined ? JSON.stringify(oldValue) : null,
      new_value: newValue !== null && newValue !== undefined ? JSON.stringify(newValue) : null,
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });

    if (error) {
      console.error('Audit log insert error:', error.message);
    }
  } catch (err) {
    // Never let audit logging break the application
    console.error('Audit log exception:', err.message);
  }
}

/**
 * Helper: build audit params from Express request
 */
function auditFromReq(req, actionType, entityType, entityId, extra = {}) {
  // Any extra key that is not a known column goes into metadata. Callers passed context
  // such as { period_key, employee_count } at the top level and it was silently dropped
  // (found 2026-10-13, Paytime Fase 10) — e.g. payroll run/finalize/reverse audit rows
  // carried no period or totals. Additive: known fields behave exactly as before.
  const KNOWN = ['module', 'fieldName', 'oldValue', 'newValue', 'metadata'];
  const loose = {};
  Object.keys(extra || {}).forEach(k => { if (!KNOWN.includes(k)) loose[k] = extra[k]; });
  const mergedMeta = Object.assign({}, loose, (extra && extra.metadata) || {});
  return logAudit({
    companyId: req.companyId || (req.user && req.user.companyId) || null,
    userId: (req.user && req.user.userId) || null,
    userEmail: (req.user && req.user.email) || (req.user && req.user.username) || 'system',
    module: extra.module || detectModule(req.path),
    actionType,
    entityType,
    entityId,
    fieldName: extra.fieldName || null,
    oldValue: extra.oldValue || null,
    newValue: extra.newValue || null,
    ipAddress: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
    metadata: mergedMeta,
  });
}

/**
 * Log field-level changes (comparing old vs new objects)
 */
async function logFieldChanges(req, entityType, entityId, oldData, newData, moduleName) {
  if (!oldData || !newData) return;
  for (const field of Object.keys(newData)) {
    if (field === 'updated_at' || field === 'created_at') continue;
    if (JSON.stringify(oldData[field]) !== JSON.stringify(newData[field])) {
      await auditFromReq(req, 'UPDATE', entityType, entityId, {
        module: moduleName,
        fieldName: field,
        oldValue: oldData[field],
        newValue: newData[field],
      });
    }
  }
}

/**
 * Detect module from URL path
 */
function detectModule(path) {
  if (path.includes('/api/pos')) return 'pos';
  if (path.includes('/api/payroll')) return 'payroll';
  if (path.includes('/api/accounting')) return 'accounting';
  return 'shared';
}

/**
 * Extract entity type from URL path
 */
function extractEntityType(path) {
  const parts = path.replace(/^\/api\/(pos|payroll|accounting)?\/?/, '').split('/').filter(Boolean);
  let name = parts[0] || 'unknown';
  if (name.endsWith('s') && !name.endsWith('ss')) name = name.slice(0, -1);
  return name;
}

/**
 * Express middleware — automatically logs POST/PUT/DELETE operations
 * Attach to routes with: router.use(auditMiddleware)
 */
function auditMiddleware(req, res, next) {
  // Attach helper to req so routes can log manually
  req.auditLog = (actionType, entityType, entityId, extra) =>
    auditFromReq(req, actionType, entityType, entityId, extra);

  const originalJson = res.json.bind(res);

  res.json = function (data) {
    try {
      const statusOk = res.statusCode >= 200 && res.statusCode < 300;
      if (statusOk) {
        const entityType = extractEntityType(req.path);
        const entityId = data?.id || data?.[entityType]?.id || req.params?.id;

        if (req.method === 'POST') {
          auditFromReq(req, 'CREATE', entityType, entityId, { newValue: summarize(data) });
        } else if (req.method === 'PUT' || req.method === 'PATCH') {
          auditFromReq(req, 'UPDATE', entityType, entityId, {
            oldValue: req._auditOldValue,
            newValue: summarize(data),
          });
        } else if (req.method === 'DELETE') {
          auditFromReq(req, 'DELETE', entityType, entityId, {
            oldValue: req._auditOldValue,
          });
        }
      }
    } catch (err) {
      console.error('Audit middleware error:', err.message);
    }
    return originalJson(data);
  };

  next();
}

/**
 * Truncate large objects for audit storage
 */
function summarize(obj) {
  if (!obj) return null;
  const str = JSON.stringify(obj);
  return str.length > 5000 ? str.substring(0, 5000) + '...' : obj;
}

module.exports = {
  logAudit,
  auditFromReq,
  logFieldChanges,
  auditMiddleware,
  extractEntityType,
};
