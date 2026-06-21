/* ============================================================
   Lorenco Practice — Company Tax Data Capture (Codebox 31)
   No localStorage/KV for business data. All data via API.
   NOT tax calculation. NOT ITR14 submission. NOT SARS.
   ============================================================ */
(function () {
    var _BASE     = '/api/practice/company-tax';
    var _currentReturnId = null;
    var _adjEditingId    = null;
    var _adjSubmitting   = false;
    var _createSubmitting = false;
    var _teamMembers = [];
    var _clients     = [];

    var CT_STATUS_LABELS = {
        draft: 'Draft', collecting_docs: 'Collecting Docs', data_captured: 'Data Captured',
        ready_for_review: 'Ready for Review', reviewed: 'Reviewed',
        submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
    };

    var CT_READINESS_LABELS = {
        ready: '✓ Ready', partial: '~ Partial', incomplete: '✗ Incomplete',
        blocked: '⚠ Blocked', unknown: '? Unknown',
    };

    var CT_ADJ_TYPE_LABELS = {
        add_back: 'Add Back', deduction: 'Deduction', allowance: 'Allowance',
        disallowance: 'Disallowance', assessed_loss: 'Assessed Loss',
        capital_allowance: 'Capital Allowance', section_24c: 'Section 24C',
        doubtful_debt: 'Doubtful Debt', donation: 'Donation', other: 'Other',
    };

    var CT_RI_STATUS_LABELS = {
        required: 'Required', requested: 'Requested', received: 'Received',
        captured: 'Captured', reviewed: 'Reviewed', waived: 'Waived',
        blocked: 'Blocked', not_applicable: 'N/A',
    };

    var esc = PracticeAPI.escHtml;

    // ── Auth + init ────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        LAYOUT.init('company-tax');

        var params = new URLSearchParams(window.location.search);
        if (params.get('client_id')) {
            document.getElementById('ctFilterStatus').value = '';
        }

        await Promise.all([loadTeam(), loadClients()]);
        await loadReturns();

        // Auto-open detail if returnId in URL
        var returnId = params.get('return_id');
        if (returnId) openDetailModal(parseInt(returnId));
    }

    // ── Load support data ──────────────────────────────────────────────────────

    async function loadTeam() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/team?active=true');
            if (!res.ok) return;
            var d = await res.json();
            _teamMembers = d.members || [];
            var opts = '<option value="">Not assigned</option>' +
                _teamMembers.map(function(m) {
                    return '<option value="' + m.id + '">' + esc(m.display_name) +
                        (m.job_title ? ' — ' + esc(m.job_title) : '') + '</option>';
                }).join('');
            ['ctOvResponsible','ctOvReviewer'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.innerHTML = opts;
            });
        } catch(e) {}
    }

    async function loadClients() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients?is_active=true');
            if (!res.ok) return;
            var d = await res.json();
            _clients = d.clients || [];
            var opts = '<option value="">Select client…</option>' +
                _clients.map(function(c) {
                    return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
                }).join('');
            document.getElementById('ctCrClient').innerHTML = opts;
        } catch(e) {}
    }

    // ── Load returns list ──────────────────────────────────────────────────────

    async function loadReturns() {
        var loadEl  = document.getElementById('ctLoading');
        var errEl   = document.getElementById('ctError');
        var listEl  = document.getElementById('ctList');
        var emptyEl = document.getElementById('ctEmpty');

        loadEl.classList.remove('hidden');
        errEl.classList.add('hidden');
        listEl.classList.add('hidden');
        emptyEl.style.display = 'none';

        try {
            var params = new URLSearchParams();
            var status     = document.getElementById('ctFilterStatus').value;
            var readiness  = document.getElementById('ctFilterReadiness').value;
            var year       = document.getElementById('ctFilterYear').value;
            if (status)    params.set('status',           status);
            if (readiness) params.set('readiness_status', readiness);
            if (year)      params.set('tax_year',         year);
            params.set('limit', '100');

            var qs  = params.toString();
            var res = await PracticeAPI.fetch(_BASE + (qs ? '?' + qs : ''));
            if (!res.ok) throw new Error('Failed');
            var d   = await res.json();
            var returns = d.company_tax_returns || [];

            loadEl.classList.add('hidden');
            renderSummaryCards(returns);

            if (returns.length === 0) {
                emptyEl.style.display = 'block';
                return;
            }

            listEl.innerHTML = returns.map(function(r) {
                return '<div class="ct-card" onclick="openDetailModal(' + r.id + ')">' +
                    '<div class="ct-card-body">' +
                        '<div class="ct-card-name">' + esc(r.return_name) + ' — Tax Year ' + r.tax_year + '</div>' +
                        '<div class="ct-card-meta">' +
                            '<span class="ct-badge ct-s-' + esc(r.status) + '">' + esc(CT_STATUS_LABELS[r.status] || r.status) + '</span>' +
                            (r.readiness_status ? '<span class="ct-badge ct-r-' + esc(r.readiness_status) + '">' + esc(CT_READINESS_LABELS[r.readiness_status] || r.readiness_status) + '</span>' : '') +
                            (r.readiness_score != null ? '<span>' + r.readiness_score + '% ready</span>' : '') +
                            (r.financial_year_end ? '<span>FY ends ' + r.financial_year_end.substring(0,10) + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="ct-card-actions">' +
                        '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openDetailModal(' + r.id + ')">Open</button>' +
                    '</div>' +
                '</div>';
            }).join('');
            listEl.classList.remove('hidden');
        } catch(e) {
            loadEl.classList.add('hidden');
            errEl.classList.remove('hidden');
        }
    }

    function renderSummaryCards(returns) {
        var total    = returns.length;
        var active   = returns.filter(function(r) { return !['cancelled','completed'].includes(r.status); }).length;
        var ready    = returns.filter(function(r) { return r.readiness_status === 'ready'; }).length;
        var blocked  = returns.filter(function(r) { return r.readiness_status === 'blocked'; }).length;

        document.getElementById('ctSummaryCards').innerHTML =
            _summCard(total, 'Total Returns') +
            _summCard(active, 'Active') +
            _summCard(ready, 'Readiness Ready') +
            _summCard(blocked, 'Blocked');
    }

    function _summCard(num, label) {
        return '<div class="ct-summary-card"><div class="ct-summary-num">' + num + '</div><div class="ct-summary-lbl">' + label + '</div></div>';
    }

    // ── Create return ──────────────────────────────────────────────────────────

    function openCreateReturnModal() {
        _createSubmitting = false;
        document.getElementById('ctCreateSubmitBtn').disabled = false;
        document.getElementById('ctCreateError').classList.add('hidden');
        ['ctCrYear','ctCrName','ctCrNotes','ctCrFyStart','ctCrFyEnd'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) { el.value = ''; el._manuallyEdited = false; }
        });
        document.getElementById('ctCrProfile').innerHTML = '<option value="">Select client first…</option>';
        document.getElementById('ctCreateModal').classList.remove('hidden');
    }

    function closeCreateReturnModal() {
        document.getElementById('ctCreateModal').classList.add('hidden');
    }

    async function ctLoadProfilesForClient() {
        var clientId = document.getElementById('ctCrClient').value;
        var sel      = document.getElementById('ctCrProfile');
        if (!clientId) { sel.innerHTML = '<option value="">Select client first…</option>'; return; }

        sel.innerHTML = '<option value="">Loading…</option>';
        try {
            var res = await PracticeAPI.fetch('/api/practice/taxpayer-profiles?client_id=' + clientId + '&limit=100');
            if (!res.ok) throw new Error();
            var d = await res.json();
            var profiles = (d.taxpayer_profiles || []).filter(function(p) { return p.tax_status !== 'ceased'; });
            if (profiles.length === 0) {
                sel.innerHTML = '<option value="">No profiles — create one in Taxpayer Profiles</option>';
            } else {
                sel.innerHTML = '<option value="">Select profile…</option>' +
                    profiles.map(function(p) {
                        return '<option value="' + p.id + '">' + esc(p.taxpayer_name || 'Unnamed') +
                            ' (' + esc(p.taxpayer_type) + ')' + '</option>';
                    }).join('');
            }
        } catch(e) {
            sel.innerHTML = '<option value="">Failed to load profiles</option>';
        }
        ctAutoName();
    }

    function ctAutoName() {
        var nameEl = document.getElementById('ctCrName');
        if (nameEl && nameEl._manuallyEdited) return;
        var year = document.getElementById('ctCrYear').value;
        if (year) {
            if (nameEl) nameEl.value = 'ITR14 ' + year;
        }
    }

    async function submitCreateReturn() {
        if (_createSubmitting) return;
        var errEl     = document.getElementById('ctCreateError');
        var clientId  = document.getElementById('ctCrClient').value;
        var profileId = document.getElementById('ctCrProfile').value;
        var year      = document.getElementById('ctCrYear').value;
        var name      = document.getElementById('ctCrName').value.trim();

        if (!clientId)  { errEl.textContent = 'Client is required.';           errEl.classList.remove('hidden'); return; }
        if (!profileId) { errEl.textContent = 'Taxpayer profile is required.'; errEl.classList.remove('hidden'); return; }
        if (!year)      { errEl.textContent = 'Tax year is required.';         errEl.classList.remove('hidden'); return; }
        if (!name)      { errEl.textContent = 'Return name is required.';      errEl.classList.remove('hidden'); return; }

        _createSubmitting = true;
        document.getElementById('ctCreateSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id:           parseInt(clientId),
                    taxpayer_profile_id: parseInt(profileId),
                    tax_year:            parseInt(year),
                    return_name:         name,
                    financial_year_start: document.getElementById('ctCrFyStart').value || null,
                    financial_year_end:   document.getElementById('ctCrFyEnd').value   || null,
                    notes:               document.getElementById('ctCrNotes').value.trim() || null,
                }),
            });
            if (!res.ok) { var ed = await res.json(); throw new Error(ed.error || 'Failed'); }
            var d = await res.json();
            _createSubmitting = false;
            closeCreateReturnModal();
            PracticeAPI.showToast('Company tax return created.');
            await loadReturns();
            openDetailModal(d.company_tax_return.id);
        } catch(e) {
            _createSubmitting = false;
            document.getElementById('ctCreateSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create return.';
            errEl.classList.remove('hidden');
        }
    }

    // ── Detail modal ───────────────────────────────────────────────────────────

    async function openDetailModal(returnId) {
        _currentReturnId = returnId;
        document.getElementById('ctDetailModal').classList.remove('hidden');

        // Reset tabs to Overview
        ctSwitchTab('overview', document.getElementById('ctTabBtnOverview'));
        await loadCtOverview();
    }

    function closeDetailModal() {
        document.getElementById('ctDetailModal').classList.add('hidden');
        _currentReturnId = null;
    }

    var _ctPanelMap = {
        overview:    'ctTabOverview',
        afs:         'ctTabAfs',
        adjustments: 'ctTabAdjustments',
        readiness:   'ctTabReadiness',
        events:      'ctTabEvents',
    };

    function ctSwitchTab(tab, btn) {
        Object.keys(_ctPanelMap).forEach(function(k) {
            var panel = document.getElementById(_ctPanelMap[k]);
            if (panel) panel.classList.toggle('active', k === tab);
        });
        document.querySelectorAll('.ct-tab-btn').forEach(function(b) {
            b.classList.toggle('active', b === btn);
        });

        // Lazy-load tab data
        if (tab === 'afs')         loadCtAfs();
        if (tab === 'adjustments') loadCtAdjustments();
        if (tab === 'readiness')   loadCtReadiness();
        if (tab === 'events')      loadCtEvents();
    }

    // ── Overview tab ───────────────────────────────────────────────────────────

    var _currentReturn = null;

    async function loadCtOverview() {
        if (!_currentReturnId) return;
        document.getElementById('ctOverviewLoading').classList.remove('hidden');
        document.getElementById('ctOverviewContent').classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId);
            if (!res.ok) throw new Error('Not found');
            var d = await res.json();
            _currentReturn = d.company_tax_return;
            renderOverview(_currentReturn);
        } catch(e) {
            document.getElementById('ctOverviewLoading').textContent = 'Failed to load. Please try again.';
        }
    }

    function renderOverview(r) {
        document.getElementById('ctDetailTitle').textContent    = r.return_name + ' — Tax Year ' + r.tax_year;
        document.getElementById('ctDetailSubtitle').textContent = (r.financial_year_start ? r.financial_year_start.substring(0,10) : '') +
            (r.financial_year_end ? ' to ' + r.financial_year_end.substring(0,10) : '');

        document.getElementById('ctOvStatus').className   = 'ct-badge ct-s-' + r.status;
        document.getElementById('ctOvStatus').textContent = CT_STATUS_LABELS[r.status] || r.status;

        if (r.readiness_status) {
            document.getElementById('ctOvReadiness').className   = 'ct-badge ct-r-' + r.readiness_status;
            document.getElementById('ctOvReadiness').textContent = CT_READINESS_LABELS[r.readiness_status] || r.readiness_status;
        } else {
            document.getElementById('ctOvReadiness').textContent = '';
        }

        if (r.readiness_score != null) {
            document.getElementById('ctOvScoreWrap').classList.remove('hidden');
            document.getElementById('ctOvScoreFill').style.width = r.readiness_score + '%';
            document.getElementById('ctOvScoreLabel').textContent = r.readiness_score + '% of required items done';
        } else {
            document.getElementById('ctOvScoreWrap').classList.add('hidden');
        }

        document.getElementById('ctOvStatus2').value          = r.status;
        document.getElementById('ctOvYear').value             = r.tax_year;
        document.getElementById('ctOvFyStart').value          = r.financial_year_start ? r.financial_year_start.substring(0,10) : '';
        document.getElementById('ctOvFyEnd').value            = r.financial_year_end   ? r.financial_year_end.substring(0,10)   : '';
        document.getElementById('ctOvNotes').value            = r.notes          || '';
        document.getElementById('ctOvInternalNotes').value    = r.internal_notes || '';
        document.getElementById('ctOvResponsible').value      = r.responsible_team_member_id || '';
        document.getElementById('ctOvReviewer').value         = r.reviewer_team_member_id    || '';

        var isCancelled = r.status === 'cancelled';
        document.getElementById('ctCancelReturnBtn').disabled = isCancelled;

        document.getElementById('ctOverviewLoading').classList.add('hidden');
        document.getElementById('ctOverviewContent').classList.remove('hidden');
        document.getElementById('ctOvSaveError').classList.add('hidden');
    }

    async function ctSaveOverview() {
        if (!_currentReturnId) return;
        var errEl = document.getElementById('ctOvSaveError');
        errEl.classList.add('hidden');

        var status = document.getElementById('ctOvStatus2').value;
        if (!status) { errEl.textContent = 'Status is required.'; errEl.classList.remove('hidden'); return; }

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status,
                    tax_year:                   parseInt(document.getElementById('ctOvYear').value) || _currentReturn.tax_year,
                    financial_year_start:        document.getElementById('ctOvFyStart').value || null,
                    financial_year_end:          document.getElementById('ctOvFyEnd').value   || null,
                    notes:                       document.getElementById('ctOvNotes').value.trim()         || null,
                    internal_notes:              document.getElementById('ctOvInternalNotes').value.trim() || null,
                    responsible_team_member_id:  document.getElementById('ctOvResponsible').value ? parseInt(document.getElementById('ctOvResponsible').value) : null,
                    reviewer_team_member_id:     document.getElementById('ctOvReviewer').value    ? parseInt(document.getElementById('ctOvReviewer').value)    : null,
                }),
            });
            if (!res.ok) { var ed = await res.json(); throw new Error(ed.error || 'Save failed'); }
            var d = await res.json();
            _currentReturn = d.company_tax_return;
            renderOverview(_currentReturn);
            PracticeAPI.showToast('Return saved.');
            loadReturns();
        } catch(e) {
            errEl.textContent = e.message || 'Failed to save.';
            errEl.classList.remove('hidden');
        }
    }

    async function ctCancelReturn() {
        if (!_currentReturnId) return;
        if (!confirm('Cancel this company tax return? This will set status to Cancelled.')) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId, { method: 'DELETE' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error); }
            PracticeAPI.showToast('Return cancelled.');
            closeDetailModal();
            loadReturns();
        } catch(e) {
            PracticeAPI.showToast('Failed to cancel: ' + (e.message || ''), true);
        }
    }

    async function ctRecalculateReadiness() {
        if (!_currentReturnId) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/recalculate-readiness', { method: 'POST' });
            if (!res.ok) throw new Error('Recalculate failed');
            var d = await res.json();
            _currentReturn = d.company_tax_return;
            renderOverview(_currentReturn);
            PracticeAPI.showToast('Readiness recalculated.');
            loadReturns();
            if (document.getElementById('ctTabReadiness').classList.contains('active')) loadCtReadiness();
        } catch(e) {
            PracticeAPI.showToast('Failed to recalculate.', true);
        }
    }

    // ── AFS Inputs tab ─────────────────────────────────────────────────────────

    async function loadCtAfs() {
        if (!_currentReturnId || !_currentReturn) return;
        var r = _currentReturn;
        var fields = {
            ctAfsAccProfit:   r.accounting_profit_loss,
            ctAfsTurnover:    r.turnover,
            ctAfsCos:         r.cost_of_sales,
            ctAfsGrossProfit: r.gross_profit,
            ctAfsOpEx:        r.operating_expenses,
            ctAfsFinance:     r.finance_costs,
            ctAfsOtherIncome: r.other_income,
            ctAfsTaxableEst:  r.taxable_income_estimate,
            ctAfsAlBf:        r.assessed_loss_brought_forward,
            ctAfsAlUtilised:  r.assessed_loss_utilised,
            ctAfsAlCf:        r.assessed_loss_carried_forward,
        };
        Object.keys(fields).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = fields[id] != null ? fields[id] : '';
        });
    }

    async function ctSaveAfs() {
        if (!_currentReturnId) return;
        var errEl = document.getElementById('ctAfsSaveError');
        errEl.classList.add('hidden');

        function num(id) {
            var v = document.getElementById(id).value;
            return v !== '' ? parseFloat(v) : null;
        }

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accounting_profit_loss:        num('ctAfsAccProfit'),
                    turnover:                      num('ctAfsTurnover'),
                    cost_of_sales:                 num('ctAfsCos'),
                    gross_profit:                  num('ctAfsGrossProfit'),
                    operating_expenses:            num('ctAfsOpEx'),
                    finance_costs:                 num('ctAfsFinance'),
                    other_income:                  num('ctAfsOtherIncome'),
                    taxable_income_estimate:       num('ctAfsTaxableEst'),
                    assessed_loss_brought_forward: num('ctAfsAlBf'),
                    assessed_loss_utilised:        num('ctAfsAlUtilised'),
                    assessed_loss_carried_forward: num('ctAfsAlCf'),
                }),
            });
            if (!res.ok) { var ed = await res.json(); throw new Error(ed.error || 'Save failed'); }
            var d = await res.json();
            _currentReturn = d.company_tax_return;
            PracticeAPI.showToast('AFS inputs saved.');
        } catch(e) {
            errEl.textContent = e.message || 'Failed to save AFS inputs.';
            errEl.classList.remove('hidden');
        }
    }

    // ── Adjustments tab ────────────────────────────────────────────────────────

    async function loadCtAdjustments() {
        if (!_currentReturnId) return;
        var loadEl  = document.getElementById('ctAdjLoading');
        var listEl  = document.getElementById('ctAdjList');
        var emptyEl = document.getElementById('ctAdjEmpty');
        var totEl   = document.getElementById('ctAdjTotals');

        loadEl.classList.remove('hidden');
        listEl.classList.add('hidden');
        emptyEl.classList.add('hidden');
        totEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/adjustments');
            if (!res.ok) throw new Error('Failed');
            var d = await res.json();
            var adjs = d.adjustments || [];

            loadEl.classList.add('hidden');
            if (adjs.length === 0) { emptyEl.classList.remove('hidden'); return; }

            // Totals by type direction
            var totalAdd = 0, totalDed = 0;
            adjs.forEach(function(a) {
                var isAddition = ['add_back','disallowance'].includes(a.adjustment_type);
                if (isAddition) totalAdd += parseFloat(a.amount || 0);
                else            totalDed += parseFloat(a.amount || 0);
            });

            listEl.innerHTML = adjs.map(function(a) {
                return '<div class="ct-adj-row">' +
                    '<div class="ct-adj-body">' +
                        '<div class="ct-adj-desc">' + esc(a.description) + '</div>' +
                        '<div class="ct-adj-meta">' +
                            '<span class="ct-adj-t-' + esc(a.adjustment_type) + '">' + esc(CT_ADJ_TYPE_LABELS[a.adjustment_type] || a.adjustment_type) + '</span>' +
                            (a.adjustment_category ? ' &bull; ' + esc(a.adjustment_category) : '') +
                            (a.source_reference    ? ' &bull; ' + esc(a.source_reference)    : '') +
                        '</div>' +
                        (a.notes ? '<div class="ct-adj-meta" style="margin-top:2px;font-style:italic;">' + esc(a.notes) + '</div>' : '') +
                    '</div>' +
                    '<div style="text-align:right;flex-shrink:0;">' +
                        '<div class="ct-adj-amt">R ' + _fmtNum(a.amount) + '</div>' +
                        '<div style="margin-top:4px;display:flex;gap:0.3rem;">' +
                            '<button class="btn btn-ghost btn-sm" onclick="openEditAdjModal(' + a.id + ')">Edit</button>' +
                            '<button class="btn btn-danger btn-sm" onclick="deleteAdj(' + a.id + ')">Del</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
            listEl.classList.remove('hidden');

            totEl.innerHTML =
                '<span style="color:rgba(255,255,255,0.5);">Add-backs / Disallowances:</span> <strong>R ' + _fmtNum(totalAdd) + '</strong>' +
                '&nbsp;&nbsp;&bull;&nbsp;&nbsp;' +
                '<span style="color:rgba(255,255,255,0.5);">Deductions / Allowances:</span> <strong>R ' + _fmtNum(totalDed) + '</strong>';
            totEl.classList.remove('hidden');
        } catch(e) {
            loadEl.textContent = 'Failed to load adjustments.';
        }
    }

    function openAddAdjModal() {
        _adjEditingId = null;
        _adjSubmitting = false;
        document.getElementById('ctAdjModalTitle').textContent = 'Add Adjustment';
        document.getElementById('ctAdjSubmitBtn').disabled = false;
        ['ctAdjType','ctAdjCategory','ctAdjDesc','ctAdjAmount','ctAdjTaxEffect','ctAdjSourceRef','ctAdjNotes'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) { el.value = el.tagName === 'SELECT' ? 'add_back' : ''; }
        });
        document.getElementById('ctAdjType').value = 'add_back';
        document.getElementById('ctAdjError').classList.add('hidden');
        document.getElementById('ctAdjModal').classList.remove('hidden');
    }

    async function openEditAdjModal(adjId) {
        // Fetch from current list
        var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/adjustments');
        if (!res.ok) return;
        var d = await res.json();
        var adj = (d.adjustments || []).find(function(a) { return a.id === adjId; });
        if (!adj) return;

        _adjEditingId = adjId;
        _adjSubmitting = false;
        document.getElementById('ctAdjModalTitle').textContent = 'Edit Adjustment';
        document.getElementById('ctAdjSubmitBtn').disabled = false;
        document.getElementById('ctAdjType').value        = adj.adjustment_type;
        document.getElementById('ctAdjCategory').value    = adj.adjustment_category || '';
        document.getElementById('ctAdjDesc').value        = adj.description;
        document.getElementById('ctAdjAmount').value      = adj.amount;
        document.getElementById('ctAdjTaxEffect').value   = adj.tax_effect       || '';
        document.getElementById('ctAdjSourceRef').value   = adj.source_reference  || '';
        document.getElementById('ctAdjNotes').value       = adj.notes             || '';
        document.getElementById('ctAdjError').classList.add('hidden');
        document.getElementById('ctAdjModal').classList.remove('hidden');
    }

    function closeAdjModal() {
        document.getElementById('ctAdjModal').classList.add('hidden');
        _adjEditingId = null;
    }

    async function submitAdj() {
        if (_adjSubmitting) return;
        var errEl = document.getElementById('ctAdjError');
        var desc  = document.getElementById('ctAdjDesc').value.trim();
        var amt   = document.getElementById('ctAdjAmount').value;
        var type  = document.getElementById('ctAdjType').value;

        if (!desc) { errEl.textContent = 'Description is required.'; errEl.classList.remove('hidden'); return; }
        if (!amt || isNaN(parseFloat(amt))) { errEl.textContent = 'Amount is required.'; errEl.classList.remove('hidden'); return; }

        _adjSubmitting = true;
        document.getElementById('ctAdjSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        var body = {
            adjustment_type:     type,
            adjustment_category: document.getElementById('ctAdjCategory').value.trim()  || null,
            description:         desc,
            amount:              parseFloat(amt),
            tax_effect:          document.getElementById('ctAdjTaxEffect').value.trim() || null,
            source_reference:    document.getElementById('ctAdjSourceRef').value.trim() || null,
            notes:               document.getElementById('ctAdjNotes').value.trim()      || null,
        };

        try {
            var url    = _BASE + '/' + _currentReturnId + '/adjustments' + (_adjEditingId ? '/' + _adjEditingId : '');
            var method = _adjEditingId ? 'PUT' : 'POST';
            var res    = await PracticeAPI.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!res.ok) { var ed = await res.json(); throw new Error(ed.error || 'Failed'); }
            _adjSubmitting = false;
            closeAdjModal();
            PracticeAPI.showToast(_adjEditingId ? 'Adjustment updated.' : 'Adjustment added.');
            loadCtAdjustments();
        } catch(e) {
            _adjSubmitting = false;
            document.getElementById('ctAdjSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to save adjustment.';
            errEl.classList.remove('hidden');
        }
    }

    async function deleteAdj(adjId) {
        if (!confirm('Delete this adjustment?')) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/adjustments/' + adjId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed');
            PracticeAPI.showToast('Adjustment deleted.');
            loadCtAdjustments();
        } catch(e) {
            PracticeAPI.showToast('Failed to delete adjustment.', true);
        }
    }

    // ── Readiness tab ──────────────────────────────────────────────────────────

    async function loadCtReadiness() {
        if (!_currentReturnId) return;
        var loadEl  = document.getElementById('ctRiLoading');
        var listEl  = document.getElementById('ctRiList');
        var emptyEl = document.getElementById('ctRiEmpty');
        var scoreEl = document.getElementById('ctReadinessScore');

        loadEl.classList.remove('hidden');
        listEl.classList.add('hidden');
        emptyEl.classList.add('hidden');
        scoreEl.classList.add('hidden');

        try {
            var [itemsRes, returnRes] = await Promise.all([
                PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/items'),
                PracticeAPI.fetch(_BASE + '/' + _currentReturnId),
            ]);
            if (!itemsRes.ok || !returnRes.ok) throw new Error('Failed');
            var id = await itemsRes.json();
            var rd = await returnRes.json();
            var items = id.items || [];
            var r     = rd.company_tax_return;

            loadEl.classList.add('hidden');

            if (r.readiness_score != null || r.readiness_status) {
                scoreEl.innerHTML =
                    '<span class="ct-badge ct-r-' + esc(r.readiness_status || 'unknown') + '">' + esc(CT_READINESS_LABELS[r.readiness_status] || r.readiness_status || 'Unknown') + '</span>' +
                    (r.readiness_score != null ? ' &nbsp;<strong>' + r.readiness_score + '%</strong> of required items done' : '');
                scoreEl.classList.remove('hidden');
            }

            if (items.length === 0) { emptyEl.classList.remove('hidden'); return; }

            listEl.innerHTML = items.map(function(item) {
                var statusOpts = ['required','requested','received','captured','reviewed','waived','blocked','not_applicable'].map(function(s) {
                    return '<option value="' + s + '"' + (item.status === s ? ' selected' : '') + '>' + esc(CT_RI_STATUS_LABELS[s] || s) + '</option>';
                }).join('');
                return '<div class="ct-ri-row">' +
                    '<div class="ct-ri-name">' + esc(item.item_name) +
                        (item.required ? '' : ' <span class="ct-ri-req">(optional)</span>') +
                    '</div>' +
                    '<select style="width:130px;font-size:0.78rem;" title="Status" onchange="ctUpdateItemStatus(' + item.id + ', this.value)">' +
                        statusOpts +
                    '</select>' +
                    '<button class="btn btn-danger btn-sm" onclick="ctDeleteReadinessItem(' + item.id + ')">×</button>' +
                '</div>';
            }).join('');
            listEl.classList.remove('hidden');
        } catch(e) {
            loadEl.textContent = 'Failed to load readiness items.';
        }
    }

    async function ctUpdateItemStatus(itemId, status) {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/items/' + itemId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) throw new Error('Failed');
            // Auto-recalculate after status change
            await ctRecalculateReadiness();
            loadCtReadiness();
        } catch(e) {
            PracticeAPI.showToast('Failed to update item status.', true);
        }
    }

    async function ctDeleteReadinessItem(itemId) {
        if (!confirm('Remove this readiness item?')) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/items/' + itemId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed');
            PracticeAPI.showToast('Item removed.');
            loadCtReadiness();
            ctRecalculateReadiness();
        } catch(e) {
            PracticeAPI.showToast('Failed to remove item.', true);
        }
    }

    async function ctGenerateDefaultItems() {
        if (!_currentReturnId) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/generate-default-items', { method: 'POST' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var d = await res.json();
            PracticeAPI.showToast('Generated ' + d.items_created + ' items (' + d.items_skipped + ' already existed).');
            loadCtReadiness();
            loadCtOverview();
        } catch(e) {
            PracticeAPI.showToast('Failed to generate items: ' + (e.message || ''), true);
        }
    }

    // ── Events tab ─────────────────────────────────────────────────────────────

    async function loadCtEvents() {
        if (!_currentReturnId) return;
        var loadEl  = document.getElementById('ctEvLoading');
        var listEl  = document.getElementById('ctEvList');
        var emptyEl = document.getElementById('ctEvEmpty');

        loadEl.classList.remove('hidden');
        listEl.classList.add('hidden');
        emptyEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _currentReturnId + '/events');
            if (!res.ok) throw new Error('Failed');
            var d = await res.json();
            var events = (d.events || []).slice().reverse();

            loadEl.classList.add('hidden');
            if (events.length === 0) { emptyEl.classList.remove('hidden'); return; }

            listEl.innerHTML = events.map(function(ev) {
                var ts = ev.created_at ? new Date(ev.created_at).toLocaleString() : '';
                return '<div class="ct-ev-row">' +
                    '<div class="ct-ev-type">' + esc(ev.event_type.replace(/_/g, ' ')) + '</div>' +
                    '<div class="ct-ev-meta">' + esc(ts) +
                        (ev.old_status && ev.new_status ? ' &bull; ' + esc(ev.old_status) + ' → ' + esc(ev.new_status) : '') +
                        (ev.notes ? ' &bull; ' + esc(ev.notes) : '') +
                    '</div>' +
                '</div>';
            }).join('');
            listEl.classList.remove('hidden');
        } catch(e) {
            loadEl.textContent = 'Failed to load events.';
        }
    }

    // ── Utility ────────────────────────────────────────────────────────────────

    function _fmtNum(n) {
        return parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ── Exports ────────────────────────────────────────────────────────────────

    window.loadReturns           = loadReturns;
    window.openCreateReturnModal = openCreateReturnModal;
    window.closeCreateReturnModal= closeCreateReturnModal;
    window.ctLoadProfilesForClient = ctLoadProfilesForClient;
    window.ctAutoName            = ctAutoName;
    window.submitCreateReturn    = submitCreateReturn;
    window.openDetailModal       = openDetailModal;
    window.closeDetailModal      = closeDetailModal;
    window.ctSwitchTab           = ctSwitchTab;
    window.ctSaveOverview        = ctSaveOverview;
    window.ctCancelReturn        = ctCancelReturn;
    window.ctRecalculateReadiness= ctRecalculateReadiness;
    window.ctSaveAfs             = ctSaveAfs;
    window.openAddAdjModal       = openAddAdjModal;
    window.openEditAdjModal      = openEditAdjModal;
    window.closeAdjModal         = closeAdjModal;
    window.submitAdj             = submitAdj;
    window.deleteAdj             = deleteAdj;
    window.ctUpdateItemStatus    = ctUpdateItemStatus;
    window.ctDeleteReadinessItem = ctDeleteReadinessItem;
    window.ctGenerateDefaultItems= ctGenerateDefaultItems;

    init();
})();
