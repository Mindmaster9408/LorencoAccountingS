/* Codebox 49 — Practice Risk Register + Internal Control Matrix
 * Internal practice governance. NOT enterprise risk software.
 * Prefix: risk
 */
(function () {
    'use strict';

    var BASE        = '/api/practice/risk-register';
    var _currentId   = null;
    var _currentRisk = null;
    var _currentTab  = 'overview';
    var _submitting  = false;
    var _page        = 1;
    var _reviewIdForComplete = null;
    var _urlSourceType = null;
    var _urlSourceId   = null;

    // ── Constants ────────────────────────────────────────────────────────────

    var STATUS_LABELS = {
        open: 'Open', monitoring: 'Monitoring', mitigated: 'Mitigated',
        accepted: 'Accepted', closed: 'Closed', cancelled: 'Cancelled',
        draft: 'Draft', completed: 'Completed',
    };

    var CATEGORY_LABELS = {
        operational: 'Operational', compliance: 'Compliance', tax: 'Tax', payroll: 'Payroll',
        finance: 'Finance', cyber: 'Cyber', privacy: 'Privacy', fraud: 'Fraud',
        business_continuity: 'Business Continuity', client_service: 'Client Service',
        strategic: 'Strategic', other: 'Other',
    };

    var EFFECTIVENESS_LABELS = { ineffective: 'Ineffective', partially_effective: 'Partially Effective', effective: 'Effective' };

    var EV_LABELS = {
        risk_created: 'Risk Created', risk_updated: 'Updated', risk_closed: 'Closed',
        risk_cancelled: 'Cancelled', risk_reopened: 'Reopened', control_added: 'Control Added',
        control_updated: 'Control Updated', control_removed: 'Control Removed',
        review_created: 'Review Scheduled', review_completed: 'Review Completed',
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(s)     { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }

    function _statusPill(s) {
        return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>';
    }

    function _ratingClass(score) {
        if (score == null) return '';
        if (score <= 6)  return 'rating-low';
        if (score <= 12) return 'rating-medium';
        if (score <= 19) return 'rating-high';
        return 'rating-critical';
    }

    function _ratingBadge(score) {
        if (score == null) return '<span style="color:#4a5568;">—</span>';
        return '<span class="rating-badge ' + _ratingClass(score) + '">' + _html(score) + '</span>';
    }

    function _effBadge(e) {
        if (!e) return '<span style="color:#4a5568;">Not assessed</span>';
        return '<span class="eff-badge eff-' + _html(e) + '">' + _html(EFFECTIVENESS_LABELS[e] || e) + '</span>';
    }

    function _heatCellColor(count) {
        if (count === 0) return '#12122a';
        if (count <= 2)  return '#3b5a8a';
        if (count <= 4)  return '#d4a94a';
        return '#c0392b';
    }

    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    function _qs() {
        var p = [];
        var category = document.getElementById('filterCategory').value;
        var status   = document.getElementById('filterStatus').value;
        var clientId = document.getElementById('filterClientId').value.trim();
        var search   = document.getElementById('filterSearch').value.trim();
        if (category) p.push('category='         + encodeURIComponent(category));
        if (status)   p.push('status='            + encodeURIComponent(status));
        if (clientId) p.push('linked_client_id='  + encodeURIComponent(clientId));
        if (search)   p.push('search='            + encodeURIComponent(search));
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function riskLoad() {
        _page = 1;
        _loadSummary();
        _loadHeatmap();
        _loadList();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        _urlSourceType = params.get('source_type');
        _urlSourceId   = params.get('source_id');
        if (_urlSourceType && _urlSourceId) {
            _renderSourceBanner(_urlSourceType, _urlSourceId);
        }
    }

    var SOURCE_TYPE_LABELS = {
        quality_finding: 'Quality Finding', knowledge_article: 'Knowledge Article',
        tax_dispute: 'Tax Dispute', completion_pack: 'Completion Pack',
    };
    var CREATE_FROM_ENDPOINT = {
        quality_finding: 'create-from-finding', knowledge_article: 'create-from-knowledge-article',
        tax_dispute: 'create-from-tax-dispute', completion_pack: 'create-from-completion-pack',
    };
    var CREATE_FROM_FIELD = {
        quality_finding: 'finding_id', knowledge_article: 'article_id',
        tax_dispute: 'dispute_id', completion_pack: 'completion_pack_id',
    };

    function _renderSourceBanner(sourceType, sourceId) {
        var existing = document.getElementById('sourceBanner');
        if (existing) existing.remove();

        var banner = document.createElement('div');
        banner.id = 'sourceBanner';
        banner.className = 'inline-msg info';
        banner.innerHTML = 'Showing risks created from <strong>' + _html(SOURCE_TYPE_LABELS[sourceType] || sourceType) + ' #' + _html(sourceId) + '</strong> — <span id="sourceBannerCount">loading…</span>';
        var content = document.querySelector('.page-content');
        content.insertBefore(banner, content.children[1]);

        window.PracticeAPI.fetch(BASE + '/risks?source_type=' + encodeURIComponent(sourceType) + '&source_id=' + encodeURIComponent(sourceId))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var countEl = document.getElementById('sourceBannerCount');
                if (!countEl) return;
                var risks = d.risks || [];
                if (!risks.length) {
                    countEl.innerHTML = 'no risks yet. <a href="#" onclick="_riskCreateFromSource(\'' + sourceType + '\',' + sourceId + ');return false;" style="color:#a3bffa;">Create one ↗</a>';
                    return;
                }
                countEl.innerHTML = risks.length + ' risk(s): ' + risks.map(function (rk) {
                    return '<a href="#" onclick="riskOpenDetail(' + rk.id + ');return false;" style="color:#a3bffa;">' + _html(rk.title) + '</a>';
                }).join(', ');
            })
            .catch(function () {});
    }

    function _riskCreateFromSource(sourceType, sourceId) {
        var endpoint = CREATE_FROM_ENDPOINT[sourceType];
        var field    = CREATE_FROM_FIELD[sourceType];
        if (!endpoint) return;
        var body = {};
        body[field] = sourceId;
        window.PracticeAPI.fetch(BASE + '/' + endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (r) {
            if (!r.ok) {
                if (r.status === 409) return _showToast('Active risk already exists (#' + r.data.existing_risk_id + ')');
                return _showToast(r.data.error || 'Failed to create risk');
            }
            _showToast('Risk created');
            riskOpenDetail(r.data.id);
        })
        .catch(function () { _showToast('Network error'); });
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
            { cls: 'sc-open',       count: d.open              || 0, label: 'Open',            filter: 'open' },
            { cls: 'sc-monitoring', count: d.monitoring         || 0, label: 'Monitoring',      filter: 'monitoring' },
            { cls: 'sc-mitigated',  count: d.mitigated          || 0, label: 'Mitigated',       filter: 'mitigated' },
            { cls: 'sc-accepted',   count: d.accepted           || 0, label: 'Accepted',        filter: 'accepted' },
            { cls: 'sc-closed',     count: d.closed             || 0, label: 'Closed',          filter: 'closed' },
            { cls: 'sc-high',       count: d.high_inherent_risk || 0, label: 'High Inherent',   filter: null },
            { cls: 'sc-overdue',    count: d.overdue_review     || 0, label: 'Review Overdue',  filter: null },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card ' + c.cls + '" onclick="' + (c.filter ? '_riskFilterStatus(\'' + c.filter + '\')' : '') + '">' +
                '<div class="sc-count">' + c.count + '</div>' +
                '<div class="sc-label">' + c.label + '</div>' +
            '</div>';
        }).join('');
    }

    function _riskFilterStatus(s) {
        document.getElementById('filterStatus').value = s;
        _page = 1;
        _loadList();
    }

    // ── Heat map ──────────────────────────────────────────────────────────────

    function _loadHeatmap() {
        window.PracticeAPI.fetch(BASE + '/heatmap')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderHeatmap(d.grid || []); })
            .catch(function () {});
    }

    function _renderHeatmap(grid) {
        var el = document.getElementById('heatmapGrid');
        if (!grid.length) { el.innerHTML = ''; return; }

        var html = '<div class="heatmap-grid">';
        html += '<div></div>';
        for (var i = 1; i <= 5; i++) html += '<div class="hm-header">Impact ' + i + '</div>';

        // Render likelihood 5 (top) down to 1 (bottom) — conventional heat map orientation.
        for (var l = 5; l >= 1; l--) {
            html += '<div class="hm-axis-label">L' + l + '</div>';
            var row = grid[l - 1];
            for (var im = 1; im <= 5; im++) {
                var cell = row[im - 1];
                var score = l * im;
                html += '<div class="hm-cell" style="background:' + _heatCellColor(cell.count) + ';" ' +
                    'onclick="_riskFilterHeatCell(' + l + ',' + im + ')" ' +
                    'title="Likelihood ' + l + ' × Impact ' + im + ' = ' + score + ' — ' + cell.count + ' risk(s)">' +
                    (cell.count || '') +
                '</div>';
            }
        }
        html += '</div>';
        html += '<div class="heatmap-axes"><span>← Likelihood (rows, 1–5 bottom to top) · Impact (columns, 1–5 left to right) →</span></div>';
        el.innerHTML = html;
    }

    function _riskFilterHeatCell(likelihood, impact) {
        _page = 1;
        window.PracticeAPI.fetch(BASE + '/risks?limit=200')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var matches = (d.risks || []).filter(function (r) { return r.likelihood === likelihood && r.impact === impact; });
                _renderList(matches, matches.length, 1, 200);
                document.getElementById('pagination').textContent = matches.length + ' risk(s) at Likelihood ' + likelihood + ' × Impact ' + impact;
            })
            .catch(function () {});
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + '/risks' + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.risks || [], d.total || 0, d.page || 1, d.limit || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8" style="color:#fc8181;">Failed to load risks</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No risks found. Create the first entry in the register.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (r) {
            return '<tr onclick="riskOpenDetail(' + r.id + ')">' +
                '<td style="color:#4a5568;font-size:.78rem;">#' + r.id + '</td>' +
                '<td><span class="cat-chip">' + _html(CATEGORY_LABELS[r.category] || r.category) + '</span></td>' +
                '<td>' + _statusPill(r.status) + '</td>' +
                '<td class="td-title" title="' + _html(r.title) + '">' + _html(r.title) + '</td>' +
                '<td style="font-size:.8rem;">' + _html(r.client_name || (r.linked_client_id ? ('#' + r.linked_client_id) : '—')) + '</td>' +
                '<td>' + _ratingBadge(r.inherent_risk) + '</td>' +
                '<td>' + _ratingBadge(r.residual_risk) + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + _fmtDate(r.next_review_date) + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_riskPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_riskPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' risk' + (total !== 1 ? 's' : '');
        }
    }

    function _riskPage(p) { _page = p; _loadList(); }

    // ── Filters ───────────────────────────────────────────────────────────────

    function riskClearFilters() {
        ['filterCategory','filterStatus','filterClientId','filterSearch'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        _page = 1;
        _loadList();
    }

    // ── Create Risk ───────────────────────────────────────────────────────────

    function riskOpenCreate() {
        document.getElementById('createModal').classList.add('open');
    }

    function riskCloseCreate() {
        document.getElementById('createModal').classList.remove('open');
    }

    function riskSubmitCreate() {
        if (_submitting) return;
        var title = document.getElementById('createTitle').value.trim();
        var category = document.getElementById('createCategory').value;
        if (!title)    return _showToast('Risk title is required');
        if (!category) return _showToast('Category is required');

        var payload = {
            title:             title,
            category:          category,
            review_frequency:  document.getElementById('createReviewFrequency').value || 'annual',
            likelihood:        Number(document.getElementById('createLikelihood').value || 3),
            impact:            Number(document.getElementById('createImpact').value || 3),
            linked_client_id:  document.getElementById('createClientId').value.trim() || null,
            owner_team_member_id: document.getElementById('createOwner').value.trim() || null,
            next_review_date:  document.getElementById('createNextReview').value || null,
            mitigation_plan:   document.getElementById('createMitigation').value.trim() || null,
            contingency_plan:  document.getElementById('createContingency').value.trim() || null,
            monitoring_notes:  document.getElementById('createMonitoring').value.trim() || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/risks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) {
                if (r.status === 409) return _showToast('Duplicate: active risk already exists (#' + r.data.existing_risk_id + ')');
                return _showToast(r.data.error || 'Failed to create risk');
            }
            _showToast('Risk created');
            riskCloseCreate();
            ['createTitle','createClientId','createOwner','createNextReview','createMitigation','createContingency','createMonitoring'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('createCategory').value = '';
            document.getElementById('createLikelihood').value = 3;
            document.getElementById('createImpact').value = 3;
            document.getElementById('createReviewFrequency').value = 'annual';
            riskLoad();
        })
        .catch(function () { _submitting = false; _showToast('Network error — could not create risk'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function riskOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        window.PracticeAPI.fetch(BASE + '/risks/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentRisk = d;
                _renderTabBar();
                _activateTab('overview');
                _renderFooter();
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load risk</div>';
            });
    }

    function riskCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId   = null;
        _currentRisk = null;
    }

    function _renderTabBar() {
        var tabs = [
            { key: 'overview', label: 'Overview' },
            { key: 'controls', label: 'Controls' },
            { key: 'reviews',  label: 'Reviews'  },
            { key: 'events',   label: 'Events'   },
        ];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="riskOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function riskOpenTab(tab) {
        _currentTab = tab;
        if (_currentRisk) {
            _activateTab(tab);
            _renderTabBar();
        }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        switch (tab) {
            case 'overview': _renderOverviewTab(body); break;
            case 'controls': _loadControlsTab(body);    break;
            case 'reviews':  _loadReviewsTab(body);     break;
            case 'events':   _loadEventsTab(body);      break;
        }
    }

    // ── Overview tab ──────────────────────────────────────────────────────────

    function _renderOverviewTab(body) {
        var r = _currentRisk;
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dRow('Category',   '<span class="cat-chip">' + _html(CATEGORY_LABELS[r.category] || r.category) + '</span>');
        html += _dRow('Status',     _statusPill(r.status));
        html += _dRow('Client',     _html(r.client_name || (r.linked_client_id ? ('#' + r.linked_client_id) : '—')));
        html += _dRow('Owner',      _html(r.owner_team_member_id ? ('#' + r.owner_team_member_id) : '—'));
        html += _dRow('Likelihood', _html(r.likelihood) + ' / 5');
        html += _dRow('Impact',     _html(r.impact) + ' / 5');
        html += _dRow('Inherent Risk (Overall Rating)', _ratingBadge(r.inherent_risk));
        html += _dRow('Residual Risk', _ratingBadge(r.residual_risk));
        html += _dRow('Review Frequency', _html(STATUS_LABELS[r.review_frequency] || r.review_frequency));
        html += _dRow('Next Review Date', _fmtDate(r.next_review_date));
        html += '</div>';
        if (r.mitigation_plan) {
            html += '<div class="section-label">Mitigation Plan</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(r.mitigation_plan) + '</div>';
        }
        if (r.contingency_plan) {
            html += '<div class="section-label">Contingency Plan</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(r.contingency_plan) + '</div>';
        }
        if (r.monitoring_notes) {
            html += '<div class="section-label">Monitoring Notes</div>';
            html += '<div style="background:#12122a;border-radius:8px;padding:10px;font-size:.82rem;color:#a0aec0;">' + _html(r.monitoring_notes) + '</div>';
        }
        if (r.source_type) {
            html += '<div class="section-label">Source</div>';
            html += '<div style="font-size:.82rem;color:#718096;">Created from ' + _html(SOURCE_TYPE_LABELS[r.source_type] || r.source_type) + ' #' + _html(r.source_id) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dRow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + label + '</div><div class="detail-value">' + (value || '—') + '</div></div>';
    }

    // ── Controls tab ──────────────────────────────────────────────────────────

    function _loadControlsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading controls…</div>';
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/controls')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderControlsTab(d.controls || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load controls</div>'; });
    }

    function _renderControlsTab(items, body) {
        var html = '<div class="tab-content">';
        html += '<div style="margin-bottom:10px;">';
        if (!['closed', 'cancelled'].includes(_currentRisk.status)) {
            html += '<button type="button" class="btn-action btn-success btn-sm" onclick="riskOpenControl()">+ Add Control</button>';
        }
        html += '</div>';
        var active = items.filter(function (c) { return c.is_active; });
        if (!active.length) {
            html += '<div class="inline-msg info">No controls recorded yet.</div>';
        } else {
            active.forEach(function (c) {
                html += '<div class="item-card">';
                html += '<div class="item-card-header">';
                html += '<span class="item-title">' + _html(c.control_title) + '</span>';
                html += _effBadge(c.effectiveness);
                if (c.control_type) html += '<span class="cat-chip">' + _html(c.control_type) + '</span>';
                html += '</div>';
                if (c.evidence_notes) html += '<div class="item-meta">' + _html(c.evidence_notes) + '</div>';
                if (c.review_date) html += '<div class="item-meta">Reviewed: ' + _fmtDate(c.review_date) + '</div>';
                html += '<div style="margin-top:8px;">';
                html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="riskRemoveControl(' + c.id + ')">Remove</button>';
                html += '</div></div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function riskOpenControl() {
        document.getElementById('controlModal').classList.add('open');
    }

    function riskCloseControl() {
        document.getElementById('controlModal').classList.remove('open');
    }

    function riskSubmitControl() {
        if (_submitting) return;
        var title = document.getElementById('ctrlTitle').value.trim();
        if (!title) return _showToast('Control title is required');

        var payload = {
            control_title:        title,
            control_type:         document.getElementById('ctrlType').value.trim() || null,
            effectiveness:        document.getElementById('ctrlEffectiveness').value || null,
            owner_team_member_id: document.getElementById('ctrlOwner').value.trim() || null,
            review_date:          document.getElementById('ctrlReviewDate').value || null,
            evidence_notes:       document.getElementById('ctrlEvidence').value.trim() || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/controls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to add control');
            _showToast('Control added');
            riskCloseControl();
            ['ctrlTitle','ctrlType','ctrlOwner','ctrlReviewDate','ctrlEvidence'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('ctrlEffectiveness').value = '';
            _loadControlsTab(document.getElementById('detailBody'));
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    function riskRemoveControl(controlId) {
        if (!window.confirm('Remove this control?')) return;
        window.PracticeAPI.fetch(BASE + '/controls/' + controlId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to remove control');
                _showToast('Control removed');
                _loadControlsTab(document.getElementById('detailBody'));
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Reviews tab ───────────────────────────────────────────────────────────

    function _loadReviewsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading reviews…</div>';
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/reviews')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReviewsTab(d.reviews || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load reviews</div>'; });
    }

    function _renderReviewsTab(items, body) {
        var html = '<div class="tab-content">';
        html += '<div style="margin-bottom:10px;">';
        if (!['closed', 'cancelled'].includes(_currentRisk.status)) {
            html += '<button type="button" class="btn-action btn-success btn-sm" onclick="riskScheduleReview()">+ Schedule Review</button>';
        }
        html += '</div>';
        if (!items.length) {
            html += '<div class="inline-msg info">No reviews recorded yet.</div>';
        } else {
            items.forEach(function (rv) {
                html += '<div class="item-card">';
                html += '<div class="item-card-header">';
                html += '<span class="item-title">Review</span>';
                html += _statusPill(rv.review_status);
                html += '</div>';
                if (rv.review_status === 'completed') {
                    html += '<div class="item-meta">L' + _html(rv.likelihood_at_review) + ' × I' + _html(rv.impact_at_review) +
                        ' — Residual: ' + _html(rv.residual_risk_at_review != null ? rv.residual_risk_at_review : '—') + '</div>';
                    html += '<div class="item-meta">Reviewed ' + _fmt(rv.reviewed_at) + '</div>';
                }
                if (rv.next_review_date) html += '<div class="item-meta">Next review: ' + _fmtDate(rv.next_review_date) + '</div>';
                if (rv.review_notes) html += '<div class="item-meta">' + _html(rv.review_notes) + '</div>';
                if (rv.review_status === 'draft') {
                    html += '<div style="margin-top:8px;">';
                    html += '<button type="button" class="btn-action btn-primary btn-sm" onclick="riskOpenCompleteReview(' + rv.id + ')">Complete Review</button>';
                    html += '</div>';
                }
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function riskScheduleReview() {
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/reviews', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            if (!r.ok) return _showToast(r.data.error || 'Failed to schedule review');
            _showToast('Review scheduled');
            _loadReviewsTab(document.getElementById('detailBody'));
        })
        .catch(function () { _showToast('Network error'); });
    }

    function riskOpenCompleteReview(reviewId) {
        _reviewIdForComplete = reviewId;
        document.getElementById('revLikelihood').value = _currentRisk.likelihood || '';
        document.getElementById('revImpact').value = _currentRisk.impact || '';
        document.getElementById('revResidual').value = _currentRisk.residual_risk != null ? _currentRisk.residual_risk : '';
        document.getElementById('revNextDate').value = '';
        document.getElementById('revNotes').value = '';
        document.getElementById('reviewModal').classList.add('open');
    }

    function riskCloseReviewModal() {
        document.getElementById('reviewModal').classList.remove('open');
        _reviewIdForComplete = null;
    }

    function riskSubmitCompleteReview() {
        if (_submitting || !_reviewIdForComplete) return;
        var payload = {
            likelihood:       Number(document.getElementById('revLikelihood').value || _currentRisk.likelihood),
            impact:           Number(document.getElementById('revImpact').value || _currentRisk.impact),
            residual_risk:    document.getElementById('revResidual').value !== '' ? Number(document.getElementById('revResidual').value) : null,
            next_review_date: document.getElementById('revNextDate').value || null,
            review_notes:     document.getElementById('revNotes').value.trim() || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/reviews/' + _reviewIdForComplete + '/complete', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to complete review');
            _showToast('Review completed');
            riskCloseReviewModal();
            riskOpenDetail(_currentId);
            _loadSummary();
            _loadHeatmap();
            _loadList();
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    // ── Events tab ────────────────────────────────────────────────────────────

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/events')
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
                html += '<div class="event-header">';
                html += '<span class="event-type">' + _html(EV_LABELS[ev.event_type] || ev.event_type) + '</span>';
                html += '<span class="event-time">' + _fmt(ev.created_at) + '</span>';
                html += '</div>';
                if (ev.old_status || ev.new_status) {
                    html += '<div class="event-status-change">';
                    if (ev.old_status) html += _statusPill(ev.old_status);
                    if (ev.old_status && ev.new_status) html += '<span class="event-arrow">→</span>';
                    if (ev.new_status) html += _statusPill(ev.new_status);
                    html += '</div>';
                }
                if (ev.notes) html += '<div class="event-notes">' + _html(ev.notes) + '</div>';
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    // ── Detail footer ─────────────────────────────────────────────────────────

    function _renderFooter() {
        var r = _currentRisk;
        var s = r.status;
        var term = ['closed', 'cancelled'].includes(s);
        var html = '<button type="button" class="btn-action btn-secondary" onclick="riskCloseDetail()">Close</button>';

        if (!term) {
            html += '<button type="button" class="btn-action btn-success" onclick="riskCloseRisk()">Close Risk</button>';
            html += '<button type="button" class="btn-action btn-danger" onclick="riskCancelRisk()">Cancel</button>';
        } else {
            html += '<button type="button" class="btn-action btn-primary" onclick="riskReopen()">Reopen</button>';
        }

        document.getElementById('detailFooter').innerHTML = html;
    }

    function riskCloseRisk() {
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/close', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to close risk');
                _showToast('Risk closed');
                riskOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function riskCancelRisk() {
        if (!window.confirm('Cancel this risk entry?')) return;
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to cancel risk');
                _showToast('Risk cancelled');
                riskCloseDetail();
                riskLoad();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function riskReopen() {
        window.PracticeAPI.fetch(BASE + '/risks/' + _currentId + '/reopen', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to reopen risk');
                _showToast('Risk reopened');
                riskOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.riskLoad               = riskLoad;
    window.riskOpenCreate         = riskOpenCreate;
    window.riskCloseCreate        = riskCloseCreate;
    window.riskSubmitCreate       = riskSubmitCreate;
    window.riskOpenDetail         = riskOpenDetail;
    window.riskCloseDetail        = riskCloseDetail;
    window.riskOpenTab            = riskOpenTab;
    window.riskClearFilters       = riskClearFilters;
    window.riskOpenControl        = riskOpenControl;
    window.riskCloseControl       = riskCloseControl;
    window.riskSubmitControl      = riskSubmitControl;
    window.riskRemoveControl      = riskRemoveControl;
    window.riskScheduleReview     = riskScheduleReview;
    window.riskOpenCompleteReview = riskOpenCompleteReview;
    window.riskCloseReviewModal   = riskCloseReviewModal;
    window.riskSubmitCompleteReview = riskSubmitCompleteReview;
    window.riskCloseRisk          = riskCloseRisk;
    window.riskCancelRisk         = riskCancelRisk;
    window.riskReopen             = riskReopen;
    window._riskFilterStatus      = _riskFilterStatus;
    window._riskFilterHeatCell    = _riskFilterHeatCell;
    window._riskPage              = _riskPage;
    window._riskCreateFromSource  = _riskCreateFromSource;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        riskLoad();
    });

}());
