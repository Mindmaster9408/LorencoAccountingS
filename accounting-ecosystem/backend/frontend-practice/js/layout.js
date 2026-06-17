/* ============================================================
   Lorenco Practice — Shared Layout
   Injects topbar + nav into #app-topbar and #app-nav.
   Call LAYOUT.init('page-key') after DOM ready.
   ============================================================ */
(function () {
    var PAGES = [
        { key: 'dashboard', label: 'Dashboard',  href: '/practice' },
        { key: 'profile',   label: 'Profile',    href: '/practice/profile.html' },
        { key: 'team',      label: 'Team',       href: '/practice/team.html' },
        { key: 'clients',   label: 'Clients',    href: '/practice/clients.html' },
        { key: 'tasks',     label: 'Tasks',      href: '/practice/tasks.html' },
        { key: 'time',      label: 'Time',       href: '/practice/time.html' },
        { key: 'deadlines', label: 'Deadlines',  href: '/practice/deadlines.html' }
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
    }

    window.LAYOUT = { init: init };
})();
