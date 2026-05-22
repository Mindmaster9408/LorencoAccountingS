# 45 — SPLIT PAYMENT CHECKOUT VERIFIED
## Checkout Charlie — Workstream 13A Verification

**Date:** 2026-05-22
**Status:** ✅ VERIFIED — 16/16 PASS — 0 blocking bugs found
**Scope:** Full static audit of Workstream 13A split payment fix
**Verifier:** Code audit pass against implementation — all changed files + RPC migration

---

## Verification Method

Full static audit of:
- `frontend-pos/index.html` — checkout button wiring, `checkoutWithFeatures()`, `checkout()`, `showSaleCompleteModal()`, cart shape, `toggleSplitPayment()`, module-level flags
- `backend/modules/pos/routes/sales.js` — `normaliseSaleBody()`, `POST /` handler, RPC call, response shape
- `backend/modules/pos/routes/reports.js` — `sales-summary` payment breakdown query and aggregation
- `database/migrations/027_pos_create_sale_atomic_idempotent.sql` — `sale_payments` insert loop, `decrement_stock` call

---

## Test Results

| # | Test | Result | Evidence |
|---|---|---|---|
| T1 | Checkout button correctly reaches split payment flow | ✅ PASS | Line 1735: `onclick="checkoutWithFeatures()"` confirmed |
| T2 | Split payment posts to `POST /api/pos/sales`, not `/split-payment` | ✅ PASS | Line 8619: `fetch(\`${API_URL}/pos/sales\`, ...)` confirmed |
| T3 | Payload includes `payments` array | ✅ PASS | Lines 8576–8611: array built from `.split-amount` inputs and included in body |
| T4 | `idempotencyKey` included and replay-safe | ✅ PASS | Line 8601: `crypto.randomUUID()` — normalised by backend, passed to RPC |
| T5 | `checkoutInProgress` guard applies to split path | ✅ PASS | Line 8545: guard before split/non-split branch; `= true` at 8613; reset in `finally` at 8667 |
| T6 | `forceUpdatePending` guard applies to split path | ✅ PASS | Lines 8546–8549: guard confirmed |
| T7 | `tillLocked` guard applies to split path | ✅ PASS | Lines 8550–8553: guard confirmed |
| T8 | `sale_payments` rows created correctly (one per payment method) | ✅ PASS | Migration 027 lines 163–177: `FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP INSERT INTO sale_payments(...)` |
| T9 | Stock decrements once (not once per payment) | ✅ PASS | `decrement_stock_v2` in RPC called once per item in `p_items`, not per payment; in-memory decrement also once per cart item |
| T10 | Receipt modal shows correct `saleId`, `saleNumber`, `totalAmount` | ✅ PASS | Server returns `saleId`, `saleNumber`, `totalAmount` (sales.js 400–403); modal reads these at lines 5545–5546, 5555 |
| T11 | Drawer opens only when cash amount > 0 | ✅ PASS | Line 8658: `payments.some(p => p.method === 'CASH' && p.amount > 0)` — uses captured JS array, not re-read from DOM |
| T12 | Drawer stays closed for card/EFT-only split | ✅ PASS | `hasCash = false` → `openDrawer: false` passed to `printReceipt()` |
| T13 | `sales-summary` payment breakdown uses `sale_payments` | ✅ PASS | reports.js line 32: `sale_payments(payment_method, amount)` join; lines 46–57: iterate rows and aggregate |
| T14 | Single-method checkout unaffected | ✅ PASS | Lines 8566–8570: `if (!splitPaymentMode) { checkout(); return; }` — delegates to `checkout()` unchanged |
| T15 | `checkout()` guard chain and `finally` block intact | ✅ PASS | `checkout()` at lines 5340–5497 unchanged — `checkoutInProgress`, `forceUpdatePending`, `tillLocked`, offline branch, `finally` all present |
| T16 | No localStorage/sessionStorage business data | ✅ PASS | `idempotencyKey` and `payments` are local JS variables — no storage writes in any changed code |

---

## Detailed Trace — Split Payment Flow

### Step 1: Button click

```
checkoutBtn onclick="checkoutWithFeatures()"  (index.html:1735)
```

Was `onclick="checkout()"` — now correctly routes through `checkoutWithFeatures()`.

---

### Step 2: Guard chain in `checkoutWithFeatures()`

```javascript
if (checkoutInProgress) return;                     // line 8545
if (forceUpdatePending) { ... return; }             // line 8546
if (tillLocked) { ... return; }                     // line 8550
if (cart.length === 0 || !currentSession) { ... }   // line 8554
if (selectedPayment === 'ACCOUNT' && !splitPaymentMode && ...) // line 8561
    // skipped for split mode since !splitPaymentMode is false
```

All guards confirmed present and in correct order.

---

### Step 3: Payload construction

```javascript
const idempotencyKey = crypto.randomUUID();   // line 8601 — new per attempt

const payload = {
    tillSessionId: currentSession.id,          // UUID of open session
    items: cart.map(item => ({
        productId: item.productId,             // matches products[].id — confirmed via cart.push at line 5144
        quantity:  item.quantity
    })),
    payments: [                                // non-zero rows from split panel
        { method: 'CASH', amount: 75.00 },    // data-method attribute from HTML
        { method: 'CARD', amount: 50.00 }
    ],
    idempotencyKey                             // camelCase — normalised by backend
};
```

---

### Step 4: Network call

```javascript
fetch(`${API_URL}/pos/sales`, { method: 'POST', ... })  // line 8619
```

Backend `normaliseSaleBody()` (sales.js:42–59) maps:

| Frontend field | Backend field | Notes |
|---|---|---|
| `tillSessionId` | `till_session_id` | camelCase → snake_case |
| `payments[].method` | `payment_method` via `p.payment_method \|\| p.method` | line 273 — handles both keys |
| `idempotencyKey` | `idempotency_key` | line 55 |

Since `paymentMethod` is not in the split payload, `payment_method` defaults to `'cash'` in `normaliseSaleBody` (line 52). This is used for `sales.payment_method` column (legacy single-method column). The actual per-method amounts are in `sale_payments` — see note below.

---

### Step 5: Backend validation

```javascript
// Split payment total validation (sales.js:255–264)
const paymentsTotal = paymentsFromBody.reduce((s, p) => s + p.amount, 0);
if (paymentsTotal < total_amount - 0.01) {
    return res.status(400).json({ error: 'Payment total is less than the sale total' });
}
```

Two-layer validation:
- Frontend: `Math.abs(allocated - total) > 0.01` (line 8596) — same formula as `updateSplitRemaining()`
- Backend: `paymentsTotal < total_amount - 0.01` — enforced against DB-computed price

The frontend total uses `subtotal * 1.15` (BUG-2 — additive VAT, Workstream 13C). The backend computes `total_amount` from DB prices with VAT-inclusive extraction. For VAT-inclusive priced goods, these produce different totals — the cashier enters split amounts against the frontend display total, which is inflated. The backend then validates against the correct server total. This mismatch means a split payment could be entered correctly in the UI but fail the backend validation.

**This is the second operational impact of BUG-2 for split payments** — in addition to the receipt display being wrong (Workstream 43 section 2), the split amount entry UI shows the wrong total, so cashiers could distribute amounts that pass the frontend check but fail the backend check. Workstream 13C must fix both the receipt display AND the split total validation formula.

---

### Step 6: Atomic sale creation

```sql
-- Migration 027, executed as one plpgsql transaction:
-- A. INSERT into sales (with idempotency gate at step 0)
-- B. FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP INSERT INTO sale_items ...
-- C. FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP INSERT INTO sale_payments ...
-- D. FOR v_item IN ... LOOP PERFORM decrement_stock_v2(...)
```

Payment rows: one `INSERT INTO sale_payments` per element in `p_payments`. A cash+card split creates exactly two rows. Stock decrements once per item — not per payment. ✅

---

### Step 7: Response handling

Server response (sales.js:388–404):
```json
{
    "saleId":       "<uuid>",
    "saleNumber":   "SAL-<ts>-<rand>",
    "totalAmount":  125.00,
    "wasDuplicate": false
}
```

`showSaleCompleteModal(result)` reads:
- `result.saleNumber` → `#SAL-...` header (line 5545) ✅
- `result.totalAmount` → `R 125.00` amount (line 5546) ✅
- `result.saleId` → Print/Email/SMS/WhatsApp buttons (lines 5555, 5563–5565, 5570) ✅

---

### Step 8: Post-success cleanup

```javascript
lastSaleId = result.saleId;                 // for reprint
const soldItems = cart.map(...);            // snapshot BEFORE cart clear
showSaleCompleteModal(result);
cart = [];
updateCart();
toggleSplitPayment();                       // closes panel, resets DOM input values to 0
                                            // (does NOT affect soldItems or payments JS arrays)

// In-memory stock decrement (display-only)
for (const sold of soldItems) { ... }
displayProductsGrid(products);
displayProductsTable(products);
rebuildBarcodeMap();

// Drawer + print
const hasCash = payments.some(p => p.method === 'CASH' && p.amount > 0);
printReceipt(lastSaleId, { openDrawer: openDrawerOnSale && hasCash });
```

Key sequencing confirmed:
- `soldItems` captured before `cart = []` → stock decrement uses correct quantities ✅
- `payments` is the local JS array captured before `toggleSplitPayment()` resets DOM input values to `'0'` → `hasCash` check is correct ✅
- `toggleSplitPayment()` sets `splitPaymentMode = false` → `finally` block button state: `cart.length === 0` is true → button stays disabled until items are added ✅

---

### Step 9: `finally` block

```javascript
} finally {
    checkoutInProgress = false;               // always reset
    btn.textContent = 'Complete Sale';         // always restored
    btn.disabled = cart.length === 0 || !currentSession;  // based on actual state
}
```

Confirmed: runs on success, error, and caught exceptions. ✅

---

### Step 10: Report verification

`GET /api/reports/sales-summary` query (reports.js:30–35):
```javascript
.select('total_amount, vat_amount, discount_amount, status, created_at,
         payment_method, sale_payments(payment_method, amount)')
```

PostgREST embedded resource: `sale_payments` has `sale_id FK → sales.id`. This join is already used by `GET /api/pos/sales` (sales.js:73) and `GET /api/pos/sales/:id` (sales.js:103–104) — confirmed working pattern. ✅

Aggregation logic:
- For each completed sale: if `sale_payments` rows exist → iterate rows and accumulate per method
- Fallback (no rows — legacy data only): use `sales.payment_method` + `total_amount`
- Methods are uppercased for consistency: `CASH`, `CARD`, `EFT`, `SNAPSCAN`
- Response shape `[{ method, amount }]` unchanged ✅

**Example — R75 cash + R50 card split sale (correct after fix):**

| Method | Amount |
|---|---|
| CASH | 75.00 |
| CARD | 50.00 |

**Example — same sale before fix (wrong):**

| Method | Amount |
|---|---|
| cash | 125.00 |

---

## Bugs Found

**None blocking.**

---

## Known Gaps (Non-blocking, Pre-existing)

### GAP-1: Sale complete modal shows stale `selectedPayment` for split sales

**Location:** `showSaleCompleteModal()` line 5547: `<div>${selectedPayment}</div>`

`selectedPayment` is the module-level payment method variable. When split mode is toggled on, `selectPayment()` is not called — `selectedPayment` retains its previous value (e.g., `"CASH"` or `"CARD"` from the last single-method selection). A split payment modal will show that stale value instead of something like "SPLIT PAYMENT".

**Impact:** Cosmetic only. The sale number and total amount are correct. The payment method label is inaccurate. Cashiers are unlikely to care or notice (they watched the cashier enter the amounts). Not a data integrity issue.

**Introduced by 13A?** No — the original `checkoutWithFeatures()` also passed `result` to `showSaleCompleteModal` which used `selectedPayment`. 13A preserved this behavior.

**Fix:** Change line 5547 to: `${splitPaymentMode ? 'SPLIT PAYMENT' : selectedPayment}`. Single-line change, appropriate for Workstream 13C or separately.

---

### GAP-2: `sales.payment_method` column stores `'cash'` for split sales

**Location:** `normaliseSaleBody()` line 52: `payment_method: body.payment_method ?? body.paymentMethod ?? 'cash'`

The split payment payload does not send `paymentMethod`, so `payment_method` defaults to `'cash'`. The `sales.payment_method` column on every split sale records `'cash'` regardless of actual payment mix.

**Impact:** The `sales-summary` report is now correct (uses `sale_payments` rows). However, anyone querying `sales.payment_method` directly will see misleading data for split sales. This is an architectural limitation of having a single-method column on a table that now supports multi-method payments.

**Introduced by 13A?** No — the column was always single-method. 13A made the report accurate by reading `sale_payments` instead. The column itself is unchanged.

**Fix options:** (a) Send `paymentMethod: 'SPLIT'` from the frontend for split payments — backend uses it only for `p_payment_method` in the RPC. (b) Leave the column as `'cash'` and treat it as deprecated for multi-method sales. Option (a) is a 1-line frontend change.

---

### GAP-3: BUG-2 affects split payment total validation (new consequence identified in this audit)

**Location:** `checkoutWithFeatures()` line 8593: `const total = cart.reduce(...) * 1.15`

The frontend validates that split amounts sum to `subtotal * 1.15` (additive VAT). The backend validates that split amounts sum to the DB-computed `total_amount` (VAT-inclusive extraction). For VAT-inclusive pricing, these are different values:

- R100 product: frontend total = R115.00, server total = R100.00
- Cashier enters Cash: R75, Card: R40 (sums to R115 → passes frontend validation)
- Backend receives: Cash: R75, Card: R40 = R115 total; server total = R100
- Backend validation: `115 < 100 - 0.01` → false → passes (over-payment is accepted ✅)

So over-payment is silently accepted. The amounts stored in `sale_payments` will be R75 cash + R40 card = R115 for a R100 sale. The `sales.total_amount` is R100 (correct). The `sale_payments` total will not match `total_amount` — which will trigger the recon consistency check `PAYMENT_TOTAL_MISMATCH` in `posReconService.js`.

**This means split payments during BUG-2 conditions will produce recon anomalies.**

**Severity:** Medium. Not a data loss issue, but will produce `is_consistent = false` recon snapshots and require manager investigation. Cashiers using split payment should be briefed not to split until BUG-2 is fixed.

**Introduced by 13A?** No — this is a consequence of pre-existing BUG-2. 13A made split payments reachable; BUG-2 was always there. The recon check will catch the anomaly.

**Fix:** Workstream 13C must fix both the receipt display AND the `updateSplitRemaining()` / split validation formula.

---

## Architecture Boundaries Confirmed Preserved

| Boundary | Status |
|---|---|
| `create_sale_atomic` unchanged | ✅ RPC untouched — accepts `p_payments` array, inserts one `sale_payments` row per element |
| `checkout()` function unchanged | ✅ Single-method path identical to pre-13A |
| No new backend endpoint | ✅ `POST /api/pos/sales` handles both single and split |
| Idempotency at DB level | ✅ `idempotency_key` unique index on `sales` — split payments now carry a client-generated key |
| Audit trail intact | ✅ `SALE_CREATED` fires for split sales via same path as single-method |
| Company isolation | ✅ `req.companyId` filter unchanged on all queries |
| No business data in browser storage | ✅ `idempotencyKey` and `payments` are local JS variables only |
| Paytime module | ✅ Not touched |
| Zeabur deployment rules | ✅ Not affected |

---

## Workstream 13A Verification Verdict

**16/16 tests PASS. 0 blocking bugs found.**

Split payment checkout is now operational. The three non-blocking gaps are:
1. Cosmetic modal label (pre-existing, 1-line fix)
2. `sales.payment_method` column stores `'cash'` for splits (architectural, report is correct)
3. BUG-2 causes split payment amounts to mismatch server total → recon `is_consistent = false` (pre-existing BUG-2 consequence — fix is Workstream 13C)

**Recommendation:** Brief operations staff that split payments work but should not be used heavily until Workstream 13C (offline VAT fix) is deployed. Single-method cash and card operations are unaffected.

**Workstream 13A is verified pilot-safe for stores using single-method payments. Split payments are functional but interact with the known BUG-2 VAT calculation issue until 13C is deployed.**
