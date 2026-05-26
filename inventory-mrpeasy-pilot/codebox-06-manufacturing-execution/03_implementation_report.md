# Codebox 06 — Manufacturing Execution & Production Control
## Implementation Report

**Date:** 2026-05-30  
**Module:** Lorenco Storehouse — Inventory + Manufacturing  
**App:** https://lorenco.zeabur.app/inventory  
**Scope:** Forensic-grade manufacturing execution built directly into the existing app  

---

## What Was Built

Codebox 06 adds full manufacturing execution tracking to the Lorenco Storehouse.

Every production run on a Work Order now creates an immutable **production batch record** that captures:
- Quantity produced and expected
- Yield % (produced / expected × 100)
- Wastage quantity and reason
- Estimated wastage value
- Unit cost at production time
- Operator notes
- Link to the stock movement created for the finished goods receipt

Material variances (expected vs actual consumption per line) are captured automatically at batch close.

---

## Files Changed

| File | Change |
|---|---|
| `database/migrations/056_manufacturing_execution.sql` | Created — full schema migration |
| `backend/modules/inventory/services/productionService.js` | Created — yield, variance, batch, wastage logic |
| `backend/modules/inventory/routes/production-batches.js` | Created — reporting endpoints |
| `backend/modules/inventory/routes/work-orders.js` | Extended — lifecycle + batch capture |
| `backend/modules/inventory/index.js` | Updated — mount `/production` route |
| `frontend-inventory/index.html` | Extended — nav tab, production section, JS functions |

---

## New Database Tables

| Table | Purpose |
|---|---|
| `production_batches` | Immutable production run records (one per WO completion) |
| `production_wastage` | Immutable wastage records per batch |
| `production_variances` | Immutable material variance records per batch |
| `production_labour_entries` | Placeholder for future MES labour tracking |
| `production_machine_entries` | Placeholder for future MES machine tracking |

All tables include `company_id` for full multi-tenant isolation.

---

## New Status States Added to Work Orders

| Status | Previous | New |
|---|---|---|
| `paused` | ❌ | ✅ |
| `closed` | ❌ | ✅ |

Full lifecycle: `draft → released → in_progress → paused ↔ in_progress → completed → closed`

Cancel allowed from: `draft / released / in_progress / paused` (reservations released on cancel from any active state).

---

## New API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/inventory/work-orders/:id/pause` | in_progress → paused |
| POST | `/api/inventory/work-orders/:id/resume` | paused → in_progress |
| POST | `/api/inventory/work-orders/:id/close` | completed → closed |
| GET | `/api/inventory/production/batches` | List batches |
| GET | `/api/inventory/production/batches/:id` | Batch detail with wastage + variances |
| GET | `/api/inventory/production/summary` | Production dashboard stats |
| GET | `/api/inventory/production/yield-report` | Yield by WO/batch |
| GET | `/api/inventory/production/wastage-report` | Wastage by reason and item |
| GET | `/api/inventory/production/variance-report` | Material variance detail |
| POST | `/api/inventory/production/batches/:id/labour` | Add labour entry |
| POST | `/api/inventory/production/batches/:id/machine` | Add machine entry |

---

## Extended WO Complete Endpoint

`POST /api/inventory/work-orders/:id/complete` now accepts:

```json
{
  "quantity_produced": 100,
  "wastage_qty": 5,
  "wastage_reason": "trimming_loss",
  "wastage_notes": "Trimming excess on edges",
  "operator_notes": "Run smooth. Temp slightly high."
}
```

After the existing `adjustStockTx` succeeds, it:
1. Creates an immutable `production_batches` row
2. If `wastage_qty > 0`: creates an immutable `production_wastage` row
3. Creates immutable `production_variances` rows for each material
4. Updates `work_orders.actual_yield_percent`, `total_wastage_qty`, `batch_count`

`adjustStockTx` remains the sole stock mutation path. No changes to that layer.

---

## New WO Columns

| Column | Purpose |
|---|---|
| `actual_yield_percent` | Computed: (produced / expected) × 100 |
| `total_wastage_qty` | Cumulative wastage across all batches on this WO |
| `batch_count` | Count of production_batches for this WO |
| `closed_at` | Timestamp when WO moved to closed |
| `closed_by` | User who closed the WO |

---

## Frontend Changes

- **Nav tab:** `🏭 Production` added after `⚙️ Work Orders`
- **WO status filter:** Added `Paused` and `Closed` options
- **WO action buttons:**
  - `in_progress`: Pause + Complete (was: Complete only)
  - `paused`: Resume button
  - `completed`: Close button
- **Complete modal:** Added Wastage Qty, Wastage Reason (auto-shows when qty > 0), Operator Notes
- **Production tab:** 4 sub-views: Dashboard / Batch History / Wastage Log / Variance Report

---

## Design Decisions

**Wastage = output loss, not input over-use.** Wastage records capture finished-good yield loss (item_id = null). Material over-consumption is captured as variance (direction = 'over'). These are separate concepts.

**Batches are INSERT-only.** Once created, `production_batches`, `production_wastage`, and `production_variances` rows are never updated. This is a hard architectural constraint for audit compliance.

**Non-fatal batch creation failure.** If batch creation fails after `adjustStockTx` succeeds, the WO is still marked complete and stock is received. A console error is logged. Stock integrity always takes priority over analytics.

**Variance is always computed from issued_qty vs required_qty at WO materials time.** This gives an accurate picture of actual consumption per batch.

---

## What Codebox 06 Does NOT Include

- Multi-batch partial completion within a single WO run (one WO → one completion batch)
- Labour/machine cost entry UI (tables exist; POST endpoints exist; no UI form yet)
- WO timeline showing paused/closed states in the detail view (existing 4-step timeline preserved)
- Scheduled downtime or machine calendar
- Real-time operator interface

These are valid future codeboxes (07+).
