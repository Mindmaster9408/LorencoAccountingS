// =============================================================================
// PayrollAPI — Payroll Execution API Service Layer
// =============================================================================
// Wraps the payroll execution endpoints:
//   POST /api/payroll/run
//   POST /api/payroll/finalize
//   GET  /api/payroll/history
//   GET  /api/payroll/history/run/:run_id
//   GET  /api/payroll/calculate/history/:employee_id/:period_key
//
// All methods return { status, ok, data } so callers can handle
// specific HTTP status codes (e.g. 409 Conflict) without throwing.
// =============================================================================

var PayrollAPI = (function () {
    'use strict';

    var BASE = window.location.origin + '/api/payroll';
    var ls   = window.safeLocalStorage || window.localStorage;

    function getToken() {
        return ls.getItem('token');
    }

    // Internal fetch wrapper. Never throws on non-2xx — returns { status, ok, data }.
    async function request(method, url, body) {
        var headers = { 'Content-Type': 'application/json' };
        var token   = getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;

        var opts = { method: method, headers: headers };
        if (body) opts.body = JSON.stringify(body);

        try {
            var res  = await fetch(url, opts);
            var data = await res.json();

            if (res.status === 401) {
                ls.removeItem('token');
                ls.removeItem('session');
                window.location.href = 'login.html';
                return { status: 401, ok: false, data: data };
            }

            return { status: res.status, ok: res.ok, data: data };
        } catch (err) {
            console.error('PayrollAPI [' + method + ' ' + url + ']:', err.message);
            return {
                status: 0,
                ok: false,
                data: { success: false, error: 'Network error — could not reach server' }
            };
        }
    }

    return {

        // POST /api/payroll/run
        // Body: { period_key, employee_ids }
        // 200: { success, run_id, period_key, processed[], errors[], totals, timestamp }
        // 404: period not found
        // 409: period already finalized
        run: function (periodKey, employeeIds, voluntaryConfigs) {
            var body = {
                period_key:   periodKey,
                employee_ids: employeeIds
            };
            if (voluntaryConfigs && Object.keys(voluntaryConfigs).length > 0) {
                body.voluntary_configs = voluntaryConfigs;
            }
            return request('POST', BASE + '/run', body);
        },

        // POST /api/payroll/finalize
        // Body: { run_id, period_key }
        // 200: { success, run_id, period_key, locked_count, timestamp }
        // 404: run not found
        // 409: already finalized
        finalize: function (runId, periodKey) {
            return request('POST', BASE + '/finalize', {
                run_id:     runId,
                period_key: periodKey
            });
        },

        // GET /api/payroll/history?period_key=YYYY-MM
        // 200: { success, period_key, count, snapshots[], timestamp }
        getHistory: function (periodKey) {
            return request('GET', BASE + '/history?period_key=' + encodeURIComponent(periodKey));
        },

        // GET /api/payroll/history/run/:run_id
        // 200: { success, run: { id, status, totals... }, timestamp }
        getRunDetail: function (runId) {
            return request('GET', BASE + '/history/run/' + encodeURIComponent(runId));
        },

        // GET /api/payroll/calculate/history/:employee_id/:period_key
        // 200: { success, employee_id, period_key, data: { gross, paye, uif, sdl, net, ... } }
        getEmployeePeriodHistory: function (employeeId, periodKey) {
            return request('GET', BASE + '/calculate/history/' +
                encodeURIComponent(employeeId) + '/' + encodeURIComponent(periodKey));
        }

    };

})();
