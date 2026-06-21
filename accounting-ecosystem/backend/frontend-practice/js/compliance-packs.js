/* ============================================================
   Lorenco Practice — Compliance Packs Page JS  (Codebox 24)
   Rule D: no localStorage for business data. All data via API.
   ============================================================ */
(function () {
    var esc    = PracticeAPI.escHtml;
    var BASE   = '/api/practice/compliance-packs';

    // ── State ────────────────────────────────────────────────────────────────

    var _clients        = [];
    var _teamMembers    = [];
    var _currentPackId  = null;
    var _creating       = false;
    var _addingItem     = false;

    // ── Labels ───────────────────────────────────────────────────────────────

    var PACK_TYPE_LABELS = {
        annual_financials: 'Annual Financials',
        company_tax:       'Company Tax',
        individual_tax:    'Individual Tax',
        vat_period:        'VAT Period',
        payroll_annual:    'Payroll Annual',
        cipc_annual:       'CIPC Annual',
        custom:            'Custom',
    };

    var PACK_STATUS_LABELS = {
        draft:            'Draft',
        collecting_docs:  'Collecting Docs',
        ready_for_review: 'Ready for Review',
        reviewed:         'Reviewed',
        completed:        'Completed',
        cancelled:        'Cancelled',
    };

    var ITEM_STATUS_LABELS = {
        required:       'Required',
        requested:      'Requested',
        received:       'Received',
        completed:      'Completed',
        waived:         'Waived',
        blocked:        'Blocked',
        not_applicable: 'N/A',
    };

    // ── Init ──────────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        LAYOUT.init('compliance-packs');

        await Promise.all([loadClients(), loadTeam()]);
        await Promise.all([loadSummary(), loadPacks()]);
    }

    // ── Reference data ───────────────────────────────────────────────────────

    async function loadClients() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients?active=true&limit=500');
            if (!res.ok) return;
            var d = await res.json();
            _clients = d.clients || [];
            var clientFilter = document.getElementById('cpFilterClient');
            var clientOpts   = '<option value="">All Clients</option>';
            _clients.forEach(function(c) {
                clientOpts += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
            });
            if (clientFilter) clientFilter.innerHTML = clientOpts;

            var createSel = document.getElementById('cpCClient');
            if (createSel) {
                var createOpts = '<option value="">Select client…</option>';
                _clients.forEach(function(c) {
                    createOpts += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
                });
                createSel.innerHTML = createOpts;
            }
        } catch(e) {}
    }

    async function loadTeam() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/team?active=true');
            if (!res.ok) return;
            var d = await res.json();
            _teamMembers = d.members || [];
            var ownerOpts = '<option value="">Unassigned</option>';
            _teamMembers.forEach(function(m) {
                ownerOpts += '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
            });
            var ownerSel = document.getElementById('cpCOwner');
            if (ownerSel) ownerSel.innerHTML = ownerOpts;
        } catch(e) {}
    }

    // ── Summary cards ────────────────────────────────────────────────────────

    async function loadSummary() {
        try {
            var res = await PracticeAPI.fetch(BASE + '/summary');
            if (!res.ok) return;
            var d   = await res.json();
            var s   = d.summary || {};
            setText('sumCpTotal',      s.total            || 0);
            setText('sumCpCollecting', s.collecting_docs  || 0);
            setText('sumCpReview',     s.ready_for_review || 0);
            setText('sumCpReady',      (s.readiness && s.readiness.ready) || 0);
            setText('sumCpBlocked',    (s.readiness && s.readiness.blocked) || 0);
        } catch(e) {}
    }

    // ── Pack list ─────────────────────────────────────────────────────────────

    async function loadPacks() {
        var loading = document.getElementById('cpListLoading');
        var wrap    = document.getElementById('cpListWrap');
        var empty   = document.getElementById('cpListEmpty');
        var errEl   = document.getElementById('cpListError');

        if (loading) loading.classList.remove('hidden');
        if (wrap)    wrap.classList.add('hidden');
        if (empty)   empty.classList.add('hidden');
        if (errEl)   errEl.classList.add('hidden');

        var params = new URLSearchParams();
        var typeF    = val('cpFilterType');
        var statusF  = val('cpFilterStatus');
        var readyF   = val('cpFilterReadiness');
        var clientF  = val('cpFilterClient');
        if (typeF)   params.set('pack_type',        typeF);
        if (statusF) params.set('status',            statusF);
        if (readyF)  params.set('readiness_status', readyF);
        if (clientF) params.set('client_id',         clientF);
        params.set('limit', '100');

        try {
            var res = await PracticeAPI.fetch(BASE + '?' + params.toString());
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            var packs = d.compliance_packs || [];

            if (loading) loading.classList.add('hidden');
            if (packs.length === 0) {
                if (empty) empty.classList.remove('hidden');
                return;
            }
            renderPackList(packs);
            if (wrap) wrap.classList.remove('hidden');
        } catch(e) {
            if (loading) loading.classList.add('hidden');
            if (errEl) {
                errEl.textContent = 'Failed to load compliance packs.';
                errEl.classList.remove('hidden');
            }
        }
    }

    function renderPackList(packs) {
        var tbody = document.getElementById('cpListBody');
        if (!tbody) return;

        tbody.innerHTML = packs.map(function(p) {
            var typeLabel   = PACK_TYPE_LABELS[p.pack_type]   || p.pack_type;
            var statusLabel = PACK_STATUS_LABELS[p.status]    || p.status;
            var clientName  = p.practice_clients ? esc(p.practice_clients.name) : '<span class="col-muted">—</span>';
            var periodStr   = formatPeriod(p);
            var readyHtml   = renderReadinessBadge(p.readiness_status, p.readiness_score);

            return '<tr>' +
                '<td><span class="cp-type-badge cp-type-' + esc(p.pack_type) + '">' + esc(typeLabel) + '</span></td>' +
                '<td>' + esc(p.pack_name) + '</td>' +
                '<td>' + clientName + '</td>' +
                '<td class="col-muted">' + (periodStr || '—') + '</td>' +
                '<td><span class="cp-status-badge cp-status-' + esc(p.status) + '">' + esc(statusLabel) + '</span></td>' +
                '<td>' + readyHtml + '</td>' +
                '<td style="text-align:right;">' +
                    '<button type="button" class="btn btn-ghost btn-xs" onclick="openDetailModal(' + p.id + ')">View</button>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    function renderReadinessBadge(readiness_status, score) {
        var cls = 'cp-ready-' + (readiness_status || 'unknown');
        var icons = { incomplete: '▲', partial: '◑', ready: '✓', blocked: '✕', unknown: '·' };
        var icon  = icons[readiness_status] || '·';
        var scoreStr = score != null ? ' ' + score + '%' : '';
        return '<span class="cp-ready-badge ' + cls + '">' + icon + scoreStr + '</span>';
    }

    function formatPeriod(p) {
        if (p.tax_year) return 'Tax Year ' + p.tax_year;
        if (p.period_start && p.period_end) return fmtDate(p.period_start) + ' – ' + fmtDate(p.period_end);
        if (p.period_start) return fmtDate(p.period_start) + '…';
        if (p.financial_year_end) return 'FYE ' + fmtDate(p.financial_year_end);
        return '';
    }

    // ── Create pack ───────────────────────────────────────────────────────────

    function openCreatePackModal() {
        document.getElementById('cpCClient').value     = '';
        document.getElementById('cpCType').value       = '';
        document.getElementById('cpCName').value       = '';
        document.getElementById('cpCTaxYear').value    = '';
        document.getElementById('cpCPeriodStart').value = '';
        document.getElementById('cpCPeriodEnd').value   = '';
        document.getElementById('cpCNotes').value       = '';
        document.getElementById('cpCOwner').value       = '';
        document.getElementById('cpCreateError').classList.add('hidden');
        _creating = false;
        document.getElementById('cpCreateSubmitBtn').disabled = false;
        document.getElementById('cpCreateModal').classList.remove('hidden');
    }

    function closeCreatePackModal() {
        document.getElementById('cpCreateModal').classList.add('hidden');
    }

    function cpTogglePeriodFields() {
        // All types benefit from period fields — keep them visible always
    }

    function cpAutoName() {
        var clientSel = document.getElementById('cpCClient');
        var typeSel   = document.getElementById('cpCType');
        var yearEl    = document.getElementById('cpCTaxYear');
        var nameEl    = document.getElementById('cpCName');

        if (!clientSel.value || !typeSel.value) return;

        var clientName = '';
        var opt = clientSel.options[clientSel.selectedIndex];
        if (opt) clientName = opt.textContent;

        var typeLabel = {
            annual_financials: 'Annual Financials',
            company_tax:       'Company Tax',
            individual_tax:    'Individual Tax',
            vat_period:        'VAT Period',
            payroll_annual:    'Payroll Annual',
            cipc_annual:       'CIPC Annual',
            custom:            'Pack',
        }[typeSel.value] || typeSel.value;

        var year = yearEl.value ? ' ' + yearEl.value : '';
        nameEl.value = clientName + ' — ' + typeLabel + year;
    }

    async function submitCreatePack() {
        if (_creating) return;
        var errEl = document.getElementById('cpCreateError');
        errEl.classList.add('hidden');

        var client_id = val('cpCClient');
        var pack_type = val('cpCType');
        var pack_name = val('cpCName').trim();

        if (!client_id) { showErr(errEl, 'Client is required.'); return; }
        if (!pack_type) { showErr(errEl, 'Pack type is required.'); return; }
        if (!pack_name) { showErr(errEl, 'Pack name is required.'); return; }

        _creating = true;
        document.getElementById('cpCreateSubmitBtn').disabled = true;

        var taxYearRaw = val('cpCTaxYear');
        var payload = {
            client_id:           parseInt(client_id),
            pack_type:           pack_type,
            pack_name:           pack_name,
            tax_year:            taxYearRaw ? parseInt(taxYearRaw) : null,
            period_start:        val('cpCPeriodStart') || null,
            period_end:          val('cpCPeriodEnd')   || null,
            owner_team_member_id: val('cpCOwner') ? parseInt(val('cpCOwner')) : null,
            notes:               val('cpCNotes') || null,
        };

        try {
            var res = await PracticeAPI.fetch(BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Failed');

            closeCreatePackModal();
            PracticeAPI.showToast('Compliance pack created!');
            await Promise.all([loadSummary(), loadPacks()]);
        } catch(e) {
            showErr(errEl, e.message || 'Failed to create pack.');
        } finally {
            _creating = false;
            document.getElementById('cpCreateSubmitBtn').disabled = false;
        }
    }

    // ── Pack detail ───────────────────────────────────────────────────────────

    async function openDetailModal(packId) {
        _currentPackId = packId;

        // Reset state
        setText('cpDetailTitle', 'Loading…');
        document.getElementById('cpDName').textContent       = '';
        document.getElementById('cpDSub').textContent        = '';
        document.getElementById('cpDStatusBadge').innerHTML  = '';
        document.getElementById('cpDStatusSelect').value     = 'draft';
        document.getElementById('cpDScoreBar').style.width   = '0%';
        document.getElementById('cpDReadinessLabel').textContent = 'Readiness unknown';
        document.getElementById('cpDScoreLabel').textContent     = '';
        document.getElementById('cpDItemsLoading').classList.remove('hidden');
        document.getElementById('cpDItemsWrap').classList.add('hidden');
        document.getElementById('cpDItemsEmpty').classList.add('hidden');
        document.getElementById('cpDItemsError').classList.add('hidden');

        document.getElementById('cpDetailModal').classList.remove('hidden');

        try {
            var [packRes, itemsRes] = await Promise.all([
                PracticeAPI.fetch(BASE + '/' + packId),
                PracticeAPI.fetch(BASE + '/' + packId + '/items'),
            ]);
            if (!packRes.ok) throw new Error('Pack not found');
            var pd = await packRes.json();
            var id = await itemsRes.json();
            var pack  = pd.compliance_pack;
            var items = id.items || [];
            var rdy   = id.readiness || {};

            renderDetailHeader(pack, rdy);
            renderDetailItems(items);
        } catch(e) {
            document.getElementById('cpDItemsLoading').classList.add('hidden');
            document.getElementById('cpDItemsError').textContent = 'Failed to load pack detail.';
            document.getElementById('cpDItemsError').classList.remove('hidden');
        }
    }

    function renderDetailHeader(pack, rdy) {
        var typeLabel   = PACK_TYPE_LABELS[pack.pack_type]   || pack.pack_type;
        var statusLabel = PACK_STATUS_LABELS[pack.status]    || pack.status;
        var clientName  = pack.practice_clients ? pack.practice_clients.name : '';
        var periodStr   = formatPeriod(pack);

        setText('cpDetailTitle', pack.pack_name);
        document.getElementById('cpDName').textContent = pack.pack_name;
        document.getElementById('cpDSub').textContent  = [typeLabel, clientName, periodStr].filter(Boolean).join(' · ');
        document.getElementById('cpDStatusBadge').innerHTML =
            '<span class="cp-status-badge cp-status-' + pack.status + '">' + esc(statusLabel) + '</span>';
        document.getElementById('cpDStatusSelect').value = pack.status;

        // Readiness bar
        var score = rdy.score != null ? rdy.score : (pack.readiness_score != null ? pack.readiness_score : null);
        var rs    = rdy.readiness_status || pack.readiness_status || 'unknown';
        var fillEl = document.getElementById('cpDScoreBar');
        fillEl.style.width = (score != null ? score : 0) + '%';
        fillEl.className   = 'cp-score-bar-fill ' + (rs === 'ready' ? 'ready' : rs === 'partial' ? 'partial' : rs === 'blocked' ? 'blocked' : '');

        var readyLabels = { incomplete: 'Incomplete', partial: 'Partial', ready: 'Ready', blocked: 'Blocked', unknown: 'Unknown' };
        document.getElementById('cpDReadinessLabel').textContent = 'Readiness: ' + (readyLabels[rs] || rs);
        document.getElementById('cpDScoreLabel').textContent     = score != null ? score + '%' : '—';
    }

    function renderDetailItems(items) {
        document.getElementById('cpDItemsLoading').classList.add('hidden');
        var wrap  = document.getElementById('cpDItemsWrap');
        var empty = document.getElementById('cpDItemsEmpty');

        var total    = items.length;
        var required = items.filter(function(i) { return i.required && i.status !== 'not_applicable'; }).length;
        var done     = items.filter(function(i) { return i.required && ['completed','received','waived'].includes(i.status); }).length;

        document.getElementById('cpDItemsTitle').textContent =
            'Items (' + total + (required > 0 ? ' · ' + done + '/' + required + ' required done' : '') + ')';

        if (items.length === 0) {
            empty.classList.remove('hidden');
            return;
        }

        wrap.innerHTML = items.map(function(item) {
            var statusLabel = ITEM_STATUS_LABELS[item.status] || item.status;
            var badgeCls    = 'cp-item-badge cp-item-' + item.status;
            var isOptional  = !item.required;
            var nameOpacity = item.status === 'not_applicable' ? 'opacity:0.4;' : '';

            return '<div class="cp-item-row" data-item-id="' + item.id + '">' +
                '<div class="cp-item-name" style="' + nameOpacity + '">' +
                    '<div>' + esc(item.item_name) + (isOptional ? ' <span class="col-muted" style="font-size:0.72rem;">(optional)</span>' : '') + '</div>' +
                    (item.item_description ? '<div class="cp-item-desc">' + esc(item.item_description) + '</div>' : '') +
                '</div>' +
                '<span class="' + badgeCls + '">' + esc(statusLabel) + '</span>' +
                '<div style="display:flex;gap:4px;flex-shrink:0;">' +
                    renderItemActions(item) +
                '</div>' +
            '</div>';
        }).join('');

        wrap.classList.remove('hidden');
    }

    function renderItemActions(item) {
        var btns = '';
        var active = item.status !== 'not_applicable' && item.status !== 'waived';

        if (active && item.status !== 'received' && item.status !== 'completed') {
            btns += '<button type="button" class="btn btn-xs btn-ghost" title="Mark received/completed" onclick="cpItemMarkDone(' + item.id + ')">✓</button>';
        }
        if (active && item.status !== 'blocked') {
            btns += '<button type="button" class="btn btn-xs btn-ghost" title="Mark blocked" onclick="cpItemMarkBlocked(' + item.id + ')">⚠</button>';
        }
        if (item.status !== 'not_applicable') {
            btns += '<button type="button" class="btn btn-xs btn-ghost" title="Mark not applicable" onclick="cpItemMarkNA(' + item.id + ')">—</button>';
        }
        return btns;
    }

    function closeCpDetailModal() {
        document.getElementById('cpDetailModal').classList.add('hidden');
        _currentPackId = null;
    }

    // ── Detail actions ────────────────────────────────────────────────────────

    async function cpUpdateStatus() {
        if (!_currentPackId) return;
        var newStatus = val('cpDStatusSelect');
        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            PracticeAPI.showToast('Status updated.');
            loadPacks();
            loadSummary();
        } catch(e) {
            PracticeAPI.showToast('❌ ' + (e.message || 'Update failed.'), true);
        }
    }

    async function cpRecalculate() {
        if (!_currentPackId) return;
        var btn = document.getElementById('cpDRecalcBtn');
        btn.disabled = true;
        btn.textContent = '⟳ Recalculating…';
        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/recalculate-readiness', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var d = await res.json();
            PracticeAPI.showToast('Readiness recalculated.');
            // Refresh the detail modal
            openDetailModal(_currentPackId);
            loadSummary();
        } catch(e) {
            PracticeAPI.showToast('❌ ' + (e.message || 'Recalculation failed.'), true);
        } finally {
            btn.disabled = false;
            btn.textContent = '⟳ Recalculate Readiness';
        }
    }

    async function cpGenerateDefaults() {
        if (!_currentPackId) return;
        var btn = document.getElementById('cpDGenDefaultBtn');
        btn.disabled = true;
        btn.textContent = '📋 Generating…';
        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/generate-default-items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            var d = await res.json();
            if (res.status === 409) {
                if (!confirm(d.error + '\n\nAdd defaults anyway?')) { btn.disabled = false; btn.textContent = '📋 Generate Default Items'; return; }
                var r2 = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/generate-default-items?force=true', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                });
                d = await r2.json();
                if (!r2.ok) throw new Error(d.error || 'Failed');
            } else if (!res.ok) {
                throw new Error(d.error || 'Failed');
            }
            PracticeAPI.showToast(d.created + ' default item(s) generated!');
            openDetailModal(_currentPackId);
        } catch(e) {
            PracticeAPI.showToast('❌ ' + (e.message || 'Generation failed.'), true);
        } finally {
            btn.disabled = false;
            btn.textContent = '📋 Generate Default Items';
        }
    }

    async function cpGenerateFromDocs() {
        if (!_currentPackId) return;
        var btn = document.getElementById('cpDGenDocsBtn');
        btn.disabled = true;
        btn.textContent = '📄 Linking…';
        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/generate-from-documents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            var d = await res.json();
            PracticeAPI.showToast(d.created > 0 ? d.created + ' document request(s) linked!' : (d.message || 'No new links added.'));
            if (d.created > 0) openDetailModal(_currentPackId);
        } catch(e) {
            PracticeAPI.showToast('❌ ' + (e.message || 'Link failed.'), true);
        } finally {
            btn.disabled = false;
            btn.textContent = '📄 Link Document Requests';
        }
    }

    async function cpCancelPack() {
        if (!_currentPackId) return;
        if (!confirm('Cancel this compliance pack? It will be hidden from the list.')) return;
        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId, { method: 'DELETE' });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            PracticeAPI.showToast('Pack cancelled.');
            closeCpDetailModal();
            await Promise.all([loadSummary(), loadPacks()]);
        } catch(e) {
            PracticeAPI.showToast('❌ ' + (e.message || 'Failed.'), true);
        }
    }

    // ── Item status actions ───────────────────────────────────────────────────

    async function cpItemMarkDone(itemId) {
        await cpItemUpdateStatus(itemId, 'received');
    }

    async function cpItemMarkBlocked(itemId) {
        await cpItemUpdateStatus(itemId, 'blocked');
    }

    async function cpItemMarkNA(itemId) {
        await cpItemUpdateStatus(itemId, 'not_applicable');
    }

    async function cpItemUpdateStatus(itemId, newStatus) {
        if (!_currentPackId) return;
        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/items/' + itemId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            // Reload items in place
            var itemsRes = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/items');
            if (itemsRes.ok) {
                var d = await itemsRes.json();
                renderDetailItems(d.items || []);
            }
        } catch(e) {
            PracticeAPI.showToast('❌ ' + (e.message || 'Failed.'), true);
        }
    }

    // ── Add item modal ────────────────────────────────────────────────────────

    function openCpAddItemModal() {
        document.getElementById('cpAIType').value     = 'document';
        document.getElementById('cpAIRequired').value = 'true';
        document.getElementById('cpAIName').value     = '';
        document.getElementById('cpAIDesc').value     = '';
        document.getElementById('cpAINotes').value    = '';
        document.getElementById('cpAddItemError').classList.add('hidden');
        _addingItem = false;
        document.getElementById('cpAddItemSubmitBtn').disabled = false;
        document.getElementById('cpAddItemModal').classList.remove('hidden');
    }

    function closeCpAddItemModal() {
        document.getElementById('cpAddItemModal').classList.add('hidden');
    }

    async function submitCpAddItem() {
        if (_addingItem || !_currentPackId) return;
        var errEl = document.getElementById('cpAddItemError');
        errEl.classList.add('hidden');
        var name = val('cpAIName').trim();
        if (!name) { showErr(errEl, 'Item name is required.'); return; }

        _addingItem = true;
        document.getElementById('cpAddItemSubmitBtn').disabled = true;

        var payload = {
            item_type:        val('cpAIType'),
            item_name:        name,
            item_description: val('cpAIDesc').trim() || null,
            required:         val('cpAIRequired') !== 'false',
            notes:            val('cpAINotes').trim() || null,
        };

        try {
            var res = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Failed');

            closeCpAddItemModal();
            PracticeAPI.showToast('Item added!');
            // Reload items
            var itemsRes = await PracticeAPI.fetch(BASE + '/' + _currentPackId + '/items');
            if (itemsRes.ok) {
                var id = await itemsRes.json();
                renderDetailItems(id.items || []);
            }
        } catch(e) {
            showErr(errEl, e.message || 'Failed to add item.');
        } finally {
            _addingItem = false;
            document.getElementById('cpAddItemSubmitBtn').disabled = false;
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    function val(id) {
        var el = document.getElementById(id);
        return el ? el.value : '';
    }

    function setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function showErr(el, msg) {
        el.textContent = msg;
        el.classList.remove('hidden');
    }

    function fmtDate(str) {
        if (!str) return '';
        var d = new Date(str + 'T00:00:00');
        return d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // ── Expose globals ────────────────────────────────────────────────────────

    window.loadPacks           = loadPacks;
    window.openCreatePackModal = openCreatePackModal;
    window.closeCreatePackModal = closeCreatePackModal;
    window.cpAutoName          = cpAutoName;
    window.cpTogglePeriodFields = cpTogglePeriodFields;
    window.submitCreatePack    = submitCreatePack;
    window.openDetailModal     = openDetailModal;
    window.closeCpDetailModal  = closeCpDetailModal;
    window.cpUpdateStatus      = cpUpdateStatus;
    window.cpRecalculate       = cpRecalculate;
    window.cpGenerateDefaults  = cpGenerateDefaults;
    window.cpGenerateFromDocs  = cpGenerateFromDocs;
    window.cpCancelPack        = cpCancelPack;
    window.cpItemMarkDone      = cpItemMarkDone;
    window.cpItemMarkBlocked   = cpItemMarkBlocked;
    window.cpItemMarkNA        = cpItemMarkNA;
    window.openCpAddItemModal  = openCpAddItemModal;
    window.closeCpAddItemModal = closeCpAddItemModal;
    window.submitCpAddItem     = submitCpAddItem;

    init();
})();
