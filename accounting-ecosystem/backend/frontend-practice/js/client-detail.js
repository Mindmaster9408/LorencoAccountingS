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
            document.getElementById('engagementsSection').classList.remove('hidden');
            document.getElementById('healthSection').classList.remove('hidden');
            document.getElementById('communicationsSection').classList.remove('hidden');
            document.getElementById('docRequestsSection').classList.remove('hidden');
            document.getElementById('compliancePacksSection').classList.remove('hidden');
            document.getElementById('taxpayerProfilesSection').classList.remove('hidden');
            document.getElementById('provisionalTaxSection').classList.remove('hidden');
            document.getElementById('individualTaxSection').classList.remove('hidden');
            document.getElementById('companyTaxSection').classList.remove('hidden');
            document.getElementById('archiveBtn').classList.remove('hidden');
            var commLink = document.getElementById('commViewAllLink');
            if (commLink) commLink.href = '/practice/communications.html?client_id=' + clientId;
            var docLink = document.getElementById('docReqViewAllLink');
            if (docLink) docLink.href = '/practice/document-requests.html?client_id=' + clientId;
            var cpLink = document.getElementById('cpViewAllLink');
            if (cpLink) cpLink.href = '/practice/compliance-packs.html?client_id=' + clientId;
            var tpLink = document.getElementById('tpViewAllLink');
            if (tpLink) tpLink.href = '/practice/taxpayer-profiles.html?client_id=' + clientId;
            var ptLink = document.getElementById('ptViewAllLink');
            if (ptLink) ptLink.href = '/practice/provisional-tax.html?client_id=' + clientId;
            var itLink = document.getElementById('itViewAllLink');
            if (itLink) itLink.href = '/practice/individual-tax.html?client_id=' + clientId;
            var ctLink = document.getElementById('ctViewAllLink');
            if (ctLink) ctLink.href = '/practice/company-tax.html?client_id=' + clientId;
            loadContacts();
            loadEngagements();
            loadClientHealth();
            loadClientCommunications();
            loadClientDocumentRequests();
            loadClientCompliancePacks();
            loadClientTaxpayerProfiles();
            loadClientProvisionalTaxPlans();
            loadClientIndividualTaxReturns();
            loadClientCompanyTaxReturns();
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
        var subtitleParts = [typeLabel[c.client_type] || ''];
        if (c.client_code) subtitleParts.push(c.client_code);
        document.getElementById('pageSubtitle').textContent = subtitleParts.filter(Boolean).join(' · ');

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

        setVal('dVatPaySeq',           c.vat_payment_sequence || '');
        setVal('dVatSubmissionMonth',  c.vat_last_submission_month ? String(c.vat_last_submission_month) : '');
        setVal('dCoidaRef',            c.coida_registration_number);
        setVal('dCoidaDueMonth',       c.coida_due_month ? String(c.coida_due_month) : '');

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

            vat_payment_sequence:      document.getElementById('dVatPaySeq').value || null,
            vat_last_submission_month: (function() { var v = document.getElementById('dVatSubmissionMonth').value; return v ? parseInt(v) : null; })(),
            coida_registration_number: document.getElementById('dCoidaRef').value.trim() || null,
            coida_due_month:           (function() { var v = document.getElementById('dCoidaDueMonth').value; return v ? parseInt(v) : null; })(),

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

    // ── Client Engagements ─────────────────────────────────────────────────────

    var _editingEngagementId = null;
    var _engTeamLoaded       = false;

    var ENG_CATEGORY_LABELS = {
        vat: 'VAT', paye: 'PAYE', emp501: 'EMP501', income_tax: 'Income Tax',
        annual_financials: 'Annual Financials', bookkeeping: 'Bookkeeping',
        payroll: 'Payroll', secretarial: 'Secretarial', consulting: 'Consulting',
        cipc: 'CIPC', other: 'Other'
    };

    var ENG_FREQ_LABELS = {
        monthly: 'Monthly', quarterly: 'Quarterly', biannual: 'Biannual',
        annual: 'Annual', once_off: 'Once-off', per_hour: 'Per Hour'
    };

    var ENG_EVENT_LABELS = {
        engagement_created:                 'Engagement Created',
        engagement_updated:                 'Engagement Updated',
        engagement_paused:                  'Paused',
        engagement_reactivated:             'Reactivated',
        engagement_ended:                   'Ended',
        engagement_cancelled:               'Cancelled',
        status_changed:                     'Status Changed',
        workflow_generated_from_engagement: 'Workflow Generated',
        workflow_generation_failed:         'Workflow Generation Failed'
    };

    async function loadEngagements() {
        document.getElementById('engagementsWrap').innerHTML =
            '<div class="loading"><div class="loading-spinner"></div><p>Loading engagements…</p></div>';
        try {
            var res = await PracticeAPI.fetch('/api/practice/clients/' + clientId + '/engagements');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            renderEngagements(d.engagements || []);
        } catch(e) {
            document.getElementById('engagementsWrap').innerHTML =
                '<div class="error-banner">⚠️ Failed to load engagements.</div>';
        }
    }

    function renderEngagements(engagements) {
        var wrap = document.getElementById('engagementsWrap');
        if (!engagements.length) {
            wrap.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><h3>No engagements</h3><p>Add service engagements to track what this client is signed up for.</p></div>';
            return;
        }

        var cards = engagements.map(function(e) {
            var catLabel  = ENG_CATEGORY_LABELS[e.service_category] || e.service_category;
            var catClass  = 'cat-' + (e.service_category || 'other');
            var feeStr    = '';
            if (e.fee_amount != null) {
                feeStr = 'R ' + Number(e.fee_amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                if (e.fee_frequency) feeStr += ' / ' + (ENG_FREQ_LABELS[e.fee_frequency] || e.fee_frequency);
            }
            var statusClass  = 'badge-eng-' + (e.status || 'active');
            var statusLabel  = (e.status || 'active').charAt(0).toUpperCase() + (e.status || 'active').slice(1);
            var dateStr      = e.start_date ? 'From ' + new Date(e.start_date).toLocaleDateString('en-ZA') : '';
            if (e.end_date) dateStr += (dateStr ? ' to ' : 'Until ') + new Date(e.end_date).toLocaleDateString('en-ZA');

            return '<div class="engagement-card">' +
                '<div class="engagement-card-body">' +
                    '<div class="engagement-card-name">' +
                        esc(e.engagement_name) +
                        ' <span class="badge ' + statusClass + '" style="font-size:0.72rem;margin-left:6px">' + esc(statusLabel) + '</span>' +
                    '</div>' +
                    '<div class="engagement-card-meta">' +
                        '<span class="cat-dot ' + catClass + '"></span>' + esc(catLabel) +
                        (dateStr ? ' · <span class="col-muted">' + esc(dateStr) + '</span>' : '') +
                    '</div>' +
                    (feeStr ? '<div class="engagement-card-fee">' + esc(feeStr) + '</div>' : '') +
                '</div>' +
                '<div class="engagement-card-actions">' +
                    (e.status === 'active' && e.workflow_template_id ? '<button type="button" class="btn btn-primary btn-sm" onclick="openGenerateModal(' + e.id + ')">⚡ Generate</button>' : '') +
                    (e.status === 'active' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="openPeriodQueueModal(' + e.id + ')">📅 Periods</button>' : '') +
                    '<a href="/practice/engagement-periods.html?engagement_id=' + e.id + '&client_id=' + e.client_id + '" class="btn btn-ghost btn-sm">Queue</a>' +
                    (e.status === 'active' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="engagementAction(' + e.id + ',\'pause\')">Pause</button>' : '') +
                    (e.status === 'paused' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="engagementAction(' + e.id + ',\'reactivate\')">Reactivate</button>' : '') +
                    (e.status !== 'cancelled' && e.status !== 'ended' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="openEngHistoryModal(' + e.id + ')">History</button>' : '') +
                    '<button type="button" class="btn btn-ghost btn-sm" onclick="window._openEngagementModal(' + e.id + ')">Edit</button>' +
                '</div>' +
            '</div>';
        }).join('');

        wrap.innerHTML = cards;
    }

    async function _populateEngTeam() {
        if (_engTeamLoaded) return;
        try {
            var res = await PracticeAPI.fetch('/api/practice/team?active=true');
            if (!res.ok) return;
            var d = await res.json();
            var opts = (d.members || []).map(function(m) {
                return '<option value="' + m.id + '">' + esc(m.display_name) +
                    (m.job_title ? ' — ' + esc(m.job_title) : '') + '</option>';
            }).join('');
            var stub = '<option value="">Not assigned</option>' + opts;
            ['eeResponsible', 'eeReviewer', 'eePartner'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.innerHTML = stub;
            });
            _engTeamLoaded = true;
        } catch(e) {}
    }

    async function _openEngagementModal(id) {
        _editingEngagementId = id || null;
        var eng = null;

        if (id) {
            try {
                var res = await PracticeAPI.fetch('/api/practice/engagements/' + id);
                if (res.ok) { var d = await res.json(); eng = d.engagement || null; }
            } catch(e) {}
        }

        document.getElementById('engModalTitle').textContent = id ? 'Edit Engagement' : 'Add Engagement';
        document.getElementById('eeName').value       = eng ? (eng.engagement_name   || '') : '';
        document.getElementById('eeCategory').value   = eng ? (eng.service_category  || '') : '';
        document.getElementById('eeBillingType').value = eng ? (eng.billing_type     || 'fixed') : 'fixed';
        document.getElementById('eeFeeAmount').value  = eng && eng.fee_amount != null ? eng.fee_amount : '';
        document.getElementById('eeFeeFreq').value    = eng ? (eng.fee_frequency     || 'monthly') : 'monthly';
        document.getElementById('eeStartDate').value  = eng ? (eng.start_date || '') : '';
        document.getElementById('eeEndDate').value    = eng ? (eng.end_date   || '') : '';
        document.getElementById('eeCurrency').value   = eng ? (eng.currency   || 'ZAR') : 'ZAR';
        document.getElementById('eeDesc').value       = eng ? (eng.description || '') : '';
        document.getElementById('eeNotes').value      = eng ? (eng.notes || '') : '';

        document.getElementById('eeRecurrenceType').value      = eng ? (eng.recurrence_type       || '') : '';
        document.getElementById('eeRecurrenceStartDate').value = eng ? (eng.recurrence_start_date || '') : '';
        document.getElementById('eeRecurrenceEndDate').value   = eng ? (eng.recurrence_end_date   || '') : '';
        document.getElementById('eeRecurrenceDay').value       = eng && eng.recurrence_day   != null ? eng.recurrence_day   : '';
        document.getElementById('eeRecurrenceMonth').value     = eng && eng.recurrence_month != null ? eng.recurrence_month : '';
        document.getElementById('eeRecurrenceNotes').value     = eng ? (eng.recurrence_notes || '') : '';
        toggleRecurrenceFields();

        await _populateEngTeam();

        var setTeamSel = function(elId, val) {
            var el = document.getElementById(elId);
            if (el && val) el.value = val;
        };
        if (eng) {
            setTeamSel('eeResponsible', eng.responsible_team_member_id);
            setTeamSel('eeReviewer',    eng.reviewer_team_member_id);
            setTeamSel('eePartner',     eng.partner_team_member_id);
        } else {
            ['eeResponsible', 'eeReviewer', 'eePartner'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
        }

        document.getElementById('engagementModal').classList.add('show');
    }

    function openEngagementModal() { _openEngagementModal(null); }

    function closeEngagementModal() {
        document.getElementById('engagementModal').classList.remove('show');
    }

    function toggleRecurrenceFields() {
        var type = document.getElementById('eeRecurrenceType').value;
        var showDay   = (type === 'monthly' || type === 'annual');
        var showMonth = (type === 'annual');
        document.getElementById('eeRecurrenceDayWrap').classList.toggle('hidden', !showDay);
        document.getElementById('eeRecurrenceMonthWrap').classList.toggle('hidden', !showMonth);
    }

    async function saveEngagement(e) {
        e.preventDefault();
        var btn = document.getElementById('eeSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…';

        var feeRaw = document.getElementById('eeFeeAmount').value.trim();
        var body = {
            engagement_name:            document.getElementById('eeName').value.trim(),
            service_category:           document.getElementById('eeCategory').value,
            billing_type:               document.getElementById('eeBillingType').value,
            fee_amount:                 feeRaw ? parseFloat(feeRaw) : null,
            fee_frequency:              document.getElementById('eeFeeFreq').value,
            start_date:                 document.getElementById('eeStartDate').value  || null,
            end_date:                   document.getElementById('eeEndDate').value    || null,
            currency:                   document.getElementById('eeCurrency').value,
            description:                document.getElementById('eeDesc').value.trim()  || null,
            notes:                      document.getElementById('eeNotes').value.trim() || null,
            responsible_team_member_id: document.getElementById('eeResponsible').value || null,
            reviewer_team_member_id:    document.getElementById('eeReviewer').value    || null,
            partner_team_member_id:     document.getElementById('eePartner').value      || null,
            recurrence_type:            document.getElementById('eeRecurrenceType').value      || null,
            recurrence_start_date:      document.getElementById('eeRecurrenceStartDate').value || null,
            recurrence_end_date:        document.getElementById('eeRecurrenceEndDate').value   || null,
            recurrence_day:             document.getElementById('eeRecurrenceDay').value   ? parseInt(document.getElementById('eeRecurrenceDay').value)   : null,
            recurrence_month:           document.getElementById('eeRecurrenceMonth').value ? parseInt(document.getElementById('eeRecurrenceMonth').value) : null,
            recurrence_notes:           document.getElementById('eeRecurrenceNotes').value.trim() || null
        };

        try {
            var url, method;
            if (_editingEngagementId) {
                url    = '/api/practice/engagements/' + _editingEngagementId;
                method = 'PUT';
            } else {
                url    = '/api/practice/clients/' + clientId + '/engagements';
                method = 'POST';
            }
            var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
            var d   = await res.json();
            if (!res.ok) throw new Error(d.error || 'Save failed');
            closeEngagementModal();
            PracticeAPI.showToast(_editingEngagementId ? 'Engagement updated!' : 'Engagement added!');
            loadEngagements();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Save Engagement';
        }
        return false;
    }

    async function engagementAction(id, action) {
        var labels = { pause: 'Pause', reactivate: 'Reactivate', end: 'End', cancel: 'Cancel' };
        if (!confirm(labels[action] + ' this engagement?')) return;
        try {
            var res;
            if (action === 'cancel') {
                res = await PracticeAPI.fetch('/api/practice/engagements/' + id, { method: 'DELETE' });
            } else {
                res = await PracticeAPI.fetch('/api/practice/engagements/' + id + '/' + action, { method: 'PUT', body: '{}' });
            }
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || action + ' failed');
            PracticeAPI.showToast('Engagement ' + action + 'd.');
            loadEngagements();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        }
    }

    async function openEngHistoryModal(id) {
        document.getElementById('engHistoryTitle').textContent = 'Engagement History';
        document.getElementById('engHistoryList').innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading…</p></div>';
        document.getElementById('engHistoryModal').classList.add('show');
        try {
            var res = await PracticeAPI.fetch('/api/practice/engagements/' + id + '/history');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            if (d.engagement_name) document.getElementById('engHistoryTitle').textContent = d.engagement_name + ' — History';
            renderEngHistory(d.events || []);
        } catch(err) {
            document.getElementById('engHistoryList').innerHTML = '<div class="error-banner">⚠️ Failed to load history.</div>';
        }
    }

    function renderEngHistory(events) {
        var el = document.getElementById('engHistoryList');
        if (!events.length) {
            el.innerHTML = '<div class="empty"><p>No history events yet.</p></div>';
            return;
        }
        el.innerHTML = events.map(function(ev) {
            var typeLabel   = ENG_EVENT_LABELS[ev.event_type] || ev.event_type;
            var statusPart  = (ev.old_status && ev.new_status)
                ? ev.old_status + ' → ' + ev.new_status
                : (ev.new_status || '');
            var ts = ev.created_at ? new Date(ev.created_at).toLocaleString('en-ZA') : '';
            var actor = ev.actor_user_id ? 'User ' + ev.actor_user_id : '';
            return '<div class="eng-event">' +
                '<div class="eng-event-type">' + esc(typeLabel) + '</div>' +
                (statusPart ? '<div class="eng-event-status">' + esc(statusPart) + '</div>' : '') +
                (ev.notes   ? '<div class="eng-event-meta" style="color:var(--text);margin-top:2px;">' + esc(ev.notes) + '</div>' : '') +
                '<div class="eng-event-meta">' + [ts, actor].filter(Boolean).join(' · ') + '</div>' +
            '</div>';
        }).join('');
    }

    function closeEngHistoryModal() {
        document.getElementById('engHistoryModal').classList.remove('show');
    }

    // ── Generate workflow from engagement ──────────────────────────────────────

    var _generateEngagementId = null;
    var _generatePreviewData  = null;

    async function openGenerateModal(engId) {
        _generateEngagementId = engId;
        _generatePreviewData  = null;

        // Reset state
        document.getElementById('genModalTitle').textContent = 'Generate Workflow';
        document.getElementById('genPreviewLoading').classList.remove('hidden');
        document.getElementById('genPreviewError').classList.add('hidden');
        document.getElementById('genPreviewContent').classList.add('hidden');
        document.getElementById('genResultPanel').classList.add('hidden');
        document.getElementById('genResultPanel').innerHTML = '';
        document.getElementById('generateWorkflowForm').classList.remove('hidden');
        document.getElementById('genSubmitBtn').disabled = true;
        document.getElementById('genSubmitBtn').textContent = 'Generate Workflow';

        // Reset form fields
        ['genAnchorDate','genDueDate','genPeriodStart','genPeriodEnd','genDeadlineTitle','genNotes'].forEach(function(id) {
            document.getElementById(id).value = '';
        });
        document.getElementById('genCreateDeadline').checked = false;
        document.getElementById('genDeadlineTitleWrap').classList.add('hidden');

        document.getElementById('generateWorkflowModal').classList.add('show');

        try {
            var res = await PracticeAPI.fetch('/api/practice/engagements/' + engId + '/generation-preview');
            if (!res.ok) throw new Error('Preview failed');
            var d = await res.json();
            _generatePreviewData = d;
            _renderGeneratePreview(d);
            document.getElementById('genPreviewLoading').classList.add('hidden');
            document.getElementById('genPreviewContent').classList.remove('hidden');
            if (d.can_generate) document.getElementById('genSubmitBtn').disabled = false;
        } catch (e) {
            document.getElementById('genPreviewLoading').classList.add('hidden');
            document.getElementById('genPreviewError').classList.remove('hidden');
        }
    }

    function _renderGeneratePreview(d) {
        var eng      = d.engagement || {};
        var template = d.template   || null;
        var client   = d.client     || null;

        var lastGenText = eng.last_generated_at
            ? 'Last generated: ' + new Date(eng.last_generated_at).toLocaleDateString('en-ZA') +
              (eng.generation_count > 1 ? ' (' + eng.generation_count + ' runs total)' : '')
            : 'Never generated from this engagement';

        var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;">';
        html += '<div><div class="col-muted" style="font-size:0.72rem;margin-bottom:2px">Engagement</div>' +
                '<div style="font-size:0.85rem">' + esc(eng.engagement_name || '') + '</div></div>';
        html += '<div><div class="col-muted" style="font-size:0.72rem;margin-bottom:2px">Client</div>' +
                '<div style="font-size:0.85rem">' + esc((client && client.name) || '—') + '</div></div>';
        html += '<div><div class="col-muted" style="font-size:0.72rem;margin-bottom:2px">Workflow Template</div>' +
                '<div style="font-size:0.85rem">' +
                (template ? esc(template.name) : '<span class="col-muted">None linked</span>') +
                '</div></div>';
        html += '<div><div class="col-muted" style="font-size:0.72rem;margin-bottom:2px">Expected Tasks</div>' +
                '<div style="font-size:0.85rem;font-weight:600">' + (d.expected_task_count || 0) + '</div></div>';
        if (d.compliance_area || d.deadline_type) {
            html += '<div><div class="col-muted" style="font-size:0.72rem;margin-bottom:2px">Compliance Area</div>' +
                    '<div style="font-size:0.85rem">' + esc(d.compliance_area || '—') + '</div></div>';
            html += '<div><div class="col-muted" style="font-size:0.72rem;margin-bottom:2px">Deadline Type</div>' +
                    '<div style="font-size:0.85rem">' + esc(d.deadline_type || '—') + '</div></div>';
        }
        html += '<div style="grid-column:1/-1"><div class="col-muted" style="font-size:0.72rem">' + esc(lastGenText) + '</div></div>';
        html += '</div>';

        if (d.will_create_deadline) {
            html += '<div style="margin-top:10px;padding:8px 12px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:6px;font-size:0.78rem;color:var(--success,#6ee7b7)">' +
                    'Template is configured to also create a compliance deadline.' +
                    '</div>';
            document.getElementById('genCreateDeadline').checked = true;
            document.getElementById('genDeadlineTitleWrap').classList.remove('hidden');
        }

        if (!d.can_generate) {
            var why = !eng.workflow_template_id ? 'No workflow template is linked to this engagement.'
                    : eng.status !== 'active'   ? 'Engagement is not active (' + eng.status + ').'
                    : !template                 ? 'Linked workflow template not found or access denied.'
                    : 'Cannot generate.';
            html += '<div class="error-banner" style="margin-top:10px">⚠️ ' + esc(why) + '</div>';
        }

        document.getElementById('genPreviewInfo').innerHTML = html;
    }

    function toggleGenDeadlineTitle() {
        var wrap = document.getElementById('genDeadlineTitleWrap');
        if (document.getElementById('genCreateDeadline').checked) wrap.classList.remove('hidden');
        else wrap.classList.add('hidden');
    }

    function closeGenerateModal() {
        document.getElementById('generateWorkflowModal').classList.remove('show');
    }

    async function submitGenerateWorkflow(e) {
        e.preventDefault();
        if (!_generateEngagementId) return false;

        var btn = document.getElementById('genSubmitBtn');
        btn.disabled = true;
        btn.textContent = 'Generating…';

        var body = {
            anchor_date:     document.getElementById('genAnchorDate').value   || null,
            due_date:        document.getElementById('genDueDate').value       || null,
            period_start:    document.getElementById('genPeriodStart').value   || null,
            period_end:      document.getElementById('genPeriodEnd').value     || null,
            create_deadline: document.getElementById('genCreateDeadline').checked,
            deadline_title:  document.getElementById('genDeadlineTitle').value.trim() || null,
            notes:           document.getElementById('genNotes').value.trim()  || null
        };

        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/engagements/' + _generateEngagementId + '/generate-workflow',
                { method: 'POST', body: JSON.stringify(body) }
            );
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Generation failed');

            // Hide form, show result panel
            document.getElementById('generateWorkflowForm').classList.add('hidden');
            var panel = document.getElementById('genResultPanel');
            panel.classList.remove('hidden');
            panel.innerHTML =
                '<div style="text-align:center;padding:24px 16px;">' +
                    '<div style="font-size:2rem;margin-bottom:10px">✅</div>' +
                    '<div style="font-weight:600;font-size:1rem;margin-bottom:6px">Workflow Generated</div>' +
                    '<div class="col-muted" style="font-size:0.84rem;margin-bottom:4px">' +
                        d.task_count + ' task' + (d.task_count !== 1 ? 's' : '') + ' created' +
                        (d.deadline_id ? ' · Compliance deadline #' + d.deadline_id + ' created' : '') +
                    '</div>' +
                    '<div class="col-muted" style="font-size:0.78rem">Workflow Run #' + d.workflow_run_id + ' · Generation #' + d.generation_count + '</div>' +
                    (d.warning ? '<div class="error-banner" style="margin-top:14px;text-align:left">⚠️ Partial success: ' + esc(d.warning) + '</div>' : '') +
                '</div>' +
                '<div style="text-align:center;margin-top:6px;">' +
                    '<button type="button" class="btn btn-ghost" onclick="closeGenerateModal()">Close</button>' +
                '</div>';

            PracticeAPI.showToast('✅ Workflow generated — ' + d.task_count + ' tasks created!');
            loadEngagements();

        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Generate Workflow';
            PracticeAPI.showToast('❌ ' + err.message, true);
        }
        return false;
    }

    // ── Generate Periods Modal (Codebox 16 — Period Queue) ────────────────────

    var _periodQueueEngId    = null;
    var _periodQueuePreview  = null;
    var _periodQueueSubmitting = false;

    async function openPeriodQueueModal(engId) {
        _periodQueueEngId   = engId;
        _periodQueuePreview = null;
        _periodQueueSubmitting = false;

        var modal = document.getElementById('periodQueueModal');
        if (!modal) return;

        document.getElementById('pqFromDate').value   = '';
        document.getElementById('pqToDate').value     = '';
        document.getElementById('pqMaxPeriods').value = '12';
        document.getElementById('pqPreviewWrap').innerHTML = '';
        document.getElementById('pqCreateBtn').disabled    = true;
        document.getElementById('pqPreviewBtn').disabled   = false;

        modal.classList.add('show');
    }

    function closePeriodQueueModal() {
        var modal = document.getElementById('periodQueueModal');
        if (modal) modal.classList.remove('show');
    }

    async function previewPeriods() {
        if (!_periodQueueEngId) return;
        var fromDate = document.getElementById('pqFromDate').value;
        var toDate   = document.getElementById('pqToDate').value;
        var maxP     = parseInt(document.getElementById('pqMaxPeriods').value) || 12;

        if (!fromDate || !toDate) {
            PracticeAPI.showToast('❌ Please enter both From Date and To Date', true);
            return;
        }

        document.getElementById('pqPreviewWrap').innerHTML =
            '<div class="loading"><div class="loading-spinner"></div><p>Previewing periods…</p></div>';
        document.getElementById('pqCreateBtn').disabled  = true;
        document.getElementById('pqPreviewBtn').disabled = true;

        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/engagements/' + _periodQueueEngId + '/periods/generate-preview',
                { method: 'POST', body: JSON.stringify({ from_date: fromDate, to_date: toDate, max_periods: maxP }) }
            );
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Preview failed');

            _periodQueuePreview = d;
            renderPeriodPreview(d);
            document.getElementById('pqCreateBtn').disabled  = !d.can_create;
        } catch(err) {
            document.getElementById('pqPreviewWrap').innerHTML =
                '<div class="error-banner">⚠️ ' + esc(err.message) + '</div>';
        } finally {
            document.getElementById('pqPreviewBtn').disabled = false;
        }
    }

    function renderPeriodPreview(d) {
        var wrap = document.getElementById('pqPreviewWrap');
        var html = '';

        if (d.warnings && d.warnings.length) {
            html += '<div style="padding:8px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);border-radius:6px;font-size:0.78rem;color:var(--warning);margin-bottom:10px">' +
                d.warnings.map(function(w) { return esc(w); }).join('<br>') + '</div>';
        }

        if (d.duplicates && d.duplicates.length) {
            html += '<div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:6px">' +
                d.duplicates.length + ' period(s) already exist and will be skipped:</div>';
            html += '<div style="font-size:0.77rem;color:var(--text-muted);margin-bottom:10px;padding-left:8px;">' +
                d.duplicates.map(function(p) { return '· ' + esc(p.period_label); }).join('<br>') +
                '</div>';
        }

        if (!d.periods || !d.periods.length) {
            html += '<div class="empty"><p>No new periods to create for the selected range.</p></div>';
        } else {
            html += '<div style="font-size:0.82rem;font-weight:600;margin-bottom:8px;color:rgba(255,255,255,0.7)">' +
                d.periods.length + ' period(s) will be queued:</div>';
            html += '<div style="display:flex;flex-direction:column;gap:4px;">';
            d.periods.forEach(function(p) {
                html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;' +
                    'background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:0.8rem;">' +
                    '<span style="font-weight:600">' + esc(p.period_label) + '</span>' +
                    '<span class="col-muted">' + esc(p.period_start) + ' – ' + esc(p.period_end) + '</span>' +
                    '</div>';
            });
            html += '</div>';
        }

        wrap.innerHTML = html;
    }

    async function createPeriodQueue() {
        if (!_periodQueueEngId || !_periodQueuePreview || _periodQueueSubmitting) return;
        if (!_periodQueuePreview.can_create) return;

        _periodQueueSubmitting = true;
        var btn = document.getElementById('pqCreateBtn');
        btn.disabled = true; btn.textContent = 'Creating…';

        var fromDate = document.getElementById('pqFromDate').value;
        var toDate   = document.getElementById('pqToDate').value;
        var maxP     = parseInt(document.getElementById('pqMaxPeriods').value) || 12;

        try {
            var res = await PracticeAPI.fetch(
                '/api/practice/engagements/' + _periodQueueEngId + '/periods/generate',
                { method: 'POST', body: JSON.stringify({ from_date: fromDate, to_date: toDate, max_periods: maxP }) }
            );
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Create failed');

            closePeriodQueueModal();
            PracticeAPI.showToast('✅ ' + d.created + ' period(s) queued!');
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
            btn.disabled = false; btn.textContent = 'Create Queue';
        } finally {
            _periodQueueSubmitting = false;
        }
    }

    // ── Client Health ──────────────────────────────────────────────────────────

    async function loadClientHealth() {
        var wrap = document.getElementById('healthWrap');
        if (!wrap) return;
        try {
            var res = await PracticeAPI.fetch('/api/practice/client-health/' + clientId);
            if (!res.ok) throw new Error('Health data unavailable');
            var d = await res.json();
            renderHealthCard(d);
        } catch(e) {
            wrap.innerHTML = '<p style="color:var(--muted);font-size:0.83rem;">' +
                esc(e.message || 'Health data unavailable') + ' — ' +
                '<button class="btn btn-xs btn-ghost" onclick="recalcClientHealth()">Recalculate now</button></p>';
        }
    }

    function renderHealthCard(d) {
        var wrap = document.getElementById('healthWrap');
        if (!wrap) return;
        var st    = d.health_status || 'unknown';
        var score = d.health_score != null ? d.health_score : '—';
        var stLabel = { good:'Good', watch:'Watch', at_risk:'At Risk', critical:'Critical', unknown:'Unknown' }[st] || st;
        var risks = (d.top_risks || []).slice(0, 3);
        var snap  = d.last_snapshot;
        var calcAt = snap ? 'Last calculated: ' + fmtDate(snap.calculated_at) : 'Not yet calculated — click Recalculate';

        var riskHtml = risks.length
            ? risks.map(function(r) {
                return '<div class="health-card-risk-item">' +
                    '<div class="health-dot d-critical"></div>' +
                    '<span>' + esc(r) + '</span>' +
                '</div>';
              }).join('')
            : '<span style="color:var(--muted);font-size:0.82rem;">No risk factors identified</span>';

        wrap.innerHTML =
            '<div class="health-card">' +
                '<div class="health-card-score">' +
                    '<div class="health-card-score-num c-' + st + '">' + score + '</div>' +
                    '<span class="health-badge hb-' + st + '">' + esc(stLabel) + '</span>' +
                '</div>' +
                '<div class="health-card-risks">' + riskHtml + '</div>' +
            '</div>' +
            '<div class="health-card-calc">' + esc(calcAt) + '</div>';
    }

    async function recalcClientHealth() {
        var btn = document.getElementById('healthRecalcBtn');
        if (btn) { btn.textContent = 'Recalculating…'; btn.disabled = true; }
        try {
            var res = await PracticeAPI.fetch('/api/practice/client-health/recalculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: clientId }),
            });
            if (!res.ok) throw new Error('Recalculation failed');
            await loadClientHealth();
        } catch(e) {
            alert(e.message || 'Recalculation failed');
        } finally {
            if (btn) { btn.textContent = 'Recalculate'; btn.disabled = false; }
        }
    }

    // ── Communication History (Section 15) ────────────────────────────────────

    var _cdCommSubmitting = false;

    var _commTypeIcon = {
        call: '📞', email_note: '📧', whatsapp_note: '💬', meeting: '🤝',
        document_request: '📄', sars_followup: '🏛', cipc_followup: '🏢',
        billing_followup: '💰', general_note: '📝', internal_note: '🔒',
    };
    var _commRespClass = {
        not_required: 'crsp-none', waiting: 'crsp-waiting',
        received: 'crsp-received', overdue: 'crsp-overdue', cancelled: 'crsp-cancelled',
    };

    async function loadClientCommunications() {
        var loading = document.getElementById('commHistoryLoading');
        var wrap    = document.getElementById('commHistoryWrap');
        var empty   = document.getElementById('commHistoryEmpty');
        if (loading) loading.classList.remove('hidden');
        if (wrap)    wrap.classList.add('hidden');
        if (empty)   empty.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch('/api/practice/communications?client_id=' + clientId + '&limit=10');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            var comms = d.communications || [];
            if (loading) loading.classList.add('hidden');
            if (comms.length === 0) {
                if (empty) empty.classList.remove('hidden');
            } else {
                renderCommHistory(comms);
                if (wrap) wrap.classList.remove('hidden');
            }
        } catch(e) {
            if (loading) loading.classList.add('hidden');
            if (wrap) { wrap.innerHTML = '<div class="error-banner">Could not load communication history.</div>'; wrap.classList.remove('hidden'); }
        }
    }

    function renderCommHistory(comms) {
        var wrap = document.getElementById('commHistoryWrap');
        if (!wrap) return;
        var today = new Date().toISOString().split('T')[0];

        var rows = comms.map(function(c) {
            var icon     = _commTypeIcon[c.communication_type] || '📋';
            var eff      = (c.effective_response_status || c.response_status || 'not_required');
            var isOverdue = eff === 'overdue' || (c.response_status === 'waiting' && c.response_due_date && c.response_due_date < today);
            if (isOverdue) eff = 'overdue';
            var respCls  = _commRespClass[eff] || '';
            var rowCls   = isOverdue ? 'comm-hist-row comm-row--overdue' : 'comm-hist-row';
            var dateStr  = c.communication_date ? c.communication_date.slice(0, 10) : '';

            var respHtml = '';
            if (c.response_required) {
                var respLabel = eff === 'waiting' ? 'Waiting' : eff === 'overdue' ? 'Overdue' : eff === 'received' ? 'Received' : eff;
                respHtml = '<span class="comm-resp-badge ' + respCls + '">' + esc(respLabel) + '</span>';
                if (eff === 'waiting' || eff === 'overdue') {
                    respHtml += ' <button type="button" class="btn btn-xs btn-ghost" onclick="markCommResponded(' + c.id + ')">✓</button>';
                }
            }

            return '<div class="' + rowCls + '">' +
                '<div class="comm-hist-icon">' + icon + '</div>' +
                '<div class="comm-hist-body">' +
                    '<div class="comm-hist-subject">' + esc(c.subject) + '</div>' +
                    (c.contact_name ? '<div class="comm-hist-contact">' + esc(c.contact_name) + '</div>' : '') +
                '</div>' +
                '<div class="comm-hist-meta">' +
                    '<div class="comm-hist-date">' + esc(dateStr) + '</div>' +
                    respHtml +
                '</div>' +
            '</div>';
        });

        wrap.innerHTML = rows.join('');
    }

    async function openAddCommModal() {
        document.getElementById('addCommType').value      = 'call';
        document.getElementById('addCommDirection').value = 'outbound';
        document.getElementById('addCommSubject').value   = '';
        document.getElementById('addCommBody').value      = '';
        document.getElementById('addCommContact').value   = '';
        document.getElementById('addCommRespReq').checked = false;
        document.getElementById('addCommRespDue').value   = '';
        document.getElementById('addCommRespDueRow').classList.add('hidden');
        document.getElementById('addCommError').classList.add('hidden');
        _cdCommSubmitting = false;
        document.getElementById('addCommSubmitBtn').disabled = false;

        // Populate assignee picker
        try {
            var res = await PracticeAPI.fetch('/api/practice/team?active=true');
            var members = [];
            if (res.ok) { var td = await res.json(); members = td.members || []; }
            var opts = '<option value="">Unassigned</option>';
            members.forEach(function(m) {
                opts += '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
            });
            document.getElementById('addCommAssignee').innerHTML = opts;
        } catch(e) {
            document.getElementById('addCommAssignee').innerHTML = '<option value="">Unassigned</option>';
        }

        document.getElementById('addCommModal').classList.remove('hidden');
    }

    function closeAddCommModal() {
        document.getElementById('addCommModal').classList.add('hidden');
    }

    function toggleAddCommResponseDate() {
        var checked = document.getElementById('addCommRespReq') && document.getElementById('addCommRespReq').checked;
        var row     = document.getElementById('addCommRespDueRow');
        if (row) {
            if (checked) row.classList.remove('hidden');
            else         row.classList.add('hidden');
        }
    }

    async function submitAddComm() {
        if (_cdCommSubmitting) return;
        var subject = document.getElementById('addCommSubject').value.trim();
        if (!subject) {
            document.getElementById('addCommError').textContent = 'Subject is required.';
            document.getElementById('addCommError').classList.remove('hidden');
            return;
        }
        _cdCommSubmitting = true;
        document.getElementById('addCommSubmitBtn').disabled = true;
        document.getElementById('addCommError').classList.add('hidden');

        var assigneeEl = document.getElementById('addCommAssignee');
        var respDueEl  = document.getElementById('addCommRespDue');
        var payload    = {
            client_id:               clientId,
            communication_type:      document.getElementById('addCommType').value,
            direction:               document.getElementById('addCommDirection').value,
            subject:                 subject,
            body:                    document.getElementById('addCommBody').value.trim() || null,
            contact_name:            document.getElementById('addCommContact').value.trim() || null,
            assigned_team_member_id: assigneeEl && assigneeEl.value ? parseInt(assigneeEl.value, 10) : null,
            response_required:       document.getElementById('addCommRespReq').checked,
            response_due_date:       respDueEl && respDueEl.value ? respDueEl.value : null,
        };

        try {
            var res = await PracticeAPI.fetch('/api/practice/communications', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });
            if (!res.ok) {
                var err = await res.json();
                throw new Error(err.error || 'Failed to log communication');
            }
            _cdCommSubmitting = false;
            closeAddCommModal();
            loadClientCommunications();
        } catch(e) {
            _cdCommSubmitting = false;
            document.getElementById('addCommSubmitBtn').disabled = false;
            document.getElementById('addCommError').textContent = e.message || 'Failed to log communication.';
            document.getElementById('addCommError').classList.remove('hidden');
        }
    }

    async function markCommResponded(commId) {
        try {
            var res = await PracticeAPI.fetch('/api/practice/communications/' + commId + '/mark-responded', { method: 'PUT' });
            if (!res.ok) { var err = await res.json(); throw new Error(err.error || 'Failed'); }
            loadClientCommunications();
        } catch(e) {
            alert('Could not mark as received: ' + (e.message || 'Server error'));
        }
    }

    function fmtDate(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
        catch(e) { return iso; }
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

    window.openEngagementModal    = openEngagementModal;
    window.closeEngagementModal   = closeEngagementModal;
    window.toggleRecurrenceFields = toggleRecurrenceFields;
    window.saveEngagement         = saveEngagement;
    window.engagementAction       = engagementAction;
    window.openEngHistoryModal    = openEngHistoryModal;
    window.closeEngHistoryModal   = closeEngHistoryModal;
    window._openEngagementModal   = _openEngagementModal;

    window.openGenerateModal      = openGenerateModal;
    window.closeGenerateModal     = closeGenerateModal;
    window.submitGenerateWorkflow = submitGenerateWorkflow;
    window.toggleGenDeadlineTitle = toggleGenDeadlineTitle;

    window.openPeriodQueueModal  = openPeriodQueueModal;
    window.closePeriodQueueModal = closePeriodQueueModal;
    window.previewPeriods        = previewPeriods;
    window.createPeriodQueue     = createPeriodQueue;

    window.loadClientHealth   = loadClientHealth;
    window.recalcClientHealth = recalcClientHealth;

    // ── Document Requests (Section 16) ────────────────────────────────────────

    var _cdDocSubmitting = false;

    var _docCatLabel = {
        identity: 'Identity', tax: 'Tax', vat: 'VAT', payroll: 'Payroll',
        accounting: 'Accounting', banking: 'Banking', cipc: 'CIPC',
        trust: 'Trust', legal: 'Legal', compliance: 'Compliance',
        financials: 'Financials', supporting_docs: 'Supporting Docs', custom: 'Custom',
    };
    var _docStatusClass = {
        requested: 'drs-requested', reminder_sent: 'drs-reminder',
        partially_received: 'drs-partial', received: 'drs-received',
        waived: 'drs-waived',
    };
    var _docStatusLabel = {
        requested: 'Requested', reminder_sent: 'Reminder Sent',
        partially_received: 'Partial', received: 'Received', waived: 'Waived',
    };

    async function loadClientDocumentRequests() {
        var loading = document.getElementById('docreqHistoryLoading');
        var wrap    = document.getElementById('docreqHistoryWrap');
        var empty   = document.getElementById('docreqHistoryEmpty');
        if (loading) loading.classList.remove('hidden');
        if (wrap)    wrap.classList.add('hidden');
        if (empty)   empty.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch('/api/practice/document-requests?client_id=' + clientId + '&limit=10');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            var reqs = (d.document_requests || []).filter(function(r) {
                return r.request_status !== 'cancelled' && r.request_status !== 'received' && r.request_status !== 'waived';
            });
            if (loading) loading.classList.add('hidden');
            if (reqs.length === 0) {
                if (empty) empty.classList.remove('hidden');
            } else {
                renderDocRequestHistory(reqs);
                if (wrap) wrap.classList.remove('hidden');
            }
        } catch(e) {
            if (loading) loading.classList.add('hidden');
            if (wrap) { wrap.innerHTML = '<div class="error-banner">Could not load document requests.</div>'; wrap.classList.remove('hidden'); }
        }
    }

    function renderDocRequestHistory(reqs) {
        var wrap  = document.getElementById('docreqHistoryWrap');
        if (!wrap) return;
        var today = new Date().toISOString().split('T')[0];

        var rows = reqs.map(function(r) {
            var catLabel    = _docCatLabel[r.document_category]  || r.document_category;
            var statusCls   = _docStatusClass[r.request_status]  || '';
            var statusLabel = _docStatusLabel[r.request_status]  || r.request_status;
            var outstanding = ['requested', 'reminder_sent', 'partially_received'].includes(r.request_status);
            var isOverdue   = r.is_overdue || (outstanding && r.required_by_date && r.required_by_date < today);
            var rowCls      = isOverdue ? 'doc-hist-row docreq-row--overdue' : 'doc-hist-row';
            var dueStr      = r.required_by_date || '';

            var actionHtml = '';
            if (outstanding) {
                actionHtml = ' <button type="button" class="btn btn-xs btn-ghost" onclick="cdDocMarkReceived(' + r.id + ')">✓</button>';
            }

            return '<div class="' + rowCls + '">' +
                '<div class="doc-hist-body">' +
                    '<div class="doc-hist-title">' + esc(r.request_title) + '</div>' +
                    '<div class="doc-hist-cat">' + esc(catLabel) + (dueStr ? ' · Due ' + esc(dueStr) : '') + '</div>' +
                '</div>' +
                '<div class="doc-hist-meta">' +
                    '<span class="docreq-status-badge ' + statusCls + '">' + esc(statusLabel) + '</span>' +
                    actionHtml +
                '</div>' +
            '</div>';
        });
        wrap.innerHTML = rows.join('');
    }

    async function openAddDocModal() {
        document.getElementById('addDocCategory').value  = '';
        document.getElementById('addDocTitle').value     = '';
        document.getElementById('addDocType').value      = '';
        document.getElementById('addDocRequiredBy').value = '';
        document.getElementById('addDocError').classList.add('hidden');
        _cdDocSubmitting = false;
        document.getElementById('addDocSubmitBtn').disabled = false;

        // Populate assignee picker
        try {
            var res = await PracticeAPI.fetch('/api/practice/team?active=true');
            var members = [];
            if (res.ok) { var td = await res.json(); members = td.members || []; }
            var opts = '<option value="">Unassigned</option>';
            members.forEach(function(m) {
                opts += '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
            });
            document.getElementById('addDocAssignee').innerHTML = opts;
        } catch(e) {
            document.getElementById('addDocAssignee').innerHTML = '<option value="">Unassigned</option>';
        }

        document.getElementById('addDocModal').classList.remove('hidden');
    }

    function closeAddDocModal() {
        document.getElementById('addDocModal').classList.add('hidden');
    }

    async function submitAddDoc() {
        if (_cdDocSubmitting) return;
        var category = document.getElementById('addDocCategory').value;
        var title    = document.getElementById('addDocTitle').value.trim();
        var errEl    = document.getElementById('addDocError');

        if (!category) { errEl.textContent = 'Category is required.'; errEl.classList.remove('hidden'); return; }
        if (!title)    { errEl.textContent = 'Request title is required.'; errEl.classList.remove('hidden'); return; }

        _cdDocSubmitting = true;
        document.getElementById('addDocSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        var assigneeEl = document.getElementById('addDocAssignee');
        var payload = {
            client_id:              clientId,
            request_title:          title,
            document_category:      category,
            document_type:          document.getElementById('addDocType').value.trim() || null,
            required_by_date:       document.getElementById('addDocRequiredBy').value || null,
            assigned_team_member_id: assigneeEl && assigneeEl.value ? parseInt(assigneeEl.value, 10) : null,
        };

        try {
            var res = await PracticeAPI.fetch('/api/practice/document-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var e2 = await res.json(); throw new Error(e2.error || 'Failed'); }
            _cdDocSubmitting = false;
            closeAddDocModal();
            loadClientDocumentRequests();
        } catch(e) {
            _cdDocSubmitting = false;
            document.getElementById('addDocSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create request.';
            errEl.classList.remove('hidden');
        }
    }

    async function cdDocMarkReceived(reqId) {
        try {
            var res = await PracticeAPI.fetch('/api/practice/document-requests/' + reqId + '/received', { method: 'PUT' });
            if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Failed'); }
            loadClientDocumentRequests();
        } catch(e) {
            alert('Could not mark as received: ' + (e.message || 'Server error'));
        }
    }

    window.openAddCommModal         = openAddCommModal;
    window.closeAddCommModal        = closeAddCommModal;
    window.toggleAddCommResponseDate = toggleAddCommResponseDate;
    window.submitAddComm            = submitAddComm;
    window.markCommResponded        = markCommResponded;

    window.openAddDocModal    = openAddDocModal;
    window.closeAddDocModal   = closeAddDocModal;
    window.submitAddDoc       = submitAddDoc;
    window.cdDocMarkReceived  = cdDocMarkReceived;

    // ── Compliance Packs (client detail section) ───────────────────────────────

    var _CP_BASE         = '/api/practice/compliance-packs';
    var _cdPackSubmitting = false;

    var _cpTypeLabels = {
        annual_financials: 'Annual Financials',
        company_tax:       'Company Tax',
        individual_tax:    'Individual Tax',
        vat_period:        'VAT Period',
        payroll_annual:    'Payroll Annual',
        cipc_annual:       'CIPC Annual',
        custom:            'Custom',
    };

    var _cpReadinessLabels = { incomplete: '▲', partial: '◑', ready: '✓', blocked: '✕', unknown: '·' };
    var _cpReadinessClasses = {
        incomplete: 'color:#f87171',
        partial:    'color:#fbbf24',
        ready:      'color:#4ade80',
        blocked:    'color:var(--danger)',
        unknown:    'color:rgba(255,255,255,0.3)',
    };

    async function loadClientCompliancePacks() {
        var loading = document.getElementById('cpClientLoading');
        var wrap    = document.getElementById('cpClientWrap');
        var empty   = document.getElementById('cpClientEmpty');
        if (loading) loading.classList.remove('hidden');
        if (wrap)    wrap.classList.add('hidden');
        if (empty)   empty.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_CP_BASE + '?client_id=' + clientId + '&limit=8');
            if (!res.ok) throw new Error('Load failed');
            var d    = await res.json();
            var packs = (d.compliance_packs || []).filter(function(p) { return p.status !== 'cancelled'; });
            if (loading) loading.classList.add('hidden');
            if (packs.length === 0) {
                if (empty) empty.classList.remove('hidden');
            } else {
                renderClientPackList(packs);
                if (wrap) wrap.classList.remove('hidden');
            }
        } catch(e) {
            if (loading) loading.classList.add('hidden');
            if (wrap) { wrap.innerHTML = '<div class="error-banner">Could not load compliance packs.</div>'; wrap.classList.remove('hidden'); }
        }
    }

    function renderClientPackList(packs) {
        var wrap = document.getElementById('cpClientWrap');
        if (!wrap) return;

        wrap.innerHTML = packs.map(function(p) {
            var typeLabel = _cpTypeLabels[p.pack_type] || p.pack_type;
            var rs        = p.readiness_status || 'unknown';
            var score     = p.readiness_score  != null ? p.readiness_score + '%' : '—';
            var icon      = _cpReadinessLabels[rs]  || '·';
            var iconStyle = _cpReadinessClasses[rs]  || '';
            var statusLabels = {
                draft: 'Draft', collecting_docs: 'Collecting', ready_for_review: 'Ready for Review',
                reviewed: 'Reviewed', completed: 'Completed',
            };
            var statusLabel = statusLabels[p.status] || p.status;

            return '<div class="doc-hist-row">' +
                '<div class="doc-hist-body">' +
                    '<div class="doc-hist-title">' + esc(p.pack_name) + '</div>' +
                    '<div class="doc-hist-cat">' + esc(typeLabel) + ' · ' + esc(statusLabel) + '</div>' +
                '</div>' +
                '<div class="doc-hist-meta">' +
                    '<span style="font-size:0.8rem;font-weight:600;' + iconStyle + '">' + icon + ' ' + esc(score) + '</span>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    function openCdCreatePackModal() {
        document.getElementById('cdCpType').value         = '';
        document.getElementById('cdCpTaxYear').value      = '';
        document.getElementById('cdCpName').value         = '';
        document.getElementById('cdCpPeriodStart').value  = '';
        document.getElementById('cdCpPeriodEnd').value    = '';
        document.getElementById('cdCreatePackError').classList.add('hidden');
        _cdPackSubmitting = false;
        document.getElementById('cdCreatePackSubmitBtn').disabled = false;
        document.getElementById('cdCreatePackModal').classList.remove('hidden');
    }

    function closeCdCreatePackModal() {
        document.getElementById('cdCreatePackModal').classList.add('hidden');
    }

    function cdCpAutoName() {
        var typeSel  = document.getElementById('cdCpType');
        var yearEl   = document.getElementById('cdCpTaxYear');
        var nameEl   = document.getElementById('cdCpName');
        if (!typeSel.value) return;
        var typeLabel = _cpTypeLabels[typeSel.value] || typeSel.value;
        var year = yearEl.value ? ' ' + yearEl.value : '';
        nameEl.value = typeLabel + year;
    }

    async function submitCdCreatePack() {
        if (_cdPackSubmitting) return;
        var errEl   = document.getElementById('cdCreatePackError');
        var pack_type = document.getElementById('cdCpType').value;
        var pack_name = document.getElementById('cdCpName').value.trim();

        if (!pack_type) { errEl.textContent = 'Pack type is required.'; errEl.classList.remove('hidden'); return; }
        if (!pack_name) { errEl.textContent = 'Pack name is required.'; errEl.classList.remove('hidden'); return; }

        _cdPackSubmitting = true;
        document.getElementById('cdCreatePackSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        var taxYearRaw = document.getElementById('cdCpTaxYear').value;
        var payload = {
            client_id:   clientId,
            pack_type:   pack_type,
            pack_name:   pack_name,
            tax_year:    taxYearRaw ? parseInt(taxYearRaw) : null,
            period_start: document.getElementById('cdCpPeriodStart').value || null,
            period_end:   document.getElementById('cdCpPeriodEnd').value   || null,
        };

        try {
            var res = await PracticeAPI.fetch(_CP_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var e2 = await res.json(); throw new Error(e2.error || 'Failed'); }
            _cdPackSubmitting = false;
            closeCdCreatePackModal();
            PracticeAPI.showToast('Compliance pack created!');
            loadClientCompliancePacks();
        } catch(e) {
            _cdPackSubmitting = false;
            document.getElementById('cdCreatePackSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create pack.';
            errEl.classList.remove('hidden');
        }
    }

    window.openCdCreatePackModal  = openCdCreatePackModal;
    window.closeCdCreatePackModal = closeCdCreatePackModal;
    window.cdCpAutoName           = cdCpAutoName;
    window.submitCdCreatePack     = submitCdCreatePack;

    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
    // 18. TAXPAYER PROFILES (Codebox 25)
    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

    var _TP_BASE = '/api/practice/taxpayer-profiles';
    var _cdProfileSubmitting = false;

    var _cdTpTypeLabels = {
        individual: 'Individual', company: 'Company', trust: 'Trust',
        partnership: 'Partnership', cc: 'CC'
    };
    var _cdTpReadinessLabels  = { incomplete: 'Incomplete', partial: 'Partial', ready: 'Ready', blocked: 'Blocked', unknown: '—' };
    var _cdTpReadinessClasses = {
        incomplete: 'color:#f87171;', partial: 'color:#fbbf24;',
        ready: 'color:#4ade80;', blocked: 'color:var(--danger);', unknown: 'color:rgba(255,255,255,0.3);'
    };

    async function loadClientTaxpayerProfiles() {
        var loading = document.getElementById('tpClientLoading');
        var wrap    = document.getElementById('tpClientWrap');
        var empty   = document.getElementById('tpClientEmpty');
        if (loading) loading.classList.remove('hidden');
        if (wrap)    wrap.classList.add('hidden');
        if (empty)   empty.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_TP_BASE + '?client_id=' + clientId + '&limit=8');
            if (!res.ok) throw new Error('Load failed');
            var d        = await res.json();
            var profiles = (d.taxpayer_profiles || []).filter(function(p) { return p.tax_status !== 'ceased'; });
            if (loading) loading.classList.add('hidden');
            if (profiles.length === 0) {
                if (empty) empty.classList.remove('hidden');
            } else {
                renderClientProfileList(profiles);
                if (wrap) wrap.classList.remove('hidden');
            }
        } catch(e) {
            if (loading) loading.classList.add('hidden');
            if (wrap) { wrap.innerHTML = '<div class="error-banner">Could not load taxpayer profiles.</div>'; wrap.classList.remove('hidden'); }
        }
    }

    function renderClientProfileList(profiles) {
        var wrap = document.getElementById('tpClientWrap');
        if (!wrap) return;
        wrap.innerHTML = profiles.map(function(p) {
            var typeLabel = _cdTpTypeLabels[p.taxpayer_type]         || p.taxpayer_type;
            var rs        = p.readiness_status                        || 'unknown';
            var score     = p.readiness_score != null ? p.readiness_score + '%' : '—';
            var rsLabel   = _cdTpReadinessLabels[rs]                  || '—';
            var rsStyle   = _cdTpReadinessClasses[rs]                 || '';
            return '<div class="doc-hist-row">' +
                '<div class="doc-hist-body">' +
                    '<div class="doc-hist-title">' + esc(typeLabel) + (p.income_tax_reference ? ' · ' + esc(p.income_tax_reference) : '') + '</div>' +
                    '<div class="doc-hist-cat">' + esc(p.client_name || '') + '</div>' +
                '</div>' +
                '<div class="doc-hist-meta">' +
                    '<span style="font-size:0.8rem;font-weight:600;' + rsStyle + '">' + rsLabel + ' ' + esc(score) + '</span>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    function openCdCreateProfileModal() {
        document.getElementById('cdTpType').value      = '';
        document.getElementById('cdTpTaxRef').value    = '';
        document.getElementById('cdTpTaxStatus').value = 'active';
        document.getElementById('cdTpNotes').value     = '';
        document.getElementById('cdCreateProfileError').classList.add('hidden');
        _cdProfileSubmitting = false;
        document.getElementById('cdCreateProfileSubmitBtn').disabled = false;
        document.getElementById('cdCreateProfileModal').classList.remove('hidden');
    }

    function closeCdCreateProfileModal() {
        document.getElementById('cdCreateProfileModal').classList.add('hidden');
    }

    async function submitCdCreateProfile() {
        if (_cdProfileSubmitting) return;
        var errEl   = document.getElementById('cdCreateProfileError');
        var tpType  = document.getElementById('cdTpType').value;
        if (!tpType) { errEl.textContent = 'Taxpayer type is required.'; errEl.classList.remove('hidden'); return; }

        _cdProfileSubmitting = true;
        document.getElementById('cdCreateProfileSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        var payload = {
            client_id:            clientId,
            taxpayer_type:        tpType,
            income_tax_reference: document.getElementById('cdTpTaxRef').value.trim() || null,
            tax_status:           document.getElementById('cdTpTaxStatus').value || 'active',
            notes:                document.getElementById('cdTpNotes').value.trim() || null
        };

        try {
            var res = await PracticeAPI.fetch(_TP_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) { var e2 = await res.json(); throw new Error(e2.error || 'Failed'); }
            _cdProfileSubmitting = false;
            closeCdCreateProfileModal();
            PracticeAPI.showToast('Taxpayer profile created!');
            loadClientTaxpayerProfiles();
        } catch(e) {
            _cdProfileSubmitting = false;
            document.getElementById('cdCreateProfileSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create profile.';
            errEl.classList.remove('hidden');
        }
    }

    window.openCdCreateProfileModal  = openCdCreateProfileModal;
    window.closeCdCreateProfileModal = closeCdCreateProfileModal;
    window.submitCdCreateProfile     = submitCdCreateProfile;

    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
    // 19. PROVISIONAL TAX PLANS (Codebox 26)
    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

    var _PT_BASE = '/api/practice/provisional-tax';
    var _cdPlanSubmitting   = false;
    var _cdPtProfiles       = [];   // taxpayer profiles for this client

    var _cdPtStatusLabels = {
        draft: 'Draft', collecting_info: 'Collecting Info',
        ready_for_review: 'Ready for Review', reviewed: 'Reviewed',
        submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
    };
    var _cdPtPeriodLabels = { period_1: 'P1', period_2: 'P2', topup: 'Top-up' };

    async function loadClientProvisionalTaxPlans() {
        var loading = document.getElementById('ptClientLoading');
        var wrap    = document.getElementById('ptClientWrap');
        var empty   = document.getElementById('ptClientEmpty');
        if (loading) loading.classList.remove('hidden');
        if (wrap)    wrap.classList.add('hidden');
        if (empty)   empty.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_PT_BASE + '?client_id=' + clientId + '&limit=6');
            if (!res.ok) throw new Error('Load failed');
            var d     = await res.json();
            var plans = (d.provisional_tax_plans || []).filter(function(p) { return p.status !== 'cancelled'; });
            if (loading) loading.classList.add('hidden');
            if (plans.length === 0) {
                if (empty) empty.classList.remove('hidden');
            } else {
                renderClientPlanList(plans);
                if (wrap) wrap.classList.remove('hidden');
            }
        } catch(e) {
            if (loading) loading.classList.add('hidden');
            if (wrap) { wrap.innerHTML = '<div class="error-banner">Could not load provisional tax plans.</div>'; wrap.classList.remove('hidden'); }
        }
    }

    function renderClientPlanList(plans) {
        var wrap = document.getElementById('ptClientWrap');
        if (!wrap) return;
        wrap.innerHTML = plans.map(function(p) {
            var statusLabel = _cdPtStatusLabels[p.status] || p.status;
            var nextDue     = p.period_1_due_date || p.period_2_due_date || null;
            var dueStr      = nextDue ? 'Next due: ' + nextDue : '';
            return '<div class="doc-hist-row">' +
                '<div class="doc-hist-body">' +
                    '<div class="doc-hist-title">' + esc(p.plan_name) + ' (' + p.tax_year + ')</div>' +
                    '<div class="doc-hist-cat">' + esc(statusLabel) + (dueStr ? ' · ' + esc(dueStr) : '') + '</div>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    async function _cdPtLoadProfiles() {
        _cdPtProfiles = [];
        var sel = document.getElementById('cdPtProfile');
        if (!sel) return;
        sel.innerHTML = '<option value="">Loading…</option>';
        try {
            var res = await PracticeAPI.fetch('/api/practice/taxpayer-profiles?client_id=' + clientId + '&limit=20');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            _cdPtProfiles = (d.taxpayer_profiles || []).filter(function(p) { return p.tax_status !== 'ceased'; });
            if (!_cdPtProfiles.length) {
                sel.innerHTML = '<option value="">No taxpayer profiles — create one first</option>';
                return;
            }
            sel.innerHTML = '<option value="">Select profile…</option>' + _cdPtProfiles.map(function(p) {
                var label = (p.taxpayer_type || '').charAt(0).toUpperCase() + (p.taxpayer_type || '').slice(1) +
                    (p.income_tax_reference ? ' · ' + p.income_tax_reference : '');
                return '<option value="' + p.id + '" data-type="' + esc(p.taxpayer_type || '') + '">' + esc(label) + '</option>';
            }).join('');
        } catch(e) {
            sel.innerHTML = '<option value="">Error loading profiles</option>';
        }
    }

    function cdPtAutoName() {
        var year = document.getElementById('cdPtYear') ? document.getElementById('cdPtYear').value : '';
        var nameEl = document.getElementById('cdPtName');
        if (!nameEl || nameEl._manuallyEdited) return;
        if (!year) return;
        var sel = document.getElementById('cdPtProfile');
        var selected = sel && sel.options[sel.selectedIndex];
        var type = selected ? (selected.dataset.type || '') : '';
        var typeLabel = type ? (type.charAt(0).toUpperCase() + type.slice(1) + ' ') : '';
        nameEl.value = typeLabel + 'IRP6 ' + year;
    }

    async function openCdCreatePlanModal() {
        document.getElementById('cdPtYear').value  = '';
        document.getElementById('cdPtName').value  = '';
        document.getElementById('cdPtNotes').value = '';
        document.getElementById('cdCreatePlanError').classList.add('hidden');
        var nameEl = document.getElementById('cdPtName');
        if (nameEl) nameEl._manuallyEdited = false;
        _cdPlanSubmitting = false;
        document.getElementById('cdCreatePlanSubmitBtn').disabled = false;
        document.getElementById('cdCreatePlanModal').classList.remove('hidden');
        await _cdPtLoadProfiles();
    }

    function closeCdCreatePlanModal() {
        document.getElementById('cdCreatePlanModal').classList.add('hidden');
    }

    async function submitCdCreatePlan() {
        if (_cdPlanSubmitting) return;
        var errEl     = document.getElementById('cdCreatePlanError');
        var profileId = document.getElementById('cdPtProfile').value;
        var year      = document.getElementById('cdPtYear').value;
        var name      = document.getElementById('cdPtName').value.trim();
        if (!profileId) { errEl.textContent = 'Taxpayer profile is required.'; errEl.classList.remove('hidden'); return; }
        if (!year)      { errEl.textContent = 'Tax year is required.';         errEl.classList.remove('hidden'); return; }
        if (!name)      { errEl.textContent = 'Plan name is required.';        errEl.classList.remove('hidden'); return; }

        _cdPlanSubmitting = true;
        document.getElementById('cdCreatePlanSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        var payload = {
            client_id:           clientId,
            taxpayer_profile_id: parseInt(profileId),
            tax_year:            parseInt(year),
            plan_name:           name,
            notes:               document.getElementById('cdPtNotes').value.trim() || null,
        };

        try {
            var res = await PracticeAPI.fetch(_PT_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) { var e2 = await res.json(); throw new Error(e2.error || 'Failed'); }
            _cdPlanSubmitting = false;
            closeCdCreatePlanModal();
            PracticeAPI.showToast('Provisional tax plan created!');
            loadClientProvisionalTaxPlans();
        } catch(e) {
            _cdPlanSubmitting = false;
            document.getElementById('cdCreatePlanSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create plan.';
            errEl.classList.remove('hidden');
        }
    }

    window.openCdCreatePlanModal  = openCdCreatePlanModal;
    window.closeCdCreatePlanModal = closeCdCreatePlanModal;
    window.cdPtAutoName           = cdPtAutoName;
    window.submitCdCreatePlan     = submitCdCreatePlan;

    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
    // 20. INDIVIDUAL TAX RETURNS (Codebox 27)
    // ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

    var _IT_BASE = '/api/practice/individual-tax';
    var _cdItSubmitting  = false;
    var _cdItProfiles    = [];

    var _cdItStatusLabels = {
        draft: 'Draft', collecting_docs: 'Collecting Docs', data_captured: 'Data Captured',
        ready_for_review: 'Ready for Review', reviewed: 'Reviewed',
        submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
    };

    var _cdItReadinessLabels = {
        ready: '✓ Ready', partial: '~ Partial', incomplete: '✗ Incomplete',
        blocked: '⚠ Blocked', unknown: '? Unknown',
    };

    async function loadClientIndividualTaxReturns() {
        if (!_currentClientId) return;
        document.getElementById('itClientLoading').classList.remove('hidden');
        document.getElementById('itClientWrap').classList.add('hidden');
        document.getElementById('itClientEmpty').classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_IT_BASE + '?client_id=' + _currentClientId + '&limit=6');
            if (!res.ok) throw new Error('Failed');
            var data = await res.json();
            var returns = (data.individual_tax_returns || []).filter(function (r) { return r.status !== 'cancelled'; });

            document.getElementById('itClientLoading').classList.add('hidden');
            if (returns.length === 0) {
                document.getElementById('itClientEmpty').classList.remove('hidden');
                return;
            }
            var wrap = document.getElementById('itClientWrap');
            wrap.innerHTML = returns.map(function (r) {
                var statusLabel    = _cdItStatusLabels[r.status]          || r.status;
                var readinessLabel = _cdItReadinessLabels[r.readiness_status] || (r.readiness_status || 'Unknown');
                return '<div class="cd-docreq-row">' +
                    '<div class="cd-docreq-info">' +
                        '<div class="cd-docreq-name">Tax Year ' + r.tax_year + ' — ' + esc(r.return_name) + '</div>' +
                        '<div class="cd-docreq-meta">' + esc(statusLabel) + ' &mdash; ' + esc(readinessLabel) +
                            (r.readiness_score != null ? ' (' + r.readiness_score + '%)' : '') + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
            wrap.classList.remove('hidden');
        } catch (_) {
            document.getElementById('itClientLoading').classList.add('hidden');
            document.getElementById('itClientEmpty').classList.remove('hidden');
        }
    }

    async function _cdItLoadProfiles() {
        if (!_currentClientId) return;
        var sel = document.getElementById('cdItProfile');
        sel.innerHTML = '<option value="">Loading…</option>';
        _cdItProfiles = [];
        try {
            var res = await PracticeAPI.fetch('/api/practice/taxpayer-profiles?client_id=' + _currentClientId + '&limit=100');
            if (!res.ok) return;
            var data = await res.json();
            _cdItProfiles = data.taxpayer_profiles || [];
            sel.innerHTML = '<option value="">Select profile…</option>';
            _cdItProfiles.forEach(function (p) {
                var opt = document.createElement('option');
                opt.value       = p.id;
                opt.textContent = p.profile_name + ' (' + (p.taxpayer_type || 'individual') + ')';
                sel.appendChild(opt);
            });
        } catch (_) {
            sel.innerHTML = '<option value="">Failed to load profiles</option>';
        }
    }

    function cdItAutoName() {
        var nameEl = document.getElementById('cdItName');
        if (nameEl._manuallyEdited) return;
        var year = document.getElementById('cdItYear').value;
        if (!year) return;
        nameEl.value = 'ITR12 ' + year;
    }

    async function openCdCreateItReturnModal() {
        document.getElementById('cdItYear').value  = '';
        document.getElementById('cdItName').value  = '';
        document.getElementById('cdItNotes').value = '';
        document.getElementById('cdCreateItReturnError').classList.add('hidden');
        var nameEl = document.getElementById('cdItName');
        if (nameEl) nameEl._manuallyEdited = false;
        _cdItSubmitting = false;
        document.getElementById('cdCreateItReturnSubmitBtn').disabled = false;
        document.getElementById('cdCreateItReturnModal').classList.remove('hidden');
        await _cdItLoadProfiles();
    }

    function closeCdCreateItReturnModal() {
        document.getElementById('cdCreateItReturnModal').classList.add('hidden');
    }

    async function submitCdCreateItReturn() {
        if (_cdItSubmitting) return;
        var errEl     = document.getElementById('cdCreateItReturnError');
        var profileId = document.getElementById('cdItProfile').value;
        var year      = document.getElementById('cdItYear').value;
        var name      = document.getElementById('cdItName').value.trim();

        if (!profileId) { errEl.textContent = 'Taxpayer profile is required.'; errEl.classList.remove('hidden'); return; }
        if (!year)      { errEl.textContent = 'Tax year is required.';         errEl.classList.remove('hidden'); return; }
        if (!name)      { errEl.textContent = 'Return name is required.';      errEl.classList.remove('hidden'); return; }

        _cdItSubmitting = true;
        document.getElementById('cdCreateItReturnSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_IT_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id:           _currentClientId,
                    taxpayer_profile_id: parseInt(profileId),
                    tax_year:            parseInt(year),
                    return_name:         name,
                    notes:               document.getElementById('cdItNotes').value.trim() || null,
                }),
            });
            if (!res.ok) {
                var d = await res.json();
                throw new Error(d.error || 'Failed to create return');
            }
            _cdItSubmitting = false;
            closeCdCreateItReturnModal();
            PracticeAPI.showToast('Individual tax return created!');
            loadClientIndividualTaxReturns();
        } catch (e) {
            _cdItSubmitting = false;
            document.getElementById('cdCreateItReturnSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create return.';
            errEl.classList.remove('hidden');
        }
    }

    window.openCdCreateItReturnModal  = openCdCreateItReturnModal;
    window.closeCdCreateItReturnModal = closeCdCreateItReturnModal;
    window.cdItAutoName               = cdItAutoName;
    window.submitCdCreateItReturn     = submitCdCreateItReturn;

    // ── Company Tax Returns (Codebox 31) ──────────────────────────────────────

    var _CT_BASE       = '/api/practice/company-tax';
    var _cdCtSubmitting = false;
    var _cdCtProfiles   = [];

    var _cdCtStatusLabels = {
        draft: 'Draft', collecting_docs: 'Collecting Docs', data_captured: 'Data Captured',
        ready_for_review: 'Ready for Review', reviewed: 'Reviewed',
        submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
    };

    var _cdCtReadinessLabels = {
        ready: '✓ Ready', partial: '~ Partial', incomplete: '✗ Incomplete',
        blocked: '⚠ Blocked', unknown: '? Unknown',
    };

    async function loadClientCompanyTaxReturns() {
        if (!_currentClientId) return;
        document.getElementById('ctClientLoading').classList.remove('hidden');
        document.getElementById('ctClientWrap').classList.add('hidden');
        document.getElementById('ctClientEmpty').classList.add('hidden');

        try {
            var res  = await PracticeAPI.fetch(_CT_BASE + '?client_id=' + _currentClientId + '&limit=6');
            if (!res.ok) throw new Error('Failed');
            var data = await res.json();
            var returns = (data.company_tax_returns || []).filter(function(r) { return r.status !== 'cancelled'; });

            document.getElementById('ctClientLoading').classList.add('hidden');
            if (returns.length === 0) {
                document.getElementById('ctClientEmpty').classList.remove('hidden');
                return;
            }
            var wrap = document.getElementById('ctClientWrap');
            wrap.innerHTML = returns.map(function(r) {
                var statusLabel    = _cdCtStatusLabels[r.status]          || r.status;
                var readinessLabel = _cdCtReadinessLabels[r.readiness_status] || (r.readiness_status || 'Unknown');
                return '<div class="cd-docreq-row">' +
                    '<div class="cd-docreq-info">' +
                        '<div class="cd-docreq-name">Tax Year ' + r.tax_year + ' — ' + esc(r.return_name) + '</div>' +
                        '<div class="cd-docreq-meta">' + esc(statusLabel) + ' &mdash; ' + esc(readinessLabel) +
                            (r.readiness_score != null ? ' (' + r.readiness_score + '%)' : '') + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
            wrap.classList.remove('hidden');
        } catch(_) {
            document.getElementById('ctClientLoading').classList.add('hidden');
            document.getElementById('ctClientEmpty').classList.remove('hidden');
        }
    }

    async function _cdCtLoadProfiles() {
        if (!_currentClientId) return;
        var sel = document.getElementById('cdCtProfile');
        sel.innerHTML = '<option value="">Loading…</option>';
        _cdCtProfiles = [];
        try {
            var res = await PracticeAPI.fetch('/api/practice/taxpayer-profiles?client_id=' + _currentClientId + '&limit=100');
            if (!res.ok) return;
            var data = await res.json();
            _cdCtProfiles = (data.taxpayer_profiles || []).filter(function(p) { return p.tax_status !== 'ceased'; });
            if (_cdCtProfiles.length === 0) {
                sel.innerHTML = '<option value="">No profiles — create one first</option>';
            } else {
                sel.innerHTML = '<option value="">Select profile…</option>' +
                    _cdCtProfiles.map(function(p) {
                        return '<option value="' + p.id + '">' + esc(p.taxpayer_name || 'Unnamed') +
                            ' (' + esc(p.taxpayer_type) + ')' + '</option>';
                    }).join('');
            }
        } catch(e) {
            sel.innerHTML = '<option value="">Failed to load profiles</option>';
        }
    }

    function cdCtAutoName() {
        var nameEl = document.getElementById('cdCtName');
        if (nameEl && nameEl._manuallyEdited) return;
        var year = document.getElementById('cdCtYear').value;
        if (year && nameEl) nameEl.value = 'ITR14 ' + year;
    }

    function openCdCreateCtReturnModal() {
        _cdCtSubmitting = false;
        document.getElementById('cdCreateCtReturnSubmitBtn').disabled = false;
        document.getElementById('cdCreateCtReturnError').classList.add('hidden');
        ['cdCtYear','cdCtName','cdCtNotes'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) { el.value = ''; el._manuallyEdited = false; }
        });
        _cdCtLoadProfiles();
        document.getElementById('cdCreateCtReturnModal').classList.remove('hidden');
    }

    function closeCdCreateCtReturnModal() {
        document.getElementById('cdCreateCtReturnModal').classList.add('hidden');
    }

    async function submitCdCreateCtReturn() {
        if (_cdCtSubmitting) return;
        var errEl     = document.getElementById('cdCreateCtReturnError');
        var profileId = document.getElementById('cdCtProfile').value;
        var year      = document.getElementById('cdCtYear').value;
        var name      = document.getElementById('cdCtName').value.trim();

        if (!profileId) { errEl.textContent = 'Taxpayer profile is required.'; errEl.classList.remove('hidden'); return; }
        if (!year)      { errEl.textContent = 'Tax year is required.';         errEl.classList.remove('hidden'); return; }
        if (!name)      { errEl.textContent = 'Return name is required.';      errEl.classList.remove('hidden'); return; }

        _cdCtSubmitting = true;
        document.getElementById('cdCreateCtReturnSubmitBtn').disabled = true;
        errEl.classList.add('hidden');

        try {
            var res = await PracticeAPI.fetch(_CT_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id:           _currentClientId,
                    taxpayer_profile_id: parseInt(profileId),
                    tax_year:            parseInt(year),
                    return_name:         name,
                    notes:               document.getElementById('cdCtNotes').value.trim() || null,
                }),
            });
            if (!res.ok) { var d = await res.json(); throw new Error(d.error || 'Failed'); }
            _cdCtSubmitting = false;
            closeCdCreateCtReturnModal();
            PracticeAPI.showToast('Company tax return created!');
            loadClientCompanyTaxReturns();
        } catch(e) {
            _cdCtSubmitting = false;
            document.getElementById('cdCreateCtReturnSubmitBtn').disabled = false;
            errEl.textContent = e.message || 'Failed to create return.';
            errEl.classList.remove('hidden');
        }
    }

    window.openCdCreateCtReturnModal  = openCdCreateCtReturnModal;
    window.closeCdCreateCtReturnModal = closeCdCreateCtReturnModal;
    window.cdCtAutoName               = cdCtAutoName;
    window.submitCdCreateCtReturn     = submitCdCreateCtReturn;

    init();
})();
