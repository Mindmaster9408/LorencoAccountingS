# 27 — DESKTOP APP + AUTO-UPDATE ARCHITECTURE
## Checkout Charlie — Workstream 8A

**Date:** 2026-05-21
**Status:** Architecture audit complete — ready for Workstream 8B implementation
**Type:** Design document (no implementation yet)

---

## Existing Infrastructure Audit

Before comparing options, the first step was auditing what already exists. This changes the design significantly.

### What Already Exists in the Codebase

| Component | File | Status |
|---|---|---|
| PWA manifest | `frontend-pos/manifest.json` | ✅ Exists — has critical flaws (see below) |
| Service worker | `frontend-pos/service-worker.js` | ✅ Exists — fully implemented |
| Update detection utility | `frontend-pos/js/update-check.js` | ✅ Exists — SW + version polling |
| Build version injection | `backend/server.js:413–424` | ✅ Exists — `__BUILD_VERSION__` replaced at request time |
| Version endpoint | `GET /api/version` | ✅ Exists — no-cache, returns `BUILD_VERSION` |
| SW registration | `frontend-pos/index.html:3825–3845` | ✅ Registered — with scope `/pos/` |
| IndexedDB offline queue | `index.html:3388–3750` | ✅ Exists — full lifecycle with conflict management |
| Offline banner | `index.html:1259–1260` | ✅ 4 states: offline/syncing/warning/pending |

### Service Worker Strategy (Already Implemented)

```
HTML navigation   → Network-first (always fresh on page load)
CSS/JS/images     → Stale-while-revalidate (instant counter response + background refresh)
API GET           → Network-first, cache fallback (reads work offline from cache)
API POST/PUT/DEL  → Try network → if offline → queue (IndexedDB, not SW cache)
```

The `__BUILD_VERSION__` placeholder in `service-worker.js` is replaced at request time by `serveSW()` in `server.js`. Every Zeabur redeploy changes `BUILD_VERSION` (timestamp-based) → SW file bytes differ → browser detects new SW → install/activate lifecycle fires → old caches deleted → clients notified via `postMessage`.

### Offline Queue (IndexedDB — Already Implemented)

```
DB: CheckoutCharliePOS (version 1)
Store: offlineSales (keyPath: tempId, autoIncrement)
Indexes: synced, createdAt
```

Sale lifecycle: `pending` → sync → `deleted` (success) | `conflict_stock` | `conflict_session` | `failed`

Retry/abandon/note management already implemented in the Manager Recovery UI.

### Critical Existing Flaws (Must Fix in 8B)

| Flaw | Location | Severity |
|---|---|---|
| `manifest.json` `start_url: "/"` opens ecosystem login, not POS | `manifest.json:6` | HIGH — PWA installs to wrong page |
| `manifest.json` has no `scope` field | `manifest.json` | HIGH — browser uses parent of start_url |
| Icons use `data:` URL SVG — not valid for Windows PWA install | `manifest.json:12–18` | HIGH — install blocked or broken on Windows |
| No `min_compatible_version` or `forced` flag on version endpoint | `server.js:163–166` | MEDIUM — no forced update path |
| Update detection shows non-blocking banner only — no forced path | `update-check.js` | MEDIUM — sales can proceed through forced-update condition |
| Offline sale records have no `app_version` field | `index.html:3539–3545` | MEDIUM — can't version-gate sync at backend |
| `pos_audit_events` has no `app_version` — can't audit which version generated a sale | schema | MEDIUM |
| Dual offline queue: SW has a Cache API queue + app has IndexedDB queue | `service-worker.js:199–216` | LOW — SW queue never read by app; dead code confusion |
| `DB_VERSION = 1` with no upgrade migration path documented | `index.html:3389` | LOW — future schema changes have no path |

---

## Option Comparison

### Option A — PWA Installable App (Chrome/Edge)

A Progressive Web App that can be installed from the browser using the native "Install App" prompt. On Windows, this creates a standalone app window with its own taskbar icon and no browser chrome. The hosted web app IS the app — no binary to distribute.

**Auto-update:** ✅ Native to the architecture. Service worker handles it automatically. Already 80% implemented. Update detection and cache invalidation already wired. No distribution problem.

**Offline:** ✅ Already fully implemented with IndexedDB queue, conflict management, and recovery UI.

**Printer/hardware:** ⚠️ `window.print()` works for receipt preview. For ESC/POS thermal printers, a one-time local print agent (see Hardware section below) is needed. Barcode scanners work natively as keyboard emulators — no code changes needed. Cash drawer is triggered through the receipt printer.

**Deployment:** ✅ Zero — pushing to GitHub deploys to Zeabur. No installer, no signed binary, no distribution channel.

**Security:** ✅ Same as the web app. HTTPS enforced. No local code execution surface beyond the print agent.

**Speed:** ✅ Stale-while-revalidate for all static assets means instant load from cache. Service worker pre-caches on install. On a typical retail till, the app loads in under 300ms from cache.

**Maintainability:** ✅ One codebase. No platform-specific build pipelines.

**Stale code risk:** None. The browser enforces SW updates. When `BUILD_VERSION` changes, every open tab receives `SW_UPDATED` → shows banner. On next page load, the new HTML is fetched network-first. There is no "old version" running anywhere.

**Windows business environment:** ✅ Chrome and Edge both support PWA install and run installed PWAs as standalone windows. Edge is installed on every Windows 10/11 machine. Both support `display: standalone`. The result is indistinguishable from a native app to a cashier.

**Assessment:** Best fit. Already 80% built. One codebase. Zero distribution complexity. Auto-update is architecturally guaranteed, not optional.

---

### Option B — Electron / Tauri Desktop Wrapper

A native binary package that bundles a local Chromium (Electron) or WebView2/WebKit (Tauri) engine and loads either the hosted URL or a bundled copy of the web app.

**Auto-update:** ⚠️ Requires separate auto-updater infrastructure (Squirrel for Electron, Tauri updater). Users must have update permissions. Update delivery is a separate release pipeline on top of the existing one. If the auto-updater fails, old versions keep running.

**Offline:** Can be done, but bundled offline requires keeping the bundled version in sync with the server's API — a coupling nightmare. Loading hosted URL online is just Option A with a heavier wrapper.

**Printer/hardware:** ✅ Native OS APIs accessible from main process. But the print agent pattern (Option A) solves this without requiring Electron.

**Deployment:** ✗ Requires code-signing certificates ($200–$500/year for Windows). Requires building and distributing `.exe` installers. Requires separate CI/CD for installer builds. Installing on each till requires downloading a 60–100MB binary.

**Security:** ⚠️ Electron bundles all of Chromium. Large attack surface. Requires careful IPC design. Running Node.js in a renderer is a critical security anti-pattern and easy to accidentally introduce.

**Speed:** Slower startup than PWA (binary startup time + Chromium init). On low-end hardware this matters.

**Maintainability:** ✗ Two build pipelines (web + Electron). Two release processes. Platform-specific code for auto-update, printer, and OS integration.

**Stale code risk:** HIGH. The fundamental risk of desktop binaries is that old versions can keep running. Even with auto-update, if the update fails or the user dismisses it, the old binary runs. For a POS that must be version-consistent with the server API, this is a significant risk.

**Windows business environment:** Requires installer for each till. Non-technical staff installing on Windows often run into UAC prompts, antivirus blocks, and corporate policy restrictions.

**Assessment:** Rejected. Adds deployment complexity, stale code risk, and build infrastructure for no benefit over the already-implemented PWA foundation.

---

### Option C — Hybrid Lightweight Desktop Shell Loading Hosted App

A thin native wrapper (e.g., Edge WebView2, NW.js, or a custom WinForms shell with an embedded browser control) that opens the hosted web app URL in a standalone window.

**Auto-update of app code:** ✅ Same as Option A — it loads the hosted URL, so the web app auto-updates via service worker. This is the only advantage over Option B.

**Update of the shell itself:** ⚠️ The shell is a binary. It rarely changes, but when it does (e.g., to update WebView2 version, add a new OS integration) it needs a distribution mechanism.

**Printer/hardware:** ✅ Slightly better than pure PWA because the shell can call native APIs. But the print agent pattern solves this without a native shell.

**Deployment:** Still requires distributing and installing a binary on each till. Not as heavy as Electron but still not zero-friction.

**Security:** WebView2 uses Edge's security model. Reasonable. Better than Electron's historical pitfalls.

**Offline:** The web app's service worker handles this identically to Option A.

**Assessment:** Rejected. It's Option A (PWA) with an unnecessary binary wrapper that adds install/distribution complexity. If a specific OS integration is ever needed, a tiny local agent (like the print agent) is a better pattern than a full desktop shell.

---

## Recommended Architecture: PWA + Local Print Agent

```
┌─────────────────────────────────────────────────────────────┐
│  Windows Till Computer                                      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Edge / Chrome (installed PWA)                        │   │
│  │  display: standalone — full screen, no browser chrome │   │
│  │                                                        │   │
│  │  index.html ← served by Zeabur (network-first)        │   │
│  │  JS/CSS/imgs ← SW stale-while-revalidate cache        │   │
│  │  API calls  ← Zeabur backend (authoritative)          │   │
│  │  Offline    ← IndexedDB queue (sales only)            │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ POST http://localhost:8080/print  │
│  ┌───────────────────────▼──────────────────────────────┐   │
│  │  Print Agent (tiny Node.js, one-time install)         │   │
│  │  Runs as Windows Service (NSSM or node-windows)       │   │
│  │  Handles: ESC/POS → thermal printer                   │   │
│  │           Cash drawer pulse via printer port          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  USB Barcode Scanner → keyboard emulation → browser input   │
│  Thermal Printer  ← USB/network from print agent            │
│  Cash Drawer      ← serial pulse through printer            │
└─────────────────────────────────────────────────────────────┘
                          │ HTTPS
┌─────────────────────────▼──────────────────────────────────┐
│  Zeabur (always-on)                                        │
│  Express backend + Supabase PostgreSQL                     │
│  Source of truth for all business data                     │
└────────────────────────────────────────────────────────────┘
```

**Why PWA + Print Agent, not pure PWA:**

The only thing a pure PWA cannot do well is raw ESC/POS output to a thermal receipt printer. `window.print()` opens a browser print dialog which is too slow and has wrong margins for 80mm thermal paper. The print agent pattern is the industry standard solution:

- The print agent is a ~100-line Node.js script
- It listens on `http://localhost:8080/print`
- It accepts JSON receipt data, converts to ESC/POS binary, and writes to the USB/network printer
- It is installed once per till as a Windows Service
- It is NOT business logic — it is a hardware bridge
- It virtually never needs updating (thermal printer ESC/POS commands haven't changed in 20 years)
- Cash drawers connect through the printer and are opened by a single ESC/POS command included in the receipt print job

---

## Update Flow

### Standard Update (Every Deployment)

```
1. Code pushed to GitHub
2. Zeabur redeploys → new container → new BUILD_VERSION (timestamp)
3. Till browser requests /pos/service-worker.js
4. Server injects new BUILD_VERSION → file bytes differ from cached SW
5. Browser detects SW update → installs new SW (background, no interruption)
6. New SW activates:
   a. Deletes all old pos-* caches
   b. Claims all clients
   c. Sends SW_UPDATED postMessage to all open tabs
7. POS app receives SW_UPDATED → update-check.js shows update banner
8. Cashier sees: "New version available — Refresh Now"
9. Cashier clicks Refresh at till changeover / between sales
10. New HTML fetched network-first → new version running
```

**No sale interrupted.** The update banner only shows; it does not reload or block. The cashier refreshes between sales.

### Forced Update (Breaking Change)

When a server API change is incompatible with older app versions (rare — backend is designed to be backward-compatible):

```
1. Developer sets MIN_COMPATIBLE_VERSION env var on Zeabur to the last safe version
2. GET /api/version returns: { version, min_compatible_version, forced: true }
3. POS app detects forced: true on version check
4. Instead of banner: blocking modal appears over the entire app
5. Modal text: "A required update is available. Please refresh before starting the next sale."
6. Cashier cannot access any POS function until refresh
7. After refresh, new version loads → forced condition cleared
```

**Mid-session protection:** Forced update modal checks `cart.length === 0` before blocking. If a cashier is mid-sale, the block is deferred until cart is cleared. This prevents a forced update from ruining a customer interaction.

### Update Detection Timing

| Trigger | When |
|---|---|
| Page load | Every navigation |
| Tab focus | Every time user returns to the POS tab |
| Poll | Every 5 minutes (already implemented in update-check.js) |
| SW activate | Immediate postMessage to all open tabs |

**Worst-case stale window:** 5 minutes (poll interval). In practice, tabs check on focus so any cashier returning to the POS after a break will get the update prompt within seconds.

---

## Offline Flow

### Sale Offline Path (Already Implemented)

```
1. Cashier completes checkout
2. app: try POST /api/pos/sales → network failure detected
3. app: saveOfflineSale(saleData) → IndexedDB offlineSales store
4. Offline banner shows: "X sale(s) pending sync"
5. window.addEventListener('online') → syncOfflineSales() called
6. For each pending sale: POST /api/pos/sales with { source: 'offline_sync', offline_idempotency_key }
7. Server: idempotency gate → if key seen, return existing sale (replay-safe)
8. Success: deleteOfflineSale(tempId) → banner clears
9. Conflict: updateOfflineSaleStatus(tempId, 'conflict_stock' | 'conflict_session')
10. Manager Recovery UI shows conflicts for manual resolution
```

### What Is Safe to Do Offline

| Operation | Offline-safe? | Mechanism |
|---|---|---|
| Process a sale | ✅ Yes | IndexedDB queue → sync on reconnect |
| Print receipt | ✅ Yes | `printOfflineReceipt()` uses browser print for offline |
| View products | ✅ Yes | IndexedDB product cache |
| View customers | ✅ Yes | IndexedDB customer cache |
| Stock adjustment | ✗ No | Inventory operations require server confirmation |
| Stock take | ✗ No | Variance must be authoritative — no queue |
| Reports | ✗ No | Reports require live server data |
| Cashup | ✗ No | Session close requires server confirmation |

**This scope is correct.** Sales are the only operation that must succeed offline — everything else is management/reporting and can wait for connectivity.

---

## Version Compatibility Rules

### Versioning Strategy

```
BUILD_VERSION = timestamp-based (e.g. 'n2x4k9')
                set per Zeabur deployment
                NOT semantic versioning — no concept of major/minor/patch
```

This is intentional for this architecture. Because the PWA always runs the latest version (SW update replaces the entire app), the only version that matters is "current vs. incompatible minimum."

### The min_compatible_version Rule

`MIN_COMPATIBLE_VERSION` is an env var on Zeabur. It is:
- **Never changed** for normal feature deployments (backward-compatible API)
- **Updated only** when a breaking API or schema change requires clients to be on the new version before syncing

```
Decision tree for setting MIN_COMPATIBLE_VERSION:
  - New API endpoint added?           → Do NOT change it (additive)
  - Existing endpoint changed?        → Check if old app code would break
  - Old response field renamed?       → CHANGE IT → forced update
  - IndexedDB schema change?          → CHANGE IT → forced update
  - Breaking change to offline sync format? → CHANGE IT → forced update
```

For this architecture (a single-file SPA with SW auto-update), breaking changes requiring a forced update should happen at most a few times per year.

### Offline Queue Compatibility Across Versions

**Current gap:** Offline sale records contain the full sale payload but no `app_version` field. This means the backend cannot reject a record based on version.

**Required:** Add `app_version: BUILD_VERSION` to every offline sale record at save time. This enables:

1. Server can log the version each offline sale was created on
2. If `app_version` is below `MIN_COMPATIBLE_VERSION`, server rejects the offline sync with `409 Conflict` and a clear message
3. The rejection is recorded in the recovery queue with the version mismatch noted
4. Manager can see: "This sale was created on version X. Please contact support."

**This is a one-line change at save time and one check at sync time.** It should be in Workstream 8B.

### IndexedDB Schema Migration

`DB_VERSION = 1` currently. When the `offlineSales` object store schema changes:

```javascript
// Pattern for version bumps:
const DB_VERSION = 2;  // increment

request.onupgradeneeded = event => {
    const db = event.target.result;
    const oldVersion = event.oldVersion;

    if (oldVersion < 1) {
        // Initial schema (current state)
        const store = db.createObjectStore('offlineSales', { keyPath: 'tempId', autoIncrement: true });
        store.createIndex('synced', 'synced', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
    }
    if (oldVersion < 2) {
        // Migration: add app_version index (data migration not needed — field optional)
        const store = event.target.transaction.objectStore('offlineSales');
        store.createIndex('app_version', 'app_version', { unique: false });
    }
    // Future: if (oldVersion < 3) { ... }
};
```

**Key rule:** IndexedDB schema migrations must be backward-compatible at the record level. Never delete an object store or rename a field — only add indexes and new optional fields. Old records without new fields are still readable.

---

## Dual Queue Issue

### Current State

The service worker has its own offline queue (Cache API, `pos-sync-queue`) implemented in `service-worker.js:199–216`. The app has a fully-featured IndexedDB queue. These are two independent mechanisms.

**In practice:** The SW Cache API queue is NEVER read by the app. The app's checkout flow catches `fetch` exceptions directly and saves to IndexedDB. The SW's `handleApiRequest()` offline path would only fire for requests that pass through the SW layer and fail there — but the app's try/catch fires first.

**The SW queue is dead code for sales.** It catches other POST requests that might fail offline (inventory adjustments, etc.) but those are not retried or surfaced in any UI.

### Resolution (Workstream 8B)

Remove the `queueRequest()` call from the SW's `handleApiRequest()` for all routes except an explicit allowlist. The SW should NOT silently queue inventory/adjustment/cashup requests — those should fail visibly so the cashier knows the action didn't go through.

```javascript
// SW handleApiRequest — remove general queueRequest() call
// Only queue explicit sale POST paths if ever needed:
if (url.pathname === '/api/pos/sales') {
    // Actually: the app handles this in its own try/catch
    // SW should just return offline response; app decides whether to queue
}
// For all other POST/PUT/DELETE:
// Return a clear offline error; do NOT silently queue
```

---

## Hardware / Printer Architecture

### Barcode Scanner

**No code changes needed.**

USB HID barcode scanners operate as keyboard emulators. They "type" the scanned barcode into the active input field. The POS already has barcode input handling. Any USB scanner works out of the box.

Wireless Bluetooth scanners paired to the machine work the same way. No WebBluetooth or WebSerial needed for standard scanners.

### Thermal Receipt Printer (ESC/POS)

**Requires print agent — one-time install per till.**

```
┌─────────────────┐      POST /print      ┌──────────────────┐
│  POS Browser    │ ──────────────────► │  Print Agent      │
│  (PWA)          │   JSON receipt data  │  localhost:8080   │
└─────────────────┘                      └────────┬─────────┘
                                                  │ ESC/POS binary
                                          ┌───────▼──────────┐
                                          │  Thermal Printer  │
                                          │  (Epson TM, Star) │
                                          └──────────────────┘
```

**Print agent spec:**
- Node.js (same runtime as the backend — no new dependencies)
- ~100–150 lines of code
- Receives `POST /print` with receipt JSON
- Converts to ESC/POS binary using `escpos` npm package
- Writes to USB printer via `escpos-usb` or to network printer via TCP socket
- No auth required — only accessible from localhost (Windows Firewall blocks external access)
- Runs as a Windows Service using NSSM (Non-Sucking Service Manager — free, widely used)
- Started automatically on boot
- Practically never needs updating

**Cash drawer:**
- Most cash drawers connect to the printer's RJ-11 port
- The drawer opens via an ESC/POS command sent at the start of the print job
- The print agent sends the drawer-open command automatically when printing a receipt
- No separate cash drawer driver or code path needed

**Current browser print fallback (`window.print()`):**
- Already implemented and works for online sales
- Continues to work as a fallback when print agent is not installed
- Shows browser print dialog → works with any installed printer

### Print Agent CORS Configuration

The POS app (served from `https://your-app.zeabur.app`) makes a cross-origin request to `http://localhost:8080/print`. The print agent must:

```javascript
// Print agent CORS:
app.use(cors({
    origin: ['https://your-app.zeabur.app', 'http://localhost:*'],
    methods: ['POST'],
}));
```

Browsers allow cross-origin requests to localhost from HTTPS origins for loopback addresses (Chrome allows this; Edge follows). This is the standard pattern used by every browser-based print solution (Star CloudPRNT, Epson ePOS-Print, etc.).

### Low-End Device Performance

**Minimum recommended spec for a POS till:**
- CPU: Intel Celeron or equivalent (anything from the last 8 years)
- RAM: 4GB
- OS: Windows 10 (Edge pre-installed)
- Network: stable LAN or Wi-Fi (no 3G/mobile data)

**Performance optimisations already in place:**
- Stale-while-revalidate: app loads from cache in under 300ms
- Products cached in IndexedDB: no loading spinner for product grid
- SW pre-caches `index.html` and `manifest.json` on install

**Not currently done but worth adding (Workstream 8B):**
- Pre-cache CSS file in SW `STATIC_FILES` array (currently empty except HTML/manifest)
- Add `font-display: swap` to any external fonts

---

## App Version in Audit Trail

Every sale and till session should carry an `app_version` stamp for forensic investigation.

### Short-Term (Workstream 8B)

Add `app_version` to the `metadata` JSONB field on `pos_audit_events`. The frontend sends it in every API call:

```javascript
// In checkout POST /api/pos/sales body:
{
    items, total, payment_method, ...,
    app_version: window.__APP_VERSION__  // set on page load from SW_UPDATED message or /api/version response
}
```

Backend stores it: `metadata: { app_version: '...', ... }`.

### Medium-Term (Post-Pilot)

Add `app_version VARCHAR(32)` to:
- `sales` table
- `till_sessions` table

This enables SQL queries like `WHERE app_version < 'n2x4k9'` to investigate version-specific issues.

---

## Deployment Flow

### Current Flow (Already Working)

```
1. git push origin main
2. Zeabur webhook triggers
3. Zeabur builds from accounting-ecosystem/Dockerfile
4. New container starts with new BUILD_VERSION
5. GET /api/version returns new version
6. All till browsers detect update on next poll/focus
7. Cashiers see update banner → refresh between sales
```

No action required on till computers. No installers. No IT intervention.

### Print Agent Deployment (One-Time Per Till)

```
1. Download print-agent.zip (to be built in 8B)
2. Run install.bat on the till computer (as administrator)
   - Installs Node.js if not present
   - Runs npm install in print agent folder
   - Registers as Windows Service via NSSM
   - Opens Windows Firewall for localhost:8080 (inbound from localhost only)
3. Test: curl http://localhost:8080/health → { status: 'ok', printer: 'connected' }
4. Configure printer USB path in print-agent config file
5. Done — print agent runs forever, starts on boot
```

Print agent updates (rare): Re-run `npm install` in the print agent folder. The POS app auto-detects agent version via `/health` response and can show a "Print agent update available" message when needed.

---

## Recovery if Update Fails

### SW Update Failure

If the SW fails to install (network error during activation, corrupted cache):

1. `update-check.js` version polling continues independently of the SW
2. If the SW is broken, navigation requests fall through to the browser (network-first anyway)
3. The page still loads from the server because HTML is always network-first
4. The user may lose the offline cache but the app remains functional while online

**Offline queue is in IndexedDB, not SW cache.** A failed SW update does NOT lose queued offline sales.

### Offline Queue Corruption

If IndexedDB is corrupted (rare, typically after disk errors):

1. `initIndexedDB()` catches the error and returns `null`
2. All offline functions check `if (!db) return null`
3. The app falls back to online-only mode silently
4. Sales still process normally when online
5. If offline, the cashier sees "Failed to save offline sale" notification rather than a silent data loss

**Recovery:** Delete the IndexedDB database via DevTools → Application → IndexedDB → Delete database. App recreates it on next load. Any pending offline sales in the corrupted DB are lost — this is the only data loss scenario, and it requires the device to have been offline with a corrupted disk.

### Backend Forced Update Failure

If the server is unreachable and the forced update flag cannot be checked:

1. `checkVersion()` catches network error silently — no forced update shown
2. App continues operating normally
3. When server is reachable again, forced update check fires on next poll

**This is the correct behavior.** A network outage should not block sales at the till.

---

## Pilot-Safe Rollout Plan

### Phase 1: Fix Existing PWA (Workstream 8B — implement first)

These are necessary before calling it an "installed desktop app":

1. **Fix manifest.json:** `start_url: "/pos/"`, `scope: "/pos/"`, real PNG icons (192x192, 512x512)
2. **Add `app_version` to offline sale records** at `saveOfflineSale()` time
3. **Add `app_version` to audit event metadata** in checkout POST payload
4. **Harden version endpoint:** Add `min_compatible_version` and `forced` fields
5. **Harden update check:** Add forced update blocking modal (defers until cart empty)
6. **Resolve dual queue:** Remove `queueRequest()` from SW's general POST handler; document IndexedDB as the sole offline queue for sales
7. **Add IndexedDB migration pattern:** Document and set up `onupgradeneeded` with version-aware migration

### Phase 2: Print Agent (Workstream 8C)

1. Build print agent (Node.js, ESC/POS, ~150 lines)
2. Test with Epson TM-T88 (most common in SA retail)
3. Package as install.bat + NSSM service
4. Document cash drawer support
5. Add `printViaAgent()` function to POS as primary print path, `window.print()` as fallback

### Phase 3: PWA Install Documentation (Workstream 8D)

1. Write cashier-facing install guide (Edge/Chrome → "Install App" → pin to taskbar)
2. Write IT guide for print agent setup
3. Pilot with one till at the client site before rolling out

### Not Needed (Rejected)

- Electron/Tauri builds
- Windows installer for the main app
- App Store distribution (Chrome OS or Windows 11 Store)
- Native app builds

---

## First Implementation Workstream

**Workstream 8B: PWA Hardening**

Scope: Fix the 7 critical gaps identified in this audit. Do not build print agent (that is 8C). Do not change business logic. All changes are in `manifest.json`, `service-worker.js`, `server.js`, and `frontend-pos/index.html`.

Deliverables:
1. Fixed `manifest.json` (start_url, scope, real icons)
2. `app_version` field in offline sale records
3. `app_version` in audit event metadata
4. Version endpoint: add `min_compatible_version` and `forced` fields
5. Forced update blocking modal in POS
6. SW queue cleanup (remove general POST queueing)
7. IndexedDB `onupgradeneeded` migration scaffolding
8. `/docs/checkout-charlie-production/28_PWA_HARDENING_IMPLEMENTED.md`

**Estimated scope:** ~150 lines of targeted changes. No new API routes. No schema changes. No Paytime files touched (Paytime stability lock — unaffected).

---

## Architecture Boundaries

This section is the permanent record of what this architecture does NOT do:

| NOT in scope | Why |
|---|---|
| Native binary distribution | PWA does not require it |
| App Store presence | Business software; direct install is correct |
| Electron/Tauri | Added complexity, same result |
| Offline inventory operations | Inventory must be server-authoritative |
| Offline reports | Reports require live DB state |
| Offline cashup | Session state must be server-confirmed |
| Bundled-mode operation (no server) | Backend + Supabase is always required; this is a connected POS, not an air-gapped terminal |
| Multi-platform native builds | Windows till + Chrome/Edge is the target environment |
