# H01 — Recommended Fixes

**Date:** 2026-05-30

---

## A. Must Fix Before Pilot (All FIXED in H01)

| # | Fix | File | Status |
|---|---|---|---|
| A1 | Add requirePerm to procurement.js (4 routes) | `routes/procurement.js` | ✓ FIXED |
| A2 | Add requirePerm to reservations.js (7 routes) | `routes/reservations.js` | ✓ FIXED |
| A3 | Add requirePerm to warehouse-locations.js (5 routes) | `routes/warehouse-locations.js` | ✓ FIXED |
| A4 | Fix manual-hold sourceId semantic bug | `routes/reservations.js` | ✓ FIXED |

---

## B. Should Fix Before Pilot

| # | Fix | File | Priority | Estimated Effort |
|---|---|---|---|---|
| B1 | Live permission denial test (multi-role users) | Test environment | HIGH | 30 min testing |
| B2 | Add `actual_output_qty > 0` validation in WO complete | `routes/work-orders.js` | MEDIUM | 2 lines |
| B3 | Stress-test concurrent stock count apply | Test environment | MEDIUM | Manual test |

### B2 Fix (safe to apply now):

```javascript
// In routes/work-orders.js complete endpoint, after parsing actual_output_qty:
const resolvedActualOutputQty = actual_output_qty != null
  ? parseFloat(actual_output_qty)
  : qtyProduced;

// Add this validation:
if (actual_output_qty != null && resolvedActualOutputQty <= 0) {
  return res.status(400).json({ error: 'actual_output_qty must be greater than 0 when provided' });
}
```

---

## C. Can Fix During Pilot (Non-blocking)

| # | Fix | File | Notes |
|---|---|---|---|
| C1 | Reset _tabLoaded on WO mutations | `frontend-inventory/index.html` | Add `_tabLoaded['workorders'] = false` after complete/cancel |
| C2 | Extend _tabLoaded refresh to SO, Counts, Reservations tabs | `frontend-inventory/index.html` | Same pattern as C1 |
| C3 | Live app load test (/inventory) | Deployed Zeabur | Manual — first browser open after deploy |
| C4 | Validate BOM base_qty in cost summary when input_unit is set | `routes/boms.js` | Display warning if conversion missing |
| C5 | Add `data-perm` attributes to BOM/Count action buttons | `frontend-inventory/index.html` | UX polish |

---

## D. Future Enhancement

| # | Enhancement | Notes |
|---|---|---|
| D1 | Optimistic locking for stock count apply | Prevent concurrent apply race condition |
| D2 | FIFO cost layer consumption | Currently proxies to average — documented in risk register R08 |
| D3 | Stock adjustment approval workflow | Threshold-based: adjustments above X qty require supervisor approval before execution |
| D4 | Email notifications for overdue POs | Requires email service integration |
| D5 | Batch health check scheduling | Currently on-demand; future: scheduled background health job |
| D6 | Per-component wastage costing | Currently batch-level; future: per-material wastage tracking |

---

## Fix Priority by Impact

```
PILOT-BLOCKING (all fixed):
  procurement.js + reservations.js + warehouse-locations.js permissions
  manual-hold sourceId

SHOULD-DO BEFORE ONBOARDING:
  Live permission denial test (requires test users)
  actual_output_qty validation

CAN DO DURING PILOT:
  _tabLoaded stale refresh
  UX polish

FUTURE:
  FIFO, approval workflows, email notifications
```
