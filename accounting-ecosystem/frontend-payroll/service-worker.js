/**
 * ============================================================================
 * Service Worker — Lorenco Paytime (Offline-First PWA)
 * ============================================================================
 * Strategy:
 *   Static assets  → Cache-first (serve instantly, refresh in background)
 *   GET API calls  → Network-first, cache fallback (always try fresh data)
 *   POST/PUT/PATCH → Network only; if offline, queue for background sync
 * ============================================================================
 */

const CACHE_VERSION = 'paytime-v1';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const SYNC_QUEUE    = 'paytime-sync-queue';

// ── Static files to precache ───────────────────────────────────────────────
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

// ── API routes to cache on first fetch ────────────────────────────────────
const CACHEABLE_API = [
  '/api/payroll/employees',
  '/api/payroll/periods',
  '/api/payroll/items',
  '/api/payroll/payruns',
  '/api/companies',
];

// ─────────────────────────────────────────────────────────────────────────
// INSTALL — precache static shell
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[Paytime SW] Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_FILES).catch(err => {
        // Non-fatal — some assets may not exist yet; ignore individual failures
        console.warn('[Paytime SW] Some static files not cached:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ACTIVATE — remove stale caches
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[Paytime SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('paytime-') && k !== STATIC_CACHE && k !== API_CACHE)
            .map(k => { console.log('[Paytime SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
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

  // API requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // Static / navigation — cache-first, network fallback
  event.respondWith(handleStaticRequest(request));
});

// ── Cache-first for static assets ─────────────────────────────────────────
async function handleStaticRequest(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Refresh cache in background without blocking response
    refreshCache(request);
    return cached;
  }
  try {
    return await refreshCache(request);
  } catch {
    // Offline and not cached — serve index.html for navigations
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

async function refreshCache(request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

// ── Network-first for API GET; queue writes when offline ──────────────────
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

      // Return empty-but-valid shape so the UI doesn't crash
      return offlineFallback(url.pathname);
    }
  }

  // Mutations (POST / PUT / PATCH / DELETE) — try network, queue if offline
  try {
    return await fetch(request);
  } catch {
    await queueRequest(request);
    return new Response(JSON.stringify({
      queued: true,
      offline: true,
      message: 'Saved offline — will sync automatically when internet returns'
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
}

// Return a safe empty payload so pages degrade gracefully
function offlineFallback(pathname) {
  const body = { offline: true, message: 'Showing cached data — you are offline' };
  if (pathname.includes('employees'))  body.employees  = [];
  if (pathname.includes('payruns'))    body.payruns     = [];
  if (pathname.includes('periods'))    body.periods     = [];
  if (pathname.includes('items'))      body.items       = [];
  if (pathname.includes('companies'))  body.companies   = [];
  return new Response(JSON.stringify(body), {
    status: 200,
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
      url:     request.url,
      method:  request.method,
      headers: Object.fromEntries(request.headers.entries()),
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
// BACKGROUND SYNC — flush queued requests when online
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
      remaining.push(entry); // still offline, keep in queue
    }
  }

  if (remaining.length) {
    await cache.put('queue', new Response(JSON.stringify(remaining), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } else {
    await cache.delete('queue');
  }

  // Tell all open tabs that sync is done
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'PAYTIME_SYNC_DONE', synced: stored.length - remaining.length }));
  console.log(`[Paytime SW] Sync complete — ${stored.length - remaining.length} requests synced`);
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGES from the main thread
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'FLUSH_QUEUE')  flushQueue();
});
