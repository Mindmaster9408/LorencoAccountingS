# 06 — Checkout Charlie: `create_sale_atomic` Implemented
**Phase 1, Step 3C — IMPLEMENTATION COMPLETE**
Date: 2026-05-10

---

## VERDICT SUMMARY

| Item | Status |
|---|---|
| SQL migration `025_pos_create_sale_atomic.sql` created | YES |
| `sales.js` patched — sequential Supabase calls replaced | YES |
| Pre-existing frontend response bug fixed | YES |
| All pre-RPC logic unchanged | YES |
| Auth, VAT, totals, payment validation unchanged | YES |
| Void, return, audit routes unchanged | YES |
| Migration run in Supabase yet? | PENDING — must be run manually |

---

## SECTION 1: FILES CHANGED

### 1.1 — New file: SQL migration

```
accounting-ecosystem/database/migrations/025_pos_create_sale_atomic.sql
```

Creates the `create_sale_atomic` PostgreSQL function in Supabase.

**Status: FILE CREATED. Must be run manually in Supabase SQL Editor.**

---

### 1.2 — Patched file: sales.js

```
accounting-ecosystem/backend/modules/pos/routes/sales.js
```

**Lines replaced:** The four sequential Supabase calls (INSERT sales, INSERT sale_items,
INSERT sale_payments, decrement_stock loop) — approximately lines 214–362 in the
pre-patch file — replaced with one RPC call, error handling, and updated response.

**Lines unchanged:** Everything else — auth middleware, body normalisation, product DB
lookup, stock pre-check, totals calculation, payment total validation, sale number
generation, void route, return route, till session routes, audit routes.

---

## SECTION 2: WHAT THE SQL FUNCTION DOES

`create_sale_atomic(...)` is a plpgsql function that executes in a single implicit
database transaction:

```
A. INSERT INTO sales        — creates the sale record
B. INSERT INTO sale_items   — one row per item (batch via jsonb_array_elements)
C. INSERT INTO sale_payments — one row per payment (batch via jsonb_array_elements)
D. PERFORM decrement_stock  — calls existing decrement_stock RPC per item
E. RETURN JSONB             — { sale_id, sale_number, receipt_number, total_amount, status }

On any RAISE EXCEPTION → entire function transaction rolls back → no orphaned records.
```

The function depends on `decrement_stock` (migration 024). It calls `PERFORM decrement_stock(product_id, quantity)` for each item. A P0001 from `decrement_stock` propagates through `create_sale_atomic` as an unhandled exception, rolling back all writes including the already-completed INSERTs in steps A–C.

---

## SECTION 3: WHAT CHANGED IN SALES.JS

### Before (four sequential Supabase calls)

```
Step 4: supabase.from('sales').insert(...)        → creates sale record
Step 5: supabase.from('sale_items').insert(...)   → creates items (error logged, not fatal)
Step 6: supabase.from('sale_payments').insert(...) → creates payments (error logged, not fatal)
Step 7: for loop: supabase.rpc('decrement_stock') → separate per-item calls
Step 8: res.status(201).json({ sale })            → returns { sale: { id, sale_number, ... } }
```

Problem: If step 7 raised P0001 (insufficient stock caught at write time), steps 4–6 had
already written. A sale record existed in the database with no corresponding stock change.

---

### After (one atomic RPC call)

```
Step 4: Build payments array (no sale_id needed — RPC handles it)
Step 5: supabase.rpc('create_sale_atomic', { ...all params, p_items, p_payments })
        → one call, one transaction, all or nothing
Step 6: auditFromReq() + res.status(201).json({ sale, saleId, saleNumber, totalAmount })
```

---

## SECTION 4: RESPONSE CONTRACT FIX

The pre-existing frontend response mismatch (discovered in Step 3B) is fixed.

### Old response shape

```json
{ "sale": { "id": 123, "sale_number": "SAL-...", "total_amount": 150.00, ... } }
```

The frontend read `result.saleId` (undefined), `result.saleNumber` (undefined),
`result.totalAmount` (undefined → TypeError on `.toFixed(2)`). Every sale modal
showed `#undefined` and `R NaN`.

### New response shape

```json
{
  "sale": {
    "id": 123,
    "sale_number": "SAL-...",
    "receipt_number": "RC-...",
    "total_amount": 150.00,
    "subtotal": 130.43,
    "vat_amount": 19.57,
    "discount_amount": 0,
    "payment_method": "cash",
    "status": "completed"
  },
  "saleId": 123,
  "saleNumber": "SAL-...",
  "totalAmount": 150.00
}
```

The top-level camelCase fields (`saleId`, `saleNumber`, `totalAmount`) are what the
frontend already reads. No frontend changes required.

---

## SECTION 5: RISKS RESOLVED BY THIS PATCH

### Risk resolved — Orphaned sale record on stock failure

**Before:** P0001 at the stock decrement step (step 7) returned 422 to the client, but
the sale record already existed in the database from step 4. The cashier saw an error;
the database had a sale record with no stock change. Manual cleanup required.

**After:** P0001 from `decrement_stock` propagates inside `create_sale_atomic` and rolls
back all inserts including the sale record. On a 422, no record exists in the database.
The cashier can retry immediately.

### Risk resolved — Pre-existing frontend response mismatch

**Before:** Every completed sale showed `#undefined`, `R NaN` in the confirmation modal.
Receipt delivery buttons called `deliverReceipt(undefined, ...)`.

**After:** The top-level `saleId`, `saleNumber`, `totalAmount` fields fix all four
frontend read sites without any frontend code change.

---

## SECTION 6: RISKS NOT RESOLVED (UNCHANGED FROM PHASE 1 STEP 2)

### Remaining Risk 1 — Return stock restoration is non-atomic

Return route reads current stock then writes an incremented value. Low real-world risk
(returns are manual, non-concurrent). Phase 2+ concern.

### Remaining Risk 2 — Void does not restore stock

Void sets `status = 'voided'` only. Policy decision, not a bug. Must be documented in UI.

### Remaining Risk 3 — No idempotency on offline sale sync

Multiple `online` events can trigger `syncOfflineSales()` twice for the same pending
sales. Duplicate sales and double stock decrements remain possible during offline sync.
Phase 2+ concern.

---

## SECTION 7: DEPLOYMENT SEQUENCE

**Run the SQL migration first, then deploy the code (or together).**

### Why order matters

The new `sales.js` calls `create_sale_atomic`. If the migration has not been run yet,
every POST to `/api/pos/sales` returns PGRST202 ("function not found") → 500 to the
client. No sale records are created (which is safe — no orphaned data). The POS will
error on every sale until the migration is applied.

The old code (four sequential calls) is no longer present — there is no fallback path.

### Recommended order

1. Run `025_pos_create_sale_atomic.sql` in Supabase SQL Editor
2. Verify the function exists (call it with test data or check schema browser)
3. Deploy the updated `sales.js` to Zeabur

If you deploy code first without running the migration, the POS will be down for sales
(every create-sale attempt will 500) until the migration is applied. This is acceptable
as long as the window is short.

---

## SECTION 8: HOW TO RUN THE MIGRATION

1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/glkndlzjkhwfsolueyhk/sql)
2. Open a new query
3. Paste the contents of `accounting-ecosystem/database/migrations/025_pos_create_sale_atomic.sql`
4. Run the query
5. Verify: `SELECT proname FROM pg_proc WHERE proname = 'create_sale_atomic';` — should return one row

---

## SECTION 9: SMOKE TEST AFTER DEPLOYMENT

Minimum required before considering Phase 1 complete:

| Test | Expected result |
|---|---|
| Standard cash sale (1 item, sufficient stock) | 201, modal shows real sale number and total |
| Standard card sale | 201, correct response |
| Split payment (cash + card) | 201, both payment rows in sale_payments |
| Oversell attempt (quantity > stock) | 422, no sale record created, stock unchanged |
| Empty cart | 400 before RPC is called |

To verify no orphaned record on oversell:
- Attempt a sale of more units than in stock
- Confirm 422 response
- Query `SELECT * FROM sales ORDER BY created_at DESC LIMIT 1` — the failed sale must NOT appear

---

## SECTION 10: PHASE 1 COMPLETION STATUS

| Step | Status |
|---|---|
| Step 1: decrement_stock RPC + sales.js fallback patch | COMPLETE |
| Step 2: RPC verification (live API test + code review) | COMPLETE |
| Step 3A: Direct pg pool audit | COMPLETE |
| Step 3B: create_sale_atomic contract design | COMPLETE |
| Step 3C: Implementation (this document) | COMPLETE — pending migration run |

**Phase 1 is functionally complete once migration 025 is run in Supabase.**

---

*Two files changed: one SQL migration created, one route patched.*
*Run `025_pos_create_sale_atomic.sql` in Supabase SQL Editor to activate.*
*After activation: all sale creation is atomic — no orphaned records possible.*
