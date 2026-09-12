(function () {
    var api = window.CollectorAPI;
    var state = {
        clients: [],
        selectedClientId: null,
        templates: [],
        periods: [],
        selectedPeriodId: null,
        periodItems: [],
        periodDocuments: []
    };

    function esc(s) { return api.escHtml(s); }

    // ── Bootstrapping ─────────────────────────────────────────────────────
    async function init() {
        if (!api.getToken()) { window.location.href = '/'; return; }
        await loadClients();
        document.getElementById('newClientBtn').addEventListener('click', showNewClientModal);
    }

    // ── Clients ───────────────────────────────────────────────────────────
    async function loadClients() {
        try {
            var data = await api.json('/clients?status=all');
            state.clients = data.clients || [];
            renderClientList();
        } catch (err) {
            api.showToast(err.message, true);
        }
    }

    function renderClientList() {
        var el = document.getElementById('clientList');
        if (!state.clients.length) {
            el.innerHTML = '<div class="empty-state">No clients yet</div>';
            return;
        }
        el.innerHTML = state.clients.map(function (c) {
            var activeCls = c.id === state.selectedClientId ? ' active' : '';
            return '<div class="client-item' + activeCls + '" data-id="' + c.id + '">' +
                '<div class="name">' + esc(c.display_name) + '</div>' +
                '<div class="juris">' + esc(c.jurisdiction) + ' &middot; ' + esc(c.status) + '</div>' +
                '</div>';
        }).join('');
        Array.prototype.forEach.call(el.querySelectorAll('.client-item'), function (node) {
            node.addEventListener('click', function () { selectClient(parseInt(node.dataset.id, 10)); });
        });
    }

    function showNewClientModal() {
        openModal('New Client', [
            { name: 'display_name', label: 'Client name', required: true },
            { name: 'primary_contact_name', label: 'Contact name' },
            { name: 'primary_contact_email', label: 'Contact email', required: true, type: 'email' },
            { name: 'jurisdiction', label: 'Jurisdiction', type: 'select', options: ['ZA', 'UK', 'AU_NZ', 'US'], value: 'ZA' }
        ], async function (values) {
            var client = await api.json('/clients', { method: 'POST', body: JSON.stringify(values) });
            api.showToast('Client created');
            await loadClients();
            selectClient(client.client.id);
        });
    }

    async function selectClient(id) {
        state.selectedClientId = id;
        renderClientList();
        try {
            var [tplData, perData] = await Promise.all([
                api.json('/clients/' + id + '/templates?active=all'),
                api.json('/clients/' + id + '/periods')
            ]);
            state.templates = tplData.templates || [];
            state.periods = perData.periods || [];
            state.selectedPeriodId = null;
            renderClientDetail();
        } catch (err) {
            api.showToast(err.message, true);
        }
    }

    function currentClient() {
        return state.clients.find(function (c) { return c.id === state.selectedClientId; });
    }

    function renderClientDetail() {
        var client = currentClient();
        var el = document.getElementById('main');
        if (!client) { el.innerHTML = '<div class="empty-state">Select a client, or create a new one.</div>'; return; }

        el.innerHTML =
            '<div class="card">' +
              '<h3>' + esc(client.display_name) + ' <span class="badge badge-' + esc(client.status) + '">' + esc(client.status) + '</span></h3>' +
              '<div class="row"><div>' + esc(client.primary_contact_name || '') + ' &lt;' + esc(client.primary_contact_email) + '&gt; &middot; ' + esc(client.jurisdiction) + '</div></div>' +
            '</div>' +
            '<div class="card">' +
              '<div class="row" style="justify-content:space-between;"><h3 style="margin:0;">Recurring Checklist</h3><button class="btn btn-sm" id="newTemplateBtn">+ Add item</button></div>' +
              renderTemplatesTable() +
            '</div>' +
            '<div class="card">' +
              '<div class="row" style="justify-content:space-between;"><h3 style="margin:0;">Periods</h3><button class="btn btn-sm btn-primary" id="newPeriodBtn">+ Open period</button></div>' +
              renderPeriodsTable() +
            '</div>' +
            '<div id="periodDetailCard"></div>';

        document.getElementById('newTemplateBtn').addEventListener('click', showNewTemplateModal);
        document.getElementById('newPeriodBtn').addEventListener('click', showNewPeriodModal);
        Array.prototype.forEach.call(el.querySelectorAll('.period-row'), function (row) {
            row.addEventListener('click', function () { selectPeriod(parseInt(row.dataset.id, 10)); });
        });
        Array.prototype.forEach.call(el.querySelectorAll('.tpl-delete'), function (btn) {
            btn.addEventListener('click', function (e) { e.stopPropagation(); deleteTemplate(parseInt(btn.dataset.id, 10)); });
        });

        if (state.selectedPeriodId) renderPeriodDetail();
    }

    function renderTemplatesTable() {
        var active = state.templates.filter(function (t) { return t.active; });
        if (!active.length) return '<div class="empty-state">No checklist items yet — add what this client sends every month.</div>';
        return '<table><thead><tr><th>Label</th><th>Type</th><th>Required</th><th></th></tr></thead><tbody>' +
            active.map(function (t) {
                return '<tr><td>' + esc(t.label) + '</td><td>' + esc(t.doc_type) + '</td><td>' + (t.is_required ? 'Yes' : 'No') +
                    '</td><td><button class="btn btn-sm btn-danger tpl-delete" data-id="' + t.id + '">Remove</button></td></tr>';
            }).join('') + '</tbody></table>';
    }

    function renderPeriodsTable() {
        if (!state.periods.length) return '<div class="empty-state">No periods opened yet.</div>';
        return '<table><thead><tr><th>Period</th><th>Status</th><th>Opened</th></tr></thead><tbody>' +
            state.periods.map(function (p) {
                return '<tr class="period-row" data-id="' + p.id + '" style="cursor:pointer;">' +
                    '<td>' + esc(p.period_label) + '</td>' +
                    '<td><span class="badge badge-' + esc(p.status) + '">' + esc(p.status) + '</span></td>' +
                    '<td>' + new Date(p.opened_at).toLocaleDateString() + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    function showNewTemplateModal() {
        openModal('Add Checklist Item', [
            { name: 'label', label: 'Label (shown to client)', required: true, placeholder: 'e.g. ABSA Salaries bank statement' },
            { name: 'doc_type', label: 'Document type', type: 'select', options: ['bank_statement', 'petty_cash', 'payroll_report', 'sales_invoices', 'purchase_receipts', 'ar_ap', 'other'], value: 'bank_statement' },
            { name: 'is_required', label: 'Required', type: 'checkbox', value: true }
        ], async function (values) {
            values.is_required = !!values.is_required;
            await api.json('/clients/' + state.selectedClientId + '/templates', { method: 'POST', body: JSON.stringify(values) });
            api.showToast('Checklist item added');
            await selectClient(state.selectedClientId);
        });
    }

    async function deleteTemplate(id) {
        if (!confirm('Remove this checklist item? Existing open periods are unaffected.')) return;
        try {
            await api.json('/templates/' + id, { method: 'DELETE' });
            api.showToast('Removed');
            await selectClient(state.selectedClientId);
        } catch (err) { api.showToast(err.message, true); }
    }

    function showNewPeriodModal() {
        var now = new Date();
        var defaultLabel = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        openModal('Open New Period', [
            { name: 'period_label', label: 'Period label', required: true, value: defaultLabel, placeholder: 'e.g. 2026-08' }
        ], async function (values) {
            var res = await api.json('/clients/' + state.selectedClientId + '/periods', { method: 'POST', body: JSON.stringify(values) });
            api.showToast('Period opened');
            await selectClient(state.selectedClientId);
            selectPeriod(res.period.id);
        });
    }

    // ── Periods / Documents ──────────────────────────────────────────────
    async function selectPeriod(id) {
        state.selectedPeriodId = id;
        try {
            var data = await api.json('/periods/' + id);
            state.periodItems = data.items || [];
            state.periodDocuments = data.documents || [];
            state.currentPeriod = data.period;
            renderPeriodDetail();
        } catch (err) { api.showToast(err.message, true); }
    }

    function renderPeriodDetail() {
        var el = document.getElementById('periodDetailCard');
        if (!el) return;
        var period = state.currentPeriod;
        if (!period) { el.innerHTML = ''; return; }

        el.innerHTML =
            '<div class="card">' +
              '<div class="row" style="justify-content:space-between;">' +
                '<h3 style="margin:0;">Period ' + esc(period.period_label) + ' <span class="badge badge-' + esc(period.status) + '">' + esc(period.status) + '</span></h3>' +
                '<div class="row">' +
                  '<button class="btn btn-sm btn-primary" id="sendBtn">Send request</button>' +
                  '<button class="btn btn-sm" id="resendBtn">Send reminder</button>' +
                  (period.status === 'closed'
                    ? '<button class="btn btn-sm" id="reopenBtn">Reopen</button>'
                    : '<button class="btn btn-sm btn-danger" id="closeBtn">Close</button>') +
                '</div>' +
              '</div>' +
              '<h4>Checklist</h4>' +
              renderItemsTable() +
              '<h4>Uploaded documents</h4>' +
              renderDocumentsTable() +
            '</div>';

        document.getElementById('sendBtn').addEventListener('click', function () { sendRequest('initial_request'); });
        document.getElementById('resendBtn').addEventListener('click', function () { sendRequest('reminder'); });
        var closeBtn = document.getElementById('closeBtn');
        if (closeBtn) closeBtn.addEventListener('click', closePeriod);
        var reopenBtn = document.getElementById('reopenBtn');
        if (reopenBtn) reopenBtn.addEventListener('click', reopenPeriod);

        Array.prototype.forEach.call(el.querySelectorAll('.doc-accept'), function (btn) {
            btn.addEventListener('click', function () { showAcceptModal(parseInt(btn.dataset.id, 10)); });
        });
        Array.prototype.forEach.call(el.querySelectorAll('.doc-reject'), function (btn) {
            btn.addEventListener('click', function () { rejectDocument(parseInt(btn.dataset.id, 10)); });
        });
        Array.prototype.forEach.call(el.querySelectorAll('.doc-view'), function (btn) {
            btn.addEventListener('click', function () { viewDocument(parseInt(btn.dataset.id, 10)); });
        });
    }

    function renderItemsTable() {
        if (!state.periodItems.length) return '<div class="empty-state">No checklist items for this period.</div>';
        return '<table><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody>' +
            state.periodItems.map(function (i) {
                return '<tr><td>' + esc(i.label) + (i.is_required ? '' : ' <span style="color:var(--text-muted);">(optional)</span>') +
                    '</td><td><span class="badge badge-' + esc(i.status) + '">' + esc(i.status) + '</span></td></tr>';
            }).join('') + '</tbody></table>';
    }

    function renderDocumentsTable() {
        if (!state.periodDocuments.length) return '<div class="empty-state">No documents uploaded yet.</div>';
        return '<table><thead><tr><th>File</th><th>Status</th><th>Uploaded</th><th></th></tr></thead><tbody>' +
            state.periodDocuments.map(function (d) {
                var actions = '<button class="btn btn-sm doc-view" data-id="' + d.id + '">View</button>';
                if (d.status === 'uploaded' || d.status === 'needs_review') {
                    actions += ' <button class="btn btn-sm btn-primary doc-accept" data-id="' + d.id + '">Match &amp; accept</button>' +
                        ' <button class="btn btn-sm btn-danger doc-reject" data-id="' + d.id + '">Reject</button>';
                }
                var flag = d.flag_reason ? ' <span class="badge badge-needs_review">' + esc(d.flag_reason) + '</span>' : '';
                return '<tr><td>' + esc(d.original_filename) + flag + '</td>' +
                    '<td><span class="badge badge-' + esc(d.status) + '">' + esc(d.status) + '</span></td>' +
                    '<td>' + new Date(d.created_at).toLocaleString() + '</td>' +
                    '<td>' + actions + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    async function sendRequest(commType) {
        try {
            var res = await api.json('/periods/' + state.selectedPeriodId + '/send', {
                method: 'POST', body: JSON.stringify({ comm_type: commType })
            });
            api.showToast('Email sent');
            console.log('Upload link (for reference):', res.upload_url);
        } catch (err) {
            api.showToast(err.message, true);
        }
    }

    async function closePeriod() {
        if (!confirm('Close this period? The client\'s upload link will stop working immediately.')) return;
        await api.json('/periods/' + state.selectedPeriodId + '/close', { method: 'POST' });
        api.showToast('Period closed');
        selectPeriod(state.selectedPeriodId);
    }

    async function reopenPeriod() {
        await api.json('/periods/' + state.selectedPeriodId + '/reopen', { method: 'POST' });
        api.showToast('Period reopened');
        selectPeriod(state.selectedPeriodId);
    }

    async function viewDocument(id) {
        try {
            var data = await api.json('/documents/' + id + '/signed-url');
            window.open(data.url, '_blank');
        } catch (err) { api.showToast(err.message, true); }
    }

    function showAcceptModal(docId) {
        var outstanding = state.periodItems.filter(function (i) { return i.status !== 'accepted' && i.status !== 'waived'; });
        if (!outstanding.length) { api.showToast('No outstanding checklist items to match against.', true); return; }
        openModal('Match Document', [
            { name: 'period_item_id', label: 'Matches checklist item', type: 'select', options: outstanding.map(function (i) { return { value: i.id, label: i.label }; }) }
        ], async function (values) {
            await api.json('/documents/' + docId + '/accept', { method: 'POST', body: JSON.stringify({ period_item_id: parseInt(values.period_item_id, 10) }) });
            api.showToast('Document accepted');
            selectPeriod(state.selectedPeriodId);
        });
    }

    async function rejectDocument(docId) {
        var reason = prompt('Reason for rejecting this document (optional):') || '';
        try {
            await api.json('/documents/' + docId + '/reject', { method: 'POST', body: JSON.stringify({ rejection_reason: reason }) });
            api.showToast('Document rejected');
            selectPeriod(state.selectedPeriodId);
        } catch (err) { api.showToast(err.message, true); }
    }

    // ── Generic modal helper ─────────────────────────────────────────────
    function openModal(title, fields, onSubmit) {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        var fieldsHtml = fields.map(function (f) {
            if (f.type === 'select') {
                var opts = (Array.isArray(f.options) ? f.options : []).map(function (o) {
                    var val = typeof o === 'object' ? o.value : o;
                    var label = typeof o === 'object' ? o.label : o;
                    var sel = (f.value !== undefined && String(f.value) === String(val)) ? ' selected' : '';
                    return '<option value="' + esc(val) + '"' + sel + '>' + esc(label) + '</option>';
                }).join('');
                return '<label>' + esc(f.label) + '</label><select name="' + f.name + '">' + opts + '</select>';
            }
            if (f.type === 'checkbox') {
                return '<label><input type="checkbox" name="' + f.name + '" ' + (f.value ? 'checked' : '') + ' style="width:auto;display:inline-block;margin-right:6px;">' + esc(f.label) + '</label>';
            }
            return '<label>' + esc(f.label) + '</label><input type="' + (f.type || 'text') + '" name="' + f.name + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '">';
        }).join('');

        overlay.innerHTML = '<div class="modal">' +
            '<h3>' + esc(title) + '</h3>' +
            '<form id="modalForm">' + fieldsHtml + '<div class="row" style="justify-content:flex-end;margin-top:16px;">' +
            '<button type="button" class="btn" id="modalCancel">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Save</button>' +
            '</div></form></div>';
        document.body.appendChild(overlay);

        overlay.querySelector('#modalCancel').addEventListener('click', function () { overlay.remove(); });
        overlay.querySelector('#modalForm').addEventListener('submit', async function (e) {
            e.preventDefault();
            var form = e.target;
            var values = {};
            fields.forEach(function (f) {
                var input = form.elements[f.name];
                if (f.type === 'checkbox') values[f.name] = input.checked;
                else values[f.name] = input.value;
                if (f.required && !values[f.name]) throw new Error(f.label + ' is required');
            });
            try {
                await onSubmit(values);
                overlay.remove();
            } catch (err) {
                api.showToast(err.message, true);
            }
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
