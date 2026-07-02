/* Codebox 53 — Practice Alert Rules Engine + Manual Alert Configuration
 * Configure the thresholds that decide when alerts are raised. NOT AI.
 * NOT automatic threshold tuning. Prefix: ar
 */
(function () {
    'use strict';

    var BASE = '/api/practice/alert-rules';
    var _rules = [];
    var _groups = [];
    var _activeGroup = '';
    var _currentRule = null;
    var _currentTab = 'overview';
    var _editingId = null;

    var SEVERITY_LABELS = { info: 'Info', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
    var EV_LABELS = {
        rule_created: 'Rule Created', rule_updated: 'Rule Updated', rule_reset: 'Rule Reset',
        rule_deleted: 'Rule Deleted', group_reset: 'Group Reset', rules_seeded: 'Defaults Seeded',
        rules_exported: 'Rules Exported', rules_imported: 'Rules Imported',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _sevPill(s) { return '<span class="pill sev-' + _html(s) + '">' + _html(SEVERITY_LABELS[s] || s) + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    function _conditionText(r) {
        if (r.comparison_operator === 'between') return 'between ' + r.threshold_value + ' and ' + r.warning_value;
        if (r.comparison_operator === 'contains' || (['=', '!='].indexOf(r.comparison_operator) !== -1 && r.threshold_text)) {
            return r.comparison_operator + ' "' + r.threshold_text + '"';
        }
        return r.comparison_operator + ' ' + r.threshold_value;
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function arLoadAll() {
        _loadSummary();
        _loadGroups();
        arLoadList();
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                document.getElementById('notSeededMsg').style.display = d.seeded ? 'none' : 'block';
                document.getElementById('seedBtn').textContent = d.seeded ? '🌱 Re-seed (safe)' : '🌱 Seed Defaults';
                var grid = document.getElementById('summaryGrid');
                var cards = [
                    { count: d.total_rules || 0, label: 'Total Rules' },
                    { count: d.enabled_count || 0, label: 'Enabled' },
                    { count: d.disabled_count || 0, label: 'Disabled' },
                    { count: d.system_rule_count || 0, label: 'System Rules' },
                    { count: d.custom_rule_count || 0, label: 'Custom Rules' },
                    { count: (d.by_severity && d.by_severity.critical) || 0, label: 'Critical Severity' },
                ];
                grid.innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    // ── Groups ────────────────────────────────────────────────────────────────

    function _loadGroups() {
        window.PracticeAPI.fetch(BASE + '/groups')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _groups = d.groups || [];
                _renderGroupBar();
                _populateCategorySelect();
            })
            .catch(function () {});
    }

    function _renderGroupBar() {
        var bar = document.getElementById('groupBar');
        var chips = ['<div class="group-chip' + (_activeGroup === '' ? ' active' : '') + '" onclick="arSelectGroup(\'\')">All <span class="gc-count">' + _rulesTotalCount() + '</span></div>'];
        _groups.forEach(function (g) {
            chips.push('<div class="group-chip' + (_activeGroup === g.group_key ? ' active' : '') + '" onclick="arSelectGroup(\'' + g.group_key + '\')" title="' + _html(g.description || '') + '">' +
                _html(g.display_name) + ' <span class="gc-count">' + g.rule_count + '</span>' +
                (_activeGroup === g.group_key ? ' <span onclick="event.stopPropagation();arResetGroup(' + g.id + ',\'' + _html(g.display_name) + '\')" title="Reset all rules in this group to defaults" style="margin-left:4px;opacity:.7;">↺</span>' : '') +
                '</div>');
        });
        bar.innerHTML = chips.join('');
    }

    function _rulesTotalCount() {
        var t = 0;
        _groups.forEach(function (g) { t += g.rule_count; });
        return t;
    }

    function _populateCategorySelect() {
        var sel = document.getElementById('rfCategory');
        sel.innerHTML = _groups.map(function (g) {
            return '<option value="' + _html(g.group_key) + '">' + _html(g.display_name) + '</option>';
        }).join('');
    }

    function arSelectGroup(key) {
        _activeGroup = key;
        _renderGroupBar();
        arLoadList();
    }

    function arResetGroup(groupId, groupName) {
        if (!confirm('Reset every rule in "' + groupName + '" back to its default values?')) return;
        window.PracticeAPI.fetch(BASE + '/groups/' + groupId + '/reset', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function () {
                _showToast('Group reset to defaults.');
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to reset group.'); });
    }

    // ── Filters ───────────────────────────────────────────────────────────────

    function arClearFilters() {
        document.getElementById('filterSearch').value = '';
        document.getElementById('filterEnabled').value = '';
        _activeGroup = '';
        _renderGroupBar();
        arLoadList();
    }

    function _qs() {
        var p = [];
        var search = document.getElementById('filterSearch').value.trim();
        var enabled = document.getElementById('filterEnabled').value;
        if (_activeGroup) p.push('category=' + encodeURIComponent(_activeGroup));
        if (search) p.push('search=' + encodeURIComponent(search));
        if (enabled) p.push('enabled=' + enabled);
        return p.length ? '?' + p.join('&') : '';
    }

    // ── List ──────────────────────────────────────────────────────────────────

    function arLoadList() {
        var tbody = document.getElementById('tableBody');
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading…</td></tr>';
        window.PracticeAPI.fetch(BASE + _qs())
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _rules = d.rules || [];
                _renderTable();
            })
            .catch(function () {
                tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Failed to load rules.</td></tr>';
            });
    }

    function _renderTable() {
        var tbody = document.getElementById('tableBody');
        if (!_rules.length) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No rules found. Try "Seed Defaults" or adjust your filters.</td></tr>';
            return;
        }
        tbody.innerHTML = _rules.map(function (r) {
            var wired = r.settings && r.settings.wired;
            return '<tr onclick="arOpenDetail(' + r.id + ')">' +
                '<td><div style="font-weight:600;">' + _html(r.display_name) + '</div><code class="rk">' + _html(r.rule_key) + '</code>' +
                (r.system_rule ? ' <span class="pill badge-sys">system</span>' : '') +
                (wired ? ' <span class="pill badge-wired" title="' + _html((r.settings && r.settings.maps_to) || '') + '">wired</span>' : '') +
                '</td>' +
                '<td>' + _html(r.category) + '</td>' +
                '<td>' + _html(_conditionText(r)) + '</td>' +
                '<td>' + _sevPill(r.severity) + '</td>' +
                '<td>' + (r.enabled ? '<span class="pill sev-low">Enabled</span>' : '<span class="pill badge-off">Disabled</span>') + '</td>' +
                '<td>v' + r.version + '</td>' +
                '<td onclick="event.stopPropagation();"><button class="btn-action btn-sm btn-secondary" onclick="arOpenDetail(' + r.id + ')">View</button></td>' +
                '</tr>';
        }).join('');
    }

    // ── Rule Detail Modal ─────────────────────────────────────────────────────

    function arOpenDetail(id) {
        _currentTab = 'overview';
        window.PracticeAPI.fetch(BASE + '/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _currentRule = d.rule;
                _currentRule._events = d.recent_events || [];
                document.getElementById('detailModal').classList.add('open');
                _renderDetailTabs();
                _renderDetailTab();
            })
            .catch(function () { _showToast('Failed to load rule.'); });
    }
    function arCloseDetail() { document.getElementById('detailModal').classList.remove('open'); _currentRule = null; }

    function _renderDetailTabs() {
        var tabs = [['overview', 'Overview'], ['history', 'History']];
        document.getElementById('detailTabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _currentTab ? ' active' : '') + '" onclick="arOpenTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('') + '<button class="tab-btn" style="margin-left:auto;" onclick="arCloseDetail()">✕ Close</button>';
    }

    function arOpenTab(tab) {
        _currentTab = tab;
        _renderDetailTabs();
        _renderDetailTab();
    }

    function _renderDetailTab() {
        var r = _currentRule;
        var body = document.getElementById('detailBody');
        var footer = document.getElementById('detailFooter');
        if (_currentTab === 'overview') {
            body.innerHTML =
                '<div class="detail-grid">' +
                _drow('Rule Key', '<code class="rk">' + _html(r.rule_key) + '</code>') +
                _drow('Category', _html(r.category)) +
                _drow('Display Name', _html(r.display_name)) +
                _drow('Severity', _sevPill(r.severity)) +
                _drow('Condition', _html(_conditionText(r))) +
                _drow('Enabled', r.enabled ? 'Yes' : 'No') +
                _drow('System Rule', r.system_rule ? 'Yes (cannot be deleted)' : 'No') +
                _drow('Editable', r.editable ? 'Yes' : 'No') +
                _drow('Version', 'v' + r.version) +
                _drow('Wired Into Code', (r.settings && r.settings.wired) ? ('Yes — ' + _html(r.settings.maps_to || '')) : 'No — seeded for administration only') +
                '</div>' +
                (r.description ? '<div style="padding:12px;font-size:.82rem;color:#a0aec0;">' + _html(r.description) + '</div>' : '');
            footer.innerHTML =
                '<button class="btn-action btn-secondary" onclick="arOpenEdit()"' + (r.editable ? '' : ' disabled') + '>Edit</button>' +
                '<button class="btn-action btn-warning" onclick="arResetRule(' + r.id + ')">↺ Reset to Default</button>' +
                '<button class="btn-action ' + (r.enabled ? 'btn-secondary' : 'btn-success') + '" onclick="arToggleEnabled()">' + (r.enabled ? 'Disable' : 'Enable') + '</button>' +
                '<button class="btn-action btn-danger" onclick="arDeleteRule(' + r.id + ')"' + (r.system_rule ? ' disabled title="System rules cannot be deleted"' : '') + '>Delete</button>';
        } else {
            var evs = r._events || [];
            body.innerHTML = evs.length
                ? evs.map(function (e) {
                    return '<div class="event-item"><div class="event-header"><span class="event-type">' + _html(EV_LABELS[e.event_type] || e.event_type) + '</span><span class="event-time">' + _fmt(e.created_at) + '</span></div>' +
                        (e.notes ? '<div class="event-notes">' + _html(e.notes) + '</div>' : '') + '</div>';
                }).join('')
                : '<div class="loading-state">No history for this rule yet.</div>';
            footer.innerHTML = '';
        }
    }
    function _drow(label, value) {
        return '<div class="detail-row"><div class="detail-label">' + _html(label) + '</div><div class="detail-value">' + value + '</div></div>';
    }

    function arToggleEnabled() {
        if (!_currentRule) return;
        window.PracticeAPI.fetch(BASE + '/' + _currentRule.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !_currentRule.enabled }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Rule ' + (d.rule.enabled ? 'enabled' : 'disabled') + '.');
                arCloseDetail();
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to update rule.'); });
    }

    function arResetRule(id) {
        if (!confirm('Reset this rule back to its default value?')) return;
        window.PracticeAPI.fetch(BASE + '/' + id + '/reset', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Rule reset to default.');
                arCloseDetail();
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to reset rule.'); });
    }

    function arDeleteRule(id) {
        if (!confirm('Delete this custom rule? This cannot be undone.')) return;
        window.PracticeAPI.fetch(BASE + '/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Rule deleted.');
                arCloseDetail();
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to delete rule.'); });
    }

    // ── Create / Edit Rule Form ───────────────────────────────────────────────

    function arOpenCreate() {
        _editingId = null;
        document.getElementById('ruleModalTitle').textContent = 'Add Custom Rule';
        document.getElementById('ruleKeyGroup').style.display = '';
        document.getElementById('rfRuleKey').value = '';
        document.getElementById('rfRuleKey').disabled = false;
        document.getElementById('rfCategory').value = _groups[0] ? _groups[0].group_key : '';
        document.getElementById('rfSeverity').value = 'medium';
        document.getElementById('rfDisplayName').value = '';
        document.getElementById('rfDescription').value = '';
        document.getElementById('rfOperator').value = '>=';
        document.getElementById('rfThresholdValue').value = '';
        document.getElementById('rfWarningValue').value = '';
        document.getElementById('rfThresholdText').value = '';
        document.getElementById('rfSortOrder').value = 0;
        document.getElementById('rfEnabled').checked = true;
        document.getElementById('ruleValidationBox').innerHTML = '';
        arOperatorChanged();
        document.getElementById('ruleModal').classList.add('open');
    }

    function arOpenEdit() {
        if (!_currentRule) return;
        var r = _currentRule;
        _editingId = r.id;
        document.getElementById('ruleModalTitle').textContent = 'Edit Rule';
        document.getElementById('ruleKeyGroup').style.display = 'none';
        document.getElementById('rfCategory').value = r.category;
        document.getElementById('rfSeverity').value = r.severity;
        document.getElementById('rfDisplayName').value = r.display_name;
        document.getElementById('rfDescription').value = r.description || '';
        document.getElementById('rfOperator').value = r.comparison_operator;
        document.getElementById('rfThresholdValue').value = r.threshold_value != null ? r.threshold_value : '';
        document.getElementById('rfWarningValue').value = r.warning_value != null ? r.warning_value : '';
        document.getElementById('rfThresholdText').value = r.threshold_text || '';
        document.getElementById('rfSortOrder').value = r.sort_order || 0;
        document.getElementById('rfEnabled').checked = !!r.enabled;
        document.getElementById('ruleValidationBox').innerHTML = '';
        arOperatorChanged();
        arCloseDetail();
        document.getElementById('ruleModal').classList.add('open');
    }

    function arCloseRuleModal() { document.getElementById('ruleModal').classList.remove('open'); }

    function arOperatorChanged() {
        var op = document.getElementById('rfOperator').value;
        document.getElementById('rfWarningValueGroup').style.display = op === 'between' ? '' : 'none';
        document.getElementById('rfThresholdTextGroup').style.display = (op === 'contains' || op === '=' || op === '!=') ? '' : 'none';
        document.getElementById('rfThresholdValueGroup').style.display = op === 'contains' ? 'none' : '';
        document.getElementById('rfThresholdValueLabel').textContent = op === 'between' ? 'Threshold Value (low)' : 'Threshold Value';
    }

    function _formPayload() {
        var op = document.getElementById('rfOperator').value;
        var payload = {
            category: document.getElementById('rfCategory').value,
            severity: document.getElementById('rfSeverity').value,
            display_name: document.getElementById('rfDisplayName').value.trim(),
            description: document.getElementById('rfDescription').value.trim() || null,
            comparison_operator: op,
            sort_order: parseInt(document.getElementById('rfSortOrder').value, 10) || 0,
            enabled: document.getElementById('rfEnabled').checked,
        };
        var tv = document.getElementById('rfThresholdValue').value;
        var wv = document.getElementById('rfWarningValue').value;
        var tt = document.getElementById('rfThresholdText').value.trim();
        payload.threshold_value = tv !== '' ? Number(tv) : null;
        payload.warning_value = wv !== '' ? Number(wv) : null;
        payload.threshold_text = tt || null;
        if (!_editingId) payload.rule_key = document.getElementById('rfRuleKey').value.trim();
        if (_editingId) payload.id = _editingId;
        return payload;
    }

    function arValidateRuleForm() {
        window.PracticeAPI.fetch(BASE + '/validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_formPayload()),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var box = document.getElementById('ruleValidationBox');
                if (d.valid) {
                    box.innerHTML = '<div class="inline-msg info">Looks good — no validation errors.</div>';
                } else {
                    box.innerHTML = '<div class="validation-box"><strong>Validation failed:</strong><ul>' + (d.errors || []).map(function (e) { return '<li>' + _html(e) + '</li>'; }).join('') + '</ul></div>';
                }
            })
            .catch(function () {});
    }

    function arSubmitRuleForm() {
        var payload = _formPayload();
        var url = _editingId ? BASE + '/' + _editingId : BASE;
        var method = _editingId ? 'PUT' : 'POST';
        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (res) {
                if (res.body.error) {
                    var box = document.getElementById('ruleValidationBox');
                    var details = res.body.details || [res.body.error];
                    box.innerHTML = '<div class="validation-box"><strong>' + _html(res.body.error) + '</strong><ul>' + details.map(function (e) { return '<li>' + _html(e) + '</li>'; }).join('') + '</ul></div>';
                    return;
                }
                _showToast(_editingId ? 'Rule updated.' : 'Rule created.');
                arCloseRuleModal();
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to save rule.'); });
    }

    // ── Seed Defaults ─────────────────────────────────────────────────────────

    function arSeedDefaults() {
        window.PracticeAPI.fetch(BASE + '/seed-defaults', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.already_seeded) {
                    _showToast('Already seeded — no changes made.');
                } else {
                    _showToast('Seeded ' + d.groups_created + ' group(s) and ' + d.rules_created + ' rule(s).');
                }
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to seed defaults.'); });
    }

    // ── Export / Import ───────────────────────────────────────────────────────

    function arExport() {
        window.PracticeAPI.fetch(BASE + '/export')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'alert-rules-export-' + new Date().toISOString().slice(0, 10) + '.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            })
            .catch(function () { _showToast('Failed to export rules.'); });
    }

    function arOpenImport() {
        document.getElementById('importJson').value = '';
        document.getElementById('importValidationBox').innerHTML = '';
        document.getElementById('importModal').classList.add('open');
    }
    function arCloseImport() { document.getElementById('importModal').classList.remove('open'); }

    function arSubmitImport() {
        var raw = document.getElementById('importJson').value.trim();
        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) {
            document.getElementById('importValidationBox').innerHTML = '<div class="validation-box"><strong>Invalid JSON.</strong></div>';
            return;
        }
        var rules = Array.isArray(parsed) ? parsed : parsed.rules;
        if (!Array.isArray(rules) || !rules.length) {
            document.getElementById('importValidationBox').innerHTML = '<div class="validation-box"><strong>No rules found in the pasted JSON. Expected an object with a "rules" array.</strong></div>';
            return;
        }
        window.PracticeAPI.fetch(BASE + '/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: rules }),
        })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (res) {
                if (res.body.error) {
                    var details = res.body.details || [res.body.error];
                    document.getElementById('importValidationBox').innerHTML = '<div class="validation-box"><strong>' + _html(res.body.error) + '</strong><ul>' + details.map(function (e) { return '<li>' + _html(e) + '</li>'; }).join('') + '</ul></div>';
                    return;
                }
                _showToast('Imported: ' + res.body.updated_count + ' updated, ' + res.body.created_count + ' created.');
                arCloseImport();
                arLoadAll();
            })
            .catch(function () { _showToast('Failed to import rules.'); });
    }

    // ── Global History ────────────────────────────────────────────────────────

    function arOpenHistory() {
        document.getElementById('historyModal').classList.add('open');
        document.getElementById('historyBody').innerHTML = '<div class="loading-state">Loading…</div>';
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var evs = d.events || [];
                document.getElementById('historyBody').innerHTML = evs.length
                    ? evs.map(function (e) {
                        return '<div class="event-item"><div class="event-header"><span class="event-type">' + _html(EV_LABELS[e.event_type] || e.event_type) +
                            (e.rule_key ? ' — <code class="rk">' + _html(e.rule_key) + '</code>' : '') + '</span><span class="event-time">' + _fmt(e.created_at) + '</span></div>' +
                            (e.notes ? '<div class="event-notes">' + _html(e.notes) + '</div>' : '') + '</div>';
                    }).join('')
                    : '<div class="loading-state">No rule changes recorded yet.</div>';
            })
            .catch(function () { document.getElementById('historyBody').innerHTML = '<div class="loading-state">Failed to load history.</div>'; });
    }
    function arCloseHistory() { document.getElementById('historyModal').classList.remove('open'); }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.arLoadAll = arLoadAll;
    window.arLoadList = arLoadList;
    window.arClearFilters = arClearFilters;
    window.arSelectGroup = arSelectGroup;
    window.arResetGroup = arResetGroup;
    window.arOpenDetail = arOpenDetail;
    window.arCloseDetail = arCloseDetail;
    window.arOpenTab = arOpenTab;
    window.arToggleEnabled = arToggleEnabled;
    window.arResetRule = arResetRule;
    window.arDeleteRule = arDeleteRule;
    window.arOpenCreate = arOpenCreate;
    window.arOpenEdit = arOpenEdit;
    window.arCloseRuleModal = arCloseRuleModal;
    window.arOperatorChanged = arOperatorChanged;
    window.arValidateRuleForm = arValidateRuleForm;
    window.arSubmitRuleForm = arSubmitRuleForm;
    window.arSeedDefaults = arSeedDefaults;
    window.arExport = arExport;
    window.arOpenImport = arOpenImport;
    window.arCloseImport = arCloseImport;
    window.arSubmitImport = arSubmitImport;
    window.arOpenHistory = arOpenHistory;
    window.arCloseHistory = arCloseHistory;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        arLoadAll();
    });

}());
