// Shared Navigation Component for Lorenco Accounting
// This file creates a consistent navigation bar across all pages

function createNavigation() {
  const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';

  const navHTML = `
    <div class="top-bar">
      <div class="brand-section">
        <div class="logo">
          <div class="logo-icon">L</div>
          <span>Lorenco</span>
        </div>
        <div class="company-selector" id="companySelectorBtn">
          <span id="navCompanyName">Business Current Account</span>
          <span style="opacity: 0.7;">▼</span>
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
          <span style="opacity: 0.7; font-size: 11px;">▼</span>
          <div class="user-dropdown" id="userDropdown">
            <a href="profile.html">My Profile</a>
            <a href="settings.html">Settings</a>
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
        <a href="dashboard.html">Home</a>
        <div class="dropdown">
          <a href="dashboard.html">Dashboard Overview</a>
          <a href="#">My Tasks</a>
          <a href="#">Favorites</a>
          <a href="#">Recent Activity</a>
        </div>
      </div>

      <div class="nav-item">
        <a href="#">Quick View</a>
        <div class="dropdown">
          <a href="#">Summary</a>
          <a href="cashflow.html">Cash Flow</a>
          <a href="#">P&L Overview</a>
          <a href="balance-sheet.html">Balance Sheet Summary</a>
        </div>
      </div>

      <div class="nav-item ${currentPage.includes('customer') || currentPage === 'invoices.html' ? 'active' : ''}">
        <a href="#">Customers</a>
        <div class="dropdown">
          <div class="dropdown-header">Sales</div>
          <a href="customer-list.html">Customer List</a>
          <a href="#">New Customer</a>
          <a href="invoices.html">Invoices</a>
          <a href="#">Quotes</a>
          <a href="#">Credit Notes</a>
          <div class="dropdown-header">Payments</div>
          <a href="customer-receipts.html">Customer Receipts</a>
          <a href="aged-debtors.html">Customer Aging</a>
        </div>
      </div>

      <div class="nav-item">
        <a href="#">Suppliers</a>
        <div class="dropdown">
          <div class="dropdown-header">Purchases</div>
          <a href="#">Supplier List</a>
          <a href="#">New Supplier</a>
          <a href="#">Purchase Orders</a>
          <a href="#">Supplier Invoices</a>
          <div class="dropdown-header">Payments</div>
          <a href="#">Supplier Payments</a>
          <a href="aged-creditors.html">Supplier Aging</a>
        </div>
      </div>

      <div class="nav-item">
        <a href="#">Items</a>
        <div class="dropdown">
          <a href="#">Product List</a>
          <a href="#">Service List</a>
          <a href="#">New Item</a>
          <a href="#">Stock Adjustments</a>
          <a href="#">Price Lists</a>
        </div>
      </div>

      <div class="nav-item ${currentPage.includes('bank') ? 'active' : ''}">
        <a href="bank.html">Banking</a>
        <div class="dropdown">
          <a href="bank.html">Bank Transactions</a>
          <a href="bank-reconciliation.html">Bank Reconciliation</a>
          <a href="#">Payment Processing</a>
          <a href="#">Bank Rules</a>
          <a href="#">Import Statements</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'accounts.html' || currentPage === 'journals.html' || currentPage === 'trial-balance.html' ? 'active' : ''}">
        <a href="accounts.html">Accounts</a>
        <div class="dropdown">
          <a href="accounts.html">Chart of Accounts</a>
          <a href="journals.html">Journal Entries</a>
          <a href="#">Nominal Ledger</a>
          <a href="trial-balance.html">Trial Balance</a>
          <a href="#">Period End</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'reports.html' || currentPage === 'balance-sheet.html' || currentPage === 'cashflow.html' ? 'active' : ''}">
        <a href="reports.html">Reports</a>
        <div class="dropdown">
          <div class="dropdown-header">Financial</div>
          <a href="reports.html">Profit & Loss</a>
          <a href="balance-sheet.html">Balance Sheet</a>
          <a href="cashflow.html">Cash Flow Statement</a>
          <a href="trial-balance.html">Trial Balance</a>
          <div class="dropdown-header">Analysis</div>
          <a href="sales-analysis.html">Sales Analysis</a>
          <a href="purchase-analysis.html">Purchase Analysis</a>
          <a href="vat-return.html">VAT Return</a>
          <a href="aged-debtors.html">Aged Debtors</a>
          <a href="aged-creditors.html">Aged Creditors</a>
        </div>
      </div>

      <div class="nav-item ${currentPage.includes('paye') || currentPage.includes('vat') ? 'active' : ''}">
        <a href="#">Tax</a>
        <div class="dropdown">
          <div class="dropdown-header">PAYE</div>
          <a href="paye.html">PAYE Overview</a>
          <a href="paye-reconciliation.html">PAYE Reconciliation</a>
          <a href="paye-config.html">PAYE Configuration</a>
          <div class="dropdown-header">VAT</div>
          <a href="vat.html">VAT Returns</a>
          <a href="vat-return.html">VAT Report</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'company.html' || currentPage === 'contacts.html' ? 'active' : ''}">
        <a href="company.html">Company</a>
        <div class="dropdown">
          <a href="company.html">Company Profile</a>
          <a href="company.html">Company Settings</a>
          <a href="contacts.html">Contacts</a>
          <a href="#">Users & Permissions</a>
          <a href="#">Financial Year</a>
          <a href="#">Tax Settings</a>
          <a href="#">Backup & Restore</a>
          <a href="settings.html">General Settings</a>
        </div>
      </div>

      <div class="nav-item ${currentPage === 'ai-settings.html' || currentPage === 'system-health.html' ? 'active' : ''}">
        <a href="#">Administration</a>
        <div class="dropdown">
          <div class="dropdown-header">Monitoring</div>
          <a href="#">Audit Log</a>
          <a href="system-health.html">System Health</a>
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
          <a href="ai-settings.html">AI Settings</a>
          <a href="#">AI Review Queue</a>
          <a href="company.html#teach-sean">Teach Sean</a>
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
      }

      .company-selector:hover {
        background: rgba(255,255,255,0.25);
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
        content: '▼';
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
        content: '→';
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
  // Get user info from localStorage
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const demoMode = localStorage.getItem('demoMode') === 'true';

  // Update user display
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  const userNameEl = document.getElementById('navUserName');
  if (userNameEl) {
    userNameEl.textContent = fullName || user.email || 'Demo User';
  }

  // Set user avatar initial
  const avatarEl = document.getElementById('navUserAvatar');
  if (avatarEl) {
    const initial = (user.firstName?.[0] || user.email?.[0] || 'D').toUpperCase();
    avatarEl.textContent = initial;
  }

  // Update company name
  const companyNameEl = document.getElementById('navCompanyName');
  if (companyNameEl) {
    companyNameEl.textContent = user.companyName || 'Business Current Account';
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

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  const userMenu = document.querySelector('.user-menu');
  const dropdown = document.getElementById('userDropdown');
  if (dropdown && userMenu && !userMenu.contains(e.target)) {
    dropdown.classList.remove('show');
  }
});

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('demoMode');
  window.location.href = 'login.html';
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createNavigation);
} else {
  createNavigation();
}
