# 31 — MULTI-TILL + STRESS TESTING AUDIT
## Checkout Charlie — Workstream 9A

**Date:** 2026-05-22
**Audited by:** Claude — Principal Engineer audit pass
**Status:** Audit complete — no code changes in this workstream
**Scope:** Real-world operational pressure — 4–10 simultaneous tills, all-day sessions, intermittent internet, real retail behaviour

---

## Audit Summary

| Area | Verdict | Worst risk |
|---|---|---|
| Multi-till concurrency | ⚠️ Mostly solid — two targeted gaps | Non-atomic return + duplicate till sessions |
| Long-running session stability | ⚠️ One known drift source | In-memory stock not refreshed mid-session |
| Offline/online storm behaviour | ✅ Solid with one data gap | `customerId` lost on offline fallback |
| Manager intervention conflicts | ⚠️ One audit integrity risk | `ABANDONED_SESSION_DETECTED` flood |
| DB/backend stress | ⚠️ One performance cliff | `updateOfflineBanner()` full-table reads |

**Pilot-safe verdict: Yes — with three known gaps documented as tracked follow-ups.**

---

## Audit Area 1 — Multi-Till Concurrency

### RISK-01 — Non-Atomic Return Stock Reversal
**Severity: HIGH**
**File:** `backend/modules/pos/routes/sales.js` — return route (`/:id/return`)

The return handler uses a sequential read-then-write pattern per item:
```javascript
// Pseudocode of actual flow
for (const item of saleItems) {
    const current = await supabase.from('pos_products').select('stock_quantity').eq('id', item.product_id)
    const newQty = current.stock_quantity + item.quantity
    await supabase.from('pos_products').update({ stock_quantity: newQty }).eq('id', item.product_id)
}
```

**Race condition:** Two concurrent returns of the same sale (double-tap by cashier, or two managers processing at the same time) → both read the same pre-return stock quantity → both calculate `qty + returned_qty` → one write overwrites the other → net result: stock incremented once instead of twice. Or if the return endpoint doesn't prevent double-return, a single physical return could apply twice.

The sale-creation path (`create_sale_atomic` RPC) correctly uses an atomic `UPDATE ... WHERE stock_quantity >= p_quantity` — no race possible there. The return path does NOT have this protection.

**Impact at multi-till scale:** Two tills both processing a customer exchange/return simultaneously for overlapping products can silently corrupt stock counts with no error surfaced.

**Mitigation already in place:** None detected.

**Recommended fix (Workstream 9B):** Replace the sequential read-then-write with an atomic `UPDATE pos_products SET stock_quantity = stock_quantity + $qty WHERE id = $id RETURNING stock_quantity` call per item. No read needed. No race window. Identical pattern to `decrement_stock_v2`.

---

### RISK-02 — No Per-Till Session Uniqueness
**Severity: HIGH**
**File:** `backend/modules/pos/routes/sessions.js`

The session-open endpoint checks for an existing **active session by `user_id`** — not by `till_id`. The duplicate-session gate fires if the same user account is already logged in, but two different user accounts can open sessions on the same physical till simultaneously.

**Scenario:** Cashier A opens a session on Till 3. Cashier A goes on break. Cashier B (different account, same till) opens a session on the same till without closing Cashier A's session. Both sessions are active. Sales made on the till from this point are assigned to whichever session the app has in memory (`currentSession`). If the browser is refreshed or the session is restored from a different path, session context could mismatch.

**Impact at multi-till scale:** At a four-till store, if cashiers share tills across shifts, there will routinely be multiple active sessions per till. Reconciliation at end-of-day becomes ambiguous — which session owns which sales?

**Mitigation already in place:** None. `till_id` column exists in the sessions schema but is not enforced for uniqueness at session-open time.

**Recommended fix (Workstream 9B):** Add a server-side check at session open: `SELECT id FROM pos_sessions WHERE till_id = $till_id AND status = 'active'`. If an active session exists for the till, return 409 Conflict with the existing session details. Operator must close or recover the existing session before a new one can be opened.

---

### RISK-03 — Last-Unit Race Condition (ALREADY HANDLED — STRONG)
**Severity: N/A — resolved**

The `decrement_stock_v2` plpgsql function uses:
```sql
UPDATE pos_products
SET stock_quantity = stock_quantity - p_quantity
WHERE id = p_product_id
  AND (p_allow_negative OR stock_quantity >= p_quantity)
```

This is a single atomic statement. The row is locked at the UPDATE step. Two concurrent checkouts of the last unit → one succeeds, one gets zero rows affected → `RAISE EXCEPTION 'INSUFFICIENT_STOCK'` → HTTP 409 → front-end shows "out of stock". No oversell possible. No race window.

**This is correctly implemented. No action required.**

---

### RISK-04 — Idempotency Race on Concurrent Sync (MEDIUM — acknowledged)
**Severity: MEDIUM**
**File:** `database/migrations/027_pos_create_sale_atomic_idempotent.sql`

The idempotency gate uses a SELECT then conditional INSERT:
```sql
SELECT id, ... INTO v_existing FROM sales WHERE idempotency_key = p_idempotency_key;
IF FOUND THEN
    -- return existing
END IF;
-- proceed with INSERT
```

There is no explicit row-level lock between the SELECT and INSERT. Two concurrent calls with the same idempotency key can both pass the `NOT FOUND` check before either completes the INSERT. The second INSERT hits the UNIQUE INDEX and raises `23505 unique_violation` → 500 error.

**Impact at multi-till scale:** This race is only possible when two tabs or two browser contexts sync the same offline record simultaneously. In practice, a single cashier has one browser window — the multi-tab scenario requires an unusual setup. The `syncInProgress` per-tab guard prevents the same tab from running two concurrent syncs. However, if a cashier has the POS open in two tabs (possible on a shared PC), both tabs maintain independent `syncInProgress` flags against the same IndexedDB — both could attempt to sync the same record.

**The migration comment explicitly acknowledges this race and classifies it as acceptable** given the low probability at pilot scale. The client-side retry (HTTP 500 → retry) will succeed on the second attempt because the first attempt's INSERT completed.

**Pilot-safe verdict: Yes.** At 4–10 tills with single-tab usage per till, this race will not manifest. If multi-tab usage becomes common, the fix is to promote the SELECT to `SELECT ... FOR UPDATE` or use `INSERT ... ON CONFLICT DO NOTHING` directly.

---

## Audit Area 2 — Long-Running Session Stability

### RISK-05 — In-Memory Stock Drift Over Long Sessions
**Severity: MEDIUM**
**File:** `frontend-pos/index.html` — `loadProducts()` / `checkout()` in-memory stock logic

After a successful checkout, the app decrements stock in the in-memory `products` array (display optimism):
```javascript
const productIndex = products.findIndex(p => p.id === item.productId);
if (productIndex !== -1) {
    products[productIndex].stock_quantity -= item.quantity;
}
```

This in-memory adjustment is intentional and correct for immediate UI feedback. However, `loadProducts()` (which fetches fresh stock from the server) is only called on:
- Page load
- Reconnection after offline period

It is **not called on a timer** and **not called after each sync of an offline sale**.

**Scenario:** Cashier on Till 1 and Till 2 both load products at 9:00 AM. Till 2 sells the last 3 units of Item X. Till 1's in-memory count still shows 3. The cashier on Till 1 tries to sell 2 units — the app-layer pre-check passes (3 >= 2), the sale goes to the server, `decrement_stock_v2` sees 0 available (strict mode) → 409 Insufficient Stock → error shown. This is handled correctly.

However, the **product list display** on Till 1 still shows 3 in stock for the next several hours. Minor UX issue. Not a data-integrity issue because the DB is authoritative.

**More problematic scenario:** After 6 hours of operation, the cashier on Till 1 has made many sales. Their in-memory product list reflects those sales. Another product has been manually restocked (stock increased via backend admin). The cashier's in-memory count doesn't know this. The product may still show as "OUT OF STOCK" on their screen even though stock is available.

**Impact at multi-till scale:** Each till independently drifts. After a full 8-hour shift with no page refresh, displayed stock levels may be meaningfully stale, causing cashiers to tell customers items are unavailable when they aren't.

**Mitigation already in place:** Server-side pre-check (`getStockPolicy()`) always queries current DB state. Display drift does not cause incorrect sales.

**Recommended fix (Workstream 9B):** Periodic `cacheProducts()` refresh every 15–30 minutes. Already called on reconnect — add a `setInterval` in the `window.addEventListener('load', ...)` block.

---

### RISK-06 — `updateOfflineBanner()` Full-Table Read on Every Call
**Severity: MEDIUM**
**File:** `frontend-pos/index.html` — `updateOfflineBanner()`

```javascript
async function updateOfflineBanner() {
    const db = await openDB();
    const tx = db.transaction(['offlineSales'], 'readonly');
    const store = tx.objectStore('offlineSales');
    const allSales = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    // count pending, synced, failed
```

`store.getAll()` retrieves every record from the `offlineSales` store with no limit or cursor. This function is called:
- After every `saveOfflineSale()`
- After every sync cycle completion
- After online/offline transitions

**Scenario:** After an internet outage during lunch rush, a till accumulates 50 offline sale records. The connection returns. Sync begins. After each of the 50 syncs, `updateOfflineBanner()` calls `getAll()` → reads all 50 records → updates the banner → next sync → reads all 50 records again. Total: 50 full-table reads in rapid succession.

With completed syncs, old records remain in IndexedDB with `status: 'synced'` (they are not purged). After a week of intermittent outages, the store could have hundreds of records. Each `updateOfflineBanner()` call reads all of them.

**Impact at multi-till scale:** Not cross-till (IndexedDB is per-browser). But on the same till, after heavy offline usage, `updateOfflineBanner()` degrades in proportion to accumulated record count.

**Recommended fix (Workstream 9B):** Two options:
1. Use `store.index('status').count()` keyed range queries instead of `getAll()` — O(1) count instead of full read.
2. Purge synced records from IndexedDB after confirmed sync (aggressive cleanup).

For pilot: acceptable. IndexedDB is fast for small datasets. Only becomes a concern after sustained offline operation with hundreds of records.

---

### RISK-07 — `cacheProducts()` Clear-Then-Add Inconsistency Window
**Severity: LOW**
**File:** `frontend-pos/index.html` — `cacheProducts()`

```javascript
async function cacheProducts(productsData) {
    const db = await openDB();
    const tx = db.transaction(['products'], 'readwrite');
    const store = tx.objectStore('products');
    await store.clear();             // store is empty here
    for (const product of productsData) {
        await store.add(product);    // re-populated here
    }
}
```

Between `store.clear()` and the first `store.add()` completing, the products store is empty. If the offline product lookup fires in this window (e.g., barcode scan while `cacheProducts()` is running), it returns nothing.

**Impact at multi-till scale:** This is a per-till race, not cross-till. The window is sub-millisecond in practice for small product catalogues (< 500 items). The probability is negligible in normal operation.

**Recommended fix (Workstream 9B if catalogue grows large):** Write new products to a temp key pattern or use a versioned store approach. Not required for pilot.

---

## Audit Area 3 — Offline / Online Storm Behaviour

### RISK-08 — `customerId` Lost in Offline Fallback Path
**Severity: CRITICAL**
**File:** `frontend-pos/index.html` — `checkout()` function

In the online path, `customerId` is included in the POST body:
```javascript
const saleData = {
    sessionId: currentSession.id,
    items: cart.map(item => ({ ... })),
    paymentMethod: selectedPaymentMethod,
    amountTendered: ...,
    customerId: selectedCustomer?.id || null,   // ← included in online POST
    // ...
};
const response = await fetch('/api/pos/sales', { ... body: JSON.stringify(saleData) });
```

In the offline fallback (called when `fetch` rejects due to network error):
```javascript
async function saveOfflineSale(saleData) {
    const sale = {
        ...saleData,        // ← spreads the same saleData
        status: 'pending',
        syncAttempts: 0,
        createdAt: new Date().toISOString(),
        tempSaleNumber: 'OFFLINE-' + Date.now(),
        app_version: window.__posAppVersion || 'unknown'
    };
    // save to IndexedDB
}
```

At first glance this looks correct — `...saleData` includes `customerId`. However, auditing the actual `saleData` construction in `checkout()`:

The `saleData` object is constructed BEFORE the fetch call and includes `customerId`. When the fetch rejects and `saveOfflineSale(saleData)` is called, `saleData` **does** include `customerId`.

**Re-assessment:** On careful re-reading, `customerId` IS included in `saleData` and IS spread into the offline record. The risk from the previous audit was based on an incorrect reading. This is actually handled correctly.

**Status: RETRACTED — no gap exists here.**

---

### RISK-09 — Multi-Tab Concurrent Sync (MEDIUM)
**Severity: MEDIUM**
**File:** `frontend-pos/index.html` — `syncOfflineSales()` / `syncInProgress` flag

The `syncInProgress` guard is a module-level boolean — it exists per JavaScript execution context (per tab):
```javascript
let syncInProgress = false;

async function syncOfflineSales() {
    if (syncInProgress) return;
    syncInProgress = true;
    // ...
    syncInProgress = false;
}
```

If the POS is open in two browser tabs (same device, different tabs), both tabs have independent `syncInProgress = false`. Both share the same IndexedDB. An online event fires in both tabs → both tabs start syncing simultaneously → both read the same pending records → both attempt to POST the same sales to the server.

**Correctness impact:** The idempotency key on each offline sale record ensures the server deduplicates. The second attempt returns the existing sale (correct). No duplicate sales created. However:
- The 23505 race described in RISK-04 becomes more likely
- Server receives double the sync requests during reconnection
- Both tabs update the same IndexedDB record's status concurrently — one update may overwrite the other (though both would write `status: 'synced'`, so the net result is correct)

**Impact at multi-till scale:** Multi-tab on the same physical till is operator error, not a designed use case. At pilot scale this is unlikely. Not a blocker.

**Recommended mitigation (future):** Use a BroadcastChannel or SW-managed sync lock to designate one tab as sync leader. Out of scope for pilot.

---

### RISK-10 — Sync Debounce Does Not Cover Service Worker Background Sync
**Severity: LOW**
**File:** `frontend-pos/service-worker.js` — `sync` event + `frontend-pos/index.html` — online handler

The app has two sync trigger paths:
1. **App-side:** `window.addEventListener('online', ...)` → 1-second debounce → `syncOfflineSales()`
2. **SW-side:** `self.addEventListener('sync', ...)` → sends `SYNC_SALES` postMessage → app's message handler → `syncOfflineSales()`

Both paths lead to the same `syncInProgress` guard, so both cannot run concurrently within one tab. However, if the `online` event fires AND the SW fires a background sync at roughly the same time (e.g., on reconnect), the first caller gets `syncInProgress = false` and proceeds; the second hits `syncInProgress = true` and returns immediately. Correct behaviour — one sync runs, the other yields.

**No race condition.** The debounce is specifically to prevent the online event from firing multiple times during a flaky reconnect (network bounces). The SW background sync is not affected by the debounce.

**Status: Non-issue.**

---

## Audit Area 4 — Manager Intervention Conflicts

### RISK-11 — `ABANDONED_SESSION_DETECTED` Audit Flood
**Severity: HIGH**
**File:** `backend/modules/pos/routes/recovery.js`

```javascript
router.get('/sessions', authenticateToken, requireRole(['manager', 'admin']), async (req, res) => {
    const STALE_SESSION_HOURS = 8;
    // ...
    for (const session of staleSessions) {
        await supabase.from('pos_audit_log').insert({
            event_type: 'ABANDONED_SESSION_DETECTED',
            // ...
        });
    }
    res.json({ staleSessions });
});
```

Every call to `GET /recovery/sessions` inserts one audit log row per stale session found — even if those same stale sessions were already reported on the previous call.

**Scenario:** Three tills go offline during a power cut. The cashiers leave without closing their sessions. Tills are down for 3 hours. A manager opens the Recovery screen in the manager panel and hits refresh every 30 seconds trying to check if the sessions cleared. Each refresh inserts 3 `ABANDONED_SESSION_DETECTED` rows. Over 10 minutes of polling, that's 60 audit rows for 3 sessions that haven't changed.

**Impact at multi-till scale:** At 10 tills with 3 stale sessions, a manager polling the recovery page every 30 seconds for 30 minutes generates 180 phantom audit rows. The `pos_audit_log` table becomes noisy. Forensic audit searches return false positives.

**Secondary risk:** If the recovery page is used as a dashboard (auto-refreshing), the audit flood is continuous and proportional to the number of stale sessions × refresh rate.

**Mitigation already in place:** None. Recovery routes are audit-only (no data mutations), so there is no data-integrity risk — only audit quality degradation.

**Recommended fix (Workstream 9B):** Add a `last_abandonment_reported_at` column to `pos_sessions`, or deduplicate in the recovery handler by checking if an `ABANDONED_SESSION_DETECTED` event already exists for this session in the last N hours before inserting a new one. A simpler approach: the event should fire once, when the session BECOMES stale — not every time the recovery page is viewed.

---

### RISK-12 — Session Recovery Does Not Close or Reassign the Session
**Severity: LOW (by design)**
**File:** `backend/modules/pos/routes/recovery.js`

The recovery routes are audit and visibility tools only. They cannot close a session, transfer its sales, or mark it as abandoned. A manager who identifies a stale session via the recovery API cannot act on it from within Checkout Charlie — they must go to the database directly or wait for the session to be cleaned up.

This is a workflow gap, not a data-integrity risk. Sales made in the stale session are correctly recorded. The session sits open until manually closed or until an admin-level cleanup runs.

**Impact at multi-till scale:** If a cashier doesn't close their session at end of shift, the till will be blocked for other users who happen to share the same `user_id` (same login). Since the current duplicate-session gate is per-user (not per-till), a second user on a different till with a different account is not blocked. The only practical impact is a growing list of stale sessions in the recovery view.

**Recommended enhancement (Workstream 9B):** Add a `POST /recovery/sessions/:id/close` endpoint — manager-authorized, writes final snapshot with `status: 'abandoned'`, records manager identity in audit log. Not a blocker for pilot.

---

## Audit Area 5 — DB / Backend Stress + PWA/Browser Risks

### RISK-13 — No Index on `sales(company_id, created_at)` for Report Queries
**Severity: MEDIUM (known — migration 033 deferred)**
**File:** `database/migrations/033_pos_core_performance_indexes.sql`

Migration 033 added indexes on `pos_sessions(company_id, status)`, `pos_products(company_id, is_active)`, and `sale_items(sale_id)`. It explicitly did NOT add an index on `sales(company_id, created_at)` — the comment indicates this was deferred pending volume data.

End-of-day reports, shift reconciliation, and sales dashboards typically query `WHERE company_id = $x AND created_at BETWEEN $start AND $end`. Without the composite index, these queries do full table scans on the `sales` table.

**Impact at multi-till scale:** At pilot scale (4–10 tills, hundreds of sales per day), a full table scan is fast enough (milliseconds). At 50 tills with 18 months of history (~1M rows), the same query will noticeably slow. This is a known deferred risk, not a surprise.

**Recommended fix:** Add `CREATE INDEX CONCURRENTLY idx_sales_company_created ON sales(company_id, created_at DESC)` before going beyond pilot scale. Can be done as a zero-downtime migration.

---

### RISK-14 — `getStockPolicy()` 60-Second Server-Side Cache Shared Across All Requests
**Severity: LOW**
**File:** `backend/modules/pos/routes/sales.js`

```javascript
let stockPolicyCache = { policy: null, fetchedAt: 0 };
const STOCK_POLICY_CACHE_TTL_MS = 60 * 1000;

async function getStockPolicy(companyId) {
    if (Date.now() - stockPolicyCache.fetchedAt < STOCK_POLICY_CACHE_TTL_MS && ...) {
        return stockPolicyCache.policy;
    }
    // fetch from DB
}
```

This is a module-level cache shared across all concurrent requests on the same Node.js process. If Company A and Company B both use the same Node instance, they share the same `stockPolicyCache` object. The cache key includes `companyId` so there is no cross-company contamination — but the cache object is a single module-level variable, not a per-company Map.

**Actual risk:** On audit of the code, `stockPolicyCache` stores the most recently fetched policy and its `companyId`. A second company's request invalidates the first company's cached value. In a multi-company deployment, the cache hit rate drops proportionally to the number of active companies. The cache degrades to near-zero utility under multi-company concurrent load.

**Impact at pilot scale (single company):** No impact — single-company means the cache always hits.
**Impact at multi-company scale:** Each sale request may trigger a DB round-trip for `company_settings`. Under 10 tills × 10 sales/minute = 100 `getStockPolicy()` calls/minute with low cache hit rate. The query is cheap (indexed lookup), so this is a latency nuisance, not a critical failure.

**Recommended fix (Workstream 9B):** Change `stockPolicyCache` to a `Map<companyId, { policy, fetchedAt }>`. Trivial change, prevents cross-company cache invalidation.

---

### RISK-15 — PWA Service Worker Cache Staleness Under Forced Update
**Severity: LOW (R4 from 8B verification)**
**File:** `frontend-pos/index.html` — SW registration block

If Service Worker registration fails at page load (network issue, browser restriction), `window.onForceUpdateRequired` is defined inside the registration `try` block. If registration throws before that line, the callback is never set.

`update-check.js` guards against this with `typeof window.onForceUpdateRequired === 'function'` — so `triggerForcedUpdate()` will still show the red banner, but the `forceUpdatePending` flag in `index.html` will never be set, so `addToCart()` and `checkout()` will not be gated.

**Impact:** If SW fails to register AND `FORCE_UPDATE=true` fires, the cashier sees the red banner but is not blocked from transacting. The banner exists; the gate does not.

**Probability:** SW registration failing in production is extremely rare. And if SW fails to register, the entire offline queue is broken, making the POS functionally degraded regardless. For pilot, acceptable.

---

## What Is Already Strong

| Area | Strength |
|---|---|
| Last-unit concurrency | Atomic `UPDATE WHERE stock_quantity >= qty` — no oversell possible |
| Sale idempotency | UUID idempotency key — safe retry, no duplicate sales |
| Offline data path | IndexedDB as sole queue — SW data-loss path eliminated in 8B |
| Forced update gates | Both `addToCart()` and `checkout()` gated — no stale-code transacting |
| Auth and company isolation | `req.companyId` enforced on all routes; `requireCompany` middleware blocks null context |
| Sync debounce | 1-second debounce on online event prevents storm on network flap |
| Atomic sale RPC | Full `create_sale_atomic` plpgsql transaction — sale + items + payments + stock in one ACID unit |
| Session duplicate check | Per-user gate prevents same user opening two sessions simultaneously |
| Recovery routes are read-only | Manager visibility cannot corrupt data |

---

## Risk Register

| ID | Risk | Severity | Blocker for Pilot? | Recommended Action |
|---|---|---|---|---|
| RISK-01 | Non-atomic return stock reversal | HIGH | No — returns are low volume at pilot | Fix before multi-till rollout (9B) |
| RISK-02 | No per-till session uniqueness | HIGH | No — single cashier per till at pilot | Fix before scaled rollout (9B) |
| RISK-04 | Idempotency SELECT→INSERT race | MEDIUM | No — single-tab usage eliminates this | Accept for pilot; fix if multi-tab becomes common |
| RISK-05 | In-memory stock drift over long sessions | MEDIUM | No — DB always authoritative | Add periodic refresh in 9B |
| RISK-06 | `updateOfflineBanner()` full-table reads | MEDIUM | No — fast at pilot record volume | Fix before sustained offline usage |
| RISK-09 | Multi-tab concurrent sync | MEDIUM | No — single-tab per till is the use case | Accept for pilot |
| RISK-11 | `ABANDONED_SESSION_DETECTED` audit flood | HIGH | No — audit quality issue, not data integrity | Fix before manager tooling is used in production |
| RISK-12 | No session close action in recovery | LOW | No — sessions accumulate but don't corrupt | Add manager close action in 9B |
| RISK-13 | No `sales(company_id, created_at)` index | MEDIUM | No — fast at pilot volume | Add before scaling beyond pilot |
| RISK-14 | `stockPolicyCache` shared across companies | LOW | No — pilot is single-company | Fix before multi-company deployment |
| RISK-15 | SW registration failure + force update gap | LOW | No — edge case, extreme conditions | Accept for pilot |

---

## Pilot-Safe Operational Limits

Given the risks above, Checkout Charlie is pilot-safe under the following conditions:

| Limit | Reason |
|---|---|
| Max 1 cashier per till (no shared till logins) | RISK-02: no per-till session uniqueness yet |
| Max 1 browser tab per till | RISK-09: multi-tab sync is unguarded |
| Returns processed one at a time (not concurrently) | RISK-01: return stock reversal is non-atomic |
| Recovery screen used once to diagnose, not polled repeatedly | RISK-11: audit flood on repeated polling |
| Till page refreshed at start of each shift | RISK-05: stock drift accumulates over long sessions |
| Pilot at single company | RISK-14: stock policy cache is per-module, not per-company Map |

None of these limits are unusual for a pilot deployment. They reflect normal retail till operation.

---

## Recommended Hardening Order (Workstream 9B)

Priority order for the next implementation workstream:

| # | Fix | Why First |
|---|---|---|
| 1 | Per-till session uniqueness check at session open | Prevents ambiguous reconciliation data |
| 2 | Atomic return stock reversal | Prevents silent stock corruption under concurrent returns |
| 3 | `ABANDONED_SESSION_DETECTED` deduplication | Prevents audit log poisoning before manager tooling goes live |
| 4 | `stockPolicyCache` → per-company Map | Trivial change; fixes multi-company correctness before any second company onboards |
| 5 | Periodic `cacheProducts()` refresh (15–30 min) | Prevents cashiers seeing wrong stock availability mid-shift |
| 6 | `updateOfflineBanner()` use count queries instead of `getAll()` | Prevents performance degradation under sustained offline usage |
| 7 | Manager session close action (`POST /recovery/sessions/:id/close`) | Operational completeness for manager tooling |
| 8 | `sales(company_id, created_at)` index | Required before report queries on any meaningful data volume |

---

## Files Audited

| File | What Was Checked |
|---|---|
| `backend/modules/pos/routes/sales.js` | Atomic RPC path, stock pre-check, return route race condition, idempotency handling, `getStockPolicy()` cache |
| `backend/modules/pos/routes/sessions.js` | Session open duplicate check, per-user vs per-till guard |
| `backend/modules/pos/routes/recovery.js` | `ABANDONED_SESSION_DETECTED` flood, read-only safety |
| `frontend-pos/index.html` | `syncOfflineSales()`, `syncInProgress`, `syncDebounceTimer`, `updateOfflineBanner()`, `cacheProducts()`, `saveOfflineSale()`, `checkout()`, `addToCart()`, barcode handlers, load handler |
| `database/migrations/027_pos_create_sale_atomic_idempotent.sql` | Idempotency SELECT→INSERT race, UNIQUE INDEX |
| `database/migrations/024_pos_decrement_stock_rpc.sql` | Atomic WHERE clause, row-level lock |
| `database/migrations/030_pos_stock_policy.sql` | `decrement_stock_v2`, negative-stock mode |
| `database/migrations/033_pos_core_performance_indexes.sql` | Deferred `sales(company_id, created_at)` index |

---

## No Code Changes in This Workstream

This is a pure audit document. No files were modified. All findings are tracked as follow-up risks for Workstream 9B.

The risks are documented, prioritised, and pilot-safe. Checkout Charlie is ready for a controlled pilot under the operational limits stated above.
