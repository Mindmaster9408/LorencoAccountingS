# Codebox 02 — Risk Register

**Date:** May 2026  
**Status:** All identified risks either fixed, accepted with documentation, or open with clear resolution path

---

## Risk Summary

| ID | Risk | Severity | Status |
|---|---|---|---|
| R01 | `costing_method` constraint missing 'last_cost' | Medium | **FIXED** |
| R02 | No DB-level non-negative cost guards | Medium | **FIXED** |
| R03 | Valuation ledger missing before-state values | High | **FIXED** |
| R04 | WO cost summary uses current price, not issue-time price | High | **FIXED** |
| R05 | Duplicate cost fallback chains across 3 files | Medium | **FIXED** |
| R06 | Stock valuation report missing consumables + sub_assembly totals | Low | **FIXED** |
| R07 | Multi-batch issue overwrites `issue_unit_cost` per component row | Low | **ACCEPTED** |
| R08 | FIFO layers recorded but not consumed | Accepted | **DOCUMENTED** |
| R09 | Migration 050 not yet deployed | High | **OPEN** |
| R10 | NOT VALID constraints not yet validated | Low | **OPEN** |

---

## Detailed Risk Notes

---

### R01 — costing_method constraint missing 'last_cost'

**Risk:** Any attempt to set `costing_method = 'last_cost'` on an item would raise a PostgreSQL CHECK constraint violation. Items intended for last-purchase-cost valuation could not be configured.

**Severity:** Medium — functional gap affecting configuration capability.

**Fix:** Migration 051 Step 1 drops the old auto-named CHECK constraint and recreates as `inventory_items_costing_method_check` with `('average', 'fifo', 'standard', 'last_cost')`.

**Status: FIXED in migration 051.**

---

### R02 — No DB-level non-negative cost guards

**Risk:** Application-level validation is the only barrier against negative cost values being written to `average_cost`, `standard_cost`, `last_purchase_cost`. A bug or direct DB access could corrupt cost data silently.

**Severity:** Medium — data integrity without DB-level defence.

**Fix:** Migration 051 Step 2 adds NOT VALID constraints:
- `chk_average_cost_non_negative`
- `chk_last_purchase_cost_non_negative`
- `chk_standard_cost_non_negative`

All use `IS NULL OR >= 0` semantics (NULL is permitted; the column is nullable).

**NOT VALID:** Does not scan existing rows. Pre-validation query in `02_database_changes.md` must be run before validating. No existing negative values found in audit.

**Status: FIXED in migration 051. Validation deferred to maintenance window.**

---

### R03 — Valuation ledger missing before-state values

**Risk:** `stock_valuation_movements` had no record of `average_cost` or `stock_qty` before each movement. Reconstructing the before-state required reading the prior row sorted by `created_at` — fragile in concurrent environments and error-prone in analysis.

**Impact:** Forensic audit of cost changes was incomplete. Any concurrent events on the same item could produce out-of-order rows making reconstruction unreliable.

**Severity:** High — forensic/audit completeness gap.

**Fix:** Migration 051 Steps 3 and 4 add `previous_average_cost` and `previous_stock` columns and update the RPC to populate them at insert time from the already-locked row values. Existing rows retain NULL (correct — no retroactive data fabrication).

**Status: FIXED in migration 051 (for new rows from deployment date onwards).**

---

### R04 — WO cost summary re-reads current price instead of issue-time price

**Risk:** `GET /work-orders/:id/cost-summary` fetched the current `average_cost` of each component to compute issued cost. If any component's price changed between the time of issue and the time of report, the cost summary showed wrong figures.

For finalized WOs (months-old) this was a guaranteed accuracy problem.

**Severity:** High — financial reporting accuracy. WO profitability analysis is directly affected.

**Fix:**
1. `work_order_materials` now stores `issue_unit_cost` (frozen at issue time, via migration 051 Step 5 + work-orders.js PHASE 2 change)
2. Cost summary endpoint now uses `issue_unit_cost` per component if populated (`cost_basis: 'frozen_at_issue'`), falls back to current estimate for pre-Codebox-02 rows (`cost_basis: 'current_estimate'`)
3. Material cost total is sourced from `work_order_costs.material_cost` (accumulated sum from issue events) when available — this is the authoritative number independent of any current-price recalculation

**Status: FIXED.**

---

### R05 — Duplicate cost fallback chains in three places

**Risk:** Three independent inline fallback chains existed:
1. `boms.js` — `average_cost || last_purchase_cost || cost_price`
2. `work-orders.js` — `average_cost || cost_price || null`
3. `costingService.js` — similar chain

None of the three was aware of `costing_method`. All defaulted to `average_cost` regardless of the item's configured valuation method.

A future change to cost dispatch logic would require updating all three. One would inevitably be missed.

**Severity:** Medium — maintainability and correctness gap. Items configured for `standard` or `last_cost` were silently costed at average.

**Fix:** `getIssueCostFromItemData()` in costingService.js centralizes the dispatch. All three call sites now use this single function.

**Status: FIXED.**

---

### R06 — Stock valuation report missing consumables and sub_assembly totals

**Risk:** `GET /reports/stock-valuation` returned `total_value`, `raw_material_value`, `finished_goods_value` but omitted consumable and sub-assembly categories. These could be significant lines for GL reconciliation and financial reporting prep.

**Severity:** Low — data gap, not financial error. Totals still added up correctly overall.

**Fix:** Added `consumables_value` and `sub_assembly_value` computations to the response using the same pattern as existing category totals.

**Status: FIXED.**

---

### R07 — Multi-batch issue overwrites issue_unit_cost

**Risk:** If materials for one WO line are issued in multiple batches (e.g., issue 5 units, then issue 3 more units of the same material), the `work_order_materials.issue_unit_cost` UPDATE overwrites the previous value with the latest issue cost.

Per-component `issue_unit_cost` therefore reflects only the last batch's cost, not a weighted average of all batches.

**Note:** The accumulated `work_order_costs.material_cost` total is NOT affected — it accumulates correctly across all batch issues. Only the per-component display cost is potentially wrong for multi-batch scenarios.

**Severity:** Low — affects per-component display only, not the authoritative total.

**Pilot scope:** MrEasy pilot work orders are expected to be single-issue per component. Multi-batch is not a pilot scenario.

**Mitigation for future:** Change `issue_unit_cost` to a weighted-average-over-issues computed field (or store per-issue sub-rows). Track as follow-up item.

**Status: ACCEPTED. Tracked as follow-up. Not a blocking item for Codebox 02 sign-off.**

---

### R08 — FIFO layers recorded but not consumed

**Risk:** The `adjust_inventory_stock` RPC inserts FIFO cost layers into `inventory_cost_layers` on every stock-in event. However, the FIFO layer consumption algorithm (matching issues to the oldest layers first) does not exist yet.

Items configured with `costing_method = 'fifo'` are silently treated as `average` cost for issue pricing.

**Severity:** Low for pilot — FIFO-method items should not be created in the pilot phase until the consumption algorithm is built.

**Documentation:** `getIssueCostFromItemData` returns `source: 'fifo_proxy_average'` when this occurs, making the proxy transparent in logs.

**Resolution path:** Codebox 05+ — FIFO layer consumption algorithm.

**Status: DOCUMENTED. ACCEPTED for pilot. Clearly surfaced in architecture docs.**

---

### R09 — Migration 050 not yet deployed

**Risk:** Migration 050 created the updated `adjust_inventory_stock` RPC with FIFO layer insertion and `item_cost_history` logging. Migration 051 depends on this base RPC. If 051 runs without 050, the `CREATE OR REPLACE` in Step 4 may restore an older function version instead of extending 050's version.

**Severity:** High — deployment sequencing risk.

**Resolution:** Deploy in strict order:
1. Run migration 050 first
2. Verify with query: `SELECT proname FROM pg_proc WHERE proname = 'adjust_inventory_stock';`
3. Then run migration 051

**Status: OPEN. Must be resolved at deployment time. Blocker for all Codebox 02 DB tests.**

---

### R10 — NOT VALID constraints not yet validated

**Risk:** The three non-negative cost constraints added in Step 2 use `NOT VALID`. This means they do not protect against existing negative values in the table — only new writes are guarded.

**Severity:** Low — pre-migration audit found zero negative cost values in existing data.

**Resolution:** Run the verification query in `02_database_changes.md` (pre-validation check). If zero rows returned, run:
```sql
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_average_cost_non_negative;
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_last_purchase_cost_non_negative;
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_standard_cost_non_negative;
```

**Status: OPEN. Planned for maintenance window after deployment. Not a blocker.**
