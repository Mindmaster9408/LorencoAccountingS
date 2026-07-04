/* Codebox 56 — Practice Planning Board + Weekly Planning Centre
 * "My planning wall." NOT AI. NOT automatic reassignment. NOT calendar sync.
 * Prefix: pb
 */
(function () {
    'use strict';

    var BASE = '/api/practice/planning-board';
    var _weekStart = null; // set on load from server's Monday-normalized default
    var _weekTab = 'this_week';
    var _weekData = null;
    var _teamData = [];
    var _deadlineData = [];
    var _notesData = [];
    var _editingNoteId = null;

    var TAB_LABELS = {
        this_week: 'This Week', next_week: 'Next Week', overdue: 'Overdue',
        high_risk: 'High Risk', upcoming_deadlines: 'Upcoming Deadlines', waiting_for_review: 'Waiting For Review',
    };
    var CAP_COLORS = { overloaded: '#e53e3e', high: '#ed8936', normal: '#48bb78', underutilized: '#667eea', unknown: '#4a5568' };
    var STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', done: 'Done', archived: 'Archived' };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) : '—'; }
    function _fmtDateLong(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }
    function _logEvent(eventType, noteId, notes, meta) {
        window.PracticeAPI.fetch(BASE + '/events', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_type: eventType, note_id: noteId || null, notes: notes || null, metadata: meta || {} }),
        }).catch(function () {});
    }

    function _weekQs() { return _weekStart ? ('?week_start=' + _weekStart) : ''; }

    function _deniedCheck(status) {
        if (status === 403) {
            document.getElementById('pageContent').style.display = 'none';
            document.getElementById('deniedState').style.display = 'block';
            return true;
        }
        return false;
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function pbLoadAll() {
        _loadSummary();
        _loadWeek();
        _loadTeam();
        _loadDeadlines();
        _loadNotes();
        _logEvent('board_opened');
    }

    function pbShiftWeek(delta) {
        var d = new Date((_weekStart || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
        d.setDate(d.getDate() + delta * 7);
        _weekStart = d.toISOString().slice(0, 10);
        _logEvent('week_changed', null, null, { week_start: _weekStart });
        pbLoadAll();
    }

    function pbGoToday() {
        _weekStart = null;
        _logEvent('week_changed', null, null, { week_start: 'current' });
        pbLoadAll();
    }

    function pbApplySearch() {
        _logEvent('filter_changed', null, null, { search: document.getElementById('pbSearch').value });
        _renderWeekTab();
        _renderTeam();
        _renderDeadlines();
        _renderNotes();
    }
    function _searchTerm() { return document.getElementById('pbSearch').value.trim().toLowerCase(); }
    function _matchesSearch(text) {
        var s = _searchTerm();
        return !s || (text || '').toLowerCase().indexOf(s) !== -1;
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary' + _weekQs())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                _weekStart = d.week_start;
                document.getElementById('weekLabel').textContent = _fmtDateLong(d.week_start) + ' – ' + _fmtDateLong(d.week_end);

                var cards = [
                    { count: d.team_member_count, label: 'Team Members', cls: '' },
                    { count: d.overloaded_count, label: 'Overloaded', cls: 'danger' },
                    { count: d.underutilized_count, label: 'Underutilized', cls: '' },
                    { count: d.total_overdue, label: 'Overdue', cls: 'danger', tab: 'overdue' },
                    { count: d.total_due_this_week, label: 'Due This Week', cls: 'warn', tab: 'this_week' },
                    { count: d.total_waiting_for_review, label: 'Waiting For Review', cls: 'warn', tab: 'waiting_for_review' },
                    { count: d.total_critical, label: 'Critical', cls: 'danger', tab: 'high_risk' },
                    { count: d.upcoming_deadlines_count, label: 'Upcoming Deadlines', cls: '', tab: 'upcoming_deadlines' },
                    { count: d.notifications_unread_count, label: 'Unread Notifications', cls: '', href: '/practice/notifications.html' },
                    { count: d.planning_notes_count, label: 'Planning Notes', cls: '' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    var onclick = c.tab ? ' onclick="pbSetWeekTab(\'' + c.tab + '\')" style="cursor:pointer;"' : (c.href ? ' onclick="window.location.href=\'' + c.href + '\'" style="cursor:pointer;"' : '');
                    return '<div class="summary-card ' + c.cls + '"' + onclick + '><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Week Tabs ─────────────────────────────────────────────────────────────

    function _loadWeek() {
        window.PracticeAPI.fetch(BASE + '/week' + _weekQs())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                _weekData = d;
                _renderWeekTabBar();
                _renderWeekTab();
            })
            .catch(function () {});
    }

    function _renderWeekTabBar() {
        var keys = ['this_week', 'next_week', 'overdue', 'high_risk', 'upcoming_deadlines', 'waiting_for_review'];
        document.getElementById('weekTabBar').innerHTML = keys.map(function (k) {
            var count = _weekData && _weekData[k] ? _weekData[k].count : 0;
            return '<button class="tab-btn' + (k === _weekTab ? ' active' : '') + '" onclick="pbSetWeekTab(\'' + k + '\')">' + TAB_LABELS[k] + ' (' + count + ')</button>';
        }).join('');
    }

    function pbSetWeekTab(tab) {
        _weekTab = tab;
        _renderWeekTabBar();
        _renderWeekTab();
    }

    function _renderWeekTab() {
        var body = document.getElementById('weekTabBody');
        if (!_weekData) { body.innerHTML = '<div class="empty-state">Loading…</div>'; return; }
        var bucket = _weekData[_weekTab];
        var items = (bucket ? bucket.items : []).filter(function (i) { return _matchesSearch(i.title + ' ' + (i.client_name || '') + ' ' + (i.team_member_name || '')); });
        body.innerHTML = items.length ? items.map(_renderItem).join('') : '<div class="empty-state">Nothing here.</div>';
    }

    // Codebox 58 — same mapping used in work-queue.js, kept in sync manually:
    // 'qms' items split into 'qms-review'/'qms-finding' via source_type;
    // 'communications' has no delegation support (not in the spec's
    // Supported Source Types list), so the Delegate action is hidden for it.
    function _delegationModule(item) {
        if (item.source_module === 'qms') return item.source_type === 'practice_quality_finding' ? 'qms-finding' : 'qms-review';
        if (item.source_module === 'communications') return null;
        return item.source_module;
    }

    function _renderItem(item) {
        var meta = [];
        if (item.team_member_name) meta.push(_html(item.team_member_name));
        if (item.client_name) meta.push(_html(item.client_name));
        meta.push(_html(item.source_module));
        var due = item.due_date ? _fmtDate(item.due_date) : null;
        if (due) meta.push('Due ' + due);
        var label = item.priority_label || 'low';
        var delegateModule = _delegationModule(item);
        var delegateBtn = delegateModule
            ? '<button class="mc-link" style="flex:none;padding:4px 10px;margin-left:8px;align-self:center;background:#805ad5;" onclick="event.stopPropagation();window.location.href=\'/practice/delegation.html?delegate=1&source_module=' + delegateModule + '&source_id=' + item.source_id + '&role=' + encodeURIComponent(item.role) + '\'">Delegate</button>'
            : '';
        // Codebox 61 — soft "at-risk client" hint, sourced from Client Success.
        // Informational only — never affects priority scoring or ordering.
        var atRiskBadge = item.at_risk_client
            ? ' <span class="pill" style="background:rgba(229,62,62,.2);color:#fc8181;" title="This client\'s relationship status is at risk or critical — see Client Success">⚠ At-Risk Client</span>'
            : '';
        // Codebox 62 — soft "annual return due/overdue" hint, sourced from
        // Secretarial. Informational only — never affects priority ordering.
        var returnBadge = item.annual_return_due
            ? ' <span class="pill" style="background:rgba(246,173,85,.2);color:#f6ad55;" title="This client has an annual return due or overdue — see Secretarial">📋 Annual Return Due</span>'
            : '';
        // Codebox 63 — soft "pending statutory change" hint (a case awaiting
        // review or implementation), sourced from Secretarial Changes.
        // Informational only — never affects priority ordering.
        var changeBadge = item.pending_statutory_change
            ? ' <span class="pill" style="background:rgba(159,122,234,.2);color:#b794f4;" title="This client has a statutory change case awaiting review or implementation — see Secretarial Changes">🗂 Pending Statutory Change</span>'
            : '';
        // Codebox 65 — soft "BO readiness concern" hint (a blocked, required
        // Beneficial Ownership readiness item), sourced from Beneficial
        // Ownership. Informational only — never affects priority ordering.
        var boBadge = item.bo_readiness_concern
            ? ' <span class="pill" style="background:rgba(229,62,62,.22);color:#fc8181;" title="This client has a blocked Beneficial Ownership readiness item — see Beneficial Ownership">🛑 BO Readiness Blocked</span>'
            : '';
        // Codebox 67 — soft statutory workload hints, sourced from the
        // Statutory Calendar. Informational only — never affects priority ordering.
        var statutoryBadge = item.statutory_workload_blocked
            ? ' <span class="pill" style="background:rgba(229,62,62,.2);color:#fc8181;" title="This client has statutory work blocked by an unresolved dependency — see Statutory Calendar">📅 Statutory Blocked</span>'
            : (item.statutory_workload_upcoming
                ? ' <span class="pill" style="background:rgba(102,126,234,.18);color:#a3bffa;" title="This client has statutory work due within 30 days — see Statutory Calendar">📅 Statutory Due Soon</span>'
                : '');
        // Codebox 66 — soft "evidence blocked" hint (a blocked, required
        // evidence item on this client's checklist), sourced from Secretarial
        // Evidence. Informational only — never affects priority ordering.
        var evidenceBadge = item.evidence_blocked
            ? ' <span class="pill" style="background:rgba(229,62,62,.22);color:#fc8181;" title="This client has a blocked, required evidence item — see Secretarial Evidence">📎 Evidence Blocked</span>'
            : '';
        // Codebox 68 — soft "lifecycle transition pending" hint (a transition
        // awaiting manager review or implementation), sourced from Entity
        // Lifecycle. Informational only — never affects priority ordering.
        var lifecycleBadge = item.lifecycle_transition_pending
            ? ' <span class="pill" style="background:rgba(246,173,85,.2);color:#f6ad55;" title="This client has a lifecycle transition awaiting review or implementation — see Entity Lifecycle">🔄 Lifecycle Pending</span>'
            : '';
        // Codebox 69 — soft "critical integrity finding" hint (an open
        // critical/high Secretarial Integrity finding), sourced from
        // Secretarial Integrity. Informational only — never affects priority
        // ordering.
        var integrityBadge = item.critical_integrity_finding
            ? ' <span class="pill" style="background:rgba(229,62,62,.3);color:#fc8181;" title="This client has an open critical/high Secretarial Integrity finding — see Secretarial Integrity">⚠ Integrity Issue</span>'
            : '';
        // Codebox 71 — soft "engagement risk unaccepted" hint (a high/critical
        // risk engagement with no recorded risk acceptance), sourced from
        // Engagement Management. Informational only — never affects priority
        // ordering.
        var engagementRiskBadge = item.engagement_risk_unaccepted
            ? ' <span class="pill" style="background:rgba(229,62,62,.3);color:#fc8181;" title="This client has a high/critical risk engagement with no recorded risk acceptance — see Engagement Management">🛑 Risk Not Accepted</span>'
            : '';
        // Codebox 72 — soft "out of scope work" hint (an unresolved
        // out-of-scope or no-active-engagement work authorization), sourced
        // from Work Authorization. Informational only — never affects
        // priority ordering, never blocks the work itself.
        var scopeBadge = item.out_of_scope_work
            ? ' <span class="pill" style="background:rgba(229,62,62,.22);color:#fc8181;" title="This client has work flagged out of scope with no override/accepted risk yet — see Work Authorization">🚧 Out of Scope</span>'
            : '';
        // Codebox 73 — soft "low margin / high write-off" hint, sourced from
        // the most recently SAVED Profitability snapshot for this client
        // (never computed live here). Informational only — never affects
        // priority ordering.
        var profitabilityBadge = item.low_margin_client
            ? ' <span class="pill" style="background:rgba(246,173,85,.2);color:#f6ad55;" title="This client\'s latest saved profitability snapshot shows low margin/unprofitable or high write-offs — see Profitability">📉 Low Margin</span>'
            : '';
        // Codebox 74 — soft "commercial review due" hint: low margin/high
        // write-offs with no active pricing review already in progress,
        // sourced from Pricing Review. Informational only — never affects
        // priority ordering, never suggests a fee.
        var pricingReviewBadge = item.commercial_review_due
            ? ' <span class="pill" style="background:rgba(246,173,85,.2);color:#f6ad55;" title="Low margin with no active pricing review in progress — see Pricing Reviews">📌 Commercial Review Due</span>'
            : '';
        return '<div class="work-item pr-' + _html(label) + '" style="display:flex;align-items:center;" onclick="pbOpenDeepLink(\'' + _html(item.deep_link) + '\')">' +
            '<div class="wi-body">' +
            '<div class="wi-title">' + _html(item.title) + ' <span class="pill st-' + _html(label === 'critical' ? 'archived' : 'open') + '">' + _html(label) + '</span>' + atRiskBadge + returnBadge + changeBadge + boBadge + statutoryBadge + evidenceBadge + lifecycleBadge + integrityBadge + engagementRiskBadge + scopeBadge + profitabilityBadge + pricingReviewBadge + '</div>' +
            '<div class="wi-reason">' + _html(item.reason) + '</div>' +
            '<div class="wi-meta">' + meta.join(' · ') + '</div>' +
            '</div>' + delegateBtn + '</div>';
    }

    function pbOpenDeepLink(link) { window.location.href = link; }

    // ── Team Board ────────────────────────────────────────────────────────────

    function _loadTeam() {
        window.PracticeAPI.fetch(BASE + '/team' + _weekQs())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                _teamData = d.team || [];
                document.getElementById('teamCount').textContent = _teamData.length;
                _populateTeamMemberSelect();
                _renderTeam();
            })
            .catch(function () {});
    }

    function _renderTeam() {
        var grid = document.getElementById('teamGrid');
        var rows = _teamData.filter(function (m) { return _matchesSearch(m.display_name); });
        if (!rows.length) { grid.innerHTML = '<div class="empty-state">No team members found.</div>'; return; }
        // Codebox 59 — optional Skills Matrix badges (Expert/Advanced/Training Needed).
        var BADGE_LABELS = { expert: '🏆 Expert', advanced: '⭐ Advanced', training_needed: '📘 Training Needed' };
        var BADGE_COLORS = { expert: '#f6ad55', advanced: '#68d391', training_needed: '#a3bffa' };

        grid.innerHTML = rows.map(function (m) {
            var pct = m.utilization_percentage != null ? Math.min(100, m.utilization_percentage) : 0;
            var color = CAP_COLORS[m.capacity_status] || '#4a5568';
            var badge = m.competency_badge ? '<span class="pill" style="background:rgba(255,255,255,.08);color:' + BADGE_COLORS[m.competency_badge] + ';margin-left:6px;">' + BADGE_LABELS[m.competency_badge] + '</span>' : '';
            // Codebox 75 — optional "team health" badge from the member's
            // most recent saved Partner/Manager Scorecard. Informational
            // only — never affects sort order or capacity math.
            var scorecardBadge = m.needs_support
                ? '<span class="pill" style="background:rgba(229,62,62,.22);color:#fc8181;margin-left:6px;" title="Latest scorecard overall score is ' + m.latest_scorecard_score + ' — see Partner Scorecards">📉 Needs Support</span>'
                : '';
            return '<div class="member-card cap-' + _html(m.capacity_status) + '">' +
                '<div class="mc-name">' + _html(m.display_name) + badge + scorecardBadge + '</div>' +
                '<div class="mc-role">' + _html(m.role || '') + '</div>' +
                '<div class="mc-util-bar"><div class="mc-util-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
                '<div style="font-size:.72rem;color:#a0aec0;">' + (m.utilization_percentage != null ? m.utilization_percentage + '% utilized' : 'No capacity set') + '</div>' +
                '<div class="mc-stats">' +
                '<div>Workload: <b>' + m.workload_count + '</b></div>' +
                '<div>Overdue: <b>' + m.overdue_count + '</b></div>' +
                '<div>Due this week: <b>' + m.due_this_week_count + '</b></div>' +
                '<div>Critical: <b>' + m.critical_count + '</b></div>' +
                '<div>Waiting review: <b>' + m.waiting_for_review_count + '</b></div>' +
                '<div>Notes: <b>' + m.planning_notes_count + '</b></div>' +
                '<div>Onboardings: <b>' + m.active_onboardings_count + '</b></div>' +
                '</div>' +
                '<div class="mc-links">' +
                '<a class="mc-link" href="' + m.work_queue_link + '">Open Queue</a>' +
                '<a class="mc-link" href="' + m.capacity_link + '">Capacity</a>' +
                (m.active_onboardings_count ? '<a class="mc-link" href="/practice/client-onboarding.html">Onboarding</a>' : '') +
                '</div></div>';
        }).join('');
    }

    function _populateTeamMemberSelect() {
        var sel = document.getElementById('nfTeamMember');
        var current = sel.value;
        sel.innerHTML = '<option value="">— Team-wide —</option>' + _teamData.map(function (m) {
            return '<option value="' + m.team_member_id + '">' + _html(m.display_name) + '</option>';
        }).join('');
        sel.value = current;
    }

    // ── Deadline Timeline ─────────────────────────────────────────────────────

    function _loadDeadlines() {
        window.PracticeAPI.fetch(BASE + '/deadlines')
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                _deadlineData = d.deadlines || [];
                document.getElementById('deadlineCount').textContent = d.total || 0;
                _renderDeadlines();
            })
            .catch(function () {});
    }

    function _renderDeadlines() {
        var body = document.getElementById('deadlineBody');
        var rows = _deadlineData.filter(function (dl) { return _matchesSearch(dl.title + ' ' + (dl.client_name || '')); });
        if (!rows.length) { body.innerHTML = '<div class="empty-state">No upcoming deadlines in range.</div>'; return; }
        body.innerHTML = rows.map(function (dl) {
            return '<div class="deadline-row' + (dl.is_overdue ? ' overdue' : '') + '" onclick="pbOpenDeepLink(\'' + _html(dl.deep_link) + '\')">' +
                '<div><div class="dl-title">' + _html(dl.title) + '</div><div class="dl-meta">' + _html(dl.client_name || 'Internal') + (dl.responsible_team_member_name ? ' · ' + _html(dl.responsible_team_member_name) : ' · Unassigned') + '</div></div>' +
                '<div class="dl-date' + (dl.is_overdue ? ' overdue' : '') + '">' + _fmtDate(dl.due_date) + '</div>' +
                '</div>';
        }).join('');
    }

    // ── Planning Notes ────────────────────────────────────────────────────────

    function _loadNotes() {
        window.PracticeAPI.fetch(BASE + '/planning-notes' + _weekQs())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                _notesData = d.notes || [];
                document.getElementById('notesCount').textContent = _notesData.length;
                _renderNotes();
            })
            .catch(function () {});
    }

    function _renderNotes() {
        var body = document.getElementById('notesBody');
        var rows = _notesData.filter(function (n) { return _matchesSearch(n.title + ' ' + (n.notes || '')); });
        if (!rows.length) { body.innerHTML = '<div class="empty-state">No planning notes for this week yet.</div>'; return; }
        body.innerHTML = rows.map(function (n) {
            var memberName = null;
            if (n.team_member_id) {
                var m = _teamData.filter(function (x) { return x.team_member_id === n.team_member_id; })[0];
                memberName = m ? m.display_name : ('Team member #' + n.team_member_id);
            }
            return '<div class="note-card">' +
                '<div class="note-title-row"><span class="note-title">' + _html(n.title) + '</span><span class="pill st-' + _html(n.status) + '">' + _html(STATUS_LABELS[n.status] || n.status) + '</span></div>' +
                (n.notes ? '<div class="note-body">' + _html(n.notes) + '</div>' : '') +
                '<div class="note-meta">' + (memberName ? memberName : 'Team-wide') + (n.client_id ? ' · Client #' + n.client_id : '') + '</div>' +
                '<div class="note-actions">' +
                '<button class="btn-action btn-secondary" onclick="pbEditNote(' + n.id + ')">Edit</button>' +
                '<button class="btn-action btn-danger" onclick="pbArchiveNote(' + n.id + ')">Archive</button>' +
                '</div></div>';
        }).join('');
    }

    function pbOpenNoteModal() {
        _editingNoteId = null;
        document.getElementById('noteModalTitle').textContent = 'Add Planning Note';
        document.getElementById('nfTitle').value = '';
        document.getElementById('nfNotes').value = '';
        document.getElementById('nfTeamMember').value = '';
        document.getElementById('nfClientId').value = '';
        document.getElementById('nfStatus').value = 'open';
        document.getElementById('noteModal').classList.add('open');
    }
    function pbCloseNoteModal() { document.getElementById('noteModal').classList.remove('open'); }

    function pbEditNote(id) {
        var n = _notesData.filter(function (x) { return x.id === id; })[0];
        if (!n) return;
        _editingNoteId = id;
        document.getElementById('noteModalTitle').textContent = 'Edit Planning Note';
        document.getElementById('nfTitle').value = n.title || '';
        document.getElementById('nfNotes').value = n.notes || '';
        document.getElementById('nfTeamMember').value = n.team_member_id || '';
        document.getElementById('nfClientId').value = n.client_id || '';
        document.getElementById('nfStatus').value = n.status === 'archived' ? 'open' : n.status;
        document.getElementById('noteModal').classList.add('open');
    }

    function pbSubmitNote() {
        var title = document.getElementById('nfTitle').value.trim();
        if (!title) return _showToast('Title is required.');
        var payload = {
            week_start: _weekStart,
            title: title,
            notes: document.getElementById('nfNotes').value.trim() || null,
            team_member_id: document.getElementById('nfTeamMember').value || null,
            client_id: document.getElementById('nfClientId').value || null,
            status: document.getElementById('nfStatus').value,
        };
        var url = _editingNoteId ? (BASE + '/planning-notes/' + _editingNoteId) : (BASE + '/planning-notes');
        var method = _editingNoteId ? 'PUT' : 'POST';
        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(_editingNoteId ? 'Note updated.' : 'Note added.');
                pbCloseNoteModal();
                _loadNotes();
                _loadSummary();
                _loadTeam();
            })
            .catch(function () { _showToast('Failed to save note.'); });
    }

    function pbArchiveNote(id) {
        if (!confirm('Archive this planning note?')) return;
        window.PracticeAPI.fetch(BASE + '/planning-notes/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Note archived.');
                _loadNotes();
                _loadSummary();
                _loadTeam();
            })
            .catch(function () { _showToast('Failed to archive note.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.pbLoadAll = pbLoadAll;
    window.pbShiftWeek = pbShiftWeek;
    window.pbGoToday = pbGoToday;
    window.pbApplySearch = pbApplySearch;
    window.pbSetWeekTab = pbSetWeekTab;
    window.pbOpenDeepLink = pbOpenDeepLink;
    window.pbOpenNoteModal = pbOpenNoteModal;
    window.pbCloseNoteModal = pbCloseNoteModal;
    window.pbEditNote = pbEditNote;
    window.pbSubmitNote = pbSubmitNote;
    window.pbArchiveNote = pbArchiveNote;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        pbLoadAll();
    });

}());
