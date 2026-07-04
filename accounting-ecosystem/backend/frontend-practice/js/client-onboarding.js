/* Codebox 70 — Practice Client Onboarding + Entity Formation Foundation
 * "What is still required before this client is fully operational?" NOT CIPC
 * incorporation. NOT SARS registration. NOT banking integration. NOT a
 * client portal.
 * Prefix: cb
 */
(function () {
    'use strict';

    var BASE = '/api/practice/client-onboarding';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'profile';
    var _currentClientId = null;

    var STATUS_LABELS = {
        draft: 'Draft', information_collection: 'Information Collection', document_collection: 'Document Collection',
        secretarial_setup: 'Secretarial Setup', tax_setup: 'Tax Setup', practice_setup: 'Practice Setup',
        review: 'Review', completed: 'Completed', cancelled: 'Cancelled',
    };
    var STEP_STATUS_LABELS = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed', skipped: 'Skipped', blocked: 'Blocked' };
    var READINESS_LABELS = { ready: 'Ready', ready_for_review: 'Ready for Review', in_progress: 'In Progress', not_ready: 'Not Ready' };
    var MODULE_LABELS = {
        statutory_calendar: 'Statutory Calendar', evidence_checklists: 'Evidence Checklists', integrity_open_findings: 'Integrity Findings',
        risk_register: 'Risk Register', knowledge_links: 'Knowledge Links', tax_profile: 'Tax Profile',
    };
    var EV_LABELS = {
        profile_created: 'Profile Created', step_created: 'Step Created', step_completed: 'Step Completed',
        checklist_generated: 'Checklist Generated', status_changed: 'Status Changed',
        review_completed: 'Review Completed', onboarding_completed: 'Onboarding Completed',
    };

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

    function cbLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientPicker();
    }

    function _renderTabBar() {
        var tabs = [['profile', 'Profile'], ['workflow', 'Workflow'], ['checklist', 'Checklist'], ['readiness', 'Readiness'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="cbSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('#clientArea > .tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function cbSetTab(tab) { _tab = tab; _renderTabBar(); if (tab === 'events') _loadEvents(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.profiles_total || 0, label: 'Onboardings Tracked' },
                    { count: d.active_onboardings || 0, label: 'Active' },
                    { count: d.delayed_onboardings || 0, label: 'Delayed' },
                    { count: d.new_clients_this_month || 0, label: 'New This Month' },
                    { count: (d.avg_completion_pct != null ? d.avg_completion_pct : 0) + '%', label: 'Avg Completion' },
                    { count: (d.by_status && d.by_status.review) || 0, label: 'In Review' },
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
                var sel = document.getElementById('clientPicker');
                sel.innerHTML = '<option value="">Select a client…</option>' + clients.map(function (c) {
                    return '<option value="' + c.id + '">' + _html(c.name) + '</option>';
                }).join('');
                var params = new URLSearchParams(window.location.search);
                var preselect = params.get('client_id');
                if (preselect && clients.some(function (c) { return String(c.id) === preselect; })) {
                    sel.value = preselect;
                    cbOnClientChange();
                }
            })
            .catch(function () {});
    }

    function cbOnClientChange() {
        var val = document.getElementById('clientPicker').value;
        if (!val) { document.getElementById('clientArea').style.display = 'none'; document.getElementById('startArea').style.display = 'none'; _currentClientId = null; return; }
        _currentClientId = parseInt(val);
        _tab = 'profile'; _renderTabBar();
        cbLoadClientData();
    }

    function cbLoadClientData() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                if (!d.profile) {
                    document.getElementById('startArea').style.display = 'block';
                    document.getElementById('clientArea').style.display = 'none';
                    return;
                }
                document.getElementById('startArea').style.display = 'none';
                document.getElementById('clientArea').style.display = 'block';
                _renderProfile(d);
            })
            .catch(function () { _showToast('Failed to load onboarding data.'); });
    }

    function cbStartOnboarding() {
        var entityType = document.getElementById('sfEntityType').value;
        window.PracticeAPI.fetch(BASE + '/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: _currentClientId, entity_type: entityType }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Onboarding workspace created.');
                _loadSummary();
                cbLoadClientData();
            })
            .catch(function () { _showToast('Failed to start onboarding.'); });
    }

    // ── Profile / Workflow rendering ──────────────────────────────────────────

    function _renderProfile(d) {
        var p = d.profile;
        document.getElementById('statusPill').innerHTML = '<span class="pill os-' + _html(p.onboarding_status) + '">' + _html(STATUS_LABELS[p.onboarding_status] || p.onboarding_status) + '</span>';
        document.getElementById('completionPct').textContent = p.completion_percentage != null ? p.completion_percentage : 0;

        document.getElementById('profileActionBar').innerHTML = _actionBar(p);

        document.getElementById('pfPriority').value = p.priority || 'normal';
        document.getElementById('pfRiskLevel').value = p.risk_level || 'low';
        document.getElementById('pfAssignedTeamMember').value = p.assigned_team_member_id || '';
        document.getElementById('pfGoLiveDate').value = p.expected_go_live_date || '';
        document.getElementById('pfContactName').value = p.client_contact_name || '';
        document.getElementById('pfContactEmail').value = p.client_contact_email || '';
        document.getElementById('pfContactPhone').value = p.client_contact_phone || '';
        document.getElementById('pfNotes').value = p.notes || '';
        document.getElementById('pfInternalNotes').value = p.internal_notes || '';

        _renderSteps(d.steps || []);
        _renderChecklist(d.checklist || []);
        _renderReadiness(d.readiness || {});
        _loadEngagementReadiness();
    }

    // Codebox 71 — engagement status/readiness reused from Engagement
    // Management (no duplicate engagement logic here, and no guessing of
    // service scope — this is a read-only display, never an auto-created
    // starter engagement).
    function _loadEngagementReadiness() {
        var el = document.getElementById('engagementReadiness');
        var link = document.getElementById('onbEngagementLink');
        if (!el) return;
        if (link) link.href = '/practice/engagement-management.html?client_id=' + _currentClientId;
        window.PracticeAPI.fetch('/api/practice/engagement-management/client/' + _currentClientId + '/profile')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { el.innerHTML = '<div class="empty-state">' + _html(d.error) + '</div>'; return; }
                var active = d.active_engagements || [];
                if (!active.length) { el.innerHTML = '<div class="empty-state">No active engagements yet — create one via Engagement Management once scope is confirmed with the client.</div>'; return; }
                el.innerHTML = '<div class="mini-card">' + active.length + ' active engagement(s) &middot; Renewal due: ' + (d.renewal_due || []).length +
                    ' &middot; Missing letters: ' + (d.missing_engagement_letters || []).length + ' &middot; High risk: ' + (d.high_risk_engagements || []).length + '</div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 72 — manager-triggered scope check reused from Work
    // Authorization (no duplicate scope logic here). Deliberately NOT
    // auto-run on page load — every check writes an audit event, so this
    // stays an explicit manager action, matching the "no silent
    // initialization" discipline established for this module's own
    // auto-initializers.
    function cbCheckOnboardingCoverage() {
        var el = document.getElementById('onboardingCoverage');
        if (!_currentClientId) return;
        window.PracticeAPI.fetch('/api/practice/work-authorization/check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: _currentClientId, work_type: 'onboarding', source_module: 'client-onboarding', source_type: 'onboarding_profile', source_id: _currentClientId }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var a = d.authorization;
                el.innerHTML = '<div class="mini-card' + (a.scope_result !== 'in_scope' ? ' flag' : '') + '">' + _html(a.reason) + '<div class="mini-card-meta">' + _html(d.recommended_action) + '</div></div>';
            })
            .catch(function () { _showToast('Failed to check coverage.'); });
    }

    function _actionBar(p) {
        var btns = [];
        if (!['review', 'completed', 'cancelled'].includes(p.onboarding_status)) {
            btns.push('<button class="btn-action btn-primary" onclick="cbSubmitReview()">Submit for Review</button>');
        }
        if (p.onboarding_status === 'review' && !p.reviewed_at) {
            btns.push('<button class="btn-action btn-success" onclick="cbApprove()">Approve</button>');
        }
        if (p.onboarding_status === 'review' && p.reviewed_at) {
            btns.push('<button class="btn-action btn-success" onclick="cbComplete()">Complete Onboarding</button>');
        }
        if (!['completed', 'cancelled'].includes(p.onboarding_status)) {
            btns.push('<button class="btn-action btn-danger" onclick="cbOpenCancel()">Cancel Onboarding</button>');
        }
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '<div class="mini-card">Onboarding ' + _html(p.onboarding_status) + '.</div>';
    }

    function cbSaveProfile() {
        var payload = {
            priority: document.getElementById('pfPriority').value,
            risk_level: document.getElementById('pfRiskLevel').value,
            assigned_team_member_id: document.getElementById('pfAssignedTeamMember').value ? parseInt(document.getElementById('pfAssignedTeamMember').value) : null,
            expected_go_live_date: document.getElementById('pfGoLiveDate').value || null,
            client_contact_name: document.getElementById('pfContactName').value || null,
            client_contact_email: document.getElementById('pfContactEmail').value || null,
            client_contact_phone: document.getElementById('pfContactPhone').value || null,
            notes: document.getElementById('pfNotes').value || null,
            internal_notes: document.getElementById('pfInternalNotes').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Onboarding profile saved.'); })
            .catch(function () { _showToast('Failed to save profile.'); });
    }

    function cbSubmitReview() {
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId + '/submit-review', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Submitted for review.'); cbLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to submit for review.'); });
    }
    function cbApprove() {
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId + '/approve', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Onboarding approved.'); cbLoadClientData(); })
            .catch(function () { _showToast('Failed to approve.'); });
    }
    function cbComplete() {
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId + '/complete', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Onboarding completed.'); cbLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to complete onboarding.'); });
    }

    function cbOpenCancel() { document.getElementById('cfReason').value = ''; document.getElementById('cancelModal').classList.add('open'); }
    function cbCloseCancel() { document.getElementById('cancelModal').classList.remove('open'); }
    function cbSubmitCancel() {
        var reason = document.getElementById('cfReason').value;
        if (!reason) { _showToast('A reason is required to cancel.'); return; }
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId + '/cancel', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Onboarding cancelled.'); cbCloseCancel(); cbLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to cancel.'); });
    }

    // ── Steps ─────────────────────────────────────────────────────────────────

    function _renderSteps(rows) {
        document.getElementById('stepsBody').innerHTML = rows.length ? rows.map(function (s) {
            return '<div class="step-row">' +
                '<select onchange="cbUpdateStep(' + s.id + ',this.value)">' +
                    ['pending', 'in_progress', 'completed', 'skipped', 'blocked'].map(function (st) {
                        return '<option value="' + st + '"' + (s.status === st ? ' selected' : '') + '>' + _html(STEP_STATUS_LABELS[st]) + '</option>';
                    }).join('') +
                '</select>' +
                '<span>' + _html(s.step_name) + '</span>' +
                (s.completed_at ? '<span class="mini-card-meta">' + _fmt(s.completed_at) + '</span>' : '') +
                '</div>';
        }).join('') : '<div class="empty-state">No steps.</div>';
    }

    function cbUpdateStep(id, status) {
        window.PracticeAPI.fetch(BASE + '/steps/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Step updated.'); cbLoadClientData(); })
            .catch(function () { _showToast('Failed to update step.'); });
    }

    // ── Checklist ─────────────────────────────────────────────────────────────

    function _renderChecklist(rows) {
        document.getElementById('checklistBody').innerHTML = rows.length ? rows.map(function (i) {
            return '<tr>' +
                '<td><input type="checkbox" ' + (i.completed ? 'checked' : '') + ' onchange="cbToggleChecklistItem(' + i.id + ',this.checked)" /></td>' +
                '<td>' + _html(i.item_name) + '</td><td><span class="pill">' + _html(i.item_type) + '</span></td>' +
                '<td>' + (i.required ? 'Yes' : 'No') + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty-state">No checklist items.</td></tr>';
    }

    function cbToggleChecklistItem(id, completed) {
        window.PracticeAPI.fetch(BASE + '/checklist/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: completed }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } cbLoadClientData(); })
            .catch(function () { _showToast('Failed to update checklist item.'); });
    }

    function cbRegenerateChecklist() {
        window.PracticeAPI.fetch(BASE + '/profiles/' + _currentClientId + '/checklist/generate', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast((d.checklist_items_created || 0) + ' item(s) added.'); cbLoadClientData(); })
            .catch(function () { _showToast('Failed to regenerate checklist.'); });
    }

    // ── Readiness ─────────────────────────────────────────────────────────────

    function _renderReadiness(r) {
        document.getElementById('readinessPill').innerHTML = '<span class="pill rd-' + _html(r.overall_readiness) + '">' + _html(READINESS_LABELS[r.overall_readiness] || r.overall_readiness) + '</span>';

        var actions = r.recommended_next_actions || [];
        document.getElementById('recommendedActions').innerHTML = actions.length ? actions.map(function (a) {
            return '<div class="mini-card">' + _html(a) + '</div>';
        }).join('') : '<div class="empty-state">Nothing outstanding.</div>';

        var modules = r.module_readiness || {};
        document.getElementById('moduleGrid').innerHTML = Object.keys(modules).map(function (k) {
            var m = modules[k];
            return '<div class="module-card ' + (m.initialized ? 'ready' : 'missing') + '">' + _html(MODULE_LABELS[k] || k) + '<div class="mini-card-meta">' + (m.initialized ? m.count + ' on record' : 'Not yet set up') + '</div></div>';
        }).join('');

        var missingInfo = r.missing_information || [];
        document.getElementById('missingInfo').innerHTML = missingInfo.length ? missingInfo.map(function (f) {
            return '<div class="mini-card flag">' + _html(f) + '</div>';
        }).join('') : '<div class="empty-state">None.</div>';
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function _loadEvents() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/events?client_id=' + _currentClientId)
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

    window.cbSetTab = cbSetTab;
    window.cbOnClientChange = cbOnClientChange;
    window.cbStartOnboarding = cbStartOnboarding;
    window.cbSaveProfile = cbSaveProfile;
    window.cbCheckOnboardingCoverage = cbCheckOnboardingCoverage;
    window.cbSubmitReview = cbSubmitReview;
    window.cbApprove = cbApprove;
    window.cbComplete = cbComplete;
    window.cbOpenCancel = cbOpenCancel;
    window.cbCloseCancel = cbCloseCancel;
    window.cbSubmitCancel = cbSubmitCancel;
    window.cbUpdateStep = cbUpdateStep;
    window.cbToggleChecklistItem = cbToggleChecklistItem;
    window.cbRegenerateChecklist = cbRegenerateChecklist;

    document.addEventListener('DOMContentLoaded', cbLoadAll);
})();
