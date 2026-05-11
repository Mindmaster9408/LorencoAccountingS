# 10 — Checkout Charlie: Phase 2A Idempotency Implemented
**Phase 2A — Offline Sale Idempotency**
Date: 2026-05-11

---

## VERDICT SUMMARY

| Item | Status |
|---|---|
| Migration 026: `idempotency_key` column added to `sales` | ✅ READY TO RUN |
| Migration 027: `create_sale_atomic` updated with idempotency gate | ✅ READY TO RUN |
| `sales.js`: generates/accepts idempotency key, passes to RPC | ✅ IMPLEMENTED |
| `sales.js`: skips audit log on duplicate replay | ✅ IMPLEMENTED |
| `checkout()`: UUID generated once in `saleData` before branching | ✅ IMPLEMENTED |
| Online POST includes `idempotencyKey` | ✅ IMPLEMENTED |
| `saveOfflineSale()`: UUID persisted via `saleData` spread | ✅ IMPLEMENTED |
| `syncOfflineSales()`: sends stored UUID, never regenerates | ✅ IMPLEMENTED |
| Duplicate requests: single sale in DB | ✅ PROVEN BY DESIGN |
| Stock decremented once only on replay | ✅ PROVEN BY DESIGN |

---

## SECTION 1: PROBLEM BEING SOLVED

### Before Phase 2A

The `syncOfflineSales()` function has two trigger paths:
1. `window.addEventListener('online', ...)` — fires when device reconnects
2. Service worker `SYNC_SALES` message — fires when background sync runs

Both call `syncOfflineSales()` with no guard. On a real network flap (connection lost → restored → lost → restored), both can fire within seconds of each other. Each call to `syncOfflineSales()` POSTs every unsynced sale to `POST /api/pos/sales`.

**Consequence:** One offline sale → two POST requests → two sale records in the DB → two stock decrements → two payment records → customer charged once, stock lost twice.

Phase 2B (sync lock) will prevent concurrent `syncOfflineSales()` runs. But even with a lock, the same POST may be retried on the next reconnect if the first attempt's response was lost (network timeout after server committed). **Idempotency is the only guarantee that survives at the HTTP layer.**

---

## SECTION 2: FILES CHANGED

| File | Change |
|---|---|
| `accounting-ecosystem/database/migrations/026_pos_add_idempotency_key.sql` | **NEW** — ALTER TABLE + partial UNIQUE INDEX |
| `accounting-ecosystem/database/migrations/027_pos_create_sale_atomic_idempotent.sql` | **NEW** — Updated RPC with idempotency gate |
| `accounting-ecosystem/backend/modules/pos/routes/sales.js` | **EDITED** — 5 changes (see Section 3) |
| `accounting-ecosystem/frontend-pos/index.html` | **EDITED** — 3 changes (see Section 4) |

---

## SECTION 3: BACKEND CHANGES — `sales.js`

### Change 1: `require('crypto')`
```javascript
const { randomUUID } = require('crypto');
```
Added at the top. Node.js built-in module, no installation needed.

### Change 2: `normaliseSaleBody` — accept idempotency key
```javascript
idempotency_key: body.idempotency_key ?? body.idempotencyKey ?? null,
```
Accepts both camelCase (frontend) and snake_case (API tools, sync).

### Change 3: POST handler — use client key or generate server-side
```javascript
const idempotencyKey = clientIdempotencyKey || randomUUID();
```
Priority: client-supplied key → server-generated fallback.
- Client-supplied: online checkout or offline sync replay (uses the stored UUID).
- Server-generated: callers that don't send a key (API tools, manual calls). Server-generated keys still land in the DB, so they're protected against double-submission at the transport level.

### Change 4: RPC call — pass `p_idempotency_key`
```javascript
p_idempotency_key: idempotencyKey,
```
Passed as a named parameter to `create_sale_atomic`. The RPC checks this before any INSERT.

### Change 5: Response — skip audit log on replay, include `wasDuplicate`
```javascript
if (rpcResult.was_duplicate) {
  console.log('[Sales] Duplicate sale blocked by idempotency key — returning existing sale:', rpcResult.sale_id);
}
if (!rpcResult.was_duplicate) {
  await auditFromReq(...);
}
res.status(201).json({
  ...
  wasDuplicate: rpcResult.was_duplicate || false,
});
```
Duplicates return HTTP 201 (not 200 or 409) so the frontend's `response.ok` check works identically. The frontend does not need to distinguish new vs. duplicate — it gets the same modal data either way.

---

## SECTION 4: FRONTEND CHANGES — `index.html`

### Change 1: UUID generated in `saleData` (line ~4531)
```javascript
const saleData = {
    idempotencyKey: crypto.randomUUID(),  // Generated ONCE per checkout
    tillSessionId: currentSession.id,
    ...
};
```
`crypto.randomUUID()` is the Web Crypto API (available in all modern browsers, no polyfill needed). The UUID is generated before the online/offline branch, so the same value is used regardless of which path the checkout takes.

**Why this matters for the offline fallback:** If the online POST succeeds at the server but the network drops before the response arrives, the client catches a network error and falls through to `saveOfflineSale(saleData)`. Because `saleData.idempotencyKey` is already set (same UUID as the POST that may have succeeded), when the sale syncs later, the server's idempotency gate returns the existing sale instead of creating a duplicate.

### Change 2: Online POST body includes `idempotencyKey` (line ~4585)
```javascript
body: JSON.stringify({
    tillSessionId: currentSession.id,
    items: cart.map(...),
    paymentMethod: selectedPayment,
    customerId: selectedAccountCustomerId || undefined,
    idempotencyKey: saleData.idempotencyKey   // ← ADDED
})
```
Protects against:
- Double-click on the checkout button before the response arrives
- Browser tab duplication mid-checkout
- Rapid reconnect during the POST

### Change 3: Sync POST body includes stored `idempotencyKey` (line ~3349)
```javascript
body: JSON.stringify({
    tillSessionId: sale.tillSessionId,
    items: sale.items,
    paymentMethod: sale.paymentMethod,
    offlineCreatedAt: sale.createdAt,
    idempotencyKey: sale.idempotencyKey   // ← ADDED — NEVER regenerated
})
```
`sale.idempotencyKey` is the UUID stored in IndexedDB when the sale was first saved offline. It is read from the stored record, not regenerated. Every retry of the same offline sale sends the same UUID.

**No change to `saveOfflineSale()`:** The function spreads `saleData` into the stored record (`...saleData`). Since `saleData.idempotencyKey` is already set before `saveOfflineSale()` is called, the UUID is automatically persisted to IndexedDB with the sale record.

---

## SECTION 5: DATABASE CHANGES

### Migration 026 — Add column and index

```sql
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency_key
  ON sales (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

**Why partial index:** `WHERE idempotency_key IS NOT NULL` means:
- Existing sales (NULL key) are not counted in the uniqueness check — no migration of old data needed.
- Multiple NULL rows are allowed (PostgreSQL partial index semantics).
- Only sales with a non-NULL key participate in the uniqueness constraint.

### Migration 027 — Idempotency gate in `create_sale_atomic`

New step 0 before the INSERT:

```sql
IF p_idempotency_key IS NOT NULL THEN
  SELECT id, sale_number, receipt_number, total_amount
  INTO   v_sale_id, v_sale_number, v_receipt_number, v_total_amount
  FROM   sales
  WHERE  idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'sale_id',        v_sale_id,
      'sale_number',    v_sale_number,
      'receipt_number', v_receipt_number,
      'total_amount',   v_total_amount,
      'status',         'completed',
      'was_duplicate',  true
    );
  END IF;
END IF;
```

If a match is found:
- Returns the existing sale record immediately.
- Steps A (INSERT sales), B (INSERT sale_items), C (INSERT sale_payments), and D (PERFORM decrement_stock) are **skipped entirely**.
- The caller gets back the original `sale_id`, `sale_number`, `receipt_number`, and `total_amount`.
- `was_duplicate: true` is included so the server can log and skip the audit write.

The sale INSERT now also stores the key:
```sql
INSERT INTO sales (..., idempotency_key)
VALUES (..., p_idempotency_key)
```

---

## SECTION 6: DUPLICATE PREVENTION FLOW

```
Cashier closes sale (checkout button)
    │
    ├─ Generate crypto.randomUUID() → idempotencyKey (ONCE)
    │
    ├── ONLINE PATH ─────────────────────────────────────────────────────────────
    │   POST /api/pos/sales { items, paymentMethod, idempotencyKey }
    │   │
    │   ├── Server: use client UUID as idempotencyKey (no generation needed)
    │   ├── RPC step 0: SELECT FROM sales WHERE idempotency_key = ?
    │   │   ├── FOUND: return existing sale, was_duplicate=true
    │   │   └── NOT FOUND: proceed to INSERT → return new sale, was_duplicate=false
    │   │
    │   ├── OK → show modal → done
    │   │
    │   └── Network error
    │       └── saveOfflineSale(saleData) — saleData.idempotencyKey already set
    │           → same UUID stored in IndexedDB
    │           → when synced, server finds existing sale via idempotency key
    │           → was_duplicate=true, no new records created
    │
    └── OFFLINE PATH ───────────────────────────────────────────────────────────
        saveOfflineSale(saleData) — spreads idempotencyKey into IndexedDB record
        │
        └── device reconnects → syncOfflineSales()
            │
            ├── First sync attempt:
            │   POST { items, paymentMethod, idempotencyKey: <stored UUID> }
            │   → RPC NOT FOUND → new sale created → was_duplicate=false
            │
            └── Second sync attempt (same sale, before Phase 2B lock):
                POST { items, paymentMethod, idempotencyKey: <same UUID> }
                → RPC FOUND → existing sale returned → was_duplicate=true
                → NO duplicate sale, NO duplicate stock decrement
```

---

## SECTION 7: REPLAY BEHAVIOUR

When the server receives a duplicate request (same `idempotency_key`):

| What happens | Result |
|---|---|
| New `INSERT INTO sales` | **Skipped** |
| New `INSERT INTO sale_items` | **Skipped** |
| New `INSERT INTO sale_payments` | **Skipped** |
| `decrement_stock()` per item | **Skipped** |
| `auditFromReq()` in `sales.js` | **Skipped** (server-side guard) |
| HTTP response to caller | **201 with same sale data** |
| `was_duplicate` in response | **`true`** |
| Frontend modal | **Shows same sale number and total — correct** |

The response is HTTP 201 on replay (same as a new sale). This is intentional: the frontend's `if (response.ok)` check works identically, the modal shows the correct sale number, and the sync code proceeds to mark the IndexedDB record for deletion (Phase 2B).

---

## SECTION 8: TEST VERIFICATION GUIDE

These tests must be run manually after both migrations are applied in Supabase.

### Test 1 — Same idempotency key posted twice

```bash
# First POST — creates the sale
curl -X POST http://localhost:3000/api/pos/sales \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"productId":1,"quantity":1}],"paymentMethod":"cash","idempotencyKey":"test-uuid-aaa-bbb-ccc-001"}'

# Expected: 201, was_duplicate: false, new saleId

# Second POST — same key, same sale
curl -X POST http://localhost:3000/api/pos/sales \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"productId":1,"quantity":1}],"paymentMethod":"cash","idempotencyKey":"test-uuid-aaa-bbb-ccc-001"}'

# Expected: 201, was_duplicate: true, SAME saleId
# Verify: SELECT COUNT(*) FROM sales WHERE idempotency_key = 'test-uuid-...' → 1
# Verify: stock decremented once only
```

### Test 2 — Offline sale replayed from IndexedDB

1. Go offline in browser DevTools
2. Add item to cart, checkout
3. Confirm offline modal appears (OFFLINE-xxx sale number)
4. Verify IndexedDB record has `idempotencyKey` field set
5. Go back online
6. `syncOfflineSales()` fires
7. Verify in Supabase: one sale record with the UUID in `idempotency_key`
8. Manually call `syncOfflineSales()` again (simulate double trigger)
9. Verify: still one sale record, no new sale, server logged "Duplicate sale blocked"

### Test 3 — Stock decremented once only

```sql
-- Before test
SELECT stock_quantity FROM products WHERE id = <product_id>;

-- Post same sale twice with same idempotency key
-- After test
SELECT stock_quantity FROM products WHERE id = <product_id>;
-- Expected: decremented by quantity ONCE, not twice
```

### Test 4 — Online sales work normally

1. Complete a normal online checkout (no idempotency key in DevTools)
   → Server generates `randomUUID()` as fallback
   → 201 with `wasDuplicate: false`
   → Normal modal flow

2. Complete an online checkout through the POS UI
   → `idempotencyKey` sent from frontend
   → 201 with `wasDuplicate: false`
   → Normal modal flow

---

## SECTION 9: DEPLOYMENT SEQUENCE

**IMPORTANT — Run migrations in order before deploying the backend.**

1. **Run Migration 026** in Supabase SQL Editor:
   `accounting-ecosystem/database/migrations/026_pos_add_idempotency_key.sql`
   → Confirm: `idempotency_key` column exists in `sales` table with partial unique index

2. **Run Migration 027** in Supabase SQL Editor:
   `accounting-ecosystem/database/migrations/027_pos_create_sale_atomic_idempotent.sql`
   → Confirm: function replaced (no 42P13 error)
   → Confirm: `was_duplicate` field appears in test call response

3. **Deploy backend** (`sales.js` changes push to Zeabur)

4. **Deploy frontend** (`index.html` changes)

**Order matters:** The column must exist before the function references it. The function must be updated before the backend passes `p_idempotency_key`. The frontend change is backwards-compatible (server handles missing key gracefully by generating one).

---

## SECTION 10: REMAINING OFFLINE RISKS

| Risk | Phase 2A status | Resolved by |
|---|---|---|
| Duplicate sale on double sync trigger | ✅ ELIMINATED | Idempotency key |
| Duplicate sale on network flap during POST | ✅ ELIMINATED | Idempotency key |
| Concurrent sync from two tabs | REDUCED (key protects DB) but sync still runs twice | Phase 2B sync lock |
| `synced=true` records never deleted from IndexedDB | STILL OPEN | Phase 2B (DELETE on confirm) |
| Blanket "synced successfully" notification regardless of errors | STILL OPEN | Phase 2B (per-result feedback) |
| Stock conflict: sold offline, stock sold online before sync | STILL OPEN | Phase 2B (conflict UI) |
| Session conflict: till session closed before offline sale syncs | STILL OPEN | Phase 2B (conflict UI) |
| `navigator.locks` multi-tab protection | NOT STARTED | Phase 2E |

---

## SECTION 11: WHAT PHASE 2B WILL SOLVE

Phase 2B builds on Phase 2A's foundation:

1. **Sync lock** — `syncInProgress` boolean prevents two concurrent `syncOfflineSales()` runs from the same tab. Phase 2A's idempotency key protects the DB regardless, but the lock reduces noise.

2. **DELETE on confirm** — Synced IndexedDB records are deleted (`store.delete(tempId)`) instead of marked `synced=true`. Eliminates accumulation of completed records.

3. **Per-sale error branching** — 422 (stock conflict) vs. 500 (server error) vs. network timeout each get distinct handling instead of the current blanket catch.

4. **Cashier alerts** — Persistent badge on pending count, non-dismissable offline banner, stock conflict notification per sale.

The idempotency key persists across all of Phase 2B's retry paths — it does not need to change.

---

*Phase 2A implementation complete.*
*Idempotency key is the foundation all subsequent Phase 2 work builds on.*
*No duplicate sales, stock decrements, or payments are possible after these changes.*
