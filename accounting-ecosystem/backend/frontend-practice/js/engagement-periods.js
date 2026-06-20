/* ============================================================
   Lorenco Practice — Period Queue Page JS (Codebox 16)
   Manages the manual period queue for recurring engagements.
   Rule D: no localStorage for business data. All data via API.
   ============================================================ */
(function () {
    var esc = PracticeAPI.escHtml;

    // ── State ──────────────────────────────────────────────────────────────────

    var _currentPage    = 1;
    var _totalPeriods   = 0;
    var _limit          = 50;
    var _activePeriodId = null;  // for skip/cancel/generate-workflow modals
    var _submitting     = false;

    // ── Auth + init ────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        LAYOUT.init('period-queue');

        // Pre-fill filters from URL params
        var params = new URLSearchParams(window.location.search);
        if (params.get('client_id'))    document.getElementById('fClient').dataset.preselect    = params.get('client_id');
        if (params.get('engagement_id')) document.getElementById('fEngagement').dataset.preselect = params.get('engagement_id');
        if (params.get('status'))        document.getElementById('fStatus').value                = params.get('status');

        await loadFilterOptions();
        await loadPeriods();
    }

    // ── Filter dropdowns ───────────────────────────────────────────────────────

    async function loadFilterOptions() {
        try {
            var [clientsRes, engRes] = await Promise.all([
                PracticeAPI.fetch('/api/practice/clients?is_active=all&limit=500'),
                PracticeAPI.fetch('/api/practice/clients/0/engagements').catch(function() { return null; })
            ]);

            if (clientsRes.ok) {
                var cd = await clientsRes.json();
                var clientSel = document.getElementById('fClient');
                var preselect = clientSel.dataset.preselect || '';
                (cd.clients || []).forEach(function(c) {
                    var opt = document.createElement('option');
                    opt.value       = c.id;
                    opt.textContent = c.name;
                    if (String(c.id) === preselect) opt.selected = true;
                    clientSel.appendChild(opt);
                });
                if (preselect) await loadEngagementFilter(parseInt(preselect));
            }
        } catch(e) {}
    }

    async function loadEngagementFilter(clientId) {
        var engSel = document.getElementById('fEngagement');
        engSel.innerHTML = '<option value="">All Engagements</option>';
        if (!clientId) return;
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId + '/engagements');
            if (!res.ok) return;
            var d   = await res.json();
            var preselect = engSel.dataset.preselect || '';
            (d.engagements || []).forEach(function(e) {
                var opt = document.createElement('option');
                opt.value       = e.id;
                opt.textContent = e.engagement_name;
                if (String(e.id) === preselect) opt.selected = true;
                engSel.appendChild(opt);
            });
        } catch(e) {}
    }

    // When client filter changes, reload engagement filter
    document.getElementById('fClient').addEventListener('change', function() {
        var cid = parseInt(this.value) || 0;
        document.getElementById('fEngagement').innerHTML = '<option value="">All Engagements</option>';
        if (cid) loadEngagementFilter(cid);
        loadPeriods();
    });

    // ── Load / render periods ──────────────────────────────────────────────────

    async function loadPeriods() {
        document.getElementById('periodsLoading').style.display = 'flex';
        document.getElementById('periodsError').classList.add('hidden');
        document.getElementById('periodsTableWrap').classList.add('hidden');
        document.getElementById('periodsEmpty').classList.add('hidden');

        var params = buildFilterParams();
        params.set('page',  _currentPage);
        params.set('limit', _limit);

        try {
            var res = await PracticeAPI.fetch('/api/practice/engagement-periods?' + params.toString());
            var d   = await res.json();
            if (!res.ok) throw new Error(d.error || 'Load failed');

            _totalPeriods = d.total || 0;
            var periods   = d.periods || [];

            document.getElementById('periodsLoading').style.display = 'none';

            if (!periods.length) {
                document.getElementById('periodsEmpty').classList.remove('hidden');
                return;
            }

            renderPeriodsTable(periods);
            renderPagination();
            document.getElementById('periodsTableWrap').classList.remove('hidden');

        } catch(e) {
            document.getElementById('periodsLoading').style.display = 'none';
            document.getElementById('periodsError').classList.remove('hidden');
        }
    }

    function buildFilterParams() {
        var p = new URLSearchParams();
        var client = document.getElementById('fClient').value;
        var eng    = document.getElementById('fEngagement').value;
        var status = document.getElementById('fStatus').value;
        var from   = document.getElementById('fDueFrom').value;
        var to     = document.getElementById('fDueTo').value;

        if (client) p.set('client_id',    client);
        if (eng)    p.set('engagement_id', eng);
        if (status) p.set('status',        status);
        if (from)   p.set('due_from',      from);
        if (to)     p.set('due_to',        to);
        return p;
    }

    function renderPeriodsTable(periods) {
        var tbody = document.getElementById('periodsTableBody');
        tbody.innerHTML = periods.map(function(p) {
            var clientName  = (p.practice_clients && p.practice_clients.name)
                ? esc(p.practice_clients.name) : '<span class="col-muted">—</span>';
            var engName     = (p.practice_client_engagements && p.practice_client_engagements.engagement_name)
                ? esc(p.practice_client_engagements.engagement_name) : '<span class="col-muted">—</span>';
            var statusBadge = '<span class="badge status-' + p.status + '">' + esc(p.status) + '</span>';
            var workflowLink = p.workflow_run_id
                ? '<a href="/practice/workflows.html" class="badge badge-info">#' + p.workflow_run_id + '</a>'
                : '<span class="col-muted">—</span>';
            var deadlineLink = p.deadline_id
                ? '<span class="badge badge-pending">#' + p.deadline_id + '</span>'
                : '<span class="col-muted">—</span>';
            var dueDateStr  = p.due_date ? p.due_date : '<span class="col-muted">—</span>';
            var periodStart = p.period_start || '—';
            var periodEnd   = p.period_end   || '—';

            var actions = '';
            if (p.status === 'queued' || p.status === 'ready') {
                actions += '<button type="button" class="btn btn-primary btn-sm" onclick="openGenFromPeriod(' + p.id + ')">⚡ Generate</button>';
                actions += '<button type="button" class="btn btn-ghost btn-sm" onclick="openSkipModal(' + p.id + ')">Skip</button>';
                actions += '<button type="button" class="btn btn-ghost btn-sm" onclick="cancelPeriod(' + p.id + ')">Cancel</button>';
            }

            return '<tr>' +
                '<td>' + clientName + '</td>' +
                '<td>' + engName + '</td>' +
                '<td style="font-weight:600">' + esc(p.period_label) + '</td>' +
                '<td>' + esc(periodStart) + '</td>' +
                '<td>' + esc(periodEnd) + '</td>' +
                '<td>' + dueDateStr + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + workflowLink + '</td>' +
                '<td>' + deadlineLink + '</td>' +
                '<td><div class="actions">' + actions + '</div></td>' +
            '</tr>';
        }).join('');
    }

    function renderPagination() {
        var totalPages = Math.ceil(_totalPeriods / _limit);
        var el = document.getElementById('periodsPagination');
        if (totalPages <= 1) { el.innerHTML = ''; return; }

        var html = '';
        html += '<button class="btn btn-ghost btn-sm" ' +
            (_currentPage <= 1 ? 'disabled' : 'onclick="gotoPage(' + (_currentPage - 1) + ')"') + '>← Prev</button>';
        html += '<span style="font-size:0.82rem;color:var(--text-muted);padding:4px 8px;">Page ' + _currentPage + ' of ' + totalPages + '</span>';
        html += '<button class="btn btn-ghost btn-sm" ' +
            (_currentPage >= totalPages ? 'disabled' : 'onclick="gotoPage(' + (_currentPage + 1) + ')"') + '>Next →</button>';
        el.innerHTML = html;
    }

    function gotoPage(page) {
        _currentPage = page;
        loadPeriods();
    }

    function resetFilters() {
        document.getElementById('fClient').value    = '';
        document.getElementById('fEngagement').value = '';
        document.getElementById('fStatus').value    = '';
        document.getElementById('fDueFrom').value   = '';
        document.getElementById('fDueTo').value     = '';
        document.getElementById('fEngagement').innerHTML = '<option value="">All Engagements</option>';
        _currentPage = 1;
        loadPeriods();
    }

    // ── Generate Workflow from Period Modal ────────────────────────────────────

    var _genFromPeriodData = null;

    async function openGenFromPeriod(periodId) {
        _activePeriodId  = periodId;
        _genFromPeriodData = null;

        // Reset form
        document.getElementById('gfpAnchorDate').value    = '';
        document.getElementById('gfpDueDate').value       = '';
        document.getElementById('gfpDeadlineTitle').value = '';
        document.getElementById('gfpNotes').value         = '';
        document.getElementById('gfpCreateDeadline').checked = false;
        document.getElementById('gfpDeadlineTitleWrap').classList.add('hidden');
        document.getElementById('gfpResultPanel').classList.add('hidden');
        document.getElementById('gfpResultPanel').innerHTML = '';
        document.getElementById('genFromPeriodForm').classList.remove('hidden');
        document.getElementById('gfpFormActions').classList.remove('hidden');
        document.getElementById('gfpSubmitBtn').disabled = false;
        document.getElementById('gfpSubmitBtn').textContent = '⚡ Generate Workflow';

        // Load period detail to populate info panel
        try {
            var res = await PracticeAPI.fetch('/api/practice/engagement-periods/' + periodId);
            if (!res.ok) throw new Error();
            var d = await res.json();
            _genFromPeriodData = d.period;
            populateGfpInfo(d.period);
            // Default anchor and due dates from period
            if (d.period.period_start) document.getElementById('gfpAnchorDate').value = d.period.period_start;
            if (d.period.due_date)     document.getElementById('gfpDueDate').value    = d.period.due_date;
        } catch(e) {
            document.getElementById('gfpPeriodInfo').innerHTML =
                '<div class="col-muted" style="font-size:0.82rem">Period #' + periodId + '</div>';
        }

        document.getElementById('genFromPeriodModal').classList.add('show');
    }

    function populateGfpInfo(period) {
        document.getElementById('gfpPeriodInfo').innerHTML =
            '<dl style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">' +
            '<dt>Period</dt><dd>' + esc(period.period_label) + '</dd>' +
            '<dt>Start</dt><dd>' + esc(period.period_start) + '</dd>' +
            '<dt>End</dt><dd>'   + esc(period.period_end)   + '</dd>' +
            (period.due_date ? '<dt>Due</dt><dd>' + esc(period.due_date) + '</dd>' : '') +
            '</dl>';
    }

    function toggleGfpDeadlineTitle() {
        var wrap = document.getElementById('gfpDeadlineTitleWrap');
        if (document.getElementById('gfpCreateDeadline').checked) wrap.classList.remove('hidden');
        else wrap.classList.add('hidden');
    }

    function closeGenFromPeriodModal() {
        document.getElementById('genFromPeriodModal').classList.remove('show');
        _activePeriodId = null;
    }

    async function submitGenFromPeriod(e) {
        e.preventDefault();
        if (!_activePeriodId || _submitting) return false;
        _submitting = true;

        var btn = document.getElementById('gfpSubmitBtn');
        btn.disabled = true; btn.textContent = 'Generating…';

        var body = {
            anchor_date:     document.getElementById('gfpAnchorDate').value   || null,
            due_date:        document.getElementById('gfpDueDate').value       || null,
            create_deadline: document.getElementById('gfpCreateDeadline').checked,
            deadline_title:  document.getElementById('gfpDeadlineTitle').value.trim() || null,
            notes:           document.getElementById('gfpNotes').value.trim()  || null
        };

        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/engagement-periods/' + _activePeriodId + '/generate-workflow',
                { method: 'POST', body: JSON.stringify(body) }
            );
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Generation failed');

            document.getElementById('genFromPeriodForm').classList.add('hidden');
            document.getElementById('gfpFormActions').classList.add('hidden');
            var panel = document.getElementById('gfpResultPanel');
            panel.classList.remove('hidden');
            panel.innerHTML =
                '<div style="text-align:center;padding:24px 16px;">' +
                    '<div style="font-size:2rem;margin-bottom:10px">✅</div>' +
                    '<div style="font-weight:600;font-size:1rem;margin-bottom:6px">Workflow Generated</div>' +
                    '<div class="col-muted" style="font-size:0.84rem;margin-bottom:4px">' +
                        d.task_count + ' task' + (d.task_count !== 1 ? 's' : '') + ' created' +
                        (d.deadline_id ? ' · Deadline #' + d.deadline_id : '') +
                    '</div>' +
                    '<div class="col-muted" style="font-size:0.78rem">Workflow Run #' + d.workflow_run_id + ' · ' + esc(d.period_label || '') + '</div>' +
                    (d.warning ? '<div class="error-banner" style="margin-top:14px;text-align:left">⚠️ ' + esc(d.warning) + '</div>' : '') +
                '</div>' +
                '<div style="text-align:center;">' +
                    '<button type="button" class="btn btn-ghost" onclick="closeGenFromPeriodModal();loadPeriods();">Close</button>' +
                '</div>';

            PracticeAPI.showToast('✅ Workflow generated — ' + d.task_count + ' tasks!');

        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
            btn.disabled = false; btn.textContent = '⚡ Generate Workflow';
        } finally {
            _submitting = false;
        }
        return false;
    }

    // ── Skip Period Modal ──────────────────────────────────────────────────────

    function openSkipModal(periodId) {
        _activePeriodId = periodId;
        document.getElementById('skipReason').value     = '';
        document.getElementById('skipSubmitBtn').disabled = false;
        document.getElementById('skipPeriodModal').classList.add('show');
    }

    function closeSkipModal() {
        document.getElementById('skipPeriodModal').classList.remove('show');
        _activePeriodId = null;
    }

    async function submitSkipPeriod() {
        if (!_activePeriodId || _submitting) return;
        var reason = document.getElementById('skipReason').value.trim();
        if (!reason) {
            PracticeAPI.showToast('❌ Reason is required to skip a period', true);
            return;
        }
        _submitting = true;
        document.getElementById('skipSubmitBtn').disabled = true;

        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/engagement-periods/' + _activePeriodId + '/skip',
                { method: 'PUT', body: JSON.stringify({ reason }) }
            );
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Skip failed');
            closeSkipModal();
            PracticeAPI.showToast('Period skipped.');
            loadPeriods();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
            document.getElementById('skipSubmitBtn').disabled = false;
        } finally {
            _submitting = false;
        }
    }

    // ── Cancel Period ──────────────────────────────────────────────────────────

    async function cancelPeriod(periodId) {
        if (!confirm('Cancel this period? It will be excluded from the active queue. (Can be re-queued by generating the same date range again.)')) return;
        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/engagement-periods/' + periodId + '/cancel',
                { method: 'PUT', body: '{}' }
            );
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Cancel failed');
            PracticeAPI.showToast('Period cancelled.');
            loadPeriods();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        }
    }

    // ── Expose globals ─────────────────────────────────────────────────────────

    window.loadPeriods          = loadPeriods;
    window.resetFilters         = resetFilters;
    window.gotoPage             = gotoPage;
    window.openGenFromPeriod    = openGenFromPeriod;
    window.closeGenFromPeriodModal = closeGenFromPeriodModal;
    window.submitGenFromPeriod  = submitGenFromPeriod;
    window.toggleGfpDeadlineTitle = toggleGfpDeadlineTitle;
    window.openSkipModal        = openSkipModal;
    window.closeSkipModal       = closeSkipModal;
    window.submitSkipPeriod     = submitSkipPeriod;
    window.cancelPeriod         = cancelPeriod;

    init();
})();
