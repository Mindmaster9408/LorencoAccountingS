/* =============================================================
   Document Request Tracker — Lorenco Practice (Codebox 23)
   IIFE module. No localStorage for business data.
   ============================================================= */
(function () {
    'use strict';

    var BASE = '/api/practice/document-requests';

    var _allRequests        = [];
    var _clients            = [];
    var _members            = [];
    var _submitting         = false;
    var _clSubmitting       = false;
    var _applySubmitting    = false;
    var _checklistVisible   = false;
    var _checklistLoaded    = false;
    var _applyingId         = null;
    var _viewingReq         = null;

    var CAT_LABEL = {
        identity: 'Identity', tax: 'Tax', vat: 'VAT', payroll: 'Payroll',
        accounting: 'Accounting', banking: 'Banking', cipc: 'CIPC',
        trust: 'Trust', legal: 'Legal', compliance: 'Compliance',
        financials: 'Financials', supporting_docs: 'Supporting Docs', custom: 'Custom',
    };

    var STATUS_LABEL = {
        requested: 'Requested', reminder_sent: 'Reminder Sent',
        partially_received: 'Partial', received: 'Received',
        waived: 'Waived', cancelled: 'Cancelled',
    };

    var STATUS_CLS = {
        requested:          'drs-requested',
        reminder_sent:      'drs-reminder',
        partially_received: 'drs-partial',
        received:           'drs-received',
        waived:             'drs-waived',
        cancelled:          'drs-cancelled',
    };

    // ── Escape helper ─────────────────────────────────────────────────────────

    function esc(s) {
        if (!s) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function showEl(id)  { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hideEl(id)  { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }
    function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

    // ── Summary ───────────────────────────────────────────────────────────────

    function loadSummary() {
        return PracticeAPI.fetch(BASE + '/summary')
            .then(function (d) { renderSummary(d.summary || {}); })
            .catch(function () {});
    }

    function renderSummary(s) {
        setText('sumDrTotal',       s.total_active   ?? '—');
        setText('sumDrOutstanding', s.outstanding    ?? '—');
        setText('sumDrOverdue',     s.overdue        ?? '—');
        setText('sumDrWeek',        s.due_this_week  ?? '—');
        setText('sumDrReceived',    s.received       ?? '—');
    }

    // ── Clients + Members ─────────────────────────────────────────────────────

    function loadClients() {
        return PracticeAPI.fetch('/api/practice/clients?is_active=true')
            .then(function (d) {
                _clients = d.clients || [];
                var opts = '<option value="">— Select client —</option>';
                _clients.forEach(function (c) {
                    opts += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
                });
                ['drCClient', 'drApplyClient'].forEach(function (id) {
                    var el = document.getElementById(id);
                    if (el) el.innerHTML = opts;
                });
                // Filter dropdown
                var filt = document.getElementById('drFilterClient');
                if (filt) {
                    var fopts = '<option value="">All Clients</option>';
                    _clients.forEach(function (c) {
                        fopts += '<option value="' + c.id + '">' + esc(c.name) + '</option>';
                    });
                    filt.innerHTML = fopts;
                }
                // Pre-select client from URL param
                var params = new URLSearchParams(window.location.search);
                var cid = params.get('client_id');
                if (cid) {
                    var el2 = document.getElementById('drFilterClient');
                    if (el2) { el2.value = cid; applyDrFilters(); }
                }
            })
            .catch(function () {});
    }

    function loadMembers() {
        return PracticeAPI.fetch('/api/practice/team?active=true')
            .then(function (d) {
                _members = d.members || [];
                var opts = '<option value="">Unassigned</option>';
                _members.forEach(function (m) {
                    opts += '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
                });
                var el = document.getElementById('drCAssignee');
                if (el) el.innerHTML = opts;
            })
            .catch(function () {});
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function loadRequests() {
        showEl('drListLoading');
        hideEl('drListWrap');
        hideEl('drListEmpty');
        hideEl('drListError');

        return PracticeAPI.fetch(BASE + '?limit=200')
            .then(function (d) {
                _allRequests = d.document_requests || [];
                hideEl('drListLoading');
                applyDrFilters();
            })
            .catch(function (e) {
                hideEl('drListLoading');
                var errEl = document.getElementById('drListError');
                if (errEl) { errEl.textContent = 'Failed to load document requests.'; showEl('drListError'); }
            });
    }

    function applyDrFilters() {
        var status   = (document.getElementById('drFilterStatus')   || {}).value || '';
        var category = (document.getElementById('drFilterCategory') || {}).value || '';
        var clientId = (document.getElementById('drFilterClient')   || {}).value || '';
        var search   = ((document.getElementById('drFilterSearch')  || {}).value || '').toLowerCase();
        var today    = new Date().toISOString().split('T')[0];

        var results = _allRequests.filter(function (r) {
            if (status === 'outstanding') {
                if (!['requested', 'reminder_sent', 'partially_received'].includes(r.request_status)) return false;
            } else if (status && r.request_status !== status) {
                return false;
            }
            if (category && r.document_category !== category)   return false;
            if (clientId && String(r.client_id) !== clientId)   return false;
            if (search) {
                var name = (r.practice_clients && r.practice_clients.name) ? r.practice_clients.name.toLowerCase() : '';
                if (!(r.request_title || '').toLowerCase().includes(search) &&
                    !(r.document_type || '').toLowerCase().includes(search) &&
                    !name.includes(search)) return false;
            }
            return true;
        });

        renderRequests(results, today);
    }

    function renderRequests(reqs, today) {
        var body = document.getElementById('drListBody');
        if (!body) return;

        if (reqs.length === 0) {
            hideEl('drListWrap');
            showEl('drListEmpty');
            return;
        }
        showEl('drListWrap');
        hideEl('drListEmpty');

        body.innerHTML = reqs.map(function (r) {
            var outstanding = ['requested', 'reminder_sent', 'partially_received'].includes(r.request_status);
            var isOverdue   = r.is_overdue || (outstanding && r.required_by_date && r.required_by_date < today);
            var rowCls      = isOverdue ? 'docreq-row--overdue' : '';
            var statusCls   = STATUS_CLS[r.request_status] || '';
            var statusLabel = STATUS_LABEL[r.request_status] || r.request_status;
            var catLabel    = CAT_LABEL[r.document_category] || r.document_category;
            var clientName  = r.practice_clients ? r.practice_clients.name : '—';
            var dueStr      = r.required_by_date || '';
            var reminderBadge = r.reminder_count > 0 ? ' <span class="docreq-rem-count">' + r.reminder_count + '×</span>' : '';

            var actionBtns = '';
            if (outstanding) {
                actionBtns += '<button type="button" class="btn btn-xs btn-ghost" title="Mark received" onclick="drMarkReceived(' + r.id + ')">✓</button> ';
                actionBtns += '<button type="button" class="btn btn-xs btn-ghost" title="Log reminder" onclick="drMarkReminder(' + r.id + ')">🔔</button> ';
            }
            actionBtns += '<button type="button" class="btn btn-xs btn-ghost" onclick="openDrViewModal(' + r.id + ')">View</button>';

            return '<tr class="' + rowCls + '">' +
                '<td><span class="docreq-cat-badge">' + esc(catLabel) + '</span></td>' +
                '<td>' +
                    '<div class="docreq-title-cell">' + esc(r.request_title) + '</div>' +
                    (r.document_type ? '<div class="docreq-type-cell">' + esc(r.document_type) + '</div>' : '') +
                '</td>' +
                '<td class="docreq-client-cell">' + esc(clientName) + '</td>' +
                '<td class="docreq-due-cell">' + (dueStr ? esc(dueStr) : '<span class="col-muted">—</span>') + '</td>' +
                '<td><span class="docreq-status-badge ' + statusCls + '">' + esc(statusLabel) + '</span>' + reminderBadge + '</td>' +
                '<td class="docreq-actions-cell">' + actionBtns + '</td>' +
            '</tr>';
        }).join('');
    }

    // ── Create request ────────────────────────────────────────────────────────

    function openDrCreateModal() {
        document.getElementById('drCTitle').value       = '';
        document.getElementById('drCDocType').value     = '';
        document.getElementById('drCCategory').value    = '';
        document.getElementById('drCRequiredBy').value  = '';
        document.getElementById('drCNotes').value       = '';
        hideEl('drCreateError');
        _submitting = false;
        document.getElementById('drCreateSubmitBtn').disabled = false;
        showEl('drCreateModal');
    }

    function closeDrCreateModal() { hideEl('drCreateModal'); }

    function submitDrCreate() {
        if (_submitting) return;
        var client   = (document.getElementById('drCClient')   || {}).value;
        var category = (document.getElementById('drCCategory') || {}).value;
        var title    = ((document.getElementById('drCTitle')   || {}).value || '').trim();

        hideEl('drCreateError');
        if (!client)   return showError('drCreateError', 'Please select a client.');
        if (!category) return showError('drCreateError', 'Please select a document category.');
        if (!title)    return showError('drCreateError', 'Request title is required.');

        _submitting = true;
        document.getElementById('drCreateSubmitBtn').disabled = true;

        var payload = {
            client_id:              parseInt(client),
            request_title:          title,
            document_category:      category,
            document_type:          ((document.getElementById('drCDocType')    || {}).value || '').trim() || null,
            required_by_date:       (document.getElementById('drCRequiredBy') || {}).value || null,
            assigned_team_member_id: +(document.getElementById('drCAssignee').value) || null,
            notes:                  ((document.getElementById('drCNotes')      || {}).value || '').trim() || null,
        };

        PracticeAPI.fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                _submitting = false;
                closeDrCreateModal();
                Promise.all([loadSummary(), loadRequests()]);
            })
            .catch(function (e) {
                _submitting = false;
                document.getElementById('drCreateSubmitBtn').disabled = false;
                showError('drCreateError', e.message || 'Failed to create request.');
            });
    }

    // ── View modal ────────────────────────────────────────────────────────────

    function openDrViewModal(id) {
        var r = _allRequests.find(function (x) { return x.id === id; });
        if (!r) return;
        _viewingReq = r;

        var today       = new Date().toISOString().split('T')[0];
        var outstanding = ['requested', 'reminder_sent', 'partially_received'].includes(r.request_status);
        var isOverdue   = r.is_overdue || (outstanding && r.required_by_date && r.required_by_date < today);
        var catLabel    = CAT_LABEL[r.document_category]  || r.document_category;
        var statusLabel = STATUS_LABEL[r.request_status]  || r.request_status;
        var statusCls   = STATUS_CLS[r.request_status]    || '';
        var clientName  = r.practice_clients ? r.practice_clients.name : '—';
        var assigneeName = r.assignee ? r.assignee.display_name : '—';

        document.getElementById('drViewTitle').textContent = r.request_title;

        var bodyHtml =
            '<div class="view-row"><div class="view-label">Client</div><div class="view-val">'      + esc(clientName)   + '</div></div>' +
            '<div class="view-row"><div class="view-label">Status</div><div class="view-val"><span class="docreq-status-badge ' + statusCls + '">' + esc(statusLabel) + '</span>' + (isOverdue ? ' <span class="docreq-overdue-tag">OVERDUE</span>' : '') + '</div></div>' +
            '<div class="view-row"><div class="view-label">Category</div><div class="view-val">'    + esc(catLabel)     + '</div></div>' +
            (r.document_type ? '<div class="view-row"><div class="view-label">Doc Type</div><div class="view-val">' + esc(r.document_type) + '</div></div>' : '') +
            '<div class="view-row"><div class="view-label">Required By</div><div class="view-val">' + esc(r.required_by_date || '—') + '</div></div>' +
            '<div class="view-row"><div class="view-label">Assigned</div><div class="view-val">'    + esc(assigneeName) + '</div></div>' +
            '<div class="view-row"><div class="view-label">Reminders</div><div class="view-val">'   + (r.reminder_count || 0) + (r.last_reminder_at ? ' (last: ' + esc(r.last_reminder_at.slice(0, 10)) + ')' : '') + '</div></div>' +
            (r.notes ? '<div class="view-body">' + esc(r.notes) + '</div>' : '') +
            (r.internal_notes ? '<div class="view-body" style="margin-top:6px;"><em>Internal:</em> ' + esc(r.internal_notes) + '</div>' : '');

        document.getElementById('drViewBody').innerHTML = bodyHtml;

        var footerHtml = '';
        if (outstanding) {
            footerHtml += '<button type="button" class="btn btn-primary" onclick="drMarkReceived(' + r.id + ', true)">✓ Mark Received</button> ';
            footerHtml += '<button type="button" class="btn btn-ghost" onclick="drMarkReminder(' + r.id + ', true)">🔔 Reminder Sent</button> ';
            footerHtml += '<button type="button" class="btn btn-ghost" onclick="drWaive(' + r.id + ', true)">Waive</button> ';
        }
        footerHtml += '<button type="button" class="btn btn-ghost btn-danger" onclick="drDelete(' + r.id + ', true)">Delete</button>';
        footerHtml += '<button type="button" class="btn btn-ghost" onclick="closeDrViewModal()" style="margin-left:auto;">Close</button>';

        document.getElementById('drViewFooter').innerHTML = footerHtml;
        showEl('drViewModal');
    }

    function closeDrViewModal() { hideEl('drViewModal'); _viewingReq = null; }

    // ── Action helpers ────────────────────────────────────────────────────────

    function drMarkReceived(id, fromView) {
        PracticeAPI.fetch(BASE + '/' + id + '/received', { method: 'PUT' })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                if (fromView) closeDrViewModal();
                Promise.all([loadSummary(), loadRequests()]);
            })
            .catch(function (e) { alert('Could not mark received: ' + (e.message || 'Error')); });
    }

    function drMarkReminder(id, fromView) {
        PracticeAPI.fetch(BASE + '/' + id + '/reminder-sent', { method: 'PUT' })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                if (fromView) closeDrViewModal();
                Promise.all([loadSummary(), loadRequests()]);
            })
            .catch(function (e) { alert('Could not log reminder: ' + (e.message || 'Error')); });
    }

    function drWaive(id, fromView) {
        if (!confirm('Mark this document request as waived? It will no longer appear in outstanding requests.')) return;
        PracticeAPI.fetch(BASE + '/' + id + '/waive', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                if (fromView) closeDrViewModal();
                Promise.all([loadSummary(), loadRequests()]);
            })
            .catch(function (e) { alert('Could not waive: ' + (e.message || 'Error')); });
    }

    function drDelete(id, fromView) {
        if (!confirm('Cancel this document request? It will be removed from the list.')) return;
        PracticeAPI.fetch(BASE + '/' + id, { method: 'DELETE' })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                if (fromView) closeDrViewModal();
                Promise.all([loadSummary(), loadRequests()]);
            })
            .catch(function (e) { alert('Could not delete: ' + (e.message || 'Error')); });
    }

    // ── Checklists (lazy-loaded on toggle) ───────────────────────────────────

    function toggleDrChecklists() {
        _checklistVisible = !_checklistVisible;
        var panel = document.getElementById('drChecklistPanel');
        if (!panel) return;
        if (_checklistVisible) {
            panel.classList.remove('hidden');
            if (!_checklistLoaded) loadChecklists();
        } else {
            panel.classList.add('hidden');
        }
    }

    function loadChecklists() {
        showEl('drChecklistLoading');
        hideEl('drChecklistEmpty');
        document.getElementById('drChecklistGrid').innerHTML = '';

        PracticeAPI.fetch(BASE + '/checklists')
            .then(function (d) {
                _checklistLoaded = true;
                hideEl('drChecklistLoading');
                var cls = d.checklists || [];
                if (cls.length === 0) { showEl('drChecklistEmpty'); return; }
                renderChecklists(cls);
            })
            .catch(function () {
                hideEl('drChecklistLoading');
                document.getElementById('drChecklistGrid').innerHTML = '<div class="error-banner">Could not load checklists.</div>';
            });
    }

    function renderChecklists(cls) {
        var grid = document.getElementById('drChecklistGrid');
        if (!grid) return;
        grid.innerHTML = cls.map(function (cl) {
            return '<div class="docreq-cl-card">' +
                '<div class="docreq-cl-name">' + esc(cl.checklist_name) + '</div>' +
                '<div class="docreq-cl-cat">' + esc(cl.category) + '</div>' +
                (cl.description ? '<div class="docreq-cl-desc">' + esc(cl.description) + '</div>' : '') +
                '<button type="button" class="btn btn-primary btn-sm docreq-cl-apply" onclick="openDrApplyModal(' + cl.id + ', \'' + esc(cl.checklist_name) + '\', \'' + esc(cl.description || '') + '\')">Apply to Client</button>' +
            '</div>';
        }).join('');
    }

    // ── Create checklist modal ────────────────────────────────────────────────

    function openCreateChecklistModal() {
        document.getElementById('clName').value     = '';
        document.getElementById('clCategory').value = 'custom';
        document.getElementById('clDesc').value     = '';
        hideEl('clCreateError');
        _clSubmitting = false;
        document.getElementById('clCreateSubmitBtn').disabled = false;
        showEl('drNewChecklistModal');
    }

    function closeCreateChecklistModal() { hideEl('drNewChecklistModal'); }

    function submitCreateChecklist() {
        if (_clSubmitting) return;
        var name = ((document.getElementById('clName') || {}).value || '').trim();
        if (!name) return showError('clCreateError', 'Checklist name is required.');

        _clSubmitting = true;
        document.getElementById('clCreateSubmitBtn').disabled = true;
        hideEl('clCreateError');

        var payload = {
            checklist_name: name,
            category:       (document.getElementById('clCategory') || {}).value || 'custom',
            description:    ((document.getElementById('clDesc')    || {}).value || '').trim() || null,
        };

        PracticeAPI.fetch(BASE + '/checklists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                _clSubmitting = false;
                closeCreateChecklistModal();
                _checklistLoaded = false;
                loadChecklists();
            })
            .catch(function (e) {
                _clSubmitting = false;
                document.getElementById('clCreateSubmitBtn').disabled = false;
                showError('clCreateError', e.message || 'Failed to create checklist.');
            });
    }

    // ── Apply checklist modal ─────────────────────────────────────────────────

    function openDrApplyModal(checklistId, name, desc) {
        _applyingId = checklistId;
        document.getElementById('drApplyTitle').textContent = 'Apply: ' + name;
        document.getElementById('drApplyDesc').textContent  = desc || 'Creates one document request per checklist item for the selected client.';
        document.getElementById('drApplyDue').value         = '';
        hideEl('drApplyError');
        _applySubmitting = false;
        document.getElementById('drApplySubmitBtn').disabled = false;
        showEl('drApplyModal');
    }

    function closeDrApplyModal() { hideEl('drApplyModal'); _applyingId = null; }

    function submitDrApply() {
        if (_applySubmitting || !_applyingId) return;
        var client = (document.getElementById('drApplyClient') || {}).value;
        if (!client) return showError('drApplyError', 'Please select a client.');

        _applySubmitting = true;
        document.getElementById('drApplySubmitBtn').disabled = true;
        hideEl('drApplyError');

        var payload = {
            client_id:       parseInt(client),
            required_by_date: (document.getElementById('drApplyDue') || {}).value || null,
        };

        PracticeAPI.fetch(BASE + '/checklists/' + _applyingId + '/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
            .then(function (d) {
                if (d.error) throw new Error(d.error);
                _applySubmitting = false;
                closeDrApplyModal();
                alert(d.created + ' document request(s) created successfully.');
                Promise.all([loadSummary(), loadRequests()]);
            })
            .catch(function (e) {
                _applySubmitting = false;
                document.getElementById('drApplySubmitBtn').disabled = false;
                showError('drApplyError', e.message || 'Failed to apply checklist.');
            });
    }

    // ── Error helper ──────────────────────────────────────────────────────────

    function showError(id, msg) {
        var el = document.getElementById(id);
        if (el) { el.textContent = msg; el.classList.remove('hidden'); }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        PracticeAuth.requireAuth().then(function () {
            LAYOUT.init('documents');
            Promise.all([loadClients(), loadMembers()])
                .then(function () {
                    return Promise.all([loadSummary(), loadRequests()]);
                });
        });
    }

    document.addEventListener('DOMContentLoaded', init);

    // ── Exports ───────────────────────────────────────────────────────────────

    window.applyDrFilters          = applyDrFilters;
    window.openDrCreateModal       = openDrCreateModal;
    window.closeDrCreateModal      = closeDrCreateModal;
    window.submitDrCreate          = submitDrCreate;
    window.openDrViewModal         = openDrViewModal;
    window.closeDrViewModal        = closeDrViewModal;
    window.drMarkReceived          = drMarkReceived;
    window.drMarkReminder          = drMarkReminder;
    window.drWaive                 = drWaive;
    window.drDelete                = drDelete;
    window.toggleDrChecklists      = toggleDrChecklists;
    window.openCreateChecklistModal = openCreateChecklistModal;
    window.closeCreateChecklistModal = closeCreateChecklistModal;
    window.submitCreateChecklist   = submitCreateChecklist;
    window.openDrApplyModal        = openDrApplyModal;
    window.closeDrApplyModal       = closeDrApplyModal;
    window.submitDrApply           = submitDrApply;
})();
