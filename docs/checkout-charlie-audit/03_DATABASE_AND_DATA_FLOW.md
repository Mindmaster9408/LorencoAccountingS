# 03 — Database and Data Flow

---

## 1. Two Separate Databases

| | Legacy | Ecosystem |
|---|---|---|
| Type | PostgreSQL (Zeabur internal) | Supabase (PostgreSQL) |
| Connection | `database.js` → `pg.Pool` | `supabase` JS client |
| Init | `server.js initDatabase()` on startup | Supabase migrations / schema |
| Used by | `Point of Sale/routes/*` | `accounting-ecosystem/backend/modules/pos/routes/*` |
| Status | DEPRECATED | AUTHORITATIVE |

**These are physically separate databases.** Data entered in one does NOT appear in the other.

---

## 2. Schema: Core Tables (Legacy — defined in server.js)

### Companies & Multi-Tenancy

```sql
companies (
  id, company_name, trading_name, registration_number, vat_number,
  contact_email, contact_phone, address, owner_user_id,
  subscription_status,   ← 'active' | 'pending' | 'suspended'
  subscription_expires_at, approved_at, approved_by_user_id,
  is_active, parent_company_id, is_location, location_name,
  created_at, updated_at
)

users (
  id, username, email, password_hash, full_name, role, user_type,
  accounting_firm_id, is_active, is_super_admin,
  employee_id, manager_user_id, department, hire_date,
  termination_date, employment_status, hourly_rate, salary,
  sso_provider, sso_external_id, mfa_enabled, mfa_secret,
  last_login_at, password_changed_at, must_change_password,
  profile_photo_url, created_at
)

user_company_access (
  id, user_id, company_id, role, is_primary, float_override,
  granted_at, granted_by_user_id, is_active
)
-- UNIQUE(user_id, company_id)

firm_company_access (
  id, firm_id, company_id, granted_at, granted_by_user_id, is_active
)
-- UNIQUE(firm_id, company_id)

invitations (
  id, email, company_id, invitation_type, token,
  invited_by_user_id, accepted_at, accepted_by_user_id,
  expires_at, is_used, created_at
)
```

### Till & Session Tables

```sql
tills (
  id, company_id, till_name, till_number, location, location_id, is_active,
  created_at
)
-- UNIQUE(company_id, till_name), UNIQUE(company_id, till_number)

till_sessions (
  id, company_id, till_id, user_id, opening_balance, closing_balance,
  expected_balance, variance, status ('open'|'closed'), location_id,
  opened_at, closed_at, notes
)
```

### Sales Tables

```sql
sales (
  id, company_id, sale_number, till_session_id, user_id, customer_id,
  subtotal, vat_amount, total_amount, payment_method, status ('completed'|'voided'),
  payment_status ('paid'|'partial'|'unpaid'), payment_complete,
  voided_at, voided_by, void_reason, discount_amount, discount_reason,
  receipt_number, receipt_email_sent, receipt_sms_sent,
  location_id, created_at
)
-- UNIQUE(company_id, sale_number)

sale_items (
  id, company_id, sale_id, product_id, quantity, unit_price, total_price
)

sale_payments (
  id, sale_id, company_id, payment_method, amount, reference, status ('completed'),
  processed_at, processed_by, metadata, created_at
)

sale_returns (
  id, company_id, original_sale_id, return_number, total_refund, reason,
  processed_by_user_id, authorized_by_user_id, created_at
)
-- UNIQUE(company_id, return_number)

sale_return_items (
  id, return_id, sale_item_id, product_id, quantity_returned, refund_amount
)
```

### Products Table

```sql
products (
  id, company_id, product_code, product_name, description, category,
  unit_price, cost_price, stock_quantity, min_stock_level,
  barcode, requires_vat, vat_rate, is_active,
  created_at, updated_at
)
-- UNIQUE(company_id, product_code)

product_companies (
  id, product_id, company_id, stock_quantity, reorder_level,
  is_active, price_override, created_at
)
-- UNIQUE(product_id, company_id) — used for multi-location stock

product_daily_discounts (
  id, company_id, product_id, discount_price, original_price, reason,
  start_date, end_date, created_by_user_id, approved_by_user_id,
  is_active, created_at
)

price_overrides (
  id, company_id, sale_id, product_id, original_price, override_price,
  reason, authorized_by_user_id, cashier_user_id, created_at
)
```

### Customers & Loyalty

```sql
customers (
  id, company_id, name, contact_person, contact_number, email,
  address_line_1, address_line_2, suburb, city, province, postal_code,
  tax_reference, company, customer_type, custom_field,
  customer_number, first_name, last_name, phone, date_of_birth, id_number,
  customer_group, credit_limit, current_balance,
  loyalty_points, loyalty_tier, marketing_consent, notes,
  home_location_id, is_active, created_at, updated_at
)

customer_group_pricing (
  id, company_id, customer_group, product_id, price, created_at
)

loyalty_point_transactions (
  id, customer_id, company_id, points_change, transaction_type,
  description, sale_id, created_at
)

customer_account_transactions (
  id, customer_id, company_id, transaction_type, amount, balance_after,
  sale_id, payment_id, due_date, notes, created_at
)

receipt_deliveries (
  id, sale_id, company_id, delivery_method, recipient,
  status, delivered_at, error_message, created_at
)
```

### Stock Management

```sql
stock_adjustments (
  id, company_id, product_id, adjustment_type, quantity_change,
  quantity_before, quantity_after, reason, reference_number,
  adjusted_by_user_id, location_id, created_at
)

-- Multi-location inventory (advanced)
inventory (
  id, company_id, product_id, location_id, warehouse_id,
  quantity_on_hand, quantity_reserved, quantity_on_order,
  quantity_in_transit, reorder_point, reorder_quantity, max_stock_level,
  bin_location, last_counted_at, last_received_at, last_sold_at, updated_at
)
-- UNIQUE(product_id, location_id, COALESCE(warehouse_id, 0))
```

### Settings Tables

```sql
company_settings (
  id, company_id, till_float_amount, receipt_printer_name,
  receipt_printer_ip, receipt_printer_port, auto_print_receipt,
  receipt_header, receipt_footer, product_code_prefix, receipt_prefix,
  next_receipt_number, vat_rate, open_drawer_on_sale, group_same_items,
  use_product_images, updated_at, updated_by_user_id
)
-- UNIQUE(company_id)

vat_settings (
  id, company_id, is_vat_registered, vat_number, vat_rate,
  updated_at, updated_by_user_id
)
-- UNIQUE(company_id)

barcode_settings (
  id, company_id, company_prefix, current_sequence, barcode_type,
  auto_generate, last_generated, updated_at, updated_by_user_id
)
-- UNIQUE(company_id)
```

### Audit Tables

```sql
audit_log (
  id, company_id, user_id, user_email, action_type, entity_type,
  entity_id, field_name, old_value, new_value,
  ip_address, session_id, user_agent, additional_metadata, created_at
)
-- Indexed on: company_id, user_id, action_type, (entity_type, entity_id), created_at

audit_trail (
  id, company_id, user_id, event_type, event_category,
  event_data, ip_address, created_at
)
-- Legacy table, kept for backward compatibility
```

---

## 3. Data Flow: How a Sale Reaches the Database

### Legacy Flow (`routes/pos.js`)

```
Frontend: POST /api/pos/sales
  │
  ├── authenticateToken → extract companyId, userId from JWT
  ├── requireCompany → ensure companyId present
  │
  ├── Verify till session:
  │   SELECT * FROM till_sessions WHERE id=? AND company_id=? AND status='open'
  │
  ├── Get products + validate stock:
  │   SELECT * FROM products WHERE company_id=? AND id IN (...)
  │   → if product.stock_quantity < requested quantity: 400 error
  │
  ├── Calculate totals:
  │   subtotal = sum(product.unit_price * quantity)
  │   vatAmount = subtotal * 0.15          ← EXTERNAL VAT (15% added on top)
  │   totalAmount = subtotal + vatAmount
  │
  ├── Generate sale number: 'SALE-' + Date.now()
  │
  ├── INSERT INTO sales (...) VALUES (...)
  │
  ├── For each item:
  │   INSERT INTO sale_items (company_id, sale_id, product_id, quantity, unit_price, total_price)
  │   UPDATE products SET stock_quantity = stock_quantity - ? WHERE id=? AND company_id=?
  │
  ├── INSERT INTO sale_payments (company_id, sale_id, payment_method, amount, ...)
  │
  └── logAudit(req, 'CREATE', 'sale', saleId, {...})
      → INSERT INTO audit_log
```

**Important gap:** No transaction wrapping. If `INSERT sale_items` succeeds but `UPDATE products` (stock decrement) fails, the sale exists with incorrect stock levels. Each operation is independent.

### Ecosystem Flow (`modules/pos/routes/sales.js`)

```
Frontend: POST /api/pos/sales
  │
  ├── authenticateToken → companyId, userId
  ├── requireCompany
  ├── requirePermission('SALES.CREATE')
  │
  ├── normaliseSaleBody → handle camelCase/snake_case variants
  │
  ├── Collect product IDs, look up prices FROM DB:
  │   supabase.from('products').select('id, product_name, unit_price, vat_rate, requires_vat, stock_quantity')
  │   .in('id', productIds).eq('company_id', companyId)
  │   → Prices CANNOT be spoofed from client — always DB authoritative
  │
  ├── Stock pre-check:
  │   for each item: if prod.stock_quantity < item.quantity → 422 error (details)
  │
  ├── Calculate totals:
  │   linePrice = prod.unit_price * quantity
  │   if (requires_vat): vat_total += linePrice * (vat_rate / (100 + vat_rate))
  │                                              ← INCLUSIVE VAT (extracted)
  │   discount = discountAmt || (discount_percent * subtotal / 100)
  │   total_amount = subtotal - discount
  │
  ├── Validate split payment total (1-cent tolerance)
  │
  ├── INSERT sales → Supabase, get sale record back
  │
  ├── INSERT sale_items (array)
  │
  ├── INSERT sale_payments (single or split array)
  │
  ├── For each product: supabase.rpc('decrement_stock', { p_product_id, p_quantity })
  │   → fallback to manual UPDATE if RPC unavailable
  │
  └── auditFromReq(req, 'CREATE', 'sale', sale.id, {...})
```

**Ecosystem advantage:** Prices are locked to DB values. Client cannot send a manipulated price.

---

## 4. Critical VAT Difference

| | Legacy | Ecosystem |
|---|---|---|
| Method | External VAT | Inclusive VAT |
| Formula | `subtotal * 0.15` | `linePrice * (vat_rate / (100 + vat_rate))` |
| Example: R100 product | subtotal=R100, VAT=R15, total=R115 | subtotal=R100, VAT=R13.04, total=R100 |
| Unit price interpretation | Excl. VAT | Incl. VAT |

These two methods are mathematically incompatible. The same product at R100 unit price produces different totals depending on which backend processed the sale. This must be resolved before both systems can be unified.

---

## 5. Stock Authority

```
products.stock_quantity   ← Simple stock counter on products table (both systems)
stock_adjustments         ← Immutable adjustment log (type, change, before, after)
inventory                 ← Advanced multi-location stock (quantity_on_hand, reserved, etc.)
```

**The primary stock figure used for POS sales is `products.stock_quantity`.**  
The `inventory` table is for multi-location advanced stock — it is NOT used in the basic sale flow.

Stock is decremented immediately on sale creation. If the sale creation succeeds but a later step fails, the stock decrement persists (no rollback in legacy — see risk section).

Stock is restored on returns: `UPDATE products SET stock_quantity = stock_quantity + ?`

---

## 6. Till Session Authority

```
till_sessions.status = 'open' | 'closed'
```

A sale requires a valid open `till_session_id`. The expected cash at close is:
```
expected_balance = opening_balance + total_sales_for_session
variance = closing_balance - expected_balance
```

Till sessions are company-scoped. Cashiers can only close their own sessions (unless manager role).

---

## 7. Table Relationships

```
companies
  └── users (via user_company_access)
  └── tills
       └── till_sessions
            └── sales
                 ├── sale_items
                 │    └── products
                 ├── sale_payments
                 └── sale_returns
                      └── sale_return_items
  └── products
       ├── product_companies (multi-location stock)
       └── product_daily_discounts
  └── customers
       ├── customer_account_transactions
       └── loyalty_point_transactions
  └── stock_adjustments
  └── inventory (multi-location)
  └── company_settings
  └── vat_settings
  └── audit_log
```

---

## 8. Database Initialization Risk

The legacy server auto-runs `initDatabase()` on every startup. This function:
- Creates all tables `IF NOT EXISTS` (safe — idempotent)
- Runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (safe — idempotent)
- Creates the `lorenco_admin` super admin user (ON CONFLICT DO UPDATE — safe)
- Does NOT run migrations or data changes automatically (disabled section in comments)

**Risk:** If a future developer adds a destructive statement to `initDatabase()`, it runs on every startup. This function should be kept idempotent.
