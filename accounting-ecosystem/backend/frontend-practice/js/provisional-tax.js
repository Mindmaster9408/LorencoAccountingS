/* ============================================================
   Lorenco Practice — Provisional Tax Planning (Codebox 26)
   NOT tax calculation. NOT SARS submission. NOT eFiling.
   Planning and readiness tracking only.
   All business data is server-authoritative. No localStorage.
   ============================================================ */
(function () {
    'use strict';

    var _BASE = '/api/practice/provisional-tax';

    /* ── State ─────────────────────────────────────────────── */
    var _clients     = [];
    var _activePlan  = null;
    var _activePeriods = [];

    /* ── Label maps ───────────────────────────────────────── */
    var _statusLabels = {
        draft:            'Draft',
        collecting_info:  'Collecting Info',
        ready_for_review: 'Ready for Review',
        reviewed:         'Reviewed',
        submitted:        'Submitted',
        completed:        'Completed',
        cancelled:        'Cancelled',
    };
    var _periodLabels = {
        period_1: 'Period 1 (IRP6 P1)',
        period_2: 'Period 2 (IRP6 P2)',
        topup:    'Top-up (Section 89bis)',
    };
    var _periodStatusLabels = {
        not_started:    'Not Started',
        collecting_info:'Collecting Info',
        ready:          'Ready',
        reviewed:       'Reviewed',
        submitted:      'Submitted',
        paid:           'Paid',
        waived:         'Waived',
        cancelled:      'Cancelled',
    };
    var _eventLabels = {
        provisional_tax_plan_created:    'Plan created',
        provisional_tax_plan_updated:    'Plan updated',
        provisional_tax_period_created:  'Period created',
        provisional_tax_period_updated:  'Period updated',
        provisional_tax_status_changed:  'Status changed',
        provisional_tax_reviewed:        'Plan reviewed',
        provisional_tax_periods_created: 'Periods created',
    };

    /* ── Init ──────────────────────────────────────────────── */
    async function init() {
        LAYOUT.init('provisional-tax');
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var authRes = await PracticeAPI.fetch('/api/auth/me');
            if (!authRes.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        var params    = new URLSearchParams(window.location.search);
        var urlClient = params.get('client_id');

        await loadClients();
        populateYearFilter();
        if (urlClient) {
            var el = document.getElementById('ptFilterClient');
            if (el) el.value = urlClient;
        }
        loadSummary();
        loadPlans();
    }

    /* ── Toast / error helpers ─────────────────────────────── */
    function showToast(msg) { PracticeAPI.showToast(msg); }

    function showError(elId, msg) {
        var el = document.getElementById(elId);
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
    }
    function clearError(elId) {
        var el = document.getElementById(elId);
        if (!el) return;
        el.textContent = '';
        el.classList.add('hidden');
    }

    /* ── Load clients ──────────────────────────────────────── */
    async function loadClients() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients?active=true&limit=500');
            if (!res.ok) return;
            var d = await res.json();
            _clients = (d.clients || []).map(function (c) {
                return { id: c.id, name: c.display_name || c.company_name || 'Unnamed' };
            });
            populateClientSelects();
        } catch(e) { _clients = []; }
    }

    function populateClientSelects() {
        var filterOpts = '<option value="">All Clients</option>' +
            _clients.map(function (c) {
                return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
            }).join('');
        var filterEl = document.getElementById('ptFilterClient');
        if (filterEl) filterEl.innerHTML = filterOpts;

        var createOpts = '<option value="">Select client…</option>' +
            _clients.map(function (c) {
                return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
            }).join('');
        var createEl = document.getElementById('ptCClient');
        if (createEl) createEl.innerHTML = createOpts;
    }

    function populateYearFilter() {
        var currentYear = new Date().getFullYear();
        var opts = '<option value="">All Tax Years</option>';
        for (var y = currentYear + 1; y >= currentYear - 5; y--) {
            opts += '<option value="' + y + '">' + y + '</option>';
        }
        var el = document.getElementById('ptFilterYear');
        if (el) el.innerHTML = opts;
    }

    /* ── Load taxpayer profiles for a client (create modal) ── */
    async function ptLoadProfilesForClient() {
        var clientId = val('ptCClient');
        var sel      = document.getElementById('ptCProfile');
        if (!sel) return;
        if (!clientId) { sel.innerHTML = '<option value="">Select client first…</option>'; return; }

        sel.innerHTML = '<option value="">Loading…</option>';
        try {
            var res = await PracticeAPI.fetch('/api/practice/taxpayer-profiles?client_id=' + clientId + '&limit=20');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            var profiles = (d.taxpayer_profiles || []).filter(function (p) { return p.tax_status !== 'ceased'; });
            if (!profiles.length) {
                sel.innerHTML = '<option value="">No active taxpayer profiles found</option>';
                ptAutoName();
                return;
            }
            sel.innerHTML = '<option value="">Select profile…</option>' + profiles.map(function (p) {
                var label = (p.taxpayer_type ? p.taxpayer_type.charAt(0).toUpperCase() + p.taxpayer_type.slice(1) : '') +
                    (p.income_tax_reference ? ' · ' + p.income_tax_reference : '');
                return '<option value="' + p.id + '" data-type="' + esc(p.taxpayer_type || '') + '">' + esc(label) + '</option>';
            }).join('');
        } catch(e) {
            sel.innerHTML = '<option value="">Error loading profiles</option>';
        }
        ptAutoName();
    }

    /* ── Auto-name the plan ────────────────────────────────── */
    function ptAutoName() {
        var clientId = val('ptCClient');
        var year     = val('ptCYear');
        if (!clientId || !year) return;

        var profileSel = document.getElementById('ptCProfile');
        var selected   = profileSel && profileSel.options[profileSel.selectedIndex];
        var type       = selected ? (selected.dataset.type || '') : '';

        var clientEl   = document.getElementById('ptCClient');
        var clientName = clientEl && clientEl.options[clientEl.selectedIndex] ? clientEl.options[clientEl.selectedIndex].text : '';

        var typeLabel = type ? (type.charAt(0).toUpperCase() + type.slice(1) + ' ') : '';
        var nameEl    = document.getElementById('ptCName');
        if (nameEl && !nameEl._manuallyEdited) {
            nameEl.value = typeLabel + 'IRP6 ' + year;
        }
    }

    /* ── Summary cards ─────────────────────────────────────── */
    async function loadSummary() {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/summary');
            if (!res.ok) return;
            var data = await res.json();
            var s = data.summary || {};
            var bs = s.by_status || {};
            setText('sumPtTotal',    s.total   || 0);
            setText('sumPtDraft',    (bs.draft || 0) + (bs.collecting_info || 0));
            setText('sumPtReview',   bs.ready_for_review || 0);
            setText('sumPtReviewed', (bs.reviewed || 0) + (bs.submitted || 0) + (bs.completed || 0));
            setText('sumPtP1',       s.upcoming_p1 || 0);
            setText('sumPtP2',       s.upcoming_p2 || 0);
        } catch(e) {}
    }

    /* ── Plan list ─────────────────────────────────────────── */
    async function loadPlans() {
        var clientId = val('ptFilterClient');
        var year     = val('ptFilterYear');
        var status   = val('ptFilterStatus');

        show('ptListLoading'); hide('ptListWrap'); hide('ptListEmpty'); hide('ptListError');

        var qs = [];
        if (clientId) qs.push('client_id=' + encodeURIComponent(clientId));
        if (year)     qs.push('tax_year='  + encodeURIComponent(year));
        if (status)   qs.push('status='    + encodeURIComponent(status));
        var url = _BASE + (qs.length ? '?' + qs.join('&') : '');

        try {
            var res = await PracticeAPI.fetch(url);
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            hide('ptListLoading');
            renderPlanList(data.provisional_tax_plans || []);
        } catch(e) {
            hide('ptListLoading');
            showError('ptListError', 'Failed to load plans: ' + (e.message || ''));
            show('ptListError');
        }
    }

    function renderPlanList(plans) {
        if (!plans.length) { show('ptListEmpty'); return; }
        var tbody = document.getElementById('ptListBody');
        if (!tbody) return;
        var today = new Date().toISOString().slice(0, 10);
        tbody.innerHTML = plans.map(function (p) {
            var statusCls = 'pt-s-' + p.status;
            var p1Label   = p.period_1_due_date ? dueBadge(p.period_1_due_date, today) : '—';
            var p2Label   = p.period_2_due_date ? dueBadge(p.period_2_due_date, today) : '—';
            var clientName = p.client_name || 'Unknown Client';
            return '<tr>' +
                '<td class="col-year">' + p.tax_year + '</td>' +
                '<td><div style="font-weight:600;">' + esc(p.plan_name) + '</div>' +
                    '<div style="font-size:0.75rem;color:var(--text-muted);">' + esc(clientName) + '</div></td>' +
                '<td class="col-status"><span class="pt-status-badge ' + statusCls + '">' + esc(_statusLabels[p.status] || p.status) + '</span></td>' +
                '<td class="col-due">' + p1Label + '</td>' +
                '<td class="col-due">' + p2Label + '</td>' +
                '<td class="col-actions"><button type="button" class="btn btn-ghost btn-xs" onclick="openDetailModal(' + p.id + ')">View</button></td>' +
                '</tr>';
        }).join('');
        show('ptListWrap');
    }

    function dueBadge(dateStr, today) {
        var diff = Math.round((new Date(dateStr) - new Date(today)) / 86400000);
        var cls  = diff < 0 ? 'overdue' : diff <= 30 ? 'soon' : '';
        var label = diff < 0 ? dateStr + ' (overdue)' : diff === 0 ? dateStr + ' (today)' : dateStr;
        return '<span class="pt-due-badge ' + cls + '">' + label + '</span>';
    }

    /* ── Create Plan Modal ─────────────────────────────────── */
    function openCreatePlanModal() {
        clearError('ptCreateError');
        setVal('ptCClient',      '');
        setVal('ptCProfile',     '');
        setVal('ptCYear',        '');
        setVal('ptCName',        '');
        setVal('ptCPriorIncome', '');
        setVal('ptCCurrIncome',  '');
        setVal('ptCP1Due',       '');
        setVal('ptCP2Due',       '');
        setVal('ptCNotes',       '');
        var nameEl = document.getElementById('ptCName');
        if (nameEl) nameEl._manuallyEdited = false;
        var profSel = document.getElementById('ptCProfile');
        if (profSel) profSel.innerHTML = '<option value="">Select client first…</option>';
        document.getElementById('ptCreateModal').classList.remove('hidden');
    }
    function closeCreatePlanModal() {
        document.getElementById('ptCreateModal').classList.add('hidden');
    }

    async function submitCreatePlan() {
        clearError('ptCreateError');
        var clientId  = val('ptCClient');
        var profileId = val('ptCProfile');
        var year      = val('ptCYear');
        var name      = val('ptCName').trim();
        if (!clientId)  { showError('ptCreateError', 'Please select a client.'); return; }
        if (!profileId) { showError('ptCreateError', 'Please select a taxpayer profile.'); return; }
        if (!year)      { showError('ptCreateError', 'Tax year is required.'); return; }
        if (!name)      { showError('ptCreateError', 'Plan name is required.'); return; }

        var body = {
            client_id:                       parseInt(clientId),
            taxpayer_profile_id:             parseInt(profileId),
            tax_year:                        parseInt(year),
            plan_name:                       name,
            prior_year_taxable_income:       val('ptCPriorIncome') ? parseFloat(val('ptCPriorIncome')) : null,
            current_estimated_taxable_income: val('ptCCurrIncome') ? parseFloat(val('ptCCurrIncome')) : null,
            period_1_due_date:               val('ptCP1Due') || null,
            period_2_due_date:               val('ptCP2Due') || null,
            notes:                           val('ptCNotes') || null,
        };

        setDisabled('ptCreateSubmitBtn', true);
        try {
            var res = await PracticeAPI.fetch(_BASE, { method: 'POST', body: JSON.stringify(body) });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            setDisabled('ptCreateSubmitBtn', false);
            closeCreatePlanModal();
            showToast('Provisional tax plan created.');
            loadSummary();
            loadPlans();
        } catch(e) {
            setDisabled('ptCreateSubmitBtn', false);
            showError('ptCreateError', e.message || 'Failed to create plan.');
        }
    }

    /* ── Detail Modal ──────────────────────────────────────── */
    async function openDetailModal(planId) {
        _activePlan    = null;
        _activePeriods = [];
        // Reset to overview tab
        ['Overview','Periods','Events'].forEach(function (t, i) {
            var el = document.getElementById('ptTab' + t);
            if (el) el.classList.toggle('active', i === 0);
        });
        document.querySelectorAll('.pt-tab').forEach(function (el, i) {
            el.classList.toggle('active', i === 0);
        });
        document.getElementById('ptDetailModal').classList.remove('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + planId);
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            _activePlan    = data.plan;
            _activePeriods = data.periods || [];
            renderDetailHeader(_activePlan);
            renderOverviewTab(_activePlan);
            renderPeriodsTab(_activePeriods);
        } catch(e) {
            document.getElementById('ptDetailTitle').textContent = 'Error loading plan';
        }
    }
    function closePtDetailModal() {
        document.getElementById('ptDetailModal').classList.add('hidden');
        _activePlan    = null;
        _activePeriods = [];
    }

    function renderDetailHeader(p) {
        var clientName = p.client_name || 'Unknown Client';
        document.getElementById('ptDetailTitle').textContent = p.plan_name + ' — ' + p.tax_year;
        document.getElementById('ptDClientName').textContent = clientName;
        document.getElementById('ptDSub').textContent = [
            'Tax Year: ' + p.tax_year,
            p.taxpayer_type ? p.taxpayer_type.charAt(0).toUpperCase() + p.taxpayer_type.slice(1) : null,
        ].filter(Boolean).join('  ·  ');
        document.getElementById('ptDStatusBadge').innerHTML =
            '<span class="pt-status-badge pt-s-' + p.status + '">' + esc(_statusLabels[p.status] || p.status) + '</span>';
    }

    function renderOverviewTab(p) {
        clearError('ptOverviewError');
        var grid = document.getElementById('ptDOverviewGrid');
        if (!grid) return;

        var fmtAmount = function(v) { return v != null ? 'R ' + parseFloat(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 }) : '—'; };

        var rows = [
            ['Tax Year',             p.tax_year],
            ['Status',               _statusLabels[p.status] || p.status],
            ['Prior Year Income',    fmtAmount(p.prior_year_taxable_income)],
            ['Current Estimate',     fmtAmount(p.current_estimated_taxable_income)],
            ['P1 Due Date',          p.period_1_due_date || '—'],
            ['P2 Due Date',          p.period_2_due_date || '—'],
            ['Top-up Due Date',      p.topup_due_date    || '—'],
            ['Reviewed At',          p.reviewed_at ? p.reviewed_at.slice(0, 10) : '—'],
        ];

        grid.innerHTML = rows.map(function (r) {
            return '<div class="pt-overview-field"><label>' + esc(r[0]) + '</label><span>' + esc(String(r[1])) + '</span></div>';
        }).join('');

        setVal('ptDEstimateBasis', p.estimate_basis || '');
        setVal('ptDRiskNotes',     p.risk_notes     || '');

        var statusSel = document.getElementById('ptDStatusSel');
        if (statusSel) statusSel.value = p.status || 'draft';
    }

    /* ── Overview edits ────────────────────────────────────── */
    async function ptSaveOverviewEdits() {
        if (!_activePlan) return;
        clearError('ptOverviewError');
        var body = {
            estimate_basis: val('ptDEstimateBasis') || null,
            risk_notes:     val('ptDRiskNotes')     || null,
        };
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id, { method: 'PUT', body: JSON.stringify(body) });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var data = await res.json();
            _activePlan = data.plan;
            showToast('Changes saved.');
        } catch(e) {
            showError('ptOverviewError', e.message || 'Save failed.');
        }
    }

    async function ptUpdateStatus() {
        if (!_activePlan) return;
        var newStatus = val('ptDStatusSel');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var data = await res.json();
            _activePlan = data.plan;
            renderDetailHeader(_activePlan);
            showToast('Status updated.');
            loadSummary();
            loadPlans();
        } catch(e) {
            showToast('Error: ' + (e.message || 'Update failed.'));
        }
    }

    async function ptMarkReviewed() {
        if (!_activePlan) return;
        if (!['ready_for_review', 'reviewed'].includes(_activePlan.status)) {
            showError('ptOverviewError', 'Set status to "Ready for Review" first.');
            return;
        }
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id + '/review', { method: 'POST' });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var data = await res.json();
            _activePlan = data.plan;
            renderDetailHeader(_activePlan);
            renderOverviewTab(_activePlan);
            showToast('Plan marked as reviewed.');
            loadSummary();
            loadPlans();
        } catch(e) {
            showError('ptOverviewError', e.message || 'Review failed.');
        }
    }

    async function ptCreatePeriods() {
        if (!_activePlan) return;
        clearError('ptOverviewError');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id + '/create-periods', { method: 'POST' });
            if (res.status === 409) {
                showToast('All periods already exist for this plan.');
                return;
            }
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var data = await res.json();
            _activePeriods = data.periods || [];
            renderPeriodsTab(_activePeriods);
            // Switch to periods tab
            ptSwitchTab('periods', null);
            document.querySelectorAll('.pt-tab').forEach(function (el, i) {
                el.classList.toggle('active', i === 1);
            });
            showToast('Periods created.');
        } catch(e) {
            showError('ptOverviewError', e.message || 'Create periods failed.');
        }
    }

    /* ── Periods tab ───────────────────────────────────────── */
    function renderPeriodsTab(periods) {
        var wrap  = document.getElementById('ptDPeriodsWrap');
        var empty = document.getElementById('ptDPeriodsEmpty');
        if (!wrap) return;
        if (!periods.length) { show('ptDPeriodsEmpty'); wrap.innerHTML = ''; return; }
        hide('ptDPeriodsEmpty');
        wrap.innerHTML = periods.map(function (period) {
            return renderPeriodRow(period);
        }).join('');
    }

    function renderPeriodRow(period) {
        var periodLabel = _periodLabels[period.period_type] || period.period_type;
        var statusCls   = 'pt-s-' + period.status;
        var fmtAmt = function(v) {
            if (v == null || v === '') return '';
            return parseFloat(v).toFixed(2);
        };
        var statusOpts = ['not_started','collecting_info','ready','reviewed','submitted','paid','waived','cancelled']
            .map(function (s) {
                return '<option value="' + s + '"' + (s === period.status ? ' selected' : '') + '>' + (_periodStatusLabels[s] || s) + '</option>';
            }).join('');

        return '<div class="pt-period-row" id="ptPeriod-' + period.id + '">' +
            '<div class="pt-period-header">' +
                '<span class="pt-period-title">' + esc(periodLabel) + '</span>' +
                '<span class="pt-status-badge ' + statusCls + '" id="ptPeriodStatusBadge-' + period.id + '">' + esc(_periodStatusLabels[period.status] || period.status) + '</span>' +
            '</div>' +
            '<div class="pt-period-grid">' +
                '<div class="pt-period-field"><label>Due Date</label>' +
                    '<input type="date" id="ptPDue-' + period.id + '" value="' + esc(period.due_date || '') + '"></div>' +
                '<div class="pt-period-field"><label>Estimated Taxable Income</label>' +
                    '<input type="number" id="ptPEstIncome-' + period.id + '" min="0" step="0.01" placeholder="0.00" value="' + fmtAmt(period.estimated_taxable_income) + '"></div>' +
                '<div class="pt-period-field"><label>Estimated Tax Due</label>' +
                    '<input type="number" id="ptPEstTax-' + period.id + '" min="0" step="0.01" placeholder="0.00" value="' + fmtAmt(period.estimated_tax_due) + '"></div>' +
                '<div class="pt-period-field"><label>Amount Submitted</label>' +
                    '<input type="number" id="ptPAmtSub-' + period.id + '" min="0" step="0.01" placeholder="0.00" value="' + fmtAmt(period.amount_submitted) + '"></div>' +
                '<div class="pt-period-field"><label>Amount Paid</label>' +
                    '<input type="number" id="ptPAmtPaid-' + period.id + '" min="0" step="0.01" placeholder="0.00" value="' + fmtAmt(period.amount_paid) + '"></div>' +
                '<div class="pt-period-field"><label>Submission Ref</label>' +
                    '<input type="text" id="ptPSubRef-' + period.id + '" placeholder="IRP6 reference" value="' + esc(period.submission_reference || '') + '"></div>' +
            '</div>' +
            '<div class="pt-period-field" style="margin-top:8px;"><label>Notes</label>' +
                '<input type="text" id="ptPNotes-' + period.id + '" placeholder="Any period notes" value="' + esc(period.notes || '') + '"></div>' +
            '<div class="pt-period-actions">' +
                '<select id="ptPStatusSel-' + period.id + '" style="font-size:0.8rem;height:28px;padding:2px 6px;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:5px;color:var(--text);" title="Period status">' + statusOpts + '</select>' +
                '<button type="button" class="btn btn-ghost btn-xs" onclick="ptUpdatePeriodStatus(' + period.id + ')">Update Status</button>' +
                '<button type="button" class="btn btn-primary btn-xs" onclick="ptSavePeriod(' + period.id + ')">Save</button>' +
            '</div>' +
        '</div>';
    }

    async function ptSavePeriod(periodId) {
        if (!_activePlan) return;
        var fv = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
        var body = {
            due_date:                  fv('ptPDue-' + periodId)      || null,
            estimated_taxable_income:  fv('ptPEstIncome-' + periodId) ? parseFloat(fv('ptPEstIncome-' + periodId)) : null,
            estimated_tax_due:         fv('ptPEstTax-' + periodId)    ? parseFloat(fv('ptPEstTax-' + periodId))    : null,
            amount_submitted:          fv('ptPAmtSub-' + periodId)    ? parseFloat(fv('ptPAmtSub-' + periodId))    : null,
            amount_paid:               fv('ptPAmtPaid-' + periodId)   ? parseFloat(fv('ptPAmtPaid-' + periodId))   : null,
            submission_reference:      fv('ptPSubRef-' + periodId)    || null,
            notes:                     fv('ptPNotes-' + periodId)     || null,
        };
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id + '/periods/' + periodId, { method: 'PUT', body: JSON.stringify(body) });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            showToast('Period saved.');
        } catch(e) {
            showToast('Error: ' + (e.message || 'Save failed.'));
        }
    }

    async function ptUpdatePeriodStatus(periodId) {
        if (!_activePlan) return;
        var sel    = document.getElementById('ptPStatusSel-' + periodId);
        var status = sel ? sel.value : '';
        if (!status) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id + '/periods/' + periodId + '/status', {
                method: 'PUT',
                body: JSON.stringify({ status: status }),
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var data    = await res.json();
            var updated = data.period;
            // Refresh badge in row
            var badge = document.getElementById('ptPeriodStatusBadge-' + periodId);
            if (badge) {
                badge.className = 'pt-status-badge pt-s-' + updated.status;
                badge.textContent = _periodStatusLabels[updated.status] || updated.status;
            }
            showToast('Period status updated.');
        } catch(e) {
            showToast('Error: ' + (e.message || 'Update failed.'));
        }
    }

    /* ── Events tab ─────────────────────────────────────────── */
    async function loadEvents() {
        if (!_activePlan) return;
        show('ptDEventsLoading'); hide('ptDEventsEmpty');
        var wrap = document.getElementById('ptDEventsWrap');
        if (wrap) wrap.innerHTML = '';
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activePlan.id + '/events');
            if (!res.ok) throw new Error('Load failed');
            var data   = await res.json();
            var events = data.events || [];
            hide('ptDEventsLoading');
            if (!events.length) { show('ptDEventsEmpty'); return; }
            if (wrap) {
                wrap.innerHTML = events.map(function (ev) {
                    var label     = _eventLabels[ev.event_type] || ev.event_type;
                    var statusStr = '';
                    if (ev.old_status && ev.new_status) {
                        statusStr = ': ' + ev.old_status + ' → ' + ev.new_status;
                    }
                    var dateStr = ev.created_at ? ev.created_at.slice(0, 16).replace('T', ' ') : '';
                    return '<div class="pt-event-row">' +
                        '<span class="pt-event-type">' + esc(label) + statusStr + '</span>' +
                        '<span style="float:right;font-size:0.72rem;">' + esc(dateStr) + '</span>' +
                        (ev.notes ? '<div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;">' + esc(ev.notes) + '</div>' : '') +
                        '</div>';
                }).join('');
            }
        } catch(e) {
            hide('ptDEventsLoading');
        }
    }

    /* ── Tab switching ─────────────────────────────────────── */
    function ptSwitchTab(tabKey, evt) {
        var keys = ['overview', 'periods', 'events'];
        var ids  = { overview: 'ptTabOverview', periods: 'ptTabPeriods', events: 'ptTabEvents' };
        keys.forEach(function (k) {
            var el = document.getElementById(ids[k]);
            if (el) el.classList.toggle('active', k === tabKey);
        });
        if (evt) {
            document.querySelectorAll('.pt-tab').forEach(function (el) { el.classList.remove('active'); });
            evt.target.classList.add('active');
        }
        if (tabKey === 'events') loadEvents();
    }

    /* ── DOM helpers ────────────────────────────────────────── */
    function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    function setVal(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
    function setText(id, t) { var el = document.getElementById(id); if (el) el.textContent = t; }
    function show(id) { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hide(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }
    function setDisabled(id, s) { var el = document.getElementById(id); if (el) el.disabled = s; }
    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /* ── Expose public interface ────────────────────────────── */
    window.loadPlans              = loadPlans;
    window.openCreatePlanModal    = openCreatePlanModal;
    window.closeCreatePlanModal   = closeCreatePlanModal;
    window.ptLoadProfilesForClient= ptLoadProfilesForClient;
    window.ptAutoName             = ptAutoName;
    window.submitCreatePlan       = submitCreatePlan;
    window.openDetailModal        = openDetailModal;
    window.closePtDetailModal     = closePtDetailModal;
    window.ptSwitchTab            = ptSwitchTab;
    window.ptUpdateStatus         = ptUpdateStatus;
    window.ptSaveOverviewEdits    = ptSaveOverviewEdits;
    window.ptMarkReviewed         = ptMarkReviewed;
    window.ptCreatePeriods        = ptCreatePeriods;
    window.ptSavePeriod           = ptSavePeriod;
    window.ptUpdatePeriodStatus   = ptUpdatePeriodStatus;

    /* ── Boot ───────────────────────────────────────────────── */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
