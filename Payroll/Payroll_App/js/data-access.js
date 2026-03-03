// ============================================================
// DataAccess - Abstraction layer over localStorage
// Centralizes all data persistence operations.
// Future: swap localStorage calls for Supabase/API calls.
// ============================================================

var DataAccess = {

    // === GENERIC OPERATIONS ===

    get: function(key) {
        var val = localStorage.getItem(key);
        if (!val) return null;
        try { return JSON.parse(val); } catch(e) { return val; }
    },

    set: function(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    },

    remove: function(key) {
        localStorage.removeItem(key);
    },

    // === SESSION ===

    getSession: function() {
        return this.get('session');
    },

    saveSession: function(session) {
        this.set('session', session);
    },

    clearSession: function() {
        this.remove('session');
    },

    // === COMPANIES ===

    getRegisteredCompanies: function() {
        return this.get('registered_companies') || [];
    },

    saveRegisteredCompanies: function(companies) {
        this.set('registered_companies', companies);
    },

    getCompanyDetails: function(companyId) {
        return this.get('company_details_' + companyId) || {};
    },

    saveCompanyDetails: function(companyId, details) {
        this.set('company_details_' + companyId, details);
    },

    // === USERS ===

    getRegisteredUsers: function() {
        return this.get('registered_users') || [];
    },

    saveRegisteredUsers: function(users) {
        this.set('registered_users', users);
    },

    // === EMPLOYEES ===

    getEmployees: function(companyId) {
        return this.get('employees_' + companyId) || [];
    },

    saveEmployees: function(companyId, employees) {
        this.set('employees_' + companyId, employees);
    },

    getEmployeeById: function(companyId, empId) {
        var employees = this.getEmployees(companyId);
        return employees.find(function(e) { return e.id === empId; }) || null;
    },

    // === EMPLOYEE PAYROLL DATA (persistent, not period-specific) ===

    getEmployeePayroll: function(companyId, empId) {
        return this.get('emp_payroll_' + companyId + '_' + empId) || { basic_salary: 0, regular_inputs: [] };
    },

    saveEmployeePayroll: function(companyId, empId, data) {
        this.set('emp_payroll_' + companyId + '_' + empId, data);
    },

    // === PERIOD-SPECIFIC EMPLOYEE DATA ===

    getCurrentInputs: function(companyId, empId, period) {
        return this.get('emp_current_' + companyId + '_' + empId + '_' + period) || [];
    },

    saveCurrentInputs: function(companyId, empId, period, inputs) {
        this.set('emp_current_' + companyId + '_' + empId + '_' + period, inputs);
    },

    getOvertime: function(companyId, empId, period) {
        return this.get('emp_overtime_' + companyId + '_' + empId + '_' + period) || [];
    },

    saveOvertime: function(companyId, empId, period, entries) {
        this.set('emp_overtime_' + companyId + '_' + empId + '_' + period, entries);
    },

    getShortTime: function(companyId, empId, period) {
        return this.get('emp_short_time_' + companyId + '_' + empId + '_' + period) || [];
    },

    saveShortTime: function(companyId, empId, period, entries) {
        this.set('emp_short_time_' + companyId + '_' + empId + '_' + period, entries);
    },

    getMultiRate: function(companyId, empId, period) {
        return this.get('emp_multi_rate_' + companyId + '_' + empId + '_' + period) || [];
    },

    saveMultiRate: function(companyId, empId, period, entries) {
        this.set('emp_multi_rate_' + companyId + '_' + empId + '_' + period, entries);
    },

    // === PAYSLIP STATUS ===

    getPayslipStatus: function(companyId, empId, period) {
        return this.get('emp_payslip_status_' + companyId + '_' + empId + '_' + period) || { status: 'draft' };
    },

    savePayslipStatus: function(companyId, empId, period, status) {
        this.set('emp_payslip_status_' + companyId + '_' + empId + '_' + period, status);
    },

    removePayslipStatus: function(companyId, empId, period) {
        this.remove('emp_payslip_status_' + companyId + '_' + empId + '_' + period);
    },

    // === PAY RUNS ===

    getPayruns: function(companyId) {
        return this.get('payruns_' + companyId) || [];
    },

    savePayruns: function(companyId, payruns) {
        this.set('payruns_' + companyId, payruns);
    },

    // === PAYROLL ITEMS (Master List) ===

    getPayrollItems: function(companyId) {
        return this.get('payroll_items_' + companyId) || [];
    },

    savePayrollItems: function(companyId, items) {
        this.set('payroll_items_' + companyId, items);
    },

    // === LEAVE ===

    getLeave: function(companyId, empId) {
        return this.get('emp_leave_' + companyId + '_' + empId) || [];
    },

    saveLeave: function(companyId, empId, leave) {
        this.set('emp_leave_' + companyId + '_' + empId, leave);
    },

    // === NOTES ===

    getNotes: function(companyId, empId) {
        return this.get('emp_notes_' + companyId + '_' + empId) || [];
    },

    saveNotes: function(companyId, empId, notes) {
        this.set('emp_notes_' + companyId + '_' + empId, notes);
    },

    // === ATTENDANCE ===

    getAttendance: function(companyId, dateStr) {
        return this.get('attendance_' + companyId + '_' + dateStr) || [];
    },

    saveAttendance: function(companyId, dateStr, entries) {
        this.set('attendance_' + companyId + '_' + dateStr, entries);
    },

    // === HISTORICAL DATA ===

    getHistoricalRecord: function(companyId, empId, period) {
        return this.get('emp_historical_' + companyId + '_' + empId + '_' + period);
    },

    saveHistoricalRecord: function(companyId, empId, period, data) {
        this.set('emp_historical_' + companyId + '_' + empId + '_' + period, data);
    },

    removeHistoricalRecord: function(companyId, empId, period) {
        this.remove('emp_historical_' + companyId + '_' + empId + '_' + period);
    },

    getHistoricalImportLog: function(companyId) {
        return this.get('historical_import_log_' + companyId) || [];
    },

    saveHistoricalImportLog: function(companyId, log) {
        this.set('historical_import_log_' + companyId, log);
    },

    // === AUDIT LOG ===

    getAuditLog: function(companyId) {
        return this.get('audit_log_' + companyId) || [];
    },

    saveAuditLog: function(companyId, log) {
        this.set('audit_log_' + companyId, log);
    },

    appendAuditLog: function(companyId, entry) {
        var log = this.getAuditLog(companyId);
        log.push(entry);
        this.saveAuditLog(companyId, log);
    },

    // === REPORT HISTORY ===

    getReportHistory: function(companyId) {
        return this.get('report_history_' + companyId) || [];
    },

    saveReportHistory: function(companyId, history) {
        this.set('report_history_' + companyId, history);
    },

    // === NARRATIVE ===

    getNarrative: function(companyId, empId, period) {
        return this.get('narrative_' + companyId + '_' + empId + '_' + period);
    },

    saveNarrative: function(companyId, empId, period, narrative) {
        this.set('narrative_' + companyId + '_' + empId + '_' + period, narrative);
    },

    removeNarrative: function(companyId, empId, period) {
        this.remove('narrative_' + companyId + '_' + empId + '_' + period);
    },

    // === PAYSLIP ARCHIVE (11-year retention) ===

    /**
     * Archive a finalized payslip for long-term retention.
     * Stores complete payslip data including calculation results,
     * employee snapshot, and retention metadata.
     * SA law requires payroll records kept for at least 5 years (BCEA/Tax).
     * Best practice: 11 years to cover SARS extended assessment periods.
     */
    archivePayslip: function(companyId, empId, period, payslipData) {
        var archiveKey = 'payslip_archive_' + companyId + '_' + empId + '_' + period;
        var record = {
            company_id: companyId,
            employee_id: empId,
            period: period,
            finalized_date: new Date().toISOString(),
            retention_until: new Date(new Date().getFullYear() + 11, new Date().getMonth(), new Date().getDate()).toISOString(),
            data: payslipData,
            archived: true
        };
        this.set(archiveKey, record);

        // Also update the archive index for this company
        var indexKey = 'payslip_archive_index_' + companyId;
        var index = this.get(indexKey) || [];
        var entry = { empId: empId, period: period, finalized_date: record.finalized_date };
        // Avoid duplicates
        var exists = index.some(function(i) { return i.empId === empId && i.period === period; });
        if (!exists) {
            index.push(entry);
            this.set(indexKey, index);
        }
        return record;
    },

    /**
     * Get an archived payslip.
     */
    getArchivedPayslip: function(companyId, empId, period) {
        return this.get('payslip_archive_' + companyId + '_' + empId + '_' + period);
    },

    /**
     * Get all archived payslip periods for a company.
     * Returns array of { empId, period, finalized_date }.
     */
    getArchiveIndex: function(companyId) {
        return this.get('payslip_archive_index_' + companyId) || [];
    },

    /**
     * Get all archived periods (unique period strings) for a company.
     */
    getArchivedPeriods: function(companyId) {
        var index = this.getArchiveIndex(companyId);
        var periods = {};
        index.forEach(function(entry) {
            periods[entry.period] = true;
        });
        return Object.keys(periods).sort();
    },

    /**
     * Get all archived payslips for an employee across all periods.
     */
    getEmployeeArchive: function(companyId, empId) {
        var index = this.getArchiveIndex(companyId);
        var records = {};
        var self = this;
        index.filter(function(i) { return i.empId === empId; }).forEach(function(entry) {
            var archived = self.getArchivedPayslip(companyId, empId, entry.period);
            if (archived) records[entry.period] = archived;
        });
        return records;
    }
};
