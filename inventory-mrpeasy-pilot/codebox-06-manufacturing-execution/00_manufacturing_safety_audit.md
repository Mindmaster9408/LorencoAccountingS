# Codebox 06 — Manufacturing Safety & Architecture Audit

**Date:** May 2026  
**Scope:** Existing Lorenco Storehouse — `frontend-inventory/index.html`, `backend/modules/inventory/`  
**Purpose:** Pre-implementation audit of current manufacturing state before adding production batches, wastage, yield, and variance tracking.

---

## 1. Current Work Order Lifecycle Audit

### Existing status set
```
draft → released → in_progress → completed → cancelled
```

### Status transitions (current TRANSITIONS map in work-orders.js)
| From | To (allowed) |
|---|---|
| draft | released, cancelled |
| released | in_progress, cancelled |
| in_progress | completed, cancelled |
| completed | (none) |
| cancelled | (none) |

### Gaps identified
- **No `paused` state** — cannot pause an active production run without cancelling
- **No `closed` state** — completed WOs have no operational-finalization step
- **No batch-level tracking** — one WO = one completion event, no multi-batch support
- **No yield variance** — quantity_produced vs quantity_to_produce not tracked as a computed %
- **No wastage capture** — no field or table for wastage qty/reason on completion
- **No material variance** — issued_qty vs required_qty difference not recorded at completion

### Required lifecycle change
```
draft → released → in_progress ⇄ paused → completed → closed → cancelled
```
Cancellation allowed from: draft, released, in_progress, paused (not completed/closed).

---

## 2. Material Issue Flow Audit

### Current behaviour
- `POST /:id/issue-materials` — all-or-nothing issue of materials to `in_progress` WO
- Pre-validates all issues before applying any changes
- Deducts from `current_stock` via `adjustStockTx` (movement_type = `wo_issue`)
- Accumulates material cost in `work_order_costs` table
- Updates `work_order_materials.issued_qty`

### Gap
- **No batch association** — issued materials not linked to a batch
- **No over-issue check** — can issue more than required_qty (not blocked currently)
- **No partial issue tracking per batch** — all issues belong to the WO level only

---

## 3. Completion Flow Audit

### Current behaviour
1. Validates all materials fully issued
2. Calls `finalizeWorkOrderCost(supabase, companyId, workOrderId, qtyProduced)` → computes unit_cost
3. Calls `adjustStockTx(..., sourceType: 'wo_complete')` → receives finished goods into stock
4. Updates WO: `status='completed'`, `quantity_produced`, `actual_end_date`

### Gaps
- **No `production_batch` record created** — no immutable trace of the production event
- **No yield calculation** — `actual_yield_percent` never computed
- **No wastage fields accepted** — `wastage_qty`, `wastage_reason` not in body
- **No variance records** — `production_variances` table does not exist
- **`paused` WOs cannot be completed** — current transitions block it

---

## 4. BOM & Costing Interaction Audit

### What exists (from costingService.js)
- `computeWeightedAverage()` — pure; used when stock is received
- `finalizeWorkOrderCost()` — computes unit_cost = (material + labor + overhead) / qty_produced
- `accumulateWorkOrderMaterialCost()` — accumulates per issue event
- `work_order_costs` table — tracks material_cost, labor_cost, overhead_cost, unit_cost

### Wastage cost impact (new requirement)
- Wastage qty represents output lost (less finished goods than expected)
- Wastage cost = wastage_qty × unit_cost_of_finished_good (write-off)
- Does NOT require an additional stock deduction (materials already issued)
- Must be stored in `production_wastage` table for forensic traceability

---

## 5. Reservation Interaction Audit

### Current cancel flow
- Cancel calls `reservationService.releaseReservation()` for all active reservations on the WO
- Correct and safe

### Paused state (new requirement)
- **`paused` must preserve reservations** — reservations remain intact when paused
- Resume (`paused → in_progress`) requires no reservation change
- Cancel from `paused` must release reservations (same as cancel from `in_progress`)

---

## 6. Frontend Storage Audit

Grep scan of `frontend-inventory/index.html` for `localStorage`, `sessionStorage`, `indexedDB`:

| Pattern | Found | Context |
|---|---|---|
| `localStorage.getItem('token')` | YES | Auth token only — **permitted** |
| `localStorage.setItem(...)` | NO (business data) | — |
| `sessionStorage` | NO | — |
| `indexedDB` | NO | — |

**Result: CLEAN** — No business data in browser storage. All WO/production data is server-authoritative.

---

## 7. Company Isolation Audit

All existing work-orders.js routes use `.eq('company_id', req.companyId)` on every query.
- `req.companyId` is set by `middleware/auth.js`
- Every insert includes `company_id: req.companyId`

**All new production tables must follow the same pattern.** Every SELECT, INSERT, UPDATE must include company_id filter.

---

## 8. Production Flow Gaps — Summary

| Gap | Severity | Codebox 06 Action |
|---|---|---|
| No `paused` status | HIGH | Add to TRANSITIONS + migration |
| No `closed` status | MEDIUM | Add to TRANSITIONS + migration |
| No production_batches table | CRITICAL | Create in migration 056 |
| No production_wastage table | HIGH | Create in migration 056 |
| No production_variances table | HIGH | Create in migration 056 |
| No yield% calculation | HIGH | Add to complete endpoint |
| No material variance recording | HIGH | Add to complete endpoint |
| No labour/machine placeholder | MEDIUM | Stub tables in migration 056 |
| No production tab in UI | CRITICAL | Add tab-production section |
| WO complete modal has no wastage fields | HIGH | Extend modal |
| WO status filter missing paused/closed | LOW | Update HTML select |

---

## 9. Planned Architecture

### New tables (migration 056)
```
production_batches
  - company_id, work_order_id, batch_number
  - produced_qty, expected_qty, wastage_qty, yield_percent
  - started_at, completed_at, executed_by, approved_by
  - notes, total_material_cost, total_labour_cost, unit_cost
  - status: in_progress | completed (immutable after completed)

production_wastage
  - company_id, batch_id, work_order_id, item_id
  - wastage_qty, wastage_reason, estimated_value, notes
  - created_by, created_at (immutable)

production_variances
  - company_id, batch_id, work_order_id, item_id
  - required_qty, actual_qty, variance_qty, variance_direction
  - unit_cost, variance_value, notes
  - created_at (immutable, computed at batch close)

production_labour_entries  [placeholder]
  - company_id, batch_id, duration_minutes, notes, created_by, created_at

production_machine_entries  [placeholder]
  - company_id, batch_id, machine_id, duration_minutes, notes, created_by, created_at
```

### Extended work_orders columns
```
actual_yield_percent  NUMERIC(8,4)
total_wastage_qty     NUMERIC(18,4)
batch_count           INTEGER DEFAULT 0
closed_at             TIMESTAMPTZ
closed_by             INTEGER REFERENCES users(id)
```

### New routes
```
production-batches.js  →  /api/inventory/production
  GET  /batches                    — list batches (filter: wo_id, status)
  GET  /batches/:id                — single batch with wastage + variances
  GET  /batches/summary            — production dashboard stats
  GET  /yield-report               — yield by WO/batch
  GET  /wastage-report             — wastage by reason/item
  GET  /variance-report            — material variance detail
```

### Extended work-orders.js
```
POST /:id/pause     — in_progress → paused (preserves reservations)
POST /:id/resume    — paused → in_progress
POST /:id/close     — completed → closed
POST /:id/complete  — EXTENDED: now also creates production_batch + wastage + variance records
```

### Frontend
```
New nav tab: 🏭 Production (after Work Orders)
New section: tab-production
  - Production Dashboard (yield cards, active WOs, recent batches)
  - Batch History table with yield% column
  - Wastage Log table
  - Variance Report table
Updated WO complete modal: adds wastage_qty + wastage_reason fields
Updated WO status filter: adds paused, closed
Updated woActionBtn(): adds Pause / Resume buttons
```

---

## 10. Safety Constraints Preserved

- `adjustStockTx()` remains the ONLY path for stock changes
- No `localStorage` for production/batch/wastage data
- All new tables include `company_id`
- Batch records are immutable after `completed` status
- Wastage records are INSERT-only
- Variance records are INSERT-only
- `paused` status preserves reservations
- Cancel from any active status releases reservations
