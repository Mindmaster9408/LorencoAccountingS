// ============================================================
// Permissions - Role-based access control for Lorenco Paytime
// Checks current session role against allowed roles per action.
// Use data-permission="ACTION_NAME" on HTML elements for auto-hide.
// ============================================================

// Owner-equivalent roles: practice_manager and administrator have the same
// access as business_owner throughout Paytime. Keep this list in sync with
// backend/config/permissions.js isOwnerEquivalent().
var _OWNER_EQUIV = ['super_admin', 'business_owner', 'practice_manager', 'administrator'];

var Permissions = {

    // Allowed roles per action
    ACTIONS: {
        VIEW_PAYROLL:         [..._OWNER_EQUIV, 'accountant', 'manager'],
        EDIT_PAYROLL:         [..._OWNER_EQUIV, 'accountant'],
        FINALIZE_PAYSLIP:    [..._OWNER_EQUIV, 'accountant'],
        UNFINALIZE_PAYSLIP:  [..._OWNER_EQUIV],
        CREATE_PAYRUN:       [..._OWNER_EQUIV, 'accountant'],
        FINALIZE_PAYRUN:     [..._OWNER_EQUIV],
        VIEW_EMPLOYEES:      [..._OWNER_EQUIV, 'accountant', 'manager', 'admin'],
        EDIT_EMPLOYEES:      [..._OWNER_EQUIV, 'accountant', 'admin'],
        DELETE_EMPLOYEES:    [..._OWNER_EQUIV],
        VIEW_BANK_DETAILS:   [..._OWNER_EQUIV, 'accountant'],
        EDIT_COMPANY:        [..._OWNER_EQUIV],
        VIEW_REPORTS:        [..._OWNER_EQUIV, 'accountant', 'manager'],
        EXPORT_DATA:         [..._OWNER_EQUIV, 'accountant'],
        MANAGE_PAYROLL_ITEMS: [..._OWNER_EQUIV, 'accountant'],
        MANAGE_USERS:        [..._OWNER_EQUIV],
        VIEW_AUDIT_TRAIL:    [..._OWNER_EQUIV, 'accountant']
    },

    /**
     * Get current user role from session.
     * @returns {string} Role string or empty string if not logged in
     */
    getRole: function() {
        try {
            var session = JSON.parse(safeLocalStorage.getItem('session') || '{}');
            if (session.role) return session.role;
            // Authenticated but role not set — default to business_owner
            if (safeLocalStorage.getItem('token')) return 'business_owner';
            return '';
        } catch(e) {
            return '';
        }
    },

    /**
     * Check if current user can perform the given action.
     * @param {string} action - Action name from ACTIONS
     * @returns {boolean}
     */
    can: function(action) {
        var allowedRoles = this.ACTIONS[action];
        if (!allowedRoles) return false;
        var role = this.getRole();
        if (!role) return false;
        return allowedRoles.indexOf(role) !== -1;
    },

    /**
     * Check permission and show alert if denied.
     * @param {string} action - Action name from ACTIONS
     * @returns {boolean} true if allowed
     */
    require: function(action) {
        if (this.can(action)) return true;
        alert('Access denied. You do not have permission to perform this action.');
        return false;
    },

    /**
     * Auto-hide elements with data-permission attribute.
     * Elements with data-permission="ACTION_NAME" will be hidden
     * if the current user's role is not in the allowed list.
     * Call this on page load after DOM is ready.
     */
    enforceUI: function() {
        var elements = document.querySelectorAll('[data-permission]');
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            var action = el.getAttribute('data-permission');
            if (!this.can(action)) {
                el.style.display = 'none';
            }
        }
    },

    /**
     * Check if current user has one of the specified roles.
     * @param {Array} roles - Array of role strings
     * @returns {boolean}
     */
    hasRole: function(roles) {
        var role = this.getRole();
        if (!role) return false;
        return roles.indexOf(role) !== -1;
    }
};
