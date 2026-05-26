# Codebox 03 — Stock Count Architecture
**Date:** June 2026  
**Module:** Lorenco Storehouse — Stock Counts & Variance Control

---

## 1. DESIGN PHILOSOPHY

Stock counting in a compliance accounting system is a **forensic event**, not a spreadsheet exercise.

Every count session must be:
- **Auditable** — who started it, who counted, who approved, what changed
- **Immutable once applied** — applied sessions cannot be re-applied
- **Company-isolated** — no cross-tenant data leakage
- **Mutation-safe** — stock changes only through `adjustStockTx()`, never direct writes

---

## 2. SESSION LIFECYCLE

```
[draft] → [in_progress] → [submitted] → [approved] → [applied]
                                      ↘ [rejected]
                                      ↘ [recount_required → in_progress again]
          [cancelled] ← draft or in_progress only
```

- `draft` — session created, lines generated but count not started
- `in_progress` — counters are actively recording quantities
- `submitted` — all lines counted, submitted for management approval
- `approved` — management approved; variance ready to apply
- `rejected` — management rejected; session closed, no stock change
- `applied` — variance applied to stock via `adjustStockTx()`; immutable
- `cancelled` — session abandoned before submission

---

## 3. DATA FLOW

```
User clicks "Start Count"
        ↓
POST /api/inventory/stock-counts
        ↓
stockCountService.createCountSession()
  → INSERT stock_count_sessions (status: 'in_progress')
  → stockCountService.generateCountLines()
    → SELECT inventory_items WHERE company_id = X (filtered by mode)
    → INSERT stock_count_lines (system_quantity = current_stock SNAPSHOT, counted_quantity = NULL)
        ↓
Counter enters quantities via PATCH /lines/:lineId
  → stockCountService.updateCountLine()
  → UPDATE stock_count_lines SET counted_quantity = X
        ↓
POST /:id/submit
  → Validate all lines have counted_quantity
  → Calculate variance_quantity = counted - system
  → Calculate variance_value = variance_quantity × average_cost
  → SET status = 'submitted'
        ↓
POST /:id/approve (action: approved | rejected | recount_required)
  → INSERT stock_count_approvals (immutable audit record)
  → Update session status accordingly
        ↓
POST /:id/apply  [only if status = 'approved']
  → Idempotency guard: conditional UPDATE WHERE status='approved' → 'applied'
  → For each line where variance_quantity ≠ 0:
    → adjustStockTx(... movementType: 'count_adjustment_in' or 'count_adjustment_out')
        ↓
stock_movements row created (source_type='stock_count', source_id=sessionId)
inventory_items.current_stock updated atomically by adjust_inventory_stock() RPC
```

---

## 4. BLIND COUNT DESIGN

When `blind_count = true`:
- **Backend enforces:** `getCountSession()` returns `system_quantity = null`, `variance_quantity = null`, `variance_value = null` for sessions not yet submitted/approved/rejected/applied
- **Frontend enforces:** columns for system_qty and variance are hidden in the count lines table when `isBlind = true`
- Purpose: prevent counters from anchoring to the system quantity before they record their physical count

After the session is submitted, the blind is lifted — management can see all values.

---

## 5. VARIANCE DIRECTION CONVENTION

```
variance_quantity = counted_quantity − system_quantity

Positive → stock gain (more found than system shows)  → count_adjustment_IN
Negative → stock loss (less found than system shows)  → count_adjustment_OUT
Zero     → no movement created (skipped)
```

---

## 6. IDEMPOTENCY GUARD ON APPLY

`applyApprovedVariance()` uses:
```javascript
const { data: lockResult } = await supabase
  .from('stock_count_sessions')
  .update({ status: 'applied', applied_at: now })
  .eq('id', sessionId)
  .eq('company_id', companyId)
  .eq('status', 'approved')  // ← only succeeds if still 'approved'
  .select('id');

if (!lockResult?.length) return { already_applied: true };
```
This ensures that concurrent double-clicks or retries do not produce duplicate stock movements.

---

## 7. KEY DESIGN DECISIONS

| Decision | Rationale |
|---|---|
| `count_adjustment_in` / `count_adjustment_out` as distinct movement types | Allows movement history to distinguish between operational movements and count corrections. Does not conflict with existing types. |
| System quantity snapshotted at line creation (immutable) | Variance is always calculated against a fixed reference point, not a moving target. |
| `stock_count_approvals` is insert-only | Provides complete approval audit trail. No UPDATE or DELETE permitted on this table. |
| Freeze inventory is a field only (not enforced) | Cross-service enforcement is complex and risky. Field is captured for future Codebox. |
| No RBAC yet | Consistent with all other inventory routes. Future `INVENTORY_COUNTS` permission documented in `06_permission_prep.md`. |
