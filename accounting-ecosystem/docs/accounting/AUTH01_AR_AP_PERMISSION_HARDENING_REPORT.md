# AUTH-01 — AR/AP Permission Hardening Report

**Date:** 2026-05-27  
**Source audit:** `docs/accounting/AR_AP_PERMISSIONS_AND_ATOMICITY_AUDIT.md` (risk ID: AUTH-01)  
**Status:** FIXED ✅

---

## 1. Summary

`customer-invoices.js` had zero authentication or permission middleware — any authenticated ECO user could hit all GL-affecting AR routes. `suppliers.js` had partial protection using a single coarse `ap.manage` key on two routes, and crucially: `hasPermission` was called without `authenticate` first, meaning the ECO→Lorenco role mapping never ran. This silently blocked `super_admin`, `business_owner`, and `administrator` ECO roles from those routes (since raw ECO role names like `'super_admin'` are not in the `['admin', ...]` Lorenco allow-list).

Both files are now fully protected with granular per-route `authenticate, hasPermission(...)` pairs, and 13 new permission keys have been added to the accounting PERMISSIONS map.

---

## 2. Risks Addressed

| Risk ID | Description | Severity |
|---------|-------------|----------|
| AUTH-01-A | `customer-invoices.js` — zero auth middleware; any ECO user can POST invoices, POST payments, POST /:id/post to GL | CRITICAL |
| AUTH-01-B | `suppliers.js` — 15 of 17 routes had no permission check; unauthenticated-equivalent access | HIGH |
| AUTH-01-C | `hasPermission('ap.manage')` on 2 routes without `authenticate` — breaks role mapping; super_admin / business_owner / administrator silently 403'd from their own routes | HIGH |
| AUTH-01-D | No granular AR permissions existed — impossible to give viewers read-only access or restrict posting to accountant+ | MEDIUM |

---

## 3. Root Cause

The accounting module has its own `authenticate` middleware (in `modules/accounting/middleware/auth.js`) that maps ECO JWT roles to the four Lorenco roles (`admin`, `accountant`, `bookkeeper`, `viewer`). `hasPermission` depends on this mapping having run first because it checks `req.user.role` against its allow-lists.

**Without `authenticate`:**
- `req.user.role` = raw ECO role (e.g., `'super_admin'`, `'business_owner'`)
- These strings are NOT in any allow-list (which uses `'admin'`, not `'super_admin'`)
- Result: admin-level users get 403 on the two protected supplier routes
- All unprotected routes: fully open to anyone who passed ECO's global auth

**With `authenticate` + `hasPermission`:**
- `authenticate` maps `super_admin/business_owner/administrator` → `'admin'`
- `'admin'` is in every allow-list
- Role-based restrictions work correctly for all four Lorenco roles

---

## 4. Files Changed

| File | Change |
|------|--------|
| `backend/modules/accounting/middleware/auth.js` | Added 13 new granular AR/AP permission keys to PERMISSIONS map. `ap.manage` retained for backward compatibility. |
| `backend/modules/accounting/routes/customer-invoices.js` | Added `authenticate` import. Added `authenticate, hasPermission(...)` to all 9 routes. |
| `backend/modules/accounting/routes/suppliers.js` | Updated import to include `authenticate`. Added `authenticate, hasPermission(...)` to 15 previously-unprotected routes. Migrated 2 existing `hasPermission('ap.manage')` calls to `authenticate, hasPermission('ap.invoice.create')`. |
| `backend/tests/auth01-ar-ap-permissions.test.js` | New — 49 tests covering all roles, all new keys, role mapping, company scope. |

**Files NOT changed:**
- All business logic (VAT calc, GL posting, reversal, line processing) — untouched
- All company scoping via `req.companyId` — unchanged and verified
- JournalService — untouched
- Bank, reports, payroll — untouched

---

## 5. New Permission Keys

All keys added to `accounting/middleware/auth.js` PERMISSIONS map:

| Key | Allowed Roles | Used On |
|-----|---------------|---------|
| `ar.invoice.view` | admin, accountant, bookkeeper, viewer | GET customer-invoices routes |
| `ar.invoice.create` | admin, accountant, bookkeeper | POST / (create AR invoice) |
| `ar.invoice.edit` | admin, accountant, bookkeeper | PUT /:id |
| `ar.invoice.post` | admin, accountant | POST /:id/post |
| `ar.invoice.void` | admin, accountant | POST /:id/void |
| `ar.payment.record` | admin, accountant, bookkeeper | POST /payments |
| `ap.invoice.view` | admin, accountant, bookkeeper, viewer | GET supplier routes |
| `ap.invoice.create` | admin, accountant, bookkeeper | POST /invoices, POST /orders, POST / (supplier), POST /invoices/ocr |
| `ap.invoice.edit` | admin, accountant, bookkeeper | PUT /invoices/:id, PUT /:id (supplier) |
| `ap.invoice.void` | admin, accountant | (available for future void route) |
| `ap.payment.record` | admin, accountant, bookkeeper | POST /payments |
| `ap.purchase_order.approve` | admin, accountant | PUT /orders/:id/status |

---

## 6. Route Protection Map (Full)

### `customer-invoices.js` (all routes — previously 0 protected)

| Route | Permission |
|-------|-----------|
| `GET /customers` | `ar.invoice.view` |
| `GET /` | `ar.invoice.view` |
| `GET /:id` | `ar.invoice.view` |
| `POST /` | `ar.invoice.create` |
| `PUT /:id` | `ar.invoice.edit` |
| `POST /:id/post` | `ar.invoice.post` |
| `POST /:id/void` | `ar.invoice.void` |
| `POST /payments` | `ar.payment.record` |
| `GET /aging` | `ar.invoice.view` |

### `suppliers.js` (17 routes — previously 2 protected with broken role mapping)

| Route | Before | After |
|-------|--------|-------|
| `GET /stats` | none | `ap.invoice.view` |
| `GET /` | none | `ap.invoice.view` |
| `POST /` | none | `ap.invoice.create` |
| `GET /invoices` | none | `ap.invoice.view` |
| `POST /invoices` | `ap.manage` (no authenticate) | `ap.invoice.create` ✓ |
| `GET /invoices/:id` | none | `ap.invoice.view` |
| `PUT /invoices/:id` | none | `ap.invoice.edit` |
| `GET /orders` | none | `ap.invoice.view` |
| `POST /orders` | none | `ap.invoice.create` |
| `GET /orders/:id` | none | `ap.invoice.view` |
| `PUT /orders/:id/status` | none | `ap.purchase_order.approve` |
| `GET /payments` | none | `ap.invoice.view` |
| `POST /payments` | none | `ap.payment.record` |
| `GET /aging` | none | `ap.invoice.view` |
| `GET /:id` | none | `ap.invoice.view` |
| `PUT /:id` | none | `ap.invoice.edit` |
| `POST /invoices/ocr` | `ap.manage` (no authenticate) | `ap.invoice.create` ✓ |

---

## 7. Role Matrix (After Fix)

| Action | viewer | bookkeeper | accountant | admin |
|--------|--------|-----------|-----------|-------|
| View AR/AP invoices, aging, payments | ✓ | ✓ | ✓ | ✓ |
| Create AR/AP invoice drafts | ✗ | ✓ | ✓ | ✓ |
| Edit AR/AP invoice drafts | ✗ | ✓ | ✓ | ✓ |
| Post AR invoice to GL | ✗ | ✗ | ✓ | ✓ |
| Void AR invoice (with GL reversal) | ✗ | ✗ | ✓ | ✓ |
| Record AR/AP payments (GL + allocation) | ✗ | ✓ | ✓ | ✓ |
| OCR invoice scan | ✗ | ✓ | ✓ | ✓ |
| Approve PO status transitions | ✗ | ✗ | ✓ | ✓ |
| Create/edit supplier master records | ✗ | ✓ | ✓ | ✓ |

---

## 8. ECO Role → Lorenco Role Mapping (Relevant Extract)

| ECO Role | Lorenco Role (after authenticate) |
|----------|----------------------------------|
| super_admin | admin |
| business_owner | admin |
| practice_manager | admin |
| administrator | admin |
| partner | admin |
| accountant | accountant |
| manager | accountant |
| bookkeeper | bookkeeper |
| cashier | bookkeeper |
| employee | viewer |
| readonly | viewer |
| viewer | viewer |

**Pre-fix defect:** Without `authenticate` running first, raw ECO role `'super_admin'` was checked against `['admin', 'accountant', 'bookkeeper']` and rejected. Super admins were silently 403'd from the two previously-protected supplier routes. Now all roles map correctly.

---

## 9. Tests Run

**Test file:** `backend/tests/auth01-ar-ap-permissions.test.js`

```
PASS tests/auth01-ar-ap-permissions.test.js
  AUTH-01 — AR/AP Permission Hardening
    TEST-AUTH-01: Viewer cannot create AR invoices
      ✓ returns 403 for viewer on ar.invoice.create
    TEST-AUTH-02: Viewer cannot post AR invoices
      ✓ returns 403 for viewer on ar.invoice.post
    TEST-AUTH-03: Viewer cannot void AR invoices
      ✓ returns 403 for viewer on ar.invoice.void
    TEST-AUTH-04: Viewer can view AR invoices
      ✓ returns 200 for viewer on ar.invoice.view
    TEST-AUTH-05: Bookkeeper can create AR invoice drafts
      ✓ returns 200 for bookkeeper on ar.invoice.create
    TEST-AUTH-06: Bookkeeper cannot post AR invoices
      ✓ returns 403 for bookkeeper on ar.invoice.post
    TEST-AUTH-07: Bookkeeper cannot void AR invoices
      ✓ returns 403 for bookkeeper on ar.invoice.void
    TEST-AUTH-08: Accountant can post AR invoices
      ✓ returns 200 for accountant on ar.invoice.post
    TEST-AUTH-09: Accountant can void AR invoices
      ✓ returns 200 for accountant on ar.invoice.void
    TEST-AUTH-10: Admin (super_admin ECO role) passes all permissions after role mapping
      ✓ super_admin passes ar.invoice.view (×12 permission keys)
      ✓ business_owner maps to admin and passes ar.invoice.post
      ✓ administrator maps to admin and passes ap.purchase_order.approve
    TEST-AUTH-11: Payment routes require ar.payment.record / ap.payment.record
      ✓ viewer cannot record AR payment
      ✓ viewer cannot record AP payment
      ✓ bookkeeper can record AR payment
      ✓ bookkeeper can record AP payment
      ✓ accountant can record AR payment
    TEST-AUTH-12: OCR / AP invoice create requires ap.invoice.create
      ✓ viewer cannot create AP invoices or use OCR
      ✓ bookkeeper can create AP invoices (and use OCR)
      ✓ accountant can create AP invoices
    TEST-AUTH-13: PO status approval requires accountant or admin
      ✓ viewer cannot approve PO status
      ✓ bookkeeper cannot approve PO status
      ✓ accountant can approve PO status
      ✓ admin can approve PO status
    TEST-AUTH-14: Company scope unaffected — companyId preserved through authenticate
      ✓ authenticate preserves req.companyId on req.user.companyId
    TEST-AUTH-15: Unknown permission key returns 403 (not silent pass)
      ✓ hasPermission with unknown key returns 403
    TEST-AUTH-16: All new permission keys are present in PERMISSIONS map
      ✓ PERMISSIONS has key: ar.invoice.view (×12 keys)

Tests: 49 passed, 49 total
```

---

## 10. Remaining Risks

| ID | Risk | Severity | Status |
|----|------|----------|--------|
| AUTH-01-R1 | `GET /aging` in `customer-invoices.js` is registered after `GET /:id`, so requests to `/aging` will be matched by the `/:id` handler (Express route ordering). This is a pre-existing bug outside AUTH-01 scope — `parseInt('aging')` returns `NaN` so the aging response returns a 500. The permission layer now correctly blocks unauthorized access, but the route itself is broken by ordering. | LOW | Pre-existing — not in scope |
| AUTH-01-R2 | `ap.invoice.void` permission key is defined but no explicit void route exists for supplier invoices (`PUT /invoices/:id` with `status: 'cancelled'` is the current pattern). The key is available for future use when a dedicated void route is added. | LOW | Key defined, ready for use |

---

## Final Safety Check

- [x] All 9 AR routes protected with appropriate granular permissions
- [x] All 17 AP routes protected with appropriate granular permissions
- [x] `authenticate` runs before `hasPermission` on all routes — role mapping is correct
- [x] Super admin, business owner, administrator ECO roles correctly map to `admin` Lorenco role
- [x] Viewer can view but cannot create/post/void/pay
- [x] Bookkeeper can create drafts and record payments but cannot post or void
- [x] Accountant can post and void
- [x] Admin has all permissions
- [x] `ap.manage` retained in PERMISSIONS map for backward compatibility
- [x] Company scoping via `req.companyId` unchanged
- [x] All VAT, GL, reversal business logic untouched
- [x] Unknown permission key returns 403 (pre-existing hardening — unchanged)
