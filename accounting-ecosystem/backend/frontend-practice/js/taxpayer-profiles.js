/* ============================================================
   Lorenco Practice — Taxpayer Profiles (Codebox 25)
   All business data is server-authoritative. No localStorage.
   ============================================================ */
(function () {
    'use strict';

    var _BASE = '/api/practice/taxpayer-profiles';

    /* ── State ─────────────────────────────────────────────── */
    var _clients       = [];
    var _activeProfile = null;

    /* ── Label maps ───────────────────────────────────────── */
    var _typeLabels = {
        individual:  'Individual',
        company:     'Company',
        trust:       'Trust',
        partnership: 'Partnership',
        cc:          'CC'
    };
    var _taxStatusLabels = {
        active:  'Active',
        dormant: 'Dormant',
        ceased:  'Ceased'
    };
    var _readinessLabels = {
        incomplete: 'Incomplete',
        partial:    'Partial',
        ready:      'Ready',
        blocked:    'Blocked',
        unknown:    'Unknown'
    };
    var _readinessClass = {
        incomplete: 'tp-ready-incomplete',
        partial:    'tp-ready-partial',
        ready:      'tp-ready-ready',
        blocked:    'tp-ready-blocked',
        unknown:    'tp-ready-unknown'
    };
    var _sourceLabels = {
        salary:            'Salary / Employment',
        business:          'Business Income',
        rental:            'Rental Income',
        investment:        'Investment Income',
        interest:          'Interest',
        dividends:         'Dividends',
        foreign_income:    'Foreign Income',
        capital_gain:      'Capital Gain',
        trust_distribution:'Trust Distribution',
        pension:           'Pension / Annuity',
        other:             'Other'
    };
    var _deductionLabels = {
        retirement_annuity: 'Retirement Annuity (RA)',
        medical:            'Medical Expenses',
        travel:             'Travel Allowance / Logbook',
        home_office:        'Home Office',
        donations:          'Donations (s18A)',
        wear_and_tear:      'Wear & Tear',
        business_expenses:  'Business Expenses',
        assessed_losses:    'Assessed Losses',
        other:              'Other'
    };
    var _itemStatusLabels = {
        required:  'Required',
        received:  'Received',
        completed: 'Completed',
        waived:    'Waived',
        blocked:   'Blocked'
    };
    var _itemStatusClass = {
        required:  'tp-item-required',
        received:  'tp-item-received',
        completed: 'tp-item-completed',
        waived:    'tp-item-waived',
        blocked:   'tp-item-blocked'
    };

    /* ── Init ──────────────────────────────────────────────── */
    async function init() {
        LAYOUT.init('taxpayer-profiles');
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var authRes = await PracticeAPI.fetch('/api/auth/me');
            if (!authRes.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        // Pre-populate client filter from URL param if present
        var params   = new URLSearchParams(window.location.search);
        var urlClient = params.get('client_id');

        await loadClients();
        if (urlClient) {
            var filterEl = document.getElementById('tpFilterClient');
            if (filterEl) filterEl.value = urlClient;
        }
        loadSummary();
        loadProfiles();
    }

    /* ── Toast / Error helpers ─────────────────────────────── */
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

    /* ── Load clients for selects ──────────────────────────── */
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
        var filterEl = document.getElementById('tpFilterClient');
        if (filterEl) filterEl.innerHTML = filterOpts;

        var createOpts = '<option value="">Select client…</option>' +
            _clients.map(function (c) {
                return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
            }).join('');
        var createEl = document.getElementById('tpCClient');
        if (createEl) createEl.innerHTML = createOpts;
    }

    /* ── Summary cards ─────────────────────────────────────── */
    async function loadSummary() {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/summary');
            if (!res.ok) return;
            var data = await res.json();
            var s = data.summary || {};
            setText('sumTpTotal',     s.total      || 0);
            setText('sumTpIndividual', s.by_type && s.by_type.individual || 0);
            setText('sumTpCompany',   ((s.by_type && s.by_type.company) || 0) + ((s.by_type && s.by_type.cc) || 0));
            setText('sumTpTrust',     ((s.by_type && s.by_type.trust) || 0) + ((s.by_type && s.by_type.partnership) || 0));
            setText('sumTpReady',     s.by_readiness && s.by_readiness.ready   || 0);
            setText('sumTpBlocked',   s.by_readiness && s.by_readiness.blocked || 0);
        } catch(e) {}
    }

    /* ── Profile list ──────────────────────────────────────── */
    async function loadProfiles() {
        var type      = val('tpFilterType');
        var status    = val('tpFilterStatus');
        var readiness = val('tpFilterReadiness');
        var clientId  = val('tpFilterClient');

        show('tpListLoading'); hide('tpListWrap'); hide('tpListEmpty'); hide('tpListError');

        var qs = [];
        if (type)      qs.push('taxpayer_type='    + encodeURIComponent(type));
        if (status)    qs.push('tax_status='        + encodeURIComponent(status));
        if (readiness) qs.push('readiness_status='  + encodeURIComponent(readiness));
        if (clientId)  qs.push('client_id='         + encodeURIComponent(clientId));
        var url = _BASE + (qs.length ? '?' + qs.join('&') : '');

        try {
            var res = await PracticeAPI.fetch(url);
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            hide('tpListLoading');
            renderProfileList(data.taxpayer_profiles || []);
        } catch(e) {
            hide('tpListLoading');
            showError('tpListError', 'Failed to load profiles: ' + (e.message || ''));
            show('tpListError');
        }
    }

    function renderProfileList(profiles) {
        if (!profiles.length) { show('tpListEmpty'); return; }
        var tbody = document.getElementById('tpListBody');
        if (!tbody) return;
        tbody.innerHTML = profiles.map(function (p) {
            var rLabel = _readinessLabels[p.readiness_status] || '—';
            var rClass = _readinessClass[p.readiness_status]  || 'tp-ready-unknown';
            var rScore = p.readiness_score != null ? p.readiness_score + '%' : '';
            var rText  = rScore ? rLabel + ' (' + rScore + ')' : rLabel;
            var clientName = p.client_name || p.client_display_name || 'Unknown Client';
            return '<tr>' +
                '<td class="col-type"><span class="tp-type-badge tp-type-' + p.taxpayer_type + '">' + esc(_typeLabels[p.taxpayer_type] || p.taxpayer_type) + '</span></td>' +
                '<td>' + esc(clientName) + '</td>' +
                '<td>' + esc(p.income_tax_reference || '—') + '</td>' +
                '<td class="col-status"><span class="tp-status-badge tp-status-' + p.tax_status + '">' + esc(_taxStatusLabels[p.tax_status] || p.tax_status) + '</span></td>' +
                '<td class="col-ready"><span class="' + rClass + '">' + rText + '</span></td>' +
                '<td class="col-actions"><button type="button" class="btn btn-ghost btn-xs" onclick="openDetailModal(' + p.id + ')">View</button></td>' +
                '</tr>';
        }).join('');
        show('tpListWrap');
    }

    /* ── Create profile modal ──────────────────────────────── */
    function openCreateProfileModal() {
        clearError('tpCreateError');
        setVal('tpCClient',    '');
        setVal('tpCType',      '');
        setVal('tpCTaxRef',    '');
        setVal('tpCTaxStatus', 'active');
        setVal('tpCIdNumber',  '');
        setVal('tpCPassport',  '');
        setVal('tpCMarital',   '');
        setChecked('tpCProvisional', false);
        setVal('tpCRegNumber', '');
        setVal('tpCFYE',       '');
        setChecked('tpCVat',   false);
        setChecked('tpCPaye',  false);
        setVal('tpCNotes',     '');
        hide('tpCIndividualFields'); hide('tpCEntityFields');
        document.getElementById('tpCreateModal').classList.remove('hidden');
    }
    function closeCreateProfileModal() {
        document.getElementById('tpCreateModal').classList.add('hidden');
    }

    function tpToggleIndividualFields() {
        var t = val('tpCType');
        if (t === 'individual') {
            show('tpCIndividualFields'); hide('tpCEntityFields');
        } else if (t === 'company' || t === 'trust' || t === 'partnership' || t === 'cc') {
            hide('tpCIndividualFields'); show('tpCEntityFields');
        } else {
            hide('tpCIndividualFields'); hide('tpCEntityFields');
        }
    }

    async function submitCreateProfile() {
        clearError('tpCreateError');
        var clientId = val('tpCClient');
        var type     = val('tpCType');
        if (!clientId) { showError('tpCreateError', 'Please select a client.'); return; }
        if (!type)     { showError('tpCreateError', 'Please select a taxpayer type.'); return; }

        var body = {
            client_id:            parseInt(clientId),
            taxpayer_type:        type,
            income_tax_reference: val('tpCTaxRef') || null,
            tax_status:           val('tpCTaxStatus') || 'active',
            notes:                val('tpCNotes') || null
        };
        if (type === 'individual') {
            body.id_number            = val('tpCIdNumber') || null;
            body.passport_number      = val('tpCPassport') || null;
            body.marital_status       = val('tpCMarital') || null;
            body.provisional_taxpayer = getChecked('tpCProvisional');
        } else {
            body.registration_number  = val('tpCRegNumber') || null;
            body.financial_year_end   = val('tpCFYE') || null;
            body.vat_registered       = getChecked('tpCVat');
            body.paye_registered      = getChecked('tpCPaye');
        }

        setDisabled('tpCreateSubmitBtn', true);
        try {
            var res = await PracticeAPI.fetch(_BASE, { method: 'POST', body: JSON.stringify(body) });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            setDisabled('tpCreateSubmitBtn', false);
            closeCreateProfileModal();
            showToast('Taxpayer profile created.');
            loadSummary();
            loadProfiles();
        } catch(e) {
            setDisabled('tpCreateSubmitBtn', false);
            showError('tpCreateError', e.message || 'Failed to create profile.');
        }
    }

    /* ── Detail modal ──────────────────────────────────────── */
    async function openDetailModal(profileId) {
        _activeProfile = null;
        // Reset tabs
        ['Overview','Income','Deductions','Readiness'].forEach(function (t, i) {
            var panel = document.getElementById('tpTab' + t);
            if (panel) panel.classList.toggle('active', i === 0);
        });
        document.querySelectorAll('.tp-tab').forEach(function (el, i) {
            el.classList.toggle('active', i === 0);
        });
        document.getElementById('tpDetailModal').classList.remove('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + profileId);
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            _activeProfile = data.profile || data;
            renderDetailHeader(_activeProfile);
            renderOverviewTab(_activeProfile);
            loadIncomeSources(_activeProfile.id);
            loadDeductions(_activeProfile.id);
            loadReadinessItems(_activeProfile.id);
        } catch(e) {
            document.getElementById('tpDetailTitle').textContent = 'Error loading profile';
        }
    }
    function closeTpDetailModal() {
        document.getElementById('tpDetailModal').classList.add('hidden');
        _activeProfile = null;
    }

    function renderDetailHeader(p) {
        var clientName = p.client_name || p.client_display_name || 'Unknown Client';
        document.getElementById('tpDetailTitle').textContent = clientName + ' — Taxpayer Profile';
        document.getElementById('tpDClientName').textContent = clientName;

        var parts = [_typeLabels[p.taxpayer_type] || p.taxpayer_type];
        if (p.income_tax_reference) parts.push('Ref: ' + p.income_tax_reference);
        document.getElementById('tpDSub').textContent = parts.join('  ·  ');

        document.getElementById('tpDTypeBadge').innerHTML =
            '<span class="tp-type-badge tp-type-' + p.taxpayer_type + '">' +
            esc(_typeLabels[p.taxpayer_type] || p.taxpayer_type) + '</span>';
    }

    function renderOverviewTab(p) {
        var grid = document.getElementById('tpDOverviewGrid');
        if (!grid) return;

        var rows = [
            ['Taxpayer Type',  _typeLabels[p.taxpayer_type]     || p.taxpayer_type],
            ['Tax Status',     _taxStatusLabels[p.tax_status]   || p.tax_status],
            ['Income Tax Ref', p.income_tax_reference           || '—'],
            ['Provisional',    p.provisional_taxpayer           ? 'Yes' : 'No'],
            ['VAT Registered', p.vat_registered                 ? 'Yes' : 'No'],
            ['PAYE Registered',p.paye_registered                ? 'Yes' : 'No']
        ];
        if (p.taxpayer_type === 'individual') {
            rows.push(['ID Number',     p.id_number       || '—']);
            rows.push(['Passport',      p.passport_number || '—']);
            rows.push(['Marital Status',p.marital_status  ? p.marital_status.charAt(0).toUpperCase() + p.marital_status.slice(1) : '—']);
        } else {
            rows.push(['Registration #', p.registration_number || '—']);
            rows.push(['Fin. Year End',  p.financial_year_end  || '—']);
        }

        grid.innerHTML = rows.map(function (r) {
            return '<div class="tp-overview-field"><label>' + esc(r[0]) + '</label><span>' + esc(String(r[1])) + '</span></div>';
        }).join('');

        var sel = document.getElementById('tpDTaxStatusSel');
        if (sel) sel.value = p.tax_status || 'active';

        renderReadinessBar(p.readiness_score, p.readiness_status);
    }

    function renderReadinessBar(score, status) {
        var label    = document.getElementById('tpDReadinessLabel');
        var scoreLbl = document.getElementById('tpDScoreLabel');
        var bar      = document.getElementById('tpDScoreBar');
        if (!bar) return;
        var pct = score != null ? score : 0;
        bar.style.width = pct + '%';
        bar.className   = 'tp-score-bar-fill' +
            (status === 'ready' ? ' ready' : status === 'partial' ? ' partial' : status === 'blocked' ? ' blocked' : '');
        if (label)    label.textContent   = _readinessLabels[status] || 'Readiness unknown';
        if (scoreLbl) scoreLbl.textContent = score != null ? score + '%' : '—';
    }

    /* ── Tax status update ─────────────────────────────────── */
    async function tpUpdateTaxStatus() {
        if (!_activeProfile) return;
        var newStatus = val('tpDTaxStatusSel');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id, {
                method: 'PUT',
                body: JSON.stringify({ tax_status: newStatus })
            });
            if (!res.ok) throw new Error('Update failed');
            _activeProfile.tax_status = newStatus;
            showToast('Tax status updated.');
            loadSummary();
            loadProfiles();
        } catch(e) {
            showToast('Error: ' + (e.message || 'Update failed.'));
        }
    }

    /* ── Recalculate readiness ─────────────────────────────── */
    async function tpRecalculate() {
        if (!_activeProfile) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/recalculate-readiness', { method: 'POST' });
            if (!res.ok) throw new Error('Recalculate failed');
            var data = await res.json();
            if (data.readiness) {
                _activeProfile.readiness_score  = data.readiness.score;
                _activeProfile.readiness_status = data.readiness.readiness_status;
                renderReadinessBar(data.readiness.score, data.readiness.readiness_status);
            }
            showToast('Readiness recalculated.');
            loadSummary();
            loadProfiles();
        } catch(e) {
            showToast('Error: ' + (e.message || 'Recalculate failed.'));
        }
    }

    /* ── Generate default items ────────────────────────────── */
    async function tpGenerateDefaults() {
        if (!_activeProfile) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/generate-default-items', { method: 'POST' });
            if (res.status === 409) {
                if (!confirm('This profile already has readiness items. Regenerate and add any missing defaults?')) return;
                var res2 = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/generate-default-items?force=true', { method: 'POST' });
                if (!res2.ok) throw new Error('Generate failed');
            } else if (!res.ok) {
                throw new Error('Generate failed');
            }
            showToast('Default items generated.');
            loadReadinessItems(_activeProfile.id);
            tpRecalculate();
        } catch(e) {
            showToast('Error: ' + (e.message || 'Generate failed.'));
        }
    }

    /* ── Tab switching ─────────────────────────────────────── */
    function tpSwitchTab(tabKey, evt) {
        var panels = { overview: 'Overview', income: 'Income', deductions: 'Deductions', readiness: 'Readiness' };
        Object.keys(panels).forEach(function (k) {
            var panel = document.getElementById('tpTab' + panels[k]);
            if (panel) panel.classList.toggle('active', k === tabKey);
        });
        document.querySelectorAll('.tp-tab').forEach(function (el) { el.classList.remove('active'); });
        var clicked = evt && evt.target ? evt.target : null;
        if (clicked) clicked.classList.add('active');
    }

    /* ── Income Sources ────────────────────────────────────── */
    async function loadIncomeSources(profileId) {
        hide('tpDSourcesWrap'); hide('tpDSourcesEmpty');
        show('tpDSourcesLoading');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + profileId + '/income-sources');
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            hide('tpDSourcesLoading');
            renderSourceList(data.income_sources || []);
        } catch(e) {
            hide('tpDSourcesLoading');
        }
    }

    function renderSourceList(sources) {
        var wrap = document.getElementById('tpDSourcesWrap');
        if (!wrap) return;
        if (!sources.length) { show('tpDSourcesEmpty'); return; }
        wrap.innerHTML = sources.map(function (s) {
            return '<div class="tp-src-row">' +
                '<span class="tp-src-type">' + esc(_sourceLabels[s.income_type] || s.income_type) + '</span>' +
                '<span class="tp-src-label">' + esc(s.description || '') + '</span>' +
                '<button type="button" class="btn btn-ghost btn-xs" onclick="removeIncomeSource(' + s.id + ')">Remove</button>' +
                '</div>';
        }).join('');
        show('tpDSourcesWrap');
    }

    function openAddSourceModal() {
        clearError('tpAddSourceError');
        setVal('tpASType',  '');
        setVal('tpASDesc',  '');
        setVal('tpASNotes', '');
        document.getElementById('tpAddSourceModal').classList.remove('hidden');
    }
    function closeAddSourceModal() {
        document.getElementById('tpAddSourceModal').classList.add('hidden');
    }

    async function submitAddSource() {
        if (!_activeProfile) return;
        clearError('tpAddSourceError');
        var incomeType = val('tpASType');
        if (!incomeType) { showError('tpAddSourceError', 'Please select an income type.'); return; }

        setDisabled('tpAddSourceSubmitBtn', true);
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/income-sources', {
                method: 'POST',
                body: JSON.stringify({ income_type: incomeType, description: val('tpASDesc') || null, notes: val('tpASNotes') || null })
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            setDisabled('tpAddSourceSubmitBtn', false);
            closeAddSourceModal();
            showToast('Income source added.');
            loadIncomeSources(_activeProfile.id);
        } catch(e) {
            setDisabled('tpAddSourceSubmitBtn', false);
            showError('tpAddSourceError', e.message || 'Failed to add source.');
        }
    }

    async function removeIncomeSource(sourceId) {
        if (!_activeProfile) return;
        if (!confirm('Remove this income source?')) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/income-sources/' + sourceId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Remove failed');
            showToast('Income source removed.');
            loadIncomeSources(_activeProfile.id);
        } catch(e) {
            showToast('Error: ' + (e.message || 'Remove failed.'));
        }
    }

    /* ── Deductions ─────────────────────────────────────────── */
    async function loadDeductions(profileId) {
        hide('tpDDedsWrap'); hide('tpDDedsEmpty');
        show('tpDDedsLoading');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + profileId + '/deductions');
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            hide('tpDDedsLoading');
            renderDeductionList(data.deductions || []);
        } catch(e) {
            hide('tpDDedsLoading');
        }
    }

    function renderDeductionList(deds) {
        var wrap = document.getElementById('tpDDedsWrap');
        if (!wrap) return;
        if (!deds.length) { show('tpDDedsEmpty'); return; }
        wrap.innerHTML = deds.map(function (d) {
            return '<div class="tp-src-row">' +
                '<span class="tp-src-type">' + esc(_deductionLabels[d.deduction_type] || d.deduction_type) + '</span>' +
                '<span class="tp-src-label">' + esc(d.description || '') + '</span>' +
                '<button type="button" class="btn btn-ghost btn-xs" onclick="removeDeduction(' + d.id + ')">Remove</button>' +
                '</div>';
        }).join('');
        show('tpDDedsWrap');
    }

    function openAddDeductionModal() {
        clearError('tpAddDeductionError');
        setVal('tpADType', '');
        setVal('tpADDesc', '');
        document.getElementById('tpAddDeductionModal').classList.remove('hidden');
    }
    function closeAddDeductionModal() {
        document.getElementById('tpAddDeductionModal').classList.add('hidden');
    }

    async function submitAddDeduction() {
        if (!_activeProfile) return;
        clearError('tpAddDeductionError');
        var dedType = val('tpADType');
        if (!dedType) { showError('tpAddDeductionError', 'Please select a deduction type.'); return; }

        setDisabled('tpAddDeductionSubmitBtn', true);
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/deductions', {
                method: 'POST',
                body: JSON.stringify({ deduction_type: dedType, description: val('tpADDesc') || null })
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            setDisabled('tpAddDeductionSubmitBtn', false);
            closeAddDeductionModal();
            showToast('Deduction added.');
            loadDeductions(_activeProfile.id);
        } catch(e) {
            setDisabled('tpAddDeductionSubmitBtn', false);
            showError('tpAddDeductionError', e.message || 'Failed to add deduction.');
        }
    }

    async function removeDeduction(dedId) {
        if (!_activeProfile) return;
        if (!confirm('Remove this deduction?')) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/deductions/' + dedId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Remove failed');
            showToast('Deduction removed.');
            loadDeductions(_activeProfile.id);
        } catch(e) {
            showToast('Error: ' + (e.message || 'Remove failed.'));
        }
    }

    /* ── Readiness Items ────────────────────────────────────── */
    async function loadReadinessItems(profileId) {
        hide('tpDItemsWrap'); hide('tpDItemsEmpty');
        show('tpDItemsLoading');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + profileId + '/readiness');
            if (!res.ok) throw new Error('Load failed');
            var data = await res.json();
            hide('tpDItemsLoading');
            if (data.readiness) {
                renderReadinessBar(data.readiness.score, data.readiness.readiness_status);
            }
            renderReadinessItemList(data.items || []);
        } catch(e) {
            hide('tpDItemsLoading');
        }
    }

    function renderReadinessItemList(items) {
        var wrap = document.getElementById('tpDItemsWrap');
        if (!wrap) return;
        if (!items.length) { show('tpDItemsEmpty'); return; }
        wrap.innerHTML = items.map(function (item) {
            var statusClass = _itemStatusClass[item.status] || 'tp-item-required';
            var statusLabel = _itemStatusLabels[item.status] || item.status;
            var optLabel    = !item.required ? '<span class="tp-item-opt">(optional)</span>' : '';
            var actionBtns  = '';
            if (item.status !== 'completed' && item.status !== 'waived') {
                actionBtns += '<button type="button" class="btn btn-ghost btn-xs" onclick="tpItemMarkReceived(' + item.id + ')">Received</button>';
                actionBtns += '<button type="button" class="btn btn-ghost btn-xs" onclick="tpItemMarkCompleted(' + item.id + ')">Done</button>';
            }
            if (item.status !== 'blocked') {
                actionBtns += '<button type="button" class="btn btn-ghost btn-xs" onclick="tpItemMarkBlocked(' + item.id + ')">Block</button>';
            }
            if (item.status !== 'waived') {
                actionBtns += '<button type="button" class="btn btn-ghost btn-xs" onclick="tpItemMarkWaived(' + item.id + ')">Waive</button>';
            }
            return '<div class="tp-item-row">' +
                '<span class="tp-item-name">' + esc(item.item_name) + ' ' + optLabel + '</span>' +
                '<span class="tp-item-badge ' + statusClass + '">' + statusLabel + '</span>' +
                '<div style="display:flex;gap:3px;">' + actionBtns + '</div>' +
                '</div>';
        }).join('');
        show('tpDItemsWrap');
    }

    async function _tpUpdateItemStatus(itemId, status) {
        if (!_activeProfile) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/readiness-items/' + itemId, {
                method: 'PUT',
                body: JSON.stringify({ status: status })
            });
            if (!res.ok) throw new Error('Update failed');
            showToast('Item updated.');
            loadReadinessItems(_activeProfile.id);
            tpRecalculate();
        } catch(e) {
            showToast('Error: ' + (e.message || 'Update failed.'));
        }
    }

    function tpItemMarkReceived(itemId)  { _tpUpdateItemStatus(itemId, 'received');  }
    function tpItemMarkCompleted(itemId) { _tpUpdateItemStatus(itemId, 'completed'); }
    function tpItemMarkBlocked(itemId)   { _tpUpdateItemStatus(itemId, 'blocked');   }
    function tpItemMarkWaived(itemId)    { _tpUpdateItemStatus(itemId, 'waived');    }

    /* ── Add readiness item modal ───────────────────────────── */
    function openAddReadinessItemModal() {
        clearError('tpAddReadinessError');
        setVal('tpARIName',     '');
        setVal('tpARIRequired', 'true');
        setVal('tpARINotes',    '');
        document.getElementById('tpAddReadinessModal').classList.remove('hidden');
    }
    function closeAddReadinessItemModal() {
        document.getElementById('tpAddReadinessModal').classList.add('hidden');
    }

    async function submitAddReadinessItem() {
        if (!_activeProfile) return;
        clearError('tpAddReadinessError');
        var name = val('tpARIName').trim();
        if (!name) { showError('tpAddReadinessError', 'Item name is required.'); return; }

        setDisabled('tpAddReadinessSubmitBtn', true);
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeProfile.id + '/readiness-items', {
                method: 'POST',
                body: JSON.stringify({ item_name: name, required: val('tpARIRequired') === 'true', notes: val('tpARINotes') || null })
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            setDisabled('tpAddReadinessSubmitBtn', false);
            closeAddReadinessItemModal();
            showToast('Readiness item added.');
            loadReadinessItems(_activeProfile.id);
        } catch(e) {
            setDisabled('tpAddReadinessSubmitBtn', false);
            showError('tpAddReadinessError', e.message || 'Failed to add item.');
        }
    }

    /* ── DOM helpers ────────────────────────────────────────── */
    function val(id) {
        var el = document.getElementById(id);
        return el ? el.value : '';
    }
    function setVal(id, v) {
        var el = document.getElementById(id);
        if (el) el.value = v;
    }
    function setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }
    function show(id) {
        var el = document.getElementById(id);
        if (el) el.classList.remove('hidden');
    }
    function hide(id) {
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    }
    function setDisabled(id, state) {
        var el = document.getElementById(id);
        if (el) el.disabled = state;
    }
    function getChecked(id) {
        var el = document.getElementById(id);
        return el ? el.checked : false;
    }
    function setChecked(id, v) {
        var el = document.getElementById(id);
        if (el) el.checked = v;
    }
    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ── Expose public interface ────────────────────────────── */
    window.loadProfiles               = loadProfiles;
    window.openCreateProfileModal     = openCreateProfileModal;
    window.closeCreateProfileModal    = closeCreateProfileModal;
    window.tpToggleIndividualFields   = tpToggleIndividualFields;
    window.submitCreateProfile        = submitCreateProfile;
    window.openDetailModal            = openDetailModal;
    window.closeTpDetailModal         = closeTpDetailModal;
    window.tpSwitchTab                = tpSwitchTab;
    window.tpUpdateTaxStatus          = tpUpdateTaxStatus;
    window.tpRecalculate              = tpRecalculate;
    window.tpGenerateDefaults         = tpGenerateDefaults;
    window.openAddSourceModal         = openAddSourceModal;
    window.closeAddSourceModal        = closeAddSourceModal;
    window.submitAddSource            = submitAddSource;
    window.removeIncomeSource         = removeIncomeSource;
    window.openAddDeductionModal      = openAddDeductionModal;
    window.closeAddDeductionModal     = closeAddDeductionModal;
    window.submitAddDeduction         = submitAddDeduction;
    window.removeDeduction            = removeDeduction;
    window.openAddReadinessItemModal  = openAddReadinessItemModal;
    window.closeAddReadinessItemModal = closeAddReadinessItemModal;
    window.submitAddReadinessItem     = submitAddReadinessItem;
    window.tpItemMarkReceived         = tpItemMarkReceived;
    window.tpItemMarkCompleted        = tpItemMarkCompleted;
    window.tpItemMarkBlocked          = tpItemMarkBlocked;
    window.tpItemMarkWaived           = tpItemMarkWaived;

    /* ── Boot ───────────────────────────────────────────────── */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
