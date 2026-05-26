# Codebox 03 — Variance Governance
**Date:** June 2026

---

## 1. WHAT IS VARIANCE?

Variance = the difference between what the system says you have and what physically exists.

```
variance_quantity = counted_quantity − system_quantity
variance_value    = variance_quantity × average_cost
```

A positive variance means more was found than the system recorded (stock gain).  
A negative variance means less was found than the system recorded (stock loss).

---

## 2. APPROVED VARIANCE REASONS

| Code | Label | When to use |
|---|---|---|
| `damaged` | Damaged | Items found in unsellable condition |
| `theft` | Theft | Items missing due to suspected theft |
| `data_entry_error` | Data Entry Error | Previous receipt or sale was incorrectly captured |
| `receiving_error` | Receiving Error | PO was received incorrectly (over/under) |
| `production_waste` | Production Waste | Materials consumed in production but not recorded |
| `found_stock` | Found Stock | Items found that were not on record (positive variance) |
| `system_error` | System Error | Software or integration error caused incorrect stock level |
| `other` | Other | None of the above — require notes |

---

## 3. THE FOUR-STEP CONTROL PROCESS

```
Step 1: COUNT
  Counter physically counts items and enters quantities per line.
  Blind count option prevents anchoring to system numbers.

Step 2: SUBMIT
  All lines must have a counted_quantity before submission.
  System calculates variance_quantity and variance_value automatically.
  Session moves to 'submitted' status.

Step 3: APPROVE
  Approver (management/senior) reviews all variances.
  Three possible decisions:
    approved         — variance is accepted; ready to apply
    rejected         — variance is not accepted; session closed; no stock change
    recount_required — session returned to in_progress for re-counting

Step 4: APPLY
  Only applies if status = 'approved'.
  Idempotency guard ensures it can only be applied once.
  Each non-zero variance line produces a stock_movement via adjustStockTx().
  Session becomes 'applied' — permanently immutable.
```

---

## 4. WHAT HAPPENS TO STOCK

When variance is applied:
- `count_adjustment_in` (positive variance) → `current_stock` increases
- `count_adjustment_out` (negative variance) → `current_stock` decreases
- Zero variance lines → no movement created (skipped)

All movements are traceable via:
```sql
SELECT * FROM stock_movements
WHERE source_type = 'stock_count'
AND   source_id   = '<session_id>'
AND   company_id  = '<company_id>';
```

---

## 5. AUDIT TRAIL

### What is permanently recorded

| Record | Where | Immutable? |
|---|---|---|
| Session header (who, when, type, notes) | `stock_count_sessions` | After 'applied' |
| System quantity snapshot | `stock_count_lines.system_quantity` | Yes — never changes after creation |
| Counted quantity + reason | `stock_count_lines` | After 'submitted' |
| Approval decision + notes | `stock_count_approvals` | Yes — insert-only table |
| Stock movements created | `stock_movements` | Yes — insert-only |
| Cost snapshot at time of count | `stock_count_lines.average_cost` | Yes — never changes after creation |

### What a complete audit looks like

For any count session, you can reconstruct:
1. Who started it and when
2. What the system quantities were at count time
3. What the counter recorded
4. Who approved and what reason was given
5. What stock movements were created
6. What the net financial impact was (variance_value sum)

---

## 6. HARD RULES — NEVER VIOLATE

1. **Rejected sessions never change stock.** The `applyApprovedVariance()` function checks `status = 'approved'` before doing anything.
2. **Applied sessions cannot be re-applied.** The idempotency guard `WHERE status='approved'` in the conditional UPDATE ensures once applied, the guard fails.
3. **system_quantity is frozen at creation.** `generateCountLines()` snapshots `current_stock` at the moment of session creation and never updates it.
4. **All stock mutations go through `adjustStockTx()`.** No direct `UPDATE inventory_items SET current_stock = ...` is ever used.
5. **No variance data in browser storage.** All count state lives in Supabase.
