# Phase 2A — Forensic Costing Audit
**Audit Date:** 2026-05-22  
**Performed Before:** Any Phase 2A implementation code written  
**Output Required By:** Phase 2A workstream spec, Step 1

---

## 1. Existing Schema — What Currently Exists

### `inventory_items` columns (costing-relevant)

| Column | Type | Current Use |
|--------|------|-------------|
| `cost_price` | numeric | Static field — set manually, never auto-updated |
| `costing_method` | text | `'average'`, `'fifo'`, `'standard'` — field exists, zero implementation behind it |

**Missing columns (Phase 2A must add):**
- `average_cost` — running weighted average, auto-maintained by costing service
- `last_purchase_cost` — cost from most recent PO receive
- `standard_cost` — fixed budgeted cost (for standard costing method)
- `cost_updated_at` — timestamp of last cost update
- `cost_source` — what triggered the last update (`'po_receive'`, `'manual'`, `'wo_complete'`, `'adjustment'`)

### `stock_movements` columns (costing-relevant)

| Column | Type | Current Use |
|--------|------|-------------|
| `cost_price` | numeric | **Always NULL** — never populated by any flow |
| `movement_type` | text | `'in'`, `'out'`, `'adjustment'`, `'transfer'` |

**Finding:** `cost_price` exists in `stock_movements` schema but has zero data. All costing is post-hoc reconstruction-only from `inventory_items.cost_price` (static). No per-movement cost trail exists.

### Missing tables (Phase 2A must create)

| Table | Purpose |
|-------|---------|
| `stock_valuation_movements` | Immutable forensic cost ledger — one row per stock event with cost data |
| `inventory_cost_layers` | FIFO layers — received batches with remaining qty and unit cost |
| `work_order_costs` | Summarised material + labor + overhead cost per work order |
| `item_cost_history` | Historical audit of cost changes per item |

---

## 2. Cost Capture Gap Analysis — All Flow Paths

### Path 1: PO Receive
**File:** `backend/modules/inventory/index.js` line 499–509

```javascript
const { data: rpcResult, error: rpcErr } = await supabase.rpc('adjust_inventory_stock', {
  p_company_id:    req.companyId,
  p_item_id:       poItem.item_id,
  p_delta:         recQty,
  p_movement_type: 'in',
  p_warehouse_id:  null,
  p_reference:     `PO-${req.params.id}`,
  p_notes:         notes || `Received from PO #${req.params.id}`,
  p_cost_price:    null,   // ← GAP: unit_price from PO line is ignored
  p_created_by:    req.user.userId
});
```

**Gap:** `p_cost_price: null`. The PO line has a `unit_price` column in `purchase_order_items`. This cost is available at receive time but is not passed to the RPC. Weighted average cannot be computed without incoming cost.

**Fix required:** Read `unit_price` from the already-fetched `poItem` and pass as `p_cost_price`.

---

### Path 2: Work Order Issue Materials
**File:** `backend/modules/inventory/routes/work-orders.js`

```javascript
supabase.rpc('adjust_inventory_stock', {
  ...
  p_movement_type: 'out',
  p_cost_price:    null,   // ← GAP: material consumed at unknown cost
  ...
});
```

**Gap:** When raw materials are issued to a work order, the cost of those materials is not recorded in the movement. Finished good cost rollup requires knowing material input costs.

**Fix required:** At issue time, read `average_cost` from `inventory_items` for the issued item and pass as `p_cost_price`. This captures the weighted average cost at time of consumption.

---

### Path 3: Work Order Complete (Finished Good Receive)
**File:** `backend/modules/inventory/routes/work-orders.js`

```javascript
supabase.rpc('adjust_inventory_stock', {
  ...
  p_movement_type: 'in',
  p_cost_price:    null,   // ← GAP: finished good enters stock at zero cost
  ...
});
```

**Gap:** When a work order is completed and finished goods are received into stock, the unit cost of the finished good is not computed or stored. This means manufactured goods have no cost basis.

**Fix required:** Compute total material cost from `work_order_costs` for this WO, divide by completed quantity, pass as `p_cost_price` for the finished good `in` movement.

---

### Path 4: Manual Movements (In / Out)
**File:** `backend/modules/inventory/index.js` line 227–270

```javascript
supabase.rpc('adjust_inventory_stock', {
  ...
  p_cost_price:    null,   // ← PARTIAL GAP
  ...
});
```

**Assessment:** Manual in/out movements optionally accept `cost_price` in the request body, but it is never forwarded to the RPC. Phase 2A should forward `req.body.cost_price || null` to allow optional cost capture on manual movements.

---

### Path 5: Manual Adjustment
**File:** `backend/modules/inventory/index.js` ~line 285

**Gap:** Adjustment movements bypass the RPC entirely — they insert directly to `stock_movements`. `current_stock` on `inventory_items` is not updated. This is a pre-existing gap, not introduced by Phase 2A. Do not alter this path in Phase 2A.

---

## 3. The `adjust_inventory_stock()` RPC

**File:** `database/migrations/016_inventory_phase1_stability.sql`

**Signature:**
```sql
adjust_inventory_stock(
  p_company_id     UUID,
  p_item_id        INTEGER,
  p_delta          NUMERIC,
  p_movement_type  TEXT,
  p_warehouse_id   UUID,
  p_reference      TEXT,
  p_notes          TEXT,
  p_cost_price     NUMERIC,    ← parameter exists, ready to receive cost data
  p_created_by     UUID
) RETURNS JSONB
```

**Current behaviour:** The RPC already accepts `p_cost_price`. It passes it through when inserting the `stock_movements` row. The parameter exists — it just receives `null` from every caller.

**Phase 2A RPC changes needed:** The RPC must be extended to:
1. Write `p_cost_price` to `stock_movements.cost_price` (already does this)
2. Write to `stock_valuation_movements` (new immutable ledger)
3. Update `inventory_items.average_cost` using weighted average formula when `p_movement_type = 'in'`
4. Update `inventory_items.last_purchase_cost` when movement type indicates PO receive
5. Insert to `inventory_cost_layers` for FIFO tracking on `'in'` movements

**Weighted average formula:**
```
newAvg = ((currentQty × currentAvg) + (incomingQty × incomingCost)) / (currentQty + incomingQty)
if currentQty <= 0: newAvg = incomingCost
```

---

## 4. `purchase_order_items` — Cost Data Availability

The PO receive flow fetches `purchase_order_items` at line 459:
```javascript
.select('id, item_id, quantity, received_qty')
```

**Finding:** `unit_price` is NOT in the select. It exists on the table but is not fetched. Phase 2A must add `unit_price` to this select so cost can be forwarded to the RPC.

---

## 5. Costing Method Field — Current State

`inventory_items.costing_method` accepts `'average'`, `'fifo'`, `'standard'`.

**Current implementation:** Zero. The field is stored but never read by any backend logic. No code path branches on `costing_method`.

**Phase 2A approach:** Implement weighted average as the default/primary method for all items. Add FIFO layer infrastructure. `costing_method` field will be respected by the costing service when determining which cost to return, but weighted average will be the default.

---

## 6. New Tables Required

### `stock_valuation_movements`
Immutable forensic ledger. One row per stock event that carries cost data.

```sql
CREATE TABLE stock_valuation_movements (
  id                    BIGSERIAL PRIMARY KEY,
  company_id            UUID NOT NULL REFERENCES companies(id),
  item_id               INTEGER NOT NULL REFERENCES inventory_items(id),
  movement_type         TEXT NOT NULL,         -- 'in','out','adjustment','transfer'
  qty                   NUMERIC NOT NULL,
  unit_cost             NUMERIC NOT NULL DEFAULT 0,
  total_cost            NUMERIC GENERATED ALWAYS AS (qty * unit_cost) STORED,
  running_avg_cost      NUMERIC,              -- average_cost AFTER this movement
  running_qty           NUMERIC,              -- current_stock AFTER this movement
  reference             TEXT,
  source_type           TEXT,                 -- 'po_receive','wo_issue','wo_complete','manual','adjustment'
  source_id             TEXT,                 -- PO id, WO id, etc.
  movement_id           BIGINT REFERENCES stock_movements(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID REFERENCES auth.users(id)
);
```

### `inventory_cost_layers` (FIFO)
One row per received batch. Consumed FIFO order by depleting `remaining_qty`.

```sql
CREATE TABLE inventory_cost_layers (
  id                    BIGSERIAL PRIMARY KEY,
  company_id            UUID NOT NULL REFERENCES companies(id),
  item_id               INTEGER NOT NULL REFERENCES inventory_items(id),
  received_qty          NUMERIC NOT NULL,
  remaining_qty         NUMERIC NOT NULL,
  unit_cost             NUMERIC NOT NULL,
  source_type           TEXT,                 -- 'po_receive','wo_complete','manual'
  source_id             TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID REFERENCES auth.users(id)
);
```

### `work_order_costs`
Per-work-order cost summary. Updated as materials are issued, finalized at WO completion.

```sql
CREATE TABLE work_order_costs (
  id                    BIGSERIAL PRIMARY KEY,
  company_id            UUID NOT NULL REFERENCES companies(id),
  work_order_id         INTEGER NOT NULL REFERENCES work_orders(id),
  material_cost         NUMERIC NOT NULL DEFAULT 0,
  labor_cost            NUMERIC NOT NULL DEFAULT 0,
  overhead_cost         NUMERIC NOT NULL DEFAULT 0,
  total_cost            NUMERIC GENERATED ALWAYS AS (material_cost + labor_cost + overhead_cost) STORED,
  completed_qty         NUMERIC,
  unit_cost             NUMERIC,              -- total_cost / completed_qty at finalization
  status                TEXT DEFAULT 'open',  -- 'open','finalized'
  finalized_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `item_cost_history`
Audit trail of every change to `inventory_items.average_cost` / `cost_price`.

```sql
CREATE TABLE item_cost_history (
  id                    BIGSERIAL PRIMARY KEY,
  company_id            UUID NOT NULL REFERENCES companies(id),
  item_id               INTEGER NOT NULL REFERENCES inventory_items(id),
  previous_cost         NUMERIC,
  new_cost              NUMERIC NOT NULL,
  cost_type             TEXT NOT NULL,        -- 'average_cost','last_purchase_cost','standard_cost'
  change_source         TEXT NOT NULL,        -- 'po_receive','manual','wo_complete','adjustment'
  source_reference      TEXT,
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by            UUID REFERENCES auth.users(id)
);
```

---

## 7. New Columns Required on Existing Tables

### `inventory_items` additions

```sql
ALTER TABLE inventory_items ADD COLUMN average_cost       NUMERIC DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN last_purchase_cost NUMERIC;
ALTER TABLE inventory_items ADD COLUMN standard_cost      NUMERIC;
ALTER TABLE inventory_items ADD COLUMN cost_updated_at    TIMESTAMPTZ;
ALTER TABLE inventory_items ADD COLUMN cost_source        TEXT;
```

---

## 8. New Backend Service Required

**File:** `backend/modules/inventory/services/costingService.js`

Responsibilities:
- `computeWeightedAverage(currentQty, currentAvg, incomingQty, incomingCost)` — pure function
- `updateAverageCost(supabase, companyId, itemId, incomingQty, incomingCost, source, sourceId, userId)` — updates DB
- `recordCostLayer(supabase, companyId, itemId, qty, unitCost, sourceType, sourceId, userId)` — FIFO layer
- `recordValuationMovement(supabase, companyId, itemId, movementType, qty, unitCost, runningAvg, runningQty, ref, sourceType, sourceId, movementId, userId)` — immutable ledger
- `accumulateWorkOrderCost(supabase, companyId, workOrderId, materialCostDelta)` — accumulate as materials issue
- `finalizeWorkOrderCost(supabase, companyId, workOrderId, completedQty)` — compute unit_cost at completion

---

## 9. New Report Endpoints Required

| Endpoint | Description |
|----------|-------------|
| `GET /api/inventory/reports/stock-valuation` | Current stock value per item (qty × average_cost) |
| `GET /api/inventory/reports/cost-history/:itemId` | Cost change history for one item |
| `GET /api/inventory/reports/valuation-movements` | Date-range forensic cost ledger |
| `GET /api/inventory/reports/work-order-cost-summary` | WO cost breakdown report |

---

## 10. Impact on Existing Code

| File | Change Type | Risk |
|------|-------------|------|
| `index.js` PO receive (line 499) | Add `unit_price` to select + forward to RPC | LOW |
| `index.js` movements POST (~line 227) | Forward `req.body.cost_price` to RPC | LOW |
| `routes/work-orders.js` issue-materials | Forward `average_cost` from item to RPC | MEDIUM |
| `routes/work-orders.js` WO complete | Compute unit cost from WO costs + forward | MEDIUM |
| `016_inventory_phase1_stability.sql` RPC | Extend to update new costing fields | HIGH — requires new migration, do not modify 016 directly |

**RPC extension strategy:** The `adjust_inventory_stock()` RPC must not be modified in-place (migration 016 is deployed). A new migration (`041`) will replace the function with an extended version using `CREATE OR REPLACE FUNCTION`.

---

## 11. Audit Verdict

Phase 2A is building on a clean foundation. The schema gaps are well-defined. The cost capture gap in all three critical paths (PO receive, WO issue, WO complete) is the primary fix. The new tables provide the forensic and FIFO infrastructure.

**Proceed to migration `041_inventory_costing_foundation.sql`.**
