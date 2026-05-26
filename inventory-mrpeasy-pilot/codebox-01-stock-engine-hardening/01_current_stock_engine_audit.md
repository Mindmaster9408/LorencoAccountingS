# Codebox 01 — Current Stock Engine Audit
**Date:** May 2026  
**Status:** Complete  

---

## 1. What Exists Today

### The Broken RPC: `adjust_inventory_stock()`

Deployed in migrations 016 and 041. Migration 041 replaced 016's version with an extended costing version. Both carry the same bug: the INSERT into `stock_movements` uses wrong column names.

The function in migration 041 is architecturally correct:
- `SELECT ... FOR UPDATE` row lock ✓
- Weighted average cost computation ✓
- Atomically updates `inventory_items` ✓
- Inserts into `stock_valuation_movements` (forensic ledger) ✓
- Creates FIFO cost layers in `inventory_cost_layers` ✓
- Appends to `item_cost_history` when cost changes ✓

The only bug: `INSERT INTO stock_movements` uses `type` (column is `movement_type`) and `cost_price` (column is `unit_cost`). This causes a PostgreSQL error on every call.

### The Workaround: `adjustStock()` in `stock-helpers.js`

Created specifically to work around the broken RPC. Uses correct column names. Does NOT write to the forensic cost tables (`stock_valuation_movements`, `inventory_cost_layers`, `item_cost_history`).

**Architectural deficiencies:**
1. No DB-level row lock — race condition window between SELECT and UPDATE
2. Does not populate `stock_valuation_movements` — forensic audit trail is blank
3. Does not create FIFO cost layers — costing foundation never activated
4. Does not record `item_cost_history` — cost changes are untracked
5. Weighted average computed in JavaScript — subject to floating point precision drift vs. PostgreSQL ROUND()

### The Critical Path: `POST /purchase-orders/:id/receive`

This route (index.js line 726) was NEVER updated to use `adjustStock()`. It still calls `supabase.rpc('adjust_inventory_stock', {...})` directly. Because the RPC is broken, PO receives fail silently (the RPC returns `{ success: false, error: '...' }` or Supabase returns an error).

This is the highest-severity bug in the current inventory module.

---

## 2. Call Site Inventory

### index.js

**Call site 1 — `POST /movements`** (line ~393)
```javascript
const result = await adjustStock(supabase, {
  companyId:    req.companyId,
  itemId:       parseInt(item_id),
  delta,
  movementType: type,
  warehouseId:  warehouse_id ? parseInt(warehouse_id) : null,
  reference:    reference || null,
  notes:        notes || null,
  costPrice:    cost_price ? parseFloat(cost_price) : null,
  createdBy:    req.user.userId,
  sourceType:   'manual',
  sourceId:     null
});
```

**Call site 2 — `POST /quick-receive`** (line ~480)
```javascript
const result = await adjustStock(supabase, {
  companyId:    req.companyId,
  itemId:       parseInt(item_id),
  delta:        qty,
  movementType: 'in',
  warehouseId:  warehouse_id ? parseInt(warehouse_id) : null,
  reference,
  notes:        notes || `Quick receive from ${supplier.name}`,
  costPrice:    cost,
  createdBy:    req.user.userId,
  sourceType:   'quick_receive',
  sourceId:     reference
});
```

**Call site 3 — `POST /purchase-orders/:id/receive`** (line ~726) — **BROKEN**
```javascript
const { data: rpcResult, error: rpcErr } = await supabase.rpc('adjust_inventory_stock', {
  p_company_id:    req.companyId,
  p_item_id:       poItem.item_id,
  p_delta:         recQty,
  p_movement_type: 'in',
  p_warehouse_id:  null,
  p_reference:     `PO-${req.params.id}`,
  p_notes:         notes || `Received from PO #${req.params.id}`,
  p_cost_price:    poItem.unit_price ? parseFloat(poItem.unit_price) : null,
  p_created_by:    req.user.userId,
  p_source_type:   'po_receive',
  p_source_id:     String(req.params.id)
});
```

### work-orders.js

**Call site 4 — `POST /:id/complete`** (line ~302)
```javascript
const rpcResult = await adjustStock(supabase, {
  companyId:    req.companyId,
  itemId:       wo.item_id,
  delta:        qtyProduced,
  movementType: 'in',
  warehouseId:  null,
  reference:    `WO-${req.params.id}`,
  notes:        'Received from work order completion',
  costPrice:    woUnitCost || null,
  createdBy:    req.user.userId,
  sourceType:   'wo_complete',
  sourceId:     String(req.params.id)
});
```

**Call site 5 — `POST /:id/issue-materials`** (line ~410)
```javascript
const issueResult = await adjustStock(supabase, {
  companyId:    req.companyId,
  itemId:       mat.item_id,
  delta:        -qty,
  movementType: 'out',
  warehouseId:  null,
  reference:    `WO-${req.params.id}`,
  notes:        `Issued to work order ${req.params.id}`,
  costPrice:    issueCost,
  createdBy:    req.user.userId,
  sourceType:   'wo_issue',
  sourceId:     String(req.params.id)
});
```

---

## 3. What the Fix Must Deliver

1. Correct the `adjust_inventory_stock()` RPC column names → `movement_type`, `unit_cost`
2. Create `stockMutationService.adjustStockTx()` as the single, tested interface to the fixed RPC
3. Replace all 5 call sites with `adjustStockTx()` 
4. Validate `chk_current_stock_non_negative` constraint
5. Forensic tables (`stock_valuation_movements`, `inventory_cost_layers`, `item_cost_history`) begin populating from this point forward

---

## 4. What Is NOT Changing

- The `stock_movements` table schema — column names are already correct in the table
- The `stock_valuation_movements`, `inventory_cost_layers`, `item_cost_history` table schemas — already correct from migration 041
- The `inventory_items` costing columns — already correct from migration 041
- The POS stock mutation RPCs — completely separate, not touched
- The `costingService.js` — remains in place; it handles above-RPC costing concerns
- The `companyId` isolation pattern — preserved exactly
- The auth middleware — not touched
- Any frontend code — not touched
