(function () {
    'use strict';

    var BASE      = '/api/practice/tax-submissions';
    var PAY_BASE  = '/api/practice/tax-payments';

    var STATUS_LABELS = {
        draft:               'Draft',
        submitted:           'Submitted',
        acknowledged:        'Acknowledged',
        assessed:            'Assessed',
        correction_required: 'Correction Required',
        objection_required:  'Objection Required',
        completed:           'Completed',
        cancelled:           'Cancelled',
    };
    var TYPE_LABELS = {
        itr12:      'ITR12', itr14: 'ITR14', irp6_p1: 'IRP6 P1',
        irp6_p2:    'IRP6 P2', irp6_topup: 'IRP6 Top-up',
        emp501:     'EMP501', custom: 'Custom',
    };
    var METHOD_LABELS = {
        efiling: 'eFiling', branch: 'Branch', email: 'Email', manual: 'Manual', other: 'Other',
    };
    var OUTCOME_LABELS = {
        accepted: 'Accepted', changed: 'Changed', additional_tax: 'Additional Tax',
        refund: 'Refund', nil: 'Nil', disputed: 'Disputed', unknown: 'Unknown',
    };

    // State
    var _currentId      = null;
    var _currentSub     = null;
    var _currentTab     = 'overview';
    var _submitting     = false;
    var _actionType     = null;
    var _page           = 1;
    var _totalCount     = 0;
    var LIMIT           = 50;

    // ── Utilities ──────────────────────────────────────────────────────────────

    function _qs() {
        var p = [];
        var type    = document.getElementById('filterType').value;
        var subtype = document.getElementById('filterSubType').value;
        var status  = document.getElementById('filterStatus').value;
        var year    = document.getElementById('filterYear').value;
        if (type)    p.push('source_type='    + encodeURIComponent(type));
        if (subtype) p.push('submission_type=' + encodeURIComponent(subtype));
        if (status)  p.push('submission_status=' + encodeURIComponent(status));
        if (year)    p.push('tax_year='       + encodeURIComponent(year));
        p.push('page='  + _page);
        p.push('limit=' + LIMIT);
        return '?' + p.join('&');
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

    function _typeBadge(st) {
        if (st === 'individual_tax_return')  return '<span class="type-badge type-ind">Ind</span>';
        if (st === 'company_tax_return')      return '<span class="type-badge type-comp">Co</span>';
        if (st === 'provisional_tax_plan')    return '<span class="type-badge type-prov">Prov</span>';
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

    // ── Boot ───────────────────────────────────────────────────────────────────

    function tslLoad() {
        _loadSummary();
        _loadList();
        _checkUrlParams();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var sourceType = params.get('source_type');
        var sourceId   = params.get('source_id');
        var taxYear    = params.get('tax_year');
        if (sourceType && sourceId) {
            // Pre-fill the create modal
            tslOpenCreate();
            document.getElementById('createSourceType').value = sourceType;
            document.getElementById('createSourceId').value   = sourceId;
            if (taxYear) document.getElementById('createTaxYear').value = taxYear;
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
            submitted:           'c-info',
            correction_required: 'c-alert',
            objection_required:  'c-warn',
            assessed:            'c-ok',
        };
        var html = '';
        Object.keys(STATUS_LABELS).forEach(function (s) {
            var count = byStatus[s] || 0;
            if (count === 0 && !['submitted','correction_required','assessed'].includes(s)) return;
            html += '<div class="sum-card" onclick="tslFilterByStatus(\'' + s + '\')">';
            html += '<div class="sum-card-count ' + (highlight[s] || '') + '">' + count + '</div>';
            html += '<div class="sum-card-label">' + _html(STATUS_LABELS[s]) + '</div>';
            html += '</div>';
        });
        if (d.follow_up_required) {
            html += '<div class="sum-card" onclick="tslApplyFilters()">';
            html += '<div class="sum-card-count c-warn">' + d.follow_up_required + '</div>';
            html += '<div class="sum-card-label">Follow-up Due</div>';
            html += '</div>';
        }
        if (d.payments_due) {
            html += '<div class="sum-card">';
            html += '<div class="sum-card-count c-alert">' + d.payments_due + '</div>';
            html += '<div class="sum-card-label">Payments Due</div>';
            html += '</div>';
        }
        document.getElementById('summaryGrid').innerHTML = html || '<span style="color:#718096;font-size:.8rem">No submissions yet</span>';
    }

    // ── List ───────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="8"><div class="loading-state">Loading…</div></td></tr>';
        PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _totalCount = d.total || 0;
                _renderList(d.submissions || []);
                _renderPagination();
            })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr><td colspan="8" style="color:#fc8181;text-align:center;padding:20px">Failed to load</td></tr>';
            });
    }

    function _renderList(items) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-state-icon">📋</div>No submissions found</div></td></tr>';
            return;
        }
        var html = '';
        items.forEach(function (s) {
            var followUp = s.follow_up_required && !['cancelled','completed'].includes(s.submission_status)
                ? '<span class="followup-badge">Follow-up</span>' : '';
            html += '<tr onclick="tslOpenDetail(' + s.id + ')">';
            html += '<td>' + _typeBadge(s.source_type) + ' <span class="subtype-badge">' + _html(TYPE_LABELS[s.submission_type] || s.submission_type) + '</span></td>';
            html += '<td>' + (s.tax_year || '—') + '</td>';
            html += '<td>' + _statusPill(s.submission_status) + '</td>';
            html += '<td style="font-size:.78rem">' + _fmt(s.submitted_at) + '</td>';
            html += '<td style="font-size:.78rem;font-family:monospace">' + _html(s.submission_reference || '—') + '</td>';
            html += '<td>' + (s.assessment_outcome ? _html(OUTCOME_LABELS[s.assessment_outcome] || s.assessment_outcome) : '—') + '</td>';
            html += '<td class="amount" style="font-family:monospace;font-size:.78rem">' + (s.amount_payable != null ? _money(s.amount_payable) : '—') + '</td>';
            html += '<td>' + followUp + (s.follow_up_due_date ? '<span style="font-size:.74rem;color:#f6ad55">' + _fmtDate(s.follow_up_due_date) + '</span>' : '') + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    function _renderPagination() {
        var totalPages = Math.max(1, Math.ceil(_totalCount / LIMIT));
        var row  = document.getElementById('paginationRow');
        var info = document.getElementById('pageInfo');
        info.textContent = 'Page ' + _page + ' of ' + totalPages + ' (' + _totalCount + ' total)';
        document.getElementById('prevPageBtn').disabled = (_page <= 1);
        document.getElementById('nextPageBtn').disabled = (_page >= totalPages);
        row.style.display = _totalCount > LIMIT ? 'flex' : 'none';
    }

    function tslPrevPage() { if (_page > 1) { _page--; _loadList(); } }
    function tslNextPage() { _page++; _loadList(); }

    // ── Filters ────────────────────────────────────────────────────────────────

    function tslApplyFilters()  { _page = 1; _loadList(); }
    function tslClearFilters()  {
        ['filterType','filterSubType','filterStatus'].forEach(function (id) { document.getElementById(id).value = ''; });
        document.getElementById('filterYear').value = '';
        _page = 1;
        _loadList();
    }
    function tslFilterByStatus(s) {
        document.getElementById('filterStatus').value = s;
        tslApplyFilters();
    }

    // ── Create modal ───────────────────────────────────────────────────────────

    function tslOpenCreate() {
        _hideMsg('createMsg');
        document.getElementById('createSourceType').value = '';
        document.getElementById('createSourceId').value   = '';
        document.getElementById('createSubType').value    = '';
        document.getElementById('createTaxYear').value    = '';
        document.getElementById('createNotes').value      = '';
        document.getElementById('createSubmitBtn').disabled    = false;
        document.getElementById('createSubmitBtn').textContent = 'Create';
        document.getElementById('createModal').classList.add('open');
    }
    function tslCloseCreate() { document.getElementById('createModal').classList.remove('open'); }

    function tslSubmitCreate() {
        if (_submitting) return;
        _hideMsg('createMsg');

        var sourceType = document.getElementById('createSourceType').value;
        var sourceId   = document.getElementById('createSourceId').value;
        var subType    = document.getElementById('createSubType').value;
        var taxYear    = document.getElementById('createTaxYear').value;
        var notes      = document.getElementById('createNotes').value.trim();

        if (!sourceType) return _showMsg('createMsg','error','Source type is required');
        if (!sourceId)   return _showMsg('createMsg','error','Source ID is required');
        if (!subType)    return _showMsg('createMsg','error','Submission type is required');

        _submitting = true;
        var btn = document.getElementById('createSubmitBtn');
        btn.disabled    = true;
        btn.textContent = 'Creating…';

        PracticeAPI.fetch(BASE, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ source_type: sourceType, source_id: Number(sourceId), submission_type: subType, tax_year: taxYear ? Number(taxYear) : null, notes: notes || null }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            btn.disabled    = false;
            btn.textContent = 'Create';
            if (!r.ok) return _showMsg('createMsg','error', r.data.error || 'Failed to create');
            _showToast('Submission record created');
            tslCloseCreate();
            tslLoad();
        })
        .catch(function () {
            _submitting = false;
            btn.disabled    = false;
            btn.textContent = 'Create';
            _showMsg('createMsg','error','Request failed. Try again.');
        });
    }

    // ── Detail modal ───────────────────────────────────────────────────────────

    function tslOpenDetail(id) {
        _currentId  = id;
        _currentSub = null;
        _currentTab = 'overview';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailTitle').textContent = 'Loading…';
        document.getElementById('detailBody').innerHTML    = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML  = '<button type="button" class="btn-action btn-secondary" onclick="tslCloseDetail()">Close</button>';

        PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentSub = d;
                _activateTab('overview');
                _renderTabBar(d);
                _renderFooter(d);
                _renderTitle(d);
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div class="tab-content" style="color:#fc8181">Failed to load submission</div>';
            });
    }

    function _renderTitle(d) {
        document.getElementById('detailTitle').textContent = (TYPE_LABELS[d.submission_type] || d.submission_type) + ' — ' + (STATUS_LABELS[d.submission_status] || d.submission_status);
    }

    function _renderTabBar(d) {
        var tabs = [
            { key:'overview',   label:'Overview'   },
            { key:'submission', label:'Submission'  },
            { key:'assessment', label:'Assessment'  },
            { key:'evidence',   label:'Evidence (' + (d.evidence_count || 0) + ')' },
            { key:'payments',   label:'Payments'   },
            { key:'followup',   label:'Follow-up'  },
            { key:'events',     label:'Events'     },
        ];
        var html = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="tslOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
        document.getElementById('detailTabBar').innerHTML = html;
    }

    function _renderFooter(d) {
        var html = '<button type="button" class="btn-action btn-secondary" onclick="tslCloseDetail()">Close</button>';
        var s = d.submission_status;
        if (s === 'draft') {
            html += '<button type="button" class="btn-action btn-primary" onclick="tslOpenAction(\'mark-submitted\')">Mark Submitted</button>';
            html += '<button type="button" class="btn-action btn-danger"  onclick="tslCancelSubmission()">Cancel</button>';
        } else if (s === 'submitted') {
            html += '<button type="button" class="btn-action btn-primary"  onclick="tslOpenAction(\'record-acknowledgement\')">Record Acknowledgement</button>';
            html += '<button type="button" class="btn-action btn-warning"  onclick="tslOpenAction(\'record-assessment\')">Record Assessment</button>';
        } else if (s === 'acknowledged') {
            html += '<button type="button" class="btn-action btn-primary"  onclick="tslOpenAction(\'record-assessment\')">Record Assessment</button>';
        }
        if (!['cancelled','completed'].includes(s)) {
            html += '<button type="button" class="btn-action btn-success"  onclick="tslOpenAction(\'add-evidence\')">Add Evidence</button>';
            html += '<button type="button" class="btn-action btn-secondary" onclick="tslOpenAction(\'set-follow-up\')">Follow-up</button>';
        }
        // Codebox 44 — Dispute integration buttons
        if (!['cancelled'].includes(s)) {
            if (['assessed','correction_required'].includes(s)) {
                html += '<button type="button" class="btn-action btn-warning" onclick="tslMarkCorrectionRequired()" title="Mark this submission as requiring a correction">Mark Correction</button>';
            }
            if (['assessed','correction_required','objection_required'].includes(s)) {
                html += '<button type="button" class="btn-action btn-danger" onclick="tslMarkObjectionRequired()" title="Mark this submission as requiring a formal objection">Mark Objection</button>';
            }
            if (!['completed'].includes(s)) {
                html += '<button type="button" class="btn-action btn-success" onclick="tslMarkCompleted()" title="Mark this submission as completed and resolved">Mark Completed</button>';
            }
        }
        html += '<a href="/practice/tax-disputes.html?submission_id=' + encodeURIComponent(d.id) + '" ' +
            'style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d3748;color:#e2e8f0;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;gap:6px;" ' +
            'title="View all dispute/correction cases for this submission">Open Disputes ↗</a>';
        // Codebox 45 — Completion Pack link
        html += '<a href="/practice/tax-completion.html?submission_id=' + encodeURIComponent(d.id) + '" ' +
            'style="display:inline-flex;align-items:center;padding:7px 14px;background:#1a4d2e;color:#68d391;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;gap:6px;" ' +
            'title="Open or create the completion pack for this submission">Completion Pack ↗</a>';
        // Codebox 46 — Knowledge Base integration
        html += '<a href="/practice/knowledge-base.html?linked_type=tax_submission&linked_id=' + encodeURIComponent(d.id) + '" ' +
            'style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d1e4d;color:#b794f4;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;gap:6px;" ' +
            'title="View knowledge articles linked to this submission">Knowledge ↗</a>';
        document.getElementById('detailFooter').innerHTML = html;
    }

    function tslCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId  = null;
        _currentSub = null;
    }

    // ── Tabs ───────────────────────────────────────────────────────────────────

    function tslOpenTab(tab) {
        _currentTab = tab;
        if (_currentSub) {
            _activateTab(tab);
            _renderTabBar(_currentSub);
        }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        switch (tab) {
            case 'overview':   _renderOverview(_currentSub, body);   break;
            case 'submission': _renderSubmissionTab(_currentSub, body); break;
            case 'assessment': _renderAssessmentTab(_currentSub, body); break;
            case 'evidence':   _loadEvidenceTab(body);               break;
            case 'payments':   _loadPaymentsTab(body);                break;
            case 'followup':   _renderFollowUpTab(_currentSub, body); break;
            case 'events':     _loadEventsTab(body);                  break;
        }
    }

    // ── Tab renderers ──────────────────────────────────────────────────────────

    function _renderOverview(d, body) {
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dField('Source Type', _typeBadge(d.source_type) + ' Source #' + d.source_id);
        html += _dField('Sub-type',    TYPE_LABELS[d.submission_type] || d.submission_type);
        html += _dField('Status',      _statusPill(d.submission_status));
        html += _dField('Tax Year',    d.tax_year || '—');
        html += _dField('Created',     _fmt(d.created_at));
        html += _dField('Last Updated', _fmt(d.updated_at));
        html += '</div>';
        if (d.notes) {
            html += '<div class="section-label">Notes</div>';
            html += '<div style="background:#0f1724;border-radius:6px;padding:10px;font-size:.82rem;color:#a0aec0">' + _html(d.notes) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _renderSubmissionTab(d, body) {
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dField('Submitted At',       _fmt(d.submitted_at));
        html += _dField('Method',             METHOD_LABELS[d.submission_method] || d.submission_method || '—');
        html += _dField('Reference',          d.submission_reference         || '—');
        html += _dField('Acknowledgement Ref',d.acknowledgement_reference    || '—');
        html += _dField('Acknowledged At',    _fmt(d.acknowledgement_received_at));
        html += _dField('Submitted By',       d.submitted_by_team_member_id  ? '#' + d.submitted_by_team_member_id : '—');
        html += '</div>';
        if (d.evidence_summary) {
            html += '<div class="section-label">Evidence Summary</div>';
            html += '<div style="background:#0f1724;border-radius:6px;padding:10px;font-size:.82rem;color:#a0aec0">' + _html(d.evidence_summary) + '</div>';
        }
        if (d.acknowledgement_file_note) {
            html += '<div class="section-label">Acknowledgement File Note</div>';
            html += '<div style="background:#0f1724;border-radius:6px;padding:10px;font-size:.82rem;color:#a0aec0">' + _html(d.acknowledgement_file_note) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _renderAssessmentTab(d, body) {
        var html = '<div class="tab-content">';
        if (!d.assessment_received_at) {
            html += '<div class="inline-msg info">No assessment recorded yet.</div>';
        } else {
            html += '<div class="detail-grid">';
            html += _dField('Assessment Ref',    d.assessment_reference   || '—');
            html += _dField('Received At',       _fmt(d.assessment_received_at));
            html += _dField('Outcome',           OUTCOME_LABELS[d.assessment_outcome] || d.assessment_outcome || '—');
            html += _dField('Assessed Amount',   _money(d.assessed_amount));
            html += _dField('Amount Payable',    _money(d.amount_payable));
            html += _dField('Refund Amount',     _money(d.refund_amount));
            html += _dField('Payment Due',       _fmtDate(d.payment_due_date));
            html += '</div>';
            if (d.assessment_file_note) {
                html += '<div class="section-label">Assessment File Note</div>';
                html += '<div style="background:#0f1724;border-radius:6px;padding:10px;font-size:.82rem;color:#a0aec0">' + _html(d.assessment_file_note) + '</div>';
            }
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _loadEvidenceTab(body) {
        body.innerHTML = '<div class="loading-state">Loading evidence…</div>';
        PracticeAPI.fetch(BASE + '/' + _currentId + '/evidence')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEvidenceTab(d.evidence || [], body); })
            .catch(function () { body.innerHTML = '<div class="tab-content" style="color:#fc8181">Failed to load evidence</div>'; });
    }

    function _renderEvidenceTab(items, body) {
        var html = '<div class="tab-content">';
        if (!items.length) {
            html += '<div class="empty-state"><div class="empty-state-icon">📎</div>No evidence records yet</div>';
        } else {
            items.forEach(function (ev) {
                html += '<div class="evidence-item">';
                html += '<div class="evidence-item-header">';
                html += '<span class="evidence-title">' + _html(ev.evidence_title) + '</span>';
                html += ev.is_verified ? '<span class="verified-badge">Verified</span>' : '<span class="unverified-badge">Unverified</span>';
                html += '<span class="subtype-badge">' + _html(ev.evidence_type) + '</span>';
                html += '</div>';
                if (ev.evidence_note) html += '<div class="evidence-meta">' + _html(ev.evidence_note) + '</div>';
                if (ev.external_reference) html += '<div class="evidence-meta">Ref: ' + _html(ev.external_reference) + '</div>';
                html += '<div style="display:flex;gap:8px;margin-top:8px;">';
                if (!ev.is_verified) {
                    html += '<button type="button" class="btn-sm btn-primary-sm" onclick="tslVerifyEvidence(' + ev.id + ')">Verify</button>';
                }
                html += '<button type="button" class="btn-sm btn-ghost-sm" onclick="tslDeleteEvidence(' + ev.id + ')">Remove</button>';
                html += '</div></div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    // ── Payments tab ───────────────────────────────────────────────────────────
    // Manual payment register — no SARS integration, no bank reconciliation.

    var PAY_STATUS_LABELS = {
        outstanding: 'Outstanding', partially_paid: 'Partially Paid', paid_in_full: 'Paid in Full',
        overpaid: 'Overpaid', refund_pending: 'Refund Pending', refund_received: 'Refund Received',
        cancelled: 'Cancelled',
    };

    function _loadPaymentsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading payment cases…</div>';
        PracticeAPI.fetch(PAY_BASE + '?submission_id=' + _currentId)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderPaymentsTab(d.payments || [], body); })
            .catch(function () { body.innerHTML = '<div class="tab-content" style="color:#fc8181">Failed to load payment cases</div>'; });
    }

    function _renderPaymentsTab(items, body) {
        var d = _currentSub;
        var html = '<div class="tab-content">';

        if (!items.length) {
            html += '<div class="inline-msg info">No payment cases yet for this submission.</div>';
            if (d.amount_payable && Number(d.amount_payable) > 0) {
                html += '<button type="button" class="btn-action btn-warning" style="margin-bottom:10px" onclick="tslCreatePaymentCase(\'payable\',' + Number(d.amount_payable) + ')">Create Payable Case (' + _money(d.amount_payable) + ')</button> ';
            }
            if (d.refund_amount && Number(d.refund_amount) > 0) {
                html += '<button type="button" class="btn-action btn-success" style="margin-bottom:10px" onclick="tslCreatePaymentCase(\'refundable\',' + Number(d.refund_amount) + ')">Create Refundable Case (' + _money(d.refund_amount) + ')</button>';
            }
            if (!d.amount_payable && !d.refund_amount) {
                html += '<div style="color:#718096;font-size:.8rem">Record an assessment with an amount payable or refund amount to start a payment case, or open the full register to create one manually.</div>';
            }
        } else {
            items.forEach(function (p) {
                html += '<div class="evidence-item">';
                html += '<div class="evidence-item-header">';
                html += '<span class="evidence-title">' + (p.direction === 'payable' ? 'Payable' : 'Refundable') + '</span>';
                html += '<span class="subtype-badge">' + _html(PAY_STATUS_LABELS[p.status] || p.status) + '</span>';
                html += '</div>';
                html += '<div class="evidence-meta">Original: ' + _money(p.original_amount) + ' · Settled: ' + _money(p.amount_settled) + ' · Balance: ' + _money(p.balance_outstanding) + '</div>';
                if (p.due_date) html += '<div class="evidence-meta">Due: ' + _fmtDate(p.due_date) + '</div>';
                html += '</div>';
            });
        }
        html += '<a href="/practice/tax-payments.html?submission_id=' + _currentId + '" style="display:inline-block;margin-top:6px;padding:7px 16px;background:#667eea;color:#fff;border-radius:7px;font-size:.82rem;font-weight:700;text-decoration:none;">Open Payment Register</a>';
        html += ' <a href="/practice/sars-recon.html?submission_id=' + _currentId + '" style="display:inline-block;margin-top:6px;padding:7px 16px;background:#2d3748;color:#e2e8f0;border-radius:7px;font-size:.82rem;font-weight:700;text-decoration:none;">SARS Recon ↗</a>';
        html += '</div>';
        body.innerHTML = html;
    }

    function tslCreatePaymentCase(direction, amount) {
        if (_submitting) return;
        _submitting = true;
        PracticeAPI.fetch(PAY_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ submission_id: _currentId, direction: direction, original_amount: amount }),
        })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to create payment case');
            _showToast('Payment case created');
            _loadPaymentsTab(document.getElementById('detailBody'));
        })
        .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    function _renderFollowUpTab(d, body) {
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dField('Follow-up Required', d.follow_up_required ? 'Yes' : 'No');
        html += _dField('Due Date',           _fmtDate(d.follow_up_due_date));
        html += _dField('Responsible',        d.responsible_team_member_id ? '#' + d.responsible_team_member_id : '—');
        html += '</div>';
        if (d.follow_up_notes) {
            html += '<div class="section-label">Follow-up Notes</div>';
            html += '<div style="background:#0f1724;border-radius:6px;padding:10px;font-size:.82rem;color:#a0aec0">' + _html(d.follow_up_notes) + '</div>';
        }
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

    function _renderEventsTab(events, body) {
        var html = '<div class="tab-content">';
        if (!events.length) {
            html += '<div style="color:#718096;font-size:.82rem">No events yet</div>';
        } else {
            html += '<div class="event-list">';
            events.forEach(function (ev) {
                html += '<div class="event-item"><div class="event-dot"></div><div class="event-content">';
                html += '<div class="event-type">' + _html(ev.event_type.replace(/_/g,' ')) + '</div>';
                if (ev.old_status && ev.new_status) {
                    html += '<div class="event-meta">' + _html(STATUS_LABELS[ev.old_status] || ev.old_status) + ' → ' + _html(STATUS_LABELS[ev.new_status] || ev.new_status) + '</div>';
                }
                html += '<div class="event-meta">' + _fmt(ev.created_at) + (ev.actor_user_id ? ' · User #' + ev.actor_user_id : '') + '</div>';
                if (ev.notes) html += '<div class="event-note">"' + _html(ev.notes) + '"</div>';
                html += '</div></div>';
            });
            html += '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dField(label, value) {
        return '<div class="detail-field"><div class="detail-label">' + _html(label) + '</div><div class="detail-value">' + (value != null ? value : '—') + '</div></div>';
    }

    // ── Action modal ───────────────────────────────────────────────────────────

    function tslOpenAction(type) {
        _actionType = type;
        _hideMsg('actionMsg');
        document.getElementById('actionSubmitBtn').disabled    = false;
        document.getElementById('actionSubmitBtn').textContent = 'Save';

        var titles = {
            'mark-submitted':       'Mark as Submitted',
            'record-acknowledgement': 'Record Acknowledgement',
            'record-assessment':    'Record Assessment',
            'add-evidence':         'Add Evidence',
            'set-follow-up':        'Set Follow-up',
        };
        document.getElementById('actionModalTitle').textContent = titles[type] || type;
        document.getElementById('actionFormBody').innerHTML     = _buildActionForm(type);
        document.getElementById('actionModal').classList.add('open');
    }

    function _buildActionForm(type) {
        if (type === 'mark-submitted') {
            return '<div class="form-grid">' +
                _formField('Submitted At *', '<input type="datetime-local" class="form-input" id="af_submitted_at">') +
                _formField('Method', '<select class="form-select" id="af_method"><option value="">— Select —</option><option value="efiling">eFiling</option><option value="branch">Branch</option><option value="email">Email</option><option value="manual">Manual</option><option value="other">Other</option></select>') +
                _formField('Submission Reference', '<input class="form-input" id="af_ref" placeholder="e.g. SARS-2025-001">') +
                _formField('Evidence Summary', '<textarea class="form-textarea" id="af_evidence_summary" rows="2"></textarea>', true) +
                '</div>';
        }
        if (type === 'record-acknowledgement') {
            return '<div class="form-grid">' +
                _formField('Received At *', '<input type="datetime-local" class="form-input" id="af_ack_at">') +
                _formField('Acknowledgement Reference', '<input class="form-input" id="af_ack_ref" placeholder="Reference number">') +
                _formField('File Note', '<textarea class="form-textarea" id="af_ack_note" rows="2"></textarea>', true) +
                '</div>';
        }
        if (type === 'record-assessment') {
            return '<div class="form-grid">' +
                _formField('Received At *', '<input type="datetime-local" class="form-input" id="af_asmt_at">') +
                _formField('Assessment Reference', '<input class="form-input" id="af_asmt_ref">') +
                _formField('Outcome *', '<select class="form-select" id="af_outcome"><option value="">— Select —</option><option value="accepted">Accepted</option><option value="changed">Changed</option><option value="additional_tax">Additional Tax</option><option value="refund">Refund</option><option value="nil">Nil</option><option value="disputed">Disputed</option><option value="unknown">Unknown</option></select>') +
                _formField('Assessed Amount', '<input type="number" step="0.01" class="form-input" id="af_assessed" placeholder="0.00">') +
                _formField('Amount Payable', '<input type="number" step="0.01" class="form-input" id="af_payable" placeholder="0.00">') +
                _formField('Refund Amount', '<input type="number" step="0.01" class="form-input" id="af_refund" placeholder="0.00">') +
                _formField('Payment Due Date', '<input type="date" class="form-input" id="af_pay_due">') +
                _formField('Assessment File Note', '<textarea class="form-textarea" id="af_asmt_note" rows="2"></textarea>', true) +
                '</div>';
        }
        if (type === 'add-evidence') {
            return '<div class="form-grid">' +
                _formField('Evidence Type *', '<select class="form-select" id="af_ev_type"><option value="">— Select —</option><option value="submission_confirmation">Submission Confirmation</option><option value="acknowledgement">Acknowledgement</option><option value="assessment">Assessment</option><option value="payment_proof">Payment Proof</option><option value="supporting_document">Supporting Document</option><option value="correspondence">Correspondence</option><option value="other">Other</option></select>') +
                _formField('Title *', '<input class="form-input" id="af_ev_title" placeholder="Descriptive title">') +
                _formField('External Reference', '<input class="form-input" id="af_ev_extref" placeholder="e.g. Case number">') +
                _formField('Note', '<textarea class="form-textarea" id="af_ev_note" rows="2" placeholder="Evidence details…"></textarea>', true) +
                '</div>';
        }
        if (type === 'set-follow-up') {
            var d = _currentSub || {};
            return '<div class="form-grid">' +
                _formField('Follow-up Required', '<select class="form-select" id="af_fu_req"><option value="true"' + (d.follow_up_required ? ' selected' : '') + '>Yes</option><option value="false"' + (!d.follow_up_required ? ' selected' : '') + '>No</option></select>') +
                _formField('Due Date', '<input type="date" class="form-input" id="af_fu_date" value="' + (d.follow_up_due_date || '') + '">') +
                _formField('Notes', '<textarea class="form-textarea" id="af_fu_notes" rows="2">' + _html(d.follow_up_notes || '') + '</textarea>', true) +
                '</div>';
        }
        return '<div style="color:#718096">Unknown action</div>';
    }

    function _formField(label, inputHtml, full) {
        return '<div class="form-group' + (full ? '" style="grid-column:1/-1' : '') + '">' +
            '<label class="form-label">' + label + '</label>' + inputHtml + '</div>';
    }

    function tslCloseAction() { document.getElementById('actionModal').classList.remove('open'); }

    function tslSubmitAction() {
        if (_submitting) return;
        _hideMsg('actionMsg');
        var payload = _buildPayload(_actionType);
        if (!payload) return;

        var urlMap = {
            'mark-submitted':       BASE + '/' + _currentId + '/mark-submitted',
            'record-acknowledgement': BASE + '/' + _currentId + '/record-acknowledgement',
            'record-assessment':    BASE + '/' + _currentId + '/record-assessment',
            'add-evidence':         BASE + '/' + _currentId + '/evidence',
            'set-follow-up':        BASE + '/' + _currentId + '/set-follow-up',
        };
        var method = _actionType === 'add-evidence' ? 'POST' : 'PUT';
        var url    = urlMap[_actionType];
        if (!url) return;

        _submitting = true;
        var btn = document.getElementById('actionSubmitBtn');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        PracticeAPI.fetch(url, {
            method:  method,
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
            tslCloseAction();
            tslOpenDetail(_currentId);
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
        function _num(id) { var v = _val(id); return v ? Number(v) : null; }

        if (type === 'mark-submitted') {
            var at = _val('af_submitted_at');
            if (!at) return _showMsg('actionMsg','error','Submitted At is required') && null;
            return { submitted_at: at, submission_method: _val('af_method') || null, submission_reference: _val('af_ref') || null, evidence_summary: _val('af_evidence_summary') || null };
        }
        if (type === 'record-acknowledgement') {
            var ackAt = _val('af_ack_at');
            if (!ackAt) return _showMsg('actionMsg','error','Received At is required') && null;
            return { acknowledgement_received_at: ackAt, acknowledgement_reference: _val('af_ack_ref') || null, acknowledgement_file_note: _val('af_ack_note') || null };
        }
        if (type === 'record-assessment') {
            var asmtAt  = _val('af_asmt_at');
            var outcome = _val('af_outcome');
            if (!asmtAt)  return _showMsg('actionMsg','error','Received At is required')  && null;
            if (!outcome) return _showMsg('actionMsg','error','Outcome is required')       && null;
            return { assessment_received_at: asmtAt, assessment_reference: _val('af_asmt_ref') || null, assessment_outcome: outcome, assessed_amount: _num('af_assessed'), amount_payable: _num('af_payable'), refund_amount: _num('af_refund'), payment_due_date: _val('af_pay_due') || null, assessment_file_note: _val('af_asmt_note') || null };
        }
        if (type === 'add-evidence') {
            var evType  = _val('af_ev_type');
            var evTitle = _val('af_ev_title');
            if (!evType)  return _showMsg('actionMsg','error','Evidence type is required') && null;
            if (!evTitle) return _showMsg('actionMsg','error','Title is required')         && null;
            return { evidence_type: evType, evidence_title: evTitle, external_reference: _val('af_ev_extref') || null, evidence_note: _val('af_ev_note') || null };
        }
        if (type === 'set-follow-up') {
            return { follow_up_required: _val('af_fu_req') === 'true', follow_up_due_date: _val('af_fu_date') || null, follow_up_notes: _val('af_fu_notes') || null };
        }
        return null;
    }

    // ── Evidence actions ───────────────────────────────────────────────────────

    function tslVerifyEvidence(evidenceId) {
        if (_submitting) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/evidence/' + evidenceId + '/verify', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                _submitting = false;
                if (!r.ok) return _showToast(r.data.error || 'Verify failed');
                _showToast('Evidence verified');
                _loadEvidenceTab(document.getElementById('detailBody'));
            })
            .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    function tslDeleteEvidence(evidenceId) {
        if (_submitting) return;
        if (!confirm('Remove this evidence record?')) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/evidence/' + evidenceId, { method: 'DELETE' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                _submitting = false;
                if (!r.ok) return _showToast(r.data.error || 'Delete failed');
                _showToast('Evidence removed');
                _loadEvidenceTab(document.getElementById('detailBody'));
            })
            .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    // ── Cancel submission ──────────────────────────────────────────────────────

    function tslCancelSubmission() {
        if (_submitting) return;
        var reason = prompt('Reason for cancellation (required):');
        if (!reason || !reason.trim()) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ notes: reason.trim() }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Cancel failed');
            _showToast('Submission cancelled');
            tslCloseDetail();
            tslLoad();
        })
        .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    // ── Codebox 44 — Dispute integration (mark-correction / objection / completed) ──

    function _tslSimpleAction(endpoint, confirmMsg, successMsg) {
        if (_submitting) return;
        if (!window.confirm(confirmMsg)) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/' + endpoint, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({}),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Action failed');
            _showToast(successMsg);
            // Refresh detail
            PracticeAPI.fetch(BASE + '/' + _currentId)
                .then(function (res) { return res.json(); })
                .then(function (d) {
                    _currentSub = d;
                    _renderTabBar(_currentSub);
                    _activateTab(_currentTab);
                    _renderFooter(_currentSub);
                });
            tslLoad();
        })
        .catch(function () { _submitting = false; _showToast('Request failed'); });
    }

    function tslMarkCorrectionRequired() {
        _tslSimpleAction('mark-correction-required', 'Mark this submission as Correction Required?', 'Marked as Correction Required');
    }

    function tslMarkObjectionRequired() {
        _tslSimpleAction('mark-objection-required', 'Mark this submission as Objection Required?', 'Marked as Objection Required');
    }

    function tslMarkCompleted() {
        _tslSimpleAction('mark-completed', 'Mark this submission as Completed?', 'Submission marked as Completed');
    }

    // ── Exports ────────────────────────────────────────────────────────────────

    window.tslLoad             = tslLoad;
    window.tslApplyFilters     = tslApplyFilters;
    window.tslClearFilters     = tslClearFilters;
    window.tslFilterByStatus   = tslFilterByStatus;
    window.tslPrevPage         = tslPrevPage;
    window.tslNextPage         = tslNextPage;
    window.tslOpenCreate       = tslOpenCreate;
    window.tslCloseCreate      = tslCloseCreate;
    window.tslSubmitCreate     = tslSubmitCreate;
    window.tslOpenDetail       = tslOpenDetail;
    window.tslCloseDetail      = tslCloseDetail;
    window.tslOpenTab          = tslOpenTab;
    window.tslOpenAction       = tslOpenAction;
    window.tslCloseAction      = tslCloseAction;
    window.tslSubmitAction     = tslSubmitAction;
    window.tslVerifyEvidence   = tslVerifyEvidence;
    window.tslDeleteEvidence   = tslDeleteEvidence;
    window.tslCancelSubmission        = tslCancelSubmission;
    window.tslCreatePaymentCase       = tslCreatePaymentCase;
    window.tslMarkCorrectionRequired  = tslMarkCorrectionRequired;
    window.tslMarkObjectionRequired   = tslMarkObjectionRequired;
    window.tslMarkCompleted           = tslMarkCompleted;

    // ── Boot ───────────────────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        if (typeof LAYOUT !== 'undefined') {
            LAYOUT.onReady(function () { tslLoad(); });
        } else {
            tslLoad();
        }
    });

})();
