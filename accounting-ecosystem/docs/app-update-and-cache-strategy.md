# App Update and Cache Strategy

> Last updated: March 2026
> Covers: All apps in the Lorenco accounting ecosystem

---

## 1. Root Cause — Why Manual Refresh Was Required

Three independent caching layers combined to trap users on stale versions after every deployment.

### Layer 1: Service Worker — Cache-First Strategy (Primary Cause)

Both service workers (POS and Payroll) used **cache-first** strategy for all static requests — HTML, CSS, JS, images.

```
User loads page → SW intercepts → returns cached version → stale UI
```

The cache name was hardcoded (`checkout-charlie-v1`, `paytime-v1`). The `activate` handler only deleted caches with OTHER names, never the current one. Result: old cached HTML/JS/CSS served forever. Manual hard-refresh (`Ctrl+Shift+R`) bypassed the SW and fixed it temporarily.

### Layer 2: Static Cache Names Never Changed (Secondary Cause)

The SW is a separate file detected by byte-comparison. When only HTML/CSS/JS changed but the SW file was unchanged, the browser saw the same SW bytes and did **not** trigger an update. The existing SW continued serving stale cached content with no awareness that a deployment had occurred.

### Layer 3: No Cache-Control Headers on HTML (Contributing Cause)

`express.static()` was called with no options. Express defaults to `Cache-Control: public, max-age=0` which relies on ETag revalidation. While this works for the browser's own cache, it had no effect on service worker caches (which bypass HTTP headers entirely).

Additionally, the named HTML routes (`app.get('/admin', ...)`) called `res.sendFile()` without any headers, relying on Express defaults — no explicit `no-cache` directive.

### Failure Chain

```
1. User visits app for first time
   → SW installs → pre-caches all HTML/JS/CSS into 'paytime-v1-static'

2. New code is deployed to Zeabur (new Docker container)
   → Server has new HTML/JS/CSS
   → SW file bytes are unchanged (only app code changed)
   → Browser: "Same SW file, no update needed"

3. User navigates to any payroll page
   → SW intercepts → matches 'paytime-v1-static' cache → returns OLD cached HTML
   → User sees stale UI

4. User must press Ctrl+Shift+R (hard refresh) to bypass SW
   → Gets fresh content from server
   → On next normal refresh, old SW is back in control (stale again)
```

---

## 2. How Updates Work Now

### A. HTML and Static Pages

**Server → browser:**
All HTML files now served with `Cache-Control: no-cache, no-store, must-revalidate`. The browser never caches HTML files on its own. This removes one entire caching layer.

**Service worker → browser:**
Both service workers now use **network-first** strategy for HTML navigation requests. When the user navigates to any page, the SW fetches fresh content from the server first. Cache is used only when offline.

```
User loads page → SW intercepts → fetches from server → returns fresh HTML
```

For POS specifically, non-navigation static assets (CSS/JS) still use stale-while-revalidate (returns cached version instantly for POS speed, refreshes cache in background). Navigation (HTML page loads) is always network-first.

### B. Service Worker Self-Update

The server now serves `service-worker.js` files **dynamically**, replacing the `__BUILD_VERSION__` placeholder with the running `BUILD_VERSION` string at request time.

`BUILD_VERSION` = `process.env.BUILD_VERSION` (set in Zeabur deployment config) OR `Date.now().toString(36)` (startup timestamp as fallback).

Every new Zeabur deployment restarts the Docker container → new startup timestamp → new `BUILD_VERSION` → SW file bytes are different → browser detects SW change → installs new SW.

```
New deployment → new BUILD_VERSION → different SW bytes → browser installs new SW
→ SW activate: deletes all stale caches → users get fresh content
```

### C. Update Notification Banner

When a new SW activates, it sends `postMessage({ type: 'SW_UPDATED' })` to all open tab clients.

The `update-check.js` utility loaded in HTML pages listens for:
1. `SW_UPDATED` message from the SW (for SW-controlled apps)
2. `updatefound` event on SW registration (for pages that register the SW)
3. Version change from polling `GET /api/version` (for all pages — fallback)

When any of these triggers fires, a non-blocking update banner appears:

```
┌──────────────────────────────────────────────────────────────┐
│ 🔄 New version available. Refresh to get the latest update.  │
│                                        [Refresh Now]  [✕]    │
└──────────────────────────────────────────────────────────────┘
```

Users are never auto-reloaded. They can click "Refresh Now" or dismiss and continue working.

---

## 3. Cache-Control Rules

| Content Type                    | Cache-Control                      | Reason                                    |
|---------------------------------|------------------------------------|-------------------------------------------|
| HTML files (`*.html`)           | `no-cache, no-store, must-revalidate` | Always fresh — core of update strategy |
| JS/CSS/images (static assets)   | `public, max-age=3600`             | 1-hour cache; ETag revalidation on expiry |
| Service worker files            | `no-cache, no-store, must-revalidate` | Browser must always check for new SW   |
| `/api/version`                  | `no-cache, no-store, must-revalidate` | Version polling must always be fresh   |
| All other API endpoints         | No cache (Express default)         | Data must always be current               |

---

## 4. Service Worker Rules

### Cache strategy per request type

| Request type               | POS strategy                          | Payroll strategy          |
|---------------------------|---------------------------------------|---------------------------|
| HTML navigation           | Network-first, cache offline fallback | Network-first, cache offline fallback |
| CSS / JS / images         | Stale-while-revalidate                | Network-first, cache offline fallback |
| API GET                   | Network-first, cache fallback         | Network-first, cache fallback |
| API POST/PUT/DELETE       | Network only; offline → queue         | Network only; offline → queue |

### Cache naming convention

```
pos-<BUILD_VERSION>-static      (POS static assets)
pos-<BUILD_VERSION>-data        (POS API responses)
paytime-<BUILD_VERSION>-static  (Payroll static assets)
paytime-<BUILD_VERSION>-api     (Payroll API responses)
paytime-sync-queue              (Offline mutation queue — permanent name)
pos-sync-queue                  (Offline mutation queue — permanent name)
```

The sync queues use permanent names so offline-queued mutations survive SW updates.

### SW update lifecycle

```
Browser detects new SW bytes (BUILD_VERSION changed)
  → SW install: pre-caches STATIC_FILES into new versioned cache
  → SW install: calls skipWaiting() → immediately takes control
  → SW activate: deletes all old paytime-*/pos-* caches except current
  → SW activate: calls clients.claim() → takes over all open tabs
  → SW activate: sends SW_UPDATED message to all open tabs
  → Pages show update banner
```

### SW version injection — how it works

```
Express server.js:
  const BUILD_VERSION = process.env.BUILD_VERSION || Date.now().toString(36);

  app.get('/payroll/service-worker.js', (req, res) => {
    const content = fs.readFileSync(swPath, 'utf8')
      .replace(/__BUILD_VERSION__/g, BUILD_VERSION);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(content);
  });

Service worker file contains:
  const CACHE_VERSION = 'paytime-__BUILD_VERSION__';
```

On each request to the SW URL, the server replaces `__BUILD_VERSION__` with the running version. The browser does a byte comparison on every page load. Different bytes → new SW install.

---

## 5. Build Version Strategy

`BUILD_VERSION` is set in this order of preference:

1. **`process.env.BUILD_VERSION`** (set in Zeabur deployment): Set this to the git commit SHA or a release tag for reliable per-deployment versioning.
2. **`Date.now().toString(36)`** (startup timestamp): Fallback — changes every container restart. Works correctly for Zeabur (every deployment = new container = new start time).

**Recommended Zeabur setup:**
In Zeabur dashboard → Service → Environment Variables:
```
BUILD_VERSION = <git-commit-sha>
```

This can be injected at build time via Zeabur's build hooks or CI pipeline.

Without this, the startup timestamp fallback works correctly — every new deployment generates a new timestamp, which is sufficient to trigger SW updates.

---

## 6. User Update Experience

**When a deployment occurs and the user has the app open:**

1. User is using the app normally
2. If their tab is open and the SW activates (within seconds of deployment), the `SW_UPDATED` banner appears
3. User sees: "New version available. Refresh to get the latest update."
4. User can click "Refresh Now" — page reloads with fresh content
5. User can dismiss the banner — they continue working; next navigation loads fresh content anyway (network-first)

**When a user opens a fresh tab after deployment:**

1. New SW is already installed
2. All HTML fetched from network (fresh)
3. No stale content shown
4. No banner needed (they already have the new version)

**Users are NEVER:**
- Auto-reloaded without consent
- Interrupted during form submission
- Required to hard-refresh or clear cache manually

---

## 7. API Version Mismatch Risk

During a deployment, there is a brief window where:
- Old frontend code may call new backend endpoints (if URLs changed)
- New frontend code may call old backend endpoints (if deploy is rolling)

**Current mitigation:** All API changes are backward-compatible. No version headers are required. The service workers do not cache API responses across SW versions (new cache name on each deploy).

**Future mitigation if needed:**
- Add `X-App-Version` header to API requests
- Backend validates version and returns `409` if incompatible
- Frontend detects `409` and shows "Please refresh" message

---

## 8. Adding Update Detection to New Apps / Pages

### For apps WITHOUT a service worker (ecosystem pages):

Include `update-check.js` in your HTML:
```html
<script src="/js/update-check.js"></script>
```

The script automatically starts polling `/api/version` on load, on tab focus, and every 5 minutes. No additional configuration required.

### For apps WITH a service worker:

1. Copy (or symlink) `update-check.js` to the app's `js/` directory
2. Include it in your HTML: `<script src="js/update-check.js"></script>`
3. After registering the SW, call `initSWUpdateCheck(registration)`:

```javascript
navigator.serviceWorker.register('/myapp/service-worker.js')
  .then(reg => {
    if (window.initSWUpdateCheck) window.initSWUpdateCheck(reg);
  });
```

4. Add `__BUILD_VERSION__` placeholder to the SW file:
```javascript
const CACHE_VERSION = 'myapp-__BUILD_VERSION__';
```

5. Add a dynamic SW serving route in `server.js` (before `express.static`):
```javascript
app.get('/myapp/service-worker.js', (req, res) => serveSW(res, path.join(myappPath, 'service-worker.js')));
```

The `serveSW()` helper is already defined in `server.js` — just add the route.

---

## 9. Rollout Guidance

### For each new deployment:

1. Verify `BUILD_VERSION` is set in Zeabur env vars (or accept startup-timestamp fallback)
2. Deploy normally (push to main → Zeabur auto-deploys)
3. Old service workers on user devices will detect the new SW bytes → auto-update within seconds to minutes of next page navigation
4. Users with open tabs will see the update banner and can refresh at their convenience

### Checklist for new deployments:
- [ ] No manual cache clearing required
- [ ] No hard-refresh required
- [ ] Users with open tabs will see update banner
- [ ] Fresh page loads get new version immediately
- [ ] Offline functionality preserved (cache fallback still works)

---

## 10. Files Changed

| File | Change |
|------|--------|
| `backend/server.js` | Added `BUILD_VERSION`, `/api/version` endpoint, `serveSW()` helper, `staticOptions` with HTML no-cache headers, all `sendFile` calls replaced with `sendHtml()` |
| `frontend-payroll/service-worker.js` | Changed to network-first for all static, versioned cache names, update notification on activate |
| `frontend-pos/service-worker.js` | Changed navigation to network-first, other static to stale-while-revalidate, versioned cache names, update notification on activate |
| `frontend-ecosystem/js/update-check.js` | New — shared update detection and banner utility |
| `frontend-payroll/js/update-check.js` | Copy of update-check.js for payroll app |
| `frontend-ecosystem/dashboard.html` | Added update-check.js |
| `frontend-ecosystem/admin.html` | Added update-check.js |
| `frontend-ecosystem/login.html` | Added update-check.js |
| `frontend-payroll/index.html` | Added update-check.js + `initSWUpdateCheck` call |
| `frontend-payroll/login.html` | Added update-check.js |
| `frontend-pos/index.html` | Fixed SW registration path to `/pos/service-worker.js`, added `initSWUpdateCheck`, added update-check.js |
| `frontend-pos/js/update-check.js` | New — copy of shared update banner utility for POS |

---

## FOLLOW-UP NOTES

```
FOLLOW-UP NOTE 1 — Remaining payroll HTML pages
- Area: frontend-payroll (18 pages without update-check.js)
- Dependency: update-check.js needs to be included in each page for banner support
- Confirmed now: Core fix (network-first SW) works without the banner in all pages
- Not yet confirmed: Banner visibility in pages other than index.html / login.html
- Risk if wrong: Low — users get fresh content automatically; banner is enhancement only
- Recommended next check: Add update-check.js to all payroll HTML pages next sprint

FOLLOW-UP NOTE 2 — Explicit BUILD_VERSION in Zeabur
- Area: Zeabur deployment environment variables
- Dependency: BUILD_VERSION env var for reliable per-commit versioning
- Confirmed now: Startup timestamp fallback works correctly
- Not yet confirmed: Explicit BUILD_VERSION is set in Zeabur dashboard
- Risk if wrong: None for correctness; startup timestamp is sufficient
- Recommended next check: Add BUILD_VERSION = <git-sha> to Zeabur env vars via
  Zeabur dashboard → Service → Environment Variables

FOLLOW-UP NOTE 3 — POS CSS/JS stale-while-revalidate
- Area: frontend-pos/service-worker.js (non-navigation static assets)
- Dependency: POS uses stale-while-revalidate for CSS/JS (not network-first)
- Confirmed now: HTML pages are always fresh (network-first for navigation)
- Not yet confirmed: Whether CSS/JS staleness causes visual bugs after deployment
- Risk if wrong: Users may see new HTML with slightly old CSS/JS on first load
  (refreshed in background for next load)
- Recommended next check: Monitor after next deployment; if CSS/JS staleness
  causes issues, change POS static strategy to network-first as well

FOLLOW-UP NOTE 4 — Remaining payroll HTML pages (non-index)
- Area: frontend-payroll (pages other than index.html and login.html)
- Dependency: update-check.js needs adding to remaining ~16 payroll HTML pages for banner support
- Confirmed now: Core fix (network-first SW) works in all pages without the banner
- Not yet confirmed: Banner shown in company-dashboard.html, payruns.html, employee-management.html, etc.
- Risk if wrong: Low — fresh content is fetched automatically; banner is UX enhancement only
- Recommended next check: Add update-check.js to all remaining payroll HTML pages next sprint
```
