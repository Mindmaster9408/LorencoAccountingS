/* Codebox 60 — Practice Learning, Development & Training Centre
 * "How do we grow this person?" NOT AI coaching. NOT an LMS. Manager-driven.
 * Prefix: lc
 */
(function () {
    'use strict';

    var BASE = '/api/practice/learning-centre';
    var TEAM_BASE = '/api/practice/team';
    var SKILLS_BASE = '/api/practice/skills-matrix/skills';
    var _tab = 'plans';
    var _teamList = [];
    var _skillsList = [];
    var _currentPlanId = null;
    var _currentPlan = null;
    var _currentGoalIdForActivity = null;

    var STATUS_LABELS = { draft: 'Draft', active: 'Active', on_hold: 'On Hold', completed: 'Completed', cancelled: 'Cancelled', not_started: 'Not Started', in_progress: 'In Progress', planned: 'Planned', recorded: 'Recorded', verified: 'Verified', expired: 'Expired' };
    var ACTIVITY_TYPE_LABELS = {
        internal_training: 'Internal Training', external_course: 'External Course', workshop: 'Workshop', reading: 'Reading', case_study: 'Case Study',
        mentoring_session: 'Mentoring Session', shadowing: 'Shadowing', client_meeting_observation: 'Client Meeting Observation', research: 'Research', other: 'Other',
    };
    var EV_LABELS = {
        plan_created: 'Plan Created', plan_updated: 'Plan Updated', plan_archived: 'Plan Cancelled',
        goal_created: 'Goal Created', goal_updated: 'Goal Updated', goal_completed: 'Goal Completed', goal_archived: 'Goal Cancelled',
        activity_created: 'Activity Created', activity_updated: 'Activity Updated', activity_completed: 'Activity Completed', activity_archived: 'Activity Cancelled',
        cpd_recorded: 'CPD Recorded', cpd_updated: 'CPD Updated', cpd_archived: 'CPD Archived',
        progress_snapshot_created: 'Progress Snapshot Captured',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _statusPill(s) { return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function lcLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadTeam();
        _loadSkillsList();
        lcLoadPlans();
        lcLoadCpd();
        lcLoadHistory();
    }

    function _renderTabBar() {
        var tabs = [['plans', 'Learning Plans'], ['cpd', 'CPD'], ['history', 'History']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="lcSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function lcSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.active_plans, label: 'Active Plans' },
                    { count: d.draft_plans, label: 'Draft Plans' },
                    { count: d.plans_overdue, label: 'Overdue Plans' },
                    { count: d.mentoring_relationships, label: 'Mentors Active' },
                    { count: d.total_goals, label: 'Total Goals' },
                    { count: d.goals_completed, label: 'Goals Completed' },
                    { count: d.total_cpd_hours, label: 'CPD Hours' },
                    { count: d.cpd_record_count, label: 'CPD Records' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Team / Skills lists ───────────────────────────────────────────────────

    function _loadTeam() {
        window.PracticeAPI.fetch(TEAM_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _teamList = d.members || [];
                var opts = '<option value="">Select…</option>' + _teamList.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('');
                document.getElementById('pfMember').innerHTML = opts;
                document.getElementById('pfMentor').innerHTML = '<option value="">— None —</option>' + _teamList.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('');
                document.getElementById('cfMember').innerHTML = opts;
            })
            .catch(function () {});
    }

    function _loadSkillsList() {
        window.PracticeAPI.fetch(SKILLS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _skillsList = d.skills || [];
                document.getElementById('gfSkill').innerHTML = '<option value="">— None —</option>' + _skillsList.map(function (s) { return '<option value="' + s.id + '">' + _html(s.display_name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    // ── Plans list ────────────────────────────────────────────────────────────

    function lcLoadPlans() {
        var list = document.getElementById('planList');
        list.innerHTML = '<div class="empty-state">Loading…</div>';
        var status = document.getElementById('planStatusFilter').value;
        window.PracticeAPI.fetch(BASE + '/plans' + (status ? '?status=' + status : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var plans = d.plans || [];
                list.innerHTML = plans.length ? plans.map(_renderPlanRow).join('') : '<div class="empty-state">No development plans yet.</div>';
            })
            .catch(function () { list.innerHTML = '<div class="empty-state">Failed to load plans.</div>'; });
    }

    function _renderPlanRow(p) {
        return '<div class="plan-row" onclick="lcOpenPlanDetail(' + p.id + ')">' +
            '<div class="plan-title-row"><span class="plan-title">' + _html(p.plan_name) + '</span>' + _statusPill(p.status) + '</div>' +
            '<div class="plan-meta">' + _html(p.team_member_name) + (p.mentor_name ? ' · Mentor: ' + _html(p.mentor_name) : '') + (p.target_completion_date ? ' · Target: ' + _fmtDate(p.target_completion_date) : '') + '</div>' +
            '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + (p.overall_progress || 0) + '%;"></div></div>' +
            '<div style="font-size:.72rem;color:#718096;margin-top:3px;">' + (p.overall_progress || 0) + '% complete</div>' +
            '</div>';
    }

    // ── Create Plan ───────────────────────────────────────────────────────────

    function lcOpenCreatePlan() {
        document.getElementById('pfMember').value = '';
        document.getElementById('pfName').value = '';
        document.getElementById('pfDescription').value = '';
        document.getElementById('pfStart').value = '';
        document.getElementById('pfTarget').value = '';
        document.getElementById('pfMentor').value = '';
        document.getElementById('pfStatus').value = 'draft';
        document.getElementById('pfNotes').value = '';
        document.getElementById('pfSuggestions').innerHTML = 'Select a team member to see suggestions.';
        document.getElementById('createPlanModal').classList.add('open');
    }
    function lcCloseCreatePlan() { document.getElementById('createPlanModal').classList.remove('open'); }

    function lcLoadSuggestions() {
        var memberId = document.getElementById('pfMember').value;
        var box = document.getElementById('pfSuggestions');
        if (!memberId) { box.innerHTML = 'Select a team member to see suggestions.'; return; }
        box.innerHTML = 'Loading…';
        window.PracticeAPI.fetch(BASE + '/suggested-goals/' + memberId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var s = d.suggested_goals || [];
                box.innerHTML = s.length ? s.map(function (g) {
                    return '<span class="suggestion-chip">' + _html(g.skill_name) + ' (' + g.current_level + '→' + g.target_level + ')</span>';
                }).join('') : 'No Skills Matrix gaps recorded for this person yet — add goals manually once the plan is created.';
            })
            .catch(function () { box.innerHTML = 'Failed to load suggestions.'; });
    }

    function lcSubmitCreatePlan() {
        var memberId = document.getElementById('pfMember').value;
        var name = document.getElementById('pfName').value.trim();
        if (!memberId || !name) return _showToast('Team member and plan name are required.');
        var payload = {
            team_member_id: memberId, plan_name: name, description: document.getElementById('pfDescription').value.trim() || null,
            start_date: document.getElementById('pfStart').value.trim() || null, target_completion_date: document.getElementById('pfTarget').value.trim() || null,
            mentor_team_member_id: document.getElementById('pfMentor').value || null, status: document.getElementById('pfStatus').value,
            notes: document.getElementById('pfNotes').value.trim() || null,
        };
        window.PracticeAPI.fetch(BASE + '/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Development plan created.');
                lcCloseCreatePlan();
                lcLoadPlans();
                _loadSummary();
            })
            .catch(function () { _showToast('Failed to create plan.'); });
    }

    // ── Plan Detail ───────────────────────────────────────────────────────────

    function lcOpenPlanDetail(id) {
        _currentPlanId = id;
        window.PracticeAPI.fetch(BASE + '/plans/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentPlan = d;
                document.getElementById('planDetailModal').classList.add('open');
                _renderPlanDetail();
            })
            .catch(function () { _showToast('Failed to load plan.'); });
    }
    function lcClosePlanDetail() { document.getElementById('planDetailModal').classList.remove('open'); _currentPlanId = null; _currentPlan = null; }

    function _renderPlanDetail() {
        var p = _currentPlan.plan, goals = _currentPlan.goals || [], activities = _currentPlan.activities || [];
        var activitiesByGoal = {};
        activities.forEach(function (a) { (activitiesByGoal[a.goal_id] = activitiesByGoal[a.goal_id] || []).push(a); });

        var body = document.getElementById('planDetailBody');
        body.innerHTML =
            '<div class="modal-title">' + _html(p.plan_name) + ' ' + _statusPill(p.status) + '</div>' +
            '<div style="font-size:.8rem;color:#a0aec0;margin-bottom:6px;">' + _html(p.team_member_name || '') + (p.mentor_name ? ' · Mentor: ' + _html(p.mentor_name) : '') + '</div>' +
            (p.description ? '<div style="font-size:.82rem;margin-bottom:10px;">' + _html(p.description) + '</div>' : '') +
            '<div class="progress-bar-wrap" style="width:100%;"><div class="progress-bar-fill" style="width:' + (p.overall_progress || 0) + '%;"></div></div>' +
            '<div style="font-size:.78rem;color:#718096;margin:4px 0 14px;">' + (p.overall_progress || 0) + '% overall progress</div>' +
            '<div class="detail-section-title">Goals <button class="btn-action btn-secondary" onclick="lcOpenGoal()">+ Add Goal</button></div>' +
            (goals.length ? goals.map(function (g) { return _renderGoalCard(g, activitiesByGoal[g.id] || []); }).join('') : '<div class="empty-state">No goals yet.</div>');

        var footer = document.getElementById('planDetailFooter');
        var btns = ['<button class="btn-action btn-secondary" onclick="lcCaptureSnapshot()">📸 Capture Progress Snapshot</button>'];
        if (p.status !== 'cancelled') btns.push('<button class="btn-action btn-danger" onclick="lcCancelPlan()">Cancel Plan</button>');
        btns.push('<button class="btn-action btn-secondary" onclick="lcClosePlanDetail()">Close</button>');
        footer.innerHTML = btns.join('');
    }

    function _renderGoalCard(g, acts) {
        var skillLabel = g.practice_skills ? g.practice_skills.display_name : null;
        return '<div class="goal-card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-weight:700;font-size:.84rem;">' + _html(g.goal_title) + (skillLabel ? ' <span style="color:#718096;font-weight:400;">(' + _html(skillLabel) + ')</span>' : '') + '</span>' +
            _statusPill(g.status) + '</div>' +
            '<div style="font-size:.74rem;color:#718096;margin-top:3px;">Priority: <span class="pri-' + _html(g.priority) + '">' + _html(g.priority) + '</span>' +
            (g.target_level != null ? ' · Level ' + (g.current_level || 0) + '→' + g.target_level : '') + (g.target_date ? ' · Target: ' + _fmtDate(g.target_date) : '') + '</div>' +
            (acts.length ? acts.map(function (a) {
                return '<div class="activity-row"><span>' + _html(ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type) + ': ' + _html(a.title) + '</span>' +
                    '<span>' + _statusPill(a.status) + ' ' + (a.completed_hours || 0) + '/' + (a.planned_hours || 0) + 'h</span></div>';
            }).join('') : '') +
            '<div style="margin-top:8px;"><button class="btn-action btn-secondary" onclick="lcOpenActivity(' + g.id + ')">+ Add Activity</button> ' +
            (g.status !== 'completed' && g.status !== 'cancelled' ? '<button class="btn-action btn-success" onclick="lcCompleteGoal(' + g.id + ')">Mark Complete</button>' : '') + '</div>' +
            '</div>';
    }

    function lcCompleteGoal(goalId) {
        window.PracticeAPI.fetch(BASE + '/goals/' + goalId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Goal marked complete.'); lcOpenPlanDetail(_currentPlanId); lcLoadPlans(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update goal.'); });
    }

    function lcCancelPlan() {
        if (!confirm('Cancel this development plan?')) return;
        window.PracticeAPI.fetch(BASE + '/plans/' + _currentPlanId, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Plan cancelled.'); lcClosePlanDetail(); lcLoadPlans(); _loadSummary(); })
            .catch(function () { _showToast('Failed to cancel plan.'); });
    }

    function lcCaptureSnapshot() {
        window.PracticeAPI.fetch(BASE + '/progress/' + _currentPlanId + '/snapshot', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Progress snapshot captured at ' + d.progress.overall_progress + '%.');
            })
            .catch(function () { _showToast('Failed to capture snapshot.'); });
    }

    // ── Goals ─────────────────────────────────────────────────────────────────

    function lcOpenGoal() {
        document.getElementById('gfTitle').value = '';
        document.getElementById('gfDescription').value = '';
        document.getElementById('gfSkill').value = '';
        document.getElementById('gfPriority').value = 'medium';
        document.getElementById('gfTargetDate').value = '';
        document.getElementById('gfCurrentLevel').value = '';
        document.getElementById('gfTargetLevel').value = '';
        document.getElementById('goalModal').classList.add('open');
    }
    function lcCloseGoal() { document.getElementById('goalModal').classList.remove('open'); }

    function lcSubmitGoal() {
        var title = document.getElementById('gfTitle').value.trim();
        if (!title) return _showToast('Goal title is required.');
        var payload = {
            learning_plan_id: _currentPlanId, goal_title: title, goal_description: document.getElementById('gfDescription').value.trim() || null,
            skill_id: document.getElementById('gfSkill').value || null, priority: document.getElementById('gfPriority').value,
            target_date: document.getElementById('gfTargetDate').value.trim() || null,
            current_level: document.getElementById('gfCurrentLevel').value || null, target_level: document.getElementById('gfTargetLevel').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Goal added.');
                lcCloseGoal();
                lcOpenPlanDetail(_currentPlanId);
                lcLoadPlans();
                _loadSummary();
            })
            .catch(function () { _showToast('Failed to add goal.'); });
    }

    // ── Activities ────────────────────────────────────────────────────────────

    function lcOpenActivity(goalId) {
        _currentGoalIdForActivity = goalId;
        document.getElementById('afTitle').value = '';
        document.getElementById('afType').value = 'internal_training';
        document.getElementById('afStatus').value = 'planned';
        document.getElementById('afPlannedHours').value = '';
        document.getElementById('afCompletedHours').value = '';
        document.getElementById('afEvidence').value = '';
        document.getElementById('activityModal').classList.add('open');
    }
    function lcCloseActivity() { document.getElementById('activityModal').classList.remove('open'); }

    function lcSubmitActivity() {
        var title = document.getElementById('afTitle').value.trim();
        if (!title) return _showToast('Activity title is required.');
        var payload = {
            goal_id: _currentGoalIdForActivity, title: title, activity_type: document.getElementById('afType').value, status: document.getElementById('afStatus').value,
            planned_hours: document.getElementById('afPlannedHours').value || null, completed_hours: document.getElementById('afCompletedHours').value || null,
            evidence_notes: document.getElementById('afEvidence').value.trim() || null,
        };
        window.PracticeAPI.fetch(BASE + '/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Activity added.');
                lcCloseActivity();
                lcOpenPlanDetail(_currentPlanId);
                lcLoadPlans();
            })
            .catch(function () { _showToast('Failed to add activity.'); });
    }

    // ── CPD ───────────────────────────────────────────────────────────────────

    function lcLoadCpd() {
        window.PracticeAPI.fetch(BASE + '/cpd')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.cpd_records || [];
                document.getElementById('cpdBody').innerHTML = rows.length ? rows.map(function (r) {
                    return '<tr><td>' + _html(r.team_member_name) + '</td><td>' + _html(r.course_name) + '</td><td>' + _html(r.provider || '—') + '</td><td>' + r.hours + 'h</td><td>' + _html(r.category || '—') + '</td>' +
                        '<td>' + _statusPill(r.is_expired ? 'expired' : r.status) + '</td><td>' + _fmtDate(r.issue_date) + '</td><td>' + _fmtDate(r.expiry_date) + '</td>' +
                        '<td><button class="btn-action btn-danger" onclick="lcArchiveCpd(' + r.id + ')">Archive</button></td></tr>';
                }).join('') : '<tr><td colspan="9" class="empty-state">No CPD records yet.</td></tr>';
            })
            .catch(function () {});
    }

    function lcOpenCpd() {
        document.getElementById('cfMember').value = '';
        document.getElementById('cfCourse').value = '';
        document.getElementById('cfProvider').value = '';
        document.getElementById('cfHours').value = '';
        document.getElementById('cfCategory').value = '';
        document.getElementById('cfStatus').value = 'recorded';
        document.getElementById('cfIssue').value = '';
        document.getElementById('cfExpiry').value = '';
        document.getElementById('cfCertNumber').value = '';
        document.getElementById('cfEvidence').value = '';
        document.getElementById('cfNotes').value = '';
        document.getElementById('cpdModal').classList.add('open');
    }
    function lcCloseCpd() { document.getElementById('cpdModal').classList.remove('open'); }

    function lcSubmitCpd() {
        var memberId = document.getElementById('cfMember').value;
        var course = document.getElementById('cfCourse').value.trim();
        if (!memberId || !course) return _showToast('Team member and course are required.');
        var payload = {
            team_member_id: memberId, course_name: course, provider: document.getElementById('cfProvider').value.trim() || null,
            hours: document.getElementById('cfHours').value || 0, category: document.getElementById('cfCategory').value.trim() || null,
            status: document.getElementById('cfStatus').value, issue_date: document.getElementById('cfIssue').value.trim() || null,
            expiry_date: document.getElementById('cfExpiry').value.trim() || null, certificate_number: document.getElementById('cfCertNumber').value.trim() || null,
            evidence: document.getElementById('cfEvidence').value.trim() || null, notes: document.getElementById('cfNotes').value.trim() || null,
        };
        window.PracticeAPI.fetch(BASE + '/cpd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('CPD recorded.');
                lcCloseCpd();
                lcLoadCpd();
                _loadSummary();
            })
            .catch(function () { _showToast('Failed to record CPD.'); });
    }

    function lcArchiveCpd(id) {
        if (!confirm('Archive this CPD record?')) return;
        window.PracticeAPI.fetch(BASE + '/cpd/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Archived.'); lcLoadCpd(); _loadSummary(); })
            .catch(function () { _showToast('Failed to archive.'); });
    }

    // ── History ───────────────────────────────────────────────────────────────

    function lcLoadHistory() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var events = d.events || [];
                document.getElementById('historyBody').innerHTML = events.length ? events.map(function (e) {
                    return '<div style="background:#12122a;border-radius:8px;padding:10px 14px;margin-bottom:6px;"><div style="display:flex;gap:8px;align-items:center;"><span style="font-size:.78rem;font-weight:700;color:#a0aec0;">' + _html(EV_LABELS[e.event_type] || e.event_type) + '</span><span style="font-size:.72rem;color:#4a5568;margin-left:auto;">' + _fmt(e.created_at) + '</span></div>' +
                        (e.notes ? '<div style="font-size:.78rem;color:#718096;font-style:italic;">' + _html(e.notes) + '</div>' : '') + '</div>';
                }).join('') : '<div class="empty-state">No history yet.</div>';
            })
            .catch(function () {});
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.lcLoadAll = lcLoadAll;
    window.lcSetTab = lcSetTab;
    window.lcLoadPlans = lcLoadPlans;
    window.lcOpenCreatePlan = lcOpenCreatePlan;
    window.lcCloseCreatePlan = lcCloseCreatePlan;
    window.lcLoadSuggestions = lcLoadSuggestions;
    window.lcSubmitCreatePlan = lcSubmitCreatePlan;
    window.lcOpenPlanDetail = lcOpenPlanDetail;
    window.lcClosePlanDetail = lcClosePlanDetail;
    window.lcCompleteGoal = lcCompleteGoal;
    window.lcCancelPlan = lcCancelPlan;
    window.lcCaptureSnapshot = lcCaptureSnapshot;
    window.lcOpenGoal = lcOpenGoal;
    window.lcCloseGoal = lcCloseGoal;
    window.lcSubmitGoal = lcSubmitGoal;
    window.lcOpenActivity = lcOpenActivity;
    window.lcCloseActivity = lcCloseActivity;
    window.lcSubmitActivity = lcSubmitActivity;
    window.lcLoadCpd = lcLoadCpd;
    window.lcOpenCpd = lcOpenCpd;
    window.lcCloseCpd = lcCloseCpd;
    window.lcSubmitCpd = lcSubmitCpd;
    window.lcArchiveCpd = lcArchiveCpd;
    window.lcLoadHistory = lcLoadHistory;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        lcLoadAll();
    });

}());
