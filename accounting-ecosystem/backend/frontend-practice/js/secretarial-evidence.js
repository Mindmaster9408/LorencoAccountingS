/* Codebox 66 — Secretarial Document Checklist + Governance Evidence Requests
 * Evidence layer over the existing Document Requests module. Manager-driven.
 * Prefix: se
 */
(function () {
    'use strict';

    var BASE = '/api/practice/secretarial-evidence';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'templates';
    var _currentChecklistId = null;
    var _currentItemId = null;

    var TYPE_LABELS = {
        director_appointment: 'Director Appointment', director_resignation: 'Director Resignation', share_transfer: 'Share Transfer',
        company_name_change: 'Company Name Change', registered_address_change: 'Registered Address Change', beneficial_ownership: 'Beneficial Ownership',
        annual_return: 'Annual Return', resolution: 'Resolution', minutes: 'Minutes', trustee_appointment: 'Trustee Appointment',
        company_secretary: 'Company Secretary', accounting_officer: 'Accounting Officer', auditor: 'Auditor', financial_year_end: 'Financial Year-End', custom: 'Custom',
    };
    var SOURCE_LABELS = { change_case: 'Statutory Change Case', governance_resolution: 'Governance Resolution', governance_meeting: 'Governance Meeting', bo_verification: 'Beneficial Ownership', annual_return: 'Annual Return', manual: 'Manual' };
    var READINESS_LABELS = { ready: 'Ready', partial: 'Partial', incomplete: 'Incomplete', blocked: 'Blocked', unknown: 'Unknown' };
    var ITEM_STATUS_LABELS = { waiting: 'Waiting', requested: 'Requested', received: 'Received', verified: 'Verified', waived: 'Waived', blocked: 'Blocked' };
    var EV_LABELS = {
        template_created: 'Template Created', template_updated: 'Template Updated', template_archived: 'Template Archived',
        checklist_generated: 'Checklist Generated', checklist_regenerated: 'Checklist Regenerated', checklist_updated: 'Checklist Updated',
        item_created: 'Item Created', item_updated: 'Item Updated', item_status_synced: 'Item Status Synced', item_verified: 'Item Verified', item_waived: 'Item Waived',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function seLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientOptions();
        seLoadTemplates();
        seLoadChecklists();
        seLoadEvents();
    }

    function _renderTabBar() {
        var tabs = [['templates', 'Templates'], ['checklists', 'Evidence Checklists'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="seSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function seSetTab(tab) { _tab = tab; _renderTabBar(); }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rd = d.checklists_by_readiness || {};
                var cards = [
                    { count: d.checklists_total || 0, label: 'Checklists' },
                    { count: rd.ready || 0, label: 'Ready' },
                    { count: rd.partial || 0, label: 'Partial' },
                    { count: rd.incomplete || 0, label: 'Incomplete' },
                    { count: rd.blocked || 0, label: 'Blocked' },
                    { count: d.bo_delegated_checklists || 0, label: 'BO-Delegated' },
                    { count: d.items_total || 0, label: 'Evidence Items' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientOptions() {
        window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var sel = document.getElementById('gfClient');
                sel.innerHTML = (d.clients || []).map(function (c) { return '<option value="' + c.id + '">' + _html(c.name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    // ── Templates ─────────────────────────────────────────────────────────────

    function seLoadTemplates() {
        window.PracticeAPI.fetch(BASE + '/templates')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.templates || [];
                if (!rows.length) { document.getElementById('templatesBody').innerHTML = '<tr><td colspan="5" class="empty-state">No templates found.</td></tr>'; return; }
                document.getElementById('templatesBody').innerHTML = rows.map(function (t) {
                    return '<tr><td>' + _html(TYPE_LABELS[t.template_type] || t.template_type) + '</td><td>' + _html(t.template_name) + '</td>' +
                        '<td>' + (t.required_evidence || []).length + '</td>' +
                        '<td><span class="pill ' + (t.is_active ? 'tpl-active' : 'tpl-inactive') + '">' + (t.is_active ? 'Active' : 'Inactive') + '</span></td>' +
                        '<td>' + (t.is_active ? '<button class="btn-action btn-danger" onclick="seArchiveTemplate(' + t.id + ')">Archive</button>' : '') + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('templatesBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }

    function seOpenTemplate() {
        ['tfName', 'tfDescription'].forEach(function (id) { document.getElementById(id).value = ''; });
        document.getElementById('tfRequiredEvidence').value = '[]';
        document.getElementById('templateModal').classList.add('open');
    }
    function seCloseTemplate() { document.getElementById('templateModal').classList.remove('open'); }
    function seSubmitTemplate() {
        var raw = document.getElementById('tfRequiredEvidence').value.trim();
        var requiredEvidence = [];
        if (raw) {
            try { requiredEvidence = JSON.parse(raw); } catch (e) { _showToast('Required Evidence must be valid JSON.'); return; }
        }
        var body = {
            template_type: document.getElementById('tfType').value,
            template_name: document.getElementById('tfName').value,
            description: document.getElementById('tfDescription').value || null,
            required_evidence: requiredEvidence,
        };
        if (!body.template_name) { _showToast('Name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Template created.'); seCloseTemplate(); seLoadTemplates(); })
            .catch(function () { _showToast('Failed to create template.'); });
    }
    function seArchiveTemplate(id) {
        window.PracticeAPI.fetch(BASE + '/templates/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Template archived.'); seLoadTemplates(); })
            .catch(function () { _showToast('Failed to archive.'); });
    }

    // ── Checklists ────────────────────────────────────────────────────────────

    function seLoadChecklists() {
        window.PracticeAPI.fetch(BASE + '/checklists')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.checklists || [];
                if (!rows.length) { document.getElementById('checklistsBody').innerHTML = '<tr><td colspan="5" class="empty-state">No evidence checklists found.</td></tr>'; return; }
                document.getElementById('checklistsBody').innerHTML = rows.map(function (c) {
                    var r = c.readiness || {};
                    var progress = r.delegated_to ? 'Delegated to BO' : (r.done_count || 0) + ' / ' + (r.required_count || 0);
                    return '<tr class="row-clickable" onclick="seOpenChecklistDetail(' + c.id + ')">' +
                        '<td>' + _html(c.client_name) + '</td><td>' + _html(c.title) + '</td><td>' + _html(SOURCE_LABELS[c.source_type] || c.source_type) + '</td>' +
                        '<td><span class="pill rd-' + _html(r.status || 'unknown') + '">' + _html(READINESS_LABELS[r.status] || r.status || 'Unknown') + '</span></td>' +
                        '<td>' + _html(progress) + '</td></tr>';
                }).join('');
            })
            .catch(function () { document.getElementById('checklistsBody').innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load.</td></tr>'; });
    }

    function seOpenGenerateChecklist() { document.getElementById('generateChecklistModal').classList.add('open'); }
    function seCloseGenerateChecklist() { document.getElementById('generateChecklistModal').classList.remove('open'); }
    function seSubmitGenerateChecklist() {
        var body = {
            client_id: document.getElementById('gfClient').value,
            source_type: document.getElementById('gfSourceType').value,
            source_id: document.getElementById('gfSourceId').value || null,
            title: document.getElementById('gfTitle').value || null,
        };
        if (!body.client_id) { _showToast('Client is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/checklists/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Checklist generated.'); seCloseGenerateChecklist(); seLoadChecklists(); _loadSummary(); seOpenChecklistDetail(d.checklist.id); })
            .catch(function () { _showToast('Failed to generate checklist.'); });
    }

    function seOpenChecklistDetail(id) {
        _currentChecklistId = id;
        Promise.all([
            window.PracticeAPI.fetch(BASE + '/checklists/' + id).then(function (r) { return r.json(); }),
            window.PracticeAPI.fetch(BASE + '/checklists/' + id + '/items').then(function (r) { return r.json(); }),
        ]).then(function (results) {
            _renderChecklistDetail(results[0].checklist, results[0].readiness, results[1].items || []);
            document.getElementById('checklistDetailModal').classList.add('open');
        }).catch(function () { _showToast('Failed to load checklist.'); });
    }
    function seCloseChecklistDetail() { document.getElementById('checklistDetailModal').classList.remove('open'); seLoadChecklists(); _loadSummary(); }

    function _renderChecklistDetail(c, readiness, items) {
        var html = '<div class="modal-title">' + _html(c.title) + ' <span class="pill rd-' + _html(readiness.status || 'unknown') + '">' + _html(READINESS_LABELS[readiness.status] || readiness.status) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(SOURCE_LABELS[c.source_type] || c.source_type) + (c.source_id ? ' #' + c.source_id : '') + '</div>';

        html += '<div class="action-bar">' +
            '<button class="btn-action btn-secondary" onclick="seRegenerateChecklist(' + c.id + ')">Regenerate</button>' +
            '</div>';

        if (readiness.delegated_to === 'beneficial_ownership') {
            html += '<div class="mini-card">This checklist is delegated to Beneficial Ownership readiness — see the Beneficial Ownership page for evidence items. No duplicate items are tracked here.</div>';
        } else if (!items.length) {
            html += '<div class="empty-state">No evidence items.</div>';
        } else {
            html += items.map(function (i) {
                var btns = '<button class="btn-action btn-secondary" onclick="seOpenLinkDoc(' + i.id + ')">Link Document</button>';
                if (['received', 'requested'].includes(i.status)) btns += ' <button class="btn-action btn-success" onclick="seOpenVerify(' + i.id + ')">Verify</button>';
                if (i.status !== 'waived') btns += ' <button class="btn-action btn-danger" onclick="seOpenWaive(' + i.id + ')">Waive</button>';
                return '<div class="mini-card">' + _html(i.item_name) + ' <span class="pill is-' + _html(i.status) + '">' + _html(ITEM_STATUS_LABELS[i.status] || i.status) + '</span>' +
                    (i.verification_required ? ' <span class="mini-card-meta">(verification required)</span>' : '') +
                    (i.linked_document_request_id ? '<div class="mini-card-meta">Linked document request #' + i.linked_document_request_id + '</div>' : '') +
                    '<div style="margin-top:6px;">' + btns + '</div></div>';
            }).join('');
        }
        document.getElementById('checklistDetailBody').innerHTML = html;
    }

    function seRegenerateChecklist(id) {
        window.PracticeAPI.fetch(BASE + '/checklists/' + id + '/regenerate', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast((d.created_count || 0) + ' new item(s) added.'); seOpenChecklistDetail(id); })
            .catch(function () { _showToast('Failed to regenerate.'); });
    }

    // ── Item actions ──────────────────────────────────────────────────────────

    function seOpenLinkDoc(itemId) {
        _currentItemId = itemId;
        document.getElementById('ldExistingId').value = '';
        document.getElementById('ldCategory').value = '';
        document.getElementById('linkDocModal').classList.add('open');
    }
    function seCloseLinkDoc() { document.getElementById('linkDocModal').classList.remove('open'); }
    function seSubmitLinkDoc() {
        var existingId = document.getElementById('ldExistingId').value;
        var promise = existingId
            ? window.PracticeAPI.fetch(BASE + '/items/' + _currentItemId + '/link-document-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document_request_id: parseInt(existingId) }) })
            : window.PracticeAPI.fetch(BASE + '/items/' + _currentItemId + '/create-document-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document_category: document.getElementById('ldCategory').value || null }) });
        promise.then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Linked to document request.'); seCloseLinkDoc(); seOpenChecklistDetail(_currentChecklistId); })
            .catch(function () { _showToast('Failed to link.'); });
    }

    function seOpenVerify(itemId) { _currentItemId = itemId; document.getElementById('vfNotes').value = ''; document.getElementById('verifyModal').classList.add('open'); }
    function seCloseVerify() { document.getElementById('verifyModal').classList.remove('open'); }
    function seSubmitVerify() {
        window.PracticeAPI.fetch(BASE + '/items/' + _currentItemId + '/verify', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verification_notes: document.getElementById('vfNotes').value || null }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Evidence verified.'); seCloseVerify(); seOpenChecklistDetail(_currentChecklistId); })
            .catch(function () { _showToast('Failed to verify.'); });
    }

    function seOpenWaive(itemId) { _currentItemId = itemId; document.getElementById('wfReason').value = ''; document.getElementById('waiveModal').classList.add('open'); }
    function seCloseWaive() { document.getElementById('waiveModal').classList.remove('open'); }
    function seSubmitWaive() {
        var reason = document.getElementById('wfReason').value;
        if (!reason) { _showToast('Reason is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/items/' + _currentItemId + '/waive', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Evidence waived.'); seCloseWaive(); seOpenChecklistDetail(_currentChecklistId); })
            .catch(function () { _showToast('Failed to waive.'); });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function seLoadEvents() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('eventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) + ' <span class="mini-card-meta">(' + _html(e.source_type) + ' #' + e.source_id + ')</span>' +
                        '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.seSetTab = seSetTab;
    window.seOpenTemplate = seOpenTemplate;
    window.seCloseTemplate = seCloseTemplate;
    window.seSubmitTemplate = seSubmitTemplate;
    window.seArchiveTemplate = seArchiveTemplate;
    window.seOpenGenerateChecklist = seOpenGenerateChecklist;
    window.seCloseGenerateChecklist = seCloseGenerateChecklist;
    window.seSubmitGenerateChecklist = seSubmitGenerateChecklist;
    window.seOpenChecklistDetail = seOpenChecklistDetail;
    window.seCloseChecklistDetail = seCloseChecklistDetail;
    window.seRegenerateChecklist = seRegenerateChecklist;
    window.seOpenLinkDoc = seOpenLinkDoc;
    window.seCloseLinkDoc = seCloseLinkDoc;
    window.seSubmitLinkDoc = seSubmitLinkDoc;
    window.seOpenVerify = seOpenVerify;
    window.seCloseVerify = seCloseVerify;
    window.seSubmitVerify = seSubmitVerify;
    window.seOpenWaive = seOpenWaive;
    window.seCloseWaive = seCloseWaive;
    window.seSubmitWaive = seSubmitWaive;

    document.addEventListener('DOMContentLoaded', seLoadAll);
})();
