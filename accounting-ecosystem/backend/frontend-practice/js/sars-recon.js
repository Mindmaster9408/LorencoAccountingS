(function () {
    'use strict';

    // Codebox 43 — SARS Statement Reconciliation
    // Manual statement-line capture and reconciliation against the Tax Payment Register.
    // NOT SARS API. NOT bank feed. NOT automatic import.

    var BASE = '/api/practice/sars-recon';

    var STATUS_LABELS = {
        unmatched:         'Unmatched',
        matched:           'Matched',
        partially_matched: 'Partially Matched',
        disputed:          'Disputed',
        ignored:           'Ignored',
        cancelled:         'Cancelled',
    };
    var TX_LABELS = {
        assessment: 'Assessment', payment: 'Payment', refund: 'Refund',
        interest: 'Interest', penalty: 'Penalty', adjustment: 'Adjustment',
        balance: 'Balance', other: 'Other',
    };
    var TAX_LABELS = {
        itr12: 'ITR12', itr14: 'ITR14', irp6: 'IRP6',
        emp201: 'EMP201', emp501: 'EMP501', vat201: 'VAT201', other: 'Other',
    };
    var EVENT_LABELS = {
        payment_recorded: 'Payment Recorded', refund_recorded: 'Refund Received',
    };

    var _currentId   = null;
    var _currentLine = null;
    var _currentTab  = 'overview';
    var _submitting  = false;
    var _actionType  = null;

    // ── Utilities ──────────────────────────────────────────────────────────────

    function _qs() {
        var p = [];
        var tt   = document.getElementById('filterTaxType').value;
        var txn  = document.getElementById('filterTransactionType').value;
        var st   = document.getElementById('filterStatus').value;
        var df   = document.getElementById('filterDateFrom').value;
        var dt   = document.getElementById('filterDateTo').value;
        var srch = document.getElementById('filterSearch').value.trim();
        var cid  = document.getElementById('filterClientId').value;
        var subId= document.getElementById('filterSubmissionId').value;
        if (tt)   p.push('tax_type='        + encodeURIComponent(tt));
        if (txn)  p.push('transaction_type='+ encodeURIComponent(txn));
        if (st)   p.push('status='          + encodeURIComponent(st));
        if (df)   p.push('date_from='       + encodeURIComponent(df));
        if (dt)   p.push('date_to='         + encodeURIComponent(dt));
        if (srch) p.push('search='          + encodeURIComponent(srch));
        if (cid)  p.push('client_id='       + encodeURIComponent(cid));
        if (subId)p.push('submission_id='   + encodeURIComponent(subId));
        return p.length ? ('?' + p.join('&')) : '';
    }

    function _html(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _fmtDate(d) {
        if (!d) return '—';
        try { var p = d.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; } catch(e) { return d; }
    }

    function _fmt(iso) {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
        catch(e) { return iso; }
    }

    function _money(v) {
        if (v == null) return '—';
        return 'R ' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits:2, maximumFractionDigits:2 });
    }

    function _statusPill(s) {
        return '<span class="status-pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>';
    }

    function _txBadge(t) {
        return '<span class="type-badge tt-' + _html(t) + '">' + _html(TX_LABELS[t] || t) + '</span>';
    }

    function _taxBadge(t) {
        return '<span class="tax-badge">' + _html(TAX_LABELS[t] || t) + '</span>';
    }

    function _showToast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(function () { t.classList.remove('show'); }, 3200);
    }

    function _showMsg(elId, type, msg) {
        var el = document.getElementById(elId);
        if (el) el.innerHTML = '<div class="inline-msg ' + type + '">' + _html(msg) + '</div>';
    }

    function _hideMsg(elId) {
        var el = document.getElementById(elId);
        if (el) el.innerHTML = '';
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    function srLoad() {
        _loadSummary();
        _loadList();
        _checkUrlParams();
        srLoadUnmatched();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var subId = params.get('submission_id');
        var payId = params.get('payment_id');
        var cid   = params.get('client_id');
        if (subId) { document.getElementById('filterSubmissionId').value = subId; }
        if (cid)   { document.getElementById('filterClientId').value = cid; }
        if (subId || payId || cid) { srApplyFilters(); }
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {
                document.getElementById('summaryGrid').innerHTML = '<div style="color:#fc8181;font-size:.82rem;">Failed to load summary</div>';
            });
    }

    function _renderSummary(d) {
        var cards = [
            { label: 'Unmatched Lines', value: d.unmatched_line_count || 0, cls: d.unmatched_line_count > 0 ? 'sc-warn' : '', filter: 'unmatched' },
            { label: 'Matched Lines',   value: (d.by_status && d.by_status.matched) || 0, cls: 'sc-good', filter: 'matched' },
            { label: 'Disputed',        value: d.disputed_line_count || 0, cls: d.disputed_line_count > 0 ? 'sc-alert' : '', filter: 'disputed' },
            { label: 'Ignored',         value: (d.by_status && d.by_status.ignored) || 0, cls: '', filter: 'ignored' },
            { label: 'Total Lines',     value: d.total_lines || 0, cls: '', filter: '' },
            { label: 'Unmatched Events', value: d.unmatched_event_count || 0, cls: d.unmatched_event_count > 0 ? 'sc-warn' : '', filter: '' },
        ];

        document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
            var click = c.filter ? ' onclick="srFilterByStatus(\'' + c.filter + '\')"' : '';
            return '<div class="summary-card ' + c.cls + '"' + click + '>' +
                '<div class="sc-label">' + _html(c.label) + '</div>' +
                '<div class="sc-value">' + c.value + '</div>' +
                '</div>';
        }).join('');

        // Variance strip
        var strip = document.getElementById('varianceStrip');
        strip.style.display = 'flex';
        var variance = Number(d.variance) || 0;
        document.getElementById('vsTotalDebits').textContent   = _money(d.total_sars_debits);
        document.getElementById('vsTotalCredits').textContent  = _money(d.total_sars_credits);
        document.getElementById('vsUnmatchedLines').textContent = d.unmatched_line_count || 0;
        document.getElementById('vsUnmatchedEvents').textContent = d.unmatched_event_count || 0;
        var varEl = document.getElementById('vsVariance');
        varEl.textContent = _money(variance);
        varEl.className   = 'vs-value ' + (variance < 0 ? 'negative' : variance > 0 ? 'positive' : '');
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="11">Loading…</td></tr>';
        PracticeAPI.fetch(BASE + '/lines' + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.lines || []); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="11" style="color:#fc8181;">Failed to load statement lines</td></tr>';
            });
    }

    function _renderList(items) {
        if (!items.length) {
            document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="11">No statement lines found. Add one to start reconciling.</td></tr>';
            return;
        }
        document.getElementById('tableBody').innerHTML = items.map(function (l) {
            return '<tr onclick="srOpenDetail(' + l.id + ')">' +
                '<td>' + _fmtDate(l.statement_date) + '</td>' +
                '<td>' + _html(l.client_name || ('#' + l.client_id)) + '</td>' +
                '<td>' + _taxBadge(l.tax_type) + '</td>' +
                '<td>' + _txBadge(l.transaction_type) + '</td>' +
                '<td style="font-size:.78rem;color:#a0aec0;">' + _html(l.reference_number || '—') + '</td>' +
                '<td class="td-desc" title="' + _html(l.description || '') + '">' + _html(l.description || '—') + '</td>' +
                '<td style="color:#fc8181;">' + (Number(l.debit_amount) > 0 ? _money(l.debit_amount) : '—') + '</td>' +
                '<td style="color:#68d391;">' + (Number(l.credit_amount) > 0 ? _money(l.credit_amount) : '—') + '</td>' +
                '<td>' + (l.running_balance != null ? _money(l.running_balance) : '—') + '</td>' +
                '<td>' + _statusPill(l.reconciliation_status) + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + (l.matched_payment_event_id ? '#' + l.matched_payment_event_id : '—') + '</td>' +
                '</tr>';
        }).join('');
    }

    function srApplyFilters()  { _loadList(); }
    function srClearFilters()  {
        ['filterTaxType','filterTransactionType','filterStatus','filterDateFrom','filterDateTo',
         'filterSearch','filterClientId','filterSubmissionId'].forEach(function (id) {
            document.getElementById(id).value = '';
        });
        _loadList();
    }
    function srFilterByStatus(s) {
        document.getElementById('filterStatus').value = s;
        srApplyFilters();
    }

    // ── Unmatched payment events panel ────────────────────────────────────────

    function srLoadUnmatched() {
        document.getElementById('unmatchedPanel').innerHTML = '<div class="loading-state">Loading…</div>';
        PracticeAPI.fetch(BASE + '/payment-events/unmatched')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderUnmatched(d.events || []); })
            .catch(function () {
                document.getElementById('unmatchedPanel').innerHTML = '<div style="color:#fc8181;font-size:.82rem;">Failed to load</div>';
            });
    }

    function _renderUnmatched(items) {
        if (!items.length) {
            document.getElementById('unmatchedPanel').innerHTML = '<div class="inline-msg info">All practice payment events have been matched to a SARS statement line.</div>';
            return;
        }
        document.getElementById('unmatchedPanel').innerHTML = items.map(function (e) {
            return '<div class="event-card">' +
                '<span class="ec-type">' + _html(EVENT_LABELS[e.event_type] || e.event_type) + '</span>' +
                '<span class="ec-amount">' + _money(e.amount) + '</span>' +
                '<span class="ec-date">' + _fmtDate(e.payment_date) + '</span>' +
                '<span class="ec-ref">' + _html(e.reference || e.payment_method || '—') + '</span>' +
                '<span style="font-size:.72rem;color:#718096;">Event #' + e.id + ' / Case #' + e.payment_id + '</span>' +
                '</div>';
        }).join('');
    }

    // ── Create modal ──────────────────────────────────────────────────────────

    function srOpenCreate() {
        // Pre-fill from URL params if available
        var params = new URLSearchParams(window.location.search);
        var subId = params.get('submission_id') || document.getElementById('filterSubmissionId').value;
        var cid   = params.get('client_id')     || document.getElementById('filterClientId').value;
        if (subId) document.getElementById('createSubmissionId').value = subId;
        if (cid)   document.getElementById('createClientId').value = cid;
        _hideMsg('createMsg');
        document.getElementById('createModal').classList.add('active');
    }

    function srCloseCreate() {
        document.getElementById('createModal').classList.remove('active');
        _hideMsg('createMsg');
    }

    function srSubmitCreate() {
        if (_submitting) return;
        var clientId  = document.getElementById('createClientId').value;
        var date      = document.getElementById('createDate').value;
        var taxType   = document.getElementById('createTaxType').value;
        var transType = document.getElementById('createTransType').value;

        if (!clientId)  return _showMsg('createMsg', 'error', 'Client ID is required');
        if (!date)      return _showMsg('createMsg', 'error', 'Statement date is required');
        if (!taxType)   return _showMsg('createMsg', 'error', 'Tax type is required');
        if (!transType) return _showMsg('createMsg', 'error', 'Transaction type is required');

        var debit  = parseFloat(document.getElementById('createDebit').value || '0') || 0;
        var credit = parseFloat(document.getElementById('createCredit').value || '0') || 0;
        if (debit < 0 || credit < 0) return _showMsg('createMsg', 'error', 'Amounts must be zero or positive');

        var bal = document.getElementById('createBalance').value;
        var subId = document.getElementById('createSubmissionId').value;
        var payId = document.getElementById('createPaymentId').value;

        var payload = {
            client_id:        Number(clientId),
            statement_date:   date,
            tax_type:         taxType,
            transaction_type: transType,
            tax_year:         document.getElementById('createTaxYear').value ? Number(document.getElementById('createTaxYear').value) : null,
            period_label:     document.getElementById('createPeriodLabel').value || null,
            reference_number: document.getElementById('createRef').value || null,
            description:      document.getElementById('createDesc').value || null,
            debit_amount:     debit,
            credit_amount:    credit,
            running_balance:  bal !== '' ? parseFloat(bal) : null,
            submission_id:    subId ? Number(subId) : null,
            payment_id:       payId ? Number(payId) : null,
            notes:            document.getElementById('createNotes').value || null,
        };

        _submitting = true;
        PracticeAPI.fetch(BASE + '/lines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showMsg('createMsg', 'error', r.data.error || 'Failed to create statement line');
            srCloseCreate();
            _showToast('Statement line added');
            _loadSummary();
            _loadList();
        })
        .catch(function () { _submitting = false; _showMsg('createMsg', 'error', 'Request failed'); });
    }

    // ── Detail modal ──────────────────────────────────────────────────────────

    function srOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('active');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        PracticeAPI.fetch(BASE + '/lines/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentLine = d.line || d;
                document.getElementById('detailTitle').textContent = 'Statement Line #' + id;
                _renderTabBar();
                _activateTab('overview');
                _renderFooter(_currentLine);
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div class="inline-msg error">Failed to load statement line</div>';
            });
    }

    function srCloseDetail() {
        document.getElementById('detailModal').classList.remove('active');
        _currentId = null; _currentLine = null;
    }

    function _renderTabBar() {
        var tabs = [{ key: 'overview', label: 'Overview' }, { key: 'events', label: 'Events' }];
        document.getElementById('detailTabBar').innerHTML = '<div class="tab-bar">' +
            tabs.map(function (t) {
                return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') +
                    '" onclick="srOpenTab(\'' + t.key + '\')">' + t.label + '</button>';
            }).join('') + '</div>';
    }

    function srOpenTab(tab) {
        _currentTab = tab;
        _renderTabBar();
        _activateTab(tab);
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        if (tab === 'overview') _renderOverviewTab(_currentLine, body);
        else if (tab === 'events') _loadEventsTab(body);
    }

    function _renderOverviewTab(d, body) {
        var html = '<div class="detail-grid">';
        html += '<div class="detail-row"><div class="detail-label">Status</div><div class="detail-value">' + _statusPill(d.reconciliation_status) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Transaction Type</div><div class="detail-value">' + _txBadge(d.transaction_type) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Tax Type</div><div class="detail-value">' + _taxBadge(d.tax_type) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Statement Date</div><div class="detail-value">' + _html(_fmtDate(d.statement_date)) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Tax Year</div><div class="detail-value">' + _html(d.tax_year || '—') + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Period Label</div><div class="detail-value">' + _html(d.period_label || '—') + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Reference</div><div class="detail-value">' + _html(d.reference_number || '—') + '</div></div>';
        html += '<div class="detail-row detail-full"><div class="detail-label">Description</div><div class="detail-value">' + _html(d.description || '—') + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Debit Amount</div><div class="detail-value" style="color:#fc8181;">' + _money(d.debit_amount) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Credit Amount</div><div class="detail-value" style="color:#68d391;">' + _money(d.credit_amount) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Running Balance</div><div class="detail-value">' + (d.running_balance != null ? _money(d.running_balance) : '—') + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Client</div><div class="detail-value">' + _html(d.client_name || ('#' + d.client_id)) + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Submission ID</div><div class="detail-value">' + _html(d.submission_id || '—') + '</div></div>';
        html += '<div class="detail-row"><div class="detail-label">Payment Case ID</div><div class="detail-value">' + _html(d.payment_id || '—') + '</div></div>';
        if (d.matched_payment_event_id) {
            html += '<div class="detail-row"><div class="detail-label">Matched Event</div><div class="detail-value" style="color:#68d391;">#' + _html(d.matched_payment_event_id) + '</div></div>';
            html += '<div class="detail-row"><div class="detail-label">Matched At</div><div class="detail-value">' + _html(_fmt(d.matched_at)) + '</div></div>';
        }
        if (d.notes) html += '<div class="detail-row detail-full"><div class="detail-label">Notes</div><div class="detail-value">' + _html(d.notes) + '</div></div>';
        html += '</div>';
        body.innerHTML = html;
    }

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        PracticeAPI.fetch(BASE + '/lines/' + _currentId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTab(d.events || [], body); })
            .catch(function () { body.innerHTML = '<div class="inline-msg error">Failed to load events</div>'; });
    }

    function _renderEventsTab(items, body) {
        if (!items.length) {
            body.innerHTML = '<div class="inline-msg info">No events yet.</div>';
            return;
        }
        body.innerHTML = items.map(function (e) {
            var label = e.event_type.replace(/sars_statement_line_/,'').replace(/_/g,' ');
            label = label.charAt(0).toUpperCase() + label.slice(1);
            return '<div class="evidence-item">' +
                '<div class="evidence-item-header">' +
                '<span class="evidence-title">' + _html(label) + '</span>' +
                (e.new_status ? '<span class="status-pill st-' + _html(e.new_status) + '">' + _html(STATUS_LABELS[e.new_status] || e.new_status) + '</span>' : '') +
                '</div>' +
                '<div class="evidence-meta">' + _html(_fmt(e.created_at)) + (e.old_status ? ' · ' + _html(STATUS_LABELS[e.old_status] || e.old_status) + ' → ' + _html(STATUS_LABELS[e.new_status] || e.new_status) : '') + '</div>' +
                (e.notes ? '<div class="evidence-meta" style="color:#a0aec0;margin-top:3px;">' + _html(e.notes) + '</div>' : '') +
                '</div>';
        }).join('');
    }

    function _renderFooter(d) {
        var footer = document.getElementById('detailFooter');
        if (!footer) return;
        if (d.reconciliation_status === 'cancelled') { footer.innerHTML = '<span style="color:#4a5568;font-size:.82rem;">Cancelled — no further actions available.</span>'; return; }

        var html = '';
        var status = d.reconciliation_status;

        if (status !== 'matched') {
            html += '<button type="button" class="btn-action btn-primary btn-sm" onclick="srOpenMatch()">Match to Event</button> ';
        }
        if (status === 'matched' || status === 'partially_matched') {
            html += '<button type="button" class="btn-action btn-neutral btn-sm" onclick="srOpenAction(\'unmatch\')">Unmatch</button> ';
        }
        if (status !== 'disputed' && status !== 'cancelled') {
            html += '<button type="button" class="btn-action btn-warning btn-sm" onclick="srOpenAction(\'dispute\')">Dispute</button> ';
        }
        if (status !== 'ignored' && status !== 'matched' && status !== 'cancelled') {
            html += '<button type="button" class="btn-action btn-neutral btn-sm" onclick="srOpenAction(\'ignore\')">Ignore</button> ';
        }
        html += '<button type="button" class="btn-action btn-neutral btn-sm" onclick="srOpenAction(\'edit\')">Edit</button> ';
        if (status !== 'matched') {
            html += '<button type="button" class="btn-action btn-danger btn-sm" onclick="srCancelLine()">Cancel Line</button>';
        }
        // Codebox 44 — Dispute Case integration
        html += ' <button type="button" class="btn-action btn-neutral btn-sm" onclick="srCreateDisputeFromLine()" title="Create a dispute case from this SARS statement line">+ Dispute Case</button>';
        html += ' <a href="/practice/tax-disputes.html?source_type=sars_statement_line&source_id=' + encodeURIComponent(d.id) + '" ' +
            'style="display:inline-flex;align-items:center;padding:5px 11px;background:#2d3748;color:#e2e8f0;border-radius:7px;font-size:.78rem;font-weight:700;text-decoration:none;" ' +
            'title="View dispute cases linked to this statement line">Open Disputes ↗</a>';
        footer.innerHTML = html;
    }

    function srCreateDisputeFromLine() {
        if (!_currentLine) return;
        var d = _currentLine;
        PracticeAPI.fetch('/api/practice/tax-disputes/create-from-sars-line', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                statement_line_id: d.id,
                case_type:         'objection',
            }),
        })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
        .then(function (r) {
            if (!r.ok) {
                if (r.status === 409) {
                    if (window.confirm('Active dispute case already exists (ID #' + r.data.existing_case_id + '). Open it?')) {
                        window.location.href = '/practice/tax-disputes.html?source_type=sars_statement_line&source_id=' + encodeURIComponent(d.id);
                    }
                } else {
                    var el = document.getElementById('detailFooter');
                    if (el) el.insertAdjacentHTML('beforeend', '<div style="color:#fc8181;font-size:.78rem;margin-top:6px;">' + (r.data.error || 'Failed to create dispute case') + '</div>');
                }
                return;
            }
            if (window.confirm('Dispute case #' + r.data.case.id + ' created. Open it now?')) {
                window.location.href = '/practice/tax-disputes.html?source_type=sars_statement_line&source_id=' + encodeURIComponent(d.id);
            }
        })
        .catch(function () {
            var el = document.getElementById('detailFooter');
            if (el) el.insertAdjacentHTML('beforeend', '<div style="color:#fc8181;font-size:.78rem;margin-top:6px;">Network error</div>');
        });
    }

    // ── Match modal ───────────────────────────────────────────────────────────

    function srOpenMatch() {
        _hideMsg('matchMsg');
        document.getElementById('matchEventId').value = '';
        document.getElementById('matchNotes').value   = '';
        document.getElementById('matchModal').classList.add('active');
    }

    function srCloseMatch() {
        document.getElementById('matchModal').classList.remove('active');
    }

    function srSubmitMatch() {
        if (_submitting) return;
        var eventId = document.getElementById('matchEventId').value;
        var notes   = document.getElementById('matchNotes').value.trim();
        if (!eventId) return _showMsg('matchMsg', 'error', 'Payment event ID is required');

        _submitting = true;
        PracticeAPI.fetch(BASE + '/lines/' + _currentId + '/match-payment-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_event_id: Number(eventId), notes: notes || null }),
        })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showMsg('matchMsg', 'error', r.data.error || 'Failed to match');
            srCloseMatch();
            _showToast('Statement line matched to payment event #' + eventId);
            srOpenDetail(_currentId);
            _loadSummary();
            _loadList();
            srLoadUnmatched();
        })
        .catch(function () { _submitting = false; _showMsg('matchMsg', 'error', 'Request failed'); });
    }

    // ── Action modal (unmatch / dispute / ignore / edit) ──────────────────────

    function srOpenAction(type) {
        _actionType = type;
        var titles = { unmatch: 'Unmatch', dispute: 'Dispute Line', ignore: 'Ignore Line', edit: 'Edit Line' };
        document.getElementById('actionTitle').textContent = titles[type] || 'Action';
        _hideMsg('actionMsg');
        document.getElementById('actionFormBody').innerHTML = _buildActionForm(type);
        document.getElementById('actionModal').classList.add('active');
    }

    function _buildActionForm(type) {
        if (type === 'dispute') {
            return '<div class="form-field"><label>Reason for Dispute *</label>' +
                '<textarea id="actionNotes" placeholder="Describe why this statement line is disputed…" style="min-height:90px;"></textarea></div>';
        }
        if (type === 'ignore') {
            return '<div class="form-field"><label>Notes (optional)</label>' +
                '<textarea id="actionNotes" placeholder="Why is this line being ignored?"></textarea></div>';
        }
        if (type === 'unmatch') {
            return '<div class="inline-msg warn">This will remove the match link and set the line back to Unmatched.</div>' +
                '<div class="form-field"><label>Notes (optional)</label>' +
                '<textarea id="actionNotes" placeholder="Reason for unmatching…"></textarea></div>';
        }
        if (type === 'edit') {
            var d = _currentLine || {};
            var html = '<div class="form-grid">';
            html += '<div class="form-field"><label>Statement Date</label><input type="date" id="editDate" value="' + _html(d.statement_date || '') + '"></div>';
            html += '<div class="form-field"><label>Tax Year</label><input type="number" id="editTaxYear" value="' + _html(d.tax_year || '') + '" placeholder="e.g. 2025"></div>';
            html += '<div class="form-field"><label>Period Label</label><input type="text" id="editPeriodLabel" value="' + _html(d.period_label || '') + '"></div>';
            html += '<div class="form-field"><label>Reference</label><input type="text" id="editRef" value="' + _html(d.reference_number || '') + '"></div>';
            html += '<div class="form-field form-full"><label>Description</label><input type="text" id="editDesc" value="' + _html(d.description || '') + '"></div>';
            html += '<div class="form-field"><label>Debit Amount (R)</label><input type="number" id="editDebit" min="0" step="0.01" value="' + _html(d.debit_amount || '') + '"></div>';
            html += '<div class="form-field"><label>Credit Amount (R)</label><input type="number" id="editCredit" min="0" step="0.01" value="' + _html(d.credit_amount || '') + '"></div>';
            html += '<div class="form-field"><label>Running Balance (R)</label><input type="number" id="editBalance" step="0.01" value="' + _html(d.running_balance != null ? d.running_balance : '') + '"></div>';
            html += '<div class="form-field form-full"><label>Notes</label><textarea id="editNotes">' + _html(d.notes || '') + '</textarea></div>';
            html += '<div class="form-field form-full"><label>Internal Notes</label><textarea id="editInternalNotes">' + _html(d.internal_notes || '') + '</textarea></div>';
            html += '</div>';
            return html;
        }
        return '';
    }

    function srCloseAction() {
        document.getElementById('actionModal').classList.remove('active');
        _actionType = null;
    }

    function srSubmitAction() {
        if (_submitting) return;
        var type = _actionType;
        var notes = (document.getElementById('actionNotes') || {}).value || '';
        var url, payload, method;

        if (type === 'dispute') {
            if (!notes.trim()) return _showMsg('actionMsg', 'error', 'A reason for the dispute is required');
            url = BASE + '/lines/' + _currentId + '/dispute';
            payload = { notes: notes.trim() };
            method = 'POST';
        } else if (type === 'ignore') {
            url = BASE + '/lines/' + _currentId + '/ignore';
            payload = { notes: notes.trim() || null };
            method = 'POST';
        } else if (type === 'unmatch') {
            url = BASE + '/lines/' + _currentId + '/unmatch';
            payload = { notes: notes.trim() || null };
            method = 'POST';
        } else if (type === 'edit') {
            url = BASE + '/lines/' + _currentId;
            method = 'PUT';
            var dateEl  = document.getElementById('editDate');
            var yearEl  = document.getElementById('editTaxYear');
            var periodEl= document.getElementById('editPeriodLabel');
            var refEl   = document.getElementById('editRef');
            var descEl  = document.getElementById('editDesc');
            var debitEl = document.getElementById('editDebit');
            var creditEl= document.getElementById('editCredit');
            var balEl   = document.getElementById('editBalance');
            var notesEl = document.getElementById('editNotes');
            var intEl   = document.getElementById('editInternalNotes');
            payload = {};
            if (dateEl   && dateEl.value)   payload.statement_date   = dateEl.value;
            if (yearEl   && yearEl.value)   payload.tax_year         = Number(yearEl.value);
            if (periodEl && periodEl.value) payload.period_label     = periodEl.value;
            if (refEl    && refEl.value)    payload.reference_number = refEl.value;
            if (descEl   && descEl.value)   payload.description      = descEl.value;
            if (debitEl  && debitEl.value !== '') payload.debit_amount  = parseFloat(debitEl.value);
            if (creditEl && creditEl.value !== '') payload.credit_amount = parseFloat(creditEl.value);
            if (balEl    && balEl.value !== '')  payload.running_balance = parseFloat(balEl.value);
            if (notesEl) payload.notes = notesEl.value || null;
            if (intEl)   payload.internal_notes = intEl.value || null;
        } else { return; }

        _submitting = true;
        PracticeAPI.fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showMsg('actionMsg', 'error', r.data.error || 'Action failed');
            srCloseAction();
            _showToast('Done');
            srOpenDetail(_currentId);
            _loadSummary();
            _loadList();
            if (type === 'unmatch') srLoadUnmatched();
        })
        .catch(function () { _submitting = false; _showMsg('actionMsg', 'error', 'Request failed'); });
    }

    // ── Cancel line ───────────────────────────────────────────────────────────

    function srCancelLine() {
        if (_submitting) return;
        if (!window.confirm('Cancel this statement line? It will be soft-cancelled and excluded from reconciliation totals. This cannot be undone.')) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/lines/' + _currentId, { method: 'DELETE' })
            .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (r) {
                _submitting = false;
                if (!r.ok) { _showToast(r.data.error || 'Failed to cancel'); return; }
                srCloseDetail();
                _showToast('Statement line cancelled');
                _loadSummary();
                _loadList();
            })
            .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.srLoad         = srLoad;
    window.srApplyFilters = srApplyFilters;
    window.srClearFilters = srClearFilters;
    window.srFilterByStatus = srFilterByStatus;
    window.srLoadUnmatched  = srLoadUnmatched;
    window.srOpenCreate   = srOpenCreate;
    window.srCloseCreate  = srCloseCreate;
    window.srSubmitCreate = srSubmitCreate;
    window.srOpenDetail   = srOpenDetail;
    window.srCloseDetail  = srCloseDetail;
    window.srOpenTab      = srOpenTab;
    window.srOpenMatch    = srOpenMatch;
    window.srCloseMatch   = srCloseMatch;
    window.srSubmitMatch  = srSubmitMatch;
    window.srOpenAction   = srOpenAction;
    window.srCloseAction  = srCloseAction;
    window.srSubmitAction = srSubmitAction;
    window.srCancelLine              = srCancelLine;
    window.srCreateDisputeFromLine   = srCreateDisputeFromLine;

    // ── Boot ─────────────────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        if (typeof LAYOUT !== 'undefined') {
            LAYOUT.onReady(function () { srLoad(); });
        } else {
            srLoad();
        }
    });

})();
