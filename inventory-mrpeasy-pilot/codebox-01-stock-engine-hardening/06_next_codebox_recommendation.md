# Codebox 01 → Codebox 02 Recommendation
**Date:** May 2026  

---

## What Codebox 01 Delivered

The stock mutation layer is now atomic, forensic, and race-condition-safe. The `stock_valuation_movements`, `inventory_cost_layers`, and `item_cost_history` tables are now being populated for every stock change.

---

## Recommended: Codebox 02 — Stock Valuation & Cost Reporting

**Why this is the natural next step:**

Codebox 01 fixed the data pipeline. The forensic tables now have data. Codebox 02 can use that data to deliver real cost visibility to the business:

1. **Stock Valuation Report** — total inventory value at weighted average cost, per item, per warehouse, per category
2. **Cost Movement History** — per-item view of every cost change with old/new avg cost
3. **FIFO Layer View** — show remaining FIFO cost layers per item (what the current stock is "worth" under FIFO)
4. **Cost Drift Alerts** — items whose average_cost has drifted more than X% from last_purchase_cost

**Backend:** Queries against `stock_valuation_movements` and `inventory_cost_layers`  
**Frontend:** New tab or section in the Storehouse reports page  
**DB:** No new migrations needed — tables already exist from migration 041

---

## Alternative: Codebox 02 — Atomic Issue-Materials Transaction

**Why this might be higher priority:**

Currently, `issue-materials` runs in a JavaScript loop. Each iteration is a separate DB call. If the server crashes mid-loop, some materials are issued but others are not — a partial state that requires manual correction.

Fixing this requires:
1. A new PostgreSQL function `inventory_issue_materials_tx(p_wo_id, p_issues JSONB)` that processes all issues in a single DB transaction
2. Replacing the JS loop in `work-orders.js` with a single RPC call
3. Adding a `work_order_issue_log` table to record which materials were issued in which batch

---

## Decision for Ruan

| Option | Business value | Technical urgency |
|--------|---------------|------------------|
| Codebox 02 — Stock Valuation Reports | High — MRPeasy pilot needs cost visibility | Medium |
| Codebox 02 — Atomic Issue-Materials | Medium — correctness improvement | High for high-volume WOs |

Recommend: **Stock Valuation Reports** first (higher business visibility for the MRPeasy pilot), then **Atomic Issue-Materials** in Codebox 03.
