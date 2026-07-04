/* Codebox 69 — Secretarial Register Integrity Audit + Statutory Data Quality Review
 * "Is this entity actually ready?" before "Can we submit?" NOT data
 * correction. NOT automatic repair. NOT CIPC validation.
 * Prefix: si
 */
(function () {
    'use strict';

    var BASE = '/api/practice/secretarial-integrity';
    var _tab = 'runs';
    var _currentFindingId = null;

    var CATEGORY_LABELS = {
        register: 'Register', director: 'Director', shareholder: 'Shareholder', beneficial_owner: 'Beneficial Owner',
        governance: 'Governance', evidence: 'Evidence', calendar: 'Calendar', lifecycle: 'Lifecycle',
        annual_return: 'Annual Return', general: 'General',
    };
    var STATUS_LABELS = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', accepted_risk: 'Accepted Risk', ignored: 'Ignored' };
    var RUN_TYPE_LABELS = { manual: 'Manual', scheduled: 'Scheduled', pre_filing: 'Pre-Filing', pre_review: 'Pre-Review', full_scan: 'Full Scan' };
    var EV_LABELS = {
        run_started: 'Run Started', run_completed: 'Run Completed', finding_created: 'Finding Created',
        finding_acknowledged: 'Finding Acknowledged', finding_resolved: 'Finding Resolved',
        finding_accepted: 'Risk Accepted', finding_reopened: 'Finding Reopened',
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
    function _scoreClass(score) {
        if (score == null) return '';
        if (score >= 85) return 'score-good';
        if (score >= 60) return 'score-fair';
        return 'score-poor';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function siLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadRuns();
    }

    function _renderTabBar() {
        var tabs = [['runs', 'Audit Runs'], ['open', 'Open Findings'], ['resolved', 'Resolved Findings'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="siSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function siSetTab(tab) {
        _tab = tab; _renderTabBar();
        if (tab === 'runs') _loadRuns();
        if (tab === 'open') siLoadOpenFindings();
        if (tab === 'resolved') _loadResolvedFindings();
        if (tab === 'events') _loadEvents();
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var run = d.latest_run;
                var scoreEl = document.getElementById('scoreValue');
                scoreEl.textContent = run && run.overall_score != null ? run.overall_score : '—';
                scoreEl.className = 'sb-value ' + _scoreClass(run ? run.overall_score : null);

                var oc = d.open_findings_by_severity || {};
                var cards = [
                    { count: d.open_findings_total || 0, label: 'Open Findings' },
                    { count: oc.critical || 0, label: 'Critical' },
                    { count: oc.high || 0, label: 'High' },
                    { count: oc.medium || 0, label: 'Medium' },
                    { count: oc.low || 0, label: 'Low' },
                    { count: run ? _fmt(run.scan_started_at) : '—', label: 'Latest Audit' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function siRunAudit() {
        _showToast('Running integrity audit…');
        window.PracticeAPI.fetch(BASE + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_type: 'manual' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Audit complete — score ' + d.overall_score + ', ' + d.findings.length + ' finding(s).');
                _loadSummary(); _loadRuns();
                if (_tab === 'open') siLoadOpenFindings();
            })
            .catch(function () { _showToast('Failed to run the integrity audit.'); });
    }

    // ── Runs ──────────────────────────────────────────────────────────────────

    function _loadRuns() {
        window.PracticeAPI.fetch(BASE + '/runs')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderRuns(d.runs || []); })
            .catch(function () { document.getElementById('runsBody').innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderRuns(rows) {
        if (!rows.length) { document.getElementById('runsBody').innerHTML = '<tr><td colspan="8" class="empty-state">No audits run yet — click "Run Audit" above.</td></tr>'; return; }
        document.getElementById('runsBody').innerHTML = rows.map(function (r) {
            var result = r.scan_completed_at == null
                ? '<span class="pill st-running">Running…</span>'
                : (r.passed ? '<span class="pill st-passed">Passed</span>' : '<span class="pill st-failed">Attention Needed</span>');
            return '<tr class="row-clickable" onclick="siOpenRun(' + r.id + ')">' +
                '<td>' + _fmt(r.scan_started_at) + '</td>' +
                '<td>' + _html(RUN_TYPE_LABELS[r.run_type] || r.run_type) + '</td>' +
                '<td>' + (r.overall_score != null ? r.overall_score : '—') + '</td>' +
                '<td>' + r.critical_count + '</td><td>' + r.high_count + '</td><td>' + r.medium_count + '</td><td>' + r.low_count + '</td>' +
                '<td>' + result + '</td></tr>';
        }).join('');
    }

    function siOpenRun(id) {
        window.PracticeAPI.fetch(BASE + '/runs/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderRunDetail(d);
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load run detail.'); });
    }

    function _renderRunDetail(d) {
        var r = d.run;
        var html = '<div class="modal-title">Audit Run — ' + _fmt(r.scan_started_at) +
            (r.scan_completed_at ? (r.passed ? ' <span class="pill st-passed">Passed</span>' : ' <span class="pill st-failed">Attention Needed</span>') : ' <span class="pill st-running">Running…</span>') + '</div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">Score: <strong>' + (r.overall_score != null ? r.overall_score : '—') + '</strong> &middot; ' +
            r.critical_count + ' critical &middot; ' + r.high_count + ' high &middot; ' + r.medium_count + ' medium &middot; ' + r.low_count + ' low</div>';

        var findings = d.findings || [];
        html += findings.length ? findings.map(function (f) {
            return '<div class="mini-card' + (['critical', 'high'].indexOf(f.severity) !== -1 ? ' flag' : '') + '">' +
                '<span class="pill sev-' + _html(f.severity) + '">' + _html(f.severity) + '</span> ' +
                '<span class="pill">' + _html(CATEGORY_LABELS[f.finding_category] || f.finding_category) + '</span> ' +
                _html(f.title) + '<div class="mini-card-meta">' + _html(f.description) + '</div></div>';
        }).join('') : '<div class="empty-state">No findings — clean run.</div>';

        document.getElementById('detailBody').innerHTML = html;
    }

    function siCloseDetail() { document.getElementById('detailModal').classList.remove('open'); }

    // ── Findings ──────────────────────────────────────────────────────────────

    function siLoadOpenFindings() {
        var category = document.getElementById('ofCategory').value;
        var severity = document.getElementById('ofSeverity').value;
        var url = BASE + '/findings?status=open';
        if (category) url += '&finding_category=' + category;
        if (severity) url += '&severity=' + severity;
        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderFindingsTable('openFindingsBody', d.findings || [], true); })
            .catch(function () { document.getElementById('openFindingsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _loadResolvedFindings() {
        window.PracticeAPI.fetch(BASE + '/findings?status=resolved')
            .then(function (r) { return r.json(); })
            .then(function (d1) {
                window.PracticeAPI.fetch(BASE + '/findings?status=accepted_risk')
                    .then(function (r2) { return r2.json(); })
                    .then(function (d2) {
                        var combined = (d1.findings || []).concat(d2.findings || []);
                        _renderFindingsTable('resolvedFindingsBody', combined, false);
                    });
            })
            .catch(function () { document.getElementById('resolvedFindingsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderFindingsTable(elId, rows, isOpenTab) {
        var el = document.getElementById(elId);
        var cols = isOpenTab ? 6 : 6;
        if (!rows.length) { el.innerHTML = '<tr><td colspan="' + cols + '" class="empty-state">None.</td></tr>'; return; }
        el.innerHTML = rows.map(function (f) {
            var actions = isOpenTab
                ? ('<button class="btn-action btn-secondary" onclick="event.stopPropagation();siAcknowledge(' + f.id + ')">Ack</button> ' +
                   '<button class="btn-action btn-success" onclick="event.stopPropagation();siResolve(' + f.id + ')">Resolve</button> ' +
                   '<button class="btn-action btn-danger" onclick="event.stopPropagation();siOpenAcceptRisk(' + f.id + ')">Accept Risk</button>')
                : ('<button class="btn-action btn-secondary" onclick="event.stopPropagation();siReopen(' + f.id + ')">Reopen</button>');
            return '<tr class="row-clickable" onclick="siOpenFinding(' + f.id + ')">' +
                '<td><span class="pill sev-' + _html(f.severity) + '">' + _html(f.severity) + '</span></td>' +
                '<td>' + _html(f.client_name || '—') + '</td>' +
                '<td>' + _html(CATEGORY_LABELS[f.finding_category] || f.finding_category) + '</td>' +
                '<td>' + _html(f.title) + '</td>' +
                (isOpenTab
                    ? ('<td><span class="pill st-' + _html(f.status) + '">' + _html(STATUS_LABELS[f.status] || f.status) + '</span></td>')
                    : ('<td><span class="pill st-' + _html(f.status) + '">' + _html(STATUS_LABELS[f.status] || f.status) + '</span></td><td>' + _fmt(f.reviewed_at) + '</td>')) +
                '<td>' + actions + '</td></tr>';
        }).join('');
    }

    function siOpenFinding(id) {
        window.PracticeAPI.fetch(BASE + '/findings/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var f = d.finding;
                var html = '<div class="modal-title"><span class="pill sev-' + _html(f.severity) + '">' + _html(f.severity) + '</span> ' + _html(f.title) + '</div>';
                html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(f.client_name || 'Company-wide') + ' &middot; ' + _html(CATEGORY_LABELS[f.finding_category] || f.finding_category) + ' &middot; <span class="pill st-' + _html(f.status) + '">' + _html(STATUS_LABELS[f.status] || f.status) + '</span></div>';
                html += '<div class="mini-card">' + _html(f.description) + '</div>';
                if (f.recommended_action) html += '<div class="mini-card">Recommended action: ' + _html(f.recommended_action) + '</div>';
                if (f.notes) html += '<div class="mini-card">Notes: ' + _html(f.notes) + '</div>';
                if (f.status === 'open' || f.status === 'acknowledged') {
                    html += '<div class="action-bar">' +
                        (f.status === 'open' ? '<button class="btn-action btn-secondary" onclick="siAcknowledge(' + f.id + ')">Acknowledge</button>' : '') +
                        '<button class="btn-action btn-success" onclick="siResolve(' + f.id + ')">Resolve</button>' +
                        '<button class="btn-action btn-danger" onclick="siOpenAcceptRisk(' + f.id + ')">Accept Risk</button>' +
                        '</div>';
                } else {
                    html += '<div class="action-bar"><button class="btn-action btn-secondary" onclick="siReopen(' + f.id + ')">Reopen</button></div>';
                }
                document.getElementById('detailBody').innerHTML = html;
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load finding.'); });
    }

    function _reloadFindingsTabs() {
        _loadSummary();
        if (_tab === 'open') siLoadOpenFindings();
        if (_tab === 'resolved') _loadResolvedFindings();
    }

    function siAcknowledge(id) {
        window.PracticeAPI.fetch(BASE + '/findings/' + id + '/acknowledge', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Finding acknowledged.'); siCloseDetail(); _reloadFindingsTabs(); })
            .catch(function () { _showToast('Failed to acknowledge finding.'); });
    }
    function siResolve(id) {
        window.PracticeAPI.fetch(BASE + '/findings/' + id + '/resolve', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Finding resolved.'); siCloseDetail(); _reloadFindingsTabs(); })
            .catch(function () { _showToast('Failed to resolve finding.'); });
    }
    function siReopen(id) {
        window.PracticeAPI.fetch(BASE + '/findings/' + id + '/reopen', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Finding reopened.'); siCloseDetail(); _reloadFindingsTabs(); })
            .catch(function () { _showToast('Failed to reopen finding.'); });
    }

    function siOpenAcceptRisk(id) {
        document.getElementById('arReason').value = '';
        document.getElementById('acceptRiskModal').dataset.findingId = id;
        document.getElementById('acceptRiskModal').classList.add('open');
    }
    function siCloseAcceptRisk() { document.getElementById('acceptRiskModal').classList.remove('open'); }
    function siSubmitAcceptRisk() {
        var id = parseInt(document.getElementById('acceptRiskModal').dataset.findingId);
        var reason = document.getElementById('arReason').value;
        if (!reason) { _showToast('A reason is required to accept risk.'); return; }
        window.PracticeAPI.fetch(BASE + '/findings/' + id + '/accept-risk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Risk accepted.'); siCloseAcceptRisk(); siCloseDetail(); _reloadFindingsTabs(); })
            .catch(function () { _showToast('Failed to accept risk.'); });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function _loadEvents() {
        window.PracticeAPI.fetch(BASE + '/events')
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

    window.siSetTab = siSetTab;
    window.siRunAudit = siRunAudit;
    window.siOpenRun = siOpenRun;
    window.siCloseDetail = siCloseDetail;
    window.siLoadOpenFindings = siLoadOpenFindings;
    window.siOpenFinding = siOpenFinding;
    window.siAcknowledge = siAcknowledge;
    window.siResolve = siResolve;
    window.siReopen = siReopen;
    window.siOpenAcceptRisk = siOpenAcceptRisk;
    window.siCloseAcceptRisk = siCloseAcceptRisk;
    window.siSubmitAcceptRisk = siSubmitAcceptRisk;

    document.addEventListener('DOMContentLoaded', siLoadAll);
})();
