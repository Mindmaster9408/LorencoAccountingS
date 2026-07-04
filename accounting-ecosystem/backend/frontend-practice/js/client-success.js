/* Codebox 61 — Practice Client Success & Relationship Management
 * "Which client needs me today?" NOT a CRM. NOT a sales pipeline. Manager-driven.
 * Prefix: cs
 */
(function () {
    'use strict';

    var BASE = '/api/practice/client-success';
    var CONTACTS_BASE = '/api/practice/clients';   // pre-existing endpoint — see docs/new-app/61_client_success.md
    var _tab = 'clients';
    var _currentClientId = null;

    var STATUS_LABELS = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At Risk', critical: 'Critical', unknown: 'Unknown' };
    var CADENCE_LABELS = { on_track: 'On Track', due_soon: 'Due Soon', overdue: 'Overdue', unknown: 'Unknown' };
    var ACTIVITY_TYPE_LABELS = { quarterly_review: 'Quarterly Review', annual_planning: 'Annual Planning', tax_planning: 'Tax Planning', business_review: 'Business Review', health_check: 'Health Check', follow_up: 'Follow Up', training: 'Training', onboarding: 'Onboarding', other: 'Other' };
    var OPP_TYPE_LABELS = { accounting: 'Accounting', payroll: 'Payroll', pos: 'POS', inventory: 'Inventory', sean_ai: 'Sean AI', secretarial: 'Secretarial', advisory: 'Advisory', training: 'Training', other: 'Other' };
    var OPP_STATUS_LABELS = { identified: 'Identified', discussed: 'Discussed', proposal: 'Proposal', won: 'Won', lost: 'Lost', deferred: 'Deferred' };
    var EV_LABELS = {
        health_assessed: 'Health Assessed', health_overridden: 'Manager Override Set', health_override_cleared: 'Manager Override Cleared',
        activity_created: 'Activity Created', activity_updated: 'Activity Updated', activity_completed: 'Activity Completed', activity_cancelled: 'Activity Cancelled',
        meeting_logged: 'Meeting Logged', meeting_updated: 'Meeting Updated',
        opportunity_created: 'Opportunity Created', opportunity_updated: 'Opportunity Updated', opportunity_won: 'Opportunity Won', opportunity_lost: 'Opportunity Lost',
        contact_added: 'Contact Added', contact_updated: 'Contact Updated', contact_archived: 'Contact Archived',
        review_scheduled: 'Review Scheduled', review_completed: 'Review Completed',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _statusPill(s) { return '<span class="pill rs-' + _html(s || 'unknown') + '">' + _html(STATUS_LABELS[s] || s || 'Unknown') + '</span>'; }
    function _oppStatusPill(s) { return '<span class="pill st-' + _html(s) + '">' + _html(OPP_STATUS_LABELS[s] || s) + '</span>'; }
    function _cadenceLabel(s) { return '<span class="cd-' + _html(s || 'unknown') + '">' + _html(CADENCE_LABELS[s] || s || 'Unknown') + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function csLoadAll() {
        _renderTabBar();
        _loadSummary();
        csLoadClients();
        csLoadOpportunities();
        csLoadHistory();
    }

    function _renderTabBar() {
        var tabs = [['clients', 'Clients'], ['opportunities', 'Opportunities'], ['history', 'History']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="csSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function csSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var c = d.clients || {};
                var o = d.opportunities || {};
                var cards = [
                    { count: c.total || 0, label: 'Total Clients' },
                    { count: c.healthy || 0, label: 'Healthy' },
                    { count: c.watch || 0, label: 'Watch' },
                    { count: c.at_risk || 0, label: 'At Risk' },
                    { count: c.critical || 0, label: 'Critical' },
                    { count: c.reviews_overdue || 0, label: 'Reviews Overdue' },
                    { count: c.cadence_overdue || 0, label: 'Contact Overdue' },
                    { count: o.open_estimated_value ? 'R' + Math.round(o.open_estimated_value).toLocaleString() : 'R0', label: 'Open Opportunity Value' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (card) {
                    return '<div class="summary-card"><div class="sc-count">' + card.count + '</div><div class="sc-label">' + _html(card.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Clients list ──────────────────────────────────────────────────────────

    function csLoadClients() {
        var status = document.getElementById('csStatusFilter').value;
        var assignedToMe = document.getElementById('csAssignedToMe').checked;
        var qs = [];
        if (status) qs.push('status=' + encodeURIComponent(status));
        if (assignedToMe) qs.push('assigned_to_me=true');
        window.PracticeAPI.fetch(BASE + '/' + (qs.length ? '?' + qs.join('&') : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.clients || [];
                if (!rows.length) { document.getElementById('clientsBody').innerHTML = '<tr><td colspan="8" class="empty-state">No clients found.</td></tr>'; return; }
                document.getElementById('clientsBody').innerHTML = rows.map(function (r) {
                    return '<tr class="client-row" onclick="csOpenClientDetail(' + r.client_id + ')">' +
                        '<td>' + _html(r.client_name) + '</td>' +
                        '<td>' + _statusPill(r.relationship_status) + (r.is_manager_override ? '<span class="override-flag">override</span>' : '') + '</td>' +
                        '<td>' + (r.relationship_score != null ? r.relationship_score : '—') + '</td>' +
                        '<td>' + _html(r.trend) + '</td>' +
                        '<td>' + _html(r.relationship_owner || '—') + '</td>' +
                        '<td>' + _cadenceLabel(r.cadence_status) + '</td>' +
                        '<td>' + _fmtDate(r.last_meaningful_contact_date) + '</td>' +
                        '<td>' + _fmtDate(r.next_review_date) + '</td>' +
                    '</tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('clientsBody').innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load.</td></tr>'; });
    }

    // ── Client Detail ────────────────────────────────────────────────────────

    function csOpenClientDetail(clientId) {
        _currentClientId = clientId;
        var now = new Date();
        var periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        var periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
        Promise.all([
            window.PracticeAPI.fetch(BASE + '/' + clientId).then(function (r) { return r.json(); }),
            window.PracticeAPI.fetch(BASE + '/' + clientId + '/health').then(function (r) { return r.json(); }),
            window.PracticeAPI.fetch(CONTACTS_BASE + '/' + clientId + '/contacts').then(function (r) { return r.json(); }).catch(function () { return { contacts: [] }; }),
            // Codebox 71 — engagement profile reused via GET
            // /engagement-management/client/:clientId/profile (no duplicate
            // engagement logic here).
            window.PracticeAPI.fetch('/api/practice/engagement-management/client/' + clientId + '/profile').then(function (r) { return r.json(); }).catch(function () { return null; }),
            // Codebox 73 — current-month profitability reused from
            // Profitability (no duplicate margin/realization logic here).
            window.PracticeAPI.fetch('/api/practice/profitability/client/' + clientId + '?period_start=' + periodStart + '&period_end=' + periodEnd).then(function (r) { return r.json(); }).catch(function () { return null; }),
            window.PracticeAPI.fetch('/api/practice/profitability/reviews?client_id=' + clientId).then(function (r) { return r.json(); }).catch(function () { return { reviews: [] }; }),
            // Codebox 74 — pricing reviews reused from Pricing Review (no
            // duplicate workflow logic here).
            window.PracticeAPI.fetch('/api/practice/pricing-review/?client_id=' + clientId).then(function (r) { return r.json(); }).catch(function () { return { reviews: [] }; }),
        ]).then(function (results) {
            _renderClientDetail(results[0], results[1], results[2].contacts || [], results[3], results[4], results[5].reviews || [], results[6].reviews || []);
            document.getElementById('clientDetailModal').classList.add('open');
            var responsibleId = results[0].client && results[0].client.responsible_team_member_id;
            if (responsibleId) {
                _loadResponsibleScorecard(responsibleId);
            } else {
                var el = document.getElementById('responsibleScorecardBody');
                if (el) el.innerHTML = '<div class="empty-state">No responsible team member assigned to this client.</div>';
            }
        }).catch(function () { _showToast('Failed to load client detail.'); });
    }

    // Codebox 75 — read-only reuse of the responsible team member's most
    // recently SAVED Partner/Manager Scorecard (no new calculation here —
    // buildScorecard() is never called from this page). Purely informational.
    function _loadResponsibleScorecard(teamMemberId) {
        var el = document.getElementById('responsibleScorecardBody');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/partner-scorecards/snapshots?team_member_id=' + teamMemberId + '&limit=1')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var s = (d.scorecards || [])[0];
                el.innerHTML = s
                    ? '<div class="mini-card">' + _html(s.team_member_name || 'Responsible team member') + ' — overall score: <strong>' + (s.overall_score != null ? s.overall_score : '—') + '</strong>' +
                      '<div class="mini-card-meta">' + _html(s.scorecard_type) + ' scorecard, ' + _fmtDate(s.period_start) + ' – ' + _fmtDate(s.period_end) + '</div></div>'
                    : '<div class="empty-state">No saved scorecard for the responsible team member yet.</div>';
            })
            .catch(function () { if (el) el.innerHTML = ''; });
    }
    function csCloseClientDetail() { document.getElementById('clientDetailModal').classList.remove('open'); }

    function _renderClientDetail(detail, health, contacts, engagementProfile, profitability, profitabilityReviews, pricingReviews) {
        var s = detail.success || {};
        var client = detail.client || {};
        var html = '';
        html += '<div class="modal-title">' + _html(client.name) + ' ' + _statusPill(s.relationship_status) +
            (s.is_manager_override ? '<span class="override-flag">manager override</span>' : '') + '</div>';

        html += '<div class="health-breakdown">';
        html += 'Cadence: ' + _cadenceLabel(detail.cadence_status) + ' &middot; Review: ' + _html(detail.review_status) + ' &middot; Score: ' + (s.relationship_score != null ? s.relationship_score : '—');
        if (health.operational_component) {
            html += '<br/>Operational health (from Client Health): ' + _html(health.operational_component.status) + ' (score ' + (health.operational_component.score != null ? health.operational_component.score : '—') + ')';
        }
        // Codebox 62 — governance summary reused from Secretarial (outstanding
        // annual returns / no active directors). No duplicate logic here.
        if (detail.governance && detail.governance.governance_concern) {
            html += '<br/><span style="color:#f6ad55;">⚠ Governance: ' + _html(detail.governance.governance_concern) + '</span>';
        }
        html += '</div>';

        html += '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">' +
            '<button class="btn-action btn-secondary" onclick="csOpenRelEdit()">Edit Relationship Info</button>' +
            '<button class="btn-action btn-warn" onclick="csOpenOverride()">Manager Override</button>' +
            '<button class="btn-action btn-secondary" onclick="csRecalculate()">Recalculate</button>' +
        '</div>';

        html += '<div class="detail-section-title">Success Activities <button class="btn-action btn-primary" onclick="csOpenActivity()">+ Add</button></div>';
        html += (detail.activities || []).length ? detail.activities.map(function (a) {
            return '<div class="mini-card">' + _html(a.title) + ' <span class="pill st-' + _html(a.status) + '">' + _html(a.status) + '</span>' +
                '<div class="mini-card-meta">' + _html(ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type) + ' &middot; Scheduled: ' + _fmtDate(a.scheduled_date) + '</div></div>';
        }).join('') : '<div class="empty-state">No activities logged.</div>';

        html += '<div class="detail-section-title">Meeting History <button class="btn-action btn-primary" onclick="csOpenMeeting()">+ Log Meeting</button></div>';
        html += (detail.meetings || []).length ? detail.meetings.map(function (m) {
            return '<div class="mini-card">' + _fmtDate(m.meeting_date) + ' — ' + _html(m.purpose || 'Meeting') +
                '<div class="mini-card-meta">' + _html(m.summary || '') + '</div></div>';
        }).join('') : '<div class="empty-state">No meetings logged.</div>';

        html += '<div class="detail-section-title">Strategic Opportunities <button class="btn-action btn-primary" onclick="csOpenOpportunity()">+ Add</button></div>';
        html += (detail.opportunities || []).length ? detail.opportunities.map(function (o) {
            return '<div class="mini-card">' + _html(o.title) + ' ' + _oppStatusPill(o.status) +
                '<div class="mini-card-meta">' + _html(OPP_TYPE_LABELS[o.opportunity_type] || o.opportunity_type) + (o.estimated_value ? ' &middot; R' + Number(o.estimated_value).toLocaleString() : '') + '</div></div>';
        }).join('') : '<div class="empty-state">No opportunities logged.</div>';

        // Codebox 75 — read-only reuse of the responsible team member's most
        // recently saved Partner/Manager Scorecard. No new calculation here
        // — populated asynchronously by _loadResponsibleScorecard() after
        // this modal opens.
        html += '<div class="detail-section-title">Responsible Team Member Performance <a href="/practice/partner-scorecards.html" class="btn-action btn-secondary" style="text-decoration:none;">Open Partner Scorecards →</a></div>';
        html += '<div id="responsibleScorecardBody"><div class="empty-state">Loading…</div></div>';

        // Codebox 71 — engagement summary reused from Engagement Management
        // (active services, renewal due, missing letters, high-risk
        // engagements). No duplicate engagement logic here.
        html += '<div class="detail-section-title">Engagements <a href="/practice/engagement-management.html?client_id=' + client.id + '" class="btn-action btn-secondary" style="text-decoration:none;">Manage Engagements →</a></div>';
        if (engagementProfile && !engagementProfile.error) {
            var activeServices = engagementProfile.services_covered || [];
            html += '<div class="mini-card">Active services: ' + (activeServices.length ? activeServices.map(_html).join(', ') : 'None') + '</div>';
            html += '<div class="mini-card">Renewal due: <strong>' + (engagementProfile.renewal_due || []).length + '</strong> &middot; ' +
                'Missing letters: <strong>' + (engagementProfile.missing_engagement_letters || []).length + '</strong> &middot; ' +
                'High risk: <strong>' + (engagementProfile.high_risk_engagements || []).length + '</strong></div>';
        } else {
            html += '<div class="empty-state">No engagement data available.</div>';
        }

        // Codebox 73 — profitability status reused from Profitability (no
        // duplicate margin/realization logic here).
        html += '<div class="detail-section-title">Profitability <a href="/practice/profitability.html" class="btn-action btn-secondary" style="text-decoration:none;">Open Profitability →</a></div>';
        if (profitability && profitability.analysis && !profitability.error) {
            var a = profitability.analysis;
            var lowMargin = ['low_margin', 'unprofitable'].indexOf(a.profitability_status) !== -1;
            html += '<div class="mini-card" style="' + (lowMargin ? 'border-left:3px solid #fc8181;' : '') + '">Status: <strong>' + _html(a.profitability_status) + '</strong>' +
                (a.realization_percentage != null ? ' &middot; Realization: ' + a.realization_percentage + '%' : '') + '</div>';
            if (lowMargin) html += '<div class="mini-card" style="border-left:3px solid #fc8181;">⚠ Low margin/unprofitable this month — consider a pricing or scope conversation.</div>';
        } else {
            html += '<div class="empty-state">No profitability data for this month yet.</div>';
        }
        var openReviews = (profitabilityReviews || []).filter(function (r) { return ['draft', 'under_review', 'reviewed', 'action_required'].indexOf(r.review_status) !== -1; });
        var dueReviews = openReviews.filter(function (r) { return r.next_review_date && r.next_review_date <= new Date().toISOString().slice(0, 10); });
        if (dueReviews.length) html += '<div class="mini-card" style="border-left:3px solid #f6ad55;">📌 ' + dueReviews.length + ' profitability review(s) due for a repricing/scope discussion.</div>';

        // Codebox 74 — pricing reviews reused from Pricing Review (no
        // duplicate workflow logic here). "Commercial review due" is a
        // deterministic flag (low margin + no active pricing review), never
        // a suggested fee — that remains a partner decision on the Pricing
        // Reviews page.
        var activePricingReviews = (pricingReviews || []).filter(function (r) { return ['implemented', 'rejected', 'cancelled'].indexOf(r.pricing_status) === -1; });
        html += '<div class="detail-section-title">Pricing Reviews <a href="/practice/pricing-review.html?client_id=' + client.id + '" class="btn-action btn-secondary" style="text-decoration:none;">Open Pricing Reviews →</a></div>';
        html += activePricingReviews.length ? activePricingReviews.map(function (r) {
            return '<div class="mini-card">' + _html(r.review_title) + ' <span class="pill">' + _html(r.pricing_status) + '</span></div>';
        }).join('') : '<div class="empty-state">No active pricing review.</div>';
        if (typeof lowMargin !== 'undefined' && lowMargin && !activePricingReviews.length) {
            html += '<div class="mini-card" style="border-left:3px solid #f6ad55;">📌 Commercial review due — low margin this month with no active pricing review in progress.</div>';
        }

        html += '<div class="detail-section-title">Key Contacts <button class="btn-action btn-primary" onclick="csOpenContact()">+ Add</button></div>';
        html += contacts.length ? contacts.map(function (c) {
            var flags = [];
            if (c.is_primary) flags.push('Preferred');
            if (c.is_decision_maker) flags.push('Decision Maker');
            if (c.is_financial_contact) flags.push('Financial');
            if (c.is_operational_contact) flags.push('Operational');
            return '<div class="mini-card">' + _html(c.contact_name) + (c.role ? ' — ' + _html(c.role) : '') +
                '<div class="mini-card-meta">' + _html(c.email || '') + (c.phone ? ' &middot; ' + _html(c.phone) : '') + (flags.length ? ' &middot; ' + flags.join(', ') : '') + '</div></div>';
        }).join('') : '<div class="empty-state">No contacts on file.</div>';

        document.getElementById('clientDetailBody').innerHTML = html;
    }

    function csRecalculate() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/recalculate', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Health recalculated.'); csOpenClientDetail(_currentClientId); csLoadClients(); _loadSummary(); })
            .catch(function () { _showToast('Failed to recalculate.'); });
    }

    // ── Override ──────────────────────────────────────────────────────────────

    function csOpenOverride() { document.getElementById('overrideModal').classList.add('open'); }
    function csCloseOverride() { document.getElementById('overrideModal').classList.remove('open'); }
    function csSubmitOverride() {
        var payload = {
            relationship_status: document.getElementById('ovStatus').value,
            relationship_score: document.getElementById('ovScore').value || null,
            override_reason: document.getElementById('ovReason').value,
        };
        if (!payload.override_reason) { _showToast('Reason is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/override', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Override set.'); csCloseOverride(); csOpenClientDetail(_currentClientId); csLoadClients(); _loadSummary(); })
            .catch(function () { _showToast('Failed to set override.'); });
    }
    function csClearOverride() {
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/override', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Override cleared.'); csCloseOverride(); csOpenClientDetail(_currentClientId); csLoadClients(); _loadSummary(); })
            .catch(function () { _showToast('Failed to clear override.'); });
    }

    // ── Relationship Edit ─────────────────────────────────────────────────────

    function csOpenRelEdit() { document.getElementById('relEditModal').classList.add('open'); }
    function csCloseRelEdit() { document.getElementById('relEditModal').classList.remove('open'); }
    function csSubmitRelEdit() {
        var payload = {
            trend: document.getElementById('reTrend').value,
            relationship_owner_team_member_id: document.getElementById('reOwner').value || null,
            last_meaningful_contact_date: document.getElementById('reLastContact').value || null,
            next_planned_contact_date: document.getElementById('reNextContact').value || null,
            last_review_date: document.getElementById('reLastReview').value || null,
            next_review_date: document.getElementById('reNextReview').value || null,
            notes: document.getElementById('reNotes').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Relationship info saved.'); csCloseRelEdit(); csOpenClientDetail(_currentClientId); csLoadClients(); })
            .catch(function () { _showToast('Failed to save.'); });
    }

    // ── Activities ────────────────────────────────────────────────────────────

    function csOpenActivity() { document.getElementById('activityModal').classList.add('open'); }
    function csCloseActivity() { document.getElementById('activityModal').classList.remove('open'); }
    function csSubmitActivity() {
        var payload = {
            title: document.getElementById('afTitle').value,
            activity_type: document.getElementById('afType').value,
            scheduled_date: document.getElementById('afScheduled').value || null,
            description: document.getElementById('afDescription').value || null,
        };
        if (!payload.title) { _showToast('Title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Activity added.'); csCloseActivity(); csOpenClientDetail(_currentClientId); })
            .catch(function () { _showToast('Failed to add activity.'); });
    }

    // ── Meetings ──────────────────────────────────────────────────────────────

    function csOpenMeeting() { document.getElementById('meetingModal').classList.add('open'); }
    function csCloseMeeting() { document.getElementById('meetingModal').classList.remove('open'); }
    function csSubmitMeeting() {
        var attendeesRaw = document.getElementById('mfAttendees').value;
        var payload = {
            meeting_date: document.getElementById('mfDate').value,
            next_meeting_date: document.getElementById('mfNextDate').value || null,
            purpose: document.getElementById('mfPurpose').value || null,
            attendees: attendeesRaw ? attendeesRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
            summary: document.getElementById('mfSummary').value || null,
            decisions: document.getElementById('mfDecisions').value || null,
            follow_ups: document.getElementById('mfFollowUps').value || null,
        };
        if (!payload.meeting_date) { _showToast('Meeting date is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Meeting logged.'); csCloseMeeting(); csOpenClientDetail(_currentClientId); csLoadClients(); })
            .catch(function () { _showToast('Failed to log meeting.'); });
    }

    // ── Opportunities ─────────────────────────────────────────────────────────

    function csOpenOpportunity() { document.getElementById('opportunityModal').classList.add('open'); }
    function csCloseOpportunity() { document.getElementById('opportunityModal').classList.remove('open'); }
    function csSubmitOpportunity() {
        var payload = {
            title: document.getElementById('ofTitle').value,
            opportunity_type: document.getElementById('ofType').value,
            estimated_value: document.getElementById('ofValue').value || null,
            expected_date: document.getElementById('ofExpected').value || null,
            description: document.getElementById('ofDescription').value || null,
        };
        if (!payload.title) { _showToast('Title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/opportunities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Opportunity added.'); csCloseOpportunity(); csOpenClientDetail(_currentClientId); csLoadOpportunities(); })
            .catch(function () { _showToast('Failed to add opportunity.'); });
    }

    function csLoadOpportunities() {
        var status = document.getElementById('oppStatusFilter').value;
        window.PracticeAPI.fetch(BASE + '/opportunities/all' + (status ? '?status=' + encodeURIComponent(status) : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.opportunities || [];
                if (!rows.length) { document.getElementById('oppBody').innerHTML = '<tr><td colspan="6" class="empty-state">No opportunities logged.</td></tr>'; return; }
                document.getElementById('oppBody').innerHTML = rows.map(function (o) {
                    return '<tr><td>' + _html(o.client_name) + '</td><td>' + _html(o.title) + '</td><td>' + _html(OPP_TYPE_LABELS[o.opportunity_type] || o.opportunity_type) + '</td>' +
                        '<td>' + _oppStatusPill(o.status) + '</td><td>' + (o.estimated_value ? 'R' + Number(o.estimated_value).toLocaleString() : '—') + '</td><td>' + _fmtDate(o.expected_date) + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('oppBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    // ── Contacts (proxies the pre-existing /api/practice/clients/:id/contacts endpoint) ──

    function csOpenContact() { document.getElementById('contactModal').classList.add('open'); }
    function csCloseContact() { document.getElementById('contactModal').classList.remove('open'); }
    function csSubmitContact() {
        var payload = {
            contact_name: document.getElementById('cfName').value,
            role: document.getElementById('cfRole').value || null,
            email: document.getElementById('cfEmail').value || null,
            phone: document.getElementById('cfPhone').value || null,
            mobile: document.getElementById('cfMobile').value || null,
            birthday: document.getElementById('cfBirthday').value || null,
            is_primary: document.getElementById('cfPrimary').checked,
            is_decision_maker: document.getElementById('cfDecisionMaker').checked,
            is_financial_contact: document.getElementById('cfFinancial').checked,
            is_operational_contact: document.getElementById('cfOperational').checked,
        };
        if (!payload.contact_name) { _showToast('Contact name is required.'); return; }
        window.PracticeAPI.fetch(CONTACTS_BASE + '/' + _currentClientId + '/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Contact added.'); csCloseContact(); csOpenClientDetail(_currentClientId); })
            .catch(function () { _showToast('Failed to add contact.'); });
    }

    // ── History ───────────────────────────────────────────────────────────────

    function csLoadHistory() {
        window.PracticeAPI.fetch(BASE + '/events/log')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                if (!rows.length) { document.getElementById('historyBody').innerHTML = '<div class="empty-state">No events yet.</div>'; return; }
                document.getElementById('historyBody').innerHTML = rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) +
                        '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('');
            })
            .catch(function () { document.getElementById('historyBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.csSetTab = csSetTab;
    window.csLoadClients = csLoadClients;
    window.csLoadOpportunities = csLoadOpportunities;
    window.csOpenClientDetail = csOpenClientDetail;
    window.csCloseClientDetail = csCloseClientDetail;
    window.csRecalculate = csRecalculate;
    window.csOpenOverride = csOpenOverride;
    window.csCloseOverride = csCloseOverride;
    window.csSubmitOverride = csSubmitOverride;
    window.csClearOverride = csClearOverride;
    window.csOpenRelEdit = csOpenRelEdit;
    window.csCloseRelEdit = csCloseRelEdit;
    window.csSubmitRelEdit = csSubmitRelEdit;
    window.csOpenActivity = csOpenActivity;
    window.csCloseActivity = csCloseActivity;
    window.csSubmitActivity = csSubmitActivity;
    window.csOpenMeeting = csOpenMeeting;
    window.csCloseMeeting = csCloseMeeting;
    window.csSubmitMeeting = csSubmitMeeting;
    window.csOpenOpportunity = csOpenOpportunity;
    window.csCloseOpportunity = csCloseOpportunity;
    window.csSubmitOpportunity = csSubmitOpportunity;
    window.csOpenContact = csOpenContact;
    window.csCloseContact = csCloseContact;
    window.csSubmitContact = csSubmitContact;

    document.addEventListener('DOMContentLoaded', csLoadAll);
})();
