# Lorenco Storehouse — Data Flow Diagrams
**Date:** April 24, 2026
**Source:** Backend code analysis — `backend/modules/inventory/index.js`, `routes/boms.js`, `routes/work-orders.js`

---

## Legend
- ✅ Step works correctly
- ⚠️ Step has a known risk or partial implementation
- ❌ Step is missing or broken

---

## Flow 1 — Create Inventory Item

**Trigger:** User fills "Add Item" modal and clicks Save

```
[Frontend]
  ↓  Calls collectItemForm() → assembles payload
  ↓  apiFetch('POST', '/api/inventory/items', payload)

[Middleware]
  ✅ authenticateToken        → sets req.user, req.companyId
  ✅ requireModule('inventory') → checks company has module
  ✅ auditMiddleware           → records action in audit_log

[Backend: POST /api/inventory/items]
  ✅ Extracts: name, sku, description, category, unit, cost_price,
               sell_price, current_stock, min_stock, warehouse_id,
               item_type, barcode, track_lots, track_serials,
               costing_method, lead_time_days
  ✅ Inserts into inventory_items with company_id = req.companyId
  ✅ Returns: { item } with status 201

[Frontend Response]
  ✅ Closes modal
  ✅ Re-fetches allItems[] via loadInventoryItems()
  ✅ Clears _tabLoaded.items → next tab visit reloads
```

**Risk:** `current_stock` can be set to any value on creation — no movement record is created for the opening stock. Stock history does not start at zero.

---

## Flow 2 — Record Stock Movement (in / out / adjustment / return)

**Trigger:** User fills "Record Movement" modal and clicks Save

```
[Frontend]
  ↓  apiFetch('POST', '/api/inventory/movements', {
       item_id, warehouse_id, type, quantity, reference, notes, cost_price
     })

[Backend: POST /api/inventory/movements]
  ✅ Validates: item_id and quantity are present
  ✅ Checks item belongs to company (Supabase query with company_id)
  
  ⚠️ Non-atomic stock update:
  ─────────────────────────────────────────────
  Step A: READ current_stock from inventory_items
     ↓  const currentStock = itemRow.current_stock
  
  Step B: Calculate new stock
     ↓  const delta = ['in', 'return'].includes(type) ? qty : -qty
     ↓  const newStock = currentStock + delta
     ↓  (NO CHECK: newStock could be < 0 — no guard, no rejection)
  
  Step C: Insert into stock_movements
     ↓  { item_id, warehouse_id, type, quantity, reference, notes, cost_price, company_id, created_by }
  
  Step D: UPDATE inventory_items SET current_stock = newStock
     ↓  (If Step D fails, movement exists but stock level is wrong — SILENT PARTIAL FAILURE)
  ─────────────────────────────────────────────
  
  ✅ Returns: { movement, new_stock } with status 201

[Frontend Response]
  ✅ Shows success toast
  ✅ Reloads movements list
  ✅ Reloads items list (to reflect new stock level)
```

**Critical Risks:**
1. **Race condition:** Two concurrent movements on the same item will both read the same `current_stock`, calculate separate deltas, and write conflicting values. Last writer wins. Stock becomes incorrect.
2. **No negative stock check:** Stock can be driven below zero. No DB constraint and no API-level guard.
3. **Partial failure:** Movement record persists even if `current_stock` update fails — audit log and actual stock diverge.
4. **Zero quantity:** No validation that `quantity > 0` before processing.

---

## Flow 3 — Create Purchase Order

**Trigger:** User fills "Create PO" modal with supplier, items, quantities, and prices

```
[Frontend]
  ↓  apiFetch('POST', '/api/inventory/purchase-orders', {
       supplier_id, notes, expected_date, total_amount,
       items: [{ item_id, quantity, unit_price }, ...]
     })
  (Frontend calculates total_amount = sum(quantity * unit_price) — NOT validated by backend)

[Backend: POST /api/inventory/purchase-orders]
  ✅ Inserts into purchase_orders: { company_id, supplier_id, status='draft', 
     total_amount, notes, expected_date, created_by }
  
  ⚠️ Non-transactional line insert:
  ─────────────────────────────────────────────
  Loop: For each item in payload.items:
     ↓  Insert into purchase_order_items: { po_id, item_id, quantity, unit_price, received_qty=0 }
     ↓  (If any line fails, the PO header remains but some lines are missing — ORPHAN RISK)
  ─────────────────────────────────────────────
  
  ✅ Returns: { purchase_order } with status 201

[Frontend Response]
  ✅ Refreshes PO list
  (No navigation to PO detail — frontend has no detail view for POs)
```

**Critical Risks:**
1. **No transactional safety:** If line item inserts fail mid-loop, the PO header is orphaned with incomplete lines.
2. **Frontend-calculated total:** Backend stores `total_amount` as passed by frontend — no server-side recalculation.
3. **No PO number:** No human-readable reference like `PO-00001` — only internal UUID/integer ID.

---

## Flow 4 — Receive Purchase Order (MISSING)

**Trigger:** User marks PO as received

```
[Frontend]
  ↓  PUT /api/inventory/purchase-orders/:id  { status: 'received' }
  (This ONLY updates the header status — nothing else happens)

[What should happen but DOES NOT:]
  ❌ No stock_movements INSERT for received goods
  ❌ No purchase_order_items.received_qty UPDATE
  ❌ No validation that received quantity matches ordered quantity
  ❌ No supplier cost price update on inventory_items
  ❌ No goods receipt note (GRN) created
  ❌ No accounting journal entry

[Current behaviour:]
  PO status changes to 'received' 
  Stock levels unchanged
  Received quantities unchanged (remain 0)
  No audit trail of what was actually received
```

**Assessment:** The purchase order → goods receipt flow is **completely absent**. The schema has `received_qty` on `purchase_order_items` but no backend endpoint updates it. Stock cannot be received via PO flow. This is a major gap.

---

## Flow 5 — Create Bill of Materials

**Trigger:** User creates a BOM with component lines

```
[Frontend]
  ↓  apiFetch('POST', '/api/inventory/boms', {
       item_id, name, version, output_qty, scrap_percent, notes,
       lines: [{ item_id, quantity, scrap_percent, notes, sort_order }, ...]
     })

[Backend: POST /api/inventory/boms]
  ✅ Validates item_id belongs to company
  ✅ Inserts into bom_headers: { company_id, item_id, name, version, status='draft', output_qty, scrap_percent, notes, created_by }
  
  ✅ Transactional-style line insert (with rollback):
  ─────────────────────────────────────────────
  For each line in payload.lines:
     ✅ Validates component item_id belongs to company
     ✅ Inserts into bom_lines: { bom_id, item_id, quantity, scrap_percent, notes, sort_order }
     If any line fails:
        ✅ DELETE bom_headers WHERE id = newBomId  ← cleanup
        ✅ Return 500 with error
  ─────────────────────────────────────────────
  
  ✅ Returns: { bom } with status 201
```

**Assessment:** BOM creation has the best error handling in the module — the manual rollback on line failure is correct. Not transactional via DB transaction, but the cleanup is consistent. ✅

---

## Flow 6 — Create Work Order

**Trigger:** User creates a WO (typically from BOM view)

```
[Frontend]
  ↓  apiFetch('POST', '/api/inventory/work-orders', {
       item_id, bom_id, quantity_to_produce, planned_start_date, planned_end_date, notes
     })

[Backend: POST /api/inventory/work-orders]
  ✅ Validates item_id, bom_id belong to company
  ✅ Validates BOM status is 'active'
  ✅ Auto-generates wo_number: SELECT MAX(wo_number) → WO-00001 format
  
  ✅ Inserts into work_orders: { company_id, wo_number, item_id, bom_id, 
     quantity_to_produce, status='draft', planned dates, notes, created_by }
  
  ✅ Auto-populates materials from BOM:
  ─────────────────────────────────────────────
  SELECT bom_lines WHERE bom_id = payload.bom_id
  For each line:
     required_qty = line.quantity * (qty_to_produce / bom.output_qty) * (1 + line.scrap_percent/100)
     INSERT into work_order_materials: { work_order_id, item_id, required_qty, issued_qty=0 }
  ─────────────────────────────────────────────
  
  ✅ Returns: { work_order } with status 201

[Frontend Response]
  ✅ Refreshes WO list
  Shows WO status as 'draft'
```

---

## Flow 7 — Issue Materials to Work Order

**Trigger:** Materials page action: "Issue Materials" (⚠️ No UI exists for this in the frontend)

```
[Frontend]
  (NO UI — endpoint exists in backend only)
  ↓  apiFetch('POST', '/api/inventory/work-orders/:id/issue-materials', {
       materials: [{ material_id, quantity }, ...]
     })

[Backend: POST /api/inventory/work-orders/:id/issue-materials]
  ✅ Validates WO belongs to company and status is 'released' or 'in_progress'
  
  ⚠️ Non-atomic loop — partial success possible:
  ─────────────────────────────────────────────
  const errors = []
  For each material in payload.materials:
    Step A: READ work_order_materials WHERE id = material_id
    Step B: READ inventory_items.current_stock
    
    ⚠️ SILENT NEGATIVE STOCK CLAMP:
    new_stock = Math.max(0, current_stock - qty)
    (Does NOT reject if qty > current_stock — just clamps to 0 and continues)
    
    Step C: UPDATE inventory_items.current_stock = new_stock
    Step D: UPDATE work_order_materials.issued_qty += qty
    Step E: INSERT stock_movements (type='out', reference=wo_number)
    
    If any step fails: push to errors[] but CONTINUE to next material
  ─────────────────────────────────────────────
  
  ⚠️ Returns HTTP 200 even if errors[] is non-empty
     { success: true, errors: [...] }

[Frontend Response]
  ⚠️ Frontend cannot distinguish between full success and partial failure
```

**Critical Risks:**
1. **Silent over-issue:** If 10 units required but only 5 in stock, system issues 5, sets stock to 0, and records `issued_qty += 10` — stock ledger and issued_qty disagree.
2. **Partial success returns 200:** Frontend cannot tell if some materials failed to issue.
3. **No pre-issue stock check:** API does not validate upfront that enough stock exists before starting the loop.
4. **No UI for this flow:** The issue-materials endpoint exists but the frontend has no "Issue Materials" button or modal.

---

## Flow 8 — Complete Work Order

**Trigger:** User clicks "Complete" on an in-progress Work Order

```
[Frontend]
  ↓  apiFetch('POST', '/api/inventory/work-orders/:id/complete', {
       quantity_produced (optional — defaults to quantity_to_produce)
     })

[Backend: POST /api/inventory/work-orders/:id/complete]
  ✅ Validates WO belongs to company and status is 'in_progress'
  
  ⚠️ Non-atomic finished goods stock update:
  ─────────────────────────────────────────────
  Step A: READ inventory_items.current_stock for finished item
  Step B: new_stock = current_stock + quantity_produced
  Step C: INSERT stock_movements (type='in', reference=wo_number)
  Step D: UPDATE inventory_items.current_stock = new_stock
  Step E: UPDATE work_orders SET status='completed', 
                                 quantity_produced = qty,
                                 actual_end_date = today
  ─────────────────────────────────────────────
  
  ❌ Does NOT check if all materials were issued before completing
  ❌ Does NOT auto-backflush (deduct) raw materials from stock
     (Materials must be issued separately via issue-materials — but there's no UI for that)
  ❌ Does NOT verify issued_qty vs required_qty before allowing completion
  
  ✅ Returns: { work_order } with status 200

[Frontend Response]
  ✅ Refreshes WO list
  ✅ Shows WO as 'completed'
  ⚠️ No warning shown if materials were never issued
```

**Critical Risks:**
1. **Ghost production:** WO can be completed, finished goods received into stock, but no raw materials ever deducted. Stock appears to be created from nothing.
2. **Race condition:** Same non-atomic read/write pattern as `POST /movements` — concurrent completions could corrupt stock.

---

## Flow 9 — BOM Activation

**Trigger:** User clicks "Activate" on a draft BOM

```
[Frontend]
  ↓  apiFetch('POST', '/api/inventory/boms/:id/activate')

[Backend: POST /api/inventory/boms/:id/activate]
  ✅ Validates BOM belongs to company
  ✅ Sets all other BOMs for same item_id to 'inactive':
     UPDATE bom_headers SET status='inactive' WHERE item_id = X AND id != bomId
  ✅ Sets this BOM to 'active':
     UPDATE bom_headers SET status='active' WHERE id = bomId

  ✅ Returns: { bom } updated record
```

**Assessment:** This flow is clean. Only one active BOM per item enforced. ✅

---

## Flow 10 — Dashboard Data Load

**Trigger:** User opens Dashboard tab

```
[Frontend]
  ↓  apiFetch('GET', '/api/inventory/dashboard')

[Backend: GET /api/inventory/dashboard]
  ✅ 6 parallel Supabase COUNT queries:
     1. inventory_items WHERE is_active=true → total_items
     2. stock_movements (no filter beyond company_id) → total_movements
     3. suppliers WHERE is_active=true → total_suppliers
     4. inventory_items WHERE current_stock <= min_stock AND min_stock > 0 → low_stock_items
     5. work_orders WHERE status IN ('draft','released','in_progress') → open_work_orders
     6. bom_headers WHERE status='active' → active_boms
  
  ✅ Returns: { total_items, total_movements, total_suppliers, low_stock_items,
               open_work_orders, active_boms }

[Frontend Response]
  ✅ Renders stat cards
```

**Assessment:** Dashboard aggregation is clean and well-structured. ✅

---

## Missing Flows (Required but Not Implemented)

| Flow | Description | Impact |
|---|---|---|
| PO Goods Receipt | Receive PO items into stock, update `received_qty`, create stock_in movements | CRITICAL — no way to receive stock via PO |
| Stock Transfer (location) | Move stock between warehouses with from/to tracking | HIGH — `transfer` type exists but cannot encode source/destination |
| Physical Stock Count | Count, compare, post adjustments | HIGH — no count workflow |
| Stock Valuation | Calculate total stock value (cost) across all items | HIGH — no report endpoint |
| Reorder Alert | Notify when item hits `min_stock` | MEDIUM — `low_stock_count` in dashboard, but no notification |
| Inter-company transfer | N/A at this stage | LOW |
| Costing Engine | FIFO/Average/Standard cost calculation per movement | HIGH — fields exist, engine absent |
| Lot/Batch Intake | Record lot numbers on receipt | MEDIUM — flags exist, no tables |
| Serial Number Assignment | Track individual serial numbers per item | MEDIUM — flags exist, no tables |
