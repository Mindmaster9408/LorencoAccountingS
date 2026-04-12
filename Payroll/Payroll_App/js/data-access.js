// ============================================================
// DataAccess - Cloud storage layer via Supabase
//
// All data lives in Supabase (cloud PostgreSQL). The server
// exposes the same /api/storage endpoints but now backed by
// the payroll_kv_store table — no local files at all.
//
// On every page load this script:
//   1. Fetches the full cloud data store into a local cache
//   2. Every write goes to the server (Supabase) first,
//      then updates the local cache for instant reads
//
// Works on localhost, Zeabur, or any deployed server.
// ============================================================

(function _initCloudSync() {
    'use strict';

    // These keys are session/auth — stay browser-local only (login state)
    var SESSION_KEYS = { session: 1, token: 1 };

    // Auto-detect server URL — works for localhost and deployed environments
    var SERVER_URL = window.location.origin;

    // In-memory cache for fast reads (populated from Supabase on every page load)
    window._payrollCache = {};

    // Retrieve stored token for authenticated storage requests
    // (token is set by auth.js on login, stored in native localStorage)
    function getStorageToken() {
        try {
            return window._payrollNativeLocalStorage
                ? window._payrollNativeLocalStorage.getItem('token')
                : localStorage.getItem('token');
        } catch (_) { return null; }
    }

    try {
        // Load ALL data from Supabase via server (synchronous on page load)
        var xhr = new XMLHttpRequest();
        xhr.open('GET', SERVER_URL + '/api/storage', false);   // false = synchronous
        var initToken = getStorageToken();
        if (initToken) xhr.setRequestHeader('Authorization', 'Bearer ' + initToken);
        xhr.send(null);

        if (xhr.status !== 200) throw new Error('Server returned ' + xhr.status);

        window._payrollCache  = JSON.parse(xhr.responseText);
        window._payrollServerUrl    = SERVER_URL;
        window._payrollServerOnline = true;

        console.log('%c✅ Payroll cloud connected — all data in Supabase (no local storage)', 'color:#28a745;font-weight:bold;');

    } catch (e) {
        window._payrollServerOnline = false;
        console.log('%c❌ Payroll cloud server not reachable — data unavailable\n   ' + e.message, 'color:#dc3545;font-weight:bold;');
    }
}());

// ============================================================
// DataAccess - Cloud-ONLY abstraction (Supabase is truth)
//
// - get()    → reads from in-memory cache (loaded from Supabase)
// - set()    → writes to Supabase, then updates cache
// - remove() → deletes from Supabase, then removes from cache
//
// localStorage is NEVER used for payroll data.
// You can switch browsers and all data is the same.
// ============================================================

var DataAccess = {

    // === GENERIC OPERATIONS ===

    get: function(key) {
        if (!window._payrollCache || !window._payrollCache.hasOwnProperty(key)) {
            return null;
        }
        var cached = window._payrollCache[key];
        if (typeof cached === 'string') {
            try { return JSON.parse(cached); } catch(e) { return cached; }
        }
        return cached;
    },

    getRaw: function(key) {
        if (key === 'session' || key === 'token') {
            var nativeStore = window._payrollNativeLocalStorage;
            return nativeStore ? nativeStore.getItem(key) : safeLocalStorage.getItem(key);
        }
        if (!window._payrollCache || !Object.prototype.hasOwnProperty.call(window._payrollCache, key)) {
            return null;
        }
        var cached = window._payrollCache[key];
        return typeof cached === 'string' ? cached : JSON.stringify(cached);
    },

    listKeys: function() {
        var keys = [];
        var nativeStore = window._payrollNativeLocalStorage;
        if (nativeStore) {
            if (nativeStore.getItem('session') !== null) keys.push('session');
            if (nativeStore.getItem('token') !== null) keys.push('token');
        } else {
            if (safeLocalStorage.getItem('session') !== null) keys.push('session');
            if (safeLocalStorage.getItem('token') !== null) keys.push('token');
        }
        if (window._payrollCache) {
            keys = keys.concat(Object.keys(window._payrollCache));
        }
        return keys;
    },

    set: function(key, value) {
        var jsonValue = JSON.stringify(value);

        // Update in-memory cache immediately (for instant reads on same page)
        if (window._payrollCache) {
            window._payrollCache[key] = value;
        }

        // Write to Supabase via server (async, non-blocking)
        if (window._payrollServerOnline) {
            var x = new XMLHttpRequest();
            x.open('PUT', (window._payrollServerUrl || window.location.origin) + '/api/storage/' + encodeURIComponent(key), true);
            x.setRequestHeader('Content-Type', 'application/json');
            var writeToken = getStorageToken();
            if (writeToken) x.setRequestHeader('Authorization', 'Bearer ' + writeToken);
            x.onload = function() {
                if (x.status >= 500) {
                    // Server-side failure — data is safe in localStorage but cloud sync failed
                    console.error('DataAccess.set: server error ' + x.status + ' for key ' + key);
                    window._payrollWriteError = true;
                    // Surface a visible (non-blocking) warning once per page load
                    if (!window._payrollWriteWarnShown) {
                        window._payrollWriteWarnShown = true;
                        console.warn('Payroll data may not have synced to the cloud. Please check your connection and try again.');
                        var banner = document.getElementById('payrollSyncErrorBanner');
                        if (banner) { banner.style.display = 'block'; }
                    }
                }
            };
            x.onerror = function() {
                window._payrollServerOnline = false;
                console.warn('DataAccess.set: network error writing key ' + key);
            };
            x.send(JSON.stringify({ value: jsonValue }));
        }
    },

    remove: function(key) {
        // Remove from in-memory cache
        if (window._payrollCache) {
            delete window._payrollCache[key];
        }

        // Delete from Supabase via server (async)
        if (window._payrollServerOnline) {
            var x = new XMLHttpRequest();
            x.open('DELETE', (window._payrollServerUrl || window.location.origin) + '/api/storage/' + encodeURIComponent(key), true);
            var delToken = getStorageToken();
            if (delToken) x.setRequestHeader('Authorization', 'Bearer ' + delToken);
            x.onerror = function() { window._payrollServerOnline = false; };
            x.send(null);
        }
    },

    // === SESSION ===

    // === SESSION (browser-local only — login state per device) ===

    getSession: function() {
        var val = safeLocalStorage.getItem('session');
        if (!val) return null;
        try { return JSON.parse(val); } catch(e) { return val; }
    },

    saveSession: function(session) {
        safeLocalStorage.setItem('session', JSON.stringify(session));
    },

    clearSession: function() {
        safeLocalStorage.removeItem('session');
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

// Keep legacy pages functional while enforcing cloud-backed payroll storage.
(function installLocalStorageCloudBridge() {
    'use strict';

    if (window.__payrollLocalStorageCloudBridgeInstalled) return;
    window.__payrollLocalStorageCloudBridgeInstalled = true;

    if (!window.localStorage) return;

    var nativeStore = {
        getItem: safeLocalStorage.getItem.bind(safeLocalStorage),
        setItem: safeLocalStorage.setItem.bind(safeLocalStorage),
        removeItem: safeLocalStorage.removeItem.bind(safeLocalStorage),
        key: function(index) {
            try {
                return typeof localStorage.key === 'function' ? localStorage.key(index) : null;
            } catch (_) {
                return null;
            }
        }
    };
    window._payrollNativeLocalStorage = nativeStore;

    function isLocalSessionKey(key) {
        return key === 'session' || key === 'token';
    }

    function isCloudKey(key) {
        return typeof key === 'string' && key.length > 0 && !isLocalSessionKey(key);
    }

    function parseRaw(raw) {
        if (raw === null || raw === undefined) return null;
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }

    safeLocalStorage.getItem = function(key) {
        if (!isCloudKey(key)) return nativeStore.getItem(key);
        return DataAccess.getRaw(key);
    };

    safeLocalStorage.setItem = function(key, value) {
        if (!isCloudKey(key)) {
            nativeStore.setItem(key, value);
            return;
        }
        DataAccess.set(key, parseRaw(value));
    };

    safeLocalStorage.removeItem = function(key) {
        if (!isCloudKey(key)) {
            nativeStore.removeItem(key);
            return;
        }
        DataAccess.remove(key);
    };

    safeLocalStorage.key = function(index) {
        var i = Number(index);
        if (!Number.isFinite(i) || i < 0) return null;
        var keys = DataAccess.listKeys();
        return keys[i] || null;
    };

    // Override safeLocalStorage.length so iteration loops see cloud keys
    try {
        Object.defineProperty(localStorage, 'length', {
            get: function() { return DataAccess.listKeys().length; },
            configurable: true
        });
    } catch (_) { /* read-only in some environments — safe to skip */ }
})();
