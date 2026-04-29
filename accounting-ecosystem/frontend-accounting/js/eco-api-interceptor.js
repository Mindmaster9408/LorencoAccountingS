/**
 * ECO Systum API Interceptor for Lorenco Accounting
 *
 * Automatically rewrites API calls from /api/* to /api/accounting/*
 * so that Lorenco Accounting pages work within the ECO Systum module system
 * without modifying each HTML page individually.
 *
 * Also handles SSO token bridging from ECO ecosystem.
 */
(function() {
  'use strict';

  // ─── API URL Rewriting ──────────────────────────────────────────────────────
  // Routes that must NOT be rewritten — they are ECO-shared endpoints, not
  // accounting-module endpoints. Adding /api/accounting/ prefix would 404 them.
  const ECO_SHARED_PREFIXES = [
    '/api/eco-clients',
    '/api/auth/',
    '/api/employees',
    '/api/audit',
  ];

  function isEcoSharedRoute(u) {
    return ECO_SHARED_PREFIXES.some(p => u.startsWith(p));
  }

  function rewriteUrl(u) {
    if (u.startsWith('/api/') && !u.startsWith('/api/accounting/') && !isEcoSharedRoute(u)) {
      return u.replace('/api/', '/api/accounting/');
    }
    return u;
  }

  const originalFetch = window.fetch;

  window.fetch = function(url, options) {
    if (typeof url === 'string') {
      url = rewriteUrl(url);
      // Handle absolute URLs (e.g. http://localhost:3000/api/...)
      if (url.includes('://')) {
        const match = url.match(/^(https?:\/\/[^/]+)(\/api\/.*)$/);
        if (match) {
          const rewritten = rewriteUrl(match[2]);
          if (rewritten !== match[2]) url = match[1] + rewritten;
        }
      }
    }
    return originalFetch.call(this, url, options);
  };

  // Also intercept XMLHttpRequest for any pages using it
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string') {
      url = rewriteUrl(url);
      if (url.includes('://')) {
        const match = url.match(/^(https?:\/\/[^/]+)(\/api\/.*)$/);
        if (match) {
          const rewritten = rewriteUrl(match[2]);
          if (rewritten !== match[2]) url = match[1] + rewritten;
        }
      }
    }
    return originalXHROpen.call(this, method, url, ...rest);
  };

  // ─── SSO Token Bridge ──────────────────────────────────────────────────────
  // If user came from ECO ecosystem SSO, bridge the token
  const ssoSource = localStorage.getItem('sso_source');
  if (ssoSource === 'ecosystem') {
    // ECO SSO stores token as 'token' — same key Lorenco uses, so no bridging needed
    // But ensure user info is available in Lorenco's expected format
    const ecoUser = localStorage.getItem('eco_user');
    if (ecoUser && !localStorage.getItem('user')) {
      try {
        const parsed = JSON.parse(ecoUser);
        // Map ECO user shape to Lorenco user shape
        const lorencoUser = {
          id: parsed.userId || parsed.id,
          email: parsed.email || parsed.username,
          firstName: parsed.fullName ? parsed.fullName.split(' ')[0] : (parsed.firstName || ''),
          lastName: parsed.fullName ? parsed.fullName.split(' ').slice(1).join(' ') : (parsed.lastName || ''),
          role: parsed.role,
          companyName: localStorage.getItem('eco_company_name') || 'Company',
          isGlobalAdmin: parsed.isSuperAdmin || parsed.isGlobalAdmin || false
        };
        localStorage.setItem('user', JSON.stringify(lorencoUser));
      } catch (e) {
        // Silently fail — user display will fall back to defaults
      }
    }
  }

  // ─── Auth Redirect Override ─────────────────────────────────────────────────
  // Override any redirect to login.html to go to ECO login instead
  const originalLocationAssign = window.location.assign;
  const originalLocationReplace = window.location.replace;

  function interceptRedirect(url) {
    if (typeof url === 'string' && (url.includes('login.html') || url === 'login.html')) {
      return '/';
    }
    return url;
  }

  // Note: Direct assignment to window.location.href is caught by navigation.js logout override
})();
