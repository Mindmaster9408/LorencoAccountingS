/* ============================================================
   Lorenco Practice — Service Catalog Page JS
   Rule D: no localStorage for business data. All data via API.
   ============================================================ */
(function () {
    var esc = PracticeAPI.escHtml;
    var _editingServiceId = null;

    var CATEGORY_LABELS = {
        vat:               'VAT',
        paye:              'PAYE',
        emp501:            'EMP501',
        income_tax:        'Income Tax',
        annual_financials: 'Annual Financials',
        bookkeeping:       'Bookkeeping',
        payroll:           'Payroll',
        secretarial:       'Secretarial',
        consulting:        'Consulting',
        cipc:              'CIPC',
        other:             'Other'
    };

    var FEE_FREQ_LABELS = {
        monthly:   'Monthly',
        quarterly: 'Quarterly',
        biannual:  'Biannual',
        annual:    'Annual',
        once_off:  'Once-off',
        per_hour:  'Per Hour'
    };

    var BILLING_TYPE_LABELS = {
        fixed:    'Fixed',
        hourly:   'Hourly',
        retainer: 'Retainer'
    };

    // ── Auth + init ─────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        LAYOUT.init('services');
        loadServices();
    }

    // ── Load services ───────────────────────────────────────────────────────────

    async function loadServices() {
        var cat    = document.getElementById('filterCategory').value;
        var active = document.getElementById('filterActive').value;

        document.getElementById('pageLoading').classList.remove('hidden');
        document.getElementById('servicesWrap').classList.add('hidden');
        document.getElementById('pageError').classList.add('hidden');

        try {
            var qs = '?active=' + encodeURIComponent(active);
            if (cat) qs += '&category=' + encodeURIComponent(cat);
            var res = await PracticeAPI.fetch('/api/practice/services' + qs);
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            renderServices(d.services || []);
        } catch(e) {
            document.getElementById('pageLoading').classList.add('hidden');
            document.getElementById('pageError').classList.remove('hidden');
        }
    }

    function renderServices(services) {
        document.getElementById('pageLoading').classList.add('hidden');
        var wrap = document.getElementById('servicesWrap');
        wrap.classList.remove('hidden');

        if (!services.length) {
            wrap.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><h3>No services</h3><p>Add services to your catalog so you can link them to client engagements.</p></div>';
            return;
        }

        var rows = services.map(function(s) {
            var catLabel  = CATEGORY_LABELS[s.service_category] || s.service_category;
            var catClass  = 'cat-' + (s.service_category || 'other');
            var feeStr    = '';
            if (s.default_fee_amount != null) {
                feeStr = 'R ' + Number(s.default_fee_amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                if (s.default_fee_frequency) feeStr += ' / ' + (FEE_FREQ_LABELS[s.default_fee_frequency] || s.default_fee_frequency);
            } else {
                feeStr = '<span class="col-muted">—</span>';
            }
            var billingLabel = BILLING_TYPE_LABELS[s.default_billing_type] || s.default_billing_type || '—';
            var activeLabel  = s.is_active
                ? '<span class="service-active">● Active</span>'
                : '<span class="service-inactive">○ Inactive</span>';
            var codeHtml     = s.service_code
                ? '<span class="service-code-badge" style="display:inline-block;background:rgba(167,139,250,0.12);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:0.72rem;font-weight:600;margin-left:6px">' + esc(s.service_code) + '</span>'
                : '';
            return '<tr>' +
                '<td><strong>' + esc(s.service_name) + '</strong>' + codeHtml + '</td>' +
                '<td><span class="cat-dot ' + catClass + '"></span>' + esc(catLabel) + '</td>' +
                '<td class="col-muted">' + billingLabel + '</td>' +
                '<td>' + feeStr + '</td>' +
                '<td>' + activeLabel + '</td>' +
                '<td><div class="td-actions">' +
                    '<button type="button" class="btn btn-ghost btn-sm" onclick="window._openServiceModal(' + s.id + ')">Edit</button>' +
                '</div></td>' +
            '</tr>';
        }).join('');

        wrap.innerHTML =
            '<div class="table-wrap"><table><thead><tr>' +
                '<th>Name</th><th>Category</th><th>Billing</th><th>Default Fee</th><th>Status</th><th>Actions</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    // ── Service modal ───────────────────────────────────────────────────────────

    async function _openServiceModal(id) {
        _editingServiceId = id || null;
        var svc = null;

        if (id) {
            try {
                var res = await PracticeAPI.fetch('/api/practice/services/' + id);
                if (res.ok) {
                    var d = await res.json();
                    svc = d.service || null;
                }
            } catch(e) {}
        }

        document.getElementById('serviceModalTitle').textContent = id ? 'Edit Service' : 'Add Service';
        document.getElementById('sCode').value    = svc ? (svc.service_code     || '') : '';
        document.getElementById('sName').value    = svc ? (svc.service_name     || '') : '';
        document.getElementById('sCategory').value = svc ? (svc.service_category || '') : '';
        document.getElementById('sBillingType').value = svc ? (svc.default_billing_type || 'fixed') : 'fixed';
        document.getElementById('sFeeAmount').value   = svc && svc.default_fee_amount != null ? svc.default_fee_amount : '';
        document.getElementById('sFeeFreq').value     = svc ? (svc.default_fee_frequency || 'monthly') : 'monthly';
        document.getElementById('sHourlyRate').value  = svc && svc.default_hourly_rate != null ? svc.default_hourly_rate : '';
        document.getElementById('sEstHours').value    = svc && svc.estimated_hours_per_period != null ? svc.estimated_hours_per_period : '';
        document.getElementById('sOrder').value       = svc && svc.display_order != null ? svc.display_order : 0;
        document.getElementById('sActive').checked    = svc ? !!svc.is_active : true;
        document.getElementById('sDesc').value        = svc ? (svc.description || '') : '';
        document.getElementById('sNotes').value       = svc ? (svc.notes || '') : '';

        var deactivateBtn = document.getElementById('sDeactivateBtn');
        if (id && svc && svc.is_active) { deactivateBtn.classList.remove('hidden'); }
        else { deactivateBtn.classList.add('hidden'); }

        document.getElementById('serviceModal').classList.add('show');
    }

    function openServiceModal() { _openServiceModal(null); }

    function closeServiceModal() {
        document.getElementById('serviceModal').classList.remove('show');
    }

    async function saveService(e) {
        e.preventDefault();
        var btn = document.getElementById('sSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…';

        var feeRaw  = document.getElementById('sFeeAmount').value.trim();
        var rateRaw = document.getElementById('sHourlyRate').value.trim();
        var hrRaw   = document.getElementById('sEstHours').value.trim();
        var ordRaw  = document.getElementById('sOrder').value.trim();

        var body = {
            service_code:              document.getElementById('sCode').value.trim() || null,
            service_name:              document.getElementById('sName').value.trim(),
            service_category:          document.getElementById('sCategory').value,
            default_billing_type:      document.getElementById('sBillingType').value,
            default_fee_amount:        feeRaw  ? parseFloat(feeRaw)  : null,
            default_fee_frequency:     document.getElementById('sFeeFreq').value,
            default_hourly_rate:       rateRaw ? parseFloat(rateRaw) : null,
            estimated_hours_per_period: hrRaw  ? parseFloat(hrRaw)   : null,
            display_order:             ordRaw  ? parseInt(ordRaw)     : 0,
            is_active:                 document.getElementById('sActive').checked,
            description:               document.getElementById('sDesc').value.trim() || null,
            notes:                     document.getElementById('sNotes').value.trim() || null
        };

        try {
            var url    = _editingServiceId ? '/api/practice/services/' + _editingServiceId : '/api/practice/services';
            var method = _editingServiceId ? 'PUT' : 'POST';
            var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
            var d   = await res.json();
            if (!res.ok) throw new Error(d.error || 'Save failed');
            closeServiceModal();
            PracticeAPI.showToast(_editingServiceId ? 'Service updated!' : 'Service added!');
            loadServices();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Save Service';
        }
        return false;
    }

    async function deactivateService() {
        if (!_editingServiceId) return;
        if (!confirm('Deactivate this service? It will no longer appear in active service lists.')) return;
        try {
            var res = await PracticeAPI.fetch('/api/practice/services/' + _editingServiceId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Deactivate failed');
            closeServiceModal();
            PracticeAPI.showToast('Service deactivated.');
            loadServices();
        } catch(e) {
            PracticeAPI.showToast('❌ ' + e.message, true);
        }
    }

    // ── Expose globals ──────────────────────────────────────────────────────────

    window.loadServices      = loadServices;
    window.openServiceModal  = openServiceModal;
    window.closeServiceModal = closeServiceModal;
    window.saveService       = saveService;
    window.deactivateService = deactivateService;
    window._openServiceModal = _openServiceModal;

    init();
})();
