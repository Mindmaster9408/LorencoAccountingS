// Shared Navigation Component for Lorenco Accounting
// Adapted for ECO Systum integration — all links prefixed with /accounting/
// Includes ECO Hub back-link and SSO token bridging

// ─── Inject API interceptor script ─────────────────────────────────────────
(function() {
  if (!document.getElementById('eco-api-interceptor')) {
    const script = document.createElement('script');
    script.id = 'eco-api-interceptor';
    script.src = '/accounting/js/eco-api-interceptor.js';
    document.head.appendChild(script);
  }
})();

function createNavigation() {
  // Strip /accounting/ prefix for current page detection
  const pathname = window.location.pathname.replace(/^\/accounting\/?/, '');
  const currentPage = pathname.split('/').pop() || 'dashboard.html';

  const navHTML = `
    <div class="top-bar">
      <div class="brand-section">
        <a href="/dashboard" class="eco-hub-link" title="Back to ECO Hub">
          <span class="eco-hub-arrow">&larr;</span>
          <span class="eco-hub-text">ECO Hub</span>
        </a>
        <div class="logo">
          <div class="logo-icon">L</div>
          <span>Lorenco</span>
        </div>
        <div class="company-selector" id="companySelectorBtn" onclick="toggleCompanyDropdown()">
          <span id="navCompanyName">Company</span>
          <span class="company-chevron" style="opacity:0.7;transition:transform 0.2s;">&#x2193;</span>
          <div class="company-dropdown" id="companyDropdown">
            <div class="company-dropdown-header">Switch Client</div>
            <div id="companyDropdownList">
              <div class="company-dropdown-loading">Click to load clients&hellip;</div>
            </div>
          </div>
        </div>
      </div>
      <div class="right-section">
        <button class="icon-btn" title="Quick Add">+</button>
        <button class="icon-btn" title="Search">&#x1F50D;</button>
        <button class="icon-btn notification-btn" title="Notifications">&#x1F514;</button>
        <button class="icon-btn" title="Help">?</button>
        <div class="user-menu" onclick="toggleUserDropdown()">
          <div class="user-avatar" id="navUserAvatar">D</div>
          <span class="user-name" id="navUserName">Demo User</span>
          <span style="opacity: 0.7; font-size: 11px;">&darr;</span>
          <div class="user-dropdown" id="userDropdown">
            <a href="/accounting/profile.html">My Profile</a>
            <a href="/accounting/settings.html">Settings</a>
            <hr>
            <a href="/dashboard">ECO Dashboard</a>
            <hr>
            <a href="#" onclick="logout(); return false;">Logout</a>
          </div>
        </div>
      </div>
    </div>

    <div class="demo-banner" id="demoBanner">
      &#x26A0; DEMO MODE - Database not connected. Install PostgreSQL to use full features.
    </div>

    <nav class="main-nav">
      <div class="nav-item ${currentPage === 'dashboard.html' ? 'active' : ''}">
        <a href="/accounting/dashboard.html">Home</a>
        <div class="dropdown">
          <a href="/accounting/dashboard.html">Dashboard Overview</a>
          <a href="#">My Tasks</a>
          <a href="#">Favorites</a>
          <a href="#">Recent Activity</a>
        </div>
      </div>

      <div class="nav-item">
        <a href="#">Quick View</a>
        <div class="dropdown">
          <a href="#">Summary</a>
          <a href="/accounting/cashflow.html">Cash Flow</a>
          <a href="#">P&L Overview</a>
          <a href="/accounting/balance-sheet.html">Balance Sheet Summary</a>
        </div>
      </div>

      <div class="nav-item ${currentPage.includes('customer') || currentPage === 'invoices.html' ? 'active' : ''}">
        <a href="#">Customers</a>
        <div class="dropdown">
          <div class="dropdown-header">Sales</div>
          <a href="/accounting/customer-list.html">Customer List</a>
          <a href="#">New Customer</a>
          <a href="/accounting/invoices.html">Invoices</a>
          <a href="#">Quotes</a>
          <a href="#">Credit Notes</a>
          <div class="dropdown-header">Payments</div>
          <a href="/accounting/customer-receipts.html">Customer Receipts</a>
          <a href="/accounting/aged-debtors.html">Customer Aging</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'suppliers.html' ? 'active' : ''}">
        <a href="/accounting/suppliers.html">Suppliers</a>
        <div class="dropdown">
          <div class="dropdown-header">Purchases</div>
          <a href="/accounting/suppliers.html">Supplier List</a>
          <a href="/accounting/suppliers.html?new=supplier">New Supplier</a>
          <a href="/accounting/suppliers.html?tab=orders">Purchase Orders</a>
          <a href="/accounting/suppliers.html?tab=invoices">Supplier Invoices</a>
          <div class="dropdown-header">Payments</div>
          <a href="/accounting/suppliers.html?tab=payments">Supplier Payments</a>
          <a href="/accounting/suppliers.html?tab=aging">Supplier Aging</a>
        </div>
      </div>


      <div class="nav-item ${currentPage.includes('bank') ? 'active' : ''}">
        <a href="/accounting/bank.html">Banking</a>
        <div class="dropdown">
          <a href="/accounting/bank.html">Bank Transactions</a>
          <a href="/accounting/bank-reconciliation.html">Bank Reconciliation</a>
          <a href="#">Payment Processing</a>
          <a href="#">Bank Rules</a>
          <a href="#">Import Statements</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'accounts.html' || currentPage === 'journals.html' || currentPage === 'trial-balance.html' ? 'active' : ''}">
        <a href="/accounting/accounts.html">Accounts</a>
        <div class="dropdown">
          <a href="/accounting/accounts.html">Chart of Accounts</a>
          <a href="/accounting/journals.html">Journal Entries</a>
          <a href="#">Nominal Ledger</a>
          <a href="/accounting/trial-balance.html">Trial Balance</a>
          <a href="#">Period End</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'reports.html' || currentPage === 'balance-sheet.html' || currentPage === 'cashflow.html' ? 'active' : ''}">
        <a href="/accounting/reports.html">Reports</a>
        <div class="dropdown">
          <div class="dropdown-header">Financial</div>
          <a href="/accounting/reports.html">Profit & Loss</a>
          <a href="/accounting/balance-sheet.html">Balance Sheet</a>
          <a href="/accounting/cashflow.html">Cash Flow Statement</a>
          <a href="/accounting/trial-balance.html">Trial Balance</a>
          <div class="dropdown-header">Analysis</div>
          <a href="/accounting/sales-analysis.html">Sales Analysis</a>
          <a href="/accounting/purchase-analysis.html">Purchase Analysis</a>
          <a href="/accounting/vat.html">VAT Reconciliation</a>
          <a href="/accounting/aged-debtors.html">Aged Debtors</a>
          <a href="/accounting/aged-creditors.html">Aged Creditors</a>
        </div>
      </div>

      <div class="nav-item ${currentPage.includes('paye') || currentPage.includes('vat') ? 'active' : ''}">
        <a href="#">Tax</a>
        <div class="dropdown">
          <div class="dropdown-header">PAYE</div>
          <a href="/accounting/paye.html">PAYE Overview</a>
          <a href="/accounting/paye-reconciliation.html">PAYE Reconciliation</a>
          <a href="/accounting/paye-config.html">PAYE Configuration</a>
          <div class="dropdown-header">VAT</div>
          <a href="/accounting/vat.html">VAT Reconciliation</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'company.html' || currentPage === 'contacts.html' ? 'active' : ''}">
        <a href="/accounting/company.html">Company</a>
        <div class="dropdown">
          <a href="/accounting/company.html">Company Profile</a>
          <a href="/accounting/company.html">Company Settings</a>
          <a href="/accounting/contacts.html">Contacts</a>
          <a href="#">Users & Permissions</a>
          <a href="#">Financial Year</a>
          <a href="#">Tax Settings</a>
          <a href="#">Backup & Restore</a>
          <a href="/accounting/settings.html">General Settings</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'ai-settings.html' || currentPage === 'system-health.html' ? 'active' : ''}">
        <a href="#">Administration</a>
        <div class="dropdown">
          <div class="dropdown-header">Monitoring</div>
          <a href="#">Audit Log</a>
          <a href="/accounting/system-health.html">System Health</a>
          <a href="#">User Activity</a>
          <div class="dropdown-header">Data Management</div>
          <a href="#">Data Export</a>
          <a href="#">Data Import</a>
          <a href="#">Archive & Delete</a>
          <div class="dropdown-header">Security</div>
          <a href="#">Security Log</a>
          <a href="#">API Keys</a>
          <a href="#">Integrations</a>
        </div>
      </div>

      <div class="nav-item nav-item-ai">
        <a href="#">Sean AI</a>
        <div class="dropdown">
          <div class="dropdown-header">AI Features</div>
          <a href="/accounting/ai-settings.html">AI Settings</a>
          <a href="#">AI Review Queue</a>
          <a href="/accounting/company.html#teach-sean">Teach Sean</a>
          <div class="dropdown-header">Automation</div>
          <a href="#">Document Upload</a>
          <a href="#">OCR Processing</a>
          <a href="#">Auto-categorization</a>
          <a href="#">Approval Queue</a>
        </div>
      </div>
    </nav>
  `;

  // Insert navigation at the start of body
  document.body.insertAdjacentHTML('afterbegin', navHTML);

  // Add navigation styles if not already present
  if (!document.getElementById('shared-nav-styles')) {
    addNavigationStyles();
  }

  // Initialize user display
  initializeNavigation();
}

function addNavigationStyles() {
  const styles = `
    <style id="shared-nav-styles">
      /* ============================================
         SHARED NAVIGATION STYLES
         ============================================ */

      /* Top Bar */
      .top-bar {
        background: linear-gradient(135deg, #0066cc 0%, #0099ff 100%);
        color: white;
        padding: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        height: 60px;
        box-shadow: 0 2px 8px rgba(0,102,204,0.2);
      }

      .brand-section {
        display: flex;
        align-items: center;
        height: 100%;
        gap: 20px;
        padding: 0 25px;
      }

      /* ECO Hub back-link */
      .eco-hub-link {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        background: rgba(255,255,255,0.2);
        border-radius: 8px;
        color: white;
        text-decoration: none;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s;
        border: 1px solid rgba(255,255,255,0.3);
      }

      .eco-hub-link:hover {
        background: rgba(255,255,255,0.35);
        transform: translateX(-2px);
      }

      .eco-hub-arrow {
        font-size: 16px;
        line-height: 1;
      }

      .logo {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 700;
        font-size: 20px;
        letter-spacing: -0.5px;
      }

      .logo-icon {
        width: 32px;
        height: 32px;
        background: linear-gradient(135deg, #ffffff 0%, #e6f3ff 100%);
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        color: #0066cc;
        font-size: 18px;
      }

      .company-selector {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 15px;
        background: rgba(255,255,255,0.15);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 13px;
        position: relative;
        user-select: none;
      }

      .company-selector:hover {
        background: rgba(255,255,255,0.25);
      }

      /* ── Client switcher dropdown ───────────────────────────────────────── */
      .company-dropdown {
        display: none;
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        min-width: 260px;
        max-height: 360px;
        overflow-y: auto;
        background: #1a1740;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        z-index: 9999;
        cursor: default;
      }

      .company-dropdown.show { display: block; }

      .company-selector.open .company-chevron { transform: rotate(180deg); }

      .company-dropdown-header {
        padding: 10px 16px 8px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: rgba(255,255,255,0.4);
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }

      .company-dropdown-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        font-size: 13px;
        color: rgba(255,255,255,0.9);
        cursor: pointer;
        transition: background 0.15s;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }

      .company-dropdown-item:last-child { border-bottom: none; }

      .company-dropdown-item:hover { background: rgba(255,255,255,0.08); }

      .company-dropdown-item.active {
        background: rgba(245,158,11,0.15);
        color: #f59e0b;
        font-weight: 600;
      }

      .company-dropdown-item .client-badge {
        margin-left: auto;
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 10px;
        background: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.5);
        flex-shrink: 0;
      }

      .company-dropdown-item.active .client-badge { background: rgba(245,158,11,0.2); color: #f59e0b; }

      .company-dropdown-loading,
      .company-dropdown-error {
        padding: 16px;
        font-size: 12px;
        text-align: center;
        color: rgba(255,255,255,0.4);
      }

      .company-dropdown-error { color: #fca5a5; }

      .company-dropdown-switching {
        padding: 12px 16px;
        font-size: 12px;
        color: #f59e0b;
        text-align: center;
      }

      .right-section {
        display: flex;
        align-items: center;
        gap: 15px;
        padding: 0 25px;
      }

      .icon-btn {
        width: 36px;
        height: 36px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.15);
        cursor: pointer;
        transition: all 0.2s;
        border: none;
        color: white;
        font-size: 16px;
      }

      .icon-btn:hover {
        background: rgba(255,255,255,0.25);
        transform: translateY(-1px);
      }

      .user-menu {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 15px;
        background: rgba(255,255,255,0.15);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
        position: relative;
      }

      .user-menu:hover {
        background: rgba(255,255,255,0.25);
      }

      .user-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: linear-gradient(135deg, #ff9800 0%, #ffc107 100%);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 12px;
      }

      .user-name {
        font-size: 13px;
        font-weight: 500;
        color: white;
      }

      .user-dropdown {
        display: none;
        position: absolute;
        top: 100%;
        right: 0;
        background: white;
        min-width: 150px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border-radius: 8px;
        margin-top: 8px;
        overflow: hidden;
        z-index: 1001;
      }

      .user-dropdown.show {
        display: block;
      }

      .user-dropdown a {
        display: block;
        padding: 10px 15px;
        color: #333;
        text-decoration: none;
        font-size: 13px;
        transition: all 0.15s;
      }

      .user-dropdown a:hover {
        background: #f0f8ff;
        color: #0066cc;
      }

      .user-dropdown hr {
        border: none;
        border-top: 1px solid #e8eaed;
        margin: 0;
      }

      /* Demo Banner */
      .demo-banner {
        background: linear-gradient(135deg, #ff9800 0%, #ffc107 100%);
        color: white;
        padding: 10px 25px;
        text-align: center;
        font-weight: 600;
        font-size: 13px;
        display: none;
      }

      .demo-banner.show {
        display: block;
      }

      /* Main Navigation */
      .main-nav {
        background: white;
        border-bottom: 1px solid #e8eaed;
        display: flex;
        align-items: center;
        padding: 0 25px;
        height: 56px;
        gap: 8px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      }

      .main-nav .nav-item {
        position: relative;
        height: 100%;
        display: flex;
        align-items: center;
      }

      .main-nav .nav-item > a {
        padding: 0 18px;
        color: #5f6368;
        text-decoration: none;
        transition: all 0.2s;
        font-size: 14px;
        font-weight: 500;
        position: relative;
        display: flex;
        align-items: center;
        height: 100%;
        gap: 6px;
        letter-spacing: 0.2px;
      }

      .main-nav .nav-item > a::after {
        content: '\\25BC';
        font-size: 8px;
        opacity: 0.5;
        transition: all 0.2s;
      }

      .main-nav .nav-item:hover > a {
        color: #0066cc;
        background: linear-gradient(to bottom, transparent 0%, #e6f3ff 100%);
      }

      .main-nav .nav-item:hover > a::after {
        transform: rotate(-180deg);
      }

      .main-nav .nav-item.active > a {
        color: #0066cc;
        font-weight: 600;
      }

      .main-nav .nav-item.active > a::before {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: linear-gradient(90deg, #0066cc 0%, #0099ff 100%);
        border-radius: 3px 3px 0 0;
      }

      .main-nav .nav-item-ai > a {
        color: #7c3aed !important;
      }

      .main-nav .nav-item-ai:hover > a,
      .main-nav .nav-item-ai.active > a {
        color: #6d28d9 !important;
      }

      .main-nav .nav-item-ai.active > a::before {
        background: linear-gradient(90deg, #7c3aed 0%, #a78bfa 100%);
      }

      /* Dropdowns */
      .main-nav .dropdown {
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        background: white;
        min-width: 260px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
        border: 1px solid #e8eaed;
        border-radius: 0 0 12px 12px;
        z-index: 1000;
        overflow: hidden;
        animation: slideDown 0.2s ease-out;
      }

      @keyframes slideDown {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .main-nav .nav-item:hover .dropdown {
        display: block;
      }

      .main-nav .dropdown a {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 20px;
        color: #5f6368;
        text-decoration: none;
        font-size: 13px;
        border-bottom: 1px solid #f5f5f5;
        transition: all 0.15s;
      }

      .main-nav .dropdown a::before {
        content: '\\2192';
        opacity: 0;
        transform: translateX(-5px);
        transition: all 0.2s;
        color: #0066cc;
      }

      .main-nav .dropdown a:last-child {
        border-bottom: none;
      }

      .main-nav .dropdown a:hover {
        background: linear-gradient(90deg, #e6f3ff 0%, #ffffff 100%);
        color: #0066cc;
        padding-left: 25px;
      }

      .main-nav .dropdown a:hover::before {
        opacity: 1;
        transform: translateX(0);
      }

      .main-nav .dropdown-header {
        padding: 10px 20px 6px;
        font-size: 11px;
        color: #9aa0a6;
        font-weight: 700;
        text-transform: uppercase;
        background: #fafbfc;
        letter-spacing: 0.5px;
      }

      .main-nav .dropdown-header::before {
        display: none;
      }

      /* Page Content Wrapper - add margin for sticky nav */
      body {
        margin: 0;
        padding: 0;
      }
    </style>
  `;

  document.head.insertAdjacentHTML('beforeend', styles);
}

function initializeNavigation() {
  // Get user info from localStorage — try ECO SSO user first, then Lorenco user
  let user = {};
  const ssoSource = localStorage.getItem('sso_source');

  if (ssoSource === 'ecosystem') {
    // ECO SSO — try eco_user first
    try {
      const ecoUser = JSON.parse(localStorage.getItem('eco_user') || '{}');
      user = {
        firstName: ecoUser.fullName ? ecoUser.fullName.split(' ')[0] : (ecoUser.firstName || ''),
        lastName: ecoUser.fullName ? ecoUser.fullName.split(' ').slice(1).join(' ') : (ecoUser.lastName || ''),
        email: ecoUser.email || ecoUser.username || '',
        companyName: localStorage.getItem('eco_company_name') || ''
      };
    } catch (e) {
      // Fall through to Lorenco user
    }
  }

  // Fallback to Lorenco's localStorage user
  if (!user.email) {
    try {
      user = JSON.parse(localStorage.getItem('user') || '{}');
    } catch (e) {
      user = {};
    }
  }

  const demoMode = localStorage.getItem('demoMode') === 'true';

  // Update user display
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  const userNameEl = document.getElementById('navUserName');
  if (userNameEl) {
    userNameEl.textContent = fullName || user.email || 'User';
  }

  // Set user avatar initial
  const avatarEl = document.getElementById('navUserAvatar');
  if (avatarEl) {
    const initial = (user.firstName?.[0] || user.email?.[0] || 'U').toUpperCase();
    avatarEl.textContent = initial;
  }

  // Update company name
  const companyNameEl = document.getElementById('navCompanyName');
  if (companyNameEl) {
    companyNameEl.textContent = user.companyName || 'Company';
  }

  // Show demo banner if in demo mode
  const demoBanner = document.getElementById('demoBanner');
  if (demoBanner && (demoMode || !localStorage.getItem('token'))) {
    demoBanner.classList.add('show');
  }
}

function toggleUserDropdown() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.classList.toggle('show');
  }
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(e) {
  // User dropdown
  const userMenu = document.querySelector('.user-menu');
  const userDropdown = document.getElementById('userDropdown');
  if (userDropdown && userMenu && !userMenu.contains(e.target)) {
    userDropdown.classList.remove('show');
  }
  // Company dropdown
  const companyBtn = document.getElementById('companySelectorBtn');
  const companyDropdown = document.getElementById('companyDropdown');
  if (companyDropdown && companyBtn && !companyBtn.contains(e.target)) {
    companyDropdown.classList.remove('show');
    companyBtn.classList.remove('open');
  }
});

// ── Company / Client Switcher ────────────────────────────────────────────────

let _clientsLoaded = false;

function toggleCompanyDropdown() {
  const btn      = document.getElementById('companySelectorBtn');
  const dropdown = document.getElementById('companyDropdown');
  if (!btn || !dropdown) return;

  const isOpen = dropdown.classList.contains('show');

  // Close user dropdown if open
  document.getElementById('userDropdown')?.classList.remove('show');

  if (isOpen) {
    dropdown.classList.remove('show');
    btn.classList.remove('open');
  } else {
    dropdown.classList.add('show');
    btn.classList.add('open');
    if (!_clientsLoaded) loadAccountingClients();
  }
}

// Decode companyId from the current accounting JWT (no external deps)
function _currentCompanyId() {
  try {
    const tok = localStorage.getItem('token') || '';
    const payload = JSON.parse(atob(tok.split('.')[1]));
    return payload.companyId || null;
  } catch (_) { return null; }
}

async function loadAccountingClients() {
  const listEl = document.getElementById('companyDropdownList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="company-dropdown-loading">Loading clients&hellip;</div>';

  // Use eco_token to call the shared ECO api (scoped to the practice company)
  const ecoToken = localStorage.getItem('eco_token') || localStorage.getItem('token') || '';
  if (!ecoToken) {
    listEl.innerHTML = '<div class="company-dropdown-error">Not authenticated</div>';
    return;
  }

  try {
    const res = await fetch('/api/eco-clients?app=accounting', {
      headers: { 'Authorization': 'Bearer ' + ecoToken }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load clients');
    }

    const data    = await res.json();
    const clients = (data.clients || []).filter(c => c.client_company_id);

    if (clients.length === 0) {
      listEl.innerHTML = '<div class="company-dropdown-loading">No accounting clients found</div>';
      return;
    }

    const activeCid = _currentCompanyId();

    listEl.innerHTML = clients.map(c => {
      const cid      = c.client_company_id;
      const isActive = String(cid) === String(activeCid);
      const badge    = c.shared_access
        ? '<span class="client-badge">Shared</span>'
        : (isActive ? '<span class="client-badge" style="background:rgba(245,158,11,0.25);color:#f59e0b;">Active</span>' : '');
      return `<div class="company-dropdown-item${isActive ? ' active' : ''}"
                   onclick="switchToClient(${cid}, event)"
                   data-name="${c.name.replace(/"/g, '&quot;')}">
                <span>${c.name}</span>${badge}
              </div>`;
    }).join('');

    _clientsLoaded = true;

  } catch (err) {
    console.error('[CompanyDropdown] loadAccountingClients:', err.message);
    listEl.innerHTML = `<div class="company-dropdown-error">Error: ${err.message}</div>`;
  }
}

async function switchToClient(companyId, event) {
  if (event) event.stopPropagation();
  if (!companyId) return;

  const itemEl = event && event.currentTarget;
  const clientName = itemEl ? itemEl.getAttribute('data-name') : 'Client';

  const listEl = document.getElementById('companyDropdownList');
  if (listEl) listEl.innerHTML = `<div class="company-dropdown-switching">Switching to ${clientName}&hellip;</div>`;

  const ecoToken = localStorage.getItem('eco_token') || localStorage.getItem('token') || '';

  try {
    const res = await fetch('/api/auth/select-company', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ecoToken
      },
      body: JSON.stringify({ companyId })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Switch failed');
    }

    const data = await res.json();

    // Update accounting token and company name, then reload
    localStorage.setItem('token', data.token);
    localStorage.setItem('eco_company_name', clientName);

    window.location.reload();

  } catch (err) {
    console.error('[CompanyDropdown] switchToClient:', err.message);
    alert('Could not switch to ' + clientName + ': ' + err.message);
    // Reload client list on failure
    _clientsLoaded = false;
    loadAccountingClients();
  }
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('demoMode');
  localStorage.removeItem('sso_source');
  localStorage.removeItem('eco_token');
  localStorage.removeItem('eco_user');
  localStorage.removeItem('eco_companies');
  localStorage.removeItem('eco_super_admin');
  localStorage.removeItem('eco_company_name');
  // Redirect to ECO ecosystem login
  window.location.href = '/';
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createNavigation);
} else {
  createNavigation();
}
