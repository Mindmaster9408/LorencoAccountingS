/**
 * ============================================================================
 * Service Worker — Checkout Charlie POS (Offline-First)
 * ============================================================================
 * Cache strategy:
 *   HTML navigation   → Network-first (always fresh HTML when online)
 *   Other static      → Stale-while-revalidate (instant response + bg refresh)
 *   GET API calls     → Network-first, cache fallback (always try fresh data)
 *   POST/PUT/DELETE   → Network only; offline → queue for background sync
 *
 * POS prioritises speed at the counter (stale-while-revalidate for CSS/JS),
 * while HTML pages are always fetched fresh to pick up UI changes immediately.
 *
 * Cache invalidation:
 *   __BUILD_VERSION__ is replaced at request time by the Express server.
 *   Every deployment generates a new version string → browser detects new
 *   SW bytes → triggers install/activate → old caches are deleted.
 * ============================================================================
 */

const CACHE_VERSION = 'pos-__BUILD_VERSION__';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const DATA_CACHE    = `${CACHE_VERSION}-data`;
const SYNC_QUEUE    = 'pos-sync-queue';

// Static files to pre-cache on install (minimal set for fast SW install)
const STATIC_FILES = [
  '/pos/index.html',
  '/pos/manifest.json',
];

// API endpoints to cache responses for offline use
const API_CACHE_URLS = [
  '/api/pos/products',
  '/api/customers'
];

// ─────────────────────────────────────────────────────────────────────────
// INSTALL — pre-cache minimal shell; activate immediately
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[POS SW] Installing version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_FILES).catch(err => {
        console.warn('[POS SW] Some files not pre-cached:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ACTIVATE — delete ALL old pos-* caches, claim clients, notify of update
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[POS SW] Activating version:', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => (k.startsWith('pos-') || k.startsWith('static-') || k.startsWith('data-') || k.startsWith('checkout-'))
                    && k !== STATIC_CACHE && k !== DATA_CACHE)
          .map(k => {
            console.log('[POS SW] Deleting stale cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => {
        clients.forEach(c => c.postMessage({
          type:    'SW_UPDATED',
          version: CACHE_VERSION
        }));
        console.log(`[POS SW] Notified ${clients.length} client(s) of update`);
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────
// FETCH — route each request to the right strategy
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Never intercept SW update checks or the version endpoint
  if (url.pathname === '/pos/service-worker.js' || url.pathname === '/api/version') return;

  // API requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // HTML navigation — always network-first so users get fresh pages on load
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // Other static (CSS, JS, images) — stale-while-revalidate for POS speed
  event.respondWith(handleStaticAsset(request));
});

// ── Network-first for HTML navigation ────────────────────────────────────
async function handleNavigationRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline — serve cached page
    const cached = await caches.match(request);
    if (cached) return cached;
    // Fall back to index.html for offline navigation
    const shell = await caches.match('/pos/index.html');
    return shell || new Response('Checkout Charlie is offline.', {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ── Stale-while-revalidate for non-navigation static (CSS/JS/images) ──────
// Returns cached version immediately (fast at counter), refreshes in background.
async function handleStaticAsset(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Background refresh — don't wait for it
    refreshAsset(request);
    return cached;
  }
  // Not cached yet — fetch and cache
  return refreshAsset(request);
}

async function refreshAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 408 });
  }
}

// ── Network-first for API GET; cache fallback; queue writes when offline ──
async function handleApiRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    try {
      const networkResponse = await fetch(request);
      if (networkResponse.ok) {
        const cache = await caches.open(DATA_CACHE);
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch {
      console.log('[POS SW] Network failed — serving cached API:', url.pathname);
      const cachedResponse = await caches.match(request);
      if (cachedResponse) return cachedResponse;

      // Offline fallback for key endpoints
      if (url.pathname.includes('/products') || url.pathname.includes('/customers')) {
        return new Response(JSON.stringify({
          products: [], customers: [], offline: true,
          message: 'Using cached data — you are offline'
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Offline and not cached');
    }
  }

  // POST/PUT/DELETE — try network; if offline, queue the request
  try {
    return await fetch(request);
  } catch {
    await queueRequest(request);
    return new Response(JSON.stringify({
      queued: true, offline: true,
      message: 'Transaction saved offline — will sync when online'
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// OFFLINE QUEUE
// ─────────────────────────────────────────────────────────────────────────
async function queueRequest(request) {
  try {
    const body  = await request.clone().text();
    const entry = {
      url: request.url, method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body, timestamp: Date.now()
    };
    const cache  = await caches.open(SYNC_QUEUE);
    const queued = await cache.match('queue').then(r => r ? r.json() : []).catch(() => []);
    queued.push(entry);
    await cache.put('queue', new Response(JSON.stringify(queued), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) {
    console.error('[POS SW] Failed to queue request:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// BACKGROUND SYNC
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-sales') event.waitUntil(syncOfflineSales());
});

async function syncOfflineSales() {
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_SALES' }));
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGES from the main thread
// ─────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
