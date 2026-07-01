/* Codebox 48 — Practice Quality Management System (QMS)
 * Quality reviews, non-conformance findings, CAPA. NOT AI. NOT disciplinary.
 * Prefix: qms
 */
(function () {
    'use strict';

    var BASE        = '/api/practice/qms';
    var _currentId   = null;
    var _currentReview = null;
    var _currentTab  = 'overview';
    var _submitting  = false;
    var _page        = 1;
    var _actionType  = null;
    var _urlLinkedType = null;
    var _urlLinkedId   = null;

    // ── Constants ────────────────────────────────────────────────────────────

    var REVIEW_STATUS_LABELS = {
        draft: 'Draft', in_review: 'In Review', passed: 'Passed', failed: 'Failed',
        needs_correction: 'Needs Correction', completed: 'Completed', cancelled: 'Cancelled',
    };

    var REVIEW_TYPE_LABELS = {
        task_review: 'Task Review', workflow_review: 'Workflow Review', tax_review: 'Tax Review',
        completion_pack_review: 'Completion Pack Review', sop_compliance_review: 'SOP Compliance Review',
        internal_inspection: 'Internal Inspection', client_file_review: 'Client File Review', custom: 'Custom',
    };

    var FINDING_STATUS_LABELS = {
        open: 'Open', in_progress: 'In Progress', resolved: 'Resolved',
        verified: 'Verified', dismissed: 'Dismissed', cancelled: 'Cancelled',
    };

    var FINDING_TYPE_LABELS = {
        non_conformance: 'Non-Conformance', observation: 'Observation', improvement: 'Improvement',
        risk: 'Risk', missing_evidence: 'Missing Evidence', sop_not_followed: 'SOP Not Followed',
        review_note: 'Review Note', custom: 'Custom',
    };

    var SEVERITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

    var EV_LABELS = {
        review_created: 'Review Created', review_updated: 'Updated', started: 'Started',
        passed: 'Passed', failed: 'Failed', completed: 'Completed', review_cancelled: 'Cancelled',
        review_needs_correction: 'Needs Correction', finding_added: 'Finding Added',
        finding_updated: 'Finding Updated', finding_resolved: 'Finding Resolved',
        finding_verified: 'Finding Verified', finding_cancelled: 'Finding Cancelled',
    };

    var LINKED_TYPE_LABELS = { task: 'Task', workflow: 'Workflow', completion_pack: 'Completion Pack', sop: 'SOP' };

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(s)     { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }

    function _statusPill(s) {
        return '<span class="pill st-' + _html(s) + '">' + _html(REVIEW_STATUS_LABELS[s] || FINDING_STATUS_LABELS[s] || s) + '</span>';
    }

    function _typeBadge(t) {
        return '<span class="type-badge">' + _html(REVIEW_TYPE_LABELS[t] || t) + '</span>';
    }

    function _sevBadge(s) {
        return '<span class="sev-badge sev-' + _html(s) + '">' + _html(SEVERITY_LABELS[s] || s) + '</span>';
    }

    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    function _qs() {
        var p = [];
        var reviewType = document.getElementById('filterReviewType').value;
        var status     = document.getElementById('filterStatus').value;
        var clientId   = document.getElementById('filterClientId').value.trim();
        var search     = document.getElementById('filterSearch').value.trim();
        if (reviewType) p.push('review_type=' + encodeURIComponent(reviewType));
        if (status)     p.push('status='      + encodeURIComponent(status));
        if (clientId)   p.push('client_id='   + encodeURIComponent(clientId));
        if (search)     p.push('search='      + encodeURIComponent(search));
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function qmsLoad() {
        _page = 1;
        _loadSummary();
        _loadList();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        _urlLinkedType = params.get('linked_type');
        _urlLinkedId   = params.get('linked_id');
        if (_urlLinkedType && _urlLinkedId) {
            document.getElementById('filterReviewType').value = '';
            _renderLinkedBanner(_urlLinkedType, _urlLinkedId);
        }
    }

    function _renderLinkedBanner(linkedType, linkedId) {
        var existing = document.getElementById('linkedBanner');
        if (existing) existing.remove();

        var banner = document.createElement('div');
        banner.id = 'linkedBanner';
        banner.className = 'inline-msg info';
        banner.innerHTML = 'Showing quality reviews for <strong>' + _html(LINKED_TYPE_LABELS[linkedType] || linkedType) + ' #' + _html(linkedId) + '</strong> — <span id="linkedBannerCount">loading…</span>';
        var content = document.querySelector('.page-content');
        content.insertBefore(banner, content.children[1]);

        window.PracticeAPI.fetch(BASE + '/reviews?linked_type=' + encodeURIComponent(linkedType) + '&linked_id=' + encodeURIComponent(linkedId))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var countEl = document.getElementById('linkedBannerCount');
                if (!countEl) return;
                var reviews = d.reviews || [];
                if (!reviews.length) {
                    countEl.innerHTML = 'no reviews yet. <a href="#" onclick="_qmsCreateFromLinked(\'' + linkedType + '\',' + linkedId + ');return false;" style="color:#a3bffa;">Create one ↗</a>';
                    return;
                }
                countEl.innerHTML = reviews.length + ' review(s): ' + reviews.map(function (rv) {
                    return '<a href="#" onclick="qmsOpenDetail(' + rv.id + ');return false;" style="color:#a3bffa;">' + _html(rv.review_title) + '</a>';
                }).join(', ');
            })
            .catch(function () {});
    }

    var CREATE_FROM_ENDPOINT = {
        task: 'create-from-task', workflow: 'create-from-workflow',
        completion_pack: 'create-from-completion-pack', sop: 'create-from-sop',
    };
    var CREATE_FROM_FIELD = {
        task: 'task_id', workflow: 'workflow_run_id',
        completion_pack: 'completion_pack_id', sop: 'sop_id',
    };

    function _qmsCreateFromLinked(linkedType, linkedId) {
        var endpoint = CREATE_FROM_ENDPOINT[linkedType];
        var field    = CREATE_FROM_FIELD[linkedType];
        if (!endpoint) return;
        var body = {};
        body[field] = linkedId;
        window.PracticeAPI.fetch(BASE + '/' + endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (r) {
            if (!r.ok) {
                if (r.status === 409) return _showToast('Active review already exists (#' + r.data.existing_review_id + ')');
                return _showToast(r.data.error || 'Failed to create review');
            }
            _showToast('Quality review created');
            qmsOpenDetail(r.data.id);
        })
        .catch(function () { _showToast('Network error'); });
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
            { cls: 'sc-draft',      count: d.draft            || 0, label: 'Draft',            filter: 'draft' },
            { cls: 'sc-in_review',  count: d.in_review         || 0, label: 'In Review',        filter: 'in_review' },
            { cls: 'sc-correction', count: d.needs_correction  || 0, label: 'Needs Correction', filter: 'needs_correction' },
            { cls: 'sc-passed',     count: d.passed            || 0, label: 'Passed',           filter: 'passed' },
            { cls: 'sc-failed',     count: d.failed            || 0, label: 'Failed',           filter: 'failed' },
            { cls: 'sc-completed',  count: d.completed         || 0, label: 'Completed',        filter: 'completed' },
            { cls: 'sc-findings',   count: d.open_findings     || 0, label: 'Open Findings',    filter: null },
            { cls: 'sc-critical',   count: d.critical_open_findings || 0, label: 'Critical Open', filter: null },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card ' + c.cls + '" onclick="' + (c.filter ? '_qmsFilterStatus(\'' + c.filter + '\')' : '') + '">' +
                '<div class="sc-count">' + c.count + '</div>' +
                '<div class="sc-label">' + c.label + '</div>' +
            '</div>';
        }).join('');
    }

    function _qmsFilterStatus(s) {
        document.getElementById('filterStatus').value = s;
        _page = 1;
        _loadList();
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="7">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + '/reviews' + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.reviews || [], d.total || 0, d.page || 1, d.limit || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="7" style="color:#fc8181;">Failed to load quality reviews</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No quality reviews found. Create the first review.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (r) {
            return '<tr onclick="qmsOpenDetail(' + r.id + ')">' +
                '<td style="color:#4a5568;font-size:.78rem;">#' + r.id + '</td>' +
                '<td>' + _typeBadge(r.review_type) + '</td>' +
                '<td>' + _statusPill(r.status) + '</td>' +
                '<td class="td-title" title="' + _html(r.review_title) + '">' + _html(r.review_title) + '</td>' +
                '<td style="font-size:.8rem;">' + _html(r.client_name || (r.client_id ? ('#' + r.client_id) : '—')) + '</td>' +
                '<td style="font-size:.8rem;">' + _html(r.quality_score != null ? (r.quality_score + '%') : '—') + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + _fmt(r.created_at) + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_qmsPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_qmsPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' review' + (total !== 1 ? 's' : '');
        }
    }

    function _qmsPage(p) { _page = p; _loadList(); }

    // ── Filters ───────────────────────────────────────────────────────────────

    function qmsClearFilters() {
        ['filterReviewType','filterStatus','filterClientId','filterSearch'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        _page = 1;
        _loadList();
    }

    // ── Create Review ─────────────────────────────────────────────────────────

    function qmsOpenCreate() {
        document.getElementById('createModal').classList.add('open');
    }

    function qmsCloseCreate() {
        document.getElementById('createModal').classList.remove('open');
    }

    function qmsSubmitCreate() {
        if (_submitting) return;
        var title = document.getElementById('createTitle').value.trim();
        var type  = document.getElementById('createReviewType').value;
        if (!title) return _showToast('Review title is required');
        if (!type)  return _showToast('Review type is required');

        var payload = {
            review_title:                     title,
            review_type:                      type,
            client_id:                         document.getElementById('createClientId').value.trim() || null,
            assigned_reviewer_team_member_id:  document.getElementById('createReviewer').value.trim()  || null,
            review_notes:                      document.getElementById('createNotes').value.trim()     || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/reviews', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to create review');
            _showToast('Quality review created');
            qmsCloseCreate();
            ['createTitle','createClientId','createReviewer','createNotes'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('createReviewType').value = '';
            qmsLoad();
        })
        .catch(function () { _submitting = false; _showToast('Network error — could not create review'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function qmsOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        window.PracticeAPI.fetch(BASE + '/reviews/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentReview = d;
                _renderTabBar();
                _activateTab('overview');
                _renderFooter();
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load review</div>';
            });
    }

    function qmsCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId     = null;
        _currentReview = null;
    }

    function _renderTabBar() {
        var tabs = [
            { key: 'overview', label: 'Overview' },
            { key: 'findings', label: 'Findings' },
            { key: 'events',   label: 'Events'   },
        ];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="qmsOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function qmsOpenTab(tab) {
        _currentTab = tab;
        if (_currentReview) {
            _activateTab(tab);
            _renderTabBar();
        }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        switch (tab) {
            case 'overview': _renderOverviewTab(body); break;
            case 'findings': _loadFindingsTab(body);    break;
            case 'events':   _loadEventsTab(body);      break;
        }
    }

    // ── Overview tab ──────────────────────────────────────────────────────────

    function _renderOverviewTab(body) {
        var r = _currentReview;
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dRow('Type',      _typeBadge(r.review_type));
        html += _dRow('Status',    _statusPill(r.status));
        html += _dRow('Client',    _html(r.client_name || (r.client_id ? ('#' + r.client_id) : '—')));
        html += _dRow('Linked To', r.linked_type ? (_html(LINKED_TYPE_LABELS[r.linked_type] || r.linked_type) + ' #' + _html(r.linked_id)) : '—');
        html += _dRow('Assigned Reviewer', _html(r.assigned_reviewer_team_member_id ? ('#' + r.assigned_reviewer_team_member_id) : '—'));
        html += _dRow('Quality Score', r.quality_score != null ? (r.quality_score + '%') : '—');
        html += _dRow('Reviewed',  r.reviewed_at ? _fmt(r.reviewed_at) : '—');
        html += _dRow('Created',  _fmt(r.created_at));
        html += '</div>';
        if (r.review_notes) {
            html += '<div class="section-label">Notes</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(r.review_notes) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dRow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + label + '</div><div class="detail-value">' + (value || '—') + '</div></div>';
    }

    // ── Findings tab ──────────────────────────────────────────────────────────

    function _loadFindingsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading findings…</div>';
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentId + '/findings')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderFindingsTab(d.findings || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load findings</div>'; });
    }

    function _renderFindingsTab(items, body) {
        var html = '<div class="tab-content">';
        html += '<div style="margin-bottom:10px;">';
        if (!['completed', 'cancelled'].includes(_currentReview.status)) {
            html += '<button type="button" class="btn-action btn-success btn-sm" onclick="qmsOpenFinding()">+ Add Finding</button>';
        }
        html += '</div>';
        if (!items.length) {
            html += '<div class="inline-msg info">No findings logged yet.</div>';
        } else {
            items.forEach(function (f) {
                html += '<div class="finding-item">';
                html += '<div class="finding-item-header">';
                html += '<span class="finding-title">' + _html(f.finding_title) + '</span>';
                html += _statusPill(f.status);
                html += _sevBadge(f.severity);
                html += '<span class="type-badge">' + _html(FINDING_TYPE_LABELS[f.finding_type] || f.finding_type) + '</span>';
                html += '</div>';
                if (f.finding_description) html += '<div class="finding-meta">' + _html(f.finding_description) + '</div>';
                if (f.root_cause) html += '<div class="capa-block"><span class="capa-label">Root Cause:</span> ' + _html(f.root_cause) + '</div>';
                if (f.corrective_action) html += '<div class="capa-block"><span class="capa-label">Corrective Action:</span> ' + _html(f.corrective_action) + '</div>';
                if (f.preventive_action) html += '<div class="capa-block"><span class="capa-label">Preventive Action:</span> ' + _html(f.preventive_action) + '</div>';
                if (f.due_date) html += '<div class="finding-meta">Due: ' + _fmtDate(f.due_date) + '</div>';
                html += '<div style="display:flex;gap:8px;margin-top:8px;">';
                if (['open', 'in_progress'].includes(f.status)) {
                    html += '<button type="button" class="btn-action btn-success btn-sm" onclick="qmsResolveFinding(' + f.id + ')">Resolve</button>';
                }
                if (f.status === 'resolved') {
                    html += '<button type="button" class="btn-action btn-primary btn-sm" onclick="qmsVerifyFinding(' + f.id + ')">Verify</button>';
                }
                if (!['verified', 'dismissed', 'cancelled'].includes(f.status)) {
                    html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="qmsCancelFinding(' + f.id + ')">Cancel</button>';
                }
                // Codebox 49 — Risk Register integration
                html += '<a class="btn-action btn-sm" href="/practice/risk-register.html?source_type=quality_finding&source_id=' + f.id + '" ' +
                    'style="background:#2d1e4d;color:#b794f4;text-decoration:none;display:inline-flex;align-items:center;" ' +
                    'title="View or create a risk register entry for this finding">Risk ↗</a>';
                html += '</div></div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function qmsOpenFinding() {
        document.getElementById('findingModal').classList.add('open');
    }

    function qmsCloseFinding() {
        document.getElementById('findingModal').classList.remove('open');
    }

    function qmsSubmitFinding() {
        if (_submitting) return;
        var title = document.getElementById('findTitle').value.trim();
        if (!title) return _showToast('Finding title is required');

        var payload = {
            finding_type:        document.getElementById('findType').value,
            severity:            document.getElementById('findSeverity').value,
            finding_title:       title,
            finding_description: document.getElementById('findDescription').value.trim() || null,
            root_cause:          document.getElementById('findRootCause').value.trim() || null,
            corrective_action:   document.getElementById('findCorrectiveAction').value.trim() || null,
            preventive_action:   document.getElementById('findPreventiveAction').value.trim() || null,
            due_date:            document.getElementById('findDueDate').value || null,
            responsible_team_member_id: document.getElementById('findResponsible').value.trim() || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentId + '/findings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to add finding');
            _showToast('Finding added');
            qmsCloseFinding();
            ['findTitle','findDescription','findRootCause','findCorrectiveAction','findPreventiveAction','findDueDate','findResponsible'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('findType').value = 'non_conformance';
            document.getElementById('findSeverity').value = 'medium';
            if (r.data.review) _currentReview = r.data.review;
            _renderTabBar();
            _loadFindingsTab(document.getElementById('detailBody'));
            _renderFooter();
            _loadSummary();
            _loadList();
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    function qmsResolveFinding(findingId) {
        window.PracticeAPI.fetch(BASE + '/findings/' + findingId + '/resolve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to resolve finding');
                _showToast('Finding resolved');
                _loadFindingsTab(document.getElementById('detailBody'));
                _loadSummary();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function qmsVerifyFinding(findingId) {
        window.PracticeAPI.fetch(BASE + '/findings/' + findingId + '/verify', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to verify finding');
                _showToast('Finding verified');
                _loadFindingsTab(document.getElementById('detailBody'));
                _loadSummary();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function qmsCancelFinding(findingId) {
        if (!window.confirm('Cancel this finding?')) return;
        window.PracticeAPI.fetch(BASE + '/findings/' + findingId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to cancel finding');
                _showToast('Finding cancelled');
                _loadFindingsTab(document.getElementById('detailBody'));
                _loadSummary();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Events tab ────────────────────────────────────────────────────────────

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentId + '/events')
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

    function _renderFooter() {
        var r = _currentReview;
        var s = r.status;
        var term = ['completed', 'cancelled'].includes(s);
        var html = '<button type="button" class="btn-action btn-secondary" onclick="qmsCloseDetail()">Close</button>';

        if (!term) {
            if (['draft', 'needs_correction'].includes(s)) {
                html += '<button type="button" class="btn-action btn-primary" onclick="qmsStart()">' + (s === 'needs_correction' ? 'Re-Review' : 'Start Review') + '</button>';
            }
            if (s === 'in_review') {
                html += '<button type="button" class="btn-action btn-success" onclick="qmsOpenAction(\'pass\')">Pass</button>';
                html += '<button type="button" class="btn-action btn-danger" onclick="qmsOpenAction(\'fail\')">Fail</button>';
            }
            if (['passed', 'failed'].includes(s)) {
                html += '<button type="button" class="btn-action btn-success" onclick="qmsOpenAction(\'complete\')">Complete</button>';
            }
            html += '<button type="button" class="btn-action btn-danger" onclick="qmsCancelReview()">Cancel Review</button>';
        }

        if (r.linked_type && r.linked_id) {
            html += '<a href="/practice/quality-management.html?linked_type=' + encodeURIComponent(r.linked_type) + '&linked_id=' + encodeURIComponent(r.linked_id) + '" ' +
                'style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d3748;color:#e2e8f0;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;" ' +
                'title="All quality reviews for this record">All Reviews ↗</a>';
        }

        document.getElementById('detailFooter').innerHTML = html;
    }

    function qmsStart() {
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentId + '/start', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to start review');
                _showToast('Review started');
                qmsOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function qmsCancelReview() {
        if (!window.confirm('Cancel this quality review? This cannot be undone.')) return;
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to cancel review');
                _showToast('Review cancelled');
                qmsCloseDetail();
                qmsLoad();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Action Modal (pass / fail / complete) ─────────────────────────────────

    function qmsOpenAction(type) {
        _actionType = type;
        var titles = { pass: 'Pass Review', fail: 'Fail Review', complete: 'Complete Review' };
        document.getElementById('actionTitle').textContent = titles[type] || type;
        document.getElementById('actionScore').value = _currentReview.quality_score != null ? _currentReview.quality_score : '';
        document.getElementById('actionNotes').value = '';
        document.getElementById('actionModal').classList.add('open');
    }

    function qmsCloseAction() {
        document.getElementById('actionModal').classList.remove('open');
        _actionType = null;
    }

    function qmsSubmitAction() {
        if (_submitting || !_actionType) return;
        var scoreRaw = document.getElementById('actionScore').value;
        var payload = {
            notes: document.getElementById('actionNotes').value.trim() || null,
        };
        if (scoreRaw !== '') payload.quality_score = Number(scoreRaw);

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentId + '/' + _actionType, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Action failed');
            _showToast('Done');
            qmsCloseAction();
            qmsOpenDetail(_currentId);
            _loadSummary();
            _loadList();
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.qmsLoad            = qmsLoad;
    window.qmsOpenCreate      = qmsOpenCreate;
    window.qmsCloseCreate     = qmsCloseCreate;
    window.qmsSubmitCreate    = qmsSubmitCreate;
    window.qmsOpenDetail      = qmsOpenDetail;
    window.qmsCloseDetail     = qmsCloseDetail;
    window.qmsOpenTab         = qmsOpenTab;
    window.qmsClearFilters    = qmsClearFilters;
    window.qmsOpenFinding     = qmsOpenFinding;
    window.qmsCloseFinding    = qmsCloseFinding;
    window.qmsSubmitFinding   = qmsSubmitFinding;
    window.qmsResolveFinding  = qmsResolveFinding;
    window.qmsVerifyFinding   = qmsVerifyFinding;
    window.qmsCancelFinding   = qmsCancelFinding;
    window.qmsStart           = qmsStart;
    window.qmsCancelReview    = qmsCancelReview;
    window.qmsOpenAction      = qmsOpenAction;
    window.qmsCloseAction     = qmsCloseAction;
    window.qmsSubmitAction    = qmsSubmitAction;
    window._qmsFilterStatus   = _qmsFilterStatus;
    window._qmsPage           = _qmsPage;
    window._qmsCreateFromLinked = _qmsCreateFromLinked;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        qmsLoad();
    });

}());
