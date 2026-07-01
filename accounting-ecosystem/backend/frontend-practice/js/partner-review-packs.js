/* Codebox 52 — Practice Partner Monthly Review Pack
 * Deterministic management reporting and partner sign-off. NOT AI. NOT forecasting.
 * Prefix: prp
 */
(function () {
    'use strict';

    var BASE = '/api/practice/partner-review-packs';
    var _page = 1;
    var _submitting = false;
    var _currentId = null;
    var _currentPack = null;
    var _currentTab = 'overview';

    var STATUS_LABELS = {
        draft: 'Draft', generated: 'Generated', under_review: 'Under Review',
        approved: 'Approved', rejected: 'Rejected', archived: 'Archived', cancelled: 'Cancelled',
    };
    var EV_LABELS = {
        partner_review_pack_generated: 'Generated', partner_review_pack_updated: 'Updated',
        partner_review_pack_submitted_review: 'Submitted for Review', partner_review_pack_approved: 'Approved',
        partner_review_pack_rejected: 'Rejected', partner_review_pack_cancelled: 'Cancelled',
        partner_review_pack_archived: 'Archived', partner_review_pack_report_viewed: 'Report Viewed',
        partner_review_pack_pdf_downloaded: 'PDF Downloaded',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _statusPill(s) { return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function prpLoadAll() {
        _loadSummary();
        prpLoadList();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('generate') === '1') {
            prpOpenGenerate();
            var start = params.get('snapshot_start_id');
            var end = params.get('snapshot_end_id');
            if (start) document.getElementById('genSnapshotStart').value = start;
            if (end) document.getElementById('genSnapshotEnd').value = end;
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '?limit=200')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var packs = d.packs || [];
                var counts = { draft: 0, generated: 0, under_review: 0, approved: 0, rejected: 0, archived: 0, cancelled: 0 };
                packs.forEach(function (p) { if (counts[p.pack_status] !== undefined) counts[p.pack_status]++; });
                _renderSummary(counts, d.total || 0);
            })
            .catch(function () {});
    }

    function _renderSummary(counts, total) {
        var grid = document.getElementById('summaryGrid');
        var cards = [
            { count: total, label: 'Total Packs' },
            { count: counts.generated, label: 'Generated' },
            { count: counts.under_review, label: 'Under Review' },
            { count: counts.approved, label: 'Approved' },
            { count: counts.rejected, label: 'Rejected' },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
        }).join('');
    }

    // ── Filters ───────────────────────────────────────────────────────────────

    function prpClearFilters() {
        document.getElementById('filterStatus').value = '';
        document.getElementById('filterFrom').value = '';
        document.getElementById('filterTo').value = '';
        _page = 1;
        prpLoadList();
    }

    function _qs() {
        var p = [];
        var status = document.getElementById('filterStatus').value;
        var from = document.getElementById('filterFrom').value;
        var to = document.getElementById('filterTo').value;
        if (status) p.push('pack_status=' + encodeURIComponent(status));
        if (from) p.push('period_from=' + encodeURIComponent(from));
        if (to) p.push('period_to=' + encodeURIComponent(to));
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function prpLoadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="7">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.packs || [], d.total || 0, d.page || 1, d.limit || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="7" style="color:#fc8181;">Failed to load packs</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No review packs found. Generate the first one.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (p) {
            return '<tr onclick="prpOpenDetail(' + p.id + ')">' +
                '<td style="color:#4a5568;font-size:.78rem;">#' + p.id + '</td>' +
                '<td>' + _statusPill(p.pack_status) + '</td>' +
                '<td>' + _html(p.pack_name) + '</td>' +
                '<td style="font-size:.8rem;">' + _fmtDate(p.review_period_start) + ' – ' + _fmtDate(p.review_period_end) + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + _fmt(p.prepared_at) + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + (p.reviewed_at ? _fmt(p.reviewed_at) : '—') + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + (p.approved_at ? _fmt(p.approved_at) : '—') + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_prpPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_prpPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' pack' + (total !== 1 ? 's' : '');
        }
    }

    function _prpPage(p) { _page = p; prpLoadList(); }

    // ── Generate Pack ─────────────────────────────────────────────────────────

    function prpOpenGenerate() {
        document.getElementById('generateWarning').innerHTML = '';
        document.getElementById('generateModal').classList.add('open');
    }
    function prpCloseGenerate() {
        document.getElementById('generateModal').classList.remove('open');
    }

    function prpSubmitGenerate(force) {
        if (_submitting) return;
        var name = document.getElementById('genName').value.trim();
        var start = document.getElementById('genPeriodStart').value;
        var end = document.getElementById('genPeriodEnd').value;
        if (!name) return _showToast('Pack name is required');
        if (!start) return _showToast('Period start is required');
        if (!end) return _showToast('Period end is required');

        var payload = {
            pack_name: name,
            review_period_start: start,
            review_period_end: end,
            period_key: document.getElementById('genPeriodKey').value.trim() || null,
            snapshot_start_id: document.getElementById('genSnapshotStart').value.trim() || null,
            snapshot_end_id: document.getElementById('genSnapshotEnd').value.trim() || null,
            executive_summary: document.getElementById('genSummary').value.trim() || null,
            notes: document.getElementById('genNotes').value.trim() || null,
        };
        if (force) payload.force = true;

        _submitting = true;
        document.getElementById('generateSubmitBtn').disabled = true;
        window.PracticeAPI.fetch(BASE + '/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            document.getElementById('generateSubmitBtn').disabled = false;
            if (!r.ok) {
                if (r.status === 409) {
                    document.getElementById('generateWarning').innerHTML =
                        '<div class="inline-msg warn">An active pack already exists for this period (#' + r.data.existing_pack_id + '). ' +
                        '<button type="button" class="btn-action btn-danger btn-sm" onclick="prpSubmitGenerate(true)">Force Regenerate</button></div>';
                    return;
                }
                return _showToast(r.data.error || 'Failed to generate pack');
            }
            var msg = 'Pack generated';
            if (r.data.warnings && r.data.warnings.length) msg += ' (' + r.data.warnings.length + ' warning(s) — see detail)';
            _showToast(msg);
            prpCloseGenerate();
            ['genName','genPeriodStart','genPeriodEnd','genPeriodKey','genSnapshotStart','genSnapshotEnd','genSummary','genNotes'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            prpLoadAll();
            prpOpenDetail(r.data.pack.id);
        })
        .catch(function () { _submitting = false; document.getElementById('generateSubmitBtn').disabled = false; _showToast('Network error'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function prpOpenDetail(id) {
        _currentId = id;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentPack = d;
                _renderTabBar();
                _activateTab('overview');
                _renderFooter();
            })
            .catch(function () { document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load pack</div>'; });
    }

    function prpCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId = null;
        _currentPack = null;
    }

    function _renderTabBar() {
        var tabs = [{ key: 'overview', label: 'Overview' }, { key: 'report', label: 'Report' }, { key: 'events', label: 'Events' }];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="prpOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function prpOpenTab(tab) {
        _currentTab = tab;
        if (_currentPack) { _activateTab(tab); _renderTabBar(); }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        if (tab === 'overview') _renderOverviewTab(body);
        else if (tab === 'report') _renderReportTab(body);
        else _loadEventsTab(body);
    }

    function _renderOverviewTab(body) {
        var p = _currentPack;
        var html = '<div class="tab-content"><div class="detail-grid">';
        html += _dRow('Status', _statusPill(p.pack_status));
        html += _dRow('Period', _fmtDate(p.review_period_start) + ' – ' + _fmtDate(p.review_period_end));
        html += _dRow('Period Key', p.period_key || '—');
        html += _dRow('Prepared', p.prepared_at ? _fmt(p.prepared_at) : '—');
        html += _dRow('Reviewed', p.reviewed_at ? _fmt(p.reviewed_at) : '—');
        html += _dRow('Approved', p.approved_at ? _fmt(p.approved_at) : '—');
        html += '</div>';
        if (p.executive_summary) { html += '<div class="section-label">Executive Summary</div><div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(p.executive_summary) + '</div>'; }
        if (p.partner_notes) { html += '<div class="section-label">Partner Notes</div><div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(p.partner_notes) + '</div>'; }
        if (p.rejection_reason) { html += '<div class="section-label">Rejection Reason</div><div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#fc8181;">' + _html(p.rejection_reason) + '</div>'; }
        var warnings = (p.report_snapshot && p.report_snapshot.warnings) || [];
        if (warnings.length) {
            html += '<div class="section-label">Warnings</div>';
            warnings.forEach(function (w) { html += '<div class="inline-msg warn">⚠ ' + _html(w) + '</div>'; });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dRow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + label + '</div><div class="detail-value">' + (value != null ? value : '—') + '</div></div>';
    }

    function _renderReportTab(body) {
        var p = _currentPack;
        var r = p.report_snapshot || {};
        var sm = r.practice_score_movement || {};
        var html = '<div class="tab-content">';
        html += '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">';
        html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="prpOpenReportHtml()">Open HTML Report ↗</button>';
        html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="prpDownloadPdf()">Download PDF ⬇</button>';
        html += '</div>';
        html += '<div class="section-label">Practice Score Movement</div>';
        html += '<div class="detail-grid">';
        html += _dRow('Overall', (sm.overall ? sm.overall.end : '—') + (sm.overall && sm.overall.start != null ? ' (was ' + sm.overall.start + ')' : ''));
        var subs = sm.sub_scores || {};
        ['quality', 'compliance', 'risk', 'capacity', 'tax'].forEach(function (k) {
            var v = subs[k] || {};
            html += _dRow(k.charAt(0).toUpperCase() + k.slice(1), (v.end != null ? v.end : '—') + (v.start != null ? ' (was ' + v.start + ')' : ''));
        });
        html += '</div>';

        html += '<div class="section-label">KPI Trends</div>';
        html += '<div class="table-wrap"><table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>';
        (r.kpi_trends || []).forEach(function (t) {
            html += '<tr><td>' + _html(t.metric_key.replace(/_/g, ' ')) + '</td><td>' + (t.start_value != null ? t.start_value : '—') + '</td><td>' + (t.end_value != null ? t.end_value : '—') + '</td><td>' + (t.delta != null ? ((t.delta > 0 ? '+' : '') + t.delta) : '—') + '</td></tr>';
        });
        html += '</tbody></table></div>';

        var alerts = (r.latest_alerts && r.latest_alerts.alerts) || [];
        html += '<div class="section-label">Key Alerts (' + alerts.length + ')</div>';
        html += '<div style="font-size:.82rem;color:#a0aec0;">' + (alerts.slice(0, 10).map(function (a) { return _html(a.label); }).join('<br/>') || 'No active alerts.') + '</div>';

        html += '</div>';
        body.innerHTML = html;
    }

    function prpOpenReportHtml() {
        window.open(BASE + '/' + _currentId + '/report-html', '_blank');
    }

    function prpDownloadPdf() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/report-pdf')
            .then(function (r) {
                if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Failed to download PDF'); });
                return r.blob();
            })
            .then(function (blob) {
                var url = window.URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'partner-review-pack-' + _currentId + '.pdf';
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);
            })
            .catch(function (e) { _showToast(e.message || 'Network error'); });
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
                html += '<div class="event-item"><div class="event-header"><span class="event-type">' + _html(EV_LABELS[ev.event_type] || ev.event_type) + '</span><span class="event-time">' + _fmt(ev.created_at) + '</span></div>';
                if (ev.notes) html += '<div class="event-notes">' + _html(ev.notes) + '</div>';
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    // ── Footer / actions ──────────────────────────────────────────────────────

    function _renderFooter() {
        var p = _currentPack;
        var s = p.pack_status;
        var html = '<button type="button" class="btn-action btn-secondary" onclick="prpCloseDetail()">Close</button>';

        if (['draft', 'generated', 'under_review', 'rejected'].includes(s)) {
            html += '<button type="button" class="btn-action btn-secondary" onclick="prpOpenEdit()">Edit</button>';
        }
        if (['generated', 'rejected'].includes(s)) {
            html += '<button type="button" class="btn-action btn-primary" onclick="prpSubmitReview()">Submit for Review</button>';
        }
        if (s === 'under_review') {
            html += '<button type="button" class="btn-action btn-success" onclick="prpApprove()">Approve</button>';
            html += '<button type="button" class="btn-action btn-danger" onclick="prpOpenReject()">Reject</button>';
        }
        if (!['archived', 'cancelled'].includes(s)) {
            html += '<button type="button" class="btn-action btn-warning" onclick="prpCancelOrArchive()">' + (s === 'approved' ? 'Archive' : 'Cancel') + '</button>';
        }
        document.getElementById('detailFooter').innerHTML = html;
    }

    function prpOpenEdit() {
        var name = window.prompt('Pack name:', _currentPack.pack_name);
        if (name == null) return;
        var summary = window.prompt('Executive summary:', _currentPack.executive_summary || '');
        if (summary == null) return;
        var notes = window.prompt('Partner notes:', _currentPack.partner_notes || '');
        if (notes == null) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pack_name: name.trim() || _currentPack.pack_name, executive_summary: summary.trim() || null, partner_notes: notes.trim() || null }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            if (!r.ok) return _showToast(r.data.error || 'Failed to update pack');
            _showToast('Pack updated');
            prpOpenDetail(_currentId);
            prpLoadList();
        })
        .catch(function () { _showToast('Network error'); });
    }

    function prpSubmitReview() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/submit-review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to submit for review');
                _showToast('Submitted for review');
                prpOpenDetail(_currentId);
                prpLoadAll();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function prpApprove() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/approve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to approve');
                _showToast('Pack approved');
                prpOpenDetail(_currentId);
                prpLoadAll();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function prpOpenReject() { document.getElementById('rejectReason').value = ''; document.getElementById('rejectModal').classList.add('open'); }
    function prpCloseReject() { document.getElementById('rejectModal').classList.remove('open'); }

    function prpSubmitReject() {
        var reason = document.getElementById('rejectReason').value.trim();
        if (!reason) return _showToast('Rejection reason is required');
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/reject', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rejection_reason: reason }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            if (!r.ok) return _showToast(r.data.error || 'Failed to reject pack');
            _showToast('Pack rejected');
            prpCloseReject();
            prpOpenDetail(_currentId);
            prpLoadAll();
        })
        .catch(function () { _showToast('Network error'); });
    }

    function prpCancelOrArchive() {
        var willArchive = _currentPack.pack_status === 'approved';
        if (!window.confirm(willArchive ? 'Archive this approved pack?' : 'Cancel this pack?')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to update pack');
                _showToast(willArchive ? 'Pack archived' : 'Pack cancelled');
                prpCloseDetail();
                prpLoadAll();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.prpLoadAll         = prpLoadAll;
    window.prpLoadList        = prpLoadList;
    window.prpClearFilters    = prpClearFilters;
    window.prpOpenGenerate     = prpOpenGenerate;
    window.prpCloseGenerate    = prpCloseGenerate;
    window.prpSubmitGenerate   = prpSubmitGenerate;
    window.prpOpenDetail       = prpOpenDetail;
    window.prpCloseDetail      = prpCloseDetail;
    window.prpOpenTab          = prpOpenTab;
    window.prpOpenReportHtml   = prpOpenReportHtml;
    window.prpDownloadPdf      = prpDownloadPdf;
    window.prpOpenEdit         = prpOpenEdit;
    window.prpSubmitReview     = prpSubmitReview;
    window.prpApprove          = prpApprove;
    window.prpOpenReject       = prpOpenReject;
    window.prpCloseReject      = prpCloseReject;
    window.prpSubmitReject     = prpSubmitReject;
    window.prpCancelOrArchive  = prpCancelOrArchive;
    window._prpPage            = _prpPage;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        prpLoadAll();
    });

}());
