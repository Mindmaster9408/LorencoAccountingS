/* Codebox 64 — Secretarial Resolutions + Minutes Register Foundation
 * "Here is the governance evidence behind the company record." Manager-driven.
 * Prefix: sg
 */
(function () {
    'use strict';

    var BASE = '/api/practice/secretarial-governance';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'resolutions';
    var _currentMeetingId = null;

    var RES_STATUS_LABELS = { draft: 'Draft', prepared: 'Prepared', approved: 'Approved', signed: 'Signed', implemented: 'Implemented', archived: 'Archived', cancelled: 'Cancelled' };
    var MEET_STATUS_LABELS = { planned: 'Planned', held: 'Held', minutes_draft: 'Minutes Draft', minutes_approved: 'Minutes Approved', completed: 'Completed', cancelled: 'Cancelled' };
    var DEC_STATUS_LABELS = { draft: 'Draft', approved: 'Approved', implemented: 'Implemented', cancelled: 'Cancelled' };
    var RES_TYPE_LABELS = { directors_resolution: 'Directors Resolution', shareholders_resolution: 'Shareholders Resolution', written_resolution: 'Written Resolution', ordinary_resolution: 'Ordinary Resolution', special_resolution: 'Special Resolution', trustee_resolution: 'Trustee Resolution', member_resolution: 'Member Resolution', custom: 'Custom' };
    var MEET_TYPE_LABELS = { directors_meeting: 'Directors Meeting', shareholders_meeting: 'Shareholders Meeting', annual_general_meeting: 'AGM', special_general_meeting: 'Special General Meeting', trustees_meeting: 'Trustees Meeting', members_meeting: 'Members Meeting', custom: 'Custom' };
    var DEC_TYPE_LABELS = { approval: 'Approval', rejection: 'Rejection', instruction: 'Instruction', noting: 'Noting', delegation: 'Delegation', statutory_change: 'Statutory Change', financial: 'Financial', governance: 'Governance', custom: 'Custom' };
    var EV_LABELS = {
        resolution_created: 'Resolution Created', resolution_updated: 'Resolution Updated', resolution_approved: 'Resolution Approved',
        resolution_signed: 'Resolution Signed', resolution_implemented: 'Resolution Implemented', resolution_cancelled: 'Resolution Cancelled',
        meeting_created: 'Meeting Created', meeting_updated: 'Meeting Updated', meeting_held: 'Meeting Held',
        minutes_approved: 'Minutes Approved', meeting_cancelled: 'Meeting Cancelled',
        attendee_added: 'Attendee Added', attendee_updated: 'Attendee Updated',
        decision_created: 'Decision Created', decision_updated: 'Decision Updated', decision_approved: 'Decision Approved',
        decision_implemented: 'Decision Implemented', decision_cancelled: 'Decision Cancelled',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function sgLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientOptions().then(_handleDeepLink);
        sgLoadResolutions();
        sgLoadMeetings();
        sgLoadDecisions();
        sgLoadEvents();
    }

    // Codebox 63 integration — "Create Resolution"/"Create Meeting" quick
    // actions on the Secretarial Workflows case detail link here with
    // ?create=resolution|meeting&client_id=&change_case_id=, pre-filling and
    // opening the matching create modal instead of a bare, unfilled form.
    function _handleDeepLink() {
        var params = new URLSearchParams(window.location.search);
        var create = params.get('create');
        var clientId = params.get('client_id');
        var changeCaseId = params.get('change_case_id');
        if (create === 'resolution') {
            sgOpenCreateResolution();
            if (clientId) document.getElementById('rfClient').value = clientId;
            if (changeCaseId) document.getElementById('rfChangeCaseId').value = changeCaseId;
        } else if (create === 'meeting') {
            sgOpenCreateMeeting();
            if (clientId) document.getElementById('mfClient').value = clientId;
            if (changeCaseId) document.getElementById('mfChangeCaseId').value = changeCaseId;
        }
    }

    function _renderTabBar() {
        var tabs = [['resolutions', 'Resolutions'], ['meetings', 'Meetings'], ['decisions', 'Decisions'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="sgSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function sgSetTab(tab) { _tab = tab; _renderTabBar(); }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var r = d.resolutions || {}, m = d.meetings || {}, dec = d.decisions || {};
                var cards = [
                    { count: r.total || 0, label: 'Resolutions' },
                    { count: (r.by_status || {}).approved || 0, label: 'Awaiting Signature' },
                    { count: m.total || 0, label: 'Meetings' },
                    { count: (m.by_status || {}).planned || 0, label: 'Meetings Planned' },
                    { count: dec.total || 0, label: 'Decisions' },
                    { count: dec.follow_ups_overdue || 0, label: 'Follow-ups Overdue' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientOptions() {
        return window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var opts = (d.clients || []).map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
                ['rfClient', 'mfClient', 'dfClient'].forEach(function (id) { var el = document.getElementById(id); if (el) el.innerHTML = opts; });
            })
            .catch(function () {});
    }

    // ── Resolutions ───────────────────────────────────────────────────────────

    function sgLoadResolutions() {
        var status = document.getElementById('resStatusFilter').value;
        window.PracticeAPI.fetch(BASE + '/resolutions' + (status ? '?resolution_status=' + encodeURIComponent(status) : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.resolutions || [];
                if (!rows.length) { document.getElementById('resolutionsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No resolutions found.</td></tr>'; return; }
                document.getElementById('resolutionsBody').innerHTML = rows.map(function (r) {
                    return '<tr class="row-clickable" onclick="sgOpenResolutionDetail(' + r.id + ')">' +
                        '<td>' + _html(r.client_name) + '</td><td>' + _html(r.resolution_title) + '</td>' +
                        '<td>' + _html(RES_TYPE_LABELS[r.resolution_type] || r.resolution_type) + '</td>' +
                        '<td><span class="pill rst-' + _html(r.resolution_status) + '">' + _html(RES_STATUS_LABELS[r.resolution_status] || r.resolution_status) + '</span></td>' +
                        '<td>' + _fmtDate(r.resolution_date) + '</td><td>' + _fmtDate(r.effective_date) + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('resolutionsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function sgOpenCreateResolution() { document.getElementById('createResolutionModal').classList.add('open'); }
    function sgCloseCreateResolution() { document.getElementById('createResolutionModal').classList.remove('open'); }
    function sgSubmitCreateResolution() {
        var body = {
            client_id: document.getElementById('rfClient').value,
            resolution_type: document.getElementById('rfType').value,
            change_case_id: document.getElementById('rfChangeCaseId').value || null,
            resolution_title: document.getElementById('rfTitle').value,
            resolution_summary: document.getElementById('rfSummary').value || null,
            resolution_date: document.getElementById('rfDate').value || null,
            effective_date: document.getElementById('rfEffectiveDate').value || null,
            prepared_by: document.getElementById('rfPreparedBy').value || null,
            reference_number: document.getElementById('rfReference').value || null,
            notes: document.getElementById('rfNotes').value || null,
        };
        if (!body.client_id) { _showToast('Client is required.'); return; }
        if (!body.resolution_title) { _showToast('Title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/resolutions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Resolution created.'); sgCloseCreateResolution(); sgLoadResolutions(); _loadSummary(); sgOpenResolutionDetail(d.resolution.id); })
            .catch(function () { _showToast('Failed to create resolution.'); });
    }

    function sgOpenResolutionDetail(id) {
        window.PracticeAPI.fetch(BASE + '/resolutions/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderResolutionDetail(d.resolution);
                document.getElementById('resolutionDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load resolution.'); });
    }
    function sgCloseResolutionDetail() { document.getElementById('resolutionDetailModal').classList.remove('open'); sgLoadResolutions(); _loadSummary(); }

    function _renderResolutionDetail(r) {
        var html = '<div class="modal-title">' + _html(r.resolution_title) + ' <span class="pill rst-' + _html(r.resolution_status) + '">' + _html(RES_STATUS_LABELS[r.resolution_status]) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(RES_TYPE_LABELS[r.resolution_type] || r.resolution_type) +
            (r.change_case_id ? ' &middot; Linked to change case #' + r.change_case_id : '') + '</div>';

        var btns = [];
        if (['draft', 'prepared'].includes(r.resolution_status)) btns.push('<button class="btn-action btn-success" onclick="sgApproveResolution(' + r.id + ')">Approve</button>');
        if (r.resolution_status === 'approved') btns.push('<button class="btn-action btn-primary" onclick="sgSignResolution(' + r.id + ')">Sign</button>');
        if (r.resolution_status === 'signed') btns.push('<button class="btn-action btn-primary" onclick="sgImplementResolution(' + r.id + ')">Implement</button>');
        if (!['implemented', 'archived', 'cancelled'].includes(r.resolution_status)) btns.push('<button class="btn-action btn-danger" onclick="sgCancelResolution(' + r.id + ')">Cancel</button>');
        if (r.resolution_status === 'implemented') btns.push('<button class="btn-action btn-secondary" onclick="sgArchiveResolution(' + r.id + ')">Archive</button>');
        html += btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';

        html += (r.resolution_summary ? '<div class="mini-card">' + _html(r.resolution_summary) + '</div>' : '');
        html += '<div class="mini-card-meta">Resolution date: ' + _fmtDate(r.resolution_date) + ' &middot; Effective: ' + _fmtDate(r.effective_date) + ' &middot; Prepared by: ' + _html(r.prepared_by || '—') + '</div>';
        if (r.content_snapshot) {
            html += '<div class="mini-card" style="margin-top:10px;"><strong>Signed Snapshot</strong><pre style="white-space:pre-wrap;font-size:.76rem;margin-top:6px;">' + _html(JSON.stringify(r.content_snapshot, null, 2)) + '</pre></div>';
        }
        document.getElementById('resolutionDetailBody').innerHTML = html;
        window._sgCurrentResolution = r;
    }

    function sgApproveResolution(id) { _resolutionAction(id, 'approve', 'Resolution approved.'); }
    function sgSignResolution(id) { _resolutionAction(id, 'sign', 'Resolution signed.'); }
    function sgImplementResolution(id) { _resolutionAction(id, 'implement', 'Resolution implemented.'); }
    function sgCancelResolution(id) {
        window.PracticeAPI.fetch(BASE + '/resolutions/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Resolution cancelled.'); sgOpenResolutionDetail(id); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }
    function sgArchiveResolution(id) {
        window.PracticeAPI.fetch(BASE + '/resolutions/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution_status: 'archived' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Resolution archived.'); sgOpenResolutionDetail(id); })
            .catch(function () { _showToast('Failed to archive.'); });
    }
    function _resolutionAction(id, action, successMsg) {
        window.PracticeAPI.fetch(BASE + '/resolutions/' + id + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(successMsg); sgOpenResolutionDetail(id); })
            .catch(function () { _showToast('Failed to ' + action + '.'); });
    }

    // ── Meetings ──────────────────────────────────────────────────────────────

    function sgLoadMeetings() {
        var status = document.getElementById('meetStatusFilter').value;
        window.PracticeAPI.fetch(BASE + '/meetings' + (status ? '?meeting_status=' + encodeURIComponent(status) : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.meetings || [];
                if (!rows.length) { document.getElementById('meetingsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No meetings found.</td></tr>'; return; }
                document.getElementById('meetingsBody').innerHTML = rows.map(function (m) {
                    return '<tr class="row-clickable" onclick="sgOpenMeetingDetail(' + m.id + ')">' +
                        '<td>' + _html(m.client_name) + '</td><td>' + _html(m.meeting_title) + '</td>' +
                        '<td>' + _html(MEET_TYPE_LABELS[m.meeting_type] || m.meeting_type) + '</td>' +
                        '<td><span class="pill mst-' + _html(m.meeting_status) + '">' + _html(MEET_STATUS_LABELS[m.meeting_status] || m.meeting_status) + '</span></td>' +
                        '<td>' + _fmtDate(m.meeting_date) + '</td><td>' + _html(m.chairperson_name || '—') + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('meetingsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function sgOpenCreateMeeting() { document.getElementById('createMeetingModal').classList.add('open'); }
    function sgCloseCreateMeeting() { document.getElementById('createMeetingModal').classList.remove('open'); }
    function sgSubmitCreateMeeting() {
        var body = {
            client_id: document.getElementById('mfClient').value,
            meeting_type: document.getElementById('mfType').value,
            change_case_id: document.getElementById('mfChangeCaseId').value || null,
            meeting_title: document.getElementById('mfTitle').value,
            meeting_date: document.getElementById('mfDate').value || null,
            meeting_location: document.getElementById('mfLocation').value || null,
            chairperson_name: document.getElementById('mfChair').value || null,
            minute_taker_name: document.getElementById('mfMinuteTaker').value || null,
            agenda_summary: document.getElementById('mfAgenda').value || null,
            notes: document.getElementById('mfNotes').value || null,
        };
        if (!body.client_id) { _showToast('Client is required.'); return; }
        if (!body.meeting_title) { _showToast('Title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Meeting created.'); sgCloseCreateMeeting(); sgLoadMeetings(); _loadSummary(); sgOpenMeetingDetail(d.meeting.id); })
            .catch(function () { _showToast('Failed to create meeting.'); });
    }

    function sgOpenMeetingDetail(id) {
        _currentMeetingId = id;
        window.PracticeAPI.fetch(BASE + '/meetings/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderMeetingDetail(d.meeting, d.attendees || []);
                document.getElementById('meetingDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load meeting.'); });
    }
    function sgCloseMeetingDetail() { document.getElementById('meetingDetailModal').classList.remove('open'); sgLoadMeetings(); _loadSummary(); }

    function _renderMeetingDetail(m, attendees) {
        var html = '<div class="modal-title">' + _html(m.meeting_title) + ' <span class="pill mst-' + _html(m.meeting_status) + '">' + _html(MEET_STATUS_LABELS[m.meeting_status]) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(MEET_TYPE_LABELS[m.meeting_type] || m.meeting_type) + ' &middot; ' + _fmtDate(m.meeting_date) +
            (m.change_case_id ? ' &middot; Linked to change case #' + m.change_case_id : '') + '</div>';

        var btns = [];
        if (m.meeting_status === 'planned') btns.push('<button class="btn-action btn-success" onclick="sgMarkHeld(' + m.id + ')">Mark Held</button>');
        if (['held', 'minutes_draft'].includes(m.meeting_status)) btns.push('<button class="btn-action btn-primary" onclick="sgApproveMinutes(' + m.id + ')">Approve Minutes</button>');
        if (m.meeting_status === 'minutes_approved') btns.push('<button class="btn-action btn-success" onclick="sgCompleteMeeting(' + m.id + ')">Complete</button>');
        if (!['completed', 'cancelled'].includes(m.meeting_status)) btns.push('<button class="btn-action btn-danger" onclick="sgCancelMeeting(' + m.id + ')">Cancel</button>');
        html += btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';

        html += (m.agenda_summary ? '<div class="mini-card"><strong>Agenda</strong><br/>' + _html(m.agenda_summary) + '</div>' : '');
        html += (m.minutes_summary ? '<div class="mini-card"><strong>Minutes</strong><br/>' + _html(m.minutes_summary) + '</div>' : '');

        html += '<div class="panel-title" style="margin-top:14px;">Attendees <button class="btn-action btn-primary" onclick="sgOpenAttendee()">+ Add Attendee</button></div>';
        html += attendees.length ? attendees.map(function (a) {
            return '<div class="mini-card">' + _html(a.attendee_name) + (a.attendee_role ? ' — ' + _html(a.attendee_role) : '') +
                ' <span class="pill at-' + _html(a.attendance_status) + '">' + _html(a.attendance_status) + '</span>' +
                '<div class="mini-card-meta">' + _html(a.attendee_type) + '</div></div>';
        }).join('') : '<div class="empty-state">No attendees recorded.</div>';

        document.getElementById('meetingDetailBody').innerHTML = html;
    }

    function sgMarkHeld(id) { _meetingAction(id, 'mark-held', 'Meeting marked held.'); }
    function sgApproveMinutes(id) { _meetingAction(id, 'approve-minutes', 'Minutes approved.'); }
    function sgCompleteMeeting(id) {
        window.PracticeAPI.fetch(BASE + '/meetings/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_status: 'completed' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Meeting completed.'); sgOpenMeetingDetail(id); })
            .catch(function () { _showToast('Failed to complete.'); });
    }
    function sgCancelMeeting(id) {
        window.PracticeAPI.fetch(BASE + '/meetings/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Meeting cancelled.'); sgOpenMeetingDetail(id); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }
    function _meetingAction(id, action, successMsg) {
        window.PracticeAPI.fetch(BASE + '/meetings/' + id + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(successMsg); sgOpenMeetingDetail(id); })
            .catch(function () { _showToast('Failed to ' + action + '.'); });
    }

    // ── Attendees ─────────────────────────────────────────────────────────────

    function sgOpenAttendee() { document.getElementById('attendeeModal').classList.add('open'); }
    function sgCloseAttendee() { document.getElementById('attendeeModal').classList.remove('open'); }
    function sgSubmitAttendee() {
        var body = {
            attendee_name: document.getElementById('afName').value,
            attendee_role: document.getElementById('afRole').value || null,
            attendee_type: document.getElementById('afType').value,
            attendance_status: document.getElementById('afStatus').value,
            email: document.getElementById('afEmail').value || null,
            notes: document.getElementById('afNotes').value || null,
        };
        if (!body.attendee_name) { _showToast('Name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/meetings/' + _currentMeetingId + '/attendees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Attendee added.'); sgCloseAttendee(); sgOpenMeetingDetail(_currentMeetingId); })
            .catch(function () { _showToast('Failed to add attendee.'); });
    }

    // ── Decisions ─────────────────────────────────────────────────────────────

    function sgLoadDecisions() {
        var status = document.getElementById('decStatusFilter').value;
        window.PracticeAPI.fetch(BASE + '/decisions' + (status ? '?decision_status=' + encodeURIComponent(status) : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.decisions || [];
                if (!rows.length) { document.getElementById('decisionsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No decisions found.</td></tr>'; return; }
                document.getElementById('decisionsBody').innerHTML = rows.map(function (dec) {
                    return '<tr class="row-clickable" onclick="sgOpenDecisionDetail(' + dec.id + ')">' +
                        '<td>' + _html(dec.client_name) + '</td><td>' + _html(dec.decision_title) + '</td>' +
                        '<td>' + _html(DEC_TYPE_LABELS[dec.decision_type] || dec.decision_type) + '</td>' +
                        '<td><span class="pill dst-' + _html(dec.decision_status) + '">' + _html(DEC_STATUS_LABELS[dec.decision_status] || dec.decision_status) + '</span></td>' +
                        '<td>' + _fmtDate(dec.decision_date) + '</td><td>' + (dec.follow_up_required ? _fmtDate(dec.follow_up_due_date) : '—') + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('decisionsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function sgOpenCreateDecision() { document.getElementById('createDecisionModal').classList.add('open'); }
    function sgCloseCreateDecision() { document.getElementById('createDecisionModal').classList.remove('open'); }
    function sgSubmitCreateDecision() {
        var body = {
            client_id: document.getElementById('dfClient').value,
            decision_type: document.getElementById('dfType').value,
            meeting_id: document.getElementById('dfMeetingId').value || null,
            resolution_id: document.getElementById('dfResolutionId').value || null,
            change_case_id: document.getElementById('dfChangeCaseId').value || null,
            decision_title: document.getElementById('dfTitle').value,
            decision_summary: document.getElementById('dfSummary').value || null,
            decision_date: document.getElementById('dfDate').value || null,
            effective_date: document.getElementById('dfEffectiveDate').value || null,
            follow_up_required: document.getElementById('dfFollowUp').checked,
            follow_up_due_date: document.getElementById('dfFollowUpDate').value || null,
            notes: document.getElementById('dfNotes').value || null,
        };
        if (!body.client_id) { _showToast('Client is required.'); return; }
        if (!body.decision_title) { _showToast('Title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Decision created.'); sgCloseCreateDecision(); sgLoadDecisions(); _loadSummary(); sgOpenDecisionDetail(d.decision.id); })
            .catch(function () { _showToast('Failed to create decision.'); });
    }

    function sgOpenDecisionDetail(id) {
        window.PracticeAPI.fetch(BASE + '/decisions/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderDecisionDetail(d.decision);
                document.getElementById('decisionDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load decision.'); });
    }
    function sgCloseDecisionDetail() { document.getElementById('decisionDetailModal').classList.remove('open'); sgLoadDecisions(); _loadSummary(); }

    function _renderDecisionDetail(dec) {
        var html = '<div class="modal-title">' + _html(dec.decision_title) + ' <span class="pill dst-' + _html(dec.decision_status) + '">' + _html(DEC_STATUS_LABELS[dec.decision_status]) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(DEC_TYPE_LABELS[dec.decision_type] || dec.decision_type) +
            (dec.meeting_id ? ' &middot; Meeting #' + dec.meeting_id : '') + (dec.resolution_id ? ' &middot; Resolution #' + dec.resolution_id : '') +
            (dec.change_case_id ? ' &middot; Change Case #' + dec.change_case_id : '') + '</div>';

        var btns = [];
        if (dec.decision_status === 'draft') btns.push('<button class="btn-action btn-success" onclick="sgApproveDecision(' + dec.id + ')">Approve</button>');
        if (dec.decision_status === 'approved') btns.push('<button class="btn-action btn-primary" onclick="sgImplementDecision(' + dec.id + ')">Implement</button>');
        if (!['implemented', 'cancelled'].includes(dec.decision_status)) btns.push('<button class="btn-action btn-danger" onclick="sgCancelDecision(' + dec.id + ')">Cancel</button>');
        html += btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';

        html += (dec.decision_summary ? '<div class="mini-card">' + _html(dec.decision_summary) + '</div>' : '');
        html += '<div class="mini-card-meta">Decision date: ' + _fmtDate(dec.decision_date) + ' &middot; Effective: ' + _fmtDate(dec.effective_date) + '</div>';
        if (dec.follow_up_required) html += '<div class="mini-card" style="border-left:3px solid #f6ad55;">Follow-up due: ' + _fmtDate(dec.follow_up_due_date) + '</div>';

        document.getElementById('decisionDetailBody').innerHTML = html;
    }

    function sgApproveDecision(id) { _decisionAction(id, 'approve', 'Decision approved.'); }
    function sgImplementDecision(id) { _decisionAction(id, 'implement', 'Decision implemented.'); }
    function sgCancelDecision(id) {
        window.PracticeAPI.fetch(BASE + '/decisions/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Decision cancelled.'); sgOpenDecisionDetail(id); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }
    function _decisionAction(id, action, successMsg) {
        window.PracticeAPI.fetch(BASE + '/decisions/' + id + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(successMsg); sgOpenDecisionDetail(id); })
            .catch(function () { _showToast('Failed to ' + action + '.'); });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function sgLoadEvents() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('eventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) + ' <span class="mini-card-meta">(' + _html(e.source_type) + ' #' + e.source_id + ')</span>' +
                        '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.sgSetTab = sgSetTab;
    window.sgLoadResolutions = sgLoadResolutions;
    window.sgOpenCreateResolution = sgOpenCreateResolution;
    window.sgCloseCreateResolution = sgCloseCreateResolution;
    window.sgSubmitCreateResolution = sgSubmitCreateResolution;
    window.sgOpenResolutionDetail = sgOpenResolutionDetail;
    window.sgCloseResolutionDetail = sgCloseResolutionDetail;
    window.sgApproveResolution = sgApproveResolution;
    window.sgSignResolution = sgSignResolution;
    window.sgImplementResolution = sgImplementResolution;
    window.sgCancelResolution = sgCancelResolution;
    window.sgArchiveResolution = sgArchiveResolution;
    window.sgLoadMeetings = sgLoadMeetings;
    window.sgOpenCreateMeeting = sgOpenCreateMeeting;
    window.sgCloseCreateMeeting = sgCloseCreateMeeting;
    window.sgSubmitCreateMeeting = sgSubmitCreateMeeting;
    window.sgOpenMeetingDetail = sgOpenMeetingDetail;
    window.sgCloseMeetingDetail = sgCloseMeetingDetail;
    window.sgMarkHeld = sgMarkHeld;
    window.sgApproveMinutes = sgApproveMinutes;
    window.sgCompleteMeeting = sgCompleteMeeting;
    window.sgCancelMeeting = sgCancelMeeting;
    window.sgOpenAttendee = sgOpenAttendee;
    window.sgCloseAttendee = sgCloseAttendee;
    window.sgSubmitAttendee = sgSubmitAttendee;
    window.sgLoadDecisions = sgLoadDecisions;
    window.sgOpenCreateDecision = sgOpenCreateDecision;
    window.sgCloseCreateDecision = sgCloseCreateDecision;
    window.sgSubmitCreateDecision = sgSubmitCreateDecision;
    window.sgOpenDecisionDetail = sgOpenDecisionDetail;
    window.sgCloseDecisionDetail = sgCloseDecisionDetail;
    window.sgApproveDecision = sgApproveDecision;
    window.sgImplementDecision = sgImplementDecision;
    window.sgCancelDecision = sgCancelDecision;

    document.addEventListener('DOMContentLoaded', sgLoadAll);
})();
