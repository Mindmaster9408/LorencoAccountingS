/* Codebox 47 — Practice SOP Templates + Workflow Instruction Library
 * The practice's operational instruction manual. NOT AI. NOT document management.
 * Prefix: sop
 */
(function () {
    'use strict';

    var BASE        = '/api/practice/sop';
    var _currentId   = null;
    var _currentSop  = null;
    var _currentTab  = 'instruction';
    var _submitting  = false;
    var _page        = 1;
    var _urlLinkedType = null;
    var _urlLinkedId   = null;

    // ── Constants ────────────────────────────────────────────────────────────

    var STATUS_LABELS = { draft: 'Draft', under_review: 'Under Review', approved: 'Approved', archived: 'Archived' };
    var DIFF_LABELS    = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

    var EV_LABELS = {
        sop_created: 'SOP Created', sop_updated: 'Updated',
        sop_submitted: 'Submitted for Review', sop_approved: 'Approved',
        sop_archived: 'Archived', sop_linked: 'Linked', sop_unlinked: 'Unlinked',
    };

    var LINKED_TYPE_LABELS = {
        workflow_template: 'Workflow Template', workflow_step: 'Workflow Step',
        task: 'Task', review_task: 'Review Task',
        compliance_pack: 'Compliance Pack', completion_pack: 'Completion Pack',
        knowledge_article: 'Knowledge Article',
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _html(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmt(s)     { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }

    function _statusPill(s) {
        return '<span class="pill st-' + _html(s) + '">' + _html(STATUS_LABELS[s] || s) + '</span>';
    }

    function _diffBadge(d) {
        if (!d) return '<span style="color:#4a5568;">—</span>';
        return '<span class="diff-badge diff-' + _html(d) + '">' + _html(DIFF_LABELS[d] || d) + '</span>';
    }

    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    function _qs() {
        var p = [];
        var category   = document.getElementById('filterCategory').value.trim();
        var status     = document.getElementById('filterStatus').value;
        var difficulty = document.getElementById('filterDifficulty').value;
        var search      = document.getElementById('filterSearch').value.trim();
        if (category)   p.push('category='   + encodeURIComponent(category));
        if (status)     p.push('status='     + encodeURIComponent(status));
        if (difficulty) p.push('difficulty=' + encodeURIComponent(difficulty));
        if (search)     p.push('search='     + encodeURIComponent(search));
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function sopLoad() {
        _page = 1;
        _loadSummary();
        _loadList();
    }

    function _checkUrlParams() {
        var params = new URLSearchParams(window.location.search);
        _urlLinkedType = params.get('linked_type');
        _urlLinkedId   = params.get('linked_id');
        if (_urlLinkedType && _urlLinkedId) {
            _renderLinkedBanner(_urlLinkedType, _urlLinkedId);
        }
    }

    function _renderLinkedBanner(linkedType, linkedId) {
        var existing = document.getElementById('linkedBanner');
        if (existing) existing.remove();

        var banner = document.createElement('div');
        banner.id = 'linkedBanner';
        banner.className = 'inline-msg info';
        banner.innerHTML = 'Showing SOPs attached to <strong>' + _html(LINKED_TYPE_LABELS[linkedType] || linkedType) + ' #' + _html(linkedId) + '</strong> — <span id="linkedBannerCount">loading…</span>';
        var content = document.querySelector('.page-content');
        content.insertBefore(banner, content.children[1]);

        window.PracticeAPI.fetch(BASE + '/linked/' + encodeURIComponent(linkedType) + '/' + encodeURIComponent(linkedId))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var countEl = document.getElementById('linkedBannerCount');
                if (!countEl) return;
                var sops = d.sops || [];
                if (!sops.length) {
                    countEl.textContent = 'no SOPs attached yet.';
                    return;
                }
                countEl.innerHTML = sops.length + ' SOP(s): ' + sops.map(function (s) {
                    return '<a href="#" onclick="sopOpenDetail(' + s.id + ');return false;" style="color:#a3bffa;">' + _html(s.title) + '</a>';
                }).join(', ');
            })
            .catch(function () {});
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderSummary(d); })
            .catch(function () {});
    }

    function _renderSummary(d) {
        var grid = document.getElementById('summaryGrid');
        var cards = [
            { cls: 'sc-draft',    count: d.draft        || 0, label: 'Draft',        filter: 'draft' },
            { cls: 'sc-review',   count: d.under_review || 0, label: 'Under Review', filter: 'under_review' },
            { cls: 'sc-approved', count: d.approved      || 0, label: 'Approved',     filter: 'approved' },
            { cls: 'sc-archived', count: d.archived      || 0, label: 'Archived',     filter: 'archived' },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card ' + c.cls + '" onclick="_sopFilterStatus(\'' + c.filter + '\')">' +
                '<div class="sc-count">' + c.count + '</div>' +
                '<div class="sc-label">' + c.label + '</div>' +
            '</div>';
        }).join('');
    }

    function _sopFilterStatus(s) {
        document.getElementById('filterStatus').value = s;
        _page = 1;
        _loadList();
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.sops || [], d.total || 0, d.page || 1, d.limit || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8" style="color:#fc8181;">Failed to load SOPs</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No SOPs found. Create the first standard operating procedure.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (s) {
            return '<tr onclick="sopOpenDetail(' + s.id + ')">' +
                '<td style="color:#4a5568;font-size:.78rem;">#' + s.id + '</td>' +
                '<td>' + _statusPill(s.status) + '</td>' +
                '<td class="td-title" title="' + _html(s.title) + '">' + _html(s.title) + '</td>' +
                '<td>' + (s.category ? '<span class="cat-chip">' + _html(s.category) + '</span>' : '<span style="color:#4a5568;">—</span>') + '</td>' +
                '<td>' + _diffBadge(s.difficulty) + '</td>' +
                '<td style="font-size:.8rem;">' + _html(s.estimated_minutes != null ? s.estimated_minutes : '—') + '</td>' +
                '<td style="font-size:.8rem;">v' + _html(s.version || 1) + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + _fmt(s.updated_at) + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_sopPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_sopPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' SOP' + (total !== 1 ? 's' : '');
        }
    }

    function _sopPage(p) { _page = p; _loadList(); }

    // ── Filters ───────────────────────────────────────────────────────────────

    function sopClearFilters() {
        ['filterCategory','filterStatus','filterDifficulty','filterSearch'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        _page = 1;
        _loadList();
    }

    // ── Create SOP ────────────────────────────────────────────────────────────

    function sopOpenCreate() {
        document.getElementById('createModal').classList.add('open');
    }

    function sopCloseCreate() {
        document.getElementById('createModal').classList.remove('open');
    }

    function sopSubmitCreate() {
        if (_submitting) return;
        var title = document.getElementById('createTitle').value.trim();
        var body  = document.getElementById('createInstructionBody').value.trim();
        if (!title) return _showToast('Title is required');
        if (!body)  return _showToast('Instructions are required');

        var minutesRaw = document.getElementById('createEstimatedMinutes').value;
        var payload = {
            title:             title,
            category:          document.getElementById('createCategory').value.trim() || null,
            summary:           document.getElementById('createSummary').value.trim() || null,
            instruction_body:  body,
            estimated_minutes: minutesRaw !== '' ? Number(minutesRaw) : null,
            difficulty:        document.getElementById('createDifficulty').value || null,
            requires_review:   document.getElementById('createRequiresReview').value === 'true',
            effective_from:    document.getElementById('createEffectiveFrom').value || null,
            effective_to:      document.getElementById('createEffectiveTo').value   || null,
            internal_notes:    document.getElementById('createInternalNotes').value.trim() || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to create SOP');
            _showToast('SOP created (draft)');
            sopCloseCreate();
            ['createTitle','createCategory','createSummary','createInstructionBody','createEstimatedMinutes',
             'createEffectiveFrom','createEffectiveTo','createInternalNotes'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('createDifficulty').value = '';
            document.getElementById('createRequiresReview').value = 'true';
            sopLoad();
        })
        .catch(function () { _submitting = false; _showToast('Network error — could not create SOP'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function sopOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'instruction';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentSop = d;
                _renderTabBar();
                _activateTab('instruction');
                _renderFooter();
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load SOP</div>';
            });
    }

    function sopCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId  = null;
        _currentSop = null;
    }

    function _renderTabBar() {
        var tabs = [
            { key: 'instruction', label: 'Instruction' },
            { key: 'links',       label: 'Links'       },
            { key: 'history',     label: 'History'     },
        ];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="sopOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function sopOpenTab(tab) {
        _currentTab = tab;
        if (_currentSop) {
            _activateTab(tab);
            _renderTabBar();
        }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        switch (tab) {
            case 'instruction': _renderInstructionTab(body); break;
            case 'links':       _loadLinksTab(body);          break;
            case 'history':     _loadHistoryTab(body);        break;
        }
    }

    // ── Instruction tab ───────────────────────────────────────────────────────

    function _renderInstructionTab(body) {
        var s = _currentSop;
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dRow('Status',       _statusPill(s.status));
        html += _dRow('Category',     s.category ? '<span class="cat-chip">' + _html(s.category) + '</span>' : '—');
        html += _dRow('Difficulty',   _diffBadge(s.difficulty));
        html += _dRow('Est. Minutes', _html(s.estimated_minutes != null ? s.estimated_minutes : '—'));
        html += _dRow('Requires Review', s.requires_review ? 'Yes' : 'No');
        html += _dRow('Version',      'v' + _html(s.version || 1));
        html += _dRow('Effective From', _fmtDate(s.effective_from));
        html += _dRow('Effective To',   _fmtDate(s.effective_to));
        html += _dRow('Reviewed',     s.reviewed_at ? _fmt(s.reviewed_at) : '—');
        html += _dRow('Approved',     s.approved_at ? _fmt(s.approved_at) : '—');
        html += '</div>';
        if (s.summary) {
            html += '<div class="section-label">Summary</div>';
            html += '<div class="content-view">' + _html(s.summary) + '</div>';
        }
        html += '<div class="section-label">Instructions</div>';
        html += '<div class="content-view">' + _html(s.instruction_body) + '</div>';
        if (s.internal_notes) {
            html += '<div class="section-label">Internal Notes</div>';
            html += '<div class="content-view">' + _html(s.internal_notes) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function _dRow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + label + '</div><div class="detail-value">' + (value || '—') + '</div></div>';
    }

    // ── Links tab ─────────────────────────────────────────────────────────────

    function _loadLinksTab(body) {
        body.innerHTML = '<div class="loading-state">Loading links…</div>';
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/links')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderLinksTab(d.links || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load links</div>'; });
    }

    function _renderLinksTab(items, body) {
        var html = '<div class="tab-content">';
        html += '<div style="margin-bottom:10px;">';
        if (_currentSop.status !== 'archived') {
            html += '<button type="button" class="btn-action btn-success btn-sm" onclick="sopOpenLink()">+ Attach to Record</button>';
        }
        html += '</div>';
        if (!items.length) {
            html += '<div class="inline-msg info">Not attached to any record yet.</div>';
        } else {
            items.forEach(function (l) {
                html += '<div class="link-item">';
                html += '<div class="link-item-header">';
                html += '<span class="link-title">' + _html(LINKED_TYPE_LABELS[l.linked_type] || l.linked_type) + ' #' + _html(l.linked_id) + '</span>';
                html += '</div>';
                if (l.notes) html += '<div class="link-meta">' + _html(l.notes) + '</div>';
                html += '<div class="link-meta">Sort order ' + _html(l.sort_order || 0) + ' · Attached ' + _fmt(l.created_at) + '</div>';
                html += '<div style="margin-top:8px;">';
                html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="sopDeleteLink(' + l.id + ')">Remove</button>';
                html += '</div></div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function sopOpenLink() {
        document.getElementById('linkModal').classList.add('open');
    }

    function sopCloseLink() {
        document.getElementById('linkModal').classList.remove('open');
    }

    function sopSubmitLink() {
        if (_submitting) return;
        var linkedType = document.getElementById('linkType').value;
        var linkedId   = document.getElementById('linkRecordId').value.trim();
        if (!linkedId) return _showToast('Record ID is required');

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                linked_type: linkedType,
                linked_id:   Number(linkedId),
                sort_order:  Number(document.getElementById('linkSortOrder').value || 0),
                notes:       document.getElementById('linkNotes').value.trim() || null,
            }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to attach SOP');
            _showToast('SOP attached');
            sopCloseLink();
            document.getElementById('linkRecordId').value = '';
            document.getElementById('linkSortOrder').value = '0';
            document.getElementById('linkNotes').value = '';
            _loadLinksTab(document.getElementById('detailBody'));
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    function sopDeleteLink(linkId) {
        if (!window.confirm('Remove this attachment?')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/links/' + linkId, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            if (!r.ok) return _showToast(r.data.error || 'Failed to remove attachment');
            _showToast('Attachment removed');
            _loadLinksTab(document.getElementById('detailBody'));
        })
        .catch(function () { _showToast('Network error'); });
    }

    // ── History tab (events) ──────────────────────────────────────────────────

    function _loadHistoryTab(body) {
        body.innerHTML = '<div class="loading-state">Loading history…</div>';
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderHistoryTab(d.events || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load history</div>'; });
    }

    function _renderHistoryTab(items, body) {
        var html = '<div class="tab-content">';
        if (!items.length) {
            html += '<div class="inline-msg info">No history recorded yet.</div>';
        } else {
            items.forEach(function (ev) {
                html += '<div class="event-item">';
                html += '<div class="event-header">';
                html += '<span class="event-type">' + _html(EV_LABELS[ev.event_type] || ev.event_type) + '</span>';
                html += '<span class="event-time">' + _fmt(ev.created_at) + '</span>';
                html += '</div>';
                if (ev.old_status || ev.new_status) {
                    html += '<div class="event-status-change">';
                    if (ev.old_status) html += _statusPill(ev.old_status);
                    if (ev.old_status && ev.new_status) html += '<span class="event-arrow">→</span>';
                    if (ev.new_status) html += _statusPill(ev.new_status);
                    html += '</div>';
                }
                if (ev.notes) html += '<div class="event-notes">' + _html(ev.notes) + '</div>';
                html += '</div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    // ── Detail footer ─────────────────────────────────────────────────────────

    function _renderFooter() {
        var s = _currentSop;
        var st = s.status;
        var html = '<button type="button" class="btn-action btn-secondary" onclick="sopCloseDetail()">Close</button>';

        if (st !== 'archived') {
            html += '<button type="button" class="btn-action btn-secondary" onclick="sopOpenEdit()">Edit</button>';
            if (st === 'draft') {
                html += '<button type="button" class="btn-action btn-primary" onclick="sopSubmitReview()">Submit for Review</button>';
            }
            if (st === 'under_review') {
                html += '<button type="button" class="btn-action btn-success" onclick="sopApprove()">Approve</button>';
            }
            html += '<button type="button" class="btn-action btn-danger" onclick="sopArchive()">Archive</button>';
        }
        // Codebox 48 — QMS integration
        html += '<a href="/practice/quality-management.html?linked_type=sop&linked_id=' + encodeURIComponent(s.id) + '" ' +
            'style="display:inline-flex;align-items:center;padding:7px 14px;background:#1e2d4d;color:#90cdf4;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;" ' +
            'title="View quality reviews for this SOP">QMS Review ↗</a>';

        document.getElementById('detailFooter').innerHTML = html;
    }

    function sopSubmitReview() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/submit-review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to submit for review');
                _showToast('Marked as submitted for review');
                sopOpenDetail(_currentId);
            })
            .catch(function () { _showToast('Network error'); });
    }

    function sopApprove() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/approve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to approve');
                _showToast('SOP approved');
                sopOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function sopArchive() {
        if (!window.confirm('Archive this SOP? It will no longer appear as an active procedure.')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to archive');
                _showToast('SOP archived');
                sopCloseDetail();
                sopLoad();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Edit Modal ────────────────────────────────────────────────────────────

    function sopOpenEdit() {
        var s = _currentSop;
        document.getElementById('editTitle').value             = s.title || '';
        document.getElementById('editCategory').value           = s.category || '';
        document.getElementById('editDifficulty').value         = s.difficulty || '';
        document.getElementById('editEstimatedMinutes').value   = s.estimated_minutes != null ? s.estimated_minutes : '';
        document.getElementById('editRequiresReview').value     = s.requires_review ? 'true' : 'false';
        document.getElementById('editSummary').value            = s.summary || '';
        document.getElementById('editInstructionBody').value    = s.instruction_body || '';
        document.getElementById('editEffectiveFrom').value      = s.effective_from || '';
        document.getElementById('editEffectiveTo').value        = s.effective_to   || '';
        document.getElementById('editInternalNotes').value      = s.internal_notes || '';

        var warning = document.getElementById('editWarning');
        if (s.status === 'approved') {
            warning.innerHTML = '<div class="inline-msg info">This SOP is approved. Saving content changes will bump the version and return it to draft for re-review/re-approval.</div>';
        } else {
            warning.innerHTML = '';
        }

        document.getElementById('detailModal').classList.remove('open');
        document.getElementById('editModal').classList.add('open');
    }

    function sopCloseEdit() {
        document.getElementById('editModal').classList.remove('open');
        document.getElementById('detailModal').classList.add('open');
    }

    function sopSubmitEdit() {
        if (_submitting) return;
        var title = document.getElementById('editTitle').value.trim();
        var body  = document.getElementById('editInstructionBody').value.trim();
        if (!title) return _showToast('Title is required');
        if (!body)  return _showToast('Instructions are required');

        var minutesRaw = document.getElementById('editEstimatedMinutes').value;
        var payload = {
            title:             title,
            category:          document.getElementById('editCategory').value.trim() || null,
            summary:           document.getElementById('editSummary').value.trim() || null,
            instruction_body:  body,
            estimated_minutes: minutesRaw !== '' ? Number(minutesRaw) : null,
            difficulty:        document.getElementById('editDifficulty').value || null,
            requires_review:   document.getElementById('editRequiresReview').value === 'true',
            effective_from:    document.getElementById('editEffectiveFrom').value || null,
            effective_to:      document.getElementById('editEffectiveTo').value   || null,
            internal_notes:    document.getElementById('editInternalNotes').value.trim() || null,
        };

        _submitting = true;
        window.PracticeAPI.fetch(BASE + '/' + _currentId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to save changes');
            _showToast('SOP updated');
            document.getElementById('editModal').classList.remove('open');
            sopOpenDetail(_currentId);
            _loadSummary();
            _loadList();
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.sopLoad            = sopLoad;
    window.sopOpenCreate      = sopOpenCreate;
    window.sopCloseCreate     = sopCloseCreate;
    window.sopSubmitCreate    = sopSubmitCreate;
    window.sopOpenDetail      = sopOpenDetail;
    window.sopCloseDetail     = sopCloseDetail;
    window.sopOpenTab         = sopOpenTab;
    window.sopClearFilters    = sopClearFilters;
    window.sopOpenEdit        = sopOpenEdit;
    window.sopCloseEdit       = sopCloseEdit;
    window.sopSubmitEdit      = sopSubmitEdit;
    window.sopSubmitReview    = sopSubmitReview;
    window.sopApprove         = sopApprove;
    window.sopArchive         = sopArchive;
    window.sopOpenLink        = sopOpenLink;
    window.sopCloseLink       = sopCloseLink;
    window.sopSubmitLink      = sopSubmitLink;
    window.sopDeleteLink      = sopDeleteLink;
    window._sopFilterStatus   = _sopFilterStatus;
    window._sopPage           = _sopPage;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        sopLoad();
    });

}());
