# Codebox 01 — Testing Report
**Date:** May 2026  
**Status:** Test scripts written — NOT yet executed against live DB.

---

## 1. Tests Not Yet Run

Migration 050 has not been applied to Supabase. The Node.js backend has not been restarted. No live tests have been executed for this codebox.

**Required before declaring Codebox 01 operational:**

1. Apply migration 050 in Supabase SQL Editor.
2. Restart backend (`node backend/server.js`).
3. Run the manual smoke tests below.
4. Run the automated test scripts.

---

## 2. Manual Smoke Tests

### CBXTEST-01: Manual Stock Movement (in)

1. Login to https://lorenco.zeabur.app/inventory
2. Select a test company and item
3. Click Add Movement → Type: In, Qty: 10, Cost: 50.00
4. Verify stock increases by 10
5. Verify a row appears in movement history
6. **Extra (new):** In Supabase, verify a row was written to `stock_valuation_movements`

**Expected:** stock += 10, movement row visible, valuation ledger populated.

---

### CBXTEST-02: Quick Receive

1. Use Quick Receive for an item → Qty: 5, Unit Cost: 75.00
2. Verify stock increases by 5
3. Verify movement history shows the receive
4. Verify `average_cost` was updated on `inventory_items`
5. Verify a row exists in `inventory_cost_layers` (FIFO layer)

**Expected:** All 5 assertions pass.

---

### CBXTEST-03: PO Receive (previously broken)

1. Create a Purchase Order with 2 lines
2. Receive the PO (partial or full)
3. Verify each line's stock increases correctly
4. Verify PO status changes to `partial_receipt` or `received`
5. Verify no error is returned (this was failing before — the RPC was being called directly with wrong column names)

**Expected:** PO receive succeeds. This was the most critical broken path.

---

### CBXTEST-04: Negative Stock Guard

1. Select an item with stock = 5
2. Attempt to post a manual Out movement with qty = 10
3. Verify the API returns HTTP 422 with `error: 'Insufficient stock'` and `available: 5`
4. Verify the item's stock is unchanged

**Expected:** Request rejected, stock unchanged.

---

### CBXTEST-05: Work Order Issue Materials

1. Create a Work Order in `in_progress` state with materials
2. Issue materials (POST /work-orders/:id/issue-materials)
3. Verify each material's stock decreases by the issued qty
4. Verify `work_order_materials.issued_qty` was updated
5. Verify valuation movements show `source_type = 'wo_issue'`

**Expected:** All assertions pass.

---

### CBXTEST-06: Work Order Complete

1. Complete a Work Order (all materials issued)
2. Verify finished goods stock increases by `quantity_produced`
3. Verify WO status = `completed`
4. Verify valuation movement shows `source_type = 'wo_complete'`

**Expected:** All assertions pass.

---

### CBXTEST-07: Constraint Validation

In Supabase SQL Editor:
```sql
-- Must fail with constraint violation:
UPDATE inventory_items
SET current_stock = -1
WHERE id = <any_valid_id>;
```

**Expected:** `ERROR:  new row for relation "inventory_items" violates check constraint "chk_current_stock_non_negative"`

---

## 3. Automated Tests

### test_inventory_stock_concurrency.mjs

```bash
SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<key> \
  node scripts/test_inventory_stock_concurrency.mjs <companyId> <itemId>
```

**Asserts:**
- No lost updates from 10 concurrent stock-outs
- Final stock matches exactly
- Stock never went negative
- `stock_movements` row count matches success count

---

### test_inventory_company_isolation.mjs

```bash
SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<key> \
  node scripts/test_inventory_company_isolation.mjs <companyA> <itemInA> <companyB>
```

**Asserts:**
- Cross-company mutation returns `{ success: false, error: 'Item not found' }`
- Company A stock unchanged
- No rogue `stock_movements` row written

---

### test_inventory_no_local_storage.mjs

```bash
node scripts/test_inventory_no_local_storage.mjs
```

**Asserts:**
- No `localStorage.setItem()`, `sessionStorage.setItem()`, `safeLocalStorage.setItem()`, or `indexedDB.open()` calls with business data in the inventory frontend or backend code

---

## 4. Post-Migration DB Verification

Run these queries in Supabase SQL Editor after applying migration 050:

```sql
-- 1. Confirm correct column names in function body
SELECT prosrc FROM pg_proc WHERE proname = 'adjust_inventory_stock';
-- Must contain 'movement_type' and 'unit_cost', NOT 'type' or 'cost_price'

-- 2. Constraint is now valid
SELECT conname, convalidated
FROM pg_constraint
WHERE conname = 'chk_current_stock_non_negative';
-- convalidated must be true

-- 3. New index exists
SELECT indexname FROM pg_indexes
WHERE tablename = 'stock_movements'
  AND indexname = 'idx_sm_company_item_created';
-- Must return 1 row

-- 4. Forensic tables are being populated (after running CBXTEST-01)
SELECT COUNT(*) FROM stock_valuation_movements;
-- Must be > 0 after first successful mutation post-migration
```
