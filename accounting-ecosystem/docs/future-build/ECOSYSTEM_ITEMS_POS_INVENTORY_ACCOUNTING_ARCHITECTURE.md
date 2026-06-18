# Ecosystem Items, POS, Inventory & Accounting — Integration Architecture

**Status:** Future Architecture Blueprint (NOT yet implemented)  
**Authored:** ACC-CORE-033  
**Applies to:** Lorenco Accounting, Checkout Charlie (POS), Lorenco Storehouse (Inventory)

---

## 1. Source-of-Truth Boundaries

Each system owns its own truth. No system silently duplicates another's truth.

| Domain | System | Source of Truth |
|---|---|---|
| Financial transactions, GL, journals | Lorenco Accounting | `journals`, `journal_lines` |
| Accounts receivable, invoices | Lorenco Accounting | `customer_invoices`, `customer_invoice_lines` |
| Accounts payable | Lorenco Accounting | `supplier_invoices`, `supplier_invoice_lines` |
| Stock quantities, movements | Lorenco Storehouse | `inventory_items`, `stock_movements` |
| POS sales transactions | Checkout Charlie | `sales`, `sale_items` |
| Item/service master (accounting) | Lorenco Accounting | `accounting_items` |

**Rule:** A piece of data lives in exactly one place. All other systems reference it by ID or pull it via API — they never maintain their own parallel copy.

---

## 2. Shared Item Master Concept (Future)

### Current state (ACC-CORE-033)
Each system has its own item concept:
- `accounting_items` — financial item/service catalogue (created in this workstream)
- `inventory_items` — Storehouse stock-tracked items
- POS products — Checkout Charlie product catalogue

### Future state (not yet implemented)
A shared item master will unify these. The architecture must allow:
- A single canonical item record with `item_id`
- Each system adds its own extension: Storehouse adds stock fields, Accounting adds income account, POS adds price tiers
- Synchronisation is event-driven, not database join

**Design principle:** No shared table across modules. Shared identity via a common `ecosystem_item_id` reference. Each module's table adds its own fields.

---

## 3. Sales Event Reconciliation Layer (Future)

### Problem
A POS sale and an accounting invoice both record revenue for the same transaction. Without a reconciliation layer, GL could be posted twice.

### Solution: Source Event Deduplication
Every GL posting from an external source must carry a source-event fingerprint:

```
company_id  + source_type + source_id + event_hash
```

Example:
- `source_type = 'pos_sale'`, `source_id = 4521`, `event_hash = sha256(amount + date + items)`
- Before posting, check `source_event_log` for this tuple
- If found: return the existing journal without creating a new one
- If not found: post to GL, then insert into `source_event_log`

**This table does not exist yet. It must be created before any POS → Accounting auto-sync is built.**

---

## 4. Integration Rules (Absolute — Must Not Be Violated)

### 4.1 No external sale may post to GL without source-event duplicate check
POS sales, e-commerce orders, or any automated revenue source must pass through the source-event deduplication layer before touching `journals` or `journal_lines`.

### 4.2 POS and Accounting sales must be reconcilable
At any point in time it must be possible to produce a report showing:
- Total POS sales for period X
- Total AR invoices posted for period X
- Delta (unexplained difference → must be investigated, never silently accepted)

### 4.3 Inventory stock movements must never be silently duplicated
A stock decrease caused by a POS sale must not also be triggered by the corresponding accounting invoice. One event = one movement. The trigger must be determined architecturally (either POS triggers it OR Accounting triggers it — never both).

### 4.4 COGS is future work
COGS (Cost of Goods Sold) posting is **not part of ACC-CORE-033**. It requires:
- Average cost tracking in Storehouse
- Cost lookup at time of sale
- GL entry: DR COGS / CR Inventory

COGS must not be partially implemented. It is all-or-nothing from a data integrity standpoint.

---

## 5. Future Integration Examples

### 5.1 POS Sale → Accounting GL (future)
```
POS: sale #4521 completes
  → emit SaleEvent { company_id, source_type='pos_sale', source_id=4521, amount, date, items }
  → Accounting source-event check: seen before? → skip. New? → post GL:
      DR AR (or Cash) / CR Revenue / CR VAT Output
  → Insert into source_event_log
```

### 5.2 Accounting Invoice → Inventory Movement (future, optional)
```
Accounting: invoice #INV-0012 posted for inventory item X
  → If item.item_type = 'inventory':
      → emit StockDecreaseEvent { company_id, item_id, qty, source='accounting_invoice', source_id=invoice_id }
      → Storehouse processes movement only if not already recorded from POS
```

### 5.3 Inventory Movement → Accounting Journal (future)
```
Storehouse: stock adjustment #1041 (write-off)
  → emit AdjustmentEvent { company_id, item_id, qty, cost_per_unit, type='write_off' }
  → Accounting: DR Inventory Write-off Expense / CR Inventory Asset
  → Source-event deduplication prevents double-post on retry
```

---

## 6. What ACC-CORE-033 Deliberately Does NOT Build

These items are explicitly deferred. The workstream boundary is a hard line:

| Deferred Item | Reason |
|---|---|
| Stock movement on invoice | Requires COGS, cost averaging, Storehouse sync — all future |
| COGS posting | Requires average cost tracking — not available yet |
| POS ↔ Accounting auto-sync | Requires source-event deduplication layer first |
| Shared item master | Requires ecosystem-wide item ID architecture first |
| Invoice → Storehouse deduction | Requires source-event layer + cost lookup |

**Nothing in ACC-CORE-033 blocks these future integrations. The `accounting_items` table and `line_type`/`item_id` columns on invoice lines are the foundation they build on.**

---

## 7. Schema Reference

### `accounting_items` (created in migration 029)
```sql
id, company_id, item_code, item_name, item_type, description,
selling_price, income_account_id, tax_type, is_active, created_at, updated_at
```
- `income_account_id` → resolves to `accounts.id` for GL posting
- `item_type` ∈ { 'service', 'inventory', 'non_stock' }
- `tax_type` ∈ { 'standard', 'zero_rated', 'exempt' }

### `customer_invoice_lines` additions (migration 029)
```sql
line_type TEXT DEFAULT 'account' CHECK (line_type IN ('account', 'item'))
item_id   INTEGER REFERENCES accounting_items(id) ON DELETE SET NULL
```
- For `line_type = 'item'`: `account_id` is populated from `item.income_account_id` at save time
- GL posting reads `account_id` for both line types — posting engine unchanged

---

*This document describes intended future architecture, not current implementation.  
Implement nothing from this document without a dedicated workstream and explicit authorization.*
