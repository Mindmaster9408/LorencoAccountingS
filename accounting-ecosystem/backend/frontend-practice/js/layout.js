/* ============================================================
   Lorenco Practice — Shared Layout
   Injects topbar + nav into #app-topbar and #app-nav.
   Call LAYOUT.init('page-key') after DOM ready.

   Codebox 80 — Navigation/UX Consolidation. The nav below used to render
   as one flat list of ~66 links that wrapped into an unreadable multi-line
   block. It is now grouped into 9 dropdown menus. CSS for the new nav is
   injected by this file itself (not practice.css) — same reasoning as
   _renderBell()'s inline styling below: layout.js is shared by every
   Practice page and must render correctly regardless of which stylesheet
   (if any) a given page links.
   ============================================================ */
(function () {
    var PAGES = [
        { key: 'dashboard',   label: 'Dashboard',   href: '/practice/index.html' },
        { key: 'management-dashboard', label: 'Management Dashboard', href: '/practice/management-dashboard.html' },
        { key: 'planning-board', label: 'Planning Board', href: '/practice/planning-board.html' },
        { key: 'resource-forecasting', label: 'Resource Forecast', href: '/practice/resource-forecasting.html' },
        { key: 'work-queue', label: 'My Work', href: '/practice/work-queue.html' },
        { key: 'delegation', label: 'Delegation', href: '/practice/delegation.html' },
        { key: 'skills-matrix', label: 'Skills Matrix', href: '/practice/skills-matrix.html' },
        { key: 'learning-centre', label: 'Learning Centre', href: '/practice/learning-centre.html' },
        { key: 'client-success', label: 'Client Success', href: '/practice/client-success.html' },
        { key: 'secretarial', label: 'Secretarial', href: '/practice/secretarial.html' },
        { key: 'secretarial-workflows', label: 'Secretarial Changes', href: '/practice/secretarial-workflows.html' },
        { key: 'secretarial-governance', label: 'Secretarial Governance', href: '/practice/secretarial-governance.html' },
        { key: 'beneficial-ownership', label: 'Beneficial Ownership', href: '/practice/beneficial-ownership.html' },
        { key: 'secretarial-evidence', label: 'Secretarial Evidence', href: '/practice/secretarial-evidence.html' },
        { key: 'secretarial-calendar', label: 'Statutory Calendar', href: '/practice/secretarial-calendar.html' },
        { key: 'entity-lifecycle', label: 'Entity Lifecycle', href: '/practice/entity-lifecycle.html' },
        { key: 'secretarial-integrity', label: 'Secretarial Integrity', href: '/practice/secretarial-integrity.html' },
        { key: 'client-onboarding', label: 'Client Onboarding', href: '/practice/client-onboarding.html' },
        { key: 'engagement-management', label: 'Engagement Management', href: '/practice/engagement-management.html' },
        { key: 'work-authorization', label: 'Work Authorization', href: '/practice/work-authorization.html' },
        { key: 'profitability', label: 'Profitability', href: '/practice/profitability.html' },
        { key: 'pricing-review', label: 'Pricing Reviews', href: '/practice/pricing-review.html' },
        { key: 'partner-scorecards', label: 'Partner Scorecards', href: '/practice/partner-scorecards.html' },
        { key: 'strategic-planning', label: 'Strategic Planning', href: '/practice/strategic-planning.html' },
        { key: 'kpi-history', label: 'KPI History', href: '/practice/kpi-history.html' },
        { key: 'partner-review-packs', label: 'Partner Review Packs', href: '/practice/partner-review-packs.html' },
        { key: 'executive-reporting', label: 'Executive Reporting', href: '/practice/executive-reporting.html' },
        { key: 'automation', label: 'Automation', href: '/practice/automation.html' },
        { key: 'operational-health', label: 'Operational Health', href: '/practice/operational-health.html' },
        { key: 'pilot-readiness', label: 'Pilot Readiness', href: '/practice/pilot-readiness.html' },
        { key: 'alert-rules', label: 'Alert Rules', href: '/practice/alert-rules.html' },
        { key: 'notifications', label: 'Notifications', href: '/practice/notifications.html' },
        { key: 'profile',     label: 'Profile',     href: '/practice/profile.html' },
        { key: 'team',        label: 'Team',        href: '/practice/team.html' },
        { key: 'clients',    label: 'Clients',    href: '/practice/clients.html' },
        { key: 'services',   label: 'Services',   href: '/practice/services.html' },
        { key: 'workflows',  label: 'Workflows',  href: '/practice/workflows.html' },
        { key: 'compliance',  label: 'Compliance',  href: '/practice/compliance.html' },
        { key: 'tasks',       label: 'Tasks',       href: '/practice/tasks.html' },
        { key: 'time',        label: 'Time',        href: '/practice/time.html' },
        { key: 'billing',     label: 'Billing',     href: '/practice/billing.html' },
        { key: 'deadlines',   label: 'Deadlines',   href: '/practice/deadlines.html' },
        { key: 'period-queue', label: 'Period Queue', href: '/practice/engagement-periods.html' },
        { key: 'capacity',      label: 'Capacity',      href: '/practice/capacity.html' },
        { key: 'client-health', label: 'Client Health', href: '/practice/client-health.html' },
        { key: 'reminders',       label: 'Reminders',       href: '/practice/reminders.html' },
        { key: 'communications',  label: 'Communications',  href: '/practice/communications.html' },
        { key: 'documents',         label: 'Documents',         href: '/practice/document-requests.html' },
        { key: 'compliance-packs',   label: 'Compliance Packs',   href: '/practice/compliance-packs.html' },
        { key: 'taxpayer-profiles',  label: 'Taxpayer Profiles',  href: '/practice/taxpayer-profiles.html' },
        { key: 'provisional-tax',    label: 'Provisional Tax',    href: '/practice/provisional-tax.html' },
        { key: 'individual-tax',     label: 'Individual Tax',     href: '/practice/individual-tax.html' },
        { key: 'company-tax',        label: 'Company Tax',        href: '/practice/company-tax.html' },
        { key: 'tax-dashboard',      label: 'Tax Dashboard',      href: '/practice/tax-dashboard.html' },
        { key: 'tax-actions',        label: 'Tax Actions',        href: '/practice/tax-actions.html' },
        { key: 'tax-checklists',     label: 'Tax Checklists',     href: '/practice/tax-checklists.html' },
        { key: 'tax-bulk-ops',       label: 'Tax Bulk Ops',       href: '/practice/tax-bulk-operations.html' },
        { key: 'tax-reports',        label: 'Tax Reports',        href: '/practice/tax-reports.html' },
        { key: 'tax-pipeline',       label: 'Tax Pipeline',       href: '/practice/tax-pipeline.html' },
        { key: 'tax-submissions',    label: 'Tax Submissions',    href: '/practice/tax-submissions.html' },
        { key: 'tax-payments',       label: 'Tax Payments',       href: '/practice/tax-payments.html' },
        { key: 'sars-recon',         label: 'SARS Recon',         href: '/practice/sars-recon.html' },
        { key: 'tax-disputes',        label: 'Tax Disputes',        href: '/practice/tax-disputes.html' },
        { key: 'tax-completion',     label: 'Tax Completion',     href: '/practice/tax-completion.html' },
        { key: 'knowledge-base',     label: 'Knowledge Base',     href: '/practice/knowledge-base.html' },
        { key: 'practice-sop',       label: 'Practice SOPs',      href: '/practice/practice-sop.html' },
        { key: 'quality',            label: 'Quality',            href: '/practice/quality-management.html' },
        { key: 'risk-register',      label: 'Risk Register',      href: '/practice/risk-register.html' },
        { key: 'tax-configs',        label: 'Tax Config',         href: '/practice/tax-configs.html' }
    ];

    var PAGES_BY_KEY = {};
    PAGES.forEach(function (p) { PAGES_BY_KEY[p.key] = p; });

    // Codebox 80 — grouped navigation. Every existing PAGES key must appear
    // in exactly one group (no route removed, no route dropped from nav).
    // Groups/order match the spec exactly; the 6 pre-existing pages the
    // spec's own group lists didn't name (workflows, compliance, tasks,
    // billing, period-queue, client-health) are folded into the closest-fit
    // existing group rather than inventing a 10th "Other" bucket.
    var NAV_GROUPS = [
        { label: 'Dashboard', icon: '🏠', keys: ['dashboard', 'management-dashboard', 'work-queue', 'notifications'] },
        { label: 'Operations', icon: '⚙️', keys: ['planning-board', 'resource-forecasting', 'capacity', 'delegation', 'work-queue', 'workflows', 'tasks', 'reminders', 'communications', 'documents', 'time', 'billing', 'period-queue'] },
        { label: 'Clients', icon: '👥', keys: ['clients', 'client-success', 'client-onboarding', 'client-health', 'engagement-management', 'work-authorization', 'profitability', 'pricing-review'] },
        { label: 'Secretarial & Governance', icon: '🏛️', keys: ['secretarial', 'secretarial-workflows', 'secretarial-governance', 'beneficial-ownership', 'secretarial-evidence', 'secretarial-calendar', 'entity-lifecycle', 'secretarial-integrity'] },
        { label: 'People & Practice', icon: '🧑‍💼', keys: ['team', 'profile', 'skills-matrix', 'learning-centre', 'services'] },
        { label: 'Compliance & Tax', icon: '📊', keys: ['deadlines', 'compliance', 'compliance-packs', 'tax-dashboard', 'tax-actions', 'tax-checklists', 'tax-bulk-ops', 'tax-reports', 'tax-pipeline', 'tax-submissions', 'tax-payments', 'sars-recon', 'tax-disputes', 'tax-completion', 'taxpayer-profiles', 'provisional-tax', 'individual-tax', 'company-tax', 'tax-configs'] },
        { label: 'Quality & Risk', icon: '🛡️', keys: ['quality', 'risk-register', 'knowledge-base', 'practice-sop'] },
        { label: 'Strategy & Executive', icon: '🎯', keys: ['kpi-history', 'partner-review-packs', 'partner-scorecards', 'strategic-planning', 'executive-reporting', 'automation', 'operational-health', 'pilot-readiness', 'alert-rules'] }
    ];

    // Reduced group set shown to non-manager staff — UX only, never a
    // security boundary (backend manager-gating via lib/team-access.js is
    // unchanged and remains the sole authorization check). Staff still see
    // every OTHER group's pages if they navigate there directly by URL —
    // this only trims which dropdowns render by default.
    var STAFF_GROUP_LABELS = ['Dashboard', 'Clients'];

    function escHtml(str) {
        var d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }

    function getCompanyName() {
        try {
            var raw = localStorage.getItem('company');
            if (!raw) return 'Practice';
            var c = JSON.parse(raw);
            return c.trading_name || c.company_name || 'Practice';
        } catch (e) {
            return 'Practice';
        }
    }

    // Codebox 54 — Notification bell. Inline-styled (not dependent on
    // /practice/css/layout.css resolving) since layout.js is shared by every
    // Practice page and must render correctly regardless of that stylesheet.
    // "No live websocket. Refresh on load." per spec — one summary fetch per
    // page load, no polling.
    function _renderBell(activePage) {
        var active = activePage === 'notifications';
        return '<a href="/practice/notifications.html" title="Notifications" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;background:' +
            (active ? 'rgba(167,139,250,0.2)' : 'rgba(167,139,250,0.1)') +
            ';border:1px solid rgba(167,139,250,0.25);color:#a78bfa;text-decoration:none;font-size:16px;">' +
            '🔔<span id="notifBellBadge" style="display:none;position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#e53e3e;color:#fff;font-size:.65rem;font-weight:700;line-height:16px;text-align:center;">0</span>' +
            '</a>';
    }

    function _loadBellCount() {
        if (!window.PracticeAPI || !window.PracticeAPI.fetch) return;
        window.PracticeAPI.fetch('/api/practice/notifications/summary')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var badge = document.getElementById('notifBellBadge');
                if (!badge) return;
                var count = d.unread_count || 0;
                if (count > 0) {
                    badge.textContent = count > 99 ? '99+' : String(count);
                    badge.style.display = 'block';
                } else {
                    badge.style.display = 'none';
                }
            })
            .catch(function () { /* non-fatal — bell just shows no badge */ });
    }

    // ── Codebox 80 — Grouped nav CSS (injected once, works with or without
    // practice.css / the page's own embedded styles) ───────────────────────

    var NAV_CSS_ID = 'lorenco-practice-nav-css';
    function _injectNavCss() {
        if (document.getElementById(NAV_CSS_ID)) return;
        var style = document.createElement('style');
        style.id = NAV_CSS_ID;
        style.textContent =
            '.lp-nav{display:flex;flex-wrap:wrap;gap:4px;padding:8px 24px;background:rgba(0,0,0,0.25);border-bottom:1px solid rgba(255,255,255,0.08);position:relative;z-index:90;font-family:"Segoe UI",Inter,sans-serif;}' +
            '.lp-nav-group{position:relative;}' +
            '.lp-nav-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;background:transparent;border:none;color:rgba(245,240,255,0.75);font-size:0.85rem;font-weight:600;cursor:pointer;border-radius:8px;white-space:nowrap;}' +
            '.lp-nav-btn:hover,.lp-nav-btn.lp-open{background:rgba(167,139,250,0.15);color:#f5f0ff;}' +
            '.lp-nav-btn.lp-active{color:#a78bfa;background:rgba(167,139,250,0.12);}' +
            '.lp-caret{font-size:0.6rem;opacity:0.7;}' +
            '.lp-dropdown{display:none;position:absolute;top:100%;left:0;margin-top:4px;min-width:220px;max-width:320px;background:#1a1330;border:1px solid rgba(255,255,255,0.1);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,0.5);padding:6px;z-index:200;max-height:70vh;overflow-y:auto;}' +
            '.lp-dropdown.lp-open{display:block;}' +
            '.lp-dropdown a{display:block;padding:8px 12px;border-radius:7px;color:rgba(245,240,255,0.85);text-decoration:none;font-size:0.82rem;white-space:nowrap;}' +
            '.lp-dropdown a:hover{background:rgba(167,139,250,0.15);color:#fff;}' +
            '.lp-dropdown a.lp-active-link{color:#a78bfa;font-weight:700;background:rgba(167,139,250,0.1);}' +
            '@media (max-width:900px){.lp-nav{overflow-x:auto;flex-wrap:nowrap;}}';
        document.head.appendChild(style);
    }

    // ── Grouped nav rendering ────────────────────────────────────────────────

    function _groupContainsActive(group, activePage) {
        return group.keys.indexOf(activePage) !== -1;
    }

    function _renderGroup(group, activePage) {
        var isActiveGroup = _groupContainsActive(group, activePage);
        var links = group.keys.map(function (key) {
            var page = PAGES_BY_KEY[key];
            if (!page) return ''; // defensive — never throws if a key is mistyped
            var cls = key === activePage ? ' class="lp-active-link"' : '';
            return '<a href="' + page.href + '"' + cls + '>' + escHtml(page.label) + '</a>';
        }).join('');
        var btnCls = 'lp-nav-btn' + (isActiveGroup ? ' lp-active' : '');
        return '<div class="lp-nav-group" data-group="' + escHtml(group.label) + '">' +
            '<button type="button" class="' + btnCls + '" onclick="LAYOUT._toggleGroup(this)">' +
                '<span>' + group.icon + '</span><span>' + escHtml(group.label) + '</span><span class="lp-caret">▾</span>' +
            '</button>' +
            '<div class="lp-dropdown">' + links + '</div>' +
        '</div>';
    }

    function _renderNav(activePage, groupsToShow) {
        return groupsToShow.map(function (g) { return _renderGroup(g, activePage); }).join('');
    }

    function _toggleGroup(btn) {
        var wrap = btn.parentElement;
        var dropdown = wrap.querySelector('.lp-dropdown');
        var wasOpen = dropdown.classList.contains('lp-open');
        // Close every other open dropdown first — only one open at a time.
        document.querySelectorAll('.lp-dropdown.lp-open').forEach(function (d) { d.classList.remove('lp-open'); });
        document.querySelectorAll('.lp-nav-btn.lp-open').forEach(function (b) { b.classList.remove('lp-open'); });
        if (!wasOpen) {
            dropdown.classList.add('lp-open');
            btn.classList.add('lp-open');
        }
    }

    function _closeAllOnOutsideClick(e) {
        if (e.target.closest && e.target.closest('.lp-nav-group')) return;
        document.querySelectorAll('.lp-dropdown.lp-open').forEach(function (d) { d.classList.remove('lp-open'); });
        document.querySelectorAll('.lp-nav-btn.lp-open').forEach(function (b) { b.classList.remove('lp-open'); });
    }

    // Codebox 80 — role-aware nav (UX only, never a security boundary; the
    // backend's manager gate via lib/team-access.js is unchanged and is the
    // only real authorization check). Renders the full nav first (the safe
    // default — fails open, never closed, if this check is slow/fails), then
    // trims to the reduced staff group set only if the current user is
    // confirmed non-manager.
    function _applyRoleAwareNav(activePage, navEl) {
        if (!window.PracticeAPI || !window.PracticeAPI.fetch) return;
        window.PracticeAPI.fetch('/api/practice/team/me')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.is_manager) return; // full nav already rendered — nothing to trim
                var staffGroups = NAV_GROUPS.filter(function (g) { return STAFF_GROUP_LABELS.indexOf(g.label) !== -1; });
                navEl.innerHTML = _renderNav(activePage, staffGroups);
            })
            .catch(function () { /* non-fatal — full nav remains visible */ });
    }

    function init(activePage) {
        _injectNavCss();
        var companyName = getCompanyName();

        var topbarEl = document.getElementById('app-topbar');
        if (topbarEl) {
            topbarEl.innerHTML =
                '<div class="topbar-left">' +
                    '<div class="app-icon">📋</div>' +
                    '<div>' +
                        '<div class="app-title">Lorenco Practice</div>' +
                        '<div class="app-subtitle">Practice Management</div>' +
                    '</div>' +
                '</div>' +
                '<div class="topbar-right">' +
                    '<span class="company-badge">' + escHtml(companyName) + '</span>' +
                    _renderBell(activePage) +
                    '<a href="/dashboard" class="btn-back">← ECO Hub</a>' +
                '</div>';
        }

        var navEl = document.getElementById('app-nav');
        if (navEl) {
            navEl.classList.add('lp-nav');
            navEl.innerHTML = _renderNav(activePage, NAV_GROUPS);
            document.addEventListener('click', _closeAllOnOutsideClick);
            _applyRoleAwareNav(activePage, navEl);
        }

        _loadBellCount();
    }

    // onReady exists so page scripts can defer their own data-load boot logic
    // until after init() has run, without assuming any particular load order.
    // init() above is fully synchronous, so this just invokes the callback now.
    function onReady(cb) { cb(); }

    window.LAYOUT = { init: init, onReady: onReady, _toggleGroup: _toggleGroup };
})();
