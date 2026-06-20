(function () {
    'use strict';

    // ── Date helpers ──────────────────────────────────────────────────────────

    function fmtDate(d) {
        if (!d) return '—';
        var parts = d.slice(0, 10).split('-');
        return parts[2] + '/' + parts[1] + '/' + parts[0];
    }

    function relativeDate(isoStr) {
        if (!isoStr) return '';
        var now  = new Date();
        var then = new Date(isoStr);
        var diff = Math.round((now - then) / 60000); // minutes
        if (diff < 2)   return 'just now';
        if (diff < 60)  return diff + 'm ago';
        var h = Math.round(diff / 60);
        if (h < 24)     return h + 'h ago';
        var d = Math.round(h / 24);
        if (d < 30)     return d + 'd ago';
        return fmtDate(isoStr.slice(0, 10));
    }

    function esc(s) { return PracticeAPI.escHtml(String(s || '')); }

    // ── DOM helpers ───────────────────────────────────────────────────────────

    function el(id)         { return document.getElementById(id); }
    function setText(id, v) { var e = el(id); if (e) e.textContent = v; }
    function setClass(id, cls) {
        var e = el(id);
        if (e) { e.className = e.className.replace(/\bv-\S+/g, '').trim(); if (cls) e.classList.add(cls); }
    }

    function showLoading(id) { var e = el(id); if (e) { e.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading…</p></div>'; } }
    function showError(id, msg) { var e = el(id); if (e) { e.innerHTML = '<div class="error-banner">⚠️ ' + esc(msg || 'Failed to load') + '</div>'; } }

    // ── Risk colour logic ──────────────────────────────────────────────────────
    // RED/AMBER/GREEN determined from transparent counts only.

    function kpiColour(count, thresholds) {
        // thresholds = { danger: N, warning: N }
        if (!thresholds) return '';
        if (count >= thresholds.danger)  return 'v-danger';
        if (count >= thresholds.warning) return 'v-warning';
        return 'v-success';
    }

    // ── Render helpers ────────────────────────────────────────────────────────

    function panelCountClass(count, thresholds) {
        if (!thresholds || count === 0) return 'panel-count-muted';
        if (count >= thresholds.danger)  return 'panel-count-danger';
        if (count >= thresholds.warning) return 'panel-count-warning';
        return 'panel-count-accent';
    }

    function emptyRow(colspan, msg) {
        return '<tr><td colspan="' + colspan + '" style="text-align:center;color:var(--text-muted);padding:18px;font-size:0.8rem;">' + esc(msg) + '</td></tr>';
    }

    function emptyPanel(msg) {
        return '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.82rem;">' + esc(msg) + '</div>';
    }

    // ── Load: summary KPIs ────────────────────────────────────────────────────

    async function loadSummary() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/dashboard/summary');
            if (!res.ok) { loadSummaryFallback(); return; }
            var d = await res.json();

            setText('kpiClients',     d.active_clients         ?? '–');
            setText('kpiEngagements', d.active_engagements     ?? '–');
            setText('kpiOverdue',     d.overdue_deadlines      ?? '–');
            setText('kpiDueWeek',     d.due_this_week          ?? '–');
            setText('kpiReview',      d.tasks_in_review        ?? '–');
            setText('kpiApproval',    d.tasks_pending_approval ?? '–');
            setText('kpiWorkflows',   d.active_workflows       ?? '–');
            setText('kpiBilling',     d.billing_pending        ?? '–');
            setText('kpiPeriods',     d.periods_pending        ?? '–');

            // Colour KPI values based on urgency
            setClass('kpiOverdue',  d.overdue_deadlines      > 0 ? 'v-danger'  : 'v-success');
            setClass('kpiDueWeek',  d.due_this_week          > 3 ? 'v-warning' : (d.due_this_week > 0 ? 'v-warning' : 'v-success'));
            setClass('kpiReview',   d.tasks_in_review        > 5 ? 'v-danger'  : (d.tasks_in_review > 0 ? 'v-warning' : 'v-success'));
            setClass('kpiApproval', d.tasks_pending_approval > 5 ? 'v-danger'  : (d.tasks_pending_approval > 0 ? 'v-warning' : 'v-success'));
            setClass('kpiWorkflows', '');
            setClass('kpiBilling',  d.billing_pending        > 0 ? 'v-warning' : 'v-success');
            setClass('kpiPeriods',  d.periods_pending        > 0 ? 'v-warning' : 'v-success');

        } catch (e) {
            loadSummaryFallback();
        }
    }

    // Fallback to the legacy /api/practice/dashboard endpoint
    async function loadSummaryFallback() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/dashboard');
            if (!res.ok) return;
            var d = await res.json();
            setText('kpiClients',   d.total_clients    ?? '–');
            setText('kpiOverdue',   d.overdue_tasks    ?? '–');
            setText('kpiDueWeek',   d.upcoming_deadlines ?? '–');
            setText('kpiWorkflows', d.open_tasks        ?? '–');
        } catch (e) {}
    }

    // ── Load: risk panels ─────────────────────────────────────────────────────

    async function loadRisk() {
        showLoading('panelOverdueBody');
        showLoading('panelDueBody');
        showLoading('panelReviewBody');
        showLoading('panelBillingBody');

        try {
            var res = await PracticeAPI.fetch('/api/practice/dashboard/risk');
            if (!res.ok) throw new Error('status ' + res.status);
            var d = await res.json();

            renderOverduePanel(d.overdue_deadlines || []);
            renderDueWeekPanel(d.due_this_week     || []);
            renderReviewPanel(d.review_backlog     || [], d.approval_backlog || []);
            renderBillingPanel(d.billing_pending   || [], d.periods_pending  || []);

            // Update panel header counts
            el('panelOverdueCount').textContent = d.overdue_deadlines?.length ?? 0;
            el('panelOverdueCount').className   = 'panel-count ' + (d.overdue_deadlines?.length ? 'panel-count-danger' : 'panel-count-muted');
            el('panelDueCount').textContent     = d.due_this_week?.length ?? 0;
            el('panelDueCount').className       = 'panel-count ' + (d.due_this_week?.length ? 'panel-count-warning' : 'panel-count-muted');
            el('panelReviewCount').textContent  = (d.review_backlog?.length ?? 0) + (d.approval_backlog?.length ?? 0);
            el('panelReviewCount').className    = 'panel-count ' + ((d.review_backlog?.length || d.approval_backlog?.length) ? 'panel-count-accent' : 'panel-count-muted');
            el('panelBillingCount').textContent = (d.billing_pending?.length ?? 0) + (d.periods_pending?.length ?? 0);
            el('panelBillingCount').className   = 'panel-count ' + ((d.billing_pending?.length || d.periods_pending?.length) ? 'panel-count-accent' : 'panel-count-muted');

        } catch (err) {
            showError('panelOverdueBody', 'Failed to load risk data');
            showError('panelDueBody', '');
            showError('panelReviewBody', '');
            showError('panelBillingBody', '');
        }
    }

    function renderOverduePanel(items) {
        if (!items.length) { el('panelOverdueBody').innerHTML = emptyPanel('No overdue deadlines'); return; }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var r = items[i];
            html += '<div class="risk-row">' +
                '<div class="risk-row-main">' +
                '<div class="risk-row-title">' + esc(r.title) + '</div>' +
                '<div class="risk-row-meta">' + esc(r.client_name || '—') +
                (r.compliance_area ? ' · ' + esc(r.compliance_area) : '') +
                (r.responsible ? ' · ' + esc(r.responsible) : '') + '</div>' +
                '</div>' +
                '<span class="risk-row-badge risk-badge-overdue">' + esc(r.days_overdue) + 'd overdue</span>' +
                '</div>';
        }
        el('panelOverdueBody').innerHTML = html;
    }

    function renderDueWeekPanel(items) {
        if (!items.length) { el('panelDueBody').innerHTML = emptyPanel('No deadlines due this week'); return; }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var r = items[i];
            html += '<div class="risk-row">' +
                '<div class="risk-row-main">' +
                '<div class="risk-row-title">' + esc(r.title) + '</div>' +
                '<div class="risk-row-meta">' + esc(r.client_name || '—') +
                (r.compliance_area ? ' · ' + esc(r.compliance_area) : '') +
                ' · ' + fmtDate(r.due_date) + '</div>' +
                '</div>' +
                '<span class="risk-row-badge risk-badge-due">' + (r.days_until === 0 ? 'Today' : esc(r.days_until) + 'd') + '</span>' +
                '</div>';
        }
        el('panelDueBody').innerHTML = html;
    }

    function renderReviewPanel(review, approval) {
        var all = review.map(function(r) { return { type: 'Review', item: r }; })
                .concat(approval.map(function(r) { return { type: 'Approval', item: r }; }));

        if (!all.length) { el('panelReviewBody').innerHTML = emptyPanel('No tasks pending review or approval'); return; }
        var html = '';
        for (var i = 0; i < all.length; i++) {
            var r = all[i].item;
            var t = all[i].type;
            html += '<div class="risk-row">' +
                '<div class="risk-row-main">' +
                '<div class="risk-row-title">' + esc(r.title) + '</div>' +
                '<div class="risk-row-meta">' + esc(r.client_name || '—') +
                (t === 'Review' ? (r.reviewer ? ' · ' + esc(r.reviewer) : '') : (r.approver ? ' · ' + esc(r.approver) : '')) + '</div>' +
                '</div>' +
                '<span class="risk-row-badge risk-badge-review">' + esc(t) + '</span>' +
                '</div>';
        }
        el('panelReviewBody').innerHTML = html;
    }

    function renderBillingPanel(packs, periods) {
        if (!packs.length && !periods.length) { el('panelBillingBody').innerHTML = emptyPanel('No billing packs or periods pending'); return; }
        var html = '';
        for (var i = 0; i < packs.length; i++) {
            var r = packs[i];
            var val = r.total_value != null ? 'R ' + Number(r.total_value).toFixed(2) : '';
            html += '<div class="risk-row">' +
                '<div class="risk-row-main">' +
                '<div class="risk-row-title">Pack #' + esc(r.pack_number) + (r.pack_name ? ' — ' + esc(r.pack_name) : '') + '</div>' +
                '<div class="risk-row-meta">' + esc(r.client_name || '—') + (val ? ' · ' + esc(val) : '') + '</div>' +
                '</div>' +
                '<span class="risk-row-badge risk-badge-review">' + esc(r.status) + '</span>' +
                '</div>';
        }
        for (var j = 0; j < periods.length; j++) {
            var p = periods[j];
            html += '<div class="risk-row">' +
                '<div class="risk-row-main">' +
                '<div class="risk-row-title">' + esc(p.period_label) + '</div>' +
                '<div class="risk-row-meta">' + esc(p.client_name || '—') + (p.engagement_name ? ' · ' + esc(p.engagement_name) : '') + '</div>' +
                '</div>' +
                '<span class="risk-row-badge risk-badge-due">Queued</span>' +
                '</div>';
        }
        el('panelBillingBody').innerHTML = html;
    }

    // ── Load: team workload ───────────────────────────────────────────────────

    async function loadWorkload() {
        showLoading('workloadBody');
        try {
            var res = await PracticeAPI.fetch('/api/practice/dashboard/workload');
            if (!res.ok) throw new Error('status ' + res.status);
            var d   = await res.json();
            var rows = d.workload || [];

            if (!rows.length) {
                el('workloadBody').innerHTML = '<tr>' + emptyRow(5, 'No team members found') + '</tr>';
                return;
            }

            var html = '';
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var total = r.active_tasks + r.review_tasks + r.deadlines_owned;
                var taskCls  = r.active_tasks  > 10 ? 'n-danger' : (r.active_tasks  > 5 ? 'n-warning' : 'n-ok');
                var revCls   = r.review_tasks  > 3  ? 'n-danger' : (r.review_tasks  > 0 ? 'n-warning' : 'n-ok');
                var dlCls    = r.deadlines_owned > 3 ? 'n-danger' : (r.deadlines_owned > 0 ? 'n-warning' : 'n-ok');
                html += '<tr>' +
                    '<td>' + esc(r.display_name) + '<div class="col-muted" style="font-size:0.72rem;">' + esc(r.role || '') + '</div></td>' +
                    '<td><span class="workload-num ' + taskCls + '">' + r.active_tasks + '</span></td>' +
                    '<td><span class="workload-num ' + revCls  + '">' + r.review_tasks + '</span></td>' +
                    '<td><span class="workload-num ' + dlCls   + '">' + r.deadlines_owned + '</span></td>' +
                    '<td class="col-muted">' + r.engagements_owned + '</td>' +
                    '</tr>';
            }
            el('workloadBody').innerHTML = html;
        } catch (err) {
            el('workloadBody').innerHTML = emptyRow(5, 'Failed to load workload data');
        }
    }

    // ── Load: activity feed ───────────────────────────────────────────────────

    var ACTIVITY_ICONS = {
        engagement: '⚡',
        deadline:   '📅',
        billing:    '💰',
    };

    function activityLabel(evt) {
        var t = (evt.event_type || '').replace(/_/g, ' ');
        var lbl = evt.label ? ' <strong>' + esc(evt.label) + '</strong>' : '';
        var client = evt.client_name ? ' · ' + esc(evt.client_name) : '';
        return esc(t) + lbl + '<span class="col-muted">' + client + '</span>';
    }

    async function loadActivity() {
        showLoading('activityBody');
        try {
            var res = await PracticeAPI.fetch('/api/practice/dashboard/activity');
            if (!res.ok) throw new Error('status ' + res.status);
            var d      = await res.json();
            var events = d.events || [];

            if (!events.length) {
                el('activityBody').innerHTML = '<div class="activity-item" style="justify-content:center;color:var(--text-muted);font-size:0.82rem;">No recent activity</div>';
                return;
            }

            var html = '';
            for (var i = 0; i < events.length; i++) {
                var e = events[i];
                var icon = ACTIVITY_ICONS[e.source] || '•';
                html += '<div class="activity-item">' +
                    '<div class="activity-icon src-' + esc(e.source) + '">' + icon + '</div>' +
                    '<div class="activity-body">' +
                    '<div class="activity-desc">' + activityLabel(e) + '</div>' +
                    '<div class="activity-meta">' + relativeDate(e.created_at) +
                    (e.created_by ? ' · ' + esc(e.created_by) : '') + '</div>' +
                    '</div></div>';
            }
            el('activityBody').innerHTML = html;
        } catch (err) {
            el('activityBody').innerHTML = '<div class="error-banner" style="margin:12px 16px;">⚠️ Failed to load activity</div>';
        }
    }

    // ── Boot ──────────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch (e) { window.location.href = '/'; return; }

        LAYOUT.init('dashboard');

        // Load all sections in parallel
        loadSummary();
        loadRisk();
        loadWorkload();
        loadActivity();
    }

    init();

})();
