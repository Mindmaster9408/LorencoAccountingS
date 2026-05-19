# 20 — CORE DB INDEXES VERIFIED
## Checkout Charlie — Workstream 5D: Post-Migration Verification

**Date:** 2026-05-12
**Migration verified:** `accounting-ecosystem/database/migrations/033_pos_core_performance_indexes.sql`
**Verification method:** Full code audit against all POS route files and service files
**Overall result:** ✅ PASS — all 16 indexes verified correct, safe, and effective

---

## Verification Scope

Files audited:

| File | Purpose |
|---|---|
| `migrations/025_pos_create_sale_atomic.sql` | Confirmed `sales`, `sale_items`, `sale_payments` column names |
| `migrations/026_pos_add_idempotency_key.sql` | Confirmed existing index on `sales` |
| `migrations/028_pos_audit_trail_foundation.sql` | Confirmed 6 existing indexes on `pos_audit_events` |
| `migrations/029_pos_recon_snapshots.sql` | Confirmed 2 existing indexes on `pos_recon_snapshots` |
| `routes/reports.js` | All 5 report query patterns |
| `routes/sessions.js` | All 5 session management query patterns |
| `routes/inventory.js` | 3 inventory query patterns |
| `routes/recovery.js` | Recovery session query pattern |
| `routes/reconciliation.js` | Snapshot and live recon query patterns |
| `routes/receipts.js` | Receipt preview and print query patterns |
| `services/posReconService.js` | Core reconciliation query patterns (most critical) |
| `frontend-pos/index.html` | localStorage/sessionStorage business data check |

---

## Check 1 — SQL Syntax and Table/Column Names ✅ PASS

All 16 `CREATE INDEX IF NOT EXISTS` statements verified against confirmed schema:

| Table | Column verified in | Status |
|---|---|---|
| `products.company_id` | `inventory.js` `.eq('company_id', ...)` | ✅ |
| `products.is_active` | `inventory.js` `.eq('is_active', true)` | ✅ |
| `products.stock_quantity` | `reports.js` `.lte('stock_quantity', 10)` | ✅ |
| `sales.company_id` | All report queries | ✅ |
| `sales.created_at` | `reports.js` `.gte/.lte('created_at', ...)` | ✅ |
| `sales.status` | `sessions.js` `.eq('status', 'completed')` | ✅ |
| `sales.till_session_id` | `posReconService.js` `.eq('till_session_id', ...)` | ✅ |
| `sales.user_id` | `reports.js` cashier-performance query | ✅ |
| `sale_items.sale_id` | `migration 025` INSERT + `receipts.js` join | ✅ |
| `sale_items.company_id` | `migration 025` INSERT | ✅ |
| `sale_items.product_id` | `migration 025` INSERT + top-products aggregation | ✅ |
| `sale_payments.sale_id` | `posReconService.js` `.in('sale_id', saleIds)` | ✅ |
| `sale_payments.company_id` | `migration 025` INSERT | ✅ |
| `sale_payments.payment_method` | `posReconService.js` breakdown | ✅ |
| `till_sessions.company_id` | `sessions.js` all queries | ✅ |
| `till_sessions.status` | `sessions.js` `.eq('status', 'open')` | ✅ |
| `till_sessions.user_id` | `sessions.js` `.eq('user_id', req.user.userId)` | ✅ |
| `till_sessions.opened_at` | `sessions.js`, `recovery.js` `.order('opened_at', desc)` | ✅ |
| `inventory_adjustments.company_id` | `inventory.js` `.eq('company_id', ...)` | ✅ |
| `inventory_adjustments.created_at` | `inventory.js` `.order('created_at', desc)` | ✅ |
| `inventory_adjustments.product_id` | `inventory.js` insert + future per-product lookup | ✅ |

No column name errors. No table name errors.

---

## Check 2 — IF NOT EXISTS Rerun Safety ✅ PASS

All 16 statements use `CREATE INDEX IF NOT EXISTS`.

- Running migration 033 a second time: each statement silently no-ops if the index already exists
- No error, no side effect, no data change on re-run
- Safe to apply via Supabase SQL Editor regardless of whether indexes already created
- Verified: PostgreSQL `IF NOT EXISTS` is standard and supported by Supabase

---

## Check 3 — No Duplicate or Conflicting Indexes ✅ PASS

Conflict check against all pre-existing indexes:

| Pre-existing index | Table | Columns | Conflicts with 033? |
|---|---|---|---|
| `idx_sales_idempotency_key` | `sales` | `idempotency_key WHERE NOT NULL` (partial unique) | No — different column entirely |
| `idx_pos_audit_company_time` | `pos_audit_events` | `(company_id, created_at DESC) WHERE company_id IS NOT NULL` | Not touched by 033 |
| `idx_pos_audit_sale` | `pos_audit_events` | `sale_id WHERE NOT NULL` | Not touched |
| `idx_pos_audit_session` | `pos_audit_events` | `till_session_id WHERE NOT NULL` | Not touched |
| `idx_pos_audit_category_type` | `pos_audit_events` | `(company_id, action_category, action_type, created_at DESC)` | Not touched |
| `idx_pos_audit_offline_sync` | `pos_audit_events` | `(company_id, created_at DESC) WHERE source = 'offline_sync'` | Not touched |
| `idx_pos_audit_auth` | `pos_audit_events` | `action_category WHERE = 'auth'` | Not touched |
| `idx_pos_recon_company_time` | `pos_recon_snapshots` | `(company_id, created_at DESC)` | Not touched |
| `idx_pos_recon_session` | `pos_recon_snapshots` | `till_session_id` | Not touched |
| `idx_inventory_adj_company` | `inventory_adjustments` | `company_id` | No conflict — `idx_inventory_adj_company_created` is a different name covering company_id + created_at, which is a superset but not a duplicate |
| `idx_pos_returns_company` | `pos_returns` | `company_id` | Not touched |
| `idx_pos_returns_sale` | `pos_returns` | `original_sale_id` | Not touched |

No index name collisions. No functional duplicates. `idx_inventory_adj_company` and `idx_inventory_adj_company_created` coexist correctly — the composite version will be preferred by the planner for ordered queries.

---

## Check 4 — Reconciliation Queries Use Indexes ✅ PASS

`posReconService.computeSessionRecon()` — three queries:

| Query | Filter columns | Index used |
|---|---|---|
| `till_sessions` by `id` + `company_id` | PK (id) + company_id | Primary key — no index needed |
| `sales` by `till_session_id` + `company_id` | `(till_session_id, company_id)` | ✅ `idx_sales_session_company` |
| `sale_payments` `.in('sale_id', saleIds)` | `sale_id IN (array)` | ✅ `idx_sale_payments_sale_id` |
| `pos_returns` `.in('original_sale_id', saleIds)` + `.eq('status', 'completed')` | `original_sale_id` | ✅ `idx_pos_returns_sale` (pre-existing) |

`posReconService.detectInconsistencies()` — same query patterns:

| Query | Index used |
|---|---|
| `sales` by `till_session_id` + `company_id` | ✅ `idx_sales_session_company` |
| `sale_payments` `.in('sale_id', saleIds)` | ✅ `idx_sale_payments_sale_id` |
| `pos_returns` `.in('original_sale_id', voidedSaleIds)` | ✅ `idx_pos_returns_sale` (pre-existing) |

`sessions.js` session close balance calculation:

| Query | Index used |
|---|---|
| `sales` by `till_session_id` + `status` = completed | ✅ `idx_sales_session_status` |

---

## Check 5 — Receipt Queries Use Indexes ✅ PASS

`receipts.js` receipt preview and print:

```javascript
supabase.from('sales')
  .select('*, sale_items(*, products(...)), sale_payments(*)')
  .eq('id', req.params.saleId)
  .eq('company_id', req.companyId)
```

PostgREST translates the embedded `sale_items(*)` into a secondary fetch keyed on `sale_id`. With `idx_sale_items_sale_id` in place, this lookup is indexed. Same for `sale_payments(*)` via `idx_sale_payments_sale_id`. Primary sale fetch uses the `sales.id` primary key.

---

## Check 6 — Top-Products Join Uses Indexes ✅ PASS

`reports.js` top-products query:

```javascript
supabase.from('sale_items')
  .select('product_id, product_name, quantity, ..., sales!inner(company_id, status, created_at)')
  .eq('sales.company_id', req.companyId)
  .eq('sales.status', 'completed')
```

PostgREST executes this as a join between `sale_items` and `sales` via the `sale_id` FK relationship. `idx_sale_items_sale_id` covers the join condition on the `sale_items` side. `idx_sales_company_status_created` covers the `sales` filter side.

Note: Aggregation is done application-side in JavaScript after the full result set is returned. This is a future optimization risk — see remaining risks section below.

---

## Check 7 — Product Loading Queries Use Indexes ✅ PASS

| Route | Query | Index |
|---|---|---|
| `GET /inventory` | `.eq('company_id', ...).eq('is_active', true)` | ✅ `idx_products_company_active` |
| `GET /inventory?low_stock=true` | Same DB query, app-side filter afterward | ✅ `idx_products_company_active` (DB portion) |
| `GET /reports/inventory-value` | `.eq('company_id', ...).eq('is_active', true)` | ✅ `idx_products_company_active` |
| Dashboard `low_stock_count` | `.eq('company_id', ...).eq('is_active', true).lte('stock_quantity', 10)` | ✅ `idx_products_company_active_stock` |

---

## Check 8 — Till Session / Recovery Queries Use Indexes ✅ PASS

| Route | Query pattern | Index |
|---|---|---|
| `GET /sessions` | `.eq('company_id', ...).order('opened_at', desc)` ± `.eq('status', ...)` | ✅ `idx_till_sessions_company_opened` / `idx_till_sessions_company_status` |
| `GET /sessions/current` | `.eq('company_id', ...).eq('user_id', ...).eq('status', 'open')` | ✅ `idx_till_sessions_company_user_status` |
| `POST /sessions/open` duplicate check | `.eq('company_id', ...).eq('user_id', ...).eq('status', 'open')` | ✅ `idx_till_sessions_company_user_status` |
| `GET /recovery/sessions` | `.eq('company_id', ...).in('status', ['open','closed']).order('opened_at', desc)` | ✅ `idx_till_sessions_company_opened` |
| `GET /sessions/pending-cashup` | `.eq('company_id', ...).eq('status', 'closed')` | ✅ `idx_till_sessions_company_status` |

---

## Check 9 — No Report Regressions ✅ PASS

Indexes are read-only query accelerators. They cannot change query results.

Verified:
- No index changes `WHERE` clause semantics
- No index changes column ordering or returned data
- No index changes NULL handling
- Reports return identical results — only faster
- Existing `idx_sales_idempotency_key` (partial unique) untouched and still in force for duplicate sale prevention

---

## Check 10 — No Migration Damage ✅ PASS

Migration 033 contains:
- **16** `CREATE INDEX IF NOT EXISTS` statements
- **0** `DROP` statements
- **0** `ALTER TABLE` statements
- **0** `UPDATE`, `INSERT`, `DELETE` statements
- **0** trigger modifications
- **0** function modifications
- No changes to append-only enforcement on `pos_audit_events` or `pos_recon_snapshots`

Tables not touched by this migration (confirmed untouched):
- `pos_audit_events` — 6 indexes intact
- `pos_recon_snapshots` — 2 indexes intact, append-only triggers intact
- `pos_returns` — 2 indexes intact

---

## Check 11 — No localStorage/sessionStorage Business Data ✅ PASS

`frontend-pos/index.html` localStorage usage audited — all uses are auth/session only:

| `localStorage` key | Category | Compliant? |
|---|---|---|
| `token` | JWT auth token | ✅ Permitted (auth) |
| `user` | Auth user identity | ✅ Permitted (auth) |
| `company` | SSO company handoff | ✅ Permitted (session) |
| `isSuperAdmin` | Auth flag | ✅ Permitted (auth) |
| `sso_source` | SSO routing flag (short-lived) | ✅ Permitted (session) |

No business data in localStorage: no sales amounts, no stock quantities, no payment totals, no product data. ✅

POS backend routes — no localStorage references (server-side JavaScript does not touch browser storage). ✅

`posReconService.js` explicitly documented: "No localStorage, no sessionStorage. DB is the single source of truth." ✅

---

## Confirmed Index Registry (Post-033)

### New indexes from 033

| Index | Table | Columns | Query coverage |
|---|---|---|---|
| `idx_products_company_active` | `products` | `(company_id, is_active)` | All product loads, inventory-value report |
| `idx_products_company_active_stock` | `products` | `(company_id, is_active, stock_quantity)` | Dashboard low-stock count |
| `idx_sales_company_created` | `sales` | `(company_id, created_at DESC)` | sales-summary, cashier-performance date range |
| `idx_sales_company_status_created` | `sales` | `(company_id, status, created_at DESC)` | Status-filtered report scans |
| `idx_sales_session_company` | `sales` | `(till_session_id, company_id)` | posReconService — all reconciliations |
| `idx_sales_session_status` | `sales` | `(till_session_id, status)` | Session close balance calculation |
| `idx_sales_company_user_created` | `sales` | `(company_id, user_id, created_at DESC)` | Cashier performance report |
| `idx_sale_items_sale_id` | `sale_items` | `(sale_id)` | Receipt embed join, top-products join |
| `idx_sale_items_company_product` | `sale_items` | `(company_id, product_id)` | Product-level aggregation |
| `idx_sale_payments_sale_id` | `sale_payments` | `(sale_id)` | posReconService IN array — critical |
| `idx_sale_payments_company_method` | `sale_payments` | `(company_id, payment_method)` | Payment method reporting |
| `idx_till_sessions_company_status` | `till_sessions` | `(company_id, status)` | Session list, pending cashup |
| `idx_till_sessions_company_user_status` | `till_sessions` | `(company_id, user_id, status)` | Current session, open-session check |
| `idx_till_sessions_company_opened` | `till_sessions` | `(company_id, opened_at DESC)` | Session history, recovery list |
| `idx_inventory_adj_company_created` | `inventory_adjustments` | `(company_id, created_at DESC)` | Adjustment history list |
| `idx_inventory_adj_product` | `inventory_adjustments` | `(product_id)` | Per-product adjustment history |

### Pre-existing indexes (confirmed intact)

| Index | Table | Source |
|---|---|---|
| `idx_sales_idempotency_key` | `sales` | Migration 026 |
| `idx_pos_audit_company_time` | `pos_audit_events` | Migration 028 |
| `idx_pos_audit_sale` | `pos_audit_events` | Migration 028 |
| `idx_pos_audit_session` | `pos_audit_events` | Migration 028 |
| `idx_pos_audit_category_type` | `pos_audit_events` | Migration 028 |
| `idx_pos_audit_offline_sync` | `pos_audit_events` | Migration 028 |
| `idx_pos_audit_auth` | `pos_audit_events` | Migration 028 |
| `idx_pos_recon_company_time` | `pos_recon_snapshots` | Migration 029 |
| `idx_pos_recon_session` | `pos_recon_snapshots` | Migration 029 |
| `idx_inventory_adj_company` | `inventory_adjustments` | pos-schema.js |
| `idx_pos_returns_company` | `pos_returns` | pos-schema.js |
| `idx_pos_returns_sale` | `pos_returns` | pos-schema.js |

---

## Remaining Slow-Query Risks

These are not index problems — they are application-level aggregation patterns that indexes cannot fully solve. Tracked as future report rewrite tasks.

### RISK-01 — Top-Products: Application-Side Aggregation (MEDIUM)

**Route:** `GET /api/reports/top-products`

Current behavior: Fetches all matching `sale_items` rows for the date range, returns them to Node.js, aggregates with `reduce` in JavaScript. With `idx_sale_items_sale_id` and `idx_sales_company_status_created` in place, the join is indexed — but the full result set still travels over the network and is aggregated in memory.

At low sale volume (pilot), this is fine. At high volume (1000+ daily sales × 10 items average = 10,000+ rows per report), this will be slow.

**Future fix:** Replace with a Supabase RPC / DB function that does `GROUP BY product_id SUM(quantity), SUM(line_total)` server-side. Do not rewrite now — pilot first.

### RISK-02 — Sales Summary: Application-Side Status Filter (LOW)

**Route:** `GET /api/reports/sales-summary`

Current behavior: Fetches all sales in date range without DB-level status filter (completed vs voided), then filters in JS. `idx_sales_company_created` covers the date range scan, but all statuses are fetched and status filtering is in-app.

`idx_sales_company_status_created` exists and is available, but this route doesn't use it because the status filter is applied post-fetch. Low risk at pilot scale.

**Future fix:** Add `.eq('status', 'completed')` to the DB query for completed-only totals, then separate voided fetch. Do not rewrite now.

### RISK-03 — Cashier Performance: No DB Aggregation (LOW)

**Route:** `GET /api/reports/cashier-performance`

Current behavior: Fetches all sales for company + date range, aggregates by `user_id` in JS. `idx_sales_company_created` covers the scan. As cashier count and sale volume grow, the in-memory aggregation grows proportionally.

**Future fix:** DB-level `GROUP BY user_id` via RPC. Do not rewrite now.

### RISK-04 — Inventory Low-Stock: App-Side Filter (LOW / COSMETIC)

**Route:** `GET /api/pos/inventory?low_stock=true`

Current behavior: Fetches all active products, then filters in JS to those below `min_stock_level`. `idx_products_company_active` covers the full fetch. The DB-level `.lte('stock_quantity', threshold)` would be faster, but at pilot scale this is negligible.

Note: `idx_products_company_active_stock` is correctly used by the dashboard's direct DB-level low-stock count — the inventory route is a separate code path.

**Future fix:** Pass `min_stock_level` as a DB filter in the inventory route. Do not change now.

---

## Report Queries Requiring Future Rewrite

| Report | Current pattern | Risk level | Recommended fix |
|---|---|---|---|
| `top-products` | Full `sale_items` result set, JS aggregation | MEDIUM (high volume) | DB GROUP BY RPC |
| `sales-summary` | Fetch all statuses, JS filter | LOW | Add status filter to DB query |
| `cashier-performance` | Fetch all sales, JS aggregation | LOW | DB GROUP BY user_id RPC |
| `inventory?low_stock` | Fetch all active, JS filter | LOW/COSMETIC | DB `.lte('stock_quantity', ...)` |

None of these require changes now. All are indexed at the DB scan level. The application-side aggregation is a performance ceiling, not a correctness problem.

---

## Final Status

| Check | Result |
|---|---|
| SQL syntax and column names correct | ✅ PASS |
| IF NOT EXISTS rerun safety | ✅ PASS |
| No duplicate or conflicting indexes | ✅ PASS |
| Reconciliation queries use indexes | ✅ PASS |
| Receipt queries use indexes | ✅ PASS |
| Top-products joins use indexes | ✅ PASS |
| Product loading queries use indexes | ✅ PASS |
| Till session / recovery queries use indexes | ✅ PASS |
| No report regressions | ✅ PASS |
| No migration damage | ✅ PASS |
| No localStorage/sessionStorage business data | ✅ PASS |

**Migration 033 is verified correct and production-ready.**
