/* Codebox 77 — Practice Executive Reporting + Board Pack Foundation
 * "What decisions do we need to make today?" NOT Business Intelligence. NOT
 * Power BI. NOT AI reporting. Every figure reused from an existing engine.
 * Prefix: er
 */
(function () {
    'use strict';

    var BASE = '/api/practice/executive-reporting';
    var TEAM_BASE = '/api/practice/team';
    var _tab = 'reports';
    var _reportDetailTab = 'overview';
    var _currentReportId = null;
    var _currentReport = null;
    var _pendingReasonAction = null;
    var _teamOptionsHtml = '<option value="">— None —</option>';
    var _reportTitleById = {};

    var REPORT_STATUS_LABELS = { draft: 'Draft', generated: 'Generated', under_review: 'Under Review', approved: 'Approved', published: 'Published', archived: 'Archived', cancelled: 'Cancelled' };
    var DECISION_STATUS_LABELS = { proposed: 'Proposed', approved: 'Approved', deferred: 'Deferred', rejected: 'Rejected', implemented: 'Implemented', cancelled: 'Cancelled' };
    var ACTION_STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', waiting: 'Waiting', completed: 'Completed', cancelled: 'Cancelled' };
    var SECTION_STATUS_LABELS = { included: 'Included', hidden: 'Hidden', manual: 'Manual' };

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

    function erLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadTeamMembers();
        erLoadReports();
        erLoadDecisions();
        erLoadActions();
        erLoadEvents();
        _maybeOpenFromQuery();
    }

    // Deep-link support from Strategic Planning's "Create Executive Report"
    // button — pre-fills the create-report modal, never auto-submits it.
    function _maybeOpenFromQuery() {
        var params = new URLSearchParams(window.location.search);
        if (!params.has('report_type') && !params.has('report_title')) return;
        erOpenCreateReport();
        if (params.get('report_title')) document.getElementById('nrTitle').value = params.get('report_title');
        if (params.get('report_type')) document.getElementById('nrType').value = params.get('report_type');
        if (params.get('period_start')) document.getElementById('nrPeriodStart').value = params.get('period_start');
        if (params.get('period_end')) document.getElementById('nrPeriodEnd').value = params.get('period_end');
    }

    function _loadTeamMembers() {
        window.PracticeAPI.fetch(TEAM_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var members = d.members || [];
                _teamOptionsHtml = '<option value="">— None —</option>' + members.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    function _renderTabBar() {
        var tabs = [['reports', 'Reports'], ['decisions', 'Decisions'], ['actions', 'Action Register'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="erSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.page-content > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function erSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var latest = d.latest_report;
                var cards = [
                    { count: latest ? latest.report_title : '—', label: 'Latest Report' },
                    { count: d.reports_awaiting_approval || 0, label: 'Awaiting Approval' },
                    { count: d.outstanding_actions || 0, label: 'Outstanding Actions' },
                    { count: d.open_decisions || 0, label: 'Open Decisions' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count" style="font-size:' + (typeof c.count === 'string' && c.count.length > 12 ? '.95rem' : '1.4rem') + ';">' + _html(c.count) + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Reports list ──────────────────────────────────────────────────────────

    function erLoadReports() {
        var params = new URLSearchParams();
        var status = document.getElementById('fReportStatus').value;
        var type = document.getElementById('fReportType').value;
        if (status) params.set('report_status', status);
        if (type) params.set('report_type', type);
        window.PracticeAPI.fetch(BASE + '/?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (d) {
                (d.reports || []).forEach(function (r) { _reportTitleById[r.id] = r.report_title; });
                _renderReports(d.reports || []);
            })
            .catch(function () { document.getElementById('reportsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderReports(rows) {
        var el = document.getElementById('reportsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No executive reports yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="erOpenReportDetail(' + r.id + ')">' +
                '<td>' + _html(r.report_title) + '</td><td>' + _html(r.report_type) + '</td>' +
                '<td>' + _fmtDate(r.period_start) + ' – ' + _fmtDate(r.period_end) + '</td>' +
                '<td><span class="pill rs-' + _html(r.report_status) + '">' + _html(REPORT_STATUS_LABELS[r.report_status] || r.report_status) + '</span></td>' +
                '<td>' + _fmt(r.generated_at) + '</td></tr>';
        }).join('');
    }

    function erOpenCreateReport() {
        document.getElementById('nrTitle').value = '';
        document.getElementById('nrType').value = 'monthly';
        document.getElementById('nrPeriodKey').value = '';
        var now = new Date();
        document.getElementById('nrPeriodStart').value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        document.getElementById('nrPeriodEnd').value = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
        document.getElementById('createReportModal').classList.add('open');
    }
    function erCloseCreateReport() { document.getElementById('createReportModal').classList.remove('open'); }
    function erSubmitCreateReport(generateNow) {
        var payload = {
            report_title: document.getElementById('nrTitle').value,
            report_type: document.getElementById('nrType').value,
            period_key: document.getElementById('nrPeriodKey').value || null,
            period_start: document.getElementById('nrPeriodStart').value,
            period_end: document.getElementById('nrPeriodEnd').value,
        };
        if (!payload.report_title || !payload.period_start || !payload.period_end) { _showToast('Title and period are required.'); return; }

        var url = generateNow ? (BASE + '/generate') : (BASE + '/');
        window.PracticeAPI.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(generateNow ? 'Report generated.' : 'Report created as draft.');
                erCloseCreateReport();
                erLoadReports();
                _loadSummary();
                if (d.report) erOpenReportDetail(d.report.id);
            })
            .catch(function () { _showToast('Failed to create report.'); });
    }

    // ── Report Detail ─────────────────────────────────────────────────────────

    function erOpenReportDetail(id) {
        _currentReportId = id;
        _reportDetailTab = 'overview';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _currentReport = d.report;
                _renderReportDetailHeader();
                _renderReportDetailTabBar();
                _renderReportOverview();
                _loadReportSections();
                _loadReportDecisions();
                _loadReportActions();
                _loadReportEvents();
                document.getElementById('reportDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load report.'); });
    }
    function erCloseReportDetail() { document.getElementById('reportDetailModal').classList.remove('open'); _currentReportId = null; _currentReport = null; }

    function _renderReportDetailHeader() {
        var r = _currentReport;
        document.getElementById('reportDetailHeader').innerHTML =
            '<div class="modal-title">' + _html(r.report_title) +
            ' <span class="pill rs-' + _html(r.report_status) + '">' + _html(REPORT_STATUS_LABELS[r.report_status] || r.report_status) + '</span></div>';
    }

    function _renderReportDetailTabBar() {
        var tabs = [['overview', 'Overview'], ['sections', 'Sections'], ['decisions', 'Decisions'], ['actions', 'Actions'], ['events', 'Events']];
        document.getElementById('reportDetailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="detail-tab-btn' + (t[0] === _reportDetailTab ? ' active' : '') + '" onclick="erSetReportDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('#reportDetailModal .detail-tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'rdpanel-' + _reportDetailTab); });
    }
    function erSetReportDetailTab(tab) { _reportDetailTab = tab; _renderReportDetailTabBar(); }

    function _renderReportOverview() {
        var r = _currentReport;
        var editable = ['draft', 'generated', 'under_review'].indexOf(r.report_status) !== -1;

        var buttons = [];
        if (['draft', 'generated', 'under_review'].indexOf(r.report_status) !== -1) buttons.push('<button class="btn-action btn-primary" onclick="erGenerateReport()">' + (r.report_status === 'draft' ? 'Generate' : 'Regenerate') + '</button>');
        if (r.report_status === 'generated') buttons.push('<button class="btn-action btn-secondary" onclick="erReportAction(\'submit-review\')">Submit for Review</button>');
        if (r.report_status === 'under_review') buttons.push('<button class="btn-action btn-success" onclick="erReportAction(\'approve\')">Approve</button>');
        if (r.report_status === 'approved') { buttons.push('<button class="btn-action btn-success" onclick="erReportAction(\'publish\')">Publish</button>'); buttons.push('<button class="btn-action btn-secondary" onclick="erReportAction(\'archive\')">Archive</button>'); }
        if (r.report_status === 'published') buttons.push('<button class="btn-action btn-secondary" onclick="erReportAction(\'archive\')">Archive</button>');
        if (['draft', 'generated', 'under_review', 'approved'].indexOf(r.report_status) !== -1) buttons.push('<button class="btn-action btn-danger" onclick="erOpenReason(\'cancel-report\')">Cancel</button>');
        buttons.push('<a class="btn-action btn-secondary" style="text-decoration:none;" href="' + BASE + '/' + r.id + '/report-html" target="_blank">View HTML</a>');
        buttons.push('<a class="btn-action btn-secondary" style="text-decoration:none;" href="' + BASE + '/' + r.id + '/report-pdf" target="_blank">Download PDF</a>');

        var confidence = (r.report_snapshot && r.report_snapshot.confidence) || null;
        var warnings = (r.report_snapshot && r.report_snapshot.warnings) || [];

        document.getElementById('reportOverviewBody').innerHTML =
            '<div class="readonly-grid">' +
                '<div class="readonly-field"><div class="rf-label">Type</div><div class="rf-value">' + _html(r.report_type) + '</div></div>' +
                '<div class="readonly-field"><div class="rf-label">Period</div><div class="rf-value">' + _fmtDate(r.period_start) + ' – ' + _fmtDate(r.period_end) + '</div></div>' +
                '<div class="readonly-field"><div class="rf-label">Generated</div><div class="rf-value">' + _fmt(r.generated_at) + '</div></div>' +
                '<div class="readonly-field"><div class="rf-label">Confidence</div><div class="rf-value">' + _html(confidence || '—') + '</div></div>' +
            '</div>' +
            (warnings.length ? '<div class="warn-box">⚠ ' + warnings.map(_html).join('<br>⚠ ') + '</div>' : '') +
            '<div class="action-bar">' + buttons.join('') + '</div>' +
            '<div class="section-heading">Executive Summary</div><textarea id="roExecSummary" ' + (editable ? '' : 'disabled') + '>' + _html(r.executive_summary) + '</textarea>' +
            '<div class="section-heading">Practice Health Summary</div><textarea id="roHealthSummary" ' + (editable ? '' : 'disabled') + '>' + _html(r.practice_health_summary) + '</textarea>' +
            '<div class="section-heading">Key Wins</div><textarea id="roKeyWins" ' + (editable ? '' : 'disabled') + '>' + _html(r.key_wins) + '</textarea>' +
            '<div class="section-heading">Key Concerns</div><textarea id="roKeyConcerns" ' + (editable ? '' : 'disabled') + '>' + _html(r.key_concerns) + '</textarea>' +
            '<div class="section-heading">Recommendations</div><textarea id="roRecommendations" ' + (editable ? '' : 'disabled') + '>' + _html(r.recommendations) + '</textarea>' +
            (editable ? '<div class="action-bar"><button class="btn-action btn-primary" onclick="erSaveNarrative()">Save Narrative</button></div>' : '');
    }

    function erSaveNarrative() {
        var payload = {
            executive_summary: document.getElementById('roExecSummary').value || null,
            practice_health_summary: document.getElementById('roHealthSummary').value || null,
            key_wins: document.getElementById('roKeyWins').value || null,
            key_concerns: document.getElementById('roKeyConcerns').value || null,
            recommendations: document.getElementById('roRecommendations').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Saved.'); _currentReport = d.report; })
            .catch(function () { _showToast('Failed to save.'); });
    }

    function erGenerateReport() {
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/generate', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Report generated (confidence: ' + (d.confidence || '—') + ').');
                erOpenReportDetail(_currentReportId);
                erLoadReports();
                _loadSummary();
            })
            .catch(function () { _showToast('Failed to generate report.'); });
    }

    function erReportAction(action) {
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Updated.'); erOpenReportDetail(_currentReportId); erLoadReports(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update report.'); });
    }

    // ── Sections ──────────────────────────────────────────────────────────────

    function _loadReportSections() {
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/sections')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReportSections(d.sections || []); })
            .catch(function () { document.getElementById('reportSectionsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }
    function _renderReportSections(rows) {
        var el = document.getElementById('reportSectionsBody');
        if (!rows.length) { el.innerHTML = '<div class="empty-state">No sections yet — generate the report to populate them.</div>'; return; }
        el.innerHTML = rows.map(function (s) {
            var toggle = s.section_status === 'hidden'
                ? '<button class="btn-action btn-success" onclick="erSetSectionStatus(' + s.id + ',\'included\')">Include</button>'
                : '<button class="btn-action btn-secondary" onclick="erSetSectionStatus(' + s.id + ',\'hidden\')">Hide</button>';
            return '<div class="mini-card"><div style="display:flex;justify-content:space-between;"><strong>' + _html(s.section_title) + '</strong><span class="pill rs-' + _html(s.section_status) + '">' + _html(SECTION_STATUS_LABELS[s.section_status] || s.section_status) + '</span></div>' +
                '<div class="mini-card-meta">Key: ' + _html(s.section_key) + ' &middot; Order: ' + s.section_order + '</div>' +
                (s.notes ? '<div class="mini-card-meta">' + _html(s.notes) + '</div>' : '') +
                '<div class="action-bar">' + toggle + '</div></div>';
        }).join('');
    }
    function erSetSectionStatus(sectionId, status) {
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/sections/' + sectionId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section_status: status }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _loadReportSections(); })
            .catch(function () { _showToast('Failed to update section.'); });
    }

    // ── Decisions (report-scoped, within detail modal) ─────────────────────────

    function _loadReportDecisions() {
        window.PracticeAPI.fetch(BASE + '/decisions?report_id=' + _currentReportId)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReportDecisions(d.decisions || []); })
            .catch(function () { document.getElementById('reportDecisionsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }
    function _renderReportDecisions(rows) {
        var el = document.getElementById('reportDecisionsBody');
        if (!rows.length) { el.innerHTML = '<div class="empty-state">No decisions recorded yet.</div>'; return; }
        el.innerHTML = rows.map(_decisionCard).join('');
    }
    function _decisionCard(dc) {
        var btns = [];
        if (['implemented', 'cancelled', 'rejected'].indexOf(dc.decision_status) === -1) btns.push('<button class="btn-action btn-success" onclick="erCompleteDecision(' + dc.id + ')">Mark Implemented</button>');
        if (dc.decision_status !== 'cancelled') btns.push('<button class="btn-action btn-danger" onclick="erOpenReason(\'cancel-decision:' + dc.id + '\')">Cancel</button>');
        return '<div class="mini-card"><div style="display:flex;justify-content:space-between;"><strong>' + _html(dc.decision_title) + '</strong><span class="pill rs-' + _html(dc.decision_status) + '">' + _html(DECISION_STATUS_LABELS[dc.decision_status] || dc.decision_status) + '</span></div>' +
            '<div class="mini-card-meta">' + _html(dc.decision_category) + (dc.due_date ? ' &middot; Due ' + _fmtDate(dc.due_date) : '') + '</div>' +
            (dc.decision_description ? '<div class="mini-card-meta">' + _html(dc.decision_description) + '</div>' : '') +
            (btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '') + '</div>';
    }
    function erOpenCreateDecision() {
        document.getElementById('ndTitle').value = '';
        document.getElementById('ndDescription').value = '';
        document.getElementById('ndCategory').value = 'strategy';
        document.getElementById('ndOwner').innerHTML = _teamOptionsHtml;
        document.getElementById('ndDueDate').value = '';
        document.getElementById('createDecisionModal').classList.add('open');
    }
    function erCloseCreateDecision() { document.getElementById('createDecisionModal').classList.remove('open'); }
    function erSubmitCreateDecision() {
        var payload = {
            decision_title: document.getElementById('ndTitle').value,
            decision_description: document.getElementById('ndDescription').value || null,
            decision_category: document.getElementById('ndCategory').value,
            owner_team_member_id: document.getElementById('ndOwner').value || null,
            due_date: document.getElementById('ndDueDate').value || null,
        };
        if (!payload.decision_title) { _showToast('Decision title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Decision added.'); erCloseCreateDecision(); _loadReportDecisions(); erLoadDecisions(); _loadSummary(); })
            .catch(function () { _showToast('Failed to add decision.'); });
    }
    function erCompleteDecision(id) {
        window.PracticeAPI.fetch(BASE + '/decisions/' + id + '/complete', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Decision marked implemented.'); _loadReportDecisions(); erLoadDecisions(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update decision.'); });
    }

    // ── Actions (report-scoped, within detail modal) ────────────────────────────

    function _loadReportActions() {
        window.PracticeAPI.fetch(BASE + '/actions?report_id=' + _currentReportId)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReportActions(d.actions || []); })
            .catch(function () { document.getElementById('reportActionsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }
    function _renderReportActions(rows) {
        var el = document.getElementById('reportActionsBody');
        if (!rows.length) { el.innerHTML = '<div class="empty-state">No actions recorded yet.</div>'; return; }
        el.innerHTML = rows.map(_actionCard).join('');
    }
    function _actionCard(a) {
        var btns = [];
        if (['completed', 'cancelled'].indexOf(a.status) === -1) btns.push('<button class="btn-action btn-success" onclick="erCompleteAction(' + a.id + ')">Complete</button>');
        if (a.status !== 'cancelled') btns.push('<button class="btn-action btn-danger" onclick="erOpenReason(\'cancel-action:' + a.id + '\')">Cancel</button>');
        return '<div class="mini-card"><div style="display:flex;justify-content:space-between;"><strong>' + _html(a.action_title) + '</strong><span class="pill rs-' + _html(a.status) + ' prio-' + _html(a.priority) + '">' + _html(ACTION_STATUS_LABELS[a.status] || a.status) + '</span></div>' +
            '<div class="mini-card-meta">Priority: ' + _html(a.priority) + (a.due_date ? ' &middot; Due ' + _fmtDate(a.due_date) : '') + '</div>' +
            (a.action_description ? '<div class="mini-card-meta">' + _html(a.action_description) + '</div>' : '') +
            (btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '') + '</div>';
    }
    function erOpenCreateAction() {
        document.getElementById('naTitle').value = '';
        document.getElementById('naDescription').value = '';
        document.getElementById('naPriority').value = 'medium';
        document.getElementById('naOwner').innerHTML = _teamOptionsHtml;
        document.getElementById('naDueDate').value = '';
        window.PracticeAPI.fetch(BASE + '/decisions?report_id=' + _currentReportId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                document.getElementById('naDecision').innerHTML = '<option value="">— None —</option>' + (d.decisions || []).map(function (dc) { return '<option value="' + dc.id + '">' + _html(dc.decision_title) + '</option>'; }).join('');
            })
            .catch(function () {});
        document.getElementById('createActionModal').classList.add('open');
    }
    function erCloseCreateAction() { document.getElementById('createActionModal').classList.remove('open'); }
    function erSubmitCreateAction() {
        var payload = {
            action_title: document.getElementById('naTitle').value,
            action_description: document.getElementById('naDescription').value || null,
            priority: document.getElementById('naPriority').value,
            owner_team_member_id: document.getElementById('naOwner').value || null,
            due_date: document.getElementById('naDueDate').value || null,
            decision_id: document.getElementById('naDecision').value || null,
        };
        if (!payload.action_title) { _showToast('Action title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Action added.'); erCloseCreateAction(); _loadReportActions(); erLoadActions(); _loadSummary(); })
            .catch(function () { _showToast('Failed to add action.'); });
    }
    function erCompleteAction(id) {
        window.PracticeAPI.fetch(BASE + '/actions/' + id + '/complete', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Action completed.'); _loadReportActions(); erLoadActions(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update action.'); });
    }

    // ── Report Events (within detail modal) ─────────────────────────────────────

    function _loadReportEvents() {
        window.PracticeAPI.fetch(BASE + '/' + _currentReportId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReportEvents(d.events || []); })
            .catch(function () { document.getElementById('reportEventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }
    function _renderReportEvents(rows) {
        var el = document.getElementById('reportEventsBody');
        if (!rows.length) { el.innerHTML = '<div class="empty-state">No events yet.</div>'; return; }
        el.innerHTML = '<table><thead><tr><th>Event</th><th>Old → New</th><th>Notes</th><th>When</th></tr></thead><tbody>' +
            rows.map(function (e) {
                return '<tr><td>' + _html(e.event_type) + '</td><td>' + _html(e.old_status || '—') + ' → ' + _html(e.new_status || '—') + '</td><td>' + _html(e.notes || '—') + '</td><td>' + _fmt(e.created_at) + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    // ── Company-wide Decisions tab ───────────────────────────────────────────────

    function erLoadDecisions() {
        var params = new URLSearchParams();
        var status = document.getElementById('fDecisionStatus').value;
        var category = document.getElementById('fDecisionCategory').value;
        if (status) params.set('decision_status', status);
        if (category) params.set('decision_category', category);
        window.PracticeAPI.fetch(BASE + '/decisions?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderDecisionsTable(d.decisions || []); })
            .catch(function () { document.getElementById('decisionsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderDecisionsTable(rows) {
        var el = document.getElementById('decisionsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No decisions yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (dc) {
            return '<tr class="row-clickable" onclick="erOpenReportDetail(' + dc.report_id + ')"><td>' + _html(dc.decision_title) + '</td><td>' + _html(dc.decision_category) + '</td>' +
                '<td><span class="pill rs-' + _html(dc.decision_status) + '">' + _html(DECISION_STATUS_LABELS[dc.decision_status] || dc.decision_status) + '</span></td>' +
                '<td>' + _html(_reportTitleById[dc.report_id] || ('#' + dc.report_id)) + '</td><td>' + _fmtDate(dc.due_date) + '</td></tr>';
        }).join('');
    }

    // ── Company-wide Actions tab ──────────────────────────────────────────────────

    function erLoadActions() {
        var params = new URLSearchParams();
        var status = document.getElementById('fActionStatus').value;
        var priority = document.getElementById('fActionPriority').value;
        if (status) params.set('status', status);
        if (priority) params.set('priority', priority);
        window.PracticeAPI.fetch(BASE + '/actions?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderActionsTable(d.actions || []); })
            .catch(function () { document.getElementById('actionsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderActionsTable(rows) {
        var el = document.getElementById('actionsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No actions yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (a) {
            return '<tr class="row-clickable" onclick="erOpenReportDetail(' + a.report_id + ')"><td>' + _html(a.action_title) + '</td><td><span class="pill prio-' + _html(a.priority) + '">' + _html(a.priority) + '</span></td>' +
                '<td><span class="pill rs-' + _html(a.status) + '">' + _html(ACTION_STATUS_LABELS[a.status] || a.status) + '</span></td>' +
                '<td>' + _html(_reportTitleById[a.report_id] || ('#' + a.report_id)) + '</td><td>' + _fmtDate(a.due_date) + '</td></tr>';
        }).join('');
    }

    // ── Company-wide Events tab ───────────────────────────────────────────────────

    function erLoadEvents() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTable(d.events || []); })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderEventsTable(rows) {
        var el = document.getElementById('eventsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">No events yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (e) {
            return '<tr><td>' + _html(e.event_type) + '</td><td>' + _html(e.old_status || '—') + ' → ' + _html(e.new_status || '—') + '</td><td>' + _html(e.notes || '—') + '</td><td>' + _fmt(e.created_at) + '</td></tr>';
        }).join('');
    }

    // ── Reason Modal (generic cancel handler) ────────────────────────────────────

    function erOpenReason(action) {
        _pendingReasonAction = action;
        document.getElementById('reasonModalTitle').textContent = 'Reason Required';
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }
    function erCloseReason() { document.getElementById('reasonModal').classList.remove('open'); }
    function erSubmitReason() {
        var reason = document.getElementById('rfReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        var action = _pendingReasonAction;
        var url, onDone;
        if (action === 'cancel-report') {
            url = BASE + '/' + _currentReportId;
            onDone = function () { erOpenReportDetail(_currentReportId); erLoadReports(); };
        } else if (action.indexOf('cancel-decision:') === 0) {
            url = BASE + '/decisions/' + action.split(':')[1];
            onDone = function () { _loadReportDecisions(); erLoadDecisions(); };
        } else if (action.indexOf('cancel-action:') === 0) {
            url = BASE + '/actions/' + action.split(':')[1];
            onDone = function () { _loadReportActions(); erLoadActions(); };
        } else { return; }

        window.PracticeAPI.fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Cancelled.'); erCloseReason(); onDone(); _loadSummary(); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.erSetTab = erSetTab;
    window.erOpenCreateReport = erOpenCreateReport;
    window.erCloseCreateReport = erCloseCreateReport;
    window.erSubmitCreateReport = erSubmitCreateReport;
    window.erOpenReportDetail = erOpenReportDetail;
    window.erCloseReportDetail = erCloseReportDetail;
    window.erSetReportDetailTab = erSetReportDetailTab;
    window.erSaveNarrative = erSaveNarrative;
    window.erGenerateReport = erGenerateReport;
    window.erReportAction = erReportAction;
    window.erSetSectionStatus = erSetSectionStatus;
    window.erOpenCreateDecision = erOpenCreateDecision;
    window.erCloseCreateDecision = erCloseCreateDecision;
    window.erSubmitCreateDecision = erSubmitCreateDecision;
    window.erCompleteDecision = erCompleteDecision;
    window.erOpenCreateAction = erOpenCreateAction;
    window.erCloseCreateAction = erCloseCreateAction;
    window.erSubmitCreateAction = erSubmitCreateAction;
    window.erCompleteAction = erCompleteAction;
    window.erLoadReports = erLoadReports;
    window.erLoadDecisions = erLoadDecisions;
    window.erLoadActions = erLoadActions;
    window.erOpenReason = erOpenReason;
    window.erCloseReason = erCloseReason;
    window.erSubmitReason = erSubmitReason;

    document.addEventListener('DOMContentLoaded', erLoadAll);
})();
