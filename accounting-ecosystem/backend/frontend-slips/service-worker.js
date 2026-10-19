/**
 * ============================================================================
 * Service Worker — Slip Capture
 * ============================================================================
 * Exists so the app is installable and opens instantly from the home screen.
 * It caches ONLY the static app shell (HTML/CSS/JS/icons).
 *
 * It never touches /api/ or any slip file: slip data and images must not be
 * kept in browser storage (CLAUDE.md Part D), and Cache Storage is browser
 * storage. Those requests go straight to the network.
 *
 * __BUILD_VERSION__ is replaced by server.js (serveSW) on every deploy, so a
 * new deploy installs a new worker and old shell caches are deleted.
 * ============================================================================
 */

const CACHE = 'slips-shell-__BUILD_VERSION__';
const SHELL = [
  '/slips/',
  '/slips/css/slips.css',
  '/slips/js/app.js',
  '/slips/manifest.json',
  '/slips/icons/icon-192.png',
  '/slips/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => { /* partial shell is fine */ }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('slips-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // signed slip URLs (Supabase) — never cached
  if (!url.pathname.startsWith('/slips/')) return;      // includes every /api/ call
  if (url.pathname === '/slips/service-worker.js') return;

  // Network-first: always fresh when online; cached shell only as an offline fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/slips/')))
  );
});
