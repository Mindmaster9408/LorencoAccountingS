/* Codebox 58 — Practice Delegation + Work Reassignment Controls
 * "I moved responsibility safely." NOT AI. NOT automatic reassignment.
 * Prefix: dl
 */
(function () {
    'use strict';

    var BASE = '/api/practice/delegation';
    var TEAM_BASE = '/api/practice/team';
    var _tab = 'all';
    var _teamList = [];
    var _currentId = null;
    var _currentDelegation = null;
    var _detailTab = 'overview';

    // Mirrors delegation.js's SOURCE_REGISTRY roles exactly — kept in sync manually.
    var ROLE_OPTIONS = {
        tasks: ['assignee', 'preparer', 'reviewer', 'approver'],
        deadlines: ['responsible'],
        'risk-register': ['owner'],
        'qms-review': ['reviewer'],
        'qms-finding': ['responsible'],
        'tax-individual': ['preparer', 'reviewer'],
        'tax-company': ['preparer', 'reviewer'],
        'compliance-packs': ['owner', 'reviewer'],
        'document-requests': ['assignee'],
        reminders: ['assignee'],
    };
    var MODULE_LABELS = {
        tasks: 'Task', deadlines: 'Deadline', 'risk-register': 'Risk', 'qms-review': 'QMS Review', 'qms-finding': 'QMS Finding',
        'tax-individual': 'Individual Tax Return', 'tax-company': 'Company Tax Return', 'compliance-packs': 'Compliance Pack',
        'document-requests': 'Document Request', reminders: 'Reminder',
    };
    var STATUS_LABELS = { draft: 'Draft', delegated: 'Pending Acceptance', accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', completed: 'Completed' };
    var EV_LABELS = {
        delegation_created: 'Delegated', delegation_accepted: 'Accepted', delegation_declined: 'Declined',
        delegation_cancelled: 'Cancelled', delegation_completed: 'Completed', ownership_changed: 'Ownership Changed',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _statusPill(s) { return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function dlLoadAll() {
        _loadSummary();
        dlLoadList();
        _loadTeam();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('delegate') === '1') {
            dlOpenCreate();
            if (params.get('source_module')) document.getElementById('cfModule').value = params.get('source_module');
            dlModuleChanged();
            if (params.get('source_id')) document.getElementById('cfSourceId').value = params.get('source_id');
            if (params.get('role')) document.getElementById('cfRole').value = params.get('role');
        }
    }

    // ── Summary / Tabs ────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.total || 0, label: 'Total', tab: 'all' },
                    { count: d.pending_acceptance || 0, label: 'Pending Acceptance', tab: 'pending' },
                    { count: d.awaiting_my_response || 0, label: 'Awaiting My Response', tab: 'mine' },
                    { count: (d.by_status && d.by_status.accepted) || 0, label: 'Accepted', tab: 'accepted' },
                    { count: (d.by_status && d.by_status.completed) || 0, label: 'Completed', tab: 'completed' },
                    { count: ((d.by_status && d.by_status.declined) || 0) + ((d.by_status && d.by_status.cancelled) || 0), label: 'History', tab: 'history' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card' + (c.tab === _tab ? ' active' : '') + '" onclick="dlSetTab(\'' + c.tab + '\')"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
                _renderTabBar();
            })
            .catch(function () {});
    }

    function _renderTabBar() {
        var tabs = [['all', 'All'], ['pending', 'Pending Acceptance'], ['accepted', 'Accepted'], ['completed', 'Completed'], ['history', 'History']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="dlSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
    }

    function dlSetTab(tab) {
        _tab = tab;
        _renderTabBar();
        dlLoadList();
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function _qs() {
        var p = [];
        var module = document.getElementById('filterModule').value;
        if (module) p.push('source_module=' + encodeURIComponent(module));
        if (_tab === 'pending') p.push('status=delegated');
        else if (_tab === 'accepted') p.push('status=accepted');
        else if (_tab === 'completed') p.push('status=completed');
        else if (_tab === 'mine') p.push('my=true');
        return p.length ? '?' + p.join('&') : '';
    }

    function dlLoadList() {
        var list = document.getElementById('delegationList');
        list.innerHTML = '<div class="empty-state">Loading…</div>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var items = d.delegations || [];
                if (_tab === 'history') items = items.filter(function (x) { return x.delegation_status === 'declined' || x.delegation_status === 'cancelled'; });
                list.innerHTML = items.length ? items.map(_renderRow).join('') : '<div class="empty-state">No delegations here.</div>';
            })
            .catch(function () { list.innerHTML = '<div class="empty-state">Failed to load delegations.</div>'; });
    }

    function _renderRow(d) {
        return '<div class="delegation-row" onclick="dlOpenDetail(' + d.id + ')">' +
            '<div class="dr-title-row"><span class="dr-title">' + _html(MODULE_LABELS[d.source_module] || d.source_module) + ': ' + _html(d.title) + '</span>' + _statusPill(d.delegation_status) + '</div>' +
            '<div class="dr-flow"><b>' + _html(d.previous_owner_name || 'Unassigned') + '</b> → <b>' + _html(d.new_owner_name) + '</b> — ' + _html(d.delegation_reason) + '</div>' +
            '<div class="dr-meta">Delegated by ' + _html(d.delegated_by_name || '—') + ' · ' + _fmt(d.created_at) + '</div>' +
            '</div>';
    }

    // ── Team list ─────────────────────────────────────────────────────────────

    function _loadTeam() {
        window.PracticeAPI.fetch(TEAM_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _teamList = d.members || [];
                var sel = document.getElementById('cfNewOwner');
                sel.innerHTML = '<option value="">Select a team member…</option>' + _teamList.map(function (m) {
                    return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Create ────────────────────────────────────────────────────────────────

    function dlOpenCreate() {
        document.getElementById('cfModule').value = 'tasks';
        dlModuleChanged();
        document.getElementById('cfSourceId').value = '';
        document.getElementById('cfNewOwner').value = '';
        document.getElementById('cfReason').value = '';
        document.getElementById('cfNotes').value = '';
        document.getElementById('cfEffectiveDate').value = '';
        document.getElementById('createErrorBox').innerHTML = '';
        document.getElementById('createAdvisoryBox').innerHTML = '';
        document.getElementById('createModal').classList.add('open');
    }
    function dlCloseCreate() { document.getElementById('createModal').classList.remove('open'); }

    function dlModuleChanged() {
        var module = document.getElementById('cfModule').value;
        var roles = ROLE_OPTIONS[module] || [];
        var sel = document.getElementById('cfRole');
        sel.innerHTML = roles.map(function (r) { return '<option value="' + r + '">' + r.charAt(0).toUpperCase() + r.slice(1) + '</option>'; }).join('');
        document.getElementById('cfRoleGroup').style.display = roles.length > 1 ? '' : 'none';
        document.getElementById('createAdvisoryBox').innerHTML = '';
        dlCheckAdvisory();
    }

    // Codebox 59 — Skills Matrix advisory, fetched live as the create form
    // fills in. Warning only; never disables the Delegate button.
    function dlCheckAdvisory() {
        var box = document.getElementById('createAdvisoryBox');
        var module = document.getElementById('cfModule').value;
        var sourceId = document.getElementById('cfSourceId').value;
        var role = document.getElementById('cfRole').value;
        var newOwnerId = document.getElementById('cfNewOwner').value;
        if (!module || !sourceId) { box.innerHTML = ''; return; }

        var qs = 'source_module=' + encodeURIComponent(module) + '&source_id=' + encodeURIComponent(sourceId) + (role ? '&role=' + encodeURIComponent(role) : '') + (newOwnerId ? '&new_owner_id=' + encodeURIComponent(newOwnerId) : '');
        window.PracticeAPI.fetch('/api/practice/delegation/competency-preview?' + qs)
            .then(function (r) { return r.json(); })
            .then(function (d) { box.innerHTML = _renderAdvisory(d.advisory); })
            .catch(function () { box.innerHTML = ''; });
    }

    function dlSubmitCreate() {
        var payload = {
            source_module: document.getElementById('cfModule').value,
            source_id: document.getElementById('cfSourceId').value,
            role: document.getElementById('cfRole').value || undefined,
            new_owner_id: document.getElementById('cfNewOwner').value,
            delegation_reason: document.getElementById('cfReason').value.trim(),
            delegation_notes: document.getElementById('cfNotes').value.trim() || null,
            effective_date: document.getElementById('cfEffectiveDate').value.trim() || null,
        };
        if (!payload.source_id) return _showToast('Source ID is required.');
        if (!payload.new_owner_id) return _showToast('Choose a new owner.');
        if (!payload.delegation_reason) return _showToast('A reason is required.');

        window.PracticeAPI.fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (res) {
                if (res.body.error) {
                    document.getElementById('createErrorBox').innerHTML = '<div class="inline-msg err">' + _html(res.body.error) + '</div>';
                    return;
                }
                _showToast('Work delegated — the new owner has been notified.');
                dlCloseCreate();
                dlLoadAll();
            })
            .catch(function () { _showToast('Failed to create delegation.'); });
    }

    // ── Detail ────────────────────────────────────────────────────────────────

    function dlOpenDetail(id) {
        _currentId = id;
        _detailTab = 'overview';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentDelegation = d.delegation;
                document.getElementById('detailModal').classList.add('open');
                _renderDetailTabs();
                _renderDetail();
            })
            .catch(function () { _showToast('Failed to load delegation.'); });
    }
    function dlCloseDetail() { document.getElementById('detailModal').classList.remove('open'); _currentId = null; _currentDelegation = null; }

    function _renderDetailTabs() {
        var tabs = [['overview', 'Overview'], ['history', 'History']];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _detailTab ? ' active' : '') + '" onclick="dlOpenDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('') + '<button class="tab-btn" style="margin-left:auto;" onclick="dlCloseDetail()">✕ Close</button>';
    }
    function dlOpenDetailTab(tab) { _detailTab = tab; _renderDetailTabs(); _renderDetail(); }

    function _renderDetail() {
        var d = _currentDelegation;
        var body = document.getElementById('detailBody');
        var footer = document.getElementById('detailFooter');
        if (_detailTab === 'overview') {
            body.innerHTML =
                '<div class="modal-title">' + _html(MODULE_LABELS[d.source_module] || d.source_module) + ': ' + _html(d.title) + '</div>' +
                '<div style="margin-bottom:14px;">' + _statusPill(d.delegation_status) + '</div>' +
                '<div class="detail-grid">' +
                _drow('From', d.previous_owner_name || 'Unassigned') +
                _drow('To', d.new_owner_name) +
                _drow('Delegated By', d.delegated_by_name || '—') +
                _drow('Role', d.ownership_role) +
                _drow('Effective Date', _fmtDate(d.effective_date)) +
                _drow('Created', _fmt(d.created_at)) +
                '</div>' +
                '<div style="font-size:.82rem;margin-bottom:6px;"><b>Reason:</b> ' + _html(d.delegation_reason) + '</div>' +
                (d.delegation_notes ? '<div style="font-size:.82rem;color:#a0aec0;">' + _html(d.delegation_notes) + '</div>' : '') +
                (d.deep_link ? '<div style="margin-top:14px;"><a href="' + d.deep_link + '" style="color:#a3bffa;font-weight:700;">Open Source Record →</a></div>' : '') +
                _renderAdvisory(d.competency_advisory);

            var btns = [];
            if (d.delegation_status === 'delegated') {
                btns.push('<button class="btn-action btn-success" onclick="dlAction(\'accept\')">Accept</button>');
                btns.push('<button class="btn-action btn-danger" onclick="dlAction(\'decline\')">Decline</button>');
                btns.push('<button class="btn-action btn-warning" onclick="dlAction(\'cancel\')">Cancel</button>');
            }
            if (d.delegation_status === 'accepted') {
                btns.push('<button class="btn-action btn-success" onclick="dlAction(\'complete\')">Mark Complete</button>');
                btns.push('<button class="btn-action btn-warning" onclick="dlAction(\'cancel\')">Cancel</button>');
            }
            footer.innerHTML = btns.join('');
        } else {
            window.PracticeAPI.fetch(BASE + '/' + d.id + '/events')
                .then(function (r) { return r.json(); })
                .then(function (evd) {
                    var events = evd.events || [];
                    body.innerHTML = '<div class="modal-title">History</div>' + (events.length ? events.map(function (e) {
                        return '<div class="event-item"><div class="event-header"><span class="event-type">' + _html(EV_LABELS[e.event_type] || e.event_type) + '</span><span class="event-time">' + _fmt(e.created_at) + '</span></div>' +
                            (e.notes ? '<div class="event-notes">' + _html(e.notes) + '</div>' : '') + '</div>';
                    }).join('') : '<div class="empty-state">No history yet.</div>');
                })
                .catch(function () { body.innerHTML = '<div class="empty-state">Failed to load history.</div>'; });
            footer.innerHTML = '';
        }
    }
    function _drow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + _html(label) + '</div><div class="detail-value">' + _html(value) + '</div></div>';
    }

    // Codebox 59 — Skills Matrix advisory. Warning only, never blocks the
    // create/accept flow — this is purely informational rendering.
    function _renderAdvisory(advisory) {
        if (!advisory) return '';
        var prev = advisory.previous_owner, next = advisory.new_owner;
        var rows = '';
        if (prev) rows += '<div style="font-size:.78rem;color:#a0aec0;">Previous owner competency: <b>' + prev.level + (prev.specific_skill_matched ? ' (specific skill)' : ' (overall average)') + '</b></div>';
        if (next) rows += '<div style="font-size:.78rem;color:#a0aec0;">New owner competency: <b>' + next.level + (next.specific_skill_matched ? ' (specific skill)' : ' (overall average)') + '</b></div>';
        return '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #12122a;">' +
            '<div style="font-size:.72rem;color:#718096;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Skills Matrix Advisory</div>' +
            rows + (advisory.warning ? '<div class="inline-msg warn" style="margin-top:8px;margin-bottom:0;">' + _html(advisory.warning) + '</div>' : '') +
            '</div>';
    }

    function dlAction(action) {
        if (!_currentId) return;
        if ((action === 'decline' || action === 'cancel') && !confirm('This will revert ownership back to the previous owner. Continue?')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Delegation ' + action + 'ed.');
                dlCloseDetail();
                dlLoadAll();
            })
            .catch(function () { _showToast('Failed to ' + action + ' delegation.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.dlLoadAll = dlLoadAll;
    window.dlSetTab = dlSetTab;
    window.dlLoadList = dlLoadList;
    window.dlOpenCreate = dlOpenCreate;
    window.dlCloseCreate = dlCloseCreate;
    window.dlModuleChanged = dlModuleChanged;
    window.dlCheckAdvisory = dlCheckAdvisory;
    window.dlSubmitCreate = dlSubmitCreate;
    window.dlOpenDetail = dlOpenDetail;
    window.dlCloseDetail = dlCloseDetail;
    window.dlOpenDetailTab = dlOpenDetailTab;
    window.dlAction = dlAction;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        dlLoadAll();
    });

}());
