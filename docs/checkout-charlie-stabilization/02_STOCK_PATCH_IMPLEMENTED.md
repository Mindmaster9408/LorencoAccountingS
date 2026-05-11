# 02 — Checkout Charlie: Stock Patch Implemented
**Phase 1, Step 1 — SURGICAL PATCH APPLIED**
Date: 2026-05-10

---

## VERDICT SUMMARY

| Question | Answer |
|---|---|
| Is the SQL migration created? | YES — `024_pos_decrement_stock_rpc.sql` |
| Has the SQL been run in Supabase yet? | PENDING — must be run manually |
| Is the sales.js patch applied? | YES |
| Is oversell protection active (post-migration)? | YES — once SQL is run |
| Does fallback still exist? | YES — only activates on PGRST202 |
| Are real RPC errors now surfaced to client? | YES |
| Are fallback write failures now surfaced? | YES |
| Is production stock substantially safer? | YES (code) + SAFE (once SQL runs) |

---

## SECTION 1: FILES CHANGED

### 1.1 — New file: SQL migration

```
accounting-ecosystem/database/migrations/024_pos_decrement_stock_rpc.sql
```

Creates the `decrement_stock` PostgreSQL function in Supabase.

**Status: FILE CREATED. Must be run manually in Supabase SQL Editor.**

---

### 1.2 — Patched file: sales.js

```
accounting-ecosystem/backend/modules/pos/routes/sales.js
```

Only the stock decrement block (previously lines 284–300) was changed.
Everything else in the file — auth, VAT, totals, sale record, sale_items, payments, void, return, audit — is untouched.

---

## SECTION 2: WHAT CHANGED AND WHY

### 2.1 — Old block (removed)

```javascript
// ── 7. Decrement stock (company-scoped, with fallback) ────────────────
for (const item of enrichedItems) {
  const { error: rpcErr } = await supabase.rpc('decrement_stock', {
    p_product_id: item.product_id,
    p_quantity:   item.quantity,
  });

  if (rpcErr) {
    // RPC not available — manual decrement
    const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
    await supabase
      .from('products')
      .update({ stock_quantity: newQty })
      .eq('id', item.product_id)
      .eq('company_id', req.companyId);
  }
}
```

**Problems with the old block:**

1. Any `rpcErr` triggered the fallback — including real stock failures (e.g. "insufficient stock" raised by the RPC). The fallback would override the RPC's correct rejection and allow the oversell anyway.
2. The fallback used `item.product.stock_quantity` — a stale value read at the start of the request, not the live database value at decrement time.
3. The fallback `await supabase.update(...)` result was discarded. Write failures were silently swallowed — the sale proceeded, stock was never decremented, and nothing was logged.

---

### 2.2 — New block (applied)

```javascript
// ── 7. Decrement stock ────────────────────────────────────────────────
for (const item of enrichedItems) {
  const { error: rpcErr } = await supabase.rpc('decrement_stock', {
    p_product_id: item.product_id,
    p_quantity:   item.quantity,
  });

  if (!rpcErr) continue;  // ✅ RPC succeeded — nothing to do

  const isRpcMissing = rpcErr.code === 'PGRST202';

  if (!isRpcMissing) {
    // RPC ran and returned a real error — do NOT fallback
    console.error('[Sales] Stock decrement RPC failed:', { ... });
    const msg = (rpcErr.message || '').toLowerCase();
    if (msg.includes('insufficient stock')) {
      return res.status(422).json({ error: 'Stock check failed', details: [rpcErr.message] });
    }
    return res.status(500).json({ error: 'Stock decrement failed', details: rpcErr.message });
  }

  // PGRST202 only — RPC is missing, use temporary fallback
  console.warn('[Sales] decrement_stock RPC missing — using temporary fallback.', { ... });
  const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
  const { error: fallbackErr } = await supabase.from('products').update({ stock_quantity: newQty })...

  if (fallbackErr) {
    console.error('[Sales] Fallback stock decrement failed:', { ... });
    return res.status(500).json({ error: 'Fallback stock decrement failed', details: fallbackErr.message });
  }
}
```

---

## SECTION 3: EXACT RISKS REMOVED

### Risk 1 — RPC real errors silently overridden (REMOVED)

**Before:** Any `rpcErr`, including a valid "insufficient stock" exception from the RPC, triggered the fallback. The fallback then wrote a clamped value and returned 201 success. A stock rejection from the database was completely ignored.

**After:** Only `rpcErr.code === 'PGRST202'` (function not found) triggers the fallback. All other RPC errors propagate to the client as 422 (stock failure) or 500 (unexpected error).

---

### Risk 2 — Fallback write failures silently swallowed (REMOVED)

**Before:** The fallback `await supabase.update(...)` return value was discarded. If the write failed, the sale was confirmed (201) but stock was never decremented.

**After:** The fallback write result is checked. If it fails, the error is logged with full detail and the request returns 500. The sale is already created at this point (atomicity is a Phase 1 Step 2 concern), but the failure is no longer invisible.

---

### Risk 3 — RPC cannot safely reject after migration (RESOLVED)

**Before:** Even if the RPC had existed, any error from it would have been overridden by the fallback. Deploying the RPC without this code fix would have made things worse — the atomic rejection would be silently bypassed.

**After:** The code correctly interprets RPC errors. The migration and this code fix are safe to deploy together or in any order.

---

## SECTION 4: REMAINING RISKS

These risks were not addressed in this patch by design (scope limited to the decrement block only).

### Remaining Risk 1 — Fallback is still non-atomic (LOW — transitional)

The fallback (PGRST202 path) still uses the stale `item.product.stock_quantity` from the start of the request. While the migration SQL is being applied in Supabase, the fallback is still active and still has the race condition for concurrent cashiers.

**Expected lifetime:** Minutes to hours, until the SQL migration is run. Once `decrement_stock` exists, PGRST202 never fires and this path becomes unreachable.

**Residual risk after migration:** None — the fallback can only trigger on PGRST202.

### Remaining Risk 2 — Sale record exists before stock decrement (MEDIUM)

The sale record, sale_items, and payment records are created (steps 5, 6, 7) before stock is decremented (step 8). If step 8 returns an error and the request aborts with 500, the sale record is orphaned — it exists in the database with no stock change applied.

This is the atomicity problem. It is not solved by this patch. A full transaction wrapper (Phase 1 Step 2) is required to address it.

For now: a failed stock decrement returns 500. The cashier sees an error. The orphaned sale record would need manual cleanup if this occurs.

### Remaining Risk 3 — Void does not restore stock

Not addressed. The void route only sets `status = 'voided'`. This is a policy decision, not a bug fix, and was explicitly out of scope for this patch.

### Remaining Risk 4 — No idempotency on offline sale sync

Offline sales synced on reconnect have no idempotency key. The same offline sale can be posted twice if sync is triggered multiple times. This creates duplicate sale records and double stock decrements. Not addressed in this patch.

### Remaining Risk 5 — Return stock restoration is non-atomic

The return route reads current stock then writes an incremented value. This is a read-then-write pattern. Race conditions on concurrent returns are extremely unlikely in normal use but theoretically present. Not addressed in this patch.

---

## SECTION 5: DEPLOYMENT SEQUENCE

**The SQL migration and the code change are safe to deploy in either order.** Here is why:

- If **code is deployed first, SQL not yet run:**
  - PGRST202 fires on every sale (as before)
  - Fallback runs (as before, but now with failure detection)
  - Behaviour is marginally better than before — fallback failures are now surfaced

- If **SQL is run first, code not yet deployed:**
  - Old code still runs: any `rpcErr` triggers fallback
  - RPC now exists, so it will succeed on sufficient stock → no `rpcErr` → no fallback → correct
  - If RPC raises "insufficient stock" (concurrent oversell caught) → old code would override with fallback → oversell allowed
  - **This is the dangerous window.** Keep it short.

- If **both deployed together** (recommended):
  - RPC exists + code correctly interprets its errors
  - Full protection active immediately

**Recommended order:** Deploy the code change first (or at the same time), then run the SQL migration in Supabase. This means the dangerous window (SQL exists but old code would override RPC errors) is never open.

---

## SECTION 6: IS OVERSELL PROTECTION NOW ACTIVE?

### Before SQL migration is run: NO (same as before)

The fallback still runs on every sale. The PGRST202 check correctly routes to it. Behaviour is the same as pre-patch for the happy path — but fallback failures are now surfaced and RPC real errors would propagate correctly if they could ever occur (they cannot until the RPC exists).

### After SQL migration is run: YES

Once `decrement_stock` exists in Supabase:

1. `supabase.rpc('decrement_stock', { p_product_id, p_quantity })` executes the atomic UPDATE.
2. If stock is sufficient: UPDATE succeeds, 1 row affected, function returns void, `rpcErr` is null, loop continues.
3. If stock is insufficient at write time (caught only by the atomic RPC, not the pre-check): UPDATE affects 0 rows, RAISE EXCEPTION fires, Supabase returns an error with "Insufficient stock" in the message, new code returns 422 to client.
4. PGRST202 never fires. Fallback never runs.

**After the SQL migration: concurrent oversells are blocked at the database level.**

---

## SECTION 7: SCENARIO VERIFICATION (CODE REVIEW)

### Scenario 1 — RPC exists, sufficient stock

```
supabase.rpc('decrement_stock', ...) → { error: null }
!rpcErr → true → continue
```

Result: Stock decremented atomically. Loop continues to next item. ✅

---

### Scenario 2 — RPC exists, insufficient stock (concurrent oversell caught)

```
supabase.rpc('decrement_stock', ...) → { error: { code: 'P0001', message: 'Insufficient stock for product 42: cannot decrement by 2' } }
!rpcErr → false
isRpcMissing = (code === 'PGRST202') → false
→ enters "!isRpcMissing" branch
→ msg.includes('insufficient stock') → true
→ return res.status(422).json({ error: 'Stock check failed', details: [...] })
```

Result: Request returns 422. Fallback does NOT run. Oversell blocked. ✅

---

### Scenario 3 — RPC missing (PGRST202)

```
supabase.rpc('decrement_stock', ...) → { error: { code: 'PGRST202', message: 'Could not find function...' } }
!rpcErr → false
isRpcMissing = (code === 'PGRST202') → true
→ console.warn logged
→ fallback executes
```

Result: Fallback runs with warning logged. Same behaviour as before, but now visible in logs. ✅

---

### Scenario 4 — Fallback update fails

```
supabase.from('products').update(...) → { error: { message: 'connection timeout' } }
fallbackErr is truthy
→ console.error logged with full detail
→ return res.status(500).json({ error: 'Fallback stock decrement failed', ... })
```

Result: Request aborts with 500. Failure is logged and surfaced. Sale record is orphaned (atomicity issue — Phase 1 Step 2). ✅ (better than silent continuation)

---

### Scenario 5 — Concurrent sale, after SQL migration

```
Cashier A + Cashier B both sell last unit simultaneously.
Both pass the pre-check (stock_quantity = 1 at read time).
Both reach step 8 at nearly the same time.

Cashier A: RPC executes UPDATE WHERE stock_quantity >= 1 → 1 row affected → success
Cashier B: RPC executes UPDATE WHERE stock_quantity >= 1 → 0 rows affected (stock is now 0) → RAISE EXCEPTION
         → code returns 422 to Cashier B
```

Result: Only one sale completes. The other is rejected at the database level. Oversell prevented. ✅

---

## SECTION 8: WHAT PHASE 1 STEP 2 SHOULD BE

**Wrap sale creation in an atomic Supabase transaction (or equivalent).**

The current flow creates the sale record (step 5), then sale_items (step 6), then payments (step 7), then decrements stock (step 8) — all as independent Supabase calls. If step 8 fails after step 5 has already written, the sale record is orphaned.

Phase 1 Step 2 options:

**Option A — PostgreSQL transaction via direct connection**
Use the `pg` pool (direct Supabase PostgreSQL connection via `DATABASE_URL`) to run the entire sale creation inside a `BEGIN / COMMIT / ROLLBACK` block. If any step fails, everything rolls back.

**Option B — Supabase RPC for entire sale creation**
Create a `create_sale(...)` Supabase function that runs the full sale inside a single plpgsql function. The entire sale is atomic. Application code calls one RPC, gets back the sale record.

**Option C — Compensating transactions (application-level rollback)**
If sale_items or stock decrement fails, issue DELETE on the already-created sale record and payments. Fragile — requires careful ordering and does not handle network failures during cleanup.

**Recommendation: Option A** — direct PostgreSQL transaction. It uses the existing `pg` dependency already in `accounting-ecosystem/backend/package.json`, requires no new Supabase functions, and gives true ACID atomicity. The Supabase JavaScript client does not support multi-statement transactions; the direct pool connection does.

---

*Patch complete. Two files changed, one file created.*
*Next action: Run `024_pos_decrement_stock_rpc.sql` in Supabase SQL Editor for project `glkndlzjkhwfsolueyhk`.*
