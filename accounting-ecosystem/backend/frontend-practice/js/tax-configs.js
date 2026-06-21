/* =============================================================
   Tax Config — Lorenco Practice (Codebox 29)
   IIFE pattern — all state local, exports on window for onclick handlers.
   ============================================================= */
(function () {
    'use strict';

    var _BASE        = '/api/practice/tax-configs';
    var _activeConfig = null;
    var _activeBrackets = [];
    var _activeTab   = 'overview';
    var _editBracketId = null;

    // ── Helpers ───────────────────────────────────────────────────────────────

    function show(id) { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hide(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }

    function esc(str) {
        var d = document.createElement('div');
        d.textContent = String(str == null ? '' : str);
        return d.innerHTML;
    }

    function fmtNum(n, dp) {
        if (n == null) return '—';
        return parseFloat(n).toLocaleString('en-ZA', {
            minimumFractionDigits: dp != null ? dp : 2,
            maximumFractionDigits: dp != null ? dp : 2,
        });
    }

    function statusBadge(s) {
        var cls = { active: 'tc-badge-active', draft: 'tc-badge-draft', archived: 'tc-badge-archived' };
        return '<span class="tc-badge ' + (cls[s] || 'tc-badge-draft') + '">' + esc(s) + '</span>';
    }

    // ── Init ─────────────────────────────────────────────────────────────────

    async function init() {
        LAYOUT.init('tax-configs');
        if (typeof PracticeAPI !== 'undefined' && PracticeAPI.requireAuth) {
            var ok = await PracticeAPI.requireAuth();
            if (!ok) return;
        }
        await loadConfigs();
    }

    // ── Load config list ──────────────────────────────────────────────────────

    async function loadConfigs() {
        show('tcListLoading');
        hide('tcListEmpty');
        document.getElementById('tcConfigList').innerHTML = '';

        var year   = document.getElementById('tcFilterYear')  ? document.getElementById('tcFilterYear').value   : '';
        var status = document.getElementById('tcFilterStatus') ? document.getElementById('tcFilterStatus').value : '';

        var url = _BASE + '?';
        if (year)   url += 'tax_year=' + encodeURIComponent(year) + '&';
        if (status) url += 'status='   + encodeURIComponent(status) + '&';

        try {
            var res = await PracticeAPI.fetch(url);
            if (!res.ok) throw new Error('Failed to load configs');
            var data = await res.json();
            var configs = data.configs || [];

            hide('tcListLoading');

            if (configs.length === 0) {
                show('tcListEmpty');
                return;
            }

            document.getElementById('tcConfigList').innerHTML = configs.map(function (c) {
                var cardClass = 'tc-config-card ' + (c.status === 'active' ? 'tc-active' : c.status === 'archived' ? 'tc-archived' : 'tc-draft');
                var locked    = c.locked_at ? ' 🔒' : '';
                var scopeLabel = c.company_id == null ? 'Global' : 'Company #' + c.company_id;
                return '<div class="' + cardClass + '">' +
                    '<div class="tc-config-header">' +
                        '<div>' +
                            '<div class="tc-config-name">' + esc(c.config_name) + locked + '</div>' +
                            '<div class="tc-config-meta">Tax Year: ' + c.tax_year + ' &nbsp;|&nbsp; ' + esc(c.country_code) + ' &nbsp;|&nbsp; Scope: ' + scopeLabel + '</div>' +
                            (c.source_note ? '<div class="tc-config-meta">' + esc(c.source_note) + '</div>' : '') +
                        '</div>' +
                        statusBadge(c.status) +
                    '</div>' +
                    '<div class="tc-config-actions">' +
                        '<button class="btn btn-ghost btn-sm" onclick="openDetailModal(' + c.id + ')">Edit / View</button>' +
                        (c.status !== 'active' && !c.locked_at ? '<button class="btn btn-secondary btn-sm" onclick="quickActivate(' + c.id + ')">Activate</button>' : '') +
                        (c.status !== 'archived' ? '<button class="btn btn-ghost btn-sm" onclick="quickArchive(' + c.id + ')">Archive</button>' : '') +
                    '</div>' +
                '</div>';
            }).join('');
        } catch (e) {
            hide('tcListLoading');
            PracticeAPI.showToast(e.message || 'Error loading configs', 'error');
        }
    }

    // ── Quick actions from list ───────────────────────────────────────────────

    async function quickActivate(id) {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + id + '/activate', { method: 'PUT' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            PracticeAPI.showToast('Config activated!');
            loadConfigs();
        } catch (e) { PracticeAPI.showToast(e.message || 'Failed to activate', 'error'); }
    }

    async function quickArchive(id) {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + id + '/archive', { method: 'PUT' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            PracticeAPI.showToast('Config archived.');
            loadConfigs();
        } catch (e) { PracticeAPI.showToast(e.message || 'Failed to archive', 'error'); }
    }

    // ── Detail modal ──────────────────────────────────────────────────────────

    async function openDetailModal(configId) {
        _activeConfig   = null;
        _activeBrackets = [];
        _editBracketId  = null;
        document.getElementById('tcDetailModal').classList.remove('hidden');
        tcSwitchTab('overview', document.querySelector('.tc-tab-btn'));

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + configId);
            if (!res.ok) throw new Error('Failed to load config');
            var data = await res.json();
            _activeConfig   = data.config;
            _activeBrackets = data.brackets || [];
            _renderDetailOverview();
            _renderBrackets();
            _renderRebates();
            _renderLimits();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Error loading config', 'error');
            closeTcDetailModal();
        }
    }

    function closeTcDetailModal() {
        document.getElementById('tcDetailModal').classList.add('hidden');
        _activeConfig   = null;
        _activeBrackets = [];
    }

    function _renderDetailOverview() {
        var c = _activeConfig;
        document.getElementById('tcDetailTitle').textContent = c.config_name + ' (' + c.tax_year + ')';
        document.getElementById('tcDYear').textContent    = c.tax_year;
        document.getElementById('tcDCountry').textContent = c.country_code;
        document.getElementById('tcDStatusBadge').innerHTML = statusBadge(c.status);
        document.getElementById('tcDName').value       = c.config_name || '';
        document.getElementById('tcDEffFrom').value    = c.effective_from  ? c.effective_from.slice(0, 10)  : '';
        document.getElementById('tcDEffTo').value      = c.effective_to    ? c.effective_to.slice(0, 10)    : '';
        document.getElementById('tcDSourceNote').value = c.source_note || '';
        document.getElementById('tcDNotes').value      = c.notes       || '';

        var locked = !!c.locked_at;
        document.getElementById('tcDLockInfo').textContent = locked
            ? 'Locked at ' + new Date(c.locked_at).toLocaleString() + '. Cannot edit.'
            : '';

        var activateBtn = document.getElementById('tcActivateBtn');
        var archiveBtn  = document.getElementById('tcArchiveBtn');
        var lockBtn     = document.getElementById('tcLockBtn');

        activateBtn.classList.toggle('hidden', c.status === 'active' || locked);
        archiveBtn.classList.toggle('hidden',  c.status === 'archived');
        lockBtn.classList.toggle('hidden',     locked);
    }

    function _renderRebates() {
        var c = _activeConfig;
        document.getElementById('tcRPrimary').value       = c.primary_rebate   != null ? c.primary_rebate   : '';
        document.getElementById('tcRSecondary').value     = c.secondary_rebate != null ? c.secondary_rebate : '';
        document.getElementById('tcRTertiary').value      = c.tertiary_rebate  != null ? c.tertiary_rebate  : '';
        document.getElementById('tcRThresh65').value      = c.tax_threshold_under_65 != null ? c.tax_threshold_under_65 : '';
        document.getElementById('tcRThresh74').value      = c.tax_threshold_65_to_74 != null ? c.tax_threshold_65_to_74 : '';
        document.getElementById('tcRThresh75').value      = c.tax_threshold_75_plus  != null ? c.tax_threshold_75_plus  : '';
        document.getElementById('tcRMedMain').value       = c.medical_credit_main_member      != null ? c.medical_credit_main_member      : '';
        document.getElementById('tcRMedFirst').value      = c.medical_credit_first_dependent  != null ? c.medical_credit_first_dependent  : '';
        document.getElementById('tcRMedAdditional').value = c.medical_credit_additional_dep   != null ? c.medical_credit_additional_dep   : '';
    }

    function _renderLimits() {
        var c = _activeConfig;
        document.getElementById('tcLRAPct').value  = c.retirement_annuity_pct_limit  != null ? c.retirement_annuity_pct_limit  : '';
        document.getElementById('tcLRACap').value  = c.retirement_annuity_annual_cap != null ? c.retirement_annuity_annual_cap : '';
        document.getElementById('tcLDonPct').value = c.donations_pct_limit           != null ? c.donations_pct_limit           : '';
    }

    function _renderBrackets() {
        var tbody = document.getElementById('tcBracketsBody');
        var empty = document.getElementById('tcBracketsEmpty');
        var locked = _activeConfig && !!_activeConfig.locked_at;

        if (!_activeBrackets || _activeBrackets.length === 0) {
            tbody.innerHTML = '';
            show('tcBracketsEmpty');
            return;
        }
        hide('tcBracketsEmpty');

        tbody.innerHTML = _activeBrackets.map(function (b) {
            var upper = b.upper_bound != null ? 'R ' + fmtNum(b.upper_bound, 0) : '(unlimited)';
            var editBtn = locked ? '' : '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="openEditBracketModal(' + b.id + ')">Edit</button>';
            return '<tr>' +
                '<td>' + b.bracket_order + '</td>' +
                '<td class="amt">R ' + fmtNum(b.lower_bound, 0) + '</td>' +
                '<td class="amt">' + upper + '</td>' +
                '<td class="amt">R ' + fmtNum(b.base_tax, 2) + '</td>' +
                '<td class="pct">' + parseFloat(b.marginal_rate).toFixed(4) + '%</td>' +
                '<td>' + editBtn + '</td>' +
            '</tr>';
        }).join('');

        var addBtn = document.getElementById('tcAddBracketBtn');
        if (addBtn) addBtn.classList.toggle('hidden', locked);
    }

    // ── Tab switching ─────────────────────────────────────────────────────────

    function tcSwitchTab(tabKey, btn) {
        _activeTab = tabKey;
        document.querySelectorAll('.tc-tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tc-tab-panel').forEach(function (p) { p.classList.remove('active'); });
        if (btn) btn.classList.add('active');

        var panelMap = {
            overview: 'tcTabOverview',
            brackets: 'tcTabBrackets',
            rebates:  'tcTabRebates',
            limits:   'tcTabLimits',
            history:  'tcTabHistory',
        };
        var panelId = panelMap[tabKey];
        if (panelId) document.getElementById(panelId).classList.add('active');

        if (tabKey === 'history') loadConfigHistory();
    }

    // ── Save overview ─────────────────────────────────────────────────────────

    async function tcSaveOverview() {
        if (!_activeConfig) return;
        var errEl = document.getElementById('tcDOverviewError');
        errEl.classList.add('hidden');

        var payload = {
            config_name:   document.getElementById('tcDName').value.trim(),
            effective_from: document.getElementById('tcDEffFrom').value  || null,
            effective_to:   document.getElementById('tcDEffTo').value    || null,
            source_note:    document.getElementById('tcDSourceNote').value.trim() || null,
            notes:          document.getElementById('tcDNotes').value.trim()      || null,
        };
        if (!payload.config_name) {
            errEl.textContent = 'Config name is required.';
            errEl.classList.remove('hidden');
            return;
        }

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeConfig = data.config;
            _renderDetailOverview();
            PracticeAPI.showToast('Saved!');
            loadConfigs();
        } catch (e) {
            errEl.textContent = e.message || 'Failed to save';
            errEl.classList.remove('hidden');
        }
    }

    // ── Save rebates ──────────────────────────────────────────────────────────

    async function tcSaveRebates() {
        if (!_activeConfig) return;
        var errEl = document.getElementById('tcRebatesError');
        errEl.classList.add('hidden');

        function numOrNull(id) { var v = document.getElementById(id).value; return v !== '' ? parseFloat(v) : null; }

        var payload = {
            primary_rebate:                  numOrNull('tcRPrimary'),
            secondary_rebate:                numOrNull('tcRSecondary'),
            tertiary_rebate:                 numOrNull('tcRTertiary'),
            tax_threshold_under_65:          numOrNull('tcRThresh65'),
            tax_threshold_65_to_74:          numOrNull('tcRThresh74'),
            tax_threshold_75_plus:           numOrNull('tcRThresh75'),
            medical_credit_main_member:      numOrNull('tcRMedMain'),
            medical_credit_first_dependent:  numOrNull('tcRMedFirst'),
            medical_credit_additional_dep:   numOrNull('tcRMedAdditional'),
        };

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeConfig = data.config;
            PracticeAPI.showToast('Rebates & credits saved!');
        } catch (e) {
            errEl.textContent = e.message || 'Failed to save';
            errEl.classList.remove('hidden');
        }
    }

    // ── Save limits ───────────────────────────────────────────────────────────

    async function tcSaveLimits() {
        if (!_activeConfig) return;
        var errEl = document.getElementById('tcLimitsError');
        errEl.classList.add('hidden');

        function numOrNull(id) { var v = document.getElementById(id).value; return v !== '' ? parseFloat(v) : null; }

        var payload = {
            retirement_annuity_pct_limit:  numOrNull('tcLRAPct'),
            retirement_annuity_annual_cap: numOrNull('tcLRACap'),
            donations_pct_limit:           numOrNull('tcLDonPct'),
        };

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeConfig = data.config;
            PracticeAPI.showToast('Deduction limits saved!');
        } catch (e) {
            errEl.textContent = e.message || 'Failed to save';
            errEl.classList.remove('hidden');
        }
    }

    // ── Activate / archive / lock ─────────────────────────────────────────────

    async function tcActivateConfig() {
        if (!_activeConfig) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/activate', { method: 'PUT' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeConfig = data.config;
            _renderDetailOverview();
            PracticeAPI.showToast('Config activated! Draft calculations will now use this config for tax year ' + _activeConfig.tax_year);
            loadConfigs();
        } catch (e) { PracticeAPI.showToast(e.message || 'Failed to activate', 'error'); }
    }

    async function tcArchiveConfig() {
        if (!_activeConfig) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/archive', { method: 'PUT' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeConfig = data.config;
            _renderDetailOverview();
            PracticeAPI.showToast('Config archived.');
            loadConfigs();
        } catch (e) { PracticeAPI.showToast(e.message || 'Failed to archive', 'error'); }
    }

    async function tcLockConfig() {
        if (!_activeConfig) return;
        if (!window.confirm('Lock this config? Brackets and values can no longer be edited after locking.')) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/lock', { method: 'PUT' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeConfig = data.config;
            _renderDetailOverview();
            _renderBrackets();
            PracticeAPI.showToast('Config locked.');
        } catch (e) { PracticeAPI.showToast(e.message || 'Failed to lock', 'error'); }
    }

    // ── Bracket — add form ────────────────────────────────────────────────────

    function openAddBracketForm() {
        show('tcAddBracketForm');
        hide('tcAddBracketError');
        document.getElementById('tcNBOrder').value  = '';
        document.getElementById('tcNBLower').value  = '';
        document.getElementById('tcNBUpper').value  = '';
        document.getElementById('tcNBBase').value   = '0';
        document.getElementById('tcNBRate').value   = '';
    }

    function closeAddBracketForm() {
        hide('tcAddBracketForm');
    }

    async function tcSubmitAddBracket() {
        if (!_activeConfig) return;
        var errEl = document.getElementById('tcAddBracketError');
        errEl.classList.add('hidden');

        var lowerVal = document.getElementById('tcNBLower').value;
        var upperVal = document.getElementById('tcNBUpper').value;
        var rateVal  = document.getElementById('tcNBRate').value;

        if (lowerVal === '') { errEl.textContent = 'Lower bound is required.'; show('tcAddBracketError'); return; }
        if (rateVal  === '') { errEl.textContent = 'Marginal rate is required.'; show('tcAddBracketError'); return; }

        var payload = {
            bracket_order: document.getElementById('tcNBOrder').value ? parseInt(document.getElementById('tcNBOrder').value) : null,
            lower_bound:   parseFloat(lowerVal),
            upper_bound:   upperVal !== '' ? parseFloat(upperVal) : null,
            base_tax:      document.getElementById('tcNBBase').value !== '' ? parseFloat(document.getElementById('tcNBBase').value) : 0,
            marginal_rate: parseFloat(rateVal),
        };

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/brackets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeBrackets.push(data.bracket);
            _activeBrackets.sort(function (a, b) { return a.bracket_order - b.bracket_order; });
            _renderBrackets();
            closeAddBracketForm();
            PracticeAPI.showToast('Bracket added!');
        } catch (e) {
            errEl.textContent = e.message || 'Failed to add bracket';
            show('tcAddBracketError');
        }
    }

    // ── Bracket — edit modal ──────────────────────────────────────────────────

    function openEditBracketModal(bracketId) {
        _editBracketId = bracketId;
        var b = _activeBrackets.find(function (x) { return x.id === bracketId; });
        if (!b) return;

        document.getElementById('tcEBOrder').value  = b.bracket_order;
        document.getElementById('tcEBLower').value  = b.lower_bound;
        document.getElementById('tcEBUpper').value  = b.upper_bound != null ? b.upper_bound : '';
        document.getElementById('tcEBBase').value   = b.base_tax;
        document.getElementById('tcEBRate').value   = b.marginal_rate;
        hide('tcEditBracketError');
        document.getElementById('tcEditBracketModal').classList.remove('hidden');
    }

    function closeEditBracketModal() {
        document.getElementById('tcEditBracketModal').classList.add('hidden');
        _editBracketId = null;
    }

    async function tcSubmitEditBracket() {
        if (!_activeConfig || !_editBracketId) return;
        var errEl = document.getElementById('tcEditBracketError');
        errEl.classList.add('hidden');

        var upperVal = document.getElementById('tcEBUpper').value;
        var payload = {
            bracket_order: parseInt(document.getElementById('tcEBOrder').value),
            lower_bound:   parseFloat(document.getElementById('tcEBLower').value),
            upper_bound:   upperVal !== '' ? parseFloat(upperVal) : null,
            base_tax:      parseFloat(document.getElementById('tcEBBase').value),
            marginal_rate: parseFloat(document.getElementById('tcEBRate').value),
        };

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/brackets/' + _editBracketId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            var idx = _activeBrackets.findIndex(function (x) { return x.id === _editBracketId; });
            if (idx >= 0) _activeBrackets[idx] = data.bracket;
            _activeBrackets.sort(function (a, b) { return a.bracket_order - b.bracket_order; });
            _renderBrackets();
            closeEditBracketModal();
            PracticeAPI.showToast('Bracket updated!');
        } catch (e) {
            errEl.textContent = e.message || 'Failed to update';
            show('tcEditBracketError');
        }
    }

    async function tcDeleteBracket() {
        if (!_activeConfig || !_editBracketId) return;
        if (!window.confirm('Delete this bracket?')) return;
        var errEl = document.getElementById('tcEditBracketError');
        errEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/brackets/' + _editBracketId, { method: 'DELETE' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            _activeBrackets = _activeBrackets.filter(function (x) { return x.id !== _editBracketId; });
            _renderBrackets();
            closeEditBracketModal();
            PracticeAPI.showToast('Bracket deleted.');
        } catch (e) {
            errEl.textContent = e.message || 'Failed to delete';
            show('tcEditBracketError');
        }
    }

    // ── History ───────────────────────────────────────────────────────────────

    async function loadConfigHistory() {
        if (!_activeConfig) return;
        show('tcHistoryLoading');
        document.getElementById('tcHistoryList').innerHTML = '';

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeConfig.id + '/events');
            if (!res.ok) throw new Error('Failed to load history');
            var data = await res.json();
            var events = data.events || [];
            hide('tcHistoryLoading');

            if (events.length === 0) {
                document.getElementById('tcHistoryList').innerHTML = '<div class="tc-empty">No events yet.</div>';
                return;
            }
            document.getElementById('tcHistoryList').innerHTML = events.map(function (e) {
                var when = new Date(e.created_at).toLocaleString();
                var status = e.new_status ? ' → ' + e.new_status : '';
                return '<div class="tc-seed-row"><span>' + esc(e.event_type) + esc(status) + (e.notes ? ' — ' + esc(e.notes) : '') + '</span><span style="color:var(--text-muted)">' + when + '</span></div>';
            }).join('');
        } catch (e) {
            hide('tcHistoryLoading');
            PracticeAPI.showToast(e.message || 'Error loading history', 'error');
        }
    }

    // ── Create config modal ───────────────────────────────────────────────────

    function openCreateConfigModal() {
        document.getElementById('tcCYear').value   = '';
        document.getElementById('tcCName').value   = '';
        document.getElementById('tcCSource').value = '';
        hide('tcCreateError');
        document.getElementById('tcCreateModal').classList.remove('hidden');
    }

    function closeTcCreateModal() {
        document.getElementById('tcCreateModal').classList.add('hidden');
    }

    async function tcSubmitCreate() {
        var errEl = document.getElementById('tcCreateError');
        errEl.classList.add('hidden');

        var year   = document.getElementById('tcCYear').value;
        var name   = document.getElementById('tcCName').value.trim();
        var source = document.getElementById('tcCSource').value.trim();

        if (!year) { errEl.textContent = 'Tax year is required.'; show('tcCreateError'); return; }
        if (!name) { errEl.textContent = 'Config name is required.'; show('tcCreateError'); return; }

        try {
            var res = await PracticeAPI.fetch(_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tax_year: parseInt(year), config_name: name, source_note: source || null }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            closeTcCreateModal();
            PracticeAPI.showToast('Config created! Opening detail editor…');
            loadConfigs();
            openDetailModal(data.config.id);
        } catch (e) {
            errEl.textContent = e.message || 'Failed to create';
            show('tcCreateError');
        }
    }

    // ── Seed modal ────────────────────────────────────────────────────────────

    function openSeedModal() {
        hide('tcSeedResultWrap');
        document.getElementById('tcSeedBtn').disabled = false;
        document.getElementById('tcSeedModal').classList.remove('hidden');
    }

    function closeSeedModal() {
        document.getElementById('tcSeedModal').classList.add('hidden');
    }

    async function tcRunSeed() {
        var btn = document.getElementById('tcSeedBtn');
        btn.disabled = true;

        try {
            var res = await PracticeAPI.fetch(_BASE + '/seed-from-js', { method: 'POST' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Seed failed'); }
            var data = await res.json();

            var seeded = data.seeded || [];
            var errors = data.errors || [];
            var html   = '';

            seeded.forEach(function (s) {
                var cls = s.action === 'created' ? 'tc-seed-ok' : 'tc-seed-skip';
                html += '<div class="tc-seed-row"><span class="' + cls + '">' + s.tax_year + ' — ' + esc(s.action) + (s.brackets != null ? ' (' + s.brackets + ' brackets)' : '') + '</span>' +
                        '<span style="color:var(--text-muted)">ID: ' + (s.config_id || '?') + '</span></div>';
            });
            errors.forEach(function (e) {
                html += '<div class="tc-seed-row"><span class="tc-seed-err">' + e.tax_year + ' — ERROR: ' + esc(e.error) + '</span></div>';
            });

            if (!html) html = '<div class="tc-seed-row"><span style="color:var(--text-muted)">Nothing to seed.</span></div>';

            document.getElementById('tcSeedResultWrap').innerHTML = html;
            show('tcSeedResultWrap');

            if (seeded.some(function (s) { return s.action === 'created'; })) {
                PracticeAPI.showToast('Seeded! Verify values before activating.');
                loadConfigs();
            }
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Seed failed', 'error');
            btn.disabled = false;
        }
    }

    // ── Window exports ────────────────────────────────────────────────────────

    window.loadConfigs          = loadConfigs;
    window.openDetailModal      = openDetailModal;
    window.closeTcDetailModal   = closeTcDetailModal;
    window.tcSwitchTab          = tcSwitchTab;
    window.tcSaveOverview       = tcSaveOverview;
    window.tcSaveRebates        = tcSaveRebates;
    window.tcSaveLimits         = tcSaveLimits;
    window.tcActivateConfig     = tcActivateConfig;
    window.tcArchiveConfig      = tcArchiveConfig;
    window.tcLockConfig         = tcLockConfig;
    window.openAddBracketForm   = openAddBracketForm;
    window.closeAddBracketForm  = closeAddBracketForm;
    window.tcSubmitAddBracket   = tcSubmitAddBracket;
    window.openEditBracketModal = openEditBracketModal;
    window.closeEditBracketModal= closeEditBracketModal;
    window.tcSubmitEditBracket  = tcSubmitEditBracket;
    window.tcDeleteBracket      = tcDeleteBracket;
    window.openCreateConfigModal= openCreateConfigModal;
    window.closeTcCreateModal   = closeTcCreateModal;
    window.tcSubmitCreate       = tcSubmitCreate;
    window.openSeedModal        = openSeedModal;
    window.closeSeedModal       = closeSeedModal;
    window.tcRunSeed            = tcRunSeed;
    window.quickActivate        = quickActivate;
    window.quickArchive         = quickArchive;

    // ── Boot ──────────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
