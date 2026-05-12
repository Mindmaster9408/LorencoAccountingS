# 04 — Checkout Charlie: Audit Trail Operational Wiring
**Workstream 1B Implementation**
Date: 2026-05-12

---

## OVERVIEW

This document records the completion of the operational audit wiring for all POS control points. Workstream 1A (doc 03) built the foundation: the `pos_audit_events` table, the `posAuditLogger.js` service, and wiring in `sales.js` and `receipts.js`.

Workstream 1B extends that foundation to cover session management (tills), product management, inventory adjustments, and the authentication flow.

**Constraint respected throughout:** No existing route logic, calculation, cash-up flow, or report was modified. Only `posAuditFromReq` / `logPosEvent` calls were added alongside existing code.

---

## SCHEMA FIX — Migration 028 updated

`company_id` changed from `INTEGER NOT NULL` to `INTEGER` (nullable).

**Why:** `LOGIN_FAILED` events occur before any company is selected. A non-nullable `company_id` would cause the audit insert to silently fail (caught by try/catch), leaving failed login attempts unrecorded — exactly the security events that need capturing.

**Impact on other events:** All non-auth events still supply `company_id` from `req.companyId` or explicit context. The nullable change has no effect on their behaviour.

**Index update:** Two indexes that filtered on `company_id IS NOT NULL` were added as partial indexes to preserve query efficiency while supporting null values. A new partial index on `action_category = 'auth'` covers auth-event queries across all users.

---

## FILES CHANGED

| File | Change |
|---|---|
| `accounting-ecosystem/database/migrations/028_pos_audit_trail_foundation.sql` | company_id nullable; auth index added |
| `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js` | 10 new event constants added |
| `accounting-ecosystem/backend/modules/pos/routes/sessions.js` | Import + 4 new audit events |
| `accounting-ecosystem/backend/modules/pos/routes/products.js` | Import + 5 new audit events |
| `accounting-ecosystem/backend/modules/pos/routes/inventory.js` | Import + 1 new audit event |
| `accounting-ecosystem/backend/shared/routes/auth.js` | Import + 5 new audit events |

---

## EVENT CONSTANTS ADDED TO posAuditLogger.js

| Constant | Category | Description |
|---|---|---|
| `TILL_OPENED` | session | Till session opened (cashier starts shift) |
| `TILL_CLOSED` | session | Till session closed by cashier |
| `CASH_VARIANCE_RECORDED` | session | Non-zero variance between expected and counted |
| `CASHUP_COMPLETED` | session | Manager completes cash-up with denomination counts |
| `PRODUCT_DEACTIVATED` | product | Product soft-deleted (is_active = false) |
| `STOCK_TAKE_COMPLETED` | inventory | Full stock take submitted (route not yet built) |
| `LOGIN_SUCCESS` | auth | User authenticated successfully |
| `LOGIN_FAILED` | auth | Authentication failed (user not found or wrong password) |
| `LOGOUT` | auth | User logged out |
| `COMPANY_SELECTED` | auth | User switched active company context |
| `MANAGER_OVERRIDE_USED` | override | Manager override invoked (route not yet built) |

Legacy aliases (`SESSION_OPENED`, `SESSION_CLOSED`, `POS_LOGIN`, `POS_LOGOUT`) retained for backward compatibility with Workstream 1A wiring.

---

## SESSIONS.JS — EVENTS WIRED

**Route: `POST /api/pos/sessions/open`**

| Event | Trigger | Data captured |
|---|---|---|
| `TILL_OPENED` | After session INSERT confirmed | `till_id`, `till_session_id`, `after_snapshot` (session_id, till_id, opening_balance, status, opened_at) |

**Route: `POST /api/pos/sessions/:id/close`**

| Event | Trigger | Data captured |
|---|---|---|
| `TILL_CLOSED` | After session UPDATE confirmed | `till_id`, `till_session_id`, `before_snapshot` (status, opening_balance), `after_snapshot` (status, expected_balance, closing_balance, variance) |
| `CASH_VARIANCE_RECORDED` | Only when `variance !== null && variance !== 0` | `till_id`, `till_session_id`, `metadata` (expected, closing_balance, variance, stage: 'session_close') |

**Route: `POST /api/pos/sessions/:id/complete-cashup`**

| Event | Trigger | Data captured |
|---|---|---|
| `CASHUP_COMPLETED` | After cash-up UPDATE confirmed | `till_id`, `till_session_id`, `before_snapshot` (status, expected_balance), `after_snapshot` (status, total_counted, variance, counted_cash, counted_card, counted_other) |
| `CASH_VARIANCE_RECORDED` | Only when `variance !== 0` | `till_id`, `till_session_id`, `metadata` (expected, total_counted, variance, stage: 'cashup') |

**Existing logic preserved:**
- `salesTotal` calculation: unchanged
- `expected` balance formula: unchanged
- `variance` calculation: unchanged
- `auditFromReq` → `audit_log` calls: all preserved and unchanged

---

## PRODUCTS.JS — EVENTS WIRED

**Route: `POST /api/pos/products`**

| Event | Trigger | Data captured |
|---|---|---|
| `PRODUCT_CREATED` | After product INSERT confirmed | `product_id`, `after_snapshot` (product_id, product_name, product_code, unit_price, stock_quantity) |

**Route: `PUT /api/pos/products/:id`**

| Event | Trigger | Data captured |
|---|---|---|
| `PRODUCT_PRICE_CHANGED` | When `unit_price` changed (alongside existing `PRICE_CHANGE` audit) | `product_id`, `before_snapshot` (field, value, product_name), `after_snapshot` (field, value) |
| `PRODUCT_PRICE_CHANGED` | When `cost_price` changed (alongside existing `PRICE_CHANGE` audit) | `product_id`, `before_snapshot` (field, value, product_name), `after_snapshot` (field, value) |
| `PRODUCT_UPDATED` | After all updates (always fires for any PUT) | `product_id`, `before_snapshot` (product_name, unit_price, is_active), `after_snapshot` (same), `metadata` (fields_changed) |

**Route: `DELETE /api/pos/products/:id` (soft delete)**

| Event | Trigger | Data captured |
|---|---|---|
| `PRODUCT_DEACTIVATED` | After soft delete UPDATE confirmed | `product_id`, `before_snapshot` ({ is_active: true }), `after_snapshot` ({ is_active: false }) |

**Existing logic preserved:**
- `PRICE_CHANGE` audit to `audit_log`: unchanged
- `UPDATE` audit to `audit_log`: unchanged
- `DELETE` audit to `audit_log`: unchanged
- Soft delete behaviour (is_active = false): unchanged
- All validation and permission checks: unchanged

---

## INVENTORY.JS — EVENTS WIRED

**Route: `POST /api/pos/inventory/adjust`**

| Event | Trigger | Data captured |
|---|---|---|
| `STOCK_ADJUSTED` | After stock update and `inventory_adjustments` INSERT confirmed | `product_id`, `before_snapshot` ({ stock_quantity: oldQty }), `after_snapshot` ({ stock_quantity: newQty }), `metadata` (product_name, quantity_change, reason, adjustment_id, notes) |

**Existing logic preserved:**
- `Math.max(0, oldQty + quantity_change)` floor: unchanged
- `inventory_adjustments` record INSERT: unchanged
- `auditFromReq` → `audit_log`: unchanged
- All validation (product_id, quantity_change, reason required): unchanged

---

## AUTH.JS — EVENTS WIRED

**Route: `POST /api/auth/login` — user not found (401)**

| Event | Trigger | Data captured |
|---|---|---|
| `LOGIN_FAILED` | `if (error \|\| !user)` before returning 401 | `company_id: null`, `user_id: null`, `user_email: loginId`, `metadata` ({ reason: 'user_not_found' }), `ip_address`, `user_agent` |

**Route: `POST /api/auth/login` — wrong password (401)**

| Event | Trigger | Data captured |
|---|---|---|
| `LOGIN_FAILED` | `if (!validPassword)` before returning 401 | `company_id: null`, `user_id: user.id`, `user_email: user.email`, `metadata` ({ reason: 'invalid_password' }), `ip_address`, `user_agent` |

**Route: `POST /api/auth/login` — success**

| Event | Trigger | Data captured |
|---|---|---|
| `LOGIN_SUCCESS` | After existing `auditFromReq` LOGIN call | `company_id: selectedCompany?.id` (null if no companies), `user_id`, `user_email`, `user_role`, `after_snapshot` (companies_available, selected_company_id), `metadata` ({ isSuperAdmin }) |

**Route: `POST /api/auth/logout`**

| Event | Trigger | Data captured |
|---|---|---|
| `LOGOUT` | After existing `auditFromReq` LOGOUT call | `company_id` from JWT token, `user_id`, `user_email`, `user_role` — all extracted by `posAuditFromReq` from `req.user` |

**Route: `POST /api/auth/select-company`**

| Event | Trigger | Data captured |
|---|---|---|
| `COMPANY_SELECTED` | After new token issued, before response | `company_id: parsedCompanyId`, `user_id`, `user_email`, `user_role`, `after_snapshot` (company_id, company_name, role) |

**Implementation pattern for auth events:**

`logPosEvent` is used directly for login events (not `posAuditFromReq`) because `req.user` is not populated on the login route — `authenticateToken` middleware has not run. All user context is extracted directly from the `user` DB object available in scope.

`posAuditFromReq` is used for logout (where `authenticateToken` has run and `req.user` is set).

**Existing logic preserved:**
- `auditFromReq(LOGIN)` → `audit_log`: unchanged
- `auditFromReq(LOGOUT)` → `audit_log`: unchanged
- `auditFromReq(SSO_LAUNCH)` → `audit_log`: unchanged (not touched)
- All JWT signing, company resolution, and role assignment logic: unchanged
- bcrypt comparison and all security checks: unchanged

---

## FULL COVERAGE TABLE — ALL POS AUDIT EVENTS

| Event | Route | Source | Status |
|---|---|---|---|
| `SALE_CREATED` | POST /api/pos/sales | sales.js | ✅ Wired (1A) |
| `SALE_REPLAYED` | POST /api/pos/sales | sales.js | ✅ Wired (1A) |
| `SALE_VOIDED` | POST /api/pos/sales/:id/void | sales.js | ✅ Wired (1A) |
| `SALE_RETURNED` | POST /api/pos/sales/:id/return | sales.js | ✅ Wired (1A) |
| `SALE_STOCK_FAILED` | POST /api/pos/sales (pre-check) | sales.js | ✅ Wired (1A) |
| `SALE_STOCK_FAILED` | POST /api/pos/sales (RPC) | sales.js | ✅ Wired (1A) |
| `SALE_RPC_FAILED` | POST /api/pos/sales | sales.js | ✅ Wired (1A) |
| `RECEIPT_PRINTED` | POST /api/receipts/print/:saleId | receipts.js | ✅ Wired (1A) |
| `TILL_OPENED` | POST /api/pos/sessions/open | sessions.js | ✅ Wired (1B) |
| `TILL_CLOSED` | POST /api/pos/sessions/:id/close | sessions.js | ✅ Wired (1B) |
| `CASH_VARIANCE_RECORDED` | POST /api/pos/sessions/:id/close | sessions.js | ✅ Wired (1B) |
| `CASHUP_COMPLETED` | POST /api/pos/sessions/:id/complete-cashup | sessions.js | ✅ Wired (1B) |
| `CASH_VARIANCE_RECORDED` | POST /api/pos/sessions/:id/complete-cashup | sessions.js | ✅ Wired (1B) |
| `PRODUCT_CREATED` | POST /api/pos/products | products.js | ✅ Wired (1B) |
| `PRODUCT_UPDATED` | PUT /api/pos/products/:id | products.js | ✅ Wired (1B) |
| `PRODUCT_PRICE_CHANGED` | PUT /api/pos/products/:id | products.js | ✅ Wired (1B) |
| `PRODUCT_DEACTIVATED` | DELETE /api/pos/products/:id | products.js | ✅ Wired (1B) |
| `STOCK_ADJUSTED` | POST /api/pos/inventory/adjust | inventory.js | ✅ Wired (1B) |
| `LOGIN_SUCCESS` | POST /api/auth/login | auth.js | ✅ Wired (1B) |
| `LOGIN_FAILED` (not found) | POST /api/auth/login | auth.js | ✅ Wired (1B) |
| `LOGIN_FAILED` (wrong pwd) | POST /api/auth/login | auth.js | ✅ Wired (1B) |
| `LOGOUT` | POST /api/auth/logout | auth.js | ✅ Wired (1B) |
| `COMPANY_SELECTED` | POST /api/auth/select-company | auth.js | ✅ Wired (1B) |

---

## AUDIT GAPS REMAINING

| Event | Why not wired | Recommended action |
|---|---|---|
| `MANAGER_OVERRIDE_USED` | No manager override route exists yet | Wire when Phase 2D manager recovery screen is built |
| `STOCK_TAKE_COMPLETED` | No stock-take route exists | Wire when stock-take feature is built |
| `RECEIPT_DELIVERED` | `/deliver/:saleId` route is a placeholder (no real delivery) | Wire when email/SMS delivery is implemented |
| `SESSION_OPENED` / `SESSION_CLOSED` | Legacy aliases kept but not wired to separate events — `TILL_OPENED` / `TILL_CLOSED` are used instead | No action needed — aliases are for internal documentation only |
| `POS_LOGIN` / `POS_LOGOUT` | Legacy constants from design — superseded by `LOGIN_SUCCESS` / `LOGOUT` | No action needed |
| Till sessions in `audit_log` — missing `till_id` in old events | Pre-existing; sessions route already writes to `audit_log` | Low priority — `pos_audit_events` now has full context |

---

## CONFIRMATION: EXISTING LOGIC NOT MODIFIED

The following were audited and confirmed unchanged:

| Area | Confirmed |
|---|---|
| `salesTotal` calculation in `sessions.js` close route | ✅ Not touched |
| `expected` balance formula (`opening_balance + salesTotal`) | ✅ Not touched |
| Cash-up `variance` formula (`totalCounted - expected_balance`) | ✅ Not touched |
| `auditFromReq` calls in sessions.js (CREATE/UPDATE to audit_log) | ✅ Preserved and unchanged |
| `auditFromReq` PRICE_CHANGE calls in products.js | ✅ Preserved and unchanged |
| `auditFromReq` UPDATE/CREATE/DELETE calls in products.js | ✅ Preserved and unchanged |
| `auditFromReq` UPDATE call in inventory.js | ✅ Preserved and unchanged |
| `auditFromReq` LOGIN/LOGOUT/SSO_LAUNCH in auth.js | ✅ Preserved and unchanged |
| bcrypt password comparison | ✅ Not touched |
| JWT signing and company resolution logic | ✅ Not touched |
| All cash-up screen UI logic | ✅ Not touched (no frontend changes) |
| All report routes (GET endpoints) | ✅ Not touched |

---

## VERIFICATION CHECKLIST

Run each scenario after deploying migration 028 and the updated backend:

| Check | SQL to verify |
|---|---|
| TILL_OPENED fires on session open | `SELECT * FROM pos_audit_events WHERE action_type = 'TILL_OPENED' ORDER BY created_at DESC LIMIT 3;` |
| TILL_CLOSED fires on session close | `SELECT * FROM pos_audit_events WHERE action_type = 'TILL_CLOSED' ORDER BY created_at DESC LIMIT 3;` |
| CASH_VARIANCE_RECORDED fires only when variance ≠ 0 | Close a till with a known variance; query for the event |
| CASHUP_COMPLETED fires on cash-up | `SELECT * FROM pos_audit_events WHERE action_type = 'CASHUP_COMPLETED' ORDER BY created_at DESC LIMIT 3;` |
| PRODUCT_PRICE_CHANGED fires only when price changes | Edit product with/without price change; confirm conditional firing |
| PRODUCT_DEACTIVATED fires on soft delete | Delete a product; `SELECT * FROM pos_audit_events WHERE action_type = 'PRODUCT_DEACTIVATED' ORDER BY created_at DESC LIMIT 1;` |
| STOCK_ADJUSTED fires on manual adjustment | `SELECT * FROM pos_audit_events WHERE action_type = 'STOCK_ADJUSTED' ORDER BY created_at DESC LIMIT 3;` |
| LOGIN_SUCCESS fires on login | `SELECT * FROM pos_audit_events WHERE action_type = 'LOGIN_SUCCESS' ORDER BY created_at DESC LIMIT 3;` |
| LOGIN_FAILED fires on wrong password | Login with bad password; check `company_id IS NULL, metadata->>'reason' = 'invalid_password'` |
| LOGIN_FAILED fires on unknown user | Login with unknown email; check `user_id IS NULL, metadata->>'reason' = 'user_not_found'` |
| LOGOUT fires on logout | `SELECT * FROM pos_audit_events WHERE action_type = 'LOGOUT' ORDER BY created_at DESC LIMIT 3;` |
| COMPANY_SELECTED fires on company switch | Select a company from the selector; query for the event |
| Audit failure does not break operations | Temporarily rename `pos_audit_events` table; confirm all routes still respond correctly |

---

## DEPLOYMENT STEPS

1. Run migration 028 (if not already run from Workstream 1A):
   ```sql
   -- Paste contents of: accounting-ecosystem/database/migrations/028_pos_audit_trail_foundation.sql
   ```
   If migration was already run with the original NOT NULL constraint, alter the column:
   ```sql
   ALTER TABLE pos_audit_events ALTER COLUMN company_id DROP NOT NULL;
   CREATE INDEX IF NOT EXISTS idx_pos_audit_auth
       ON pos_audit_events (action_category, created_at DESC)
       WHERE action_category = 'auth';
   ```

2. Deploy backend — all changes are in existing route files and the `posAuditLogger.js` service.

3. No frontend changes required for Workstream 1B.

---

*Workstream 1A: foundation table + sales/receipt wiring — ✅ implemented (doc 03)*
*Workstream 1B: sessions, products, inventory, auth wiring — ✅ implemented (this doc)*
*Next: Phase 2D — manager recovery screen (per-record conflict view, resolution actions)*
*Next: Workstream 1C (future) — wire MANAGER_OVERRIDE_USED, STOCK_TAKE_COMPLETED, RECEIPT_DELIVERED when those routes are built*
