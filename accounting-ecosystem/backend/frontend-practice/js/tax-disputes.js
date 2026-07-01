/* Codebox 44 — Tax Disputes / Corrections / Objections
 * NOT SARS API. NOT eFiling. Manual internal tracking only.
 * Prefix: td
 */
(function () {
    'use strict';

    var BASE     = '/api/practice/tax-disputes';
    var _currentId   = null;
    var _currentCase = null;
    var _currentTab  = 'overview';
    var _submitting  = false;
    var _actionType  = null;
    var _page        = 1;

    // ── Constants ────────────────────────────────────────────────────────────

    var STATUS_LABELS = {
        open: 'Open', pending_submission: 'Pending Submission',
        submitted: 'Submitted', acknowledged: 'Acknowledged',
        under_review: 'Under Review', response_received: 'Response Received',
        accepted: 'Accepted', rejected: 'Rejected',
        escalated: 'Escalated', appealing: 'Appealing',
        completed: 'Completed', cancelled: 'Cancelled',
    };

    var TYPE_LABELS = {
        correction: 'Correction', objection: 'Objection',
        noo: 'NOO', adr: 'ADR', appeal: 'Appeal',
        tax_court: 'Tax Court', manual_review: 'Manual Review',
    };

    var PRI_LABELS = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

    var EV_LABELS = {
        dispute_case_created: 'Case Created', dispute_case_updated: 'Updated',
        dispute_submitted: 'Submitted', dispute_acknowledged: 'Acknowledged',
        dispute_response_received: 'Response Received', dispute_accepted: 'Accepted',
        dispute_rejected: 'Rejected', dispute_escalated: 'Escalated',
        dispute_completed: 'Completed', dispute_case_cancelled: 'Cancelled',
        evidence_added: 'Evidence Added', evidence_removed: 'Evidence Removed',
        evidence_verified: 'Evidence Verified',
    };

    var TAX_LABELS = {
        itr12: 'ITR12', itr14: 'ITR14', irp6: 'IRP6',
        emp201: 'EMP201', emp501: 'EMP501', vat201: 'VAT201', other: 'Other',
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(s)     { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _money(n)   { return n != null ? 'R ' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }

    function _statusPill(s) {
        return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>';
    }

    function _typeBadge(t) {
        return '<span class="ct-badge ct-' + _html(t) + '">' + _html(TYPE_LABELS[t] || t) + '</span>';
    }

    function _priClass(p) { return 'pri-' + (p || 'medium'); }

    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    function _qs() {
        var p = [];
        var caseType  = document.getElementById('filterCaseType').value;
        var status    = document.getElementById('filterStatus').value;
        var priority  = document.getElementById('filterPriority').value;
        var taxType   = document.getElementById('filterTaxType').value;
        var clientId  = document.getElementById('filterClientId').value.trim();
        var subId     = document.getElementById('filterSubmissionId').value.trim();
        var dateFrom  = document.getElementById('filterDateFrom').value;
        var dateTo    = document.getElementById('filterDateTo').value;
        var search    = document.getElementById('filterSearch').value.trim();
        var activeOnly = document.getElementById('filterActiveOnly').checked;
        if (caseType)  p.push('case_type='    + encodeURIComponent(caseType));
        if (status)    p.push('case_status='  + encodeURIComponent(status));
        if (priority)  p.push('priority='     + encodeURIComponent(priority));
        if (taxType)   p.push('tax_type='     + encodeURIComponent(taxType));
        if (clientId)  p.push('client_id='    + encodeURIComponent(clientId));
        if (subId)     p.push('submission_id='+ encodeURIComponent(subId));
        if (dateFrom)  p.push('date_from='    + encodeURIComponent(dateFrom));
        if (dateTo)    p.push('date_to='      + encodeURIComponent(dateTo));
        if (search)    p.push('search='       + encodeURIComponent(search));
        if (activeOnly) p.push('active=1');
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function tdLoad() {
        _page = 1;
        _loadSummary();
        _loadList();
        _checkUrlParams();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var subId    = params.get('submission_id');
        var clientId = params.get('client_id');
        var caseType = params.get('case_type');
        if (subId)    { document.getElementById('filterSubmissionId').value = subId; }
        if (clientId) { document.getElementById('filterClientId').value = clientId; }
        if (caseType) { document.getElementById('filterCaseType').value = caseType; }
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {});
    }

    function _renderSummary(d) {
        var grid = document.getElementById('summaryGrid');
        var cards = [
            { cls: 'sc-open',      count: d.open_count || 0,                 label: 'Open Cases',     filter: null },
            { cls: 'sc-overdue',   count: d.overdue_count || 0,              label: 'Overdue',        filter: null },
            { cls: 'sc-submitted', count: (d.by_status && d.by_status.submitted) || 0,   label: 'Submitted',  filter: 'submitted' },
            { cls: 'sc-response',  count: (d.by_status && d.by_status.response_received) || 0, label: 'Response Received', filter: 'response_received' },
            { cls: 'sc-completed', count: (d.by_status && d.by_status.completed) || 0,  label: 'Completed',  filter: 'completed' },
            { cls: 'sc-cancelled', count: (d.by_status && d.by_status.cancelled) || 0,  label: 'Cancelled',  filter: 'cancelled' },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card ' + c.cls + '" onclick="' + (c.filter ? '_tdFilterStatus(\'' + c.filter + '\')' : '') + '">' +
                '<div class="sc-count">' + c.count + '</div>' +
                '<div class="sc-label">' + c.label + '</div>' +
            '</div>';
        }).join('');

        // Type strip
        if (d.by_type) {
            var strip = document.getElementById('typeStrip');
            var types = ['correction','objection','noo','adr','appeal','tax_court','manual_review'];
            strip.innerHTML = types.map(function (t) {
                var cnt = d.by_type[t] || 0;
                return '<div class="ts-item" onclick="_tdFilterType(\'' + t + '\')">' +
                    _html(TYPE_LABELS[t] || t) +
                    '<span class="ts-count">' + cnt + '</span>' +
                '</div>';
            }).join('');
        }
    }

    function _tdFilterStatus(s) {
        document.getElementById('filterStatus').value = s;
        _page = 1;
        _loadList();
    }

    function _tdFilterType(t) {
        document.getElementById('filterCaseType').value = t;
        _page = 1;
        _loadList();
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="9">Loading…</td></tr>';
        PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.cases || [], d.total || 0, d.page || 1, d.per_page || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="9" style="color:#fc8181;">Failed to load dispute cases</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No dispute cases found. Open a case to start tracking.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (c) {
            var deadline = c.submission_deadline || c.response_deadline;
            var today    = new Date().toISOString().slice(0, 10);
            var isOverdue = deadline && deadline < today && !['completed','cancelled'].includes(c.case_status);
            return '<tr onclick="tdOpenDetail(' + c.id + ')">' +
                '<td style="color:#4a5568;font-size:.78rem;">#' + c.id + '</td>' +
                '<td>' + _typeBadge(c.case_type) + '</td>' +
                '<td>' + _statusPill(c.case_status) + '</td>' +
                '<td class="td-title" title="' + _html(c.title) + '">' + _html(c.title) + '</td>' +
                '<td style="font-size:.8rem;">' + _html(c.client_name || ('#' + c.client_id)) + '</td>' +
                '<td><span style="font-size:.78rem;color:#718096;">' + _html(TAX_LABELS[c.tax_type] || c.tax_type || '—') + '</span></td>' +
                '<td style="font-size:.8rem;">' + _html(c.tax_year || '—') + '</td>' +
                '<td><span class="' + _priClass(c.priority) + '">' + _html(PRI_LABELS[c.priority] || c.priority || '—') + '</span></td>' +
                '<td style="font-size:.78rem;' + (isOverdue ? 'color:#fc8181;font-weight:700;' : 'color:#718096;') + '">' + (deadline ? _fmtDate(deadline) : '—') + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_tdPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_tdPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' case' + (total !== 1 ? 's' : '');
        }
    }

    function _tdPage(p) { _page = p; _loadList(); }

    // ── Filters ───────────────────────────────────────────────────────────────

    function tdClearFilters() {
        ['filterCaseType','filterStatus','filterPriority','filterTaxType',
         'filterClientId','filterSubmissionId','filterDateFrom','filterDateTo','filterSearch'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        document.getElementById('filterActiveOnly').checked = false;
        _page = 1;
        _loadList();
    }

    // ── Create Case ───────────────────────────────────────────────────────────

    function tdOpenCreate() {
        // Pre-fill from URL params
        var params = new URLSearchParams(window.location.search);
        var subId     = params.get('submission_id') || document.getElementById('filterSubmissionId').value;
        var clientId  = params.get('client_id')     || document.getElementById('filterClientId').value;
        var caseType  = params.get('case_type');
        if (subId)    { document.getElementById('createSubmissionId').value = subId; document.getElementById('createSourceId').value = subId; document.getElementById('createSourceType').value = 'tax_submission'; }
        if (clientId) { document.getElementById('createClientId').value = clientId; }
        if (caseType) { document.getElementById('createCaseType').value = caseType; }
        document.getElementById('createDateOpened').value = new Date().toISOString().slice(0, 10);
        document.getElementById('createModal').classList.add('open');
    }

    function tdCloseCreate() {
        document.getElementById('createModal').classList.remove('open');
    }

    function tdSubmitCreate() {
        if (_submitting) return;
        var caseType  = document.getElementById('createCaseType').value;
        var sourceType = document.getElementById('createSourceType').value;
        var clientId  = document.getElementById('createClientId').value.trim();
        var title     = document.getElementById('createTitle').value.trim();
        if (!caseType)  return _showToast('Case type is required');
        if (!clientId)  return _showToast('Client ID is required');
        if (!title)     return _showToast('Title is required');

        var payload = {
            case_type:             caseType,
            source_type:           sourceType,
            source_id:             document.getElementById('createSourceId').value.trim() || null,
            client_id:             Number(clientId),
            title:                 title,
            tax_type:              document.getElementById('createTaxType').value      || null,
            tax_year:              document.getElementById('createTaxYear').value.trim() || null,
            assessment_reference:  document.getElementById('createAssessmentRef').value.trim() || null,
            submission_id:         document.getElementById('createSubmissionId').value.trim() ? Number(document.getElementById('createSubmissionId').value.trim()) : null,
            date_opened:           document.getElementById('createDateOpened').value   || null,
            submission_deadline:   document.getElementById('createSubDeadline').value  || null,
            response_deadline:     document.getElementById('createRespDeadline').value || null,
            priority:              document.getElementById('createPriority').value     || 'medium',
            notes:                 document.getElementById('createNotes').value.trim() || null,
        };

        _submitting = true;
        PracticeAPI.fetch(BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) {
                if (r.status === 409) {
                    _showToast('Duplicate: active case already exists (ID #' + r.data.existing_case_id + ')');
                } else {
                    _showToast(r.data.error || 'Failed to create case');
                }
                return;
            }
            _showToast('Case created');
            tdCloseCreate();
            // reset form
            ['createCaseType','createSourceType','createSourceId','createClientId','createTitle',
             'createTaxType','createTaxYear','createAssessmentRef','createSubmissionId',
             'createDateOpened','createSubDeadline','createRespDeadline','createNotes'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('createPriority').value = 'medium';
            tdLoad();
        })
        .catch(function () { _submitting = false; _showToast('Network error — could not create case'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function tdOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentCase = d.case;
                _renderTabBar(_currentCase);
                _activateTab('overview');
                _renderFooter(_currentCase);
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load case</div>';
            });
    }

    function tdCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId   = null;
        _currentCase = null;
    }

    function _renderTabBar(c) {
        var tabs = [
            { key: 'overview',  label: 'Overview'  },
            { key: 'evidence',  label: 'Evidence'  },
            { key: 'events',    label: 'Events'    },
        ];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="tdOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function tdOpenTab(tab) {
        _currentTab = tab;
        if (_currentCase) {
            _activateTab(tab);
            _renderTabBar(_currentCase);
        }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        switch (tab) {
            case 'overview': _renderOverviewTab(_currentCase, body); break;
            case 'evidence': _loadEvidenceTab(body);                 break;
            case 'events':   _loadEventsTab(body);                   break;
        }
    }

    // ── Overview tab ──────────────────────────────────────────────────────────

    function _renderOverviewTab(c, body) {
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dRow('Type',           _typeBadge(c.case_type));
        html += _dRow('Status',         _statusPill(c.case_status));
        html += _dRow('Client',         _html(c.client_name || ('#' + c.client_id)));
        html += _dRow('Priority',       '<span class="' + _priClass(c.priority) + '">' + _html(PRI_LABELS[c.priority] || c.priority || '—') + '</span>');
        html += _dRow('Tax Type',       _html(TAX_LABELS[c.tax_type] || c.tax_type || '—'));
        html += _dRow('Tax Year',       _html(c.tax_year || '—'));
        html += _dRow('Source Type',    _html(c.source_type || '—'));
        html += _dRow('Source ID',      _html(c.source_id  || '—'));
        html += _dRow('Submission ID',  _html(c.submission_id || '—'));
        html += _dRow('Assessment Ref', _html(c.assessment_reference || '—'));
        html += _dRow('SARS Case #',    _html(c.sars_case_number || '—'));
        html += _dRow('SARS Dispute Ref', _html(c.sars_dispute_reference || '—'));
        html += _dRow('Date Opened',    _fmtDate(c.date_opened));
        html += _dRow('Sub Deadline',   _fmtDate(c.submission_deadline));
        html += _dRow('Resp Deadline',  _fmtDate(c.response_deadline));
        html += _dRow('SARS Resp Date', _fmtDate(c.sars_response_date));
        html += '</div>';
        if (c.outcome || c.outcome_amount != null || c.outcome_notes) {
            html += '<div class="section-label">Outcome</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:12px;font-size:.82rem;">';
            if (c.outcome)        html += '<div><strong>Outcome:</strong> ' + _html(c.outcome) + '</div>';
            if (c.outcome_amount != null) html += '<div><strong>Amount:</strong> ' + _money(c.outcome_amount) + '</div>';
            if (c.outcome_notes)  html += '<div style="margin-top:6px;color:#a0aec0;">' + _html(c.outcome_notes) + '</div>';
            html += '</div>';
        }
        if (c.notes) {
            html += '<div class="section-label">Notes</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(c.notes) + '</div>';
        }
        if (c.submission_id) {
            html += '<div style="margin-top:14px;">';
            html += '<a href="/practice/tax-submissions.html?submission_id=' + c.submission_id + '" style="font-size:.8rem;color:#667eea;text-decoration:none;">View Tax Submission #' + c.submission_id + ' ↗</a>';
            html += '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dRow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + label + '</div><div class="detail-value">' + (value || '—') + '</div></div>';
    }

    // ── Evidence tab ──────────────────────────────────────────────────────────

    function _loadEvidenceTab(body) {
        body.innerHTML = '<div class="loading-state">Loading evidence…</div>';
        PracticeAPI.fetch(BASE + '/' + _currentId + '/evidence')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEvidenceTab(d.evidence || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load evidence</div>'; });
    }

    function _renderEvidenceTab(items, body) {
        var html = '<div class="tab-content">';
        html += '<div style="margin-bottom:10px;">';
        if (!['cancelled'].includes(_currentCase && _currentCase.case_status)) {
            html += '<button type="button" class="btn-action btn-success btn-sm" onclick="tdOpenAction(\'add-evidence\')">+ Add Evidence</button>';
        }
        html += '</div>';
        if (!items.length) {
            html += '<div class="inline-msg info">No evidence records yet.</div>';
        } else {
            items.forEach(function (ev) {
                html += '<div class="evidence-item">';
                html += '<div class="evidence-item-header">';
                html += '<span class="evidence-title">' + _html(ev.evidence_title) + '</span>';
                html += ev.is_verified
                    ? '<span class="verified-badge">Verified</span>'
                    : '<span class="unverified-badge">Unverified</span>';
                html += '<span class="subtype-badge">' + _html(ev.evidence_type) + '</span>';
                html += '</div>';
                if (ev.evidence_note)       html += '<div class="evidence-meta">' + _html(ev.evidence_note) + '</div>';
                if (ev.external_reference)  html += '<div class="evidence-meta">Ref: ' + _html(ev.external_reference) + '</div>';
                if (ev.evidence_date)       html += '<div class="evidence-meta">Date: ' + _fmtDate(ev.evidence_date) + '</div>';
                html += '<div style="display:flex;gap:8px;margin-top:8px;">';
                if (!ev.is_verified) {
                    html += '<button type="button" class="btn-action btn-primary btn-sm" onclick="tdVerifyEvidence(' + ev.id + ')">Verify</button>';
                }
                html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="tdDeleteEvidence(' + ev.id + ')">Remove</button>';
                html += '</div></div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function tdVerifyEvidence(evidenceId) {
        PracticeAPI.fetch(BASE + '/' + _currentId + '/evidence/' + evidenceId + '/verify', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to verify');
                _showToast('Evidence verified');
                _loadEvidenceTab(document.getElementById('detailBody'));
            })
            .catch(function () { _showToast('Network error'); });
    }

    function tdDeleteEvidence(evidenceId) {
        if (!window.confirm('Remove this evidence record?')) return;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/evidence/' + evidenceId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to remove');
                _showToast('Evidence removed');
                _loadEvidenceTab(document.getElementById('detailBody'));
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Events tab ────────────────────────────────────────────────────────────

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        PracticeAPI.fetch(BASE + '/' + _currentId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTab(d.events || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load events</div>'; });
    }

    function _renderEventsTab(items, body) {
        var html = '<div class="tab-content">';
        if (!items.length) {
            html += '<div class="inline-msg info">No events recorded yet.</div>';
        } else {
            items.forEach(function (ev) {
                html += '<div class="event-item">';
                html += '<div class="event-header">';
                html += '<span class="event-type">' + _html(EV_LABELS[ev.event_type] || ev.event_type) + '</span>';
                html += '<span class="event-time">' + _fmt(ev.created_at) + '</span>';
                html += '</div>';
                if (ev.old_status || ev.new_status) {
                    html += '<div class="event-status-change">';
                    if (ev.old_status) html += _statusPill(ev.old_status);
                    if (ev.old_status && ev.new_status) html += '<span class="event-arrow">→</span>';
                    if (ev.new_status) html += _statusPill(ev.new_status);
                    html += '</div>';
                }
                if (ev.notes) html += '<div class="event-notes">' + _html(ev.notes) + '</div>';
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    // ── Detail footer ─────────────────────────────────────────────────────────

    function _renderFooter(c) {
        var s    = c.case_status;
        var term = ['completed', 'cancelled'].includes(s);
        var html = '<button type="button" class="btn-action btn-secondary" onclick="tdCloseDetail()">Close</button>';

        if (!term) {
            // Status-driven action buttons
            if (['open', 'pending_submission', 'acknowledged', 'escalated'].includes(s))
                html += '<button type="button" class="btn-action btn-primary" onclick="tdOpenAction(\'mark-submitted\')">Mark Submitted</button>';
            if (['submitted', 'escalated', 'appealing'].includes(s))
                html += '<button type="button" class="btn-action btn-primary" onclick="tdOpenAction(\'record-acknowledgement\')">Record Acknowledgement</button>';
            if (['submitted', 'acknowledged', 'under_review', 'escalated', 'appealing'].includes(s))
                html += '<button type="button" class="btn-action btn-warning" onclick="tdOpenAction(\'record-response\')">Record Response</button>';
            if (['response_received', 'under_review', 'acknowledged', 'escalated'].includes(s))
                html += '<button type="button" class="btn-action btn-success" onclick="tdOpenAction(\'accept\')">Accept</button>';
            if (['response_received', 'under_review', 'acknowledged', 'escalated'].includes(s))
                html += '<button type="button" class="btn-action btn-danger" onclick="tdOpenAction(\'reject\')">Reject</button>';
            html += '<button type="button" class="btn-action btn-purple" onclick="tdOpenAction(\'escalate\')">Escalate</button>';
            html += '<button type="button" class="btn-action btn-success" onclick="tdOpenAction(\'complete\')">Complete</button>';
            html += '<button type="button" class="btn-action btn-secondary" onclick="tdOpenAction(\'add-evidence\')">Add Evidence</button>';
            html += '<button type="button" class="btn-action btn-danger" onclick="tdCancelCase()">Cancel Case</button>';
        }

        if (c.submission_id) {
            html += '<a href="/practice/tax-disputes.html?submission_id=' + encodeURIComponent(c.submission_id) + '" ' +
                'style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d3748;color:#e2e8f0;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;gap:6px;" ' +
                'title="All disputes for this submission">All Sub Disputes ↗</a>';
        }

        document.getElementById('detailFooter').innerHTML = html;
    }

    // ── Action Modal ──────────────────────────────────────────────────────────

    function tdOpenAction(type) {
        _actionType = type;
        var titles = {
            'mark-submitted':          'Mark as Submitted',
            'record-acknowledgement':  'Record Acknowledgement',
            'record-response':         'Record SARS Response',
            'accept':                  'Accept — Mark Resolved',
            'reject':                  'Reject SARS Decision',
            'escalate':                'Escalate Case',
            'complete':                'Complete Case',
            'add-evidence':            'Add Evidence',
        };
        document.getElementById('actionTitle').textContent    = titles[type] || type;
        document.getElementById('actionMsg').textContent      = '';
        document.getElementById('actionFormBody').innerHTML   = _buildActionForm(type);
        document.getElementById('actionSubmitBtn').textContent = type === 'add-evidence' ? 'Add Evidence' : 'Submit';
        document.getElementById('actionModal').classList.add('open');
    }

    function _buildActionForm(type) {
        var html = '';
        if (type === 'mark-submitted') {
            html += _fGroup('Submission Reference', '<input type="text" id="af_sub_ref" placeholder="SARS case / dispute reference" />');
            html += _fGroup('Notes', '<textarea id="af_notes" placeholder="Optional notes"></textarea>');
        } else if (type === 'record-acknowledgement') {
            html += _fGroup('Acknowledgement Date *', '<input type="date" id="af_ack_date" />');
            html += _fGroup('SARS Case Number', '<input type="text" id="af_sars_case" placeholder="e.g. D20240001" />');
            html += _fGroup('Notes', '<textarea id="af_notes" placeholder="Optional notes"></textarea>');
        } else if (type === 'record-response') {
            html += _fGroup('Response Date *', '<input type="date" id="af_resp_date" />');
            html += _fGroup('Notes', '<textarea id="af_notes" placeholder="Summary of SARS response"></textarea>');
        } else if (type === 'accept') {
            html += _fGroup('Outcome Amount (R)', '<input type="number" id="af_outcome_amount" step="0.01" placeholder="0.00" />');
            html += _fGroup('Outcome Notes', '<textarea id="af_outcome_notes" placeholder="Details of accepted outcome"></textarea>');
            html += _fGroup('Notes', '<textarea id="af_notes"></textarea>');
        } else if (type === 'reject') {
            html += _fGroup('Outcome Notes', '<textarea id="af_outcome_notes" placeholder="Reason for rejection / next steps"></textarea>');
            html += _fGroup('Notes', '<textarea id="af_notes"></textarea>');
        } else if (type === 'escalate') {
            html += '<div style="background:rgba(252,129,74,.08);border:1px solid rgba(252,129,74,.2);border-radius:8px;padding:10px 12px;font-size:.82rem;color:#f6ad55;margin-bottom:12px;">Notes are required when escalating.</div>';
            html += _fGroup('Escalation Notes *', '<textarea id="af_notes" placeholder="Reason for escalation and next action"></textarea>');
        } else if (type === 'complete') {
            html += _fGroup('Outcome', '<input type="text" id="af_outcome" placeholder="e.g. Settled in favour, Penalty waived" />');
            html += _fGroup('Outcome Amount (R)', '<input type="number" id="af_outcome_amount" step="0.01" placeholder="0.00" />');
            html += _fGroup('Outcome Notes', '<textarea id="af_outcome_notes" placeholder="Details of final outcome"></textarea>');
            html += _fGroup('Notes', '<textarea id="af_notes"></textarea>');
        } else if (type === 'add-evidence') {
            html += _fGroup('Evidence Type *', '<select id="af_ev_type"><option value="">Select…</option>' +
                ['sars_correspondence','supporting_document','objection_form','legal_advice','tax_calculation','payment_proof','acknowledgement','other'].map(function (t) {
                    return '<option value="' + t + '">' + t.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + '</option>';
                }).join('') + '</select>');
            html += _fGroup('Title *', '<input type="text" id="af_ev_title" placeholder="e.g. SARS Assessment Notice 2024" />');
            html += _fGroup('Evidence Date', '<input type="date" id="af_ev_date" />');
            html += _fGroup('External Reference', '<input type="text" id="af_ev_ref" placeholder="File number / case ref" />');
            html += _fGroup('Note', '<textarea id="af_ev_note" placeholder="Optional detail"></textarea>');
        }
        return html;
    }

    function _fGroup(label, input) {
        return '<div class="form-group"><label>' + label + '</label>' + input + '</div>';
    }

    function tdCloseAction() {
        document.getElementById('actionModal').classList.remove('open');
        _actionType = null;
    }

    function tdSubmitAction() {
        if (_submitting || !_actionType) return;

        var type = _actionType;
        var url, body;

        if (type === 'add-evidence') {
            var evType  = (document.getElementById('af_ev_type')  || {}).value;
            var evTitle = (document.getElementById('af_ev_title') || {}).value;
            if (!evType)  return _showToast('Evidence type is required');
            if (!evTitle) return _showToast('Title is required');
            url  = BASE + '/' + _currentId + '/evidence';
            body = JSON.stringify({
                evidence_type:      evType,
                evidence_title:     evTitle.trim(),
                evidence_date:      (document.getElementById('af_ev_date') || {}).value || null,
                external_reference: (document.getElementById('af_ev_ref')  || {}).value.trim() || null,
                evidence_note:      (document.getElementById('af_ev_note') || {}).value.trim() || null,
            });
        } else {
            var endpointMap = {
                'mark-submitted': 'mark-submitted', 'record-acknowledgement': 'record-acknowledgement',
                'record-response': 'record-response', 'accept': 'accept', 'reject': 'reject',
                'escalate': 'escalate', 'complete': 'complete',
            };
            url = BASE + '/' + _currentId + '/' + endpointMap[type];
            var payload = { notes: (document.getElementById('af_notes') || {}).value.trim() || null };
            if (document.getElementById('af_sub_ref'))       payload.submission_reference  = document.getElementById('af_sub_ref').value.trim() || null;
            if (document.getElementById('af_ack_date'))      payload.acknowledgement_date  = document.getElementById('af_ack_date').value || null;
            if (document.getElementById('af_sars_case'))     payload.sars_case_number      = document.getElementById('af_sars_case').value.trim() || null;
            if (document.getElementById('af_resp_date'))     payload.response_date         = document.getElementById('af_resp_date').value || null;
            if (document.getElementById('af_outcome'))       payload.outcome               = document.getElementById('af_outcome').value.trim() || null;
            if (document.getElementById('af_outcome_amount') && document.getElementById('af_outcome_amount').value)
                payload.outcome_amount = Number(document.getElementById('af_outcome_amount').value);
            if (document.getElementById('af_outcome_notes')) payload.outcome_notes         = document.getElementById('af_outcome_notes').value.trim() || null;
            body = JSON.stringify(payload);
        }

        _submitting = true;
        PracticeAPI.fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
            .then(function (r) {
                _submitting = false;
                if (!r.ok) return _showToast(r.data.error || 'Action failed');
                _showToast('Done');
                tdCloseAction();
                // Refresh detail
                PracticeAPI.fetch(BASE + '/' + _currentId)
                    .then(function (res) { return res.json(); })
                    .then(function (d) {
                        _currentCase = d.case;
                        _renderTabBar(_currentCase);
                        _activateTab(_currentTab);
                        _renderFooter(_currentCase);
                    });
                _loadSummary();
                _loadList();
            })
            .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    // ── Cancel Case ───────────────────────────────────────────────────────────

    function tdCancelCase() {
        if (!window.confirm('Cancel this dispute case? This cannot be undone.')) return;
        PracticeAPI.fetch(BASE + '/' + _currentId, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            if (!r.ok) return _showToast(r.data.error || 'Failed to cancel case');
            _showToast('Case cancelled');
            tdCloseDetail();
            tdLoad();
        })
        .catch(function () { _showToast('Network error'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.tdLoad            = tdLoad;
    window.tdOpenCreate      = tdOpenCreate;
    window.tdCloseCreate     = tdCloseCreate;
    window.tdSubmitCreate    = tdSubmitCreate;
    window.tdOpenDetail      = tdOpenDetail;
    window.tdCloseDetail     = tdCloseDetail;
    window.tdOpenTab         = tdOpenTab;
    window.tdClearFilters    = tdClearFilters;
    window.tdOpenAction      = tdOpenAction;
    window.tdCloseAction     = tdCloseAction;
    window.tdSubmitAction    = tdSubmitAction;
    window.tdCancelCase      = tdCancelCase;
    window.tdVerifyEvidence  = tdVerifyEvidence;
    window.tdDeleteEvidence  = tdDeleteEvidence;
    window._tdFilterStatus   = _tdFilterStatus;
    window._tdFilterType     = _tdFilterType;
    window._tdPage           = _tdPage;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        tdLoad();
    });

}());
