/**
 * ============================================================================
 * Service Worker — Lorenco Paytime (Offline-Capable PWA)
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

const CACHE_VERSION = 'paytime-__BUILD_VERSION__';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const SYNC_QUEUE    = 'paytime-sync-queue';

// ── Static files to cache for offline fallback ─────────────────────────────
// These are cached after the first network fetch (not pre-fetched on install)
// so install never fails due to missing files during the initial deployment.
const STATIC_FILES = [
  '/payroll/',
  '/payroll/index.html',
  '/payroll/login.html',
  '/payroll/company-selection.html',
  '/payroll/company-dashboard.html',
  '/payroll/payruns.html',
  '/payroll/employee-management.html',
  '/payroll/employee-detail.html',
  '/payroll/attendance.html',
  '/payroll/payroll-items.html',
  '/payroll/reports.html',
  '/payroll/manifest.json',
  '/payroll/css/dark-theme.css',
  '/payroll/css/mobile-responsive.css',
  '/payroll/js/auth.js',
  '/payroll/js/data-access.js',
  '/payroll/js/payroll-engine.js',
  '/payroll/js/permissions.js',
  '/payroll/js/mobile-utils.js',
  '/payroll/js/pdf-branding.js',
  '/payroll/js/export-formats.js',
  '/payroll/js/banking-formats.js',
  '/payroll/js/bulk-import-utils.js',
  '/payroll/js/narrative-generator.js',
  '/payroll/js/attendance.js',
  '/payroll/js/payroll-items-helper.js',
];

// ── API routes to cache on first successful fetch ──────────────────────────
const CACHEABLE_API = [
  '/api/payroll/employees',
  '/api/payroll/periods',
  '/api/payroll/items',
  '/api/payroll/payruns',
  '/api/companies',
];

// ─────────────────────────────────────────────────────────────────────────
// INSTALL — warm up the static shell into the NEW versioned cache
// Does not call skipWaiting here — let the update notification flow control
// when the new SW takes over (after user acknowledges the update banner).
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
  if (url.pathname === '/payroll/service-worker.js' || url.pathname === '/api/version') return;

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
      const shell = await caches.match('/payroll/index.html');
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
    await queueRequest(request);
    return new Response(JSON.stringify({
      queued:  true,
      offline: true,
      message: 'Saved offline — will sync automatically when internet returns'
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
}

// Return a safe empty payload so pages degrade gracefully offline
function offlineFallback(pathname) {
  const body = { offline: true, message: 'Showing cached data — you are offline' };
  if (pathname.includes('employees'))  body.employees  = [];
  if (pathname.includes('payruns'))    body.payruns     = [];
  if (pathname.includes('periods'))    body.periods     = [];
  if (pathname.includes('items'))      body.items       = [];
  if (pathname.includes('companies'))  body.companies   = [];
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: { 'Content-Type': 'application/json', 'X-Paytime-Offline': 'true' }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// OFFLINE QUEUE — persist failed mutations in Cache Storage
// ─────────────────────────────────────────────────────────────────────────
async function queueRequest(request) {
  try {
    const body   = await request.clone().text();
    const entry  = {
      url:       request.url,
      method:    request.method,
      headers:   Object.fromEntries(request.headers.entries()),
      body,
      timestamp: Date.now()
    };
    const cache  = await caches.open(SYNC_QUEUE);
    const queued = await cache.match('queue').then(r => r ? r.json() : []).catch(() => []);
    queued.push(entry);
    await cache.put('queue', new Response(JSON.stringify(queued), {
      headers: { 'Content-Type': 'application/json' }
    }));
    console.log('[Paytime SW] Queued offline request:', request.method, request.url);
  } catch (e) {
    console.error('[Paytime SW] Failed to queue request:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BACKGROUND SYNC — flush queued requests when back online
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'paytime-sync') {
    event.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  console.log('[Paytime SW] Background sync — flushing offline queue...');
  const cache  = await caches.open(SYNC_QUEUE);
  const stored = await cache.match('queue').then(r => r ? r.json() : []).catch(() => []);
  if (!stored.length) return;

  const remaining = [];
  for (const entry of stored) {
    try {
      const res = await fetch(entry.url, {
        method:  entry.method,
        headers: entry.headers,
        body:    entry.body || undefined,
      });
      if (!res.ok) remaining.push(entry);
      else console.log('[Paytime SW] Synced:', entry.method, entry.url);
    } catch {
      remaining.push(entry); // still offline — keep in queue
    }
  }

  if (remaining.length) {
    await cache.put('queue', new Response(JSON.stringify(remaining), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } else {
    await cache.delete('queue');
  }

  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({
    type:   'PAYTIME_SYNC_DONE',
    synced: stored.length - remaining.length
  }));
  console.log(`[Paytime SW] Sync complete — ${stored.length - remaining.length} requests synced`);
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGES from the main thread
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'FLUSH_QUEUE')  flushQueue();
});
