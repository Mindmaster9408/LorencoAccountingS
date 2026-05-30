# Session Handoff — Codebox 11: Permissions, Roles & Approval Governance

**Date:** 2026-05-30
**Session:** Codebox 11 of 12 — Lorenco Storehouse MrEasy Pilot Path
**Status:** Implementation complete. No DB migration required. No deployment changes required.

---

## What Was Changed

### Modified Files

| File | Change |
|---|---|
| `backend/config/permissions.js` | Extended `INVENTORY` block from 3 to 16 granular permissions (VIEW, RECEIVE, ADJUST, CONFIGURE, PO_CREATE, PO_APPROVE, WO_MANAGE, WO_COMPLETE, WO_CLOSE, COUNT_CONDUCT, COUNT_APPROVE, COST_VIEW, REPORTS_VIEW, TRANSFER, TRANSFER_CREATE, SO_MANAGE, PRODUCTION_MANAGE) |
| `backend/server.js` | Added `requireCompany` to inventory module mount — blocks all inventory access without company context |
| `backend/modules/inventory/routes/purchase-orders.js` | All routes gated with appropriate permissions |
| `backend/modules/inventory/routes/work-orders.js` | All routes gated — complete/close require WO_COMPLETE/WO_CLOSE, others WO_MANAGE |
| `backend/modules/inventory/routes/stock-counts.js` | Conduct routes → COUNT_CONDUCT; approve/apply → COUNT_APPROVE |
| `backend/modules/inventory/routes/reports.js` | Cost reports → COST_VIEW; operational reports → REPORTS_VIEW |
| `backend/modules/inventory/routes/warehouse-transfers.js` | View → VIEW; create → TRANSFER_CREATE; approve/ship/receive/cancel → TRANSFER |
| `backend/modules/inventory/routes/sales-orders.js` | View → VIEW; mutations → SO_MANAGE |
| `backend/modules/inventory/routes/production-batches.js` | Reports → REPORTS_VIEW or COST_VIEW; mutations → PRODUCTION_MANAGE |
| `backend/modules/inventory/routes/boms.js` | Read → VIEW; mutations + cost summary → CONFIGURE or COST_VIEW |
| `backend/modules/inventory/index.js` | Read routes → VIEW; mutations → appropriate permissions; UOM config → CONFIGURE; quick-receive → RECEIVE; new `GET /my-permissions` endpoint |
| `frontend-inventory/index.html` | Permission state loaded on init from `/my-permissions`; `data-perm` attributes on action buttons; item table shows edit/remove conditionally; dashboard quick-cards hide based on permissions |

### New Files

| File | Purpose |
|---|---|
| `backend/modules/inventory/permissions.js` | Centralized permission string constants (PERM.*) + `requirePerm()` factory + `getInventoryPermsForRole()` helper |
| `inventory-mrpeasy-pilot/codebox-11-permissions-governance/05_role_matrix.md` | Role-to-permission mapping table |
| (this file) | Session handoff |

---

## Architecture

```
JWT (role per company)
    ↓ authenticateToken
req.user.role available on all routes
    ↓ requireCompany  ← NEW (Codebox 11)
req.companyId confirmed non-null
    ↓ requirePerm('INVENTORY.X')  ← NEW (Codebox 11)
hasPermission(role, 'INVENTORY', 'X') → 403 if not allowed
    ↓ route handler
```

The permission check is one line added per route: `requirePerm(PERM.X)` as middleware before the handler. No handler logic was changed.

---

## What Was NOT Changed

- No new DB tables — approval fields (approved_by, approved_at) already existed on PO, stock count, and transfer records
- No changes to `adjustStockTx()` or the stock mutation engine
- No changes to JWT structure or auth flow
- No changes to Dockerfile or Zeabur config
- No localStorage permission storage — all permission decisions are server-side

---

## Key Rules Preserved

- Backend is authoritative — frontend `canDo()` checks are UX only
- Company isolation unchanged — all queries still filter by req.companyId
- `requirePermission()` middleware already had audit hook built in — permission denials are logged
- Super admin (isSuperAdmin) can access any company via X-Company-Id header (unchanged)

---

## Testing Required

| Test | Expected |
|---|---|
| cashier role tries GET /api/inventory/items | 403 Insufficient permissions |
| shift_supervisor tries POST /api/inventory/movements | 403 (ADJUST required) |
| assistant_manager tries POST /api/inventory/purchase-orders | 201 Created (PO_CREATE) |
| assistant_manager tries POST /api/inventory/purchase-orders/:id/approve | 403 (PO_APPROVE required) |
| store_manager approves stock count | 200 OK |
| assistant_manager tries to approve count | 403 |
| Any role tries GET /api/inventory/reports/stock-valuation | 403 unless management (COST_VIEW) |
| store_manager views stock valuation | 200 OK |
| shift_supervisor views stock-counts report | 200 OK (REPORTS_VIEW) |
| Any authenticated user without company in JWT | 400 Company not selected |
| GET /api/inventory/my-permissions | Returns role + permission map |
| /inventory cloud app still loads | Yes — VIEW-gated routes accessible to SUPERVISOR_ROLES |
| Direct API call bypasses frontend hide | Backend returns 403 — frontend hiding is UX only |

---

## No Deployment Changes Needed

No new DB migration. No Dockerfile changes. Zeabur will auto-deploy on git push.

---

*Codebox 11 complete. Codebox 12 to follow.*
