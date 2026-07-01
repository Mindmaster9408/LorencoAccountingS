// Codebox 45 — Tax Completion Pack frontend (tc prefix)
// Internal quality-control and partner sign-off gate.
// No localStorage. No KV. All state from server API.

(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────────────
    var BASE = '/api/practice/tax-completion';

    var PACK_STATUS_LABELS = {
        draft:          'Draft',
        review_pending: 'Review Pending',
        approved:       'Approved',
        completed:      'Completed',
        cancelled:      'Cancelled',
    };

    var SOURCE_TYPE_LABELS = {
        individual_tax:  'Individual Tax',
        company_tax:     'Company Tax',
        provisional_tax: 'Provisional Tax',
        vat:             'VAT',
        payroll:         'Payroll',
    };

    var ITEM_TYPE_LABELS = {
        submission_proof:     'Submission Proof',
        assessment:           'Assessment',
        payment_proof:        'Payment Proof',
        refund_proof:         'Refund Proof',
        reconciliation:       'Reconciliation',
        dispute:              'Dispute',
        supporting_documents: 'Supporting Documents',
        working_papers:       'Working Papers',
        client_approval:      'Client Approval',
        partner_review:       'Partner Review',
        internal_review:      'Internal Review',
        other:                'Other',
    };

    var OVERRIDE_LABELS = {
        outstanding_payments: 'Outstanding Payments',
        unmatched_sars_lines: 'Unmatched SARS Lines',
        open_disputes:        'Open Disputes',
    };

    var TERMINAL_STATUSES = ['completed', 'cancelled'];

    // ── State ─────────────────────────────────────────────────────────────────
    var _currentId   = null;
    var _currentPack = null;
    var _currentTab  = 'checklist';
    var _page        = 1;
    var _total       = 0;
    var _submitting  = false;
    var _overrideTarget = null;

    // ── DOM Helpers ───────────────────────────────────────────────────────────
    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g,  '&lt;')
            .replace(/>/g,  '&gt;')
            .replace(/"/g,  '&quot;');
    }

    function _setText(id, t) { var el = document.getElementById(id); if (el) el.textContent = t; }
    function _setHTML(id, h) { var el = document.getElementById(id); if (el) el.innerHTML = h; }
    function _val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    function _isChecked(id) { var el = document.getElementById(id); return el ? el.checked : false; }

    // ── Status / Score Helpers ────────────────────────────────────────────────
    function _statusPill(s) {
        var colors = {
            draft:          '#a0aec0',
            review_pending: '#63b3ed',
            approved:       '#68d391',
            completed:      '#38a169',
            cancelled:      '#fc8181',
        };
        var c = colors[s] || '#a0aec0';
        return '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:.78rem;font-weight:700;background:' + c + '22;color:' + c + ';border:1px solid ' + c + '44;">' + _html(PACK_STATUS_LABELS[s] || s) + '</span>';
    }

    function _sourceTypeBadge(t) {
        return '<span style="display:inline-block;padding:2px 9px;border-radius:8px;font-size:.76rem;background:#2d3748;color:#a0aec0;">' + _html(SOURCE_TYPE_LABELS[t] || t) + '</span>';
    }

    function _scoreColor(score) {
        if (score >= 100) return '#68d391';
        if (score >= 75)  return '#faf089';
        if (score >= 50)  return '#f6ad55';
        return '#fc8181';
    }

    function _scorePill(score) {
        var c = _scoreColor(score);
        return '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:.78rem;font-weight:700;background:' + c + '22;color:' + c + ';border:1px solid ' + c + '44;">' + score + '%</span>';
    }

    function _scoreBar(score) {
        var c = _scoreColor(score);
        return '<div style="height:6px;background:#2d3056;border-radius:3px;min-width:60px;">' +
            '<div style="height:6px;border-radius:3px;background:' + c + ';width:' + Math.min(score, 100) + '%;"></div>' +
        '</div>';
    }

    // ── Main Load ─────────────────────────────────────────────────────────────
    function tcLoad() {
        _loadSummary();
        _loadList();
    }

    function _loadSummary() {
        PracticeAPI.fetch(BASE + '/summary')
            .then(function (d) {
                _setText('sc-draft',        String(d.total_draft          || 0));
                _setText('sc-review',       String(d.total_review_pending || 0));
                _setText('sc-approved',     String(d.total_approved       || 0));
                _setText('sc-completed',    String(d.total_completed      || 0));
                _setText('sc-low-score',    String(d.low_score_count      || 0));
                _setText('sc-near-complete',String(d.near_complete_count  || 0));
            })
            .catch(function () { /* non-blocking */ });
    }

    function _loadList() {
        var params = new URLSearchParams();
        var status = _val('fStatus');
        var type   = _val('fSourceType');
        var cid    = _val('fClientId');
        var subId  = _val('fSubmissionId');
        var active = _isChecked('fActiveOnly');

        if (status) params.set('pack_status',   status);
        if (type)   params.set('source_type',   type);
        if (cid)    params.set('client_id',     cid);
        if (subId)  params.set('submission_id', subId);
        if (active) params.set('active_only',   '1');
        params.set('page',     String(_page));
        params.set('per_page', '50');

        _setHTML('packsTable', '<tr><td colspan="8" style="text-align:center;color:#718096;padding:32px;">Loading…</td></tr>');

        PracticeAPI.fetch(BASE + '/?' + params.toString())
            .then(function (d) {
                _total = d.total || 0;
                _renderList(d.packs || [], _total);
                _renderPagination();
            })
            .catch(function () {
                _setHTML('packsTable', '<tr><td colspan="8" style="text-align:center;color:#fc8181;padding:32px;">Failed to load completion packs.</td></tr>');
            });
    }

    function _renderList(packs, total) {
        _setText('listMeta', total + ' pack' + (total !== 1 ? 's' : '') + ' found');

        if (!packs.length) {
            _setHTML('packsTable', '<tr><td colspan="8" style="text-align:center;color:#718096;padding:32px;">No completion packs found.</td></tr>');
            return;
        }

        var rows = packs.map(function (p) {
            var sc = _scoreColor(p.completion_score);
            return '<tr onclick="tcOpenDetail(' + p.id + ')" style="cursor:pointer;">' +
                '<td><span style="color:#718096;font-size:.8rem;">#' + p.id + '</span></td>' +
                '<td>' + _statusPill(p.pack_status) + '</td>' +
                '<td>' + _html(p.client_name || ('#' + p.client_id)) + '</td>' +
                '<td>' + _sourceTypeBadge(p.source_type) + '</td>' +
                '<td>' +
                    '<div style="display:flex;align-items:center;gap:8px;">' +
                        _scoreBar(p.completion_score) +
                        '<span style="color:' + sc + ';font-size:.8rem;font-weight:700;min-width:32px;">' + p.completion_score + '%</span>' +
                    '</div>' +
                '</td>' +
                '<td><span style="color:#718096;font-size:.82rem;">' + (p.submission_id ? '#' + p.submission_id : '—') + '</span></td>' +
                '<td><span style="color:#718096;font-size:.82rem;">' + (p.completion_date || '—') + '</span></td>' +
                '<td><span style="color:#718096;font-size:.82rem;">' + (p.updated_at ? p.updated_at.slice(0, 10) : '—') + '</span></td>' +
            '</tr>';
        }).join('');

        _setHTML('packsTable', rows);
    }

    // ── Pagination ────────────────────────────────────────────────────────────
    function _renderPagination() {
        var perPage = 50;
        var totalPages = Math.max(1, Math.ceil(_total / perPage));
        _setText('pageLabel', 'Page ' + _page + ' of ' + totalPages);
        var first = document.getElementById('btnFirst');
        var prev  = document.getElementById('btnPrev');
        var next  = document.getElementById('btnNext');
        if (first) first.disabled = _page <= 1;
        if (prev)  prev.disabled  = _page <= 1;
        if (next)  next.disabled  = _page >= totalPages;
    }

    function tcPage(p)    { _page = p; _loadList(); }
    function tcPagePrev() { if (_page > 1) { _page--; _loadList(); } }
    function tcPageNext() { _page++; _loadList(); }

    function tcApplyFilters() { _page = 1; _loadList(); }

    function tcFilterStatus(s) {
        var el = document.getElementById('fStatus');
        if (el) el.value = s;
        _page = 1;
        _loadList();
    }

    // ── Create Modal ───────────────────────────────────────────────────────────
    function tcOpenCreate() {
        var params = new URLSearchParams(window.location.search);
        var subId  = params.get('submission_id');
        if (subId) {
            var el = document.getElementById('cSubmissionId');
            if (el) el.value = subId;
        }
        document.getElementById('createModal').classList.add('open');
    }

    function tcCloseCreate() {
        document.getElementById('createModal').classList.remove('open');
    }

    function tcSaveCreate() {
        if (_submitting) return;
        var clientId   = _val('cClientId');
        var sourceType = _val('cSourceType');
        var subId      = _val('cSubmissionId');
        var notes      = _val('cNotes');

        if (!clientId)   { alert('Client ID is required.'); return; }
        if (!sourceType) { alert('Source Type is required.'); return; }

        _submitting = true;
        var url, body;

        if (subId) {
            url  = BASE + '/create-from-submission';
            body = { client_id: parseInt(clientId, 10), source_type: sourceType, submission_id: parseInt(subId, 10) };
        } else {
            url  = BASE + '/';
            body = { client_id: parseInt(clientId, 10), source_type: sourceType, review_notes: notes || null };
        }

        PracticeAPI.fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        })
        .then(function (d) {
            _submitting = false;
            tcCloseCreate();
            tcLoad();
            var packId = (d.pack && d.pack.id) || d.id;
            if (packId) {
                setTimeout(function () { tcOpenDetail(packId); }, 350);
            }
        })
        .catch(function (err) {
            _submitting = false;
            if (err && err.existing_pack_id) {
                if (window.confirm('An active completion pack already exists for this submission. Open it?')) {
                    tcCloseCreate();
                    tcOpenDetail(err.existing_pack_id);
                }
            } else {
                alert('Failed to create pack: ' + ((err && err.error) || 'Unknown error.'));
            }
        });
    }

    // ── Detail Modal ───────────────────────────────────────────────────────────
    function tcOpenDetail(id) {
        _currentId   = id;
        _currentPack = null;
        _currentTab  = 'checklist';
        document.getElementById('detailModal').classList.add('open');
        _setHTML('detailTitle',  'Loading…');
        _setHTML('detailStatus', '');
        _setHTML('detailScore',  '');
        _setHTML('detailTabBar', '');
        _setHTML('detailBody',   '<div style="padding:40px;text-align:center;color:#718096;">Loading…</div>');
        _setHTML('detailFooter', '');

        PracticeAPI.fetch(BASE + '/' + id)
            .then(function (d) {
                _currentPack = d;
                _renderDetail(d);
            })
            .catch(function () {
                _setHTML('detailBody', '<div style="padding:40px;text-align:center;color:#fc8181;">Failed to load completion pack.</div>');
            });
    }

    function tcCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId   = null;
        _currentPack = null;
    }

    function _renderDetail(d) {
        _setText('detailTitle', 'Completion Pack #' + d.id);
        _setHTML('detailStatus', _statusPill(d.pack_status));
        _setHTML('detailScore',  _scorePill(d.completion_score));
        _renderTabBar();
        _activateTab(_currentTab);
        _renderFooter(d);
    }

    function _renderTabBar() {
        var tabs = [
            { key: 'checklist', label: 'Checklist & Status' },
            { key: 'events',    label: 'Events' },
        ];
        _setHTML('detailTabBar', tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="tcOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join(''));
    }

    function tcOpenTab(tab) {
        _currentTab = tab;
        _renderTabBar();
        if (_currentPack) _activateTab(tab);
    }

    function _activateTab(tab) {
        if (tab === 'checklist') _renderChecklistTab(_currentPack);
        else _renderEventsTab(_currentPack.id);
    }

    // ── Checklist Tab ─────────────────────────────────────────────────────────
    function _renderChecklistTab(d) {
        var html = '';

        // Pack overview
        html += '<div class="detail-grid" style="margin-bottom:16px;">' +
            _dRow('Client',       d.client_name || ('#' + d.client_id)) +
            _dRow('Source Type',  SOURCE_TYPE_LABELS[d.source_type] || d.source_type) +
            _dRow('Submission',   d.submission_id ? ('#' + d.submission_id) : '—') +
            _dRow('Status',       PACK_STATUS_LABELS[d.pack_status] || d.pack_status) +
            _dRow('Approved By',  d.approved_by  || '—') +
            _dRow('Approved At',  d.approved_at  ? d.approved_at.slice(0, 10)   : '—') +
            _dRow('Completed On', d.completion_date || '—') +
        '</div>';

        // Completion snapshot (frozen) — shown for completed packs
        if (d.pack_status === 'completed' && d.completion_snapshot) {
            html += _renderSnapshot(d.completion_snapshot);
        }

        // Quality gate — shown for active packs
        if (!TERMINAL_STATUSES.includes(d.pack_status) && d.quality_gate) {
            html += _renderQualityGatePanel(d.quality_gate);
        }

        // Score progress bar
        var sc    = _scoreColor(d.completion_score);
        var items = d.items || [];
        var req   = items.filter(function (i) { return i.required; }).length;
        var done  = items.filter(function (i) { return i.required && i.completed; }).length;

        html += '<div style="margin:14px 0 10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                '<span style="font-size:.83rem;font-weight:600;color:#a0aec0;">Checklist Progress</span>' +
                '<span style="font-size:.83rem;font-weight:700;color:' + sc + ';">' + done + ' / ' + req + ' required • ' + d.completion_score + '%</span>' +
            '</div>' +
            '<div style="height:8px;background:#12122a;border-radius:4px;">' +
                '<div style="height:8px;border-radius:4px;background:' + sc + ';width:' + d.completion_score + '%;transition:width .4s;"></div>' +
            '</div>' +
        '</div>';

        // Checklist items
        html += '<div style="margin:12px 0;">';
        if (!items.length) {
            html += '<div style="padding:20px;text-align:center;background:#12122a;border-radius:8px;color:#718096;">' +
                'No checklist items yet.';
            if (!TERMINAL_STATUSES.includes(d.pack_status)) {
                html += ' <button type="button" onclick="tcGenerateDefaults()" style="color:#5a67d8;background:none;border:none;cursor:pointer;text-decoration:underline;font-size:inherit;">Generate default items</button>';
            }
            html += '</div>';
        } else {
            html += '<div style="display:flex;flex-direction:column;gap:6px;">';
            items.forEach(function (item) {
                var isTerminal = TERMINAL_STATUSES.includes(d.pack_status);
                var bg    = item.completed ? '#1a4d2e' : '#12122a';
                var bdr   = item.completed ? '#276749' : '#2d3056';
                var nameC = item.completed ? '#68d391' : '#e2e8f0';

                html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:' + bg + ';border:1px solid ' + bdr + ';">';

                if (isTerminal) {
                    html += '<span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:.9rem;color:' + nameC + ';">' + (item.completed ? '✓' : '○') + '</span>';
                } else {
                    html += '<button type="button" onclick="tcToggleItem(' + item.id + ')" ' +
                        'style="width:20px;height:20px;border-radius:4px;border:2px solid ' + (item.completed ? '#68d391' : '#4a5568') + ';background:' + (item.completed ? '#68d391' : 'transparent') + ';' +
                        'cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.75rem;color:#1a1a2e;flex-shrink:0;" ' +
                        'title="' + (item.completed ? 'Mark incomplete' : 'Mark complete') + '">' +
                        (item.completed ? '✓' : '') +
                    '</button>';
                }

                html += '<div style="flex:1;">' +
                    '<div style="font-size:.87rem;font-weight:600;color:' + nameC + ';">' +
                        _html(item.item_name) +
                        (item.required
                            ? '<span style="font-size:.71rem;color:#f6ad55;margin-left:6px;font-weight:400;">required</span>'
                            : '<span style="font-size:.71rem;color:#718096;margin-left:6px;font-weight:400;">optional</span>') +
                    '</div>' +
                    (item.notes ? '<div style="font-size:.77rem;color:#718096;margin-top:2px;">' + _html(item.notes) + '</div>' : '') +
                    (item.completed && item.completed_at ? '<div style="font-size:.72rem;color:#4a5568;margin-top:2px;">Completed ' + item.completed_at.slice(0, 10) + '</div>' : '') +
                '</div>';

                if (!isTerminal) {
                    html += '<button type="button" onclick="tcDeleteItem(' + item.id + ')" ' +
                        'style="background:none;border:none;cursor:pointer;color:#4a5568;font-size:.85rem;padding:2px 6px;" ' +
                        'title="Remove item">✕</button>';
                }

                html += '</div>';
            });
            html += '</div>';

            if (!TERMINAL_STATUSES.includes(d.pack_status)) {
                html += '<div style="margin-top:8px;text-align:right;">' +
                    '<button type="button" class="btn-action btn-secondary btn-sm" onclick="tcOpenAddItem()" style="font-size:.79rem;padding:5px 12px;">+ Add Item</button>' +
                '</div>';
            }
        }
        html += '</div>';

        // Inline add-item form (hidden, shown by tcOpenAddItem)
        if (!TERMINAL_STATUSES.includes(d.pack_status)) {
            html += '<div id="addItemForm" style="display:none;background:#12122a;border-radius:8px;padding:14px;margin-top:8px;border:1px solid #2d3056;">' +
                '<div style="font-size:.84rem;font-weight:600;color:#a0aec0;margin-bottom:10px;">Add Checklist Item</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
                    '<div><label class="form-label">Item Type *</label>' +
                        '<select id="aiType" class="form-input" style="width:100%;">' +
                            Object.keys(ITEM_TYPE_LABELS).map(function (k) {
                                return '<option value="' + k + '">' + ITEM_TYPE_LABELS[k] + '</option>';
                            }).join('') +
                        '</select></div>' +
                    '<div><label class="form-label">Item Name *</label>' +
                        '<input type="text" id="aiName" class="form-input" placeholder="e.g. Submission Proof" style="width:100%;"></div>' +
                '</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">' +
                    '<div><label class="form-label">Required?</label>' +
                        '<select id="aiRequired" class="form-input" style="width:100%;">' +
                            '<option value="true">Required</option><option value="false">Optional</option>' +
                        '</select></div>' +
                    '<div><label class="form-label">Notes</label>' +
                        '<input type="text" id="aiNotes" class="form-input" placeholder="Optional" style="width:100%;"></div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                    '<button type="button" class="btn-action btn-secondary btn-sm" onclick="tcCloseAddItem()">Cancel</button>' +
                    '<button type="button" class="btn-action btn-primary btn-sm"   onclick="tcSaveItem()">Add Item</button>' +
                '</div>' +
            '</div>';
        }

        // Partner/review notes
        if (d.partner_notes || d.review_notes) {
            html += '<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">';
            if (d.review_notes) {
                html += '<div style="padding:10px 14px;background:#12122a;border-radius:8px;border-left:3px solid #5a67d8;">' +
                    '<div style="font-size:.72rem;color:#718096;margin-bottom:3px;">Review Notes</div>' +
                    '<div style="font-size:.85rem;color:#e2e8f0;">' + _html(d.review_notes) + '</div>' +
                '</div>';
            }
            if (d.partner_notes) {
                html += '<div style="padding:10px 14px;background:#12122a;border-radius:8px;border-left:3px solid #68d391;">' +
                    '<div style="font-size:.72rem;color:#718096;margin-bottom:3px;">Partner Notes</div>' +
                    '<div style="font-size:.85rem;color:#e2e8f0;">' + _html(d.partner_notes) + '</div>' +
                '</div>';
            }
            html += '</div>';
        }

        _setHTML('detailBody', html);
    }

    function _dRow(label, value) {
        return '<div class="detail-row">' +
            '<span class="detail-label">' + _html(label) + '</span>' +
            '<span class="detail-value">' + _html(String(value != null ? value : '—')) + '</span>' +
        '</div>';
    }

    // ── Quality Gate Panel ────────────────────────────────────────────────────
    function _renderQualityGatePanel(qg) {
        if (!qg) return '';
        var hard     = qg.hard_blocks     || [];
        var soft     = qg.soft_blocks     || [];
        var overrode = qg.soft_overridden || [];
        var applied  = qg.overrides_applied || [];

        if (!hard.length && !soft.length) {
            if (!overrode.length) {
                // All clear
                return '<div style="background:#1a4d2e;border:1px solid #276749;border-radius:8px;padding:12px 16px;margin-bottom:14px;">' +
                    '<div style="color:#68d391;font-size:.87rem;font-weight:700;">✓ Quality Gate Passed</div>' +
                    '<div style="color:#48bb78;font-size:.78rem;margin-top:2px;">All checks clear. Pack is ready for completion.</div>' +
                '</div>';
            }
        }

        var html = '<div style="margin-bottom:14px;">';

        if (hard.length) {
            html += '<div style="background:#3d1515;border:1px solid #742a2a;border-radius:8px;padding:12px 16px;margin-bottom:8px;">';
            html += '<div style="color:#fc8181;font-size:.87rem;font-weight:700;margin-bottom:6px;">⛔ ' + hard.length + ' hard block' + (hard.length > 1 ? 's' : '') + ' — cannot be overridden</div>';
            hard.forEach(function (b) {
                html += '<div style="font-size:.82rem;color:#feb2b2;padding:4px 0 4px 12px;border-left:2px solid #fc8181;margin-bottom:4px;">• ' + _html(b.message) + '</div>';
            });
            html += '</div>';
        }

        if (soft.length) {
            html += '<div style="background:#3d2600;border:1px solid #744210;border-radius:8px;padding:12px 16px;margin-bottom:8px;">';
            html += '<div style="color:#f6ad55;font-size:.87rem;font-weight:700;margin-bottom:6px;">⚠ ' + soft.length + ' soft block' + (soft.length > 1 ? 's' : '') + ' — partner override required</div>';
            soft.forEach(function (b) {
                html += '<div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid #4a3000;">' +
                    '<div style="flex:1;font-size:.82rem;color:#fbd38d;">• ' + _html(b.message) + '</div>' +
                    '<button type="button" onclick="tcOpenOverride(\'' + b.type + '\')" ' +
                        'style="flex-shrink:0;background:#744210;border:1px solid #b7791f;color:#fbd38d;border-radius:6px;padding:4px 10px;font-size:.78rem;cursor:pointer;white-space:nowrap;">' +
                        'Override' +
                    '</button>' +
                '</div>';
            });
            html += '</div>';
        }

        if (overrode.length) {
            html += '<div style="background:#1a2e1a;border:1px solid #276749;border-radius:8px;padding:10px 14px;">';
            html += '<div style="color:#68d391;font-size:.8rem;font-weight:700;margin-bottom:4px;">✓ Overrides applied</div>';
            overrode.forEach(function (b) {
                var ov = applied.find(function (o) { return o.override_type === b.type; });
                html += '<div style="font-size:.78rem;color:#48bb78;padding:2px 0 2px 10px;">• ' +
                    _html(OVERRIDE_LABELS[b.type] || b.type) +
                    (ov ? ' — <em>' + _html(ov.reason) + '</em>' : '') +
                '</div>';
            });
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    // ── Completion Snapshot (frozen state) ────────────────────────────────────
    function _renderSnapshot(snap) {
        if (!snap) return '';
        var html = '<div style="background:#1a2e1a;border:1px solid #276749;border-radius:8px;padding:14px;margin-bottom:16px;">';
        html += '<div style="font-size:.87rem;font-weight:700;color:#68d391;margin-bottom:10px;">✓ Completion Snapshot — Frozen</div>';
        html += '<div style="font-size:.78rem;color:#718096;margin-bottom:8px;">Frozen at: ' + _html(snap.frozen_at ? snap.frozen_at.slice(0, 19).replace('T', ' ') + ' UTC' : '—') + '</div>';

        if (snap.sars_recon_at_completion) {
            var r = snap.sars_recon_at_completion;
            html += '<div style="margin:6px 0;font-size:.82rem;color:#a0aec0;">SARS Recon: ' +
                r.total + ' total — ' +
                '<span style="color:#68d391;">' + r.matched  + ' matched</span>, ' +
                '<span style="color:#fc8181;">' + r.unmatched + ' unmatched</span>, ' +
                '<span style="color:#f6ad55;">' + r.disputed  + ' disputed</span>' +
            '</div>';
        }
        if (snap.payments_at_completion && snap.payments_at_completion.length) {
            html += '<div style="font-size:.82rem;color:#a0aec0;">Payments at completion: ' + snap.payments_at_completion.length + ' record(s)</div>';
        }
        if (snap.disputes_at_completion && snap.disputes_at_completion.length) {
            html += '<div style="font-size:.82rem;color:#a0aec0;">Disputes at completion: ' + snap.disputes_at_completion.length + ' case(s)</div>';
        }
        if (snap.partner_overrides && snap.partner_overrides.length) {
            html += '<div style="font-size:.82rem;color:#f6ad55;margin-top:4px;">Partner overrides: ' +
                snap.partner_overrides.map(function (o) { return OVERRIDE_LABELS[o.override_type] || o.override_type; }).join(', ') +
            '</div>';
        }

        html += '</div>';
        return html;
    }

    // ── Events Tab ────────────────────────────────────────────────────────────
    function _renderEventsTab(packId) {
        _setHTML('detailBody', '<div style="padding:24px;text-align:center;color:#718096;">Loading events…</div>');
        PracticeAPI.fetch(BASE + '/' + packId + '/events')
            .then(function (d) {
                var events = d.events || [];
                if (!events.length) {
                    _setHTML('detailBody', '<div style="padding:24px;text-align:center;color:#718096;">No events yet.</div>');
                    return;
                }
                var html = '<div style="display:flex;flex-direction:column;gap:8px;">';
                events.forEach(function (ev) {
                    html += '<div style="padding:10px 14px;background:#12122a;border-radius:8px;border-left:3px solid #2d3056;">' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                            '<span style="font-size:.82rem;font-weight:700;color:#e2e8f0;">' + _html(ev.event_type.replace(/_/g, ' ')) + '</span>' +
                            '<span style="font-size:.75rem;color:#4a5568;">' + (ev.created_at ? ev.created_at.slice(0, 19).replace('T', ' ') : '') + '</span>' +
                        '</div>' +
                        (ev.old_status || ev.new_status
                            ? '<div style="font-size:.78rem;color:#718096;margin-top:3px;">' +
                                (ev.old_status ? _html(ev.old_status) + ' → ' : '') + _html(ev.new_status || '') +
                              '</div>'
                            : '') +
                        (ev.notes ? '<div style="font-size:.8rem;color:#a0aec0;margin-top:4px;">' + _html(ev.notes) + '</div>' : '') +
                    '</div>';
                });
                html += '</div>';
                _setHTML('detailBody', html);
            })
            .catch(function () {
                _setHTML('detailBody', '<div style="padding:24px;text-align:center;color:#fc8181;">Failed to load events.</div>');
            });
    }

    // ── Detail Footer ─────────────────────────────────────────────────────────
    function _renderFooter(d) {
        var s    = d.pack_status;
        var html = '<button type="button" class="btn-action btn-secondary" onclick="tcCloseDetail()">Close</button>';

        if (s === 'draft') {
            html += ' <button type="button" class="btn-action btn-primary" onclick="tcSubmitReview()">Submit for Review</button>';
            if (!(d.items || []).length) {
                html += ' <button type="button" class="btn-action btn-neutral" onclick="tcGenerateDefaults()">Generate Default Items</button>';
            }
            html += ' <button type="button" class="btn-action btn-danger" onclick="tcCancelPack()">Cancel Pack</button>';
        } else if (s === 'review_pending') {
            html += ' <button type="button" class="btn-action btn-success" onclick="tcApprove()">Approve</button>';
            html += ' <button type="button" class="btn-action btn-danger" onclick="tcCancelPack()">Cancel Pack</button>';
        } else if (s === 'approved') {
            html += ' <button type="button" class="btn-action btn-success" onclick="tcComplete()">Complete</button>';
            html += ' <button type="button" class="btn-action btn-danger" onclick="tcCancelPack()">Cancel Pack</button>';
        }

        if (d.submission_id && s !== 'cancelled') {
            html += ' <a href="/practice/tax-disputes.html?submission_id=' + encodeURIComponent(d.submission_id) + '" ' +
                'style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d3748;color:#e2e8f0;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;" ' +
                'title="View dispute cases for this submission">Open Disputes ↗</a>';
        }

        _setHTML('detailFooter', html);
    }

    // ── Item Actions ──────────────────────────────────────────────────────────
    function tcToggleItem(itemId) {
        if (_submitting || !_currentPack) return;
        var item = (_currentPack.items || []).find(function (i) { return i.id === itemId; });
        if (!item) return;
        _submitting = true;

        PracticeAPI.fetch(BASE + '/' + _currentId + '/items/' + itemId, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ completed: !item.completed }),
        })
        .then(function () { return PracticeAPI.fetch(BASE + '/' + _currentId); })
        .then(function (d) {
            _submitting  = false;
            _currentPack = d;
            _renderDetail(d);
            _loadSummary();
            _loadList();
        })
        .catch(function () {
            _submitting = false;
            alert('Failed to update item.');
        });
    }

    function tcDeleteItem(itemId) {
        if (!window.confirm('Remove this checklist item?')) return;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/items/' + itemId, { method: 'DELETE' })
            .then(function () { return PracticeAPI.fetch(BASE + '/' + _currentId); })
            .then(function (d) {
                _currentPack = d;
                _renderDetail(d);
                _loadList();
            })
            .catch(function () { alert('Failed to remove item.'); });
    }

    function tcOpenAddItem() {
        var el = document.getElementById('addItemForm');
        if (el) el.style.display = '';
    }

    function tcCloseAddItem() {
        var el = document.getElementById('addItemForm');
        if (el) el.style.display = 'none';
    }

    function tcSaveItem() {
        var type     = _val('aiType');
        var name     = _val('aiName');
        var required = document.getElementById('aiRequired') ? document.getElementById('aiRequired').value !== 'false' : true;
        var notes    = _val('aiNotes');

        if (!name) { alert('Item name is required.'); return; }

        PracticeAPI.fetch(BASE + '/' + _currentId + '/items', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ item_type: type, item_name: name, required: required, notes: notes || null }),
        })
        .then(function () { return PracticeAPI.fetch(BASE + '/' + _currentId); })
        .then(function (d) {
            _currentPack = d;
            _renderDetail(d);
            _loadList();
        })
        .catch(function () { alert('Failed to add item.'); });
    }

    function tcGenerateDefaults() {
        if (!_currentId) return;
        if (!window.confirm('Generate default checklist items for this source type? This will fail if items already exist.')) return;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/generate-default-items', { method: 'POST' })
            .then(function () { return PracticeAPI.fetch(BASE + '/' + _currentId); })
            .then(function (d) {
                _currentPack = d;
                _renderDetail(d);
                _loadList();
            })
            .catch(function (err) {
                alert('Failed to generate items: ' + ((err && err.error) || 'Unknown error.'));
            });
    }

    // ── Status Transitions ────────────────────────────────────────────────────
    function _refreshDetail() {
        return PracticeAPI.fetch(BASE + '/' + _currentId)
            .then(function (d) {
                _currentPack = d;
                _renderDetail(d);
                tcLoad();
            });
    }

    function tcSubmitReview() {
        if (!window.confirm('Submit this pack for partner review?')) return;
        if (_submitting) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/submit-review', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        .then(function () { _submitting = false; return _refreshDetail(); })
        .catch(function (err) {
            _submitting = false;
            alert('Failed: ' + ((err && err.error) || 'Unknown error.'));
        });
    }

    function tcApprove() {
        var notes = window.prompt('Optional review notes:');
        if (notes === null) return;
        if (_submitting) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId + '/approve', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ notes: notes || null }),
        })
        .then(function () { _submitting = false; return _refreshDetail(); })
        .catch(function (err) {
            _submitting = false;
            alert('Approval failed: ' + ((err && err.error) || 'Unknown error.'));
        });
    }

    function tcComplete() {
        var summary = window.prompt('Optional completion summary:');
        if (summary === null) return;
        if (_submitting) return;
        _submitting = true;

        PracticeAPI.fetch(BASE + '/' + _currentId + '/complete', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ completion_summary: summary || null }),
        })
        .then(function () {
            _submitting = false;
            return _refreshDetail();
        })
        .catch(function (err) {
            _submitting = false;
            // Quality gate failure — show structured message
            var msg = '';
            if (err && err.hard_blocks && err.hard_blocks.length) {
                msg += '⛔ Hard blocks (cannot override):\n';
                err.hard_blocks.forEach(function (b) { msg += '  • ' + b.message + '\n'; });
                msg += '\n';
            }
            if (err && err.soft_blocks_not_overridden && err.soft_blocks_not_overridden.length) {
                msg += '⚠ Soft blocks (use Override buttons in the Checklist tab):\n';
                err.soft_blocks_not_overridden.forEach(function (b) { msg += '  • ' + b.message + '\n'; });
            }
            if (!msg) msg = (err && err.error) || 'Unknown error.';
            alert('Cannot complete pack:\n\n' + msg);
            // Re-load detail to refresh quality gate display
            PracticeAPI.fetch(BASE + '/' + _currentId)
                .then(function (d) { _currentPack = d; _renderDetail(d); });
        });
    }

    function tcCancelPack() {
        var reason = window.prompt('Reason for cancelling this pack (optional):');
        if (reason === null) return;
        if (_submitting) return;
        _submitting = true;
        PracticeAPI.fetch(BASE + '/' + _currentId, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ reason: reason || null }),
        })
        .then(function () { _submitting = false; return _refreshDetail(); })
        .catch(function (err) {
            _submitting = false;
            alert('Cancel failed: ' + ((err && err.error) || 'Unknown error.'));
        });
    }

    // ── Partner Override Modal ────────────────────────────────────────────────
    function tcOpenOverride(blockType) {
        _overrideTarget = blockType;
        var el = document.getElementById('overrideReason');
        if (el) el.value = '';
        _setText('overrideBlockLabel', OVERRIDE_LABELS[blockType] || blockType);
        document.getElementById('overrideModal').classList.add('open');
    }

    function tcCloseOverride() {
        document.getElementById('overrideModal').classList.remove('open');
        _overrideTarget = null;
    }

    function tcSaveOverride() {
        var reason = _val('overrideReason');
        if (!reason) { alert('A reason is required for a partner override.'); return; }
        if (!_overrideTarget) return;
        if (_submitting) return;
        _submitting = true;

        PracticeAPI.fetch(BASE + '/' + _currentId + '/partner-override', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ override_type: _overrideTarget, reason }),
        })
        .then(function () {
            _submitting = false;
            tcCloseOverride();
            return PracticeAPI.fetch(BASE + '/' + _currentId);
        })
        .then(function (d) {
            _currentPack = d;
            _renderDetail(d);
        })
        .catch(function (err) {
            _submitting = false;
            alert('Override failed: ' + ((err && err.error) || 'Unknown error.'));
        });
    }

    // ── Exports to window ─────────────────────────────────────────────────────
    window.tcLoad            = tcLoad;
    window.tcPage            = tcPage;
    window.tcPagePrev        = tcPagePrev;
    window.tcPageNext        = tcPageNext;
    window.tcApplyFilters    = tcApplyFilters;
    window.tcFilterStatus    = tcFilterStatus;
    window.tcOpenCreate      = tcOpenCreate;
    window.tcCloseCreate     = tcCloseCreate;
    window.tcSaveCreate      = tcSaveCreate;
    window.tcOpenDetail      = tcOpenDetail;
    window.tcCloseDetail     = tcCloseDetail;
    window.tcOpenTab         = tcOpenTab;
    window.tcToggleItem      = tcToggleItem;
    window.tcDeleteItem      = tcDeleteItem;
    window.tcOpenAddItem     = tcOpenAddItem;
    window.tcCloseAddItem    = tcCloseAddItem;
    window.tcSaveItem        = tcSaveItem;
    window.tcGenerateDefaults = tcGenerateDefaults;
    window.tcSubmitReview    = tcSubmitReview;
    window.tcApprove         = tcApprove;
    window.tcComplete        = tcComplete;
    window.tcCancelPack      = tcCancelPack;
    window.tcOpenOverride    = tcOpenOverride;
    window.tcCloseOverride   = tcCloseOverride;
    window.tcSaveOverride    = tcSaveOverride;

    // ── Boot ─────────────────────────────────────────────────────────────────
    LAYOUT.onReady(function () {
        // Pre-fill submission filter from URL if navigated from tax-submissions page
        var params = new URLSearchParams(window.location.search);
        var subId  = params.get('submission_id');
        if (subId) {
            var fSub = document.getElementById('fSubmissionId');
            if (fSub) fSub.value = subId;
        }
        tcLoad();
    });

})();
