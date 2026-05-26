# Codebox 03 — Permission Preparation
**Date:** June 2026  
**Status:** DESIGN ONLY — not yet implemented

---

## CURRENT STATE

Stock count routes have **no RBAC** applied. This is consistent with all other inventory routes in the current codebase. JWT authentication (`authenticateToken`) and company context (`requireCompany`) are enforced, but no role-level access control exists for inventory yet.

---

## FUTURE PERMISSION DESIGN

When RBAC is implemented for inventory, the following `INVENTORY_COUNTS` permission set is recommended:

### Proposed permissions in `backend/config/permissions.js`

```javascript
INVENTORY_COUNTS: {
  VIEW:    ['owner', 'admin', 'accountant', 'manager', 'inventory_user'],
  CREATE:  ['owner', 'admin', 'manager', 'inventory_user'],
  ENTER:   ['owner', 'admin', 'manager', 'inventory_user'],   // update counted_qty on lines
  SUBMIT:  ['owner', 'admin', 'manager'],
  APPROVE: ['owner', 'admin'],                                 // approve/reject/recount
  APPLY:   ['owner', 'admin'],                                 // apply to stock — highest risk
  CANCEL:  ['owner', 'admin', 'manager'],
}
```

### Why separate APPROVE and APPLY

- **APPROVE:** Management sign-off on variance — already a significant control
- **APPLY:** Permanently mutates live stock — should require owner/admin to confirm
- Separating these prevents an approver from also being the one who applies

### Segregation of duties

Ideally (where staff numbers allow):
- Counter (ENTER) ≠ Approver (APPROVE)
- Approver (APPROVE) may or may not also be Applier (APPLY)

---

## ROUTES THAT WILL NEED MIDDLEWARE WHEN IMPLEMENTED

| Route | Required Permission |
|---|---|
| `GET /stock-counts` | `INVENTORY_COUNTS.VIEW` |
| `POST /stock-counts` | `INVENTORY_COUNTS.CREATE` |
| `GET /stock-counts/:id` | `INVENTORY_COUNTS.VIEW` |
| `PATCH /stock-counts/:id/lines/:lineId` | `INVENTORY_COUNTS.ENTER` |
| `POST /stock-counts/:id/submit` | `INVENTORY_COUNTS.SUBMIT` |
| `POST /stock-counts/:id/approve` | `INVENTORY_COUNTS.APPROVE` |
| `POST /stock-counts/:id/apply` | `INVENTORY_COUNTS.APPLY` |
| `DELETE /stock-counts/:id` | `INVENTORY_COUNTS.CANCEL` |

---

## WHEN TO IMPLEMENT

Implement in a dedicated permissions Codebox once:
1. All inventory modules have RBAC applied consistently
2. `inventory_user` role is formally defined in the permissions system
3. The frontend supports role-conditional button visibility for inventory

Do not implement partially — partial RBAC is more dangerous than no RBAC.
