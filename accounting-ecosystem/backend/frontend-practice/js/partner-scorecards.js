/* Codebox 75 — Practice Partner Performance + Practice Scorecards
 * Executive operational reporting — NOT HR, NOT payroll performance, NOT
 * employee ranking, NOT disciplinary management. Aggregates existing KPIs
 * only. NOT AI — deterministic weighted arithmetic, every component states
 * its source/formula/weight/confidence.
 * Prefix: psc
 */
(function () {
    'use strict';

    var BASE = '/api/practice/partner-scorecards';
    var TEAM_BASE = '/api/practice/team';
    var _tab = 'practice';
    var _currentResult = { practice: null, partners: null, managers: null, teams: null };
    var _currentReviewId = null;
    var _currentSnapshotId = null;
    var _pendingNotesAction = null;

    var COMPONENT_LABELS = {
        profitability: 'Profitability', quality: 'Quality', client: 'Client Success', capacity: 'Capacity',
        risk: 'Risk', engagement: 'Engagement', learning: 'Learning', planning: 'Planning', notification: 'Notifications',
    };
    var REVIEW_STATUS_LABELS = { draft: 'Draft', under_review: 'Under Review', reviewed: 'Reviewed', action_required: 'Action Required', accepted: 'Accepted', archived: 'Archived', cancelled: 'Cancelled' };

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
    function _defaultPeriod() {
        var now = new Date();
        var start = new Date(now.getFullYear(), now.getMonth(), 1);
        var end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function pscLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadPickers();
        var p = _defaultPeriod();
        ['prPeriodStart', 'partnersPeriodStart', 'managersPeriodStart', 'teamsPeriodStart'].forEach(function (id) { document.getElementById(id).value = p.start; });
        ['prPeriodEnd', 'partnersPeriodEnd', 'managersPeriodEnd', 'teamsPeriodEnd'].forEach(function (id) { document.getElementById(id).value = p.end; });
        pscLoadHistory();
        pscLoadReviews();
    }

    function _renderTabBar() {
        var tabs = [['practice', 'Practice'], ['partners', 'Partners'], ['managers', 'Managers'], ['teams', 'Teams'], ['history', 'History'], ['reviews', 'Reviews']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="pscSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function pscSetTab(tab) {
        _tab = tab; _renderTabBar();
        if (tab === 'history') pscLoadHistory();
        if (tab === 'reviews') pscLoadReviews();
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var lowest = d.lowest_scoring_snapshot;
                var cards = [
                    { count: d.scorecards_total || 0, label: 'Total Scorecards' },
                    { count: (d.by_scorecard_type && d.by_scorecard_type.partner) || 0, label: 'Partner Snapshots' },
                    { count: (d.by_scorecard_type && d.by_scorecard_type.manager) || 0, label: 'Manager Snapshots' },
                    { count: d.open_reviews || 0, label: 'Open Reviews' },
                    { count: lowest ? lowest.overall_score : '—', label: 'Lowest Score Needing Review' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadPickers() {
        window.PracticeAPI.fetch(TEAM_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var members = d.members || [];
                var partners = members.filter(function (m) { return ['owner', 'partner'].indexOf(m.role) !== -1; });
                var managers = members.filter(function (m) { return m.role === 'manager'; });
                document.getElementById('partnerPicker').innerHTML = partners.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('') || '<option value="">No partners found</option>';
                document.getElementById('managerPicker').innerHTML = managers.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('') || '<option value="">No managers found</option>';
            })
            .catch(function () {});
        window.PracticeAPI.fetch(BASE + '/team-keys')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var keys = d.team_keys || [];
                document.getElementById('teamPicker').innerHTML = keys.map(function (k) { return '<option value="' + _html(k) + '">' + _html(k) + '</option>'; }).join('') || '<option value="">No teams/departments found</option>';
            })
            .catch(function () {});
    }

    // ── Compute (shared across practice/partners/managers/teams) ────────────────

    function pscCalculate(kind) {
        var url, periodStart, periodEnd;
        if (kind === 'practice') {
            periodStart = document.getElementById('prPeriodStart').value; periodEnd = document.getElementById('prPeriodEnd').value;
            url = BASE + '/practice?period_start=' + periodStart + '&period_end=' + periodEnd;
        } else if (kind === 'partners') {
            var partnerId = document.getElementById('partnerPicker').value;
            if (!partnerId) { _showToast('Select a partner.'); return; }
            periodStart = document.getElementById('partnersPeriodStart').value; periodEnd = document.getElementById('partnersPeriodEnd').value;
            url = BASE + '/partner/' + partnerId + '?period_start=' + periodStart + '&period_end=' + periodEnd;
        } else if (kind === 'managers') {
            var managerId = document.getElementById('managerPicker').value;
            if (!managerId) { _showToast('Select a manager.'); return; }
            periodStart = document.getElementById('managersPeriodStart').value; periodEnd = document.getElementById('managersPeriodEnd').value;
            url = BASE + '/manager/' + managerId + '?period_start=' + periodStart + '&period_end=' + periodEnd;
        } else {
            var teamKey = document.getElementById('teamPicker').value;
            if (!teamKey) { _showToast('Select a team.'); return; }
            periodStart = document.getElementById('teamsPeriodStart').value; periodEnd = document.getElementById('teamsPeriodEnd').value;
            url = BASE + '/team/' + encodeURIComponent(teamKey) + '?period_start=' + periodStart + '&period_end=' + periodEnd;
        }
        if (!periodStart || !periodEnd) { _showToast('Period start and end are required.'); return; }

        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _currentResult[kind] = d.scorecard;
                document.getElementById('result-' + kind).innerHTML = _renderScorecard(d.scorecard, kind);
            })
            .catch(function () { _showToast('Failed to calculate scorecard.'); });
    }

    function _renderScorecard(sc, kind) {
        var html = '<div class="panel"><div class="panel-title">Overall Score: <strong>' + (sc.overall_score != null ? sc.overall_score : '—') + '</strong>' +
            '<div class="action-bar" style="margin:0;"><button class="btn-action btn-primary" onclick="pscSaveSnapshot(\'' + kind + '\')">Save Snapshot</button></div></div>';

        if (sc.warnings && sc.warnings.length) {
            html += sc.warnings.map(function (w) { return '<div class="mini-card flag">' + _html(w) + '</div>'; }).join('');
        }

        html += Object.keys(sc.component_scores).map(function (key) {
            var c = sc.component_scores[key];
            return '<div class="component-card"><div class="c-head"><span>' + _html(COMPONENT_LABELS[key] || key) + '</span>' +
                '<span>' + (c.score != null ? c.score : '—') + ' <span class="conf-' + _html(c.confidence) + '">(' + _html(c.confidence) + ' confidence)</span></span></div>' +
                '<div class="c-meta">Weight: ' + Math.round(c.weight * 100) + '% &middot; Source: ' + _html(c.source) + '</div>' +
                '<div class="c-meta">Formula: ' + _html(c.formula) + '</div>' +
                (c.warning ? '<div class="c-meta" style="color:#f6ad55;">⚠ ' + _html(c.warning) + '</div>' : '') + '</div>';
        }).join('');

        html += '</div>';
        return html;
    }

    function pscSaveSnapshot(kind) {
        var sc = _currentResult[kind];
        if (!sc) return;
        var periodKey = sc.period_start ? sc.period_start.slice(0, 7) : new Date().toISOString().slice(0, 7);
        var payload = {
            scorecard_type: kind === 'practice' ? 'practice' : kind === 'partners' ? 'partner' : kind === 'managers' ? 'manager' : 'team',
            team_member_id: sc.team_member_id || null, team_key: sc.team_key || null,
            period_start: sc.period_start, period_end: sc.period_end, period_key: periodKey,
        };
        window.PracticeAPI.fetch(BASE + '/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Scorecard snapshot saved.'); _loadSummary(); if (_tab === 'history') pscLoadHistory(); })
            .catch(function () { _showToast('Failed to save snapshot.'); });
    }

    // ── History ───────────────────────────────────────────────────────────────

    function pscLoadHistory() {
        var type = document.getElementById('fHistType').value;
        var periodKey = document.getElementById('fHistPeriodKey').value;
        var qs = [];
        if (type) qs.push('scorecard_type=' + type);
        if (periodKey) qs.push('period_key=' + encodeURIComponent(periodKey));
        window.PracticeAPI.fetch(BASE + '/snapshots' + (qs.length ? '?' + qs.join('&') : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderHistory(d.scorecards || []); })
            .catch(function () { document.getElementById('historyBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderHistory(rows) {
        var el = document.getElementById('historyBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No scorecard snapshots saved yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (s) {
            var scope = s.team_member_name || s.team_key || 'Whole Practice';
            return '<tr class="row-clickable" onclick="pscOpenSnapshot(' + s.id + ')">' +
                '<td>' + _html(s.scorecard_type) + '</td><td>' + _html(scope) + '</td>' +
                '<td>' + _fmtDate(s.period_start) + ' – ' + _fmtDate(s.period_end) + '</td>' +
                '<td>' + (s.overall_score != null ? s.overall_score : '—') + '</td><td>' + _fmt(s.created_at) + '</td></tr>';
        }).join('');
    }

    function pscOpenSnapshot(id) {
        _currentSnapshotId = id;
        window.PracticeAPI.fetch(BASE + '/snapshots/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var s = d.scorecard;
                var snap = s.snapshot || {};
                var html = '<div class="modal-title">Scorecard #' + s.id + ' — ' + _html(s.scorecard_type) + ' <strong>' + (s.overall_score != null ? s.overall_score : '—') + '</strong></div>';
                html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _fmtDate(s.period_start) + ' – ' + _fmtDate(s.period_end) + '</div>';
                html += (s.warnings || []).map(function (w) { return '<div class="mini-card flag">' + _html(w) + '</div>'; }).join('');
                if (snap.component_scores) {
                    html += Object.keys(snap.component_scores).map(function (key) {
                        var c = snap.component_scores[key];
                        return '<div class="component-card"><div class="c-head"><span>' + _html(COMPONENT_LABELS[key] || key) + '</span>' +
                            '<span>' + (c.score != null ? c.score : '—') + ' <span class="conf-' + _html(c.confidence) + '">(' + _html(c.confidence) + ')</span></span></div>' +
                            '<div class="c-meta">Weight: ' + Math.round(c.weight * 100) + '% &middot; ' + _html(c.formula) + '</div></div>';
                    }).join('');
                }
                html += '<div class="action-bar"><button class="btn-action btn-primary" onclick="pscOpenCreateReview()">Create Executive Review</button></div>';
                document.getElementById('detailBody').innerHTML = html;
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load scorecard.'); });
    }
    function pscCloseDetail() { document.getElementById('detailModal').classList.remove('open'); }

    // ── Create Review ─────────────────────────────────────────────────────────

    function pscOpenCreateReview() {
        document.getElementById('rvSummary').value = '';
        document.getElementById('rvStrengths').value = '';
        document.getElementById('rvImprovement').value = '';
        document.getElementById('rvActionPlan').value = '';
        document.getElementById('rvNextReviewDate').value = '';
        document.getElementById('createReviewModal').classList.add('open');
    }
    function pscCloseCreateReview() { document.getElementById('createReviewModal').classList.remove('open'); }
    function pscSubmitCreateReview() {
        var payload = {
            scorecard_id: _currentSnapshotId,
            review_summary: document.getElementById('rvSummary').value || null,
            strengths: document.getElementById('rvStrengths').value || null,
            improvement_areas: document.getElementById('rvImprovement').value || null,
            action_plan: document.getElementById('rvActionPlan').value || null,
            next_review_date: document.getElementById('rvNextReviewDate').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review created.'); pscCloseCreateReview(); pscCloseDetail(); _loadSummary(); if (_tab === 'reviews') pscLoadReviews(); })
            .catch(function () { _showToast('Failed to create review.'); });
    }

    // ── Reviews ───────────────────────────────────────────────────────────────

    function pscLoadReviews() {
        var status = document.getElementById('fReviewStatus').value;
        window.PracticeAPI.fetch(BASE + '/reviews' + (status ? '?review_status=' + status : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReviews(d.reviews || []); })
            .catch(function () { document.getElementById('reviewsBody').innerHTML = '<tr><td colspan="3" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderReviews(rows) {
        var el = document.getElementById('reviewsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="3" class="empty-state">No reviews yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="pscOpenReview(' + r.id + ')">' +
                '<td>Scorecard #' + r.scorecard_id + '</td>' +
                '<td><span class="pill rs-' + _html(r.review_status) + '">' + _html(REVIEW_STATUS_LABELS[r.review_status] || r.review_status) + '</span></td>' +
                '<td>' + _fmtDate(r.next_review_date) + '</td></tr>';
        }).join('');
    }

    function pscOpenReview(id) {
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
        var html = '<div class="modal-title">Executive Review — Scorecard #' + r.scorecard_id +
            ' <span class="pill rs-' + _html(r.review_status) + '">' + _html(REVIEW_STATUS_LABELS[r.review_status] || r.review_status) + '</span></div>';
        if (r.review_summary) html += '<div class="mini-card">' + _html(r.review_summary) + '</div>';
        if (r.strengths) html += '<div class="mini-card">Strengths: ' + _html(r.strengths) + '</div>';
        if (r.improvement_areas) html += '<div class="mini-card">Improvement areas: ' + _html(r.improvement_areas) + '</div>';
        if (r.action_plan) html += '<div class="mini-card">Action plan: ' + _html(r.action_plan) + '</div>';
        if (r.partner_notes) html += '<div class="mini-card">Partner notes: ' + _html(r.partner_notes) + '</div>';
        html += _renderReviewActionBar(r);
        document.getElementById('detailBody').innerHTML = html;
    }

    function _renderReviewActionBar(r) {
        var btns = [];
        if (r.review_status === 'draft') btns.push('<button class="btn-action btn-primary" onclick="pscReviewAction(\'submit\')">Submit for Review</button>');
        if (r.review_status === 'under_review') btns.push('<button class="btn-action btn-success" onclick="pscOpenNotes(\'complete\')">Complete Review</button>');
        if (['under_review', 'reviewed'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="pscOpenNotes(\'mark-action-required\')">Mark Action Required</button>');
        if (['reviewed', 'action_required'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-success" onclick="pscOpenNotes(\'accept\')">Accept</button>');
        if (['accepted', 'reviewed', 'action_required'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="pscOpenNotes(\'archive\')">Archive</button>');
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function pscReviewAction(action) {
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentReviewId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review updated.'); pscOpenReview(_currentReviewId); if (_tab === 'reviews') pscLoadReviews(); })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    function pscOpenNotes(action) {
        _pendingNotesAction = action;
        document.getElementById('notesModalTitle').textContent = action.replace(/-/g, ' ');
        document.getElementById('nfNotes').value = '';
        document.getElementById('notesModal').classList.add('open');
    }
    function pscCloseNotes() { document.getElementById('notesModal').classList.remove('open'); }
    function pscSubmitNotes() {
        var notes = document.getElementById('nfNotes').value;
        window.PracticeAPI.fetch(BASE + '/reviews/' + _currentReviewId + '/' + _pendingNotesAction, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: notes || null }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review updated.'); pscCloseNotes(); pscOpenReview(_currentReviewId); if (_tab === 'reviews') pscLoadReviews(); })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.pscSetTab = pscSetTab;
    window.pscCalculate = pscCalculate;
    window.pscSaveSnapshot = pscSaveSnapshot;
    window.pscLoadHistory = pscLoadHistory;
    window.pscOpenSnapshot = pscOpenSnapshot;
    window.pscCloseDetail = pscCloseDetail;
    window.pscOpenCreateReview = pscOpenCreateReview;
    window.pscCloseCreateReview = pscCloseCreateReview;
    window.pscSubmitCreateReview = pscSubmitCreateReview;
    window.pscLoadReviews = pscLoadReviews;
    window.pscOpenReview = pscOpenReview;
    window.pscReviewAction = pscReviewAction;
    window.pscOpenNotes = pscOpenNotes;
    window.pscCloseNotes = pscCloseNotes;
    window.pscSubmitNotes = pscSubmitNotes;

    document.addEventListener('DOMContentLoaded', pscLoadAll);
})();
