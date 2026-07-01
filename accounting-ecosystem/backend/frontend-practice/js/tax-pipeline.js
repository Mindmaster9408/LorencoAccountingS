(function () {
    'use strict';

    var BASE = '/api/practice/tax-pipeline';

    var STAGE_ORDER = [
        'not_started', 'docs_requested', 'docs_received', 'data_captured',
        'calculation_completed', 'review_pack_generated', 'under_review',
        'ready_to_submit', 'submitted', 'completed'
    ];
    var STAGE_LABELS = {
        not_started:           'Not Started',
        docs_requested:        'Docs Requested',
        docs_received:         'Docs Received',
        data_captured:         'Data Captured',
        calculation_completed: 'Calculation Done',
        review_pack_generated: 'Review Pack',
        under_review:          'Under Review',
        ready_to_submit:       'Ready To Submit',
        submitted:             'Submitted',
        completed:             'Completed',
        cancelled:             'Cancelled',
    };

    // State
    var _items           = [];
    var _currentView     = 'board';
    var _currentDetail   = null;   // { sourceType, sourceId, detail }
    var _submitting      = false;

    // ── Utilities ──────────────────────────────────────────────────────────────

    function _qs() {
        var p = [];
        var type  = document.getElementById('filterType').value;
        var stage = document.getElementById('filterStage').value;
        var year  = document.getElementById('filterYear').value;
        if (type)  p.push('source_type='  + encodeURIComponent(type));
        if (stage) p.push('filing_stage=' + encodeURIComponent(stage));
        if (year)  p.push('tax_year='     + encodeURIComponent(year));
        return p.length ? '?' + p.join('&') : '';
    }

    function _typeBadge(sourceType) {
        if (sourceType === 'individual_tax_return')  return '<span class="type-badge type-ind">Individual</span>';
        if (sourceType === 'company_tax_return')      return '<span class="type-badge type-comp">Company</span>';
        if (sourceType === 'provisional_tax_plan')    return '<span class="type-badge type-prov">Provisional</span>';
        return '<span class="type-badge">?</span>';
    }

    function _stagePill(stage) {
        return '<span class="stage-pill stage-' + stage + '">' + (STAGE_LABELS[stage] || stage) + '</span>';
    }

    function _formatDate(iso) {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' }); } catch(e) { return iso; }
    }

    function _showToast(msg, dur) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(function () { t.classList.remove('show'); }, dur || 3000);
    }

    function _html(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function _money(v) {
        if (v == null) return '—';
        return 'R ' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits:2, maximumFractionDigits:2 });
    }

    var PAY_STATUS_LABELS = {
        outstanding: 'Outstanding', partially_paid: 'Partially Paid', paid_in_full: 'Paid in Full',
        overpaid: 'Overpaid', refund_pending: 'Refund Pending', refund_received: 'Refund Received',
        cancelled: 'Cancelled',
    };

    // ── Load pipeline data ─────────────────────────────────────────────────────

    function tplLoad() {
        _loadSummary();
        _loadItems();
    }

    function _loadSummary() {
        PracticeAPI.fetch(BASE + '/summary')
            .then(function (res) { return res.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {
                document.getElementById('summaryGrid').innerHTML = '<span style="color:#fc8181;font-size:.8rem">Failed to load summary</span>';
            });
    }

    function _loadItems() {
        _setLoading(true);
        PracticeAPI.fetch(BASE + _qs())
            .then(function (res) { return res.json(); })
            .then(function (d) {
                _items = d.items || [];
                _setLoading(false);
                _renderView();
            })
            .catch(function () {
                _setLoading(false);
                _renderError();
            });
    }

    // ── Summary cards ──────────────────────────────────────────────────────────

    function _renderSummary(d) {
        var stageSummary = d.stage_summary || [];
        var activeStages = ['under_review','ready_to_submit','submitted'];
        var highlight    = {
            ready_to_submit: 'c-info',
            under_review:    'c-warn',
            submitted:       'c-ok',
        };
        var html = '';
        stageSummary.forEach(function (s) {
            if (s.count === 0 && !activeStages.includes(s.stage)) return;
            var cls = highlight[s.stage] || (s.count > 0 ? '' : '');
            html += '<div class="sum-card" onclick="tplFilterByStage(\'' + _html(s.stage) + '\')">';
            html += '<div class="sum-card-count ' + cls + '">' + s.count + '</div>';
            html += '<div class="sum-card-label">' + _html(s.label) + '</div>';
            html += '</div>';
        });
        if (!html) html = '<div style="color:#718096;font-size:.8rem">No data</div>';
        document.getElementById('summaryGrid').innerHTML = html;
    }

    // ── View toggle ────────────────────────────────────────────────────────────

    function tplSetView(view) {
        _currentView = view;
        document.getElementById('viewBoardBtn').className = 'view-btn' + (view === 'board' ? ' active' : '');
        document.getElementById('viewListBtn').className  = 'view-btn' + (view === 'list'  ? ' active' : '');
        _renderView();
    }

    function _renderView() {
        if (_currentView === 'board') {
            document.getElementById('boardWrap').style.display = 'block';
            document.getElementById('listWrap').style.display  = 'none';
            _renderBoard();
        } else {
            document.getElementById('boardWrap').style.display = 'none';
            document.getElementById('listWrap').style.display  = 'block';
            _renderList();
        }
    }

    // ── Board rendering ────────────────────────────────────────────────────────

    function _renderBoard() {
        var board = document.getElementById('board');
        if (!_items.length) {
            board.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div>No pipeline items found</div></div>';
            return;
        }

        // Group by stage
        var grouped = {};
        STAGE_ORDER.forEach(function (s) { grouped[s] = []; });
        _items.forEach(function (item) {
            var s = item.filing_stage;
            if (!grouped[s]) grouped[s] = [];
            grouped[s].push(item);
        });

        var html = '';
        STAGE_ORDER.forEach(function (stage) {
            var cards = grouped[stage];
            html += '<div class="board-col">';
            html += '<div class="board-col-header">';
            html += _html(STAGE_LABELS[stage]);
            html += '<span class="board-col-count">' + cards.length + '</span>';
            html += '</div>';
            html += '<div class="board-col-body">';
            if (cards.length === 0) {
                html += '<div style="font-size:.72rem;color:#4a5568;text-align:center;padding:12px 0;">Empty</div>';
            } else {
                cards.forEach(function (item) {
                    html += _boardCard(item);
                });
            }
            html += '</div></div>';
        });

        board.innerHTML = html;
    }

    function _boardCard(item) {
        var name   = _html(item.name || '—');
        var client = _html(item.client_name || '');
        var year   = item.tax_year || '';
        var resp   = item.responsible_team_member_id ? '#' + item.responsible_team_member_id : '';

        return '<div class="pipeline-card" onclick="tplOpenDetail(\'' + _html(item.source_type) + '\',' + item.source_id + ')">' +
            '<div class="pipeline-card-name" title="' + name + '">' + name + '</div>' +
            (client ? '<div class="pipeline-card-client">' + client + '</div>' : '') +
            '<div class="pipeline-card-meta">' +
            _typeBadge(item.source_type) +
            '<span class="pipeline-card-year">' + year + '</span>' +
            (resp ? '<span class="member-chip">' + _html(resp) + '</span>' : '') +
            '</div></div>';
    }

    // ── List rendering ─────────────────────────────────────────────────────────

    function _renderList() {
        var tbody = document.getElementById('listBody');
        if (!_items.length) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">📋</div>No pipeline items found</div></td></tr>';
            return;
        }
        var html = '';
        _items.forEach(function (item) {
            var name   = _html(item.name || '—');
            var client = _html(item.client_name || '—');
            html += '<tr onclick="tplOpenDetail(\'' + _html(item.source_type) + '\',' + item.source_id + ')">';
            html += '<td><div style="font-weight:600">' + name + '</div><div style="font-size:.72rem;color:#718096">' + client + '</div></td>';
            html += '<td>' + _typeBadge(item.source_type) + '</td>';
            html += '<td>' + (item.tax_year || '—') + '</td>';
            html += '<td>' + _stagePill(item.filing_stage) + '</td>';
            html += '<td style="color:#718096;font-size:.78rem">' + (item.responsible_team_member_id ? '#' + item.responsible_team_member_id : '—') + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    // ── Loading / error states ─────────────────────────────────────────────────

    function _setLoading(on) {
        var board = document.getElementById('board');
        var tbody = document.getElementById('listBody');
        if (on) {
            board.innerHTML = '<div class="loading-spinner">Loading pipeline…</div>';
            tbody.innerHTML = '<tr><td colspan="5"><div class="loading-spinner">Loading…</div></td></tr>';
        }
    }

    function _renderError() {
        document.getElementById('board').innerHTML = '<div class="empty-state" style="color:#fc8181">Failed to load pipeline</div>';
        document.getElementById('listBody').innerHTML = '<tr><td colspan="5" style="color:#fc8181;text-align:center">Failed to load pipeline</td></tr>';
    }

    // ── Filters ────────────────────────────────────────────────────────────────

    function tplApplyFilters()  { _loadItems(); }
    function tplClearFilters()  {
        document.getElementById('filterType').value  = '';
        document.getElementById('filterStage').value = '';
        document.getElementById('filterYear').value  = '';
        _loadItems();
    }
    function tplFilterByStage(stage) {
        document.getElementById('filterStage').value = stage;
        tplApplyFilters();
    }

    // ── Detail modal ───────────────────────────────────────────────────────────

    function tplOpenDetail(sourceType, sourceId) {
        _currentDetail = null;
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailModalTitle').textContent = 'Loading…';
        document.getElementById('detailModalBody').innerHTML    = '<div class="loading-spinner">Loading detail…</div>';
        document.getElementById('detailChangeStageBtn').disabled = true;

        PracticeAPI.fetch(BASE + '/' + encodeURIComponent(sourceType) + '/' + sourceId)
            .then(function (res) { return res.json(); })
            .then(function (d) {
                _currentDetail = { sourceType: sourceType, sourceId: sourceId, detail: d };
                _renderDetail(d);
                document.getElementById('detailChangeStageBtn').disabled =
                    (d.filing_stage === 'cancelled' || d.filing_stage === 'completed');
            })
            .catch(function () {
                document.getElementById('detailModalBody').innerHTML = '<div style="color:#fc8181">Failed to load detail</div>';
            });
    }

    function _renderDetail(d) {
        var typeName = d.source_type === 'individual_tax_return' ? 'Individual Tax Return'
                     : d.source_type === 'company_tax_return'    ? 'Company Tax Return'
                     : 'Provisional Tax Plan';
        document.getElementById('detailModalTitle').textContent = typeName + ' — Pipeline Detail';

        var html = '';

        // Current stage
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Current Stage</div>';
        html += '<div style="display:flex;align-items:center;gap:12px;">';
        html += _stagePill(d.filing_stage);
        html += '<span style="font-size:.75rem;color:#718096">Updated ' + _formatDate(d.filing_stage_updated_at) + '</span>';
        html += '</div>';
        html += '</div>';

        // Details
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Details</div>';
        html += '<div class="detail-grid">';
        html += '<div class="detail-field"><div class="detail-field-label">Tax Year</div><div class="detail-field-value">' + (d.tax_year || '—') + '</div></div>';
        html += '<div class="detail-field"><div class="detail-field-label">Type</div><div class="detail-field-value">' + _typeBadge(d.source_type) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-field-label">Readiness</div><div class="detail-field-value">' + _html(d.readiness_status || '—') + '</div></div>';
        html += '<div class="detail-field"><div class="detail-field-label">Status</div><div class="detail-field-value">' + _html(d.status || '—') + '</div></div>';
        html += '</div></div>';

        // Allowed next stages
        if (d.allowed_next_stages && d.allowed_next_stages.length) {
            html += '<div class="detail-section">';
            html += '<div class="detail-section-title">Allowed Next Stages</div>';
            html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
            d.allowed_next_stages.forEach(function (s) {
                html += _stagePill(s.stage);
            });
            html += '</div></div>';
        }

        // History
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Stage History</div>';
        if (!d.history || !d.history.length) {
            html += '<div style="color:#718096;font-size:.8rem">No history yet</div>';
        } else {
            html += '<div class="history-list">';
            d.history.forEach(function (ev) {
                var arrow = ev.old_stage
                    ? (_html(STAGE_LABELS[ev.old_stage] || ev.old_stage) + ' → ' + _html(STAGE_LABELS[ev.new_stage] || ev.new_stage))
                    : ('Set to ' + _html(STAGE_LABELS[ev.new_stage] || ev.new_stage));
                html += '<div class="history-item">';
                html += '<div class="history-dot"></div>';
                html += '<div class="history-content">';
                html += '<div class="history-stages">' + arrow + '</div>';
                html += '<div class="history-meta">' + _formatDate(ev.created_at);
                if (ev.actor_user_id) html += ' · User #' + ev.actor_user_id;
                html += '</div>';
                if (ev.notes) html += '<div class="history-notes">"' + _html(ev.notes) + '"</div>';
                html += '</div></div>';
            });
            html += '</div>';
        }
        html += '</div>';

        // ── Pipeline → Submission Register link (only when submitted) ──
        if (d.filing_stage === 'submitted') {
            html += '<div class="detail-section" style="border-top:1px solid #2d3748;padding-top:16px;margin-top:4px;">';
            html += '<div class="detail-section-title">Submission Register</div>';
            var regUrl = '/practice/tax-submissions.html'
                + '?source_type=' + encodeURIComponent(d.source_type)
                + '&source_id='   + encodeURIComponent(d.source_id)
                + '&tax_year='    + encodeURIComponent(d.tax_year || '');
            html += '<div style="font-size:.8rem;color:#a0aec0;margin-bottom:10px;">This return is marked submitted. Create a formal submission register entry to record the reference number, method, and evidence.</div>';
            html += '<a href="' + regUrl + '" style="display:inline-block;padding:7px 16px;background:#667eea;color:#fff;border-radius:7px;font-size:.82rem;font-weight:700;text-decoration:none;">Open Submission Register</a>';
            html += '</div>';
        }

        // ── Pipeline → Payment Summary (only when completed) ──
        if (d.filing_stage === 'completed') {
            html += '<div class="detail-section" style="border-top:1px solid #2d3748;padding-top:16px;margin-top:4px;">';
            html += '<div class="detail-section-title">Payment Summary</div>';
            var ps = d.payment_summary;
            if (!ps) {
                html += '<div style="font-size:.8rem;color:#a0aec0;">No submission register entry found yet for this return, so no payment case can exist. Open the Submission Register to record the submission first.</div>';
            } else if (!ps.payments || !ps.payments.length) {
                html += '<div style="font-size:.8rem;color:#a0aec0;margin-bottom:10px;">Submission registered, but no payment case has been created yet.</div>';
                if (ps.amount_payable) html += '<div style="font-size:.8rem;color:#a0aec0;">Amount payable: ' + _money(ps.amount_payable) + '</div>';
                if (ps.refund_amount)  html += '<div style="font-size:.8rem;color:#a0aec0;">Refund amount: ' + _money(ps.refund_amount) + '</div>';
            } else {
                ps.payments.forEach(function (p) {
                    html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #2d3748;font-size:.82rem;">';
                    html += '<span class="pay-pill pay-' + _html(p.status) + '">' + _html(PAY_STATUS_LABELS[p.status] || p.status) + '</span>';
                    html += '<span style="color:#cbd5e0;">' + (p.direction === 'payable' ? 'Payable' : 'Refundable') + '</span>';
                    html += '<span style="color:#a0aec0;">Balance: ' + _money(p.balance_outstanding) + '</span>';
                    if (p.due_date) html += '<span style="color:#a0aec0;">Due: ' + _formatDate(p.due_date) + '</span>';
                    html += '</div>';
                });
            }
            var payUrl = '/practice/tax-payments.html'
                + (ps && ps.submission_id ? ('?submission_id=' + encodeURIComponent(ps.submission_id)) : '');
            html += '<a href="' + payUrl + '" style="display:inline-block;margin-top:10px;padding:7px 16px;background:#667eea;color:#fff;border-radius:7px;font-size:.82rem;font-weight:700;text-decoration:none;">Open Payment Register</a>';
            html += '</div>';
        }

        document.getElementById('detailModalBody').innerHTML = html;
    }

    function tplCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
    }

    // ── Stage change modal ─────────────────────────────────────────────────────

    function tplOpenStageChange() {
        if (!_currentDetail) return;
        var d = _currentDetail.detail;
        var allowed = d.allowed_next_stages || [];
        if (!allowed.length) {
            _showToast('No stage changes available from ' + (STAGE_LABELS[d.filing_stage] || d.filing_stage));
            return;
        }

        document.getElementById('stageValidationMsg').style.display = 'none';
        document.getElementById('stageNotes').value = '';
        document.getElementById('stageNotesRequired').style.display = 'none';
        document.getElementById('stageSubmitBtn').disabled = false;

        var select = document.getElementById('stageSelect');
        var opts   = '<option value="">— Select stage —</option>';
        allowed.forEach(function (s) { opts += '<option value="' + _html(s.stage) + '">' + _html(s.label) + '</option>'; });
        select.innerHTML = opts;

        document.getElementById('stageModal').classList.add('open');
    }

    function tplOnStageSelectChange() {
        var val = document.getElementById('stageSelect').value;
        var notesReq = (val === 'cancelled') || (val && _isBackward(_currentDetail.detail.filing_stage, val));
        document.getElementById('stageNotesRequired').style.display = notesReq ? 'inline' : 'none';
    }

    function _isBackward(current, next) {
        var ci = STAGE_ORDER.indexOf(current);
        var ni = STAGE_ORDER.indexOf(next);
        return ci > -1 && ni > -1 && ni < ci;
    }

    function tplCloseStage() {
        document.getElementById('stageModal').classList.remove('open');
    }

    function tplSubmitStage() {
        if (_submitting) return;
        var newStage = document.getElementById('stageSelect').value;
        var notes    = document.getElementById('stageNotes').value.trim();
        if (!newStage) {
            _showValidationMsg('error', 'Please select a stage');
            return;
        }
        var needsNotes = (newStage === 'cancelled') || _isBackward(_currentDetail.detail.filing_stage, newStage);
        if (needsNotes && !notes) {
            _showValidationMsg('error', 'Notes are required for this stage change');
            return;
        }

        _submitting = true;
        document.getElementById('stageSubmitBtn').disabled    = true;
        document.getElementById('stageSubmitBtn').textContent = 'Saving…';
        document.getElementById('stageValidationMsg').style.display = 'none';

        var sourceType = _currentDetail.sourceType;
        var sourceId   = _currentDetail.sourceId;

        PracticeAPI.fetch(
            BASE + '/' + encodeURIComponent(sourceType) + '/' + sourceId + '/stage',
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ new_stage: newStage, notes: notes || null }),
            }
        )
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (r) {
            _submitting = false;
            document.getElementById('stageSubmitBtn').disabled    = false;
            document.getElementById('stageSubmitBtn').textContent = 'Move Stage';
            if (!r.ok) {
                _showValidationMsg('error', r.data.error || 'Stage change failed');
                return;
            }
            _showToast('Stage moved to ' + (STAGE_LABELS[newStage] || newStage));
            tplCloseStage();
            tplCloseDetail();
            tplLoad();
        })
        .catch(function () {
            _submitting = false;
            document.getElementById('stageSubmitBtn').disabled    = false;
            document.getElementById('stageSubmitBtn').textContent = 'Move Stage';
            _showValidationMsg('error', 'Request failed. Try again.');
        });
    }

    function _showValidationMsg(type, msg) {
        var el = document.getElementById('stageValidationMsg');
        el.className   = 'validation-msg ' + type;
        el.textContent = msg;
        el.style.display = 'block';
    }

    // ── Exports ────────────────────────────────────────────────────────────────

    window.tplSetView        = tplSetView;
    window.tplLoad           = tplLoad;
    window.tplApplyFilters   = tplApplyFilters;
    window.tplClearFilters   = tplClearFilters;
    window.tplFilterByStage  = tplFilterByStage;
    window.tplOpenDetail     = tplOpenDetail;
    window.tplCloseDetail    = tplCloseDetail;
    window.tplOpenStageChange = tplOpenStageChange;
    window.tplOnStageSelectChange = tplOnStageSelectChange;
    window.tplCloseStage     = tplCloseStage;
    window.tplSubmitStage    = tplSubmitStage;

    // ── Boot ───────────────────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        if (typeof LAYOUT !== 'undefined') {
            LAYOUT.onReady(function () { tplLoad(); });
        } else {
            tplLoad();
        }
    });

})();
