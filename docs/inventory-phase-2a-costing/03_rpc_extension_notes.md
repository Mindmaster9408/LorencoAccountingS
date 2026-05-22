# Phase 2A — RPC Extension Notes
**Date:** 2026-05-22

---

## `adjust_inventory_stock()` — What Changed

### Old signature (migration 016)
```sql
adjust_inventory_stock(
  p_company_id    INTEGER,
  p_item_id       INTEGER,
  p_delta         NUMERIC,
  p_movement_type VARCHAR(50),
  p_warehouse_id  INTEGER      DEFAULT NULL,
  p_reference     VARCHAR(255) DEFAULT NULL,
  p_notes         TEXT         DEFAULT NULL,
  p_cost_price    NUMERIC      DEFAULT NULL,
  p_created_by    INTEGER      DEFAULT NULL
)
RETURNS JSONB  -- { success, new_stock } or { success: false, error, available }
```

### New signature (migration 041)
```sql
adjust_inventory_stock(
  p_company_id    INTEGER,
  p_item_id       INTEGER,
  p_delta         NUMERIC,
  p_movement_type VARCHAR(50),
  p_warehouse_id  INTEGER      DEFAULT NULL,
  p_reference     VARCHAR(255) DEFAULT NULL,
  p_notes         TEXT         DEFAULT NULL,
  p_cost_price    NUMERIC      DEFAULT NULL,
  p_created_by    INTEGER      DEFAULT NULL,
  p_source_type   VARCHAR(50)  DEFAULT NULL,   -- NEW
  p_source_id     VARCHAR(255) DEFAULT NULL    -- NEW
)
RETURNS JSONB  -- { success, new_stock, new_avg_cost } or { success: false, error, available }
```

### Backward compatibility
Two new parameters (`p_source_type`, `p_source_id`) are added at the END of the parameter list with `DEFAULT NULL`. All existing callers using named parameters (`p_company_id: ..., p_item_id: ...`) continue to work without any changes. The new parameters simply receive `NULL` from old callers, which is handled gracefully throughout the function body.

---

## What the Extended RPC Now Does (Step by Step)

1. **`SELECT ... FOR UPDATE`** — Locks the `inventory_items` row for the duration of the transaction. Prevents two concurrent receives from computing stale weighted averages simultaneously.

2. **Stock sufficiency check** — If `p_delta < 0` and result would be negative, returns `{success: false, error: 'Insufficient stock'}` immediately (same behavior as before).

3. **Weighted average computation** — Only when `p_delta > 0` AND `p_cost_price IS NOT NULL`:
   ```sql
   IF v_old_stock <= 0 THEN
     v_new_avg := p_cost_price;
   ELSE
     v_new_avg := ROUND(
       ((v_old_stock * v_old_avg) + (p_delta * p_cost_price)) / (v_old_stock + p_delta),
       6
     );
   END IF;
   ```
   If `p_cost_price` is NULL (old callers), `v_new_avg` stays unchanged.

4. **Atomic `UPDATE inventory_items`** — Updates:
   - `current_stock` (same as before)
   - `average_cost` (new — set to `v_new_avg`)
   - `last_purchase_cost` (new — set to `p_cost_price` only when `p_source_type = 'po_receive'`)
   - `cost_updated_at` (new — set to `NOW()` only when `p_cost_price IS NOT NULL`)
   - `cost_source` (new — set to `p_source_type` if provided)
   - `updated_at` (same as before)

5. **`INSERT INTO stock_movements`** — Identical to before. `RETURNING id INTO v_movement_id` added to capture the movement ID for the valuation ledger FK.

6. **`INSERT INTO stock_valuation_movements`** — Written for EVERY movement (even when `p_cost_price` is NULL). When cost is unknown, `unit_cost` falls back to the pre-movement `v_old_avg`. This means even historical movements without explicit cost have a best-effort cost estimate in the ledger.

7. **`INSERT INTO inventory_cost_layers`** — Written ONLY when `p_delta > 0 AND p_cost_price IS NOT NULL`. Creates a FIFO batch for future FIFO depletion logic.

8. **`INSERT INTO item_cost_history`** — Written ONLY when `v_new_avg IS DISTINCT FROM v_old_avg`. This means it only fires when the weighted average actually changed — not on every movement.

---

## Return Value Change

Old: `{ "success": true, "new_stock": 42.0 }`  
New: `{ "success": true, "new_stock": 42.0, "new_avg_cost": 25.50 }`

The `new_avg_cost` field is new. Existing code that checks `rpcResult.success` and `rpcResult.new_stock` is unaffected. Code can optionally read `rpcResult.new_avg_cost` to display or log the updated weighted average.

---

## Error Response (Unchanged)

```json
{ "success": false, "error": "Insufficient stock", "available": 10.0 }
{ "success": false, "error": "Item not found" }
```

These are identical to the old behavior. No breaking changes.

---

## Migration Safety

- `CREATE OR REPLACE FUNCTION` — replaces the existing function without requiring a DROP. No downtime.
- The new tables and columns are created with `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` — safe to re-run.
- The backfill (`UPDATE inventory_items SET average_cost = cost_price WHERE...`) only updates rows where `average_cost = 0 OR NULL` and `cost_price IS NOT NULL` — no existing data overwritten.
