/**
 * sidebar.js — Shared sidebar renderer for all payroll frontend pages.
 *
 * Usage: Add <div id="sidebar-container"></div> where the sidebar should appear,
 * then include <script src="js/sidebar.js"></script> before the page inline script.
 *
 * Active state: auto-detected from window.location.pathname filename.
 * First match wins — handles payruns.html appearing twice (Pay Runs + Payslips).
 *
 * The page-level loadCompaniesCarousel() function populates #companies-carousel
 * after this script injects it into the DOM.
 */
(function () {
    'use strict';

    var SIDEBAR_ITEMS = [
        { label: '📊 Dashboard',           href: 'company-dashboard.html' },
        { label: '👥 Employees',           href: 'employee-management.html' },
        { label: ' Payslips',            href: 'payruns.html' },
        { label: '⚙️ Execute Payroll',     href: 'payroll-execution.html' },
        { label: '📋 Payroll Items',       href: 'payroll-items.html' },
        { label: '⏰ Attendance',           href: 'attendance.html' },
        { label: '📊 Reports',             href: 'reports.html' },
        { label: '🧾 PAYE Reconciliation', href: 'paye-reconciliation.html' },
        { label: '🔁 Net-to-Gross',        href: 'net-to-gross.html' },
        { label: '📥 Import',              href: 'historical-import.html' },
        { label: '🏢 Company Details',     href: 'company-details.html' }
    ];

    function buildSidebarHTML(currentPage) {
        var activeSet = false;

        var navLinks = SIDEBAR_ITEMS.map(function (item) {
            var isActive = !activeSet && item.href === currentPage;
            if (isActive) activeSet = true;
            var cls = 'sidebar-link' + (isActive ? ' active' : '');
            return '                <a href="' + item.href + '" class="' + cls + '">' + item.label + '</a>';
        }).join('\n');

        return [
            '<div class="sidebar">',
            '            <div class="sidebar-header">',
            '                <div class="sidebar-title">Menu</div>',
            '            </div>',
            '            <div class="sidebar-section">',
            '                <div class="sidebar-section-title">Navigation</div>',
            navLinks,
            '            </div>',
            '            <div class="company-carousel">',
            '                <div class="carousel-title">Switch Company</div>',
            '                <div class="carousel-container">',
            '                    <div class="carousel-companies" id="companies-carousel"></div>',
            '                </div>',
            '            </div>',
            '            <div class="sidebar-actions">',
            '                <button class="btn-sidebar" style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white;" onclick="window.location.href=\'/dashboard/dashboard.html\'">🏠 Return to Ecosystem</button>',
            '                <button class="btn-sidebar btn-switch" onclick="window.location.href=\'company-selection.html\'">← Return to Dashboard</button>',
            '                <button class="btn-sidebar btn-logout" onclick="handleLogout()">🚪 Logout</button>',
            '            </div>',
            '        </div>'
        ].join('\n        ');
    }

    function renderSidebar() {
        var container = document.getElementById('sidebar-container');
        if (!container) return;

        var pathname = window.location.pathname;
        var currentPage = pathname.split('/').pop();
        if (!currentPage) currentPage = 'company-dashboard.html';

        container.innerHTML = buildSidebarHTML(currentPage);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderSidebar);
    } else {
        // DOM already ready (script loaded late)
        renderSidebar();
    }
}());
