/* Codebox 65 — Secretarial Beneficial Ownership + Ownership Chain Foundation
 * "Who ultimately owns or controls this client?" NOT CIPC filing. Manager-driven.
 * Prefix: bo
 */
(function () {
    'use strict';

    var BASE = '/api/practice/beneficial-ownership';
    var CLIENTS_BASE = '/api/practice/clients';
    var _tab = 'owners';
    var _currentClientId = null;
    var _editingOwnerId = null;
    var _editingChainId = null;

    var OWNER_TYPE_LABELS = { natural_person: 'Natural Person', company: 'Company', trust: 'Trust', partnership: 'Partnership', nominee: 'Nominee', other: 'Other' };
    var CONTROL_TYPE_LABELS = { shareholding: 'Shareholding', voting_rights: 'Voting Rights', board_control: 'Board Control', trustee_control: 'Trustee Control', beneficiary_control: 'Beneficiary Control', nominee_control: 'Nominee Control', agreement_control: 'Agreement Control', other_control: 'Other Control' };
    var OWNER_STATUS_LABELS = { draft: 'Draft', active: 'Active', incomplete: 'Incomplete', verified: 'Verified', not_reportable: 'Not Reportable', archived: 'Archived' };
    var VERIFICATION_LABELS = { not_started: 'Not Started', requested: 'Requested', documents_received: 'Documents Received', verified: 'Verified', rejected: 'Rejected', expired: 'Expired' };
    var CHAIN_STATUS_LABELS = { draft: 'Draft', active: 'Active', verified: 'Verified', incomplete: 'Incomplete', archived: 'Archived' };
    var READINESS_STATUS_LABELS = { required: 'Required', requested: 'Requested', received: 'Received', verified: 'Verified', waived: 'Waived', blocked: 'Blocked', not_applicable: 'N/A' };
    var READINESS_TOP_LABELS = { ready: 'Ready', partial: 'Partial', incomplete: 'Incomplete', blocked: 'Blocked', unknown: 'Unknown' };
    var EV_LABELS = {
        bo_owner_created: 'Owner Created', bo_owner_updated: 'Owner Updated', bo_owner_verified: 'Owner Verified', bo_owner_archived: 'Owner Archived',
        ownership_chain_created: 'Chain Created', ownership_chain_updated: 'Chain Updated', ownership_chain_verified: 'Chain Verified', ownership_chain_archived: 'Chain Archived',
        readiness_item_created: 'Readiness Item Created', readiness_item_updated: 'Readiness Item Updated', bo_readiness_recalculated: 'Readiness Recalculated',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _pct(v) { return v != null ? v + '%' : '—'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function boLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadClientPicker();
    }

    function _renderTabBar() {
        var tabs = [['owners', 'Beneficial Owners'], ['chains', 'Ownership Chains'], ['readiness', 'Readiness'], ['events', 'Events']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="boSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function boSetTab(tab) { _tab = tab; _renderTabBar(); }

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rd = d.readiness || {};
                var cards = [
                    { count: d.owners_total || 0, label: 'Beneficial Owners' },
                    { count: d.reportable_owners || 0, label: 'Reportable Owners' },
                    { count: d.chains_total || 0, label: 'Ownership Chains' },
                    { count: d.chains_low_confidence || 0, label: 'Low Confidence Chains' },
                    { count: rd.ready || 0, label: 'Clients Ready' },
                    { count: (rd.incomplete || 0) + (rd.blocked || 0), label: 'Clients Need Attention' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function _loadClientPicker() {
        window.PracticeAPI.fetch(CLIENTS_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var clients = d.clients || [];
                var sel = document.getElementById('clientPicker');
                sel.innerHTML = '<option value="">Select a client…</option>' + clients.map(function (c) {
                    return '<option value="' + c.id + '">' + _html(c.name) + '</option>';
                }).join('');
                var params = new URLSearchParams(window.location.search);
                var preselect = params.get('client_id');
                if (preselect && clients.some(function (c) { return String(c.id) === preselect; })) {
                    sel.value = preselect;
                    boOnClientChange();
                }
            })
            .catch(function () {});
    }

    function boOnClientChange() {
        var val = document.getElementById('clientPicker').value;
        if (!val) { document.getElementById('clientArea').style.display = 'none'; _currentClientId = null; return; }
        _currentClientId = parseInt(val);
        document.getElementById('clientArea').style.display = 'block';
        boLoadClientData();
    }

    function boLoadClientData() {
        if (!_currentClientId) return;
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderReadinessBanner(d.readiness, d.reportable_owners.length, d.missing_information_count);
                _renderOwners(d.beneficial_owners || []);
                _renderShareholders(d.direct_shareholders || []);
                _renderChains(d.ownership_chains || []);
                _renderReadinessItems(d.readiness.items || []);
                _loadEvents();
            })
            .catch(function () { _showToast('Failed to load BO profile.'); });
    }

    function _renderReadinessBanner(readiness, reportableCount, missingCount) {
        var status = readiness.status || 'unknown';
        document.getElementById('readinessBanner').innerHTML =
            '<div class="rb-status rd-' + _html(status) + '">' + _html(READINESS_TOP_LABELS[status] || status) + '</div>' +
            '<div>Score: ' + (readiness.score || 0) + '%</div>' +
            '<div>' + (readiness.done_count || 0) + ' / ' + (readiness.required_count || 0) + ' required items done</div>' +
            '<div>Reportable owners: ' + reportableCount + '</div>' +
            '<div>Missing information: ' + missingCount + '</div>';
    }

    // ── Beneficial Owners ─────────────────────────────────────────────────────

    function _renderOwners(rows) {
        if (!rows.length) { document.getElementById('ownersBody').innerHTML = '<tr><td colspan="7" class="empty-state">No beneficial owners on record.</td></tr>'; return; }
        document.getElementById('ownersBody').innerHTML = rows.map(function (o) {
            return '<tr class="row-clickable" onclick="boOpenOwnerDetail(' + o.id + ')">' +
                '<td>' + _html(o.owner_name) + '</td><td>' + _html(OWNER_TYPE_LABELS[o.owner_type] || o.owner_type) + '</td>' +
                '<td>' + _html(CONTROL_TYPE_LABELS[o.control_type] || o.control_type) + '</td><td>' + _pct(o.effective_percentage) + '</td>' +
                '<td>' + (o.is_reportable ? 'Yes' : 'No') + '</td>' +
                '<td><span class="pill os-' + _html(o.status) + '">' + _html(OWNER_STATUS_LABELS[o.status] || o.status) + '</span></td>' +
                '<td>' + _html(VERIFICATION_LABELS[o.verification_status] || o.verification_status) + '</td></tr>';
        }).join('');
    }

    function _renderShareholders(rows) {
        document.getElementById('shareholdersBody').innerHTML = rows.length ? rows.map(function (s) {
            return '<tr><td>' + _html(s.shareholder_name) + '</td><td>' + _html(s.shareholder_type) + '</td><td>' + _pct(s.percentage) + '</td></tr>';
        }).join('') : '<tr><td colspan="3" class="empty-state">None.</td></tr>';
    }

    function boSyncNaturalPerson() {
        document.getElementById('ofIsNaturalPerson').checked = document.getElementById('ofType').value === 'natural_person';
    }

    function boOpenOwner() {
        _editingOwnerId = null;
        ['ofIdNumber', 'ofRegNumber', 'ofTrustNumber', 'ofTaxNumber', 'ofNationality', 'ofCountry', 'ofDirectPct', 'ofEffectivePct', 'ofSourceNote', 'ofNotes', 'ofName'].forEach(function (id) { document.getElementById(id).value = ''; });
        document.getElementById('ofType').value = 'natural_person';
        document.getElementById('ofControlType').value = 'shareholding';
        document.getElementById('ofIsNaturalPerson').checked = true;
        document.getElementById('ofForceReportable').checked = false;
        document.getElementById('ownerModal').classList.add('open');
    }
    function boCloseOwner() { document.getElementById('ownerModal').classList.remove('open'); }
    function boSubmitOwner() {
        var body = {
            client_id: _currentClientId,
            owner_type: document.getElementById('ofType').value,
            owner_name: document.getElementById('ofName').value,
            id_number: document.getElementById('ofIdNumber').value || null,
            registration_number: document.getElementById('ofRegNumber').value || null,
            trust_number: document.getElementById('ofTrustNumber').value || null,
            tax_number: document.getElementById('ofTaxNumber').value || null,
            nationality: document.getElementById('ofNationality').value || null,
            country_of_residence: document.getElementById('ofCountry').value || null,
            control_type: document.getElementById('ofControlType').value,
            direct_percentage: document.getElementById('ofDirectPct').value || null,
            effective_percentage: document.getElementById('ofEffectivePct').value || null,
            is_natural_person: document.getElementById('ofIsNaturalPerson').checked,
            force_reportable: document.getElementById('ofForceReportable').checked,
            source_note: document.getElementById('ofSourceNote').value || null,
            notes: document.getElementById('ofNotes').value || null,
        };
        if (!body.owner_name) { _showToast('Owner name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/owners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Beneficial owner added.'); boCloseOwner(); boLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to add owner.'); });
    }

    function boOpenOwnerDetail(id) {
        window.PracticeAPI.fetch(BASE + '/owners/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderOwnerDetail(d.owner);
                document.getElementById('ownerDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load owner.'); });
    }
    function boCloseOwnerDetail() { document.getElementById('ownerDetailModal').classList.remove('open'); boLoadClientData(); }

    function _renderOwnerDetail(o) {
        var html = '<div class="modal-title">' + _html(o.owner_name) + ' <span class="pill os-' + _html(o.status) + '">' + _html(OWNER_STATUS_LABELS[o.status]) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">' + _html(OWNER_TYPE_LABELS[o.owner_type]) + ' &middot; ' + _html(CONTROL_TYPE_LABELS[o.control_type]) +
            ' &middot; Effective: ' + _pct(o.effective_percentage) + ' &middot; Reportable: ' + (o.is_reportable ? 'Yes' : 'No') + '</div>';

        var btns = [];
        if (o.status !== 'verified' && o.status !== 'archived') btns.push('<button class="btn-action btn-success" onclick="boVerifyOwner(' + o.id + ')">Verify</button>');
        if (o.status !== 'archived') btns.push('<button class="btn-action btn-danger" onclick="boArchiveOwner(' + o.id + ')">Archive</button>');
        html += btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';

        html += '<div class="mini-card">ID: ' + _html(o.id_number || '—') + ' &middot; Reg: ' + _html(o.registration_number || '—') + ' &middot; Trust: ' + _html(o.trust_number || '—') + '</div>';
        html += '<div class="mini-card">Nationality: ' + _html(o.nationality || '—') + ' &middot; Country of Residence: ' + _html(o.country_of_residence || '—') + '</div>';
        if (o.source_note) html += '<div class="mini-card">Source: ' + _html(o.source_note) + '</div>';
        if (o.notes) html += '<div class="mini-card">' + _html(o.notes) + '</div>';
        document.getElementById('ownerDetailBody').innerHTML = html;
    }

    function boVerifyOwner(id) {
        window.PracticeAPI.fetch(BASE + '/owners/' + id + '/verify', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Owner verified.'); boOpenOwnerDetail(id); })
            .catch(function () { _showToast('Failed to verify.'); });
    }
    function boArchiveOwner(id) {
        window.PracticeAPI.fetch(BASE + '/owners/' + id + '/archive', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Owner archived.'); boCloseOwnerDetail(); })
            .catch(function () { _showToast('Failed to archive.'); });
    }

    // ── Ownership Chains ──────────────────────────────────────────────────────

    function _renderChains(rows) {
        if (!rows.length) { document.getElementById('chainsBody').innerHTML = '<tr><td colspan="6" class="empty-state">No ownership chains on record.</td></tr>'; return; }
        document.getElementById('chainsBody').innerHTML = rows.map(function (c) {
            return '<tr class="row-clickable" onclick="boOpenChainDetail(' + c.id + ')">' +
                '<td>' + _html(c.chain_name) + '</td><td>' + _html(c.root_holder_name) + '</td><td>' + _pct(c.effective_percentage) + '</td>' +
                '<td>' + _html(c.calculation_method) + '</td><td class="conf-' + _html(c.confidence) + '">' + _html(c.confidence) + '</td>' +
                '<td><span class="pill cs-' + _html(c.chain_status) + '">' + _html(CHAIN_STATUS_LABELS[c.chain_status]) + '</span></td></tr>';
        }).join('');
    }

    function boOpenChain() {
        _editingChainId = null;
        ['cfName', 'cfRootName', 'cfRootRefId', 'cfUltimateOwnerId', 'cfDirectPct', 'cfEffectivePct', 'cfNotes'].forEach(function (id) { document.getElementById(id).value = ''; });
        document.getElementById('cfChainPath').value = '[]';
        document.getElementById('cfRootType').value = 'shareholder';
        document.getElementById('chainModal').classList.add('open');
    }
    function boCloseChain() { document.getElementById('chainModal').classList.remove('open'); }
    function boSubmitChain() {
        var chainPathRaw = document.getElementById('cfChainPath').value.trim();
        var chainPath = [];
        if (chainPathRaw) {
            try { chainPath = JSON.parse(chainPathRaw); } catch (e) { _showToast('Chain Path must be valid JSON.'); return; }
        }
        var body = {
            client_id: _currentClientId,
            chain_name: document.getElementById('cfName').value,
            root_holder_type: document.getElementById('cfRootType').value,
            root_holder_name: document.getElementById('cfRootName').value,
            root_holder_reference_id: document.getElementById('cfRootRefId').value || null,
            ultimate_owner_id: document.getElementById('cfUltimateOwnerId').value || null,
            chain_path: chainPath,
            direct_percentage: document.getElementById('cfDirectPct').value || null,
            effective_percentage: document.getElementById('cfEffectivePct').value || null,
            notes: document.getElementById('cfNotes').value || null,
        };
        if (!body.chain_name) { _showToast('Chain name is required.'); return; }
        if (!body.root_holder_name) { _showToast('Root holder name is required.'); return; }
        window.PracticeAPI.fetch(BASE + '/chains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Ownership chain added.'); boCloseChain(); boLoadClientData(); _loadSummary(); })
            .catch(function () { _showToast('Failed to add chain.'); });
    }

    function boOpenChainDetail(id) {
        window.PracticeAPI.fetch(BASE + '/chains/' + id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _renderChainDetail(d.chain);
                document.getElementById('chainDetailModal').classList.add('open');
            })
            .catch(function () { _showToast('Failed to load chain.'); });
    }
    function boCloseChainDetail() { document.getElementById('chainDetailModal').classList.remove('open'); boLoadClientData(); }

    function _renderChainDetail(c) {
        var html = '<div class="modal-title">' + _html(c.chain_name) + ' <span class="pill cs-' + _html(c.chain_status) + '">' + _html(CHAIN_STATUS_LABELS[c.chain_status]) + '</span></div>';
        html += '<div class="mini-card-meta" style="margin-bottom:14px;">Root: ' + _html(c.root_holder_name) + ' (' + _html(c.root_holder_type) + ')' +
            ' &middot; Effective: ' + _pct(c.effective_percentage) + ' &middot; Method: ' + _html(c.calculation_method) + ' &middot; Confidence: ' + _html(c.confidence) + '</div>';

        var btns = [];
        if (c.chain_status !== 'verified' && c.chain_status !== 'archived') btns.push('<button class="btn-action btn-success" onclick="boVerifyChain(' + c.id + ')">Verify</button>');
        if (c.chain_status !== 'archived') btns.push('<button class="btn-action btn-danger" onclick="boArchiveChain(' + c.id + ')">Archive</button>');
        html += btns.length ? '<div class="action-bar">' + btns.join('') + '</div>' : '';

        if (c.missing_information) html += '<div class="mini-card" style="border-left:3px solid #f6ad55;">' + _html(c.missing_information) + '</div>';
        html += '<div class="mini-card"><strong>Chain Path</strong><pre style="white-space:pre-wrap;font-size:.76rem;margin-top:6px;">' + _html(JSON.stringify(c.chain_path || [], null, 2)) + '</pre></div>';
        if (c.notes) html += '<div class="mini-card">' + _html(c.notes) + '</div>';
        document.getElementById('chainDetailBody').innerHTML = html;
    }

    function boVerifyChain(id) {
        window.PracticeAPI.fetch(BASE + '/chains/' + id + '/verify', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Chain verified.'); boOpenChainDetail(id); })
            .catch(function () { _showToast('Failed to verify.'); });
    }
    function boArchiveChain(id) {
        window.PracticeAPI.fetch(BASE + '/chains/' + id + '/archive', { method: 'PUT' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Chain archived.'); boCloseChainDetail(); })
            .catch(function () { _showToast('Failed to archive.'); });
    }

    // ── Readiness ─────────────────────────────────────────────────────────────

    function _renderReadinessItems(rows) {
        if (!rows.length) { document.getElementById('readinessBody').innerHTML = '<tr><td colspan="6" class="empty-state">No readiness items yet — click "Generate Items."</td></tr>'; return; }
        document.getElementById('readinessBody').innerHTML = rows.map(function (i) {
            var doneOptions = ['requested', 'received', 'verified', 'waived', 'blocked', 'not_applicable'];
            var select = '<select onchange="boUpdateReadinessStatus(' + i.id + ', this.value)">' + doneOptions.map(function (s) {
                return '<option value="' + s + '"' + (s === i.status ? ' selected' : '') + '>' + _html(READINESS_STATUS_LABELS[s]) + '</option>';
            }).join('') + '</select>';
            return '<tr><td>' + _html(i.item_name) + '</td><td>' + _html(i.item_type) + '</td><td>' + (i.required ? 'Yes' : 'No') + '</td>' +
                '<td><span class="pill rs-' + _html(i.status) + '">' + _html(READINESS_STATUS_LABELS[i.status] || i.status) + '</span></td>' +
                '<td>' + _fmtDate(i.due_date) + '</td><td>' + select + '</td></tr>';
        }).join('');
    }

    function boGenerateReadiness() {
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId + '/generate-readiness', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast(d.created_count + ' readiness item(s) generated.'); boLoadClientData(); })
            .catch(function () { _showToast('Failed to generate readiness items.'); });
    }

    function boUpdateReadinessStatus(itemId, status) {
        window.PracticeAPI.fetch(BASE + '/readiness/' + itemId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Readiness item updated.'); boLoadClientData(); })
            .catch(function () { _showToast('Failed to update readiness item.'); });
    }

    function boRecalculateReadiness() {
        window.PracticeAPI.fetch(BASE + '/client/' + _currentClientId + '/recalculate-readiness', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.error) { _showToast(d.error); return; } _showToast('Readiness recalculated: ' + (READINESS_TOP_LABELS[d.status] || d.status)); boLoadClientData(); })
            .catch(function () { _showToast('Failed to recalculate.'); });
    }

    // ── Events ────────────────────────────────────────────────────────────────

    function _loadEvents() {
        window.PracticeAPI.fetch(BASE + '/events?client_id=' + _currentClientId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.events || [];
                document.getElementById('eventsBody').innerHTML = rows.length ? rows.map(function (e) {
                    return '<div class="mini-card">' + _html(EV_LABELS[e.event_type] || e.event_type) +
                        '<div class="mini-card-meta">' + _fmt(e.created_at) + (e.notes ? ' &middot; ' + _html(e.notes) : '') + '</div></div>';
                }).join('') : '<div class="empty-state">No events yet.</div>';
            })
            .catch(function () { document.getElementById('eventsBody').innerHTML = '<div class="empty-state">Failed to load.</div>'; });
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.boSetTab = boSetTab;
    window.boOnClientChange = boOnClientChange;
    window.boSyncNaturalPerson = boSyncNaturalPerson;
    window.boOpenOwner = boOpenOwner;
    window.boCloseOwner = boCloseOwner;
    window.boSubmitOwner = boSubmitOwner;
    window.boOpenOwnerDetail = boOpenOwnerDetail;
    window.boCloseOwnerDetail = boCloseOwnerDetail;
    window.boVerifyOwner = boVerifyOwner;
    window.boArchiveOwner = boArchiveOwner;
    window.boOpenChain = boOpenChain;
    window.boCloseChain = boCloseChain;
    window.boSubmitChain = boSubmitChain;
    window.boOpenChainDetail = boOpenChainDetail;
    window.boCloseChainDetail = boCloseChainDetail;
    window.boVerifyChain = boVerifyChain;
    window.boArchiveChain = boArchiveChain;
    window.boGenerateReadiness = boGenerateReadiness;
    window.boUpdateReadinessStatus = boUpdateReadinessStatus;
    window.boRecalculateReadiness = boRecalculateReadiness;

    document.addEventListener('DOMContentLoaded', boLoadAll);
})();
