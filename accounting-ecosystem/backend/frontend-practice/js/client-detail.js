/* ============================================================
   Lorenco Practice — Client Detail / CRM Page JS
   Handles auth, load, save, archive, and contact persons.
   Rule D: no localStorage for business data. All data via API.
   ============================================================ */
(function () {
    var esc = PracticeAPI.escHtml;
    var clientId = null;
    var editingContactId = null;

    // ── Auth + init ────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        var params = new URLSearchParams(window.location.search);
        clientId = params.get('id') ? parseInt(params.get('id')) : null;
        if (!clientId) {
            window.location.href = '/practice/clients.html';
            return;
        }

        LAYOUT.init('clients');
        await Promise.all([loadTeam(), loadClient()]);
    }

    // ── Load team members for ownership pickers ────────────────────────────────

    async function loadTeam() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/team?active=true');
            if (!res.ok) return;
            var d = await res.json();
            var members = d.members || [];
            var opts = members.map(function(m) {
                return '<option value="' + m.id + '">' + esc(m.display_name) +
                    (m.job_title ? ' — ' + esc(m.job_title) : '') + '</option>';
            }).join('');
            var stub = '<option value="">Not assigned</option>' + opts;
            ['dResponsible', 'dReviewer', 'dPartner'].forEach(function(id) {
                document.getElementById(id).innerHTML = stub;
            });
        } catch(e) {}
    }

    // ── Load client ────────────────────────────────────────────────────────────

    async function loadClient() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId);
            if (!res.ok) throw new Error('Not found');
            var d = await res.json();
            populateForm(d.client);
            document.getElementById('pageLoading').classList.add('hidden');
            document.getElementById('clientForm').classList.remove('hidden');
            document.getElementById('contactsSection').classList.remove('hidden');
            document.getElementById('complianceSuggestionsSection').classList.remove('hidden');
            document.getElementById('archiveBtn').classList.remove('hidden');
            loadContacts();
        } catch(e) {
            document.getElementById('pageLoading').classList.add('hidden');
            document.getElementById('pageError').classList.remove('hidden');
        }
    }

    // ── Populate form ──────────────────────────────────────────────────────────

    function populateForm(c) {
        document.getElementById('pageTitle').textContent = c.name || 'Client Profile';
        var typeLabel = { company:'Company', cc:'CC', trust:'Trust', partnership:'Partnership',
            sole_proprietor:'Sole Proprietor', individual:'Individual', other:'Other' };
        document.getElementById('pageSubtitle').textContent = typeLabel[c.client_type] || '';

        setVal('dName',         c.name);
        setVal('dClientType',   c.client_type || 'company');
        setVal('dIndustry',     c.industry);
        setVal('dFYEMonth',     c.financial_year_end_month || '');

        setVal('dRegNumber',    c.registration_number);
        setVal('dVatNumber',    c.vat_number);
        setVal('dIncomeTax',    c.income_tax_number);
        setVal('dPayeRef',      c.paye_reference_number);
        setVal('dUifRef',       c.uif_reference_number);
        setVal('dSdlRef',       c.sdl_reference_number);

        setVal('dIdNumber',     c.id_number);
        setVal('dPassport',     c.passport_number);
        setVal('dDOB',          c.date_of_birth ? c.date_of_birth.substring(0, 10) : '');

        setVal('dEmail',        c.email);
        setVal('dPhone',        c.phone);
        setVal('dSecondaryPhone', c.secondary_phone);
        setVal('dWebsite',      c.website);

        setVal('dAddrLine1',    c.address_line1);
        setVal('dAddrLine2',    c.address_line2);
        setVal('dAddrCity',     c.address_city);
        setVal('dAddrProvince', c.address_province || '');
        setVal('dAddrPostal',   c.address_postal_code);
        setVal('dAddrCountry',  c.address_country || 'South Africa');

        var postalSame = c.postal_same_as_physical !== false;
        document.getElementById('dPostalSame').checked = postalSame;
        setVal('dPostalLine1',  c.postal_address_line1);
        setVal('dPostalLine2',  c.postal_address_line2);
        setVal('dPostalCity',   c.postal_city);
        setVal('dPostalProvince', c.postal_province || '');
        setVal('dPostalCode',   c.postal_postal_code);
        setVal('dPostalCountry', c.postal_country);

        setVal('dResponsible',  c.responsible_team_member_id || '');
        setVal('dReviewer',     c.reviewer_team_member_id || '');
        setVal('dPartner',      c.partner_team_member_id || '');

        document.getElementById('dVatReg').checked   = !!c.vat_registered;
        document.getElementById('dPayeReg').checked  = !!c.paye_registered;
        document.getElementById('dProvTax').checked  = !!c.provisional_taxpayer;
        document.getElementById('dUifReg').checked   = !!c.uif_registered;
        document.getElementById('dSdlReg').checked   = !!c.sdl_registered;
        document.getElementById('dCoidaReg').checked = !!c.coida_registered;
        document.getElementById('dCipcReg').checked  = !!c.cipc_registered;

        setVal('dOnboarding',   c.onboarding_status || 'active');
        setVal('dRisk',         c.risk_rating || 'normal');
        setVal('dStatus',       c.is_active !== false ? 'true' : 'false');

        setVal('dBillingRate',    c.billing_rate_override != null ? c.billing_rate_override : '');
        setVal('dCurrency',       c.billing_currency || 'ZAR');
        setVal('dPaymentTerms',   c.payment_terms_days != null ? c.payment_terms_days : '30');

        setVal('dNotes',          c.notes);
        setVal('dInternalNotes',  c.internal_notes);

        toggleIndividualFields();
        togglePostalAddress();
    }

    // ── Show / hide individual taxpayer section ────────────────────────────────

    function toggleIndividualFields() {
        var isIndividual = document.getElementById('dClientType').value === 'individual';
        document.getElementById('individualSection').classList.toggle('hidden', !isIndividual);
    }

    // ── Show / hide postal address section ─────────────────────────────────────

    function togglePostalAddress() {
        var same = document.getElementById('dPostalSame').checked;
        document.getElementById('postalSection').classList.toggle('hidden', same);
    }

    // ── Save client ────────────────────────────────────────────────────────────

    async function saveClientDetail(e) {
        e.preventDefault();
        var btn = document.getElementById('saveBtn');
        btn.disabled = true;

        var responsibleRaw = document.getElementById('dResponsible').value;
        var reviewerRaw    = document.getElementById('dReviewer').value;
        var partnerRaw     = document.getElementById('dPartner').value;
        var fyeRaw         = document.getElementById('dFYEMonth').value;
        var rateRaw        = document.getElementById('dBillingRate').value;
        var termsRaw       = document.getElementById('dPaymentTerms').value;

        var body = {
            name:                       document.getElementById('dName').value.trim(),
            client_type:                document.getElementById('dClientType').value,
            industry:                   document.getElementById('dIndustry').value.trim() || null,
            financial_year_end_month:   fyeRaw ? parseInt(fyeRaw) : null,

            registration_number:        document.getElementById('dRegNumber').value.trim() || null,
            vat_number:                 document.getElementById('dVatNumber').value.trim() || null,
            income_tax_number:          document.getElementById('dIncomeTax').value.trim() || null,
            paye_reference_number:      document.getElementById('dPayeRef').value.trim() || null,
            uif_reference_number:       document.getElementById('dUifRef').value.trim() || null,
            sdl_reference_number:       document.getElementById('dSdlRef').value.trim() || null,

            id_number:                  document.getElementById('dIdNumber').value.trim() || null,
            passport_number:            document.getElementById('dPassport').value.trim() || null,
            date_of_birth:              document.getElementById('dDOB').value || null,

            email:                      document.getElementById('dEmail').value.trim() || null,
            phone:                      document.getElementById('dPhone').value.trim() || null,
            secondary_phone:            document.getElementById('dSecondaryPhone').value.trim() || null,
            website:                    document.getElementById('dWebsite').value.trim() || null,

            address_line1:              document.getElementById('dAddrLine1').value.trim() || null,
            address_line2:              document.getElementById('dAddrLine2').value.trim() || null,
            address_city:               document.getElementById('dAddrCity').value.trim() || null,
            address_province:           document.getElementById('dAddrProvince').value || null,
            address_postal_code:        document.getElementById('dAddrPostal').value.trim() || null,
            address_country:            document.getElementById('dAddrCountry').value.trim() || 'South Africa',

            postal_same_as_physical:    document.getElementById('dPostalSame').checked,
            postal_address_line1:       document.getElementById('dPostalLine1').value.trim() || null,
            postal_address_line2:       document.getElementById('dPostalLine2').value.trim() || null,
            postal_city:                document.getElementById('dPostalCity').value.trim() || null,
            postal_province:            document.getElementById('dPostalProvince').value || null,
            postal_postal_code:         document.getElementById('dPostalCode').value.trim() || null,
            postal_country:             document.getElementById('dPostalCountry').value.trim() || null,

            responsible_team_member_id: responsibleRaw ? parseInt(responsibleRaw) : null,
            reviewer_team_member_id:    reviewerRaw    ? parseInt(reviewerRaw)    : null,
            partner_team_member_id:     partnerRaw     ? parseInt(partnerRaw)     : null,

            vat_registered:     document.getElementById('dVatReg').checked,
            paye_registered:    document.getElementById('dPayeReg').checked,
            provisional_taxpayer: document.getElementById('dProvTax').checked,
            uif_registered:     document.getElementById('dUifReg').checked,
            sdl_registered:     document.getElementById('dSdlReg').checked,
            coida_registered:   document.getElementById('dCoidaReg').checked,
            cipc_registered:    document.getElementById('dCipcReg').checked,

            onboarding_status:  document.getElementById('dOnboarding').value,
            risk_rating:        document.getElementById('dRisk').value,
            is_active:          document.getElementById('dStatus').value === 'true',

            billing_rate_override: rateRaw  ? parseFloat(rateRaw)  : null,
            billing_currency:      document.getElementById('dCurrency').value,
            payment_terms_days:    termsRaw ? parseInt(termsRaw)   : 30,

            notes:         document.getElementById('dNotes').value.trim() || null,
            internal_notes: document.getElementById('dInternalNotes').value.trim() || null
        };

        try {
            var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Save failed');
            PracticeAPI.showToast('Client saved!');
            document.getElementById('pageTitle').textContent = body.name || 'Client Profile';
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false;
        }
        return false;
    }

    // ── Archive client ─────────────────────────────────────────────────────────

    async function archiveClient() {
        var name = document.getElementById('dName').value || 'this client';
        if (!confirm('Archive "' + name + '"? This will mark them as inactive and archived. You can reactivate from the client list.')) return;
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Archive failed');
            PracticeAPI.showToast('Client archived.');
            setTimeout(function() { window.location.href = '/practice/clients.html'; }, 800);
        } catch(e) {
            PracticeAPI.showToast('❌ ' + e.message, true);
        }
    }

    // ── Contact persons ────────────────────────────────────────────────────────

    async function loadContacts() {
        document.getElementById('contactsWrap').innerHTML =
            '<div class="loading"><div class="loading-spinner"></div><p>Loading contacts…</p></div>';
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId + '/contacts');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            renderContacts(d.contacts || []);
        } catch(e) {
            document.getElementById('contactsWrap').innerHTML =
                '<div class="error-banner">⚠️ Failed to load contacts.</div>';
        }
    }

    function renderContacts(contacts) {
        var wrap = document.getElementById('contactsWrap');
        if (!contacts.length) {
            wrap.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><h3>No contact persons</h3><p>Add contacts to track who receives correspondence from this client.</p></div>';
            return;
        }

        var rows = contacts.map(function(ct) {
            var badges = [];
            if (ct.is_primary)                badges.push('<span class="badge badge-billable">Primary</span>');
            if (ct.receives_tax_correspondence) badges.push('<span class="badge badge-info">Tax</span>');
            if (ct.receives_billing)            badges.push('<span class="badge badge-pending">Billing</span>');
            if (ct.receives_payroll)            badges.push('<span class="badge badge-review">Payroll</span>');
            if (ct.receives_cipc)              badges.push('<span class="badge badge-open">CIPC</span>');
            var contact = [
                ct.email ? '<div>' + esc(ct.email) + '</div>' : '',
                ct.phone ? '<div style="font-size:0.78rem;">' + esc(ct.phone) + '</div>' : '',
                ct.mobile && !ct.phone ? '<div style="font-size:0.78rem;">' + esc(ct.mobile) + '</div>' : ''
            ].filter(Boolean).join('') || '–';

            return '<tr>' +
                '<td><strong>' + esc(ct.contact_name) + '</strong>' +
                    (ct.role ? '<div class="col-muted" style="font-size:0.78rem;">' + esc(ct.role) + '</div>' : '') +
                '</td>' +
                '<td class="col-muted">' + contact + '</td>' +
                '<td>' + (badges.length ? badges.join(' ') : '<span class="col-muted">–</span>') + '</td>' +
                '<td><div class="td-actions">' +
                    '<button type="button" class="btn btn-ghost btn-sm" onclick="window._openContactModal(' + ct.id + ')">Edit</button>' +
                '</div></td>' +
            '</tr>';
        }).join('');

        wrap.innerHTML =
            '<div class="table-wrap"><table><thead><tr>' +
                '<th>Name</th><th>Contact</th><th>Correspondence</th><th>Actions</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    // ── Contact modal ──────────────────────────────────────────────────────────

    var cachedContacts = [];

    async function _openContactModal(id) {
        editingContactId = id || null;
        var ct = null;

        if (id) {
            try {
                var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId + '/contacts');
                if (res.ok) {
                    var d = await res.json();
                    cachedContacts = d.contacts || [];
                    ct = cachedContacts.find(function(x) { return x.id === id; }) || null;
                }
            } catch(e) {}
        }

        document.getElementById('contactModalTitle').textContent = id ? 'Edit Contact' : 'Add Contact Person';
        document.getElementById('ctName').value   = ct ? ct.contact_name || '' : '';
        document.getElementById('ctRole').value   = ct ? ct.role || '' : '';
        document.getElementById('ctEmail').value  = ct ? ct.email || '' : '';
        document.getElementById('ctPhone').value  = ct ? ct.phone || '' : '';
        document.getElementById('ctMobile').value = ct ? ct.mobile || '' : '';
        document.getElementById('ctNotes').value  = ct ? ct.notes || '' : '';
        document.getElementById('ctPrimary').checked  = ct ? !!ct.is_primary : false;
        document.getElementById('ctTax').checked      = ct ? !!ct.receives_tax_correspondence : false;
        document.getElementById('ctBilling').checked  = ct ? !!ct.receives_billing : false;
        document.getElementById('ctPayroll').checked  = ct ? !!ct.receives_payroll : false;
        document.getElementById('ctCipc').checked     = ct ? !!ct.receives_cipc : false;

        var deactivateBtn = document.getElementById('ctDeactivateBtn');
        if (id) { deactivateBtn.classList.remove('hidden'); }
        else     { deactivateBtn.classList.add('hidden'); }

        document.getElementById('contactModal').classList.add('show');
    }

    function openContactModal() { _openContactModal(null); }

    function closeContactModal() {
        document.getElementById('contactModal').classList.remove('show');
    }

    async function saveContact(e) {
        e.preventDefault();
        var btn = document.getElementById('ctSaveBtn');
        btn.disabled = true;

        var body = {
            contact_name:               document.getElementById('ctName').value.trim(),
            role:                       document.getElementById('ctRole').value.trim() || null,
            email:                      document.getElementById('ctEmail').value.trim() || null,
            phone:                      document.getElementById('ctPhone').value.trim() || null,
            mobile:                     document.getElementById('ctMobile').value.trim() || null,
            notes:                      document.getElementById('ctNotes').value.trim() || null,
            is_primary:                 document.getElementById('ctPrimary').checked,
            receives_tax_correspondence: document.getElementById('ctTax').checked,
            receives_billing:           document.getElementById('ctBilling').checked,
            receives_payroll:           document.getElementById('ctPayroll').checked,
            receives_cipc:              document.getElementById('ctCipc').checked
        };

        try {
            var url    = editingContactId
                ? '/api/practice/clients/' + clientId + '/contacts/' + editingContactId
                : '/api/practice/clients/' + clientId + '/contacts';
            var method = editingContactId ? 'PUT' : 'POST';
            var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Save failed');
            closeContactModal();
            PracticeAPI.showToast(editingContactId ? 'Contact updated!' : 'Contact added!');
            loadContacts();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false;
        }
        return false;
    }

    async function deactivateContact() {
        if (!editingContactId) return;
        var ct = cachedContacts.find(function(x) { return x.id === editingContactId; });
        if (!confirm('Remove "' + (ct ? ct.contact_name : 'this contact') + '"?')) return;
        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/clients/' + clientId + '/contacts/' + editingContactId,
                { method: 'DELETE' }
            );
            if (!res.ok) throw new Error('Remove failed');
            closeContactModal();
            PracticeAPI.showToast('Contact removed.');
            loadContacts();
        } catch(e) {
            PracticeAPI.showToast('❌ ' + e.message, true);
        }
    }

    // ── Utilities ──────────────────────────────────────────────────────────────

    function setVal(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = (value != null ? value : '');
    }

    // ── Compliance Suggestions ─────────────────────────────────────────────────

    var _suggestionData = null;  // last loaded suggestion for modal pre-fill
    var _sdTeamLoaded   = false;

    async function loadComplianceSuggestions() {
        if (!clientId) return;
        var btn  = document.getElementById('loadSuggestionsBtn');
        var wrap = document.getElementById('suggestionsWrap');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        wrap.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Fetching suggestions…</p></div>';

        try {
            var r = await PracticeAPI.fetch('/api/practice/compliance/suggestions/client/' + clientId);
            if (!r.ok) throw new Error('Request failed');
            var d = await r.json();
            var suggestions = d.suggestions || [];

            if (!suggestions.length) {
                wrap.innerHTML = '<div class="empty"><h3>No suggestions available</h3><p>Set compliance flags on this client to generate suggestions.</p></div>';
                return;
            }

            var areaColours = {
                vat: '#38bdf8', paye: '#f59e0b', emp501: '#a78bfa',
                provisional_tax: '#f43f5e', income_tax: '#10b981',
                cipc: '#fb923c', bo: '#e879f9', annual_financials: '#34d399',
                payroll: '#60a5fa', bookkeeping: '#a3e635', other: '#94a3b8'
            };

            wrap.innerHTML = suggestions.map(function(s, i) {
                var colour = areaColours[s.compliance_area] || '#94a3b8';
                return '<div class="suggestion-card" style="border-left-color:' + colour + '">' +
                    '<div class="suggestion-body">' +
                        '<div class="suggestion-title">' + esc(s.title) + '</div>' +
                        '<div class="suggestion-reason">' + esc(s.reason) + '</div>' +
                        (s.note ? '<div class="suggestion-note">' + esc(s.note) + '</div>' : '') +
                        '<div class="suggestion-meta">' +
                            '<span class="badge badge-info" style="font-size:0.7rem">' + esc(s.compliance_area || '') + '</span>' +
                            '<span class="badge" style="font-size:0.7rem;background:rgba(255,255,255,0.06)">' + esc(s.deadline_type || '') + '</span>' +
                            (s.suggested_recurrence ? '<span class="col-muted" style="font-size:0.72rem">↻ ' + esc(s.suggested_recurrence) + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                    '<button type="button" class="btn btn-ghost btn-sm" onclick="openSuggestionDeadlineModal(' + i + ')" style="flex-shrink:0">+ Create Deadline</button>' +
                '</div>';
            }).join('');

            // Store for modal access by index
            window._complianceSuggestions = suggestions;

        } catch(e) {
            wrap.innerHTML = '<div class="error-banner">Failed to load suggestions: ' + esc(e.message) + '</div>';
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Refresh Suggestions'; }
        }
    }

    async function openSuggestionDeadlineModal(idx) {
        var suggestions = window._complianceSuggestions || [];
        var s = suggestions[idx];
        if (!s) return;
        _suggestionData = s;

        document.getElementById('sdTitle').value        = s.title || '';
        document.getElementById('sdDueDate').value      = '';
        document.getElementById('sdPeriodStart').value  = '';
        document.getElementById('sdPeriodEnd').value    = '';
        document.getElementById('sdPriority').value     = s.priority || 'normal';
        document.getElementById('sdNotes').value        = s.note || '';
        document.getElementById('sdArea').value         = s.compliance_area || '';
        document.getElementById('sdDeadlineType').value = s.deadline_type || '';
        document.getElementById('sdType').value         = s.type || 'general';

        // Populate team members if not done yet
        if (!_sdTeamLoaded) {
            try {
                var tr = await PracticeAPI.fetch('/api/practice/team?active=true');
                if (tr.ok) {
                    var td = await tr.json();
                    var opts = (td.members || []).map(function(m) {
                        return '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
                    }).join('');
                    var el = document.getElementById('sdResponsible');
                    if (el) el.innerHTML = '<option value="">Not assigned</option>' + opts;
                    _sdTeamLoaded = true;
                }
            } catch(e) {}
        }

        document.getElementById('suggestionDeadlineModal').classList.add('show');
    }

    async function saveSuggestionDeadline(e) {
        e.preventDefault();
        var s = _suggestionData || {};
        var btn = document.getElementById('sdSaveBtn');
        btn.disabled = true; btn.textContent = 'Creating…';

        var payload = {
            title:                    document.getElementById('sdTitle').value.trim(),
            client_id:                clientId,
            compliance_area:          document.getElementById('sdArea').value || null,
            deadline_type:            document.getElementById('sdDeadlineType').value || null,
            type:                     document.getElementById('sdType').value || 'general',
            due_date:                 document.getElementById('sdDueDate').value,
            period_start:             document.getElementById('sdPeriodStart').value || null,
            period_end:               document.getElementById('sdPeriodEnd').value || null,
            responsible_team_member_id: document.getElementById('sdResponsible').value || null,
            priority:                 document.getElementById('sdPriority').value || 'normal',
            notes:                    document.getElementById('sdNotes').value.trim() || null,
            status:                   'open'
        };

        try {
            var r = await PracticeAPI.fetch('/api/practice/deadlines', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            var d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Save failed');

            PracticeAPI.showToast('Deadline created');
            closeSuggestionModal();
        } catch(err) {
            PracticeAPI.showToast('Error: ' + err.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Create Deadline';
        }
        return false;
    }

    function closeSuggestionModal() {
        document.getElementById('suggestionDeadlineModal').classList.remove('show');
    }

    // ── Expose globals ─────────────────────────────────────────────────────────

    window.saveClientDetail            = saveClientDetail;
    window.archiveClient               = archiveClient;
    window.toggleIndividualFields      = toggleIndividualFields;
    window.togglePostalAddress         = togglePostalAddress;
    window.openContactModal            = openContactModal;
    window.closeContactModal           = closeContactModal;
    window.saveContact                 = saveContact;
    window.deactivateContact           = deactivateContact;
    window._openContactModal           = _openContactModal;
    window.loadComplianceSuggestions   = loadComplianceSuggestions;
    window.openSuggestionDeadlineModal = openSuggestionDeadlineModal;
    window.saveSuggestionDeadline      = saveSuggestionDeadline;
    window.closeSuggestionModal        = closeSuggestionModal;

    init();
})();
