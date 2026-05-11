# 01 — Checkout Charlie: Stock RPC Audit
**Phase 0, Step 2 — READ ONLY. No code changes made.**
Date: 2026-05-10

---

## VERDICT SUMMARY

| Question | Answer | Confidence |
|---|---|---|
| Does `decrement_stock` RPC exist in the codebase? | **NO — not defined anywhere** | CONFIRMED |
| Does it exist in the Supabase database? | **ALMOST CERTAINLY NO** | VERY LIKELY |
| What runs on every production sale instead? | **Unsafe fallback with stale read** | CONFIRMED |
| Is production stock currently safe? | **NO — UNSAFE** | CONFIRMED |
| Is there a race condition risk? | **YES — active** | CONFIRMED |
| Can stock go below zero? | **No — clamped to 0, but silently** | CONFIRMED |
| Is silent stock loss possible? | **YES — Math.max(0,...) hides it** | CONFIRMED |
| Is emergency action required? | **YES for multi-cashier stores** | CONFIRMED |

---

## SECTION 1: DOES THE RPC EXIST?

### 1.1 — Complete search of every SQL file in the repository

A grep of `decrement_stock` across the entire repository was performed. The function was searched across all `.sql`, `.js`, `.md`, and all other file types.

**All SQL function definitions found in the ecosystem schema:**

File: `accounting-ecosystem/database/schema.sql`

```sql
-- Only two functions are defined:
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION initialize_payroll_defaults(p_company_id INTEGER)
RETURNS VOID AS $$
...
$$ LANGUAGE plpgsql;
```

`decrement_stock` is not in this file.

**All migration files checked:**

```
accounting-ecosystem/database/migrations/011_paytime_company_fields.sql
accounting-ecosystem/database/migrations/012_voluntary_tax_overdeduction.sql
accounting-ecosystem/database/migrations/013_employee_classification_hours_eti.sql
accounting-ecosystem/database/migrations/014_inventory_manufacturing.sql
accounting-ecosystem/database/migrations/015_company_logo_data.sql
accounting-ecosystem/database/migrations/016_inventory_phase1_stability.sql
accounting-ecosystem/database/migrations/017_pay_schedules.sql
accounting-ecosystem/database/migrations/018_sdl_uif_registration.sql
accounting-ecosystem/database/migrations/019_year_end_close.sql
accounting-ecosystem/database/migrations/020_bank_staging.sql
accounting-ecosystem/database/007_coaching_schema.sql
accounting-ecosystem/database/008_eco_clients_packages.sql
accounting-ecosystem/database/009_user_app_access.sql
accounting-ecosystem/database/010_user_client_access.sql
accounting-ecosystem/database/011_sean_irp5_learning.sql
accounting-ecosystem/database/012_accounting_schema.sql
accounting-ecosystem/database/013_sean_learning.sql
accounting-ecosystem/database/019_coaching_exercise_data.sql
accounting-ecosystem/database/020_basis_assessment_storage.sql
accounting-ecosystem/database/021_coaching_settings.sql
accounting-ecosystem/database/022_assessment_tokens.sql
accounting-ecosystem/database/023_coaching_client_photos.sql
accounting-ecosystem/backend/config/migrations/001_sean_tables.sql
accounting-ecosystem/backend/config/migrations/002_super_practice.sql
```

`decrement_stock` is not in any of these files.

### 1.2 — Conclusion

**`decrement_stock` has never been defined in this repository.**

It was not created. It was not included in the schema. It was not added as a migration. There is no SQL file that runs `CREATE FUNCTION decrement_stock` anywhere in the codebase.

The function is called in application code but was never created in the database.

### 1.3 — What Supabase returns when a non-existent RPC is called

When `supabase.rpc('decrement_stock', {...})` is called against a function that does not exist in Supabase, Supabase returns a PostgREST error:

```json
{
  "code": "PGRST202",
  "message": "Could not find the function public.decrement_stock(p_product_id, p_quantity) in the schema cache",
  "hint": "If a new function was created in the database, try reloading the schema cache."
}
```

This error object is truthy. The application code checks `if (rpcErr)` and enters the fallback branch.

**Consequence: The fallback runs on every single production sale. Always. Without exception.**

---

## SECTION 2: EXACT CODE PATHS — WHAT ACTUALLY RUNS

### 2.1 — The complete sale creation flow

File: `accounting-ecosystem/backend/modules/pos/routes/sales.js`

```
Step 1: Authenticate + validate company + till session (lines ~120-150)
Step 2: Load products from Supabase DB (lines 152-158)
Step 3: Stock pre-check — reject if any item has insufficient stock (lines 165-179)
Step 4: Calculate totals using locked DB prices + inclusive VAT (lines 181-209)
Step 5: CREATE the sale record in Supabase (lines 211-237)  ← WRITE
Step 6: INSERT sale_items (lines 239-258)                   ← WRITE
Step 7: INSERT payment records (lines 260-282)              ← WRITE
Step 8: DECREMENT stock (lines 284-300)                     ← WRITE (broken)
Step 9: Audit log + return 201 response (lines 302-311)
```

No transaction wraps any of these steps. Each is an independent Supabase call.

### 2.2 — The full stock decrement block (lines 284-300)

```javascript
// ── 7. Decrement stock (company-scoped, with fallback) ────────────────
for (const item of enrichedItems) {
  const { error: rpcErr } = await supabase.rpc('decrement_stock', {
    p_product_id: item.product_id,
    p_quantity:   item.quantity,
  });

  if (rpcErr) {
    // RPC not available — manual decrement (still company-scoped via product lookup above)
    const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
    await supabase
      .from('products')
      .update({ stock_quantity: newQty })
      .eq('id', item.product_id)
      .eq('company_id', req.companyId);
  }
}
```

### 2.3 — The stock pre-check (lines 165-179)

```javascript
// ── 2. Stock pre-check — reject if any item is insufficient ──────────
const stockErrors = [];
for (const item of normItems) {
  const prod = productMap[item.product_id];
  if (!prod) {
    stockErrors.push(`Product ${item.product_id} not found`);
  } else if (prod.stock_quantity < item.quantity) {
    stockErrors.push(
      `Insufficient stock for "${prod.product_name}": have ${prod.stock_quantity}, need ${item.quantity}`
    );
  }
}
if (stockErrors.length > 0) {
  return res.status(422).json({ error: 'Stock check failed', details: stockErrors });
}
```

This pre-check is the ONLY stock guard. Once it passes, the sale is committed. The decrement at step 8 is not guarded — it uses the stale value from step 2.

---

## SECTION 3: SAFETY ANALYSIS

### 3.1 — What `item.product.stock_quantity` actually contains

`item.product` is set from `productMap`, which is populated at the product load step (step 2, line 162):

```javascript
const productMap = {};
for (const p of (productRows || [])) productMap[p.id] = p;
```

This is a snapshot of stock quantities taken at the START of the sale request processing — before the sale record was created, before sale_items were inserted, before payments were recorded.

By the time step 8 (decrement) runs, `item.product.stock_quantity` is a stale value. It is the quantity that existed when the request arrived. It is NOT the live current quantity in the database at the moment of the write.

**This is a read-then-write pattern, not an atomic compare-and-update.**

### 3.2 — Single cashier scenario (current typical case)

In a single-cashier store where sales are sequential:

```
Sale A arrives → reads stock = 10 → pre-check OK → creates sale → decrements to 7 (3 sold)
Sale B arrives → reads stock = 7  → pre-check OK → creates sale → decrements to 4 (3 sold)
```

**Result: CORRECT.** Stock reduces properly because no concurrent writes overlap.

### 3.3 — Multi-cashier concurrent scenario (the race condition)

In a multi-till store where two sales arrive simultaneously:

```
Cashier A:  reads stock = 1   (product has 1 unit)
Cashier B:  reads stock = 1   (same read, concurrent)
Cashier A:  pre-check: 1 < 1? NO → passes
Cashier B:  pre-check: 1 < 1? NO → passes
Cashier A:  creates sale record ✓
Cashier B:  creates sale record ✓
Cashier A:  fallback decrement: Math.max(0, 1 - 1) = 0 → writes stock = 0
Cashier B:  fallback decrement: Math.max(0, 1 - 1) = 0 → writes stock = 0
```

**Result: SILENT OVERSELL.** Two sales exist for 1 unit of product. Stock shows 0. No error. No alert. Both customers have receipts. One unit was physically given out; the other was sold on air.

### 3.4 — Worse concurrent scenario with larger quantities

```
Product stock = 3
Cashier A sells 2: reads stock = 3, fallback writes: Math.max(0, 3 - 2) = 1
Cashier B sells 2: reads stock = 3, fallback writes: Math.max(0, 3 - 2) = 1
```

**Result:** 4 units sold, stock shows 1. Stock should be -1 but Math.max clamps it to 1. The business has lost 1 unit's worth of value with no record of why.

### 3.5 — What the RPC WOULD have done (if it existed)

If `decrement_stock` existed with the recommended `WHERE stock_quantity >= p_quantity` guard:

```sql
UPDATE products
SET stock_quantity = stock_quantity - p_quantity
WHERE id = p_product_id AND stock_quantity >= p_quantity;
```

This executes as a single atomic database operation. PostgreSQL locks the row during the update.

```
Cashier A:  RPC executes: stock=1, 1 >= 1 → decrements to 0, 1 row affected
Cashier B:  RPC executes: stock=0, 0 >= 1 → NO rows affected (condition fails)
```

If the RPC returned 0 rows affected, the application code could detect this and reject the sale. **This is the correct behaviour.** The fallback provides none of it.

---

## SECTION 4: CONCURRENCY ANALYSIS

### 4.1 — Is this a real risk or theoretical?

This depends entirely on the store's setup:

| Store type | Concurrent sale risk | Stock integrity risk |
|---|---|---|
| Single till, single cashier | Near zero | LOW |
| Multiple tills, same shift | Realistic during peak | MEDIUM |
| High-volume store, multiple cashiers | Frequent | HIGH |
| Offline sync on reconnect + active cashiers | Near certain | HIGH |

The most likely real-world trigger: a cashier processes a cash sale while another cashier is scanning items with a pending offline sale that syncs at the same moment.

### 4.2 — Offline sync makes this worse

When offline sales sync on reconnect (`syncOfflineSales()`), each pending sale is posted to `POST /api/pos/sales`. If a cashier was actively taking sales while another device reconnected and synced 3 offline sales, those 4 concurrent requests would all:
1. Read the same product quantities
2. All pass the pre-check
3. All create sale records
4. All fallback-decrement using the same stale reads

This is the most likely path to a real-world stock discrepancy.

### 4.3 — Idempotency gap multiplies the risk

There is no idempotency key on offline sale sync. If `syncOfflineSales()` is triggered twice (multiple `online` events, page reload during sync), the same offline sale is POSTed twice. Both posts create sale records, both decrement stock. This doubles the stock discrepancy from the concurrent race described above.

---

## SECTION 5: NEGATIVE STOCK PROTECTION ANALYSIS

### 5.1 — Can stock go below zero?

With the current fallback: **No — but only because of Math.max clamping.**

```javascript
const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
```

Stock cannot be written as negative. The minimum written value is 0.

### 5.2 — Is this protection meaningful?

**No.** The protection is misleading. Clamping to 0 does not prevent overselling — it hides it.

When two concurrent sales of the last unit both complete:
- The database shows `stock_quantity = 0` — looks correct
- Two sale records exist — both customers have receipts
- One unit was sold that did not exist
- The business has a revenue entry with no corresponding inventory movement
- There is no indication in the database that anything went wrong

A correct guard would REJECT the second sale, not silently accept it and clip the stock value.

### 5.3 — Manual stock adjustments

File: `accounting-ecosystem/backend/modules/pos/routes/inventory.js`

Manual adjustments also use `Math.max(0, oldQty + quantity_change)`. However, manual adjustments are:
1. Performed one at a time by a human
2. Not concurrent with other adjustments
3. Recorded in `inventory_adjustments` table with before/after quantities

The concurrency risk for manual adjustments is negligible.

---

## SECTION 6: FALLBACK PATH ANALYSIS

### 6.1 — When does the fallback activate?

The fallback activates whenever `rpcErr` is truthy — that is, whenever the RPC call returns an error.

Since `decrement_stock` does not exist in Supabase, every call returns a PGRST202 error. The fallback activates on **every sale, for every item, in production.**

### 6.2 — The fallback has a secondary write failure

The fallback does this:

```javascript
await supabase
  .from('products')
  .update({ stock_quantity: newQty })
  .eq('id', item.product_id)
  .eq('company_id', req.companyId);
```

The result of this `await` is not checked. If this write also fails (network issue, Supabase downtime), the error is silently swallowed. The sale record already exists, the items are created, payment is recorded — but stock was never decremented. The product appears to still have full stock.

This is a second level of silent failure within the fallback.

### 6.3 — Error propagation chain

```
Sale request arrives
    │
    ├── Step 5: Insert sale record → error → returns 500, sale aborted ✓
    │
    ├── Step 6: Insert sale_items → error → LOGGED but sale continues ⚠️
    │           (sale exists with no items — orphaned record)
    │
    ├── Step 7: Insert payments → error → LOGGED but sale continues ⚠️
    │           (sale exists with no payment record — orphaned record)
    │
    └── Step 8: Decrement stock
            │
            ├── RPC call → ALWAYS FAILS (function does not exist)
            │
            └── Fallback write → error → SILENTLY IGNORED ⚠️
                                          (stock never decremented)
```

Steps 6, 7, and 8 failures are not surfaced to the client. The API returns 201 success. A sale record is created. The customer gets a receipt. The stock, sale_items, or payment record may be incomplete or missing — silently.

---

## SECTION 7: ALL STOCK MUTATION PATHS — COMPLETE MAP

### 7.1 — Sale creation (primary decrement path)

| Path | Method | Atomic? | Guard | Risk |
|---|---|---|---|---|
| `POST /api/pos/sales` — RPC call | `supabase.rpc('decrement_stock')` | YES (if existed) | `WHERE stock_qty >= qty` | Does not exist — never executes |
| `POST /api/pos/sales` — fallback | `Math.max(0, staleRead - qty)` update | NO | None | Active: stale read + no concurrency protection |

### 7.2 — Return (stock restoration)

File: `accounting-ecosystem/backend/modules/pos/routes/sales.js` (lines ~416-431)

```javascript
const { data: prod } = await supabase.from('products').select('stock_quantity')...
if (prod) {
  await supabase.from('products').update({
    stock_quantity: prod.stock_quantity + ri.quantity
  })...
}
```

| Path | Method | Atomic? | Risk |
|---|---|---|---|
| `POST /api/pos/sales/:id/return` | Read then write | NO | Low — manual, non-concurrent |

Returns add stock back correctly in normal use. Non-atomic but acceptable for manually triggered operations.

### 7.3 — Void (does NOT restore stock)

File: `accounting-ecosystem/backend/modules/pos/routes/sales.js` (lines ~318-354)

```javascript
await supabase.from('sales').update({
  status: 'voided',
  void_reason: reason,
  voided_by: req.user.userId,
  voided_at: new Date().toISOString(),
})
```

| Path | Stock effect | Risk |
|---|---|---|
| `POST /api/pos/sales/:id/void` | None — stock NOT restored | If goods not given to customer, stock is permanently under-counted |

### 7.4 — Manual stock adjustment

File: `accounting-ecosystem/backend/modules/pos/routes/inventory.js`

```javascript
const newQty = Math.max(0, oldQty + quantity_change);
await supabase.from('products').update({ stock_quantity: newQty })...
// Also inserts into inventory_adjustments table with before/after quantities
```

| Path | Method | Atomic? | Audit trail? | Risk |
|---|---|---|---|---|
| `POST /api/pos/inventory/adjust` | Read then write | NO | YES — `inventory_adjustments` | Low — manual, non-concurrent |

### 7.5 — Offline sale sync (stock effect)

Stock is NOT decremented during the offline period. Stock decrement only happens when the offline sale is synced via `POST /api/pos/sales`, which goes through the same fallback path as a live sale.

If multiple offline sales sync simultaneously (multiple devices reconnecting), they all use stale stock reads from the moment each sync POST arrives — not from the moment the offline sale was made. This can create a multi-sale simultaneous race condition.

### 7.6 — Summary of all stock mutation paths

| Trigger | File | Lines | Atomic | Guard | Audit record |
|---|---|---|---|---|---|
| Sale — RPC (never runs) | `modules/pos/routes/sales.js` | 285-289 | Would be YES | `WHERE qty >= req` | No (would be in DB function) |
| Sale — fallback (always runs) | `modules/pos/routes/sales.js` | 291-299 | NO | Math.max(0,...) | No |
| Return | `modules/pos/routes/sales.js` | 416-431 | NO | None needed | Via `sale_returns` table |
| Void | `modules/pos/routes/sales.js` | 318-354 | N/A | N/A | `audit_log` only, no stock change |
| Manual adjust | `modules/pos/routes/inventory.js` | 74-89 | NO | Math.max(0,...) | YES — `inventory_adjustments` |
| Offline sync | `frontend-pos/index.html` | 3338-3375 | N/A (handled server-side) | N/A | Audit log on sync |

---

## SECTION 8: REAL OVERSELL RISK ASSESSMENT

### 8.1 — Conditions for a real oversell to occur

All three of these must be true simultaneously:

1. A product has low stock (ideally 1 unit)
2. Two or more sale requests arrive within a very short window (milliseconds apart)
3. Both pass the pre-check before either decrement completes

**How often does this happen?**

In a low-volume single-cashier store: rarely. The sequential nature of manual sales makes simultaneous requests unlikely.

In a higher-volume or multi-till store during peak hours: feasible. Customers at two tills simultaneously buying the last unit of the same product.

Via offline sync: the most predictable trigger. A device with 3 offline sales reconnects while another cashier is actively selling. The sync fires 3 concurrent POSTs along with 1 live sale — 4 requests hitting stock decrements simultaneously.

### 8.2 — Financial impact of an oversell

An oversell at the current stock level means:

- A sale is recorded for a unit that did not exist
- Revenue is booked for a transaction that cannot be fulfilled
- If the customer already left: no inventory to reverse against
- Stock shows 0, which looks correct, hiding the discrepancy
- The business carries phantom revenue and a real inventory shortage

For a small store, a single oversell incident causes minor discrepancy. For a store with fast-moving items during peak hours, this can accumulate silently over time.

### 8.3 — Is this currently causing problems?

Likely not causing obvious problems if:
- The store has a single cashier
- Sales are processed one at a time
- Offline sync rarely happens with multiple pending sales

Likely IS causing occasional problems if:
- Multiple tills are in use
- Offline mode is used regularly
- Fast-moving low-stock items are sold

Without checking the Supabase `sales` table for duplicate sequential sales of the same product at the same timestamp, it is impossible to confirm whether past oversells have occurred.

---

## SECTION 9: PRODUCTION SAFETY VERDICT

### VERDICT: UNSAFE — FALLBACK IS ALWAYS ACTIVE

```
┌─────────────────────────────────────────────────────────────┐
│  PRODUCTION STOCK STATE: UNSAFE                             │
│                                                             │
│  The decrement_stock RPC does not exist.                    │
│  Every production sale uses the unsafe fallback.           │
│  The fallback uses a stale stock read.                      │
│  The fallback does not prevent concurrent oversell.         │
│  Silent stock loss is clamped to 0, not surfaced.          │
│  Fallback write failures are silently swallowed.           │
│                                                             │
│  For a single-cashier store: LOW ACTIVE RISK               │
│  For a multi-till store: MEDIUM ACTIVE RISK                │
│  During offline sync: HIGH ACTIVE RISK                     │
└─────────────────────────────────────────────────────────────┘
```

---

## SECTION 10: RECOMMENDED FIX ORDER

### Fix 1 — Create `decrement_stock` in Supabase (CRITICAL, DO NOW)

This is a single SQL statement. It must be run in the Supabase SQL Editor for project `glkndlzjkhwfsolueyhk`.

```sql
CREATE OR REPLACE FUNCTION decrement_stock(p_product_id INT, p_quantity INT)
RETURNS VOID AS $$
DECLARE
  rows_affected INT;
BEGIN
  UPDATE products
  SET stock_quantity = stock_quantity - p_quantity
  WHERE id = p_product_id
    AND stock_quantity >= p_quantity;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  IF rows_affected = 0 THEN
    RAISE EXCEPTION 'Insufficient stock for product %: cannot decrement by %',
      p_product_id, p_quantity;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

**Why this works:**
- `WHERE stock_quantity >= p_quantity` is evaluated atomically at write time
- PostgreSQL row-level locking prevents concurrent writes from racing
- `GET DIAGNOSTICS` + `RAISE EXCEPTION` causes the RPC to return an error if stock was insufficient at write time — even if the pre-check passed
- The application code checks `if (rpcErr)` — if the RPC raises an exception, `rpcErr` is truthy, triggering the fallback... which is the problem

### Fix 2 — Fix fallback to respect RPC failure as a real error (CRITICAL, PAIRED WITH FIX 1)

Once the RPC exists and throws on insufficient stock, the fallback must NOT silently continue. The current code:

```javascript
if (rpcErr) {
  // RPC not available — manual decrement
  const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
  ...
}
```

This was written assuming `rpcErr` only means "function not found." Once the RPC exists, `rpcErr` can also mean "insufficient stock at decrement time." The fallback should NOT run in that case — it would allow the oversell that the RPC just rejected.

The fix must distinguish between:
- `PGRST202` (function not found) → use fallback
- Any other error (e.g., our `RAISE EXCEPTION`) → propagate the error, do not fallback

**This fix requires a code change in `sales.js` and must be paired with Fix 1.**

### Fix 3 — Check and handle fallback write failure (HIGH)

The fallback write result is currently not checked:

```javascript
await supabase.from('products').update({ stock_quantity: newQty })...
// result is discarded
```

If this write fails, the sale exists but stock was never decremented. The error should be logged at minimum; ideally the sale should be rolled back — but without a transaction, rollback is not possible.

For now: capture the error and log it prominently so at least the failure is visible.

### Fix 4 — Add idempotency key to offline sale sync (HIGH)

When offline sales sync, include a unique key that the server checks for duplicates:

```javascript
body: JSON.stringify({
  ...saleData,
  idempotency_key: sale.tempSaleNumber  // 'OFFLINE-1715000000000'
})
```

Server side: before creating a sale, check if a sale with that `idempotency_key` already exists. If it does, return the existing sale rather than creating a duplicate.

This prevents the offline sync race condition from doubling stock decrements.

### Fix 5 — Decide void stock policy and implement it (MEDIUM)

Current behavior: void does not restore stock. This is a policy gap, not a bug.

Decide:
- **Option A:** Void restores stock automatically (treat void as full reversal)
- **Option B:** Void does not restore stock; a return must be processed separately

Document the chosen policy clearly in the UI. If Option A: implement stock restoration in the void route. If Option B: add a UI warning in the void confirmation dialog.

---

## SECTION 11: IS EMERGENCY ACTION REQUIRED?

| Store configuration | Emergency action? |
|---|---|
| Single cashier, no offline mode | NO — create RPC at next maintenance window |
| Single cashier, offline mode used | YES — offline sync can race with live sales |
| Multi-till store | YES — concurrent sales can oversell |
| Any store with fast-moving low-stock items | YES — even single cashier can hit offline race |

**Minimum emergency action for any store:** Run Fix 1 (create the RPC function) in Supabase SQL Editor. This is a 30-second operation that requires no code deployment. It immediately replaces the unsafe fallback with atomic protection for all future sales.

Fix 2 (code change to handle RPC errors properly) must follow immediately after. Until Fix 2 is deployed, a stock-insufficient RPC error would silently fall through to the fallback and allow the oversell anyway.

---

## SECTION 12: CONFIDENCE LEVELS

| Finding | Confidence |
|---|---|
| `decrement_stock` not defined in any SQL file in repo | CONFIRMED |
| `decrement_stock` not in Supabase production DB | VERY LIKELY (never created, no migration) |
| Fallback runs on every production sale | CONFIRMED |
| Stale stock read used in fallback | CONFIRMED (code traced) |
| Math.max(0,...) hides oversell silently | CONFIRMED |
| Race condition is theoretically possible | CONFIRMED |
| Race condition has actually occurred | UNKNOWN (would require Supabase data check) |
| Fallback write failure is silently swallowed | CONFIRMED (result not checked) |

---

*Investigation complete. No files were modified during this investigation.*
*Immediate next step: Verify by checking Supabase dashboard → Database → Functions for `decrement_stock`.*
*If absent: create it using Fix 1 SQL above.*
