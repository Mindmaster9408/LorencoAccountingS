# 10 — Risks and Protected Areas

---

## SECTION A: CRITICAL RISKS

### RISK-1: Two Active Backends With Separate Databases (CRITICAL)

**What:** `Point of Sale/` (port 8080, PostgreSQL) and `accounting-ecosystem/backend/modules/pos/` (port 3000, Supabase) are two separate backends with separate databases. The same frontend (`index.html`) calls whichever server hosts it.

**Risk:** If both servers are deployed and the frontend is pointed to one but business operators believe they are using the other, sales, stock, and customer data diverge permanently between two databases.

**Current mitigation:** The legacy `server.js` prints a DEPRECATED warning on startup. No production routing guard exists.

**Do not:** Deploy both servers simultaneously against different databases.  
**Action needed:** Confirm which is live in production, migrate data if needed, decommission the other.

---

### RISK-2: VAT Calculation Method Mismatch (HIGH)

**What:** Legacy calculates VAT as `subtotal × 0.15` (exclusive — adds VAT on top). Ecosystem calculates VAT as `linePrice × (vat_rate / (100 + vat_rate))` (inclusive — extracts VAT from price).

**Example for a R100 product:**
- Legacy: subtotal R100, VAT R15, total R115
- Ecosystem: subtotal R100, VAT R13.04, total R100

**Risk:** If both backends ever processed sales for the same company, VAT reports would be internally inconsistent. Tax submissions (VAT201) would be wrong.

**Do not:** Mix data from both backends in the same VAT report.  
**Action needed:** Standardize on one method. Ecosystem's inclusive method is correct for SA retail (retail prices are typically VAT-inclusive). Legacy's external addition is mathematically wrong for VAT-inclusive priced products.

---

### RISK-3: Offline Sales Can Be Permanently Lost (HIGH)

**What:** Offline sales stored in IndexedDB are business-critical — they represent real transactions. If the browser storage is cleared, the device is lost, or the JWT token expires before sync, those sales are gone forever with no server record.

**Risk:** Revenue loss, stock mismatch, customer receipts for non-existent sales.

**Do not:** Assume offline sales always sync successfully.  
**Action needed:** Implement server-side receipt validation, retry with backoff, and alert on sync failure.

---

### RISK-4: No Atomic Transaction on Sale Creation (MEDIUM-HIGH)

**What:** In the legacy backend, the sale record, sale_items, stock decrements, and payment record are written as separate independent SQL statements. No `BEGIN TRANSACTION / COMMIT / ROLLBACK` wraps them.

**Risk:** If the server crashes after `INSERT sales` but before `UPDATE products` (stock decrement), the sale exists but stock was never decremented. The product appears to still have stock available.

**Do not:** Assume sale creation is all-or-nothing in the legacy backend.  
**Action needed:** Wrap the entire sale creation in a PostgreSQL transaction.

---

### RISK-5: Void Does Not Restore Stock (MEDIUM)

**What:** `POST /api/pos/sales/:id/void` sets `status = 'voided'` but does NOT restore product stock quantities. Only formal returns (`/sales/:id/return`) restore stock.

**Risk:** If a cashier voids a sale where products were physically not given to the customer, the stock level will be lower than actual.

**Do not:** Tell users that voiding recovers stock.  
**Action needed:** Decide on and implement a consistent policy — either void does restore stock, or the system requires a formal return for all stock restorations. Document this clearly to users.

---

### RISK-6: Race Condition on Last-Unit Sales (MEDIUM)

**What:** Two cashiers at different tills could both check `products.stock_quantity` at the same time (both see 1 unit available), both pass stock validation, and both proceed to decrement — resulting in `stock_quantity = -1`.

**Current guard:** `if stock_quantity < requested_quantity: 400 error` — but if two requests arrive simultaneously before either decrement completes, both pass.

**Do not:** Assume the stock check prevents double-selling in high-concurrency environments.  
**Action needed:** Use `UPDATE products SET stock_quantity = stock_quantity - ? WHERE id=? AND stock_quantity >= ?` and check `rowCount = 1` to ensure the update only succeeds if stock was sufficient at write time.

---

### RISK-7: Offline Sync Can Post Duplicate Sales (MEDIUM)

**What:** If `syncOfflineSales()` is called twice before `markSaleSynced()` completes (multiple `online` events or page reload during sync), the same offline sale is POSTed twice. The server has no idempotency check.

**Risk:** Duplicate sales records, double stock decrements, double payment records.

**Action needed:** Add an idempotency key (e.g., offline `tempSaleNumber`) to the POST body; server rejects duplicates with a known `409 Conflict` response.

---

## SECTION B: PROTECTED AREAS (DO NOT TOUCH CARELESSLY)

### PROTECTED-1: `Point of Sale/database.js`

Marked CRITICAL in code. This file provides the PostgreSQL connection pool with a SQLite compatibility shim. The `convertPlaceholders()` function translates `?` to `$1, $2, ...`. Any change here could break all database operations. Do not modify without full understanding of PostgreSQL vs SQLite parameter differences.

---

### PROTECTED-2: `Point of Sale/server.js` — `initDatabase()` function

Marked CRITICAL. Runs on every startup. Must remain idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`). Do NOT add any destructive statements (DROP, TRUNCATE, UPDATE that changes data) to this function.

---

### PROTECTED-3: `Point of Sale/middleware/auth.js`

All route authentication flows through here. Changing `JWT_SECRET` will invalidate all existing tokens. Changing `authenticateToken` or `requireCompany` will affect every route.

---

### PROTECTED-4: `Point of Sale/config/permissions.js`

The permission matrix controls what each role can do. Changing a role's permissions will silently grant or remove access for all users with that role. Any change here requires careful testing of all affected user flows.

---

### PROTECTED-5: `routes/pos.js` — Sale creation (`POST /sales`)

The entire sale flow: till session validation → product validation → stock check → totals → INSERT sales → INSERT sale_items → UPDATE stock → INSERT sale_payments → logAudit.

This is the highest-traffic, highest-risk route. Any change must be tested against:
- Normal cash sale
- Split payment
- Customer account sale
- Offline sale sync
- Low stock boundary
- Zero stock boundary

---

### PROTECTED-6: `routes/pos.js` — Session close (`POST /sessions/:id/close`)

The cash-up calculation. `expected_balance = opening_balance + total_sales`. If this formula changes, every future cash-up will show wrong variances. Historical variances would also be reinterpreted incorrectly.

---

### PROTECTED-7: `accounting-ecosystem/backend/modules/pos/routes/sales.js`

The ecosystem sale creation logic. Notably: prices are locked to DB values (anti-spoofing), VAT is calculated as inclusive, and the RPC decrement pattern. Do not change these without understanding the full pricing contract with the frontend.

---

### PROTECTED-8: `audit_log` table

Immutable forensic audit log. Should only ever be INSERTed into — never UPDATEd or DELETEd from. Do not add an UPDATE or DELETE route for audit_log records.

---

### PROTECTED-9: `till_sessions.status` field

The session lifecycle (`open` → `closed`) is the gate for sale creation. Any sale requires an `open` session. Corruption of this field (e.g., sessions stuck as open) would cause:
- Cashier locked out of selling
- Cash-up impossible
- Historical session reports broken

Do not bulk-update `till_sessions` without careful verification.

---

## SECTION C: STABLE AND WORKING FLOWS (VERIFIED)

These flows appear correctly implemented and tested based on code review:

| Flow | Evidence |
|---|---|
| Multi-tenant company isolation | `company_id` on all tables + middleware |
| JWT authentication | Standard `jsonwebtoken.verify()` |
| Role-based permissions | `hasPermission()` matrix enforced on every route |
| Single-method sale creation | Full validation + stock check + audit |
| Split payment creation | Validation + separate `sale_payments` rows |
| Return with stock restore | Correct stock increment on return |
| Daily discount application | `product_daily_discounts` + date-range active check |
| Stock adjustment with audit | Before/after quantities logged |
| IndexedDB offline caching | Products + customers cached |
| Service worker static caching | `index.html`, `manifest.json` cached |
| Session open/close | Till session lifecycle enforced |
| Super admin account creation | Idempotent on startup |

---

## SECTION D: WHAT TO AUDIT DEEPER

These areas were not fully traced in this audit and require deeper investigation before modification:

| Area | Why |
|---|---|
| `routes/receipts.js` | Receipt email/SMS delivery — not fully read |
| `routes/loyalty.js` | Loyalty program tier mechanics — not fully read |
| `routes/promotions.js` | Promo approval workflow — not fully read |
| `routes/analytics.js` | Pre-aggregation trigger mechanism — not verified |
| `modules/pos/routes/sessions.js` | Ecosystem session close logic — not fully read |
| `modules/pos/routes/tills.js` | Ecosystem till management — not read |
| Goods receipt stock increment | Whether goods receipt auto-increments stock — not confirmed |
| `decrement_stock` Supabase RPC | Whether this function exists in production Supabase — not verified |
