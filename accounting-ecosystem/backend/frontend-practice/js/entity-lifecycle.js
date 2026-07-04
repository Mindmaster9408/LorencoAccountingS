/* Codebox 68 — Practice Secretarial Entity Lifecycle Management
 * "Where is this entity in its lifecycle, and what must happen before it can
 * move to the next stage?" NOT CIPC API. NOT automatic transitions. Manual,
 * manager-controlled lifecycle tracking.
 * Prefix: el
 */
(function () {
    'use strict';

    var BASE = '/api/practice/entity-lifecycle';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'profile';
    var _detailTab = 'checklist';
    var _currentClientId = null;
    var _currentTransitionId = null;

    var LIFECYCLE_STATUS_LABELS = {
        pre_incorporation: 'Pre-Incorporation', incorporated: 'Incorporated', active: 'Active', trading: 'Trading',
        dormant: 'Dormant', non_compliant: 'Non-Compliant', deregistration_pending: 'Deregistration Pending',
        deregistered: 'Deregistered', restoration_pending: 'Restoration Pending', restored: 'Restored',
        liquidation_pending: 'Liquidation Pending', liquidated: 'Liquidated', closed: 'Closed', unknown: 'Unknown',
    };
    var TRANSITION_TYPE_LABELS = {
        incorporate: 'Incorporate', activate: 'Activate', commence_trading: 'Commence Trading', mark_dormant: 'Mark Dormant',
        mark_non_compliant: 'Mark Non-Compliant', start_deregistration: 'Start Deregistration', confirm_deregistered: 'Confirm Deregistered',
        start_restoration: 'Start Restoration', confirm_restored: 'Confirm Restored', start_liquidation: 'Start Liquidation',
        confirm_liquidated: 'Confirm Liquidated', close_entity: 'Close Entity', reopen_entity: 'Reopen Entity',
        status_review: 'Status Review', custom: 'Custom',
    };
    var TRANSITION_STATUS_LABELS = {
        draft: 'Draft', preparing: 'Preparing', awaiting_evidence: 'Awaiting Evidence', ready_for_review: 'Ready for Review',
        approved: 'Approved', implemented: 'Implemented', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled',
    };
    var EV_LABELS = {
        lifecycle_profile_created: 'Profile Created', lifecycle_profile_updated: 'Profile Updated', lifecycle_reviewed: 'Reviewed',
        lifecycle_status_changed: 'Status Changed', transition_created: 'Transition Created', transition_updated: 'Transition Updated',
        transition_submitted_review: 'Submitted for Review', transition_approved: 'Transition Approved', transition_rejected: 'Transition Rejected',
        transition_implemented: 'Transition Implemented', transition_completed: 'Transition Completed', transition_cancelled: 'Transition Cancelled',
        checklist_generated: 'Checklist Generated', checklist_item_updated: 'Checklist Item Updated',
    };
    var PRE_REVIEW = ['draft', 'preparing', 'awaiting_evidence'];

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _today() { return new Date().toISOString().split('T')[0]; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function elLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientPicker();
    }

    function _renderTabBar() {
        var tabs = [['profile', 'Lifecycle Profile'], ['transitions', 'Transitions'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="elSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('#clientArea > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function elSetTab(tab) {
        _tab = tab; _renderTabBar();
        if (tab === 'transitions') _loadTransitions();
        if (tab === 'events') _loadEvents();
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var s = d.by_lifecycle_status || {};
                var cards = [
                    { count: d.profiles_total || 0, label: 'Entities Tracked' },
                    { count: d.active_transitions || 0, label: 'Active Transitions' },
                    { count: d.high_risk_entities || 0, label: 'High/Critical Risk' },
                    { count: s.non_compliant || 0, label: 'Non-Compliant' },
                    { count: s.deregistration_pending || 0, label: 'Deregistration Pending' },
                    { count: s.liquidation_pending || 0, label: 'Liquidation Pending' },
                    { count: s.dormant || 0, label: 'Dormant' },
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
                var sel = document.getElementById('clientPicker');
                sel.innerHTML = '<option value="">Select a client…</option>' + clients.map(function (c) {
                    return '<option value="' + c.id + '">' + _html(c.name) + '</option>';
                }).join('');
                var params = new URLSearchParams(window.location.search);
                var preselect = params.get('client_id');
                if (preselect && clients.some(function (c) { return String(c.id) === preselect; })) {
                    sel.value = preselect;
                    elOnClientChange();
                }
            })
            .catch(function () {});
    }

    function elOnClientChange() {
        var val = document.getElementById('clientPicker').value;
        if (!val) { document.getElementById('clientArea').style.display = 'none'; _currentClientId = null; return; }
        _currentClientId = parseInt(val);
        document.getElementById('clientArea').style.display = 'block';
        _tab = 'profile'; _renderTabBar();
        elLoadClientData();
    }

    function elLoadClientData() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderProfile(d);
            })
            .catch(function () { _showToast('Failed to load entity lifecycle data.'); });
        _loadIntegrityWarnings();
    }

    // Codebox 69 — open Secretarial Integrity findings for this client,
    // reused via GET /secretarial-integrity/findings?client_id=&status=open
    // (no duplicate validation/scoring logic here).
    function _loadIntegrityWarnings() {
        var el = document.getElementById('integrityWarnings');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/secretarial-integrity/findings?client_id=' + _currentClientId + '&status=open')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var findings = d.findings || [];
                el.innerHTML = findings.length ? findings.map(function (f) {
                    return '<div class="mini-card' + (f.severity === 'critical' || f.severity === 'high' ? ' flag' : '') + '">' +
                        '<span class="pill">' + _html(f.severity) + '</span> ' + _html(f.title) + '</div>';
                }).join('') : '<div class="empty-state">No open integrity findings for this client.</div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    function _renderProfile(d) {
        var p = d.profile || {};
        document.getElementById('currentStatusPill').innerHTML = '<span class="pill ls-' + _html(d.current_status) + '">' + _html(LIFECYCLE_STATUS_LABELS[d.current_status] || d.current_status) + '</span>';

        var flags = d.risk_flags || [];
        document.getElementById('riskFlags').innerHTML = flags.length ? flags.map(function (f) {
            return '<div class="mini-card flag">' + _html(f) + '</div>';
        }).join('') : '<div class="empty-state">No risk flags.</div>';

        var actions = d.recommended_next_actions || [];
        document.getElementById('recommendedActions').innerHTML = actions.length ? actions.map(function (a) {
            return '<div class="mini-card action">' + _html(a) + '</div>';
        }).join('') : '';

        document.getElementById('pfEntityCategory').value = p.entity_category || '';
        document.getElementById('pfTradingStatus').value = p.trading_status || 'unknown';
        document.getElementById('pfComplianceStatus').value = p.compliance_status || 'unknown';
        document.getElementById('pfRiskStatus').value = p.risk_status || 'unknown';
        document.getElementById('pfNextReview').value = p.next_review_date || '';
        document.getElementById('pfStatusReason').value = p.lifecycle_status_reason || '';
        document.getElementById('pfNotes').value = p.notes || '';
        document.getElementById('pfInternalNotes').value = p.internal_notes || '';

        _renderReusedSummaries(d);

        var outstanding = d.outstanding_checklist_items || [];
        document.getElementById('outstandingItems').innerHTML = outstanding.length ? outstanding.map(function (i) {
            return '<div class="mini-card">' + _html(i.item_name) + '<div class="mini-card-meta">' + _html(i.item_type) + '</div></div>';
        }).join('') : '<div class="empty-state">None.</div>';

        var latest = d.latest_completed_transition;
        document.getElementById('latestCompleted').innerHTML = latest
            ? '<div class="mini-card">' + _html(TRANSITION_TYPE_LABELS[latest.transition_type] || latest.transition_type) + ': ' +
              _html(LIFECYCLE_STATUS_LABELS[latest.old_status] || latest.old_status) + ' → ' + _html(LIFECYCLE_STATUS_LABELS[latest.new_status] || latest.new_status) +
              '<div class="mini-card-meta">Completed ' + _fmt(latest.completed_at) + '</div></div>'
            : '<div class="empty-state">None yet.</div>';
    }

    // Reused live from Statutory Calendar (Codebox 67), Secretarial Foundation
    // (Codebox 62), Beneficial Ownership (Codebox 65), and Secretarial Evidence
    // (Codebox 66) — no duplicate aggregation logic here, backend already
    // wraps each in _safe() so one unavailable summary never blocks the rest.
    function _renderReusedSummaries(d) {
        var fields = [];
        var cal = d.statutory_calendar_summary;
        fields.push(['Statutory Compliance', cal ? ('Overdue: ' + (cal.overdue || 0) + ' · Due Today: ' + (cal.due_today || 0) + ' · Blocked: ' + (cal.blocked || 0)) : 'Unavailable']);
        var sec = d.secretarial_profile_summary;
        fields.push(['Company Status (Secretarial)', sec ? (sec.company_status || '—') : 'Unavailable']);
        var bo = d.bo_readiness_summary;
        fields.push(['Beneficial Ownership Readiness', bo ? (bo.status + ' (' + (bo.score || 0) + '%)') : 'Unavailable']);
        var ev = d.evidence_readiness_summary;
        fields.push(['Evidence Readiness', ev ? (ev.ready + '/' + ev.checklists_total + ' checklist(s) ready, ' + ev.blocked + ' blocked') : 'No evidence checklists']);

        document.getElementById('reusedSummaries').innerHTML = fields.map(function (f) {
            return '<div class="readonly-field"><div class="rf-label">' + _html(f[0]) + '</div><div class="rf-value">' + _html(f[1]) + '</div></div>';
        }).join('');
    }

    function elSaveProfile() {
        var payload = {
            entity_category: document.getElementById('pfEntityCategory').value || null,
            trading_status: document.getElementById('pfTradingStatus').value,
            compliance_status: document.getElementById('pfComplianceStatus').value,
            risk_status: document.getElementById('pfRiskStatus').value,
            next_review_date: document.getElementById('pfNextReview').value || null,
            lifecycle_status_reason: document.getElementById('pfStatusReason').value || null,
            notes: document.getElementById('pfNotes').value || null,
            internal_notes: document.getElementById('pfInternalNotes').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId + '/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Profile saved.'); elLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to save profile.'); });
    }

    function elMarkReviewed() {
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId + '/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mark_reviewed: true }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Marked reviewed.'); elLoadClientData(); })
            .catch(function () { _showToast('Failed to mark reviewed.'); });
    }

    // ── Transitions ───────────────────────────────────────────────────────────

    function _loadTransitions() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/transitions?client_id=' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderTransitions(d.transitions || []); })
            .catch(function () { document.getElementById('transitionsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderTransitions(rows) {
        if (!rows.length) { document.getElementById('transitionsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No transitions yet.</td></tr>'; return; }
        document.getElementById('transitionsBody').innerHTML = rows.map(function (t) {
            return '<tr class="row-clickable" onclick="elOpenDetail(' + t.id + ')">' +
                '<td>' + _html(TRANSITION_TYPE_LABELS[t.transition_type] || t.transition_type) + '</td>' +
                '<td>' + _html(LIFECYCLE_STATUS_LABELS[t.old_status] || t.old_status) + ' → ' + _html(LIFECYCLE_STATUS_LABELS[t.new_status] || t.new_status) + '</td>' +
                '<td><span class="pill ts-' + _html(t.transition_status) + '">' + _html(TRANSITION_STATUS_LABELS[t.transition_status] || t.transition_status) + '</span></td>' +
                '<td>' + _fmtDate(t.requested_date) + '</td><td>' + _fmtDate(t.effective_date) + '</td><td></td></tr>';
        }).join('');
    }

    function elOpenNewTransition() {
        document.getElementById('tfType').value = 'incorporate';
        document.getElementById('tfNewStatus').value = '';
        document.getElementById('tfRequestedBy').value = '';
        document.getElementById('tfRequestedDate').value = _today();
        document.getElementById('tfEffectiveDate').value = '';
        document.getElementById('tfSummary').value = '';
        document.getElementById('tfReason').value = '';
        document.getElementById('newTransitionModal').classList.add('open');
    }
    function elCloseNewTransition() { document.getElementById('newTransitionModal').classList.remove('open'); }
    function elSubmitNewTransition() {
        var payload = {
            client_id: _currentClientId,
            transition_type: document.getElementById('tfType').value,
            new_status: document.getElementById('tfNewStatus').value || null,
            requested_by_name: document.getElementById('tfRequestedBy').value || null,
            requested_date: document.getElementById('tfRequestedDate').value || null,
            effective_date: document.getElementById('tfEffectiveDate').value || null,
            transition_summary: document.getElementById('tfSummary').value || null,
            reason: document.getElementById('tfReason').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/transitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Transition created.'); elCloseNewTransition(); _loadTransitions(); _loadSummary();
                elOpenDetail(d.transition.id);
            })
            .catch(function () { _showToast('Failed to create transition.'); });
    }

    // ── Transition Detail ────────────────────────────────────────────────────

    function elOpenDetail(id) {
        _currentTransitionId = id;
        window.PracticeAPI.fetch(BASE + '/transitions/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderDetail(d);
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load transition detail.'); });
    }
    function elCloseDetail() { document.getElementById('detailModal').classList.remove('open'); _loadTransitions(); _loadSummary(); elLoadClientData(); }

    function _renderDetail(d) {
        var t = d.transition;
        var html = '<div class="modal-title">' + _html(TRANSITION_TYPE_LABELS[t.transition_type] || t.transition_type) +
            ' <span class="pill ts-' + _html(t.transition_status) + '">' + _html(TRANSITION_STATUS_LABELS[t.transition_status] || t.transition_status) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(LIFECYCLE_STATUS_LABELS[t.old_status] || t.old_status) + ' → ' + _html(LIFECYCLE_STATUS_LABELS[t.new_status] || t.new_status) +
            ' &middot; Effective: ' + _fmtDate(t.effective_date) + '</div>';

        html += _renderActionBar(t);

        html += '<div class="detail-tab-bar" id="detailTabBar"></div>';
        html += '<div class="detail-tab-panel active" id="dpanel-checklist"><div id="checklistBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-details">' +
            (t.transition_summary ? '<div class="mini-card">' + _html(t.transition_summary) + '</div>' : '') +
            (t.reason ? '<div class="mini-card">Reason: ' + _html(t.reason) + '</div>' : '') +
            (t.rejection_reason ? '<div class="mini-card" style="border-left:3px solid #fc8181;">Rejection reason: ' + _html(t.rejection_reason) + '</div>' : '') +
            (t.risk_notes ? '<div class="mini-card">Risk notes: ' + _html(t.risk_notes) + '</div>' : '') +
            (t.evidence_notes ? '<div class="mini-card">Evidence notes: ' + _html(t.evidence_notes) + '</div>' : '') +
            (t.after_snapshot ? '<div class="mini-card-meta" style="margin-top:12px;">After Snapshot</div><pre style="white-space:pre-wrap;font-size:.76rem;background:#12122a;padding:12px;border-radius:8px;">' + _html(JSON.stringify(t.after_snapshot, null, 2)) + '</pre>' : '') +
            '</div>';
        html += '<div class="detail-tab-panel" id="dpanel-events"><div id="detailEventsBody"></div></div>';

        document.getElementById('detailBody').innerHTML = html;
        _detailTab = 'checklist';
        _renderDetailTabBar();
        _renderChecklist(d.checklist || []);
        _loadDetailEvents(t.id);
    }

    function _renderActionBar(t) {
        var btns = [];
        if (PRE_REVIEW.indexOf(t.transition_status) !== -1) {
            btns.push('<button class="btn-action btn-secondary" onclick="elGenerateChecklist(' + t.id + ')">Generate Checklist</button>');
            btns.push('<button class="btn-action btn-primary" onclick="elSubmitReview(' + t.id + ')">Submit for Review</button>');
        }
        if (t.transition_status === 'ready_for_review') {
            btns.push('<button class="btn-action btn-success" onclick="elOpenApprove(' + t.id + ')">Approve</button>');
            btns.push('<button class="btn-action btn-danger" onclick="elOpenReject(' + t.id + ')">Reject</button>');
        }
        if (t.transition_status === 'approved') {
            btns.push('<button class="btn-action btn-primary" onclick="elOpenImplement(' + t.id + ', \'' + (t.effective_date || '') + '\')">Implement</button>');
            btns.push('<button class="btn-action btn-danger" onclick="elOpenReject(' + t.id + ')">Reject</button>');
        }
        if (t.transition_status === 'implemented') {
            btns.push('<button class="btn-action btn-success" onclick="elCompleteTransition(' + t.id + ')">Complete</button>');
        }
        if (['completed', 'rejected', 'cancelled'].indexOf(t.transition_status) === -1) {
            btns.push('<button class="btn-action btn-secondary" onclick="elCancelTransition(' + t.id + ')">Cancel Transition</button>');
        }
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function _renderDetailTabBar() {
        var tabs = [['checklist', 'Checklist'], ['details', 'Details'], ['events', 'Events']];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="detail-tab-btn' + (t[0] === _detailTab ? ' active' : '') + '" onclick="elSetDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.detail-tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'dpanel-' + _detailTab); });
    }
    function elSetDetailTab(tab) { _detailTab = tab; _renderDetailTabBar(); }

    // ── Checklist ─────────────────────────────────────────────────────────────

    function _renderChecklist(rows) {
        document.getElementById('checklistBody').innerHTML = rows.length ? rows.map(function (i) {
            return '<div class="checklist-row' + (i.completed ? ' completed' : '') + '">' +
                '<input type="checkbox" ' + (i.completed ? 'checked' : '') + ' onchange="elToggleChecklistItem(' + _currentTransitionId + ',' + i.id + ',this.checked)" />' +
                '<span class="pill">' + _html(i.item_type) + '</span>' +
                '<span class="ci-name">' + _html(i.item_name) + (i.required ? '' : ' (optional)') + '</span>' +
                '</div>';
        }).join('') : '<div class="empty-state">No checklist yet — click "Generate Checklist" above.</div>';
    }

    function elGenerateChecklist(id) {
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/generate-checklist', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(d.message || 'Checklist generated.'); elOpenDetail(id); })
            .catch(function () { _showToast('Failed to generate checklist.'); });
    }

    function elToggleChecklistItem(id, itemId, completed) {
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/checklist/' + itemId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: completed }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); } })
            .catch(function () { _showToast('Failed to update checklist item.'); });
    }

    // ── Detail Events ─────────────────────────────────────────────────────────

    function _loadDetailEvents(id) {
        window.PracticeAPI.fetch(BASE + '/lifecycle_transition/' + id + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('detailEventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) + '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('detailEventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    function elSubmitReview(id) {
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/submit-review', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Submitted for review.'); elOpenDetail(id); })
            .catch(function () { _showToast('Failed to submit for review.'); });
    }

    function elOpenApprove(id) {
        document.getElementById('apReason').value = '';
        document.getElementById('approveWarn').style.display = 'none';
        document.getElementById('approveModal').dataset.transitionId = id;
        document.getElementById('approveModal').classList.add('open');
    }
    function elCloseApprove() { document.getElementById('approveModal').classList.remove('open'); }
    function elSubmitApprove() {
        var id = parseInt(document.getElementById('approveModal').dataset.transitionId);
        var reason = document.getElementById('apReason').value || undefined;
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/approve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ override_reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) {
                    if (d.incomplete_count) {
                        document.getElementById('approveWarn').style.display = 'block';
                        document.getElementById('approveWarn').textContent = d.error;
                        return;
                    }
                    _showToast(d.error); return;
                }
                _showToast('Transition approved.'); elCloseApprove(); elOpenDetail(id);
            })
            .catch(function () { _showToast('Failed to approve.'); });
    }

    function elOpenReject(id) {
        document.getElementById('rjReason').value = '';
        document.getElementById('rejectModal').dataset.transitionId = id;
        document.getElementById('rejectModal').classList.add('open');
    }
    function elCloseReject() { document.getElementById('rejectModal').classList.remove('open'); }
    function elSubmitReject() {
        var id = parseInt(document.getElementById('rejectModal').dataset.transitionId);
        var reason = document.getElementById('rjReason').value;
        if (!reason) { _showToast('Rejection reason is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/reject', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rejection_reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Transition rejected.'); elCloseReject(); elOpenDetail(id); })
            .catch(function () { _showToast('Failed to reject.'); });
    }

    function elOpenImplement(id, effectiveDate) {
        document.getElementById('imEffectiveDate').value = effectiveDate || _today();
        document.getElementById('implementModal').dataset.transitionId = id;
        document.getElementById('implementModal').classList.add('open');
    }
    function elCloseImplement() { document.getElementById('implementModal').classList.remove('open'); }
    function elSubmitImplement() {
        var id = parseInt(document.getElementById('implementModal').dataset.transitionId);
        var effectiveDate = document.getElementById('imEffectiveDate').value;
        if (!effectiveDate) { _showToast('Effective date is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/implement', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effective_date: effectiveDate }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Transition implemented.'); elCloseImplement(); elOpenDetail(id); })
            .catch(function () { _showToast('Failed to implement.'); });
    }

    function elCompleteTransition(id) {
        window.PracticeAPI.fetch(BASE + '/transitions/' + id + '/complete', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Transition completed.'); elOpenDetail(id); })
            .catch(function () { _showToast('Failed to complete.'); });
    }

    function elCancelTransition(id) {
        window.PracticeAPI.fetch(BASE + '/transitions/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Transition cancelled.'); elOpenDetail(id); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }

    // ── Client-level Events tab ──────────────────────────────────────────────

    function _loadEvents() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/events?client_id=' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('eventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) + '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.elSetTab = elSetTab;
    window.elOnClientChange = elOnClientChange;
    window.elSaveProfile = elSaveProfile;
    window.elMarkReviewed = elMarkReviewed;
    window.elOpenNewTransition = elOpenNewTransition;
    window.elCloseNewTransition = elCloseNewTransition;
    window.elSubmitNewTransition = elSubmitNewTransition;
    window.elOpenDetail = elOpenDetail;
    window.elCloseDetail = elCloseDetail;
    window.elSetDetailTab = elSetDetailTab;
    window.elGenerateChecklist = elGenerateChecklist;
    window.elToggleChecklistItem = elToggleChecklistItem;
    window.elSubmitReview = elSubmitReview;
    window.elOpenApprove = elOpenApprove;
    window.elCloseApprove = elCloseApprove;
    window.elSubmitApprove = elSubmitApprove;
    window.elOpenReject = elOpenReject;
    window.elCloseReject = elCloseReject;
    window.elSubmitReject = elSubmitReject;
    window.elOpenImplement = elOpenImplement;
    window.elCloseImplement = elCloseImplement;
    window.elSubmitImplement = elSubmitImplement;
    window.elCompleteTransition = elCompleteTransition;
    window.elCancelTransition = elCancelTransition;

    document.addEventListener('DOMContentLoaded', elLoadAll);
})();
