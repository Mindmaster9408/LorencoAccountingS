/**
 * ============================================================================
 * update-check.js — Shared App Update Detection Utility
 * ============================================================================
 * Detects when a new deployment has occurred. Works for both:
 *
 *   A. Pages WITHOUT a service worker (ecosystem: dashboard, admin, login)
 *      → Polls GET /api/version on load + on tab focus + every 5 minutes
 *      → If the version changes since page load, shows the update banner
 *
 *   B. Pages WITH a service worker (POS, Payroll)
 *      → Listens for SW postMessage { type: 'SW_UPDATED' }
 *      → Also listens for SW registration 'updatefound' event
 *      → Calls registration.update() the moment a new deployment is detected
 *        via the version poll, so the browser actually re-checks the SW file
 *        immediately instead of waiting for its own infrequent (~24h) check —
 *        a kiosk till that never navigates/reloads for weeks would otherwise
 *        never trigger that check on its own.
 *
 * Include this file in any HTML page's <head> or end of <body>:
 *   <script src="/js/update-check.js"></script>
 *
 * For SW-controlled apps, call initSWUpdateCheck(registration) after SW
 * registration to enable the updatefound listener.
 *
 * UX philosophy:
 *   - Default: non-blocking banner (not a modal, not an alert). User can
 *     dismiss and continue working. "Refresh Now" reloads cleanly.
 *   - Opt-in silent auto-reload: if the host page defines a global
 *     `window.isSafeToAutoReload()` predicate, this file waits for it to
 *     return true (polling every 15s once an update is known) and reloads
 *     on its own — no banner, no click, nothing left in anyone's hands.
 *     Pages that don't define this predicate keep the exact banner-only
 *     behavior described above; this is opt-in per page, not a default.
 *     If the predicate itself throws, that is treated as "not safe" for
 *     that check (never silently reload on an error) and falls back to the
 *     manual banner after a few failures so an update is never lost.
 *   - `force_update` is unchanged by any of the above — it still shows the
 *     existing non-dismissible blocking overlay immediately, regardless of
 *     idle state. That path is for breaking changes where continuing to run
 *     old code at all is the greater risk; it is intentionally NOT made to
 *     wait for idle.
 * ============================================================================
 */
(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────────
  const VERSION_ENDPOINT     = '/api/version';
  const POLL_INTERVAL_MS     = 5 * 60 * 1000;  // 5 minutes
  const IDLE_POLL_INTERVAL_MS = 15 * 1000;     // 15 seconds, only once an update is pending
  const IDLE_PREDICATE_MAX_ERRORS = 3;         // fall back to the manual banner after this many thrown errors
  const BANNER_ID            = 'app-update-banner';

  // ── State ──────────────────────────────────────────────────────────────────
  let knownVersion        = null;  // version seen on page load
  let bannerShown         = false;
  let forcedUpdateActive  = false;
  let pollTimer           = null;
  let swRegistration      = null;  // set by initSWUpdateCheck(), used to force an SW re-check
  let awaitingIdleReload  = false;
  let idlePollTimer       = null;
  let idlePredicateErrorCount = 0;

  // Expose current app version so it can be stamped on offline sale records
  window.__posAppVersion = null;

  // ── Banner injection ───────────────────────────────────────────────────────
  function injectBannerStyles() {
    if (document.getElementById('app-update-banner-styles')) return;
    const style = document.createElement('style');
    style.id = 'app-update-banner-styles';
    style.textContent = `
      /* Corner-anchored, fixed narrow width — was a wide bottom-center bar
         (max-width: 95vw) that sat directly on top of whatever table/content
         happened to be at the bottom of the viewport (found live 2026-07-29:
         obscured Stock Management rows). A small bottom-right toast stays
         out of the way of page content while remaining just as visible. */
      #${BANNER_ID} {
        position: fixed;
        bottom: 20px;
        right: 20px;
        transform: translateY(80px);
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: rgba(15, 12, 41, 0.97);
        border: 1px solid rgba(102, 126, 234, 0.45);
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(102,126,234,0.12);
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-size: 0.82rem;
        color: #fff;
        opacity: 0;
        transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.35s ease;
        white-space: normal;
        width: 320px;
        max-width: calc(100vw - 40px);
      }
      #${BANNER_ID}.visible {
        transform: translateY(0);
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

  // Forced update: non-dismissible blocking overlay (no dismiss button).
  // Called when force_update === true and the page is running stale code.
  // If the app defines window.onForceUpdateRequired(version), that handler is
  // called first so it can gate addToCart/checkout with a modal.
  // This banner also shows as a persistent visual indicator.
  function triggerForcedUpdate(newVersion) {
    if (forcedUpdateActive) return;
    forcedUpdateActive = true;

    if (typeof window.onForceUpdateRequired === 'function') {
      window.onForceUpdateRequired(newVersion);
    }

    // Also show a persistent (non-dismissible) banner
    injectBannerStyles();
    let banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove(); // remove soft banner if already shown
    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'assertive');
    banner.style.cssText = 'background: rgba(180,10,10,0.97); border-color: rgba(255,100,100,0.6);';
    banner.innerHTML = `
      <span class="uc-icon">&#9888;&#65039;</span>
      <span class="uc-text">
        <strong>Required update.</strong>
        This version is no longer compatible. Refresh before continuing.
      </span>
      <button class="uc-refresh" onclick="window.location.reload()">Refresh Now</button>
    `;
    document.body.appendChild(banner);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => banner.classList.add('visible'));
    });
  }

  // ── Soft-update handling: silent idle reload where opted in, banner otherwise ──
  // Single entry point for all three "a new soft update exists" signals
  // (version poll, SW updatefound/installed, SW_UPDATED message) so there is
  // exactly one reload-waiting cycle, never several racing each other.
  function handleSoftUpdateDetected(message) {
    if (typeof window.isSafeToAutoReload !== 'function') {
      // This page hasn't opted in — unchanged behavior, exactly as before.
      showUpdateBanner(message);
      return;
    }
    startIdleReloadWait();
  }

  function startIdleReloadWait() {
    if (awaitingIdleReload) return;
    awaitingIdleReload = true;

    const tryReload = () => {
      let safe;
      try {
        safe = window.isSafeToAutoReload();
      } catch (err) {
        // Never treat a throwing predicate as "safe" — count it and, after a
        // few failures, give up on silence and fall back to the manual
        // banner so the update is never lost outright.
        console.warn('[update-check] isSafeToAutoReload() threw:', err);
        idlePredicateErrorCount++;
        if (idlePredicateErrorCount >= IDLE_PREDICATE_MAX_ERRORS) {
          clearInterval(idlePollTimer);
          idlePollTimer = null;
          awaitingIdleReload = false;
          showUpdateBanner();
        }
        return;
      }
      if (safe === true) {
        clearInterval(idlePollTimer);
        idlePollTimer = null;
        window.location.reload();
      }
    };

    idlePollTimer = setInterval(tryReload, IDLE_POLL_INTERVAL_MS);
    tryReload(); // also check immediately — no reason to wait a full interval
  }

  // ── Version polling (for pages without SW, and as the trigger for SW pages) ──
  async function checkVersion() {
    try {
      const res  = await fetch(VERSION_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const v    = data.version;

      if (!knownVersion) {
        // First check — record the version this page loaded with and expose it
        knownVersion = v;
        window.__posAppVersion = v;
        return;
      }

      if (v !== knownVersion) {
        console.log('[update-check] New version detected:', v, '(was:', knownVersion + ')');

        // Force the browser to actually re-check the SW file now, rather than
        // waiting for its own infrequent automatic check — this is what makes
        // the whole SW update cascade (skipWaiting/activate/clients.claim,
        // already correctly built into the SW itself) actually fire promptly.
        if (swRegistration) {
          swRegistration.update().catch(() => {});
        }

        if (data.force_update) {
          triggerForcedUpdate(v);
          stopPolling();
        } else {
          handleSoftUpdateDetected();
          stopPolling();
        }
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
    swRegistration = registration;

    // Listen for a new SW entering 'installing' state
    registration.addEventListener('updatefound', () => {
      const newSW = registration.installing;
      if (!newSW) return;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          // A new SW is installed and waiting — handle per the page's opt-in.
          console.log('[update-check] New SW installed and waiting');
          handleSoftUpdateDetected('Refresh to activate the new version.');
        }
      });
    });

    // Listen for messages from the SW (sent on activate)
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'SW_UPDATED') {
        console.log('[update-check] SW activated:', event.data.version);
        handleSoftUpdateDetected();
      }
      // Existing PAYTIME_SYNC_DONE messages pass through untouched
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
