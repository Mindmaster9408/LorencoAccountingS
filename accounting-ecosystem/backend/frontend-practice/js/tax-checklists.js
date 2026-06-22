// Practice Tax Checklist Templates (Codebox 36)
// Manages practice_tax_checklist_templates + controlled apply.
// No localStorage/KV for business data.
(function () {
    'use strict';

    var esc  = PracticeAPI.escHtml;
    var BASE = '/api/practice/tax-checklists';

    var _activeTemplateId   = null;
    var _activeTemplateName = null;
    var _submitting         = false;

    // ─── Init ─────────────────────────────────────────────────────────────────
    function init() {
        LAYOUT.init('tax-checklists');
        tcLoad();
    }

    // ─── Load template list ───────────────────────────────────────────────────
    async function tcLoad() {
        _setEl('tcList', '<div class="tc-loading">Loading templates…</div>');

        var qs = [];
        var fltType   = _val('tcFltType');
        var fltActive = _val('tcFltActive');
        if (fltType)   qs.push('template_type=' + encodeURIComponent(fltType));
        if (fltActive) qs.push('is_active=' + encodeURIComponent(fltActive));

        try {
            var res  = await PracticeAPI.fetch(BASE + '/templates' + (qs.length ? '?' + qs.join('&') : ''));
            var data = await res.json();
            var tpls = data.templates || [];

            if (tpls.length === 0) {
                _setEl('tcList', '<div class="tc-empty">No templates found. Click "Seed Defaults" to get started.</div>');
                return;
            }

            _setEl('tcList',
                '<table class="tc-table"><thead><tr>' +
                '<th>Template Name</th><th>Type</th><th>Client Type</th><th>Tax Year</th><th>Items</th><th>Status</th><th></th>' +
                '</tr></thead><tbody>' +
                tpls.map(function (t) {
                    var typeCls  = 'tc-b-' + (t.template_type || 'custom');
                    var isActive = t.is_active !== false;
                    return '<tr>' +
                        '<td><span style="font-weight:600;color:rgba(255,255,255,0.88);">' + esc(t.template_name) + '</span>' +
                            (t.is_default ? ' <span class="tc-badge tc-b-default">default</span>' : '') +
                            (t.description ? '<br><span style="font-size:0.7rem;color:rgba(255,255,255,0.3);">' + esc(t.description.substring(0,80)) + (t.description.length > 80 ? '…' : '') + '</span>' : '') +
                        '</td>' +
                        '<td><span class="tc-badge ' + typeCls + '">' + esc(_typeLabel(t.template_type)) + '</span></td>' +
                        '<td>' + esc(t.client_type ? _clientTypeLabel(t.client_type) : '—') + '</td>' +
                        '<td>' + esc(t.tax_year ? String(t.tax_year) : '—') + '</td>' +
                        '<td style="text-align:center;">' + (t.item_count || 0) + '</td>' +
                        '<td>' + (isActive ? '<span style="color:#34d399;font-size:0.78rem;">Active</span>' : '<span class="tc-badge tc-b-inactive">Inactive</span>') + '</td>' +
                        '<td style="display:flex;gap:0.3rem;flex-wrap:nowrap;">' +
                            '<button type="button" class="tc-btn items" data-id="' + t.id + '" data-name="' + esc(t.template_name.replace(/"/g,'')) + '" onclick="tcOpenItems(this)">Items</button>' +
                            '<button type="button" class="tc-btn apply" data-id="' + t.id + '" data-name="' + esc(t.template_name.replace(/"/g,'')) + '" onclick="tcOpenApply(this)">Apply</button>' +
                            '<button type="button" class="tc-btn" data-id="' + t.id + '" data-name="' + esc(t.template_name.replace(/"/g,'')) + '" data-type="' + t.template_type + '" data-ctype="' + (t.client_type || '') + '" data-year="' + (t.tax_year || '') + '" data-desc="' + esc((t.description || '').replace(/"/g,'')) + '" onclick="tcOpenEditModal(this)">Edit</button>' +
                            (isActive ? '<button type="button" class="tc-btn danger" data-id="' + t.id + '" onclick="tcDeactivate(this)">Deactivate</button>' : '') +
                        '</td>' +
                        '</tr>';
                }).join('') +
                '</tbody></table>'
            );
        } catch (err) {
            _setEl('tcList', '<div class="tc-error">Failed to load templates: ' + esc(err.message) + '</div>');
        }
    }
    window.tcLoad = tcLoad;

    // ─── Seed defaults ────────────────────────────────────────────────────────
    async function tcSeedDefaults() {
        if (_submitting) return;
        _submitting = true;
        try {
            var res  = await PracticeAPI.fetch(BASE + '/seed-defaults', { method: 'POST' });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            PracticeAPI.showToast('Seeded ' + data.templates_created + ' template(s). ' + data.templates_skipped + ' skipped (already existed).');
            tcLoad();
        } catch (err) {
            PracticeAPI.showToast('Seed failed: ' + err.message, true);
        } finally {
            _submitting = false;
        }
    }
    window.tcSeedDefaults = tcSeedDefaults;

    // ─── Deactivate ───────────────────────────────────────────────────────────
    async function tcDeactivate(btn) {
        var id = parseInt(btn.getAttribute('data-id'));
        if (!confirm('Deactivate this template?')) return;
        try {
            var res  = await PracticeAPI.fetch(BASE + '/templates/' + id, { method: 'DELETE' });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            PracticeAPI.showToast('Template deactivated.');
            if (_activeTemplateId === id) { _activeTemplateId = null; _setEl('tcItemPanel', ''); document.getElementById('tcItemPanel').style.display = 'none'; }
            tcLoad();
        } catch (err) {
            PracticeAPI.showToast('Error: ' + err.message, true);
        }
    }
    window.tcDeactivate = tcDeactivate;

    // ─── Template modal (create / edit) ──────────────────────────────────────
    function tcOpenCreateModal() {
        _setVal('tcTplId', '');
        _setVal('tcTplName', '');
        _setVal('tcTplType', 'individual_tax');
        _setVal('tcTplClientType', '');
        _setVal('tcTplTaxYear', '');
        _setVal('tcTplDescription', '');
        _setText('tcTplModalTitle', 'Create Template');
        _setText('tcTplSubmitBtn', 'Create');
        _hideErr('tcTplError');
        _openModal('tcTemplateModal');
    }
    window.tcOpenCreateModal = tcOpenCreateModal;

    function tcOpenEditModal(btn) {
        _setVal('tcTplId',          btn.getAttribute('data-id'));
        _setVal('tcTplName',        btn.getAttribute('data-name'));
        _setVal('tcTplType',        btn.getAttribute('data-type'));
        _setVal('tcTplClientType',  btn.getAttribute('data-ctype'));
        _setVal('tcTplTaxYear',     btn.getAttribute('data-year'));
        _setVal('tcTplDescription', btn.getAttribute('data-desc'));
        _setText('tcTplModalTitle', 'Edit Template');
        _setText('tcTplSubmitBtn', 'Save');
        _hideErr('tcTplError');
        _openModal('tcTemplateModal');
    }
    window.tcOpenEditModal = tcOpenEditModal;

    async function tcSubmitTemplate() {
        if (_submitting) return;
        var id   = _val('tcTplId');
        var name = (_val('tcTplName') || '').trim();
        if (!name) { _showErr('tcTplError', 'Template name is required.'); return; }

        _submitting = true;
        document.getElementById('tcTplSubmitBtn').disabled = true;
        _hideErr('tcTplError');

        var body = {
            template_name: name,
            template_type: _val('tcTplType'),
            client_type:   _val('tcTplClientType') || null,
            tax_year:      _val('tcTplTaxYear')    ? parseInt(_val('tcTplTaxYear')) : null,
            description:   (_val('tcTplDescription') || '').trim() || null,
        };

        try {
            var res  = id
                ? await PracticeAPI.fetch(BASE + '/templates/' + id, { method: 'PUT',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                : await PracticeAPI.fetch(BASE + '/templates',       { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            _closeModal('tcTemplateModal');
            PracticeAPI.showToast(id ? 'Template updated.' : 'Template created.');
            tcLoad();
        } catch (err) {
            _showErr('tcTplError', 'Error: ' + err.message);
        } finally {
            _submitting = false;
            document.getElementById('tcTplSubmitBtn').disabled = false;
        }
    }
    window.tcSubmitTemplate = tcSubmitTemplate;

    // ─── Template item editor ─────────────────────────────────────────────────
    async function tcOpenItems(btn) {
        var id   = parseInt(btn.getAttribute('data-id'));
        var name = btn.getAttribute('data-name') || 'Template';
        _activeTemplateId   = id;
        _activeTemplateName = name;

        document.getElementById('tcItemPanel').style.display = 'block';
        _setText('tcItemPanelTitle', 'Items: ' + name);
        _setEl('tcItemList', '<div class="tc-loading">Loading…</div>');

        try {
            var res  = await PracticeAPI.fetch(BASE + '/templates/' + id + '/items');
            var data = await res.json();
            var items = data.items || [];

            if (items.length === 0) {
                _setEl('tcItemList', '<div class="tc-empty">No items yet. Click "+ Add Item" to add one.</div>');
                return;
            }

            _setEl('tcItemList',
                items.map(function (item) {
                    return '<div class="tc-item-row">' +
                        '<div class="tc-item-name">' + esc(item.item_name) +
                            (item.item_description ? '<br><span style="font-size:0.7rem;color:rgba(255,255,255,0.3);">' + esc(item.item_description.substring(0,80)) + '</span>' : '') +
                        '</div>' +
                        '<div class="tc-item-meta">' + esc(_targetLabel(item.target_type)) + '</div>' +
                        '<div class="tc-item-meta">' + esc(item.item_category) + '</div>' +
                        '<div>' + (item.required ? '<span class="tc-item-req">Required</span>' : '<span class="tc-item-opt">Optional</span>') + '</div>' +
                        '<button type="button" class="tc-btn danger" data-id="' + item.id + '" data-tid="' + id + '" onclick="tcDeleteItem(this)">×</button>' +
                        '</div>';
                }).join('')
            );
        } catch (err) {
            _setEl('tcItemList', '<div class="tc-error">Failed to load items: ' + esc(err.message) + '</div>');
        }
    }
    window.tcOpenItems = tcOpenItems;

    function tcOpenAddItemModal() {
        if (!_activeTemplateId) return;
        _setVal('tcItTemplateId', _activeTemplateId);
        _setVal('tcItName', '');
        _setVal('tcItDescription', '');
        _setVal('tcItCategory', 'document');
        _setVal('tcItTargetType', 'document_request');
        _setVal('tcItDocCat', 'supporting_docs');
        _setVal('tcItDueOffset', '');
        document.getElementById('tcItRequired').checked = true;
        _hideErr('tcItError');
        tcItemTargetChanged();
        _openModal('tcItemModal');
    }
    window.tcOpenAddItemModal = tcOpenAddItemModal;

    function tcItemTargetChanged() {
        var t    = _val('tcItTargetType');
        var show = t === 'document_request';
        document.getElementById('tcItDocCatRow').style.display = show ? '' : 'none';
    }
    window.tcItemTargetChanged = tcItemTargetChanged;

    async function tcSubmitItem() {
        if (_submitting) return;
        var templateId = parseInt(_val('tcItTemplateId'));
        var name       = (_val('tcItName') || '').trim();
        if (!name) { _showErr('tcItError', 'Item name is required.'); return; }

        _submitting = true;
        document.getElementById('tcItSubmitBtn').disabled = true;
        _hideErr('tcItError');

        var targetType = _val('tcItTargetType');
        var settings   = {};
        if (targetType === 'document_request') settings.document_category = _val('tcItDocCat') || 'supporting_docs';

        var dueOffset = _val('tcItDueOffset');
        var body = {
            item_name:               name,
            item_description:        (_val('tcItDescription') || '').trim() || null,
            item_category:           _val('tcItCategory'),
            target_type:             targetType,
            required:                document.getElementById('tcItRequired').checked,
            default_due_offset_days: dueOffset ? parseInt(dueOffset) : null,
            settings,
        };

        try {
            var res  = await PracticeAPI.fetch(BASE + '/templates/' + templateId + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            _closeModal('tcItemModal');
            PracticeAPI.showToast('Item added.');
            tcOpenItems({ getAttribute: function (k) { return k === 'data-id' ? _activeTemplateId : _activeTemplateName; } });
        } catch (err) {
            _showErr('tcItError', 'Error: ' + err.message);
        } finally {
            _submitting = false;
            document.getElementById('tcItSubmitBtn').disabled = false;
        }
    }
    window.tcSubmitItem = tcSubmitItem;

    async function tcDeleteItem(btn) {
        var itemId     = parseInt(btn.getAttribute('data-id'));
        var templateId = parseInt(btn.getAttribute('data-tid'));
        if (!confirm('Remove this item from the template?')) return;
        try {
            var res  = await PracticeAPI.fetch(BASE + '/templates/' + templateId + '/items/' + itemId, { method: 'DELETE' });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            PracticeAPI.showToast('Item removed.');
            tcOpenItems({ getAttribute: function (k) { return k === 'data-id' ? _activeTemplateId : _activeTemplateName; } });
        } catch (err) {
            PracticeAPI.showToast('Error: ' + err.message, true);
        }
    }
    window.tcDeleteItem = tcDeleteItem;

    // ─── Apply modal ──────────────────────────────────────────────────────────
    var _applyDataLoaded = false;
    var _applyClients    = [];
    var _applyPacks      = [];
    var _applyIndReturns = [];
    var _applyCoReturns  = [];

    async function tcOpenApply(btn) {
        var id   = parseInt(btn.getAttribute('data-id'));
        var name = btn.getAttribute('data-name') || 'Template';
        _setVal('tcApplyTemplateId', id);
        _setText('tcApplyTemplateName', 'Template: ' + name);
        _setVal('tcApplyDueDate', '');
        document.getElementById('tcApplyCreateDocReqs').checked  = true;
        document.getElementById('tcApplyCreatePackItems').checked = false;
        document.getElementById('tcApplyCreateTaxItems').checked  = false;
        _hideErr('tcApplyError');
        tcApplyCheckboxChanged();

        // Load supporting data if not yet loaded
        if (!_applyDataLoaded) {
            await _loadApplyData();
            _applyDataLoaded = true;
        }

        // Populate client select
        var clientSel = document.getElementById('tcApplyClient');
        clientSel.innerHTML = '<option value="">— Select client —</option>';
        _applyClients.forEach(function (c) {
            var o = document.createElement('option');
            o.value = c.id;
            o.textContent = c.display_name || c.name || ('Client #' + c.id);
            clientSel.appendChild(o);
        });

        _openModal('tcApplyModal');
    }
    window.tcOpenApply = tcOpenApply;

    async function _loadApplyData() {
        try {
            var [clRes, pkRes, irRes, crRes] = await Promise.all([
                PracticeAPI.fetch('/api/practice/clients?is_active=true&limit=500'),
                PracticeAPI.fetch('/api/practice/compliance-packs?limit=200'),
                PracticeAPI.fetch('/api/practice/individual-tax?limit=200'),
                PracticeAPI.fetch('/api/practice/company-tax?limit=200'),
            ]);
            var [clData, pkData, irData, crData] = await Promise.all([clRes.json(), pkRes.json(), irRes.json(), crRes.json()]);
            _applyClients    = clData.clients  || [];
            _applyPacks      = pkData.packs    || [];
            _applyIndReturns = irData.returns  || [];
            _applyCoReturns  = crData.returns  || [];
        } catch (_) {}
    }

    function tcApplyCheckboxChanged() {
        var showPack = document.getElementById('tcApplyCreatePackItems').checked;
        var showTax  = document.getElementById('tcApplyCreateTaxItems').checked;

        var packRow = document.getElementById('tcApplyPackRow');
        var indRow  = document.getElementById('tcApplyIndRow');
        var coRow   = document.getElementById('tcApplyCoRow');

        packRow.style.display = showPack ? '' : 'none';
        indRow.style.display  = showTax  ? '' : 'none';
        coRow.style.display   = showTax  ? '' : 'none';

        if (showPack && packRow.querySelector('select').options.length < 2) {
            var sel = document.getElementById('tcApplyPackId');
            sel.innerHTML = '<option value="">— Select pack —</option>';
            _applyPacks.forEach(function (p) {
                var o = document.createElement('option');
                o.value = p.id; o.textContent = (p.pack_name || p.pack_type || ('Pack #' + p.id));
                sel.appendChild(o);
            });
        }
        if (showTax) {
            var iSel = document.getElementById('tcApplyIndReturnId');
            if (iSel.options.length < 2) {
                iSel.innerHTML = '<option value="">— None —</option>';
                _applyIndReturns.forEach(function (r) {
                    var o = document.createElement('option');
                    o.value = r.id; o.textContent = (r.return_name || r.client_name || ('Return #' + r.id)) + (r.tax_year ? ' (' + r.tax_year + ')' : '');
                    iSel.appendChild(o);
                });
            }
            var cSel = document.getElementById('tcApplyCoReturnId');
            if (cSel.options.length < 2) {
                cSel.innerHTML = '<option value="">— None —</option>';
                _applyCoReturns.forEach(function (r) {
                    var o = document.createElement('option');
                    o.value = r.id; o.textContent = (r.return_name || r.client_name || ('Return #' + r.id)) + (r.tax_year ? ' (' + r.tax_year + ')' : '');
                    cSel.appendChild(o);
                });
            }
        }
    }
    window.tcApplyCheckboxChanged = tcApplyCheckboxChanged;

    async function tcSubmitApply() {
        if (_submitting) return;
        var templateId = parseInt(_val('tcApplyTemplateId'));
        var clientId   = parseInt(_val('tcApplyClient'));
        if (!clientId) { _showErr('tcApplyError', 'Please select a client.'); return; }

        var createDocReqs  = document.getElementById('tcApplyCreateDocReqs').checked;
        var createPack     = document.getElementById('tcApplyCreatePackItems').checked;
        var createTax      = document.getElementById('tcApplyCreateTaxItems').checked;

        if (!createDocReqs && !createPack && !createTax) {
            _showErr('tcApplyError', 'Select at least one output type.'); return;
        }

        var packId    = createPack ? (parseInt(_val('tcApplyPackId'))     || null) : null;
        var indRetId  = createTax  ? (parseInt(_val('tcApplyIndReturnId')) || null) : null;
        var coRetId   = createTax  ? (parseInt(_val('tcApplyCoReturnId'))  || null) : null;
        var dueDate   = _val('tcApplyDueDate') || null;

        _submitting = true;
        document.getElementById('tcApplySubmitBtn').disabled = true;
        _hideErr('tcApplyError');

        try {
            var res  = await PracticeAPI.fetch(BASE + '/templates/' + templateId + '/apply', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    client_id:                clientId,
                    compliance_pack_id:       packId,
                    individual_tax_return_id: indRetId,
                    company_tax_return_id:    coRetId,
                    due_date:                 dueDate,
                    create_document_requests: createDocReqs,
                    create_pack_items:        createPack,
                    create_tax_items:         createTax,
                }),
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

            _closeModal('tcApplyModal');
            PracticeAPI.showToast(
                'Applied. Created: ' + data.doc_requests_created + ' doc requests, ' +
                data.pack_items_created + ' pack items, ' +
                data.tax_items_created + ' tax items. ' +
                (data.skipped > 0 ? data.skipped + ' skipped (duplicates).' : '')
            );
        } catch (err) {
            _showErr('tcApplyError', 'Apply failed: ' + err.message);
        } finally {
            _submitting = false;
            document.getElementById('tcApplySubmitBtn').disabled = false;
        }
    }
    window.tcSubmitApply = tcSubmitApply;

    // ─── Modal helpers ────────────────────────────────────────────────────────
    function tcCloseModal(id, evt) {
        if (evt && evt.target !== document.getElementById(id)) return;
        _closeModal(id);
    }
    window.tcCloseModal = tcCloseModal;

    function _openModal(id)  { document.getElementById(id).classList.add('open'); }
    function _closeModal(id) { document.getElementById(id).classList.remove('open'); _submitting = false; }

    // ─── Label helpers ────────────────────────────────────────────────────────
    function _typeLabel(t) {
        var m = { individual_tax: 'Individual', company_tax: 'Company', provisional_tax: 'Provisional',
                  annual_financials: 'Annual AFS', vat_period: 'VAT Period',
                  payroll_annual: 'Payroll', cipc_annual: 'CIPC', custom: 'Custom' };
        return m[t] || t || '—';
    }

    function _clientTypeLabel(t) {
        var m = { individual: 'Individual', company: 'Company', trust: 'Trust',
                  close_corporation: 'CC', partnership: 'Partnership',
                  sole_proprietor: 'Sole Proprietor', other: 'Other' };
        return m[t] || t || '—';
    }

    function _targetLabel(t) {
        var m = { document_request: 'Doc Request', compliance_pack_item: 'Pack Item',
                  individual_tax_item: 'Ind. Tax Item', company_tax_item: 'Co. Tax Item' };
        return m[t] || t || '—';
    }

    // ─── DOM helpers ──────────────────────────────────────────────────────────
    function _setEl(id, html)  { var el = document.getElementById(id); if (el) el.innerHTML = html; }
    function _setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
    function _val(id)          { var el = document.getElementById(id); return el ? el.value : ''; }
    function _setVal(id, v)    { var el = document.getElementById(id); if (el) el.value = v; }
    function _showErr(id, msg) { var el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
    function _hideErr(id)      { var el = document.getElementById(id); if (el) { el.textContent = ''; el.style.display = 'none'; } }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

}());
