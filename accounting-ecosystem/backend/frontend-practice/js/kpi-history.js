/* Codebox 51 — Practice KPI Engine + Historical Trend Analytics
 * Deterministic KPI history only. NOT AI. NOT forecasting.
 * Prefix: kpi
 */
(function () {
    'use strict';

    var BASE = '/api/practice/kpi-history';
    var _page = 1;
    var _submitting = false;
    var _selectedForCompare = [];
    var _currentId = null;
    var _currentSnapshot = null;
    var _currentTab = 'overview';

    // ── Constants ────────────────────────────────────────────────────────────

    var METRIC_LABELS = {
        overall_score: 'Overall Score', quality_score: 'Quality Score', compliance_score: 'Compliance Score',
        risk_score: 'Risk Score', capacity_score: 'Capacity Score', tax_score: 'Tax Score',
        open_risks: 'Open Risks', critical_risks: 'Critical Risks', open_findings: 'Open Findings',
        overdue_documents: 'Overdue Documents', tax_review_queue: 'Tax Review Queue',
        overdue_reminders: 'Overdue Reminders', capacity_overloaded_count: 'Capacity Overloaded Count',
    };

    var TYPE_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', manual: 'Manual' };
    var EV_LABELS = {
        kpi_snapshot_captured: 'Captured', kpi_snapshot_archived: 'Archived',
        kpi_snapshot_compared: 'Compared', kpi_trend_viewed: 'Trend Viewed',
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }

    function _dirArrow(dir) {
        if (dir === 'up') return '<span class="sc-trend-up">▲</span>';
        if (dir === 'down') return '<span class="sc-trend-down">▼</span>';
        if (dir === 'flat') return '<span class="sc-trend-flat">■</span>';
        return '—';
    }

    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function kpiLoadAll() {
        _loadSummary();
        kpiLoadList();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('capture') === '1') {
            kpiOpenCapture();
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {});
    }

    function _renderSummary(d) {
        var grid = document.getElementById('summaryGrid');
        var cards = [
            { count: d.total_snapshots || 0, label: 'Total Snapshots' },
            { count: d.monthly_snapshots || 0, label: 'Monthly' },
            { count: d.weekly_snapshots || 0, label: 'Weekly' },
            { count: d.manual_snapshots || 0, label: 'Manual' },
            { count: d.latest_snapshot_date ? _fmt(d.latest_snapshot_date) : '—', label: 'Latest Snapshot' },
            { count: d.trend_direction ? _dirArrow(d.trend_direction) + ' ' + d.trend_direction : 'Not enough data', label: 'Score Trend', raw: true },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card">' +
                '<div class="sc-count">' + (c.raw ? c.count : _html(c.count)) + '</div>' +
                '<div class="sc-label">' + _html(c.label) + '</div>' +
            '</div>';
        }).join('');
    }

    // ── Filters ───────────────────────────────────────────────────────────────

    function kpiClearFilters() {
        document.getElementById('filterSnapshotType').value = '';
        document.getElementById('filterStatus').value = 'active';
        document.getElementById('filterPeriodFrom').value = '';
        document.getElementById('filterPeriodTo').value = '';
        _page = 1;
        kpiLoadList();
    }

    function _qs() {
        var p = [];
        var type = document.getElementById('filterSnapshotType').value;
        var status = document.getElementById('filterStatus').value;
        var from = document.getElementById('filterPeriodFrom').value;
        var to = document.getElementById('filterPeriodTo').value;
        if (type) p.push('snapshot_type=' + encodeURIComponent(type));
        if (status) p.push('status=' + encodeURIComponent(status));
        if (from) p.push('period_from=' + encodeURIComponent(from));
        if (to) p.push('period_to=' + encodeURIComponent(to));
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function kpiLoadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.snapshots || [], d.total || 0, d.page || 1, d.limit || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8" style="color:#fc8181;">Failed to load snapshots</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No snapshots found. Capture the first one.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (s) {
            var period = s.period_key || (s.period_start ? (_fmtDate(s.period_start) + ' – ' + _fmtDate(s.period_end)) : '—');
            var score = s.score_data && s.score_data.overall_score != null ? s.score_data.overall_score : '—';
            var checked = _selectedForCompare.indexOf(s.id) !== -1 ? 'checked' : '';
            return '<tr class="clickable">' +
                '<td class="checkbox-cell" onclick="event.stopPropagation();"><input type="checkbox" ' + checked + ' onchange="_kpiToggleCompare(' + s.id + ', this.checked)" /></td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')" style="color:#4a5568;font-size:.78rem;">#' + s.id + '</td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')"><span class="type-chip">' + _html(TYPE_LABELS[s.snapshot_type] || s.snapshot_type) + '</span></td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')"><span class="pill st-' + _html(s.status) + '">' + _html(s.status) + '</span></td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')">' + _html(s.snapshot_name) + '</td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')" style="font-size:.8rem;">' + _html(period) + '</td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')">' + _html(score) + '</td>' +
                '<td onclick="kpiOpenDetail(' + s.id + ')" style="font-size:.78rem;color:#718096;">' + _fmt(s.generated_at) + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_kpiPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_kpiPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' snapshot' + (total !== 1 ? 's' : '');
        }
    }

    function _kpiPage(p) { _page = p; kpiLoadList(); }

    function _kpiToggleCompare(id, checked) {
        var idx = _selectedForCompare.indexOf(id);
        if (checked && idx === -1) {
            if (_selectedForCompare.length >= 2) { _showToast('Select only 2 snapshots to compare'); kpiLoadList(); return; }
            _selectedForCompare.push(id);
        } else if (!checked && idx !== -1) {
            _selectedForCompare.splice(idx, 1);
        }
    }

    function kpiCompareSelected() {
        if (_selectedForCompare.length !== 2) return _showToast('Select exactly 2 snapshots to compare');
        _loadCompare(_selectedForCompare[0], _selectedForCompare[1]);
    }

    // Codebox 52 — Partner Review Pack integration. IDs are sequential
    // (GENERATED BY DEFAULT AS IDENTITY), so the lower id is treated as the
    // earlier (start) snapshot and the higher id as the later (end) snapshot
    // — a reasonable low-risk heuristic without an extra lookup call.
    function kpiCreatePartnerPackFromSelected() {
        if (_selectedForCompare.length !== 2) return _showToast('Select exactly 2 snapshots first');
        var ids = _selectedForCompare.slice().sort(function (a, b) { return a - b; });
        window.location.href = '/practice/partner-review-packs.html?generate=1&snapshot_start_id=' + ids[0] + '&snapshot_end_id=' + ids[1];
    }

    // ── Capture Snapshot ──────────────────────────────────────────────────────

    function kpiOpenCapture() {
        document.getElementById('captureWarning').innerHTML = '';
        document.getElementById('captureModal').classList.add('open');
    }

    function kpiCloseCapture() {
        document.getElementById('captureModal').classList.remove('open');
    }

    function kpiSubmitCapture(force) {
        if (_submitting) return;
        var payload = {
            snapshot_type: document.getElementById('capType').value || 'manual',
            period_key:    document.getElementById('capPeriodKey').value.trim() || null,
            period_start:  document.getElementById('capPeriodStart').value || null,
            period_end:    document.getElementById('capPeriodEnd').value || null,
            snapshot_name: document.getElementById('capName').value.trim() || null,
            notes:         document.getElementById('capNotes').value.trim() || null,
        };
        if (force) payload.force = true;

        _submitting = true;
        document.getElementById('captureSubmitBtn').disabled = true;
        window.PracticeAPI.fetch(BASE + '/capture', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            document.getElementById('captureSubmitBtn').disabled = false;
            if (!r.ok) {
                if (r.status === 409) {
                    document.getElementById('captureWarning').innerHTML =
                        '<div class="inline-msg info">An active snapshot already exists for this period (#' + r.data.existing_snapshot_id + '). ' +
                        '<button type="button" class="btn-action btn-danger btn-sm" onclick="kpiSubmitCapture(true)">Force Recapture</button></div>';
                    return;
                }
                return _showToast(r.data.error || 'Failed to capture snapshot');
            }
            _showToast('KPI snapshot captured');
            kpiCloseCapture();
            ['capPeriodKey','capPeriodStart','capPeriodEnd','capName','capNotes'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            kpiLoadAll();
        })
        .catch(function () { _submitting = false; document.getElementById('captureSubmitBtn').disabled = false; _showToast('Network error'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function kpiOpenDetail(id) {
        _currentId = id;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentSnapshot = d;
                _renderTabBar();
                _activateTab('overview');
                _renderFooter();
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load snapshot</div>';
            });
    }

    function kpiCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId = null;
        _currentSnapshot = null;
    }

    function _renderTabBar() {
        var tabs = [{ key: 'overview', label: 'Overview' }, { key: 'events', label: 'Events' }];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="kpiOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function kpiOpenTab(tab) {
        _currentTab = tab;
        if (_currentSnapshot) { _activateTab(tab); _renderTabBar(); }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        if (tab === 'overview') _renderOverviewTab(body);
        else _loadEventsTab(body);
    }

    function _renderOverviewTab(body) {
        var s = _currentSnapshot;
        var scores = (s.score_data && s.score_data.scores) || {};
        var kpi = s.kpi_data || {};
        var alerts = (s.alert_data && s.alert_data.alerts) || [];
        var queue = s.partner_queue_data || {};

        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dRow('Type', TYPE_LABELS[s.snapshot_type] || s.snapshot_type);
        html += _dRow('Status', s.status);
        html += _dRow('Period', s.period_key || '—');
        html += _dRow('Generated', _fmt(s.generated_at));
        html += _dRow('Overall Score', s.score_data ? s.score_data.overall_score : '—');
        html += _dRow('Quality', scores.quality != null ? scores.quality : '—');
        html += _dRow('Compliance', scores.compliance != null ? scores.compliance : '—');
        html += _dRow('Risk', scores.risk != null ? scores.risk : '—');
        html += _dRow('Capacity', scores.capacity != null ? scores.capacity : '—');
        html += _dRow('Tax', scores.tax != null ? scores.tax : '—');
        html += '</div>';

        html += '<div class="section-label">Key KPIs</div>';
        html += '<div class="detail-grid">';
        html += _dRow('Open Risks', kpi.risk ? kpi.risk.open_risks : '—');
        html += _dRow('Critical Risks', kpi.risk ? kpi.risk.critical_risks : '—');
        html += _dRow('Open Findings', kpi.qms ? kpi.qms.open_findings : '—');
        html += _dRow('Overdue Documents', kpi.document_requests ? kpi.document_requests.overdue : '—');
        html += _dRow('Overdue Reminders', kpi.reminders ? kpi.reminders.overdue : '—');
        html += _dRow('Over-Capacity Staff', kpi.capacity ? kpi.capacity.over_capacity_staff : '—');
        html += '</div>';

        html += '<div class="section-label">Alerts (' + alerts.length + ')</div>';
        html += '<div style="font-size:.82rem;color:#a0aec0;">' + alerts.slice(0, 10).map(function (a) { return _html(a.label); }).join('<br/>') + (alerts.length > 10 ? '<br/>…' : '') + '</div>';

        var queueTotal = ['knowledge_approvals','sop_approvals','tax_completion','qms_reviews','risk_acceptance','billing_approval']
            .reduce(function (sum, k) { return sum + ((queue[k] || []).length); }, 0);
        html += '<div class="section-label">Partner Queue (' + queueTotal + ')</div>';

        if (s.notes) {
            html += '<div class="section-label">Notes</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(s.notes) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dRow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + label + '</div><div class="detail-value">' + (value != null ? _html(value) : '—') + '</div></div>';
    }

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTab(d.events || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load events</div>'; });
    }

    function _renderEventsTab(items, body) {
        var html = '<div class="tab-content">';
        if (!items.length) {
            html += '<div class="inline-msg info">No events recorded yet.</div>';
        } else {
            items.forEach(function (ev) {
                html += '<div class="event-item">';
                html += '<div class="event-header"><span class="event-type">' + _html(EV_LABELS[ev.event_type] || ev.event_type) + '</span><span class="event-time">' + _fmt(ev.created_at) + '</span></div>';
                if (ev.notes) html += '<div class="event-notes">' + _html(ev.notes) + '</div>';
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _renderFooter() {
        var s = _currentSnapshot;
        var html = '<button type="button" class="btn-action btn-secondary" onclick="kpiCloseDetail()">Close</button>';
        if (s.status !== 'archived') {
            html += '<button type="button" class="btn-action btn-danger" onclick="kpiArchiveSnapshot()">Archive</button>';
        }
        document.getElementById('detailFooter').innerHTML = html;
    }

    function kpiArchiveSnapshot() {
        if (!window.confirm('Archive this snapshot? It will be excluded from active views but its history is preserved.')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to archive snapshot');
                _showToast('Snapshot archived');
                kpiCloseDetail();
                kpiLoadAll();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Trend Viewer ──────────────────────────────────────────────────────────

    function kpiLoadTrend() {
        var metric = document.getElementById('trendMetric').value;
        var type = document.getElementById('trendSnapshotType').value;
        var from = document.getElementById('trendPeriodFrom').value;
        var to = document.getElementById('trendPeriodTo').value;

        var p = ['metric_key=' + encodeURIComponent(metric)];
        if (type) p.push('snapshot_type=' + encodeURIComponent(type));
        if (from) p.push('period_from=' + encodeURIComponent(from));
        if (to) p.push('period_to=' + encodeURIComponent(to));

        document.getElementById('trendBody').innerHTML = '<tr class="empty-row"><td colspan="4">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + '/trends?' + p.join('&'))
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderTrend(d.trend || []); })
            .catch(function () { document.getElementById('trendBody').innerHTML = '<tr class="empty-row"><td colspan="4" style="color:#fc8181;">Failed to load trend</td></tr>'; });
    }

    function _renderTrend(items) {
        var tbody = document.getElementById('trendBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No snapshots match these filters.</td></tr>';
            return;
        }
        tbody.innerHTML = items.map(function (t) {
            var period = t.period_key || t.period_start || _fmt(t.generated_at);
            return '<tr>' +
                '<td>' + _html(period) + '</td>' +
                '<td>' + (t.value != null ? _html(t.value) : '—') + '</td>' +
                '<td>' + (t.delta != null ? (t.delta > 0 ? '+' : '') + _html(t.delta) + (t.delta_percentage != null ? ' (' + (t.delta_percentage > 0 ? '+' : '') + t.delta_percentage + '%)' : '') : '—') + '</td>' +
                '<td>' + _dirArrow(t.trend_direction) + '</td>' +
            '</tr>';
        }).join('');
    }

    // ── Compare ───────────────────────────────────────────────────────────────

    function _loadCompare(idA, idB) {
        document.getElementById('compareModal').classList.add('open');
        document.getElementById('compareBody').innerHTML = '<div class="loading-state">Loading…</div>';
        window.PracticeAPI.fetch(BASE + '/compare?snapshot_a_id=' + idA + '&snapshot_b_id=' + idB)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderCompare(d); })
            .catch(function () { document.getElementById('compareBody').innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to compare snapshots</div>'; });
    }

    function kpiCloseCompare() {
        document.getElementById('compareModal').classList.remove('open');
    }

    function _renderCompare(d) {
        var html = '<div class="compare-select-row">' +
            '<strong>A:</strong> ' + _html(d.snapshot_a.snapshot_name) + ' (' + _fmt(d.snapshot_a.generated_at) + ')' +
            ' &nbsp; vs &nbsp; <strong>B:</strong> ' + _html(d.snapshot_b.snapshot_name) + ' (' + _fmt(d.snapshot_b.generated_at) + ')' +
        '</div>';

        function _table(title, rows, labelKey, aKey, bKey) {
            var out = '<div class="section-label">' + title + '</div><div class="table-wrap" style="margin-bottom:16px;"><table><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Delta</th><th>Trend</th></tr></thead><tbody>';
            rows.forEach(function (r) {
                out += '<tr><td>' + _html(METRIC_LABELS[r[labelKey]] || r[labelKey]) + '</td><td>' + (r[aKey] != null ? _html(r[aKey]) : '—') + '</td><td>' + (r[bKey] != null ? _html(r[bKey]) : '—') + '</td>' +
                    '<td>' + (r.delta != null ? (r.delta > 0 ? '+' : '') + _html(r.delta) : '—') + '</td><td>' + _dirArrow(r.direction) + '</td></tr>';
            });
            out += '</tbody></table></div>';
            return out;
        }

        html += _table('Score Comparison', d.score_comparison || [], 'metric', 'a_value', 'b_value');
        html += _table('KPI Comparison', d.kpi_comparison || [], 'metric', 'a_value', 'b_value');

        html += '<div class="section-label">Alert Comparison</div><div class="table-wrap" style="margin-bottom:16px;"><table><thead><tr><th>Severity</th><th>A</th><th>B</th><th>Delta</th></tr></thead><tbody>';
        (d.alert_comparison || []).forEach(function (a) {
            html += '<tr><td>' + _html(a.severity) + '</td><td>' + a.a_count + '</td><td>' + a.b_count + '</td><td>' + (a.delta > 0 ? '+' : '') + a.delta + '</td></tr>';
        });
        html += '</tbody></table></div>';

        html += '<div class="section-label">Partner Queue Comparison</div><div class="table-wrap"><table><thead><tr><th>Category</th><th>A</th><th>B</th><th>Delta</th></tr></thead><tbody>';
        (d.partner_queue_comparison || []).forEach(function (q) {
            html += '<tr><td>' + _html(q.category) + '</td><td>' + q.a_count + '</td><td>' + q.b_count + '</td><td>' + (q.delta > 0 ? '+' : '') + q.delta + '</td></tr>';
        });
        html += '</tbody></table></div>';

        document.getElementById('compareBody').innerHTML = html;
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.kpiLoadAll         = kpiLoadAll;
    window.kpiLoadList        = kpiLoadList;
    window.kpiClearFilters    = kpiClearFilters;
    window.kpiOpenCapture     = kpiOpenCapture;
    window.kpiCloseCapture    = kpiCloseCapture;
    window.kpiSubmitCapture   = kpiSubmitCapture;
    window.kpiOpenDetail      = kpiOpenDetail;
    window.kpiCloseDetail     = kpiCloseDetail;
    window.kpiOpenTab         = kpiOpenTab;
    window.kpiArchiveSnapshot = kpiArchiveSnapshot;
    window.kpiLoadTrend       = kpiLoadTrend;
    window.kpiCompareSelected = kpiCompareSelected;
    window.kpiCreatePartnerPackFromSelected = kpiCreatePartnerPackFromSelected;
    window.kpiCloseCompare    = kpiCloseCompare;
    window._kpiPage           = _kpiPage;
    window._kpiToggleCompare  = _kpiToggleCompare;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        kpiLoadAll();
    });

}());
