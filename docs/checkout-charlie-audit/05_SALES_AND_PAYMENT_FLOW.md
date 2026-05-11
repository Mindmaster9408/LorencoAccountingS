# 05 — Sales and Payment Flow

---

## 1. Sale Creation — Step by Step

### Legacy (`routes/pos.js`)

```
POST /api/pos/sales
Body: { tillSessionId, items: [{productId, quantity}], paymentMethod, customerId? }

Step 1: Verify till session
  SELECT * FROM till_sessions WHERE id=? AND company_id=? AND status='open'
  → 400 if not found or not open

Step 2: Load + validate products
  SELECT * FROM products WHERE company_id=? AND id IN (...)
  → 400 if product not found
  → 400 if stock_quantity < requested quantity

Step 3: Calculate totals
  subtotal = Σ (product.unit_price × quantity)
  vatAmount = subtotal × 0.15         ← adds 15% on top (external VAT)
  totalAmount = subtotal + vatAmount

Step 4: Generate sale number
  saleNumber = 'SALE-' + Date.now()

Step 5: INSERT sales
  INSERT INTO sales (company_id, sale_number, till_session_id, user_id, customer_id,
    subtotal, vat_amount, total_amount, payment_method, payment_status, payment_complete)
  VALUES (..., 'paid', 1)

Step 6: INSERT sale_items (per product line)
  INSERT INTO sale_items (company_id, sale_id, product_id, quantity, unit_price, total_price)

Step 7: Decrement stock (per product)
  UPDATE products SET stock_quantity = stock_quantity - ? WHERE id=? AND company_id=?

Step 8: INSERT sale_payments
  INSERT INTO sale_payments (company_id, sale_id, payment_method, amount, reference_number, status)

Step 9: logAudit(req, 'CREATE', 'sale', saleId, {...})
  INSERT INTO audit_log

Response: { saleId, saleNumber, subtotal, vatAmount, totalAmount, paymentMethod }
```

**No database transaction wrapping.** Each step is an independent query. Failure midway leaves the database in a partially-written state.

---

### Ecosystem (`modules/pos/routes/sales.js`)

```
POST /api/pos/sales
Body: { items, paymentMethod, tillSessionId, customerId?, discountAmount?, discountPercent?, notes?, payments? }

Step 1: normaliseSaleBody → accept camelCase or snake_case
Step 2: requirePermission('SALES.CREATE')

Step 3: Load products from DB (prices NOT from client)
  supabase.from('products').select('id, product_name, unit_price, vat_rate, requires_vat, stock_quantity')
  .in('id', productIds).eq('company_id', companyId).eq('is_active', true)

Step 4: Stock pre-check (all items at once)
  if prod.stock_quantity < item.quantity → 422 with details array

Step 5: Calculate totals
  linePrice = prod.unit_price × quantity
  vat_total += linePrice × (vat_rate / (100 + vat_rate))  ← inclusive VAT
  discount = discountAmt OR (discount_percent × subtotal / 100)
  total_amount = subtotal - discount

Step 6: Validate split payment total (1-cent tolerance)

Step 7: INSERT sales (Supabase)
  saleNumber = 'SAL-' + Date.now() + '-' + random4chars
  receiptNumber = saleNumber.replace('SAL-', 'RC-')

Step 8: INSERT sale_items array
Step 9: INSERT sale_payments (single or split array)

Step 10: Decrement stock via RPC (with manual fallback)
  supabase.rpc('decrement_stock', { p_product_id, p_quantity })
  Fallback: UPDATE products SET stock_quantity = MAX(0, current - quantity)

Step 11: auditFromReq(req, 'CREATE', 'sale', sale.id, {...})

Response: { sale } (full Supabase row with related data)
```

**Ecosystem advantage:** Prices locked to DB values — clients cannot manipulate prices.  
**Ecosystem risk:** If `sale_items` insert fails (step 8), the sale record already exists with no items. The error is logged but the sale is not rolled back.

---

## 2. Sale Number Format

| Backend | Format | Example |
|---|---|---|
| Legacy | `SALE-{timestamp}` | `SALE-1715000000000` |
| Ecosystem | `SAL-{timestamp}-{4chars}` | `SAL-1715000000000-AB3Z` |

The ecosystem format includes random chars to reduce collision risk within the same millisecond.

---

## 3. Payment Types

| Method | Stored As | Notes |
|---|---|---|
| Cash | `CASH` | Change calculated frontend-only |
| Card | `CARD` | No terminal integration in current code |
| EFT | `EFT` | Reference number recorded |
| Account | `ACCOUNT` | Updates `customer_account_transactions` |
| SnapScan | `SNAPSCAN` | No real integration — just records method |
| Zapper | `ZAPPER` | No real integration — just records method |
| Gift Card | `GIFT_CARD` | No real integration — just records method |
| Split | `CASH:100,CARD:50` (legacy) | Payment method string concatenated |
| Split | separate records (ecosystem) | Each payment → own `sale_payments` row |

**No payment terminal integration exists.** Card payments are manually confirmed by the cashier.

---

## 4. Split Payment Handling

### Legacy (`pos.js /sales/split-payment`)
```javascript
paymentMethod = payments.map(p => `${p.method}:${p.amount}`).join(',')
// Result: "CASH:100,CARD:50" stored in sales.payment_method column
// Each payment also inserted into sale_payments table
```

### Ecosystem (`sales.js POST /`)
```javascript
// payments array accepted directly
// Validates total: paymentsTotal >= total_amount - 0.01
// Each payment inserted as separate sale_payments row
// sales.payment_method set to the first method ('cash' default)
```

---

## 5. Void Flow

### Legacy
```
POST /api/pos/sales/:id/void   (requires POS.VOID_SALE)
Body: { reason }

  SELECT sale → verify exists + belongs to company
  UPDATE sales SET status='voided', voided_at=NOW(), voided_by=userId, void_reason=reason

  ⚠️ Stock is NOT restored on void (only returns restore stock)
  ✓ Audit log created
```

### Ecosystem
```
POST /api/pos/sales/:id/void   (requires SALES.VOID)
Body: { reason }

  SELECT sale → verify not already voided
  UPDATE sales SET status='voided', void_reason, voided_by, voided_at

  ✓ Audit trail recorded
  ⚠️ Stock restoration depends on implementation — not explicitly in audit
```

**Critical:** In the legacy system, void does NOT restore stock. Only a return restores stock. A voided sale that shipped product would cause stock discrepancy.

---

## 6. Return Flow

```
POST /api/pos/sales/:id/return   (requires POS.VOID_SALE)
Body: { items: [{product_id, quantity}], reason, authorized_by_user_id }

Step 1: Get original sale
Step 2: Get original sale_items
Step 3: Validate return items:
  - Product must be in original sale
  - Return quantity ≤ original quantity
Step 4: Calculate refund amounts (at original unit_price)
Step 5: If cashier: requires authorized_by_user_id (manager must authorize)
Step 6: Generate return_number = 'RET-' + Date.now()
Step 7: INSERT sale_returns record
Step 8: INSERT sale_return_items (per line)
Step 9: Restore stock: UPDATE products SET stock_quantity = stock_quantity + ?
Step 10: INSERT audit_trail
Step 11: logAudit(req, 'RETURN', 'sale', originalSaleId, {...})
```

---

## 7. Discount Flow

### Daily Product Discount
Applied at product level, not at sale level:
```
POST /api/pos/daily-discounts
  → product_daily_discounts record created with discount_price, start_date, end_date

GET /api/pos/products/with-discounts
  → Returns products with active discounts
  → Cashier sees discounted price in cart
  
On sale: effectivePrice = item.overridePrice || product.unit_price
```

### Sale-Level Discount (Ecosystem)
```
POST /api/pos/sales with { discount_amount: X } or { discount_percent: Y }
  → discount = discountAmt || (discount_percent × subtotal / 100)
  → total_amount = subtotal - discount
  → discount_amount stored on sale record
```

### Price Override (Per-Item Manager Authorization)
```
POST /api/pos/price-override
  → authorized_by_user_id must have admin/business_owner/accountant role
  → price_overrides record created (audit trail)
  → cart item uses override_price for this sale
```

---

## 8. Receipt Flow

After a successful sale:
1. `saleNumber` and `receiptNumber` returned in response
2. Frontend renders receipt modal (HTML in `index.html`) with:
   - Company name, address, VAT number
   - Sale date/time, cashier name
   - Line items (product name, qty, unit price, line total)
   - Subtotal, VAT breakdown, total
   - Payment method
3. Optional print: `window.print()` or network printer via IP/port settings
4. Optional email/SMS receipt: `POST /api/receipts/...` (routes/receipts.js)
5. `receipt_deliveries` record created for each delivery method attempted

---

## 9. Loyalty Points Flow

When a customer is attached to a sale:
1. Sale completes
2. Loyalty points calculated based on sale total
3. `UPDATE customers SET loyalty_points = loyalty_points + ?`
4. `INSERT loyalty_point_transactions` (record the earning event)
5. Tier upgrade checked based on total accumulated points

Redemption:
1. Customer has points to redeem
2. Redemption amount deducted from sale total
3. `INSERT loyalty_point_transactions` with negative `points_change`

---

## 10. Accounting Implications

**No accounting journal integration exists in POS.**

POS sales do not automatically post to any accounting module (chart of accounts, ledger, etc.). Each sale exists only in `sales` / `sale_items` / `sale_payments` tables. Accounting would require:

- A journal entry: Debit Cash/Card Receivable, Credit Revenue, Credit VAT Liability
- A COGS entry: Debit COGS, Credit Inventory
- A reconciliation link between POS session and bank

None of this currently exists. This is a known gap (see 09_ACCOUNTING_INTEGRATION.md).
