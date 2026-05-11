# 08 — Checkout Charlie: POS UI Smoke Test
**Phase 1, Step 3C End-to-End Verification**
Date: 2026-05-11

---

## VERDICT SUMMARY

| Check | Result |
|---|---|
| Product loads via API | ✅ PASS |
| Sale completes (HTTP 201) | ✅ PASS |
| `saleId` in response (not undefined) | ✅ PASS |
| `saleNumber` in response (not undefined) | ✅ PASS |
| `totalAmount` in response (not NaN) | ✅ PASS |
| Stock decremented correctly | ✅ PASS |
| `sale_items` record created | ✅ PASS |
| `sale_payments` record created | ✅ PASS |
| Insufficient stock → 422, no orphan | ✅ PASS |
| `localStorage` business data written | ✅ PASS (none written) |
| `sessionStorage` business data written | ✅ PASS (none written) |
| Bug found during test | ✅ FOUND + FIXED (`JSON.stringify` on JSONB params) |
| Test data cleaned up from database | ✅ DONE |

---

## SECTION 1: TEST ENVIRONMENT

| Item | Value |
|---|---|
| Server | Local (`http://localhost:3000`) |
| Test method | API calls (Node.js server → Supabase) |
| User | ruanvlog@lorenco.co.za (company_id: 1) |
| Test product | SMOKE-TEST-PRODUCT — R100.00, 15% VAT, 5 units |
| Test product ID | 1 (created for this test, deleted after) |
| Test sale ID | 4 (created, verified, deleted after) |

---

## SECTION 2: BUG FOUND AND FIXED — `JSON.stringify` on JSONB Parameters

**Before the sale could be tested, a bug was discovered:**

The first sale attempt returned:
```json
{ "error": "Sale creation failed", "details": "cannot extract elements from a scalar" }
```

**Root cause:** `sales.js` passed `p_items` and `p_payments` to `supabase.rpc()` wrapped in `JSON.stringify(...)`. The Supabase JS client serializes the entire RPC body to JSON automatically. Wrapping an array in `JSON.stringify` first turns it into a JSON string like `"[{...}]"`. The Supabase client then serializes that as a JSON string value in the body. PostgreSQL receives `p_items` as a JSONB text scalar instead of a JSONB array. `jsonb_array_elements(scalar)` throws "cannot extract elements from a scalar."

**Fix applied** (`accounting-ecosystem/backend/modules/pos/routes/sales.js`):

```javascript
// BEFORE (broken):
p_items:    JSON.stringify(enrichedItems.map(item => ({ ... }))),
p_payments: JSON.stringify(payments),

// AFTER (correct):
p_items:    enrichedItems.map(item => ({ ... })),
p_payments: payments,
```

The Supabase JS client serializes arrays to JSON correctly without manual pre-serialization.

**This was the only code change made during the smoke test.**

---

## SECTION 3: NORMAL SALE — FULL RESULTS

### Pre-sale state
```
Product: SMOKE-TEST-PRODUCT
Price:   R100.00 (VAT inclusive, 15%)
Stock:   5 units
```

### Sale request (what the POS frontend sends)
```json
POST /api/pos/sales
{
  "items":         [{ "productId": 1, "quantity": 2 }],
  "paymentMethod": "cash"
}
```

### Response (HTTP 201)
```json
{
  "sale": {
    "id":              4,
    "sale_number":     "SAL-1778484203283-SEV8",
    "receipt_number":  "RC-1778484203283-SEV8",
    "total_amount":    200,
    "subtotal":        200,
    "vat_amount":      26.0869565217391,
    "discount_amount": 0,
    "payment_method":  "cash",
    "status":          "completed"
  },
  "saleId":      4,
  "saleNumber":  "SAL-1778484203283-SEV8",
  "totalAmount": 200
}
```

### Response field verification (what the frontend modal reads)

| Frontend read site | Field expected | Value received | Result |
|---|---|---|---|
| `lastSaleId = result.saleId` | `result.saleId` | `4` | ✅ |
| Modal `#${sale.saleNumber}` | `result.saleNumber` | `SAL-1778484203283-SEV8` | ✅ |
| Modal `R ${sale.totalAmount.toFixed(2)}` | `result.totalAmount` | `200` | ✅ |
| `deliverReceipt(${sale.saleId}, ...)` | `result.saleId` | `4` | ✅ |

The `#undefined` and `R NaN` bug is confirmed fixed.

---

## SECTION 4: DATABASE VERIFICATION

### Stock decrement
```
Before sale: stock_quantity = 5
After sale:  stock_quantity = 3  (sold 2 units)
Expected:    3
Result:      ✅ CORRECT
```

### sale_items record (Supabase query)
```
product_id: 1
quantity:   2
unit_price: 100
line_total: 200
total_price: 200   ← both columns populated (schema has both)
vat_rate:   15
```
Result: ✅ All columns present and correct

### sale_payments record (Supabase query)
```
payment_method: cash
amount:         200
reference:      (null)
```
Result: ✅ Correct

### sales record (Supabase query)
```
id:           4
sale_number:  SAL-1778484203283-SEV8
total_amount: 200
status:       completed
company_id:   1
user_id:      1
```
Result: ✅ Correct

---

## SECTION 5: INSUFFICIENT STOCK TEST

### Setup
```
Stock before attempt: 3 (remaining after normal sale)
Quantity requested:   10
```

### Request
```json
POST /api/pos/sales
{ "items": [{ "productId": 1, "quantity": 10 }], "paymentMethod": "cash" }
```

### Response (HTTP 422)
```json
{
  "error":   "Stock check failed",
  "details": "Insufficient stock for \"SMOKE-TEST-PRODUCT\": have 3, need 10"
}
```

**Note:** This 422 came from the Node.js pre-check (stock pre-check loop before the RPC call) — the obvious case is caught before any transaction begins, giving the best UX. The RPC-level `decrement_stock` P0001 guard handles concurrent races that slip through the pre-check (already proven in `07_CREATE_SALE_ATOMIC_VERIFIED.md`).

### Post-attempt database verification
```
Stock: 3  (unchanged — expected 3)            ✅
Total sales records: 1  (only the good sale)  ✅
No "OFFLINE-*" or phantom sales present       ✅
```

**No orphan sale record created. Atomicity holds.**

---

## SECTION 6: LOCALSTORAGE / SESSIONSTORAGE AUDIT

**Code review of `accounting-ecosystem/frontend-pos/index.html`:**

### `localStorage.setItem` calls — exhaustive list

| Key | Value | Classification |
|---|---|---|
| `'token'` | JWT token | Auth token — permitted (CLAUDE.md Part D Rule D2) |
| `'isSuperAdmin'` | `'true'` | UI flag — permitted (UI preference) |

No business data (sales, products, stock, payments, totals, receipts, IDs) is written to `localStorage` during or after a sale.

### `sessionStorage.setItem` calls
None found in the POS frontend.

**Result: ✅ localStorage/sessionStorage clean for business data.**

---

## SECTION 7: OPEN RISK — IndexedDB OFFLINE QUEUE

The POS frontend maintains an offline sale queue using IndexedDB (`offlineSales` object store). This queue stores pending sale data (items, prices, quantities) when the network is unavailable.

**Classification:** IndexedDB is listed in CLAUDE.md Part D Rule D1 as a prohibited storage mechanism for business data.

**Status:** Pre-existing code — not introduced by the Checkout Charlie stabilization. Not a regression.

**Risk:** If a cashier creates sales while offline, those sales exist only in the browser's IndexedDB until synced. If the browser cache is cleared before sync, those sales are permanently lost with no server record.

**Scope:** Out of scope for Phase 1 stabilization. Tracked as an open risk. Requires a dedicated Phase 2+ decision on offline-first architecture (service worker with proper sync, or disable offline mode, or server-side queuing).

---

## SECTION 8: PHASE 1 COMPLETE — FINAL STATUS

| Phase 1 Item | Status |
|---|---|
| Step 1: `decrement_stock` RPC + fallback patch | ✅ COMPLETE |
| Step 2: Stock RPC verified (live Supabase test) | ✅ COMPLETE |
| Step 3A: Direct pg pool audit | ✅ COMPLETE |
| Step 3B: `create_sale_atomic` contract design | ✅ COMPLETE |
| Step 3C: `create_sale_atomic` implementation | ✅ COMPLETE |
| Step 3C: Atomicity verified (rollback test) | ✅ COMPLETE |
| Step 3C: End-to-end API smoke test | ✅ COMPLETE |
| Bug found + fixed: `JSON.stringify` on JSONB params | ✅ FIXED |

**Phase 1 is complete.**

---

## SECTION 9: REMAINING OPEN RISKS (PHASE 2+)

| Risk | Priority | Notes |
|---|---|---|
| Offline sale idempotency | HIGH | Multiple sync events can duplicate sales. No server-side idempotency key. |
| IndexedDB offline queue (Part D violation) | MEDIUM | Business data in browser storage — lost if cache cleared before sync |
| Void does not restore stock | LOW (policy) | Intentional — must be documented in POS UI |
| Return stock restoration non-atomic | LOW | Read-then-write pattern, concurrent returns very unlikely |

---

*Smoke test complete. One bug found and fixed (JSON.stringify on JSONB params).*
*Phase 1 stabilization is confirmed working end-to-end.*
*Test product and sale record cleaned up from database.*
