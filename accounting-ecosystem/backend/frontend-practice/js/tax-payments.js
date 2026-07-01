(function () {
    'use strict';

    // Manual tax payment register (Codebox 42).
    // NOT SARS integration. NOT bank reconciliation. NOT automatic payment importing.

    var BASE = '/api/practice/tax-payments';

    var STATUS_LABELS = {
        outstanding: 'Outstanding', partially_paid: 'Partially Paid', paid_in_full: 'Paid in Full',
        overpaid: 'Overpaid', refund_pending: 'Refund Pending', refund_received: 'Refund Received',
        cancelled: 'Cancelled',
    };
    var METHOD_LABELS = {
        eft: 'EFT', debit_order: 'Debit Order', cash: 'Cash', cheque: 'Cheque',
        sars_efiling: 'SARS eFiling', other: 'Other',
    };
    var EVENT_LABELS = {
        payment_created: 'Case Created', payment_recorded: 'Payment Recorded', refund_recorded: 'Refund Recorded',
        interest_added: 'Interest Added', penalty_added: 'Penalty Added', payment_cancelled: 'Case Cancelled',
    };

    // State
    var _currentId   = null;
    var _currentItem = null;
    var _currentTab  = 'overview';
    var _submitting  = false;
    var _actionType  = null;

    // ── Utilities ──────────────────────────────────────────────────────────────

    function _qs() {
        var p = [];
        var direction = document.getElementById('filterDirection').value;
        var status    = document.getElementById('filterStatus').value;
        var year      = document.getElementById('filterYear').value;
        var subId     = document.getElementById('filterSubmissionId').value;
        if (direction) p.push('direction='     + encodeURIComponent(direction));
        if (status)    p.push('status='        + encodeURIComponent(status));
        if (year)      p.push('tax_year='      + encodeURIComponent(year));
        if (subId)     p.push('submission_id=' + encodeURIComponent(subId));
        return p.length ? ('?' + p.join('&')) : '';
    }

    function _html(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function _fmt(iso) {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' }); } catch(e) { return iso; }
    }

    function _fmtDate(d) {
        if (!d) return '—';
        try {
            var parts = d.split('-');
            return parts[2] + '/' + parts[1] + '/' + parts[0];
        } catch(e) { return d; }
    }

    function _money(v) {
        if (v == null) return '—';
        return 'R ' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits:2, maximumFractionDigits:2 });
    }

    function _directionBadge(dir) {
        if (dir === 'payable')    return '<span class="type-badge type-payable">Payable</span>';
        if (dir === 'refundable') return '<span class="type-badge type-refundable">Refundable</span>';
        return '';
    }

    function _statusPill(s) {
        return '<span class="status-pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>';
    }

    function _showToast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(function () { t.classList.remove('show'); }, 3200);
    }

    function _showMsg(elId, type, msg) {
        var el = document.getElementById(elId);
        el.className = 'inline-msg ' + type;
        el.innerHTML = _html(msg);
        el.style.display = 'block';
    }

    function _hideMsg(elId) { document.getElementById(elId).style.display = 'none'; }

    function _formField(label, inputHtml, full) {
        return '<div class="form-group' + (full ? '" style="grid-column:1/-1' : '') + '">' +
            '<label class="form-label">' + label + '</label>' + inputHtml + '</div>';
    }

    // ── Boot ───────────────────────────────────────────────────────────────────

    function tprLoad() {
        _loadSummary();
        _loadList();
        _checkUrlParams();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var subId = params.get('submission_id');
        if (subId) {
            document.getElementById('filterSubmissionId').value = subId;
            tprApplyFilters();
        }
    }

    // ── Summary ────────────────────────────────────────────────────────────────

    function _loadSummary() {
        PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {
                document.getElementById('summaryGrid').innerHTML = '<span style="color:#fc8181;font-size:.8rem">Summary unavailable</span>';
            });
    }

    function _renderSummary(d) {
        var byStatus = d.by_status || {};
        var highlight = {
            outstanding:    'c-alert',
            partially_paid: 'c-warn',
            refund_pending: 'c-info',
            paid_in_full:   'c-ok',
            refund_received:'c-ok',
        };
        var html = '';
        Object.keys(STATUS_LABELS).forEach(function (s) {
            var count = byStatus[s] || 0;
            if (count === 0 && !['outstanding','partially_paid','refund_pending'].includes(s)) return;
            html += '<div class="sum-card" onclick="tprFilterByStatus(\'' + s + '\')">';
            html += '<div class="sum-card-count ' + (highlight[s] || '') + '">' + count + '</div>';
            html += '<div class="sum-card-label">' + _html(STATUS_LABELS[s]) + '</div>';
            html += '</div>';
        });
        html += '<div class="sum-card">';
        html += '<div class="sum-card-count c-alert">' + _money(d.total_outstanding_payable) + '</div>';
        html += '<div class="sum-card-label">Outstanding Payable</div>';
        html += '</div>';
        html += '<div class="sum-card">';
        html += '<div class="sum-card-count c-info">' + _money(d.total_pending_refund) + '</div>';
        html += '<div class="sum-card-label">Pending Refund</div>';
        html += '</div>';
        if (d.overdue_count) {
            html += '<div class="sum-card">';
            html += '<div class="sum-card-count c-alert">' + d.overdue_count + '</div>';
            html += '<div class="sum-card-label">Overdue</div>';
            html += '</div>';
        }
        document.getElementById('summaryGrid').innerHTML = html || '<span style="color:#718096;font-size:.8rem">No payment cases yet</span>';
    }

    // ── List ───────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="9"><div class="loading-state">Loading…</div></td></tr>';
        PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.payments || []); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr><td colspan="9" style="color:#fc8181;text-align:center;padding:20px">Failed to load</td></tr>';
            });
    }

    function _renderList(items) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">💰</div>No payment cases found</div></td></tr>';
            return;
        }
        var html = '';
        items.forEach(function (p) {
            html += '<tr onclick="tprOpenDetail(' + p.id + ')">';
            html += '<td>' + _directionBadge(p.direction) + '</td>';
            html += '<td>' + (p.tax_year || '—') + '</td>';
            html += '<td>' + _statusPill(p.status) + '</td>';
            html += '<td style="font-family:monospace;font-size:.78rem">' + _money(p.original_amount) + '</td>';
            html += '<td style="font-family:monospace;font-size:.78rem">' + _money(p.interest_accrued) + '</td>';
            html += '<td style="font-family:monospace;font-size:.78rem">' + _money(p.penalty_accrued) + '</td>';
            html += '<td style="font-family:monospace;font-size:.78rem">' + _money(p.amount_settled) + '</td>';
            html += '<td style="font-family:monospace;font-size:.78rem;font-weight:700">' + _money(p.balance_outstanding) + '</td>';
            html += '<td style="font-size:.78rem">' + _fmtDate(p.due_date) + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    // ── Filters ────────────────────────────────────────────────────────────────

    function tprApplyFilters() { _loadList(); }
    function tprClearFilters() {
        ['filterDirection','filterStatus'].forEach(function (id) { document.getElementById(id).value = ''; });
        document.getElementById('filterYear').value = '';
        document.getElementById('filterSubmissionId').value = '';
        _loadList();
    }
    function tprFilterByStatus(s) {
        document.getElementById('filterStatus').value = s;
        tprApplyFilters();
    }

    // ── Create modal ───────────────────────────────────────────────────────────

    function tprOpenCreate() {
        _hideMsg('createMsg');
        document.getElementById('createSubmissionId').value = document.getElementById('filterSubmissionId').value || '';
        document.getElementById('createDirection').value    = '';
        document.getElementById('createAmount').value       = '';
        document.getElementById('createDueDate').value      = '';
        document.getElementById('createNotes').value        = '';
        document.getElementById('createSubmitBtn').disabled    = false;
        document.getElementById('createSubmitBtn').textContent = 'Create';
        document.getElementById('createModal').classList.add('open');
    }
    function tprCloseCreate() { document.getElementById('createModal').classList.remove('open'); }

    function tprSubmitCreate() {
        if (_submitting) return;
        _hideMsg('createMsg');

        var submissionId = document.getElementById('createSubmissionId').value;
        var direction     = document.getElementById('createDirection').value;
        var amount        = document.getElementById('createAmount').value;
        var dueDate        = document.getElementById('createDueDate').value;
        var notes          = document.getElementById('createNotes').value.trim();

        if (!submissionId) return _showMsg('createMsg','error','Submission ID is required');
        if (!direction)    return _showMsg('createMsg','error','Direction is required');
        if (!amount || Number(amount) <= 0) return _showMsg('createMsg','error','Original amount must be a positive number');

        _submitting = true;
        var btn = document.getElementById('createSubmitBtn');
        btn.disabled = true;
        btn.textContent = 'Creating…';

        PracticeAPI.fetch(BASE, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                submission_id:    Number(submissionId),
                direction:        direction,
                original_amount:  Number(amount),
                due_date:         dueDate || null,
                notes:            notes || null,
            }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            btn.disabled = false;
            btn.textContent = 'Create';
            if (!r.ok) return _showMsg('createMsg','error', r.data.error || 'Failed to create payment case');
            _showToast('Payment case created');
            tprCloseCreate();
            _loadSummary();
            _loadList();
        })
        .catch(function () {
            _submitting = false;
            btn.disabled = false;
            btn.textContent = 'Create';
            _showMsg('createMsg','error','Request failed. Try again.');
        });
    }

    // ── Detail modal ───────────────────────────────────────────────────────────

    function tprOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'overview';
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailModal').classList.add('open');

        PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentItem = d;
                document.getElementById('detailTitle').textContent =
                    (d.direction === 'payable' ? 'Payable' : 'Refundable') + ' Payment Case #' + d.id;
                _renderTabBar(d);
                _renderFooter(d);
                _activateTab('overview');
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div class="tab-content" style="color:#fc8181">Failed to load payment case</div>';
            });
    }
    function tprCloseDetail() { document.getElementById('detailModal').classList.remove('open'); }

    function _renderTabBar(d) {
        var tabs = [
            { key:'overview', label:'Overview' },
            { key:'events',   label:'Events'   },
        ];
        var html = '';
        tabs.forEach(function (t) {
            html += '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="tprOpenTab(\'' + t.key + '\')">' + t.label + '</button>';
        });
        document.getElementById('detailTabBar').innerHTML = html;
    }

    function tprOpenTab(tab) {
        _currentTab = tab;
        _renderTabBar(_currentItem);
        _activateTab(tab);
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        if (tab === 'overview') _renderOverviewTab(_currentItem, body);
        else if (tab === 'events') _loadEventsTab(body);
    }

    function _renderOverviewTab(d, body) {
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += '<div class="detail-field"><div class="detail-label">Direction</div><div class="detail-value">' + _directionBadge(d.direction) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Status</div><div class="detail-value">' + _statusPill(d.status) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Tax Year</div><div class="detail-value">' + (d.tax_year || '—') + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Due Date</div><div class="detail-value">' + _fmtDate(d.due_date) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Original Amount</div><div class="detail-value amount">' + _money(d.original_amount) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Interest Accrued</div><div class="detail-value amount">' + _money(d.interest_accrued) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Penalty Accrued</div><div class="detail-value amount">' + _money(d.penalty_accrued) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Amount Settled</div><div class="detail-value amount">' + _money(d.amount_settled) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Balance Outstanding</div><div class="detail-value amount">' + _money(d.balance_outstanding) + '</div></div>';
        html += '<div class="detail-field"><div class="detail-label">Submission ID</div><div class="detail-value">#' + d.submission_id + '</div></div>';
        html += '</div>';
        if (d.notes) html += '<div class="detail-field" style="margin-bottom:10px"><div class="detail-label">Notes</div><div class="detail-value" style="font-weight:400">' + _html(d.notes) + '</div></div>';
        if (d.internal_notes) html += '<div class="detail-field" style="margin-bottom:10px"><div class="detail-label">Internal Notes</div><div class="detail-value" style="font-weight:400">' + _html(d.internal_notes) + '</div></div>';
        html += '</div>';
        body.innerHTML = html;
    }

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        PracticeAPI.fetch(BASE + '/' + _currentId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTab(d.events || [], body); })
            .catch(function () { body.innerHTML = '<div class="tab-content" style="color:#fc8181">Failed to load events</div>'; });
    }

    function _renderEventsTab(items, body) {
        var html = '<div class="tab-content">';
        if (!items.length) {
            html += '<div class="inline-msg info">No events recorded yet.</div>';
        } else {
            items.forEach(function (ev) {
                html += '<div class="evidence-item">';
                html += '<div class="evidence-item-header">';
                html += '<span class="evidence-title">' + _html(EVENT_LABELS[ev.event_type] || ev.event_type) + '</span>';
                if (ev.amount != null) html += '<span class="subtype-badge">' + _money(ev.amount) + '</span>';
                html += '</div>';
                var metaParts = [_fmt(ev.created_at)];
                if (ev.payment_date)   metaParts.push('Payment date: ' + _fmtDate(ev.payment_date));
                if (ev.payment_method) metaParts.push(METHOD_LABELS[ev.payment_method] || ev.payment_method);
                if (ev.reference)      metaParts.push('Ref: ' + ev.reference);
                html += '<div class="evidence-meta">' + metaParts.map(_html).join(' · ') + '</div>';
                if (ev.balance_before != null && ev.balance_after != null) {
                    html += '<div class="evidence-meta">Balance: ' + _money(ev.balance_before) + ' → ' + _money(ev.balance_after) + '</div>';
                }
                if (ev.notes) html += '<div class="evidence-meta">"' + _html(ev.notes) + '"</div>';
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _renderFooter(d) {
        var html = '<button type="button" class="btn-action btn-secondary" onclick="tprCloseDetail()">Close</button>';
        if (d.status !== 'cancelled') {
            if (d.direction === 'payable') {
                html += '<button type="button" class="btn-action btn-success" onclick="tprOpenAction(\'record-payment\')">Record Payment</button>';
                html += '<button type="button" class="btn-action btn-warning" onclick="tprOpenAction(\'add-interest\')">Add Interest</button>';
                html += '<button type="button" class="btn-action btn-warning" onclick="tprOpenAction(\'add-penalty\')">Add Penalty</button>';
            } else {
                html += '<button type="button" class="btn-action btn-success" onclick="tprOpenAction(\'record-refund\')">Record Refund</button>';
            }
            html += '<button type="button" class="btn-action btn-secondary" onclick="tprOpenAction(\'edit\')">Edit</button>';
            if (Number(d.amount_settled) === 0) {
                html += '<button type="button" class="btn-action btn-danger" onclick="tprCancelCase()">Cancel Case</button>';
            }
        }
        // SARS Recon link — opens the recon page pre-filtered to this payment case
        var reconUrl = '/practice/sars-recon.html?payment_id=' + encodeURIComponent(d.id) + '&client_id=' + encodeURIComponent(d.client_id);
        html += '<a href="' + reconUrl + '" style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d3748;color:#e2e8f0;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;gap:6px;" title="Open SARS Statement Reconciliation filtered to this payment case">SARS Recon ↗</a>';
        document.getElementById('detailFooter').innerHTML = html;
    }

    // ── Action modal (ledger movements + edit) ────────────────────────────────

    function tprOpenAction(type) {
        _actionType = type;
        _hideMsg('actionMsg');
        document.getElementById('actionSubmitBtn').disabled    = false;
        document.getElementById('actionSubmitBtn').textContent = 'Save';

        var titles = {
            'record-payment': 'Record Payment',
            'record-refund':  'Record Refund',
            'add-interest':   'Add Interest',
            'add-penalty':    'Add Penalty',
            'edit':           'Edit Payment Case',
        };
        document.getElementById('actionModalTitle').textContent = titles[type] || type;
        document.getElementById('actionFormBody').innerHTML     = _buildActionForm(type);
        document.getElementById('actionModal').classList.add('open');
    }

    function _buildActionForm(type) {
        if (type === 'record-payment' || type === 'record-refund') {
            return '<div class="form-grid">' +
                _formField('Amount *', '<input type="number" step="0.01" class="form-input" id="af_amount" placeholder="0.00">') +
                _formField('Payment Date *', '<input type="date" class="form-input" id="af_date">') +
                _formField('Method', '<select class="form-select" id="af_method"><option value="">— Select —</option><option value="eft">EFT</option><option value="debit_order">Debit Order</option><option value="cash">Cash</option><option value="cheque">Cheque</option><option value="sars_efiling">SARS eFiling</option><option value="other">Other</option></select>') +
                _formField('Reference', '<input class="form-input" id="af_ref" placeholder="Bank reference / proof of payment ref">') +
                _formField('Notes', '<textarea class="form-textarea" id="af_notes" rows="2"></textarea>', true) +
                '</div>';
        }
        if (type === 'add-interest' || type === 'add-penalty') {
            return '<div class="form-grid">' +
                _formField('Amount *', '<input type="number" step="0.01" class="form-input" id="af_amount" placeholder="0.00">') +
                _formField('Reference', '<input class="form-input" id="af_ref" placeholder="SARS statement reference">') +
                _formField('Notes', '<textarea class="form-textarea" id="af_notes" rows="2"></textarea>', true) +
                '</div>';
        }
        if (type === 'edit') {
            var d = _currentItem || {};
            return '<div class="form-grid">' +
                _formField('Due Date', '<input type="date" class="form-input" id="af_due_date" value="' + (d.due_date || '') + '">') +
                _formField('Notes', '<textarea class="form-textarea" id="af_notes_edit" rows="2">' + _html(d.notes || '') + '</textarea>', true) +
                _formField('Internal Notes', '<textarea class="form-textarea" id="af_internal_notes" rows="2">' + _html(d.internal_notes || '') + '</textarea>', true) +
                '</div>';
        }
        return '<div style="color:#718096">Unknown action</div>';
    }

    function tprCloseAction() { document.getElementById('actionModal').classList.remove('open'); }

    function tprSubmitAction() {
        if (_submitting) return;
        _hideMsg('actionMsg');
        var payload = _buildPayload(_actionType);
        if (!payload) return;

        var urlMap = {
            'record-payment': BASE + '/' + _currentId + '/record-payment',
            'record-refund':  BASE + '/' + _currentId + '/record-refund',
            'add-interest':   BASE + '/' + _currentId + '/add-interest',
            'add-penalty':    BASE + '/' + _currentId + '/add-penalty',
            'edit':           BASE + '/' + _currentId,
        };
        var url = urlMap[_actionType];
        if (!url) return;

        _submitting = true;
        var btn = document.getElementById('actionSubmitBtn');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        PracticeAPI.fetch(url, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            btn.disabled    = false;
            btn.textContent = 'Save';
            if (!r.ok) return _showMsg('actionMsg','error', r.data.error || 'Action failed');
            _showToast('Saved successfully');
            tprCloseAction();
            tprOpenDetail(_currentId);
            _loadSummary();
            _loadList();
        })
        .catch(function () {
            _submitting = false;
            btn.disabled    = false;
            btn.textContent = 'Save';
            _showMsg('actionMsg','error','Request failed. Try again.');
        });
    }

    function _buildPayload(type) {
        function _val(id) { var el = document.getElementById(id); return el ? el.value.trim() : null; }

        if (type === 'record-payment' || type === 'record-refund') {
            var amount = _val('af_amount');
            var date   = _val('af_date');
            if (!amount || Number(amount) <= 0) return _showMsg('actionMsg','error','Amount must be a positive number') && null;
            if (!date) return _showMsg('actionMsg','error','Payment date is required') && null;
            return { amount: Number(amount), payment_date: date, payment_method: _val('af_method') || null, reference: _val('af_ref') || null, notes: _val('af_notes') || null };
        }
        if (type === 'add-interest' || type === 'add-penalty') {
            var amt = _val('af_amount');
            if (!amt || Number(amt) <= 0) return _showMsg('actionMsg','error','Amount must be a positive number') && null;
            return { amount: Number(amt), reference: _val('af_ref') || null, notes: _val('af_notes') || null };
        }
        if (type === 'edit') {
            return { due_date: _val('af_due_date') || null, notes: _val('af_notes_edit') || null, internal_notes: _val('af_internal_notes') || null };
        }
        return null;
    }

    // ── Cancel ─────────────────────────────────────────────────────────────────

    function tprCancelCase() {
        if (_submitting) return;
        if (!window.confirm('Cancel this payment case? This cannot be undone.')) return;
        _submitting = true;

        PracticeAPI.fetch(BASE + '/' + _currentId, { method: 'DELETE' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                _submitting = false;
                if (!r.ok) return _showToast(r.data.error || 'Cancel failed');
                _showToast('Payment case cancelled');
                tprOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    // ── Exports ────────────────────────────────────────────────────────────────

    window.tprLoad            = tprLoad;
    window.tprApplyFilters    = tprApplyFilters;
    window.tprClearFilters    = tprClearFilters;
    window.tprFilterByStatus  = tprFilterByStatus;
    window.tprOpenCreate      = tprOpenCreate;
    window.tprCloseCreate     = tprCloseCreate;
    window.tprSubmitCreate    = tprSubmitCreate;
    window.tprOpenDetail      = tprOpenDetail;
    window.tprCloseDetail     = tprCloseDetail;
    window.tprOpenTab         = tprOpenTab;
    window.tprOpenAction      = tprOpenAction;
    window.tprCloseAction     = tprCloseAction;
    window.tprSubmitAction    = tprSubmitAction;
    window.tprCancelCase      = tprCancelCase;

    // ── Boot ───────────────────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        if (typeof LAYOUT !== 'undefined') {
            LAYOUT.onReady(function () { tprLoad(); });
        } else {
            tprLoad();
        }
    });

})();
