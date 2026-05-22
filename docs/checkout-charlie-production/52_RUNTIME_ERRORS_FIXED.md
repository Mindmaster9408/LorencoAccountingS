# 52 — Runtime Errors Fixed: Customer 404 + authToken ReferenceError

**Module:** Checkout Charlie POS (`frontend-pos/index.html`)  
**Date:** 2026-05  
**Status:** FIXED  
**Governing standard:** CLAUDE.md Part A (audit before change), Part D (no browser storage for business data), Part E (Paytime stability lock — not affected by this change)

---

## Errors Fixed

### BUG 1 — `404: api/customers` (DELETE and other missing endpoints)

**Symptom:** Browser console showed 404 errors when performing customer management operations in the POS settings panel.

**Root cause:**
The POS frontend was calling `${API_URL}/customers/*` (the shared customers route at `/api/customers`) for all customer operations. The shared route does **not** have a `DELETE /:id` handler — so `deleteCustomer()` always returned 404. The POS module route at `/api/pos/customers` has a full CRUD implementation including soft-delete, permission gates (`CUSTOMERS.EDIT`), and proper audit trail.

Additionally, the account history endpoint `GET /api/customers/:id/account` on the shared route returns `{ account: { current_balance, credit_limit } }` with no `transactions` array — the frontend expected `{ transactions, balance, customer }` which is what the POS-module route returns, meaning the account transaction history panel was always showing "No account transactions yet" despite data existing.

**Backend route comparison:**

| Endpoint | Shared `/api/customers` | POS `/api/pos/customers` |
|---|---|---|
| `GET /` | ✅ | ✅ |
| `GET /search?q=` | ✅ dedicated `/search` path | ❌ use `?search=` on `GET /` instead |
| `GET /:id` | ✅ | ✅ |
| `POST /` | ✅ | ✅ |
| `PUT /:id` | ✅ | ✅ with `requirePermission('CUSTOMERS.EDIT')` |
| `DELETE /:id` | ❌ NOT PRESENT | ✅ soft-delete with audit trail |
| `GET /:id/account` | ✅ balance only (no transactions) | ✅ balance + full transaction history |
| `POST /:id/account/payment` | ✅ simple balance update | ✅ balance update + `customer_account_transactions` insert |
| `GET /:id/loyalty` | ✅ | ❌ |
| `POST /:id/loyalty/earn` | ✅ | ❌ |
| `POST /:id/loyalty/redeem` | ✅ | ❌ |

---

### BUG 2 — `ReferenceError: authToken is not defined`

**Symptom:** Opening the Add Product modal crashed with a ReferenceError. The product code auto-generation silently failed.

**Root cause:**  
`generateProductCode()` (called from `showAddProduct()`) used `authToken` as the bearer token variable. `authToken` was never declared in `index.html`. Throughout the entire file, the auth token is stored in the outer-scope `let token = null` (line 3528). `authToken` was a stale legacy name from an earlier refactor, retained by accident in one location.

---

## Changes Applied to `accounting-ecosystem/frontend-pos/index.html`

### Bug 2 Fix

| Location | Old | New |
|---|---|---|
| `generateProductCode()` ~line 5994 | `` `Bearer ${authToken}` `` | `` `Bearer ${token}` `` |

### Bug 1 Fixes — Customer Path Corrections

| Function | Context | Old Path | New Path |
|---|---|---|---|
| `searchAccountCustomers()` | Checkout — account payment customer search | `/customers/search?q=` | `/pos/customers?search=` |
| `loadCustomers()` | Settings — customer list | `/customers${query}` | `/pos/customers${query}` |
| `editCustomer(id)` | Settings — load customer for editing | `/customers/${id}` | `/pos/customers/${id}` |
| `saveCustomer()` | Settings — create customer (POST) | `/customers` | `/pos/customers` |
| `saveCustomer()` | Settings — update customer (PUT) | `/customers/${currentCustomerId}` | `/pos/customers/${currentCustomerId}` |
| `deleteCustomer(id)` | Settings — delete customer | `DELETE /customers/${id}` | `DELETE /pos/customers/${id}` ← **FIXES 404** |
| `searchCustomers()` | Settings — search customers | `/customers/search?q=` | `/pos/customers?search=` |
| `showCustomerDetail(customerId)` | Customer detail modal | `/customers/${customerId}` | `/pos/customers/${customerId}` |
| `loadCustomerAccountHistory(customerId)` | Customer detail — account tab | `/customers/${customerId}/account` | `/pos/customers/${customerId}/account` |
| `recordAccountPayment(customerId)` | Customer detail — record payment | `/customers/${customerId}/account/payment` | `/pos/customers/${customerId}/account/payment` |

### Account History Field Mapping Fix (part of Bug 1)

`loadCustomerAccountHistory()` was reading `data.current_balance` and `data.credit_limit` from the root of the response. The POS route returns `{ customer, balance, transactions }`. After switching to the POS route:

| Field | Before | After |
|---|---|---|
| Balance display | `data.current_balance` → `undefined` → `R 0.00` | `data.balance` → correct value |
| Credit limit display | `data.credit_limit` → `undefined` → `R 0.00` | `data.customer?.credit_limit` → correct value |
| Transaction history | `data.transactions` → `[]` (empty, shared route returns no transactions) | `data.transactions` → full history array |

---

## Intentionally Kept on Shared Route `/api/customers`

The following loyalty endpoints are **only** implemented in the shared customers route. The POS module route has no loyalty handlers. These calls correctly remain on `/api/customers`:

| Function | URL kept | Reason |
|---|---|---|
| `loadCustomerLoyaltyHistory(customerId)` | `GET /api/customers/:id/loyalty` | Only in shared route |
| `earnLoyaltyPoints(customerId)` | `POST /api/customers/:id/loyalty/earn` | Only in shared route |
| `redeemLoyaltyPoints(customerId)` | `POST /api/customers/:id/loyalty/redeem` | Only in shared route |

---

## Search Endpoint Note

The shared route has a dedicated `GET /search` path (e.g. `/api/customers/search?q=`). The POS module route does not have `/search` — instead, it uses a `?search=` query parameter on `GET /` (e.g. `/api/pos/customers?search=`). Both return `{ customers: [...] }` in the same shape.

Both `searchCustomers()` (settings panel) and `searchAccountCustomers()` (checkout panel) were updated from `/customers/search?q=` to `/pos/customers?search=`.

---

## Verification Checklist

- [x] Zero occurrences of `authToken` in `index.html` (grep confirmed)
- [x] Only 3 remaining `${API_URL}/customers` calls — all three are the intentionally-preserved loyalty endpoints (lines 11462, 11546, 11568)
- [x] `deleteCustomer()` now routes to `/api/pos/customers/:id` which has the DELETE handler
- [x] `loadCustomerAccountHistory()` now uses POS route — returns `transactions` array correctly
- [x] Account balance and credit limit display fixed (`data.balance`, `data.customer?.credit_limit`)
- [x] `recordAccountPayment()` now creates a `customer_account_transactions` row via the POS route (better audit trail)
- [x] `searchAccountCustomers()` (checkout) uses correct POS search query param format
- [x] Auth token (`token`) is the correct outer-scope variable throughout all fixed functions
- [x] No `localStorage`/`sessionStorage` introduced for business data (Rule D1 — compliant)
- [x] No `zbpack.json` created (Rule C1 — compliant)
- [x] No payroll files touched (Part E — stable)

---

## Files Changed

| File | Lines affected |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | ~5321, ~5994, ~7479, ~7558, ~7641, ~7669, ~7696, ~11356, ~11491 (URL + field mapping), ~11590 |

No backend files changed. Both `/api/customers` (shared) and `/api/pos/customers` (POS module) routes continue to exist unchanged. The fix is entirely on the frontend routing level.
