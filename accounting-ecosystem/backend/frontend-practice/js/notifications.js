/* Codebox 54 — Practice Notification Centre + Internal Notification Routing
 * Internal only. NOT email/SMS/push/Teams/Sean AI. Prefix: nt
 */
(function () {
    'use strict';

    var BASE = '/api/practice/notifications';
    var _notifications = [];
    var _selected = {};
    var _quickFilter = ''; // '', 'unread', 'due_today', 'overdue', 'assigned_to_me'
    var _currentId = null;
    var _currentNotification = null;

    var CATEGORY_LABELS = {
        risk: 'Risk', tax: 'Tax', billing: 'Billing', workflow: 'Workflow', capacity: 'Capacity',
        client: 'Client', documents: 'Documents', compliance: 'Compliance', qms: 'QMS',
        knowledge: 'Knowledge', sop: 'SOP', communication: 'Communication', system: 'System',
    };
    var STATUS_LABELS = { new: 'New', read: 'Read', snoozed: 'Snoozed', completed: 'Completed', archived: 'Archived', cancelled: 'Cancelled' };
    var SEVERITY_LABELS = { info: 'Info', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
    var EV_LABELS = {
        notification_created: 'Created', notification_read: 'Marked Read', notification_unread: 'Marked Unread',
        notification_snoozed: 'Snoozed', notification_completed: 'Completed',
        notification_archived: 'Archived', notification_cancelled: 'Cancelled',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _sevPill(s) { return '<span class="pill sev-' + _html(s) + '">' + _html(SEVERITY_LABELS[s] || s) + '</span>'; }
    function _statusPill(s) { return '<span class="pill st-pill-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function ntLoadAll() {
        _loadSummary();
        ntLoadList();
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {});
    }

    function _renderSummary(d) {
        var grid = document.getElementById('summaryGrid');
        var cards = [
            { key: '', count: d.total || 0, label: 'Total' },
            { key: 'unread', count: d.unread_count || 0, label: 'Unread' },
            { key: 'assigned_to_me', count: d.assigned_to_me_count || 0, label: 'Assigned To Me' },
            { key: 'due_today', count: d.due_today_count || 0, label: 'Due Today' },
            { key: 'overdue', count: d.overdue_count || 0, label: 'Overdue' },
            { key: '', count: (d.by_severity && d.by_severity.critical) || 0, label: 'Critical' },
        ];
        grid.innerHTML = cards.map(function (c) {
            var active = c.key && c.key === _quickFilter;
            var onclick = c.key ? ' onclick="ntSetQuickFilter(\'' + c.key + '\')"' : '';
            return '<div class="summary-card' + (active ? ' active' : '') + '"' + onclick + '><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
        }).join('');
    }

    function ntSetQuickFilter(key) {
        _quickFilter = (_quickFilter === key) ? '' : key;
        ntLoadList();
        _loadSummary();
    }

    // ── Filters ───────────────────────────────────────────────────────────────

    function ntClearFilters() {
        document.getElementById('filterStatus').value = '';
        document.getElementById('filterCategory').value = '';
        document.getElementById('filterSeverity').value = '';
        _quickFilter = '';
        ntLoadList();
        _loadSummary();
    }

    function _qs() {
        var p = [];
        var status = document.getElementById('filterStatus').value;
        var category = document.getElementById('filterCategory').value;
        var severity = document.getElementById('filterSeverity').value;
        if (status) p.push('status=' + encodeURIComponent(status));
        if (category) p.push('category=' + encodeURIComponent(category));
        if (severity) p.push('severity=' + encodeURIComponent(severity));
        if (_quickFilter === 'unread') p.push('unread=true');
        if (_quickFilter === 'due_today') p.push('due_today=true');
        if (_quickFilter === 'overdue') p.push('overdue=true');
        if (_quickFilter === 'assigned_to_me') p.push('assigned_to_me=true');
        p.push('limit=100');
        return '?' + p.join('&');
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function ntLoadList() {
        var list = document.getElementById('inboxList');
        list.innerHTML = '<div class="empty-state">Loading…</div>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _notifications = d.notifications || [];
                _selected = {};
                _renderList();
                _renderBulkBar();
            })
            .catch(function () { list.innerHTML = '<div class="empty-state">Failed to load notifications.</div>'; });
    }

    function _renderList() {
        var list = document.getElementById('inboxList');
        if (!_notifications.length) {
            list.innerHTML = '<div class="empty-state">No notifications match your filters.</div>';
            return;
        }
        list.innerHTML = _notifications.map(function (n) {
            var meta = [];
            meta.push(_html(CATEGORY_LABELS[n.category] || n.category));
            if (n.assigned_team_member_name) meta.push('Assigned: ' + _html(n.assigned_team_member_name));
            if (n.due_date) meta.push('Due: ' + _fmtDate(n.due_date));
            if (n.notification_status === 'snoozed' && n.snoozed_until) meta.push('Snoozed until: ' + _fmt(n.snoozed_until));
            meta.push(_fmt(n.created_at));
            return '<div class="notif-row st-' + _html(n.notification_status) + '" onclick="ntOpenDetail(' + n.id + ')">' +
                '<input type="checkbox" class="notif-check" onclick="event.stopPropagation();ntToggleSelect(' + n.id + ')" ' + (_selected[n.id] ? 'checked' : '') + ' />' +
                '<div class="notif-body">' +
                '<div class="notif-title-row"><span class="notif-title">' + _html(n.title) + '</span>' + _sevPill(n.severity) + _statusPill(n.notification_status) + '</div>' +
                (n.message ? '<div class="notif-msg">' + _html(n.message) + '</div>' : '') +
                '<div class="notif-meta">' + meta.join(' · ') + '</div>' +
                '</div></div>';
        }).join('');
    }

    // ── Selection / Bulk ──────────────────────────────────────────────────────

    function ntToggleSelect(id) {
        if (_selected[id]) delete _selected[id]; else _selected[id] = true;
        _renderBulkBar();
    }
    function ntClearSelection() {
        _selected = {};
        _renderList();
        _renderBulkBar();
    }
    function _selectedIds() { return Object.keys(_selected).map(Number); }
    function _renderBulkBar() {
        var ids = _selectedIds();
        var bar = document.getElementById('bulkBar');
        bar.classList.toggle('open', ids.length > 0);
        document.getElementById('bulkCount').textContent = ids.length + ' selected';
    }

    function ntBulk(action) {
        var ids = _selectedIds();
        if (!ids.length) return;
        window.PracticeAPI.fetch(BASE + '/bulk-' + action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _showToast((d.updated || []).length + ' updated' + ((d.skipped || []).length ? ', ' + d.skipped.length + ' skipped' : '') + '.');
                ntClearSelection();
                ntLoadAll();
            })
            .catch(function () { _showToast('Bulk action failed.'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function ntOpenDetail(id) {
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentId = id;
                _currentNotification = d.notification;
                document.getElementById('detailModal').classList.add('open');
                _renderDetail();
                return window.PracticeAPI.fetch(BASE + '/' + id + '/events');
            })
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEvents(d.events || []); })
            .catch(function () { _showToast('Failed to load notification.'); });
    }
    function ntCloseDetail() { document.getElementById('detailModal').classList.remove('open'); _currentId = null; _currentNotification = null; }

    // Codebox 55 integration — "Notifications: Open directly into source
    // records." Same source_module → URL mapping used by work-queue.js's
    // aggregator, kept in sync manually since the two files don't share code.
    var SOURCE_DEEP_LINKS = {
        'tasks': '/practice/tasks.html?open=',
        'deadlines': '/practice/deadlines.html?open=',
        'reminders': '/practice/reminders.html?open=',
        'risk-register': '/practice/risk-register.html?open=',
        'qms': '/practice/quality-management.html?open=',
        'compliance-packs': '/practice/compliance-packs.html?open=',
        'document-requests': '/practice/document-requests.html?open=',
        'communications': '/practice/communications.html?open=',
        'tax-individual': '/practice/individual-tax.html?open=',
        'tax-company': '/practice/company-tax.html?open=',
    };
    function _deepLinkFor(n) {
        var base = SOURCE_DEEP_LINKS[n.source_module];
        return base && n.source_id ? (base + n.source_id) : null;
    }

    function _renderDetail() {
        var n = _currentNotification;
        document.getElementById('detailBody').innerHTML =
            '<div class="modal-title">' + _html(n.title) + '</div>' +
            '<div style="margin-bottom:12px;">' + _sevPill(n.severity) + ' ' + _statusPill(n.notification_status) + ' <span class="pill" style="background:rgba(255,255,255,.05);color:#a0aec0;">' + _html(CATEGORY_LABELS[n.category] || n.category) + '</span></div>' +
            (n.message ? '<div style="font-size:.85rem;color:#cbd5e0;margin-bottom:12px;">' + _html(n.message) + '</div>' : '') +
            '<div style="font-size:.78rem;color:#718096;line-height:1.8;">' +
            'Assigned: ' + _html(n.assigned_team_member_id ? ('Team member #' + n.assigned_team_member_id) : 'Unassigned') + '<br/>' +
            'Due: ' + _fmtDate(n.due_date) + '<br/>' +
            (n.source_module ? ('Source: ' + _html(n.source_module) + (n.source_type ? ' (' + _html(n.source_type) + (n.source_id ? ' #' + n.source_id : '') + ')' : '')) + '<br/>' : '') +
            'Created: ' + _fmt(n.created_at) +
            '</div>';

        var footer = document.getElementById('detailFooter');
        var btns = [];
        var deepLink = _deepLinkFor(n);
        if (deepLink) btns.push('<button class="btn-action btn-primary" onclick="window.location.href=\'' + deepLink + '\'">Open Source Record →</button>');
        if (n.notification_status === 'new') btns.push('<button class="btn-action btn-secondary" onclick="ntAction(\'read\')">Mark Read</button>');
        if (n.notification_status === 'read') btns.push('<button class="btn-action btn-secondary" onclick="ntAction(\'unread\')">Mark Unread</button>');
        if (['new', 'read', 'snoozed'].indexOf(n.notification_status) !== -1) {
            btns.push('<button class="btn-action btn-warning" onclick="ntOpenSnooze()">Snooze</button>');
            btns.push('<button class="btn-action btn-success" onclick="ntAction(\'complete\')">Complete</button>');
        }
        if (['new', 'read', 'snoozed', 'completed'].indexOf(n.notification_status) !== -1) {
            btns.push('<button class="btn-action btn-secondary" onclick="ntAction(\'archive\')">Archive</button>');
        }
        if (['new', 'read', 'snoozed'].indexOf(n.notification_status) !== -1) {
            btns.push('<button class="btn-action btn-danger" onclick="ntCancel()">Cancel</button>');
        }
        btns.push('<button class="btn-action btn-secondary" onclick="ntCloseDetail()">Close</button>');
        footer.innerHTML = btns.join('');
    }

    function _renderEvents(events) {
        document.getElementById('detailEvents').innerHTML =
            '<div style="font-size:.72rem;color:#718096;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">History</div>' +
            (events.length ? events.map(function (e) {
                return '<div class="event-item"><div class="event-header"><span class="event-type">' + _html(EV_LABELS[e.event_type] || e.event_type) + '</span><span class="event-time">' + _fmt(e.created_at) + '</span></div></div>';
            }).join('') : '<div style="font-size:.8rem;color:#4a5568;">No history yet.</div>');
    }

    function ntAction(action) {
        if (!_currentId) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Notification updated.');
                ntCloseDetail();
                ntLoadAll();
            })
            .catch(function () { _showToast('Failed to update notification.'); });
    }

    function ntCancel() {
        if (!_currentId) return;
        if (!confirm('Cancel this notification?')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Notification cancelled.');
                ntCloseDetail();
                ntLoadAll();
            })
            .catch(function () { _showToast('Failed to cancel notification.'); });
    }

    // ── Snooze ────────────────────────────────────────────────────────────────

    function ntOpenSnooze() {
        document.getElementById('snoozeUntil').value = '';
        document.getElementById('snoozeModal').classList.add('open');
    }
    function ntCloseSnooze() { document.getElementById('snoozeModal').classList.remove('open'); }
    function ntSubmitSnooze() {
        var val = document.getElementById('snoozeUntil').value;
        if (!val) return _showToast('Pick a snooze date/time first.');
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/snooze', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snoozed_until: new Date(val).toISOString() }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Notification snoozed.');
                ntCloseSnooze();
                ntCloseDetail();
                ntLoadAll();
            })
            .catch(function () { _showToast('Failed to snooze notification.'); });
    }

    // ── Create ────────────────────────────────────────────────────────────────

    function ntOpenCreate() {
        document.getElementById('cfTitle').value = '';
        document.getElementById('cfMessage').value = '';
        document.getElementById('cfCategory').value = 'system';
        document.getElementById('cfSeverity').value = 'medium';
        document.getElementById('cfAssignedId').value = '';
        document.getElementById('cfDueDate').value = '';
        document.getElementById('createModal').classList.add('open');
    }
    function ntCloseCreate() { document.getElementById('createModal').classList.remove('open'); }
    function ntSubmitCreate() {
        var title = document.getElementById('cfTitle').value.trim();
        if (!title) return _showToast('Title is required.');
        var payload = {
            title: title,
            message: document.getElementById('cfMessage').value.trim() || null,
            category: document.getElementById('cfCategory').value,
            severity: document.getElementById('cfSeverity').value,
            due_date: document.getElementById('cfDueDate').value.trim() || null,
            source_module: 'manual',
        };
        var assignedId = document.getElementById('cfAssignedId').value.trim();
        if (assignedId) payload.assigned_team_member_id = assignedId;

        window.PracticeAPI.fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(d.deduped ? 'An active notification with this key already exists — reused it.' : 'Notification created.');
                ntCloseCreate();
                ntLoadAll();
            })
            .catch(function () { _showToast('Failed to create notification.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.ntLoadAll = ntLoadAll;
    window.ntLoadList = ntLoadList;
    window.ntClearFilters = ntClearFilters;
    window.ntSetQuickFilter = ntSetQuickFilter;
    window.ntToggleSelect = ntToggleSelect;
    window.ntClearSelection = ntClearSelection;
    window.ntBulk = ntBulk;
    window.ntOpenDetail = ntOpenDetail;
    window.ntCloseDetail = ntCloseDetail;
    window.ntAction = ntAction;
    window.ntCancel = ntCancel;
    window.ntOpenSnooze = ntOpenSnooze;
    window.ntCloseSnooze = ntCloseSnooze;
    window.ntSubmitSnooze = ntSubmitSnooze;
    window.ntOpenCreate = ntOpenCreate;
    window.ntCloseCreate = ntCloseCreate;
    window.ntSubmitCreate = ntSubmitCreate;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        ntLoadAll();
    });

}());
