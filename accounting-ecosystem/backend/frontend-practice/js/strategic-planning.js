/* Codebox 76 — Practice Strategic Planning + Objectives Management
 * "Where are we going?" NOT project management. NOT task management. NOT HR
 * performance. KPI links reference existing KPI engines — never a duplicate
 * KPI calculation. NOT AI — every score deterministic with its formula shown.
 * Prefix: sp
 */
(function () {
    'use strict';

    var BASE = '/api/practice/strategic-planning';
    var TEAM_BASE = '/api/practice/team';
    var _tab = 'plans';
    var _planDetailTab = 'overview';
    var _currentPlanId = null;
    var _currentObjectiveId = null;
    var _pendingReasonAction = null;
    var _teamOptionsHtml = '<option value="">— None —</option>';

    var PLAN_STATUS_LABELS = { draft: 'Draft', active: 'Active', under_review: 'Under Review', completed: 'Completed', archived: 'Archived', cancelled: 'Cancelled' };
    var OBJECTIVE_STATUS_LABELS = { not_started: 'Not Started', in_progress: 'In Progress', on_track: 'On Track', at_risk: 'At Risk', off_track: 'Off Track', achieved: 'Achieved', deferred: 'Deferred', cancelled: 'Cancelled' };
    var INITIATIVE_STATUS_LABELS = { not_started: 'Not Started', in_progress: 'In Progress', blocked: 'Blocked', completed: 'Completed', deferred: 'Deferred', cancelled: 'Cancelled' };
    var REVIEW_STATUS_LABELS = { draft: 'Draft', under_review: 'Under Review', reviewed: 'Reviewed', action_required: 'Action Required', completed: 'Completed', cancelled: 'Cancelled' };
    var AREA_LABELS = { growth: 'Growth', profitability: 'Profitability', quality: 'Quality', client_success: 'Client Success', capacity: 'Capacity', team_development: 'Team Development', risk: 'Risk', compliance: 'Compliance', secretarial: 'Secretarial', tax: 'Tax', operational_excellence: 'Operational Excellence', technology: 'Technology', other: 'Other' };

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
    function _progressBar(pct) {
        var p = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
        return '<div class="progress-bar"><div class="progress-bar-fill" style="width:' + p + '%;"></div></div>';
    }
    function _optionsFrom(list, labelMap) {
        return list.map(function (v) { return '<option value="' + v + '">' + _html((labelMap && labelMap[v]) || v) + '</option>'; }).join('');
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function spLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadTeamMembers();
        spLoadPlans();
        spLoadReviews();
        spLoadEvents();
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
        var tabs = [['plans', 'Plans'], ['reviews', 'Reviews'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="spSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.page-content > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function spSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.plans_total || 0, label: 'Total Plans' },
                    { count: d.active_plans || 0, label: 'Active Plans' },
                    { count: d.at_risk_objectives || 0, label: 'At-Risk Objectives' },
                    { count: d.open_reviews || 0, label: 'Open Reviews' },
                    { count: d.reviews_due || 0, label: 'Reviews Due' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Plans list ────────────────────────────────────────────────────────────

    function spLoadPlans() {
        window.PracticeAPI.fetch(BASE + '/plans')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderPlans(d.plans || []); })
            .catch(function () { document.getElementById('plansBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderPlans(rows) {
        var el = document.getElementById('plansBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No strategic plans yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (p) {
            return '<tr class="row-clickable" onclick="spOpenPlanDetail(' + p.id + ')">' +
                '<td>' + _html(p.plan_name) + '</td><td>' + p.plan_year + '</td>' +
                '<td>' + _fmtDate(p.period_start) + ' – ' + _fmtDate(p.period_end) + '</td>' +
                '<td><span class="pill ps-' + _html(p.plan_status) + '">' + _html(PLAN_STATUS_LABELS[p.plan_status] || p.plan_status) + '</span></td>' +
                '<td>' + _html(p.strategic_theme || '—') + '</td></tr>';
        }).join('');
    }

    function spOpenCreatePlan() {
        document.getElementById('npName').value = '';
        document.getElementById('npYear').value = new Date().getFullYear();
        document.getElementById('npTheme').value = '';
        document.getElementById('npPeriodStart').value = new Date().getFullYear() + '-01-01';
        document.getElementById('npPeriodEnd').value = new Date().getFullYear() + '-12-31';
        document.getElementById('npVision').value = '';
        document.getElementById('createPlanModal').classList.add('open');
    }
    function spCloseCreatePlan() { document.getElementById('createPlanModal').classList.remove('open'); }
    function spSubmitCreatePlan() {
        var payload = {
            plan_name: document.getElementById('npName').value, plan_year: document.getElementById('npYear').value,
            period_start: document.getElementById('npPeriodStart').value, period_end: document.getElementById('npPeriodEnd').value,
            strategic_theme: document.getElementById('npTheme').value || null, vision_statement: document.getElementById('npVision').value || null,
        };
        if (!payload.plan_name || !payload.plan_year || !payload.period_start || !payload.period_end) { _showToast('Plan name, year, and period are required.'); return; }
        window.PracticeAPI.fetch(BASE + '/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Plan created.'); spCloseCreatePlan(); _loadSummary(); spLoadPlans(); })
            .catch(function () { _showToast('Failed to create plan.'); });
    }

    // ── Plan Detail ───────────────────────────────────────────────────────────

    function spOpenPlanDetail(id) {
        _currentPlanId = id;
        _planDetailTab = 'overview';
        window.PracticeAPI.fetch(BASE + '/plans/' + id + '/health')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderPlanDetail(d);
                document.getElementById('planDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load plan.'); });
    }
    function spClosePlanDetail() { document.getElementById('planDetailModal').classList.remove('open'); }

    function _renderPlanDetail(health) {
        var p = health.plan;
        document.getElementById('planDetailHeader').innerHTML =
            '<div class="modal-title">' + _html(p.plan_name) + ' (' + p.plan_year + ') <span class="pill ps-' + _html(p.plan_status) + '">' + _html(PLAN_STATUS_LABELS[p.plan_status] || p.plan_status) + '</span></div>' +
            _renderPlanActionBar(p);

        var tabs = [['overview', 'Overview'], ['objectives', 'Objectives'], ['reviews', 'Reviews'], ['events', 'Events']];
        document.getElementById('planDetailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="detail-tab-btn' + (t[0] === _planDetailTab ? ' active' : '') + '" onclick="spSetPlanDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('#planDetailModal .detail-tab-panel').forEach(function (el) { el.classList.toggle('active', el.id === 'pdpanel-' + _planDetailTab); });

        var overview = '<div class="readonly-grid">' +
            '<div class="readonly-field"><div class="rf-label">Overall Progress</div><div class="rf-value">' + (health.overall_progress != null ? health.overall_progress + '%' : '—') + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">At-Risk Objectives</div><div class="rf-value">' + health.at_risk_objectives.length + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Blocked Initiatives</div><div class="rf-value">' + health.blocked_initiatives.length + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Overdue Initiatives</div><div class="rf-value">' + health.overdue_initiatives.length + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">KPI Gaps</div><div class="rf-value">' + health.kpi_gaps.length + '</div></div>' +
            '</div>';
        if (p.vision_statement) overview += '<div class="mini-card">Vision: ' + _html(p.vision_statement) + '</div>';
        if (p.executive_summary) overview += '<div class="mini-card">' + _html(p.executive_summary) + '</div>';
        if (p.partner_notes) overview += '<div class="mini-card">Partner notes: ' + _html(p.partner_notes) + '</div>';
        overview += '<div class="section-heading">Recommended Next Manual Actions</div>';
        overview += health.recommended_next_manual_actions.length
            ? health.recommended_next_manual_actions.map(function (a) { return '<div class="mini-card flag">' + _html(a) + '</div>'; }).join('')
            : '<div class="empty-state">No flags — plan looks healthy.</div>';
        document.getElementById('planOverviewBody').innerHTML = overview;

        _renderObjectivesList(health.objectives || []);
        if (_planDetailTab === 'reviews') _loadPlanReviews(p.id);
        if (_planDetailTab === 'events') _loadPlanEvents(p.id);
    }

    function spSetPlanDetailTab(tab) {
        _planDetailTab = tab;
        document.querySelectorAll('#planDetailTabBar .detail-tab-btn').forEach(function (b, i) {
            var tabs = ['overview', 'objectives', 'reviews', 'events'];
            b.classList.toggle('active', tabs[i] === tab);
        });
        document.querySelectorAll('#planDetailModal .detail-tab-panel').forEach(function (el) { el.classList.toggle('active', el.id === 'pdpanel-' + tab); });
        if (tab === 'reviews') _loadPlanReviews(_currentPlanId);
        if (tab === 'events') _loadPlanEvents(_currentPlanId);
    }

    function _renderPlanActionBar(p) {
        var btns = [];
        if (p.plan_status === 'draft') btns.push('<button class="btn-action btn-primary" onclick="spPlanAction(\'activate\')">Activate</button>');
        if (['active', 'under_review'].indexOf(p.plan_status) !== -1) btns.push('<button class="btn-action btn-success" onclick="spPlanAction(\'complete\')">Complete</button>');
        if (['completed', 'cancelled'].indexOf(p.plan_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="spPlanAction(\'archive\')">Archive</button>');
        if (['draft', 'active', 'under_review'].indexOf(p.plan_status) !== -1) btns.push('<button class="btn-action btn-danger" onclick="spOpenReason(\'cancel-plan\')">Cancel Plan</button>');
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }
    function spPlanAction(action) {
        window.PracticeAPI.fetch(BASE + '/plans/' + _currentPlanId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Plan updated.'); spOpenPlanDetail(_currentPlanId); spLoadPlans(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update plan.'); });
    }

    // ── Objectives ────────────────────────────────────────────────────────────

    function _renderObjectivesList(objectives) {
        var el = document.getElementById('objectivesBody');
        if (!objectives.length) { el.innerHTML = '<div class="empty-state">No objectives yet.</div>'; return; }
        el.innerHTML = objectives.map(function (o) {
            return '<div class="mini-card row-clickable" onclick="spOpenObjectiveDetail(' + o.id + ')">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<strong>' + _html(o.objective_title) + '</strong>' +
                '<span><span class="pill prio-' + _html(o.priority) + '">' + _html(o.priority) + '</span> <span class="pill ps-' + _html(o.objective_status) + '">' + _html(OBJECTIVE_STATUS_LABELS[o.objective_status] || o.objective_status) + '</span></span>' +
                '</div>' +
                '<div class="mini-card-meta">' + _html(AREA_LABELS[o.objective_area] || o.objective_area) + ' &middot; ' + (o.computed_progress != null ? o.computed_progress + '%' : '—') + ' &middot; ' + o.initiative_count + ' initiative(s), ' + o.kpi_link_count + ' KPI link(s)</div>' +
                _progressBar(o.computed_progress) +
                '</div>';
        }).join('');
    }

    function spOpenCreateObjective() {
        document.getElementById('noTitle').value = '';
        document.getElementById('noDescription').value = '';
        document.getElementById('noArea').value = 'growth';
        document.getElementById('noPriority').value = 'medium';
        document.getElementById('noOwner').innerHTML = _teamOptionsHtml;
        document.getElementById('noTargetDate').value = '';
        document.getElementById('noSuccessMeasure').value = '';
        document.getElementById('createObjectiveModal').classList.add('open');
    }
    function spCloseCreateObjective() { document.getElementById('createObjectiveModal').classList.remove('open'); }
    function spSubmitCreateObjective() {
        var title = document.getElementById('noTitle').value;
        if (!title) { _showToast('Objective title is required.'); return; }
        var payload = {
            objective_title: title, objective_description: document.getElementById('noDescription').value || null,
            objective_area: document.getElementById('noArea').value, priority: document.getElementById('noPriority').value,
            owner_team_member_id: document.getElementById('noOwner').value || null, target_date: document.getElementById('noTargetDate').value || null,
            success_measure: document.getElementById('noSuccessMeasure').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/plans/' + _currentPlanId + '/objectives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Objective created.'); spCloseCreateObjective(); spOpenPlanDetail(_currentPlanId); })
            .catch(function () { _showToast('Failed to create objective.'); });
    }

    function spOpenObjectiveDetail(id) {
        _currentObjectiveId = id;
        window.PracticeAPI.fetch(BASE + '/objectives/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderObjectiveDetail(d.objective, d.initiatives || [], d.kpi_links || []);
                document.getElementById('objectiveDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load objective.'); });
    }
    function spCloseObjectiveDetail() { document.getElementById('objectiveDetailModal').classList.remove('open'); spOpenPlanDetail(_currentPlanId); }

    function _renderObjectiveDetail(o, initiatives, kpiLinks) {
        var html = '<div class="modal-title">' + _html(o.objective_title) + ' <span class="pill ps-' + _html(o.objective_status) + '">' + _html(OBJECTIVE_STATUS_LABELS[o.objective_status] || o.objective_status) + '</span></div>';
        html += '<div class="form-group"><label>Status</label><select onchange="spUpdateObjectiveStatus(this.value)">' + _optionsFrom(['not_started', 'in_progress', 'on_track', 'at_risk', 'off_track', 'achieved', 'deferred'], OBJECTIVE_STATUS_LABELS).replace('value="' + o.objective_status + '"', 'value="' + o.objective_status + '" selected') + '</select></div>';
        html += '<div class="mini-card-meta">Computed progress: ' + (o.computed_progress != null ? o.computed_progress + '%' : '—') + ' — ' + _html(o.formula || '') + '</div>';
        html += _progressBar(o.computed_progress);
        if (o.objective_description) html += '<div class="mini-card">' + _html(o.objective_description) + '</div>';
        if (o.success_measure) html += '<div class="mini-card">Success measure: ' + _html(o.success_measure) + '</div>';

        html += '<div class="section-heading">Initiatives <button class="btn-action btn-add" onclick="spOpenCreateInitiative()">+ Add</button></div>';
        html += initiatives.length ? initiatives.map(function (i) {
            return '<div class="mini-card' + (i.initiative_status === 'blocked' ? ' flag' : '') + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' + _html(i.initiative_title) +
                '<select onchange="spUpdateInitiativeStatus(' + i.id + ', this.value)">' + _optionsFrom(['not_started', 'in_progress', 'blocked', 'completed', 'deferred'], INITIATIVE_STATUS_LABELS).replace('value="' + i.initiative_status + '"', 'value="' + i.initiative_status + '" selected') + '</select></div>' +
                '<div class="mini-card-meta">Due: ' + _fmtDate(i.due_date) + ' &middot; Progress: ' + i.progress_percentage + '%' + (i.next_action ? ' &middot; Next: ' + _html(i.next_action) : '') + '</div>' +
                (i.blocker_notes ? '<div class="mini-card-meta">Blocker: ' + _html(i.blocker_notes) + '</div>' : '') + '</div>';
        }).join('') : '<div class="empty-state">No initiatives yet.</div>';

        html += '<div class="section-heading">KPI Links <button class="btn-action btn-add" onclick="spOpenCreateKpi()">+ Add</button></div>';
        html += kpiLinks.length ? kpiLinks.map(function (k) {
            return '<div class="mini-card"><strong>' + _html(k.metric_label) + '</strong> <span class="mini-card-meta">(' + _html(k.kpi_source) + ' / ' + _html(k.confidence) + ')</span>' +
                '<div class="mini-card-meta">Baseline: ' + (k.baseline_value != null ? k.baseline_value : '—') + ' &middot; Current: ' + (k.current_value != null ? k.current_value : '—') + ' &middot; Target: ' + (k.target_value != null ? k.target_value : '—') + ' &middot; ' + _html(k.direction) + '</div>' +
                (k.computed_progress != null ? '<div class="mini-card-meta">Progress: ' + Math.round(k.computed_progress) + '%</div>' : '') + '</div>';
        }).join('') : '<div class="empty-state">No KPI links yet.</div>';

        document.getElementById('objectiveDetailBody').innerHTML = html;
    }

    function spUpdateObjectiveStatus(status) {
        window.PracticeAPI.fetch(BASE + '/objectives/' + _currentObjectiveId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objective_status: status }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Objective updated.'); spOpenObjectiveDetail(_currentObjectiveId); })
            .catch(function () { _showToast('Failed to update objective.'); });
    }

    // ── Initiatives ───────────────────────────────────────────────────────────

    function spOpenCreateInitiative() {
        document.getElementById('niTitle').value = '';
        document.getElementById('niDescription').value = '';
        document.getElementById('niOwner').innerHTML = _teamOptionsHtml;
        document.getElementById('niDueDate').value = '';
        document.getElementById('niNextAction').value = '';
        document.getElementById('createInitiativeModal').classList.add('open');
    }
    function spCloseCreateInitiative() { document.getElementById('createInitiativeModal').classList.remove('open'); }
    function spSubmitCreateInitiative() {
        var title = document.getElementById('niTitle').value;
        if (!title) { _showToast('Initiative title is required.'); return; }
        var payload = {
            initiative_title: title, initiative_description: document.getElementById('niDescription').value || null,
            owner_team_member_id: document.getElementById('niOwner').value || null, due_date: document.getElementById('niDueDate').value || null,
            next_action: document.getElementById('niNextAction').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/objectives/' + _currentObjectiveId + '/initiatives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Initiative added.'); spCloseCreateInitiative(); spOpenObjectiveDetail(_currentObjectiveId); })
            .catch(function () { _showToast('Failed to add initiative.'); });
    }
    function spUpdateInitiativeStatus(id, status) {
        window.PracticeAPI.fetch(BASE + '/initiatives/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initiative_status: status }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Initiative updated.'); spOpenObjectiveDetail(_currentObjectiveId); })
            .catch(function () { _showToast('Failed to update initiative.'); });
    }

    // ── KPI Links ─────────────────────────────────────────────────────────────

    function spOpenCreateKpi() {
        document.getElementById('nkSource').value = 'management_dashboard';
        document.getElementById('nkMetricKey').value = '';
        document.getElementById('nkMetricLabel').value = '';
        document.getElementById('nkDirection').value = 'increase';
        document.getElementById('nkWeight').value = 1;
        document.getElementById('nkBaseline').value = '';
        document.getElementById('nkTarget').value = '';
        document.getElementById('nkCurrent').value = '';
        document.getElementById('createKpiModal').classList.add('open');
    }
    function spCloseCreateKpi() { document.getElementById('createKpiModal').classList.remove('open'); }
    function spSubmitCreateKpi() {
        var metricKey = document.getElementById('nkMetricKey').value;
        var metricLabel = document.getElementById('nkMetricLabel').value;
        if (!metricKey || !metricLabel) { _showToast('Metric key and label are required.'); return; }
        var payload = {
            kpi_source: document.getElementById('nkSource').value, metric_key: metricKey, metric_label: metricLabel,
            direction: document.getElementById('nkDirection').value, weight: document.getElementById('nkWeight').value || 1,
            baseline_value: document.getElementById('nkBaseline').value || null, target_value: document.getElementById('nkTarget').value || null,
            current_value: document.getElementById('nkCurrent').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/objectives/' + _currentObjectiveId + '/kpis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('KPI link added.'); spCloseCreateKpi(); spOpenObjectiveDetail(_currentObjectiveId); })
            .catch(function () { _showToast('Failed to add KPI link.'); });
    }

    // ── Reviews (plan-scoped, within Plan Detail) ────────────────────────────────

    function _loadPlanReviews(planId) {
        window.PracticeAPI.fetch(BASE + '/plans/' + planId + '/reviews')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderPlanReviews(d.reviews || []); })
            .catch(function () { document.getElementById('planReviewsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }
    function _renderPlanReviews(rows) {
        var el = document.getElementById('planReviewsBody');
        if (!rows.length) { el.innerHTML = '<div class="empty-state">No reviews yet.</div>'; return; }
        el.innerHTML = rows.map(function (r) {
            var btns = [];
            if (['draft', 'under_review', 'action_required'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-success" onclick="spReviewAction(' + r.id + ',\'complete\')">Complete</button>');
            if (['draft', 'under_review'].indexOf(r.review_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="spReviewAction(' + r.id + ',\'action-required\')">Mark Action Required</button>');
            if (['completed', 'cancelled'].indexOf(r.review_status) === -1) btns.push('<button class="btn-action btn-danger" onclick="spOpenReason(\'cancel-review:' + r.id + '\')">Cancel</button>');
            return '<div class="mini-card"><div style="display:flex;justify-content:space-between;"><strong>' + _html(r.review_title) + '</strong><span class="pill ps-' + _html(r.review_status) + '">' + _html(REVIEW_STATUS_LABELS[r.review_status] || r.review_status) + '</span></div>' +
                '<div class="mini-card-meta">Overall progress: ' + (r.overall_progress != null ? r.overall_progress + '%' : '—') + ' &middot; Next review: ' + _fmtDate(r.next_review_date) + '</div>' +
                (r.review_summary ? '<div class="mini-card-meta">' + _html(r.review_summary) + '</div>' : '') +
                (btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '') + '</div>';
        }).join('');
    }

    function spOpenCreateReview() {
        document.getElementById('nrTitle').value = '';
        document.getElementById('nrSummary').value = '';
        document.getElementById('nrWins').value = '';
        document.getElementById('nrConcerns').value = '';
        document.getElementById('nrNextReviewDate').value = '';
        document.getElementById('createReviewModal').classList.add('open');
    }
    function spCloseCreateReview() { document.getElementById('createReviewModal').classList.remove('open'); }
    function spSubmitCreateReview() {
        var title = document.getElementById('nrTitle').value;
        if (!title) { _showToast('Review title is required.'); return; }
        var payload = {
            review_title: title, review_summary: document.getElementById('nrSummary').value || null,
            wins: document.getElementById('nrWins').value || null, concerns: document.getElementById('nrConcerns').value || null,
            next_review_date: document.getElementById('nrNextReviewDate').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/plans/' + _currentPlanId + '/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review created.'); spCloseCreateReview(); _loadPlanReviews(_currentPlanId); _loadSummary(); spLoadReviews(); })
            .catch(function () { _showToast('Failed to create review.'); });
    }
    function spReviewAction(id, action) {
        window.PracticeAPI.fetch(BASE + '/reviews/' + id + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review updated.'); _loadPlanReviews(_currentPlanId); _loadSummary(); spLoadReviews(); })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    // ── Company-wide Reviews tab ──────────────────────────────────────────────

    function spLoadReviews() {
        window.PracticeAPI.fetch(BASE + '/plans')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var plans = d.plans || [];
                return Promise.all(plans.map(function (p) {
                    return window.PracticeAPI.fetch(BASE + '/plans/' + p.id + '/reviews').then(function (r) { return r.json(); }).then(function (rd) {
                        return (rd.reviews || []).map(function (rv) { return Object.assign({}, rv, { plan_name: p.plan_name }); });
                    });
                }));
            })
            .then(function (lists) { _renderReviewsTable([].concat.apply([], lists)); })
            .catch(function () { document.getElementById('reviewsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderReviewsTable(rows) {
        var el = document.getElementById('reviewsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="5" class="empty-state">No reviews yet.</td></tr>'; return; }
        rows.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
        el.innerHTML = rows.map(function (r) {
            return '<tr><td>' + _html(r.review_title) + '</td><td>' + _html(r.plan_name) + '</td>' +
                '<td><span class="pill ps-' + _html(r.review_status) + '">' + _html(REVIEW_STATUS_LABELS[r.review_status] || r.review_status) + '</span></td>' +
                '<td>' + (r.overall_progress != null ? r.overall_progress + '%' : '—') + '</td><td>' + _fmtDate(r.next_review_date) + '</td></tr>';
        }).join('');
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function spLoadEvents() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTable(d.events || []); })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load.</td></tr>'; });
    }
    function _renderEventsTable(rows) {
        var el = document.getElementById('eventsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">No events yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (e) {
            return '<tr><td>' + _html(e.event_type) + '</td><td>' + _html(e.old_status || '—') + ' → ' + _html(e.new_status || '—') + '</td>' +
                '<td>' + _html(e.notes || '') + '</td><td>' + _fmt(e.created_at) + '</td></tr>';
        }).join('');
    }
    function _loadPlanEvents(planId) {
        window.PracticeAPI.fetch(BASE + '/plan/' + planId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('planEventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(e.event_type) + ' <span class="mini-card-meta">' + _fmt(e.created_at) + '</span>' +
                        (e.notes ? '<div class="mini-card-meta">' + _html(e.notes) + '</div>' : '') + '</div>';
                }).join('') : '<div class="empty-state">No events for this plan yet.</div>';
            })
            .catch(function () { document.getElementById('planEventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Reason Modal (plan/review cancellation) ──────────────────────────────────

    function spOpenReason(action) {
        _pendingReasonAction = action;
        document.getElementById('reasonModalTitle').textContent = 'Reason Required';
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }
    function spCloseReason() { document.getElementById('reasonModal').classList.remove('open'); }
    function spSubmitReason() {
        var reason = document.getElementById('rfReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        var action = _pendingReasonAction;
        var url, onDone;
        if (action === 'cancel-plan') {
            url = BASE + '/plans/' + _currentPlanId;
            onDone = function () { spOpenPlanDetail(_currentPlanId); spLoadPlans(); };
        } else if (action.indexOf('cancel-review:') === 0) {
            url = BASE + '/reviews/' + action.split(':')[1];
            onDone = function () { _loadPlanReviews(_currentPlanId); spLoadReviews(); };
        } else { return; }

        window.PracticeAPI.fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Cancelled.'); spCloseReason(); onDone(); _loadSummary(); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.spSetTab = spSetTab;
    window.spOpenCreatePlan = spOpenCreatePlan;
    window.spCloseCreatePlan = spCloseCreatePlan;
    window.spSubmitCreatePlan = spSubmitCreatePlan;
    window.spOpenPlanDetail = spOpenPlanDetail;
    window.spClosePlanDetail = spClosePlanDetail;
    window.spSetPlanDetailTab = spSetPlanDetailTab;
    window.spPlanAction = spPlanAction;
    window.spOpenCreateObjective = spOpenCreateObjective;
    window.spCloseCreateObjective = spCloseCreateObjective;
    window.spSubmitCreateObjective = spSubmitCreateObjective;
    window.spOpenObjectiveDetail = spOpenObjectiveDetail;
    window.spCloseObjectiveDetail = spCloseObjectiveDetail;
    window.spUpdateObjectiveStatus = spUpdateObjectiveStatus;
    window.spOpenCreateInitiative = spOpenCreateInitiative;
    window.spCloseCreateInitiative = spCloseCreateInitiative;
    window.spSubmitCreateInitiative = spSubmitCreateInitiative;
    window.spUpdateInitiativeStatus = spUpdateInitiativeStatus;
    window.spOpenCreateKpi = spOpenCreateKpi;
    window.spCloseCreateKpi = spCloseCreateKpi;
    window.spSubmitCreateKpi = spSubmitCreateKpi;
    window.spOpenCreateReview = spOpenCreateReview;
    window.spCloseCreateReview = spCloseCreateReview;
    window.spSubmitCreateReview = spSubmitCreateReview;
    window.spReviewAction = spReviewAction;
    window.spLoadPlans = spLoadPlans;
    window.spLoadReviews = spLoadReviews;
    window.spOpenReason = spOpenReason;
    window.spCloseReason = spCloseReason;
    window.spSubmitReason = spSubmitReason;

    document.addEventListener('DOMContentLoaded', spLoadAll);
})();
