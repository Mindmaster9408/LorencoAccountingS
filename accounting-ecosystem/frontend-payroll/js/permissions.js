// ============================================================
// Permissions - Role-based access control for Lorenco Paytime
// Checks current session role against allowed roles per action.
// Use data-permission="ACTION_NAME" on HTML elements for auto-hide.
// ============================================================

var Permissions = {

    // Allowed roles per action
    ACTIONS: {
        VIEW_PAYROLL:         ['super_admin', 'business_owner', 'accountant', 'manager'],
        EDIT_PAYROLL:         ['super_admin', 'business_owner', 'accountant'],
        FINALIZE_PAYSLIP:    ['super_admin', 'business_owner', 'accountant'],
        UNFINALIZE_PAYSLIP:  ['super_admin', 'business_owner'],
        CREATE_PAYRUN:       ['super_admin', 'business_owner', 'accountant'],
        FINALIZE_PAYRUN:     ['super_admin', 'business_owner'],
        VIEW_EMPLOYEES:      ['super_admin', 'business_owner', 'accountant', 'manager', 'admin'],
        EDIT_EMPLOYEES:      ['super_admin', 'business_owner', 'accountant', 'admin'],
        DELETE_EMPLOYEES:    ['super_admin', 'business_owner'],
        VIEW_BANK_DETAILS:   ['super_admin', 'business_owner', 'accountant'],
        EDIT_COMPANY:        ['super_admin', 'business_owner'],
        VIEW_REPORTS:        ['super_admin', 'business_owner', 'accountant', 'manager'],
        EXPORT_DATA:         ['super_admin', 'business_owner', 'accountant'],
        MANAGE_PAYROLL_ITEMS: ['super_admin', 'business_owner', 'accountant'],
        MANAGE_USERS:        ['super_admin', 'business_owner'],
        VIEW_AUDIT_TRAIL:    ['super_admin', 'business_owner', 'accountant']
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
