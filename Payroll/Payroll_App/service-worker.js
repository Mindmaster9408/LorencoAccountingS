/**
 * ============================================================================
 * Service Worker — Lorenco Paytime Offline (Desktop App)
 * ============================================================================
 * Cache strategy:
 *   HTML navigation  → Network-first (always fetch fresh pages when online)
 *   Static assets    → Network-first (always fresh when online)
 *   GET API calls    → Network-first, cache fallback (always try fresh data)
 *   POST/PUT/PATCH   → Network only; offline → queue for background sync
 *
 * Why network-first for HTML/static:
 *   After each deployment the server returns updated files. Cache-first would
 *   serve stale HTML/CSS/JS until the user manually hard-refreshed. Network-
 *   first ensures users always get the deployed version when online, while the
 *   cache is still available as an offline fallback.
 *
 * Cache invalidation:
 *   __BUILD_VERSION__ is replaced at request time by the Express server with
 *   the running BUILD_VERSION (env var or startup timestamp). This guarantees
 *   the SW file bytes change on every deployment → browser detects new SW →
 *   installs and activates → old version caches are deleted automatically.
 * ============================================================================
 */

const CACHE_VERSION = 'paytime-offline-__BUILD_VERSION__';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const SYNC_QUEUE    = 'paytime-sync-queue';

// ── Static files to cache for offline fallback ─────────────────────────────
// These are cached after the first network fetch (not pre-fetched on install)
// so install never fails due to missing files during the initial deployment.
const STATIC_FILES = [
  '/',
  '/index.html',
  '/login.html',
  '/company-selection.html',
  '/company-dashboard.html',
  '/payruns.html',
  '/employee-management.html',
  '/employee-detail.html',
  '/attendance.html',
  '/payroll-items.html',
  '/reports.html',
  '/net-to-gross.html',
  '/historical-import.html',
  '/paye-config.html',
  '/paye-reconciliation.html',
  '/paye.html',
  '/company-details.html',
  '/payroll-test.html',
  '/super-admin-dashboard.html',
  '/test-suite.html',
  '/users.html',
  '/manifest.json',
  '/js/polyfills.js',
  '/js/data-access.js',
  '/js/permissions.js',
  '/js/audit.js',
  '/js/demo-company-seed.js',
  '/js/auth.js',
  '/js/payroll-engine.js',
  '/js/mobile-utils.js',
  '/js/pdf-branding.js',
  '/js/export-formats.js',
  '/js/banking-formats.js',
  '/js/bulk-import-utils.js',
  '/js/narrative-generator.js',
  '/js/attendance.js',
  '/js/payroll-items-helper.js',
  '/js/update-check.js',
];

// ── API routes to cache on first successful fetch ──────────────────────────
const CACHEABLE_API = [
  '/api/storage',
  '/api/health',
  '/api/version',
];

// ─────────────────────────────────────────────────────────────────────────
// INSTALL — warm up the static shell into the NEW versioned cache
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[Paytime SW] Installing version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_FILES).catch(err => {
        // Non-fatal — assets may not exist on first deploy; SW still installs
        console.warn('[Paytime SW] Some static files not pre-cached:', err);
      }))
      // skipWaiting immediately: new SW takes over existing tabs so they get
      // the update banner. This is safe because our fetch strategy is
      // network-first — no risk of mixed old/new assets mid-session.
      .then(() => self.skipWaiting())
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ACTIVATE — delete ALL old paytime caches, then claim all clients.
// Notifies open tabs that a new version is now active.
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[Paytime SW] Activating version:', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('paytime-') && k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => {
            console.log('[Paytime SW] Deleting stale cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => {
        // Notify all open tabs that a new version has activated.
        // The update-check.js utility in each page listens for this message
        // and shows the "New version available" banner.
        clients.forEach(c => c.postMessage({
          type:    'SW_UPDATED',
          version: CACHE_VERSION
        }));
        console.log(`[Paytime SW] Notified ${clients.length} client(s) of update`);
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────
// FETCH — route every request through the right strategy
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Never intercept SW update checks or the version endpoint
  if (url.pathname === '/service-worker.js' || url.pathname === '/api/version') return;

  // API requests: network-first, cache fallback, offline queue for writes
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // Static / navigation: network-first when online, cache fallback when offline
  event.respondWith(handleStaticRequest(request));
});

// ── Network-first for static assets and HTML navigation ───────────────────
// Always fetches from network when online — users always see the deployed
// version of any page immediately. Cache is used only when offline.
async function handleStaticRequest(request) {
  try {
    const response = await fetch(request);
    // Cache successful responses for offline fallback
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — serve from cache (offline mode)
    const cached = await caches.match(request);
    if (cached) {
      console.log('[Paytime SW] Offline — serving from cache:', request.url);
      return cached;
    }

    // Nothing cached either — degrade gracefully
    if (request.mode === 'navigate') {
      const shell = await caches.match('/index.html');
      return shell || new Response('Lorenco Paytime is offline. Please try again when connected.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    return new Response('', { status: 408 });
  }
}

// ── Network-first for API GET; cache fallback; queue writes offline ────────
async function handleApiRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    try {
      const networkRes = await fetch(request.clone());
      if (networkRes.ok) {
        const cache = await caches.open(API_CACHE);
        cache.put(request, networkRes.clone());
      }
      return networkRes;
    } catch {
      console.log('[Paytime SW] Offline — serving cached API:', url.pathname);
      const cached = await caches.match(request);
      if (cached) return cached;
      return offlineFallback(url.pathname);
    }
  }

  // Mutations (POST / PUT / PATCH / DELETE) — try network, queue if offline
  try {
    return await fetch(request);
  } catch {
    console.log('[Paytime SW] Offline — queuing mutation:', request.method, url.pathname);
    // Queue this mutation for later sync when connectivity returns
    await queueOfflineRequest(request);
    return new Response(
      JSON.stringify({ queued: true, message: 'Changes saved offline — will sync when connected' }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Queue offline mutation for later sync
async function queueOfflineRequest(request) {
  const body = await request.clone().text();
  const queued = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: body,
    timestamp: Date.now()
  };

  try {
    const db = await openDB();
    const tx = db.transaction([SYNC_QUEUE], 'readwrite');
    const store = tx.objectStore(SYNC_QUEUE);
    store.add(queued);
  } catch {
    console.error('[Paytime SW] Failed to queue request:', queued);
  }
}

// Fallback responses for offline API
function offlineFallback(pathname) {
  if (pathname === '/api/health') {
    return new Response(JSON.stringify({ status: 'offline', database: 'unreachable' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ error: 'Offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Simple IndexedDB helper for offline queue
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('paytime-offline', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SYNC_QUEUE)) {
        db.createObjectStore(SYNC_QUEUE, { autoIncrement: true });
      }
    };
  });
}
