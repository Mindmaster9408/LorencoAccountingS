/* ============================================================================
   Lorenco Ecosystem — Dashboard V2 Script
   ============================================================================
   Security contract:
   - isSuperAdmin is NEVER read from localStorage. Sourced from JWT, confirmed
     from /api/auth/me DB response.
   - hasCoachingAccess is always confirmed from /api/auth/me (same as V1).
   - Workspace switch always calls /api/auth/select-company and updates the
     stored token. No in-memory-only company switching.
   ============================================================================ */

'use strict';

const API_BASE = window.location.origin;

// ── App Definitions (mirrors V1 APP_DEFS — do not diverge) ────────────────────
const APP_DEFS = [
  { key: 'pos',        name: 'Checkout Charlie',   subtitle: 'Point of Sale',          icon: '🛒',  logo: 'assets/branding/checkout-charlie/checkout-charlie-logo-secondary.png', path: '/pos',        css: 'pos' },
  { key: 'payroll',    name: 'Lorenco Paytime',     subtitle: 'Payroll Management',     icon: '💰',  logo: 'assets/branding/paytime/paytime-logo.png',                            path: '/payroll',    css: 'payroll' },
  { key: 'accounting', name: 'Lorenco Accounting',  subtitle: 'General Ledger',         icon: '📊',  logo: null,                                                                  path: '/accounting', css: 'accounting' },
  { key: 'sean',       name: 'SEAN AI',             subtitle: 'Smart Assistant',        icon: '🤖',  logo: null,                                                                  path: '/sean',       css: 'sean' },
  { key: 'coaching',   name: 'Coaching',            subtitle: 'Business Coaching',      icon: '⭐',  logo: null,                                                                  path: '/coaching',   css: 'coaching' },
  { key: 'inventory',  name: 'Lorenco Storehouse',  subtitle: 'Inventory Management',   icon: '📦',  logo: null,                                                                  path: '/inventory',  css: 'inventory' },
  { key: 'practice',   name: 'Lorenco Practice',    subtitle: 'Practice Management',    icon: '📋',  logo: null,                                                                  path: '/practice',   css: 'practice' },
];

// ── Session State ─────────────────────────────────────────────────────────────
let currentUser     = null;
let isSuperAdmin    = false;
let companies       = [];
let selectedCompany = null;
let activeNav       = 'apps';
let allClients      = [];
let platformData    = null; // lazy-loaded when Platform nav is activated

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function authHeaders() {
  const tok = localStorage.getItem('eco_token');
  return tok ? { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' } : {};
}

function parseJWT(tok) {
  try { return JSON.parse(atob(tok.split('.')[1])); } catch (_) { return {}; }
}

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function accountHolderLabel(company) {
  if (!company) return 'Workspace';
  const t = company.account_holder_type || '';
  if (t === 'accounting_practice') return 'Accounting Practice';
  if (t === 'business_owner')      return 'Business Owner';
  if (t === 'individual')          return 'Individual';
  return 'Standalone';
}

function accountHolderBadgeClass(company) {
  const t = company?.account_holder_type || '';
  if (t === 'accounting_practice') return 'badge-practice';
  if (t === 'business_owner')      return 'badge-business';
  return 'badge-client';
}

function companyTypeLabel(c) {
  const t = c.account_holder_type || '';
  if (t === 'accounting_practice') return 'Practice';
  if (t === 'business_owner')      return 'Business';
  if (t === 'individual')          return 'Individual';
  return '';
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const tok = localStorage.getItem('eco_token');
  if (!tok) { window.location.href = '/login'; return; }

  // Step 1: derive isSuperAdmin from JWT (tamper-evident, fast)
  const jwtPayload = parseJWT(tok);
  isSuperAdmin = !!jwtPayload.isSuperAdmin;

  // Step 2: confirm from DB via /me — always authoritative source
  try {
    const meRes = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
    if (!meRes.ok) { window.location.href = '/login'; return; }
    const meData = await meRes.json();
    currentUser  = meData.user;
    isSuperAdmin = !!currentUser.is_super_admin; // DB overrides JWT estimate
    currentUser.hasCoachingAccess = !!meData.hasCoachingAccess;
  } catch (_) {
    window.location.href = '/login';
    return;
  }

  // Step 3: load company list
  try {
    const coRes  = await fetch(`${API_BASE}/api/auth/companies`, { headers: authHeaders() });
    const coData = coRes.ok ? await coRes.json() : {};
    companies    = coData.companies || [];
  } catch (_) {
    companies = [];
  }

  // Step 4: select primary company (super admin lands on Infinite Legacy)
  if (isSuperAdmin) {
    selectedCompany = companies.find(c =>
      c.company_name === 'The Infinite Legacy' || c.trading_name === 'The Infinite Legacy'
    ) || companies.find(c => c.is_primary) || companies[0] || null;
  } else {
    selectedCompany = companies.find(c => c.is_primary) || companies[0] || null;
  }

  // Step 5: ensure JWT matches selected company (fixes stale-JWT bug from V1)
  if (selectedCompany && jwtPayload.companyId !== selectedCompany.id) {
    await switchCompany(selectedCompany.id, false);
  }

  renderAll();
}

// ── Workspace Switch ──────────────────────────────────────────────────────────
// Always calls /api/auth/select-company and stores the returned token.
// This fixes the stale-JWT cross-company data risk identified in the audit.
async function switchCompany(companyId, rerender = true) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/select-company`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ companyId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Company switch failed', true);
      return;
    }
    const data = await res.json();
    localStorage.setItem('eco_token', data.token);

    // Update selectedCompany with fresh data from server
    const merged = { ...(companies.find(c => c.id === companyId) || {}), ...(data.company || {}), role: data.role };
    selectedCompany = merged;

    // Backfill hasCoachingAccess from select-company response
    if (currentUser && data.hasCoachingAccess !== undefined) {
      currentUser.hasCoachingAccess = !!data.hasCoachingAccess;
    }

    // Invalidate client cache — new company context
    allClients = [];
    platformData = null;

    if (rerender) renderAll();
  } catch (err) {
    showToast('Network error during workspace switch', true);
  }
}

// ── Render All ────────────────────────────────────────────────────────────────
function renderAll() {
  renderTopbar();
  renderNav();
  renderHero();
  renderActivePanel();
}

// ── Topbar ────────────────────────────────────────────────────────────────────
function renderTopbar() {
  // User info
  const name = currentUser?.full_name || currentUser?.username || '';
  const role = selectedCompany?.role || (isSuperAdmin ? 'super_admin' : '');
  const el = document.getElementById('topbarUser');
  if (el) {
    el.innerHTML = `<div class="topbar-username">${escHtml(name)}</div>
      <div class="topbar-role">${escHtml(role.replace(/_/g, ' '))}</div>`;
  }

  // Workspace button label
  const co = selectedCompany;
  const tradingOk = co?.trading_name && co.trading_name.toLowerCase() !== 'default';
  const dispName  = co ? escHtml(tradingOk ? co.trading_name : co.company_name) : 'No workspace';
  const codeStr   = co?.practice_code ? `<span class="workspace-code-tag">${escHtml(co.practice_code)}</span>` : '';
  const wBtn = document.getElementById('workspaceBtn');
  if (wBtn) {
    wBtn.innerHTML = `${dispName}${codeStr ? ' ' + codeStr : ''}<span class="workspace-chevron">▾</span>`;
  }

  // Workspace menu items
  renderWorkspaceMenu();
}

function renderWorkspaceMenu() {
  const menu = document.getElementById('workspaceMenu');
  if (!menu) return;
  if (companies.length <= 1) {
    menu.innerHTML = '<div style="padding:8px 10px;font-size:0.75rem;color:var(--text-muted);">No other workspaces</div>';
    return;
  }
  menu.innerHTML = companies.map(c => {
    const isActive = selectedCompany && c.id === selectedCompany.id;
    const tradingOk = c.trading_name && c.trading_name.toLowerCase() !== 'default';
    const label = tradingOk ? c.trading_name : c.company_name;
    const code = c.practice_code ? `<span style="font-family:monospace;font-size:0.65rem;color:var(--accent)">${escHtml(c.practice_code)}</span>` : '';
    const typeLabel = companyTypeLabel(c);
    return `<button class="workspace-item${isActive ? ' active' : ''}" onclick="onWorkspaceSelect(${c.id})">
      <span>${escHtml(label)}${code ? ' ' + code : ''}</span>
      ${typeLabel ? `<span class="workspace-type-tag">${escHtml(typeLabel)}</span>` : ''}
    </button>`;
  }).join('');
}

// Workspace dropdown toggle
function toggleWorkspaceMenu() {
  const menu = document.getElementById('workspaceMenu');
  if (!menu) return;
  menu.classList.toggle('hidden');
}

async function onWorkspaceSelect(companyId) {
  document.getElementById('workspaceMenu')?.classList.add('hidden');
  if (selectedCompany && companyId === selectedCompany.id) return;
  await switchCompany(companyId, true);
}

// Close workspace menu on outside click
document.addEventListener('click', e => {
  const sel = document.getElementById('workspaceSelector');
  if (sel && !sel.contains(e.target)) {
    document.getElementById('workspaceMenu')?.classList.add('hidden');
  }
});

// ── Side Nav ──────────────────────────────────────────────────────────────────

// Single authoritative controller for nav item visibility.
// Uses element.style.display directly — not CSS classes — to avoid CSS specificity gaps.
// Call this whenever selectedCompany, isSuperAdmin, or activeNav changes.
//
// Visibility matrix:
//   Apps     — always visible
//   Clients  — super admin + accounting practice only (practices manage clients)
//   Team     — super admin + practice + business owner (not plain client users)
//   Platform — super admin only
function updateNavigationVisibility() {
  const isPractice    = selectedCompany?.account_holder_type === 'accounting_practice';
  const isOwner       = selectedCompany?.account_holder_type === 'business_owner';
  const isRegularUser = !isSuperAdmin && !isPractice && !isOwner;

  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  };

  show('navClients',  isSuperAdmin || isPractice);
  show('navTeam',     !isRegularUser);
  show('navPlatform', isSuperAdmin);
}

function renderNav() {
  updateNavigationVisibility();
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === activeNav);
  });
}

function setNav(nav) {
  activeNav = nav;
  renderNav();
  renderActivePanel();
}

// ── Hero ──────────────────────────────────────────────────────────────────────
function renderHero() {
  const name = currentUser?.full_name?.split(' ')[0] || currentUser?.username || 'there';
  document.getElementById('heroName').textContent = name;

  // Account type badge
  const badgeEl = document.getElementById('accountTypeBadge');
  if (badgeEl) {
    if (isSuperAdmin) {
      badgeEl.textContent = 'Platform';
      badgeEl.className = 'badge badge-platform';
    } else {
      badgeEl.textContent = accountHolderLabel(selectedCompany);
      badgeEl.className   = 'badge ' + accountHolderBadgeClass(selectedCompany);
    }
  }

  // Practice code badge
  const codeEl = document.getElementById('practiceCodeBadge');
  if (codeEl) {
    if (selectedCompany?.practice_code) {
      codeEl.textContent = selectedCompany.practice_code;
      codeEl.style.display = '';
    } else {
      codeEl.style.display = 'none';
    }
  }

  // Stats — rendered after data loads in panel functions
  renderHeroStats();
}

function renderHeroStats() {
  // Active apps count
  const mods = (selectedCompany?.modules_enabled) || [];
  document.getElementById('statApps').textContent = mods.length || '—';

  // Clients count (if loaded)
  document.getElementById('statClients').textContent = allClients.length > 0 ? allClients.length : '—';

  // Role / team — show from selectedCompany
  const role = selectedCompany?.role || (isSuperAdmin ? 'Platform Admin' : '—');
  document.getElementById('statTeam').textContent = role.replace(/_/g, ' ');

  // Subscription status
  const status = selectedCompany?.subscription_status || '—';
  document.getElementById('statStatus').textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

// ── Panels ────────────────────────────────────────────────────────────────────
function renderActivePanel() {
  ['apps','clients','team','platform'].forEach(id => {
    const el = document.getElementById(`panel${id.charAt(0).toUpperCase() + id.slice(1)}`);
    if (el) el.classList.toggle('hidden', id !== activeNav);
  });

  if (activeNav === 'apps')      renderApps();
  if (activeNav === 'clients')   renderClientsPanel();
  if (activeNav === 'team')      renderTeamPanel();
  if (activeNav === 'platform')  renderPlatformPanel();
}

// ── Apps Panel ────────────────────────────────────────────────────────────────
function renderApps() {
  const grid = document.getElementById('appsGrid');
  if (!grid) return;

  const mods = (selectedCompany?.modules_enabled) || [];
  const userAppsAccess = selectedCompany?.apps_access || null;

  const cards = APP_DEFS.map(app => {
    // SEAN: super admin only
    if (app.key === 'sean' && !isSuperAdmin) return null;
    // Coaching: DB flag only (has_coaching_access)
    if (app.key === 'coaching' && !currentUser?.hasCoachingAccess) return null;

    const canAccess = app.key === 'coaching'
      ? true
      : isSuperAdmin || !userAppsAccess || userAppsAccess.includes(app.key);

    const isActive = app.key === 'coaching'
      ? true
      : canAccess && (isSuperAdmin || mods.includes(app.key));

    if (!canAccess) return null;

    const logoHtml = app.logo
      ? `<div class="app-logo-wrap"><img src="${app.logo}" alt="${escHtml(app.name)}" onerror="this.style.display='none';this.parentElement.innerHTML='<div class=\\'app-icon-wrap ${app.css}\\'>${app.icon}</div>'"></div>`
      : `<div class="app-icon-wrap ${app.css}">${app.icon}</div>`;

    const launchBtn = isActive
      ? `<button class="btn-launch" onclick="launchApp('${app.key}')">Launch →</button>`
      : `<span style="font-size:0.7rem;color:var(--text-muted)">Not activated</span>`;

    return `<div class="app-card-v2 ${isActive ? 'active' : 'inactive'}" onclick="${isActive ? `launchApp('${app.key}')` : ''}">
      ${logoHtml}
      <div class="app-info">
        <div class="app-name">${escHtml(app.name)}</div>
        <div class="app-subtitle">${escHtml(app.subtitle)}</div>
      </div>
      <div class="app-right">
        <div class="app-status-dot ${isActive ? 'on' : ''}"></div>
        ${launchBtn}
      </div>
    </div>`;
  }).filter(Boolean);

  grid.innerHTML = cards.length > 0
    ? cards.join('')
    : '<p style="color:var(--text-muted);font-size:0.82rem;">No apps enabled for this workspace.</p>';
}

// ── Clients Panel ─────────────────────────────────────────────────────────────
async function renderClientsPanel() {
  const grid = document.getElementById('clientsGrid');
  if (!grid) return;
  if (!selectedCompany) { grid.innerHTML = '<p style="color:var(--text-muted)">No workspace selected.</p>'; return; }

  grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;">Loading clients…</p>';

  try {
    const res = await fetch(`${API_BASE}/api/eco-clients?company_id=${selectedCompany.id}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Failed to load clients');
    const data = await res.json();
    allClients = data.clients || [];
    renderHeroStats();
    renderClientCards(grid, allClients);
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--danger);font-size:0.82rem;">${escHtml(err.message)}</p>`;
  }
}

function renderClientCards(grid, clients) {
  if (clients.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;">No clients yet. Add your first client from the Classic dashboard.</p>';
    return;
  }
  grid.innerHTML = clients.map(c => {
    const apps = Array.isArray(c.apps) ? c.apps : [];
    const appBtns = apps.map(key => {
      const def = APP_DEFS.find(a => a.key === key);
      return `<button class="client-app-btn" onclick="launchClientApp(${c.id},${c.client_company_id||'null'},'${key}')">${def ? escHtml(def.name) : escHtml(key)}</button>`;
    }).join('');
    return `<div class="client-card-v2">
      <div class="client-name-v2">${escHtml(c.name)}</div>
      ${c.client_code ? `<div class="client-code-v2">${escHtml(c.client_code)}</div>` : ''}
      <div class="client-meta-v2">${escHtml(c.client_type || 'Business')}${c.email ? ' · ' + escHtml(c.email) : ''}</div>
      ${apps.length > 0 ? `<div class="client-apps-v2">${appBtns}</div>` : '<div style="font-size:0.72rem;color:var(--text-muted)">No apps assigned</div>'}
    </div>`;
  }).join('');
}

// ── Team Panel ────────────────────────────────────────────────────────────────
function renderTeamPanel() {
  const el = document.getElementById('teamContent');
  if (!el) return;
  el.innerHTML = `<div class="team-notice">
    <h3>Team Management</h3>
    <p>Full team and user management, role assignment, and app access controls are available in the Classic Dashboard.</p>
    <a href="/dashboard" class="btn-primary" style="display:inline-block;text-decoration:none;">Open Classic Dashboard →</a>
  </div>`;
}

// ── Platform Panel ────────────────────────────────────────────────────────────
async function renderPlatformPanel() {
  if (!isSuperAdmin) return;
  const el = document.getElementById('platformContent');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;">Loading platform data…</p>';

  try {
    // Fetch all account holders via eco-clients (admin view)
    if (!platformData) {
      const [clientsRes, companiesRes] = await Promise.all([
        fetch(`${API_BASE}/api/eco-clients?status=all`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/companies`, { headers: authHeaders() }),
      ]);
      const clientsJson = clientsRes.ok ? await clientsRes.json() : {};
      platformData = {
        clients: clientsJson.clients || [],
        companies: companies, // already loaded at init
      };
    }

    renderPlatformView(el);
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger);font-size:0.82rem;">${escHtml(err.message)}</p>`;
  }
}

function renderPlatformView(el) {
  const practiceCompanies = companies.filter(c => c.account_holder_type === 'accounting_practice');
  const ownerCompanies    = companies.filter(c => c.account_holder_type === 'business_owner');
  const standalones       = companies.filter(c => !c.account_holder_type || c.account_holder_type === 'individual');

  const makeCard = (c) => {
    const tradingOk = c.trading_name && c.trading_name.toLowerCase() !== 'default';
    const displayName = tradingOk ? c.trading_name : c.company_name;
    const mods = (c.modules_enabled || []).join(', ') || 'none';
    const statusCls = c.subscription_status === 'active' ? 'tag-active' : c.subscription_status === 'demo' ? 'tag-demo' : 'tag-inactive';
    const clientCount = (platformData?.clients || []).filter(cl => cl.company_id === c.id).length;

    return `<div class="platform-card">
      <div class="platform-card-name">${escHtml(displayName)}</div>
      ${c.practice_code ? `<div class="platform-card-code">${escHtml(c.practice_code)}</div>` : ''}
      <div class="platform-meta-row"><span class="platform-meta-key">Account type</span><span class="platform-meta-val">${escHtml(accountHolderLabel(c))}</span></div>
      <div class="platform-meta-row"><span class="platform-meta-key">Status</span><span class="platform-meta-val ${statusCls}">${escHtml(c.subscription_status || '—')}</span></div>
      <div class="platform-meta-row"><span class="platform-meta-key">Active modules</span><span class="platform-meta-val">${escHtml(mods)}</span></div>
      ${clientCount > 0 ? `<div class="platform-meta-row"><span class="platform-meta-key">Managed clients</span><span class="platform-meta-val">${clientCount}</span></div>` : ''}
      <a href="/admin" class="platform-link">Full management →</a>
    </div>`;
  };

  const section = (title, list) => list.length === 0 ? '' : `
    <div style="margin-bottom:24px;">
      <div class="section-title" style="margin-bottom:12px;">${title} (${list.length})</div>
      <div class="platform-grid">${list.map(makeCard).join('')}</div>
    </div>`;

  el.innerHTML = `
    <div class="platform-header">
      <h2>Platform Control Centre</h2>
      <p>Billing and service metadata only. Client operational data is not visible here.</p>
    </div>
    ${section('Accounting Practices', practiceCompanies)}
    ${section('Business Owners', ownerCompanies)}
    ${section('Standalone / Individual', standalones)}
    <div style="margin-top:16px;">
      <a href="/admin" class="btn-outline" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;">
        Full Admin Panel →
      </a>
    </div>`;
}

// ── SSO Auth Failure (shared — used by launchApp and launchClientApp) ────────
function handleSsoAuthFailure() {
  hideLaunchOverlay();
  localStorage.removeItem('eco_token');
  localStorage.removeItem('eco_user');
  alert('Your session has expired. Please log in again.');
  window.location.href = '/login';
}

// ── App Launch (SSO — mirrors V1 exactly) ─────────────────────────────────────
async function launchApp(appKey) {
  const app = APP_DEFS.find(a => a.key === appKey);
  if (!app) return;

  showLaunchOverlay(`Launching ${app.name}…`);

  if (appKey === 'coaching') {
    try {
      const res = await fetch(`${API_BASE}/api/auth/sso-launch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetApp: 'coaching', companyId: selectedCompany?.id || null }),
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('auth_token', data.appToken);
        localStorage.setItem('user', JSON.stringify(data.user));
        localStorage.setItem('sso_source', 'ecosystem');
      }
    } catch (_) {}
    setLaunchText(`Opening ${app.name}…`);
    setTimeout(() => { window.location.href = app.path; }, 400);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/sso-launch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ targetApp: appKey, companyId: selectedCompany?.id || null }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        handleSsoAuthFailure();
        return;
      }
      throw new Error(err.error || 'SSO launch failed');
    }

    const data = await res.json();
    localStorage.setItem('token', data.appToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.removeItem('company');

    const cSrc = data.company || selectedCompany;
    if (cSrc) {
      const cid   = String(cSrc.id);
      const cname = cSrc.trading_name || cSrc.company_name || '';
      localStorage.setItem('activeCompanyId',   cid);
      localStorage.setItem('selectedCompanyId', cid);
      localStorage.setItem('eco_company_name',  cname);
    }
    localStorage.setItem(`${appKey}_token`, data.appToken);
    localStorage.setItem(`${appKey}_user`, JSON.stringify(data.user));
    localStorage.setItem('sso_source', 'ecosystem');

    setLaunchText(`Opening ${app.name}…`);
    setTimeout(() => { window.location.href = app.path; }, 500);
  } catch (err) {
    hideLaunchOverlay();
    showToast(err.message || 'Launch failed', true);
  }
}

// Launch app in context of a specific client's company
async function launchClientApp(clientId, clientCompanyId, appKey) {
  const app = APP_DEFS.find(a => a.key === appKey);
  if (!app) return;
  if (!clientCompanyId) { showToast('Client company not found', true); return; }

  showLaunchOverlay(`Opening ${app.name} for client…`);

  try {
    const res = await fetch(`${API_BASE}/api/auth/sso-launch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ targetApp: appKey, companyId: clientCompanyId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        handleSsoAuthFailure();
        return;
      }
      throw new Error(err.error || 'SSO launch failed');
    }

    const data = await res.json();
    localStorage.setItem('token', data.appToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.removeItem('company');

    const cSrc = data.company || {};
    if (cSrc.id) {
      localStorage.setItem('activeCompanyId',   String(cSrc.id));
      localStorage.setItem('selectedCompanyId', String(cSrc.id));
      localStorage.setItem('eco_company_name',  cSrc.trading_name || cSrc.company_name || '');
    }
    localStorage.setItem(`${appKey}_token`, data.appToken);
    localStorage.setItem(`${appKey}_user`, JSON.stringify(data.user));
    localStorage.setItem('sso_source', 'ecosystem');

    setLaunchText(`Opening ${app.name}…`);
    setTimeout(() => { window.location.href = app.path; }, 500);
  } catch (err) {
    hideLaunchOverlay();
    showToast(err.message || 'Launch failed', true);
  }
}

function showLaunchOverlay(msg) {
  const el = document.getElementById('launchOverlay');
  if (el) el.classList.add('show');
  setLaunchText(msg);
}
function setLaunchText(msg) {
  const el = document.getElementById('launchText');
  if (el) el.textContent = msg;
}
function hideLaunchOverlay() {
  document.getElementById('launchOverlay')?.classList.remove('show');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
