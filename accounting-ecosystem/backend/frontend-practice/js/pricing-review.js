/* Codebox 74 — Practice Pricing Review + Fee Adjustment Workflow
 * "Every pricing decision should be reviewed, justified, approved,
 * documented, auditable." NEVER modifies invoices/accounting/billing/
 * engagements. NEVER suggests a specific fee amount — only a review
 * category and supporting evidence. Pricing remains a partner decision.
 * Prefix: pr
 */
(function () {
    'use strict';

    var BASE = '/api/practice/pricing-review';
    var CLIENTS_BASE = '/api/practice/clients';
    var _currentReviewId = null;
    var _prepared = null;
    var _pendingReasonAction = null;

    var STATUS_LABELS = {
        draft: 'Draft', under_review: 'Under Review', partner_review: 'Partner Review',
        approved: 'Approved', rejected: 'Rejected', implemented: 'Implemented', cancelled: 'Cancelled',
    };
    var REASON_LABELS = {
        profitability: 'Profitability', scope_change: 'Scope Change', inflation: 'Inflation', annual_review: 'Annual Review',
        client_growth: 'Client Growth', service_growth: 'Service Growth', writeoffs: 'Write-Offs',
        low_realization: 'Low Realization', manual: 'Manual', other: 'Other',
    };
    var ITEM_TYPE_LABELS = {
        low_realization: 'Low Realization', high_writeoffs: 'High Write-Offs', scope_creep: 'Scope Creep',
        time_increase: 'Time Increase', new_services: 'New Services', additional_compliance: 'Additional Compliance',
        manual_justification: 'Manual Justification', other: 'Other',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _fmtMoney(n) { return n != null ? 'R' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
    function _fmtFee(basis, amount) {
        if (amount == null && !basis) return '—';
        return (amount != null ? _fmtMoney(amount) : '—') + (basis ? ' (' + _html(basis) + ')' : '');
    }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function prLoadAll() {
        _loadSummary();
        _loadClientPickers().then(_maybeOpenFromQueryString);
        prLoadReviews();
    }

    // Codebox 74 — Profitability's "Create Pricing Review" button hands off
    // client_id/engagement_id via the query string; this opens the create
    // modal prefilled rather than requiring the user to re-select the client.
    function _maybeOpenFromQueryString() {
        var params = new URLSearchParams(window.location.search);
        var clientId = params.get('client_id');
        if (!clientId) return;
        prOpenCreate(clientId, params.get('engagement_id'));
    }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.reviews_total || 0, label: 'Total Reviews' },
                    { count: d.partner_approvals_waiting || 0, label: 'Awaiting Partner' },
                    { count: d.commercial_discussions_pending || 0, label: 'Discussions Pending' },
                    { count: d.approved_not_implemented || 0, label: 'Approved, Not Implemented' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientPickers() {
        return window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var clients = d.clients || [];
                var opts = clients.map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
                document.getElementById('crClient').innerHTML = opts;
                document.getElementById('fClient').innerHTML = '<option value="">All clients</option>' + opts;
            })
            .catch(function () {});
    }

    // ── Reviews list ─────────────────────────────────────────────────────────

    function prLoadReviews() {
        var status = document.getElementById('fStatus').value;
        var clientId = document.getElementById('fClient').value;
        var qs = [];
        if (status) qs.push('pricing_status=' + status);
        if (clientId) qs.push('client_id=' + clientId);
        var url = BASE + '/' + (qs.length ? '?' + qs.join('&') : '');
        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderReviews(d.reviews || []); })
            .catch(function () { document.getElementById('reviewsBody').innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderReviews(rows) {
        var el = document.getElementById('reviewsBody');
        if (!rows.length) { el.innerHTML = '<tr><td colspan="7" class="empty-state">No pricing reviews yet.</td></tr>'; return; }
        el.innerHTML = rows.map(function (r) {
            return '<tr class="row-clickable" onclick="prOpenReview(' + r.id + ')">' +
                '<td>' + _html(r.review_title) + '</td><td>' + _html(r.client_name || '—') + '</td>' +
                '<td>' + _html(REASON_LABELS[r.review_reason] || r.review_reason) + '</td>' +
                '<td><span class="pill prs-' + _html(r.pricing_status) + '">' + _html(STATUS_LABELS[r.pricing_status] || r.pricing_status) + '</span></td>' +
                '<td>' + _fmtFee(r.current_fee_basis, r.current_fee_amount) + '</td>' +
                '<td>' + _fmtFee(r.proposed_fee_basis, r.proposed_fee_amount) + '</td>' +
                '<td>' + _fmtDate(r.effective_date) + '</td></tr>';
        }).join('');
    }

    // ── Create Review ────────────────────────────────────────────────────────

    function prOpenCreate(presetClientId, presetEngagementId) {
        document.getElementById('crEngagementId').value = presetEngagementId || '';
        document.getElementById('crTitle').value = '';
        document.getElementById('crReason').value = 'profitability';
        document.getElementById('crEffectiveDate').value = '';
        document.getElementById('crCurrentFeeGrid').style.display = 'none';
        document.getElementById('crAssumptions').innerHTML = '';
        document.getElementById('crItemsHeading').style.display = 'none';
        document.getElementById('crSuggestedItems').innerHTML = '';
        _prepared = null;
        if (presetClientId) document.getElementById('crClient').value = presetClientId;
        document.getElementById('createModal').classList.add('open');
        if (document.getElementById('crClient').value) prPrepare();
    }
    function prCloseCreate() { document.getElementById('createModal').classList.remove('open'); }

    function prPrepare() {
        var clientId = document.getElementById('crClient').value;
        if (!clientId) return;
        var engagementId = document.getElementById('crEngagementId').value;
        var qs = 'client_id=' + clientId + (engagementId ? '&engagement_id=' + engagementId : '');
        window.PracticeAPI.fetch(BASE + '/prepare?' + qs)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { return; }
                _prepared = d;
                document.getElementById('crReason').value = d.suggested_review_reason || 'manual';

                var feeGrid = document.getElementById('crCurrentFeeGrid');
                if (d.current_fee_amount != null || d.current_fee_basis) {
                    feeGrid.style.display = 'grid';
                    feeGrid.innerHTML =
                        '<div class="readonly-field"><div class="rf-label">Current Fee Basis</div><div class="rf-value">' + _html(d.current_fee_basis || '—') + '</div></div>' +
                        '<div class="readonly-field"><div class="rf-label">Current Fee Amount</div><div class="rf-value">' + _fmtMoney(d.current_fee_amount) + '</div></div>';
                } else {
                    feeGrid.style.display = 'none';
                }

                document.getElementById('crAssumptions').innerHTML = (d.assumptions || []).map(function (a) {
                    return '<div class="mini-card-meta">' + _html(a) + '</div>';
                }).join('');

                var items = d.suggested_review_items || [];
                document.getElementById('crItemsHeading').style.display = items.length ? 'block' : 'none';
                document.getElementById('crSuggestedItems').innerHTML = items.map(function (it, idx) {
                    return '<div class="item-row mini-card"><input type="checkbox" class="cr-item-cb" data-idx="' + idx + '" checked />' +
                        '<div><strong>' + _html(ITEM_TYPE_LABELS[it.item_type] || it.item_type) + ':</strong> ' + _html(it.title) +
                        (it.description ? '<div class="mini-card-meta">' + _html(it.description) + '</div>' : '') + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function prSubmitCreate() {
        var clientId = document.getElementById('crClient').value;
        var title = document.getElementById('crTitle').value;
        if (!clientId) { _showToast('Select a client.'); return; }
        if (!title) { _showToast('Review title is required.'); return; }

        var checkedItems = [];
        if (_prepared && _prepared.suggested_review_items) {
            document.querySelectorAll('.cr-item-cb:checked').forEach(function (cb) {
                var it = _prepared.suggested_review_items[parseInt(cb.getAttribute('data-idx'))];
                if (it) checkedItems.push(it);
            });
        }

        var payload = {
            client_id: parseInt(clientId),
            engagement_id: document.getElementById('crEngagementId').value ? parseInt(document.getElementById('crEngagementId').value) : null,
            review_title: title,
            review_reason: document.getElementById('crReason').value,
            effective_date: document.getElementById('crEffectiveDate').value || null,
            current_fee_basis: _prepared ? (_prepared.current_fee_basis || null) : null,
            current_fee_amount: _prepared ? (_prepared.current_fee_amount || null) : null,
            review_items: checkedItems,
        };
        window.PracticeAPI.fetch(BASE + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Pricing review created.'); prCloseCreate(); _loadSummary(); prLoadReviews(); })
            .catch(function () { _showToast('Failed to create pricing review.'); });
    }

    // ── Detail / Workflow ────────────────────────────────────────────────────

    function prOpenReview(id) {
        _currentReviewId = id;
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderDetail(d.review, d.items || []);
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load review.'); });
    }
    function prCloseDetail() { document.getElementById('detailModal').classList.remove('open'); }

    function _renderDetail(r, items) {
        var html = '<div class="modal-title">' + _html(r.review_title) +
            ' <span class="pill prs-' + _html(r.pricing_status) + '">' + _html(STATUS_LABELS[r.pricing_status] || r.pricing_status) + '</span></div>';

        html += '<div class="readonly-grid">' +
            '<div class="readonly-field"><div class="rf-label">Reason</div><div class="rf-value">' + _html(REASON_LABELS[r.review_reason] || r.review_reason) + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Current Fee</div><div class="rf-value">' + _fmtFee(r.current_fee_basis, r.current_fee_amount) + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Proposed Fee</div><div class="rf-value">' + _fmtFee(r.proposed_fee_basis, r.proposed_fee_amount) + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Effective Date</div><div class="rf-value">' + _fmtDate(r.effective_date) + '</div></div>' +
            '</div>';

        if (r.partner_notes) html += '<div class="mini-card">Partner notes: ' + _html(r.partner_notes) + '</div>';
        if (r.client_discussion_notes) html += '<div class="mini-card">Client discussion: ' + _html(r.client_discussion_notes) + '</div>';
        if (r.internal_notes) html += '<div class="mini-card">Internal notes: ' + _html(r.internal_notes) + '</div>';
        if (r.rejection_reason) html += '<div class="mini-card flag">Rejected: ' + _html(r.rejection_reason) + '</div>';
        if (r.cancellation_reason) html += '<div class="mini-card flag">Cancelled: ' + _html(r.cancellation_reason) + '</div>';
        if (r.approval_notes) html += '<div class="mini-card">Approval notes: ' + _html(r.approval_notes) + '</div>';

        html += '<div class="section-heading">Evidence Items</div>';
        html += items.length ? items.map(function (it) {
            return '<div class="mini-card"><strong>' + _html(ITEM_TYPE_LABELS[it.item_type] || it.item_type) + ':</strong> ' + _html(it.title) +
                (it.description ? '<div class="mini-card-meta">' + _html(it.description) + '</div>' : '') +
                (it.supporting_value != null ? '<div class="mini-card-meta">Value: ' + _html(it.supporting_value) + '</div>' : '') + '</div>';
        }).join('') : '<div class="empty-state">No evidence items yet.</div>';
        var terminal = ['implemented', 'rejected', 'cancelled'].indexOf(r.pricing_status) !== -1;
        if (!terminal) html += '<div class="action-bar"><button class="btn-action btn-secondary" onclick="prOpenItem()">Add Evidence Item</button></div>';

        html += _renderActionBar(r);
        document.getElementById('detailBody').innerHTML = html;
    }

    function _renderActionBar(r) {
        var btns = [];
        if (r.pricing_status === 'draft') btns.push('<button class="btn-action btn-primary" onclick="prAction(\'submit\')">Submit for Review</button>');
        if (r.pricing_status === 'under_review') btns.push('<button class="btn-action btn-primary" onclick="prAction(\'partner-review\')">Send to Partner</button>');
        if (r.pricing_status === 'partner_review') btns.push('<button class="btn-action btn-success" onclick="prAction(\'approve\')">Approve</button>');
        if (['under_review', 'partner_review'].indexOf(r.pricing_status) !== -1) btns.push('<button class="btn-action btn-danger" onclick="prOpenReason(\'reject\')">Reject</button>');
        if (r.pricing_status === 'approved') btns.push('<button class="btn-action btn-success" onclick="prAction(\'implement\')">Mark Implemented</button>');
        if (['draft', 'under_review', 'partner_review', 'approved'].indexOf(r.pricing_status) !== -1) btns.push('<button class="btn-action btn-secondary" onclick="prOpenReason(\'cancel\', true)">Cancel</button>');
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function prAction(action) {
        window.PracticeAPI.fetch(BASE + '/' + _currentReviewId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                if (d.partner_approval_unverified) _showToast('Approved — note: approver is not recorded as a partner role.');
                else _showToast('Review updated.');
                prOpenReview(_currentReviewId); _loadSummary(); prLoadReviews();
            })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    function prOpenReason(action, isDelete) {
        _pendingReasonAction = { action: action, isDelete: !!isDelete };
        document.getElementById('reasonModalTitle').textContent = action === 'reject' ? 'Reject Review' : 'Cancel Review';
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }
    function prCloseReason() { document.getElementById('reasonModal').classList.remove('open'); }
    function prSubmitReason() {
        var reason = document.getElementById('rfReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        var a = _pendingReasonAction;
        var url = a.isDelete ? (BASE + '/' + _currentReviewId) : (BASE + '/' + _currentReviewId + '/' + a.action);
        var method = a.isDelete ? 'DELETE' : 'PUT';
        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Review updated.'); prCloseReason(); prOpenReview(_currentReviewId); _loadSummary(); prLoadReviews(); })
            .catch(function () { _showToast('Failed to update review.'); });
    }

    // ── Evidence items ───────────────────────────────────────────────────────

    function prOpenItem() {
        document.getElementById('itType').value = 'manual_justification';
        document.getElementById('itTitle').value = '';
        document.getElementById('itDescription').value = '';
        document.getElementById('itSupportingValue').value = '';
        document.getElementById('itemModal').classList.add('open');
    }
    function prCloseItem() { document.getElementById('itemModal').classList.remove('open'); }
    function prSubmitItem() {
        var title = document.getElementById('itTitle').value;
        if (!title) { _showToast('Item title is required.'); return; }
        var payload = {
            item_type: document.getElementById('itType').value,
            title: title,
            description: document.getElementById('itDescription').value || null,
            supporting_value: document.getElementById('itSupportingValue').value || null,
        };
        window.PracticeAPI.fetch(BASE + '/' + _currentReviewId + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Evidence item added.'); prCloseItem(); prOpenReview(_currentReviewId); })
            .catch(function () { _showToast('Failed to add item.'); });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.prLoadReviews = prLoadReviews;
    window.prOpenCreate = prOpenCreate;
    window.prCloseCreate = prCloseCreate;
    window.prPrepare = prPrepare;
    window.prSubmitCreate = prSubmitCreate;
    window.prOpenReview = prOpenReview;
    window.prCloseDetail = prCloseDetail;
    window.prAction = prAction;
    window.prOpenReason = prOpenReason;
    window.prCloseReason = prCloseReason;
    window.prSubmitReason = prSubmitReason;
    window.prOpenItem = prOpenItem;
    window.prCloseItem = prCloseItem;
    window.prSubmitItem = prSubmitItem;

    document.addEventListener('DOMContentLoaded', prLoadAll);
})();
