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
        getHeaders: getHeaders,
        getToken: getToken,
        escHtml: escHtml,
        showToast: showToast
    };
})();
