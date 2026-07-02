/* Codebox 57 — Practice Resource Forecasting + Future Capacity Planning
 * "Will we have enough people and hours next month?" NOT AI. NOT auto-scheduling.
 * Prefix: rf
 */
(function () {
    'use strict';

    var BASE = '/api/practice/resource-forecasting';
    var _teamList = [];

    var STATUS_LABELS = { under_capacity: 'Under Capacity', normal: 'Normal', high: 'High', over_capacity: 'Over Capacity', critical: 'Critical', unknown: 'Unknown' };
    var STATUS_COLORS = { under_capacity: '#667eea', normal: '#48bb78', high: '#ed8936', over_capacity: '#f6ad55', critical: '#e53e3e', unknown: '#4a5568' };
    var PRESSURE_LABELS = { normal: 'Normal', medium: 'Medium', high: 'High', critical: 'Critical' };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) : '—'; }
    function _fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }
    function _statusPill(s) { return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>'; }
    function _deniedCheck(status) {
        if (status === 403) {
            document.getElementById('pageContent').style.display = 'none';
            document.getElementById('deniedState').style.display = 'block';
            return true;
        }
        return false;
    }

    function _qs() {
        var p = [];
        var start = document.getElementById('rfStartDate').value.trim();
        var weeks = document.getElementById('rfWeeks').value;
        var member = document.getElementById('rfTeamMember').value;
        if (start) p.push('start_date=' + encodeURIComponent(start));
        if (weeks) p.push('weeks=' + encodeURIComponent(weeks));
        if (member) p.push('team_member_id=' + encodeURIComponent(member));
        return p.length ? '?' + p.join('&') : '';
    }
    function _qsNoMember() {
        var p = [];
        var start = document.getElementById('rfStartDate').value.trim();
        var weeks = document.getElementById('rfWeeks').value;
        if (start) p.push('start_date=' + encodeURIComponent(start));
        if (weeks) p.push('weeks=' + encodeURIComponent(weeks));
        return p.length ? '?' + p.join('&') : '';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function rfLoadAll() {
        _loadSummary();
        _loadWeekBoard();
        _loadTeam();
        _loadClients();
        _loadDeadlines();
        _loadSnapshots();
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary' + _qs())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.total_capacity_hours, label: 'Total Capacity (hrs)', cls: '' },
                    { count: d.total_allocated_hours, label: 'Allocated (hrs)', cls: '' },
                    { count: d.capacity_gap, label: 'Capacity Gap (hrs)', cls: d.capacity_gap > 0 ? 'danger' : '' },
                    { count: d.overloaded_weeks, label: 'Overloaded Weeks', cls: d.overloaded_weeks > 0 ? 'warn' : '' },
                    { count: d.critical_weeks, label: 'Critical Weeks', cls: d.critical_weeks > 0 ? 'danger' : '' },
                    { count: d.unscheduled_item_count, label: 'Unscheduled Items', cls: '' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card ' + c.cls + '"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Weekly Forecast Board ────────────────────────────────────────────────

    function _loadWeekBoard() {
        window.PracticeAPI.fetch(BASE + '/forecast' + _qs())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                var weekly = d.weekly || [];
                var board = document.getElementById('weekBoard');
                if (!weekly.length) { board.innerHTML = '<div class="empty-state">No forecast data.</div>'; return; }
                var maxHours = Math.max.apply(null, weekly.map(function (w) { return Math.max(w.capacity_hours, w.allocated_hours); }).concat([1]));
                board.innerHTML = weekly.map(function (w, idx) {
                    var capH = Math.round((w.capacity_hours / maxHours) * 100);
                    var allocH = Math.round((w.allocated_hours / maxHours) * 100);
                    var color = STATUS_COLORS[w.status] || '#4a5568';
                    return '<div class="week-col">' +
                        '<div>Week ' + (idx + 1) + '</div>' +
                        '<div class="week-col-dates">' + _fmtDate(w.week_start) + ' – ' + _fmtDate(w.week_end) + '</div>' +
                        '<div class="week-bar-wrap">' +
                        '<div class="week-bar week-bar-cap" style="height:' + capH + '%;" title="Capacity: ' + w.capacity_hours + 'h"></div>' +
                        '<div class="week-bar week-bar-alloc" style="height:' + allocH + '%;background:' + color + ';" title="Allocated: ' + w.allocated_hours + 'h"></div>' +
                        '</div>' +
                        '<div class="week-pct" style="color:' + color + ';">' + (w.utilization_percentage != null ? w.utilization_percentage + '%' : '—') + '</div>' +
                        '<div class="week-status">' + _html(STATUS_LABELS[w.status] || w.status) + '</div>' +
                        '</div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Team Forecast ─────────────────────────────────────────────────────────

    function _loadTeam() {
        window.PracticeAPI.fetch(BASE + '/team' + _qsNoMember())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                _teamList = d.team || [];
                document.getElementById('teamCount').textContent = '(' + _teamList.length + ')';
                _populateTeamMemberFilter();
                var body = document.getElementById('teamBody');
                body.innerHTML = _teamList.length ? _teamList.map(function (m) {
                    return '<tr class="clickable" onclick="window.location.href=\'' + m.work_queue_link + '\'">' +
                        '<td>' + _html(m.display_name) + '</td>' +
                        '<td>' + (m.weekly_capacity != null ? m.weekly_capacity + 'h/wk' : '—') + '</td>' +
                        '<td>' + m.total_capacity + 'h</td>' +
                        '<td>' + m.total_allocated + 'h</td>' +
                        '<td style="color:' + (m.capacity_gap > 0 ? '#fc8181' : '#68d391') + ';">' + (m.capacity_gap > 0 ? '+' : '') + m.capacity_gap + 'h</td>' +
                        '<td>' + m.overloaded_weeks + '</td>' +
                        '<td>' + _statusPill(m.status) + '</td>' +
                        '<td><button class="btn-action btn-secondary" style="padding:4px 10px;font-size:.72rem;" onclick="event.stopPropagation();window.location.href=\'' + m.work_queue_link + '\'">Open Queue</button></td>' +
                        '</tr>';
                }).join('') : '<tr><td colspan="8" class="empty-state">No team members found.</td></tr>';
            })
            .catch(function () {});
    }

    function _populateTeamMemberFilter() {
        var sel = document.getElementById('rfTeamMember');
        var current = sel.value;
        sel.innerHTML = '<option value="">— Whole Team —</option>' + _teamList.map(function (m) {
            return '<option value="' + m.team_member_id + '">' + _html(m.display_name) + '</option>';
        }).join('');
        sel.value = current;
    }

    // ── Client Pressure ───────────────────────────────────────────────────────

    function _loadClients() {
        window.PracticeAPI.fetch(BASE + '/clients' + _qsNoMember())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                var clients = d.clients || [];
                var body = document.getElementById('clientBody');
                body.innerHTML = clients.length ? clients.map(function (c) {
                    return '<tr>' +
                        '<td>' + _html(c.client_name) + '</td>' +
                        '<td>' + c.estimated_hours_next_weeks + 'h</td>' +
                        '<td>' + c.deadline_count + '</td>' +
                        '<td>' + c.tax_item_count + '</td>' +
                        '<td>' + c.document_count + '</td>' +
                        '<td>' + c.risk_count + '</td>' +
                        '<td><span class="pill st-' + (c.pressure_status === 'critical' ? 'critical' : c.pressure_status === 'high' ? 'over_capacity' : c.pressure_status === 'medium' ? 'high' : 'normal') + '">' + _html(PRESSURE_LABELS[c.pressure_status] || c.pressure_status) + '</span></td>' +
                        '</tr>';
                }).join('') : '<tr><td colspan="7" class="empty-state">No client work scheduled in this window.</td></tr>';
            })
            .catch(function () {});
    }

    // ── Deadline Pressure ─────────────────────────────────────────────────────

    function _loadDeadlines() {
        window.PracticeAPI.fetch(BASE + '/deadlines' + _qsNoMember())
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                var deadlines = d.deadlines || [];
                var body = document.getElementById('deadlineBody');
                body.innerHTML = deadlines.length ? deadlines.map(function (dl) {
                    return '<tr class="clickable" onclick="window.location.href=\'' + dl.deep_link + '\'">' +
                        '<td>' + _html(dl.title) + '</td>' +
                        '<td>' + _html(dl.client_name || 'Internal') + '</td>' +
                        '<td' + (dl.is_overdue ? ' style="color:#fc8181;font-weight:700;"' : '') + '>' + _fmtDate(dl.due_date) + '</td>' +
                        '<td>' + _html(dl.owner_name) + '</td>' +
                        '<td><span class="conf-' + dl.confidence + '">' + dl.estimated_hours + 'h*</span></td>' +
                        '<td>' + _statusPill(dl.risk_level === 'critical' ? 'critical' : dl.risk_level === 'high' ? 'over_capacity' : 'normal') + '</td>' +
                        '<td>' + (dl.week_bucket != null ? 'Week ' + (dl.week_bucket + 1) : 'Beyond window') + '</td>' +
                        '</tr>';
                }).join('') : '<tr><td colspan="7" class="empty-state">No deadlines in this window.</td></tr>';
            })
            .catch(function () {});
    }

    // ── Snapshots ─────────────────────────────────────────────────────────────

    function _loadSnapshots() {
        window.PracticeAPI.fetch(BASE + '/snapshots')
            .then(function (r) { if (_deniedCheck(r.status)) throw new Error('denied'); return r.json(); })
            .then(function (d) {
                var snaps = d.snapshots || [];
                document.getElementById('snapshotCount').textContent = '(' + snaps.length + ')';
                var body = document.getElementById('snapshotBody');
                body.innerHTML = snaps.length ? snaps.map(function (s) {
                    var gap = s.summary_data ? s.summary_data.capacity_gap : null;
                    return '<tr class="clickable" onclick="rfOpenSnapshotDetail(' + s.id + ')">' +
                        '<td>' + _html(s.snapshot_name) + '</td>' +
                        '<td>' + _fmtDate(s.forecast_start_date) + ' – ' + _fmtDate(s.forecast_end_date) + '</td>' +
                        '<td>' + s.forecast_weeks + '</td>' +
                        '<td style="color:' + (gap > 0 ? '#fc8181' : '#68d391') + ';">' + (gap != null ? (gap > 0 ? '+' : '') + gap + 'h' : '—') + '</td>' +
                        '<td>' + _fmtDateTime(s.created_at) + '</td>' +
                        '<td><button class="btn-action btn-danger" style="padding:4px 10px;font-size:.72rem;" onclick="event.stopPropagation();rfArchiveSnapshot(' + s.id + ')">Archive</button></td>' +
                        '</tr>';
                }).join('') : '<tr><td colspan="6" class="empty-state">No saved snapshots yet.</td></tr>';
            })
            .catch(function () {});
    }

    function rfOpenSnapshotModal() {
        document.getElementById('sfName').value = '';
        document.getElementById('sfNotes').value = '';
        document.getElementById('snapshotModal').classList.add('open');
    }
    function rfCloseSnapshotModal() { document.getElementById('snapshotModal').classList.remove('open'); }

    function rfSubmitSnapshot() {
        var name = document.getElementById('sfName').value.trim();
        if (!name) return _showToast('Snapshot name is required.');
        var start = document.getElementById('rfStartDate').value.trim();
        var weeks = document.getElementById('rfWeeks').value;
        window.PracticeAPI.fetch(BASE + '/snapshots', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snapshot_name: name, notes: document.getElementById('sfNotes').value.trim() || null, start_date: start || null, weeks: weeks }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Forecast snapshot saved.');
                rfCloseSnapshotModal();
                _loadSnapshots();
            })
            .catch(function () { _showToast('Failed to save snapshot.'); });
    }

    function rfOpenSnapshotDetail(id) {
        window.PracticeAPI.fetch(BASE + '/snapshots/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var s = d.snapshot;
                if (!s) return;
                document.getElementById('snapshotDetailTitle').textContent = s.snapshot_name;
                var sum = s.summary_data || {};
                document.getElementById('snapshotDetailBody').innerHTML =
                    '<div style="font-size:.82rem;color:#a0aec0;margin-bottom:10px;">' + _fmtDate(s.forecast_start_date) + ' – ' + _fmtDate(s.forecast_end_date) + ' (' + s.forecast_weeks + ' weeks)</div>' +
                    (s.notes ? '<div style="font-size:.82rem;margin-bottom:12px;">' + _html(s.notes) + '</div>' : '') +
                    '<div style="font-size:.8rem;line-height:1.9;">' +
                    'Total Capacity: <b>' + sum.total_capacity_hours + 'h</b><br/>' +
                    'Total Allocated: <b>' + sum.total_allocated_hours + 'h</b><br/>' +
                    'Capacity Gap: <b style="color:' + (sum.capacity_gap > 0 ? '#fc8181' : '#68d391') + ';">' + (sum.capacity_gap > 0 ? '+' : '') + sum.capacity_gap + 'h</b><br/>' +
                    'Overloaded Weeks: <b>' + sum.overloaded_weeks + '</b><br/>' +
                    'Critical Weeks: <b>' + sum.critical_weeks + '</b>' +
                    '</div>';
                document.getElementById('snapshotDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load snapshot.'); });
    }
    function rfCloseSnapshotDetail() { document.getElementById('snapshotDetailModal').classList.remove('open'); }

    function rfArchiveSnapshot(id) {
        if (!confirm('Archive this forecast snapshot?')) return;
        window.PracticeAPI.fetch(BASE + '/snapshots/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Snapshot archived.');
                _loadSnapshots();
            })
            .catch(function () { _showToast('Failed to archive snapshot.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.rfLoadAll = rfLoadAll;
    window.rfOpenSnapshotModal = rfOpenSnapshotModal;
    window.rfCloseSnapshotModal = rfCloseSnapshotModal;
    window.rfSubmitSnapshot = rfSubmitSnapshot;
    window.rfOpenSnapshotDetail = rfOpenSnapshotDetail;
    window.rfCloseSnapshotDetail = rfCloseSnapshotDetail;
    window.rfArchiveSnapshot = rfArchiveSnapshot;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        rfLoadAll();
    });

}());
