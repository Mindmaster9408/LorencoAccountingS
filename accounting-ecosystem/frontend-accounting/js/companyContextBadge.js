// companyContextBadge.js
// Visual-only company context badge for high-risk accounting pages.
// Reads the company name from existing sources — no new storage, no auth logic.

(function () {
    function getCurrentCompanyDisplayName() {
        const stored = localStorage.getItem('accounting_company_name')
            || localStorage.getItem('eco_company_name');
        if (stored && stored.trim()) return stored.trim();

        // Fallback: read from nav DOM if already rendered
        const navEl = document.getElementById('navCompanyName');
        if (navEl && navEl.textContent && navEl.textContent.trim()
            && navEl.textContent.trim() !== 'Company') {
            return navEl.textContent.trim();
        }

        return 'Selected company';
    }

    function renderCompanyContextBadge() {
        if (document.getElementById('company-context-badge')) return;

        const name = getCurrentCompanyDisplayName();
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        const badge = document.createElement('div');
        badge.id = 'company-context-badge';
        badge.setAttribute('aria-label', 'Active company context');

        badge.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'gap:7px',
            'padding:5px 13px 5px 10px',
            'border-radius:8px',
            'border-left:3px solid #f97316',
            'font-size:0.82rem',
            'font-weight:600',
            'font-family:inherit',
            'letter-spacing:0.01em',
            'box-shadow:0 1px 4px rgba(0,0,0,0.08)',
            'user-select:none',
            'white-space:nowrap',
            'margin-bottom:16px',
            isDark
                ? 'background:#1e1b3a;color:#f1f5f9;border-color:#f97316'
                : 'background:#fff7ed;color:#7c2d12;border-color:#f97316',
        ].join(';');

        const icon = document.createElement('span');
        icon.textContent = '🏢';
        icon.style.cssText = 'font-size:0.9rem;line-height:1';

        const label = document.createElement('span');
        label.style.cssText = 'opacity:0.65;font-weight:400;margin-right:2px';
        label.textContent = 'Working client:';

        const companyName = document.createElement('span');
        companyName.id = 'context-badge-company-name';
        companyName.textContent = name;

        badge.appendChild(icon);
        badge.appendChild(label);
        badge.appendChild(companyName);

        // Insert after the page <h1>/<h2> if one exists, otherwise prepend to <main>
        const heading = document.querySelector('main h1, main h2, .page-header h1, .page-header h2');
        if (heading && heading.parentNode) {
            heading.parentNode.insertBefore(badge, heading.nextSibling);
        } else {
            const main = document.querySelector('main') || document.body;
            main.prepend(badge);
        }

        // Re-apply dark theme if it loads asynchronously after this script runs
        const observer = new MutationObserver(() => {
            const dark = document.documentElement.getAttribute('data-theme') === 'dark';
            if (dark) {
                badge.style.background = '#1e1b3a';
                badge.style.color = '#f1f5f9';
            } else {
                badge.style.background = '#fff7ed';
                badge.style.color = '#7c2d12';
            }
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderCompanyContextBadge);
    } else {
        renderCompanyContextBadge();
    }
})();
