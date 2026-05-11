# 09 — Checkout Charlie: Offline/Online Architecture Design
**Phase 2 — DESIGN ONLY. No code changes.**
Date: 2026-05-11

---

## EXECUTIVE SUMMARY

The current offline sale system has two production-critical defects:

1. **No idempotency key** — the same offline sale can be posted to the server multiple times, creating duplicate sale records and double stock decrements. This happens silently today whenever the `online` event fires more than once (which browsers do routinely).

2. **No conflict handling** — when a sync fails (422 stock conflict, 400 invalid session, 500 error), the sale is silently skipped and the cashier sees "synced successfully" regardless. The sale is never retried cleanly and never surfaced to a manager.

**Nothing else in the offline architecture matters until idempotency is solved.** Every other improvement — conflict handling, manager recovery, cashier alerts — is unstable without a deduplication guarantee at the server.

---

## SECTION 1: CURRENT STATE — EXACT DEFECTS

### Source: `frontend-pos/index.html` lines 3338–3374

```javascript
async function syncOfflineSales() {
    const pendingSales = await getPendingOfflineSales();
    for (const sale of pendingSales) {
        const response = await fetch(`${API_URL}/pos/sales`, {
            body: JSON.stringify({
                tillSessionId: sale.tillSessionId,
                items: sale.items,
                paymentMethod: sale.paymentMethod,
                // ↑ No idempotency key
            })
        });
        if (response.ok) {
            await markSaleSynced(sale.tempId, result.saleId);
            // ↑ Marks synced=true but NEVER DELETES the record
        }
        // catch: silently continues — 422/500 are absorbed
    }
    showNotification('Offline sales synced successfully!', 'success');
    // ↑ Fires even if every sale failed
}
```

### Defect inventory

| Defect | Category | Impact |
|---|---|---|
| No idempotency key | DATA INTEGRITY | Duplicate sale records + double stock decrements |
| No sync lock | DATA INTEGRITY | `online` event + SW `SYNC_SALES` message fire concurrently — same sale posted twice |
| 422/500 silently swallowed | DATA LOSS | Stock conflicts and server errors produce no manager alert, no retry |
| Synced records kept forever | TECHNICAL DEBT | IndexedDB grows unboundedly; `synced=true` records confuse the queue |
| Optimistic stock write-back | UX RISK | `product.current_stock` mutated in-memory and cached — becomes stale source of truth until reconnect |
| Blanket success notification | UX LIE | "Synced successfully" shown even when all syncs failed |

### Source: lines 3410–3421 (concurrent trigger paths)

```javascript
// TRIGGER 1: network online event
window.addEventListener('online', async () => {
    await syncOfflineSales();   // ← runs here
});

// TRIGGER 2: service worker message
navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data.type === 'SYNC_SALES') {
        syncOfflineSales();     // ← can run simultaneously
    }
});
```

Both can fire within milliseconds of each other. `syncOfflineSales` has no guard. The same pending sale gets POSTed twice to the server in the same instant.

---

## SECTION 2: CORE PRINCIPLE

```
IndexedDB is a SEND QUEUE — not a record store.

An entry in the offlineSales store is UNCONFIRMED business data.
The moment the server returns 201 (or 200 idempotent), the IndexedDB
entry is DELETED. The server record is the only source of truth.

No sale exists until the server says it exists.
The offline receipt shown to the customer is a DRAFT receipt.
```

This principle governs every design decision below.

---

## SECTION 3: IDEMPOTENCY DESIGN

### 3.1 — The idempotency key

Every sale — online or offline — receives a UUID (v4) generated on the client at the moment the cashier presses "Complete Sale". This key:

- Is generated once and never changes
- Is stored in the offline queue record
- Is passed to the server on every sync attempt
- Is stored in the `sales` table with a UNIQUE constraint

If the server receives a sale whose `idempotency_key` already exists in `sales`, it returns the existing sale record rather than creating a new one. The sync is idempotent: posting the same sale ten times produces exactly one sale record.

### 3.2 — Database migration required

```sql
-- Migration 026
ALTER TABLE sales ADD COLUMN idempotency_key UUID;
CREATE UNIQUE INDEX idx_sales_idempotency ON sales(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

The column is nullable to allow legacy sales without keys. New sales always provide a key.

### 3.3 — create_sale_atomic update required

The function must check for an existing sale before inserting:

```sql
CREATE OR REPLACE FUNCTION create_sale_atomic(
  -- ... existing params ...
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_existing sales%ROWTYPE;
  -- ... existing declares ...
BEGIN
  -- Idempotency check: return existing sale if key already recorded
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM sales
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'sale_id',        v_existing.id,
        'sale_number',    v_existing.sale_number,
        'receipt_number', v_existing.receipt_number,
        'total_amount',   v_existing.total_amount,
        'status',         v_existing.status,
        'was_duplicate',  true
      );
    END IF;
  END IF;

  -- Normal insert path (existing logic unchanged)
  INSERT INTO sales (
    ..., idempotency_key
  ) VALUES (
    ..., p_idempotency_key
  ) RETURNING ...;

  -- ... rest unchanged ...
END;
$$;
```

The `was_duplicate: true` flag in the response lets the client know it was a replayed request and can safely delete the IndexedDB record.

### 3.4 — sales.js route update required

```javascript
// At sale number generation time (before the RPC):
const idempotencyKey = crypto.randomUUID();

// In the RPC call:
const { data: rpcResult, error: rpcError } = await supabase.rpc('create_sale_atomic', {
  ...
  p_idempotency_key: idempotencyKey,
});
```

### 3.5 — Frontend update required (online sales)

```javascript
// In checkout — generate key before POST, include in body
const idempotencyKey = crypto.randomUUID();
body: JSON.stringify({
  idempotencyKey,          // ← add this
  tillSessionId: ...,
  items: ...,
  paymentMethod: ...
})
```

### 3.6 — Frontend update required (offline sales)

```javascript
async function saveOfflineSale(saleData) {
  const sale = {
    ...saleData,
    idempotencyKey: crypto.randomUUID(),   // ← generate ONCE, here, never again
    status: 'pending',
    syncAttempts: 0,
    lastSyncError: null,
    createdAt: new Date().toISOString(),
    tempSaleNumber: 'OFFLINE-' + Date.now(),
  };
  // ... IndexedDB write
}
```

The key must be generated at save time, not at sync time. If it were generated at sync time, a repeated sync attempt would use a different key each time and bypass deduplication.

---

## SECTION 4: SALE STATUS STATE MACHINE

Each offline sale moves through defined states. No state transition is allowed outside this machine.

```
                        ┌───────────────────────────────────┐
         cashier        │                                   │
         completes      │         PENDING                   │
         offline sale   │   (awaiting sync)                 │
              │         └───────────────┬───────────────────┘
              │                         │
              ▼                         │ sync loop picks up
          IndexedDB                     ▼
                               ┌────────────────┐
                               │   SYNCING      │
                               │ (in-flight)    │
                               └───┬──────┬─────┘
                                   │      │
                     ┌─────────────┘      └────────────────┐
                     │ 201/200                              │ error
                     ▼                                      ▼
              ┌────────────┐         ┌──────────────────────────────┐
              │  SYNCED    │         │                              │
              │ → DELETE   │         │   422 stock conflict         │
              │ from IDB   │         │   → CONFLICT_STOCK           │
              └────────────┘         │                              │
                                     │   400/422 session invalid    │
                                     │   → CONFLICT_SESSION         │
                                     │                              │
                                     │   500 / network error        │
                                     │   → attempts < MAX: PENDING  │
                                     │   → attempts >= MAX: FAILED  │
                                     └──────────────────┬───────────┘
                                                        │
                                          ┌─────────────┴──────────┐
                                          │                        │
                                     manager                  manager
                                     approves                 discards
                                          │                        │
                                          ▼                        ▼
                                      retry sync              CANCELLED
                                                           (notify cashier)
```

**States that require manager action before resolution:**
- `CONFLICT_STOCK` — product sold out between offline sale and sync
- `CONFLICT_SESSION` — till session closed during offline period
- `FAILED` — max retries exhausted, underlying cause unknown

---

## SECTION 5: SYNC QUEUE DESIGN

### 5.1 — Sync lock

```javascript
let syncInProgress = false;

async function syncOfflineSales() {
  if (syncInProgress) {
    console.log('[Sync] Already syncing — skipping duplicate trigger');
    return;
  }
  syncInProgress = true;
  try {
    await runSyncCycle();
  } finally {
    syncInProgress = false;
  }
}
```

This lock is process-scoped (single browser tab). Multiple tabs need a `BroadcastChannel` or `localStorage`-based lock — addressed in Section 5.5.

### 5.2 — Sync cycle per-sale logic

```javascript
async function runSyncCycle() {
  const pendingSales = await getSalesByStatus('pending');
  if (pendingSales.length === 0) return;

  const results = { synced: 0, conflicts: 0, failed: 0 };

  for (const sale of pendingSales) {
    await markSaleStatus(sale.tempId, 'syncing');

    let response, body;
    try {
      response = await fetch(`${API_URL}/pos/sales`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey:  sale.idempotencyKey,
          tillSessionId:   sale.tillSessionId,
          items:           sale.items,
          paymentMethod:   sale.paymentMethod,
          customerId:      sale.customerId || undefined,
          payments:        sale.payments || undefined,
        }),
      });
      body = await response.json();
    } catch (networkErr) {
      // Network failure — put back to pending, stop this cycle
      await markSaleStatus(sale.tempId, 'pending', networkErr.message);
      break;   // Do not continue — network is gone. Next online event retries.
    }

    if (response.ok) {
      // 201 or 200 — confirmed or already existed (idempotent)
      await deleteOfflineSale(sale.tempId);   // DELETE, not mark synced
      results.synced++;
    } else if (response.status === 422 && body.error?.includes('Stock')) {
      await markSaleStatus(sale.tempId, 'conflict_stock', body.details);
      results.conflicts++;
    } else if (response.status === 400 || response.status === 422) {
      await markSaleStatus(sale.tempId, 'conflict_session', body.error);
      results.conflicts++;
    } else {
      const attempts = sale.syncAttempts + 1;
      const newStatus = attempts >= MAX_SYNC_RETRIES ? 'failed' : 'pending';
      await markSaleStatus(sale.tempId, newStatus, body.error, attempts);
      results.failed++;
    }
  }

  reportSyncResults(results);
}
```

### 5.3 — MAX_SYNC_RETRIES

Default: **3**. After 3 failed attempts (not counting conflict states which are permanent), the sale is marked `failed` and requires manager intervention. This prevents an infinite retry loop against a broken server.

### 5.4 — Sync triggers

```javascript
// Trigger 1: browser online event (with debounce)
let syncDebounceTimer = null;
window.addEventListener('online', () => {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(syncOfflineSales, 2000); // 2s debounce
});

// Trigger 2: SW SYNC_SALES message (no debounce — SW already debounces)
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data.type === 'SYNC_SALES') syncOfflineSales();
});

// Trigger 3: periodic retry for 'pending' (failed-then-put-back) sales
// Run every 5 minutes if online
setInterval(() => { if (isOnline) syncOfflineSales(); }, 5 * 60 * 1000);
```

### 5.5 — Multi-tab sync lock (Phase 2E, deferred)

If the cashier has two browser tabs open, both will respond to the `online` event and attempt to sync. The module-level lock does not cross tab boundaries.

**Short-term mitigation:** The idempotency key means even if two tabs both sync, the server creates the sale only once and both get back the same sale ID. This is the safe fallback even without a cross-tab lock.

**Long-term fix (Phase 2E):** Use the `Web Locks API` (`navigator.locks.request('pos-sync', ...)`) to ensure only one tab holds the sync lock at a time. Supported in all modern browsers.

---

## SECTION 6: CONFLICT HANDLING

### 6.1 — Stock conflict (422 from `decrement_stock` P0001)

**Cause:** A product was sold by another cashier, a return was voided, or the product was manually adjusted while this cashier was offline. The stock that appeared available when the offline sale was taken is no longer available at sync time.

**Important:** `create_sale_atomic` rolls back the entire transaction on P0001 — no orphan sale record is created. The conflict is clean.

**Resolution options (manager-controlled):**

| Option | When | Effect |
|---|---|---|
| **Accept and adjust** | Manager confirms the sale should stand | Manager posts a manual stock adjustment (negative) to cover the difference, then re-syncs the sale |
| **Discard the sale** | Product genuinely unavailable | IndexedDB record deleted, cashier notified, customer refunded if receipt was issued |
| **Reduce quantity** | Partial stock available | Manager edits the offline sale to reduce quantity to what's available, then re-syncs |

### 6.2 — Till session conflict (400/422 session invalid)

**Cause:** The till session was closed (end-of-day, forced close by manager, or inactivity timeout) while the cashier was offline. The `till_session_id` stored in the offline sale no longer maps to an open session.

**Resolution:**

| Option | When | Effect |
|---|---|---|
| **Reassign to current session** | Same cashier, same day | Manager edits the `till_session_id` to point to the current open session, re-syncs |
| **Create recovery session** | Session closed permanently | Manager opens a special recovery session (type: `recovery`), assigns the sale to it |
| **Discard** | Manager determines sale is invalid | IndexedDB record deleted |

### 6.3 — Price conflict (informational — not an error)

**Cause:** A product's price was changed on the server between the time the offline sale was recorded and the time it synced.

**Behaviour:** This is NOT a sync failure. The server-side route always looks up prices from the database — the cashier's cached price is ignored. The sale is created at the current DB price.

**Risk:** The customer received a paper receipt showing the old cached price. The server record shows the new price. This is a discrepancy.

**Mitigation:**
- The server response on sync should include the `total_amount` that was actually charged.
- If it differs from the cached `totalAmount`, the POS should flag it: "Sale synced at R[new amount] — receipt showed R[cached amount]. Manual adjustment may be required."
- Price conflict is rare (requires a price change during an offline window).

### 6.4 — Network failure during sync

**Cause:** Connectivity drops again during sync (e.g. flapping connection).

**Behaviour:** The `try/catch` in the sync loop catches the network error. The current sale being synced is reset to `pending`. The sync loop **stops** (`break`) — there is no point continuing if the network is down. The next `online` event retries.

This is safe because of idempotency keys: partial syncs that managed to POST before the failure will be handled correctly (server returns 200 idempotent if re-posted).

---

## SECTION 7: BROWSER STORAGE POLICY

### 7.1 — What is permitted

| Storage | Key / Store | What it holds | Classification |
|---|---|---|---|
| `localStorage` | `token` | JWT auth token | Auth — permitted |
| `localStorage` | `isSuperAdmin` | UI display flag | UI preference — permitted |
| IndexedDB | `products` | Server-cached product catalog | READ-ONLY cache — permitted with rules |
| IndexedDB | `customers` | Server-cached customer list | READ-ONLY cache — permitted with rules |
| IndexedDB | `offlineSales` | Unconfirmed pending sales | SEND QUEUE — permitted with strict rules |
| IndexedDB | `sessionData` | Current till session ID/token | Session context — permitted |

### 7.2 — Rules for the offlineSales send queue

These rules make IndexedDB acceptable for pending sale data under CLAUDE.md Part D:

1. **Delete, not mark.** Synced records are `DELETE`d from IndexedDB immediately. A record with `status = 'synced'` must never persist. The server record is the canonical fact.

2. **Treat as draft only.** An `offlineSales` entry is not a sale. It is a form submission pending acknowledgement. No financial reporting, no inventory calculation, no audit trail uses these records.

3. **Never display as confirmed.** The offline receipt shown to the cashier must be visually distinct (e.g. "DRAFT — Pending Sync" watermark, `OFFLINE-{timestamp}` number). The real sale number is only known after sync.

4. **Reconcile on reconnect.** After every sync cycle, `loadProducts()` is called to replace the locally-mutated stock cache with server-authoritative values. Local stock mutations exist only as UX aid, never as inventory record.

5. **Manager visibility.** Any record not in `synced` state must be accessible to a manager via the recovery screen. Offline sales are not hidden from oversight.

6. **TTL enforcement.** Any IndexedDB record older than 7 days is considered stale and auto-escalated to `failed` regardless of `syncAttempts`. This prevents zombie queue entries accumulating from browser sessions that were abandoned mid-offline.

### 7.3 — What is NOT permitted

- `localStorage.setItem` of any sale data, product prices, stock quantities, or payment records
- `sessionStorage` of any business data
- Using IndexedDB `products` cache as authoritative stock levels (it's a display cache only)
- Reporting stock levels from the IndexedDB cache to any business logic
- Allowing offline-decremented cached stock to persist after reconnect without a server refresh

---

## SECTION 8: OFFLINE STOCK OPTIMISM — POLICY

### Current behaviour (lines 4551–4558)

```javascript
// Offline sale completed — update local display only
for (const item of cart) {
  const product = products.find(p => p.id === item.productId);
  if (product) {
    product.current_stock = Math.max(0, (product.current_stock || 0) - item.quantity);
  }
}
await cacheProducts(products);
```

This optimistic decrement is **allowed as a UX affordance** under the following conditions:

1. **It is immediately overwritten on reconnect** — `loadProducts()` after sync replaces the entire product cache with server data. The optimistic decrement has a maximum lifespan equal to the offline window duration.

2. **It is used only for display** — the "stock remaining" shown in the POS grid. It is not used for server-side stock calculations or inventory reports.

3. **It is visually differentiated from confirmed stock** — while offline, the stock display should show "~3 remaining" (tilde = estimated) or use a different colour/icon to indicate that stock levels are unconfirmed.

4. **It cannot go below zero** — already handled by `Math.max(0, ...)`.

5. **Conflicts are expected and handled** — if the cashier's optimistic decrement was wrong (another cashier sold the same item from a different terminal), the stock conflict at sync time triggers the manager workflow.

### What MUST NOT change

- The server's `decrement_stock` RPC is the only authoritative stock write. Period.
- The in-memory decrement does not bypass or replace the server RPC.

---

## SECTION 9: PRE-OFFLINE REQUIREMENTS

Before a cashier can take offline sales, these conditions must be verified (at the moment connectivity is lost or proactively before a known offline window):

| Requirement | Check | If failed |
|---|---|---|
| Active till session | `currentSession` is set and `status = 'open'` | Disable offline sales. Show: "Open a till session before going offline." |
| Product catalog freshness | `lastProductSync` timestamp < 30 minutes ago | Warn: "Product list may be outdated. Prices may differ on sync." |
| Authentication validity | `token` exists and not expired | Force re-login. Cannot take offline sales without a valid token for the sync. |
| Network was previously confirmed | At least one successful `/api/health` response this session | Warn: "Never connected this session — offline mode may not sync correctly." |

### Cashier-facing offline mode banner

```
┌───────────────────────────────────────────────────────────────────┐
│  ⚠  OFFLINE MODE — Sales are being saved locally (3 pending)     │
│  Stock levels shown are estimates. Syncing when connection returns │
└───────────────────────────────────────────────────────────────────┘
```

- Banner is non-dismissable while offline
- Shows live count of pending sales
- Visually distinct from the normal header (e.g. amber/yellow background)

---

## SECTION 10: RECONNECT FLOW

When `window.addEventListener('online', ...)` fires:

```
1. Show "Reconnected — syncing pending sales..." overlay (non-blocking)
2. Debounce 2 seconds (wait for connection to stabilise)
3. Attempt syncOfflineSales() with sync lock
4. For each pending sale: run sync cycle (Section 5.2)
5. Show per-result notifications:
   - "3 offline sales synced ✓"
   - "1 sale has a stock conflict — manager review needed ⚠"
   - "2 sales failed after 3 attempts — manager review needed ✗"
6. If any conflicts/failures: show persistent badge + manager alert
7. loadProducts() — refresh product catalog with server-authoritative data
8. Stock display returns to confirmed (remove ~ estimated indicators)
9. Remove offline banner
```

---

## SECTION 11: MANAGER RECOVERY SCREEN

### 11.1 — Purpose

A manager-only view (requires role `manager` or `super_admin`) that shows all unresolved offline sales across all browsers on this terminal. It reads directly from IndexedDB (current tab) and should eventually read from a server-side pending queue (Phase 2E).

### 11.2 — Screen layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SYNC RECOVERY — Manager View                            [Refresh]       │
├──────┬──────────────────┬───────────┬────────────┬───────────┬──────────┤
│  #   │  Offline Time    │  Cashier  │  Items     │  Total    │  Status  │
├──────┼──────────────────┼───────────┼────────────┼───────────┼──────────┤
│  1   │  12:34 (3h ago)  │  Ruan V.  │  3 items   │  R450.00  │  ⚠ STOCK │
│  2   │  13:15 (2h ago)  │  Ruan V.  │  1 item    │  R75.50   │  ✗ FAILED│
├──────┴──────────────────┴───────────┴────────────┴───────────┴──────────┤
│  Actions for selected:  [View Items]  [Approve + Adjust Stock]           │
│                         [Reassign Session]  [Discard]  [Force Retry]     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 11.3 — Actions

| Action | Status applicable | Server operation |
|---|---|---|
| **Approve + Adjust Stock** | `conflict_stock` | Manager posts manual stock adjustment, then re-syncs the sale |
| **Reassign Session** | `conflict_session` | Manager provides a valid `till_session_id`, record is updated, then re-synced |
| **Discard** | Any | Record deleted from IndexedDB. If a paper receipt was issued, manager must handle reversal manually. |
| **Force Retry** | `failed` | Reset `syncAttempts = 0`, `status = 'pending'`, trigger sync |
| **View Items** | Any | Expand row to show individual items, prices, and payment method |

### 11.4 — Cashier notification

When a manager discards or resolves a sale, the cashier who created it receives a toast:

- "Your offline sale OFFLINE-1715000000 was synced as SAL-... ✓"
- "Your offline sale OFFLINE-1715000001 was discarded by manager. Customer refund may be required."

---

## SECTION 12: IMPLEMENTATION ORDER

### PHASE 2A — Idempotency (BLOCKING — nothing else is safe without this)

**This must be implemented before offline mode is used in production.**

| Task | File | Notes |
|---|---|---|
| Migration 026: `idempotency_key UUID UNIQUE` on `sales` | New migration SQL | Nullable for legacy rows |
| Update `create_sale_atomic` | Migration 027 | Upsert-style: check key, return existing if found |
| Update `sales.js` | Route | Generate `crypto.randomUUID()`, pass as `p_idempotency_key` |
| Update frontend — online sales | `index.html` | Generate UUID in checkout, include in POST body |
| Update `saveOfflineSale` | `index.html` | Generate UUID once at save time, store in record |
| Update `syncOfflineSales` | `index.html` | Include `idempotencyKey` in sync POST body |

Estimated: 2 sessions (migration + route + frontend)

---

### PHASE 2B — Sync Lock + Status Tracking (cannot be reliable without 2A)

| Task | File | Notes |
|---|---|---|
| Add `syncInProgress` boolean lock | `index.html` | Module-level, check at entry of sync function |
| Debounce `online` event | `index.html` | 2-second debounce before sync starts |
| Add `status`, `syncAttempts`, `lastSyncError` to IDB schema | `index.html` | Requires IDB version bump |
| Rewrite sync loop with error branching | `index.html` | Per Section 5.2 |
| DELETE confirmed records (not mark synced) | `index.html` | Removes accumulation problem |

Estimated: 1 session

---

### PHASE 2C — Cashier Alerts

| Task | Notes |
|---|---|
| Per-result sync notifications | Replace blanket "synced successfully" |
| Persistent conflict badge | Badge count on offline indicator |
| Offline banner with pending count | Non-dismissable, amber style |
| Estimated stock display marker (`~`) | Visual cue for unconfirmed stock |

Estimated: 0.5 sessions (UI-only, no API changes)

---

### PHASE 2D — Manager Recovery Screen

| Task | Notes |
|---|---|
| Recovery route/modal | Manager-only, reads from IndexedDB |
| Action: Approve + Adjust Stock | Manual stock adjustment POST + re-sync |
| Action: Reassign Session | Edit till_session_id in IDB + re-sync |
| Action: Discard | DELETE from IDB + cashier notification |
| Action: Force Retry | Reset attempts + re-sync |
| Cashier notification on resolution | Toast to cashier with outcome |

Estimated: 2 sessions

---

### PHASE 2E — Multi-Tab Lock (deferred)

| Task | Notes |
|---|---|
| `navigator.locks.request('pos-sync', ...)` | Prevents concurrent sync across tabs |
| Server-side pending queue | So recovery screen works across browsers/devices |

Estimated: 1 session (Phase 2E is a refinement, not safety-critical once idempotency is in place)

---

## SECTION 13: WHAT MUST BE BLOCKED UNTIL PHASE 2A IS COMPLETE

```
┌────────────────────────────────────────────────────────────────────┐
│  BLOCKED — DO NOT USE IN PRODUCTION UNTIL PHASE 2A IS DONE       │
│                                                                    │
│  Offline sale mode is unsafe today.                               │
│                                                                    │
│  Every time the online event fires twice (which it does),         │
│  the same offline sale is posted twice.                           │
│  This creates duplicate sale records and double stock decrements. │
│                                                                    │
│  Mitigation until 2A is deployed:                                 │
│  - Advise cashiers to avoid offline mode                          │
│  - If offline sales occur, check for duplicates before EOD close  │
│  - Run: SELECT sale_number, COUNT(*) FROM sales                   │
│          GROUP BY sale_number HAVING COUNT(*) > 1                 │
│         to detect any that slipped through                        │
└────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 14: WHAT IS SAFE TODAY (POST PHASE 1)

| Feature | Status |
|---|---|
| Online sale creation | ✅ SAFE — atomic, idempotent (no retry needed) |
| Stock protection (concurrent cashiers) | ✅ SAFE — `decrement_stock` RPC |
| Sale record atomicity | ✅ SAFE — `create_sale_atomic` rollback proven |
| Response shape (saleId, saleNumber, totalAmount) | ✅ SAFE — fixed in Phase 1 |
| Offline sale drafts | ⚠ UNSAFE — duplicate risk until 2A |
| Offline sale sync | ⚠ UNSAFE — no idempotency, no conflict handling |
| Stock during offline window | ⚠ ESTIMATED ONLY — not authoritative |
| Manager visibility of unsynced sales | ❌ NOT BUILT |

---

*Design complete. No code changes made.*
*Phase 2A (idempotency) is the prerequisite for all other Phase 2 work.*
*Offline mode should not be relied upon in production until Phase 2A ships.*
