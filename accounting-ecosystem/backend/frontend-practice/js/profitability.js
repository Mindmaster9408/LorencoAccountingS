/* Codebox 73 — Practice Client Profitability + Service Margin Foundation
 * "Where are we making or losing money?" NOT accounting. NOT a ledger. NOT
 * invoicing automation — analysis of existing data only.
 * Prefix: pf
 */
(function () {
    'use strict';

    var BASE = '/api/practice/profitability';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'analysis';
    var _currentAnalysis = null;
    var _currentReviewId = null;
    var _pendingNotesAction = null;

    var STATUS_LABELS = { profitable: 'Profitable', watch: 'Watch', low_margin: 'Low Margin', unprofitable: 'Unprofitable', unknown: 'Unknown' };
    var REVIEW_STATUS_LABELS = { draft: 'Draft', under_review: 'Under Review', reviewed: 'Reviewed', action_required: 'Action Required', accepted: 'Accepted', archived: 'Archived', cancelled: 'Cancelled' };
    var WARNING_LABELS = {
        TEAM_COST_RATE_MISSING: 'No team cost-rate data — margin % is not yet meaningful.',
        NO_APPROVED_TIME_IN_PERIOD: 'No approved billable time found in this period.',
        SIGNIFICANT_UNAPPROVED_TIME: 'A significant share of billable hours has not yet been approved for billing.',
        TIME_WITHOUT_ENGAGEMENT_LINK: 'A significant share of time entries are not linked to any engagement via their task.',
        RECOVERABLE_VALUE_NO_BILLING_PACK: 'Recoverable value exists but no billing pack covers this period.',
        BILLING_PACK_NOT_FINALIZED: 'At least one billing pack in this period is still in draft.',
        UNBILLED_VALUE_NEGATIVE_CHECK_DATA: 'Unbilled value computed negative — check underlying billing/write-off data.',
        HIGH_UNBILLED_VALUE: 'High unbilled value relative to recoverable value.',
        HIGH_WRITEOFFS: 'High write-offs relative to recoverable value.',
        LOW_REALIZATION: 'Realization is below 70%.',
        HIGH_NONBILLABLE_TIME: 'A high share of recorded hours is non-billable.',
        WORK_OUTSIDE_SCOPE: 'This client has unresolved out-of-scope work authorizations.',
        NO_LINKED_TASKS_FOUND: 'No tasks are linked to this engagement/service.',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _fmtMoney(n) { return n != null ? 'R' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
    function _fmtPct(n) { return n != null ? n + '%' : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }
    function _defaultPeriod() {
        var now = new Date();
        var start = new Date(now.getFullYear(), now.getMonth(), 1);
        var end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function pfLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientPicker();
        var p = _defaultPeriod();
        document.getElementById('anPeriodStart').value = p.start;
        document.getElementById('anPeriodEnd').value = p.end;
        pfLoadSnapshots();
        pfLoadReviews();
    }

    function _renderTabBar() {
        var tabs = [['analysis', 'Analysis'], ['snapshots', 'Snapshots'], ['reviews', 'Reviews']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="pfSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function pfSetTab(tab) {
        _tab = tab; _renderTabBar();
        if (tab === 'snapshots') pfLoadSnapshots();
        if (tab === 'reviews') pfLoadReviews();
    }

    function pfOnScopeChange() {
        var scope = document.getElementById('anScope').value;
        document.getElementById('anClientGroup').style.display = scope === 'client' ? 'flex' : 'none';
        document.getElementById('anEngagementGroup').style.display = scope === 'engagement' ? 'flex' : 'none';
        document.getElementById('anServiceGroup').style.display = scope === 'service' ? 'flex' : 'none';
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.snapshots_total || 0, label: 'Snapshots' },
                    { count: d.low_margin_clients || 0, label: 'Low Margin' },
                    { count: d.unprofitable_clients || 0, label: 'Unprofitable' },
                    { count: d.high_writeoff_count || 0, label: 'High Write-Offs' },
                    { count: d.low_realization_count || 0, label: 'Low Realization' },
                    { count: d.reviews_open || 0, label: 'Open Reviews' },
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
                document.getElementById('anClient').innerHTML = clients.map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    // ── Analysis ──────────────────────────────────────────────────────────────

    function pfCalculate() {
        var scope = document.getElementById('anScope').value;
        var periodStart = document.getElementById('anPeriodStart').value;
        var periodEnd = document.getElementById('anPeriodEnd').value;
        if (!periodStart || !periodEnd) { _showToast('Period start and end are required.'); return; }

        var url;
        if (scope === 'practice') {
            url = BASE + '/practice?period_start=' + periodStart + '&period_end=' + periodEnd;
        } else if (scope === 'client') {
            var clientId = document.getElementById('anClient').value;
            if (!clientId) { _showToast('Select a client.'); return; }
            url = BASE + '/client/' + clientId + '?period_start=' + periodStart + '&period_end=' + periodEnd;
        } else if (scope === 'engagement') {
            var engagementId = document.getElementById('anEngagementId').value;
            if (!engagementId) { _showToast('Enter an engagement ID.'); return; }
            url = BASE + '/engagement/' + engagementId + '?period_start=' + periodStart + '&period_end=' + periodEnd;
        } else {
            var serviceId = document.getElementById('anServiceId').value;
            if (!serviceId) { _showToast('Enter a service ID.'); return; }
            url = BASE + '/service/' + serviceId + '?period_start=' + periodStart + '&period_end=' + periodEnd;
        }

        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _currentAnalysis = d.analysis;
                _renderAnalysis(d.analysis, scope, periodStart, periodEnd);
            })
            .catch(function () { _showToast('Failed to calculate profitability.'); });
    }

    function _renderAnalysis(a, scope, periodStart, periodEnd) {
        document.getElementById('analysisResultPanel').style.display = 'block';
        document.getElementById('analysisStatusPill').innerHTML = '<span class="pill ps-' + _html(a.profitability_status) + '">' + _html(STATUS_LABELS[a.profitability_status] || a.profitability_status) + '</span>';

        var fields = [
            ['Revenue', _fmtMoney(a.revenue_amount)], ['Recoverable', _fmtMoney(a.recoverable_value)], ['Billed', _fmtMoney(a.billed_value)],
            ['Write-Off', _fmtMoney(a.writeoff_value)], ['Unbilled', _fmtMoney(a.unbilled_value)], ['Estimated Cost', _fmtMoney(a.estimated_cost)],
            ['Estimated Margin', _fmtMoney(a.estimated_margin)], ['Realization %', _fmtPct(a.realization_percentage)], ['Margin %', _fmtPct(a.margin_percentage)],
            ['Hours Recorded', a.hours_recorded], ['Billable Hours', a.billable_hours], ['Non-Billable Hours', a.nonbillable_hours],
        ];
        document.getElementById('analysisGrid').innerHTML = fields.map(function (f) {
            return '<div class="readonly-field"><div class="rf-label">' + _html(f[0]) + '</div><div class="rf-value">' + f[1] + '</div></div>';
        }).join('');

        var warnings = a.warnings || [];
        document.getElementById('analysisWarnings').innerHTML = warnings.length ? warnings.map(function (w) {
            return '<div class="mini-card flag">' + _html(WARNING_LABELS[w] || w) + '</div>';
        }).join('') : '<div class="empty-state">No warnings.</div>';
    }

    function pfSaveSnapshot() {
        if (!_currentAnalysis) return;
        var scope = document.getElementById('anScope').value;
        var payload = {
            snapshot_type: scope === 'practice' ? 'practice' : scope,
            period_start: document.getElementById('anPeriodStart').value,
            period_end: document.getElementById('anPeriodEnd').value,
            client_id: _currentAnalysis.client_id || null,
            engagement_id: _currentAnalysis.engagement_id || null,
            service_id: _currentAnalysis.service_id || null,
        };
        window.PracticeAPI.fetch(BASE + '/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Snapshot saved.'); _loadSummary(); if (_tab === 'snapshots') pfLoadSnapshots(); })
            .catch(function () { _showToast('Failed to save snapshot.'); });
    }

    // ── Snapshots ─────────────────────────────────────────────────────────────

    function pfLoadSnapshots() {
        var type = document.getElementById('fSnapshotType').value;
        var status = document.getElementById('fSnapshotStatus').value;
        var qs = [];
        if (type) qs.push('snapshot_type=' + type);
        if (status) qs.push('profitability_status=' + status);
        var url = BASE + '/snapshots' + (qs.length ? '?' + qs.join('&') : '');
        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSnapshots(d.snapshots || []); })
            .catch(function () { document.getElementById('snapshotsBody').innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderSnapshots(rows) {
        var el = document.getElementById('snapshotsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="7" class="empty-state">No snapshots saved yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (s) {
            return '<tr class="row-clickable" onclick="pfOpenSnapshot(' + s.id + ')">' +
                '<td>' + _html(s.snapshot_type) + '</td><td>' + _html(s.client_name || '—') + '</td>' +
                '<td>' + _fmtDate(s.period_start) + ' – ' + _fmtDate(s.period_end) + '</td>' +
                '<td><span class="pill ps-' + _html(s.profitability_status) + '">' + _html(STATUS_LABELS[s.profitability_status] || s.profitability_status) + '</span></td>' +
                '<td>' + _fmtPct(s.realization_percentage) + '</td><td>' + _fmtPct(s.margin_percentage) + '</td><td>' + _fmtMoney(s.billed_value) + '</td></tr>';
        }).join('');
    }

    function pfOpenSnapshot(id) {
        window.PracticeAPI.fetch(BASE + '/snapshots/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var s = d.snapshot;
                var html = '<div class="modal-title">Snapshot #' + s.id + ' <span class="pill ps-' + _html(s.profitability_status) + '">' + _html(STATUS_LABELS[s.profitability_status] || s.profitability_status) + '</span></div>';
                html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(s.snapshot_type) + ' &middot; ' + _fmtDate(s.period_start) + ' – ' + _fmtDate(s.period_end) + '</div>';
                html += '<div class="readonly-grid">' +
                    '<div class="readonly-field"><div class="rf-label">Billed</div><div class="rf-value">' + _fmtMoney(s.billed_value) + '</div></div>' +
                    '<div class="readonly-field"><div class="rf-label">Recoverable</div><div class="rf-value">' + _fmtMoney(s.recoverable_value) + '</div></div>' +
                    '<div class="readonly-field"><div class="rf-label">Write-Off</div><div class="rf-value">' + _fmtMoney(s.writeoff_value) + '</div></div>' +
                    '<div class="readonly-field"><div class="rf-label">Unbilled</div><div class="rf-value">' + _fmtMoney(s.unbilled_value) + '</div></div>' +
                    '<div class="readonly-field"><div class="rf-label">Realization</div><div class="rf-value">' + _fmtPct(s.realization_percentage) + '</div></div>' +
                    '<div class="readonly-field"><div class="rf-label">Margin</div><div class="rf-value">' + _fmtPct(s.margin_percentage) + '</div></div>' +
                    '</div>';
                var warnings = s.warnings || [];
                html += warnings.length ? warnings.map(function (w) { return '<div class="mini-card flag">' + _html(WARNING_LABELS[w] || w) + '</div>'; }).join('') : '';
                if (s.notes) html += '<div class="mini-card">' + _html(s.notes) + '</div>';
                document.getElementById('detailBody').innerHTML = html;
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load snapshot.'); });
    }
    function pfCloseDetail() { document.getElementById('detailModal').classList.remove('open'); }

    // ── Create Review ─────────────────────────────────────────────────────────

    function pfOpenCreateReview() {
        document.getElementById('rvTitle').value = '';
        document.getElementById('rvSummary').value = '';
        document.getElementById('rvRecommendedAction').value = '';
        document.getElementById('rvNextReviewDate').value = '';
        document.getElementById('createReviewModal').classList.add('open');
    }
    function pfCloseCreateReview() { document.getElementById('createReviewModal').classList.remove('open'); }
    function pfSubmitCreateReview() {
        var title = document.getElementById('rvTitle').value;
        if (!title) { _showToast('Review title is required.'); return; }
        var payload = {
            review_title: title, review_summary: document.getElementById('rvSummary').value || null,
            recommended_action: document.getElementById('rvRecommendedAction').value || null,
            next_review_date: document.getElementById('rvNextReviewDate').value || null,
            client_id: _currentAnalysis ? _currentAnalysis.client_id : null,
            engagement_id: _currentAnalysis ? _currentAnalysis.engagement_id : null,
        };
        window.PracticeAPI.fetch(BASE + '/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review created.'); pfCloseCreateReview(); _loadSummary(); if (_tab === 'reviews') pfLoadReviews(); })
            .catch(function () { _showToast('Failed to create review.'); });
    }

    // Codebox 74 — hands off to Pricing Review with client/engagement context
    // in the query string. This module never creates a pricing review itself.
    function pfOpenPricingReview() {
        if (!_currentAnalysis) return;
        var qs = [];
        if (_currentAnalysis.client_id) qs.push('client_id=' + _currentAnalysis.client_id);
        if (_currentAnalysis.engagement_id) qs.push('engagement_id=' + _currentAnalysis.engagement_id);
        window.location.href = '/practice/pricing-review.html' + (qs.length ? '?' + qs.join('&') : '');
    }

    // ── Reviews ───────────────────────────────────────────────────────────────

    function pfLoadReviews() {
        var status = document.getElementById('fReviewStatus').value;
        var url = BASE + '/reviews' + (status ? '?review_status=' + status : '');
        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReviews(d.reviews || []); })
            .catch(function () { document.getElementById('reviewsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderReviews(rows) {
        var el = document.getElementById('reviewsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No reviews yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="pfOpenReview(' + r.id + ')">' +
                '<td>' + _html(r.review_title) + '</td><td>' + _html(r.client_name || '—') + '</td>' +
                '<td><span class="pill rs-' + _html(r.review_status) + '">' + _html(REVIEW_STATUS_LABELS[r.review_status] || r.review_status) + '</span></td>' +
                '<td>' + _html(r.recommended_action || '—') + '</td><td>' + _fmtDate(r.next_review_date) + '</td></tr>';
        }).join('');
    }

    function pfOpenReview(id) {
        _currentReviewId = id;
        window.PracticeAPI.fetch(BASE + '/reviews/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderReviewDetail(d.review);
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load review.'); });
    }

    function _renderReviewDetail(r) {
        var html = '<div class="modal-title">' + _html(r.review_title) + ' <span class="pill rs-' + _html(r.review_status) + '">' + _html(REVIEW_STATUS_LABELS[r.review_status] || r.review_status) + '</span></div>';
        if (r.review_summary) html += '<div class="mini-card">' + _html(r.review_summary) + '</div>';
        if (r.partner_notes) html += '<div class="mini-card">Partner notes: ' + _html(r.partner_notes) + '</div>';
        if (r.recommended_action) html += '<div class="mini-card">Recommended action: ' + _html(r.recommended_action) + '</div>';

        html += _renderReviewActionBar(r);
        document.getElementById('detailBody').innerHTML = html;
    }

    function _renderReviewActionBar(r) {
        var btns = [];
        if (r.review_status === 'draft') btns.push('<button class="btn-action btn-primary" onclick="pfReviewAction(\'submit\')">Submit for Review</button>');
        if (r.review_status === 'under_review') btns.push('<button class="btn-action btn-success" onclick="pfOpenNotes(\'complete\')">Complete Review</button>');
        if (['under_review', 'reviewed'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="pfOpenNotes(\'mark-action-required\')">Mark Action Required</button>');
        if (['reviewed', 'action_required'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-success" onclick="pfOpenNotes(\'accept\')">Accept</button>');
        if (['accepted', 'reviewed', 'action_required'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="pfOpenNotes(\'archive\')">Archive</button>');
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function pfReviewAction(action) {
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentReviewId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review updated.'); pfOpenReview(_currentReviewId); if (_tab === 'reviews') pfLoadReviews(); })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    function pfOpenNotes(action) {
        _pendingNotesAction = action;
        document.getElementById('notesModalTitle').textContent = action.replace(/-/g, ' ');
        document.getElementById('nfNotes').value = '';
        document.getElementById('notesModal').classList.add('open');
    }
    function pfCloseNotes() { document.getElementById('notesModal').classList.remove('open'); }
    function pfSubmitNotes() {
        var notes = document.getElementById('nfNotes').value;
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentReviewId + '/' + _pendingNotesAction, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: notes || null }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review updated.'); pfCloseNotes(); pfOpenReview(_currentReviewId); if (_tab === 'reviews') pfLoadReviews(); })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.pfSetTab = pfSetTab;
    window.pfOnScopeChange = pfOnScopeChange;
    window.pfCalculate = pfCalculate;
    window.pfSaveSnapshot = pfSaveSnapshot;
    window.pfLoadSnapshots = pfLoadSnapshots;
    window.pfOpenSnapshot = pfOpenSnapshot;
    window.pfCloseDetail = pfCloseDetail;
    window.pfOpenCreateReview = pfOpenCreateReview;
    window.pfOpenPricingReview = pfOpenPricingReview;
    window.pfCloseCreateReview = pfCloseCreateReview;
    window.pfSubmitCreateReview = pfSubmitCreateReview;
    window.pfLoadReviews = pfLoadReviews;
    window.pfOpenReview = pfOpenReview;
    window.pfReviewAction = pfReviewAction;
    window.pfOpenNotes = pfOpenNotes;
    window.pfCloseNotes = pfCloseNotes;
    window.pfSubmitNotes = pfSubmitNotes;

    document.addEventListener('DOMContentLoaded', pfLoadAll);
})();
