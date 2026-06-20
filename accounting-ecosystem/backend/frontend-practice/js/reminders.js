/* ============================================================
   Lorenco Practice — Reminder Center  (Codebox 21)
   In-app reminders only. No email/SMS/push. No cron.
   ============================================================ */
(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────────────
    var _allReminders    = [];  // loaded from API, cached for client-side filter
    var _suggestions     = [];  // loaded on demand from /suggestions
    var _clients         = [];  // for create modal picker
    var _members         = [];  // for create modal picker
    var _snoozingId      = null;
    var _submitting      = false;
    var _suggestVisible  = false;
    var _suggestLoaded   = false;

    var BASE = '/api/practice/reminders';

    // ── Severity helpers ───────────────────────────────────────────────────────
    var SEV_DOT = { urgent: 'rsev-urgent', high: 'rsev-high', normal: 'rsev-normal', low: 'rsev-low' };
    var SEV_LABEL = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

    // Friendly labels for reminder_type
    var TYPE_LABEL = {
        deadline_due:      'Deadline Due',
        deadline_overdue:  'Deadline Overdue',
        review_waiting:    'Review Waiting',
        approval_waiting:  'Approval Waiting',
        billing_waiting:   'Billing Waiting',
        health_action:     'Health Action',
        period_waiting:    'Period Waiting',
        engagement_setup:  'Engagement Setup',
        capacity_warning:  'Capacity Warning',
        general:           'General',
    };

    // Status badge CSS suffix
    var STATUS_CLASS = {
        open:      'rs-open',
        snoozed:   'rs-snoozed',
        completed: 'rs-completed',
        dismissed: 'rs-dismissed',
        cancelled: 'rs-cancelled',
    };

    // ── Utilities ──────────────────────────────────────────────────────────────
    function esc(s) {
        if (!s) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtDate(d) {
        if (!d) return '—';
        return d.slice(0, 10);
    }

    function isOverdue(r) {
        if (!r.due_date || r.status !== 'open') return false;
        return r.due_date < new Date().toISOString().split('T')[0];
    }

    function showEl(id)  { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hideEl(id)  { var el = document.getElementById(id); if (el) el.classList.add('hidden');    }
    function setEl(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html;      }
    function valEl(id)   { var el = document.getElementById(id); return el ? el.value.trim() : '';      }

    // ── Init ───────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        var token = typeof getToken === 'function' ? getToken() : localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }

        LAYOUT.init('reminders');

        Promise.all([loadSummary(), loadList(), loadClientsAndMembers()]);
    });

    // ── API ────────────────────────────────────────────────────────────────────
    function loadSummary() {
        return PracticeAPI.fetch(BASE + '/summary')
            .then(function (d) { renderSummaryCards(d.summary || {}); })
            .catch(function () { /* summary failure is non-fatal */ });
    }

    function loadList() {
        hideEl('listWrap');
        hideEl('listEmpty');
        hideEl('listError');
        showEl('listLoading');

        return PracticeAPI.fetch(BASE + '?limit=500')
            .then(function (d) {
                _allReminders = d.reminders || [];
                hideEl('listLoading');
                applyFilters();
            })
            .catch(function (err) {
                hideEl('listLoading');
                showEl('listError');
                setEl('listError', 'Failed to load reminders: ' + esc(err.message || 'Server error'));
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

    function loadSuggestions() {
        showEl('suggestLoading');
        hideEl('suggestEmpty');
        hideEl('suggestList');

        PracticeAPI.fetch(BASE + '/suggestions')
            .then(function (d) {
                _suggestions = d.suggestions || [];
                _suggestLoaded = true;
                hideEl('suggestLoading');
                renderSuggestions();
            })
            .catch(function (err) {
                hideEl('suggestLoading');
                setEl('suggestList', '<div class="error-banner">Failed to load suggestions: ' + esc(err.message || 'Server error') + '</div>');
                showEl('suggestList');
            });
    }

    // ── Summary cards ──────────────────────────────────────────────────────────
    function renderSummaryCards(s) {
        setEl('sumOpen',    s.open      != null ? String(s.open)      : '0');
        setEl('sumOverdue', s.overdue   != null ? String(s.overdue)   : '0');
        setEl('sumToday',   s.due_today != null ? String(s.due_today) : '0');
        setEl('sumWeek',    s.due_this_week != null ? String(s.due_this_week) : '0');
        setEl('sumUrgent',  s.urgent    != null ? String(s.urgent)    : '0');
        setEl('sumSnoozed', s.snoozed   != null ? String(s.snoozed)   : '0');
    }

    // ── Client-side filter + render ────────────────────────────────────────────
    function applyFilters() {
        var statusFilter   = valEl('filterStatus');
        var typeFilter     = valEl('filterType');
        var severityFilter = valEl('filterSeverity');
        var searchFilter   = document.getElementById('filterSearch')
            ? document.getElementById('filterSearch').value.toLowerCase().trim()
            : '';

        var filtered = _allReminders.filter(function (r) {
            // Status
            if (statusFilter === 'active') {
                if (r.status !== 'open' && r.status !== 'snoozed') return false;
            } else if (statusFilter !== 'all' && statusFilter) {
                if (r.status !== statusFilter) return false;
            }
            // Type
            if (typeFilter && r.reminder_type !== typeFilter) return false;
            // Severity
            if (severityFilter && r.severity !== severityFilter) return false;
            // Search
            if (searchFilter) {
                var haystack = (r.title + ' ' + (r.message || '') + ' ' + (r.client_name || '')).toLowerCase();
                if (haystack.indexOf(searchFilter) === -1) return false;
            }
            return true;
        });

        renderList(filtered);
    }

    // ── Reminder list ──────────────────────────────────────────────────────────
    function renderList(reminders) {
        if (!reminders || reminders.length === 0) {
            hideEl('listWrap');
            showEl('listEmpty');
            return;
        }

        hideEl('listEmpty');
        showEl('listWrap');

        var rows = reminders.map(function (r) {
            var sevClass  = SEV_DOT[r.severity]    || 'rsev-normal';
            var statClass = STATUS_CLASS[r.status]  || '';
            var typeLabel = TYPE_LABEL[r.reminder_type] || r.reminder_type;
            var overdueCls = isOverdue(r) ? ' rem-row--overdue' : '';
            var snoozeNote = r.status === 'snoozed' && r.snoozed_until
                ? '<div class="rem-snooze-note">Snoozed until ' + esc(r.snoozed_until.slice(0, 16).replace('T', ' ')) + '</div>'
                : '';
            var actionUrl  = r.action_url
                ? '<a href="' + esc(r.action_url) + '" class="btn btn-xs btn-ghost">→ Go</a>'
                : '';

            var canAct = r.status !== 'cancelled' && r.status !== 'completed' && r.status !== 'dismissed';

            return '<tr class="' + overdueCls + '">' +
                '<td><div class="rem-sev-dot ' + sevClass + '" title="' + esc(SEV_LABEL[r.severity] || r.severity) + '"></div></td>' +
                '<td>' +
                    '<div class="rem-title">' + esc(r.title) + '</div>' +
                    (r.message ? '<div class="rem-message">' + esc(r.message) + '</div>' : '') +
                    snoozeNote +
                '</td>' +
                '<td><span class="rem-type-badge">' + esc(typeLabel) + '</span></td>' +
                '<td>' + esc(r.client_name || '—') + '</td>' +
                '<td>' + esc(r.assignee_name || '—') + '</td>' +
                '<td class="' + (isOverdue(r) ? 'rem-overdue-date' : '') + '">' + fmtDate(r.due_date) + '</td>' +
                '<td><span class="rem-status-badge ' + statClass + '">' + esc(r.status) + '</span></td>' +
                '<td class="rem-actions">' +
                    actionUrl +
                    (canAct
                        ? '<button type="button" class="btn btn-xs btn-ghost" onclick="completeReminder(' + r.id + ')">✓</button>' +
                          '<button type="button" class="btn btn-xs btn-ghost" onclick="openSnoozeModal(' + r.id + ')">💤</button>' +
                          '<button type="button" class="btn btn-xs btn-ghost rem-dismiss-btn" onclick="dismissReminder(' + r.id + ')">✕</button>'
                        : '') +
                '</td>' +
            '</tr>';
        });

        setEl('listBody', rows.join(''));
    }

    // ── Suggestions panel ──────────────────────────────────────────────────────
    function toggleSuggestions() {
        _suggestVisible = !_suggestVisible;
        var panel = document.getElementById('suggestionsPanel');
        if (!panel) return;

        if (_suggestVisible) {
            panel.classList.remove('hidden');
            if (!_suggestLoaded) loadSuggestions();
        } else {
            panel.classList.add('hidden');
        }
    }

    function renderSuggestions() {
        if (!_suggestions || _suggestions.length === 0) {
            showEl('suggestEmpty');
            hideEl('suggestList');
            return;
        }

        // Build a lookup from _clients for display
        var clientMap = {};
        _clients.forEach(function (c) { clientMap[c.id] = c.client_name || c.name || ''; });

        var items = _suggestions.map(function (s, idx) {
            var sevClass  = SEV_DOT[s.severity] || 'rsev-normal';
            var typeLabel = TYPE_LABEL[s.reminder_type] || s.reminder_type;
            var clientName = s.client_id ? (clientMap[s.client_id] || 'Client ' + s.client_id) : '';

            return '<div class="rem-suggest-item">' +
                '<div class="rem-suggest-sev"><div class="rem-sev-dot ' + sevClass + '"></div></div>' +
                '<div class="rem-suggest-body">' +
                    '<div class="rem-suggest-title">' + esc(s.title) + '</div>' +
                    (s.message   ? '<div class="rem-suggest-msg">'    + esc(s.message) + '</div>' : '') +
                    (clientName  ? '<div class="rem-suggest-client">' + esc(clientName) + '</div>' : '') +
                    '<span class="rem-type-badge rem-type-badge--sm">' + esc(typeLabel) + '</span>' +
                '</div>' +
                '<div class="rem-suggest-actions">' +
                    (s.action_url
                        ? '<a href="' + esc(s.action_url) + '" class="btn btn-xs btn-ghost">→ Go</a>'
                        : '') +
                    '<button type="button" class="btn btn-xs btn-primary" onclick="createFromSuggestion(' + idx + ')">+ Remind</button>' +
                '</div>' +
            '</div>';
        });

        setEl('suggestList', items.join(''));
        showEl('suggestList');
        hideEl('suggestEmpty');
    }

    // ── Create from suggestion ─────────────────────────────────────────────────
    function createFromSuggestion(idx) {
        var s = _suggestions[idx];
        if (!s) return;

        PracticeAPI.fetch(BASE + '/create-from-suggestion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reminder_type:          s.reminder_type,
                source_type:            s.source_type,
                source_id:              s.source_id    || null,
                client_id:              s.client_id    || null,
                title:                  s.title,
                message:                s.message      || null,
                severity:               s.severity     || 'normal',
                due_date:               s.due_date     || null,
                action_url:             s.action_url   || null,
            }),
        })
        .then(function () {
            // Remove from local suggestions list to prevent duplicate click
            _suggestions.splice(idx, 1);
            renderSuggestions();
            loadSummary();
            loadList();
        })
        .catch(function (err) {
            alert('Could not create reminder: ' + (err.message || 'Server error'));
        });
    }

    // ── Create modal ───────────────────────────────────────────────────────────
    function populateModalPickers() {
        var cSel = document.getElementById('cClient');
        if (cSel) {
            var opts = '<option value="">No client</option>';
            _clients.forEach(function (c) {
                opts += '<option value="' + c.id + '">' + esc(c.client_name || c.name || 'Client ' + c.id) + '</option>';
            });
            cSel.innerHTML = opts;
        }

        var mSel = document.getElementById('cAssignee');
        if (mSel) {
            var mopts = '<option value="">Unassigned</option>';
            _members.forEach(function (m) {
                mopts += '<option value="' + m.id + '">' + esc(m.display_name || m.name || 'Member ' + m.id) + '</option>';
            });
            mSel.innerHTML = mopts;
        }
    }

    function openCreateModal() {
        hideEl('createError');
        document.getElementById('cTitle').value = '';
        document.getElementById('cType').value  = 'general';
        document.getElementById('cSeverity').value = 'normal';
        document.getElementById('cDue').value   = '';
        document.getElementById('cMessage').value = '';
        if (document.getElementById('cClient'))   document.getElementById('cClient').value   = '';
        if (document.getElementById('cAssignee')) document.getElementById('cAssignee').value = '';
        _submitting = false;
        document.getElementById('createSubmitBtn').disabled = false;
        showEl('createModal');
    }

    function closeCreateModal() {
        hideEl('createModal');
    }

    function submitCreate() {
        if (_submitting) return;
        var title = valEl('cTitle');
        var type  = valEl('cType');
        if (!title) {
            setEl('createError', 'Title is required.');
            showEl('createError');
            return;
        }

        _submitting = true;
        document.getElementById('createSubmitBtn').disabled = true;
        hideEl('createError');

        var payload = {
            reminder_type:          type,
            source_type:            'system',
            title:                  title,
            severity:               valEl('cSeverity') || 'normal',
            due_date:               valEl('cDue')      || null,
            message:                valEl('cMessage')  || null,
            client_id:              valEl('cClient')   ? parseInt(valEl('cClient'), 10)   : null,
            assigned_team_member_id: valEl('cAssignee') ? parseInt(valEl('cAssignee'), 10) : null,
        };

        PracticeAPI.fetch(BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function () {
            _submitting = false;
            closeCreateModal();
            Promise.all([loadSummary(), loadList()]);
        })
        .catch(function (err) {
            _submitting = false;
            document.getElementById('createSubmitBtn').disabled = false;
            setEl('createError', err.message || 'Failed to create reminder.');
            showEl('createError');
        });
    }

    // ── Snooze modal ───────────────────────────────────────────────────────────
    function openSnoozeModal(id) {
        _snoozingId = id;
        _submitting  = false;
        hideEl('snoozeError');
        document.getElementById('snoozeUntil').value = '';
        document.getElementById('snoozeSubmitBtn').disabled = false;
        showEl('snoozeModal');
    }

    function closeSnoozeModal() {
        hideEl('snoozeModal');
        _snoozingId = null;
    }

    function setSnoozeQuick(days) {
        var d   = new Date(Date.now() + days * 86400000);
        d.setHours(8, 0, 0, 0);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        var val = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T08:00';
        document.getElementById('snoozeUntil').value = val;
    }

    function submitSnooze() {
        if (_submitting || !_snoozingId) return;
        var until = valEl('snoozeUntil');
        if (!until) {
            setEl('snoozeError', 'Please select a snooze date and time.');
            showEl('snoozeError');
            return;
        }

        _submitting = true;
        document.getElementById('snoozeSubmitBtn').disabled = true;
        hideEl('snoozeError');

        PracticeAPI.fetch(BASE + '/' + _snoozingId + '/snooze', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snoozed_until: new Date(until).toISOString() }),
        })
        .then(function () {
            _submitting = false;
            closeSnoozeModal();
            Promise.all([loadSummary(), loadList()]);
        })
        .catch(function (err) {
            _submitting = false;
            document.getElementById('snoozeSubmitBtn').disabled = false;
            setEl('snoozeError', err.message || 'Failed to snooze reminder.');
            showEl('snoozeError');
        });
    }

    // ── Complete / Dismiss ─────────────────────────────────────────────────────
    function completeReminder(id) {
        PracticeAPI.fetch(BASE + '/' + id + '/complete', { method: 'PUT' })
            .then(function () { Promise.all([loadSummary(), loadList()]); })
            .catch(function (err) { alert('Could not complete: ' + (err.message || 'Server error')); });
    }

    function dismissReminder(id) {
        if (!confirm('Dismiss this reminder?')) return;
        PracticeAPI.fetch(BASE + '/' + id + '/dismiss', { method: 'PUT' })
            .then(function () { Promise.all([loadSummary(), loadList()]); })
            .catch(function (err) { alert('Could not dismiss: ' + (err.message || 'Server error')); });
    }

    // ── Window exports (called from inline handlers) ───────────────────────────
    window.applyFilters         = applyFilters;
    window.toggleSuggestions    = toggleSuggestions;
    window.openCreateModal      = openCreateModal;
    window.closeCreateModal     = closeCreateModal;
    window.submitCreate         = submitCreate;
    window.openSnoozeModal      = openSnoozeModal;
    window.closeSnoozeModal     = closeSnoozeModal;
    window.setSnoozeQuick       = setSnoozeQuick;
    window.submitSnooze         = submitSnooze;
    window.completeReminder     = completeReminder;
    window.dismissReminder      = dismissReminder;
    window.createFromSuggestion = createFromSuggestion;

}());
