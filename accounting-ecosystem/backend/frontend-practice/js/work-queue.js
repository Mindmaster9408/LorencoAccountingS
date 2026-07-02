/* Codebox 55 — Practice Work Queue + Personal Work Hub
 * "What must I work on next?" — every employee's operational home page.
 * NOT AI. NOT auto-assignment. Aggregates, never replaces, source modules.
 * Prefix: wq
 */
(function () {
    'use strict';

    var BASE = '/api/practice/work-queue';
    var NOTIF_BASE = '/api/practice/notifications';
    var _view = 'my_work';
    var _preferences = null;
    var _collapsed = {};

    // Codebox 56 (Planning Board) deep-links here with ?team_member_id=X so a
    // manager can browse a specific employee's queue read-only. Only applied
    // to the queue-item GET calls below — preferences and notifications
    // always stay scoped to whoever is actually logged in, so "viewing"
    // someone's queue can never mutate their settings or their notifications.
    // The backend independently re-validates the caller is manager-level
    // before honouring this param — a non-manager passing it is a no-op.
    function _viewAsParam() {
        var id = new URLSearchParams(window.location.search).get('team_member_id');
        return id ? ('team_member_id=' + encodeURIComponent(id)) : '';
    }
    function _withViewAs(qs) {
        var v = _viewAsParam();
        if (!v) return qs;
        return qs ? (qs + '&' + v) : ('?' + v);
    }

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : null; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    function _logEvent(eventType, sourceModule, sourceType, sourceId, notes, meta) {
        window.PracticeAPI.fetch(BASE + '/events', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_type: eventType, source_module: sourceModule || null, source_type: sourceType || null, source_id: sourceId || null, notes: notes || null, metadata: meta || {} }),
        }).catch(function () {});
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function wqLoadAll() {
        _loadPreferences().then(function () {
            _loadSummary();
            _loadQueue();
            _loadNotifications();
            _loadWaitingOnMe();
            _loadWaitingOnOthers();
            _loadCompleted();
        });
        _logEvent('page_opened');
    }

    function _loadPreferences() {
        return window.PracticeAPI.fetch(BASE + '/preferences')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _preferences = d.preferences || {};
                (_preferences.collapsed_sections || []).forEach(function (k) { _collapsed[k] = true; });
                _applyCollapsedState();
            })
            .catch(function () {});
    }

    function _applyCollapsedState() {
        ['completed', 'waiting_others'].forEach(function (key) {
            var bodyId = key === 'completed' ? 'completedBody' : 'waitingOthersBody';
            var toggleId = key === 'completed' ? 'completedToggle' : 'waitingOthersToggle';
            var body = document.getElementById(bodyId);
            var toggle = document.getElementById(toggleId);
            if (!body) return;
            body.classList.toggle('collapsed', !!_collapsed[key]);
            if (toggle) toggle.textContent = _collapsed[key] ? '▸' : '▾';
        });
    }

    function wqToggleSection(key) {
        _collapsed[key] = !_collapsed[key];
        _applyCollapsedState();
        var sections = Object.keys(_collapsed).filter(function (k) { return _collapsed[k]; });
        window.PracticeAPI.fetch(BASE + '/preferences', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, _preferences, { collapsed_sections: sections })),
        }).catch(function () {});
    }

    // ── Summary / Greeting / Focus Strip ────────────────────────────────────────

    function _greetingWord() {
        var h = new Date().getHours();
        return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary' + _withViewAs(''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.unlinked) {
                    document.getElementById('greeting').textContent = 'My Work';
                    document.getElementById('greetingSub').textContent = d.message || 'Your login is not linked to a Practice team member yet.';
                    document.getElementById('focusStrip').innerHTML = '';
                    return;
                }
                var viewingAs = !!_viewAsParam();
                document.getElementById('greeting').textContent = viewingAs
                    ? ('Viewing ' + (d.team_member_name || 'this team member') + '’s queue')
                    : (_greetingWord() + (d.team_member_name ? ', ' + d.team_member_name.split(' ')[0] : '') + '.');
                document.getElementById('greetingSub').textContent = viewingAs
                    ? 'Read-only manager view — opened from the Planning Board.'
                    : 'Here is what needs your attention today.';

                var c = d.counts || {};
                var cards = [
                    { key: 'my_work', count: c.my_work || 0, label: 'My Work', cls: '' },
                    { key: 'today', count: c.today || 0, label: 'Today', cls: '' },
                    { key: 'overdue', count: c.overdue || 0, label: 'Overdue', cls: 'fc-overdue' },
                    { key: 'upcoming', count: c.upcoming || 0, label: 'Upcoming', cls: '' },
                    { key: null, count: c.waiting_on_me || 0, label: 'Waiting On Me', cls: 'fc-waiting' },
                    { key: null, count: c.notifications_unread || 0, label: 'Notifications', cls: 'fc-waiting' },
                ];
                document.getElementById('focusStrip').innerHTML = cards.map(function (card) {
                    var onclick = card.key ? ' onclick="wqSetView(\'' + card.key + '\')"' : '';
                    var active = card.key === _view ? ' active' : '';
                    return '<div class="focus-card ' + card.cls + active + '"' + onclick + '><div class="fc-count">' + card.count + '</div><div class="fc-label">' + _html(card.label) + '</div></div>';
                }).join('');

                document.getElementById('highestPriorityBody').innerHTML = (d.top_priority || []).length
                    ? d.top_priority.map(_renderItem).join('')
                    : '<div class="empty-state">Nothing urgent — nice work.</div>';
            })
            .catch(function () {});
    }

    // ── My Queue ──────────────────────────────────────────────────────────────

    function wqSetView(view) {
        _view = view;
        document.querySelectorAll('.chip[data-view]').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-view') === view); });
        _logEvent('queue_filtered', null, null, null, null, { view: view });
        _loadQueue();
    }

    function wqApplyFilters() {
        _logEvent('queue_filtered', null, null, null, null, { view: _view, search: document.getElementById('wqSearch').value });
        _loadQueue();
    }

    var VIEW_ENDPOINTS = { my_work: 'my-work', today: 'today', overdue: 'overdue', upcoming: 'upcoming' };

    function _loadQueue() {
        var body = document.getElementById('myQueueBody');
        body.innerHTML = '<div class="empty-state">Loading…</div>';
        var search = document.getElementById('wqSearch').value.trim();
        var qs = search ? ('?search=' + encodeURIComponent(search)) : '';
        window.PracticeAPI.fetch(BASE + '/' + (VIEW_ENDPOINTS[_view] || 'my-work') + _withViewAs(qs))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var items = d.items || [];
                document.getElementById('myQueueCount').textContent = items.length;
                body.innerHTML = items.length ? items.map(_renderItem).join('') : '<div class="empty-state">Nothing here right now.</div>';
            })
            .catch(function () { body.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    function _loadWaitingOnMe() {
        window.PracticeAPI.fetch(BASE + '/waiting-on-me' + _withViewAs(''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var items = d.items || [];
                document.getElementById('waitingMeCount').textContent = items.length;
                document.getElementById('waitingMeBody').innerHTML = items.length ? items.map(_renderItem).join('') : '<div class="empty-state">Nothing waiting on you.</div>';
            })
            .catch(function () {});
    }

    function _loadWaitingOnOthers() {
        window.PracticeAPI.fetch(BASE + '/waiting-on-others' + _withViewAs(''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var items = d.items || [];
                document.getElementById('waitingOthersCount').textContent = items.length;
                document.getElementById('waitingOthersBody').innerHTML = items.length ? items.map(_renderItem).join('') : '<div class="empty-state">Nothing waiting on others.</div>';
            })
            .catch(function () {});
    }

    // Codebox 58 — Work Hub items map fairly directly onto delegation.js's
    // SOURCE_REGISTRY keys, with two exceptions: 'qms' here covers both
    // reviews and findings (split via source_type there), and
    // 'communications' has no delegation support at all (not in the
    // spec's Supported Source Types list) — returns null so the Delegate
    // button is hidden rather than linking to an unsupported source.
    function _delegationModule(item) {
        if (item.source_module === 'qms') return item.source_type === 'practice_quality_finding' ? 'qms-finding' : 'qms-review';
        if (item.source_module === 'communications') return null;
        return item.source_module;
    }

    function _renderItem(item) {
        var meta = [];
        if (item.client_name) meta.push(_html(item.client_name));
        meta.push(_html(item.source_module));
        var due = _fmtDate(item.due_date);
        if (due) meta.push('Due ' + due);
        var label = item.priority_label || 'low';
        var delegateModule = _delegationModule(item);
        var delegateBtn = delegateModule
            ? '<button class="wi-open" style="background:#805ad5;margin-left:6px;" onclick="event.stopPropagation();window.location.href=\'/practice/delegation.html?delegate=1&source_module=' + delegateModule + '&source_id=' + item.source_id + '&role=' + encodeURIComponent(item.role) + '\'">Delegate</button>'
            : '';
        return '<div class="work-item pr-' + _html(label) + '" onclick="wqOpenItem(\'' + item.source_module + '\',\'' + item.source_type + '\',' + item.source_id + ',\'' + _html(item.deep_link) + '\')">' +
            '<div class="wi-body">' +
            '<div class="wi-title-row"><span class="wi-title">' + _html(item.title) + '</span><span class="pill pr-pill-' + _html(label) + '">' + _html(label) + '</span></div>' +
            '<div class="wi-reason">' + _html(item.reason) + '</div>' +
            '<div class="wi-meta">' + meta.join(' · ') + '</div>' +
            '</div>' +
            '<button class="wi-open" onclick="event.stopPropagation();wqOpenItem(\'' + item.source_module + '\',\'' + item.source_type + '\',' + item.source_id + ',\'' + _html(item.deep_link) + '\')">Open →</button>' +
            delegateBtn +
            '</div>';
    }

    function wqOpenItem(sourceModule, sourceType, sourceId, deepLink) {
        _logEvent('item_opened', sourceModule, sourceType, sourceId);
        window.location.href = deepLink;
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    function _loadNotifications() {
        window.PracticeAPI.fetch(BASE + '/notifications?limit=10')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var items = d.notifications || [];
                document.getElementById('notifCount').textContent = items.length;
                document.getElementById('notifBody').innerHTML = items.length ? items.map(_renderNotification).join('') : '<div class="empty-state">No notifications.</div>';
            })
            .catch(function () {});
    }

    function _renderNotification(n) {
        var sev = n.severity || 'info';
        return '<div class="notif-row" onclick="wqOpenNotification(' + n.id + ')">' +
            '<div class="notif-title"><span class="pill sev-' + _html(sev) + '">' + _html(sev) + '</span> ' + _html(n.title) + '</div>' +
            (n.message ? '<div class="notif-msg">' + _html(n.message) + '</div>' : '') +
            '</div>';
    }

    function wqOpenNotification(id) {
        window.PracticeAPI.fetch(NOTIF_BASE + '/' + id + '/read', { method: 'PUT' })
            .then(function () {
                _logEvent('item_opened', 'notifications', 'practice_notification', id);
                window.location.href = '/practice/notifications.html';
            })
            .catch(function () { window.location.href = '/practice/notifications.html'; });
    }

    // ── Completed ─────────────────────────────────────────────────────────────

    function _loadCompleted() {
        window.PracticeAPI.fetch(BASE + '/completed' + _withViewAs(''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var items = d.items || [];
                document.getElementById('completedCount').textContent = items.length;
                document.getElementById('completedBody').innerHTML = items.length
                    ? items.map(function (i) {
                        return '<div class="completed-row"><span class="completed-title">' + _html(i.title) + (i.client_name ? ' — ' + _html(i.client_name) : '') + '</span><span class="completed-time">' + _fmt(i.completed_at) + '</span></div>';
                    }).join('')
                    : '<div class="empty-state">Nothing completed in the last 14 days.</div>';
            })
            .catch(function () {});
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.wqLoadAll = wqLoadAll;
    window.wqSetView = wqSetView;
    window.wqApplyFilters = wqApplyFilters;
    window.wqToggleSection = wqToggleSection;
    window.wqOpenItem = wqOpenItem;
    window.wqOpenNotification = wqOpenNotification;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        wqLoadAll();
    });

}());
