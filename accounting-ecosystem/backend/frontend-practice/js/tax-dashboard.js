// Practice Tax Dashboard — Tax Season Command Center (Codebox 34/35)
// All data from /api/practice/tax-dashboard/* and /api/practice/tax-actions/*
// No localStorage/KV for business data.
(function () {
    'use strict';

    var esc      = PracticeAPI.escHtml;
    var BASE     = '/api/practice/tax-dashboard';
    var ACT_BASE = '/api/practice/tax-actions';

    // ─── Pagination state ────────────────────────────────────────────────────
    var _currentPage  = 1;
    var _totalReturns = 0;
    var _returnLimit  = 50;
    var _amSubmitting = false;

    // ─── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        LAYOUT.init('tax-dashboard');
        await _loadTeamMembersForFilter();
        tdRefreshAll();
    }

    async function _loadTeamMembersForFilter() {
        try {
            var res     = await PracticeAPI.fetch('/api/practice/team?active=true');
            var data    = await res.json();
            var members = data.team_members || data.members || data || [];

            // Returns list filter
            var sel = document.getElementById('tdFltMember');
            // Review queue reviewer filter
            var rqSel = document.getElementById('tdRqFltReviewer');
            // Action modal assignee
            var amSel = document.getElementById('tdAmMember');

            members.forEach(function (m) {
                var name = m.display_name || m.name || ('Member #' + m.id);
                if (sel) {
                    var o = document.createElement('option');
                    o.value = m.id; o.textContent = name;
                    sel.appendChild(o);
                }
                if (rqSel) {
                    var o2 = document.createElement('option');
                    o2.value = m.id; o2.textContent = name;
                    rqSel.appendChild(o2);
                }
                if (amSel) {
                    var o3 = document.createElement('option');
                    o3.value = m.id; o3.textContent = name;
                    amSel.appendChild(o3);
                }
            });
        } catch (_) { /* selects remain usable without member list */ }
    }

    // ─── Full refresh ─────────────────────────────────────────────────────────
    async function tdRefreshAll() {
        _currentPage = 1;
        Promise.all([
            _loadSummary(),
            _loadRisk(),
            _loadWorkload(),
            _loadActivity(),
            _loadReviewQueue(),
        ]);
        _loadReturns();
    }
    window.tdRefreshAll = tdRefreshAll;

    // ─── Summary ──────────────────────────────────────────────────────────────
    async function _loadSummary() {
        var actionEl = document.getElementById('tdKpiAction');
        var totalsEl = document.getElementById('tdKpiTotals');
        if (!actionEl) return;
        actionEl.innerHTML = '<div class="td-loading">Loading summary…</div>';
        if (totalsEl) totalsEl.innerHTML = '';

        try {
            var res = await PracticeAPI.fetch(BASE + '/summary');
            var d   = await res.json();

            actionEl.innerHTML = [
                _kpiCard(d.tax_deadlines_overdue,             'Overdue Deadlines',        'urgent'),
                _kpiCard(d.review_packs_pending,              'Review Packs Pending',      d.review_packs_pending > 0 ? 'warn' : 'info'),
                _kpiCard(d.draft_calculations_pending_review, 'Calculations Pending',      d.draft_calculations_pending_review > 0 ? 'warn' : 'info'),
                _kpiCard(d.documents_outstanding,             'Docs Outstanding',          d.documents_outstanding > 0 ? 'warn' : 'info'),
                _kpiCard(d.provisional_due_soon,              'Provisional Due ≤14d',      d.provisional_due_soon > 0 ? 'warn' : 'info'),
                _kpiCard((d.individual_returns_ready || 0) + (d.company_returns_ready || 0), 'Returns Ready',
                    ((d.individual_returns_ready || 0) + (d.company_returns_ready || 0)) > 0 ? 'ok' : 'info'),
            ].join('');

            if (totalsEl) {
                totalsEl.innerHTML = [
                    _kpiCard(d.individual_returns_total, 'Individual Returns', 'info'),
                    _kpiCard(d.company_returns_total,    'Company Returns',    'info'),
                    _kpiCard(d.provisional_plans_total,  'Provisional Plans',  'info'),
                    _kpiCard(d.individual_returns_ready, 'Ind. Ready',         d.individual_returns_ready > 0 ? 'ok' : 'info'),
                    _kpiCard(d.company_returns_ready,    'Co. Ready',          d.company_returns_ready > 0 ? 'ok' : 'info'),
                    _kpiCard((d.individual_returns_review_pending || 0) + (d.company_returns_review_pending || 0), 'Packs in Review', 'info'),
                ].join('');
            }
        } catch (err) {
            actionEl.innerHTML = '<div class="td-error">Failed to load summary: ' + esc(err.message) + '</div>';
        }
    }

    function _kpiCard(num, label, type) {
        return '<div class="td-kpi-card ' + (type || 'info') + '">' +
            '<div class="td-kpi-num">' + (num == null ? '—' : num) + '</div>' +
            '<div class="td-kpi-lbl">' + esc(label) + '</div>' +
            '</div>';
    }

    // ─── Risk Panels ──────────────────────────────────────────────────────────
    async function _loadRisk() {
        ['tdRiskOverdue','tdRiskBlocked','tdRiskRejected','tdRiskProvDue','tdRiskCalcWarn']
            .forEach(function(id) { _setEl(id, '<div class="td-loading">Loading…</div>'); });

        try {
            var res = await PracticeAPI.fetch(BASE + '/risk');
            var d   = await res.json();

            // Overdue deadlines
            var overdue = d.overdue_tax_deadlines || [];
            _setCount('tdRiskOverdueCount', overdue.length);
            _setEl('tdRiskOverdue', overdue.length === 0
                ? '<div class="td-panel-empty">No overdue deadlines.</div>'
                : overdue.slice(0, 8).map(function (item) {
                    var safeTitle = esc(item.title || 'Deadline');
                    return '<div class="td-risk-item">' +
                        '<div class="td-risk-dot red"></div>' +
                        '<div class="td-risk-body">' +
                            '<div class="td-risk-name">' + safeTitle + '</div>' +
                            '<div class="td-risk-meta">' + esc(item.client_name) + ' · Due: ' + _fmtDate(item.due_date) +
                                ' · <span style="color:#f87171;">' + item.days_overdue + 'd overdue</span>' +
                            '</div>' +
                            '<div class="td-risk-btns">' +
                                _riskBtn('compliance_deadline', item.id, item.client_id, 'Follow-up: ' + (item.title || 'Overdue deadline')) +
                                _openLink('/practice/deadlines.html') +
                            '</div>' +
                        '</div></div>';
                }).join('')
            );

            // Blocked returns
            var blocked = d.returns_with_blocked_readiness || [];
            _setCount('tdRiskBlockedCount', blocked.length);
            _setEl('tdRiskBlocked', blocked.length === 0
                ? '<div class="td-panel-empty">No blocked returns.</div>'
                : blocked.slice(0, 8).map(function (r) {
                    var srcType = r.source_type === 'individual' ? 'individual_return' : 'company_return';
                    var page    = r.source_type === 'individual' ? '/practice/individual-tax.html' : '/practice/company-tax.html';
                    return '<div class="td-risk-item">' +
                        '<div class="td-risk-dot amber"></div>' +
                        '<div class="td-risk-body">' +
                            '<div class="td-risk-name">' + esc(r.client_name) + '</div>' +
                            '<div class="td-risk-meta">' + _typeLabel(r.source_type) + ' · ' + esc(r.return_name || '') + ' · ' + (r.tax_year || '—') + '</div>' +
                            '<div class="td-risk-btns">' +
                                _riskBtn(srcType, r.id, r.client_id, 'Unblock: ' + r.client_name) +
                                _openLink(page) +
                            '</div>' +
                        '</div></div>';
                }).join('')
            );

            // Rejected review packs
            var rejCount = d.review_packs_rejected || 0;
            _setCount('tdRiskRejectedCount', rejCount);
            _setEl('tdRiskRejected', rejCount === 0
                ? '<div class="td-panel-empty">No rejected packs.</div>'
                : '<div class="td-risk-item"><div class="td-risk-dot red"></div><div class="td-risk-body">' +
                    '<div class="td-risk-name">' + rejCount + ' review pack' + (rejCount === 1 ? '' : 's') + ' rejected</div>' +
                    '<div class="td-risk-meta">Navigate to Company Tax or Individual Tax to review.</div>' +
                    '</div></div>'
            );

            // Provisional periods due ≤7 days
            var provDue = d.provisional_plans_near_due || [];
            _setCount('tdRiskProvDueCount', provDue.length);
            _setEl('tdRiskProvDue', provDue.length === 0
                ? '<div class="td-panel-empty">No periods due within 7 days.</div>'
                : provDue.slice(0, 8).map(function (p) {
                    return '<div class="td-risk-item">' +
                        '<div class="td-risk-dot amber"></div>' +
                        '<div class="td-risk-body">' +
                            '<div class="td-risk-name">' + esc(_periodLabel(p.period_type)) + '</div>' +
                            '<div class="td-risk-meta">Due: ' + _fmtDate(p.due_date) + ' · ' +
                                (p.days_until === 0 ? '<span style="color:#f87171;">Today</span>' : '<span style="color:#fcd34d;">' + p.days_until + 'd left</span>') +
                            '</div>' +
                            '<div class="td-risk-btns">' +
                                _riskBtn('provisional_plan', p.plan_id, null, 'Action provisional period due ' + _fmtDate(p.due_date)) +
                                _openLink('/practice/provisional-tax.html') +
                            '</div>' +
                        '</div></div>';
                }).join('')
            );

            // Calculations with extra warnings
            var calcWarnCount = d.calculations_with_extra_warnings_count || 0;
            var calcWarnList  = d.calculations_with_extra_warnings || [];
            _setCount('tdRiskCalcWarnCount', calcWarnCount);
            _setEl('tdRiskCalcWarn', calcWarnList.length === 0
                ? '<div class="td-panel-empty">No calculations with extra warning flags.</div>'
                : calcWarnList.slice(0, 8).map(function (c) {
                    var flagCount = Array.isArray(c.warning_flags) ? c.warning_flags.length : 0;
                    var srcType   = c.source_type === 'individual' ? 'individual_calculation' : 'company_calculation';
                    var page      = c.source_type === 'individual' ? '/practice/individual-tax.html' : '/practice/company-tax.html';
                    return '<div class="td-risk-item">' +
                        '<div class="td-risk-dot purple"></div>' +
                        '<div class="td-risk-body">' +
                            '<div class="td-risk-name">' + esc(c.calculation_name || 'Calculation') + '</div>' +
                            '<div class="td-risk-meta">' + _typeLabel(c.source_type) + ' · ' + flagCount + ' flag' + (flagCount === 1 ? '' : 's') + '</div>' +
                            '<div class="td-risk-btns">' +
                                _riskBtn(srcType, c.id, null, 'Review warnings: ' + (c.calculation_name || 'Calculation')) +
                                _openLink(page) +
                            '</div>' +
                        '</div></div>';
                }).join('')
            );

        } catch (err) {
            ['tdRiskOverdue','tdRiskBlocked','tdRiskRejected','tdRiskProvDue','tdRiskCalcWarn']
                .forEach(function (id) { _setEl(id, '<div class="td-error">Load failed: ' + esc(err.message) + '</div>'); });
        }
    }

    function _riskBtn(sourceType, sourceId, clientId, title) {
        var s = String(sourceId || 0);
        var c = String(clientId || 0);
        var t = (title || '').replace(/'/g, '').substring(0, 80);
        return '<button type="button" class="td-risk-btn" ' +
            'data-stype="' + esc(sourceType) + '" data-sid="' + s + '" data-cid="' + c + '" data-title="' + esc(t) + '" ' +
            'onclick="tdRiskActionBtn(this)">+ Action</button>';
    }

    function _openLink(href) {
        return '<a href="' + href + '" class="td-risk-btn">Open →</a>';
    }

    // Called by onclick on risk action buttons
    function tdRiskActionBtn(btn) {
        var st = btn.getAttribute('data-stype') || 'tax_dashboard_risk';
        var si = parseInt(btn.getAttribute('data-sid') || '0');
        var ci = parseInt(btn.getAttribute('data-cid') || '0') || null;
        var tt = btn.getAttribute('data-title') || 'Follow-up action';
        tdOpenActionModal(st, si, ci, tt);
    }
    window.tdRiskActionBtn = tdRiskActionBtn;

    // ─── Workload Table ───────────────────────────────────────────────────────
    async function _loadWorkload() {
        _setEl('tdWorkload', '<div class="td-loading">Loading…</div>');
        try {
            var res = await PracticeAPI.fetch(BASE + '/workload');
            var d   = await res.json();
            var wl  = d.workload || [];

            if (wl.length === 0) {
                _setEl('tdWorkload', '<div class="td-panel-empty">No active team members found.</div>');
                return;
            }

            _setEl('tdWorkload',
                '<table class="td-wl-table"><thead><tr>' +
                '<th>Team Member</th><th style="text-align:center;">Ind.</th><th style="text-align:center;">Co.</th>' +
                '<th style="text-align:center;">Prov.</th><th style="text-align:center;">Review Packs</th>' +
                '<th style="text-align:center;">Overdue</th><th style="text-align:center;">Docs</th>' +
                '<th style="text-align:center;">Total</th></tr></thead><tbody>' +
                wl.map(function (m) {
                    return '<tr>' +
                        '<td style="font-weight:600;color:rgba(255,255,255,0.88);">' + esc(m.display_name) +
                            '<br><span style="font-size:0.7rem;color:rgba(255,255,255,0.35);">' + esc(m.role || '') + '</span></td>' +
                        _wlCell(m.individual_returns_owned) +
                        _wlCell(m.company_returns_owned) +
                        _wlCell(m.provisional_plans_owned) +
                        _wlCell(m.review_packs_pending, true) +
                        _wlCell(m.overdue_tax_deadlines, false, true) +
                        _wlCell(m.outstanding_documents) +
                        '<td class="td-wl-num" style="font-weight:700;color:rgba(255,255,255,0.85);">' + (m.total_tax_items || 0) + '</td>' +
                        '</tr>';
                }).join('') +
                '</tbody></table>'
            );
        } catch (err) {
            _setEl('tdWorkload', '<div class="td-error">Failed to load workload: ' + esc(err.message) + '</div>');
        }
    }

    function _wlCell(n, isWarn, isUrgent) {
        var cls = 'td-wl-num ' + (n > 0 && isUrgent ? 'td-wl-hi' : n > 0 && isWarn ? 'td-wl-mid' : n === 0 ? 'td-wl-zero' : '');
        return '<td class="' + cls + '">' + (n || 0) + '</td>';
    }

    // ─── Review Queue ─────────────────────────────────────────────────────────
    async function _loadReviewQueue() {
        _setEl('tdReviewQueue', '<div class="td-loading">Loading…</div>');
        _setCount('tdRqCount', '—');

        var qs = [];
        var fltType     = _val('tdRqFltType');
        var fltReviewer = _val('tdRqFltReviewer');
        if (fltType)     qs.push('source_type=' + encodeURIComponent(fltType));
        if (fltReviewer) qs.push('reviewer_team_member_id=' + encodeURIComponent(fltReviewer));

        try {
            var res  = await PracticeAPI.fetch(ACT_BASE + '/review-queue' + (qs.length ? '?' + qs.join('&') : ''));
            var data = await res.json();
            var rows = data.review_queue || [];

            _setCount('tdRqCount', rows.length);

            if (rows.length === 0) {
                _setEl('tdReviewQueue', '<div class="td-panel-empty">Nothing in the review queue.</div>');
                return;
            }

            _setEl('tdReviewQueue',
                rows.map(function (r) {
                    var typeCls = 'td-b-' + (r.source_type || '').replace(/_/g, '-');
                    var warnTxt = r.warning_count > 0 ? ' · <span style="color:#fcd34d;">⚠ ' + r.warning_count + ' flags</span>' : '';
                    var rvTxt   = r.reviewer ? ' · Reviewer: ' + esc(r.reviewer) : ' · <span style="color:#f87171;">No reviewer</span>';
                    var pageHref = _rqPageHref(r.source_type);
                    return '<div class="td-rq-row">' +
                        '<div class="td-rq-body">' +
                            '<div class="td-rq-name">' + esc(r.client_name) +
                                (r.return_name ? ' — ' + esc(r.return_name) : '') +
                            '</div>' +
                            '<div class="td-rq-meta">' + (r.tax_year || '—') + rvTxt + warnTxt + '</div>' +
                        '</div>' +
                        '<div class="td-rq-btns">' +
                            '<span class="td-badge ' + typeCls + '">' + esc(_sourceTypeLabel(r.source_type)) + '</span>' +
                            (r.reviewer_id == null
                                ? '<button type="button" class="td-risk-btn" data-stype="' + esc(r.source_type) + '" data-sid="' + r.source_id + '" data-cid="0" data-title="Assign reviewer: ' + esc((r.return_name || r.client_name || '').replace(/'/g,'').substring(0,60)) + '" onclick="tdRiskActionBtn(this)">Assign</button>'
                                : '') +
                            '<a href="' + pageHref + '" class="td-return-link">Open →</a>' +
                        '</div>' +
                        '</div>';
                }).join('')
            );
        } catch (err) {
            _setEl('tdReviewQueue', '<div class="td-error">Failed to load review queue: ' + esc(err.message) + '</div>');
        }
    }

    function tdLoadReviewQueue() { _loadReviewQueue(); }
    window.tdLoadReviewQueue = tdLoadReviewQueue;

    function _rqPageHref(sourceType) {
        var m = {
            individual_return: '/practice/individual-tax.html',
            company_return:    '/practice/company-tax.html',
            provisional_plan:  '/practice/provisional-tax.html',
            individual_calculation: '/practice/individual-tax.html',
            company_calculation:    '/practice/company-tax.html',
            individual_review_pack: '/practice/individual-tax.html',
            company_review_pack:    '/practice/company-tax.html',
        };
        return m[sourceType] || '/practice';
    }

    function _sourceTypeLabel(t) {
        var m = {
            individual_return: 'Individual', company_return: 'Company',
            provisional_plan: 'Provisional', individual_calculation: 'Ind. Calc',
            company_calculation: 'Co. Calc', individual_review_pack: 'Ind. Pack',
            company_review_pack: 'Co. Pack',
        };
        return m[t] || t || '—';
    }

    // ─── Action Modal ─────────────────────────────────────────────────────────

    function tdOpenActionModal(sourceType, sourceId, clientId, suggestedTitle) {
        var el = document.getElementById('tdActionModal');
        if (!el) return;
        // Pre-fill hidden fields
        _setVal('tdAmSourceType', sourceType || 'tax_dashboard_risk');
        _setVal('tdAmSourceId',   String(sourceId || 0));
        _setVal('tdAmClientId',   String(clientId || ''));
        _setVal('tdAmTitle',      suggestedTitle || '');
        _setVal('tdAmDueDate',    '');
        _setVal('tdAmNotes',      '');
        _setVal('tdAmActionType', 'general_followup');
        var errEl = document.getElementById('tdAmError');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        el.style.display = 'flex';
        var titleInput = document.getElementById('tdAmTitle');
        if (titleInput) titleInput.focus();
    }
    window.tdOpenActionModal = tdOpenActionModal;

    function tdCloseActionModal(evt) {
        if (evt && evt.target !== document.getElementById('tdActionModal')) return;
        var el = document.getElementById('tdActionModal');
        if (el) el.style.display = 'none';
        _amSubmitting = false;
    }
    window.tdCloseActionModal = tdCloseActionModal;

    async function tdSubmitAction() {
        if (_amSubmitting) return;

        var sourceType = _val('tdAmSourceType');
        var sourceId   = parseInt(_val('tdAmSourceId') || '0') || 0;
        var clientId   = parseInt(_val('tdAmClientId') || '0') || null;
        var actionType = _val('tdAmActionType');
        var title      = (_val('tdAmTitle') || '').trim();
        var memberId   = parseInt(_val('tdAmMember') || '0') || null;
        var dueDate    = _val('tdAmDueDate') || null;
        var notes      = (_val('tdAmNotes') || '').trim() || null;

        var errEl = document.getElementById('tdAmError');
        if (!title) {
            if (errEl) { errEl.textContent = 'Action title is required.'; errEl.style.display = 'block'; }
            return;
        }
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

        _amSubmitting = true;
        var btn = document.getElementById('tdAmSubmitBtn');
        if (btn) btn.disabled = true;

        try {
            var res  = await PracticeAPI.fetch(ACT_BASE + '/from-dashboard-risk', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    source_type:              sourceType,
                    source_id:                sourceId,
                    client_id:                clientId,
                    action_type:              actionType,
                    action_title:             title,
                    assigned_team_member_id:  memberId,
                    due_date:                 dueDate,
                    notes,
                }),
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

            // Close modal and refresh actions panel if visible
            var el = document.getElementById('tdActionModal');
            if (el) el.style.display = 'none';
            PracticeAPI.showToast('Action created.');
        } catch (err) {
            if (errEl) { errEl.textContent = 'Failed: ' + esc(err.message); errEl.style.display = 'block'; }
        } finally {
            _amSubmitting = false;
            if (btn) btn.disabled = false;
        }
    }
    window.tdSubmitAction = tdSubmitAction;

    // ─── Returns List ─────────────────────────────────────────────────────────
    async function _loadReturns() {
        _setEl('tdReturnsList', '<div class="td-loading">Loading…</div>');
        var pgEl = document.getElementById('tdPagination');
        if (pgEl) pgEl.style.display = 'none';

        var qs = _buildReturnsQS();
        try {
            var res  = await PracticeAPI.fetch(BASE + '/returns?' + qs);
            var data = await res.json();
            var rows = data.returns || [];
            _totalReturns = data.total || 0;

            if (rows.length === 0) {
                _setEl('tdReturnsList', '<div class="td-panel-empty">No tax work matches current filters.</div>');
                return;
            }

            _setEl('tdReturnsList', rows.map(_renderReturnRow).join(''));

            var totalPages = Math.ceil(_totalReturns / _returnLimit);
            if (totalPages > 1) {
                var prevBtn = document.getElementById('tdBtnPrev');
                var nextBtn = document.getElementById('tdBtnNext');
                var infoEl  = document.getElementById('tdPageInfo');
                if (prevBtn) prevBtn.disabled = (_currentPage <= 1);
                if (nextBtn) nextBtn.disabled = (_currentPage >= totalPages);
                if (infoEl)  infoEl.textContent = 'Page ' + _currentPage + ' of ' + totalPages + ' (' + _totalReturns + ' total)';
                if (pgEl)    pgEl.style.display = 'flex';
            }
        } catch (err) {
            _setEl('tdReturnsList', '<div class="td-error">Failed to load returns: ' + esc(err.message) + '</div>');
        }
    }

    function _renderReturnRow(r) {
        var typeCls  = 'td-b-' + (r.source_type || 'individual');
        var statusCls = 'td-b-s-' + (r.status || 'draft').replace(/ /g, '_');
        var readyCls  = 'td-b-r-' + (r.readiness_status || 'unknown');
        var calcBadge = r.latest_calculation_status
            ? '<span class="td-badge td-b-s-' + r.latest_calculation_status.replace(/ /g,'_') + '">Calc: ' + esc(r.latest_calculation_status.replace(/_/g,' ')) + '</span>' : '';
        var packBadge = r.latest_review_pack_status
            ? '<span class="td-badge td-b-s-' + r.latest_review_pack_status.replace(/ /g,'_') + '">Pack: ' + esc(r.latest_review_pack_status.replace(/_/g,' ')) + '</span>' : '';
        var warnBadge = r.warning_flags_count > 2
            ? '<span class="td-badge td-b-warn-flags">⚠ ' + r.warning_flags_count + ' flags</span>' : '';
        var dueMeta   = r.next_due_date ? ' · Next due: ' + _fmtDate(r.next_due_date) : '';
        var scoreMeta = r.readiness_score != null ? ' · ' + r.readiness_score + '%' : '';

        return '<div class="td-return-row">' +
            '<div class="td-return-body">' +
                '<div class="td-return-name">' + esc(r.client_name) + (r.return_name ? ' — ' + esc(r.return_name) : '') + '</div>' +
                '<div class="td-return-meta">' + esc(r.tax_year || '—') + scoreMeta + dueMeta + '</div>' +
            '</div>' +
            '<div class="td-return-badges">' +
                '<span class="td-badge ' + typeCls + '">' + esc(_typeLabel(r.source_type)) + '</span>' +
                '<span class="td-badge ' + statusCls + '">' + esc((r.status || '').replace(/_/g,' ')) + '</span>' +
                (r.readiness_status ? '<span class="td-badge ' + readyCls + '">' + esc(r.readiness_status) + '</span>' : '') +
                calcBadge + packBadge + warnBadge +
                '<a class="td-return-link" href="' + _pageHref(r.source_type) + '">Open →</a>' +
            '</div>' +
            '</div>';
    }

    function _pageHref(sourceType) {
        var m = { individual: '/practice/individual-tax.html', company: '/practice/company-tax.html', provisional: '/practice/provisional-tax.html' };
        return m[sourceType] || '/practice';
    }

    function _buildReturnsQS() {
        var params = [];
        var type      = _val('tdFltType');
        var year      = _val('tdFltYear');
        var status    = _val('tdFltStatus');
        var readiness = _val('tdFltReadiness');
        var review    = _val('tdFltReview');
        var member    = _val('tdFltMember');
        if (type)      params.push('return_type=' + encodeURIComponent(type));
        if (year)      params.push('tax_year='    + encodeURIComponent(year));
        if (status)    params.push('status='      + encodeURIComponent(status));
        if (readiness) params.push('readiness_status=' + encodeURIComponent(readiness));
        if (review)    params.push('review_status='    + encodeURIComponent(review));
        if (member)    params.push('assigned_team_member_id=' + encodeURIComponent(member));
        params.push('page=' + _currentPage, 'limit=' + _returnLimit);
        return params.join('&');
    }

    function tdApplyFilters() { _currentPage = 1; _loadReturns(); }
    window.tdApplyFilters = tdApplyFilters;

    function tdPrevPage() { if (_currentPage > 1) { _currentPage--; _loadReturns(); } }
    function tdNextPage() {
        if (_currentPage < Math.ceil(_totalReturns / _returnLimit)) { _currentPage++; _loadReturns(); }
    }
    window.tdPrevPage = tdPrevPage;
    window.tdNextPage = tdNextPage;

    // ─── Activity Timeline ────────────────────────────────────────────────────
    async function _loadActivity() {
        _setEl('tdActivity', '<div class="td-loading">Loading…</div>');
        try {
            var res  = await PracticeAPI.fetch(BASE + '/activity');
            var data = await res.json();
            var items = data.activity || [];

            if (items.length === 0) {
                _setEl('tdActivity', '<div class="td-panel-empty">No recent activity.</div>');
                return;
            }

            _setEl('tdActivity',
                items.map(function (e) {
                    return '<div class="td-activity-item">' +
                        '<div class="td-activity-dot"></div>' +
                        '<div class="td-activity-body">' +
                            '<div class="td-activity-evt">' + esc(e.event_type.replace(/_/g,' ')) + '</div>' +
                            '<div class="td-activity-meta">' + esc(e.source) + ' · ' + _fmtTs(e.created_at) + '</div>' +
                        '</div></div>';
                }).join('')
            );
        } catch (err) {
            _setEl('tdActivity', '<div class="td-error">Failed to load activity: ' + esc(err.message) + '</div>');
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function _setEl(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
    function _setCount(id, n) { var el = document.getElementById(id); if (el) el.textContent = (n != null ? n : '—'); }
    function _val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    function _setVal(id, v) { var el = document.getElementById(id); if (el) el.value = v; }

    function _typeLabel(t) {
        var m = { individual: 'Individual', company: 'Company', provisional: 'Provisional',
                  individual_return: 'Individual', company_return: 'Company', provisional_plan: 'Provisional' };
        return m[t] || t || '—';
    }

    function _periodLabel(t) {
        var m = { period_1: 'Period 1', period_2: 'Period 2', topup: 'Top-up' };
        return m[t] || t || 'Period';
    }

    function _fmtDate(d) {
        if (!d) return '—';
        var parts = String(d).split('T')[0].split('-');
        if (parts.length !== 3) return d;
        return parts[2] + '/' + parts[1] + '/' + parts[0];
    }

    function _fmtTs(ts) {
        if (!ts) return '—';
        try {
            var dt = new Date(ts);
            return _fmtDate(dt.toISOString()) + ' ' + dt.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
        } catch (_) { return String(ts); }
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

}());
