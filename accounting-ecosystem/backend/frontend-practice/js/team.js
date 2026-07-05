/* ============================================================
   Lorenco Practice — Team Members Page JS
   Handles auth, list, add/edit/deactivate/reactivate.
   Rule D: no localStorage for business data. All data via API.
   ============================================================ */
(function () {
    var esc = PracticeAPI.escHtml;
    var allMembers = [], filteredMembers = [];
    var editingId = null;
    var PAGE_SIZE = 20;
    var currentPage = 1;
    // Tracks whether the "Link to Login Account" picker actually loaded —
    // if /api/practice/users fails, the picker used to silently fall back
    // to "Not linked" with no warning, letting a member be saved without
    // its login link even though a matching account exists (root cause of
    // the 2026-07-05 Planning Board access incident). Now surfaced instead
    // of swallowed.
    var loginUsersLoaded = false;

    var ROLE_LABEL = {
        owner: 'Owner', partner: 'Partner', manager: 'Manager', senior: 'Senior',
        staff: 'Staff', admin: 'Admin', reviewer: 'Reviewer', viewer: 'Viewer'
    };
    var ROLE_BADGE = {
        owner: 'badge-in-progress', partner: 'badge-in-progress', manager: 'badge-review',
        senior: 'badge-info', staff: 'badge-open', admin: 'badge-pending',
        reviewer: 'badge-billable', viewer: 'badge-inactive'
    };

    // ── Auth + init ────────────────────────────────────────────────────────────

    async function init() {
        var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
        if (!token) { window.location.href = '/'; return; }
        try {
            var res = await PracticeAPI.fetch('/api/auth/me');
            if (!res.ok) { window.location.href = '/'; return; }
        } catch(e) { window.location.href = '/'; return; }

        LAYOUT.init('team');
        await Promise.all([loadLoginUsers(), loadTeam()]);
    }

    // ── Load login users for the "Link to Login Account" picker in modal ───────

    async function loadLoginUsers() {
        try {
            var res = await PracticeAPI.fetch('/api/practice/users');
            if (!res.ok) throw new Error('Load failed (' + res.status + ')');
            var d = await res.json();
            var users = d.users || [];
            var opts = users.map(function(u) {
                var name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
                return '<option value="' + u.id + '">' + esc(name) + ' (' + esc(u.email || '') + ')</option>';
            }).join('');
            document.getElementById('tmUserId').innerHTML =
                '<option value="">Not linked (roster only — cannot receive tasks)</option>' + opts;
            loginUsersLoaded = true;
        } catch(e) {
            loginUsersLoaded = false;
            document.getElementById('tmUserId').innerHTML =
                '<option value="">⚠️ Could not load login accounts — reopen this form to retry</option>';
            PracticeAPI.showToast('❌ Could not load login accounts for the "Link to Login Account" picker. Reopen Add/Edit Member to retry before saving a link.', true);
        }
    }

    // ── Load team list ─────────────────────────────────────────────────────────

    async function loadTeam() {
        document.getElementById('teamWrap').innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading team…</p></div>';
        var active = document.getElementById('fActive').value;
        var url = '/api/practice/team?active=' + encodeURIComponent(active);
        try {
            var res = await PracticeAPI.fetch(url);
            if (!res.ok) throw new Error('Load failed');
            var d = await res.json();
            allMembers = d.members || [];
            currentPage = 1;
            applyFilters();
        } catch(e) {
            document.getElementById('teamWrap').innerHTML = '<div class="error-banner">⚠️ Failed to load team members. Please refresh.</div>';
        }
    }

    // ── Client-side search + role filter ──────────────────────────────────────

    function applyFilters() {
        var search = (document.getElementById('fSearch').value || '').toLowerCase().trim();
        var role   = document.getElementById('fRole').value;
        filteredMembers = allMembers.filter(function(m) {
            var matchRole   = !role || m.role === role;
            var matchSearch = !search ||
                (m.display_name && m.display_name.toLowerCase().includes(search)) ||
                (m.email && m.email.toLowerCase().includes(search)) ||
                (m.job_title && m.job_title.toLowerCase().includes(search)) ||
                (m.department && m.department.toLowerCase().includes(search));
            return matchRole && matchSearch;
        });
        currentPage = 1;
        renderTeam();
    }

    // ── Render ────────────────────────────────────────────────────────────────

    function renderTeam() {
        var wrap = document.getElementById('teamWrap');
        var totalPages = Math.max(1, Math.ceil(filteredMembers.length / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        var start = (currentPage - 1) * PAGE_SIZE;
        var page  = filteredMembers.slice(start, start + PAGE_SIZE);

        if (!filteredMembers.length) {
            wrap.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><h3>No team members</h3><p>Add team members to track responsibility and enable task assignment.</p></div>';
            return;
        }

        var rows = page.map(function(m) {
            var roleLabel = ROLE_LABEL[m.role] || m.role;
            var roleBadge = ROLE_BADGE[m.role] || 'badge-open';
            var statusBadge = m.is_active
                ? '<span class="badge badge-active">Active</span>'
                : '<span class="badge badge-inactive">Inactive</span>';
            var linkedBadge = m.user_id
                ? '<span class="badge badge-billable" title="Linked to login account">Linked</span>'
                : '<span class="badge badge-inactive" title="No login account linked">No login</span>';
            var permissions = [];
            if (m.can_receive_tasks) permissions.push('Tasks');
            if (m.can_review_work)   permissions.push('Review');
            if (m.can_approve_work)  permissions.push('Approve');
            var permStr = permissions.length ? permissions.join(', ') : '–';
            var rateStr = m.default_hourly_rate != null ? 'R ' + parseFloat(m.default_hourly_rate).toFixed(2) : '–';
            var subtitle = [m.job_title, m.department].filter(Boolean).join(' · ');

            // Capacity column
            var capHours = m.weekly_capacity_hours != null ? parseFloat(m.weekly_capacity_hours) + ' hrs/wk' : null;
            var capCell  = capHours
                ? '<span style="font-size:0.82rem;color:var(--text)">' + capHours + '</span>'
                : '<span style="font-size:0.78rem;color:var(--muted)">Not set</span>';

            return '<tr>' +
                '<td>' +
                    '<strong>' + esc(m.display_name) + '</strong>' +
                    (subtitle ? '<div class="col-muted" style="font-size:0.78rem;margin-top:2px;">' + esc(subtitle) + '</div>' : '') +
                '</td>' +
                '<td><span class="badge ' + roleBadge + '">' + esc(roleLabel) + '</span></td>' +
                '<td class="col-muted">' +
                    (m.email ? '<div>' + esc(m.email) + '</div>' : '') +
                    (m.phone ? '<div style="font-size:0.78rem;">' + esc(m.phone) + '</div>' : (!m.email ? '–' : '')) +
                '</td>' +
                '<td class="col-muted col-small">' + esc(rateStr) + '</td>' +
                '<td class="col-muted col-small">' + esc(permStr) + '</td>' +
                '<td>' + linkedBadge + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + capCell + '</td>' +
                '<td><div class="td-actions">' +
                    '<button type="button" class="btn btn-ghost btn-sm" onclick="openModal(' + m.id + ')">Edit</button>' +
                    '<a href="/practice/capacity.html" class="btn btn-ghost btn-sm" style="text-decoration:none" title="Manage capacity for this member">Capacity</a>' +
                '</div></td>' +
            '</tr>';
        }).join('');

        var tableHtml =
            '<div class="table-wrap"><table><thead><tr>' +
                '<th>Name</th><th>Role</th><th>Contact</th><th>Rate/hr</th><th>Permissions</th><th>Login</th><th>Status</th><th>Capacity</th><th>Actions</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>' +
            renderPagination(totalPages) +
            '</div>';

        wrap.innerHTML = tableHtml;
    }

    function renderPagination(totalPages) {
        if (totalPages <= 1) return '';
        var s = (currentPage - 1) * PAGE_SIZE + 1;
        var e = Math.min(currentPage * PAGE_SIZE, filteredMembers.length);
        var pages = '';
        for (var i = 1; i <= totalPages; i++) {
            pages += '<button type="button" class="page-btn' + (i === currentPage ? ' active' : '') + '" onclick="goPage(' + i + ')">' + i + '</button>';
        }
        return '<div class="pagination">' +
            '<span>Showing ' + s + '–' + e + ' of ' + filteredMembers.length + ' members</span>' +
            '<div class="pagination-pages">' +
                '<button type="button" class="page-btn" onclick="goPage(' + (currentPage - 1) + ')" ' + (currentPage === 1 ? 'disabled' : '') + '>‹</button>' +
                pages +
                '<button type="button" class="page-btn" onclick="goPage(' + (currentPage + 1) + ')" ' + (currentPage === totalPages ? 'disabled' : '') + '>›</button>' +
            '</div>' +
        '</div>';
    }

    function goPage(p) {
        var totalPages = Math.ceil(filteredMembers.length / PAGE_SIZE);
        if (p < 1 || p > totalPages) return;
        currentPage = p;
        renderTeam();
    }

    // ── Modal ─────────────────────────────────────────────────────────────────

    function openModal(id) {
        editingId = id || null;
        var m = id ? allMembers.find(function(x) { return x.id === id; }) : null;
        document.getElementById('tmModalTitle').textContent = id ? 'Edit Team Member' : 'Add Team Member';

        setVal('tmDisplayName', m ? m.display_name : '');
        setVal('tmEmail',       m ? m.email        : '');
        setVal('tmPhone',       m ? m.phone        : '');
        setVal('tmRole',        m ? m.role || 'staff' : 'staff');
        setVal('tmJobTitle',    m ? m.job_title    : '');
        setVal('tmDepartment',  m ? m.department   : '');
        setVal('tmHourlyRate',  m && m.default_hourly_rate != null ? m.default_hourly_rate : '');
        setVal('tmUserId',      m && m.user_id ? m.user_id : '');
        setVal('tmCanReceiveTasks', m ? String(m.can_receive_tasks !== false) : 'true');
        setVal('tmCanReview',       m ? String(!!m.can_review_work)  : 'false');
        setVal('tmCanApprove',      m ? String(!!m.can_approve_work) : 'false');
        setVal('tmIsActive',        m ? String(m.is_active !== false) : 'true');
        setVal('tmNotes',       m ? m.notes : '');

        var deactivateBtn  = document.getElementById('tmDeactivateBtn');
        var reactivateBtn  = document.getElementById('tmReactivateBtn');
        if (id && m) {
            if (m.is_active) {
                deactivateBtn.classList.remove('hidden');
                reactivateBtn.classList.add('hidden');
            } else {
                deactivateBtn.classList.add('hidden');
                reactivateBtn.classList.remove('hidden');
            }
        } else {
            deactivateBtn.classList.add('hidden');
            reactivateBtn.classList.add('hidden');
        }

        document.getElementById('teamModal').classList.add('show');
    }

    function closeModal() {
        document.getElementById('teamModal').classList.remove('show');
    }

    // ── Save (create or update) ───────────────────────────────────────────────

    async function saveMember(e) {
        e.preventDefault();

        var userIdRaw = document.getElementById('tmUserId').value;
        // Guard against saving without a login link just because the
        // picker silently failed to load (the actual root cause of the
        // 2026-07-05 Planning Board access incident) — the admin must
        // explicitly confirm they mean "no login account" when the picker
        // never loaded, rather than that being an unnoticed accident.
        if (!loginUsersLoaded && !userIdRaw) {
            var proceed = confirm('The login account picker failed to load, so this save cannot verify whether ' +
                (document.getElementById('tmEmail').value.trim() || 'this person') +
                ' already has a login account.\n\nSaving now will leave them "Not linked" (roster only — cannot receive tasks).\n\n' +
                'Click Cancel to close this form and reopen it to retry loading the picker. Click OK to save as-is.');
            if (!proceed) return false;
        }

        var btn = document.getElementById('tmSaveBtn');
        btn.disabled = true;

        var hourlyRaw = document.getElementById('tmHourlyRate').value;
        var body = {
            display_name:       document.getElementById('tmDisplayName').value.trim(),
            email:              document.getElementById('tmEmail').value.trim() || null,
            phone:              document.getElementById('tmPhone').value.trim() || null,
            role:               document.getElementById('tmRole').value,
            job_title:          document.getElementById('tmJobTitle').value.trim() || null,
            department:         document.getElementById('tmDepartment').value.trim() || null,
            default_hourly_rate: hourlyRaw ? parseFloat(hourlyRaw) : null,
            user_id:            userIdRaw ? parseInt(userIdRaw) : null,
            can_receive_tasks:  document.getElementById('tmCanReceiveTasks').value === 'true',
            can_review_work:    document.getElementById('tmCanReview').value === 'true',
            can_approve_work:   document.getElementById('tmCanApprove').value === 'true',
            is_active:          document.getElementById('tmIsActive').value === 'true',
            notes:              document.getElementById('tmNotes').value.trim() || null
        };

        try {
            var url    = editingId ? '/api/practice/team/' + editingId : '/api/practice/team';
            var method = editingId ? 'PUT' : 'POST';
            var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Save failed');
            closeModal();
            PracticeAPI.showToast(editingId ? 'Team member updated!' : 'Team member added!');
            loadTeam();
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false;
        }
        return false;
    }

    // ── Deactivate / Reactivate ───────────────────────────────────────────────

    async function deactivateFromModal() {
        if (!editingId) return;
        var m = allMembers.find(function(x) { return x.id === editingId; });
        if (!confirm('Deactivate "' + (m ? m.display_name : editingId) + '"? They will no longer appear in active filters or task pickers.')) return;
        try {
            var res = await PracticeAPI.fetch('/api/practice/team/' + editingId, { method: 'DELETE' });
            if (!res.ok) throw new Error('Deactivate failed');
            closeModal();
            PracticeAPI.showToast('Team member deactivated.');
            loadTeam();
        } catch(e) {
            PracticeAPI.showToast('❌ ' + e.message, true);
        }
    }

    async function reactivateFromModal() {
        if (!editingId) return;
        var m = allMembers.find(function(x) { return x.id === editingId; });
        try {
            var res = await PracticeAPI.fetch('/api/practice/team/' + editingId + '/reactivate', { method: 'PUT', body: '{}' });
            if (!res.ok) throw new Error('Reactivate failed');
            closeModal();
            PracticeAPI.showToast('Team member reactivated!');
            loadTeam();
        } catch(e) {
            PracticeAPI.showToast('❌ ' + e.message, true);
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    function setVal(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = value || '';
    }

    // ── Sync from ecosystem users ─────────────────────────────────────────────

    async function syncFromUsers() {
        var btn = document.getElementById('syncBtn');
        btn.disabled = true;
        btn.textContent = 'Syncing…';
        try {
            var res = await PracticeAPI.fetch('/api/practice/team/sync-from-users', { method: 'POST', body: '{}' });
            var d = await res.json();
            if (!res.ok) throw new Error(d.error || 'Sync failed');
            if (d.imported === 0) {
                PracticeAPI.showToast(d.message || 'All users already in team — nothing to import.');
            } else {
                PracticeAPI.showToast(d.imported + ' user' + (d.imported === 1 ? '' : 's') + ' imported as Staff. Adjust roles as needed.');
                await loadTeam();
            }
        } catch(err) {
            PracticeAPI.showToast('❌ ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = '↓ Sync from Ecosystem Users';
        }
    }

    // ── Expose globals needed by inline HTML event handlers ───────────────────

    window.loadTeam         = loadTeam;
    window.applyFilters     = applyFilters;
    window.openModal        = openModal;
    window.closeModal       = closeModal;
    window.saveMember       = saveMember;
    window.deactivateFromModal = deactivateFromModal;
    window.reactivateFromModal = reactivateFromModal;
    window.goPage           = goPage;
    window.syncFromUsers    = syncFromUsers;

    init();
})();
