/* ============================================================
   Lorenco Practice — safeLocalStorage Bridge
   Rule D compliance: business data must never go to browser storage.
   Load this BEFORE auth.js so the shim in auth.js uses this impl.
   ============================================================ */
(function () {
    var ALLOWED_KEYS = [
        'token', 'practice_token', 'session', 'user', 'company',
        'sso_source', 'availableCompanies'
    ];

    var KV_ENDPOINT = '/api/practice/kv';

    function isAllowed(key) {
        for (var i = 0; i < ALLOWED_KEYS.length; i++) {
            if (key === ALLOWED_KEYS[i] || key.indexOf(ALLOWED_KEYS[i]) === 0) return true;
        }
        return false;
    }

    function getAuthToken() {
        return localStorage.getItem('token') || localStorage.getItem('practice_token') || null;
    }

    var bridge = {
        getItem: function (key) {
            if (isAllowed(key)) return localStorage.getItem(key);
            return null;
        },
        setItem: function (key, value) {
            if (isAllowed(key)) {
                localStorage.setItem(key, value);
                return;
            }
            var token = getAuthToken();
            if (!token) return;
            fetch(KV_ENDPOINT + '/' + encodeURIComponent(key), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ value: value })
            }).catch(function () {});
        },
        removeItem: function (key) {
            if (isAllowed(key)) localStorage.removeItem(key);
        }
    };

    if (typeof window.safeLocalStorage === 'undefined') {
        window.safeLocalStorage = bridge;
    }
})();
