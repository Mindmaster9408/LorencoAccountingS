# 12 — File Map

---

## Frontend Files

| File | Lines | Role |
|---|---|---|
| [Point of Sale/POS_App/index.html](../../Point of Sale/POS_App/index.html) | ~9,334 | Entire POS SPA — HTML + CSS + JS inline |
| [Point of Sale/POS_App/service-worker.js](../../Point of Sale/POS_App/service-worker.js) | 179 | Offline PWA, network-first API caching, background sync |
| [Point of Sale/POS_App/manifest.json](../../Point of Sale/POS_App/manifest.json) | ~20 | PWA manifest (installable app metadata) |
| [Point of Sale/POS_App/js/polyfills.js](../../Point of Sale/POS_App/js/polyfills.js) | small | Browser polyfills |
| [Point of Sale/POS_App/supabase-config.js](../../Point of Sale/POS_App/supabase-config.js) | small | Optional Supabase client (may not be used by legacy) |

---

## Legacy Backend Files (DEPRECATED — `Point of Sale/`)

| File | Lines | Role |
|---|---|---|
| [Point of Sale/server.js](../../Point of Sale/server.js) | 1,544 | Express app entry, DB init (all 60+ tables), route mounting |
| [Point of Sale/database.js](../../Point of Sale/database.js) | 104 | PostgreSQL pool + SQLite compatibility shim |
| [Point of Sale/middleware/auth.js](../../Point of Sale/middleware/auth.js) | 127 | JWT auth, requireCompany, requirePermission, requireRole |
| [Point of Sale/middleware/audit.js](../../Point of Sale/middleware/audit.js) | small | `logAudit()` helper → inserts into audit_log |
| [Point of Sale/config/permissions.js](../../Point of Sale/config/permissions.js) | 200+ | RBAC role hierarchy + permission matrix |

### Legacy Routes

| File | Lines | Key Endpoints |
|---|---|---|
| [Point of Sale/routes/auth.js](../../Point of Sale/routes/auth.js) | 1,561 | Login, company select, register, locations |
| [Point of Sale/routes/pos.js](../../Point of Sale/routes/pos.js) | 1,947 | Tills, sessions, products, sales, stock, discounts, cash-up |
| [Point of Sale/routes/reports.js](../../Point of Sale/routes/reports.js) | 300+ | Gross profit, VAT, daily summary, payment breakdown |
| [Point of Sale/routes/customers.js](../../Point of Sale/routes/customers.js) | 300+ | Customer CRUD, group pricing, account aging |
| [Point of Sale/routes/inventory.js](../../Point of Sale/routes/inventory.js) | 200+ | Multi-location inventory, low stock, valuation |
| [Point of Sale/routes/barcode.js](../../Point of Sale/routes/barcode.js) | 200+ | EAN13/EAN8 generation, validation, history |
| [Point of Sale/routes/vat.js](../../Point of Sale/routes/vat.js) | 200+ | VAT settings, calculation, product VAT report |
| [Point of Sale/routes/sean-ai.js](../../Point of Sale/routes/sean-ai.js) | 250+ | AI product learning, cashier behavior insights |
| [Point of Sale/routes/audit.js](../../Point of Sale/routes/audit.js) | small | Audit trail query + export |
| [Point of Sale/routes/locations.js](../../Point of Sale/routes/locations.js) | small | Multi-location hierarchy management |
| [Point of Sale/routes/employees.js](../../Point of Sale/routes/employees.js) | small | Employee CRUD, role assignment |
| [Point of Sale/routes/scheduling.js](../../Point of Sale/routes/scheduling.js) | small | Shift scheduling, time entries |
| [Point of Sale/routes/suppliers.js](../../Point of Sale/routes/suppliers.js) | small | Supplier master data |
| [Point of Sale/routes/purchase-orders.js](../../Point of Sale/routes/purchase-orders.js) | small | PO lifecycle |
| [Point of Sale/routes/transfers.js](../../Point of Sale/routes/transfers.js) | small | Stock transfers between locations |
| [Point of Sale/routes/loyalty.js](../../Point of Sale/routes/loyalty.js) | small | Loyalty programs + tiers |
| [Point of Sale/routes/promotions.js](../../Point of Sale/routes/promotions.js) | small | Promotions + discounts |
| [Point of Sale/routes/loss-prevention.js](../../Point of Sale/routes/loss-prevention.js) | small | Loss detection rules + alerts |
| [Point of Sale/routes/analytics.js](../../Point of Sale/routes/analytics.js) | small | Business intelligence + KPIs |
| [Point of Sale/routes/receipts.js](../../Point of Sale/routes/receipts.js) | small | Receipt generation + delivery |
| [Point of Sale/routes/kv.js](../../Point of Sale/routes/kv.js) | small | Key-value storage API |

---

## Ecosystem POS Module (AUTHORITATIVE — `accounting-ecosystem/backend/modules/pos/`)

| File | Role |
|---|---|
| [accounting-ecosystem/backend/modules/pos/index.js](../../accounting-ecosystem/backend/modules/pos/index.js) | Route registration, module entry point |
| [accounting-ecosystem/backend/modules/pos/routes/sales.js](../../accounting-ecosystem/backend/modules/pos/routes/sales.js) | Sale creation (price-locked), void, returns via Supabase |
| [accounting-ecosystem/backend/modules/pos/routes/sessions.js](../../accounting-ecosystem/backend/modules/pos/routes/sessions.js) | Till session open/close via Supabase |
| [accounting-ecosystem/backend/modules/pos/routes/tills.js](../../accounting-ecosystem/backend/modules/pos/routes/tills.js) | Till management via Supabase |
| [accounting-ecosystem/backend/modules/pos/routes/products.js](../../accounting-ecosystem/backend/modules/pos/routes/products.js) | Product CRUD via Supabase |
| [accounting-ecosystem/backend/modules/pos/routes/customers.js](../../accounting-ecosystem/backend/modules/pos/routes/customers.js) | Customer management via Supabase |
| [accounting-ecosystem/backend/modules/pos/routes/categories.js](../../accounting-ecosystem/backend/modules/pos/routes/categories.js) | Product categories |
| [accounting-ecosystem/backend/modules/pos/routes/inventory.js](../../accounting-ecosystem/backend/modules/pos/routes/inventory.js) | Inventory management |
| [accounting-ecosystem/backend/modules/pos/routes/discounts.js](../../accounting-ecosystem/backend/modules/pos/routes/discounts.js) | Daily discounts |
| [accounting-ecosystem/backend/modules/pos/routes/loyalty.js](../../accounting-ecosystem/backend/modules/pos/routes/loyalty.js) | Loyalty points |
| [accounting-ecosystem/backend/modules/pos/routes/receipts.js](../../accounting-ecosystem/backend/modules/pos/routes/receipts.js) | Receipt generation |
| [accounting-ecosystem/backend/modules/pos/routes/kv.js](../../accounting-ecosystem/backend/modules/pos/routes/kv.js) | Cloud KV store (NOT localStorage) |

---

## Database Definition (Legacy — all in `server.js initDatabase()`)

| Table Group | Tables |
|---|---|
| Multi-tenant core | `companies`, `users`, `user_company_access`, `firm_company_access`, `invitations`, `accounting_firms` |
| Till & session | `tills`, `till_sessions` |
| Sales | `sales`, `sale_items`, `sale_payments`, `sale_returns`, `sale_return_items` |
| Products | `products`, `product_companies`, `product_daily_discounts`, `price_overrides` |
| Customers | `customers`, `customer_group_pricing`, `loyalty_point_transactions`, `customer_account_transactions`, `receipt_deliveries` |
| Stock | `stock_adjustments`, `inventory`, `warehouses` |
| Suppliers & PO | `suppliers`, `product_suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`, `reorder_rules` |
| Stock transfers | `stock_transfers`, `stock_transfer_items` |
| Settings | `company_settings`, `vat_settings`, `barcode_settings`, `barcode_history`, `receipt_printers`, `daily_till_resets` |
| Locations | `locations`, `location_settings`, `user_location_access` |
| Enterprise users | `shift_schedules`, `time_entries`, `user_sessions`, `mfa_backup_codes`, `password_history`, `sso_configurations` |
| Analytics | `daily_sales_summary`, `hourly_sales_summary`, `product_performance`, `kpi_targets`, `scheduled_reports` |
| Loss prevention | `cash_variances`, `employee_variance_summary`, `loss_prevention_rules`, `loss_prevention_alerts` |
| Loyalty | `loyalty_programs`, `loyalty_tiers`, `customer_loyalty` |
| Promotions | `promotions`, `promotion_usage`, `promotion_approvals` |
| AI | `sean_product_knowledge`, `sean_button_interactions` |
| Integrations | `integration_configs`, `integration_sync_log`, `webhooks`, `webhook_deliveries` |
| Audit | `audit_log`, `audit_trail` |

---

## Setup Scripts

| File | Purpose |
|---|---|
| [Point of Sale/init-database-pg.js](../../Point of Sale/init-database-pg.js) | Standalone PostgreSQL schema init (alternative to server.js auto-init) |
| [Point of Sale/init-database.js](../../Point of Sale/init-database.js) | Legacy SQLite schema init (deprecated) |
| [Point of Sale/init-sean-ai.js](../../Point of Sale/init-sean-ai.js) | Sean AI tables init |
| [Point of Sale/init-barcodes.js](../../Point of Sale/init-barcodes.js) | Barcode settings init |
| [Point of Sale/fix-user-company-links.js](../../Point of Sale/fix-user-company-links.js) | Migration utility |

---

## Documentation Files (Already Existing)

| File | Content |
|---|---|
| [Point of Sale/README.md](../../Point of Sale/README.md) | App overview |
| [Point of Sale/QUICKSTART.md](../../Point of Sale/QUICKSTART.md) | Setup guide |
| [Point of Sale/DEPLOYMENT.md](../../Point of Sale/DEPLOYMENT.md) | Deployment guide |
| [Point of Sale/BARCODE-SYSTEM.md](../../Point of Sale/BARCODE-SYSTEM.md) | Barcode system documentation |
| [Point of Sale/CODEBASE_OVERVIEW.md](../../Point of Sale/CODEBASE_OVERVIEW.md) | Code structure overview |
| [Point of Sale/API-DOCUMENTATION.md](../../Point of Sale/API-DOCUMENTATION.md) | API endpoint documentation |
| [Point of Sale/SEAN-AI-INTEGRATION.md](../../Point of Sale/SEAN-AI-INTEGRATION.md) | Sean AI integration guide |
