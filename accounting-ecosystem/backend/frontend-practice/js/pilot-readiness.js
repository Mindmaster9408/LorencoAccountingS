/* Codebox 80 — Practice Pilot Launch Readiness + Navigation/UX Consolidation
 * "Can we start pilot testing?" GO / NO-GO / CONDITIONAL GO, with a reason.
 * Prefix: pr
 */
(function () {
    'use strict';

    var BASE = '/api/practice/pilot-readiness';
    var _tab = 'matrix';
    var _currentRunId = null;
    var _currentIssueId = null;

    var CHECK_STATUS_LABELS = { not_started: 'Not Started', passed: 'Passed', failed: 'Failed', warning: 'Warning', not_applicable: 'N/A', deferred: 'Deferred' };
    var ISSUE_STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', accepted_risk: 'Accepted Risk', deferred: 'Deferred', cancelled: 'Cancelled' };
    var READINESS_LABELS = { not_ready: 'Not Ready', needs_attention: 'Needs Attention', pilot_ready: 'Pilot Ready', launch_ready: 'Launch Ready', blocked: 'Blocked' };
    var DECISION_LABELS = { no_decision: 'No Decision', go: 'GO', no_go: 'NO-GO', conditional_go: 'CONDITIONAL GO' };

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
        setTimeout(function () { el.remove(); }, 3500);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function prLoadAll() {
        _renderTabBar();
        _loadSummary();
        prLoadChecklist();
        prLoadIssues();
        prLoadRuns();
        prLoadEvents();
    }

    function _renderTabBar() {
        var tabs = [['matrix', 'Module Matrix'], ['checklist', 'Smoke-Test Checklist'], ['issues', 'Known Issues'], ['runs', 'Readiness Runs'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="prSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.page-content > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function prSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary / Go-No-Go hero ────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _renderDecisionHero(d.latest_run);
                var cards = [
                    { count: d.latest_run ? d.latest_run.overall_score : '—', label: 'Latest Readiness Score' },
                    { count: d.latest_run ? (READINESS_LABELS[d.latest_run.readiness_status] || d.latest_run.readiness_status) : '—', label: 'Readiness Status' },
                    { count: d.open_critical_issues || 0, label: 'Open Critical Issues' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + _html(c.count) + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _renderDecisionHero(run) {
        var el = document.getElementById('decisionHero');
        if (!run) { el.innerHTML = '<div class="decision-value decision-none">NO DATA YET</div><div class="decision-sub">Run a readiness check to get a Go/No-Go recommendation.</div>'; return; }
        var decision = run.decision || 'no_decision';
        el.innerHTML =
            '<div class="decision-value decision-' + _html(decision) + '">' + _html(DECISION_LABELS[decision] || decision) + '</div>' +
            '<div class="decision-sub">Readiness: ' + _html(READINESS_LABELS[run.readiness_status] || run.readiness_status) + ' (score ' + run.overall_score + ') — click a run in Readiness Runs to record or update a decision.</div>';
    }

    // ── Run a readiness check ─────────────────────────────────────────────────

    function prOpenRunReadiness() {
        document.getElementById('rrName').value = 'Readiness check — ' + new Date().toLocaleDateString('en-ZA');
        document.getElementById('rrType').value = 'internal_test';
        document.getElementById('runReadinessError').innerHTML = '';
        document.getElementById('runReadinessModal').classList.add('open');
    }
    function prCloseRunReadiness() { document.getElementById('runReadinessModal').classList.remove('open'); }
    function prSubmitRunReadiness() {
        var payload = { run_name: document.getElementById('rrName').value, run_type: document.getElementById('rrType').value };
        if (!payload.run_name) { document.getElementById('runReadinessError').innerHTML = '<div class="error-box">Run name is required.</div>'; return; }

        window.PracticeAPI.fetch(BASE + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
                if (!res.ok) { document.getElementById('runReadinessError').innerHTML = '<div class="error-box">' + _html(res.d.error) + '</div>'; return; }
                _showToast('Readiness check complete: ' + (READINESS_LABELS[res.d.run.readiness_status] || res.d.run.readiness_status));
                prCloseRunReadiness();
                _loadSummary();
                _renderMatrixFromRun(res.d.run);
                prLoadRuns();
                prLoadEvents();
            })
            .catch(function () { document.getElementById('runReadinessError').innerHTML = '<div class="error-box">Failed to run readiness check.</div>'; });
    }

    // ── Module matrix ──────────────────────────────────────────────────────────

    function _renderMatrixFromRun(run) {
        var matrix = run.module_matrix || [];
        var el = document.getElementById('matrixGrid');
        if (!matrix.length) { el.innerHTML = '<div class="empty-state">No matrix data.</div>'; return; }
        el.innerHTML = matrix.map(function (m) {
            return '<div class="matrix-card"><div class="matrix-score">' + (m.score != null ? m.score : '—') + '</div><div class="matrix-label">' + _html(m.area) + '</div></div>';
        }).join('');
    }

    // ── Checklist ─────────────────────────────────────────────────────────────

    function prLoadChecklist() {
        window.PracticeAPI.fetch(BASE + '/checklist')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderChecklist(d.checklist || []); })
            .catch(function () { document.getElementById('checklistBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderChecklist(rows) {
        var el = document.getElementById('checklistBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No checklist items yet — click "Seed Default Checklist".</td></tr>'; return; }
        el.innerHTML = rows.map(function (c) {
            var link = c.linked_url ? '<a href="' + c.linked_url + '" target="_blank" style="color:#a3bffa;">Open</a>' : '';
            return '<tr><td>' + _html(c.check_title) + '</td><td>' + _html(c.check_category) + '</td>' +
                '<td><span class="pill sev-' + _html(c.severity) + '">' + _html(c.severity) + '</span></td>' +
                '<td><select onchange="prUpdateChecklistStatus(' + c.id + ', this.value)">' +
                Object.keys(CHECK_STATUS_LABELS).map(function (s) { return '<option value="' + s + '"' + (s === c.check_status ? ' selected' : '') + '>' + CHECK_STATUS_LABELS[s] + '</option>'; }).join('') +
                '</select></td><td>' + link + '</td></tr>';
        }).join('');
    }
    function prSeedChecklist() {
        window.PracticeAPI.fetch(BASE + '/checklist/seed-defaults', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast((d.inserted || 0) + ' checklist item(s) seeded.'); prLoadChecklist(); })
            .catch(function () { _showToast('Failed to seed checklist.'); });
    }
    function prUpdateChecklistStatus(id, status) {
        window.PracticeAPI.fetch(BASE + '/checklist/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ check_status: status }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Checklist item updated.'); })
            .catch(function () { _showToast('Failed to update checklist item.'); });
    }

    // ── Known Issues ──────────────────────────────────────────────────────────

    function prLoadIssues() {
        var params = new URLSearchParams();
        var status = document.getElementById('fIssueStatus').value;
        var severity = document.getElementById('fIssueSeverity').value;
        if (status) params.set('issue_status', status);
        if (severity) params.set('severity', severity);
        window.PracticeAPI.fetch(BASE + '/issues?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderIssues(d.issues || []); })
            .catch(function () { document.getElementById('issuesBody').innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderIssues(rows) {
        var el = document.getElementById('issuesBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">No known issues.</td></tr>'; return; }
        el.innerHTML = rows.map(function (i) {
            return '<tr class="row-clickable" onclick="prOpenIssueDetail(' + i.id + ')"><td>' + _html(i.issue_title) + '</td><td>' + _html(i.issue_category) + '</td>' +
                '<td><span class="pill sev-' + _html(i.severity) + '">' + _html(i.severity) + '</span></td>' +
                '<td><span class="pill status-' + _html(i.issue_status) + '">' + _html(ISSUE_STATUS_LABELS[i.issue_status] || i.issue_status) + '</span></td></tr>';
        }).join('');
    }

    function prOpenCreateIssue() {
        document.getElementById('niTitle').value = '';
        document.getElementById('niDescription').value = '';
        document.getElementById('niCategory').value = 'bug';
        document.getElementById('niSeverity').value = 'medium';
        document.getElementById('niAffectedModule').value = '';
        document.getElementById('niAffectedUrl').value = '';
        document.getElementById('niRepro').value = '';
        document.getElementById('createIssueModal').classList.add('open');
    }
    function prCloseCreateIssue() { document.getElementById('createIssueModal').classList.remove('open'); }
    function prSubmitCreateIssue() {
        var payload = {
            issue_title: document.getElementById('niTitle').value,
            issue_description: document.getElementById('niDescription').value || null,
            issue_category: document.getElementById('niCategory').value,
            severity: document.getElementById('niSeverity').value,
            affected_module: document.getElementById('niAffectedModule').value || null,
            affected_url: document.getElementById('niAffectedUrl').value || null,
            reproduction_steps: document.getElementById('niRepro').value || null,
        };
        if (!payload.issue_title) { _showToast('Issue title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Issue reported.'); prCloseCreateIssue(); prLoadIssues(); _loadSummary(); })
            .catch(function () { _showToast('Failed to report issue.'); });
    }

    function prOpenIssueDetail(id) {
        _currentIssueId = id;
        window.PracticeAPI.fetch(BASE + '/issues/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var i = d.issue;
                document.getElementById('issueDetailHeader').innerHTML =
                    '<div class="modal-title">' + _html(i.issue_title) + ' <span class="pill status-' + _html(i.issue_status) + '">' + _html(ISSUE_STATUS_LABELS[i.issue_status] || i.issue_status) + '</span></div>';
                document.getElementById('issueDetailBody').innerHTML =
                    '<p><strong>Category:</strong> ' + _html(i.issue_category) + ' &middot; <strong>Severity:</strong> ' + _html(i.severity) + '</p>' +
                    (i.issue_description ? '<p>' + _html(i.issue_description) + '</p>' : '') +
                    (i.reproduction_steps ? '<div class="mini-card"><strong>Repro:</strong> ' + _html(i.reproduction_steps) + '</div>' : '') +
                    (i.resolution_notes ? '<div class="mini-card"><strong>Resolution notes:</strong> ' + _html(i.resolution_notes) + '</div>' : '');
                document.getElementById('idResolutionNotes').value = '';
                document.getElementById('issueDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load issue.'); });
    }
    function prCloseIssueDetail() { document.getElementById('issueDetailModal').classList.remove('open'); _currentIssueId = null; }
    function prResolveIssue() {
        var notes = document.getElementById('idResolutionNotes').value;
        window.PracticeAPI.fetch(BASE + '/issues/' + _currentIssueId + '/resolve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution_notes: notes || null }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Issue resolved.'); prCloseIssueDetail(); prLoadIssues(); _loadSummary(); })
            .catch(function () { _showToast('Failed to resolve issue.'); });
    }
    function prAcceptRisk() {
        var notes = document.getElementById('idResolutionNotes').value;
        if (!notes) { _showToast('Notes are required to accept risk.'); return; }
        window.PracticeAPI.fetch(BASE + '/issues/' + _currentIssueId + '/accept-risk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution_notes: notes }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Risk accepted.'); prCloseIssueDetail(); prLoadIssues(); _loadSummary(); })
            .catch(function () { _showToast('Failed to accept risk.'); });
    }

    // ── Readiness Runs ────────────────────────────────────────────────────────

    function prLoadRuns() {
        window.PracticeAPI.fetch(BASE + '/runs')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderRuns(d.runs || []); })
            .catch(function () { document.getElementById('runsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderRuns(rows) {
        var el = document.getElementById('runsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="6" class="empty-state">No readiness runs yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="prOpenRunDetail(' + r.id + ')"><td>' + _html(r.run_name) + '</td><td>' + _html(r.run_type) + '</td>' +
                '<td><span class="pill status-' + _html(r.readiness_status) + '">' + _html(READINESS_LABELS[r.readiness_status] || r.readiness_status) + '</span></td>' +
                '<td>' + r.overall_score + '</td>' +
                '<td><span class="pill status-' + _html(r.decision) + '">' + _html(DECISION_LABELS[r.decision] || r.decision) + '</span></td>' +
                '<td>' + _fmt(r.created_at) + '</td></tr>';
        }).join('');
    }

    function prOpenRunDetail(id) {
        _currentRunId = id;
        window.PracticeAPI.fetch(BASE + '/runs/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var run = d.run;
                document.getElementById('runDetailHeader').innerHTML =
                    '<div class="modal-title">' + _html(run.run_name) + ' <span class="pill status-' + _html(run.readiness_status) + '">' + _html(READINESS_LABELS[run.readiness_status] || run.readiness_status) + '</span></div>';
                var snap = run.readiness_snapshot || {};
                var blockers = snap.blockers || [];
                var warnings = snap.warnings || [];
                var actions = snap.recommended_next_actions || [];
                document.getElementById('runDetailBody').innerHTML =
                    '<p>Score: <strong>' + run.overall_score + '</strong> &middot; Critical blockers: ' + run.critical_blockers + '</p>' +
                    (blockers.length ? '<div class="error-box">' + blockers.map(function (b) { return _html(b.message); }).join('<br>') + '</div>' : '') +
                    (warnings.length ? '<div class="warn-box">' + warnings.map(function (w) { return _html(w.message); }).join('<br>') + '</div>' : '') +
                    (actions.length ? '<div class="section-heading">Recommended Next Actions</div><ul>' + actions.map(function (a) { return '<li>' + _html(a) + '</li>'; }).join('') + '</ul>' : '');
                _renderMatrixFromRun(run);
                document.getElementById('rdDecisionNotes').value = run.decision_notes || '';
                document.getElementById('runDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load run.'); });
    }
    function prCloseRunDetail() { document.getElementById('runDetailModal').classList.remove('open'); _currentRunId = null; }
    function prRecordDecision(decision) {
        var notes = document.getElementById('rdDecisionNotes').value;
        window.PracticeAPI.fetch(BASE + '/runs/' + _currentRunId + '/decision', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: decision, decision_notes: notes || null }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Decision recorded: ' + (DECISION_LABELS[decision] || decision)); prCloseRunDetail(); prLoadRuns(); _loadSummary(); prLoadEvents(); })
            .catch(function () { _showToast('Failed to record decision.'); });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function prLoadEvents() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEvents(d.events || []); })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderEvents(rows) {
        var el = document.getElementById('eventsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">No events yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (e) {
            return '<tr><td>' + _html(e.event_type) + '</td><td>' + _html(e.old_status || '—') + ' → ' + _html(e.new_status || '—') + '</td><td>' + _html(e.notes || '—') + '</td><td>' + _fmt(e.created_at) + '</td></tr>';
        }).join('');
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.prSetTab = prSetTab;
    window.prOpenRunReadiness = prOpenRunReadiness;
    window.prCloseRunReadiness = prCloseRunReadiness;
    window.prSubmitRunReadiness = prSubmitRunReadiness;
    window.prSeedChecklist = prSeedChecklist;
    window.prUpdateChecklistStatus = prUpdateChecklistStatus;
    window.prLoadIssues = prLoadIssues;
    window.prOpenCreateIssue = prOpenCreateIssue;
    window.prCloseCreateIssue = prCloseCreateIssue;
    window.prSubmitCreateIssue = prSubmitCreateIssue;
    window.prOpenIssueDetail = prOpenIssueDetail;
    window.prCloseIssueDetail = prCloseIssueDetail;
    window.prResolveIssue = prResolveIssue;
    window.prAcceptRisk = prAcceptRisk;
    window.prOpenRunDetail = prOpenRunDetail;
    window.prCloseRunDetail = prCloseRunDetail;
    window.prRecordDecision = prRecordDecision;

    document.addEventListener('DOMContentLoaded', prLoadAll);
})();
