/* Codebox 78 — Practice Automation Foundation + Workflow Orchestration
 * NOT AI. NOT autonomous decision making. Manual test-run/run-now only.
 * Prefix: auto
 */
(function () {
    'use strict';

    var BASE = '/api/practice/automation';
    var _tab = 'rules';
    var _pendingReasonAction = null;
    var _currentRuleId = null;
    var _ruleDetailTab = 'overview';
    var _catalogue = null;

    var RULE_STATUS_LABELS = { draft: 'Draft', active: 'Active', paused: 'Paused', disabled: 'Disabled', archived: 'Archived', cancelled: 'Cancelled' };
    var RUN_STATUS_LABELS = { dry_run: 'Dry Run', running: 'Running', completed: 'Completed', completed_with_warnings: 'Completed (Warnings)', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' };
    var STEP_STATUS_LABELS = { pending: 'Pending', passed: 'Passed (simulated)', skipped: 'Skipped', completed: 'Completed', failed: 'Failed', warning: 'Warning' };

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

    function autoLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadCatalogue();
        autoLoadRules();
        autoLoadRuns();
        autoLoadEvents();
    }

    function _renderTabBar() {
        var tabs = [['rules', 'Rules'], ['runs', 'Run History'], ['events', 'Events'], ['catalogue', 'Catalogue / Help']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="autoSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.page-content > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function autoSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.active_rules || 0, label: 'Active Rules' },
                    { count: d.rules_awaiting_approval || 0, label: 'Awaiting Approval' },
                    { count: d.failed_runs || 0, label: 'Failed Runs (recent)' },
                    { count: d.runs_with_warnings || 0, label: 'Runs With Warnings (recent)' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Catalogue ─────────────────────────────────────────────────────────────

    function _loadCatalogue() {
        window.PracticeAPI.fetch(BASE + '/catalogue')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _catalogue = d;
                _populateTriggerAndCategorySelects(d);
                _renderCatalogue(d);
            })
            .catch(function () {});
    }
    function _populateTriggerAndCategorySelects(d) {
        var trigSel = document.getElementById('nrTrigger');
        if (trigSel) trigSel.innerHTML = (d.triggers || []).map(function (t) { return '<option value="' + t + '">' + _html(t) + '</option>'; }).join('');
        var catSel = document.getElementById('nrCategory');
        if (catSel) catSel.innerHTML = (d.rule_categories || []).map(function (c) { return '<option value="' + c + '">' + _html(c) + '</option>'; }).join('');
        var safetySel = document.getElementById('nrSafety');
        if (safetySel) safetySel.innerHTML = (d.safety_levels || []).map(function (s) { return '<option value="' + s + '">' + _html(s) + '</option>'; }).join('');
    }
    function _renderCatalogue(d) {
        document.getElementById('catTriggers').innerHTML = (d.triggers || []).map(function (t) { return '<div class="catalogue-item"><code>' + _html(t) + '</code></div>'; }).join('');
        document.getElementById('catActions').innerHTML = (d.actions || []).map(function (a) { return '<div class="catalogue-item"><code>' + _html(a) + '</code></div>'; }).join('');
        document.getElementById('catForbidden').innerHTML = (d.forbidden_actions || []).map(function (a) { return '<div class="catalogue-item"><code>' + _html(a) + '</code> — rejected, fails safely</div>'; }).join('');
        document.getElementById('catOperators').innerHTML = (d.condition_operators || []).map(function (o) { return '<div class="catalogue-item"><code>' + _html(o) + '</code></div>'; }).join('');
        document.getElementById('catRoots').innerHTML = (d.condition_field_roots || []).map(function (r) { return '<div class="catalogue-item"><code>' + _html(r) + '</code></div>'; }).join('');
    }

    // ── Rules list ────────────────────────────────────────────────────────────

    function autoLoadRules() {
        var params = new URLSearchParams();
        var status = document.getElementById('fRuleStatus').value;
        var category = document.getElementById('fRuleCategory').value;
        if (status) params.set('rule_status', status);
        if (category) params.set('rule_category', category);
        window.PracticeAPI.fetch(BASE + '/rules?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderRules(d.rules || []); })
            .catch(function () { document.getElementById('rulesBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderRules(rows) {
        var el = document.getElementById('rulesBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No automation rules yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            var approvalBadge = r.requires_approval ? (r.approved_at ? ' <span class="pill rs-completed">Approved</span>' : ' <span class="pill rs-failed">Needs Approval</span>') : '';
            return '<tr class="row-clickable" onclick="autoOpenRuleDetail(' + r.id + ')">' +
                '<td>' + _html(r.rule_name) + approvalBadge + '</td><td>' + _html(r.trigger_type) + '</td>' +
                '<td><span class="pill rs-' + _html(r.rule_status) + '">' + _html(RULE_STATUS_LABELS[r.rule_status] || r.rule_status) + '</span></td>' +
                '<td><span class="pill safety-' + _html(r.safety_level) + '">' + _html(r.safety_level) + '</span></td>' +
                '<td>' + _fmt(r.last_run_at) + '</td></tr>';
        }).join('');
    }

    function autoSeedDefaults() {
        window.PracticeAPI.fetch(BASE + '/seed-defaults', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(d.inserted + ' seed rule(s) added.'); autoLoadRules(); _loadSummary(); })
            .catch(function () { _showToast('Failed to seed default rules.'); });
    }

    // ── Create Rule ───────────────────────────────────────────────────────────

    function autoOpenCreateRule() {
        document.getElementById('createRuleTitle').textContent = 'New Automation Rule';
        document.getElementById('createRuleError').innerHTML = '';
        document.getElementById('nrName').value = '';
        document.getElementById('nrKey').value = '';
        document.getElementById('nrDescription').value = '';
        document.getElementById('nrConditions').value = '[]';
        document.getElementById('nrActions').value = '[]';
        document.getElementById('nrRequiresApproval').checked = false;
        if (_catalogue) _populateTriggerAndCategorySelects(_catalogue);
        document.getElementById('createRuleModal').classList.add('open');
    }
    function autoCloseCreateRule() { document.getElementById('createRuleModal').classList.remove('open'); }
    function autoSubmitCreateRule() {
        var conditions, actions;
        try { conditions = JSON.parse(document.getElementById('nrConditions').value || '[]'); } catch (e) { _showRuleError('Conditions is not valid JSON.'); return; }
        try { actions = JSON.parse(document.getElementById('nrActions').value || '[]'); } catch (e) { _showRuleError('Actions is not valid JSON.'); return; }

        var payload = {
            rule_name: document.getElementById('nrName').value,
            rule_key: document.getElementById('nrKey').value,
            trigger_type: document.getElementById('nrTrigger').value,
            rule_category: document.getElementById('nrCategory').value,
            safety_level: document.getElementById('nrSafety').value,
            description: document.getElementById('nrDescription').value || null,
            conditions: conditions, actions: actions,
            requires_approval: document.getElementById('nrRequiresApproval').checked,
        };
        if (!payload.rule_name || !payload.rule_key) { _showRuleError('Rule name and rule key are required.'); return; }

        window.PracticeAPI.fetch(BASE + '/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
                if (!res.ok) { _showRuleError(res.d.error + (res.d.details ? ' — ' + res.d.details.join('; ') : '')); return; }
                _showToast('Rule created as draft.');
                autoCloseCreateRule();
                autoLoadRules();
                _loadSummary();
            })
            .catch(function () { _showRuleError('Failed to create rule.'); });
    }
    function _showRuleError(msg) {
        document.getElementById('createRuleError').innerHTML = '<div class="error-box">⚠ ' + _html(msg) + '</div>';
    }

    // ── Rule Detail ───────────────────────────────────────────────────────────

    function autoOpenRuleDetail(id) {
        _currentRuleId = id;
        _ruleDetailTab = 'overview';
        window.PracticeAPI.fetch(BASE + '/rules/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderRuleDetailHeader(d.rule);
                _renderRuleDetailTabBar();
                _renderRuleOverview(d.rule);
                _loadRuleEvents(id);
                document.getElementById('ruleDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load rule.'); });
    }
    function autoCloseRuleDetail() { document.getElementById('ruleDetailModal').classList.remove('open'); _currentRuleId = null; }

    function _renderRuleDetailHeader(rule) {
        document.getElementById('ruleDetailHeader').innerHTML =
            '<div class="modal-title">' + _html(rule.rule_name) +
            ' <span class="pill rs-' + _html(rule.rule_status) + '">' + _html(RULE_STATUS_LABELS[rule.rule_status] || rule.rule_status) + '</span>' +
            ' <span class="pill safety-' + _html(rule.safety_level) + '">' + _html(rule.safety_level) + '</span></div>';
    }
    function _renderRuleDetailTabBar() {
        var tabs = [['overview', 'Overview'], ['events', 'Events']];
        document.getElementById('ruleDetailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="detail-tab-btn' + (t[0] === _ruleDetailTab ? ' active' : '') + '" onclick="autoSetRuleDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('#ruleDetailModal .detail-tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'rddpanel-' + _ruleDetailTab); });
    }
    function autoSetRuleDetailTab(tab) { _ruleDetailTab = tab; _renderRuleDetailTabBar(); }

    function _renderRuleOverview(rule) {
        var buttons = [];
        buttons.push('<button class="btn-action btn-secondary" onclick="autoOpenTestRun()">Test (Dry Run)</button>');
        if (rule.rule_status === 'active') buttons.push('<button class="btn-action btn-danger" onclick="autoOpenTestRun(true)">Run Live Now</button>');
        if (rule.requires_approval && !rule.approved_at) buttons.push('<button class="btn-action btn-warn" onclick="autoApproveRule()">Approve (Requires Approval)</button>');
        if (['draft', 'paused', 'disabled'].indexOf(rule.rule_status) !== -1) buttons.push('<button class="btn-action btn-success" onclick="autoRuleAction(\'activate\')">Activate</button>');
        if (rule.rule_status === 'active') buttons.push('<button class="btn-action btn-secondary" onclick="autoRuleAction(\'pause\')">Pause</button>');
        if (['draft', 'active', 'paused'].indexOf(rule.rule_status) !== -1) buttons.push('<button class="btn-action btn-secondary" onclick="autoRuleAction(\'disable\')">Disable</button>');
        if (['paused', 'disabled'].indexOf(rule.rule_status) !== -1) buttons.push('<button class="btn-action btn-secondary" onclick="autoRuleAction(\'archive\')">Archive</button>');
        if (['draft', 'paused', 'disabled'].indexOf(rule.rule_status) !== -1) buttons.push('<button class="btn-action btn-danger" onclick="autoOpenReason(\'cancel-rule\')">Cancel</button>');

        var approvalNote = rule.requires_approval
            ? (rule.approved_at ? '<div class="warn-box">✓ Approved by user #' + _html(rule.approved_by) + ' on ' + _fmt(rule.approved_at) + '</div>' : '<div class="error-box">⚠ Requires approval — cannot be activated or run live until approved.</div>')
            : '';

        document.getElementById('ruleOverviewBody').innerHTML =
            '<div class="readonly-grid">' +
                '<div class="readonly-field"><div class="rf-label">Trigger</div><div class="rf-value">' + _html(rule.trigger_type) + '</div></div>' +
                '<div class="readonly-field"><div class="rf-label">Category</div><div class="rf-value">' + _html(rule.rule_category) + '</div></div>' +
                '<div class="readonly-field"><div class="rf-label">Last Run</div><div class="rf-value">' + _fmt(rule.last_run_at) + '</div></div>' +
                '<div class="readonly-field"><div class="rf-label">Rule Key</div><div class="rf-value">' + _html(rule.rule_key) + '</div></div>' +
            '</div>' +
            approvalNote +
            '<div class="action-bar">' + buttons.join('') + '</div>' +
            '<div class="section-heading">Description</div><p>' + _html(rule.description || 'No description.') + '</p>' +
            '<div class="section-heading">Conditions (what must be true)</div><pre style="background:#0d0d1f;padding:10px;border-radius:8px;font-size:.76rem;overflow-x:auto;">' + _html(JSON.stringify(rule.conditions || [], null, 2)) + '</pre>' +
            '<div class="section-heading">Actions (what will happen)</div><pre style="background:#0d0d1f;padding:10px;border-radius:8px;font-size:.76rem;overflow-x:auto;">' + _html(JSON.stringify(rule.actions || [], null, 2)) + '</pre>';
    }

    function autoApproveRule() {
        var notes = prompt('Approval notes (optional):') || '';
        window.PracticeAPI.fetch(BASE + '/rules/' + _currentRuleId + '/approve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_notes: notes || null }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Rule approved.'); autoOpenRuleDetail(_currentRuleId); autoLoadRules(); _loadSummary(); })
            .catch(function () { _showToast('Failed to approve rule.'); });
    }
    function autoRuleAction(action) {
        window.PracticeAPI.fetch(BASE + '/rules/' + _currentRuleId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Updated.'); autoOpenRuleDetail(_currentRuleId); autoLoadRules(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update rule.'); });
    }

    function _loadRuleEvents(id) {
        window.PracticeAPI.fetch(BASE + '/rules/' + id + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderRuleEvents(d.events || []); })
            .catch(function () { document.getElementById('ruleEventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }
    function _renderRuleEvents(rows) {
        var el = document.getElementById('ruleEventsBody');
        if (!rows.length) { el.innerHTML = '<div class="empty-state">No events yet.</div>'; return; }
        el.innerHTML = '<table><thead><tr><th>Event</th><th>Old → New</th><th>Notes</th><th>When</th></tr></thead><tbody>' +
            rows.map(function (e) { return '<tr><td>' + _html(e.event_type) + '</td><td>' + _html(e.old_status || '—') + ' → ' + _html(e.new_status || '—') + '</td><td>' + _html(e.notes || '—') + '</td><td>' + _fmt(e.created_at) + '</td></tr>'; }).join('') +
            '</tbody></table>';
    }

    // ── Test / Run ────────────────────────────────────────────────────────────

    function autoOpenTestRun(liveMode) {
        document.getElementById('testRunTitle').textContent = liveMode ? 'Run Live Now — real actions will execute' : 'Test Run (Dry Run) — nothing real is created';
        document.getElementById('trSource').value = '{}';
        document.getElementById('trContext').value = '{}';
        document.getElementById('trSourceType').value = '';
        document.getElementById('trSourceId').value = '';
        document.getElementById('testRunResult').innerHTML = '';
        document.getElementById('trLiveBtn').style.display = liveMode ? 'inline-block' : 'none';
        document.getElementById('testRunModal').classList.add('open');
    }
    function autoCloseTestRun() { document.getElementById('testRunModal').classList.remove('open'); }

    function autoExecuteTestRun(dryRun) {
        var source, context;
        try { source = JSON.parse(document.getElementById('trSource').value || '{}'); } catch (e) { _showToast('source is not valid JSON.'); return; }
        try { context = JSON.parse(document.getElementById('trContext').value || '{}'); } catch (e) { _showToast('context is not valid JSON.'); return; }

        if (!dryRun && !confirm('This will run the rule LIVE — real notifications/reminders/executive actions may be created. Continue?')) return;

        var url = BASE + '/rules/' + _currentRuleId + '/' + (dryRun ? 'test' : 'run');
        var payload = {
            trigger_context: { source: source, context: context },
            trigger_source_type: document.getElementById('trSourceType').value || null,
            trigger_source_id: document.getElementById('trSourceId').value ? parseInt(document.getElementById('trSourceId').value, 10) : null,
        };
        window.PracticeAPI.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { document.getElementById('testRunResult').innerHTML = '<div class="error-box">⚠ ' + _html(d.error) + '</div>'; return; }
                var run = d.run || {};
                document.getElementById('testRunResult').innerHTML =
                    '<div class="warn-box">Run #' + run.id + ' — <span class="pill rs-' + _html(run.run_status) + '">' + _html(RUN_STATUS_LABELS[run.run_status] || run.run_status) + '</span> — ' + _html(run.result_summary || '') + '</div>' +
                    (d.warnings && d.warnings.length ? '<div class="warn-box">Warnings: ' + d.warnings.map(_html).join('; ') + '</div>' : '') +
                    (d.errors && d.errors.length ? '<div class="error-box">Errors: ' + d.errors.map(_html).join('; ') + '</div>' : '') +
                    '<button class="btn-action btn-secondary" onclick="autoOpenRunDetail(' + run.id + ')">View Run Steps</button>';
                _showToast(dryRun ? 'Dry run complete.' : 'Live run complete.');
                autoLoadRuns();
                _loadSummary();
                if (!dryRun) autoOpenRuleDetail(_currentRuleId);
            })
            .catch(function () { _showToast('Failed to execute run.'); });
    }

    // ── Runs (company-wide) ──────────────────────────────────────────────────

    function autoLoadRuns() {
        var params = new URLSearchParams();
        var status = document.getElementById('fRunStatus').value;
        if (status) params.set('run_status', status);
        window.PracticeAPI.fetch(BASE + '/runs?' + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderRuns(d.runs || []); })
            .catch(function () { document.getElementById('runsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderRuns(rows) {
        var el = document.getElementById('runsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No runs yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="autoOpenRunDetail(' + r.id + ')">' +
                '<td>#' + r.id + '</td><td>' + _html(r.trigger_type) + '</td>' +
                '<td>' + (r.dry_run ? '<span class="pill rs-dry_run">Dry Run</span>' : '<span class="pill rs-failed">Live</span>') + '</td>' +
                '<td><span class="pill rs-' + _html(r.run_status) + '">' + _html(RUN_STATUS_LABELS[r.run_status] || r.run_status) + '</span></td>' +
                '<td>' + _fmt(r.started_at) + '</td></tr>';
        }).join('');
    }

    function autoOpenRunDetail(id) {
        Promise.all([
            window.PracticeAPI.fetch(BASE + '/runs/' + id).then(function (r) { return r.json(); }),
            window.PracticeAPI.fetch(BASE + '/runs/' + id + '/steps').then(function (r) { return r.json(); }),
        ]).then(function (results) {
            var run = results[0].run, steps = results[1].steps || [];
            document.getElementById('runDetailHeader').innerHTML =
                '<div class="modal-title">Run #' + run.id + ' <span class="pill rs-' + _html(run.run_status) + '">' + _html(RUN_STATUS_LABELS[run.run_status] || run.run_status) + '</span> ' +
                (run.dry_run ? '<span class="pill rs-dry_run">Dry Run</span>' : '<span class="pill rs-failed">Live</span>') + '</div>' +
                '<div class="mini-card-meta">Trigger: ' + _html(run.trigger_type) + ' &middot; Started: ' + _fmt(run.started_at) + ' &middot; Completed: ' + _fmt(run.completed_at) + '</div>' +
                '<p>' + _html(run.result_summary || '') + '</p>';
            document.getElementById('runStepsBody').innerHTML = steps.length
                ? steps.map(function (s) {
                    return '<div class="mini-card"><div style="display:flex;justify-content:space-between;"><strong>' + s.step_order + '. ' + _html(s.step_name) + '</strong><span class="pill rs-' + _html(s.step_status) + '">' + _html(STEP_STATUS_LABELS[s.step_status] || s.step_status) + '</span></div>' +
                        '<div class="mini-card-meta">Type: ' + _html(s.step_type) + '</div>' +
                        (s.error_message ? '<div class="error-box">' + _html(s.error_message) + '</div>' : '') +
                        '<pre style="background:#0d0d1f;padding:8px;border-radius:6px;font-size:.72rem;overflow-x:auto;margin-top:6px;">' + _html(JSON.stringify(s.output || {}, null, 2)) + '</pre></div>';
                }).join('')
                : '<div class="empty-state">No steps recorded.</div>';
            document.getElementById('runDetailModal').classList.add('open');
        }).catch(function () { _showToast('Failed to load run.'); });
    }
    function autoCloseRunDetail() { document.getElementById('runDetailModal').classList.remove('open'); }

    // ── Events (company-wide) ────────────────────────────────────────────────

    function autoLoadEvents() {
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

    function autoOpenReason(action) {
        _pendingReasonAction = action;
        document.getElementById('reasonModalTitle').textContent = 'Reason Required';
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }
    function autoCloseReason() { document.getElementById('reasonModal').classList.remove('open'); }
    function autoSubmitReason() {
        var reason = document.getElementById('rfReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        if (_pendingReasonAction !== 'cancel-rule') return;

        window.PracticeAPI.fetch(BASE + '/rules/' + _currentRuleId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Rule cancelled.'); autoCloseReason(); autoOpenRuleDetail(_currentRuleId); autoLoadRules(); _loadSummary(); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.autoSetTab = autoSetTab;
    window.autoSeedDefaults = autoSeedDefaults;
    window.autoOpenCreateRule = autoOpenCreateRule;
    window.autoCloseCreateRule = autoCloseCreateRule;
    window.autoSubmitCreateRule = autoSubmitCreateRule;
    window.autoOpenRuleDetail = autoOpenRuleDetail;
    window.autoCloseRuleDetail = autoCloseRuleDetail;
    window.autoSetRuleDetailTab = autoSetRuleDetailTab;
    window.autoApproveRule = autoApproveRule;
    window.autoRuleAction = autoRuleAction;
    window.autoOpenTestRun = autoOpenTestRun;
    window.autoCloseTestRun = autoCloseTestRun;
    window.autoExecuteTestRun = autoExecuteTestRun;
    window.autoOpenRunDetail = autoOpenRunDetail;
    window.autoCloseRunDetail = autoCloseRunDetail;
    window.autoLoadRules = autoLoadRules;
    window.autoLoadRuns = autoLoadRuns;
    window.autoOpenReason = autoOpenReason;
    window.autoCloseReason = autoCloseReason;
    window.autoSubmitReason = autoSubmitReason;

    document.addEventListener('DOMContentLoaded', autoLoadAll);
})();
