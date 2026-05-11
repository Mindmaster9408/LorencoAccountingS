# 11 — Next Steps: Safe Implementation Order

---

## Phase 0: Clarification (Before Any Code)

These questions must be answered before any feature work begins:

1. **Which backend is production?**  
   Is the live POS running on `Point of Sale/` (port 8080) or `accounting-ecosystem/backend/modules/pos/` (port 3000)?  
   Check Zeabur deployment config — which folder is deployed?

2. **Which database has live data?**  
   The legacy PostgreSQL on Zeabur, or Supabase?  
   Run `SELECT COUNT(*) FROM sales` on both to see which has real records.

3. **What is the VAT model?**  
   Are products priced VAT-inclusive (retail norm in SA) or VAT-exclusive?  
   This determines which VAT calculation formula is correct.

4. **Does the `decrement_stock` Supabase RPC exist?**  
   Check Supabase dashboard → Database → Functions → search `decrement_stock`.  
   If it doesn't exist, every ecosystem sale falls back to a non-atomic decrement with a clamp-to-zero risk.

---

## Phase 1: Foundation Fixes (No New Features)

**Priority: CRITICAL before any new feature work.**

### 1.1 — Decommission Legacy or Ecosystem (Pick One)
Determine which backend is authoritative. Ensure the deployed frontend points to it.  
Add a redirect or clear documentation so no one accidentally uses the wrong server.

### 1.2 — Wrap Sale Creation in a Database Transaction
In `routes/pos.js` (legacy) or `modules/pos/routes/sales.js` (ecosystem):
- Wrap: INSERT sales + INSERT sale_items + UPDATE stock + INSERT sale_payments in one atomic transaction
- On any failure: rollback the entire sale
- This eliminates partial-write state

### 1.3 — Fix the Race Condition in Stock Decrement
Change from:
```sql
-- Check stock (read)
SELECT stock_quantity FROM products WHERE id=?

-- Decrement stock (write)
UPDATE products SET stock_quantity = stock_quantity - ?
WHERE id=?
```
To:
```sql
-- Atomic compare-and-decrement
UPDATE products
SET stock_quantity = stock_quantity - ?
WHERE id = ? AND company_id = ? AND stock_quantity >= ?
-- Check that exactly 1 row was affected
```

### 1.4 — Standardize VAT Calculation
Choose one method. For SA retail (prices shown inclusive):
```
vat_extracted = line_total × (vat_rate / (100 + vat_rate))
```
Confirm all products are priced inclusive or exclusive and apply consistently.

### 1.5 — Confirm/Create `decrement_stock` Supabase RPC
If it doesn't exist, create it:
```sql
CREATE OR REPLACE FUNCTION decrement_stock(p_product_id INT, p_quantity INT)
RETURNS VOID AS $$
BEGIN
  UPDATE products
  SET stock_quantity = stock_quantity - p_quantity
  WHERE id = p_product_id AND stock_quantity >= p_quantity;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient stock for product %', p_product_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

---

## Phase 2: Offline Sale Safety (Before Deploying Offline Mode Broadly)

### 2.1 — Add Idempotency Key to Offline Sales
When syncing offline sales, include the `tempSaleNumber` as an idempotency key:
```javascript
body: JSON.stringify({
  ...saleData,
  idempotency_key: sale.tempSaleNumber   // 'OFFLINE-1715000000000'
})
```
Server: check if `sale_metadata->>'idempotency_key'` already exists → return existing sale, don't re-create.

### 2.2 — Handle JWT Expiry During Offline Period
If the cashier was offline for >8 hours, their token will have expired by sync time.  
Options:
- Extend JWT expiry for offline mode (risk: longer attack window)
- Implement refresh token flow
- Queue the sync action with a note, and require manager re-authentication to complete it

### 2.3 — Handle Session-Closed During Offline Period
If a till session is closed before the offline sale syncs, sync will fail.  
Add logic: if session is closed, either post sale to the session retroactively (if within business day) or flag for manager review.

### 2.4 — Add Retry with Backoff + User Alert on Sync Failure
Current sync silently skips failed offline sales. Add:
- Retry (3 attempts with exponential backoff)
- Alert the cashier/manager if any offline sale could not sync
- Log the failure with enough detail to manually recover

---

## Phase 3: Void Stock Restoration Policy

Decide and implement the business rule:

**Option A: Void = full reversal (stock restored, like it never happened)**
```javascript
// In void route:
for each sale_item:
  UPDATE products SET stock_quantity = stock_quantity + item.quantity
  WHERE id = item.product_id AND company_id = companyId
// Also create stock_adjustments record: type='void_reversal'
```

**Option B: Void = sale cancelled but stock not auto-restored (requires separate return)**
- Document this clearly in the UI ("Voiding does not restore stock. Process a return if goods were not given to the customer.")
- Current behaviour — just document it

---

## Phase 4: Accounting Integration (After Foundation Is Solid)

### 4.1 — Define Chart of Accounts Mapping
Map POS concepts to accounting accounts:
```
Cash sale → DR Cash Till / CR Sales Revenue / CR VAT Output
Card sale → DR Card Clearing / CR Sales Revenue / CR VAT Output
Account sale → DR Accounts Receivable / CR Sales Revenue / CR VAT Output
COGS → DR Cost of Goods Sold / CR Inventory
Return → Reverse all above
```

### 4.2 — Implement Journal Entry Generation
On sale completion: POST journal entry payload to accounting module.  
Schema for `pos_journal_entries`:
```sql
CREATE TABLE pos_journal_entries (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL,
  sale_id INT NOT NULL,
  journal_entry_id INT,  -- FK to accounting module
  status VARCHAR(50) DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

### 4.3 — VAT Period Tracking
Implement VAT period locking after VAT201 submission.  
No backdated sales or returns after period close.

### 4.4 — Bank Reconciliation Link
Connect POS session card totals to bank transaction import matching.

---

## Phase 5: Reporting Improvements

- Add `status = 'completed'` filter consistently across ALL reports (some may be missing it)
- Add voided sale exclusion to all revenue totals
- Add COGS calculation to daily summary (requires cost_price on all products)
- Add VAT period reports with lock dates
- Add consolidated multi-location reports

---

## Phase 6: Dedicated Frontend for Ecosystem POS

The current `index.html` is 9,334 lines of monolithic code. It should be:
- Split into modules (products.js, cart.js, payments.js, cashup.js, reports.js)
- Updated to explicitly target the ecosystem backend URL
- Updated to use the ecosystem's VAT-inclusive pricing model
- Tested against the ecosystem's Supabase database

---

## What to Avoid

| Do NOT | Reason |
|---|---|
| Run both legacy and ecosystem POS simultaneously | Two databases = data split |
| Add localStorage for cart/session state | Violates CLAUDE.md Rule D1 |
| Add new features before fixing the transaction atomicity | Any new feature built on a broken foundation is also broken |
| Add new reports before fixing VAT calculation consistency | Reports will have inconsistent figures |
| "Fix" void without deciding the stock restoration policy | Stock behaviour must be deliberate |
| Change `initDatabase()` in `server.js` without care | Runs every startup — destructive changes affect production |
| Change `database.js` | Entire legacy backend depends on it |
| Bypass `requireCompany` middleware | Multi-tenant isolation breaks |
