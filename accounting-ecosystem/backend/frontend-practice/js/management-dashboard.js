/* Codebox 50 — Management Dashboard (Executive Command Centre)
 * Read-only aggregator for partners. NOT an operational page. NOT AI.
 * Prefix: md
 */
(function () {
    'use strict';

    var BASE = '/api/practice/management-dashboard';

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }

    function _scoreColor(v) {
        if (v >= 80) return '#68d391';
        if (v >= 60) return '#f6ad55';
        return '#fc8181';
    }

    function _kpiClass(value, warnAt, badAt) {
        if (value >= badAt) return 'kpi-bad';
        if (value >= warnAt) return 'kpi-warn';
        return 'kpi-good';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function mdRefreshAll() {
        _loadScore();
        _loadSummary();
        _loadAlerts();
        _loadPartnerQueue();
        _loadFeed();
    }

    // ── Practice Score ───────────────────────────────────────────────────────

    function _loadScore() {
        window.PracticeAPI.fetch(BASE + '/practice-score')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderScore(d); })
            .catch(function () {});
    }

    function _renderScore(d) {
        var overall = d.overall_score != null ? d.overall_score : 0;
        var color = _scoreColor(overall);
        document.getElementById('scoreValue').textContent = overall;
        document.getElementById('scoreValue').style.color = color;
        document.getElementById('scoreRing').style.background =
            'conic-gradient(' + color + ' ' + (overall * 3.6) + 'deg, #12122a 0deg)';

        var weights = d.weights || {};
        var scores = d.scores || {};
        var order = ['quality', 'compliance', 'risk', 'capacity', 'tax'];
        var labels = { quality: 'Quality', compliance: 'Compliance', risk: 'Risk', capacity: 'Capacity', tax: 'Tax' };

        document.getElementById('subscoreGrid').innerHTML = order.map(function (key) {
            var val = scores[key] != null ? scores[key] : 0;
            var weight = weights[key] != null ? Math.round(weights[key] * 100) : 0;
            var c = _scoreColor(val);
            return '<div class="subscore-card">' +
                '<div class="subscore-name">' + labels[key] + '</div>' +
                '<div class="subscore-value" style="color:' + c + ';">' + val + '</div>' +
                '<div class="subscore-weight">Weight: ' + weight + '%</div>' +
                '<div class="subscore-bar-track"><div class="subscore-bar-fill" style="width:' + val + '%;background:' + c + ';"></div></div>' +
            '</div>';
        }).join('');
    }

    // ── Summary KPIs ──────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {});
    }

    function _kpi(cls, value, label, href) {
        var onclick = href ? ' onclick="window.location.href=\'' + href + '\'"' : '';
        return '<div class="kpi-card ' + cls + '"' + onclick + '>' +
            '<div class="kpi-value">' + _html(value) + '</div>' +
            '<div class="kpi-label">' + _html(label) + '</div>' +
        '</div>';
    }

    function _renderSummary(d) {
        var p = d.practice || {}, c = d.capacity || {}, t = d.tax || {}, q = d.qms || {}, rk = d.risk || {},
            ch = d.client_health || {}, kb = d.knowledge || {}, sop = d.sop || {}, b = d.billing || {},
            rem = d.reminders || {}, doc = d.document_requests || {}, comm = d.communications || {}, comp = d.compliance || {};

        document.getElementById('kpiPractice').innerHTML =
            _kpi('kpi-neutral', p.active_clients || 0, 'Active Clients', '/practice/clients.html') +
            _kpi('kpi-neutral', p.active_staff || 0, 'Active Staff', '/practice/team.html') +
            _kpi(_kpiClass(p.open_tasks || 0, 20, 50), p.open_tasks || 0, 'Open Tasks', '/practice/tasks.html') +
            _kpi(_kpiClass(p.overdue_tasks || 0, 1, 5), p.overdue_tasks || 0, 'Overdue Tasks', '/practice/tasks.html') +
            _kpi(_kpiClass(c.over_capacity_staff || 0, 1, 3), c.over_capacity_staff || 0, 'Over-Capacity Staff', '/practice/capacity.html') +
            _kpi('kpi-neutral', (c.avg_utilization_pct != null ? c.avg_utilization_pct + '%' : '—'), 'Avg Utilization', '/practice/capacity.html');

        document.getElementById('kpiTax').innerHTML =
            _kpi('kpi-neutral', t.open_returns || 0, 'Open Returns', '/practice/tax-dashboard.html') +
            _kpi('kpi-neutral', t.ready_review || 0, 'Ready for Review', '/practice/tax-pipeline.html') +
            _kpi('kpi-good', t.ready_submit || 0, 'Ready to Submit', '/practice/tax-pipeline.html') +
            _kpi('kpi-neutral', t.pipeline || 0, 'In Pipeline', '/practice/tax-pipeline.html') +
            _kpi(_kpiClass(t.payments_outstanding || 0, 1, 5), t.payments_outstanding || 0, 'Payments Outstanding', '/practice/tax-payments.html') +
            _kpi(_kpiClass(t.sars_recon_unmatched || 0, 1, 10), t.sars_recon_unmatched || 0, 'SARS Unmatched Lines', '/practice/sars-recon.html') +
            _kpi(_kpiClass(t.open_disputes || 0, 1, 5), t.open_disputes || 0, 'Open Disputes', '/practice/tax-disputes.html') +
            _kpi('kpi-neutral', t.completion_packs_active || 0, 'Completion Packs Active', '/practice/tax-completion.html');

        document.getElementById('kpiQms').innerHTML =
            _kpi('kpi-neutral', q.active_reviews || 0, 'Active Reviews', '/practice/quality-management.html') +
            _kpi(_kpiClass(q.failed_reviews || 0, 1, 3), q.failed_reviews || 0, 'Failed Reviews', '/practice/quality-management.html') +
            _kpi(_kpiClass(q.needs_correction || 0, 1, 3), q.needs_correction || 0, 'Needs Correction', '/practice/quality-management.html') +
            _kpi(_kpiClass(q.open_findings || 0, 3, 10), q.open_findings || 0, 'Open Findings', '/practice/quality-management.html') +
            _kpi(_kpiClass(q.critical_findings || 0, 1, 3), q.critical_findings || 0, 'Critical Findings', '/practice/quality-management.html') +
            _kpi(_kpiClass(q.high_findings || 0, 1, 5), q.high_findings || 0, 'High Findings', '/practice/quality-management.html');

        document.getElementById('kpiRisk').innerHTML =
            _kpi('kpi-neutral', rk.open_risks || 0, 'Open Risks', '/practice/risk-register.html') +
            _kpi(_kpiClass(rk.high_risks || 0, 1, 5), rk.high_risks || 0, 'High Risks', '/practice/risk-register.html') +
            _kpi(_kpiClass(rk.critical_risks || 0, 1, 3), rk.critical_risks || 0, 'Critical Risks', '/practice/risk-register.html');

        document.getElementById('kpiClientHealth').innerHTML =
            _kpi('kpi-good', ch.healthy || 0, 'Healthy', '/practice/client-health.html') +
            _kpi('kpi-warn', ch.watch || 0, 'Watch', '/practice/client-health.html') +
            _kpi(_kpiClass(ch.critical || 0, 1, 3), ch.critical || 0, 'Critical', '/practice/client-health.html') +
            _kpi('kpi-neutral', ch.unknown || 0, 'Unassessed', '/practice/client-health.html');

        // Codebox 61 — RELATIONSHIP health (manager assessment + communication
        // cadence), a separate concept from client_health above (operational risk).
        var cr = d.client_relationship || {};
        var kpiClientRelationshipEl = document.getElementById('kpiClientRelationship');
        if (kpiClientRelationshipEl) {
            kpiClientRelationshipEl.innerHTML =
                _kpi('kpi-good', cr.healthy || 0, 'Relationship: Healthy', '/practice/client-success.html') +
                _kpi('kpi-warn', cr.watch || 0, 'Relationship: Watch', '/practice/client-success.html') +
                _kpi(_kpiClass(cr.at_risk || 0, 1, 3), cr.at_risk || 0, 'Relationship: At Risk', '/practice/client-success.html') +
                _kpi(_kpiClass(cr.critical || 0, 1, 2), cr.critical || 0, 'Relationship: Critical', '/practice/client-success.html');
        }

        // Codebox 65 — Beneficial Ownership summary. Low-risk counts only,
        // same optional-card treatment as the client relationship section above.
        var bo = d.beneficial_ownership || {};
        var boByStatus = bo.owners_by_status || {};
        var kpiBoEl = document.getElementById('kpiBeneficialOwnership');
        if (kpiBoEl) {
            kpiBoEl.innerHTML =
                _kpi('kpi-good', boByStatus.verified || 0, 'BO: Verified Owners', '/practice/beneficial-ownership.html') +
                _kpi('kpi-neutral', boByStatus.incomplete || 0, 'BO: Incomplete Owners', '/practice/beneficial-ownership.html') +
                _kpi('kpi-neutral', bo.reportable_owners || 0, 'BO: Reportable Owners', '/practice/beneficial-ownership.html') +
                _kpi(_kpiClass(bo.clients_with_blocked_items || 0, 1, 3), bo.clients_with_blocked_items || 0, 'BO: Clients Blocked', '/practice/beneficial-ownership.html');
        }

        // Codebox 67 — Statutory Compliance summary. Reuses the same
        // buildStatutoryCalendar() counts the Statutory Calendar page itself shows.
        var sca = d.statutory_compliance || {};
        var kpiScEl = document.getElementById('kpiStatutoryCompliance');
        if (kpiScEl) {
            kpiScEl.innerHTML =
                _kpi(_kpiClass(sca.overdue || 0, 1, 5), sca.overdue || 0, 'Statutory: Overdue', '/practice/secretarial-calendar.html') +
                _kpi(_kpiClass(sca.due_today || 0, 1, 3), sca.due_today || 0, 'Statutory: Due Today', '/practice/secretarial-calendar.html') +
                _kpi('kpi-neutral', sca.upcoming || 0, 'Statutory: Upcoming', '/practice/secretarial-calendar.html') +
                _kpi(_kpiClass(sca.blocked || 0, 1, 3), sca.blocked || 0, 'Statutory: Blocked', '/practice/secretarial-calendar.html');
        }

        // Codebox 66 — Evidence readiness summary.
        var ev = d.evidence_readiness || {};
        var evByR = ev.by_readiness || {};
        var kpiEvEl = document.getElementById('kpiEvidenceReadiness');
        if (kpiEvEl) {
            kpiEvEl.innerHTML =
                _kpi('kpi-good', evByR.ready || 0, 'Evidence: Ready', '/practice/secretarial-evidence.html') +
                _kpi('kpi-neutral', evByR.partial || 0, 'Evidence: Partial', '/practice/secretarial-evidence.html') +
                _kpi(_kpiClass(evByR.incomplete || 0, 1, 5), evByR.incomplete || 0, 'Evidence: Incomplete', '/practice/secretarial-evidence.html') +
                _kpi(_kpiClass(ev.blocked || 0, 1, 3), ev.blocked || 0, 'Evidence: Blocked', '/practice/secretarial-evidence.html');
        }

        // Codebox 68 — Entity Lifecycle summary.
        var el = d.entity_lifecycle || {};
        var kpiElEl = document.getElementById('kpiEntityLifecycle');
        if (kpiElEl) {
            kpiElEl.innerHTML =
                _kpi('kpi-neutral', el.entities_tracked || 0, 'Lifecycle: Entities Tracked', '/practice/entity-lifecycle.html') +
                _kpi(_kpiClass(el.high_risk || 0, 1, 3), el.high_risk || 0, 'Lifecycle: High/Critical Risk', '/practice/entity-lifecycle.html') +
                _kpi(_kpiClass(el.non_compliant || 0, 1, 3), el.non_compliant || 0, 'Lifecycle: Non-Compliant', '/practice/entity-lifecycle.html') +
                _kpi(_kpiClass(el.transitions_pending_review || 0, 1, 5), el.transitions_pending_review || 0, 'Lifecycle: Transitions Pending Review', '/practice/entity-lifecycle.html');
        }

        // Codebox 69 — Secretarial Integrity summary.
        var si = d.secretarial_integrity || {};
        var kpiSiEl = document.getElementById('kpiSecretarialIntegrity');
        if (kpiSiEl) {
            kpiSiEl.innerHTML =
                _kpi(si.latest_score == null ? 'kpi-neutral' : (si.latest_score >= 85 ? 'kpi-good' : (si.latest_score >= 60 ? 'kpi-neutral' : 'kpi-bad')), si.latest_score != null ? si.latest_score : '—', 'Integrity: Latest Score', '/practice/secretarial-integrity.html') +
                _kpi(_kpiClass(si.critical_findings || 0, 1, 3), si.critical_findings || 0, 'Integrity: Critical Findings', '/practice/secretarial-integrity.html') +
                _kpi(_kpiClass(si.open_findings || 0, 1, 10), si.open_findings || 0, 'Integrity: Open Findings', '/practice/secretarial-integrity.html') +
                _kpi('kpi-neutral', si.latest_run_at ? new Date(si.latest_run_at).toLocaleDateString('en-ZA') : 'Never run', 'Integrity: Latest Audit', '/practice/secretarial-integrity.html');
        }

        // Codebox 70 — Client Onboarding summary.
        var cb = d.client_onboarding || {};
        var kpiCbEl = document.getElementById('kpiClientOnboarding');
        if (kpiCbEl) {
            kpiCbEl.innerHTML =
                _kpi('kpi-neutral', cb.new_clients_this_month || 0, 'Onboarding: New This Month', '/practice/client-onboarding.html') +
                _kpi('kpi-neutral', cb.active_onboardings || 0, 'Onboarding: Active', '/practice/client-onboarding.html') +
                _kpi(_kpiClass(cb.delayed_onboardings || 0, 1, 3), cb.delayed_onboardings || 0, 'Onboarding: Delayed', '/practice/client-onboarding.html') +
                _kpi('kpi-neutral', (cb.avg_completion_pct != null ? cb.avg_completion_pct + '%' : '—'), 'Onboarding: Avg Progress', '/practice/client-onboarding.html');
        }

        // Codebox 71 — Engagement Management summary.
        var em = d.engagement_management || {};
        var kpiEmEl = document.getElementById('kpiEngagementManagement');
        if (kpiEmEl) {
            kpiEmEl.innerHTML =
                _kpi(_kpiClass(em.due_for_review || 0, 1, 5), em.due_for_review || 0, 'Engagements: Due for Review', '/practice/engagement-management.html') +
                _kpi(_kpiClass(em.missing_engagement_letters || 0, 1, 5), em.missing_engagement_letters || 0, 'Engagements: Missing Letters', '/practice/engagement-management.html') +
                _kpi(_kpiClass(em.high_risk_without_acceptance || 0, 1, 3), em.high_risk_without_acceptance || 0, 'Engagements: High Risk, No Acceptance', '/practice/engagement-management.html') +
                _kpi(_kpiClass(em.clients_with_work_no_engagement || 0, 1, 3), em.clients_with_work_no_engagement || 0, 'Clients: Work, No Engagement', '/practice/engagement-management.html');
        }

        // Codebox 72 — Work Authorization summary.
        var wa = d.work_authorization || {};
        var kpiWaEl = document.getElementById('kpiWorkAuthorization');
        if (kpiWaEl) {
            kpiWaEl.innerHTML =
                _kpi(_kpiClass(wa.out_of_scope_work || 0, 1, 5), wa.out_of_scope_work || 0, 'Authorization: Out of Scope', '/practice/work-authorization.html') +
                _kpi(_kpiClass(wa.pending_overrides || 0, 1, 5), wa.pending_overrides || 0, 'Authorization: Pending Overrides', '/practice/work-authorization.html') +
                _kpi(_kpiClass(wa.high_risk_overrides || 0, 1, 3), wa.high_risk_overrides || 0, 'Authorization: High Risk Overrides', '/practice/work-authorization.html');
        }

        // Codebox 73 — Profitability summary.
        var pf = d.profitability || {};
        var kpiPfEl = document.getElementById('kpiProfitability');
        if (kpiPfEl) {
            kpiPfEl.innerHTML =
                _kpi(_kpiClass(pf.low_margin_clients || 0, 1, 5), pf.low_margin_clients || 0, 'Profitability: Low Margin', '/practice/profitability.html') +
                _kpi(_kpiClass(pf.unprofitable_clients || 0, 1, 3), pf.unprofitable_clients || 0, 'Profitability: Unprofitable', '/practice/profitability.html') +
                _kpi(_kpiClass(pf.high_writeoffs || 0, 1, 5), pf.high_writeoffs || 0, 'Profitability: High Write-Offs', '/practice/profitability.html') +
                _kpi(_kpiClass(pf.low_realization || 0, 1, 5), pf.low_realization || 0, 'Profitability: Low Realization', '/practice/profitability.html');
        }

        // Codebox 74 — Pricing Review summary.
        var pr = d.pricing_review || {};
        var kpiPrEl = document.getElementById('kpiPricingReview');
        if (kpiPrEl) {
            kpiPrEl.innerHTML =
                _kpi('kpi-neutral', pr.total || 0, 'Pricing: Total Reviews', '/practice/pricing-review.html') +
                _kpi(_kpiClass(pr.partner_approvals_waiting || 0, 1, 3), pr.partner_approvals_waiting || 0, 'Pricing: Awaiting Partner', '/practice/pricing-review.html') +
                _kpi(_kpiClass(pr.commercial_discussions_pending || 0, 1, 5), pr.commercial_discussions_pending || 0, 'Pricing: Discussions Pending', '/practice/pricing-review.html') +
                _kpi(_kpiClass(pr.approved_not_implemented || 0, 1, 5), pr.approved_not_implemented || 0, 'Pricing: Approved, Not Implemented', '/practice/pricing-review.html');
        }

        // Codebox 75 — Partner Scorecards summary.
        var psc = d.partner_scorecards || {};
        var kpiPscEl = document.getElementById('kpiPartnerScorecards');
        if (kpiPscEl) {
            var lowest = psc.lowest_scoring_snapshot;
            kpiPscEl.innerHTML =
                _kpi('kpi-neutral', psc.practice_score != null ? psc.practice_score : '—', 'Practice Performance Score', '/practice/partner-scorecards.html') +
                _kpi('kpi-neutral', psc.total_snapshots || 0, 'Scorecard Snapshots', '/practice/partner-scorecards.html') +
                _kpi(lowest && lowest.overall_score < 60 ? 'kpi-bad' : 'kpi-neutral', lowest ? lowest.overall_score : '—', 'Lowest Score Needing Review', '/practice/partner-scorecards.html');
        }

        document.getElementById('kpiKnowledgeSop').innerHTML =
            _kpi('kpi-neutral', kb.draft || 0, 'Knowledge: Draft', '/practice/knowledge-base.html') +
            _kpi('kpi-neutral', kb.under_review || 0, 'Knowledge: Under Review', '/practice/knowledge-base.html') +
            _kpi('kpi-good', kb.approved || 0, 'Knowledge: Approved', '/practice/knowledge-base.html') +
            _kpi('kpi-neutral', sop.draft || 0, 'SOP: Draft', '/practice/practice-sop.html') +
            _kpi('kpi-neutral', sop.under_review || 0, 'SOP: Under Review', '/practice/practice-sop.html') +
            _kpi('kpi-good', sop.approved || 0, 'SOP: Approved', '/practice/practice-sop.html');

        document.getElementById('kpiOps').innerHTML =
            _kpi('kpi-neutral', b.draft_packs || 0, 'Billing: Draft Packs', '/practice/billing.html') +
            _kpi('kpi-neutral', b.locked_packs || 0, 'Billing: Locked Packs', '/practice/billing.html') +
            _kpi('kpi-neutral', (b.realisation_pct != null ? b.realisation_pct + '%' : '—'), 'Realisation Rate', '/practice/billing.html') +
            _kpi(_kpiClass(rem.overdue || 0, 1, 5), rem.overdue || 0, 'Reminders Overdue', '/practice/reminders.html') +
            _kpi('kpi-neutral', rem.upcoming || 0, 'Reminders Upcoming (7d)', '/practice/reminders.html') +
            _kpi(_kpiClass(doc.overdue || 0, 1, 5), doc.overdue || 0, 'Documents Overdue', '/practice/document-requests.html') +
            _kpi('kpi-neutral', doc.outstanding || 0, 'Documents Outstanding', '/practice/document-requests.html') +
            _kpi(_kpiClass(comm.unread_followups || 0, 1, 5), comm.unread_followups || 0, 'Comms Awaiting Reply', '/practice/communications.html') +
            _kpi('kpi-neutral', comp.open || 0, 'Compliance Open', '/practice/compliance.html') +
            _kpi(_kpiClass(comp.blocked || 0, 1, 3), comp.blocked || 0, 'Compliance Blocked', '/practice/compliance-packs.html');
    }

    // ── Alerts ────────────────────────────────────────────────────────────────

    var SEV_LABELS = {
        critical: 'Critical', high: 'High', overdue: 'Overdue', blocked: 'Blocked',
        needs_partner: 'Needs Partner', requires_approval: 'Requires Approval',
    };

    function _loadAlerts() {
        window.PracticeAPI.fetch(BASE + '/alerts')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderAlerts(d.alerts || []); })
            .catch(function () { document.getElementById('alertsList').innerHTML = '<div class="empty-note">Failed to load alerts</div>'; });
    }

    function _renderAlerts(items) {
        document.getElementById('alertsCount').textContent = items.length;
        if (!items.length) {
            document.getElementById('alertsList').innerHTML = '<div class="empty-note">No active alerts.</div>';
            return;
        }
        document.getElementById('alertsList').innerHTML = items.slice(0, 40).map(function (a) {
            return '<div class="list-item">' +
                '<span class="list-item-label"><span class="sev-pill sev-' + _html(a.severity) + '">' + _html(SEV_LABELS[a.severity] || a.severity) + '</span>' + _html(a.label) + '</span>' +
                (a.due ? '<span class="list-item-meta">Due ' + _html(a.due) + '</span>' : '') +
            '</div>';
        }).join('');
    }

    // ── Partner Queue ─────────────────────────────────────────────────────────

    function _loadPartnerQueue() {
        window.PracticeAPI.fetch(BASE + '/partner-review')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderPartnerQueue(d); })
            .catch(function () { document.getElementById('queueList').innerHTML = '<div class="empty-note">Failed to load partner queue</div>'; });
    }

    function _renderPartnerQueue(d) {
        document.getElementById('queueCount').textContent = d.total || 0;
        var groups = [
            { items: d.knowledge_approvals || [], label: 'Knowledge approval', field: 'title' },
            { items: d.sop_approvals       || [], label: 'SOP approval',       field: 'title' },
            { items: d.tax_completion      || [], label: 'Tax completion review', field: 'id' },
            { items: d.qms_reviews         || [], label: 'QMS review',         field: 'review_title' },
            { items: d.risk_acceptance     || [], label: 'Risk acceptance',    field: 'title' },
            { items: d.billing_approval    || [], label: 'Billing approval',   field: 'id' },
        ];
        var html = '';
        groups.forEach(function (g) {
            g.items.forEach(function (it) {
                var label = it[g.field] != null ? it[g.field] : ('#' + it.id);
                html += '<div class="list-item">' +
                    '<span class="list-item-label"><span class="feed-source">' + _html(g.label) + '</span>' + _html(label) + '</span>' +
                    '<span class="list-item-meta">' + (it.updated_at ? _fmt(it.updated_at) : '') + '</span>' +
                '</div>';
            });
        });
        document.getElementById('queueList').innerHTML = html || '<div class="empty-note">Nothing waiting for partner review.</div>';
    }

    // ── Executive Feed ────────────────────────────────────────────────────────

    function _loadFeed() {
        window.PracticeAPI.fetch(BASE + '/executive-feed?limit=40')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderFeed(d.feed || []); })
            .catch(function () { document.getElementById('feedList').innerHTML = '<div class="empty-note">Failed to load feed</div>'; });
    }

    function _renderFeed(items) {
        document.getElementById('feedCount').textContent = items.length;
        if (!items.length) {
            document.getElementById('feedList').innerHTML = '<div class="empty-note">No recent activity.</div>';
            return;
        }
        document.getElementById('feedList').innerHTML = items.map(function (e) {
            return '<div class="list-item">' +
                '<span class="list-item-label"><span class="feed-source">' + _html(e.source) + '</span>' + _html(e.description) + '</span>' +
                '<span class="list-item-meta">' + _fmt(e.at) + '</span>' +
            '</div>';
        }).join('');
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.mdRefreshAll = mdRefreshAll;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        mdRefreshAll();
    });

}());
