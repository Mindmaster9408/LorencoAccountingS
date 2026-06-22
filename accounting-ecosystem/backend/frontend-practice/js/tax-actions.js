// Practice Tax Actions — Standalone Page (Codebox 35)
// Reads and manages practice_tax_work_actions via /api/practice/tax-actions/*
// No localStorage for business data.
(function () {
    'use strict';

    var esc      = PracticeAPI.escHtml;
    var BASE     = '/api/practice/tax-actions';

    var _page    = 1;
    var _total   = 0;
    var _limit   = 50;
    var _working = {}; // action id → true while request in flight

    // ─── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        LAYOUT.init('tax-actions');
        await _loadAssignees();
        _load();
    }

    async function _loadAssignees() {
        try {
            var res     = await PracticeAPI.fetch('/api/practice/team?active=true');
            var data    = await res.json();
            var members = data.members || data.team_members || [];
            var sel     = document.getElementById('taFltAssignee');
            if (!sel) return;
            members.forEach(function (m) {
                var o = document.createElement('option');
                o.value = m.id;
                o.textContent = m.display_name || m.name || ('Member #' + m.id);
                sel.appendChild(o);
            });
        } catch (_) {}
    }

    // ─── Load / refresh ───────────────────────────────────────────────────────
    async function _load() {
        _setEl('taList', '<div class="ta-loading">Loading actions…</div>');
        _setText('taTotalLabel', '');
        var pgEl = document.getElementById('taPagination');
        if (pgEl) pgEl.style.display = 'none';

        var qs = _buildQS();
        try {
            var res  = await PracticeAPI.fetch(BASE + '?' + qs);
            var data = await res.json();
            var rows = data.actions || [];
            _total   = data.total || 0;

            _setText('taTotalLabel', _total + ' action' + (_total === 1 ? '' : 's'));

            if (rows.length === 0) {
                _setEl('taList', '<div class="ta-empty">No actions match the current filters.</div>');
                return;
            }

            _setEl('taList', rows.map(_renderRow).join(''));

            var totalPages = Math.ceil(_total / _limit);
            if (totalPages > 1) {
                var prevBtn = document.getElementById('taBtnPrev');
                var nextBtn = document.getElementById('taBtnNext');
                var infoEl  = document.getElementById('taPageInfo');
                if (prevBtn) prevBtn.disabled = (_page <= 1);
                if (nextBtn) nextBtn.disabled = (_page >= totalPages);
                if (infoEl)  infoEl.textContent = 'Page ' + _page + ' of ' + totalPages;
                if (pgEl)    pgEl.style.display = 'flex';
            }
        } catch (err) {
            _setEl('taList', '<div class="ta-error">Failed to load actions: ' + esc(err.message) + '</div>');
        }
    }

    function _renderRow(a) {
        var statusCls  = 'ta-b-' + (a.action_status || 'open');
        var srcCls     = 'ta-b-src-' + (a.source_type || '');
        var isOpen     = a.action_status === 'open' || a.action_status === 'in_progress';
        var due        = a.due_date ? _fmtDate(a.due_date) : null;
        var isOverdue  = isOpen && a.due_date && new Date(a.due_date) < new Date();
        var dueTxt     = due ? (' · Due: <span class="' + (isOverdue ? 'ta-overdue' : '') + '">' + due + (isOverdue ? ' ⚠' : '') + '</span>') : '';
        var assignee   = a.assignee_name ? (' · Assigned: ' + esc(a.assignee_name)) : '';
        var clientTxt  = a.client_name   ? (' · ' + esc(a.client_name)) : '';

        var row = '<div class="ta-row" id="ta-row-' + a.id + '">' +
            '<div class="ta-row-body">' +
                '<div class="ta-row-title">' + esc(a.action_title || 'Untitled action') + '</div>' +
                '<div class="ta-row-meta">' +
                    esc(_actionTypeLabel(a.action_type)) + clientTxt + assignee + dueTxt +
                    (a.notes ? ' · <span style="color:rgba(255,255,255,0.3);">' + esc(a.notes.substring(0, 60)) + (a.notes.length > 60 ? '…' : '') + '</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="ta-row-btns">' +
                '<span class="ta-badge ' + srcCls + '">' + esc(_srcLabel(a.source_type)) + '</span>' +
                '<span class="ta-badge ' + statusCls + '">' + esc(a.action_status || 'open') + '</span>' +
                (isOpen
                    ? '<button type="button" class="ta-btn complete" data-id="' + a.id + '" onclick="taComplete(this)">Complete</button>' +
                      '<button type="button" class="ta-btn dismiss" data-id="' + a.id + '" onclick="taDismiss(this)">Dismiss</button>'
                    : '') +
            '</div>' +
            '</div>';
        return row;
    }

    // ─── Complete / dismiss ───────────────────────────────────────────────────
    async function taComplete(btn) {
        var id = parseInt(btn.getAttribute('data-id'));
        if (_working[id]) return;
        _working[id] = true;
        btn.disabled = true;
        try {
            var res  = await PracticeAPI.fetch(BASE + '/' + id + '/complete', { method: 'PUT' });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            PracticeAPI.showToast('Action completed.');
            _load();
        } catch (err) {
            PracticeAPI.showToast('Error: ' + err.message, true);
            btn.disabled = false;
        } finally {
            delete _working[id];
        }
    }
    window.taComplete = taComplete;

    async function taDismiss(btn) {
        var id = parseInt(btn.getAttribute('data-id'));
        if (_working[id]) return;
        if (!confirm('Dismiss this action?')) return;
        _working[id] = true;
        btn.disabled = true;
        try {
            var res  = await PracticeAPI.fetch(BASE + '/' + id + '/dismiss', { method: 'PUT' });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            PracticeAPI.showToast('Action dismissed.');
            _load();
        } catch (err) {
            PracticeAPI.showToast('Error: ' + err.message, true);
            btn.disabled = false;
        } finally {
            delete _working[id];
        }
    }
    window.taDismiss = taDismiss;

    // ─── Filters / pagination ─────────────────────────────────────────────────
    function taApplyFilters() { _page = 1; _load(); }
    function taPrevPage() { if (_page > 1) { _page--; _load(); } }
    function taNextPage() {
        if (_page < Math.ceil(_total / _limit)) { _page++; _load(); }
    }
    function taRefresh() { _page = 1; _load(); }

    window.taApplyFilters = taApplyFilters;
    window.taPrevPage     = taPrevPage;
    window.taNextPage     = taNextPage;
    window.taRefresh      = taRefresh;

    function _buildQS() {
        var p = [];
        var status   = _val('taFltStatus');
        var srcType  = _val('taFltSourceType');
        var assignee = _val('taFltAssignee');
        var dueFrom  = _val('taFltDueFrom');
        var dueTo    = _val('taFltDueTo');
        if (status)   p.push('action_status=' + encodeURIComponent(status));
        if (srcType)  p.push('source_type='   + encodeURIComponent(srcType));
        if (assignee) p.push('assigned_team_member_id=' + encodeURIComponent(assignee));
        if (dueFrom)  p.push('due_from=' + encodeURIComponent(dueFrom));
        if (dueTo)    p.push('due_to='   + encodeURIComponent(dueTo));
        p.push('page=' + _page, 'limit=' + _limit);
        return p.join('&');
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function _setEl(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
    function _setText(id, t)  { var el = document.getElementById(id); if (el) el.textContent = t; }
    function _val(id) { var el = document.getElementById(id); return el ? el.value : ''; }

    function _fmtDate(d) {
        if (!d) return '—';
        var parts = String(d).split('T')[0].split('-');
        if (parts.length !== 3) return d;
        return parts[2] + '/' + parts[1] + '/' + parts[0];
    }

    function _srcLabel(t) {
        var m = {
            individual_return: 'Ind. Return', company_return: 'Co. Return',
            provisional_plan:  'Provisional', individual_calculation: 'Ind. Calc',
            company_calculation: 'Co. Calc',  individual_review_pack: 'Ind. Pack',
            company_review_pack: 'Co. Pack',  compliance_deadline: 'Deadline',
            document_request: 'Doc Request',  tax_dashboard_risk: 'Dashboard Risk',
        };
        return m[t] || t || '—';
    }

    function _actionTypeLabel(t) {
        var m = {
            create_task: 'Create Task', assign_owner: 'Assign Owner',
            assign_reviewer: 'Assign Reviewer', request_document: 'Request Document',
            generate_review_pack: 'Generate Pack', run_calculation: 'Run Calculation',
            submit_for_review: 'Submit for Review', general_followup: 'Follow-up',
        };
        return m[t] || t || '—';
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

}());
