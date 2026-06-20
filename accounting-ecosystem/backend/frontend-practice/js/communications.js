/* ============================================================
   Lorenco Practice — Client Communication Log  (Codebox 22)
   Manual logging only. No email/SMS/WhatsApp sending.
   ============================================================ */
(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────────────
    var _allComms   = [];   // loaded from API, filtered client-side
    var _clients    = [];   // for create modal picker
    var _members    = [];   // for create modal picker
    var _submitting = false;
    var _viewingComm = null; // currently displayed in view modal

    var BASE = '/api/practice/communications';

    // ── Type config ────────────────────────────────────────────────────────────
    var TYPE_ICON = {
        call:              '📞',
        email_note:        '📧',
        whatsapp_note:     '💬',
        meeting:           '🤝',
        document_request:  '📄',
        sars_followup:     '🏛',
        cipc_followup:     '🏢',
        billing_followup:  '💰',
        general_note:      '📝',
        internal_note:     '🔒',
    };

    var TYPE_LABEL = {
        call:              'Call',
        email_note:        'Email Note',
        whatsapp_note:     'WhatsApp Note',
        meeting:           'Meeting',
        document_request:  'Document Request',
        sars_followup:     'SARS Follow-up',
        cipc_followup:     'CIPC Follow-up',
        billing_followup:  'Billing Follow-up',
        general_note:      'General Note',
        internal_note:     'Internal Note',
    };

    var DIR_LABEL = { outbound: 'Out', inbound: 'In', internal: 'Int' };
    var DIR_CLASS = { outbound: 'cdir-out', inbound: 'cdir-in', internal: 'cdir-int' };

    var RESP_LABEL = {
        not_required: '—',
        waiting:      'Waiting',
        received:     'Received',
        overdue:      'Overdue',
        cancelled:    'Cancelled',
    };
    var RESP_CLASS = {
        not_required: 'crsp-none',
        waiting:      'crsp-waiting',
        received:     'crsp-received',
        overdue:      'crsp-overdue',
        cancelled:    'crsp-cancelled',
    };

    // ── Utils ──────────────────────────────────────────────────────────────────
    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' });
        } catch (e) { return iso.slice(0, 10); }
    }

    function fmtDateTime(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso.slice(0, 16).replace('T', ' '); }
    }

    function nowLocalInput() {
        var d   = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function showEl(id)  { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hideEl(id)  { var el = document.getElementById(id); if (el) el.classList.add('hidden');    }
    function setEl(id, h){ var el = document.getElementById(id); if (el) el.innerHTML = h;              }
    function valEl(id)   { var el = document.getElementById(id); return el ? el.value.trim() : '';      }
    function chkEl(id)   { var el = document.getElementById(id); return el ? el.checked : false;        }

    function getEffectiveRespStatus(c) {
        return c.effective_response_status || c.response_status || 'not_required';
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        var token = typeof getToken === 'function' ? getToken() : localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }

        LAYOUT.init('communications');

        // Set default comm date to now
        var cdEl = document.getElementById('cCommDate');
        if (cdEl) cdEl.value = nowLocalInput();

        Promise.all([loadSummary(), loadList(), loadClientsAndMembers()]);
    });

    // ── API calls ──────────────────────────────────────────────────────────────
    function loadSummary() {
        return PracticeAPI.fetch(BASE + '/summary')
            .then(function (d) { renderSummaryCards(d.summary || {}); })
            .catch(function () { /* non-fatal */ });
    }

    function loadList() {
        hideEl('listWrap');
        hideEl('listEmpty');
        hideEl('listError');
        showEl('listLoading');

        return PracticeAPI.fetch(BASE + '?limit=200')
            .then(function (d) {
                _allComms = d.communications || [];
                hideEl('listLoading');
                applyFilters();
            })
            .catch(function (err) {
                hideEl('listLoading');
                setEl('listError', 'Failed to load: ' + esc(err.message || 'Server error'));
                showEl('listError');
            });
    }

    function loadClientsAndMembers() {
        return Promise.all([
            PracticeAPI.fetch('/api/practice/clients?limit=500').catch(function () { return { clients: [] }; }),
            PracticeAPI.fetch('/api/practice/team?limit=200').catch(function () { return { members: [] }; }),
        ]).then(function (results) {
            _clients = results[0].clients || results[0].data || [];
            _members = results[1].members || results[1].team  || [];
            populateModalPickers();
        });
    }

    // ── Summary cards ──────────────────────────────────────────────────────────
    function renderSummaryCards(s) {
        setEl('sumTotal',   s.total                  != null ? String(s.total)                  : '0');
        setEl('sumWaiting', s.waiting_responses       != null ? String(s.waiting_responses)       : '0');
        setEl('sumOverdue', s.overdue_responses       != null ? String(s.overdue_responses)       : '0');
        setEl('sumDocReq',  s.document_requests_open  != null ? String(s.document_requests_open)  : '0');
        setEl('sumWeek',    s.this_week               != null ? String(s.this_week)               : '0');
    }

    // ── Client-side filter ─────────────────────────────────────────────────────
    function applyFilters() {
        var typeFilter   = valEl('filterType');
        var dirFilter    = valEl('filterDirection');
        var respFilter   = valEl('filterResponse');
        var search       = document.getElementById('filterSearch')
            ? document.getElementById('filterSearch').value.toLowerCase().trim()
            : '';

        var filtered = _allComms.filter(function (c) {
            if (typeFilter && c.communication_type !== typeFilter) return false;
            if (dirFilter  && c.direction          !== dirFilter)  return false;
            if (respFilter) {
                var eff = getEffectiveRespStatus(c);
                if (eff !== respFilter) return false;
            }
            if (search) {
                var hay = ((c.subject || '') + ' ' + (c.body || '') + ' ' + (c.contact_name || '') + ' ' + (c.client_name || '')).toLowerCase();
                if (hay.indexOf(search) === -1) return false;
            }
            return true;
        });

        renderList(filtered);
    }

    // ── List render ────────────────────────────────────────────────────────────
    function renderList(comms) {
        if (!comms || comms.length === 0) {
            hideEl('listWrap');
            showEl('listEmpty');
            return;
        }
        hideEl('listEmpty');
        showEl('listWrap');

        var rows = comms.map(function (c) {
            var eff      = getEffectiveRespStatus(c);
            var overdue  = eff === 'overdue';
            var typeIcon = TYPE_ICON[c.communication_type] || '📋';
            var typeLabel = TYPE_LABEL[c.communication_type] || c.communication_type;
            var dirClass  = DIR_CLASS[c.direction]  || '';
            var respClass = RESP_CLASS[eff]         || '';
            var respLabel = RESP_LABEL[eff]         || eff;
            var rowCls    = overdue ? ' comm-row--overdue' : '';
            var bodyPrev  = c.body ? (c.body.length > 60 ? c.body.slice(0, 60) + '…' : c.body) : '';

            var actionBtns = '<button type="button" class="btn btn-xs btn-ghost" onclick="openViewModal(' + c.id + ')">View</button>';
            if (c.response_required && eff === 'waiting' || eff === 'overdue') {
                actionBtns += '<button type="button" class="btn btn-xs btn-ghost" onclick="markResponded(' + c.id + ')">✓ Received</button>';
            }

            return '<tr class="' + rowCls + '">' +
                '<td><span class="comm-type-badge">' + typeIcon + ' ' + esc(typeLabel) + '</span></td>' +
                '<td>' +
                    '<div class="comm-subject">' + esc(c.subject) + '</div>' +
                    (bodyPrev ? '<div class="comm-body-prev">' + esc(bodyPrev) + '</div>' : '') +
                '</td>' +
                '<td class="comm-client-cell">' + esc(c.client_name || '—') + '</td>' +
                '<td><span class="comm-dir-badge ' + dirClass + '">' + esc(DIR_LABEL[c.direction] || c.direction) + '</span></td>' +
                '<td class="comm-date-cell">' + fmtDate(c.communication_date) + '</td>' +
                '<td><span class="comm-resp-badge ' + respClass + '">' + esc(respLabel) + '</span>' +
                    (c.response_due_date && eff !== 'received' && eff !== 'not_required'
                        ? '<div class="comm-resp-due">' + fmtDate(c.response_due_date) + '</div>'
                        : '') +
                '</td>' +
                '<td class="comm-actions-cell">' + actionBtns + '</td>' +
            '</tr>';
        });

        setEl('listBody', rows.join(''));
    }

    // ── View modal ─────────────────────────────────────────────────────────────
    function openViewModal(id) {
        var c = _allComms.find(function (x) { return x.id === id; });
        if (!c) return;
        _viewingComm = c;

        var eff      = getEffectiveRespStatus(c);
        var typeIcon = TYPE_ICON[c.communication_type] || '📋';
        var typeLabel = TYPE_LABEL[c.communication_type] || c.communication_type;

        setEl('viewTitle', typeIcon + ' ' + esc(typeLabel) + ' — ' + esc(c.subject));

        var rows = [
            ['Client',     esc(c.client_name   || c.client_id   || '—')],
            ['Direction',  esc(DIR_LABEL[c.direction] || c.direction)],
            ['Date',       fmtDateTime(c.communication_date)],
            ['Assigned',   esc(c.assignee_name || '—')],
            ['Contact',    esc([c.contact_name, c.contact_email, c.contact_phone].filter(Boolean).join(' · ') || '—')],
        ];

        var infoHtml = rows.map(function (r) {
            return '<div class="view-row"><div class="view-label">' + r[0] + '</div><div class="view-val">' + r[1] + '</div></div>';
        }).join('');

        if (c.body) {
            infoHtml += '<div class="view-body">' + esc(c.body).replace(/\n/g, '<br>') + '</div>';
        }

        if (c.response_required) {
            var respCls = RESP_CLASS[eff] || '';
            infoHtml += '<div class="view-row"><div class="view-label">Response</div><div class="view-val">' +
                '<span class="comm-resp-badge ' + respCls + '">' + esc(RESP_LABEL[eff] || eff) + '</span>' +
                (c.response_due_date ? ' · Due ' + fmtDate(c.response_due_date) : '') +
                (c.responded_at ? ' · Received ' + fmtDate(c.responded_at) : '') +
                '</div></div>';
        }

        if (c.attachments_note) {
            infoHtml += '<div class="view-row"><div class="view-label">Attachments</div><div class="view-val">' + esc(c.attachments_note) + '</div></div>';
        }

        setEl('viewBody', infoHtml);

        var footerBtns = '';
        if (c.response_required && (eff === 'waiting' || eff === 'overdue')) {
            footerBtns += '<button type="button" class="btn btn-ghost" onclick="markResponded(' + c.id + ');closeViewModal();">✓ Mark Received</button>';
        }
        footerBtns += '<button type="button" class="btn btn-ghost" onclick="createReminderFromView()">🔔 Create Reminder</button>';
        footerBtns += '<button type="button" class="btn btn-ghost" onclick="createTaskFromView()">📋 Create Task</button>';
        footerBtns += '<button type="button" class="btn btn-ghost btn-danger" onclick="cancelComm(' + c.id + ')">Delete</button>';
        footerBtns += '<button type="button" class="btn btn-primary" onclick="closeViewModal()">Close</button>';

        setEl('viewFooter', footerBtns);
        showEl('viewModal');
    }

    function closeViewModal() {
        hideEl('viewModal');
        _viewingComm = null;
    }

    // ── Create modal ───────────────────────────────────────────────────────────
    function populateModalPickers() {
        var cSel  = document.getElementById('cClient');
        var mSel  = document.getElementById('cAssignee');
        if (cSel) {
            var opts = '<option value="">Select client…</option>';
            _clients.forEach(function (c) {
                opts += '<option value="' + c.id + '">' + esc(c.client_name || c.name || 'Client ' + c.id) + '</option>';
            });
            cSel.innerHTML = opts;
        }
        if (mSel) {
            var mopts = '<option value="">Unassigned</option>';
            _members.forEach(function (m) {
                mopts += '<option value="' + m.id + '">' + esc(m.display_name || 'Member ' + m.id) + '</option>';
            });
            mSel.innerHTML = mopts;
        }
    }

    function openCreateModal(presetClientId) {
        hideEl('createError');
        document.getElementById('cSubject').value       = '';
        document.getElementById('cBody').value          = '';
        document.getElementById('cContactName').value   = '';
        document.getElementById('cContactEmail').value  = '';
        document.getElementById('cContactPhone').value  = '';
        document.getElementById('cAttachNote').value    = '';
        document.getElementById('cType').value          = 'call';
        document.getElementById('cDirection').value     = 'outbound';
        document.getElementById('cVisibility').value    = 'practice';
        document.getElementById('cResponseRequired').checked = false;
        document.getElementById('cIsInternal').checked  = false;
        document.getElementById('cCommDate').value      = nowLocalInput();
        hideEl('cResponseDateRow');
        document.getElementById('cResponseDue').value   = '';

        if (presetClientId && document.getElementById('cClient')) {
            document.getElementById('cClient').value = String(presetClientId);
        } else if (document.getElementById('cClient')) {
            document.getElementById('cClient').value = '';
        }
        if (document.getElementById('cAssignee')) document.getElementById('cAssignee').value = '';

        _submitting = false;
        document.getElementById('createSubmitBtn').disabled = false;
        showEl('createModal');
    }

    function closeCreateModal() { hideEl('createModal'); }

    function toggleResponseDate() {
        var checked = document.getElementById('cResponseRequired') &&
            document.getElementById('cResponseRequired').checked;
        if (checked) showEl('cResponseDateRow'); else hideEl('cResponseDateRow');
    }

    function submitCreate() {
        if (_submitting) return;
        var client_id = valEl('cClient');
        var subject   = valEl('cSubject');
        if (!client_id) {
            setEl('createError', 'Please select a client.');
            showEl('createError');
            return;
        }
        if (!subject) {
            setEl('createError', 'Subject is required.');
            showEl('createError');
            return;
        }

        _submitting = true;
        document.getElementById('createSubmitBtn').disabled = true;
        hideEl('createError');

        var commDateVal = document.getElementById('cCommDate').value;

        var payload = {
            client_id:               parseInt(client_id, 10),
            communication_type:      valEl('cType'),
            direction:               valEl('cDirection'),
            subject:                 subject,
            body:                    valEl('cBody') || null,
            contact_name:            valEl('cContactName')  || null,
            contact_email:           valEl('cContactEmail') || null,
            contact_phone:           valEl('cContactPhone') || null,
            assigned_team_member_id: valEl('cAssignee') ? parseInt(valEl('cAssignee'), 10) : null,
            communication_date:      commDateVal ? new Date(commDateVal).toISOString() : null,
            response_required:       chkEl('cResponseRequired'),
            response_due_date:       valEl('cResponseDue') || null,
            is_internal:             chkEl('cIsInternal'),
            visibility:              valEl('cVisibility') || 'practice',
            attachments_note:        valEl('cAttachNote') || null,
        };

        PracticeAPI.fetch(BASE, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        })
        .then(function () {
            _submitting = false;
            closeCreateModal();
            Promise.all([loadSummary(), loadList()]);
        })
        .catch(function (err) {
            _submitting = false;
            document.getElementById('createSubmitBtn').disabled = false;
            setEl('createError', err.message || 'Failed to log communication.');
            showEl('createError');
        });
    }

    // ── Mark responded ─────────────────────────────────────────────────────────
    function markResponded(id) {
        PracticeAPI.fetch(BASE + '/' + id + '/mark-responded', { method: 'PUT' })
            .then(function () { Promise.all([loadSummary(), loadList()]); })
            .catch(function (err) { alert('Could not mark as received: ' + (err.message || 'Server error')); });
    }

    // ── Cancel response ────────────────────────────────────────────────────────
    function cancelCommResponse(id) {
        if (!confirm('Cancel the response requirement for this communication?')) return;
        PracticeAPI.fetch(BASE + '/' + id + '/cancel-response', { method: 'PUT' })
            .then(function () { Promise.all([loadSummary(), loadList()]); })
            .catch(function (err) { alert('Could not cancel: ' + (err.message || 'Server error')); });
    }

    // ── Create reminder from view modal ────────────────────────────────────────
    function createReminderFromView() {
        if (!_viewingComm) return;
        var id = _viewingComm.id;
        closeViewModal();
        PracticeAPI.fetch(BASE + '/' + id + '/create-reminder', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({}),
        })
        .then(function (d) {
            alert('Reminder created (ID: ' + d.reminder_id + '). View it in the Reminders page.');
            loadList();
        })
        .catch(function (err) { alert('Could not create reminder: ' + (err.message || 'Server error')); });
    }

    // ── Create task from view modal ────────────────────────────────────────────
    function createTaskFromView() {
        if (!_viewingComm) return;
        var id = _viewingComm.id;
        closeViewModal();
        PracticeAPI.fetch(BASE + '/' + id + '/create-task', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({}),
        })
        .then(function (d) {
            alert('Task created (ID: ' + d.task_id + '). View it in the Tasks page.');
            loadList();
        })
        .catch(function (err) { alert('Could not create task: ' + (err.message || 'Server error')); });
    }

    // ── Cancel communication (soft delete) ────────────────────────────────────
    function cancelComm(id) {
        if (!confirm('Remove this communication from the log? (This cannot be undone.)')) return;
        closeViewModal();
        PracticeAPI.fetch(BASE + '/' + id, { method: 'DELETE' })
            .then(function () { Promise.all([loadSummary(), loadList()]); })
            .catch(function (err) { alert('Could not remove: ' + (err.message || 'Server error')); });
    }

    // ── Window exports ─────────────────────────────────────────────────────────
    window.applyFilters         = applyFilters;
    window.openCreateModal      = openCreateModal;
    window.closeCreateModal     = closeCreateModal;
    window.toggleResponseDate   = toggleResponseDate;
    window.submitCreate         = submitCreate;
    window.openViewModal        = openViewModal;
    window.closeViewModal       = closeViewModal;
    window.markResponded        = markResponded;
    window.cancelCommResponse   = cancelCommResponse;
    window.createReminderFromView = createReminderFromView;
    window.createTaskFromView   = createTaskFromView;
    window.cancelComm           = cancelComm;

}());
