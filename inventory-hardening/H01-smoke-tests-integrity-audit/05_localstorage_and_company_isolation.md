# H01 — localStorage Scan & Company Isolation Results

**Date:** 2026-05-30

---

## localStorage Scan

**Method:** Full grep of `frontend-inventory/index.html` for `localStorage.`, `sessionStorage.`, `indexedDB`.

**Total matches found:** 1

```javascript
// Line 1747 — getToken() function:
if (!token) token = localStorage.getItem('token') || '';
```

**Classification:** ALLOWED

This reads the authentication JWT from localStorage. This is:
- Standard ecosystem auth pattern
- The JWT contains no business data (only userId, companyId, role, email)
- Re-authentication recovers the token if lost
- Compliant with CLAUDE.md Rule D2 (auth tokens in localStorage are permitted)

**Business data in localStorage:** ZERO occurrences

No inventory items, stock quantities, costs, reservations, POs, WOs, BOMs, or any other business data is stored in localStorage.

**sessionStorage:** Zero occurrences found.

**indexedDB:** Zero occurrences found.

### localStorage Scan Result: ✓ PASS

---

## Company Isolation Audit

### Backend Route Level

**Check:** Every inventory route must filter data by `req.companyId`.

**Method:** Read all route files and verify every Supabase query includes `.eq('company_id', ...)` or equivalent company scope.

**Findings:**

| Route File | Company-Scoped? | Notes |
|---|---|---|
| `index.js` | ✓ YES | Every query uses `req.companyId` or `cid` |
| `purchase-orders.js` | ✓ YES | All queries scope by `companyId` |
| `work-orders.js` | ✓ YES | All queries scope by `req.companyId` |
| `stock-counts.js` | ✓ YES | All queries scope by `req.companyId` |
| `reports.js` | ✓ YES | All reports pass `req.companyId` to service |
| `boms.js` | ✓ YES | All queries scope by `req.companyId` |
| `warehouse-transfers.js` | ✓ YES | All via warehouseTransferService with companyId |
| `warehouse-locations.js` | ✓ YES | All queries scope by `req.companyId` |
| `sales-orders.js` | ✓ YES | All via salesOrderService with companyId |
| `production-batches.js` | ✓ YES | All queries scope by `req.companyId` |
| `procurement.js` | ✓ YES | All queries scope by `companyId` |
| `reservations.js` | ✓ YES | All queries scope by `req.companyId` |

### Service Layer

**operationalHealthService.js:** All 10 health checks pass `companyId` as parameter to every query. ✓

**inventoryInsightService.js:** Read-only, no queries — returns static explanations. ✓

**uomService.js:** All conversion lookups pass `companyId`. The item lookup includes `.eq('company_id', companyId)`. ✓

**stockMutationService.js:** Passes `companyId` as `p_company_id` to RPC. ✓

### Super Admin Override

The `authenticateToken` middleware allows super admins to override company via `X-Company-Id` header. This is intentional and documented in auth.js. Non-super-admins cannot use this header.

**Risk:** Low. Super admin access is platform-controlled (isSuperAdmin flag in JWT).

### Company Isolation Audit Result: ✓ PASS

---

## JWT Isolation

The JWT payload includes `companyId` embedded at company selection time (via `/select-company` endpoint). The `companyId` in the token is verified to belong to the authenticated user before it is embedded.

Cross-company access is not possible through JWT manipulation because:
1. The JWT is signed with `JWT_SECRET` — tampered tokens fail verification
2. `companyId` in the token is set by the backend at login/company-select, not by the client

**Result: ✓ PASS**

---

## Summary

| Check | Result |
|---|---|
| localStorage business data | ✓ PASS — zero occurrences |
| localStorage auth token | ✓ ALLOWED |
| sessionStorage | ✓ PASS — zero occurrences |
| indexedDB | ✓ PASS — zero occurrences |
| Company isolation in routes | ✓ PASS — 12/12 route files |
| Company isolation in services | ✓ PASS |
| JWT cross-company protection | ✓ PASS |
