/* ============================================================
   Practice Tax Reports — Codeboxes 38 & 39
   Data display (CB38) + export buttons (CB39).
   Fix: all PracticeAPI.fetch() calls now chain .then(res=>res.json()).
   ============================================================ */
(function () {
    'use strict';

    var esc = PracticeAPI.escHtml;
    var BASE = '/api/practice/tax-reports';

    // ── State ────────────────────────────────────────────────
    var _teamMembers = [];
    var _exporting   = {};   // { 'progress-pdf': true } — prevents double-submit

    // ── Boot ─────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        LAYOUT.init('tax-reports');
        _loadTeam().then(function () { trrRefresh(); });
    });

    // ── Load team members for dropdowns ──────────────────────
    function _loadTeam() {
        return PracticeAPI.fetch('/api/practice/team?active=true')
            .then(function (res) { return res.json(); })
            .then(function (d) {
                _teamMembers = d.team_members || d.members || [];
                var opts = _teamMembers.map(function (m) {
                    return '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
                }).join('');
                var base = '<option value="">All</option>' + opts;
                var resp = document.getElementById('trrResponsible');
                var rev  = document.getElementById('trrReviewer');
                if (resp) resp.innerHTML = base;
                if (rev)  rev.innerHTML  = base;
            })
            .catch(function () {});
    }

    // ── Filter query string ───────────────────────────────────
    function _qs() {
        var p   = new URLSearchParams();
        var yr  = (document.getElementById('trrYear')        || {}).value;
        var ct  = (document.getElementById('trrClientType')  || {}).value;
        var res = (document.getElementById('trrResponsible') || {}).value;
        var rev = (document.getElementById('trrReviewer')    || {}).value;
        if (yr)  p.set('tax_year', yr);
        if (ct)  p.set('client_type', ct);
        if (res) p.set('responsible_team_member_id', res);
        if (rev) p.set('reviewer_team_member_id', rev);
        var s = p.toString();
        return s ? '?' + s : '';
    }

    // ── Refresh all ───────────────────────────────────────────
    function trrRefresh() {
        _loadProgress();
        _loadStatusBreakdown();
        _loadDocOutstanding();
        _loadReviewBottlenecks();
        _loadPartnerSummary();
        _loadRiskSummary();
        _loadBulkSummary();
    }
    window.trrRefresh = trrRefresh;

    // ─────────────────────────────────────────────────────────
    // SECTION LOADERS (CB38 — fixed: all .then(res=>res.json()))
    // ─────────────────────────────────────────────────────────

    function _loadProgress() {
        var bar  = document.getElementById('trrPctBar');
        var lbl  = document.getElementById('trrPctLabel');
        var grid = document.getElementById('trrProgressGrid');
        var meta = document.getElementById('trrProgressMeta');
        if (grid) grid.innerHTML = '<div class="loading-msg">Loading...</div>';

        PracticeAPI.fetch(BASE + '/progress' + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                var pct = d.progress_percentage || 0;
                if (bar) bar.style.width = pct + '%';
                if (lbl) lbl.textContent  = pct + '% complete';
                if (meta) meta.textContent = d.total + ' total items tracked';
                if (!grid) return;
                if (d.total === 0) { grid.innerHTML = '<div class="empty-msg">No tax season items for the selected filters.</div>'; return; }
                grid.innerHTML =
                    _statCard(pct + '%',    'Complete',         'stat-pct') +
                    _statCard(d.total,      'Total',            'stat-total') +
                    _statCard(d.completed,  'Completed',        'stat-completed') +
                    _statCard(d.reviewed,   'Reviewed',         'stat-reviewed') +
                    _statCard(d.ready_for_review, 'Ready for Review', 'stat-ready') +
                    _statCard(d.in_progress,'In Progress',      'stat-inprogress') +
                    _statCard(d.blocked,    'Blocked',          'stat-blocked') +
                    _statCard(d.cancelled,  'Cancelled',        '');
            })
            .catch(function (e) {
                if (grid) grid.innerHTML = '<div class="empty-msg">Error: ' + esc(e.message || '') + '</div>';
            });
    }

    function _loadStatusBreakdown() {
        var grid = document.getElementById('trrBreakdownGrid');
        if (grid) grid.innerHTML = '<div class="loading-msg">Loading...</div>';

        PracticeAPI.fetch(BASE + '/status-breakdown' + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                if (!grid) return;
                var sections = [
                    { title: 'Individual Returns',   counts: d.individual_by_status },
                    { title: 'Individual Readiness', counts: d.individual_by_readiness },
                    { title: 'Company Returns',      counts: d.company_by_status },
                    { title: 'Company Readiness',    counts: d.company_by_readiness },
                    { title: 'Provisional Plans',    counts: d.provisional_by_status },
                    { title: 'Compliance Packs',     counts: d.packs_by_status },
                    { title: 'Ind. Review Packs',    counts: d.ind_review_packs_by_status },
                    { title: 'Co. Review Packs',     counts: d.co_review_packs_by_status },
                ];
                grid.innerHTML = sections.map(function (s) {
                    var counts = s.counts || {};
                    var keys   = Object.keys(counts);
                    if (!keys.length) return '';
                    return '<div class="breakdown-card"><div class="breakdown-card-title">' + esc(s.title) + '</div>' +
                        keys.map(function (k) {
                            return '<div class="breakdown-row"><span class="status-lbl">' + esc(k.replace(/_/g, ' ')) + '</span>' +
                                   '<span class="status-cnt">' + esc(String(counts[k])) + '</span></div>';
                        }).join('') + '</div>';
                }).join('') || '<div class="empty-msg">No status data.</div>';
            })
            .catch(function (e) {
                if (grid) grid.innerHTML = '<div class="empty-msg">Error: ' + esc(e.message || '') + '</div>';
            });
    }

    function _loadDocOutstanding() {
        var byClient = document.getElementById('trrDocByClient');
        var byCat    = document.getElementById('trrDocByCategory');
        var meta     = document.getElementById('trrDocMeta');

        PracticeAPI.fetch(BASE + '/document-outstanding' + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                if (meta) meta.textContent = d.total + ' outstanding, ' + d.overdue + ' overdue';
                if (byClient) {
                    byClient.innerHTML = !d.by_client || !d.by_client.length
                        ? '<tr><td colspan="3" class="empty-msg">No outstanding documents.</td></tr>'
                        : d.by_client.slice(0, 20).map(function (c) {
                            return '<tr><td>' + esc(c.client_name) + '</td>' +
                                   '<td><span class="' + (c.total > 5 ? 'num-warn' : '') + '">' + c.total + '</span></td>' +
                                   '<td>' + (c.overdue > 0 ? '<span class="num-bad">' + c.overdue + '</span>' : '0') + '</td></tr>';
                        }).join('');
                }
                if (byCat) {
                    byCat.innerHTML = !d.by_category || !d.by_category.length
                        ? '<tr><td colspan="2" class="empty-msg">None.</td></tr>'
                        : d.by_category.map(function (c) {
                            return '<tr><td>' + esc(c.category.replace(/_/g, ' ')) + '</td><td>' + c.count + '</td></tr>';
                        }).join('');
                }
            })
            .catch(function (e) {
                if (byClient) byClient.innerHTML = '<tr><td colspan="3" class="empty-msg">Error: ' + esc(e.message || '') + '</td></tr>';
            });
    }

    function _loadReviewBottlenecks() {
        var byRev    = document.getElementById('trrReviewByReviewer');
        var oldest   = document.getElementById('trrReviewOldest');
        var rejected = document.getElementById('trrRejected');
        var meta     = document.getElementById('trrReviewMeta');

        PracticeAPI.fetch(BASE + '/review-bottlenecks' + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                if (meta) meta.textContent = d.items_waiting_review + ' waiting, ' + d.rejected_items + ' rejected';
                if (byRev) {
                    byRev.innerHTML = !d.by_reviewer || !d.by_reviewer.length
                        ? '<tr><td colspan="3" class="empty-msg">No items waiting review.</td></tr>'
                        : d.by_reviewer.map(function (r) {
                            return '<tr><td>' + esc(r.reviewer_name) + '</td>' +
                                   '<td><span class="' + (r.count > 5 ? 'num-warn' : '') + '">' + r.count + '</span></td>' +
                                   '<td>' + (r.oldest_date ? _fmtDate(r.oldest_date) : '—') + '</td></tr>';
                        }).join('');
                }
                if (oldest) {
                    var items = d.oldest_waiting_items || [];
                    oldest.innerHTML = !items.length
                        ? '<tr><td colspan="3" class="empty-msg">None.</td></tr>'
                        : items.map(function (i) {
                            return '<tr><td>' + esc(i.name || '—') + '<br><span style="font-size:0.7rem;color:#718096">' + esc(_fmtEntityType(i.entity_type)) + '</span></td>' +
                                   '<td>' + esc(i.client_name || '—') + '</td><td>' + _fmtDate(i.waiting_since) + '</td></tr>';
                        }).join('');
                }
                if (rejected) {
                    var rItems = d.rejected_items_list || [];
                    rejected.innerHTML = !rItems.length
                        ? '<tr><td colspan="4" class="empty-msg">No rejected packs.</td></tr>'
                        : rItems.map(function (i) {
                            return '<tr><td>' + esc(i.name || '—') + '</td><td>' + esc(i.client_name || '—') + '</td>' +
                                   '<td>' + esc(_fmtEntityType(i.entity_type)) + '</td><td>' + _fmtDate(i.updated_at) + '</td></tr>';
                        }).join('');
                }
            })
            .catch(function (e) {
                if (byRev) byRev.innerHTML = '<tr><td colspan="3" class="empty-msg">Error: ' + esc(e.message || '') + '</td></tr>';
            });
    }

    function _loadPartnerSummary() {
        var tbody = document.getElementById('trrPartnerTable');

        PracticeAPI.fetch(BASE + '/partner-summary' + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                if (!tbody) return;
                var rows = d.summary || [];
                tbody.innerHTML = !rows.length
                    ? '<tr><td colspan="8" class="empty-msg">No team data.</td></tr>'
                    : rows.map(function (r) {
                        return '<tr>' +
                            '<td>' + esc(r.team_member_name) + '</td>' +
                            '<td>' + (r.client_count || 0) + '</td>' +
                            '<td>' + (r.return_count || 0) + '</td>' +
                            '<td>' + (r.ready_for_review > 0 ? '<span class="num-warn">' + r.ready_for_review + '</span>' : '0') + '</td>' +
                            '<td>' + (r.pack_pending || 0) + '</td>' +
                            '<td>' + (r.outstanding_docs > 0 ? '<span class="num-warn">' + r.outstanding_docs + '</span>' : '0') + '</td>' +
                            '<td>' + (r.open_actions > 0 ? '<span class="num-info">' + r.open_actions + '</span>' : '0') + '</td>' +
                            '<td>' + (r.overdue_deadlines > 0 ? '<span class="num-bad">' + r.overdue_deadlines + '</span>' : '0') + '</td>' +
                            '</tr>';
                    }).join('');
            })
            .catch(function (e) {
                if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">Error: ' + esc(e.message || '') + '</td></tr>';
            });
    }

    function _loadRiskSummary() {
        var grid    = document.getElementById('trrRiskGrid');
        var details = document.getElementById('trrRiskDetails');
        if (grid) grid.innerHTML = '<div class="loading-msg">Loading...</div>';

        PracticeAPI.fetch(BASE + '/risk-summary' + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                if (grid) {
                    grid.innerHTML =
                        _statCard(d.overdue_deadlines,     'Overdue Deadlines',    d.overdue_deadlines > 0 ? 'stat-blocked' : '') +
                        _statCard(d.blocked_returns,       'Blocked Returns',       d.blocked_returns > 0 ? 'stat-blocked' : '') +
                        _statCard(d.missing_review_packs,  'Missing Review Packs', d.missing_review_packs > 0 ? 'stat-ready' : '') +
                        _statCard(d.outstanding_documents, 'Outstanding Docs',      d.outstanding_documents > 0 ? 'stat-ready' : '') +
                        _statCard(d.open_tax_actions,      'Open Actions',           d.open_tax_actions > 0 ? 'stat-ready' : '') +
                        _statCard(d.high_risk_clients,     'High-Risk Clients',     d.high_risk_clients > 0 ? 'stat-blocked' : '');
                }
                if (!details) return;
                var html = '';
                if (d.overdue_deadline_items && d.overdue_deadline_items.length) {
                    html += '<div style="margin-bottom:1rem"><div style="font-size:0.72rem;color:#718096;font-weight:600;text-transform:uppercase;margin-bottom:0.5rem">Overdue Deadlines</div>' +
                        '<table class="trr-table"><thead><tr><th>Deadline</th><th>Client</th><th>Due Date</th></tr></thead><tbody>' +
                        d.overdue_deadline_items.map(function (i) {
                            return '<tr><td>' + esc(i.title) + '</td><td>' + esc(i.client_name || '—') + '</td><td><span class="num-bad">' + _fmtDate(i.due_date) + '</span></td></tr>';
                        }).join('') + '</tbody></table></div>';
                }
                if (d.blocked_return_items && d.blocked_return_items.length) {
                    html += '<div style="margin-bottom:1rem"><div style="font-size:0.72rem;color:#718096;font-weight:600;text-transform:uppercase;margin-bottom:0.5rem">Blocked Returns</div>' +
                        '<table class="trr-table"><thead><tr><th>Return</th><th>Client</th><th>Type</th><th>Year</th></tr></thead><tbody>' +
                        d.blocked_return_items.map(function (i) {
                            return '<tr><td>' + esc(i.return_name || '—') + '</td><td>' + esc(i.client_name || '—') + '</td><td>' + esc(i.entity_type) + '</td><td>' + (i.tax_year || '—') + '</td></tr>';
                        }).join('') + '</tbody></table></div>';
                }
                if (d.high_risk_client_list && d.high_risk_client_list.length) {
                    html += '<div style="margin-bottom:1rem"><div style="font-size:0.72rem;color:#718096;font-weight:600;text-transform:uppercase;margin-bottom:0.5rem">High-Risk Clients (2+ risk factors)</div>' +
                        '<table class="trr-table"><thead><tr><th>Client</th><th>Type</th><th>Risk Count</th></tr></thead><tbody>' +
                        d.high_risk_client_list.map(function (c) {
                            return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.client_type || '—') + '</td><td><span class="badge badge-err">' + c.risk_count + ' factors</span></td></tr>';
                        }).join('') + '</tbody></table></div>';
                }
                details.innerHTML = html || '<div class="empty-msg">No risk items found.</div>';
            })
            .catch(function (e) {
                if (grid) grid.innerHTML = '<div class="empty-msg">Error: ' + esc(e.message || '') + '</div>';
            });
    }

    function _loadBulkSummary() {
        var tbody = document.getElementById('trrBulkTable');

        PracticeAPI.fetch(BASE + '/bulk-operation-summary')
            .then(function (res) { return res.json(); })
            .then(function (d) {
                if (!tbody) return;
                var ops = d.operations || [];
                tbody.innerHTML = !ops.length
                    ? '<tr><td colspan="8" class="empty-msg">No bulk operations found.</td></tr>'
                    : ops.map(function (op) {
                        var ic = op.item_counts || {};
                        return '<tr>' +
                            '<td>' + esc(op.operation_name) + '</td>' +
                            '<td style="font-size:0.7rem;color:#a0aec0">' + esc(op.operation_type.replace(/_/g, ' ')) + '</td>' +
                            '<td>' + _statusBadge(op.operation_status) + '</td>' +
                            '<td>' + (op.tax_year || '—') + '</td>' +
                            '<td>' + (ic.success > 0 ? '<span class="num-good">' + ic.success + '</span>' : (ic.total ? '0' : '—')) + '</td>' +
                            '<td>' + (ic.warning > 0 ? '<span class="num-warn">' + ic.warning + '</span>' : '0') + '</td>' +
                            '<td>' + (ic.failed  > 0 ? '<span class="num-bad">'  + ic.failed  + '</span>' : '0') + '</td>' +
                            '<td style="font-size:0.72rem;color:#718096">' + _fmtDate(op.created_at) + '</td>' +
                            '</tr>';
                    }).join('');
            })
            .catch(function (e) {
                if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">Error: ' + esc(e.message || '') + '</td></tr>';
            });
    }

    // ─────────────────────────────────────────────────────────
    // EXPORT FUNCTIONS (CB39) — auth-safe, blob download
    // Token stays in Authorization header — never in URL.
    // ─────────────────────────────────────────────────────────

    function _exportKey(report, format) { return report + '-' + format; }

    function _setExportState(key, busy, btnId) {
        _exporting[key] = busy;
        var btn = document.getElementById(btnId);
        if (!btn) return;
        btn.disabled = busy;
        if (busy) {
            btn.dataset.orig = btn.textContent;
            btn.textContent  = 'Loading...';
        } else {
            btn.textContent  = btn.dataset.orig || btn.textContent;
        }
    }

    // Open HTML report in new tab (blob URL — auth via fetch)
    function trrOpenHtml(report, btnId) {
        var key = _exportKey(report, 'html');
        if (_exporting[key]) return;
        _setExportState(key, true, btnId);
        PracticeAPI.fetch(BASE + '/' + report + '/report-html' + _qs())
            .then(function (res) {
                if (!res.ok) throw new Error('Server error ' + res.status);
                return res.blob();
            })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                window.open(url, '_blank');
                setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
            })
            .catch(function (e) { PracticeAPI.showToast('Failed to open HTML report: ' + (e.message || ''), true); })
            .finally(function () { _setExportState(key, false, btnId); });
    }
    window.trrOpenHtml = trrOpenHtml;

    // Download PDF
    function trrDownloadPdf(report, filename, btnId) {
        var key = _exportKey(report, 'pdf');
        if (_exporting[key]) return;
        _setExportState(key, true, btnId);
        PracticeAPI.fetch(BASE + '/' + report + '/report-pdf' + _qs())
            .then(function (res) {
                if (!res.ok) throw new Error('Server error ' + res.status);
                return res.blob();
            })
            .then(function (blob) {
                var a   = document.createElement('a');
                a.href  = URL.createObjectURL(blob);
                a.download = filename || (report + '.pdf');
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
                PracticeAPI.showToast('PDF downloaded.', false);
            })
            .catch(function (e) { PracticeAPI.showToast('PDF download failed: ' + (e.message || ''), true); })
            .finally(function () { _setExportState(key, false, btnId); });
    }
    window.trrDownloadPdf = trrDownloadPdf;

    // Open HTML pack
    function trrOpenPackHtml(btnId) { trrOpenHtml('tax-season-pack', btnId); }
    window.trrOpenPackHtml = trrOpenPackHtml;

    // Download full pack PDF
    function trrDownloadPackPdf(btnId) { trrDownloadPdf('tax-season-pack', 'tax-season-pack.pdf', btnId); }
    window.trrDownloadPackPdf = trrDownloadPackPdf;

    // ─────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────

    function _statCard(val, lbl, cls) {
        return '<div class="progress-stat ' + (cls || '') + '">' +
            '<div class="stat-val">' + esc(String(val)) + '</div>' +
            '<div class="stat-lbl">' + esc(lbl) + '</div>' +
            '</div>';
    }

    function _fmtDate(iso) {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleDateString('en-ZA'); } catch (e) { return String(iso); }
    }

    function _fmtEntityType(t) {
        var map = { individual_return: 'Individual Return', company_return: 'Company Return', ind_review_pack: 'Ind. Review Pack', co_review_pack: 'Co. Review Pack' };
        return map[t] || (t ? t.replace(/_/g, ' ') : '—');
    }

    function _statusBadge(status) {
        var cls = { completed: 'badge-ok', completed_with_warnings: 'badge-warn', failed: 'badge-err', executing: 'badge-info', previewed: 'badge-grey', cancelled: 'badge-grey' }[status] || 'badge-grey';
        return '<span class="badge ' + cls + '">' + esc((status || '').replace(/_/g, ' ')) + '</span>';
    }

})();
