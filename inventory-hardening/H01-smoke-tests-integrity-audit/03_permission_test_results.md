# H01 — Permission Test Results

**Method:** Code-level role matrix verification
**Date:** 2026-05-30

**Note:** Live multi-role user testing is BLOCKED (only one test user available in toolchain context). Results are derived from code analysis of the permission matrix and middleware.

---

## Permission System Architecture

- JWT contains `role` per company (set at login/company-select)
- `requirePermission('CATEGORY.ACTION')` middleware checks `hasPermission(role, category, action)`
- Denial returns `403 { error: 'Insufficient permissions', required: '...', userRole: '...' }`
- `requireCompany` blocks any request without company context (added CB11)

---

## PT-01: View permission — who can see items

**Permission:** `INVENTORY.VIEW`
**Allowed roles:** SUPERVISOR_ROLES = management + leave_admin + assistant_manager + shift_supervisor

| Role | Expected | Verified |
|---|---|---|
| store_manager (70) | ✓ ALLOW | ✓ In SUPERVISOR_ROLES |
| assistant_manager (50) | ✓ ALLOW | ✓ In SUPERVISOR_ROLES |
| shift_supervisor (40) | ✓ ALLOW | ✓ In SUPERVISOR_ROLES |
| cashier (20) | ✗ DENY | ✓ Not in SUPERVISOR_ROLES |
| trainee (5) | ✗ DENY | ✓ Not in SUPERVISOR_ROLES |

**Result: ✓ PASS**

---

## PT-02: Receive stock — who can receive

**Permission:** `INVENTORY.RECEIVE`
**Allowed:** management + assistant_manager + shift_supervisor

| Role | Expected | Verified |
|---|---|---|
| store_manager (70) | ✓ ALLOW | ✓ In MANAGEMENT_ROLES |
| assistant_manager (50) | ✓ ALLOW | ✓ Explicitly included |
| shift_supervisor (40) | ✓ ALLOW | ✓ Explicitly included |
| cashier (20) | ✗ DENY | ✓ Not in RECEIVE roles |

**Result: ✓ PASS**

---

## PT-03: Manual stock adjustment — who can adjust

**Permission:** `INVENTORY.ADJUST`
**Allowed:** MANAGEMENT_ROLES only (store_manager and above)

| Role | Expected | Verified |
|---|---|---|
| store_manager (70) | ✓ ALLOW | ✓ In MANAGEMENT_ROLES |
| assistant_manager (50) | ✗ DENY | ✓ Not in MANAGEMENT_ROLES |
| shift_supervisor (40) | ✗ DENY | ✓ Not in MANAGEMENT_ROLES |

Also applies to: `POST /reservations/manual-hold` (H01 fix).

**Result: ✓ PASS**

---

## PT-04: Cost view — who can see costs/valuation

**Permission:** `INVENTORY.COST_VIEW`
**Allowed:** MANAGEMENT_ROLES only (store_manager and above)

**Protected routes:**
- `GET /reports/stock-valuation`
- `GET /reports/cost-history/:itemId`
- `GET /reports/valuation-movements`
- `GET /reports/work-order-cost-summary`
- `GET /reports/supplier-history`
- `GET /reports/wastage`
- `GET /reports/yield-variance`
- `GET /boms/:id/cost-summary`
- `GET /work-orders/:id/cost-summary`
- `GET /procurement/supplier-history` (H01 fix)
- `GET /production/yield-report`
- `GET /production/wastage-report`
- `GET /production/variance-report`

| Role | Expected | Verified |
|---|---|---|
| store_manager (70) | ✓ ALLOW | ✓ In MANAGEMENT_ROLES |
| assistant_manager (50) | ✗ DENY | ✓ Not in MANAGEMENT_ROLES |
| shift_supervisor (40) | ✗ DENY | ✓ Not in MANAGEMENT_ROLES |

**Result: ✓ PASS**

---

## PT-05: Approve counts — restricted to management

**Permission:** `INVENTORY.COUNT_APPROVE`
**Allowed:** MANAGEMENT_ROLES only

**Protected routes:**
- `POST /stock-counts/:id/approve`
- `POST /stock-counts/:id/apply`

| Role | Expected | Verified |
|---|---|---|
| store_manager (70) | ✓ ALLOW | ✓ |
| assistant_manager (50) | ✗ DENY | ✓ Not in MANAGEMENT_ROLES |

**Result: ✓ PASS**

---

## PT-06: Approve POs — restricted to management

**Permission:** `INVENTORY.PO_APPROVE`
**Allowed:** MANAGEMENT_ROLES

**Protected routes:**
- `POST /purchase-orders/:id/approve`
- `POST /purchase-orders/:id/mark-ordered`
- `POST /purchase-orders/:id/close`
- `POST /purchase-orders/:id/cancel`
- `POST /procurement/supplier-history/:id/set-preferred` (H01 fix)

**Result: ✓ PASS**

---

## PT-07: Complete WO — restricted to management

**Permission:** `INVENTORY.WO_COMPLETE`
**Allowed:** MANAGEMENT_ROLES

WO complete finalizes material cost — restricted to prevent unauthorized cost finalization.

**Result: ✓ PASS**

---

## PT-08: Direct API bypass without token

**Check:** All routes require valid JWT (enforced by `authenticateToken` at server.js mount).

No inventory route is accessible without a valid JWT. `authenticateToken` returns 401 if no token, 403 if invalid/expired.

**Result: ✓ PASS**

---

## PT-09: Direct API bypass — company not selected

**Check:** All routes require company context.

`requireCompany` middleware (added CB11) blocks requests where `req.companyId` is null.

```
400 { error: 'Company not selected', requiresCompanySelection: true }
```

**Result: ✓ PASS**

---

## PT-10: Live permission denial test

**Status: ⊘ BLOCKED** — requires at least two user accounts with different roles to test in live environment.

**Required for full certification:**
- User with `cashier` role → attempt `GET /items` → must get 403
- User with `shift_supervisor` role → attempt `POST /movements` → must get 403
- User with `assistant_manager` → attempt `POST /purchase-orders/:id/approve` → must get 403
- User with `store_manager` → above actions must succeed

These must be run against the deployed Zeabur instance before a pilot company is onboarded.

---

## Summary

| Test | Result |
|---|---|
| PT-01: VIEW role coverage | ✓ PASS |
| PT-02: RECEIVE role coverage | ✓ PASS |
| PT-03: ADJUST restricted to management | ✓ PASS |
| PT-04: COST_VIEW restricted to management | ✓ PASS |
| PT-05: COUNT_APPROVE restricted | ✓ PASS |
| PT-06: PO_APPROVE restricted | ✓ PASS |
| PT-07: WO_COMPLETE restricted | ✓ PASS |
| PT-08: No token → 401 | ✓ PASS |
| PT-09: No company → 400 | ✓ PASS |
| PT-10: Live denial test | ⊘ BLOCKED |
