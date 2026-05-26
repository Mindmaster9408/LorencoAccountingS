# Codebox 02 — Accounting Integration Prep

**Date:** May 2026  
**Status:** Fields added. No GL posting logic. Full integration deferred to future Codebox.

---

## Purpose

Codebox 02 prepares the inventory data model for future accounting integration by adding three nullable GL account fields to `inventory_items`. These fields are not yet read by any route or service. No journal entries are created in Codebox 02.

---

## New Fields on inventory_items

| Column | Type | FK | Purpose |
|---|---|---|---|
| `inventory_asset_account_id` | INTEGER | None (yet) | GL account to debit when stock is received |
| `cogs_account_id` | INTEGER | None (yet) | GL account to debit when materials are issued (consumed) |
| `wip_account_id` | INTEGER | None (yet) | GL account to debit when materials are issued to a work order |

All three are nullable. Items without account assignments will remain invisible to any future GL posting logic until explicitly configured.

**No FK constraint yet** — the Chart of Accounts table and its ID space are defined in the accounting module. The FK relationship will be formalized when the GL posting service is built.

---

## Intended GL Flow (Future — Not Active)

The following describes the accounting entries that these fields will support when GL posting is activated in a future Codebox.

### Event 1: Purchase Order Receive

```
DR  inventory_asset_account_id  (qty × unit_cost)
CR  Accounts Payable             (qty × unit_cost)
```

**Cost source:** `unit_price` from PO line (already captured in `stockMutationService.adjustStockTx`)

---

### Event 2: Material Issue to Work Order

```
DR  wip_account_id               (qty × issue_unit_cost)
CR  inventory_asset_account_id   (qty × issue_unit_cost)
```

**Cost source:** `issue_unit_cost` from `work_order_materials` — frozen at issue time. Available from Codebox 02.

---

### Event 3: Work Order Completion (Finished Good Produced)

```
DR  inventory_asset_account_id   (finished_good)    (completedQty × finalized_unit_cost)
CR  wip_account_id               (completedQty × finalized_unit_cost)
```

**Cost source:** `unit_cost` from `work_order_costs` — computed at WO finalization.

---

### Event 4: COGS on Sale / Delivery

```
DR  cogs_account_id              (qty × average_cost at time of dispatch)
CR  inventory_asset_account_id   (qty × average_cost at time of dispatch)
```

**Cost source:** Item's `average_cost` at time of stock-out (captured in `stock_valuation_movements.unit_cost`).

---

## Integration Prerequisites

Before GL posting can be activated, all of the following must be true:

1. **Chart of Accounts exists** — the accounting module must have a `chart_of_accounts` table with proper company scoping
2. **Account IDs assigned** — each inventory item must have `inventory_asset_account_id`, `cogs_account_id`, `wip_account_id` populated; OR company-level defaults must be configured for items without explicit assignments
3. **GL Posting Service built** — a dedicated service (e.g., `glPostingService.js`) must exist to create journal entries atomically with stock movements
4. **Double-entry validation** — all journal entries must balance (DR = CR) before commit
5. **Currency handling confirmed** — the accounting module's rounding and currency precision must match inventory's NUMERIC(12,4) cost precision

None of the above exist in Codebox 02. All are future milestones.

---

## What This Means for the Current Pilot

The MrEasy pilot operates in inventory-only mode. Financial reporting uses the inventory module's own stock valuation report, not a GL trial balance.

The three new fields on `inventory_items` are currently:
- Insertable and updateable via direct DB access or a future admin UI
- Ignored by all current inventory routes
- Safe to leave null for all existing items

When the accounting integration Codebox is ready, the migration path will be:
1. Assign account IDs to items (or set company defaults)
2. Activate GL posting service
3. All movements from activation date forward will generate journal entries
4. Backfill of pre-activation movements is NOT planned (not retroactive posting)

---

## No Changes to Existing Accounting Module

Codebox 02 adds no code to any file outside `accounting-ecosystem/backend/modules/inventory/` and `accounting-ecosystem/database/migrations/`.

The existing accounting, GL, and financial reporting modules are untouched.
