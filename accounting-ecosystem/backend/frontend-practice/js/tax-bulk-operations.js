/* ============================================================
   Tax Bulk Operations (Codebox 37)
   Lorenco Practice — User-triggered bulk preparation.
   NOT cron. NOT background. NOT AI.
   All operations are preview-first, user-approved.
   ============================================================ */
(function () {
    'use strict';

    var esc = PracticeAPI.escHtml;

    var _currentStep    = 1;
    var _selectedOpType = null;
    var _previewData    = null;  // { clients, warnings, estimated_outputs, client_count }
    var _savedOpId      = null;
    var _teamMembers    = [];
    var _templates      = [];

    // ── Init ────────────────────────────────────────────────────────────────────

    async function init() {
        LAYOUT.init('tax-bulk-ops');
        await Promise.all([_loadTeamMembers(), _loadTemplates()]);
        _load();
    }

    // ── Data loaders ────────────────────────────────────────────────────────────

    async function _loadTeamMembers() {
        try {
            var data = await PracticeAPI.fetch('/api/practice/team?active=true');
            _teamMembers = (data && (data.team_members || data.members)) || [];
        } catch (e) { _teamMembers = []; }
        _populateTeamSelects();
    }

    async function _loadTemplates() {
        try {
            var data = await PracticeAPI.fetch('/api/practice/tax-checklists/templates?limit=100');
            _templates = (data && data.templates) || [];
        } catch (e) { _templates = []; }
        _populateTemplateSelect();
    }

    function _populateTeamSelects() {
        var base = '<option value="">— None —</option>';
        var anyOpt = '<option value="">Any</option>';
        var opts = _teamMembers.map(function (m) {
            return '<option value="' + m.id + '">' + esc(m.display_name || m.name || ('Member #' + m.id)) + '</option>';
        }).join('');

        var filterEl = document.getElementById('tboFilterOwner');
        if (filterEl) filterEl.innerHTML = anyOpt + opts;

        var ownerEl = document.getElementById('tboOptOwner');
        if (ownerEl) ownerEl.innerHTML = base + opts;

        var reviewerEl = document.getElementById('tboOptReviewer');
        if (reviewerEl) reviewerEl.innerHTML = base + opts;
    }

    function _populateTemplateSelect() {
        var el = document.getElementById('tboOptTemplate');
        if (!el) return;
        el.innerHTML = '<option value="">— Select Template —</option>' + _templates.map(function (t) {
            return '<option value="' + t.id + '">' + esc(t.template_name) + ' (' + esc(t.template_type) + ')</option>';
        }).join('');
    }

    // ── Operations list ─────────────────────────────────────────────────────────

    async function _load() {
        var params = new URLSearchParams({ limit: 30 });
        var typeEl   = document.getElementById('tboListType');
        var statusEl = document.getElementById('tboListStatus');
        if (typeEl   && typeEl.value)   params.set('operation_type',   typeEl.value);
        if (statusEl && statusEl.value) params.set('operation_status', statusEl.value);

        var data = await PracticeAPI.fetch('/api/practice/tax-bulk-operations?' + params.toString());
        var ops  = (data && data.operations) || [];
        var el   = document.getElementById('tboList');
        if (!el) return;

        if (!ops.length) {
            el.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#718096;padding:2rem">No operations yet — create one with "+ New Operation"</td></tr>';
            return;
        }

        el.innerHTML = ops.map(function (op) {
            var statusKey = (op.operation_status || '').replace(/_/g, '-');
            var badge     = '<span class="tbo-badge tbo-badge-' + statusKey + '">' + esc(op.operation_status || '') + '</span>';
            var typeLbl   = esc((op.operation_type || '').replace(/_/g, ' '));
            var created   = op.created_at ? new Date(op.created_at).toLocaleDateString() : '—';
            var actions   = '';
            if (op.operation_status === 'previewed' || op.operation_status === 'draft') {
                actions += '<button class="btn-sm btn-sm-primary" onclick="tboExecuteExisting(' + op.id + ')">Execute</button> ';
            }
            if (op.operation_status !== 'cancelled' && op.operation_status !== 'running') {
                actions += '<button class="btn-sm" onclick="tboCancel(' + op.id + ')">Cancel</button> ';
            }
            actions += '<button class="btn-sm" onclick="tboViewItems(' + op.id + ')">Results</button>';

            return '<tr>' +
                '<td>' + esc(op.operation_name || '') + '</td>' +
                '<td style="color:#a0aec0">' + typeLbl + '</td>' +
                '<td>' + badge + '</td>' +
                '<td>' + (op.tax_year || '—') + '</td>' +
                '<td style="color:#718096">' + created + '</td>' +
                '<td>' + actions + '</td>' +
            '</tr>';
        }).join('');
    }

    // ── Wizard control ──────────────────────────────────────────────────────────

    function tboNewOp() {
        _currentStep    = 1;
        _selectedOpType = null;
        _previewData    = null;
        _savedOpId      = null;
        var el = document.getElementById('tboWizard');
        if (el) el.style.display = 'block';
        _renderStep(1);
        el && el.scrollIntoView({ behavior: 'smooth' });
    }

    function tboCloseWizard() {
        var el = document.getElementById('tboWizard');
        if (el) el.style.display = 'none';
    }

    function _renderStep(step) {
        for (var i = 1; i <= 5; i++) {
            var s = document.getElementById('tboStep' + i);
            if (s) s.style.display = (i === step ? 'block' : 'none');
            var p = document.getElementById('tboStepPill' + i);
            if (p) {
                p.classList.toggle('active', i === step);
                p.classList.toggle('done',   i <  step);
            }
        }
    }

    function tboNextStep() {
        if (_currentStep === 1 && !_selectedOpType) {
            PracticeAPI.showToast('Select an operation type first', true); return;
        }
        if (_currentStep === 3) { tboPreview(); return; }
        _currentStep = Math.min(_currentStep + 1, 5);
        if (_currentStep === 3) _updateOptionsPanel();
        _renderStep(_currentStep);
    }

    function tboPrevStep() {
        _currentStep = Math.max(_currentStep - 1, 1);
        _renderStep(_currentStep);
        if (_currentStep === 3) _updateOptionsPanel();
    }

    function tboSetOpType(type) {
        _selectedOpType = type;
        document.querySelectorAll('.tbo-op-card').forEach(function (card) {
            card.classList.toggle('selected', card.getAttribute('data-type') === type);
        });
    }

    function _updateOptionsPanel() {
        var show = {
            tboOptPackSection:     ['create_compliance_packs', 'mixed_tax_season_setup'],
            tboOptTemplateSection: ['apply_tax_checklist', 'create_document_requests', 'mixed_tax_season_setup'],
            tboOptOwnerSection:    ['create_compliance_packs', 'assign_tax_owners', 'mixed_tax_season_setup'],
            tboOptReviewerSection: ['create_compliance_packs', 'assign_reviewers', 'mixed_tax_season_setup'],
            tboOptOverrideSection: ['assign_tax_owners', 'assign_reviewers'],
            tboOptActionSection:   ['create_tax_actions'],
        };
        Object.keys(show).forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.style.display = show[id].includes(_selectedOpType) ? 'block' : 'none';
        });
    }

    // ── Build payload ──────────────────────────────────────────────────────────

    function _buildPayload() {
        function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
        function checked(id) { var el = document.getElementById(id); return el ? el.checked : false; }
        function intVal(id) { var v = val(id); return v ? parseInt(v) : null; }

        var taxYearRaw = val('tboFilterYear');
        var taxYear    = taxYearRaw ? parseInt(taxYearRaw) : null;

        var opName = val('tboOpName').trim() ||
            (_selectedOpType || '').replace(/_/g, ' ') + (taxYear ? ' ' + taxYear : '');

        return {
            operation_name: opName,
            operation_type: _selectedOpType,
            tax_year:       taxYear,
            filters: {
                client_type:                 val('tboFilterClientType') || null,
                responsible_team_member_id:  intVal('tboFilterOwner'),
                provisional_taxpayer:        checked('tboFilterProvisional') || null,
                has_active_engagement:       checked('tboFilterHasEngagement') || null,
                missing_compliance_pack:     checked('tboFilterMissingPack') || null,
            },
            options: {
                compliance_pack_type:               val('tboOptPackType') || null,
                checklist_template_id:              intVal('tboOptTemplate'),
                due_date:                           val('tboOptDueDate') || val('tboOptActionDueDate') || null,
                assign_responsible_team_member_id:  intVal('tboOptOwner'),
                assign_reviewer_team_member_id:     intVal('tboOptReviewer'),
                override_existing:                  checked('tboOptOverrideExisting'),
                pack_period_start:                  val('tboOptPeriodStart') || null,
                pack_period_end:                    val('tboOptPeriodEnd')   || null,
                action_title:                       val('tboOptActionTitle').trim() || null,
                action_type:                        val('tboOptActionType') || null,
            },
        };
    }

    // ── Preview ────────────────────────────────────────────────────────────────

    async function tboPreview() {
        if (!_selectedOpType) { PracticeAPI.showToast('Select an operation type first', true); return; }

        var previewEl = document.getElementById('tboPreviewContent');
        if (previewEl) previewEl.innerHTML = '<p style="color:#718096">Building preview...</p>';

        _currentStep = 4;
        _renderStep(4);

        var payload  = _buildPayload();
        var data     = await PracticeAPI.fetch('/api/practice/tax-bulk-operations/preview', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });

        if (!data) {
            if (previewEl) previewEl.innerHTML = '<p style="color:#fc8181">Preview failed — check filters and try again.</p>';
            return;
        }

        _previewData = data;
        _renderPreview(data);
    }

    function _renderPreview(r) {
        var clients  = r.clients || [];
        var warnings = r.warnings || [];
        var est      = r.estimated_outputs || {};
        var html     = '';

        if (warnings.length) {
            html += '<div class="tbo-warning-box">' +
                warnings.map(function (w) { return '<p>⚠ ' + esc(w) + '</p>'; }).join('') +
            '</div>';
        }

        html += '<div class="tbo-preview-summary">' +
            '<span><strong>' + clients.length + '</strong> clients matched</span>' +
            (est.packs        ? '<span><strong>' + est.packs        + '</strong> packs to create</span>' : '') +
            (est.doc_requests ? '<span><em>~' + est.doc_requests    + '</em> doc requests (est.)</span>'  : '') +
            (est.actions      ? '<span><strong>' + est.actions      + '</strong> actions to create</span>' : '') +
            (est.assignments  ? '<span><strong>' + est.assignments  + '</strong> assignments</span>' : '') +
        '</div>';

        if (clients.length) {
            html += '<div class="tbo-preview-table-wrap"><table class="tbo-table"><thead><tr><th>Client</th><th>Type</th></tr></thead><tbody>';
            var shown = clients.slice(0, 50);
            html += shown.map(function (c) {
                return '<tr><td>' + esc(c.name || '') + '</td><td style="color:#718096">' + esc(c.client_type || '') + '</td></tr>';
            }).join('');
            if (clients.length > 50) {
                html += '<tr><td colspan="2" style="color:#718096;padding:0.5rem 0.75rem">…and ' + (clients.length - 50) + ' more clients</td></tr>';
            }
            html += '</tbody></table></div>';
        } else {
            html += '<p style="color:#718096;margin-top:0.75rem">No clients matched the filters.</p>';
        }

        var previewEl = document.getElementById('tboPreviewContent');
        if (previewEl) previewEl.innerHTML = html;
    }

    // ── Save & Continue ─────────────────────────────────────────────────────────

    async function tboSaveAndContinue() {
        if (!_previewData) { PracticeAPI.showToast('Preview first', true); return; }
        if (!_previewData.clients || !_previewData.clients.length) {
            PracticeAPI.showToast('No clients matched — adjust filters', true); return;
        }

        var payload          = _buildPayload();
        payload.preview_snapshot = _previewData;

        var data = await PracticeAPI.fetch('/api/practice/tax-bulk-operations', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });

        if (!data || !data.operation) {
            PracticeAPI.showToast('Failed to save operation', true); return;
        }

        _savedOpId = data.operation.id;
        _currentStep = 5;
        _renderStep(5);
        _renderExecuteStep(data.operation);
        _load();
    }

    function _renderExecuteStep(op) {
        var el = document.getElementById('tboExecuteSummary');
        if (!el) return;
        var count = (_previewData && _previewData.client_count) || '?';
        el.innerHTML = '<div class="tbo-execute-summary">' +
            '<p><strong>Operation:</strong> ' + esc(op.operation_name || '') + '</p>' +
            '<p><strong>Type:</strong> ' + esc((op.operation_type || '').replace(/_/g, ' ')) + '</p>' +
            '<p><strong>Clients:</strong> ' + count + '</p>' +
            '<p><strong>Status:</strong> Saved — ready to execute</p>' +
        '</div>';

        var resultEl = document.getElementById('tboExecuteResult');
        if (resultEl) resultEl.innerHTML = '';

        var btn = document.getElementById('tboExecuteBtn');
        if (btn) btn.disabled = false;
    }

    // ── Execute ────────────────────────────────────────────────────────────────

    async function tboExecute() {
        if (!_savedOpId) { PracticeAPI.showToast('No saved operation', true); return; }

        var btn = document.getElementById('tboExecuteBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

        var data = await PracticeAPI.fetch('/api/practice/tax-bulk-operations/' + _savedOpId + '/execute', {
            method: 'POST',
        });

        if (btn) { btn.disabled = false; btn.textContent = 'Execute Now'; }
        if (!data) return;

        _renderExecuteResult(data);
        _load();
    }

    function _renderExecuteResult(r) {
        var el  = document.getElementById('tboExecuteResult');
        if (!el) return;
        var s   = r.result_summary || {};
        var items = r.items || [];

        el.innerHTML = '<div class="tbo-result-summary">' +
            '<div class="tbo-result-stat tbo-stat-success"><strong>' + (s.created   || 0) + '</strong><span>success</span></div>' +
            '<div class="tbo-result-stat tbo-stat-warning"><strong>' + (s.warnings  || 0) + '</strong><span>warnings</span></div>' +
            '<div class="tbo-result-stat tbo-stat-skip"><strong>'    + (s.skipped   || 0) + '</strong><span>skipped</span></div>' +
            '<div class="tbo-result-stat tbo-stat-fail"><strong>'    + (s.failed    || 0) + '</strong><span>failed</span></div>' +
        '</div>';

        if (items.length) {
            el.innerHTML += '<div class="tbo-result-items"><table class="tbo-table">' +
                '<thead><tr><th>Client</th><th>Status</th><th>Message</th></tr></thead><tbody>' +
                items.map(function (item) {
                    var statusKey = (item.item_status || '').replace(/_/g, '-');
                    return '<tr>' +
                        '<td>' + esc(item.client_name || ('Client #' + item.client_id)) + '</td>' +
                        '<td><span class="tbo-badge tbo-badge-' + statusKey + '">' + esc(item.item_status || '') + '</span></td>' +
                        '<td style="color:#a0aec0">' + esc(item.message || '') + '</td>' +
                    '</tr>';
                }).join('') +
                '</tbody></table></div>';
        }
    }

    // ── Execute existing (from list) ────────────────────────────────────────────

    async function tboExecuteExisting(opId) {
        if (!confirm('Execute this operation? Records will be created for all preview clients.')) return;

        var data = await PracticeAPI.fetch('/api/practice/tax-bulk-operations/' + opId + '/execute', {
            method: 'POST',
        });

        if (!data) return;
        var s = data.result_summary || {};
        PracticeAPI.showToast('Done — ' + (s.created || 0) + ' created, ' + (s.failed || 0) + ' failed');
        _load();
    }

    // ── View items (from list) ──────────────────────────────────────────────────

    async function tboViewItems(opId) {
        var data  = await PracticeAPI.fetch('/api/practice/tax-bulk-operations/' + opId + '/items?limit=200');
        var items = (data && data.items) || [];
        var panel = document.getElementById('tboItemsPanel');
        var listEl = document.getElementById('tboItemsList');
        if (!panel || !listEl) return;

        listEl.innerHTML = items.length ? items.map(function (item) {
            var statusKey = (item.item_status || '').replace(/_/g, '-');
            return '<tr>' +
                '<td>' + esc(item.client_name || ('Client #' + item.client_id)) + '</td>' +
                '<td><span class="tbo-badge tbo-badge-' + statusKey + '">' + esc(item.item_status || '') + '</span></td>' +
                '<td style="color:#a0aec0">' + esc(item.message || '—') + '</td>' +
                '<td style="color:#fc8181;font-size:0.72rem">' + esc(item.error_detail || '') + '</td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="4" style="color:#718096;text-align:center;padding:1.5rem">No results recorded yet</td></tr>';

        panel.style.display = 'block';
        panel.scrollIntoView({ behavior: 'smooth' });
    }

    // ── Cancel ─────────────────────────────────────────────────────────────────

    async function tboCancel(opId) {
        if (!confirm('Cancel this operation?')) return;
        var data = await PracticeAPI.fetch('/api/practice/tax-bulk-operations/' + opId + '/cancel', {
            method: 'PUT',
        });
        if (!data) return;
        PracticeAPI.showToast('Operation cancelled');
        _load();
    }

    // ── Window exports ──────────────────────────────────────────────────────────

    window.tboNewOp           = tboNewOp;
    window.tboCloseWizard     = tboCloseWizard;
    window.tboNextStep        = tboNextStep;
    window.tboPrevStep        = tboPrevStep;
    window.tboSetOpType       = tboSetOpType;
    window.tboPreview         = tboPreview;
    window.tboSaveAndContinue = tboSaveAndContinue;
    window.tboExecute         = tboExecute;
    window.tboExecuteExisting = tboExecuteExisting;
    window.tboViewItems       = tboViewItems;
    window.tboCancel          = tboCancel;
    window.tboLoadOps         = function () { _load(); };

    document.addEventListener('DOMContentLoaded', init);
})();
