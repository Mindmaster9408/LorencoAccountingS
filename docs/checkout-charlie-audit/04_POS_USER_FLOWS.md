# 04 — POS User Flows

This document traces the real user journeys through the POS system, following actual code behaviour.

---

## Flow 1: Cashier Logs In

1. Cashier opens POS app in browser (`/`)
2. Login screen shows: username + password fields
3. `login()` calls `POST /api/auth/login`
4. Server returns JWT + list of accessible companies
5. If user has **multiple companies**: company selector screen shows
6. If user has **one company**: auto-selects, calls `POST /api/auth/select-company`
7. `select-company` returns a new JWT with `companyId` embedded
8. `localStorage.setItem('token', token)` — persisted for page refresh survival
9. `completeLogin()` runs: loads products, till list, initializes POS UI

**Role-based UI:** If `role === 'cashier'`, certain menu items and buttons are hidden. Void, Return, Price Override all require manager authorization.

---

## Flow 2: Cashier Opens a Till Session

1. Navigate to Till tab (default on login)
2. If no open session: "Open Session" prompt appears
3. Cashier selects till from list (loaded via `GET /api/pos/tills`)
4. Enters opening balance (cash float)
5. `POST /api/pos/sessions/open` → `{ tillId, openingBalance }`
6. Server checks: till belongs to this company, no existing open session for this till
7. Creates `till_sessions` record with `status = 'open'`, `opening_balance`
8. Returns session object → stored in `currentSession` JS variable
9. POS till tab becomes active for sales

**Guard:** If the till already has an open session, server returns 400. One till can have only one open session at a time.

---

## Flow 3: Adding Products to Cart

### By product grid
1. Products loaded on login: `GET /api/pos/products` → stored in `products[]`
2. Category filter rendered from unique categories
3. Click product card → `addToCart(productId, 1)`
4. If `groupSameItems` setting enabled: duplicate products increment existing cart item quantity
5. Cart re-renders with new totals

### By barcode scan
1. Barcode scanner fires input event on scan field
2. `products.find(p => p.barcode === scannedBarcode)` looked up in local `products[]`
3. If found: `addToCart(product.id, 1)`
4. If not found: Sean AI lookup attempted → `POST /api/sean/learn/interaction`

### Cart total calculation (frontend)
```javascript
subtotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
vat = cart.reduce((sum, item) => sum + (item.requires_vat ? item.vatAmount : 0), 0)
// Note: VAT calculation logic is in the frontend — the backend recalculates independently
```

---

## Flow 4: Processing a Cash Sale

1. Cart has items
2. Cashier clicks CASH button
3. Input field for "Amount Tendered" appears
4. Change = tendered − total (calculated in frontend)
5. Cashier clicks "Checkout"
6. `POST /api/pos/sales` with `{ tillSessionId, items: [{productId, quantity}], paymentMethod: 'CASH' }`
7. Server validates → creates sale → decrements stock → records payment
8. Receipt modal shown with sale details
9. Cart cleared

---

## Flow 5: Processing a Split Payment

1. Cart has items
2. Cashier clicks SPLIT button → split payment modal opens
3. Remaining balance shown
4. Cashier allocates amounts: e.g., R100 CASH + R50 CARD
5. "Add payment" for each method
6. When total allocated ≥ sale total → Checkout enabled
7. `POST /api/pos/sales/split-payment` with `payments: [{method: 'CASH', amount: 100}, {method: 'CARD', amount: 50}]`
8. Server validates total matches (1-cent tolerance in ecosystem, exact match required in legacy)
9. Each payment stored separately in `sale_payments` table

---

## Flow 6: Account Customer Sale

1. Cashier selects ACCOUNT payment method
2. Customer search modal opens
3. Search by name/phone/email → `GET /api/customers/search?query=...`
4. Customer selected → `customer.current_balance` checked
5. If balance within `credit_limit`: allowed
6. Sale posted with `customerId` in payload
7. `customer_account_transactions` record inserted with the balance

---

## Flow 7: Processing a Return

1. Manager navigates to sale search
2. Finds original sale: `GET /api/pos/sales/search?sale_number=...`
3. Selects items to return + quantities
4. Enters return reason
5. Cashier requires manager authorization: `authorized_by_user_id` must be provided
6. `POST /api/pos/sales/:id/return` with `{ items, reason, authorized_by_user_id }`
7. Server validates: items were in original sale, return qty ≤ original qty
8. Creates `sale_returns` + `sale_return_items` records
9. Stock restored: `UPDATE products SET stock_quantity = stock_quantity + ?`
10. Audit log entry created

---

## Flow 8: Voiding a Sale

1. Manager opens sale from session sales list or search
2. Clicks Void
3. Must provide void reason
4. `POST /api/pos/sales/:id/void` (requires `POS.VOID_SALE` permission)
5. Server: verifies sale is not already voided, sets `status = 'voided'`, records `voided_at`, `voided_by`, `void_reason`
6. **Note: Stock is NOT automatically restored on void in legacy** — only returns restore stock
7. Audit log entry created

---

## Flow 9: Processing a Daily Discount

1. Authorized user (has `POS.APPLY_DISCOUNT` permission) opens Stock tab
2. Selects "Daily Discounts" section
3. Selects product, enters discount price, optional reason and end date
4. `POST /api/pos/daily-discounts` → inserts `product_daily_discounts` record
5. Next time products load: `GET /api/pos/products/with-discounts` returns active discounts
6. Cart uses `effectivePrice = item.overridePrice || product.unit_price` — discount price shown to cashier

---

## Flow 10: Cash-Up / Closing the Till

1. Cashier (or manager) navigates to Cash Up tab
2. Current open session loaded
3. All sales for the session fetched
4. Expected cash = `opening_balance + sum(cash_sale totals)`
5. Cashier counts physical cash using denomination entry UI (R200, R100, R50, ...)
6. App auto-totals from denomination counts
7. Variance = actual_cash_count - expected_balance
   - Positive variance = over (more cash than expected) — shown in green
   - Negative variance = short (less cash than expected) — shown in red
8. Cashier enters notes if applicable
9. Clicks "Close Session"
10. `POST /api/pos/sessions/:id/close` with `{ closingBalance, expectedBalance, variance, notes }`
11. Server: verifies session is open, updates status to 'closed', records all values
12. Session archived, new session required to continue selling

---

## Flow 11: Manager Authorizes a Price Override

1. During a sale, cashier clicks "Price Override" on a cart item
2. Override price entered
3. Manager authorization required: manager enters their credentials or pin
4. `POST /api/pos/price-override` → `{ product_id, original_price, override_price, reason, authorized_by_user_id }`
5. Server verifies: `authorized_by_user_id` has role `admin/business_owner/accountant`
6. Override recorded in `price_overrides` table
7. Cart item uses override price for the sale

---

## Flow 12: Stock Adjustment (Manual)

1. Authorized user (requires `STOCK.ADJUST`) opens Stock tab
2. Selects product
3. Selects adjustment type: add / remove / set / damage / theft / return
4. Enters quantity and reason
5. `POST /api/pos/stock/adjust` → `{ product_id, adjustment_type, quantity, reason, reference_number }`
6. Server calculates `quantity_before`, `quantity_after`, validates not below zero
7. `UPDATE products SET stock_quantity = ?`
8. `INSERT stock_adjustments` record with full audit trail (before, after, type, reason, who)

---

## Flow 13: Viewing Reports

1. Authorized user navigates to Reports tab
2. Selects report type: Gross Profit / By Person / By Product / VAT / Daily Summary / etc.
3. Selects date range (from/to)
4. `GET /api/reports/sales/gross-profit?startDate=...&endDate=...`
5. Server queries `sales JOIN sale_items JOIN products JOIN users` with date filter
6. Returns aggregated data + summary totals
7. CSV export available (data serialised to CSV client-side)

**Permission gates:**
- `REPORTS.SALES` — sales audit trail, daily summary
- `REPORTS.PROFIT` — gross profit reports (cost_price visible)
- `REPORTS.VAT` — VAT reports

---

## Flow 14: Offline Sale (Cashier Loses Internet)

1. Browser fires `offline` event → `isOnline = false`
2. "Offline Mode" banner appears
3. Cashier completes sale as normal
4. On Checkout: `fetch('/api/pos/sales', ...)` fails with NetworkError
5. `saveOfflineSale(saleData)` → stores full sale object in IndexedDB `offlineSales` store
6. `tempSaleNumber = 'OFFLINE-' + Date.now()` assigned
7. Receipt modal shows temporary offline sale number
8. Cart clears
9. When connectivity restored: `online` event fires → `syncOfflineSales()` runs
10. Each pending sale POSTed to server: `POST /api/pos/sales`
11. On success: `markSaleSynced(tempId, serverSaleId)` — marked synced in IndexedDB
12. **Stock decrement only happens on server after sync — not during offline period**

---

## Flow 15: Switching Between Companies/Locations

1. User opens company/location switcher
2. `GET /api/auth/companies` — lists all accessible companies
3. User selects a different company
4. `POST /api/auth/select-company` → new JWT with new `companyId`
5. All state cleared: products, cart, current session, customers
6. Fresh load for new company context

This flow is critical for multi-location setups where one user manages several stores.
