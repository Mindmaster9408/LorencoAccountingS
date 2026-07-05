/* ============================================================
   Lorenco Practice — Shared Layout
   Injects topbar + nav into #app-topbar and #app-nav.
   Call LAYOUT.init('page-key') after DOM ready.

   Codebox 80 — Navigation/UX Consolidation. The nav used to render as one
   flat list of ~66 links that wrapped into an unreadable multi-line block.
   Grouped into 9 dropdown menus.

   Codebox 80A — Navigation UX Hardening + Mega Menu Consolidation. Pure
   UI/UX refactor of the same renderer — no route, endpoint, permission, or
   database change. PAGES and NAV_GROUPS below are byte-for-byte the same
   routes as Codebox 80 (audited, not reshuffled) — only the interaction
   layer (single-open-at-a-time via delegation instead of inline onclick,
   keyboard nav, ESC, animated open/close), search, and responsive behavior
   (tablet icon-only, mobile hamburger+accordion reusing the exact same
   rendered markup) are new. CSS is still self-injected by this file — same
   reasoning as _renderBell()'s inline styling below: layout.js is shared
   by every Practice page and must render correctly regardless of which
   stylesheet (if any) a given page links.

   Codebox 80B — Enterprise Header & Navigation Polish. Presentation-only:
   no route/endpoint/permission/database change, NAV_GROUPS page membership
   unchanged. Audit found the real cause of "too much vertical space": of
   the 42 pages that call LAYOUT.init(), 36 link a dead stylesheet path
   (/practice/css/layout.css, confirmed absent from disk — a pre-existing
   dead link documented back in Codebox 80's own handoff) and so load ZERO
   topbar CSS — #app-topbar rendered as unstyled stacked block elements
   with no height cap, no sticky, no flex layout. The topbar's CSS is now
   self-injected by this file too (same reasoning as the nav CSS below),
   which fixes that root cause universally instead of only for the 6 pages
   that happen to link the real practice.css. Header and nav are now a
   fixed, tightened, stacked sticky pair (header on top, nav pinned
   directly beneath it via a shared --lp-topbar-h custom property) so page
   content starts immediately below regardless of which stylesheet (if
   any) a page links. Dropdown items are now grouped into sections with
   thin visual dividers for scannability on the larger menus — this
   reorders items WITHIN a group for readability only; no page moved to a
   different top-level group.
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

    // Same 8 groups/top-level page membership as Codebox 80 — audited, not
    // reshuffled. The hardening spec's own group-name example (Operations/
    // Clients/Secretarial/People/Compliance/Quality/Executive/Alerts/
    // Settings) is illustrative, not literal: this app has no distinct
    // "Settings" area beyond Profile (already in People & Practice) and no
    // content that would justify splitting Alert Rules out of Strategy &
    // Executive into its own near-empty group. Introducing empty/near-empty
    // groups would be worse UX, not better — documented Architect-Freedom
    // judgment call.
    //
    // Codebox 80B — each group's flat `keys` list is now split into
    // `sections` (thin dividers rendered between them in the dropdown) for
    // the larger groups, per the spec's own Operations example. This only
    // reorders/clusters items WITHIN a group for scannability — the set of
    // pages belonging to each top-level group is unchanged (verified by the
    // coverage-diff script, which flattens every `keys:[...]` occurrence
    // regardless of nesting).
    var NAV_GROUPS = [
        { label: 'Dashboard', icon: '🏠', sections: [
            { keys: ['dashboard', 'management-dashboard'] },
            { keys: ['work-queue', 'notifications'] }
        ] },
        { label: 'Operations', icon: '⚙️', sections: [
            { keys: ['planning-board', 'work-queue', 'tasks'] },
            { keys: ['capacity', 'resource-forecasting'] },
            { keys: ['workflows', 'period-queue', 'delegation'] },
            { keys: ['billing', 'time'] },
            { keys: ['reminders', 'communications', 'documents'] }
        ] },
        { label: 'Clients', icon: '👥', sections: [
            { keys: ['clients', 'client-onboarding', 'client-success', 'client-health'] },
            { keys: ['engagement-management', 'work-authorization'] },
            { keys: ['profitability', 'pricing-review'] }
        ] },
        { label: 'Secretarial & Governance', icon: '🏛️', sections: [
            { keys: ['secretarial', 'secretarial-workflows', 'secretarial-integrity'] },
            { keys: ['secretarial-governance', 'beneficial-ownership', 'secretarial-evidence'] },
            { keys: ['secretarial-calendar', 'entity-lifecycle'] }
        ] },
        { label: 'People & Practice', icon: '🧑‍💼', sections: [
            { keys: ['team', 'profile', 'services'] },
            { keys: ['skills-matrix', 'learning-centre'] }
        ] },
        { label: 'Compliance & Tax', icon: '📊', sections: [
            { keys: ['deadlines', 'compliance', 'compliance-packs'] },
            { keys: ['tax-dashboard', 'tax-actions', 'tax-checklists', 'tax-bulk-ops', 'tax-pipeline', 'tax-reports'] },
            { keys: ['taxpayer-profiles', 'provisional-tax', 'individual-tax', 'company-tax', 'tax-configs'] },
            { keys: ['tax-submissions', 'tax-payments', 'sars-recon', 'tax-disputes', 'tax-completion'] }
        ] },
        { label: 'Quality & Risk', icon: '🛡️', sections: [
            { keys: ['quality', 'risk-register', 'knowledge-base', 'practice-sop'] }
        ] },
        { label: 'Strategy & Executive', icon: '🎯', sections: [
            { keys: ['strategic-planning', 'partner-scorecards', 'kpi-history', 'partner-review-packs'] },
            { keys: ['executive-reporting', 'automation'] },
            { keys: ['operational-health', 'pilot-readiness', 'alert-rules'] }
        ] }
    ];

    function _groupKeys(group) {
        var out = [];
        group.sections.forEach(function (s) { out = out.concat(s.keys); });
        return out;
    }

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

    // ── Codebox 80B — Header + Nav CSS (injected once; works with or
    // without practice.css / the page's own embedded styles) ───────────────
    // Header and nav are stacked sticky elements — header pinned at
    // top:0, nav pinned directly beneath it at top:var(--lp-topbar-h) — so
    // the two heights must stay in lockstep. --lp-topbar-h is the single
    // source of truth for that offset, overridden per breakpoint below
    // rather than duplicated as a magic number in two places.
    //
    // .topbar is now defined HERE rather than relying solely on
    // practice.css: the audit found 36 of the 42 pages that call
    // LAYOUT.init() link a dead stylesheet path (/practice/css/layout.css,
    // confirmed absent from disk) and therefore loaded ZERO topbar CSS —
    // #app-topbar rendered as unstyled stacked block elements with no
    // height cap and no sticky positioning, which is the real cause of
    // "too much vertical space / content below the fold." Self-injecting
    // fixes it universally, the same reasoning _renderBell() and the nav
    // CSS below already use. Where a page's linked practice.css also
    // defines `.topbar`, this rule wins on source order (this <style> is
    // appended to <head> after any linked stylesheet), keeping behavior
    // identical across every page regardless of which (if any) stylesheet
    // it links — one deterministic layout, not 42 independent ones.
    //
    // Mega menu capped at 280-340px per spec. Dropdown open/close is
    // animated via opacity+transform (never display:none, so the
    // transition can actually play). Tablet hides button label text
    // (icon+caret only — "collapsed groups"); mobile hides the whole
    // group row behind a hamburger and re-flows dropdowns to be static/
    // stacked (same rendered markup, no second render path).

    var NAV_CSS_ID = 'lorenco-practice-nav-css';
    function _injectNavCss() {
        if (document.getElementById(NAV_CSS_ID)) return;
        var style = document.createElement('style');
        style.id = NAV_CSS_ID;
        style.textContent =
            ':root{--lp-topbar-h:50px;}' +
            // Header — tightened, sticky, self-contained
            '.topbar{display:flex;align-items:center;justify-content:space-between;height:var(--lp-topbar-h);padding:0 24px;background:rgba(0,0,0,0.4);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;z-index:110;font-family:"Segoe UI",Inter,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.2);}' +
            '.topbar-left{display:flex;align-items:center;gap:10px;min-width:0;}' +
            '.topbar .app-icon{width:30px;height:30px;flex:0 0 auto;background:linear-gradient(135deg,#a78bfa,#7c3aed);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px;}' +
            '.topbar .app-title{font-size:0.95rem;font-weight:700;letter-spacing:-0.2px;line-height:1.2;color:#f5f0ff;}' +
            '.topbar .app-subtitle{font-size:0.65rem;color:rgba(245,240,255,0.5);text-transform:uppercase;letter-spacing:0.06em;line-height:1.2;}' +
            '.topbar-right{display:flex;align-items:center;gap:10px;flex:0 0 auto;}' +
            '.topbar .company-badge{padding:4px 11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:20px;font-size:0.74rem;color:rgba(245,240,255,0.55);white-space:nowrap;}' +
            '.topbar .btn-back{padding:6px 13px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);color:#a78bfa;border-radius:9px;cursor:pointer;font-size:0.74rem;font-weight:600;text-decoration:none;white-space:nowrap;transition:background .15s ease;}' +
            '.topbar .btn-back:hover{background:rgba(167,139,250,0.2);}' +
            // Nav — pinned directly beneath the header, tightened padding
            // overflow:visible is explicit and load-bearing: 16 of the 71 pages
            // still carry the legacy class="nav-tabs" on #app-nav (harmless
            // relic from before the grouped nav existed), and practice.css's
            // .nav-tabs{overflow-x:auto} auto-computes overflow-y:auto too per
            // the CSS spec, which would clip the absolutely-positioned
            // .lp-dropdown menus on exactly those 16 pages if not overridden.
            '.lp-nav{display:flex;align-items:center;gap:4px;padding:4px 24px;background:rgba(0,0,0,0.25);border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:var(--lp-topbar-h);z-index:100;font-family:"Segoe UI",Inter,sans-serif;overflow:visible;}' +
            '.lp-hamburger{display:none;background:transparent;border:1px solid rgba(255,255,255,0.12);color:#f5f0ff;border-radius:8px;width:34px;height:34px;font-size:15px;cursor:pointer;flex:0 0 auto;}' +
            '.lp-nav-groups{display:flex;align-items:center;gap:2px;flex-wrap:nowrap;}' +
            '.lp-nav-group{position:relative;}' +
            '.lp-nav-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;background:transparent;border:none;color:rgba(245,240,255,0.72);font-size:0.82rem;font-weight:600;cursor:pointer;border-radius:8px;white-space:nowrap;transition:background .15s ease,color .15s ease;}' +
            '.lp-btn-icon{display:inline-flex;width:16px;justify-content:center;flex:0 0 auto;}' +
            '.lp-nav-btn:hover,.lp-nav-btn.lp-open{background:rgba(167,139,250,0.14);color:#f5f0ff;}' +
            '.lp-nav-btn.lp-active{color:#a78bfa;background:rgba(167,139,250,0.11);}' +
            '.lp-nav-btn:focus-visible{outline:2px solid #a78bfa;outline-offset:1px;}' +
            '.lp-caret{font-size:0.6rem;opacity:0.65;transition:transform .15s ease;}' +
            '.lp-nav-btn.lp-open .lp-caret{transform:rotate(180deg);}' +
            '.lp-dropdown{position:absolute;top:100%;left:0;margin-top:6px;min-width:230px;max-width:340px;background:#1a1330;border:1px solid rgba(255,255,255,0.1);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,0.5);padding:6px;z-index:200;max-height:70vh;overflow-y:auto;' +
                'opacity:0;visibility:hidden;transform:translateY(-6px);pointer-events:none;transition:opacity .12s ease,transform .12s ease,visibility 0s linear .12s;}' +
            '.lp-dropdown.lp-open{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition:opacity .12s ease,transform .12s ease;}' +
            '.lp-dropdown a{display:block;padding:9px 12px;border-radius:7px;color:rgba(245,240,255,0.85);text-decoration:none;font-size:0.82rem;white-space:nowrap;transition:background .1s ease;}' +
            '.lp-dropdown a:hover,.lp-dropdown a:focus-visible{background:rgba(167,139,250,0.16);color:#fff;outline:none;}' +
            '.lp-dropdown a.lp-active-link{color:#a78bfa;font-weight:700;background:rgba(167,139,250,0.1);}' +
            '.lp-dropdown-divider{height:1px;background:rgba(255,255,255,0.08);margin:5px 6px;}' +
            // Search
            '.lp-search-wrap{position:relative;margin-left:auto;flex:0 0 auto;}' +
            '.lp-search-input{width:190px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#f5f0ff;padding:7px 10px;font-size:0.8rem;transition:width .15s ease,border-color .15s ease;}' +
            '.lp-search-input:focus{width:240px;border-color:#a78bfa;outline:none;}' +
            '.lp-search-results{position:absolute;top:100%;right:0;margin-top:6px;width:280px;background:#1a1330;border:1px solid rgba(255,255,255,0.1);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,0.5);padding:6px;z-index:210;max-height:60vh;overflow-y:auto;' +
                'opacity:0;visibility:hidden;transform:translateY(-6px);pointer-events:none;transition:opacity .12s ease,transform .12s ease;}' +
            '.lp-search-results.lp-open{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;}' +
            '.lp-search-results a{display:block;padding:8px 12px;border-radius:7px;color:rgba(245,240,255,0.85);text-decoration:none;font-size:0.82rem;}' +
            '.lp-search-results a:hover,.lp-search-results a:focus-visible{background:rgba(167,139,250,0.16);color:#fff;outline:none;}' +
            '.lp-search-empty{padding:10px 12px;font-size:0.78rem;color:rgba(245,240,255,0.4);}' +
            // Tablet — compact spacing + collapse group labels to icon+caret only
            '@media (max-width:1100px){' +
                ':root{--lp-topbar-h:46px;}' +
                '.topbar{padding:0 16px;}' +
                '.topbar .company-badge{display:none;}' +
                '.lp-nav{padding:3px 16px;}' +
                '.lp-nav-btn .lp-btn-label{display:none;}.lp-nav-btn{padding:8px 10px;}.lp-search-input{width:130px;}.lp-search-input:focus{width:180px;}' +
            '}' +
            // Mobile — existing hamburger + stacked/static accordion using the SAME markup
            '@media (max-width:700px){' +
                ':root{--lp-topbar-h:44px;}' +
                '.topbar{padding:0 12px;}' +
                '.topbar .app-subtitle{display:none;}' +
                '.lp-nav{padding:3px 12px;}' +
                '.lp-hamburger{display:inline-flex;align-items:center;justify-content:center;}' +
                '.lp-nav-groups{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:stretch;background:#160f26;border-bottom:1px solid rgba(255,255,255,0.1);padding:8px;max-height:80vh;overflow-y:auto;z-index:150;}' +
                '.lp-nav.lp-mobile-open .lp-nav-groups{display:flex;}' +
                '.lp-nav-btn{width:100%;justify-content:flex-start;}' +
                '.lp-nav-btn .lp-btn-label{display:inline;}' +
                '.lp-dropdown{position:static;box-shadow:none;border:none;background:rgba(255,255,255,0.03);margin:2px 0 6px;max-width:none;transform:none;max-height:none;}' +
                '.lp-dropdown.lp-open,.lp-dropdown{transition:none;}' +
                '.lp-search-wrap{margin:0 0 8px;width:100%;order:-1;}' +
                '.lp-search-input{width:100%;}' +
                '.lp-search-input:focus{width:100%;}' +
                '.lp-search-results{position:static;width:100%;box-shadow:none;margin-top:4px;}' +
            '}';
        document.head.appendChild(style);
    }

    // ── Grouped nav rendering — one renderer, reused at every breakpoint ────

    function _groupContainsActive(group, activePage) {
        return _groupKeys(group).indexOf(activePage) !== -1;
    }

    function _renderGroup(group, activePage) {
        var isActiveGroup = _groupContainsActive(group, activePage);
        var links = group.sections.map(function (section) {
            return section.keys.map(function (key) {
                var page = PAGES_BY_KEY[key];
                if (!page) return ''; // defensive — never throws if a key is mistyped
                var cls = key === activePage ? ' class="lp-active-link"' : '';
                return '<a href="' + page.href + '"' + cls + '>' + escHtml(page.label) + '</a>';
            }).join('');
        }).join('<div class="lp-dropdown-divider" role="separator"></div>');
        var btnCls = 'lp-nav-btn' + (isActiveGroup ? ' lp-active' : '');
        return '<div class="lp-nav-group" data-group="' + escHtml(group.label) + '">' +
            '<button type="button" class="' + btnCls + '" aria-haspopup="true" aria-expanded="false">' +
                '<span class="lp-btn-icon">' + group.icon + '</span><span class="lp-btn-label">' + escHtml(group.label) + '</span><span class="lp-caret">▾</span>' +
            '</button>' +
            '<div class="lp-dropdown" role="menu">' + links + '</div>' +
        '</div>';
    }

    function _renderNav(activePage, groupsToShow) {
        return groupsToShow.map(function (g) { return _renderGroup(g, activePage); }).join('');
    }

    // ── Open/close (single source of truth — used by click, keyboard, and
    // outside-click/ESC handlers alike; no duplicated logic) ────────────────

    function _closeAllGroups() {
        document.querySelectorAll('.lp-dropdown.lp-open').forEach(function (d) { d.classList.remove('lp-open'); });
        document.querySelectorAll('.lp-nav-btn.lp-open').forEach(function (b) { b.classList.remove('lp-open'); b.setAttribute('aria-expanded', 'false'); });
    }

    function _openGroup(groupEl) {
        _closeAllGroups();
        var btn = groupEl.querySelector('.lp-nav-btn');
        var dropdown = groupEl.querySelector('.lp-dropdown');
        dropdown.classList.add('lp-open');
        btn.classList.add('lp-open');
        btn.setAttribute('aria-expanded', 'true');
    }

    function _toggleGroup(btn) {
        var groupEl = btn.closest ? btn.closest('.lp-nav-group') : btn.parentElement;
        var dropdown = groupEl.querySelector('.lp-dropdown');
        var wasOpen = dropdown.classList.contains('lp-open');
        _closeAllGroups();
        if (!wasOpen) _openGroup(groupEl);
    }

    function _closeSearch(searchWrap) {
        var results = searchWrap.querySelector('.lp-search-results');
        if (results) results.classList.remove('lp-open');
    }

    // ── Event delegation — one click listener, one keydown listener per
    // nav instance. Survives _applyRoleAwareNav()'s innerHTML swap because
    // both listeners are attached to navEl itself (only its children are
    // replaced), never to the individual buttons/links it renders. ─────────

    function _wireNav(navEl) {
        navEl.addEventListener('click', function (e) {
            var hamburger = e.target.closest('.lp-hamburger');
            if (hamburger) { navEl.classList.toggle('lp-mobile-open'); return; }
            var btn = e.target.closest('.lp-nav-btn');
            if (btn) { _toggleGroup(btn); return; }
            if (e.target.tagName === 'A') { _closeAllGroups(); } // clicking a link closes menus (mobile keeps its own panel open until hamburger is toggled again — acceptable, matches most enterprise navs)
        });

        navEl.addEventListener('keydown', function (e) {
            var btn = e.target.closest('.lp-nav-btn');
            var link = e.target.tagName === 'A' ? e.target.closest('.lp-dropdown') && e.target : null;

            if (btn) {
                var allBtns = Array.prototype.slice.call(navEl.querySelectorAll('.lp-nav-btn'));
                var idx = allBtns.indexOf(btn);
                if (e.key === 'ArrowRight') { e.preventDefault(); (allBtns[idx + 1] || allBtns[0]).focus(); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); (allBtns[idx - 1] || allBtns[allBtns.length - 1]).focus(); }
                else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    var groupEl = btn.closest('.lp-nav-group');
                    _openGroup(groupEl);
                    var firstLink = groupEl.querySelector('.lp-dropdown a');
                    if (firstLink) firstLink.focus();
                } else if (e.key === 'Escape') {
                    _closeAllGroups();
                }
                return;
            }

            if (link) {
                var dropdown = link.closest('.lp-dropdown');
                var links = Array.prototype.slice.call(dropdown.querySelectorAll('a'));
                var lIdx = links.indexOf(link);
                if (e.key === 'ArrowDown') { e.preventDefault(); (links[lIdx + 1] || links[0]).focus(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); (links[lIdx - 1] || links[links.length - 1]).focus(); }
                else if (e.key === 'Escape') {
                    e.preventDefault();
                    var groupBtn = dropdown.parentElement.querySelector('.lp-nav-btn');
                    _closeAllGroups();
                    if (groupBtn) groupBtn.focus();
                }
            }
        });
    }

    // ESC anywhere on the page closes any open menu/search (covers focus
    // outside the nav entirely, e.g. focus in page content).
    function _globalEscHandler(e) {
        if (e.key === 'Escape') {
            _closeAllGroups();
            document.querySelectorAll('.lp-search-results.lp-open').forEach(function (r) { r.classList.remove('lp-open'); });
        }
    }

    function _closeAllOnOutsideClick(e) {
        if (e.target.closest && e.target.closest('.lp-nav-group')) return;
        if (e.target.closest && e.target.closest('.lp-search-wrap')) return;
        _closeAllGroups();
        document.querySelectorAll('.lp-search-results.lp-open').forEach(function (r) { r.classList.remove('lp-open'); });
    }

    // ── Codebox 80A — quick module search. Frontend-only, filters the same
    // PAGES list the nav itself is built from; never touches the DOM nodes
    // the nav renderer owns (separate results panel). No storage of any
    // kind — nothing persists between page loads. ──────────────────────────

    function _renderSearchBox() {
        return '<div class="lp-search-wrap">' +
            '<input type="text" class="lp-search-input" placeholder="Search modules…" aria-label="Search modules" autocomplete="off" />' +
            '<div class="lp-search-results" role="listbox"></div>' +
        '</div>';
    }

    function _wireSearch(searchWrap) {
        var input = searchWrap.querySelector('.lp-search-input');
        var results = searchWrap.querySelector('.lp-search-results');

        function _renderResults(query) {
            var q = query.trim().toLowerCase();
            if (!q) { results.innerHTML = ''; results.classList.remove('lp-open'); return; }
            var matches = PAGES.filter(function (p) { return p.label.toLowerCase().indexOf(q) !== -1; }).slice(0, 12);
            results.innerHTML = matches.length
                ? matches.map(function (p) { return '<a href="' + p.href + '">' + escHtml(p.label) + '</a>'; }).join('')
                : '<div class="lp-search-empty">No modules match "' + escHtml(query) + '".</div>';
            results.classList.add('lp-open');
        }

        input.addEventListener('input', function () { _renderResults(input.value); });
        input.addEventListener('focus', function () { if (input.value.trim()) _renderResults(input.value); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { input.value = ''; results.innerHTML = ''; results.classList.remove('lp-open'); input.blur(); return; }
            if (e.key === 'ArrowDown') {
                var first = results.querySelector('a');
                if (first) { e.preventDefault(); first.focus(); }
                return;
            }
            if (e.key === 'Enter') {
                var firstLink = results.querySelector('a');
                if (firstLink) { window.location.href = firstLink.getAttribute('href'); }
            }
        });
        results.addEventListener('keydown', function (e) {
            var links = Array.prototype.slice.call(results.querySelectorAll('a'));
            var idx = links.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); (links[idx + 1] || links[0]).focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); (idx <= 0 ? input : links[idx - 1]).focus(); }
            else if (e.key === 'Escape') { input.value = ''; results.innerHTML = ''; results.classList.remove('lp-open'); input.focus(); }
        });
    }

    // Codebox 80 — role-aware nav (UX only, never a security boundary; the
    // backend's manager gate via lib/team-access.js is unchanged and is the
    // only real authorization check). Renders the full nav first (the safe
    // default — fails open, never closed, if this check is slow/fails), then
    // trims to the reduced staff group set only if the current user is
    // confirmed non-manager.
    function _applyRoleAwareNav(activePage, groupsEl) {
        if (!window.PracticeAPI || !window.PracticeAPI.fetch) return;
        window.PracticeAPI.fetch('/api/practice/team/me')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.is_manager) return; // full nav already rendered — nothing to trim
                var staffGroups = NAV_GROUPS.filter(function (g) { return STAFF_GROUP_LABELS.indexOf(g.label) !== -1; });
                groupsEl.innerHTML = _renderNav(activePage, staffGroups);
            })
            .catch(function () { /* non-fatal — full nav remains visible */ });
    }

    function init(activePage) {
        _injectNavCss();
        var companyName = getCompanyName();

        var topbarEl = document.getElementById('app-topbar');
        if (topbarEl) {
            topbarEl.classList.add('topbar'); // some pages already hardcode class="topbar" on this div — classList.add is idempotent either way
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
            navEl.innerHTML =
                '<button type="button" class="lp-hamburger" aria-label="Toggle navigation menu">☰</button>' +
                '<div class="lp-nav-groups">' + _renderNav(activePage, NAV_GROUPS) + _renderSearchBox() + '</div>';

            var groupsEl = navEl.querySelector('.lp-nav-groups');
            _wireNav(navEl);
            _wireSearch(navEl.querySelector('.lp-search-wrap'));
            document.addEventListener('click', _closeAllOnOutsideClick);
            document.addEventListener('keydown', _globalEscHandler);
            _applyRoleAwareNav(activePage, groupsEl);
        }

        _loadBellCount();
    }

    // onReady exists so page scripts can defer their own data-load boot logic
    // until after init() has run, without assuming any particular load order.
    // init() above is fully synchronous, so this just invokes the callback now.
    function onReady(cb) { cb(); }

    window.LAYOUT = { init: init, onReady: onReady, _toggleGroup: _toggleGroup };
})();
