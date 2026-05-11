# 06 — Stock and Inventory Flow

---

## 1. Stock Architecture

The POS uses two overlapping stock mechanisms:

| Mechanism | Table | Used By | Authority |
|---|---|---|---|
| Simple stock counter | `products.stock_quantity` | Basic POS sale flow | **Primary for sales** |
| Multi-location inventory | `inventory` table | Advanced inventory module | Secondary (not used in basic sale) |
| Adjustment log | `stock_adjustments` | Manual adjustments + stock takes | Audit/history |
| Location-specific stock | `product_companies` | Multi-store stock splits | Per-location view |

**The sale flow only reads and writes `products.stock_quantity`.** The `inventory` table is managed separately by the inventory module routes (`/api/inventory/*`).

---

## 2. Stock Reduction on Sale (Legacy)

```sql
-- Per item in sale, immediately on sale creation:
UPDATE products
SET stock_quantity = stock_quantity - ?
WHERE id = ? AND company_id = ?
```

- No transaction wrapper — each `UPDATE` is independent
- No check for race conditions (two cashiers selling the same last item simultaneously could result in negative stock)
- No `stock_adjustments` record created for sales (only for manual adjustments)
- No `inventory` table updated

---

## 3. Stock Reduction on Sale (Ecosystem)

```javascript
// Preferred: RPC function (atomic)
await supabase.rpc('decrement_stock', {
  p_product_id: item.product_id,
  p_quantity:   item.quantity,
});

// Fallback if RPC unavailable:
const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
await supabase
  .from('products')
  .update({ stock_quantity: newQty })
  .eq('id', item.product_id)
  .eq('company_id', req.companyId);
```

The `decrement_stock` RPC is a PostgreSQL function — if it exists in Supabase, it runs atomically (single DB round-trip). If not available, the manual fallback can result in negative stock being clamped to 0 (data loss for stock tracking).

---

## 4. Stock Restoration on Return

```sql
-- Per item returned:
UPDATE products
SET stock_quantity = stock_quantity + ?
WHERE id = ? AND company_id = ?
```

Corresponding `sale_return_items` record also created with `quantity_returned` and `refund_amount`.

---

## 5. Manual Stock Adjustment

`POST /api/pos/stock/adjust` (requires `STOCK.ADJUST` permission)

### Adjustment Types

| Type | Direction | Example Use Case |
|---|---|---|
| `add` | + | Received delivery, manual count correction |
| `restock` | + | Returned goods from customer |
| `return` | + | Goods returned to shelves |
| `remove` | − | Correcting overcount |
| `damage` | − | Damaged goods written off |
| `theft` | − | Shrinkage/loss prevention write-off |
| `set` | absolute | Set exact quantity (stock take result) |

### Flow

```
POST /api/pos/stock/adjust
Body: { product_id, adjustment_type, quantity, reason, reference_number }

1. GET product current stock
2. Calculate:
   if type in [remove, damage, theft]: quantityChange = -abs(quantity)
   if type in [add, restock, return]:  quantityChange = +abs(quantity)
   if type == set: quantityChange = quantity - quantityBefore
3. quantityAfter = quantityBefore + quantityChange
4. if quantityAfter < 0: 400 error — cannot reduce below zero
5. UPDATE products SET stock_quantity = quantityAfter
6. INSERT stock_adjustments (company_id, product_id, adjustment_type, quantity_change,
   quantity_before, quantity_after, reason, reference_number, adjusted_by_user_id)
7. INSERT audit_trail
8. logAudit(req, 'STOCK_ADJUST', 'product', product_id, {...})
```

---

## 6. Bulk Stock Update (Stock Take)

`POST /api/pos/stock/bulk-update` (requires `STOCK.STOCK_TAKE` permission)

```
Body: { items: [{product_id, quantity}], reference_number }

For each item:
  1. GET current stock (quantityBefore)
  2. quantityAfter = item.quantity (absolute set)
  3. quantityChange = quantityAfter - quantityBefore
  4. UPDATE products SET stock_quantity = quantityAfter
  5. INSERT stock_adjustments (adjustment_type = 'stock_take')

Returns array of results: { product_id, product_name, quantity_before, quantity_after, variance }
```

Processed per-item, not in a single transaction. If one item fails, others may still succeed.

---

## 7. Stock History Query

`GET /api/pos/stock/history`

```sql
SELECT sa.*, p.product_name, p.product_code, u.full_name as adjusted_by
FROM stock_adjustments sa
JOIN products p ON sa.product_id = p.id
LEFT JOIN users u ON sa.adjusted_by_user_id = u.id
WHERE sa.company_id = ?
[AND sa.product_id = ?]
ORDER BY sa.created_at DESC LIMIT ?
```

Returns full adjustment history with who adjusted, before/after quantities, and reason.

---

## 8. Low Stock Detection

`GET /api/pos/stock?low_stock_only=true`

```sql
SELECT ... FROM products
WHERE company_id=? AND is_active=1 AND stock_quantity <= min_stock_level
ORDER BY product_name
```

- `min_stock_level` is set per product (default 10)
- Frontend shows colour-coded badges: OK (green) / LOW (amber) / OUT (red)
- No automatic reorder triggering in current code (reorder_rules table exists but no auto-PO creation)

---

## 9. Multi-Location Stock

### product_companies table
Tracks per-location stock for companies with multiple branches:
```sql
product_companies (product_id, company_id, stock_quantity, reorder_level, is_active, price_override)
```

`GET /api/pos/products/:id/stock-by-location`:
```sql
SELECT c.id as location_id, c.location_name, c.company_name,
  pc.stock_quantity, pc.reorder_level, pc.is_active, pc.price_override
FROM companies c
LEFT JOIN product_companies pc ON c.id=pc.company_id AND pc.product_id=?
WHERE (c.id=? OR c.parent_company_id=?) AND c.is_active=1
```

**Note:** The basic sale flow uses `products.stock_quantity` (total stock), not per-location `product_companies.stock_quantity`. Multi-location stock in `product_companies` is a separate overlay, not the live sale stock counter.

### inventory table (Advanced)
```sql
inventory (company_id, product_id, location_id, warehouse_id, quantity_on_hand,
  quantity_reserved, quantity_on_order, quantity_in_transit, ...)
```

This table is managed by `/api/inventory/*` routes and the `inventory.js` module. It is NOT queried during basic POS sales. It is intended for warehouse-level stock management.

---

## 10. Stock Transfer Flow

Between locations (not used in basic POS flow, managed by enterprise routes):

```
POST /api/transfers          ← Create transfer request
POST /api/transfers/:id/approve ← Manager approves
POST /api/transfers/:id/ship ← Mark shipped
POST /api/transfers/:id/receive ← Receiving location marks received

Tables: stock_transfers, stock_transfer_items
```

---

## 11. Supplier & Purchase Order Flow

Not part of basic POS sale — managed via separate enterprise routes:

```
POST /api/purchase-orders         ← Create PO
POST /api/purchase-orders/:id/approve ← Approve
POST /api/purchase-orders/:id/receive ← Goods receipt

Tables: purchase_orders, purchase_order_items, goods_receipts, goods_receipt_items
```

When goods are received via `goods_receipt_items`, stock should be incremented. **Whether stock is automatically incremented on goods receipt is not confirmed from the routes read** — the `goods_receipts` table exists but the route logic for auto-incrementing `products.stock_quantity` on receipt was not fully traced during this audit.

---

## 12. Key Risks in Stock Flow

| Risk | Detail |
|---|---|
| No atomic transaction | Sale + stock decrement are separate queries; partial failure possible |
| Race condition | Two simultaneous sales of last item — stock_quantity check passes for both |
| Void does not restore stock | Stock is NOT returned when a sale is voided (only on formal return) |
| Offline stock not decremented | Offline sales decrement stock only when synced — store may sell more than available |
| `decrement_stock` RPC may not exist | Supabase RPC fallback clamps to 0 — silent stock loss in accounting |
| `product_companies` vs `products.stock_quantity` | Two different stock counters, can diverge |

---

## 13. What the Stock Audit Trail Captures

`stock_adjustments` records every manual adjustment with:
- `adjustment_type` (add/remove/damage/theft/stock_take/etc.)
- `quantity_before`, `quantity_after`, `quantity_change`
- `reason` (free text)
- `reference_number`
- `adjusted_by_user_id`
- `created_at`

`audit_log` additionally captures:
- IP address
- User agent
- Session ID
- Additional metadata JSON

Sales do NOT create `stock_adjustments` entries — only manual adjustments do.
