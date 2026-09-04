/* ============================================================
   Lorenco Practice — Shared API Helper
   Wraps all fetch calls with auth header and 401 redirect.
   ============================================================ */
(function () {
    var BASE = window.location.origin;

    function getToken() {
        if (window.AUTH && typeof AUTH.getToken === 'function') return AUTH.getToken();
        return localStorage.getItem('token') || localStorage.getItem('practice_token') || null;
    }

    function getHeaders(extra) {
        var h = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (getToken() || '')
        };
        if (extra) {
            Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
        }
        return h;
    }

    async function apiFetch(path, options) {
        options = options || {};
        var fetchOptions = {
            method: options.method || 'GET',
            headers: getHeaders(options.headers)
        };
        if (options.body !== undefined) fetchOptions.body = options.body;

        var res = await fetch(BASE + path, fetchOptions);

        if (res.status === 401) {
            window.location.href = '/';
            throw new Error('Unauthorized');
        }
        return res;
    }

    // PracticeAPI.fetch() intentionally returns the raw, unparsed Response —
    // some callers need it raw (blob/text downloads, or code that wants to
    // inspect res.status itself). Most callers just want the parsed JSON body
    // and to have a bad status surface as a real, catchable error instead of
    // silently reading undefined off a Response object. Use PracticeAPI.json()
    // for that — it's the fix for a real, shipped bug (2026-09-04): several
    // pages called PracticeAPI.fetch() and then read properties straight off
    // the Response (e.g. `res.entries`, `res.members`), which are always
    // undefined, so every read silently came back empty regardless of what
    // the server returned. Root cause of "approved time never reaches
    // Billing/WIP" and "no team members found" despite both existing server-side.
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

    window.PracticeAPI = {
        fetch: apiFetch,
        json: apiJson,
        getHeaders: getHeaders,
        getToken: getToken,
        escHtml: escHtml,
        showToast: showToast
    };
})();
