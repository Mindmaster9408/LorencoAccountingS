/* Codebox 71 — Practice Engagement Management + Engagement Letter Foundation
 * "Are we formally engaged to perform this work?" NOT document generation.
 * NOT e-signature. NOT automatic proposal acceptance.
 * Prefix: em
 */
(function () {
    'use strict';

    var BASE = '/api/practice/engagement-management';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'all';
    var _detailTab = 'scope';
    var _currentClientId = null;
    var _currentEngagementId = null;
    var _pendingReasonAction = null; // { kind: 'end'|'reject'|'cancel'|'waive', id, letterId }

    var STATUS_LABELS = {
        draft: 'Draft', proposed: 'Proposed', active: 'Active', paused: 'Paused', under_review: 'Under Review',
        renewal_due: 'Renewal Due', renewed: 'Renewed', ended: 'Ended', cancelled: 'Cancelled', rejected: 'Rejected',
    };
    var LETTER_STATUS_LABELS = {
        not_required: 'Not Required', required: 'Required', drafted: 'Drafted', sent: 'Sent',
        signed: 'Signed', waived: 'Waived', expired: 'Expired',
    };
    var LETTER_ITEM_STATUS_LABELS = { draft: 'Draft', sent: 'Sent', signed: 'Signed', waived: 'Waived', expired: 'Expired', archived: 'Archived', cancelled: 'Cancelled' };
    var EV_LABELS = {
        engagement_created: 'Engagement Created', engagement_updated: 'Engagement Updated', engagement_proposed: 'Proposed',
        engagement_activated: 'Activated', engagement_paused: 'Paused', engagement_resumed: 'Resumed',
        engagement_review_started: 'Review Started', engagement_review_completed: 'Review Completed',
        engagement_renewal_due: 'Marked Renewal Due', engagement_renewed: 'Renewed', engagement_ended: 'Ended',
        engagement_cancelled: 'Cancelled', engagement_risk_accepted: 'Risk Accepted',
        letter_created: 'Letter Created', letter_sent: 'Letter Sent', letter_signed: 'Letter Signed', letter_waived: 'Letter Waived', letter_expired: 'Letter Expired',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function emLoadAll() {
        _renderTabBar();
        _loadSummary();
        emLoadAllEngagements();
        _loadClientPicker();
    }

    function _renderTabBar() {
        var tabs = [['all', 'All Engagements'], ['profile', 'Client Profile']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="emSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function emSetTab(tab) { _tab = tab; _renderTabBar(); if (tab === 'all') emLoadAllEngagements(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var cards = [
                    { count: d.engagements_total || 0, label: 'Engagements' },
                    { count: d.active_engagements || 0, label: 'Active' },
                    { count: d.due_for_review || 0, label: 'Due for Review' },
                    { count: d.renewal_due || 0, label: 'Renewal Due' },
                    { count: d.missing_engagement_letters || 0, label: 'Missing Letters' },
                    { count: d.high_risk_without_acceptance || 0, label: 'High Risk, No Acceptance' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientPicker() {
        window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var clients = d.clients || [];
                var opts = '<option value="">Select a client…</option>' + clients.map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
                document.getElementById('clientPicker').innerHTML = opts;
                document.getElementById('cfClient').innerHTML = clients.map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');

                var params = new URLSearchParams(window.location.search);
                var preselect = params.get('client_id');
                if (preselect && clients.some(function (c) { return String(c.id) === preselect; })) {
                    _tab = 'profile'; _renderTabBar();
                    document.getElementById('clientPicker').value = preselect;
                    emOnClientChange();
                }
            })
            .catch(function () {});
    }

    // ── All Engagements ───────────────────────────────────────────────────────

    function emLoadAllEngagements() {
        var status = document.getElementById('fEngagementStatus').value;
        var risk = document.getElementById('fRiskLevel').value;
        var url = BASE + '/';
        var qs = [];
        if (status) qs.push('engagement_status=' + status);
        if (risk) qs.push('risk_level=' + risk);
        if (qs.length) url += '?' + qs.join('&');
        window.PracticeAPI.fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEngagementsTable('allEngagementsBody', d.engagements || [], true); })
            .catch(function () { document.getElementById('allEngagementsBody').innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _renderEngagementsTable(elId, rows, showClient) {
        var el = document.getElementById(elId);
        var cols = showClient ? 7 : 5;
        if (!rows.length) { el.innerHTML = '<tr><td colspan="' + cols + '" class="empty-state">No engagements.</td></tr>'; return; }
        el.innerHTML = rows.map(function (e) {
            return '<tr class="row-clickable" onclick="emOpenDetail(' + e.id + ')">' +
                (showClient ? '<td>' + _html(e.client_name || '—') + '</td>' : '') +
                '<td>' + _html(e.engagement_name) + '</td>' +
                '<td>' + _html(e.engagement_type || '—') + '</td>' +
                '<td><span class="pill es-' + _html(e.engagement_status) + '">' + _html(STATUS_LABELS[e.engagement_status] || e.engagement_status) + '</span></td>' +
                '<td><span class="pill risk-' + _html(e.risk_level) + '">' + _html(e.risk_level) + '</span></td>' +
                '<td><span class="pill ls-' + _html(e.engagement_letter_status) + '">' + _html(LETTER_STATUS_LABELS[e.engagement_letter_status] || e.engagement_letter_status) + '</span></td>' +
                (showClient ? '<td>' + _fmtDate(e.next_review_date) + '</td>' : '') +
                '</tr>';
        }).join('');
    }

    // ── Client Profile ────────────────────────────────────────────────────────

    function emOnClientChange() {
        var val = document.getElementById('clientPicker').value;
        if (!val) { document.getElementById('profileArea').style.display = 'none'; _currentClientId = null; return; }
        _currentClientId = parseInt(val);
        document.getElementById('profileArea').style.display = 'block';
        _loadClientProfile();
    }

    function _loadClientProfile() {
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId + '/profile')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                var services = d.services_covered || [];
                document.getElementById('servicesCovered').innerHTML = services.length
                    ? services.map(function (s) { return '<span class="pill" style="margin-right:6px;">' + _html(s) + '</span>'; }).join('')
                    : '<div class="empty-state">None.</div>';

                var gaps = d.possible_gaps || [];
                document.getElementById('possibleGaps').innerHTML = gaps.length
                    ? gaps.map(function (g) { return '<div class="mini-card flag">' + _html(g.reason) + '</div>'; }).join('')
                    : '<div class="empty-state">None detected.</div>';

                document.getElementById('attentionSummary').innerHTML =
                    '<div class="mini-card">Due for review: <strong>' + (d.due_for_review || []).length + '</strong> &middot; ' +
                    'Renewal due: <strong>' + (d.renewal_due || []).length + '</strong> &middot; ' +
                    'Missing letters: <strong>' + (d.missing_engagement_letters || []).length + '</strong> &middot; ' +
                    'High risk: <strong>' + (d.high_risk_engagements || []).length + '</strong></div>';

                _renderEngagementsTable('clientEngagementsBody', d.engagements || [], false);
            })
            .catch(function () { _showToast('Failed to load client engagement profile.'); });
    }

    // ── Create ────────────────────────────────────────────────────────────────

    function emOpenCreate() {
        document.getElementById('cfClient').disabled = false;
        _resetCreateForm();
        document.getElementById('createModal').classList.add('open');
    }
    function emOpenCreateForClient() {
        _resetCreateForm();
        document.getElementById('cfClient').value = _currentClientId;
        document.getElementById('cfClient').disabled = true;
        document.getElementById('createModal').classList.add('open');
    }
    function _resetCreateForm() {
        document.getElementById('cfName').value = '';
        document.getElementById('cfServiceCategory').value = 'vat';
        document.getElementById('cfEngagementType').value = '';
        document.getElementById('cfRiskLevel').value = 'low';
        document.getElementById('cfFeeBasis').value = '';
        document.getElementById('cfFeeAmount').value = '';
        document.getElementById('cfStartDate').value = '';
        document.getElementById('cfNextReviewDate').value = '';
        document.getElementById('cfScopeSummary').value = '';
    }
    function emCloseCreate() { document.getElementById('createModal').classList.remove('open'); }
    function emSubmitCreate() {
        var payload = {
            client_id: parseInt(document.getElementById('cfClient').value),
            engagement_name: document.getElementById('cfName').value,
            service_category: document.getElementById('cfServiceCategory').value,
            engagement_type: document.getElementById('cfEngagementType').value || null,
            risk_level: document.getElementById('cfRiskLevel').value,
            fee_basis: document.getElementById('cfFeeBasis').value || null,
            fee_amount: document.getElementById('cfFeeAmount').value || null,
            start_date: document.getElementById('cfStartDate').value || null,
            next_review_date: document.getElementById('cfNextReviewDate').value || null,
            scope_summary: document.getElementById('cfScopeSummary').value || null,
        };
        if (!payload.client_id) { _showToast('Client is required.'); return; }
        if (!payload.engagement_name) { _showToast('Engagement name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Engagement created.'); emCloseCreate(); _loadSummary();
                if (_tab === 'all') emLoadAllEngagements();
                if (_tab === 'profile' && _currentClientId) _loadClientProfile();
            })
            .catch(function () { _showToast('Failed to create engagement.'); });
    }

    // ── Detail ────────────────────────────────────────────────────────────────

    function emOpenDetail(id) {
        _currentEngagementId = id;
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderDetail(d);
                document.getElementById('detailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load engagement.'); });
    }
    function emCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _loadSummary();
        if (_tab === 'all') emLoadAllEngagements();
        if (_tab === 'profile' && _currentClientId) _loadClientProfile();
    }

    function _renderDetail(d) {
        var e = d.engagement;
        var html = '<div class="modal-title">' + _html(e.engagement_name) + ' <span class="pill es-' + _html(e.engagement_status) + '">' + _html(STATUS_LABELS[e.engagement_status] || e.engagement_status) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(e.engagement_type || e.service_category) + ' &middot; Risk: ' + _html(e.risk_level) + ' &middot; Letter: ' + _html(LETTER_STATUS_LABELS[e.engagement_letter_status] || e.engagement_letter_status) + '</div>';

        html += _renderActionBar(e);

        html += '<div class="detail-tab-bar" id="detailTabBar"></div>';
        html += '<div class="detail-tab-panel active" id="dpanel-scope">' +
            '<div class="readonly-grid">' +
            '<div class="readonly-field"><div class="rf-label">Fee Basis</div><div class="rf-value">' + _html(e.fee_basis || '—') + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Fee Amount</div><div class="rf-value">' + (e.fee_amount != null ? e.fee_amount : '—') + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Billing Frequency</div><div class="rf-value">' + _html(e.billing_frequency || '—') + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Next Review</div><div class="rf-value">' + _fmtDate(e.next_review_date) + '</div></div>' +
            '<div class="readonly-field"><div class="rf-label">Renewal Date</div><div class="rf-value">' + _fmtDate(e.renewal_date) + '</div></div>' +
            '</div>' +
            (e.scope_summary ? '<div class="mini-card">' + _html(e.scope_summary) + '</div>' : '<div class="empty-state">No scope summary recorded.</div>') +
            '</div>';
        html += '<div class="detail-tab-panel" id="dpanel-risk">' +
            '<div class="mini-card">Risk Level: <span class="pill risk-' + _html(e.risk_level) + '">' + _html(e.risk_level) + '</span></div>' +
            (e.risk_notes ? '<div class="mini-card">' + _html(e.risk_notes) + '</div>' : '') +
            (e.risk_accepted_by ? '<div class="mini-card">Accepted ' + _fmt(e.risk_accepted_at) + '<div class="mini-card-meta">' + _html(e.risk_acceptance_reason || '') + '</div></div>' : '<div class="empty-state">Risk not yet accepted.</div>') +
            '</div>';
        html += '<div class="detail-tab-panel" id="dpanel-letters"><div class="action-bar"><button class="btn-action btn-add" onclick="emOpenLetter()">+ New Letter</button></div><div id="lettersBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-authorizations"><div id="authorizationsLinkedBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-profitability"><div id="profitabilityBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-pricing"><div id="pricingReviewsBody"></div></div>';
        html += '<div class="detail-tab-panel" id="dpanel-events"><div id="detailEventsBody"></div></div>';

        document.getElementById('detailBody').innerHTML = html;
        _detailTab = 'scope';
        _renderDetailTabBar();
        _renderLetters(d.letters || []);
        _loadDetailEvents(e.id);
        _loadLinkedAuthorizations(e.id, e.client_id);
        _loadEngagementProfitability(e.id);
        _loadEngagementPricingReviews(e.id);
    }

    // Codebox 74 — pricing reviews linked to this engagement, reused from
    // Pricing Review (no duplicate workflow logic here). Read-only — creating
    // or actioning a review remains an explicit action on the Pricing
    // Reviews page itself.
    function _loadEngagementPricingReviews(engagementId) {
        var el = document.getElementById('pricingReviewsBody');
        if (!el) return;
        window.PracticeAPI.fetch('/api/practice/pricing-review/?engagement_id=' + engagementId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.reviews || [];
                el.innerHTML = (rows.length ? rows.map(function (r) {
                    return '<div class="mini-card">' + _html(r.review_title) + ' <span class="pill">' + _html(r.pricing_status) + '</span>' +
                        '<div class="mini-card-meta">' + _html(r.review_reason) + '</div></div>';
                }).join('') : '<div class="empty-state">No pricing reviews for this engagement yet.</div>') +
                    '<div style="margin-top:8px;"><a href="/practice/pricing-review.html" class="btn-action btn-secondary" style="text-decoration:none;">Open Pricing Reviews →</a></div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 73 — current-month profitability reused from Profitability (no
    // duplicate margin/realization logic here). Read-only — this tab never
    // saves a snapshot; that remains an explicit action on the Profitability
    // page itself.
    function _loadEngagementProfitability(engagementId) {
        var el = document.getElementById('profitabilityBody');
        if (!el) return;
        var now = new Date();
        var periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        var periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
        window.PracticeAPI.fetch('/api/practice/profitability/engagement/' + engagementId + '?period_start=' + periodStart + '&period_end=' + periodEnd)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { el.innerHTML = '<div class="empty-state">' + _html(d.error) + '</div>'; return; }
                var a = d.analysis;
                el.innerHTML = '<div class="mini-card-meta" style="margin-bottom:8px;">Current month (' + periodStart + ' – ' + periodEnd + ')</div>' +
                    '<div class="mini-card">Status: <span class="pill">' + _html(a.profitability_status) + '</span> &middot; Realization: ' + (a.realization_percentage != null ? a.realization_percentage + '%' : '—') + '</div>' +
                    '<div class="mini-card">Write-off: R' + a.writeoff_value + ' &middot; Unbilled: R' + a.unbilled_value + '</div>' +
                    '<div style="margin-top:8px;"><a href="/practice/profitability.html" class="btn-action btn-secondary" style="text-decoration:none;">Open Profitability →</a></div>';
            })
            .catch(function () { el.innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // Codebox 72 — linked work authorizations reused from Work Authorization
    // (no duplicate scope-check logic here). Filtered client-side to this
    // engagement since GET /work-authorization has no matched_engagement_id
    // filter param.
    function _loadLinkedAuthorizations(engagementId, clientId) {
        window.PracticeAPI.fetch('/api/practice/work-authorization?client_id=' + clientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var linked = (d.authorizations || []).filter(function (a) { return a.matched_engagement_id === engagementId; });
                var el = document.getElementById('authorizationsLinkedBody');
                if (!el) return;
                el.innerHTML = linked.length ? linked.map(function (a) {
                    return '<div class="mini-card">' + _html(a.work_type) + ' <span class="pill">' + _html(a.authorization_status) + '</span>' +
                        '<div class="mini-card-meta">' + _html(a.source_module) + ' / ' + _html(a.source_type) + '</div></div>';
                }).join('') + '<div style="margin-top:8px;"><a href="/practice/work-authorization.html" class="btn-action btn-secondary" style="text-decoration:none;">Open Work Authorization →</a></div>'
                    : '<div class="empty-state">No linked work authorizations.</div>';
            })
            .catch(function () {});
    }

    function _renderActionBar(e) {
        var btns = [];
        if (e.engagement_status === 'draft') btns.push('<button class="btn-action btn-primary" onclick="emAction(\'propose\')">Propose</button>');
        if (e.engagement_status === 'proposed') {
            btns.push('<button class="btn-action btn-success" onclick="emAction(\'activate\')">Activate</button>');
            btns.push('<button class="btn-action btn-danger" onclick="emOpenReason(\'reject\')">Reject</button>');
        }
        if (e.engagement_status === 'active') {
            btns.push('<button class="btn-action btn-secondary" onclick="emAction(\'pause\')">Pause</button>');
            btns.push('<button class="btn-action btn-secondary" onclick="emAction(\'start-review\')">Start Review</button>');
            btns.push('<button class="btn-action btn-secondary" onclick="emAction(\'mark-renewal-due\')">Mark Renewal Due</button>');
        }
        if (e.engagement_status === 'paused') btns.push('<button class="btn-action btn-success" onclick="emAction(\'resume\')">Resume</button>');
        if (e.engagement_status === 'under_review') {
            btns.push('<button class="btn-action btn-success" onclick="emAction(\'complete-review\')">Complete Review</button>');
            btns.push('<button class="btn-action btn-secondary" onclick="emAction(\'mark-renewal-due\')">Mark Renewal Due</button>');
        }
        if (e.engagement_status === 'renewal_due') btns.push('<button class="btn-action btn-success" onclick="emAction(\'renew\')">Renew</button>');
        if (['active', 'paused', 'under_review', 'renewal_due', 'renewed'].indexOf(e.engagement_status) !== -1) {
            btns.push('<button class="btn-action btn-danger" onclick="emOpenReason(\'end\')">End</button>');
        }
        if (['ended', 'cancelled', 'rejected'].indexOf(e.engagement_status) === -1) {
            btns.push('<button class="btn-action btn-danger" onclick="emOpenReason(\'cancel\')">Cancel</button>');
        }
        if (['high', 'critical'].indexOf(e.risk_level) !== -1 && !e.risk_accepted_by) {
            btns.push('<button class="btn-action btn-danger" onclick="emOpenRisk()">Accept Risk</button>');
        }
        return btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';
    }

    function _renderDetailTabBar() {
        var tabs = [['scope', 'Scope'], ['risk', 'Risk'], ['letters', 'Letters'], ['authorizations', 'Authorizations'], ['profitability', 'Profitability'], ['pricing', 'Pricing'], ['events', 'Events']];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="detail-tab-btn' + (t[0] === _detailTab ? ' active' : '') + '" onclick="emSetDetailTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.detail-tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'dpanel-' + _detailTab); });
    }
    function emSetDetailTab(tab) { _detailTab = tab; _renderDetailTabBar(); }

    // ── Actions ───────────────────────────────────────────────────────────────

    function emAction(action) {
        window.PracticeAPI.fetch(BASE + '/' + _currentEngagementId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) {
                    if (d.requires_risk_acceptance) { _showToast(d.error); emOpenRisk(); return; }
                    if (d.requires_letter_resolution) { _showToast(d.error); emSetDetailTab('letters'); _renderDetailTabBar(); return; }
                    _showToast(d.error); return;
                }
                _showToast('Engagement updated.'); emOpenDetail(_currentEngagementId);
            })
            .catch(function () { _showToast('Failed to update engagement.'); });
    }

    function emOpenReason(kind) {
        _pendingReasonAction = { kind: kind };
        document.getElementById('reasonModalTitle').textContent = kind === 'reject' ? 'Reject Engagement' : (kind === 'end' ? 'End Engagement' : 'Cancel Engagement');
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }
    function emCloseReason() { document.getElementById('reasonModal').classList.remove('open'); }
    function emSubmitReason() {
        var reason = document.getElementById('rfReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        var kind = _pendingReasonAction.kind;
        var url, method;
        if (kind === 'cancel') { url = BASE + '/' + _currentEngagementId; method = 'DELETE'; }
        else { url = BASE + '/' + _currentEngagementId + '/' + kind; method = 'PUT'; }
        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Engagement ' + kind + 'ed.'); emCloseReason(); emOpenDetail(_currentEngagementId); })
            .catch(function () { _showToast('Failed to ' + kind + ' engagement.'); });
    }

    function emOpenRisk() { document.getElementById('rkReason').value = ''; document.getElementById('riskModal').classList.add('open'); }
    function emCloseRisk() { document.getElementById('riskModal').classList.remove('open'); }
    function emSubmitRisk() {
        var reason = document.getElementById('rkReason').value;
        if (!reason) { _showToast('A reason is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentEngagementId + '/accept-risk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Risk accepted.'); emCloseRisk(); emOpenDetail(_currentEngagementId); })
            .catch(function () { _showToast('Failed to accept risk.'); });
    }

    // ── Letters ───────────────────────────────────────────────────────────────

    function _renderLetters(rows) {
        document.getElementById('lettersBody').innerHTML = rows.length ? rows.map(function (l) {
            var actions = [];
            if (l.letter_status === 'draft') {
                actions.push('<button class="btn-action btn-primary" onclick="emLetterAction(' + l.id + ',\'send\')">Mark Sent</button>');
                actions.push('<button class="btn-action btn-danger" onclick="emOpenWaive(' + l.id + ')">Waive</button>');
            }
            if (l.letter_status === 'sent') {
                actions.push('<button class="btn-action btn-success" onclick="emLetterAction(' + l.id + ',\'sign\')">Mark Signed</button>');
                actions.push('<button class="btn-action btn-danger" onclick="emOpenWaive(' + l.id + ')">Waive</button>');
            }
            return '<div class="mini-card">' + _html(l.letter_title) + ' <span class="pill ls-' + _html(l.letter_status) + '">' + _html(LETTER_ITEM_STATUS_LABELS[l.letter_status] || l.letter_status) + '</span>' +
                '<div class="mini-card-meta">' + _html(l.letter_reference || '') + '</div>' +
                (actions.length ? '<div class="action-bar" style="margin-top:8px;margin-bottom:0;">' + actions.join('') + '</div>' : '') +
                '</div>';
        }).join('') : '<div class="empty-state">No letters yet.</div>';
    }

    function emOpenLetter() {
        document.getElementById('lfTitle').value = '';
        document.getElementById('lfReference').value = '';
        document.getElementById('lfExpiryDate').value = '';
        document.getElementById('lfNotes').value = '';
        document.getElementById('letterModal').classList.add('open');
    }
    function emCloseLetter() { document.getElementById('letterModal').classList.remove('open'); }
    function emSubmitLetter() {
        var payload = {
            letter_title: document.getElementById('lfTitle').value,
            letter_reference: document.getElementById('lfReference').value || null,
            expiry_date: document.getElementById('lfExpiryDate').value || null,
            notes: document.getElementById('lfNotes').value || null,
        };
        if (!payload.letter_title) { _showToast('Letter title is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/' + _currentEngagementId + '/letters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Letter created.'); emCloseLetter(); emOpenDetail(_currentEngagementId); })
            .catch(function () { _showToast('Failed to create letter.'); });
    }

    function emLetterAction(letterId, action) {
        window.PracticeAPI.fetch(BASE + '/letters/' + letterId + '/' + action, { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Letter ' + action + '.'); emOpenDetail(_currentEngagementId); })
            .catch(function () { _showToast('Failed to update letter.'); });
    }

    var _pendingWaiveLetterId = null;
    function emOpenWaive(letterId) {
        _pendingWaiveLetterId = letterId;
        document.getElementById('reasonModalTitle').textContent = 'Waive Letter';
        _pendingReasonAction = { kind: 'waive-letter' };
        document.getElementById('rfReason').value = '';
        document.getElementById('reasonModal').classList.add('open');
    }

    // Extend the generic reason-modal submit to also cover letter waiving.
    var _origSubmitReason = emSubmitReason;
    function emSubmitReasonDispatch() {
        if (_pendingReasonAction && _pendingReasonAction.kind === 'waive-letter') {
            var reason = document.getElementById('rfReason').value;
            if (!reason) { _showToast('A reason is required.'); return; }
            window.PracticeAPI.fetch(BASE + '/letters/' + _pendingWaiveLetterId + '/waive', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
                .then(function (r) { return r.json(); })
                .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Letter waived.'); emCloseReason(); emOpenDetail(_currentEngagementId); })
                .catch(function () { _showToast('Failed to waive letter.'); });
            return;
        }
        _origSubmitReason();
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function _loadDetailEvents(id) {
        window.PracticeAPI.fetch(BASE + '/' + id + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('detailEventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) + '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('detailEventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.emSetTab = emSetTab;
    window.emLoadAllEngagements = emLoadAllEngagements;
    window.emOnClientChange = emOnClientChange;
    window.emOpenCreate = emOpenCreate;
    window.emOpenCreateForClient = emOpenCreateForClient;
    window.emCloseCreate = emCloseCreate;
    window.emSubmitCreate = emSubmitCreate;
    window.emOpenDetail = emOpenDetail;
    window.emCloseDetail = emCloseDetail;
    window.emSetDetailTab = emSetDetailTab;
    window.emAction = emAction;
    window.emOpenReason = emOpenReason;
    window.emCloseReason = emCloseReason;
    window.emSubmitReason = emSubmitReasonDispatch;
    window.emOpenRisk = emOpenRisk;
    window.emCloseRisk = emCloseRisk;
    window.emSubmitRisk = emSubmitRisk;
    window.emOpenLetter = emOpenLetter;
    window.emCloseLetter = emCloseLetter;
    window.emSubmitLetter = emSubmitLetter;
    window.emLetterAction = emLetterAction;
    window.emOpenWaive = emOpenWaive;

    document.addEventListener('DOMContentLoaded', emLoadAll);
})();
