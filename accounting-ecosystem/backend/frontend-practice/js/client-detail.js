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
            document.getElementById('archiveBtn').classList.remove('hidden');
            loadContacts();
            loadEngagements();
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

    init();
})();
