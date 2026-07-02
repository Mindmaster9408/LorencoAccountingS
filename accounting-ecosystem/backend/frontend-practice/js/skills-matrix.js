/* Codebox 59 — Practice Skills Matrix + Competency Framework
 * "What can this person confidently do?" NOT AI. Advisory only.
 * Prefix: sk
 */
(function () {
    'use strict';

    var BASE = '/api/practice/skills-matrix';
    var TEAM_BASE = '/api/practice/team';
    var _tab = 'competency';
    var _categories = [];
    var _skills = [];
    var _teamList = [];
    var _certTypes = [];
    var _editingCategoryId = null;
    var _editingSkillId = null;
    var _editingTeamSkill = null;

    var LEVEL_LABELS = { 0: 'No Exposure', 1: 'Basic', 2: 'Working Knowledge', 3: 'Independent', 4: 'Advanced', 5: 'Expert' };
    var EV_LABELS = {
        category_created: 'Category Created', category_updated: 'Category Updated', category_archived: 'Category Archived',
        skill_created: 'Skill Created', skill_updated: 'Skill Updated', skill_archived: 'Skill Archived',
        team_skill_updated: 'Competency Updated', team_skill_archived: 'Competency Reset',
        certification_created: 'Certification Type Created', certification_updated: 'Certification Type Updated', certification_archived: 'Certification Type Archived',
        team_certification_added: 'Team Certification Added', team_certification_updated: 'Team Certification Updated', team_certification_archived: 'Team Certification Archived',
        skills_seeded: 'Defaults Seeded',
    };

    function _html(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _fmt(s) { return s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
    function _fmtDate(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : '—'; }
    function _levelPill(n) { return '<span class="pill lv-' + n + '">' + n + ' — ' + _html(LEVEL_LABELS[n] || '') + '</span>'; }
    function _showToast(msg) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2d3748;color:#e2e8f0;padding:12px 20px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 3000);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function skLoadAll() {
        _renderTabBar();
        _loadSummary();
        _loadTeam();
        skLoadCategories();
        skLoadSkills();
        _loadCertTypes();
        skLoadTeamCerts();
        skLoadTraining();
        skLoadHistory();
    }

    function _renderTabBar() {
        var tabs = [['competency', 'Team Competency'], ['catalog', 'Skills Catalog'], ['certifications', 'Certifications'], ['training', 'Training Needs'], ['history', 'History']];
        document.getElementById('tabBar').innerHTML = tabs.map(function (t) {
            return '<button class="tab-btn' + (t[0] === _tab ? ' active' : '') + '" onclick="skSetTab(\'' + t[0] + '\')">' + t[1] + '</button>';
        }).join('');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + _tab); });
    }
    function skSetTab(tab) { _tab = tab; _renderTabBar(); }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _loadSummary() {
        window.PracticeAPI.fetch(BASE + '/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                document.getElementById('notSeededMsg').style.display = d.seeded ? 'none' : 'block';
                var cards = [
                    { count: d.category_count, label: 'Categories' },
                    { count: d.skill_count, label: 'Skills' },
                    { count: d.expert_count, label: 'Expert Ratings' },
                    { count: d.advanced_count, label: 'Advanced Ratings' },
                    { count: d.training_needed_count, label: 'Training Needed' },
                    { count: d.certification_type_count, label: 'Certification Types' },
                    { count: d.certifications_expiring_soon, label: 'Expiring Soon' },
                    { count: d.certifications_expired, label: 'Expired' },
                ];
                document.getElementById('summaryGrid').innerHTML = cards.map(function (c) {
                    return '<div class="summary-card"><div class="sc-count">' + c.count + '</div><div class="sc-label">' + _html(c.label) + '</div></div>';
                }).join('');
            })
            .catch(function () {});
    }

    function skSeedDefaults() {
        window.PracticeAPI.fetch(BASE + '/seed-defaults', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast(d.already_seeded ? 'Already seeded.' : ('Seeded ' + d.categories_created + ' categories and ' + d.skills_created + ' skills.'));
                skLoadAll();
            })
            .catch(function () { _showToast('Failed to seed defaults.'); });
    }

    // ── Team list ─────────────────────────────────────────────────────────────

    function _loadTeam() {
        window.PracticeAPI.fetch(TEAM_BASE)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _teamList = d.members || [];
                var opts = '<option value="">Select…</option>' + _teamList.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('');
                document.getElementById('tcMember').innerHTML = opts;
                document.getElementById('tcfMember').innerHTML = '<option value="">Select…</option>' + _teamList.map(function (m) { return '<option value="' + m.id + '">' + _html(m.display_name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    // ── Categories ────────────────────────────────────────────────────────────

    function skLoadCategories() {
        window.PracticeAPI.fetch(BASE + '/categories')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _categories = d.categories || [];
                document.getElementById('categoryBody').innerHTML = _categories.length ? _categories.map(function (c) {
                    return '<tr class="clickable" onclick="skOpenCategory(' + c.id + ')"><td>' + _html(c.display_name) + '</td><td><code>' + _html(c.category_key) + '</code></td><td><button class="btn-action btn-secondary" onclick="event.stopPropagation();skOpenCategory(' + c.id + ')">Edit</button></td></tr>';
                }).join('') : '<tr><td colspan="3" class="empty-state">No categories yet.</td></tr>';

                var catOpts = '<option value="">— None —</option>' + _categories.map(function (c) { return '<option value="' + c.id + '">' + _html(c.display_name) + '</option>'; }).join('');
                document.getElementById('skCategory').innerHTML = catOpts;
                document.getElementById('skillCategoryFilter').innerHTML = '<option value="">All</option>' + _categories.map(function (c) { return '<option value="' + c.id + '">' + _html(c.display_name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    function skOpenCategory(id) {
        _editingCategoryId = id || null;
        var c = id ? _categories.filter(function (x) { return x.id === id; })[0] : null;
        document.getElementById('categoryModalTitle').textContent = id ? 'Edit Category' : 'Add Category';
        document.getElementById('catKey').value = c ? c.category_key : '';
        document.getElementById('catKey').disabled = !!id;
        document.getElementById('catName').value = c ? c.display_name : '';
        document.getElementById('catDesc').value = c ? (c.description || '') : '';
        document.getElementById('catArchiveBtn').style.display = id ? '' : 'none';
        document.getElementById('categoryModal').classList.add('open');
    }
    function skCloseCategory() { document.getElementById('categoryModal').classList.remove('open'); }

    function skSubmitCategory() {
        var name = document.getElementById('catName').value.trim();
        if (!name) return _showToast('Display name is required.');
        var payload = { display_name: name, description: document.getElementById('catDesc').value.trim() || null };
        var url = BASE + '/categories', method = 'POST';
        if (_editingCategoryId) { url += '/' + _editingCategoryId; method = 'PUT'; }
        else { payload.category_key = document.getElementById('catKey').value.trim(); if (!payload.category_key) return _showToast('Category key is required.'); }

        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Category saved.');
                skCloseCategory();
                skLoadCategories();
            })
            .catch(function () { _showToast('Failed to save category.'); });
    }

    function skArchiveCategory() {
        if (!_editingCategoryId || !confirm('Archive this category?')) return;
        window.PracticeAPI.fetch(BASE + '/categories/' + _editingCategoryId, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Category archived.'); skCloseCategory(); skLoadCategories(); })
            .catch(function () { _showToast('Failed to archive category.'); });
    }

    // ── Skills ────────────────────────────────────────────────────────────────

    function skLoadSkills() {
        var catId = document.getElementById('skillCategoryFilter').value;
        window.PracticeAPI.fetch(BASE + '/skills' + (catId ? '?category_id=' + catId : ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _skills = d.skills || [];
                document.getElementById('skillBody').innerHTML = _skills.length ? _skills.map(function (s) {
                    return '<tr class="clickable" onclick="skOpenSkill(' + s.id + ')"><td>' + _html(s.display_name) + '</td><td>' + _html(s.practice_skill_categories ? s.practice_skill_categories.display_name : '—') + '</td><td><button class="btn-action btn-secondary" onclick="event.stopPropagation();skOpenSkill(' + s.id + ')">Edit</button></td></tr>';
                }).join('') : '<tr><td colspan="3" class="empty-state">No skills yet.</td></tr>';
            })
            .catch(function () {});
    }

    function skOpenSkill(id) {
        _editingSkillId = id || null;
        var s = id ? _skills.filter(function (x) { return x.id === id; })[0] : null;
        document.getElementById('skillModalTitle').textContent = id ? 'Edit Skill' : 'Add Skill';
        document.getElementById('skKey').value = s ? s.skill_key : '';
        document.getElementById('skKey').disabled = !!id;
        document.getElementById('skName').value = s ? s.display_name : '';
        document.getElementById('skCategory').value = s ? (s.category_id || '') : '';
        document.getElementById('skDesc').value = s ? (s.description || '') : '';
        document.getElementById('skArchiveBtn').style.display = id ? '' : 'none';
        document.getElementById('skillModal').classList.add('open');
    }
    function skCloseSkill() { document.getElementById('skillModal').classList.remove('open'); }

    function skSubmitSkill() {
        var name = document.getElementById('skName').value.trim();
        if (!name) return _showToast('Display name is required.');
        var payload = { display_name: name, category_id: document.getElementById('skCategory').value || null, description: document.getElementById('skDesc').value.trim() || null };
        var url = BASE + '/skills', method = 'POST';
        if (_editingSkillId) { url += '/' + _editingSkillId; method = 'PUT'; }
        else { payload.skill_key = document.getElementById('skKey').value.trim(); if (!payload.skill_key) return _showToast('Skill key is required.'); }

        window.PracticeAPI.fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Skill saved.');
                skCloseSkill();
                skLoadSkills();
            })
            .catch(function () { _showToast('Failed to save skill.'); });
    }

    function skArchiveSkill() {
        if (!_editingSkillId || !confirm('Archive this skill?')) return;
        window.PracticeAPI.fetch(BASE + '/skills/' + _editingSkillId, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Skill archived.'); skCloseSkill(); skLoadSkills(); })
            .catch(function () { _showToast('Failed to archive skill.'); });
    }

    // ── Team Competency ───────────────────────────────────────────────────────

    function skLoadCompetency() {
        var memberId = document.getElementById('tcMember').value;
        var body = document.getElementById('competencyBody');
        if (!memberId) { body.innerHTML = '<tr><td colspan="7" class="empty-state">Select a team member.</td></tr>'; return; }
        body.innerHTML = '<tr><td colspan="7" class="empty-state">Loading…</td></tr>';

        window.PracticeAPI.fetch(BASE + '/team-skills?team_member_id=' + memberId)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var haveSkillIds = {};
                var rows = (d.team_skills || []).map(function (ts) {
                    haveSkillIds[ts.skill_id] = true;
                    return _competencyRow(ts.skill_id, ts.practice_skills ? ts.practice_skills.display_name : '#' + ts.skill_id, ts);
                });
                // Show every catalog skill, even ones this member has no record for yet (level 0, editable).
                _skills.forEach(function (s) {
                    if (!haveSkillIds[s.id]) rows.push(_competencyRow(s.id, s.display_name, null));
                });
                body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="7" class="empty-state">No skills in the catalog yet — seed defaults or add some.</td></tr>';
            })
            .catch(function () { body.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load.</td></tr>'; });
    }

    function _competencyRow(skillId, skillName, ts) {
        var level = ts ? ts.current_level : 0;
        var target = ts && ts.target_level != null ? ts.target_level : null;
        var flags = [];
        if (ts && ts.is_preferred) flags.push('<span class="pill badge-pref">Preferred</span>');
        if (ts && ts.is_restricted) flags.push('<span class="pill badge-restr">Restricted</span>');
        var catName = ts && ts.practice_skills ? '' : '';
        var payload = JSON.stringify({ id: ts ? ts.id : null, skill_id: skillId, skill_name: skillName, current_level: level, target_level: target, is_preferred: !!(ts && ts.is_preferred), is_restricted: !!(ts && ts.is_restricted), last_reviewed_date: ts ? ts.last_reviewed_date : null, review_notes: ts ? ts.review_notes : null }).replace(/'/g, '&#39;');
        return '<tr><td>' + _html(skillName) + '</td><td>' + _html(catName) + '</td><td>' + _levelPill(level) + '</td><td>' + (target != null ? _levelPill(target) : '—') + '</td><td>' + (flags.join(' ') || '—') + '</td><td>' + _fmtDate(ts ? ts.last_reviewed_date : null) + '</td>' +
            '<td><button class="btn-action btn-secondary" onclick=\'skOpenTeamSkill(' + payload + ')\'>Update</button></td></tr>';
    }

    function skOpenTeamSkill(ts) {
        _editingTeamSkill = ts;
        document.getElementById('tsSkillName').textContent = ts.skill_name;
        document.getElementById('tsCurrentLevel').value = ts.current_level || 0;
        document.getElementById('tsTargetLevel').value = ts.target_level != null ? ts.target_level : '';
        document.getElementById('tsPreferred').checked = !!ts.is_preferred;
        document.getElementById('tsRestricted').checked = !!ts.is_restricted;
        document.getElementById('tsLastReviewed').value = ts.last_reviewed_date || '';
        document.getElementById('tsNotes').value = ts.review_notes || '';
        document.getElementById('teamSkillModal').classList.add('open');
    }
    function skCloseTeamSkill() { document.getElementById('teamSkillModal').classList.remove('open'); }

    function skSubmitTeamSkill() {
        var memberId = document.getElementById('tcMember').value;
        if (!memberId) return _showToast('Select a team member first.');
        var payload = {
            team_member_id: memberId, skill_id: _editingTeamSkill.skill_id,
            current_level: document.getElementById('tsCurrentLevel').value,
            target_level: document.getElementById('tsTargetLevel').value || null,
            is_preferred: document.getElementById('tsPreferred').checked,
            is_restricted: document.getElementById('tsRestricted').checked,
            last_reviewed_date: document.getElementById('tsLastReviewed').value.trim() || null,
            review_notes: document.getElementById('tsNotes').value.trim() || null,
        };
        window.PracticeAPI.fetch(BASE + '/team-skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Competency updated.');
                skCloseTeamSkill();
                skLoadCompetency();
                _loadSummary();
                skLoadTraining();
            })
            .catch(function () { _showToast('Failed to update competency.'); });
    }

    // ── Certifications ────────────────────────────────────────────────────────

    function _loadCertTypes() {
        window.PracticeAPI.fetch(BASE + '/certifications')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                _certTypes = d.certifications || [];
                document.getElementById('certTypeBody').innerHTML = _certTypes.length ? _certTypes.map(function (c) {
                    return '<tr><td>' + _html(c.certification_name) + '</td><td>' + _html(c.issuer || '—') + '</td><td><button class="btn-action btn-danger" onclick="skArchiveCertType(' + c.id + ')">Archive</button></td></tr>';
                }).join('') : '<tr><td colspan="3" class="empty-state">No certification types yet.</td></tr>';
                document.getElementById('tcfCert').innerHTML = '<option value="">Select…</option>' + _certTypes.map(function (c) { return '<option value="' + c.id + '">' + _html(c.certification_name) + '</option>'; }).join('');
            })
            .catch(function () {});
    }

    function skOpenCertType() {
        document.getElementById('ctName').value = '';
        document.getElementById('ctIssuer').value = '';
        document.getElementById('ctDesc').value = '';
        document.getElementById('certTypeModal').classList.add('open');
    }
    function skCloseCertType() { document.getElementById('certTypeModal').classList.remove('open'); }

    function skSubmitCertType() {
        var name = document.getElementById('ctName').value.trim();
        if (!name) return _showToast('Name is required.');
        window.PracticeAPI.fetch(BASE + '/certifications', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ certification_name: name, issuer: document.getElementById('ctIssuer').value.trim() || null, description: document.getElementById('ctDesc').value.trim() || null }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Certification type added.');
                skCloseCertType();
                _loadCertTypes();
            })
            .catch(function () { _showToast('Failed to add certification type.'); });
    }

    function skArchiveCertType(id) {
        if (!confirm('Archive this certification type?')) return;
        window.PracticeAPI.fetch(BASE + '/certifications/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Archived.'); _loadCertTypes(); })
            .catch(function () { _showToast('Failed to archive.'); });
    }

    function skLoadTeamCerts() {
        window.PracticeAPI.fetch(BASE + '/team-certifications')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = d.team_certifications || [];
                document.getElementById('teamCertBody').innerHTML = rows.length ? rows.map(function (r) {
                    return '<tr><td>' + _html(r.team_member_name) + '</td><td>' + _html(r.practice_certifications ? r.practice_certifications.certification_name : '—') + '</td>' +
                        '<td><span class="pill st-' + _html(r.is_expired ? 'expired' : r.status) + '">' + _html(r.is_expired ? 'Expired' : r.status) + '</span></td>' +
                        '<td>' + _fmtDate(r.issue_date) + '</td><td>' + _fmtDate(r.expiry_date) + '</td>' +
                        '<td><button class="btn-action btn-danger" onclick="skArchiveTeamCert(' + r.id + ')">Archive</button></td></tr>';
                }).join('') : '<tr><td colspan="6" class="empty-state">No team certifications recorded yet.</td></tr>';
            })
            .catch(function () {});
    }

    function skOpenTeamCert() {
        document.getElementById('tcfMember').value = '';
        document.getElementById('tcfCert').value = '';
        document.getElementById('tcfIssue').value = '';
        document.getElementById('tcfExpiry').value = '';
        document.getElementById('tcfStatus').value = 'active';
        document.getElementById('tcfNumber').value = '';
        document.getElementById('tcfNotes').value = '';
        document.getElementById('teamCertModal').classList.add('open');
    }
    function skCloseTeamCert() { document.getElementById('teamCertModal').classList.remove('open'); }

    function skSubmitTeamCert() {
        var memberId = document.getElementById('tcfMember').value;
        var certId = document.getElementById('tcfCert').value;
        if (!memberId || !certId) return _showToast('Team member and certification are required.');
        window.PracticeAPI.fetch(BASE + '/team-certifications', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                team_member_id: memberId, certification_id: certId,
                issue_date: document.getElementById('tcfIssue').value.trim() || null,
                expiry_date: document.getElementById('tcfExpiry').value.trim() || null,
                status: document.getElementById('tcfStatus').value,
                certificate_number: document.getElementById('tcfNumber').value.trim() || null,
                notes: document.getElementById('tcfNotes').value.trim() || null,
            }),
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.error) { _showToast(d.error); return; }
                _showToast('Team certification added.');
                skCloseTeamCert();
                skLoadTeamCerts();
                _loadSummary();
            })
            .catch(function () { _showToast('Failed to add team certification.'); });
    }

    function skArchiveTeamCert(id) {
        if (!confirm('Archive this team certification record?')) return;
        window.PracticeAPI.fetch(BASE + '/team-certifications/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function () { _showToast('Archived.'); skLoadTeamCerts(); _loadSummary(); })
            .catch(function () { _showToast('Failed to archive.'); });
    }

    // ── Training Needs ────────────────────────────────────────────────────────

    function skLoadTraining() {
        window.PracticeAPI.fetch(BASE + '/team-skills')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var rows = (d.team_skills || []).filter(function (ts) { return ts.target_level != null && ts.target_level > ts.current_level; })
                    .sort(function (a, b) { return (b.target_level - b.current_level) - (a.target_level - a.current_level); });
                document.getElementById('trainingBody').innerHTML = rows.length ? rows.map(function (ts) {
                    return '<tr><td>' + _html(ts.team_member_name) + '</td><td>' + _html(ts.practice_skills ? ts.practice_skills.display_name : '—') + '</td>' +
                        '<td>' + _levelPill(ts.current_level) + '</td><td>' + _levelPill(ts.target_level) + '</td><td>' + (ts.target_level - ts.current_level) + '</td><td>' + _fmtDate(ts.last_reviewed_date) + '</td></tr>';
                }).join('') : '<tr><td colspan="6" class="empty-state">No training gaps recorded — set a target level above current level on the Team Competency tab to flag one.</td></tr>';
            })
            .catch(function () {});
    }

    // ── History ───────────────────────────────────────────────────────────────

    function skLoadHistory() {
        window.PracticeAPI.fetch(BASE + '/events')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var events = d.events || [];
                document.getElementById('historyBody').innerHTML = events.length ? events.map(function (e) {
                    return '<div style="background:#12122a;border-radius:8px;padding:10px 14px;margin-bottom:6px;"><div style="display:flex;gap:8px;align-items:center;"><span style="font-size:.78rem;font-weight:700;color:#a0aec0;">' + _html(EV_LABELS[e.event_type] || e.event_type) + '</span><span style="font-size:.72rem;color:#4a5568;margin-left:auto;">' + _fmt(e.created_at) + '</span></div>' +
                        (e.notes ? '<div style="font-size:.78rem;color:#718096;font-style:italic;">' + _html(e.notes) + '</div>' : '') + '</div>';
                }).join('') : '<div class="empty-state">No history yet.</div>';
            })
            .catch(function () {});
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    window.skLoadAll = skLoadAll;
    window.skSetTab = skSetTab;
    window.skSeedDefaults = skSeedDefaults;
    window.skLoadCategories = skLoadCategories;
    window.skOpenCategory = skOpenCategory;
    window.skCloseCategory = skCloseCategory;
    window.skSubmitCategory = skSubmitCategory;
    window.skArchiveCategory = skArchiveCategory;
    window.skLoadSkills = skLoadSkills;
    window.skOpenSkill = skOpenSkill;
    window.skCloseSkill = skCloseSkill;
    window.skSubmitSkill = skSubmitSkill;
    window.skArchiveSkill = skArchiveSkill;
    window.skLoadCompetency = skLoadCompetency;
    window.skOpenTeamSkill = skOpenTeamSkill;
    window.skCloseTeamSkill = skCloseTeamSkill;
    window.skSubmitTeamSkill = skSubmitTeamSkill;
    window.skOpenCertType = skOpenCertType;
    window.skCloseCertType = skCloseCertType;
    window.skSubmitCertType = skSubmitCertType;
    window.skArchiveCertType = skArchiveCertType;
    window.skLoadTeamCerts = skLoadTeamCerts;
    window.skOpenTeamCert = skOpenTeamCert;
    window.skCloseTeamCert = skCloseTeamCert;
    window.skSubmitTeamCert = skSubmitTeamCert;
    window.skArchiveTeamCert = skArchiveTeamCert;
    window.skLoadTraining = skLoadTraining;
    window.skLoadHistory = skLoadHistory;

    // ── Boot ─────────────────────────────────────────────────────────────────

    LAYOUT.onReady(function () {
        skLoadAll();
    });

}());
