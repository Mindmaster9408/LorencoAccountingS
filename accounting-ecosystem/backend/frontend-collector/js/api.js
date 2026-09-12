/* ============================================================
   Collector — Shared API Helper (staff, authenticated)
   Same convention as every other frontend app's js/api.js in this
   ecosystem: JWT from localStorage, Bearer header, 401 -> login.
   ============================================================ */
(function () {
    var BASE = window.location.origin;
    var API_PREFIX = '/api/collector';

    function getToken() {
        return localStorage.getItem('token') || null;
    }

    function getHeaders(extra) {
        var h = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (getToken() || '')
        };
        if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
        return h;
    }

    async function apiFetch(path, options) {
        options = options || {};
        var fetchOptions = {
            method: options.method || 'GET',
            headers: getHeaders(options.headers)
        };
        if (options.body !== undefined) fetchOptions.body = options.body;

        var res = await fetch(BASE + API_PREFIX + path, fetchOptions);
        if (res.status === 401) {
            window.location.href = '/';
            throw new Error('Unauthorized');
        }
        return res;
    }

    async function apiJson(path, options) {
        var res = await apiFetch(path, options);
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
    }

    function escHtml(str) {
        var d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }

    function showToast(msg, isError) {
        var t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = 'toast show' + (isError ? ' error' : '');
        setTimeout(function () { t.className = 'toast'; }, 3500);
    }

    window.CollectorAPI = {
        fetch: apiFetch,
        json: apiJson,
        getHeaders: getHeaders,
        getToken: getToken,
        escHtml: escHtml,
        showToast: showToast
    };
})();
