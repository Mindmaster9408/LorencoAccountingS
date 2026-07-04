/* Codebox 72 — Practice Engagement Scope Control + Work Authorization Gate
 * "Are we allowed to do this work under the current engagement?" NOT legal
 * advice. NOT billing automation. NOT hard blocking — warns and records.
 * Prefix: wa
 */
(function () {
    'use strict';

    var BASE = '/api/practice/work-authorization';
    var CLIENTS_BASE = '/api/practice/clients';
    var _currentAuthId = null;
    var _pendingReasonAction = null; // 'request-override' | 'reject-override' | 'accept-risk' | 'cancel'

    var STATUS_LABELS = {
        clear: 'Clear', warning: 'Warning', out_of_scope: 'Out of Scope', override_requested: 'Override Requested',
        override_approved: 'Override Approved', override_rejected: 'Override Rejected', accepted_risk: 'Accepted Risk', cancelled: 'Cancelled',
    };
    var SCOPE_LABELS = { in_scope: 'In Scope', possible_gap: 'Possible Gap', out_of_scope: 'Out of Scope', no_active_engagement: 'No Active Engagement', unknown: 'Unknown' };
    var EV_LABELS = {
        authorization_checked: 'Checked', authorization_warning_created: 'Warning Created', override_requested: 'Override Requested',
        override_approved: 'Override Approved', override_rejected: 'Override Rejected', accepted_risk: 'Risk Accepted', authorization_cancelled: 'Cancelled',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function waLoadAll() {
        _loadSummary();
        waLoadList();
        _loadClientPicker();
    }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.authorizations_total || 0, label: 'Authorizations' },
                    { count: d.out_of_scope_work || 0, label: 'Out of Scope' },
                    { count: d.pending_overrides || 0, label: 'Pending Overrides' },
                    { count: d.high_risk_overrides || 0, label: 'High Risk Overrides' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientPicker() {
        window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var clients = d.clients || [];
                document.getElementById('ckClient').innerHTML = clients.map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function waLoadList() {
        var status = document.getElementById('fStatus').value;
        var scopeResult = document.getElementById('fScopeResult').value;
        var workType = document.getElementById('fWorkType').value;
        var qs = [];
        if (status) qs.push('authorization_status=' + status);
        if (scopeResult) qs.push('scope_result=' + scopeResult);
        if (workType) qs.push('work_type=' + workType);
        var url = BASE + '/' + (qs.length ? '?' + qs.join('&') : '');
        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.authorizations || []); })
            .catch(function () { document.getElementById('authorizationsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderList(rows) {
        var el = document.getElementById('authorizationsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="6" class="empty-state">No authorizations recorded yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (a) {
            return '<tr class="row-clickable" onclick="waOpenDetail(' + a.id + ')">' +
                '<td>' + _html(a.client_name || '—') + '</td>' +
                '<td>' + _html(a.work_type) + '</td>' +
                '<td>' + _html(a.source_module) + ' / ' + _html(a.source_type) + '</td>' +
                '<td><span class="pill sr-' + _html(a.scope_result) + '">' + _html(SCOPE_LABELS[a.scope_result] || a.scope_result) + '</span></td>' +
                '<td><span class="pill as-' + _html(a.authorization_status) + '">' + _html(STATUS_LABELS[a.authorization_status] || a.authorization_status) + '</span></td>' +
                '<td><span class="pill risk-' + _html(a.risk_level) + '">' + _html(a.risk_level) + '</span></td>' +
                '</tr>';
        }).join('');
    }

    // ── Check Work ────────────────────────────────────────────────────────────

    function waOpenCheck() {
        document.getElementById('ckWorkType').value = 'accounting';
        document.getElementById('ckRiskLevel').value = '';
        document.getElementById('checkModal').classList.add('open');
    }
    function waCloseCheck() { document.getElementById('checkModal').classList.remove('open'); }
    function waSubmitCheck() {
        var clientId = parseInt(document.getElementById('ckClient').value);
        if (!clientId) { _showToast('Client is required.'); return; }
        var payload = {
            client_id: clientId,
            work_type: document.getElementById('ckWorkType').value,
            source_module: 'work-authorization', source_type: 'manual_check',
            risk_level: document.getElementById('ckRiskLevel').value || undefined,
        };
        window.PracticeAPI.fetch(BASE + '/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(d.recommended_action || 'Check complete.');
                waCloseCheck(); _loadSummary(); waLoadList();
                waOpenDetail(d.authorization.id);
            })
            .catch(function () { _showToast('Failed to check work authorization.'); });
    }

    // ── Detail ────────────────────────────────────────────────────────────────

    function waOpenDetail(id) {
        _currentAuthId = id;
        Promise.all([
            window.PracticeAPI.fetch(BASE + '/' + id).then(function (r) { return r.json(); }),
            window.PracticeAPI.fetch(BASE + '/' + id + '/events').then(function (r) { return r.json(); }),
        ]).then(function (results) {
            if (results[0].error) { _showToast(results[0].error); return; }
            _renderDetail(results[0].authorization, results[1].events || []);
            document.getElementById('detailModal').classList.add('open');
        }).catch(function () { _showToast('Failed to load authorization.'); });
    }
    function waCloseDetail() { document.getElementById('detailModal').classList.remove('open'); _loadSummary(); waLoadList(); }

    function _renderDetail(a, events) {
        var html = '<div class="modal-title">' + _html(a.work_type) + ' <span class="pill sr-' + _html(a.scope_result) + '">' + _html(SCOPE_LABELS[a.scope_result] || a.scope_result) + '</span> <span class="pill as-' + _html(a.authorization_status) + '">' + _html(STATUS_LABELS[a.authorization_status] || a.authorization_status) + '</span></div>';
        html += '<div class="readonly-grid">' +
            '<div class="readonly-field"><div class="rf-label">Client</div><div class="rf-value">' + _html(a.client_name || a.client_id) + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Source</div><div class="rf-value">' + _html(a.source_module) + ' / ' + _html(a.source_type) + (a.source_id ? ' #' + a.source_id : '') + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Risk Level</div><div class="rf-value"><span class="pill risk-' + _html(a.risk_level) + '">' + _html(a.risk_level) + '</span></div></div>' +
            '<div class="readonly-field"><div class="rf-label">Matched Engagement</div><div class="rf-value">' + (a.matched_engagement_id ? '#' + a.matched_engagement_id + ' (' + _html(a.matched_engagement_status) + ')' : '—') + '</div></div>' +
            '</div>';
        if (a.reason) html += '<div class="mini-card">' + _html(a.reason) + '</div>';
        if (a.override_reason) html += '<div class="mini-card">Override/acceptance reason: ' + _html(a.override_reason) + '</div>';
        if (a.approved_by) html += '<div class="mini-card">Approved ' + _fmt(a.approved_at) + '</div>';
        if (a.rejected_by) html += '<div class="mini-card">Rejected ' + _fmt(a.rejected_at) + '</div>';

        html += _renderActionBar(a);

        html += '<div class="detail-tab-bar" id="detailTabBar"></div>';
        html += '<div class="detail-tab-panel active" id="dpanel-events"><div id="detailEventsBody"></div></div>';

        document.getElementById('detailBody').innerHTML = html;
        _renderDetailTabBar();
        _renderEvents(events);
    }

    function _renderActionBar(a) {
        var btns = [];
        if (['warning', 'out_of_scope'].indexOf(a.authorization_status) !== -1) {
            btns.push('<button class="btn-action btn-primary" onclick="waOpenReason(\'request-override\')">Request Override</button>');
            btns.push('<button class="btn-action btn-danger" onclick="waOpenReason(\'accept-risk\')">Accept Risk</button>');
        }
        if (a.authorization_status === 'override_requested') {
            btns.push('<button class="btn-action btn-success" onclick="waApproveOverride()">Approve Override</button>');
            btns.push('<button class="btn-action btn-danger" onclick="waOpenReason(\'reject-override\')">Reject Override</button>');
        }
        if (['cancelled'].indexOf(a.authorization_status) === -1) {
            btns.push('<button class="btn-action btn-secondary" onclick="waOpenReason(\'cancel\')">Cancel</button>');
        }
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function _renderDetailTabBar() {
        document.getElementById('detailTabBar').innerHTML = '<button class="detail-tab-btn active">Events</button>';
    }

    function _renderEvents(rows) {
        document.getElementById('detailEventsBody').innerHTML = rows.length ? rows.map(function (e) {
            var flag = (e.metadata && e.metadata.partner_required_unverified) ? ' <span class="pill risk-high">Partner Unverified</span>' : '';
            return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) + flag + '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
        }).join('') : '<div class="empty-state">No events yet.</div>';
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    function waApproveOverride() {
        window.PracticeAPI.fetch(BASE + '/' + _currentAuthId + '/approve-override', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(d.partner_required_unverified ? 'Approved — partner requirement not verified (flagged for review).' : 'Override approved.');
                waOpenDetail(_currentAuthId);
            })
            .catch(function () { _showToast('Failed to approve override.'); });
    }

    function waOpenReason(kind) {
        _pendingReasonAction = kind;
        var titles = { 'request-override': 'Request Override', 'reject-override': 'Reject Override', 'accept-risk': 'Accept Risk', cancel: 'Cancel Authorization' };
        document.getElementById('reasonModalTitle').textContent = titles[kind] || 'Reason';
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }
    function waCloseReason() { document.getElementById('reasonModal').classList.remove('open'); }
    function waSubmitReason() {
        var reason = document.getElementById('rfReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        var kind = _pendingReasonAction;
        var url, method, body;
        if (kind === 'request-override') { url = BASE + '/' + _currentAuthId + '/request-override'; method = 'PUT'; body = { override_reason: reason }; }
        else if (kind === 'reject-override') { url = BASE + '/' + _currentAuthId + '/reject-override'; method = 'PUT'; body = { reason: reason }; }
        else if (kind === 'accept-risk') { url = BASE + '/' + _currentAuthId + '/accept-risk'; method = 'PUT'; body = { reason: reason }; }
        else { url = BASE + '/' + _currentAuthId; method = 'DELETE'; body = { reason: reason }; }
        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(d.partner_required_unverified ? 'Done — partner requirement not verified (flagged for review).' : 'Done.');
                waCloseReason(); waOpenDetail(_currentAuthId);
            })
            .catch(function () { _showToast('Failed to submit.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.waOpenCheck = waOpenCheck;
    window.waCloseCheck = waCloseCheck;
    window.waSubmitCheck = waSubmitCheck;
    window.waLoadList = waLoadList;
    window.waOpenDetail = waOpenDetail;
    window.waCloseDetail = waCloseDetail;
    window.waApproveOverride = waApproveOverride;
    window.waOpenReason = waOpenReason;
    window.waCloseReason = waCloseReason;
    window.waSubmitReason = waSubmitReason;

    document.addEventListener('DOMContentLoaded', waLoadAll);
})();
