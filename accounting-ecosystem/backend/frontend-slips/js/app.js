/* ============================================================================
   Slip Capture — phone-first PWA
   ============================================================================
   Browser storage (CLAUDE.md Part D): the ONLY thing stored locally is the
   auth token ('slips_token' — also set by the dashboard's SSO launch). Slips,
   details and the upload queue live in memory and on the server only. A
   failed upload stays in the on-screen queue (in memory) for retry; the
   photo itself is still in the phone's own gallery.
   ============================================================================ */
(function () {
    'use strict';

    var TOKEN_KEY = 'slips_token';
    var API = window.location.origin + '/api/slips';
    var AUTH = window.location.origin + '/api/auth';
    var PAGE_SIZE = 30;

    // Images larger than this are downscaled before upload (phone photos are
    // often 3–8 MB). The longest edge stays large enough to read a till slip.
    var COMPRESS_OVER_BYTES = 1.5 * 1024 * 1024;
    var MAX_EDGE_PX = 2400;
    var JPEG_QUALITY = 0.85;

    var state = {
        slips: [],
        total: 0,
        offset: 0,
        status: 'active',
        search: '',
        current: null,      // slip open in the sheet
        queue: [],          // [{ id, file, name, status, error, slip }]
        pendingLogin: null  // { token, companies } between login steps
    };

    // ── Small helpers ──────────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    }
    function setToken(t) {
        try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* private mode: session-only */ }
        memoryToken = t;
    }
    function clearToken() {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        memoryToken = null;
    }
    var memoryToken = null;
    function token() { return memoryToken || getToken(); }

    var toastTimer = null;
    function toast(msg, isError) {
        var t = $('toast');
        t.textContent = msg;
        t.className = 'toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.className = 'toast'; }, 3500);
    }

    function fmtAmount(v) {
        if (v === null || v === undefined || v === '') return '';
        var n = Number(v);
        if (!isFinite(n)) return '';
        return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtDate(iso) {
        if (!iso) return '';
        var d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
        return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function fmtDateTime(iso) {
        var d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function fmtSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── API ────────────────────────────────────────────────────────────────
    function ApiError(message, status, body) {
        this.message = message; this.status = status; this.body = body || {};
    }
    ApiError.prototype = Object.create(Error.prototype);

    async function request(url, options) {
        options = options || {};
        var headers = options.headers || {};
        var t = options.token || token();
        if (t) headers['Authorization'] = 'Bearer ' + t;
        if (options.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.json);
        }
        var res;
        try {
            res = await fetch(url, { method: options.method || 'GET', headers: headers, body: options.body });
        } catch (e) {
            throw new ApiError('No connection. Check your internet and try again.', 0);
        }
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 401 && !options.allow401) {
            clearToken();
            showLogin('Your session has expired. Please sign in again.');
            throw new ApiError('Session expired', 401, data);
        }
        if (!res.ok) throw new ApiError(data.message || data.error || ('Request failed (' + res.status + ')'), res.status, data);
        return data;
    }

    // ── Views ──────────────────────────────────────────────────────────────
    function showLogin(message) {
        $('appView').hidden = true;
        $('loginView').hidden = false;
        $('loginForm').hidden = false;
        $('twoFactorForm').hidden = true;
        $('companyPicker').hidden = true;
        state.pendingLogin = null;
        var err = $('loginError');
        err.hidden = !message;
        err.textContent = message || '';
    }

    function loginError(msg) {
        var err = $('loginError');
        err.hidden = false;
        err.textContent = msg;
    }

    async function showApp() {
        try {
            var ctx = await request(API + '/context');
            $('companyName').textContent = ctx.company && ctx.company.name ? ctx.company.name : 'Company #' + (ctx.company && ctx.company.id);
        } catch (e) {
            if (e.status === 401) return;
            if (e.status === 403 || e.status === 400) {
                // Signed in, but this company doesn't have the app (or no company).
                showLogin(e.message);
                $('loginForm').hidden = true;
                await offerCompanySwitch();
                return;
            }
            showLogin(e.message);
            return;
        }
        $('loginView').hidden = true;
        $('appView').hidden = false;
        await loadSlips(true);
    }

    // ── Login flow ─────────────────────────────────────────────────────────
    async function handleLoginResponse(data) {
        if (data.requires2FA) {
            state.pendingLogin = { pendingToken: data.pendingToken };
            $('loginForm').hidden = true;
            $('twoFactorForm').hidden = false;
            $('loginError').hidden = true;
            return;
        }
        if (!data.token) throw new ApiError(data.error || 'Sign-in failed', 0);

        var companies = data.companies || [];
        if (data.requiresCompanySelection || (!data.selectedCompany && companies.length)) {
            setToken(data.token);
            renderCompanyPicker(companies);
            return;
        }
        if (!data.selectedCompany && !(data.user && data.user.isSuperAdmin)) {
            throw new ApiError('Your account is not linked to any company yet.', 0);
        }
        setToken(data.token);
        await showApp();
    }

    function renderCompanyPicker(companies) {
        $('loginView').hidden = false;
        $('appView').hidden = true;
        $('loginForm').hidden = true;
        $('twoFactorForm').hidden = true;
        $('companyPicker').hidden = false;
        // Companies that already have the app first; others still selectable
        // (super admins can open any company — Rule F1).
        var sorted = companies.slice().sort(function (a, b) {
            var ah = (a.modules_enabled || []).indexOf('slips') >= 0 ? 0 : 1;
            var bh = (b.modules_enabled || []).indexOf('slips') >= 0 ? 0 : 1;
            if (ah !== bh) return ah - bh;
            return String(a.trading_name || a.company_name).localeCompare(String(b.trading_name || b.company_name));
        });
        $('companyList').innerHTML = sorted.length ? sorted.map(function (c) {
            return '<button type="button" class="btn" data-id="' + esc(c.id) + '">' +
                esc(c.trading_name || c.company_name || ('Company #' + c.id)) + '</button>';
        }).join('') : '<div class="muted">No companies available.</div>';
        Array.prototype.forEach.call($('companyList').querySelectorAll('button[data-id]'), function (b) {
            b.addEventListener('click', function () { selectCompany(b.getAttribute('data-id')); });
        });
    }

    async function selectCompany(companyId) {
        try {
            var data = await request(AUTH + '/select-company', { method: 'POST', json: { companyId: companyId } });
            setToken(data.token);
            $('loginError').hidden = true;
            await showApp();
        } catch (e) {
            if (e.status !== 401) loginError(e.message);
        }
    }

    async function offerCompanySwitch() {
        try {
            var data = await request(AUTH + '/companies');
            renderCompanyPicker(data.companies || []);
        } catch (e) {
            if (e.status !== 401) loginError(e.message);
        }
    }

    // ── Slip list ──────────────────────────────────────────────────────────
    // Keeps the current list on screen (and tappable) until the new result
    // arrives, and drops responses that a newer search/filter has overtaken.
    var listSeq = 0;
    async function loadSlips(reset) {
        var seq = ++listSeq;
        var params = new URLSearchParams({ status: state.status, limit: PAGE_SIZE, offset: reset ? 0 : state.offset });
        if (state.search) params.set('q', state.search);
        try {
            var data = await request(API + '?' + params.toString());
            if (seq !== listSeq) return;
            state.slips = reset ? data.slips : state.slips.concat(data.slips);
            state.total = data.total;
            state.offset = state.slips.length;
            renderList();
        } catch (e) {
            if (e.status !== 401) toast(e.message, true);
        }
    }

    function renderList() {
        var el = $('slipList');
        if (!state.slips.length) {
            el.innerHTML = '<div class="empty-state">' +
                (state.search ? 'No slips match your search.' : (state.status === 'hidden' ? 'No hidden slips.' : 'No slips yet. Take a photo to start.')) +
                '</div>';
        } else {
            el.innerHTML = state.slips.map(function (s) {
                var isPdf = s.content_type === 'application/pdf';
                var title = s.supplier_name || s.original_filename || ('Slip #' + s.id);
                var subParts = [];
                subParts.push(s.slip_date ? fmtDate(s.slip_date) : 'Uploaded ' + fmtDate(s.created_at));
                if (s.category) subParts.push(s.category);
                if (s.uploaded_by_name) subParts.push(s.uploaded_by_name);
                var amount = s.amount !== null && s.amount !== undefined
                    ? '<div class="slip-amount">' + esc(fmtAmount(s.amount)) + '</div>'
                    : '<div class="slip-amount missing">add details</div>';
                return '<button type="button" class="slip-card' + (s.status === 'hidden' ? ' hidden-slip' : '') + '" data-id="' + s.id + '">' +
                    '<div class="slip-type">' + (isPdf ? '&#128196;' : '&#129534;') + '</div>' +
                    '<div class="slip-main"><div class="slip-title">' + esc(title) + '</div>' +
                    '<div class="slip-sub">' + esc(subParts.join(' · ')) + (s.status === 'hidden' ? ' · hidden' : '') + '</div></div>' +
                    amount + '</button>';
            }).join('');
            Array.prototype.forEach.call(el.querySelectorAll('.slip-card'), function (node) {
                node.addEventListener('click', function () {
                    var s = state.slips.find(function (x) { return String(x.id) === node.getAttribute('data-id'); });
                    if (s) openSheet(s);
                });
            });
        }
        $('loadMoreBtn').hidden = state.slips.length >= state.total;

        // Supplier suggestions from what's loaded (memory only).
        var seen = {};
        $('supplierSuggestions').innerHTML = state.slips
            .map(function (s) { return s.supplier_name; })
            .filter(function (n) { if (!n || seen[n.toLowerCase()]) return false; seen[n.toLowerCase()] = true; return true; })
            .slice(0, 50)
            .map(function (n) { return '<option value="' + esc(n) + '">'; })
            .join('');
    }

    function upsertSlipInList(slip) {
        var i = state.slips.findIndex(function (x) { return x.id === slip.id; });
        var matchesFilter = state.status === 'all' || slip.status === state.status;
        if (i >= 0) {
            if (matchesFilter) state.slips[i] = slip;
            else { state.slips.splice(i, 1); state.total = Math.max(0, state.total - 1); state.offset = state.slips.length; }
        } else if (matchesFilter && !state.search) {
            state.slips.unshift(slip);
            state.total += 1;
            state.offset = state.slips.length;
        }
        renderList();
    }

    // ── Upload ─────────────────────────────────────────────────────────────
    function loadImage(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
            img.src = url;
        });
    }

    // Downscale big JPEG/PNG/WEBP photos. HEIC/PDF and anything that fails
    // to decode are uploaded untouched. Never makes a file bigger.
    async function prepareFile(file) {
        var compressible = /^image\/(jpeg|png|webp)$/.test(file.type);
        if (!compressible || file.size <= COMPRESS_OVER_BYTES) return file;
        try {
            var img = await loadImage(file);
            var scale = Math.min(1, MAX_EDGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
            var w = Math.round(img.naturalWidth * scale);
            var h = Math.round(img.naturalHeight * scale);
            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            var blob = await new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY); });
            if (!blob || blob.size >= file.size) return file;
            var base = (file.name || 'slip').replace(/\.[^.]+$/, '');
            return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
        } catch (e) {
            return file;
        }
    }

    function queueFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        files.forEach(function (f) {
            var item = { id: Math.random().toString(36).slice(2), file: f, name: f.name || 'photo', status: 'waiting', error: null, slip: null };
            state.queue.push(item);
        });
        renderQueue();
        runQueue(files.length === 1);
    }

    var queueRunning = false;
    async function runQueue(openAfterSingle) {
        if (queueRunning) return;
        queueRunning = true;
        var lastDone = null;
        var doneCount = 0;
        try {
            for (var i = 0; i < state.queue.length; i++) {
                var item = state.queue[i];
                if (item.status !== 'waiting') continue;
                await uploadOne(item);
                if (item.status === 'done') { lastDone = item; doneCount++; }
            }
        } finally {
            queueRunning = false;
        }
        // Clear finished rows after a moment; failed rows stay for retry.
        setTimeout(function () {
            state.queue = state.queue.filter(function (q) { return q.status !== 'done'; });
            renderQueue();
        }, 2500);
        if (openAfterSingle && doneCount === 1 && lastDone && lastDone.slip) openSheet(lastDone.slip);
    }

    async function uploadOne(item) {
        item.status = 'preparing'; renderQueue();
        var file = await prepareFile(item.file);
        item.status = 'uploading'; renderQueue();
        var fd = new FormData();
        fd.append('file', file, file.name || 'slip.jpg');
        try {
            var data = await request(API + '/upload', { method: 'POST', body: fd });
            item.status = 'done';
            item.slip = data.slip;
            upsertSlipInList(data.slip);
        } catch (e) {
            if (e.status === 409 && e.body && e.body.code === 'DUPLICATE_SLIP') {
                item.status = 'duplicate';
                item.error = 'Already uploaded';
            } else {
                item.status = 'failed';
                item.error = e.message;
            }
        }
        renderQueue();
    }

    function renderQueue() {
        var labels = { waiting: 'Waiting…', preparing: 'Preparing…', uploading: 'Uploading…', done: '✓ Saved online', failed: 'Failed', duplicate: 'Already uploaded' };
        $('uploadQueue').innerHTML = state.queue.map(function (q) {
            var cls = q.status === 'done' ? ' done' : (q.status === 'failed' || q.status === 'duplicate' ? ' failed' : '');
            var actions = '';
            if (q.status === 'failed') actions += ' <button type="button" class="btn btn-sm" data-retry="' + q.id + '">Retry</button>';
            if (q.status === 'failed' || q.status === 'duplicate') actions += ' <button type="button" class="btn btn-sm" data-dismiss="' + q.id + '">✕</button>';
            return '<div class="upload-item' + cls + '"><span class="name">' + esc(q.name) + '</span>' +
                '<span class="state">' + esc(labels[q.status] || q.status) + (q.error && q.status === 'failed' ? ': ' + esc(q.error) : '') + actions + '</span></div>';
        }).join('');
        Array.prototype.forEach.call($('uploadQueue').querySelectorAll('[data-retry]'), function (b) {
            b.addEventListener('click', function () {
                var q = state.queue.find(function (x) { return x.id === b.getAttribute('data-retry'); });
                if (q) { q.status = 'waiting'; q.error = null; renderQueue(); runQueue(false); }
            });
        });
        Array.prototype.forEach.call($('uploadQueue').querySelectorAll('[data-dismiss]'), function (b) {
            b.addEventListener('click', function () {
                state.queue = state.queue.filter(function (x) { return x.id !== b.getAttribute('data-dismiss'); });
                renderQueue();
            });
        });
    }

    // ── Detail sheet ───────────────────────────────────────────────────────
    async function openSheet(slip) {
        state.current = slip;
        $('sheetTitle').textContent = slip.supplier_name || ('Slip #' + slip.id);
        var f = $('detailForm');
        f.slip_date.value = slip.slip_date || '';
        f.amount.value = slip.amount !== null && slip.amount !== undefined ? Number(slip.amount).toFixed(2) : '';
        f.supplier_name.value = slip.supplier_name || '';
        f.category.value = slip.category || '';
        f.note.value = slip.note || '';
        $('hideBtn').textContent = slip.status === 'hidden' ? 'Restore' : 'Hide';
        $('hideBtn').className = slip.status === 'hidden' ? 'btn' : 'btn btn-danger';
        renderMeta(slip);
        $('sheetPreview').innerHTML = '<div class="muted small">Loading preview…</div>';
        $('sheet').hidden = false;

        try {
            var data = await request(API + '/' + slip.id + '/file');
            if (state.current !== slip) return;
            if (slip.content_type === 'application/pdf') {
                $('sheetPreview').innerHTML = '<div class="pdf-box">&#128196; PDF document<br><br>' +
                    '<a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(data.url) + '">Open PDF</a></div>';
            } else if (/heic|heif/.test(slip.content_type)) {
                $('sheetPreview').innerHTML = '<div class="pdf-box">HEIC photo (this browser may not preview it)<br><br>' +
                    '<a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(data.url) + '">Open original</a></div>';
            } else {
                $('sheetPreview').innerHTML = '<a target="_blank" rel="noopener" href="' + esc(data.url) + '">' +
                    '<img alt="Slip photo" src="' + esc(data.url) + '"></a>';
            }
        } catch (e) {
            if (e.status !== 401) $('sheetPreview').innerHTML = '<div class="error-text">Could not load the file: ' + esc(e.message) + '</div>';
        }
    }

    function renderMeta(slip) {
        $('sheetMeta').innerHTML =
            'Uploaded ' + esc(fmtDateTime(slip.created_at)) + (slip.uploaded_by_name ? ' by ' + esc(slip.uploaded_by_name) : '') + '<br>' +
            'File: ' + esc(slip.original_filename || '—') + ' (' + esc(fmtSize(slip.file_size_bytes)) + ')<br>' +
            'Kept online until at least ' + esc(fmtDate(slip.retain_until)) + '<br>' +
            (slip.status === 'hidden' ? 'Hidden ' + esc(fmtDateTime(slip.hidden_at)) + (slip.hidden_reason ? ' — ' + esc(slip.hidden_reason) : '') + '<br>' : '') +
            'Fingerprint (SHA-256): ' + esc(slip.sha256);
    }

    function closeSheet() {
        $('sheet').hidden = true;
        $('sheetPreview').innerHTML = '';
        state.current = null;
    }

    async function saveDetails(ev) {
        ev.preventDefault();
        if (!state.current) return;
        var f = $('detailForm');
        var btn = f.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            var data = await request(API + '/' + state.current.id, {
                method: 'PATCH',
                json: {
                    slip_date: f.slip_date.value,
                    amount: f.amount.value,
                    supplier_name: f.supplier_name.value,
                    category: f.category.value,
                    note: f.note.value
                }
            });
            upsertSlipInList(data.slip);
            toast('Details saved');
            closeSheet();
        } catch (e) {
            if (e.status !== 401) toast(e.message, true);
        } finally {
            btn.disabled = false;
        }
    }

    async function toggleHidden() {
        var slip = state.current;
        if (!slip) return;
        var hiding = slip.status !== 'hidden';
        var body = {};
        if (hiding) {
            var reason = window.prompt('Hide this slip? It stays stored online (7-year retention) and can be restored.\n\nReason (optional):', '');
            if (reason === null) return;
            body.reason = reason;
        }
        try {
            var data = await request(API + '/' + slip.id + (hiding ? '/hide' : '/restore'), { method: 'POST', json: body });
            upsertSlipInList(data.slip);
            toast(hiding ? 'Slip hidden' : 'Slip restored');
            closeSheet();
        } catch (e) {
            if (e.status !== 401) toast(e.message, true);
        }
    }

    // ── Wiring ─────────────────────────────────────────────────────────────
    function debounce(fn, ms) {
        var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }

    function wire() {
        $('loginForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            var btn = f.querySelector('button');
            btn.disabled = true;
            $('loginError').hidden = true;
            try {
                var data = await request(AUTH + '/login', {
                    method: 'POST', token: '', allow401: true,
                    json: { username: f.username.value.trim(), password: f.password.value }
                });
                f.password.value = '';
                await handleLoginResponse(data);
            } catch (e) {
                loginError(e.status === 401 ? 'Incorrect email/username or password.' : e.message);
            } finally {
                btn.disabled = false;
            }
        });

        $('twoFactorForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            try {
                var data = await request(AUTH + '/2fa/login-verify', {
                    method: 'POST', token: '', allow401: true,
                    json: { pendingToken: state.pendingLogin && state.pendingLogin.pendingToken, code: f.code.value.trim() }
                });
                f.code.value = '';
                await handleLoginResponse(data);
            } catch (e) {
                loginError(e.message);
            }
        });

        $('cameraInput').addEventListener('change', function (ev) { queueFiles(ev.target.files); ev.target.value = ''; });
        $('fileInput').addEventListener('change', function (ev) { queueFiles(ev.target.files); ev.target.value = ''; });

        $('searchInput').addEventListener('input', debounce(function () {
            state.search = $('searchInput').value.trim();
            loadSlips(true);
        }, 350));
        $('statusFilter').addEventListener('change', function () {
            state.status = $('statusFilter').value;
            loadSlips(true);
        });
        $('loadMoreBtn').addEventListener('click', function () { loadSlips(false); });

        $('sheetClose').addEventListener('click', closeSheet);
        $('sheet').addEventListener('click', function (ev) { if (ev.target === $('sheet')) closeSheet(); });
        $('detailForm').addEventListener('submit', saveDetails);
        $('hideBtn').addEventListener('click', toggleHidden);

        $('switchCompanyBtn').addEventListener('click', offerCompanySwitch);
        $('logoutBtn').addEventListener('click', async function () {
            var t = token();
            clearToken();
            if (t) { try { await fetch(AUTH + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }); } catch (e) { /* ignore */ } }
            state.slips = []; state.queue = [];
            renderQueue();
            showLogin('');
        });

        window.addEventListener('beforeunload', function (ev) {
            var busy = state.queue.some(function (q) { return q.status === 'uploading' || q.status === 'preparing' || q.status === 'waiting' || q.status === 'failed'; });
            if (busy) { ev.preventDefault(); ev.returnValue = ''; }
        });
    }

    // ── Boot ───────────────────────────────────────────────────────────────
    wire();
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/slips/service-worker.js', { scope: '/slips/' }).catch(function () { /* app works without it */ });
    }
    if (token()) showApp(); else showLogin('');
})();
