// ============================================================
// AuditTrail - Unified audit logging for Lorenco Paytime
// All CRUD operations should log through this module.
// ============================================================

var AuditTrail = {

    /**
     * Log an audit entry.
     * @param {string} companyId - Company identifier
     * @param {string} actionType - CREATE, UPDATE, DELETE, VIEW, EXPORT, FINALIZE, UNFINALIZE, LOGIN, LOGOUT
     * @param {string} entityType - employee, payslip, payrun, payroll_item, company, user, report, attendance, import
     * @param {string} description - Human-readable description
     * @param {Object} [details] - Optional additional data
     */
    log: function(companyId, actionType, entityType, description, details) {
        var session = {};
        try { session = JSON.parse(safeLocalStorage.getItem('session') || '{}'); } catch(e) {}

        var entry = {
            id: 'audit-' + Math.random().toString(36).substr(2, 9),
            timestamp: new Date().toISOString(),
            user_id: session.user_id || null,
            user_email: session.email || null,
            user_name: session.name || null,
            role: session.role || null,
            action_type: actionType,
            entity_type: entityType,
            description: description,
            details: details || null,
            company_id: companyId
        };

        var key = 'audit_log_' + companyId;
        var log = [];
        try { log = JSON.parse(safeLocalStorage.getItem(key) || '[]'); } catch(e) { log = []; }
        log.push(entry);

        // Keep last 1000 entries to prevent localStorage overflow
        if (log.length > 1000) {
            log = log.slice(log.length - 1000);
        }

        safeLocalStorage.setItem(key, JSON.stringify(log));
        return entry;
    },

    logCreate: function(companyId, entityType, description, details) {
        return this.log(companyId, 'CREATE', entityType, description, details);
    },

    logUpdate: function(companyId, entityType, description, details) {
        return this.log(companyId, 'UPDATE', entityType, description, details);
    },

    logDelete: function(companyId, entityType, description, details) {
        return this.log(companyId, 'DELETE', entityType, description, details);
    },

    logView: function(companyId, entityType, description, details) {
        return this.log(companyId, 'VIEW', entityType, description, details);
    },

    logExport: function(companyId, entityType, description, details) {
        return this.log(companyId, 'EXPORT', entityType, description, details);
    },

    logFinalize: function(companyId, entityType, description, details) {
        return this.log(companyId, 'FINALIZE', entityType, description, details);
    },

    logUnfinalize: function(companyId, entityType, description, details) {
        return this.log(companyId, 'UNFINALIZE', entityType, description, details);
    }
};
