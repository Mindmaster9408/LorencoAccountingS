/* Codebox 63 — Practice Secretarial Workflows + Statutory Change Management
 * "Every statutory change is controlled." NOT CIPC filing. Manager-driven.
 * Prefix: sw
 */
(function () {
    'use strict';

    var BASE = '/api/practice/secretarial-workflows';
    var CLIENTS_BASE = '/api/practice/clients';
    var _currentCaseId = null;
    var _detailTab = 'checklist';

    var STATUS_LABELS = {
        draft: 'Draft', preparing: 'Preparing', awaiting_documents: 'Awaiting Documents',
        ready_for_review: 'Ready for Review', approved: 'Approved', implemented: 'Implemented',
        completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled',
    };
    var TYPE_LABELS = {
        director_appointment: 'Director Appointment', director_resignation: 'Director Resignation',
        share_transfer: 'Share Transfer', share_issue: 'Share Issue', share_cancellation: 'Share Cancellation',
        registered_address_change: 'Registered Address Change', postal_address_change: 'Postal Address Change',
        company_name_change: 'Company Name Change', financial_year_end_change: 'Financial Year-End Change',
        company_secretary_change: 'Company Secretary Change', auditor_change: 'Auditor Change',
        accounting_officer_change: 'Accounting Officer Change', public_officer_change: 'Public Officer Change',
        company_status_change: 'Company Status Change', annual_return: 'Annual Return', custom: 'Custom',
    };
    // Payload field hints per change_type — the spec's "keep simple" payload
    // UI: a single JSON textarea, guided by a plain-text hint of which fields
    // secretarial-workflows.js's IMPLEMENTATION_RULES actually reads for that
    // type, rather than 16 bespoke structured forms.
    var PAYLOAD_HINTS = {
        director_appointment: 'Fields used on implement: director_name (required), role, appointment_date, id_or_passport_number, shareholding_pct, signing_authority',
        director_resignation: 'Fields used on implement: director_id (required — the existing director\'s ID)',
        share_transfer: 'Fields used on implement: shareholder_id (optional — if omitted, no automatic register update is made, event only)',
        registered_address_change: 'Fields used on implement: registered_address (required)',
        postal_address_change: 'Fields used on implement: postal_address (required)',
        company_secretary_change: 'Fields used on implement: company_secretary (required)',
        auditor_change: 'Fields used on implement: auditor (required)',
        company_status_change: 'Fields used on implement: company_status (required — active/dormant/deregistration_process/deregistered/in_liquidation/other)',
        annual_return: 'Fields used on implement: return_year (required), due_date, submission_date, status, reference',
        share_issue: 'No automatic register update supported for this change type — implementation requires manual: true + manual_reason.',
        share_cancellation: 'No automatic register update supported for this change type — implementation requires manual: true + manual_reason.',
        company_name_change: 'No automatic register update supported — company name is client master data, edited via the Clients page. Implementation requires manual: true + manual_reason.',
        financial_year_end_change: 'No automatic register update supported — financial year-end lives on the Taxpayer Profile. Implementation requires manual: true + manual_reason.',
        accounting_officer_change: 'No automatic register update supported (no exact matching field). Implementation requires manual: true + manual_reason.',
        public_officer_change: 'No automatic register update supported (no matching field exists). Implementation requires manual: true + manual_reason.',
        custom: 'No default checklist or automatic implementation for custom cases. Implementation requires manual: true + manual_reason.',
    };
    var EV_LABELS = {
        change_case_created: 'Case Created', change_case_updated: 'Case Updated',
        checklist_generated: 'Checklist Generated', checklist_item_updated: 'Checklist Item Updated',
        submitted_for_review: 'Submitted for Review', change_approved: 'Approved', change_rejected: 'Rejected',
        change_implemented: 'Implemented', change_completed: 'Completed', change_cancelled: 'Cancelled',
        register_updated: 'Register Updated', timeline_event_created: 'Timeline Event Created',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _statusPill(s) { return '<span class="pill cs-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function swLoadAll() {
        _loadSummary();
        _loadClientOptions();
        swLoadCases();
        swUpdatePayloadHint();
    }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.total || 0, label: 'Total Cases' },
                    { count: d.active || 0, label: 'Active' },
                    { count: d.approved_awaiting_implementation || 0, label: 'Awaiting Implementation' },
                    { count: d.overdue_for_implementation || 0, label: 'Overdue for Implementation' },
                    { count: (d.by_status || {}).ready_for_review || 0, label: 'Ready for Review' },
                    { count: (d.by_status || {}).completed || 0, label: 'Completed' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientOptions() {
        window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var sel = document.getElementById('cfClient');
                sel.innerHTML = (d.clients || []).map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    function swUpdatePayloadHint() {
        var type = document.getElementById('cfType').value;
        document.getElementById('cfPayloadHint').textContent = PAYLOAD_HINTS[type] || '';
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function swLoadCases() {
        var status = document.getElementById('swStatusFilter').value;
        var type = document.getElementById('swTypeFilter').value;
        var qs = [];
        if (status) qs.push('case_status=' + encodeURIComponent(status));
        if (type) qs.push('change_type=' + encodeURIComponent(type));
        window.PracticeAPI.fetch(BASE + '/' + (qs.length ? '?' + qs.join('&') : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.cases || [];
                if (!rows.length) { document.getElementById('casesBody').innerHTML = '<tr><td colspan="6" class="empty-state">No change cases found.</td></tr>'; return; }
                document.getElementById('casesBody').innerHTML = rows.map(function (c) {
                    return '<tr class="case-row" onclick="swOpenDetail(' + c.id + ')">' +
                        '<td>' + _html(c.client_name) + '</td><td>' + _html(c.change_title) + '</td>' +
                        '<td>' + _html(TYPE_LABELS[c.change_type] || c.change_type) + '</td><td>' + _statusPill(c.case_status) + '</td>' +
                        '<td>' + _fmtDate(c.requested_date) + '</td><td>' + _fmtDate(c.effective_date) + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('casesBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    // ── Create ────────────────────────────────────────────────────────────────

    function swOpenCreate() { document.getElementById('createModal').classList.add('open'); }
    function swCloseCreate() { document.getElementById('createModal').classList.remove('open'); }
    function swSubmitCreate() {
        var payloadRaw = document.getElementById('cfPayload').value.trim();
        var payload = {};
        if (payloadRaw) {
            try { payload = JSON.parse(payloadRaw); } catch (e) { _showToast('Payload must be valid JSON.'); return; }
        }
        var body = {
            client_id: document.getElementById('cfClient').value,
            change_type: document.getElementById('cfType').value,
            change_title: document.getElementById('cfTitle').value,
            change_summary: document.getElementById('cfSummary').value || null,
            requested_by_name: document.getElementById('cfRequestedBy').value || null,
            requested_date: document.getElementById('cfRequestedDate').value || null,
            effective_date: document.getElementById('cfEffectiveDate').value || null,
            payload: payload,
            notes: document.getElementById('cfNotes').value || null,
        };
        if (!body.client_id) { _showToast('Client is required.'); return; }
        if (!body.change_title) { _showToast('Change title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Change case created.'); swCloseCreate(); swLoadCases(); _loadSummary(); swOpenDetail(d.case.id); })
            .catch(function () { _showToast('Failed to create change case.'); });
    }

    // ── Detail ────────────────────────────────────────────────────────────────

    function swOpenDetail(id) {
        _currentCaseId = id;
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderDetail(d);
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load case detail.'); });
    }
    function swCloseDetail() { document.getElementById('detailModal').classList.remove('open'); swLoadCases(); _loadSummary(); }

    function _renderDetail(d) {
        var c = d.case;
        var html = '<div class="modal-title">' + _html(c.change_title) + ' ' + _statusPill(c.case_status) + '</div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(d.client ? d.client.name : '') + ' &middot; ' + _html(TYPE_LABELS[c.change_type] || c.change_type) +
            ' &middot; Effective: ' + _fmtDate(c.effective_date) + '</div>';

        html += _renderActionBar(c);

        html += '<div class="detail-tab-bar" id="detailTabBar"></div>';
        html += '<div class="detail-tab-panel active" id="dpanel-checklist"><div id="checklistBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-payload"><pre style="white-space:pre-wrap;font-size:.78rem;background:#12122a;padding:12px;border-radius:8px;">' + _html(JSON.stringify(c.payload || {}, null, 2)) + '</pre>' +
            (c.change_summary ? '<div class="mini-card">' + _html(c.change_summary) + '</div>' : '') +
            (c.rejection_reason ? '<div class="mini-card" style="border-left:3px solid #fc8181;">Rejection reason: ' + _html(c.rejection_reason) + '</div>' : '') +
            (c.after_snapshot ? '<div class="detail-section-title" style="margin-top:12px;font-size:.78rem;color:#718096;">After Snapshot</div><pre style="white-space:pre-wrap;font-size:.76rem;background:#12122a;padding:12px;border-radius:8px;">' + _html(JSON.stringify(c.after_snapshot, null, 2)) + '</pre>' : '') +
            '</div>';
        html += '<div class="detail-tab-panel" id="dpanel-governance"><div id="governanceBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-events"><div id="eventsBody"></div></div>';

        document.getElementById('detailBody').innerHTML = html;
        _detailTab = 'checklist';
        _renderDetailTabBar();
        _loadChecklist(c.id);
        _loadEvents(c.id);
        _loadGovernanceLinks(c.id);
    }

    function _renderActionBar(c) {
        var btns = [];
        if (['draft', 'preparing', 'awaiting_documents'].includes(c.case_status)) {
            btns.push('<button class="btn-action btn-secondary" onclick="swGenerateChecklist(' + c.id + ')">Generate Checklist</button>');
            btns.push('<button class="btn-action btn-primary" onclick="swSubmitReview(' + c.id + ')">Submit for Review</button>');
        }
        if (c.case_status === 'ready_for_review') {
            btns.push('<button class="btn-action btn-success" onclick="swOpenApprove(' + c.id + ')">Approve</button>');
            btns.push('<button class="btn-action btn-danger" onclick="swOpenReject(' + c.id + ')">Reject</button>');
        }
        if (c.case_status === 'approved') {
            btns.push('<button class="btn-action btn-primary" onclick="swOpenImplement(' + c.id + ')">Implement</button>');
            btns.push('<button class="btn-action btn-danger" onclick="swOpenReject(' + c.id + ')">Reject</button>');
        }
        if (c.case_status === 'implemented') {
            btns.push('<button class="btn-action btn-success" onclick="swOpenComplete(' + c.id + ')">Complete</button>');
        }
        if (!['completed', 'cancelled'].includes(c.case_status)) {
            btns.push('<button class="btn-action btn-secondary" onclick="swCancelCase(' + c.id + ')">Cancel Case</button>');
        }
        // Codebox 64 — quick actions into Secretarial Governance, pre-filled
        // via deep link (?create=resolution|meeting&client_id=&change_case_id=).
        // Available at any stage — governance evidence can be prepared
        // alongside the case, not gated by case_status.
        btns.push('<button class="btn-action btn-secondary" onclick="swCreateGovernance(\'resolution\',' + c.id + ',' + c.client_id + ')">+ Create Resolution</button>');
        btns.push('<button class="btn-action btn-secondary" onclick="swCreateGovernance(\'meeting\',' + c.id + ',' + c.client_id + ')">+ Create Meeting</button>');
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function swCreateGovernance(kind, changeCaseId, clientId) {
        window.location.href = '/practice/secretarial-governance.html?create=' + kind + '&client_id=' + clientId + '&change_case_id=' + changeCaseId;
    }

    function _renderDetailTabBar() {
        var tabs = [['checklist', 'Checklist'], ['payload', 'Change Details'], ['governance', 'Governance'], ['events', 'Events']];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="detail-tab-btn' + (t[0] === _detailTab ? ' active' : '') + '" onclick="swSetDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.detail-tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'dpanel-' + _detailTab); });
    }
    function swSetDetailTab(tab) { _detailTab = tab; _renderDetailTabBar(); }

    // Codebox 64 — linked governance records (resolutions/meetings/decisions),
    // reused via GET /secretarial-governance/* filtered by change_case_id.
    // No duplicate governance logic in this file.
    function _loadGovernanceLinks(caseId) {
        var GOV_BASE = '/api/practice/secretarial-governance';
        Promise.all([
            window.PracticeAPI.fetch(GOV_BASE + '/resolutions?change_case_id=' + caseId).then(function (r) { return r.json(); }).catch(function () { return { resolutions: [] }; }),
            window.PracticeAPI.fetch(GOV_BASE + '/meetings?change_case_id=' + caseId).then(function (r) { return r.json(); }).catch(function () { return { meetings: [] }; }),
            window.PracticeAPI.fetch(GOV_BASE + '/decisions?change_case_id=' + caseId).then(function (r) { return r.json(); }).catch(function () { return { decisions: [] }; }),
        ]).then(function (results) {
            var resolutions = results[0].resolutions || [], meetings = results[1].meetings || [], decisions = results[2].decisions || [];
            var html = '';
            html += '<div class="mini-card-meta" style="margin-bottom:8px;">Resolutions</div>';
            html += resolutions.length ? resolutions.map(function (r) { return '<div class="mini-card">' + _html(r.resolution_title) + ' <span class="pill">' + _html(r.resolution_status) + '</span></div>'; }).join('') : '<div class="empty-state">None linked.</div>';
            html += '<div class="mini-card-meta" style="margin:12px 0 8px;">Meetings</div>';
            html += meetings.length ? meetings.map(function (m) { return '<div class="mini-card">' + _html(m.meeting_title) + ' <span class="pill">' + _html(m.meeting_status) + '</span></div>'; }).join('') : '<div class="empty-state">None linked.</div>';
            html += '<div class="mini-card-meta" style="margin:12px 0 8px;">Decisions</div>';
            html += decisions.length ? decisions.map(function (d) { return '<div class="mini-card">' + _html(d.decision_title) + ' <span class="pill">' + _html(d.decision_status) + '</span></div>'; }).join('') : '<div class="empty-state">None linked.</div>';
            document.getElementById('governanceBody').innerHTML = html;
        }).catch(function () { document.getElementById('governanceBody').innerHTML = '<div class="empty-state">Failed to load governance links.</div>'; });
    }

    // ── Checklist ─────────────────────────────────────────────────────────────

    function _loadChecklist(caseId) {
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/checklist')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.checklist || [];
                document.getElementById('checklistBody').innerHTML = rows.length ? rows.map(function (i) {
                    return '<div class="checklist-row' + (i.completed ? ' completed' : '') + '">' +
                        '<input type="checkbox" ' + (i.completed ? 'checked' : '') + ' onchange="swToggleChecklistItem(' + caseId + ',' + i.id + ',this.checked)" />' +
                        '<span class="pill ci-' + _html(i.item_type) + '">' + _html(i.item_type) + '</span>' +
                        '<span class="ci-name">' + _html(i.item_name) + (i.required ? '' : ' (optional)') + '</span>' +
                        '</div>';
                }).join('') : '<div class="empty-state">No checklist yet — click "Generate Checklist" above.</div>';
            })
            .catch(function () { document.getElementById('checklistBody').innerHTML = '<div class="empty-state">Failed to load checklist.</div>'; });
    }

    function swGenerateChecklist(caseId) {
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/generate-checklist', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(d.message || 'Checklist generated.'); _loadChecklist(caseId); })
            .catch(function () { _showToast('Failed to generate checklist.'); });
    }

    function swToggleChecklistItem(caseId, itemId, completed) {
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/checklist/' + itemId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: completed }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); _loadChecklist(caseId); return; } _loadChecklist(caseId); })
            .catch(function () { _showToast('Failed to update checklist item.'); });
    }

    // ── Workflow actions ──────────────────────────────────────────────────────

    function swSubmitReview(caseId) {
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/submit-review', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Submitted for review.'); swOpenDetail(caseId); })
            .catch(function () { _showToast('Failed to submit for review.'); });
    }

    function swOpenApprove(caseId) {
        document.getElementById('apReason').value = '';
        document.getElementById('approveWarn').style.display = 'none';
        document.getElementById('approveModal').dataset.caseId = caseId;
        document.getElementById('approveModal').classList.add('open');
    }
    function swCloseApprove() { document.getElementById('approveModal').classList.remove('open'); }
    function swSubmitApprove() {
        var caseId = parseInt(document.getElementById('approveModal').dataset.caseId);
        var reason = document.getElementById('apReason').value || undefined;
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/approve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ override_reason: reason }) })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (res) {
                if (res.body.error) {
                    if (res.status === 400 && res.body.incomplete_count) {
                        document.getElementById('approveWarn').style.display = 'block';
                        document.getElementById('approveWarn').textContent = res.body.error;
                        return;
                    }
                    _showToast(res.body.error); return;
                }
                _showToast('Change case approved.'); swCloseApprove(); swOpenDetail(caseId);
            })
            .catch(function () { _showToast('Failed to approve.'); });
    }

    function swOpenReject(caseId) {
        document.getElementById('rjReason').value = '';
        document.getElementById('rejectModal').dataset.caseId = caseId;
        document.getElementById('rejectModal').classList.add('open');
    }
    function swCloseReject() { document.getElementById('rejectModal').classList.remove('open'); }
    function swSubmitReject() {
        var caseId = parseInt(document.getElementById('rejectModal').dataset.caseId);
        var reason = document.getElementById('rjReason').value;
        if (!reason) { _showToast('Rejection reason is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/reject', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rejection_reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Change case rejected.'); swCloseReject(); swOpenDetail(caseId); })
            .catch(function () { _showToast('Failed to reject.'); });
    }

    function swOpenImplement(caseId) {
        document.getElementById('imEffectiveDate').value = '';
        document.getElementById('imManual').checked = false;
        document.getElementById('imManualReason').value = '';
        document.getElementById('imManualReasonGroup').style.display = 'none';
        document.getElementById('implementModal').dataset.caseId = caseId;
        document.getElementById('implementModal').classList.add('open');
    }
    function swCloseImplement() { document.getElementById('implementModal').classList.remove('open'); }
    function swToggleManualReason() {
        document.getElementById('imManualReasonGroup').style.display = document.getElementById('imManual').checked ? 'block' : 'none';
    }
    function swSubmitImplement() {
        var caseId = parseInt(document.getElementById('implementModal').dataset.caseId);
        var body = { effective_date: document.getElementById('imEffectiveDate').value || undefined };
        if (document.getElementById('imManual').checked) {
            body.manual = true;
            body.manual_reason = document.getElementById('imManualReason').value;
            if (!body.manual_reason) { _showToast('Manual reason is required.'); return; }
        }
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/implement', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (res) {
                if (res.body.error) {
                    if (res.status === 422) { _showToast(res.body.error + ' (tick "Implement manually" if you updated the register outside this system.)'); return; }
                    _showToast(res.body.error); return;
                }
                _showToast(res.body.skipped_mutation ? 'Case marked implemented (no automatic register update).' : 'Case implemented — register updated.');
                swCloseImplement(); swOpenDetail(caseId);
            })
            .catch(function () { _showToast('Failed to implement.'); });
    }

    function swOpenComplete(caseId) {
        document.getElementById('cmReason').value = '';
        document.getElementById('completeModal').dataset.caseId = caseId;
        document.getElementById('completeModal').classList.add('open');
    }
    function swCloseComplete() { document.getElementById('completeModal').classList.remove('open'); }
    function swSubmitComplete() {
        var caseId = parseInt(document.getElementById('completeModal').dataset.caseId);
        var reason = document.getElementById('cmReason').value || undefined;
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/complete', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completion_reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Change case completed.'); swCloseComplete(); swOpenDetail(caseId); })
            .catch(function () { _showToast('Failed to complete.'); });
    }

    function swCancelCase(caseId) {
        window.PracticeAPI.fetch(BASE + '/' + caseId, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Change case cancelled.'); swOpenDetail(caseId); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function _loadEvents(caseId) {
        window.PracticeAPI.fetch(BASE + '/' + caseId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('eventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) +
                        '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<div class="empty-state">Failed to load events.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.swLoadCases = swLoadCases;
    window.swUpdatePayloadHint = swUpdatePayloadHint;
    window.swOpenCreate = swOpenCreate;
    window.swCloseCreate = swCloseCreate;
    window.swSubmitCreate = swSubmitCreate;
    window.swOpenDetail = swOpenDetail;
    window.swCloseDetail = swCloseDetail;
    window.swSetDetailTab = swSetDetailTab;
    window.swGenerateChecklist = swGenerateChecklist;
    window.swToggleChecklistItem = swToggleChecklistItem;
    window.swSubmitReview = swSubmitReview;
    window.swOpenApprove = swOpenApprove;
    window.swCloseApprove = swCloseApprove;
    window.swSubmitApprove = swSubmitApprove;
    window.swOpenReject = swOpenReject;
    window.swCloseReject = swCloseReject;
    window.swSubmitReject = swSubmitReject;
    window.swOpenImplement = swOpenImplement;
    window.swCloseImplement = swCloseImplement;
    window.swToggleManualReason = swToggleManualReason;
    window.swSubmitImplement = swSubmitImplement;
    window.swOpenComplete = swOpenComplete;
    window.swCloseComplete = swCloseComplete;
    window.swSubmitComplete = swSubmitComplete;
    window.swCancelCase = swCancelCase;
    window.swCreateGovernance = swCreateGovernance;

    document.addEventListener('DOMContentLoaded', swLoadAll);
})();
