/* Codebox 46 — Practice Knowledge Base + Technical Opinion Library
 * Human-controlled knowledge library. NOT AI-generated. NOT Sean AI.
 * Prefix: kb
 */
(function () {
    'use strict';

    var BASE        = '/api/practice/knowledge';
    var _currentId   = null;
    var _currentArticle = null;
    var _currentTab  = 'content';
    var _submitting  = false;
    var _page        = 1;
    var _urlLinkedType = null;
    var _urlLinkedId   = null;

    // ── Constants ────────────────────────────────────────────────────────────

    var STATUS_LABELS = {
        draft: 'Draft', under_review: 'Under Review',
        approved: 'Approved', archived: 'Archived',
    };

    var TYPE_LABELS = {
        technical_opinion: 'Technical Opinion', sars_interpretation: 'SARS Interpretation',
        internal_policy: 'Internal Policy', sop: 'SOP',
        working_paper_note: 'Working Paper Note', client_position: 'Client Position',
        checklist_note: 'Checklist Note', template_note: 'Template Note',
        general_note: 'General Note',
    };

    var CATEGORY_LABELS = {
        income_tax: 'Income Tax', company_tax: 'Company Tax', provisional_tax: 'Provisional Tax',
        vat: 'VAT', paye: 'PAYE', payroll: 'Payroll', cipc: 'CIPC', coida: 'COIDA',
        accounting: 'Accounting', audit: 'Audit', secretarial: 'Secretarial',
        internal_policy: 'Internal Policy', workflow: 'Workflow', other: 'Other',
    };

    var EV_LABELS = {
        knowledge_article_created: 'Article Created', knowledge_article_updated: 'Updated',
        knowledge_article_submitted_review: 'Submitted for Review', knowledge_article_approved: 'Approved',
        knowledge_article_archived: 'Archived', knowledge_article_linked: 'Linked',
        knowledge_article_unlinked: 'Unlinked',
    };

    var LINKED_TYPE_LABELS = {
        client: 'Client', taxpayer_profile: 'Taxpayer Profile',
        individual_tax_return: 'Individual Tax Return', company_tax_return: 'Company Tax Return',
        provisional_tax_plan: 'Provisional Tax Plan', tax_submission: 'Tax Submission',
        sars_statement_line: 'SARS Statement Line', tax_dispute: 'Tax Dispute',
        tax_completion_pack: 'Tax Completion Pack', workflow_run: 'Workflow Run',
        task: 'Task', document_request: 'Document Request', compliance_pack: 'Compliance Pack',
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

    function _typeBadge(t) {
        return '<span class="ct-badge">' + _html(TYPE_LABELS[t] || t) + '</span>';
    }

    function _tagChips(tags) {
        if (!Array.isArray(tags) || !tags.length) return '<span style="color:#4a5568;">—</span>';
        return tags.map(function (t) { return '<span class="tag-chip">' + _html(t) + '</span>'; }).join('');
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
        var category = document.getElementById('filterCategory').value;
        var type     = document.getElementById('filterType').value;
        var status   = document.getElementById('filterStatus').value;
        var tag      = document.getElementById('filterTag').value.trim();
        var search   = document.getElementById('filterSearch').value.trim();
        if (category) p.push('category='     + encodeURIComponent(category));
        if (type)     p.push('article_type=' + encodeURIComponent(type));
        if (status)   p.push('status='       + encodeURIComponent(status));
        if (tag)      p.push('tag='          + encodeURIComponent(tag));
        if (search)   p.push('search='       + encodeURIComponent(search));
        p.push('page=' + _page);
        return p.length ? ('?' + p.join('&')) : '';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function kbLoad() {
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
        banner.innerHTML = 'Showing knowledge linked to <strong>' + _html(LINKED_TYPE_LABELS[linkedType] || linkedType) + ' #' + _html(linkedId) + '</strong> — <span id="linkedBannerCount">loading…</span>';
        var content = document.querySelector('.page-content');
        content.insertBefore(banner, content.children[1]);

        window.PracticeAPI.fetch(BASE + '/linked/' + encodeURIComponent(linkedType) + '/' + encodeURIComponent(linkedId))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var countEl = document.getElementById('linkedBannerCount');
                if (!countEl) return;
                var arts = d.articles || [];
                if (!arts.length) {
                    countEl.textContent = 'no articles linked yet.';
                    return;
                }
                countEl.innerHTML = arts.length + ' article(s): ' + arts.map(function (a) {
                    return '<a href="#" onclick="kbOpenDetail(' + a.id + ');return false;" style="color:#a3bffa;">' + _html(a.title) + '</a>';
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
            { cls: 'sc-review',   count: d.under_review  || 0, label: 'Under Review', filter: 'under_review' },
            { cls: 'sc-approved', count: d.approved      || 0, label: 'Approved',     filter: 'approved' },
            { cls: 'sc-archived', count: d.archived      || 0, label: 'Archived',     filter: 'archived' },
        ];
        grid.innerHTML = cards.map(function (c) {
            return '<div class="summary-card ' + c.cls + '" onclick="_kbFilterStatus(\'' + c.filter + '\')">' +
                '<div class="sc-count">' + c.count + '</div>' +
                '<div class="sc-label">' + c.label + '</div>' +
            '</div>';
        }).join('');
    }

    function _kbFilterStatus(s) {
        document.getElementById('filterStatus').value = s;
        _page = 1;
        _loadList();
    }

    // ── List ─────────────────────────────────────────────────────────────────

    function _loadList() {
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderList(d.articles || [], d.total || 0, d.page || 1, d.limit || 50); })
            .catch(function () {
                document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="8" style="color:#fc8181;">Failed to load knowledge articles</td></tr>';
            });
    }

    function _renderList(items, total, page, perPage) {
        var tbody = document.getElementById('tableBody');
        if (!items.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No articles found. Create the first knowledge article.</td></tr>';
            document.getElementById('pagination').textContent = '';
            return;
        }
        tbody.innerHTML = items.map(function (a) {
            return '<tr onclick="kbOpenDetail(' + a.id + ')">' +
                '<td style="color:#4a5568;font-size:.78rem;">#' + a.id + '</td>' +
                '<td>' + _typeBadge(a.article_type) + '</td>' +
                '<td>' + _statusPill(a.status) + '</td>' +
                '<td class="td-title" title="' + _html(a.title) + '">' + _html(a.title) + '</td>' +
                '<td style="font-size:.8rem;color:#a0aec0;">' + _html(CATEGORY_LABELS[a.category] || a.category) + '</td>' +
                '<td>' + _tagChips(a.tags) + '</td>' +
                '<td style="font-size:.8rem;">v' + _html(a.version || 1) + '</td>' +
                '<td style="font-size:.78rem;color:#718096;">' + _fmt(a.updated_at) + '</td>' +
            '</tr>';
        }).join('');

        var pageEl = document.getElementById('pagination');
        var totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
            pageEl.innerHTML = 'Page ' + page + ' of ' + totalPages +
                (page > 1 ? ' <button onclick="_kbPage(' + (page - 1) + ')" style="margin-left:8px;background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">← Prev</button>' : '') +
                (page < totalPages ? ' <button onclick="_kbPage(' + (page + 1) + ')" style="background:#2d3748;border:none;color:#e2e8f0;padding:4px 10px;border-radius:5px;cursor:pointer;">Next →</button>' : '');
        } else {
            pageEl.textContent = total + ' article' + (total !== 1 ? 's' : '');
        }
    }

    function _kbPage(p) { _page = p; _loadList(); }

    // ── Filters ───────────────────────────────────────────────────────────────

    function kbClearFilters() {
        ['filterCategory','filterType','filterStatus','filterTag','filterSearch'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        _page = 1;
        _loadList();
    }

    // ── Create Article ───────────────────────────────────────────────────────

    function kbOpenCreate() {
        document.getElementById('createModal').classList.add('open');
    }

    function kbCloseCreate() {
        document.getElementById('createModal').classList.remove('open');
    }

    function kbSubmitCreate() {
        if (_submitting) return;
        var title    = document.getElementById('createTitle').value.trim();
        var category = document.getElementById('createCategory').value;
        var type     = document.getElementById('createType').value;
        var content  = document.getElementById('createContent').value.trim();
        if (!title)    return _showToast('Title is required');
        if (!category) return _showToast('Category is required');
        if (!type)     return _showToast('Type is required');
        if (!content)  return _showToast('Content is required');

        var payload = {
            title:            title,
            category:         category,
            article_type:     type,
            summary:          document.getElementById('createSummary').value.trim() || null,
            content:          content,
            tags:             document.getElementById('createTags').value.trim() || null,
            source_reference: document.getElementById('createSourceRef').value.trim() || null,
            effective_from:   document.getElementById('createEffectiveFrom').value || null,
            effective_to:     document.getElementById('createEffectiveTo').value   || null,
            internal_notes:   document.getElementById('createInternalNotes').value.trim() || null,
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
            if (!r.ok) return _showToast(r.data.error || 'Failed to create article');
            _showToast('Article created (draft)');
            kbCloseCreate();
            ['createTitle','createSummary','createContent','createTags','createSourceRef',
             'createEffectiveFrom','createEffectiveTo','createInternalNotes'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('createCategory').value = '';
            document.getElementById('createType').value = '';
            kbLoad();
        })
        .catch(function () { _submitting = false; _showToast('Network error — could not create article'); });
    }

    // ── Detail Modal ──────────────────────────────────────────────────────────

    function kbOpenDetail(id) {
        _currentId  = id;
        _currentTab = 'content';
        document.getElementById('detailModal').classList.add('open');
        document.getElementById('detailBody').innerHTML = '<div class="loading-state">Loading…</div>';
        document.getElementById('detailFooter').innerHTML = '';
        document.getElementById('detailTabBar').innerHTML = '';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentArticle = d;
                _renderTabBar();
                _activateTab('content');
                _renderFooter();
            })
            .catch(function () {
                document.getElementById('detailBody').innerHTML = '<div style="color:#fc8181;padding:20px;">Failed to load article</div>';
            });
    }

    function kbCloseDetail() {
        document.getElementById('detailModal').classList.remove('open');
        _currentId      = null;
        _currentArticle = null;
    }

    function _renderTabBar() {
        var tabs = [
            { key: 'content', label: 'Content' },
            { key: 'links',   label: 'Links'   },
            { key: 'events',  label: 'Events'  },
        ];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button type="button" class="tab-btn' + (t.key === _currentTab ? ' active' : '') + '" onclick="kbOpenTab(\'' + t.key + '\')">' + _html(t.label) + '</button>';
        }).join('');
    }

    function kbOpenTab(tab) {
        _currentTab = tab;
        if (_currentArticle) {
            _activateTab(tab);
            _renderTabBar();
        }
    }

    function _activateTab(tab) {
        var body = document.getElementById('detailBody');
        switch (tab) {
            case 'content': _renderContentTab(body); break;
            case 'links':   _loadLinksTab(body);      break;
            case 'events':  _loadEventsTab(body);     break;
        }
    }

    // ── Content tab ───────────────────────────────────────────────────────────

    function _renderContentTab(body) {
        var a = _currentArticle;
        var html = '<div class="tab-content">';
        html += '<div class="detail-grid">';
        html += _dRow('Type',      _typeBadge(a.article_type));
        html += _dRow('Status',    _statusPill(a.status));
        html += _dRow('Category',  _html(CATEGORY_LABELS[a.category] || a.category));
        html += _dRow('Version',   'v' + _html(a.version || 1));
        html += _dRow('Tags',      _tagChips(a.tags));
        html += _dRow('Source Reference', _html(a.source_reference || '—'));
        html += _dRow('Effective From',   _fmtDate(a.effective_from));
        html += _dRow('Effective To',     _fmtDate(a.effective_to));
        html += _dRow('Reviewed',  a.reviewed_at ? _fmt(a.reviewed_at) : '—');
        html += _dRow('Approved',  a.approved_at ? _fmt(a.approved_at) : '—');
        html += '</div>';
        if (a.summary) {
            html += '<div class="section-label">Summary</div>';
            html += '<div class="content-view">' + _html(a.summary) + '</div>';
        }
        html += '<div class="section-label">Content</div>';
        html += '<div class="content-view">' + _html(a.content) + '</div>';
        if (a.internal_notes) {
            html += '<div class="section-label">Internal Notes</div>';
            html += '<div class="content-view">' + _html(a.internal_notes) + '</div>';
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
        if (_currentArticle.status !== 'archived') {
            html += '<button type="button" class="btn-action btn-success btn-sm" onclick="kbOpenLink()">+ Link to Record</button>';
        }
        html += '</div>';
        if (!items.length) {
            html += '<div class="inline-msg info">No linked records yet.</div>';
        } else {
            items.forEach(function (l) {
                html += '<div class="link-item">';
                html += '<div class="link-item-header">';
                html += '<span class="link-title">' + _html(LINKED_TYPE_LABELS[l.linked_type] || l.linked_type) + ' #' + _html(l.linked_id) + '</span>';
                html += '</div>';
                if (l.notes) html += '<div class="link-meta">' + _html(l.notes) + '</div>';
                html += '<div class="link-meta">Linked ' + _fmt(l.created_at) + '</div>';
                html += '<div style="margin-top:8px;">';
                html += '<button type="button" class="btn-action btn-secondary btn-sm" onclick="kbDeleteLink(' + l.id + ')">Remove</button>';
                html += '</div></div>';
            });
        }
        html += '</div>';
        body.innerHTML = html;
    }

    function kbOpenLink() {
        document.getElementById('linkModal').classList.add('open');
    }

    function kbCloseLink() {
        document.getElementById('linkModal').classList.remove('open');
    }

    function kbSubmitLink() {
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
                notes:       document.getElementById('linkNotes').value.trim() || null,
            }),
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            _submitting = false;
            if (!r.ok) return _showToast(r.data.error || 'Failed to link article');
            _showToast('Article linked');
            kbCloseLink();
            document.getElementById('linkRecordId').value = '';
            document.getElementById('linkNotes').value = '';
            _loadLinksTab(document.getElementById('detailBody'));
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    function kbDeleteLink(linkId) {
        if (!window.confirm('Remove this link?')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/links/' + linkId, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
            if (!r.ok) return _showToast(r.data.error || 'Failed to remove link');
            _showToast('Link removed');
            _loadLinksTab(document.getElementById('detailBody'));
        })
        .catch(function () { _showToast('Network error'); });
    }

    // ── Events tab ────────────────────────────────────────────────────────────

    function _loadEventsTab(body) {
        body.innerHTML = '<div class="loading-state">Loading events…</div>';
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) { _renderEventsTab(d.events || [], body); })
            .catch(function () { body.innerHTML = '<div style="color:#fc8181;padding:16px;">Failed to load events</div>'; });
    }

    function _renderEventsTab(items, body) {
        var html = '<div class="tab-content">';
        if (!items.length) {
            html += '<div class="inline-msg info">No events recorded yet.</div>';
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
        var a = _currentArticle;
        var s = a.status;
        var html = '<button type="button" class="btn-action btn-secondary" onclick="kbCloseDetail()">Close</button>';

        if (s !== 'archived') {
            html += '<button type="button" class="btn-action btn-secondary" onclick="kbOpenEdit()">Edit</button>';
            if (s === 'draft') {
                html += '<button type="button" class="btn-action btn-primary" onclick="kbSubmitReview()">Submit for Review</button>';
            }
            if (s === 'under_review') {
                html += '<button type="button" class="btn-action btn-success" onclick="kbApprove()">Approve</button>';
            }
            html += '<button type="button" class="btn-action btn-danger" onclick="kbArchive()">Archive</button>';
        }
        // Codebox 49 — Risk Register integration
        html += '<a href="/practice/risk-register.html?source_type=knowledge_article&source_id=' + encodeURIComponent(a.id) + '" ' +
            'style="display:inline-flex;align-items:center;padding:7px 14px;background:#2d1e4d;color:#b794f4;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;" ' +
            'title="View or create a risk register entry for this article">Risk ↗</a>';

        document.getElementById('detailFooter').innerHTML = html;
    }

    function kbSubmitReview() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/submit-review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to submit for review');
                _showToast('Submitted for review');
                kbOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function kbApprove() {
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/approve', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to approve');
                _showToast('Article approved');
                kbOpenDetail(_currentId);
                _loadSummary();
                _loadList();
            })
            .catch(function () { _showToast('Network error'); });
    }

    function kbArchive() {
        if (!window.confirm('Archive this article? It will no longer appear as active knowledge.')) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentId + '/archive', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (r) {
                if (!r.ok) return _showToast(r.data.error || 'Failed to archive');
                _showToast('Article archived');
                kbCloseDetail();
                kbLoad();
            })
            .catch(function () { _showToast('Network error'); });
    }

    // ── Edit Modal ────────────────────────────────────────────────────────────

    function kbOpenEdit() {
        var a = _currentArticle;
        document.getElementById('editTitle').value          = a.title || '';
        document.getElementById('editCategory').value        = a.category || '';
        document.getElementById('editType').value             = a.article_type || '';
        document.getElementById('editSummary').value          = a.summary || '';
        document.getElementById('editContent').value          = a.content || '';
        document.getElementById('editTags').value             = Array.isArray(a.tags) ? a.tags.join(', ') : '';
        document.getElementById('editSourceRef').value        = a.source_reference || '';
        document.getElementById('editEffectiveFrom').value    = a.effective_from || '';
        document.getElementById('editEffectiveTo').value      = a.effective_to   || '';
        document.getElementById('editInternalNotes').value    = a.internal_notes || '';

        var warning = document.getElementById('editWarning');
        if (a.status === 'approved') {
            warning.innerHTML = '<div class="inline-msg info">This article is approved. Saving content changes will bump the version and return it to draft for re-review.</div>';
        } else {
            warning.innerHTML = '';
        }

        document.getElementById('detailModal').classList.remove('open');
        document.getElementById('editModal').classList.add('open');
    }

    function kbCloseEdit() {
        document.getElementById('editModal').classList.remove('open');
        document.getElementById('detailModal').classList.add('open');
    }

    function kbSubmitEdit() {
        if (_submitting) return;
        var title    = document.getElementById('editTitle').value.trim();
        var category = document.getElementById('editCategory').value;
        var type     = document.getElementById('editType').value;
        var content  = document.getElementById('editContent').value.trim();
        if (!title)    return _showToast('Title is required');
        if (!category) return _showToast('Category is required');
        if (!type)     return _showToast('Type is required');
        if (!content)  return _showToast('Content is required');

        var payload = {
            title:            title,
            category:         category,
            article_type:     type,
            summary:          document.getElementById('editSummary').value.trim() || null,
            content:          content,
            tags:             document.getElementById('editTags').value.trim() || null,
            source_reference: document.getElementById('editSourceRef').value.trim() || null,
            effective_from:   document.getElementById('editEffectiveFrom').value || null,
            effective_to:     document.getElementById('editEffectiveTo').value   || null,
            internal_notes:   document.getElementById('editInternalNotes').value.trim() || null,
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
            _showToast('Article updated');
            document.getElementById('editModal').classList.remove('open');
            kbOpenDetail(_currentId);
            _loadSummary();
            _loadList();
        })
        .catch(function () { _submitting = false; _showToast('Network error'); });
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    window.kbLoad            = kbLoad;
    window.kbOpenCreate      = kbOpenCreate;
    window.kbCloseCreate     = kbCloseCreate;
    window.kbSubmitCreate    = kbSubmitCreate;
    window.kbOpenDetail      = kbOpenDetail;
    window.kbCloseDetail     = kbCloseDetail;
    window.kbOpenTab         = kbOpenTab;
    window.kbClearFilters    = kbClearFilters;
    window.kbOpenEdit        = kbOpenEdit;
    window.kbCloseEdit       = kbCloseEdit;
    window.kbSubmitEdit      = kbSubmitEdit;
    window.kbSubmitReview    = kbSubmitReview;
    window.kbApprove         = kbApprove;
    window.kbArchive         = kbArchive;
    window.kbOpenLink        = kbOpenLink;
    window.kbCloseLink       = kbCloseLink;
    window.kbSubmitLink      = kbSubmitLink;
    window.kbDeleteLink      = kbDeleteLink;
    window._kbFilterStatus   = _kbFilterStatus;
    window._kbPage           = _kbPage;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        _checkUrlParams();
        kbLoad();
    });

}());
