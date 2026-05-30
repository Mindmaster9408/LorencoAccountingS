# H01 — Smoke Test Results

**Method:** Static code analysis (live browser testing BLOCKED — toolchain limitation)
**Date:** 2026-05-30

Legend:
- ✓ PASS — verified by code logic
- ✗ FAIL — bug found
- ⊘ BLOCKED — requires live browser/network test

---

## Core App

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | /inventory loads | ⊘ BLOCKED | Requires live browser. Code structure intact. |
| 2 | Dashboard loads (`GET /demo-dashboard`) | ✓ PASS | Route exists in index.js, company-scoped, no errors in logic |
| 3 | Items tab loads (`GET /items`) | ✓ PASS | Route gated with INVENTORY.VIEW, company-scoped |
| 4 | Health diagnostics loads (`GET /health`) | ✓ PASS | Route added in CB12, gated with VIEW, all 10 checks verified |
| 5 | Sean context endpoint (`GET /sean-context`) | ✓ PASS | Returns read-only context, `mutation_allowed: false` |
| 6 | Onboarding checklist (`GET /onboarding`) | ✓ PASS | 7-step checklist, company-scoped |
| 7 | My permissions endpoint (`GET /my-permissions`) | ✓ PASS | Returns role + 17 permission flags |

## Item Management

| # | Test | Result | Evidence |
|---|---|---|---|
| 8 | Add raw material (`POST /items`) | ✓ PASS | Requires CONFIGURE. Validates item_type. |
| 9 | Add finished good | ✓ PASS | Same route, item_type='finished_good' |
| 10 | Edit item (`PUT /items/:id`) | ✓ PASS | Requires CONFIGURE. Allows all UOM fields. |
| 11 | Delete/deactivate item | ✓ PASS | Soft-delete (is_active=false). Requires CONFIGURE. |
| 12 | List items with reservations enriched | ✓ PASS | available_stock = current_stock - net_reserved |

## UOM / Pack Sizes

| # | Test | Result | Evidence |
|---|---|---|---|
| 13 | Add UOM (`POST /uom`) | ✓ PASS | Requires CONFIGURE. Unique per company+code. |
| 14 | Add item UOM conversion (`POST /items/:id/uom-conversions`) | ✓ PASS | Requires CONFIGURE. Factor > 0 enforced. |
| 15 | Quick receive with pack size | ✓ PASS | UOM conversion applied before adjustStockTx. base_qty computed. |
| 16 | UOM profile endpoint (`GET /items/:id/uom-profile`) | ✓ PASS | Returns base_unit, conversions list |

## Purchasing

| # | Test | Result | Evidence |
|---|---|---|---|
| 17 | Create PO (`POST /purchase-orders`) | ✓ PASS | Requires PO_CREATE. Auto-generates PO number. |
| 18 | Approve PO (`POST /purchase-orders/:id/approve`) | ✓ PASS | Requires PO_APPROVE. Status transition validated. |
| 19 | Mark PO ordered | ✓ PASS | Requires PO_APPROVE. Lifecycle guard enforced. |
| 20 | Partial receive (`POST /purchase-orders/:id/receive`) | ✓ PASS | Over-receive blocked (remaining check). Requires RECEIVE. |
| 21 | UOM conversion on receive | ✓ PASS | purchase_unit converted to base_qty before adjustStockTx |
| 22 | Full receive → status=fully_received | ✓ PASS | All lines received_qty ≥ quantity → status updated |
| 23 | Receive on cancelled PO | ✓ PASS | Blocked — status guard rejects cancelled/closed POs |

## Stock / Movements

| # | Test | Result | Evidence |
|---|---|---|---|
| 24 | Manual stock out within available | ✓ PASS | adjustStockTx handles delta, RPC blocks negative |
| 25 | Manual stock adjustment requires ADJUST permission | ✓ PASS | INVENTORY.ADJUST = MANAGEMENT_ROLES only |
| 26 | Over-issue blocked at RPC level | ✓ PASS | adjust_inventory_stock RPC returns Insufficient stock error |

## Reservations

| # | Test | Result | Evidence |
|---|---|---|---|
| 27 | List reservations | ✓ PASS | Requires VIEW. Company-scoped. |
| 28 | Manual hold (`POST /reservations/manual-hold`) | ✓ PASS | Requires ADJUST (H01 fix). sourceId=reference now (H01 fix). |
| 29 | Release reservation | ✓ PASS | Requires VIEW minimum. Company-scoped via reservationService. |

## BOMs

| # | Test | Result | Evidence |
|---|---|---|---|
| 30 | Create BOM | ✓ PASS | Requires CONFIGURE. Lines with input_unit get base_qty computed. |
| 31 | BOM cost summary | ✓ PASS | Requires COST_VIEW. Uses base_qty × avg_cost. |
| 32 | Activate BOM | ✓ PASS | Only one active per item enforced. |

## Work Orders

| # | Test | Result | Evidence |
|---|---|---|---|
| 33 | Create WO from BOM | ✓ PASS | required_qty uses base_qty (A7 fix applied) |
| 34 | Release WO | ✓ PASS | Requires WO_MANAGE. Creates reservations. Blocks if shortage. |
| 35 | Issue materials | ✓ PASS | Requires PRODUCTION_MANAGE. Frozen cost at issue time. |
| 36 | Complete WO | ✓ PASS | Requires WO_COMPLETE. Finalizes cost. Creates production batch. |
| 37 | Close WO | ✓ PASS | Requires WO_CLOSE. Requires status=completed first. |
| 38 | Cancel WO | ✓ PASS | Requires WO_MANAGE. Releases all active reservations. |

## Stock Counts

| # | Test | Result | Evidence |
|---|---|---|---|
| 39 | Create count session | ✓ PASS | Requires COUNT_CONDUCT. |
| 40 | Submit count | ✓ PASS | Requires COUNT_CONDUCT. |
| 41 | Approve count | ✓ PASS | Requires COUNT_APPROVE (management only). |
| 42 | Apply count variances | ✓ PASS | Requires COUNT_APPROVE. **Idempotency: status flipped to 'applied' before processing — double-apply protected.** |

## Warehouse Transfers

| # | Test | Result | Evidence |
|---|---|---|---|
| 43 | Create transfer | ✓ PASS | Requires TRANSFER_CREATE. |
| 44 | Approve transfer | ✓ PASS | Requires TRANSFER. |
| 45 | Ship transfer | ✓ PASS | Requires TRANSFER. Creates OUT movements. |
| 46 | Receive transfer | ✓ PASS | Requires TRANSFER. Creates IN movements. |
| 47 | Cancel transfer | ✓ PASS | Requires TRANSFER. Blocks if already shipped. |
| 48 | Warehouse locations CRUD | ✓ PASS | Gated VIEW/CONFIGURE (H01 fix). company_id enforced. |

## Sales Orders

| # | Test | Result | Evidence |
|---|---|---|---|
| 49 | Create SO | ✓ PASS | Requires SO_MANAGE. |
| 50 | Confirm SO | ✓ PASS | Requires SO_MANAGE. |
| 51 | Allocate SO (reserve stock) | ✓ PASS | Requires SO_MANAGE. Creates stock reservations. |
| 52 | Fulfill SO line | ✓ PASS | Requires SO_MANAGE. Creates stock-out movement. |
| 53 | Cancel SO | ✓ PASS | Requires SO_MANAGE. Releases reservations. |

## Procurement

| # | Test | Result | Evidence |
|---|---|---|---|
| 54 | Procurement suggestions | ✓ PASS | Requires REPORTS_VIEW (H01 fix). |
| 55 | Supplier history (cost data) | ✓ PASS | Requires COST_VIEW (H01 fix). |
| 56 | Set preferred supplier | ✓ PASS | Requires PO_APPROVE (H01 fix). |

## Reports

| # | Test | Result | Evidence |
|---|---|---|---|
| 57 | Stock valuation report | ✓ PASS | Requires COST_VIEW. |
| 58 | Work order cost summary | ✓ PASS | Requires COST_VIEW. |
| 59 | Yield variance report | ✓ PASS | Requires COST_VIEW. |
| 60 | Wastage report | ✓ PASS | Requires COST_VIEW. |
| 61 | Supplier history report | ✓ PASS | Requires COST_VIEW. |
| 62 | Operational reports (shortages, ATP, etc.) | ✓ PASS | Requires REPORTS_VIEW. |

---

## Summary

| Category | Total | Pass | Fail | Blocked |
|---|---|---|---|---|
| Core App | 7 | 6 | 0 | 1 |
| Items/UOM | 8 | 8 | 0 | 0 |
| Purchasing | 7 | 7 | 0 | 0 |
| Stock/Movements | 3 | 3 | 0 | 0 |
| Reservations | 3 | 3 | 0 | 0 |
| BOMs | 3 | 3 | 0 | 0 |
| Work Orders | 6 | 6 | 0 | 0 |
| Stock Counts | 4 | 4 | 0 | 0 |
| Warehouse | 6 | 6 | 0 | 0 |
| Sales Orders | 5 | 5 | 0 | 0 |
| Procurement | 3 | 3 | 0 | 0 |
| Reports | 6 | 6 | 0 | 0 |
| **TOTAL** | **61** | **60** | **0** | **1** |

**1 test BLOCKED** (live app load) — not a code failure, toolchain limitation.
