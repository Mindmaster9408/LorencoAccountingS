/* Codebox 67 — Secretarial Statutory Calendar + Compliance Scheduler
 * "The Practice should never miss a statutory deadline." Manager-driven.
 * Prefix: sc
 */
(function () {
    'use strict';

    var BASE = '/api/practice/secretarial-calendar';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'calendar';
    var _calendarData = null;
    var _clientNameById = {};

    var TYPE_LABELS = {
        annual_return: 'Annual Return', beneficial_ownership_review: 'Beneficial Ownership Review',
        director_register_review: 'Director Register Review', share_register_review: 'Share Register Review',
        company_information_review: 'Company Information Review', financial_year_end_review: 'Financial Year-End Review',
        company_secretary_review: 'Company Secretary Review', auditor_review: 'Auditor Review',
        accounting_officer_review: 'Accounting Officer Review', custom: 'Custom',
    };
    var FREQUENCY_LABELS = { one_off: 'One-Off', monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-Yearly', annual: 'Annual', every_x_months: 'Every X Months', manual: 'Manual' };
    var CATEGORY_LABELS = { upcoming: 'Upcoming', due_today: 'Due Today', overdue: 'Overdue', blocked: 'Blocked', waiting: 'Waiting', completed: 'Completed', future: 'Future' };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _catPill(cat) { return '<span class="pill cat-' + _html(cat) + '">' + _html(CATEGORY_LABELS[cat] || cat) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function scLoadAll() {
        _renderTabBar();
        _loadClientOptions(); // also triggers scLoadObligations() once client names are available
        scLoadCalendar();
    }

    function _renderTabBar() {
        var tabs = [['calendar', 'Calendar'], ['upcoming', 'Upcoming'], ['overdue', 'Overdue'], ['blocked', 'Blocked'], ['completed', 'Completed'], ['templates', 'Templates']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="scSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function scSetTab(tab) { _tab = tab; _renderTabBar(); }

    function _loadClientOptions() {
        window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var clients = d.clients || [];
                clients.forEach(function (c) { _clientNameById[c.id] = c.name; });
                var sel = document.getElementById('ofClient');
                sel.innerHTML = clients.map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
                scLoadObligations();
            })
            .catch(function () {});
    }

    // ── Calendar ──────────────────────────────────────────────────────────────

    function scLoadCalendar() {
        window.PracticeAPI.fetch(BASE + '/calendar')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _calendarData = d;
                _renderSummary(d.counts || {});
                _renderCalendarTable(d.items || []);
                _renderBucketTable('upcomingBody', d.buckets.upcoming || [], false);
                _renderBucketTable('overdueBody', d.buckets.overdue || [], false);
                _renderBucketTable('blockedBody', d.buckets.blocked || [], true);
                _renderCompletedTable(d.buckets.completed || []);
            })
            .catch(function () { _showToast('Failed to load calendar.'); });
    }

    function _renderSummary(counts) {
        var cards = [
            { count: counts.overdue || 0, label: 'Overdue' },
            { count: counts.due_today || 0, label: 'Due Today' },
            { count: counts.upcoming || 0, label: 'Upcoming' },
            { count: counts.blocked || 0, label: 'Blocked' },
            { count: counts.waiting || 0, label: 'Waiting' },
            { count: counts.completed || 0, label: 'Completed' },
            { count: counts.future || 0, label: 'Future' },
        ];
        document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
            return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
        }).join('');
    }

    function _renderCalendarTable(items) {
        var rows = items.filter(function (i) { return i.category !== 'completed'; });
        if (!rows.length) { document.getElementById('calendarBody').innerHTML = '<tr><td colspan="6" class="empty-state">Nothing scheduled.</td></tr>'; return; }
        document.getElementById('calendarBody').innerHTML = rows.map(function (i) {
            var completeBtn = '<button class="btn-action btn-success" onclick="scMarkComplete(' + i.id + ')">Mark Complete</button>';
            return '<tr><td>' + _html(i.client_name) + '</td><td>' + _html(i.period_label) + '</td><td>' + _fmtDate(i.due_date) + '</td>' +
                '<td>' + _catPill(i.category) + '</td><td>' + _html(i.notes || '') + '</td><td>' + completeBtn + '</td></tr>';
        }).join('');
    }

    function _renderBucketTable(elId, items, showReasons) {
        var el = document.getElementById(elId);
        if (!items.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">None.</td></tr>'; return; }
        el.innerHTML = items.map(function (i) {
            if (showReasons) {
                return '<tr><td>' + _html(i.client_name) + '</td><td>' + _html(i.period_label) + '</td><td>' + _fmtDate(i.due_date) + '</td>' +
                    '<td>' + _html((i.dependency_reasons || []).join('; ')) + '</td></tr>';
            }
            return '<tr><td>' + _html(i.client_name) + '</td><td>' + _html(i.period_label) + '</td><td>' + _fmtDate(i.due_date) + '</td>' +
                '<td><button class="btn-action btn-success" onclick="scMarkComplete(' + i.id + ')">Mark Complete</button></td></tr>';
        }).join('');
    }

    function _renderCompletedTable(items) {
        var el = document.getElementById('completedBody');
        if (!items.length) { el.innerHTML = '<tr><td colspan="4" class="empty-state">None.</td></tr>'; return; }
        el.innerHTML = items.map(function (i) {
            return '<tr><td>' + _html(i.client_name) + '</td><td>' + _html(i.period_label) + '</td><td>' + _fmtDate(i.due_date) + '</td><td>' + _fmt(i.completed_at) + '</td></tr>';
        }).join('');
    }

    function scMarkComplete(scheduleId) {
        window.PracticeAPI.fetch(BASE + '/schedule/' + scheduleId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Marked complete.'); scLoadCalendar(); })
            .catch(function () { _showToast('Failed to update.'); });
    }

    // ── Obligations (Templates) ──────────────────────────────────────────────

    function scLoadObligations() {
        window.PracticeAPI.fetch(BASE + '/obligations')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.obligations || [];
                if (!rows.length) { document.getElementById('obligationsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No obligations defined.</td></tr>'; return; }
                document.getElementById('obligationsBody').innerHTML = rows.map(function (o) {
                    return '<tr><td>' + _html(_clientNameById[o.client_id] || ('#' + o.client_id)) + '</td><td>' + _html(o.title) + '</td><td>' + _html(TYPE_LABELS[o.obligation_type] || o.obligation_type) + '</td>' +
                        '<td>' + _html(FREQUENCY_LABELS[o.frequency] || o.frequency) + '</td>' +
                        '<td><span class="pill ' + (o.is_active ? 'obl-active' : 'obl-inactive') + '">' + (o.is_active ? 'Active' : 'Inactive') + '</span></td>' +
                        '<td><button class="btn-action btn-primary" onclick="scGenerateSchedule(' + o.id + ')">Generate Schedule</button> ' +
                        '<button class="btn-action btn-secondary" onclick="scOpenObligationDetail(' + o.id + ')">Details</button></td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('obligationsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load.</td></tr>'; });
    }

    function scOpenObligation() { document.getElementById('obligationModal').classList.add('open'); }
    function scCloseObligation() { document.getElementById('obligationModal').classList.remove('open'); }
    function scToggleEveryX() {
        document.getElementById('ofEveryXGroup').style.display = document.getElementById('ofFrequency').value === 'every_x_months' ? 'flex' : 'none';
    }
    function scSubmitObligation() {
        var body = {
            client_id: document.getElementById('ofClient').value,
            obligation_type: document.getElementById('ofType').value,
            title: document.getElementById('ofTitle').value,
            frequency: document.getElementById('ofFrequency').value,
            every_x_months: document.getElementById('ofEveryXMonths').value || null,
            due_rule: {
                anchor: document.getElementById('ofAnchor').value,
                offset_days: parseInt(document.getElementById('ofOffsetDays').value) || 0,
                fixed_month_day: document.getElementById('ofFixedMonthDay').value || null,
            },
            warning_days: document.getElementById('ofWarningDays').value || 30,
            grace_period_days: document.getElementById('ofGraceDays').value || 0,
            notes: document.getElementById('ofNotes').value || null,
        };
        if (!body.client_id) { _showToast('Client is required.'); return; }
        if (!body.title) { _showToast('Title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/obligations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Obligation created.'); scCloseObligation(); scLoadObligations(); })
            .catch(function () { _showToast('Failed to create obligation.'); });
    }

    function scGenerateSchedule(obligationId) {
        window.PracticeAPI.fetch(BASE + '/obligations/' + obligationId + '/generate-schedule', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(d.message || 'Schedule generated.'); scLoadCalendar(); })
            .catch(function () { _showToast('Failed to generate schedule.'); });
    }

    function scOpenObligationDetail(id) {
        window.PracticeAPI.fetch(BASE + '/obligations/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var o = d.obligation;
                var html = '<div class="modal-title">' + _html(o.title) + '</div>';
                html += '<div class="mini-card">Type: ' + _html(TYPE_LABELS[o.obligation_type] || o.obligation_type) + ' &middot; Frequency: ' + _html(FREQUENCY_LABELS[o.frequency] || o.frequency) + '</div>';
                html += '<div class="mini-card">Due Rule: <pre style="white-space:pre-wrap;font-size:.76rem;margin-top:4px;">' + _html(JSON.stringify(o.due_rule, null, 2)) + '</pre></div>';
                html += '<div class="mini-card">Warning Days: ' + o.warning_days + ' &middot; Grace Period: ' + o.grace_period_days + ' &middot; Mandatory: ' + (o.mandatory ? 'Yes' : 'No') + '</div>';
                if (o.notes) html += '<div class="mini-card">' + _html(o.notes) + '</div>';
                document.getElementById('obligationDetailBody').innerHTML = html;
                document.getElementById('obligationDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load obligation.'); });
    }
    function scCloseObligationDetail() { document.getElementById('obligationDetailModal').classList.remove('open'); }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.scSetTab = scSetTab;
    window.scMarkComplete = scMarkComplete;
    window.scOpenObligation = scOpenObligation;
    window.scCloseObligation = scCloseObligation;
    window.scToggleEveryX = scToggleEveryX;
    window.scSubmitObligation = scSubmitObligation;
    window.scGenerateSchedule = scGenerateSchedule;
    window.scOpenObligationDetail = scOpenObligationDetail;
    window.scCloseObligationDetail = scCloseObligationDetail;

    document.addEventListener('DOMContentLoaded', scLoadAll);
})();
