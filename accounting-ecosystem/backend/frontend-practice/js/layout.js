/* ============================================================
   Lorenco Practice — Shared Layout
   Injects topbar + nav into #app-topbar and #app-nav.
   Call LAYOUT.init('page-key') after DOM ready.
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

    function init(activePage) {
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
            navEl.innerHTML = PAGES.map(function (p) {
                var cls = 'nav-tab' + (p.key === activePage ? ' active' : '');
                return '<a href="' + p.href + '" class="' + cls + '">' + p.label + '</a>';
            }).join('');
        }

        _loadBellCount();
    }

    // onReady exists so page scripts can defer their own data-load boot logic
    // until after init() has run, without assuming any particular load order.
    // init() above is fully synchronous, so this just invokes the callback now.
    function onReady(cb) { cb(); }

    window.LAYOUT = { init: init, onReady: onReady };
})();
