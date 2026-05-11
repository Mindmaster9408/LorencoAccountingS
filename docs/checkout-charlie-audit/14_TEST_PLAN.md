# 14 — Manual Test Plan

This is the recommended manual test plan for verifying all core POS flows. Run this before deploying any changes.

---

## Pre-Test Setup

Before testing, confirm:
- [ ] Which backend is live (legacy port 8080 or ecosystem port 3000)
- [ ] Test company exists with at least one till configured
- [ ] Test products exist (at least 3 with different categories, varying stock levels)
- [ ] At least one product has `cost_price` set (for profit reports)
- [ ] Test customer exists with credit account and loyalty points
- [ ] At least one open till session (or plan to open one)
- [ ] Test cashier user + test manager user accounts ready

---

## TEST GROUP 1: Authentication and Company Selection

### T1.1 — Login with single company
1. Enter valid credentials for a user with one company
2. Expected: Auto-selects company, enters POS till view without showing company selector
3. Expected: JWT token stored in localStorage

### T1.2 — Login with multiple companies
1. Enter valid credentials for a user with multiple companies
2. Expected: Company selector screen shown
3. Select a company
4. Expected: Enters POS till view for that company

### T1.3 — Invalid login
1. Enter wrong password
2. Expected: Error message displayed, no token stored

### T1.4 — Token expiry
1. Log in successfully
2. Manually alter the stored token in localStorage (DevTools) to an invalid value
3. Expected: Next API call should fail with 401, redirect to login

### T1.5 — Logout
1. Click Logout
2. Expected: Confirmation dialog shown
3. Confirm
4. Expected: Redirected to login, localStorage cleared (token, isSuperAdmin removed)

---

## TEST GROUP 2: Product Loading

### T2.1 — Products load on login
1. Log in
2. Navigate to Till tab
3. Expected: Product cards visible with correct names, prices, categories

### T2.2 — Category filter
1. Click a category filter
2. Expected: Only products in that category shown

### T2.3 — Search
1. Enter text in product search field
2. Expected: Only matching products shown (by name or code)

### T2.4 — Barcode scan (if scanner available)
1. Scan a product barcode
2. Expected: Product added to cart

### T2.5 — Product with stock_quantity = 0
1. Attempt to add a product with zero stock to cart
2. Expected: Error shown "Insufficient stock"

---

## TEST GROUP 3: Cart Totals

### T3.1 — Add one product
1. Add 1 unit of a product at R100
2. Expected: Cart shows R100 subtotal, correct VAT, correct total

### T3.2 — Add multiple products
1. Add several different products
2. Expected: Each line shows qty × unit_price, subtotal sums correctly

### T3.3 — Change quantity
1. Use + / − buttons on a cart item
2. Expected: Line total updates, cart total updates

### T3.4 — Remove item
1. Click remove on a cart item
2. Expected: Item removed, cart total recalculated

### T3.5 — VAT calculation
1. Add a product with `requires_vat = true`
2. Check displayed VAT amount
3. Expected: VAT matches the backend's calculation method (inclusive vs exclusive — confirm with your choice)

### T3.6 — Empty cart checkout attempt
1. Attempt checkout with empty cart
2. Expected: Error or button disabled

---

## TEST GROUP 4: Cash Sale

### T4.1 — Standard cash sale
1. Add products to cart (total ~R50)
2. Click CASH payment
3. Enter tendered amount (e.g., R100)
4. Expected: Change shown as R50
5. Click Checkout
6. Expected: Sale success, receipt modal shown with sale number
7. Expected: Cart cleared

### T4.2 — Cash sale — verify DB record
1. Complete a cash sale
2. Check database: `SELECT * FROM sales ORDER BY created_at DESC LIMIT 1`
3. Expected: Record exists with correct `subtotal`, `vat_amount`, `total_amount`, `payment_method = 'CASH'`, `status = 'completed'`

### T4.3 — Cash sale — verify stock decrement
1. Note stock quantity of product before sale (from stock tab)
2. Complete sale with 2 units of that product
3. Check stock tab
4. Expected: Stock reduced by 2

### T4.4 — Cash sale — verify sale_items
1. Check database: `SELECT * FROM sale_items WHERE sale_id = ?`
2. Expected: One row per product with correct qty, unit_price, total_price

---

## TEST GROUP 5: Card Sale

### T5.1 — Standard card sale
1. Add products, click CARD
2. Complete checkout
3. Expected: Sale created with `payment_method = 'CARD'`
4. Expected: `sale_payments` record with `payment_method = 'CARD'`

### T5.2 — Card sale does not affect cash float
1. Open till with R500 float
2. Make a R100 card sale
3. Go to cash-up
4. Expected: Expected cash still shows R500 (card not in cash expectation)

---

## TEST GROUP 6: Split Payment

### T6.1 — Split cash + card
1. Cart total: R150
2. Click SPLIT
3. Enter R100 CASH + R50 CARD
4. Expected: Total allocated = R150, Checkout enabled
5. Complete checkout
6. Expected: Sale created, two records in `sale_payments` (CASH R100, CARD R50)

### T6.2 — Split payment under-allocation
1. Cart total: R150
2. Allocate only R100
3. Expected: Checkout button disabled or error "Total payment insufficient"

### T6.3 — Split payment over-allocation
1. Cart total: R150
2. Allocate R200 (all cash)
3. Expected: Allowed (change given back to customer)

---

## TEST GROUP 7: Account Customer Sale

### T7.1 — Search and attach customer
1. Click ACCOUNT
2. Search for a customer by name
3. Expected: Customer appears in search results
4. Select customer
5. Expected: Customer name shown on sale

### T7.2 — Account sale within credit limit
1. Customer with credit_limit = R500, current_balance = R0
2. Make a R200 account sale
3. Expected: Sale completes, `customer_account_transactions` record created

### T7.3 — Account sale exceeding credit limit
1. Customer with credit_limit = R200, current_balance = R200
2. Attempt a R50 account sale
3. Expected: Error or warning about credit limit exceeded

---

## TEST GROUP 8: Refunds and Returns

### T8.1 — Return as manager
1. Find a completed sale
2. Process a full return as a manager
3. Expected: `sale_returns` record created, stock restored for returned items

### T8.2 — Return as cashier without authorization
1. Attempt a return as a cashier without providing `authorized_by_user_id`
2. Expected: 403 error "Manager authorization required for returns"

### T8.3 — Partial return
1. Sale had 3 units of a product
2. Return 1 unit only
3. Expected: `quantity_returned = 1`, refund = unit_price × 1, stock += 1

### T8.4 — Return more than purchased
1. Attempt to return 5 units from a sale of 3
2. Expected: Error "Cannot return more than purchased"

---

## TEST GROUP 9: Voids

### T9.1 — Void a sale as manager
1. Find a completed sale
2. Void it with a reason
3. Expected: `status = 'voided'`, `void_reason` set, `voided_at` set

### T9.2 — Void an already-voided sale
1. Attempt to void a sale already voided
2. Expected: Error "Sale is already voided"

### T9.3 — Voided sale excluded from revenue reports
1. Make a sale for R100
2. Void it
3. Run daily summary report for today
4. Expected: The voided sale's R100 NOT included in total sales

### T9.4 — Verify void does not restore stock (current behaviour)
1. Note product stock: 10 units
2. Sell 3 units
3. Stock: 7 units
4. Void the sale
5. Check stock
6. Expected: Stock remains at 7 (void does NOT restore stock in current implementation)

---

## TEST GROUP 10: Stock Reduction — Verification

### T10.1 — Sale reduces stock
1. Product A: 10 units
2. Sell 3 units of Product A
3. Check stock: expected 7

### T10.2 — Oversell attempt
1. Product B: 2 units
2. Attempt to sell 5 units
3. Expected: 400/422 error "Insufficient stock for [product name]"

### T10.3 — Manual stock adjustment — add
1. Product C: 10 units
2. Add 5 units via stock adjust (type: add, reason: "Delivery received")
3. Expected: Stock = 15, `stock_adjustments` record created with `adjustment_type='add'`, `quantity_change=5`, `quantity_before=10`, `quantity_after=15`

### T10.4 — Manual stock adjustment — damage
1. Product D: 20 units
2. Mark 3 as damaged
3. Expected: Stock = 17, `stock_adjustments` record with `adjustment_type='damage'`

### T10.5 — Stock take (bulk update)
1. Count actual stock for 3 products
2. Submit bulk update via Stock Take feature
3. Expected: Each product updated to actual count, `stock_adjustments` records created with `adjustment_type='stock_take'`

---

## TEST GROUP 11: Reporting

### T11.1 — Daily summary
1. Run daily summary for today after making several sales
2. Expected: Correct transaction count, correct total sales

### T11.2 — Gross profit requires cost_price
1. Create a product with no cost_price (or cost_price = 0)
2. Run gross profit report
3. Expected: Gross profit = unit_price × qty (suspicious result — document this risk)

### T11.3 — VAT report
1. Run VAT detail report for today
2. Expected: Each sale shown with VAT amount
3. Verify: sum of VAT amounts matches sum of `sales.vat_amount` in DB

### T11.4 — CSV export
1. Run a report
2. Click CSV export
3. Expected: Download triggers, file contains correct data

### T11.5 — Report date filter
1. Run daily summary with a date range that excludes today
2. Expected: Today's sales NOT shown

---

## TEST GROUP 12: Till Session and Cash-Up

### T12.1 — Open session
1. Navigate to POS, no session open
2. Select till, enter opening balance R500
3. Expected: Session created, POS active

### T12.2 — Prevent second open session
1. With one session open, attempt to open another on the same till
2. Expected: Error "This till already has an open session"

### T12.3 — Cash-up calculation
1. Open session with R500 float
2. Make 3 cash sales totalling R300
3. Navigate to Cash Up
4. Expected: Expected cash = R800 (R500 + R300)

### T12.4 — Denomination entry
1. In Cash Up, enter denominations that total R800
2. Expected: Auto-calculated total shows R800
3. Variance shows R0

### T12.5 — Short till variance
1. Count cash totalling R750 vs expected R800
2. Expected: Variance shown as -R50 (red)

### T12.6 — Close session
1. Submit cash-up with R800 actual cash
2. Expected: Session status = 'closed', variance recorded, new sales blocked

---

## TEST GROUP 13: Multi-Tenant Isolation

### T13.1 — Company data isolation
1. Log in as Company A, create a product "Test-Company-A"
2. Log out, log in as Company B
3. Expected: "Test-Company-A" product NOT visible

### T13.2 — API isolation
1. Log in as Company A, get a sale ID from their data
2. Attempt `GET /api/pos/sales/{company_B_sale_id}` with Company A token
3. Expected: 404 "Sale not found" (or empty — NOT Company B's data)

---

## TEST GROUP 14: Permissions

### T14.1 — Cashier cannot access profit reports
1. Log in as cashier role
2. Attempt to access gross profit report
3. Expected: 403 Forbidden

### T14.2 — Cashier cannot void without manager
1. Log in as cashier
2. Attempt to void a sale without providing `authorized_by_user_id`
3. Expected: 403 error

### T14.3 — Manager can void
1. Log in as manager/store_manager
2. Void a sale with a reason
3. Expected: Success

### T14.4 — Cashier can only see own sessions
1. Log in as cashier
2. `GET /api/pos/sessions`
3. Expected: Only cashier's own sessions returned

---

## TEST GROUP 15: Offline Sync

### T15.1 — Offline sale queued
1. Disable network (DevTools → Network → Offline)
2. Add products to cart, checkout
3. Expected: Sale stored in IndexedDB `offlineSales` store, temporary receipt shown
4. Verify IndexedDB via DevTools: Application → IndexedDB → CheckoutCharliePOS → offlineSales

### T15.2 — Offline indicator
1. Go offline
2. Expected: "Offline Mode" banner visible

### T15.3 — Sync on reconnect
1. With pending offline sale in IndexedDB
2. Re-enable network
3. Expected: Auto-sync runs, success notification shown
4. Verify: Sale now in database `SELECT * FROM sales ORDER BY created_at DESC LIMIT 5`

### T15.4 — Sync failure notification
1. Create an offline sale with a closed till session
2. Go online
3. Expected: Sync attempt, server returns error (session closed), user notified

---

## TEST GROUP 16: Accounting Integration (Future — Once Implemented)

Once accounting integration is built, add tests here for:
- Sale creates journal entry
- Return reverses journal entry
- VAT output correctly credited
- Cash sale creates correct cash account entry
- Card sale creates card clearing entry
- Period lock prevents backdating

---

## Post-Test Checklist

After completing all tests:
- [ ] No orphan sale records (sales without sale_items)
- [ ] No negative stock quantities
- [ ] audit_log has entries for all tested mutations
- [ ] No localStorage keys found other than `token` and `isSuperAdmin`
- [ ] No business data found in IndexedDB after successful sync
