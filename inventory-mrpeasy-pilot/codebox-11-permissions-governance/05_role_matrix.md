# Codebox 11 — Inventory Role Permission Matrix

**Date:** 2026-05-30

---

## How Roles Map to Inventory Permissions

Ecosystem roles are not inventory-specific. The table below shows which ecosystem roles can perform each inventory action.

| Permission | super_admin | business_owner / practice_manager / administrator | accountant / corporate_admin | store_manager / payroll_admin | assistant_manager | shift_supervisor | cashier / trainee |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **VIEW** (items, movements, stock) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| **RECEIVE** (quick receive, PO receive) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| **ADJUST** (manual stock movements) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **CONFIGURE** (items, warehouses, suppliers, UOM, BOMs) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **PO_CREATE** (create & edit purchase orders) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **PO_APPROVE** (approve, mark-ordered, close, cancel POs) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **WO_MANAGE** (create, update, release, start, pause, resume, cancel WOs) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **WO_COMPLETE** (complete work orders — finalizes batch cost) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **WO_CLOSE** (close completed work orders) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **COUNT_CONDUCT** (create counts, record quantities, submit) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| **COUNT_APPROVE** (approve / reject / apply counts) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **COST_VIEW** (valuation, cost history, WO cost summary, wastage values) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **REPORTS_VIEW** (operational reports, dashboards) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| **TRANSFER** (approve, ship, receive, cancel warehouse transfers) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **TRANSFER_CREATE** (create warehouse transfer requests) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **SO_MANAGE** (create, confirm, allocate, fulfill, cancel sales orders) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **PRODUCTION_MANAGE** (issue materials, add labour/machine entries) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |

---

## Spec vs Ecosystem Role Mapping

| Spec Role | Ecosystem Role Equivalent |
|---|---|
| inventory_viewer | shift_supervisor, leave_admin (can VIEW, COUNT_CONDUCT, REPORTS_VIEW) |
| inventory_operator | assistant_manager (adds RECEIVE, PO_CREATE, WO_MANAGE, SO_MANAGE, PRODUCTION_MANAGE, TRANSFER_CREATE) |
| inventory_supervisor | store_manager, payroll_admin (adds ADJUST, CONFIGURE, PO_APPROVE, WO_COMPLETE, WO_CLOSE, COUNT_APPROVE, TRANSFER, COST_VIEW) |
| inventory_manager | accountant, corporate_admin (same as store_manager for inventory) |
| inventory_admin | business_owner, practice_manager, administrator, super_admin |

---

## Key Approval Gates

| Action | Min Role Required |
|---|---|
| Receive stock from supplier | assistant_manager (50) |
| Approve a Purchase Order | store_manager (70) |
| Complete a Work Order (cost finalization) | store_manager (70) |
| Approve a stock count | store_manager (70) |
| Apply count variances to stock | store_manager (70) |
| Approve a warehouse transfer | store_manager (70) |
| View cost / valuation reports | store_manager (70) |
| Manual stock adjustment | store_manager (70) |
| Configure items / UOM / warehouses | store_manager (70) |
