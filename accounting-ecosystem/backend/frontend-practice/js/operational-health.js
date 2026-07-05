/* Codebox 79 — Practice Operational Health Centre + System Readiness Monitor
 * "Is the platform ready?" Read-only monitor. NOT AI. NOT scheduled.
 * Prefix: oh
 */
(function () {
    'use strict';

    var BASE = '/api/practice/operational-health';
    var _tab = 'checklist';
    var _latestRun = null;

    var CATEGORY_LABELS = { modules: 'Modules', configuration: 'Configuration', migrations: 'Migrations', automation: 'Automation', role_links: 'Role Links', stale_data: 'Stale Data', integrations: 'Integrations' };

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

    function ohLoadAll() {
        _renderTabBar();
        _loadLatest();
        ohLoadHistory();
    }

    function _renderTabBar() {
        var tabs = [['checklist', 'Pilot Readiness Checklist'], ['findings', 'Findings'], ['history', 'Run History']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="ohSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.page-content > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function ohSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Latest run (summary + detail if available) ───────────────────────────

    function _loadLatest() {
        window.PracticeAPI.fetch(BASE + '/runs?limit=1')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var latest = (d.runs || [])[0];
                if (!latest || latest.run_status !== 'completed') { _renderScoreHero(null); return; }
                return window.PracticeAPI.fetch(BASE + '/runs/' + latest.id).then(function (r2) { return r2.json(); }).then(function (d2) {
                    _latestRun = d2.run;
                    _renderScoreHero(_latestRun);
                    _renderCategoryGrid(_latestRun);
                    _renderChecklist(_latestRun);
                    _renderFindings(_latestRun);
                });
            })
            .catch(function () { _renderScoreHero(null); });
    }

    function _renderScoreHero(run) {
        var el = document.getElementById('scoreHero');
        if (!run) { el.innerHTML = '<div class="score-value">—</div><div class="score-status">No health check has been run yet</div>'; return; }
        el.innerHTML =
            '<div class="score-value score-' + _html(run.overall_status) + '">' + run.overall_score + '</div>' +
            '<div class="score-status score-' + _html(run.overall_status) + '">' + _html(run.overall_status) + ' — last checked ' + _fmt(run.completed_at) + '</div>';
    }

    function _renderCategoryGrid(run) {
        var results = run.category_results || {};
        var cats = Object.keys(CATEGORY_LABELS);
        document.getElementById('categoryGrid').innerHTML = cats.map(function (c) {
            var r = results[c] || {};
            return '<div class="category-card"><div class="cc-score">' + (r.score != null ? r.score : '—') + '</div><div class="cc-label">' + _html(CATEGORY_LABELS[c]) + '</div></div>';
        }).join('');
    }

    function _renderChecklist(run) {
        var items = run.checklist || [];
        var el = document.getElementById('checklistBody');
        if (!items.length) { el.innerHTML = '<div class="empty-state">No checklist data.</div>'; return; }
        el.innerHTML = items.map(function (item) {
            return '<div class="checklist-item">' +
                '<span class="checklist-icon ' + (item.passed ? 'pass' : 'fail') + '">' + (item.passed ? '✓' : '✗') + '</span>' +
                '<span>' + _html(item.label) + '</span>' +
                (item.detail ? '<span class="checklist-detail">' + _html(item.detail) + '</span>' : '') +
                '</div>';
        }).join('');
    }

    function _renderFindings(run) {
        var findings = run.findings || [];
        var el = document.getElementById('findingsBody');
        if (!findings.length) { el.innerHTML = '<tr><td colspan="3" class="empty-state">No findings — everything checked out clean.</td></tr>'; return; }
        el.innerHTML = findings.map(function (f) {
            return '<tr><td>' + _html(CATEGORY_LABELS[f.category] || f.category) + '</td><td><span class="pill sev-' + _html(f.severity) + '">' + _html(f.severity) + '</span></td><td>' + _html(f.message) + '</td></tr>';
        }).join('');
    }

    // ── Run a health check now ────────────────────────────────────────────────

    function ohRunHealthCheck() {
        if (!confirm('Run a full operational health check now? This scans every Practice module and may take a few seconds.')) return;
        _showToast('Running health check…');
        window.PracticeAPI.fetch(BASE + '/run', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _latestRun = d.run;
                _renderScoreHero(_latestRun);
                _renderCategoryGrid(_latestRun);
                _renderChecklist(_latestRun);
                _renderFindings(_latestRun);
                ohLoadHistory();
                _showToast('Health check complete — score: ' + d.run.overall_score);
            })
            .catch(function () { _showToast('Failed to run health check.'); });
    }

    // ── Run history ───────────────────────────────────────────────────────────

    function ohLoadHistory() {
        window.PracticeAPI.fetch(BASE + '/runs')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderHistory(d.runs || []); })
            .catch(function () { document.getElementById('historyBody').innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderHistory(rows) {
        var el = document.getElementById('historyBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">No runs yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="ohOpenRunDetail(' + r.id + ')">' +
                '<td>#' + r.id + '</td><td><span class="pill status-' + _html(r.run_status) + '">' + _html(r.run_status) + '</span></td>' +
                '<td>' + (r.overall_score != null ? r.overall_score : '—') + '</td><td>' + _fmt(r.started_at) + '</td></tr>';
        }).join('');
    }

    function ohOpenRunDetail(id) {
        Promise.all([
            window.PracticeAPI.fetch(BASE + '/runs/' + id).then(function (r) { return r.json(); }),
            window.PracticeAPI.fetch(BASE + '/runs/' + id + '/events').then(function (r) { return r.json(); }),
        ]).then(function (results) {
            var run = results[0].run, events = results[1].events || [];
            document.getElementById('runDetailHeader').innerHTML =
                '<div class="modal-title">Run #' + run.id + ' <span class="pill status-' + _html(run.run_status) + '">' + _html(run.run_status) + '</span></div>' +
                '<div class="mini-card-meta">Started: ' + _fmt(run.started_at) + ' &middot; Completed: ' + _fmt(run.completed_at) + '</div>' +
                (run.overall_score != null ? '<p>Overall score: <strong>' + run.overall_score + '</strong> (' + _html(run.overall_status) + ')</p>' : '');
            document.getElementById('runDetailEvents').innerHTML = events.length
                ? events.map(function (e) { return '<div class="mini-card">' + _html(e.event_type) + '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' — ' + _html(e.notes) : '') + '</div></div>'; }).join('')
                : '<div class="empty-state">No events.</div>';
            document.getElementById('runDetailModal').classList.add('open');
        }).catch(function () { _showToast('Failed to load run.'); });
    }
    function ohCloseRunDetail() { document.getElementById('runDetailModal').classList.remove('open'); }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.ohSetTab = ohSetTab;
    window.ohRunHealthCheck = ohRunHealthCheck;
    window.ohOpenRunDetail = ohOpenRunDetail;
    window.ohCloseRunDetail = ohCloseRunDetail;

    document.addEventListener('DOMContentLoaded', ohLoadAll);
})();
