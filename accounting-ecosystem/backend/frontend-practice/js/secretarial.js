/* Codebox 62 — Practice Secretarial Foundation
 * "I know everything about this company's statutory position." NOT CIPC API. Manager-driven.
 * Prefix: sec
 */
(function () {
    'use strict';

    var BASE = '/api/practice/secretarial';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'profile';
    var _currentClientId = null;
    var _currentProfile = null;

    var COMPANY_STATUS_LABELS = { active: 'Active', dormant: 'Dormant', deregistration_process: 'Deregistration Process', deregistered: 'Deregistered', in_liquidation: 'In Liquidation', other: 'Other' };
    var DIRECTOR_ROLE_LABELS = { executive: 'Executive', non_executive: 'Non-Executive', alternate: 'Alternate' };
    var RETURN_STATUS_LABELS = { pending: 'Pending', submitted: 'Submitted', overdue: 'Overdue', exempted: 'Exempted' };
    var EV_LABELS = {
        profile_created: 'Profile Created', profile_updated: 'Profile Updated',
        director_appointed: 'Director Appointed', director_resigned: 'Director Resigned', director_updated: 'Director Updated',
        shareholder_added: 'Shareholder Added', shareholder_updated: 'Shareholder Updated', share_transferred: 'Share Transferred',
        annual_return_created: 'Annual Return Created', annual_return_submitted: 'Annual Return Submitted', annual_return_updated: 'Annual Return Updated',
        company_detail_changed: 'Company Detail Changed', manager_note: 'Manager Note',
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

    function secLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientPicker();
    }

    function _renderTabBar() {
        var tabs = [['profile', 'Corporate Profile'], ['directors', 'Directors'], ['shareholders', 'Shareholders'], ['returns', 'Annual Returns'], ['timeline', 'Timeline']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="secSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function secSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cs = d.company_status || {};
                var ar = d.annual_returns || {};
                var cards = [
                    { count: d.profiles_total || 0, label: 'Profiles' },
                    { count: cs.active || 0, label: 'Active Companies' },
                    { count: (cs.dormant || 0) + (cs.deregistration_process || 0) + (cs.in_liquidation || 0), label: 'Needs Attention' },
                    { count: d.active_directors || 0, label: 'Active Directors' },
                    { count: ar.overdue || 0, label: 'Returns Overdue' },
                    { count: ar.pending || 0, label: 'Returns Pending' },
                    { count: ar.submitted || 0, label: 'Returns Submitted' },
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
                // Deep link from Client Detail (?client_id=) — pre-select and load.
                var params = new URLSearchParams(window.location.search);
                var preselect = params.get('client_id');
                if (preselect && clients.some(function (c) { return String(c.id) === preselect; })) {
                    sel.value = preselect;
                    secOnClientChange();
                }
            })
            .catch(function () {});
    }

    function secOnClientChange() {
        var val = document.getElementById('clientPicker').value;
        if (!val) { document.getElementById('clientArea').style.display = 'none'; _currentClientId = null; return; }
        _currentClientId = parseInt(val);
        document.getElementById('clientArea').style.display = 'block';
        var link = document.getElementById('secChangesLink');
        if (link) link.href = '/practice/secretarial-workflows.html?client_id=' + _currentClientId;
        var govLink = document.getElementById('secGovernanceLink');
        if (govLink) govLink.href = '/practice/secretarial-governance.html?client_id=' + _currentClientId;
        var boLink = document.getElementById('secBoLink');
        if (boLink) boLink.href = '/practice/beneficial-ownership.html?client_id=' + _currentClientId;
        var calLink = document.getElementById('secCalendarLink');
        if (calLink) calLink.href = '/practice/secretarial-calendar.html?client_id=' + _currentClientId;
        var lifecycleLink = document.getElementById('secLifecycleLink');
        if (lifecycleLink) lifecycleLink.href = '/practice/entity-lifecycle.html?client_id=' + _currentClientId;
        var integrityLink = document.getElementById('secIntegrityLink');
        if (integrityLink) integrityLink.href = '/practice/secretarial-integrity.html?client_id=' + _currentClientId;
        var onboardingLink = document.getElementById('secOnboardingLink');
        if (onboardingLink) onboardingLink.href = '/practice/client-onboarding.html?client_id=' + _currentClientId;
        secLoadClientData();
        _loadRecentChanges();
        _loadRecentGovernance();
        _loadBoSummary();
        _loadStatutoryPanel();
        _loadLifecyclePanel();
        _loadIntegrityPanel();
        _loadOnboardingPanel();
    }

    function secLoadClientData() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _currentProfile = d;
                _renderReusedFields(d);
                _renderProfileForm(d.profile);
                _renderUpcomingActions(d.upcoming_statutory_actions || []);
                _renderDirectors(d.directors || []);
                _renderShareholders(d.shareholders || []);
                _renderReturns(d.annual_returns || []);
                _renderTimeline(d.timeline || []);
            })
            .catch(function () { _showToast('Failed to load secretarial data.'); });
    }

    // Codebox 63 — recent statutory change cases for this client, reused via
    // GET /secretarial-workflows (no duplicate case logic here).
    function _loadRecentChanges() {
        var el = document.getElementById('recentChanges');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/secretarial-workflows?client_id=' + _currentClientId + '&limit=5')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.cases || [];
                el.innerHTML = rows.length ? rows.map(function (c) {
                    return '<div class="mini-card">' + _html(c.change_title) + ' <span class="pill">' + _html(c.case_status) + '</span>' +
                        '<div class="mini-card-meta">' + _fmtDate(c.effective_date) + '</div></div>';
                }).join('') : '<div class="empty-state">None.</div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 64 — recent governance records for this client, reused via
    // GET /secretarial-governance/* (no duplicate governance logic here).
    function _loadRecentGovernance() {
        var el = document.getElementById('recentGovernance');
        if (!el) return;
        var GOV_BASE = '/api/practice/secretarial-governance';
        Promise.all([
            window.PracticeAPI.fetch(GOV_BASE + '/resolutions?client_id=' + _currentClientId + '&limit=3').then(function (r) { return r.json(); }).catch(function () { return { resolutions: [] }; }),
            window.PracticeAPI.fetch(GOV_BASE + '/meetings?client_id=' + _currentClientId + '&limit=3').then(function (r) { return r.json(); }).catch(function () { return { meetings: [] }; }),
            window.PracticeAPI.fetch(GOV_BASE + '/decisions?client_id=' + _currentClientId + '&limit=3').then(function (r) { return r.json(); }).catch(function () { return { decisions: [] }; }),
        ]).then(function (results) {
            var items = [];
            (results[0].resolutions || []).forEach(function (r) { items.push(r.resolution_title + ' (' + r.resolution_status + ')'); });
            (results[1].meetings || []).forEach(function (m) { items.push(m.meeting_title + ' (' + m.meeting_status + ')'); });
            (results[2].decisions || []).forEach(function (d) { items.push(d.decision_title + ' (' + d.decision_status + ')'); });
            el.innerHTML = items.length ? items.map(function (t) { return '<div class="mini-card">' + _html(t) + '</div>'; }).join('') : '<div class="empty-state">None.</div>';
        }).catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 65 — BO readiness/reportable/missing-info summary for this
    // client, reused via GET /beneficial-ownership/client/:clientId (no
    // duplicate BO logic here).
    function _loadBoSummary() {
        var el = document.getElementById('boSummaryPanel');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/beneficial-ownership/client/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { el.innerHTML = '<div class="empty-state">' + _html(d.error) + '</div>'; return; }
                var readiness = d.readiness || {};
                el.innerHTML = '<div class="mini-card">Readiness: <strong>' + _html(readiness.status || 'unknown') + '</strong> (' + (readiness.score || 0) + '%)' +
                    '<div class="mini-card-meta">Reportable owners: ' + (d.reportable_owners || []).length + ' &middot; Missing information: ' + (d.missing_information_count || 0) + '</div></div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 67 — upcoming statutory obligations + compliance readiness for
    // this client, reused via GET /secretarial-calendar/calendar?client_id=
    // (no duplicate scheduler logic here).
    function _loadStatutoryPanel() {
        var el = document.getElementById('statutoryPanel');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/secretarial-calendar/calendar?client_id=' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var counts = d.counts || {};
                var upcoming = (d.buckets && d.buckets.upcoming) || [];
                var overdue = (d.buckets && d.buckets.overdue) || [];
                var blocked = (d.buckets && d.buckets.blocked) || [];
                var html = '<div class="mini-card">Overdue: <strong>' + (counts.overdue || 0) + '</strong> &middot; Due Today: <strong>' + (counts.due_today || 0) +
                    '</strong> &middot; Upcoming: <strong>' + (counts.upcoming || 0) + '</strong> &middot; Blocked: <strong>' + (counts.blocked || 0) + '</strong></div>';
                var listed = overdue.concat(upcoming).slice(0, 5);
                if (listed.length) {
                    html += listed.map(function (i) { return '<div class="mini-card">' + _html(i.period_label) + ' — ' + _fmtDate(i.due_date) + '</div>'; }).join('');
                }
                if (blocked.length) {
                    html += '<div class="mini-card" style="border-left:3px solid #fc8181;">' + blocked.length + ' item(s) blocked on a dependency</div>';
                }
                el.innerHTML = html;
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 68 — lifecycle status/risk summary for this client, reused via
    // GET /entity-lifecycle/client/:clientId (no duplicate lifecycle logic
    // here — that engine composes calendar/BO/evidence itself already).
    function _loadLifecyclePanel() {
        var el = document.getElementById('lifecyclePanel');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/entity-lifecycle/client/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { el.innerHTML = '<div class="empty-state">' + _html(d.error) + '</div>'; return; }
                var flags = d.risk_flags || [];
                var html = '<div class="mini-card">Status: <strong>' + _html(d.current_status) + '</strong>' +
                    (d.active_transitions && d.active_transitions.length ? ' &middot; ' + d.active_transitions.length + ' transition(s) in progress' : '') + '</div>';
                if (flags.length) html += '<div class="mini-card" style="border-left:3px solid #fc8181;">' + flags.length + ' risk flag(s): ' + _html(flags[0]) + (flags.length > 1 ? ' (+' + (flags.length - 1) + ' more)' : '') + '</div>';
                el.innerHTML = html;
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 69 — open findings for this client, reused via GET
    // /secretarial-integrity/findings?client_id=&status=open (no duplicate
    // validation/scoring logic here).
    function _loadIntegrityPanel() {
        var el = document.getElementById('integrityPanel');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/secretarial-integrity/findings?client_id=' + _currentClientId + '&status=open')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var findings = d.findings || [];
                if (!findings.length) { el.innerHTML = '<div class="mini-card">No open findings for this client.</div>'; return; }
                var critHigh = findings.filter(function (f) { return f.severity === 'critical' || f.severity === 'high'; }).length;
                var html = '<div class="mini-card">' + findings.length + ' open finding(s)' + (critHigh ? ', ' + critHigh + ' critical/high' : '') + '</div>';
                html += findings.slice(0, 5).map(function (f) {
                    return '<div class="mini-card" style="' + (f.severity === 'critical' || f.severity === 'high' ? 'border-left:3px solid #fc8181;' : '') + '">' + _html(f.title) + ' <span class="pill">' + _html(f.severity) + '</span></div>';
                }).join('');
                el.innerHTML = html;
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 70 — onboarding status for this client, reused via GET
    // /client-onboarding/profiles/:clientId (no duplicate onboarding logic
    // here).
    function _loadOnboardingPanel() {
        var el = document.getElementById('onboardingPanel');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/client-onboarding/profiles/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { el.innerHTML = '<div class="empty-state">' + _html(d.error) + '</div>'; return; }
                if (!d.profile) { el.innerHTML = '<div class="empty-state">Not yet onboarded — <a href="/practice/client-onboarding.html?client_id=' + _currentClientId + '">start onboarding</a>.</div>'; return; }
                el.innerHTML = '<div class="mini-card">Status: <strong>' + _html(d.profile.onboarding_status) + '</strong> &middot; Completion: ' + (d.profile.completion_percentage || 0) + '%</div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    function _renderReusedFields(d) {
        var fields = [
            ['Registration Number', d.client.registration_number],
            ['VAT Number', d.client.vat_number],
            ['COIDA Number', d.client.coida_registration_number],
            ['Income Tax Number', d.income_tax_reference],
            ['Financial Year-End', d.financial_year_end ? _fmtDate(d.financial_year_end) : null],
        ];
        document.getElementById('reusedFields').innerHTML = fields.map(function (f) {
            return '<div class="readonly-field"><div class="rf-label">' + _html(f[0]) + '</div><div class="rf-value">' + _html(f[1] || '—') + '</div></div>';
        }).join('') + '<div class="readonly-field"><div class="rf-label">Source</div><div class="rf-value" style="font-size:.72rem;color:#718096;">Reused live from Client / Taxpayer Profile — not editable here.</div></div>';
    }

    function _renderProfileForm(p) {
        p = p || {};
        document.getElementById('pfCompanyType').value = p.company_type || '';
        document.getElementById('pfRegDate').value = p.registration_date || '';
        document.getElementById('pfCompanyStatus').value = p.company_status || 'active';
        document.getElementById('pfCipcStatus').value = p.cipc_status || '';
        document.getElementById('pfRegAddress').value = p.registered_address || '';
        document.getElementById('pfPostalAddress').value = p.postal_address || '';
        document.getElementById('pfPaye').value = p.paye_number || '';
        document.getElementById('pfSdl').value = p.sdl_number || '';
        document.getElementById('pfUif').value = p.uif_number || '';
        document.getElementById('pfAuditor').value = p.auditor || '';
        document.getElementById('pfSecretary').value = p.company_secretary || '';
        document.getElementById('pfFinOfficer').value = p.financial_officer || '';
        document.getElementById('pfNotes').value = p.notes || '';
    }

    function secSaveProfile() {
        var payload = {
            company_type: document.getElementById('pfCompanyType').value || null,
            registration_date: document.getElementById('pfRegDate').value || null,
            company_status: document.getElementById('pfCompanyStatus').value,
            cipc_status: document.getElementById('pfCipcStatus').value || null,
            registered_address: document.getElementById('pfRegAddress').value || null,
            postal_address: document.getElementById('pfPostalAddress').value || null,
            paye_number: document.getElementById('pfPaye').value || null,
            sdl_number: document.getElementById('pfSdl').value || null,
            uif_number: document.getElementById('pfUif').value || null,
            auditor: document.getElementById('pfAuditor').value || null,
            company_secretary: document.getElementById('pfSecretary').value || null,
            financial_officer: document.getElementById('pfFinOfficer').value || null,
            notes: document.getElementById('pfNotes').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Profile saved.'); _loadSummary(); })
            .catch(function () { _showToast('Failed to save profile.'); });
    }

    function _renderUpcomingActions(actions) {
        document.getElementById('upcomingActions').innerHTML = actions.length ? actions.map(function (a) {
            return '<div class="mini-card" style="' + (a.overdue ? 'border-left:3px solid #fc8181;' : 'border-left:3px solid #f6ad55;') + '">' + _html(a.label) + '</div>';
        }).join('') : '<div class="empty-state">None.</div>';
    }

    // ── Directors ─────────────────────────────────────────────────────────────

    function _renderDirectors(rows) {
        if (!rows.length) { document.getElementById('directorsBody').innerHTML = '<tr><td colspan="8" class="empty-state">No directors on record.</td></tr>'; return; }
        document.getElementById('directorsBody').innerHTML = rows.map(function (d) {
            var resignBtn = d.status === 'active' ? '<button class="btn-action btn-secondary" onclick="secResignDirector(' + d.id + ')">Resign</button>' : '';
            return '<tr><td>' + _html(d.director_name) + '</td><td>' + _html(DIRECTOR_ROLE_LABELS[d.role] || d.role) + '</td>' +
                '<td><span class="pill ds-' + _html(d.status) + '">' + _html(d.status) + '</span></td>' +
                '<td>' + _fmtDate(d.appointment_date) + '</td><td>' + _fmtDate(d.resignation_date) + '</td>' +
                '<td>' + (d.shareholding_pct != null ? d.shareholding_pct + '%' : '—') + '</td><td>' + (d.signing_authority ? 'Yes' : 'No') + '</td>' +
                '<td>' + resignBtn + '</td></tr>';
        }).join('');
    }

    function secOpenDirector() { document.getElementById('directorModal').classList.add('open'); }
    function secCloseDirector() { document.getElementById('directorModal').classList.remove('open'); }
    function secSubmitDirector() {
        var payload = {
            director_name: document.getElementById('dfName').value,
            id_or_passport_number: document.getElementById('dfIdNumber').value || null,
            role: document.getElementById('dfRole').value,
            appointment_date: document.getElementById('dfAppointed').value || null,
            shareholding_pct: document.getElementById('dfShareholding').value || null,
            signing_authority: document.getElementById('dfSigning').checked,
            notes: document.getElementById('dfNotes').value || null,
        };
        if (!payload.director_name) { _showToast('Director name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/directors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Director added.'); secCloseDirector(); secLoadClientData(); })
            .catch(function () { _showToast('Failed to add director.'); });
    }
    function secResignDirector(id) {
        window.PracticeAPI.fetch(BASE + '/directors/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resigned' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Director marked resigned.'); secLoadClientData(); })
            .catch(function () { _showToast('Failed to update director.'); });
    }

    // ── Shareholders ──────────────────────────────────────────────────────────

    function _renderShareholders(rows) {
        if (!rows.length) { document.getElementById('shareholdersBody').innerHTML = '<tr><td colspan="8" class="empty-state">No shareholders on record.</td></tr>'; return; }
        document.getElementById('shareholdersBody').innerHTML = rows.map(function (s) {
            var transferBtn = s.status === 'active' ? '<button class="btn-action btn-secondary" onclick="secTransferShareholder(' + s.id + ')">Mark Transferred</button>' : '';
            return '<tr><td>' + _html(s.shareholder_name) + '</td><td>' + _html(s.shareholder_type) + '</td>' +
                '<td>' + (s.shares != null ? s.shares : '—') + '</td><td>' + (s.percentage != null ? s.percentage + '%' : '—') + '</td>' +
                '<td><span class="pill ds-' + _html(s.status === 'active' ? 'active' : 'resigned') + '">' + _html(s.status) + '</span></td>' +
                '<td>' + _fmtDate(s.issue_date) + '</td><td>' + _fmtDate(s.transfer_date) + '</td><td>' + transferBtn + '</td></tr>';
        }).join('');
    }

    function secOpenShareholder() { document.getElementById('shareholderModal').classList.add('open'); }
    function secCloseShareholder() { document.getElementById('shareholderModal').classList.remove('open'); }
    function secSubmitShareholder() {
        var payload = {
            shareholder_name: document.getElementById('sfName').value,
            shareholder_type: document.getElementById('sfType').value,
            shares: document.getElementById('sfShares').value || null,
            percentage: document.getElementById('sfPercentage').value || null,
            issue_date: document.getElementById('sfIssueDate').value || null,
            notes: document.getElementById('sfNotes').value || null,
        };
        if (!payload.shareholder_name) { _showToast('Shareholder name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/shareholders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Shareholder added.'); secCloseShareholder(); secLoadClientData(); })
            .catch(function () { _showToast('Failed to add shareholder.'); });
    }
    function secTransferShareholder(id) {
        window.PracticeAPI.fetch(BASE + '/shareholders/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'transferred' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Shareholder marked transferred.'); secLoadClientData(); })
            .catch(function () { _showToast('Failed to update shareholder.'); });
    }

    // ── Annual Returns ────────────────────────────────────────────────────────

    function _renderReturns(rows) {
        if (!rows.length) { document.getElementById('returnsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No annual returns on record.</td></tr>'; return; }
        document.getElementById('returnsBody').innerHTML = rows.map(function (r) {
            var submitBtn = r.status !== 'submitted' ? '<button class="btn-action btn-secondary" onclick="secSubmitReturnAction(' + r.id + ')">Mark Submitted</button>' : '';
            return '<tr><td>' + _html(r.return_year) + '</td><td>' + _fmtDate(r.due_date) + '</td>' +
                '<td><span class="pill rs-' + _html(r.status) + '">' + _html(RETURN_STATUS_LABELS[r.status] || r.status) + '</span></td>' +
                '<td>' + _fmtDate(r.submission_date) + '</td><td>' + _html(r.reference || '—') + '</td><td>' + submitBtn + '</td></tr>';
        }).join('');
    }

    function secOpenReturn() { document.getElementById('returnModal').classList.add('open'); }
    function secCloseReturn() { document.getElementById('returnModal').classList.remove('open'); }
    function secSubmitReturn() {
        var payload = {
            return_year: document.getElementById('rfYear').value,
            due_date: document.getElementById('rfDueDate').value || null,
            reference: document.getElementById('rfReference').value || null,
            reminder_date: document.getElementById('rfReminderDate').value || null,
            notes: document.getElementById('rfNotes').value || null,
        };
        if (!payload.return_year) { _showToast('Year is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/annual-returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Annual return added.'); secCloseReturn(); secLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to add annual return.'); });
    }
    function secSubmitReturnAction(id) {
        window.PracticeAPI.fetch(BASE + '/annual-returns/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'submitted' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Annual return marked submitted.'); secLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to update annual return.'); });
    }

    // ── Timeline ──────────────────────────────────────────────────────────────

    function _renderTimeline(rows) {
        document.getElementById('timelineBody').innerHTML = rows.length ? rows.map(function (e) {
            return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) +
                '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
        }).join('') : '<div class="empty-state">No events yet.</div>';
    }

    function secOpenNote() { document.getElementById('noteModal').classList.add('open'); }
    function secCloseNote() { document.getElementById('noteModal').classList.remove('open'); }
    function secSubmitNote() {
        var notes = document.getElementById('nfNote').value;
        if (!notes) { _showToast('Note is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentClientId + '/timeline/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: notes }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Note added.'); secCloseNote(); document.getElementById('nfNote').value = ''; secLoadClientData(); })
            .catch(function () { _showToast('Failed to add note.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.secSetTab = secSetTab;
    window.secOnClientChange = secOnClientChange;
    window.secSaveProfile = secSaveProfile;
    window.secOpenDirector = secOpenDirector;
    window.secCloseDirector = secCloseDirector;
    window.secSubmitDirector = secSubmitDirector;
    window.secResignDirector = secResignDirector;
    window.secOpenShareholder = secOpenShareholder;
    window.secCloseShareholder = secCloseShareholder;
    window.secSubmitShareholder = secSubmitShareholder;
    window.secTransferShareholder = secTransferShareholder;
    window.secOpenReturn = secOpenReturn;
    window.secCloseReturn = secCloseReturn;
    window.secSubmitReturn = secSubmitReturn;
    window.secSubmitReturnAction = secSubmitReturnAction;
    window.secOpenNote = secOpenNote;
    window.secCloseNote = secCloseNote;
    window.secSubmitNote = secSubmitNote;

    document.addEventListener('DOMContentLoaded', secLoadAll);
})();
