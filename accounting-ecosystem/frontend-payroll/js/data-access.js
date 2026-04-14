// ============================================================
// DataAccess - API-backed persistence layer
// ============================================================
// Converted from localStorage to REST API calls against the
// Accounting Ecosystem backend at /api/payroll/*
//
// All methods now return Promises. Callers must use await or .then()
// The API handles company_id scoping via the JWT token.
// ============================================================

// Safety shim: ensures safeLocalStorage is always available even if
// polyfills.js failed to load or was not deployed.
if (typeof window.safeLocalStorage === 'undefined') {
    window.safeLocalStorage = window.localStorage;
}

var DataAccess = (function() {
    'use strict';

    const API_BASE = window.location.origin + '/api';

    // ─── HTTP Helper ─────────────────────────────────────────────────────────

    function getToken() {
        return safeLocalStorage.getItem('token');
    }

    async function apiRequest(method, path, body) {
        const url = API_BASE + path;
        const headers = { 'Content-Type': 'application/json' };
        const token = getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const opts = { method, headers };
        if (body && method !== 'GET') {
            opts.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, opts);

            // Token expired — redirect to login
            if (response.status === 401) {
                safeLocalStorage.removeItem('token');
                safeLocalStorage.removeItem('session');
                window.location.href = 'login.html';
                throw new Error('Session expired');
            }

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'API request failed');
            }
            return data;
        } catch (err) {
            console.error('API Error [' + method + ' ' + path + ']:', err.message);
            throw err;
        }
    }

    function GET(path)        { return apiRequest('GET', path); }
    function POST(path, body) { return apiRequest('POST', path, body); }
    function PUT(path, body)  { return apiRequest('PUT', path, body); }
    function DELETE(path)     { return apiRequest('DELETE', path); }

    // ─── Local Cache (fallback for offline reads) ────────────────────────────

    function cacheSet(key, data) {
        try { safeLocalStorage.setItem('cache_' + key, JSON.stringify(data)); } catch(e) {}
    }

    function cacheGet(key) {
        try {
            const val = safeLocalStorage.getItem('cache_' + key);
            return val ? JSON.parse(val) : null;
        } catch(e) { return null; }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    return {

        // === SESSION (local — token-based) ===

        getSession: function() {
            var val = safeLocalStorage.getItem('session');
            if (!val) return null;
            try { return JSON.parse(val); } catch(e) { return null; }
        },

        saveSession: function(session) {
            safeLocalStorage.setItem('session', JSON.stringify(session));
        },

        clearSession: function() {
            safeLocalStorage.removeItem('session');
            safeLocalStorage.removeItem('token');
        },

        // === COMPANIES ===

        getRegisteredCompanies: async function() {
            try {
                const result = await GET('/auth/companies');
                const companies = result.companies || result.data || result;
                cacheSet('companies', companies);
                return companies;
            } catch(e) {
                return cacheGet('companies') || [];
            }
        },

        saveRegisteredCompanies: function(companies) {
            cacheSet('companies', companies);
        },

        getCompanyDetails: async function(companyId) {
            try {
                const result = await GET('/companies/' + companyId);
                return result.company || result.data || result;
            } catch(e) {
                return cacheGet('company_' + companyId) || {};
            }
        },

        saveCompanyDetails: async function(companyId, details) {
            try {
                await PUT('/companies/' + companyId, details);
            } catch(e) {
                console.error('Failed to save company details:', e.message);
            }
        },

        // === USERS ===

        getRegisteredUsers: async function() {
            try {
                const result = await GET('/users');
                return result.users || result.data || result;
            } catch(e) {
                return cacheGet('users') || [];
            }
        },

        saveRegisteredUsers: function(users) {
            cacheSet('users', users);
        },

        // === EMPLOYEES ===

        getEmployees: async function(companyId) {
            try {
                const result = await GET('/employees');
                const employees = result.employees || result.data || result;
                cacheSet('employees_' + companyId, employees);
                return employees;
            } catch(e) {
                // Try API response cache first; fall back to localStorage-managed employees
                // (written by employee-management.html under the non-prefixed key)
                return cacheGet('employees_' + companyId) ||
                    JSON.parse(safeLocalStorage.getItem('employees_' + companyId) || '[]');
            }
        },

        saveEmployees: async function(companyId, employees) {
            cacheSet('employees_' + companyId, employees);
        },

        getEmployeeById: async function(companyId, empId) {
            try {
                const result = await GET('/employees/' + empId);
                return result.employee || result.data || result;
            } catch(e) {
                var cached = cacheGet('employees_' + companyId) || [];
                return cached.find(function(e) { return e.id == empId; }) || null;
            }
        },

        // === EMPLOYEE PAYROLL DATA ===

        getEmployeePayroll: async function(companyId, empId) {
            try {
                const result = await GET('/payroll/employees/' + empId);
                return result.data || result || { basic_salary: 0, regular_inputs: [] };
            } catch(e) {
                return cacheGet('emp_payroll_' + companyId + '_' + empId) || { basic_salary: 0, regular_inputs: [] };
            }
        },

        saveEmployeePayroll: async function(companyId, empId, data) {
            try {
                await PUT('/payroll/employees/' + empId + '/salary', data);
                cacheSet('emp_payroll_' + companyId + '_' + empId, data);
            } catch(e) {
                cacheSet('emp_payroll_' + companyId + '_' + empId, data);
                console.error('Failed to save employee payroll:', e.message);
            }
        },

        // === PERIOD-SPECIFIC DATA ===

        getCurrentInputs: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/transactions?employee_id=' + empId + '&period=' + period);
                const txn = result.data || result;
                return txn.current_inputs || [];
            } catch(e) {
                return cacheGet('emp_current_' + companyId + '_' + empId + '_' + period) || [];
            }
        },

        saveCurrentInputs: async function(companyId, empId, period, inputs) {
            try {
                await POST('/payroll/transactions/inputs', {
                    employee_id: empId,
                    period_key: period,
                    inputs: inputs
                });
            } catch(e) {
                cacheSet('emp_current_' + companyId + '_' + empId + '_' + period, inputs);
            }
        },

        getOvertime: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/transactions?employee_id=' + empId + '&period=' + period + '&type=overtime');
                return result.data || [];
            } catch(e) {
                return cacheGet('emp_overtime_' + companyId + '_' + empId + '_' + period) || [];
            }
        },

        saveOvertime: async function(companyId, empId, period, entries) {
            try {
                await POST('/payroll/transactions/overtime', {
                    employee_id: empId, period_key: period, entries: entries
                });
            } catch(e) {
                cacheSet('emp_overtime_' + companyId + '_' + empId + '_' + period, entries);
            }
        },

        getShortTime: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/transactions?employee_id=' + empId + '&period=' + period + '&type=short_time');
                return result.data || [];
            } catch(e) {
                return cacheGet('emp_short_time_' + companyId + '_' + empId + '_' + period) || [];
            }
        },

        saveShortTime: async function(companyId, empId, period, entries) {
            try {
                await POST('/payroll/transactions/short-time', {
                    employee_id: empId, period_key: period, entries: entries
                });
            } catch(e) {
                cacheSet('emp_short_time_' + companyId + '_' + empId + '_' + period, entries);
            }
        },

        getMultiRate: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/transactions?employee_id=' + empId + '&period=' + period + '&type=multi_rate');
                return result.data || [];
            } catch(e) {
                return cacheGet('emp_multi_rate_' + companyId + '_' + empId + '_' + period) || [];
            }
        },

        saveMultiRate: async function(companyId, empId, period, entries) {
            try {
                await POST('/payroll/transactions/multi-rate', {
                    employee_id: empId, period_key: period, entries: entries
                });
            } catch(e) {
                cacheSet('emp_multi_rate_' + companyId + '_' + empId + '_' + period, entries);
            }
        },

        // === PAYSLIP STATUS ===

        getPayslipStatus: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/transactions?employee_id=' + empId + '&period=' + period);
                const txn = result.data || result;
                return { status: txn.status || 'draft' };
            } catch(e) {
                return cacheGet('emp_payslip_status_' + companyId + '_' + empId + '_' + period) || { status: 'draft' };
            }
        },

        savePayslipStatus: async function(companyId, empId, period, statusObj) {
            try {
                await PUT('/payroll/transactions/status', {
                    employee_id: empId, period_key: period,
                    status: statusObj.status || statusObj
                });
            } catch(e) {
                cacheSet('emp_payslip_status_' + companyId + '_' + empId + '_' + period, statusObj);
            }
        },

        removePayslipStatus: async function(companyId, empId, period) {
            try {
                await PUT('/payroll/transactions/status', {
                    employee_id: empId, period_key: period, status: 'draft'
                });
            } catch(e) {}
        },

        // === PAY RUNS ===

        getPayruns: async function(companyId) {
            try {
                const result = await GET('/payroll/periods');
                const periods = result.data || result.periods || result;
                cacheSet('payruns_' + companyId, periods);
                return periods;
            } catch(e) {
                return cacheGet('payruns_' + companyId) || [];
            }
        },

        savePayruns: async function(companyId, payruns) {
            cacheSet('payruns_' + companyId, payruns);
        },

        // === PAYROLL ITEMS (Master List) ===

        getPayrollItems: async function(companyId) {
            try {
                const result = await GET('/payroll/items');
                const items = result.data || result.items || result;
                cacheSet('payroll_items_' + companyId, items);
                return items;
            } catch(e) {
                return cacheGet('payroll_items_' + companyId) || [];
            }
        },

        savePayrollItems: async function(companyId, items) {
            cacheSet('payroll_items_' + companyId, items);
        },

        // === LEAVE ===

        getLeave: async function(companyId, empId, year) {
            const yearParam = year ? '&year=' + year : '';
            try {
                const result = await GET('/payroll/attendance/leave?employee_id=' + empId + yearParam);
                // Cache for offline fallback
                cacheSet('emp_leave_' + companyId + '_' + empId, result.records || []);
                cacheSet('emp_leave_balances_' + companyId + '_' + empId, result.balances || []);
                return result; // { records, balances, year }
            } catch(e) {
                return {
                    records: cacheGet('emp_leave_' + companyId + '_' + empId) || [],
                    balances: cacheGet('emp_leave_balances_' + companyId + '_' + empId) || [],
                    year: year || new Date().getFullYear()
                };
            }
        },

        saveLeave: async function(companyId, empId, record) {
            // Saves a SINGLE leave record. record must have: leave_type, start_date, end_date, days_taken, status, reason
            const result = await POST('/payroll/attendance/leave', { employee_id: empId, records: [record] });
            return result;
        },

        deleteLeave: async function(companyId, empId, recordId) {
            await DELETE('/payroll/attendance/leave/' + recordId);
        },

        updateLeaveStatus: async function(companyId, recordId, status) {
            await PUT('/payroll/attendance/leave/' + recordId, { status });
        },

        // === NOTES ===

        getNotes: async function(companyId, empId) {
            try {
                const result = await GET('/payroll/employees/' + empId + '/notes');
                return result.data || [];
            } catch(e) {
                return cacheGet('emp_notes_' + companyId + '_' + empId) || [];
            }
        },

        saveNotes: async function(companyId, empId, notes) {
            try {
                await POST('/payroll/employees/' + empId + '/notes', { notes: notes });
            } catch(e) {
                cacheSet('emp_notes_' + companyId + '_' + empId, notes);
            }
        },

        // === ATTENDANCE ===

        getAttendance: async function(companyId, dateStr) {
            try {
                const result = await GET('/payroll/attendance?date=' + dateStr);
                const entries = result.data || result.entries || result;
                cacheSet('attendance_' + companyId + '_' + dateStr, entries);
                return entries;
            } catch(e) {
                return cacheGet('attendance_' + companyId + '_' + dateStr) || [];
            }
        },

        saveAttendance: async function(companyId, dateStr, entries) {
            try {
                await POST('/payroll/attendance', { date: dateStr, entries: entries });
            } catch(e) {
                cacheSet('attendance_' + companyId + '_' + dateStr, entries);
            }
        },

        // === HISTORICAL DATA ===

        getHistoricalRecord: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/employees/' + empId + '/historical?period=' + period);
                return result.data || null;
            } catch(e) {
                return cacheGet('emp_historical_' + companyId + '_' + empId + '_' + period);
            }
        },

        saveHistoricalRecord: async function(companyId, empId, period, data) {
            try {
                await POST('/payroll/employees/' + empId + '/historical', {
                    period_key: period, ...data
                });
            } catch(e) {
                cacheSet('emp_historical_' + companyId + '_' + empId + '_' + period, data);
            }
        },

        removeHistoricalRecord: async function(companyId, empId, period) {
            try {
                await DELETE('/payroll/employees/' + empId + '/historical?period=' + period);
            } catch(e) {}
        },

        getHistoricalImportLog: async function(companyId) {
            try {
                const result = await GET('/payroll/employees/historical-log');
                return result.data || [];
            } catch(e) {
                return cacheGet('historical_import_log_' + companyId) || [];
            }
        },

        saveHistoricalImportLog: async function(companyId, log) {
            cacheSet('historical_import_log_' + companyId, log);
        },

        // === AUDIT LOG ===

        getAuditLog: async function(companyId) {
            try {
                const result = await GET('/audit?module=payroll&limit=200');
                return result.data || result.logs || [];
            } catch(e) {
                return cacheGet('audit_log_' + companyId) || [];
            }
        },

        saveAuditLog: function(companyId, log) {
            cacheSet('audit_log_' + companyId, log);
        },

        appendAuditLog: function(companyId, entry) {
            // Audit is auto-logged by backend middleware
            var log = cacheGet('audit_log_' + companyId) || [];
            log.push(entry);
            cacheSet('audit_log_' + companyId, log);
        },

        // === REPORT HISTORY ===

        getReportHistory: async function(companyId) {
            return cacheGet('report_history_' + companyId) || [];
        },

        saveReportHistory: async function(companyId, history) {
            cacheSet('report_history_' + companyId, history);
        },

        // === NARRATIVE ===

        getNarrative: async function(companyId, empId, period) {
            try {
                const result = await GET('/payroll/employees/' + empId + '/narrative?period=' + period);
                return result.data || null;
            } catch(e) {
                return cacheGet('narrative_' + companyId + '_' + empId + '_' + period);
            }
        },

        saveNarrative: async function(companyId, empId, period, narrative) {
            try {
                await POST('/payroll/employees/' + empId + '/narrative', {
                    period_key: period, narrative: narrative
                });
            } catch(e) {
                cacheSet('narrative_' + companyId + '_' + empId + '_' + period, narrative);
            }
        },

        removeNarrative: async function(companyId, empId, period) {
            try {
                await DELETE('/payroll/employees/' + empId + '/narrative?period=' + period);
            } catch(e) {}
        }
    };
})();

// ============================================================
// Cloud localStorage Bridge — ECO Payroll
//
// Intercepts ALL safeLocalStorage.*  calls and routes payroll data
// through the /api/payroll/kv endpoint (Supabase-backed, company-
// scoped) so that clearing browser history never loses any data.
//
// Only 'session' and 'token' stay in native safeLocalStorage.
// 'cache_*' keys used as offline fallback also remain local.
// ============================================================
(function installEcoPayrollLocalStorageBridge() {
    'use strict';

    if (window.__ecoPayrollBridgeInstalled) return;
    // Guard: if safeLocalStorage doesn't exist (polyfills.js not loaded),
    // skip bridge installation to prevent ReferenceError crash.
    if (typeof window.safeLocalStorage === 'undefined') return;
    window.__ecoPayrollBridgeInstalled = true;

    var KV_URL = window.location.origin + '/api/payroll/kv';

    // Keys that must stay in native localStorage (auth state)
    function isLocalKey(key) {
        return key === 'session' || key === 'token' || key === 'company' || key === 'selectedCompanyId' ||
               (typeof key === 'string' && key.indexOf('cache_') === 0) ||
               (typeof key === 'string' && key.indexOf('eco_') === 0) ||
               key === 'availableCompanies' ||
               key === 'user' || key === 'sso_source' || key === 'language';
    }

    // In-memory cache populated synchronously on page load
    window._ecoPayrollKvCache = {};
    window._ecoPayrollKvOnline = false;

    try {
        var token = (function() {
            try { return window.safeLocalStorage.getItem
                ? window.safeLocalStorage.getItem.call
                    ? null // bridge not installed yet, read direct
                    : null
                : null;
            } catch(e){ return null; }
        }());
        // Read token before bridge patches localStorage
        token = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')
            ? Storage.prototype.getItem.call(localStorage, 'token')
            : null;

        if (token) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', KV_URL, false);  // synchronous
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
            xhr.send(null);
            if (xhr.status === 200) {
                window._ecoPayrollKvCache = JSON.parse(xhr.responseText) || {};
                window._ecoPayrollKvOnline = true;
                console.log('%c✅ ECO Payroll cloud connected — data in Supabase (no local)', 'color:#28a745;font-weight:bold;');
            }
        }
    } catch(e) {
        console.warn('ECO Payroll cloud bridge: offline — ' + e.message);
    }

    function kvGet(key) {
        var raw = window._ecoPayrollKvCache[key];
        if (raw === undefined || raw === null) return null;
        try { return typeof raw === 'string' ? raw : JSON.stringify(raw); } catch(_) { return String(raw); }
    }

    function kvSet(key, value) {
        var parsed;
        try { parsed = JSON.parse(value); } catch(_) { parsed = value; }
        window._ecoPayrollKvCache[key] = parsed;
        if (!window._ecoPayrollKvOnline) return;
        var token = Storage.prototype.getItem.call(localStorage, 'token');
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', KV_URL + '/' + encodeURIComponent(key), true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(JSON.stringify({ value: parsed }));
    }

    function kvRemove(key) {
        delete window._ecoPayrollKvCache[key];
        if (!window._ecoPayrollKvOnline) return;
        var token = Storage.prototype.getItem.call(localStorage, 'token');
        var xhr = new XMLHttpRequest();
        xhr.open('DELETE', KV_URL + '/' + encodeURIComponent(key), true);
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(null);
    }

    function kvKeys() {
        return Object.keys(window._ecoPayrollKvCache);
    }

    var _native = {
        getItem:    Storage.prototype.getItem.bind(localStorage),
        setItem:    Storage.prototype.setItem.bind(localStorage),
        removeItem: Storage.prototype.removeItem.bind(localStorage),
        key:        Storage.prototype.key.bind(localStorage)
    };

    safeLocalStorage.getItem = function(key) {
        if (isLocalKey(key)) return _native.getItem(key);
        return kvGet(key);
    };
    safeLocalStorage.setItem = function(key, value) {
        if (isLocalKey(key)) { _native.setItem(key, value); return; }
        kvSet(key, value);
    };
    safeLocalStorage.removeItem = function(key) {
        if (isLocalKey(key)) { _native.removeItem(key); return; }
        kvRemove(key);
    };
    safeLocalStorage.key = function(index) {
        var keys = kvKeys();
        return keys[Number(index)] || null;
    };
    try {
        Object.defineProperty(localStorage, 'length', {
            get: function() { return kvKeys().length; },
            configurable: true
        });
    } catch(_) {}
}());
