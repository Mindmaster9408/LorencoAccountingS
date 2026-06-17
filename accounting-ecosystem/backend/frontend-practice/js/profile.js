/* ============================================================
   Lorenco Practice — Profile Page JS
   Handles auth guard, profile load/create/update, user picker.
   Rule D: no localStorage for business data. All data via API.
   ============================================================ */
(function () {
    var esc = PracticeAPI.escHtml;
    var profileMode = 'create'; // 'create' or 'update'

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        LAYOUT.init('profile');
        await Promise.all([loadUsers(), loadProfile()]);
    }

    async function loadUsers() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/users');
            if (!res.ok) return;
            var d = await res.json();
            var users = d.users || [];
            var sel = document.getElementById('pDefaultAssignee');
            if (!sel) return;
            var opts = users.map(function(u) {
                var name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
                return '<option value="' + u.id + '">' + esc(name) + '</option>';
            }).join('');
            sel.innerHTML = '<option value="">No default assignee</option>' + opts;
        } catch(e) {}
    }

    async function loadProfile() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/profile');
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            document.getElementById('profileLoading').classList.add('hidden');
            if (d.profile) {
                profileMode = 'update';
                populateForm(d.profile);
            } else {
                profileMode = 'create';
                document.getElementById('createNotice').classList.remove('hidden');
            }
            document.getElementById('profileForm').classList.remove('hidden');
        } catch(e) {
            document.getElementById('profileLoading').classList.add('hidden');
            document.getElementById('profileError').classList.remove('hidden');
        }
    }

    function populateForm(p) {
        setVal('pTaxPractitionerNumber', p.tax_practitioner_number);
        setVal('pVatNumber',             p.vat_registration_number);
        setVal('pPracticeType',          p.practice_type);
        setVal('pEmail',                 p.practice_email);
        setVal('pPhone',                 p.practice_phone);
        setVal('pWebsite',               p.practice_website);
        setVal('pLine1',                 p.address_line1);
        setVal('pLine2',                 p.address_line2);
        setVal('pCity',                  p.address_city);
        setVal('pProvince',              p.address_province);
        setVal('pPostal',                p.address_postal_code);
        setVal('pHourlyRate',            p.default_hourly_rate != null ? p.default_hourly_rate : '');
        setVal('pCurrency',              p.default_currency || 'ZAR');
        setVal('pFiscalMonth',           p.fiscal_year_end_month != null ? p.fiscal_year_end_month : '');
        setVal('pDefaultAssignee',       p.default_task_assignee_id || '');
        setVal('pPrimaryColour',         p.primary_colour);
        setVal('pLogoUrl',               p.logo_url);
        setVal('pComplianceNotes',       p.compliance_notes);
    }

    function setVal(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = value || '';
    }

    function getStr(id) {
        var el = document.getElementById(id);
        return el ? el.value.trim() || null : null;
    }

    async function saveProfile(e) {
        e.preventDefault();
        var btn = document.getElementById('profileSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        var hourlyRateRaw  = document.getElementById('pHourlyRate').value;
        var fiscalMonthRaw = document.getElementById('pFiscalMonth').value;
        var assigneeRaw    = document.getElementById('pDefaultAssignee').value;

        var body = {
            tax_practitioner_number: getStr('pTaxPractitionerNumber'),
            vat_registration_number: getStr('pVatNumber'),
            practice_type:           document.getElementById('pPracticeType').value || null,
            practice_email:          getStr('pEmail'),
            practice_phone:          getStr('pPhone'),
            practice_website:        getStr('pWebsite'),
            address_line1:           getStr('pLine1'),
            address_line2:           getStr('pLine2'),
            address_city:            getStr('pCity'),
            address_province:        document.getElementById('pProvince').value || null,
            address_postal_code:     getStr('pPostal'),
            default_hourly_rate:     hourlyRateRaw  ? parseFloat(hourlyRateRaw)  : null,
            default_currency:        document.getElementById('pCurrency').value  || 'ZAR',
            fiscal_year_end_month:   fiscalMonthRaw ? parseInt(fiscalMonthRaw)   : null,
            default_task_assignee_id: assigneeRaw   ? parseInt(assigneeRaw)      : null,
            primary_colour:          getStr('pPrimaryColour'),
            logo_url:                getStr('pLogoUrl'),
            compliance_notes:        getStr('pComplianceNotes')
        };

        try {
            var method = profileMode === 'create' ? 'POST' : 'PUT';
            var res = await PracticeAPI.fetch('/api/practice/profile', {
                method: method,
                body: JSON.stringify(body)
            });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Save failed');
            if (profileMode === 'create') {
                profileMode = 'update';
                document.getElementById('createNotice').classList.add('hidden');
            }
            PracticeAPI.showToast('Profile saved!');
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Profile';
        }
        return false;
    }

    window.saveProfile = saveProfile;
    init();
})();
