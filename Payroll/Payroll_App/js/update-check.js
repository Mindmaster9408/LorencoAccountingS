/**
 * ============================================================================
 * update-check.js — Shared App Update Detection Utility (Offline Version)
 * ============================================================================
 * Detects when a new deployment has occurred and shows a non-blocking update
 * banner, inviting the user to refresh. Works for both:
 *
 *   A. Pages WITHOUT a service worker (legacy, fallback)
 *      → Polls GET /api/version on load + on tab focus + every 5 minutes
 *      → If the version changes since page load, shows the update banner
 *
 *   B. Pages WITH a service worker (Payroll offline app)
 *      → Listens for SW postMessage { type: 'SW_UPDATED' }
 *      → Also listens for SW registration 'updatefound' event
 *      → Shows the update banner when new SW activates
 *
 * Include this file in any HTML page's <head> or end of <body>:
 *   <script src="/js/update-check.js"></script>
 *
 * For SW-controlled apps, call initSWUpdateCheck(registration) after SW
 * registration to enable the updatefound listener.
 *
 * UX philosophy:
 *   - Non-blocking banner (not a modal, not an alert)
 *   - User can dismiss and continue working
 *   - "Refresh Now" reloads cleanly
 *   - Does NOT auto-reload — never interrupts active form work
 * ============================================================================
 */
(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────────
  const VERSION_ENDPOINT     = '/api/version';
  const POLL_INTERVAL_MS     = 5 * 60 * 1000; // 5 minutes
  const BANNER_ID            = 'app-update-banner';

  // ── State ──────────────────────────────────────────────────────────────────
  let knownVersion   = null;  // version seen on page load
  let bannerShown    = false;
  let pollTimer      = null;

  // ── Banner injection ───────────────────────────────────────────────────────
  function injectBannerStyles() {
    if (document.getElementById('app-update-banner-styles')) return;
    const style = document.createElement('style');
    style.id = 'app-update-banner-styles';
    style.textContent = `
      #${BANNER_ID} {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(80px);
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 20px;
        background: rgba(15, 12, 41, 0.97);
        border: 1px solid rgba(102, 126, 234, 0.45);
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(102,126,234,0.12);
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-size: 0.84rem;
        color: #fff;
        opacity: 0;
        transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.35s ease;
        white-space: nowrap;
        max-width: 95vw;
      }
      #${BANNER_ID}.visible {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
      #${BANNER_ID} .uc-icon { font-size: 1.1rem; flex-shrink: 0; }
      #${BANNER_ID} .uc-text { flex: 1; line-height: 1.4; }
      #${BANNER_ID} .uc-text strong { color: #a5b4fc; }
      #${BANNER_ID} .uc-refresh {
        padding: 7px 16px;
        background: linear-gradient(135deg, #667eea, #764ba2);
        border: none; border-radius: 9px;
        color: #fff; font-size: 0.78rem; font-weight: 700;
        cursor: pointer; flex-shrink: 0; transition: opacity 0.2s;
        white-space: nowrap;
      }
      #${BANNER_ID} .uc-refresh:hover { opacity: 0.88; }
      #${BANNER_ID} .uc-dismiss {
        background: none; border: none;
        color: rgba(255,255,255,0.4); font-size: 1rem;
        cursor: pointer; flex-shrink: 0; padding: 0 4px;
        line-height: 1; transition: color 0.2s;
      }
      #${BANNER_ID} .uc-dismiss:hover { color: rgba(255,255,255,0.7); }
    `;
    document.head.appendChild(style);
  }

  function showUpdateBanner(message) {
    if (bannerShown) return;
    bannerShown = true;

    injectBannerStyles();

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.setAttribute('role', 'alert');
      banner.setAttribute('aria-live', 'polite');
      banner.innerHTML = `
        <span class="uc-icon">&#128260;</span>
        <span class="uc-text">
          <strong>New version available.</strong>
          ${message || 'Refresh to get the latest update.'}
        </span>
        <button class="uc-refresh" onclick="window.location.reload()">Refresh Now</button>
        <button class="uc-dismiss" title="Dismiss" onclick="this.closest('#${BANNER_ID}').remove()">&#10005;</button>
      `;
      document.body.appendChild(banner);
    }

    // Trigger animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => banner.classList.add('visible'));
    });
  }

  // ── Version polling (for pages without SW) ─────────────────────────────────
  async function checkVersion() {
    try {
      const res  = await fetch(VERSION_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const v    = data.version;

      if (!knownVersion) {
        // First check — record the version this page loaded with
        knownVersion = v;
        return;
      }

      if (v !== knownVersion) {
        console.log('[update-check] New version detected:', v, '(was:', knownVersion + ')');
        showUpdateBanner();
        stopPolling();
      }
    } catch (err) {
      // Network error or server down — ignore silently
    }
  }

  function startPolling() {
    // Initial check (sets knownVersion)
    checkVersion();
    // Periodic checks
    pollTimer = setInterval(checkVersion, POLL_INTERVAL_MS);
    // Check when user returns to tab (fast detection)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkVersion();
    });
    window.addEventListener('focus', checkVersion);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── SW update listener (for pages with a service worker) ───────────────────
  // Call this after navigator.serviceWorker.register() resolves.
  // Pass the ServiceWorkerRegistration object.
  window.initSWUpdateCheck = function (registration) {
    if (!registration) return;

    // Listen for a new SW entering 'installing' state
    registration.addEventListener('updatefound', () => {
      const newSW = registration.installing;
      if (!newSW) return;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          // A new SW is installed and waiting — show banner
          console.log('[update-check] New SW installed and waiting');
          showUpdateBanner('Refresh to activate the new version.');
        }
      });
    });

    // Listen for messages from the SW (sent on activate)
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'SW_UPDATED') {
        console.log('[update-check] SW activated:', event.data.version);
        showUpdateBanner();
      }
    });
  };

  // ── Auto-init ──────────────────────────────────────────────────────────────
  // Always start version polling (works even for SW-controlled pages as a
  // secondary fallback, and is the primary mechanism for pages without SW).
  // Runs after DOM is ready so banner can be appended to body.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

})();
