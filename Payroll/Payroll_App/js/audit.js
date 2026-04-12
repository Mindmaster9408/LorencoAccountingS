// ============================================================
// AuditTrail - Unified audit logging for Lorenco Paytime
// All CRUD operations should log through this module.
//
// Each entry captures:
//   - WHO  (user_id, user_email, user_name, role)
//   - WHAT (action_type, entity_type, description)
//   - WHEN (timestamp)
//   - WHERE (company_id, source)
//   - CONTEXT (before/after snapshots where available)
// ============================================================

var AuditTrail = {

    /**
     * Log an audit entry.
     *
     * @param {string} companyId   - Company identifier (tenant scope)
     * @param {string} actionType  - CREATE | UPDATE | DELETE | VIEW | EXPORT |
     *                               FINALIZE | UNFINALIZE | LOGIN | LOGOUT |
     *                               UNLOCK | SYNC | IMPORT | VALIDATION_FAIL
     * @param {string} entityType  - employee | payslip | payrun | payroll_item |
     *                               company | user | report | attendance | import
     * @param {string} description - Human-readable description
     * @param {Object} [details]   - Optional: { before, after, reason, source, ... }
     */
    log: function(companyId, actionType, entityType, description, details) {
        var session = {};
        try { session = JSON.parse(safeLocalStorage.getItem('session') || '{}'); } catch(e) {}

        var entry = {
            id: 'audit-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            user_id:    session.user_id    || null,
            user_email: session.email      || null,
            user_name:  session.name       || null,
            role:       session.role       || null,
            action_type:  actionType,
            entity_type:  entityType,
            description:  description,
            details:      details || null,
            company_id:   companyId
        };

        var key = 'audit_log_' + companyId;
        var log = [];
        try { log = JSON.parse(safeLocalStorage.getItem(key) || '[]'); } catch(e) { log = []; }
        log.push(entry);

        // Keep last 2000 entries — increased from 1000 for better compliance coverage
        if (log.length > 2000) {
            log = log.slice(log.length - 2000);
        }

        safeLocalStorage.setItem(key, JSON.stringify(log));
        return entry;
    },

    // Core action helpers
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
    },

    /**
     * Log a user login event.
     * Call this after successful authentication.
     *
     * @param {string} companyId  - Active company at login time
     * @param {string} email      - Logged-in email
     * @param {string} name       - User display name
     * @param {string} role       - User role
     */
    logLogin: function(companyId, email, name, role) {
        return this.log(
            companyId || 'system',
            'LOGIN',
            'user',
            'User logged in: ' + (name || email) + ' (' + (role || 'unknown') + ')',
            { email: email, role: role, source: 'auth' }
        );
    },

    /**
     * Log a user logout event.
     *
     * @param {string} companyId
     * @param {string} email
     */
    logLogout: function(companyId, email) {
        return this.log(
            companyId || 'system',
            'LOGOUT',
            'user',
            'User logged out: ' + (email || 'unknown'),
            { email: email, source: 'auth' }
        );
    },

    /**
     * Log a sensitive action that required elevated authorization.
     * Use this for manager auth unlocks, overrides, etc.
     *
     * @param {string} companyId
     * @param {string} entityType      - Type of entity being unlocked/overridden
     * @param {string} description     - What was done
     * @param {string} authorizedBy    - Email of the authorizing user
     * @param {string} authorizedRole  - Role of the authorizing user
     * @param {Object} [context]       - Additional context
     */
    logSensitiveAction: function(companyId, entityType, description, authorizedBy, authorizedRole, context) {
        return this.log(
            companyId,
            'UNLOCK',
            entityType,
            description,
            Object.assign({ authorized_by: authorizedBy, authorized_role: authorizedRole, source: 'manager_auth' }, context || {})
        );
    },

    /**
     * Log a sync/backfill operation.
     *
     * @param {string} companyId
     * @param {string} description
     * @param {Object} [details]  - e.g., { created, linked, failed }
     */
    logSync: function(companyId, description, details) {
        return this.log(companyId, 'SYNC', 'employee', description, details);
    },

    /**
     * Log a failed validation event for audit trail purposes.
     * Captures attempts to save invalid data — useful for detecting
     * data quality problems and potential abuse patterns.
     *
     * @param {string} companyId
     * @param {string} entityType
     * @param {string} description
     * @param {string[]} validationErrors
     */
    logValidationFail: function(companyId, entityType, description, validationErrors) {
        return this.log(
            companyId,
            'VALIDATION_FAIL',
            entityType,
            description,
            { errors: validationErrors }
        );
    },

    /**
     * Log a salary change with before/after snapshot.
     *
     * @param {string} companyId
     * @param {string} empId
     * @param {string} empName
     * @param {number} salaryBefore
     * @param {number} salaryAfter
     */
    logSalaryChange: function(companyId, empId, empName, salaryBefore, salaryAfter) {
        return this.log(
            companyId,
            'UPDATE',
            'payroll',
            'Salary changed for ' + empName + ': R ' + (salaryBefore || 0).toFixed(2) + ' → R ' + (salaryAfter || 0).toFixed(2),
            {
                emp_id: empId,
                before: { basic_salary: salaryBefore },
                after:  { basic_salary: salaryAfter },
                change_amount: (salaryAfter || 0) - (salaryBefore || 0)
            }
        );
    },

    // ==========================================================
    // READ HELPERS
    // ==========================================================

    /**
     * Get all audit log entries for a company.
     * @param {string} companyId
     * @returns {Array}
     */
    getLog: function(companyId) {
        try {
            return JSON.parse(safeLocalStorage.getItem('audit_log_' + companyId) || '[]');
        } catch(e) {
            return [];
        }
    },

    /**
     * Get audit log entries filtered by action type.
     * @param {string} companyId
     * @param {string} actionType
     * @returns {Array}
     */
    getByAction: function(companyId, actionType) {
        return this.getLog(companyId).filter(function(e) {
            return e.action_type === actionType;
        });
    }
};
