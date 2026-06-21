/* =============================================================
   Individual Tax — Lorenco Practice Management  (Codebox 27)
   NOT tax calculation. NOT SARS submission. NOT eFiling.
   ============================================================= */
(function () {
    'use strict';

    var _BASE      = '/api/practice/individual-tax';
    var _CLIENTS_B = '/api/practice/clients';
    var _PROF_B    = '/api/practice/taxpayer-profiles';

    // Active state
    var _activeReturn  = null;  // full return object
    var _activeTab     = 'overview';
    var _createSubmitting = false;

    // ── Helpers ────────────────────────────────────────────────────────────────

    function show(id) { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hide(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }
    function esc(s)   { if (s == null) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

    function fmt(n) {
        if (n == null) return '—';
        return 'R ' + parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    var _STATUS_LABELS = {
        draft: 'Draft', collecting_docs: 'Collecting Docs', data_captured: 'Data Captured',
        ready_for_review: 'Ready for Review', reviewed: 'Reviewed',
        submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
    };

    var _READINESS_LABELS = {
        ready: 'Ready', partial: 'Partial', incomplete: 'Incomplete',
        blocked: 'Blocked', unknown: 'Unknown',
    };

    function statusBadge(s) {
        return '<span class="it-s-badge it-s-' + esc(s) + '">' + esc(_STATUS_LABELS[s] || s) + '</span>';
    }

    function readinessBadge(r) {
        return '<span class="it-r-badge it-r-' + esc(r || 'unknown') + '">' + esc(_READINESS_LABELS[r || 'unknown'] || r || 'Unknown') + '</span>';
    }

    // ── Init ───────────────────────────────────────────────────────────────────

    async function init() {
        LAYOUT.init('individual-tax');
        if (typeof PracticeAPI !== 'undefined' && PracticeAPI.requireAuth) {
            var ok = await PracticeAPI.requireAuth();
            if (!ok) return;
        }
        await Promise.all([loadClients(), loadSummary()]);
        loadReturns();
    }

    // ── Load clients for filter + create dropdowns ─────────────────────────────

    async function loadClients() {
        try {
            var res = await PracticeAPI.fetch(_CLIENTS_B + '?limit=500');
            if (!res.ok) return;
            var data = await res.json();
            var clients = data.clients || [];
            var fSel = document.getElementById('itFClient');
            var cSel = document.getElementById('itCClient');
            clients.forEach(function (c) {
                var label = c.display_name || c.company_name || ('Client #' + c.id);
                var opt1 = document.createElement('option');
                opt1.value = c.id; opt1.textContent = label;
                fSel.appendChild(opt1);
                var opt2 = document.createElement('option');
                opt2.value = c.id; opt2.textContent = label;
                cSel.appendChild(opt2);
            });
        } catch (_) {}
    }

    // ── Summary cards ──────────────────────────────────────────────────────────

    async function loadSummary() {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/summary');
            if (!res.ok) return;
            var data = await res.json();
            var s = data.summary || {};
            var by = s.by_status || {};
            var br = s.by_readiness || {};
            document.getElementById('itSumTotal').textContent        = s.total || 0;
            document.getElementById('itSumDraft').textContent        = (by.draft || 0) + (by.collecting_docs || 0);
            document.getElementById('itSumReady').textContent        = by.ready_for_review || 0;
            document.getElementById('itSumDone').textContent         = (by.reviewed || 0) + (by.submitted || 0) + (by.completed || 0);
            document.getElementById('itSumReadinessReady').textContent = br.ready || 0;
            document.getElementById('itSumBlocked').textContent      = br.blocked || 0;
        } catch (_) {}
    }

    // ── Returns list ───────────────────────────────────────────────────────────

    async function loadReturns() {
        var fClient   = document.getElementById('itFClient').value;
        var fYear     = document.getElementById('itFYear').value;
        var fStatus   = document.getElementById('itFStatus').value;
        var fReadiness= document.getElementById('itFReadiness').value;

        var params = new URLSearchParams();
        if (fClient)    params.set('client_id', fClient);
        if (fYear)      params.set('tax_year',  fYear);
        if (fStatus)    params.set('status',    fStatus);
        if (fReadiness) params.set('readiness_status', fReadiness);
        params.set('limit', '100');

        show('itTableLoading');
        hide('itTableEmpty');
        var tbody = document.getElementById('itTableBody');
        tbody.innerHTML = '';

        try {
            var res = await PracticeAPI.fetch(_BASE + '?' + params.toString());
            if (!res.ok) throw new Error('Failed to load returns');
            var data = await res.json();
            var returns = data.individual_tax_returns || [];

            hide('itTableLoading');
            if (returns.length === 0) { show('itTableEmpty'); return; }

            returns.forEach(function (r) {
                var tr = document.createElement('tr');
                tr.innerHTML =
                    '<td>' + esc(r.tax_year) + '</td>' +
                    '<td>' + esc(r.client_name || ('Client #' + r.client_id)) + '</td>' +
                    '<td>' + esc(r.return_name) + '</td>' +
                    '<td>' + statusBadge(r.status) + '</td>' +
                    '<td>' + readinessBadge(r.readiness_status) + '</td>' +
                    '<td>' + (r.readiness_score != null ? r.readiness_score + '%' : '—') + '</td>' +
                    '<td><button class="btn btn-ghost btn-sm" onclick="openDetailModal(' + r.id + ')">Open</button></td>';
                tbody.appendChild(tr);
            });
        } catch (e) {
            hide('itTableLoading');
            PracticeAPI.showToast(e.message || 'Error loading returns', 'error');
        }
    }

    function clearFilters() {
        document.getElementById('itFClient').value    = '';
        document.getElementById('itFYear').value      = '';
        document.getElementById('itFStatus').value    = '';
        document.getElementById('itFReadiness').value = '';
        loadReturns();
    }

    // ── Create return modal ────────────────────────────────────────────────────

    function openCreateModal() {
        hide('itCreateError');
        document.getElementById('itCClient').value    = '';
        document.getElementById('itCProfile').value   = '';
        document.getElementById('itCYear').value      = '';
        var nameEl = document.getElementById('itCName');
        nameEl.value = '';
        nameEl._manuallyEdited = false;
        document.getElementById('itCPlanId').value    = '';
        document.getElementById('itCPackId').value    = '';
        document.getElementById('itCNotes').value     = '';
        _createSubmitting = false;
        document.getElementById('itCreateSubmitBtn').disabled = false;
        document.getElementById('itCreateModal').classList.remove('hidden');
    }

    function closeCreateModal() {
        document.getElementById('itCreateModal').classList.add('hidden');
    }

    async function itClientChanged() {
        var clientId = document.getElementById('itCClient').value;
        var profSel  = document.getElementById('itCProfile');
        profSel.innerHTML = '<option value="">Select profile…</option>';
        if (!clientId) return;
        try {
            var res = await PracticeAPI.fetch(_PROF_B + '?client_id=' + clientId + '&limit=100');
            if (!res.ok) return;
            var data = await res.json();
            (data.taxpayer_profiles || []).forEach(function (p) {
                var opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.profile_name + ' (' + (p.taxpayer_type || 'individual') + ')';
                profSel.appendChild(opt);
            });
        } catch (_) {}
        itAutoName();
    }

    function itAutoName() {
        var nameEl = document.getElementById('itCName');
        if (nameEl._manuallyEdited) return;
        var year   = document.getElementById('itCYear').value;
        if (!year) return;
        nameEl.value = 'ITR12 ' + year;
    }

    async function submitCreateReturn() {
        if (_createSubmitting) return;
        var errEl     = document.getElementById('itCreateError');
        var clientId  = document.getElementById('itCClient').value;
        var profileId = document.getElementById('itCProfile').value;
        var year      = document.getElementById('itCYear').value;
        var name      = document.getElementById('itCName').value.trim();

        if (!clientId)  { errEl.textContent = 'Client is required.';           errEl.classList.remove('hidden'); return; }
        if (!profileId) { errEl.textContent = 'Taxpayer profile is required.'; errEl.classList.remove('hidden'); return; }
        if (!year)      { errEl.textContent = 'Tax year is required.';         errEl.classList.remove('hidden'); return; }
        if (!name)      { errEl.textContent = 'Return name is required.';      errEl.classList.remove('hidden'); return; }

        var planId = document.getElementById('itCPlanId').value;
        var packId = document.getElementById('itCPackId').value;

        _createSubmitting = true;
        document.getElementById('itCreateSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id:                      parseInt(clientId),
                    taxpayer_profile_id:            parseInt(profileId),
                    tax_year:                       parseInt(year),
                    return_name:                    name,
                    related_provisional_tax_plan_id:planId ? parseInt(planId) : null,
                    related_compliance_pack_id:     packId ? parseInt(packId) : null,
                    notes:                          document.getElementById('itCNotes').value.trim() || null,
                }),
            });
            if (!res.ok) {
                var d = await res.json();
                throw new Error(d.error || 'Failed to create return');
            }
            _createSubmitting = false;
            closeCreateModal();
            PracticeAPI.showToast('Tax return created!');
            loadSummary();
            loadReturns();
        } catch (e) {
            _createSubmitting = false;
            document.getElementById('itCreateSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create return.';
            errEl.classList.remove('hidden');
        }
    }

    // ── Detail modal ───────────────────────────────────────────────────────────

    async function openDetailModal(returnId) {
        _activeReturn = null;
        _activeTab    = 'overview';

        // Reset tabs
        document.querySelectorAll('.it-tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.it-tab-panel').forEach(function (p) { p.classList.remove('active'); });
        document.getElementById('itTabBtnOverview').classList.add('active');
        document.getElementById('itTabOverview').classList.add('active');
        hide('itDOverviewError');

        document.getElementById('itDetailModal').classList.remove('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + returnId);
            if (!res.ok) throw new Error('Failed to load return');
            var data = await res.json();
            _activeReturn = data.tax_return;
            _renderOverview();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Error loading return', 'error');
            closeDetailModal();
        }
    }

    function closeDetailModal() {
        document.getElementById('itDetailModal').classList.add('hidden');
        _activeReturn = null;
    }

    function _renderOverview() {
        var r = _activeReturn;
        document.getElementById('itDetailTitle').textContent = r.return_name + ' — Tax Year ' + r.tax_year;
        document.getElementById('itDTaxYear').textContent    = r.tax_year;
        document.getElementById('itDClient').textContent     = r.client_name || ('Client #' + r.client_id);
        document.getElementById('itDStatusBadge').innerHTML  = statusBadge(r.status);
        document.getElementById('itDReadinessBadge').innerHTML = readinessBadge(r.readiness_status);

        var pct  = r.readiness_score != null ? r.readiness_score : 0;
        document.getElementById('itDReadinessBar').style.width = pct + '%';
        document.getElementById('itDReadinessPct').textContent = r.readiness_score != null ? pct + '%' : '—';

        document.getElementById('itDNotes').value         = r.notes          || '';
        document.getElementById('itDInternalNotes').value = r.internal_notes || '';
        document.getElementById('itDUpdateStatus').value  = '';
    }

    async function itSaveOverview() {
        if (!_activeReturn) return;
        var errEl = document.getElementById('itDOverviewError');
        errEl.classList.add('hidden');
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    notes:          document.getElementById('itDNotes').value.trim()         || null,
                    internal_notes: document.getElementById('itDInternalNotes').value.trim() || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Save failed'); }
            var data = await res.json();
            _activeReturn = data.tax_return;
            PracticeAPI.showToast('Saved!');
        } catch (e) {
            errEl.textContent = e.message || 'Save failed.';
            errEl.classList.remove('hidden');
        }
    }

    async function itSaveStatus() {
        if (!_activeReturn) return;
        var status = document.getElementById('itDUpdateStatus').value;
        if (!status) { PracticeAPI.showToast('Select a status first', 'error'); return; }
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeReturn = data.tax_return;
            _renderOverview();
            PracticeAPI.showToast('Status updated!');
            loadReturns();
            loadSummary();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to update status', 'error');
        }
    }

    async function itRecalcReadiness() {
        if (!_activeReturn) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/recalculate-readiness', { method: 'POST' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeReturn.readiness_score  = data.readiness.score;
            _activeReturn.readiness_status = data.readiness.readiness_status;
            _renderOverview();
            PracticeAPI.showToast('Readiness recalculated!');
            loadReturns();
            loadSummary();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to recalculate readiness', 'error');
        }
    }

    async function itGenerateItems() {
        if (!_activeReturn) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/generate-default-items', { method: 'POST' });
            if (res.status === 409) {
                // Try force append missing items
                var res2 = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/generate-default-items?force=true', { method: 'POST' });
                if (!res2.ok) {
                    var d2 = await res2.json();
                    throw new Error(d2.error || 'Failed');
                }
                var data2 = await res2.json();
                PracticeAPI.showToast(data2.inserted > 0 ? 'Added ' + data2.inserted + ' missing item(s).' : 'All default items already exist.');
            } else if (!res.ok) {
                var d = await res.json();
                throw new Error(d.error || 'Failed');
            } else {
                var data = await res.json();
                PracticeAPI.showToast('Generated ' + data.inserted + ' checklist item(s)!');
            }
            // If currently on items tab, refresh it
            if (_activeTab === 'items') loadItems();
            itSwitchTab('items', document.getElementById('itTabBtnItems'));
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to generate checklist', 'error');
        }
    }

    // ── Tab switching ──────────────────────────────────────────────────────────

    function itSwitchTab(tabKey, btn) {
        _activeTab = tabKey;
        document.querySelectorAll('.it-tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.it-tab-panel').forEach(function (p) { p.classList.remove('active'); });
        if (btn) btn.classList.add('active');

        var panelMap = {
            overview:       'itTabOverview',
            items:          'itTabItems',
            income:         'itTabIncome',
            deductions:     'itTabDed',
            events:         'itTabHistory',
            calculations:   'itTabCalc',
            'review-packs': 'itTabReviewPacks',
        };
        var panelId = panelMap[tabKey];
        if (panelId) document.getElementById(panelId).classList.add('active');

        if (tabKey === 'items')         loadItems();
        if (tabKey === 'income')        loadIncome();
        if (tabKey === 'deductions')    loadDeductions();
        if (tabKey === 'events')        loadEvents();
        if (tabKey === 'calculations')  loadCalculations();
    }

    // ── Checklist items ────────────────────────────────────────────────────────

    var _ITEM_STATUS_OPTS = [
        'required', 'requested', 'received', 'captured', 'reviewed', 'waived', 'blocked', 'not_applicable',
    ];

    var _ITEM_STATUS_LABELS = {
        required: 'Required', requested: 'Requested', received: 'Received',
        captured: 'Captured', reviewed: 'Reviewed', waived: 'Waived',
        blocked: 'Blocked', not_applicable: 'N/A',
    };

    async function loadItems() {
        if (!_activeReturn) return;
        show('itItemsLoading');
        document.getElementById('itItemsList').innerHTML = '';
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/items');
            if (!res.ok) throw new Error('Failed to load items');
            var data = await res.json();
            hide('itItemsLoading');
            _renderItems(data.items || []);
        } catch (e) {
            hide('itItemsLoading');
            PracticeAPI.showToast(e.message || 'Error loading items', 'error');
        }
    }

    function _renderItems(items) {
        var list = document.getElementById('itItemsList');
        if (items.length === 0) {
            list.innerHTML = '<div class="it-empty">No items yet. Click "Generate Checklist" to create defaults.</div>';
            return;
        }
        list.innerHTML = items.map(function (item) {
            var statusOpts = _ITEM_STATUS_OPTS.map(function (s) {
                return '<option value="' + s + '"' + (item.item_status === s ? ' selected' : '') + '>' + (_ITEM_STATUS_LABELS[s] || s) + '</option>';
            }).join('');
            return '<div class="it-item-row">' +
                '<div class="it-item-label">' + esc(item.item_label) + '</div>' +
                '<select class="it-item-status-sel" data-id="' + item.id + '" onchange="itUpdateItemStatus(this)" title="Status">' + statusOpts + '</select>' +
                '<button class="it-item-del-btn" onclick="itDeleteItem(' + item.id + ')" title="Remove">✕</button>' +
            '</div>';
        }).join('');
    }

    async function itUpdateItemStatus(sel) {
        if (!_activeReturn) return;
        var itemId = parseInt(sel.getAttribute('data-id'));
        var status = sel.value;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/items/' + itemId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_status: status }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to update item', 'error');
        }
    }

    async function itDeleteItem(itemId) {
        if (!_activeReturn) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/items/' + itemId, { method: 'DELETE' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            loadItems();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to delete item', 'error');
        }
    }

    function openAddItemForm() {
        document.getElementById('itNewItemType').value  = '';
        document.getElementById('itNewItemLabel').value = '';
        show('itAddItemForm');
    }

    function closeAddItemForm() { hide('itAddItemForm'); }

    async function submitAddItem() {
        if (!_activeReturn) return;
        var type  = document.getElementById('itNewItemType').value;
        var label = document.getElementById('itNewItemLabel').value.trim();
        if (!type)  { PracticeAPI.showToast('Select an item type', 'error');   return; }
        if (!label) { PracticeAPI.showToast('Label is required', 'error'); return; }
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_type: type, item_label: label }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            closeAddItemForm();
            loadItems();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to add item', 'error');
        }
    }

    // ── Income entries ─────────────────────────────────────────────────────────

    var _incomeEntries = [];

    async function loadIncome() {
        if (!_activeReturn) return;
        show('itIncomeLoading');
        document.getElementById('itIncomeList').innerHTML = '';
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/income');
            if (!res.ok) throw new Error('Failed to load income');
            var data = await res.json();
            _incomeEntries = data.income_entries || [];
            hide('itIncomeLoading');
            var t = data.totals || {};
            document.getElementById('itIncomeTotals').textContent =
                'Gross: ' + fmt(t.gross_total) + '  |  Tax Withheld: ' + fmt(t.withheld_total);
            _renderIncome(_incomeEntries);
        } catch (e) {
            hide('itIncomeLoading');
            PracticeAPI.showToast(e.message || 'Error loading income', 'error');
        }
    }

    function _renderIncome(entries) {
        var list = document.getElementById('itIncomeList');
        if (entries.length === 0) {
            list.innerHTML = '<div class="it-empty">No income entries yet.</div>';
            return;
        }
        list.innerHTML = entries.map(function (e) {
            return '<div class="it-entry-row">' +
                '<div class="it-entry-header">' +
                    '<div>' +
                        '<div class="it-entry-type-label">' + esc(e.income_type) + '</div>' +
                        '<div class="it-entry-desc">' + esc(e.description || '—') + '</div>' +
                        (e.source_reference ? '<div class="it-entry-ref">Ref: ' + esc(e.source_reference) + '</div>' : '') +
                    '</div>' +
                    '<div style="text-align:right">' +
                        '<div class="it-entry-amount">' + fmt(e.gross_amount) + '</div>' +
                        '<div class="it-entry-ref">PAYE: ' + fmt(e.tax_withheld) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:flex;gap:6px;margin-top:6px">' +
                    '<button class="btn btn-ghost btn-sm" onclick="openEditIncomeModal(' + e.id + ')">Edit</button>' +
                    '<button class="btn btn-ghost btn-sm" style="color:var(--danger,#eb5757)" onclick="deleteIncome(' + e.id + ')">Delete</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    function openAddIncomeForm() {
        document.getElementById('itNewIncType').value     = '';
        document.getElementById('itNewIncDesc').value     = '';
        document.getElementById('itNewIncGross').value    = '';
        document.getElementById('itNewIncWithheld').value = '';
        document.getElementById('itNewIncRef').value      = '';
        show('itAddIncomeForm');
    }

    function closeAddIncomeForm() { hide('itAddIncomeForm'); }

    async function submitAddIncome() {
        if (!_activeReturn) return;
        var type = document.getElementById('itNewIncType').value;
        if (!type) { PracticeAPI.showToast('Select income type', 'error'); return; }
        var gross    = document.getElementById('itNewIncGross').value;
        var withheld = document.getElementById('itNewIncWithheld').value;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/income', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    income_type:      type,
                    description:      document.getElementById('itNewIncDesc').value.trim() || null,
                    gross_amount:     gross    ? parseFloat(gross)    : null,
                    tax_withheld:     withheld ? parseFloat(withheld) : null,
                    source_reference: document.getElementById('itNewIncRef').value.trim()  || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            closeAddIncomeForm();
            loadIncome();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to add income entry', 'error');
        }
    }

    function openEditIncomeModal(incomeId) {
        var entry = _incomeEntries.find(function (e) { return e.id === incomeId; });
        if (!entry) return;
        document.getElementById('itEditIncId').value    = entry.id;
        document.getElementById('itEditIncType').value  = entry.income_type || '';
        document.getElementById('itEditIncDesc').value  = entry.description || '';
        document.getElementById('itEditIncGross').value = entry.gross_amount != null ? entry.gross_amount : '';
        document.getElementById('itEditIncWith').value  = entry.tax_withheld != null ? entry.tax_withheld : '';
        document.getElementById('itEditIncRef').value   = entry.source_reference || '';
        document.getElementById('itEditIncomeModal').classList.remove('hidden');
    }

    function closeEditIncomeModal() { document.getElementById('itEditIncomeModal').classList.add('hidden'); }

    async function submitEditIncome() {
        if (!_activeReturn) return;
        var incomeId = parseInt(document.getElementById('itEditIncId').value);
        var gross    = document.getElementById('itEditIncGross').value;
        var withheld = document.getElementById('itEditIncWith').value;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/income/' + incomeId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    income_type:      document.getElementById('itEditIncType').value,
                    description:      document.getElementById('itEditIncDesc').value.trim() || null,
                    gross_amount:     gross    ? parseFloat(gross)    : null,
                    tax_withheld:     withheld ? parseFloat(withheld) : null,
                    source_reference: document.getElementById('itEditIncRef').value.trim()  || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            closeEditIncomeModal();
            loadIncome();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to save income entry', 'error');
        }
    }

    async function deleteIncome(incomeId) {
        if (!_activeReturn) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/income/' + incomeId, { method: 'DELETE' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            loadIncome();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to delete income entry', 'error');
        }
    }

    // ── Deduction entries ──────────────────────────────────────────────────────

    var _dedEntries = [];

    async function loadDeductions() {
        if (!_activeReturn) return;
        show('itDedLoading');
        document.getElementById('itDedList').innerHTML = '';
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/deductions');
            if (!res.ok) throw new Error('Failed to load deductions');
            var data = await res.json();
            _dedEntries = data.deduction_entries || [];
            hide('itDedLoading');
            document.getElementById('itDedTotal').textContent = 'Total Deductions: ' + fmt(data.total_deductions);
            _renderDeductions(_dedEntries);
        } catch (e) {
            hide('itDedLoading');
            PracticeAPI.showToast(e.message || 'Error loading deductions', 'error');
        }
    }

    function _renderDeductions(entries) {
        var list = document.getElementById('itDedList');
        if (entries.length === 0) {
            list.innerHTML = '<div class="it-empty">No deduction entries yet.</div>';
            return;
        }
        list.innerHTML = entries.map(function (e) {
            return '<div class="it-entry-row">' +
                '<div class="it-entry-header">' +
                    '<div>' +
                        '<div class="it-entry-type-label">' + esc(e.deduction_type) + '</div>' +
                        '<div class="it-entry-desc">' + esc(e.description || '—') + '</div>' +
                        (e.source_reference ? '<div class="it-entry-ref">Ref: ' + esc(e.source_reference) + '</div>' : '') +
                    '</div>' +
                    '<div class="it-entry-amount">' + fmt(e.amount) + '</div>' +
                '</div>' +
                '<div style="display:flex;gap:6px;margin-top:6px">' +
                    '<button class="btn btn-ghost btn-sm" onclick="openEditDedModal(' + e.id + ')">Edit</button>' +
                    '<button class="btn btn-ghost btn-sm" style="color:var(--danger,#eb5757)" onclick="deleteDeduction(' + e.id + ')">Delete</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    function openAddDedForm() {
        document.getElementById('itNewDedType').value = '';
        document.getElementById('itNewDedDesc').value = '';
        document.getElementById('itNewDedAmt').value  = '';
        document.getElementById('itNewDedRef').value  = '';
        show('itAddDedForm');
    }

    function closeAddDedForm() { hide('itAddDedForm'); }

    async function submitAddDeduction() {
        if (!_activeReturn) return;
        var type = document.getElementById('itNewDedType').value;
        if (!type) { PracticeAPI.showToast('Select deduction type', 'error'); return; }
        var amt = document.getElementById('itNewDedAmt').value;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/deductions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deduction_type:   type,
                    description:      document.getElementById('itNewDedDesc').value.trim() || null,
                    amount:           amt ? parseFloat(amt) : null,
                    source_reference: document.getElementById('itNewDedRef').value.trim()  || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            closeAddDedForm();
            loadDeductions();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to add deduction', 'error');
        }
    }

    function openEditDedModal(dedId) {
        var entry = _dedEntries.find(function (e) { return e.id === dedId; });
        if (!entry) return;
        document.getElementById('itEditDedId').value   = entry.id;
        document.getElementById('itEditDedType').value = entry.deduction_type || '';
        document.getElementById('itEditDedDesc').value = entry.description    || '';
        document.getElementById('itEditDedAmt').value  = entry.amount != null ? entry.amount : '';
        document.getElementById('itEditDedRef').value  = entry.source_reference || '';
        document.getElementById('itEditDedModal').classList.remove('hidden');
    }

    function closeEditDedModal() { document.getElementById('itEditDedModal').classList.add('hidden'); }

    async function submitEditDeduction() {
        if (!_activeReturn) return;
        var dedId = parseInt(document.getElementById('itEditDedId').value);
        var amt   = document.getElementById('itEditDedAmt').value;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/deductions/' + dedId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deduction_type:   document.getElementById('itEditDedType').value,
                    description:      document.getElementById('itEditDedDesc').value.trim() || null,
                    amount:           amt ? parseFloat(amt) : null,
                    source_reference: document.getElementById('itEditDedRef').value.trim()  || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            closeEditDedModal();
            loadDeductions();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to save deduction', 'error');
        }
    }

    async function deleteDeduction(dedId) {
        if (!_activeReturn) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/deductions/' + dedId, { method: 'DELETE' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            loadDeductions();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to delete deduction', 'error');
        }
    }

    // ── Events / history ───────────────────────────────────────────────────────

    async function loadEvents() {
        if (!_activeReturn) return;
        show('itHistoryLoading');
        document.getElementById('itHistoryList').innerHTML = '';
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/events');
            if (!res.ok) throw new Error('Failed to load events');
            var data = await res.json();
            var events = data.events || [];
            hide('itHistoryLoading');

            if (events.length === 0) {
                document.getElementById('itHistoryList').innerHTML = '<div class="it-empty">No events recorded yet.</div>';
                return;
            }
            document.getElementById('itHistoryList').innerHTML = events.map(function (ev) {
                var transition = ev.old_status && ev.new_status
                    ? '<span style="color:var(--text-muted)"> → </span>' + esc(ev.new_status)
                    : '';
                return '<div class="it-event-row">' +
                    '<div class="it-event-type">' + esc(ev.event_type) + (ev.old_status ? ' &mdash; ' + esc(ev.old_status) + transition : '') + '</div>' +
                    (ev.notes ? '<div class="it-event-notes">' + esc(ev.notes) + '</div>' : '') +
                    '<div class="it-event-time">' + new Date(ev.created_at).toLocaleString('en-ZA') + '</div>' +
                '</div>';
            }).join('');
        } catch (e) {
            hide('itHistoryLoading');
            PracticeAPI.showToast(e.message || 'Error loading events', 'error');
        }
    }

    // ── Window exports ─────────────────────────────────────────────────────────

    window.openCreateModal     = openCreateModal;
    window.closeCreateModal    = closeCreateModal;
    window.itClientChanged     = itClientChanged;
    window.itAutoName          = itAutoName;
    window.submitCreateReturn  = submitCreateReturn;
    window.loadReturns         = loadReturns;
    window.clearFilters        = clearFilters;

    window.openDetailModal     = openDetailModal;
    window.closeDetailModal    = closeDetailModal;
    window.itSwitchTab         = itSwitchTab;
    window.itSaveOverview      = itSaveOverview;
    window.itSaveStatus        = itSaveStatus;
    window.itRecalcReadiness   = itRecalcReadiness;
    window.itGenerateItems     = itGenerateItems;

    window.itUpdateItemStatus  = itUpdateItemStatus;
    window.itDeleteItem        = itDeleteItem;
    window.openAddItemForm     = openAddItemForm;
    window.closeAddItemForm    = closeAddItemForm;
    window.submitAddItem       = submitAddItem;

    window.openAddIncomeForm   = openAddIncomeForm;
    window.closeAddIncomeForm  = closeAddIncomeForm;
    window.submitAddIncome     = submitAddIncome;
    window.openEditIncomeModal = openEditIncomeModal;
    window.closeEditIncomeModal= closeEditIncomeModal;
    window.submitEditIncome    = submitEditIncome;
    window.deleteIncome        = deleteIncome;

    window.openAddDedForm      = openAddDedForm;
    window.closeAddDedForm     = closeAddDedForm;
    window.submitAddDeduction  = submitAddDeduction;
    window.openEditDedModal    = openEditDedModal;
    window.closeEditDedModal   = closeEditDedModal;
    window.submitEditDeduction = submitEditDeduction;
    window.deleteDeduction     = deleteDeduction;

    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
    // CALCULATIONS (Codebox 28) — Draft Engine
    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

    var _activeCalc     = null;   // currently open calculation in the detail modal
    var _calcSubmitting = false;

    var _CALC_STATUS_LABELS = {
        draft:            'Draft',
        ready_for_review: 'Ready for Review',
        reviewed:         'Reviewed',
        approved:         'Approved',
        rejected:         'Rejected',
        cancelled:        'Cancelled',
    };

    function calcStatusBadge(s) {
        return '<span class="it-s-badge it-cs-' + esc(s) + '">' + esc(_CALC_STATUS_LABELS[s] || s) + '</span>';
    }

    function fmtAmt(n) {
        if (n == null) return '—';
        return 'R ' + parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ── Load calculation list (Calculations tab) ──────────────────────────────

    async function loadCalculations() {
        if (!_activeReturn) return;
        show('itCalcLoading');
        document.getElementById('itCalcList').innerHTML = '';

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/calculations');
            if (!res.ok) throw new Error('Failed to load calculations');
            var data = await res.json();
            var calcs = data.calculations || [];
            hide('itCalcLoading');

            if (calcs.length === 0) {
                document.getElementById('itCalcList').innerHTML =
                    '<div class="it-empty">No calculations yet. Click "Run Draft Calculation" to generate one.</div>';
                return;
            }
            document.getElementById('itCalcList').innerHTML = calcs.map(function (c) {
                var payable = parseFloat(c.estimated_tax_payable || 0);
                var refund  = parseFloat(c.estimated_refund      || 0);
                return '<div class="it-calc-card">' +
                    '<div class="it-calc-header">' +
                        '<div>' +
                            '<div class="it-calc-name">' + esc(c.calculation_name) + '</div>' +
                            '<div class="it-calc-version">v' + c.calculation_version + ' &mdash; Table: ' + esc(c.tax_table_version || '?') + '</div>' +
                        '</div>' +
                        calcStatusBadge(c.calculation_status) +
                    '</div>' +
                    '<div class="it-calc-amounts">' +
                        '<div class="it-calc-amt-item"><div>Gross Income</div><div class="it-calc-amt-val">' + fmtAmt(c.gross_income_total) + '</div></div>' +
                        '<div class="it-calc-amt-item"><div>Deductions</div><div class="it-calc-amt-val">' + fmtAmt(c.deduction_total) + '</div></div>' +
                        '<div class="it-calc-amt-item"><div>Tax Payable</div><div class="it-calc-amt-val' + (payable > 0 ? ' it-calc-payable' : '') + '">' + fmtAmt(c.estimated_tax_payable) + '</div></div>' +
                        '<div class="it-calc-amt-item"><div>Refund</div><div class="it-calc-amt-val' + (refund > 0 ? ' it-calc-refund' : '') + '">' + fmtAmt(c.estimated_refund) + '</div></div>' +
                    '</div>' +
                    '<div style="margin-top:6px;display:flex;gap:6px">' +
                        '<button class="btn btn-ghost btn-sm" onclick="openCalcDetailModal(' + c.id + ')">View Detail</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        } catch (e) {
            hide('itCalcLoading');
            PracticeAPI.showToast(e.message || 'Error loading calculations', 'error');
        }
    }

    // ── Run draft calculation ─────────────────────────────────────────────────

    async function itRunDraftCalc() {
        if (!_activeReturn || _calcSubmitting) return;
        _calcSubmitting = true;
        var btn = document.getElementById('itRunCalcBtn');
        if (btn) btn.disabled = true;
        show('itCalcLoading');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/calculations/run-draft', {
                method: 'POST',
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed to run calculation'); }
            var data = await res.json();
            _calcSubmitting = false;
            if (btn) btn.disabled = false;
            PracticeAPI.showToast('Draft calculation v' + data.calculation.calculation_version + ' created!');
            loadCalculations();
            // Auto-open the detail modal
            openCalcDetailModal(data.calculation.id);
        } catch (e) {
            _calcSubmitting = false;
            if (btn) btn.disabled = false;
            hide('itCalcLoading');
            PracticeAPI.showToast(e.message || 'Failed to run calculation', 'error');
        }
    }

    // ── Calculation detail modal ───────────────────────────────────────────────

    async function openCalcDetailModal(calcId) {
        _activeCalc = null;
        document.getElementById('itCalcDetailModal').classList.remove('hidden');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/calculations/' + calcId);
            if (!res.ok) throw new Error('Failed to load calculation');
            var data = await res.json();
            _activeCalc = data.calculation;
            _renderCalcDetail();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Error loading calculation', 'error');
            closeCalcDetailModal();
        }
    }

    function closeCalcDetailModal() {
        document.getElementById('itCalcDetailModal').classList.add('hidden');
        _activeCalc = null;
    }

    function _renderCalcDetail() {
        var c = _activeCalc;
        document.getElementById('itCalcDetailTitle').textContent = c.calculation_name;
        document.getElementById('itCalcDStatus').innerHTML  = calcStatusBadge(c.calculation_status);
        document.getElementById('itCalcDYear').textContent   = c.tax_year;
        document.getElementById('itCalcDVersion').textContent = c.tax_table_version || '?';
        document.getElementById('itCalcDCalcVer').textContent = 'v' + c.calculation_version;

        document.getElementById('itCalcDProvTax').value = c.provisional_tax_paid != null ? c.provisional_tax_paid : '';
        document.getElementById('itCalcDNotes').value   = c.notes || '';

        // Calculation lines table
        var lines = c.calculation_lines || [];
        document.getElementById('itCalcDLines').innerHTML = lines.map(function (l) {
            var amtStr = l.amount != null
                ? 'R ' + parseFloat(l.amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : '—';
            return '<tr>' +
                '<td>' + esc(l.label) + '</td>' +
                '<td class="amt">' + amtStr + '</td>' +
                '<td class="note">' + esc(l.note || '') + '</td>' +
            '</tr>';
        }).join('');

        // Warning flags
        var flags = c.warning_flags || [];
        document.getElementById('itCalcDWarnings').innerHTML = flags.length === 0
            ? '<span style="color:var(--text-muted);font-size:12px">None</span>'
            : flags.map(function (f) { return '<span class="it-warn-chip">' + esc(f) + '</span>'; }).join('');

        // Assumptions
        var assumptions = c.assumptions || [];
        document.getElementById('itCalcDAssumptions').innerHTML = assumptions
            .map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('');

        // Show/hide action buttons based on status
        var status = c.calculation_status;
        var submitBtn = document.getElementById('itCalcSubmitReviewBtn');
        var approveBtn= document.getElementById('itCalcApproveBtn');
        var rejectBtn = document.getElementById('itCalcRejectBtn');

        submitBtn.classList.toggle('hidden', !['draft', 'rejected'].includes(status));
        approveBtn.classList.toggle('hidden', !['ready_for_review', 'reviewed'].includes(status));
        rejectBtn.classList.toggle('hidden',  !['ready_for_review', 'reviewed'].includes(status));
    }

    async function itSaveCalcNotes() {
        if (!_activeCalc) return;
        var provTax = document.getElementById('itCalcDProvTax').value;
        var notes   = document.getElementById('itCalcDNotes').value.trim();
        try {
            var res = await PracticeAPI.fetch(_BASE + '/calculations/' + _activeCalc.id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provisional_tax_paid: provTax ? parseFloat(provTax) : null,
                    notes:                notes || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeCalc = data.calculation;
            PracticeAPI.showToast('Saved!');
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to save', 'error');
        }
    }

    async function itSubmitCalcForReview() {
        if (!_activeCalc) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/calculations/' + _activeCalc.id + '/submit-review', { method: 'POST' });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeCalc = data.calculation;
            _renderCalcDetail();
            PracticeAPI.showToast('Submitted for review!');
            loadCalculations();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to submit for review', 'error');
        }
    }

    async function itApproveCalc() {
        if (!_activeCalc) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/calculations/' + _activeCalc.id + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeCalc = data.calculation;
            _renderCalcDetail();
            PracticeAPI.showToast('Calculation approved!');
            loadCalculations();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to approve', 'error');
        }
    }

    function openCalcRejectModal() {
        document.getElementById('itCalcRejectReason').value = '';
        document.getElementById('itCalcRejectModal').classList.remove('hidden');
    }

    function closeCalcRejectModal() {
        document.getElementById('itCalcRejectModal').classList.add('hidden');
    }

    async function itRejectCalc() {
        if (!_activeCalc) return;
        var reason = document.getElementById('itCalcRejectReason').value.trim();
        try {
            var res = await PracticeAPI.fetch(_BASE + '/calculations/' + _activeCalc.id + '/reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rejection_reason: reason || null }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            var data = await res.json();
            _activeCalc = data.calculation;
            closeCalcRejectModal();
            _renderCalcDetail();
            PracticeAPI.showToast('Calculation rejected.');
            loadCalculations();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to reject', 'error');
        }
    }

    window.itRunDraftCalc        = itRunDraftCalc;
    window.openCalcDetailModal   = openCalcDetailModal;
    window.closeCalcDetailModal  = closeCalcDetailModal;
    window.itSaveCalcNotes       = itSaveCalcNotes;
    window.itSubmitCalcForReview = itSubmitCalcForReview;
    window.itApproveCalc         = itApproveCalc;
    window.openCalcRejectModal   = openCalcRejectModal;
    window.closeCalcRejectModal  = closeCalcRejectModal;
    window.itRejectCalc          = itRejectCalc;

    // ══════════════════════════════════════════════════════════════════════════
    // REVIEW PACKS  (Codebox 30)
    // ══════════════════════════════════════════════════════════════════════════

    var _activePackRejectId = null;

    var _RP_STATUS_LABELS = {
        draft:            'Draft',
        generated:        'Generated',
        ready_for_review: 'Ready for Review',
        reviewed:         'Reviewed',
        approved:         'Approved',
        rejected:         'Rejected',
        cancelled:        'Cancelled',
    };

    function rpStatusBadge(s) {
        return '<span class="it-s-badge it-rps-' + esc(s) + '">' + esc(_RP_STATUS_LABELS[s] || s) + '</span>';
    }

    // ── Load review packs for the active return ────────────────────────────────

    async function loadReviewPacks() {
        if (!_activeReturn) return;
        var listEl  = document.getElementById('itRpList');
        var loadEl  = document.getElementById('itRpLoading');
        var emptyEl = document.getElementById('itRpEmpty');
        if (!listEl) return;

        listEl.innerHTML = '';
        show('itRpLoading');
        hide('itRpEmpty');

        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/review-packs');
            if (!res.ok) throw new Error('Failed to load review packs');
            var data = await res.json();
            var packs = data.packs || [];

            hide('itRpLoading');
            if (packs.length === 0) { show('itRpEmpty'); return; }

            packs.forEach(function (p) {
                var warnCount = (p.warning_flags || []).length;
                var genDate   = p.report_generated_at
                    ? new Date(p.report_generated_at).toLocaleString('en-ZA')
                    : '—';

                var card = document.createElement('div');
                card.className = 'it-rp-card';
                card.innerHTML =
                    '<div class="it-rp-header">' +
                        '<div>' +
                            '<div class="it-rp-name">' + esc(p.pack_name) + '</div>' +
                            '<div class="it-rp-meta">Year: ' + esc(p.tax_year) + '  |  Generated: ' + esc(genDate) + '  |  Warnings: ' + warnCount + '</div>' +
                        '</div>' +
                        rpStatusBadge(p.pack_status) +
                    '</div>' +
                    _rpActionButtons(p) +
                    '</div>';
                listEl.appendChild(card);
            });
        } catch (e) {
            hide('itRpLoading');
            PracticeAPI.showToast(e.message || 'Error loading review packs', 'error');
        }
    }

    function _rpActionButtons(p) {
        var btns = '<div class="it-rp-actions">';
        btns += '<button class="btn btn-ghost btn-sm" onclick="viewRpReport(' + p.id + ', \'html\')">View Report</button>';
        btns += '<button class="btn btn-ghost btn-sm" onclick="viewRpReport(' + p.id + ', \'pdf\')">Download PDF</button>';
        btns += '<button class="btn btn-ghost btn-sm" onclick="loadRpEvents(' + p.id + ')">Events</button>';

        if (['generated', 'draft', 'rejected'].includes(p.pack_status)) {
            btns += '<button class="btn btn-secondary btn-sm" onclick="itSubmitPackForReview(' + p.id + ')">Submit for Review</button>';
        }
        if (['ready_for_review', 'reviewed'].includes(p.pack_status)) {
            btns += '<button class="btn btn-primary btn-sm" onclick="itApproveReviewPack(' + p.id + ')">Approve</button>';
            btns += '<button class="btn btn-ghost btn-sm" onclick="openRpRejectModal(' + p.id + ')">Reject</button>';
        }
        btns += '</div>';
        return btns;
    }

    // ── Generate review pack ───────────────────────────────────────────────────

    async function itGenerateReviewPack() {
        if (!_activeReturn) return;
        try {
            var res = await PracticeAPI.fetch(_BASE + '/' + _activeReturn.id + '/review-packs/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed to generate'); }
            PracticeAPI.showToast('Review pack generated.');
            loadReviewPacks();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to generate review pack', 'error');
        }
    }

    // ── View report HTML / PDF ─────────────────────────────────────────────────
    // Uses fetch (with auth header) → blob URL so authenticated endpoints work.

    async function viewRpReport(packId, format) {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/review-packs/' + packId + '/report-' + format);
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed to load report'); }
            var blob = await res.blob();
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href   = url;
            if (format === 'pdf') {
                a.download = 'draft-tax-review-pack-' + packId + '.pdf';
                a.click();
            } else {
                a.target = '_blank';
                a.click();
            }
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to open report', 'error');
        }
    }

    // ── Submit for review ──────────────────────────────────────────────────────

    async function itSubmitPackForReview(packId) {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/review-packs/' + packId + '/submit-review', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            PracticeAPI.showToast('Pack submitted for review.');
            loadReviewPacks();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to submit for review', 'error');
        }
    }

    // ── Approve ────────────────────────────────────────────────────────────────

    async function itApproveReviewPack(packId) {
        try {
            var res = await PracticeAPI.fetch(_BASE + '/review-packs/' + packId + '/approve', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            PracticeAPI.showToast('Review pack approved.');
            loadReviewPacks();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to approve', 'error');
        }
    }

    // ── Reject ─────────────────────────────────────────────────────────────────

    function openRpRejectModal(packId) {
        _activePackRejectId = packId;
        document.getElementById('itRpRejectReason').value = '';
        document.getElementById('itRpRejectModal').classList.remove('hidden');
    }

    function closeRpRejectModal() {
        _activePackRejectId = null;
        document.getElementById('itRpRejectModal').classList.add('hidden');
    }

    async function itConfirmRejectPack() {
        if (!_activePackRejectId) return;
        var reason = document.getElementById('itRpRejectReason').value.trim();
        if (!reason) { PracticeAPI.showToast('Rejection reason is required', 'error'); return; }
        try {
            var res = await PracticeAPI.fetch(_BASE + '/review-packs/' + _activePackRejectId + '/reject', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rejection_reason: reason }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            closeRpRejectModal();
            PracticeAPI.showToast('Review pack rejected.');
            loadReviewPacks();
        } catch (e) {
            PracticeAPI.showToast(e.message || 'Failed to reject', 'error');
        }
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    async function loadRpEvents(packId) {
        show('itRpEventsModal');
        show('itRpEventsLoading');
        document.getElementById('itRpEventsList').innerHTML = '';

        try {
            var res = await PracticeAPI.fetch(_BASE + '/review-packs/' + packId + '/events');
            if (!res.ok) throw new Error('Failed to load events');
            var data = await res.json();
            var events = data.events || [];

            hide('itRpEventsLoading');
            var listEl = document.getElementById('itRpEventsList');

            if (events.length === 0) {
                listEl.innerHTML = '<div class="it-empty">No events recorded.</div>';
                return;
            }
            events.forEach(function (ev) {
                var row = document.createElement('div');
                row.className = 'it-rpe-row';
                row.innerHTML =
                    '<div class="it-rpe-type">' + esc(ev.event_type) + '</div>' +
                    (ev.notes ? '<div class="it-rpe-notes">' + esc(ev.notes) + '</div>' : '') +
                    '<div class="it-rpe-time">' + new Date(ev.created_at).toLocaleString('en-ZA') + '</div>';
                listEl.appendChild(row);
            });
        } catch (e) {
            hide('itRpEventsLoading');
            document.getElementById('itRpEventsList').innerHTML = '<div class="it-empty" style="color:var(--danger)">Failed to load events.</div>';
        }
    }

    function closeRpEventsModal() {
        document.getElementById('itRpEventsModal').classList.add('hidden');
    }

    // ── Wire Review Packs tab load ─────────────────────────────────────────────
    // Patch itSwitchTab so switching to review-packs triggers a load.
    var _origSwitchTab = window.itSwitchTab;
    window.itSwitchTab = function (tab, btn) {
        _origSwitchTab(tab, btn);
        if (tab === 'review-packs') loadReviewPacks();
    };

    window.itGenerateReviewPack  = itGenerateReviewPack;
    window.viewRpReport          = viewRpReport;
    window.itSubmitPackForReview = itSubmitPackForReview;
    window.itApproveReviewPack   = itApproveReviewPack;
    window.openRpRejectModal     = openRpRejectModal;
    window.closeRpRejectModal    = closeRpRejectModal;
    window.itConfirmRejectPack   = itConfirmRejectPack;
    window.loadRpEvents          = loadRpEvents;
    window.closeRpEventsModal    = closeRpEventsModal;

    // ── Boot ───────────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
