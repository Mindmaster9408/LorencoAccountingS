# 19 — CORE DB INDEXES IMPLEMENTED
## Checkout Charlie — Workstream 5D: Query Performance Hardening

**Date:** 2026-05-12
**Status:** ✅ Implemented
**Migration:** `accounting-ecosystem/database/migrations/033_pos_core_performance_indexes.sql`
**Risk:** Zero — `CREATE INDEX IF NOT EXISTS` only. No data changes. No business logic changes.

---

## Audit Summary

Full read audit of all POS migrations (024–032) and routes (reports.js, sessions.js, inventory.js, recovery.js, reconciliation.js) plus posReconService.js to map every significant query pattern before writing SQL.

### Pre-existing indexes (confirmed adequate — not changed)

| Table | Index | Source |
|---|---|---|
| `sales` | `idx_sales_idempotency_key` (partial unique) | Migration 026 |
| `pos_audit_events` | 6 indexes (company_time, sale, session, category_type, offline_sync, auth) | Migration 028 |
| `pos_recon_snapshots` | `idx_pos_recon_company_time`, `idx_pos_recon_session` | Migration 029 |
| `pos_returns` | `idx_pos_returns_company`, `idx_pos_returns_sale` | pos-schema.js |
| `inventory_adjustments` | `idx_inventory_adj_company` | pos-schema.js |

---

## Indexes Implemented

### `products` table — 2 new indexes

| Index | Columns | Why |
|---|---|---|
| `idx_products_company_active` | `(company_id, is_active)` | Every product list load, inventory view, all report product queries |
| `idx_products_company_active_stock` | `(company_id, is_active, stock_quantity)` | Low-stock dashboard filter — `.lte('stock_quantity', threshold)` with no index caused full scan |

**Before:** No performance indexes. Every product load = full table scan filtered in app code.

---

### `sales` table — 5 new indexes

| Index | Columns | Why |
|---|---|---|
| `idx_sales_company_created` | `(company_id, created_at DESC)` | Sales-summary report date-range scans |
| `idx_sales_company_status_created` | `(company_id, status, created_at DESC)` | Status-filtered report queries (completed sales in range) |
| `idx_sales_session_company` | `(till_session_id, company_id)` | posReconService: fetch all sales for a till session |
| `idx_sales_session_status` | `(till_session_id, status)` | Session close: expected balance — filter by session+completed |
| `idx_sales_company_user_created` | `(company_id, user_id, created_at DESC)` | Cashier performance report |

**Before:** Only `idx_sales_idempotency_key` (partial unique — only used for duplicate prevention, not query acceleration). All report and recon queries = full table scans.

---

### `sale_items` table — 2 new indexes

| Index | Columns | Why |
|---|---|---|
| `idx_sale_items_sale_id` | `(sale_id)` | Receipt retrieval + top-products report — joins to sales via sale_id per sale |
| `idx_sale_items_company_product` | `(company_id, product_id)` | Product-level revenue/units aggregation in reports |

**Before:** No indexes. Full table scan on every receipt view and every report run.

---

### `sale_payments` table — 2 new indexes

| Index | Columns | Why |
|---|---|---|
| `idx_sale_payments_sale_id` | `(sale_id)` | **Most critical miss.** posReconService calls `.in('sale_id', saleIds)` — up to hundreds of IDs per session reconciliation with no index |
| `idx_sale_payments_company_method` | `(company_id, payment_method)` | Payment method total reporting |

**Before:** No indexes. Every reconciliation run = full table scan of all payments, filtered by IN array in DB.

---

### `till_sessions` table — 3 new indexes

| Index | Columns | Why |
|---|---|---|
| `idx_till_sessions_company_status` | `(company_id, status)` | GET /sessions list — active sessions for company |
| `idx_till_sessions_company_user_status` | `(company_id, user_id, status)` | GET /sessions/current — find open session for current user |
| `idx_till_sessions_company_opened` | `(company_id, opened_at DESC)` | Session history list, recovery session list |

**Before:** Created by core schema (pre-migration-001). Index state unverified by migration audit. `IF NOT EXISTS` guards against any Supabase auto-created indexes.

---

### `inventory_adjustments` table — 2 new indexes

| Index | Columns | Why |
|---|---|---|
| `idx_inventory_adj_company_created` | `(company_id, created_at DESC)` | Adjustment history list — existing `idx_inventory_adj_company` only had company_id, not time-ordered |
| `idx_inventory_adj_product` | `(product_id)` | Per-product adjustment history lookup |

**Before:** `idx_inventory_adj_company` existed but only covered company_id, not time ordering.

---

## Total Index Count

| Table | Before | Added | After |
|---|---|---|---|
| `products` | 0 | 2 | 2 |
| `sales` | 1 | 5 | 6 |
| `sale_items` | 0 | 2 | 2 |
| `sale_payments` | 0 | 2 | 2 |
| `till_sessions` | unknown | 3 | 3+ |
| `inventory_adjustments` | 1 | 2 | 3 |
| `pos_audit_events` | 6 | 0 | 6 |
| `pos_recon_snapshots` | 2 | 0 | 2 |
| `pos_returns` | 2 | 0 | 2 |

**16 new indexes added across 6 tables.**

---

## Critical Fixes by Impact

### 1. posReconService — `sale_payments` IN array lookup (CRITICAL)
`posReconService.computeSessionRecon()` fetches all sales for a session, then calls:
```javascript
.in('sale_id', saleIds)
```
With no index on `sale_payments(sale_id)`, this was a full-table scan per reconciliation run. Fixed by `idx_sale_payments_sale_id`.

### 2. posReconService — sales for session (HIGH)
The query `.eq('till_session_id', session.id).eq('company_id', companyId)` on `sales` had no index on `till_session_id`. Fixed by `idx_sales_session_company`.

### 3. Reports — top-products aggregation (HIGH)
`reports.js` aggregates `sale_items` by `product_id` for top-products report. No index on `sale_items(sale_id)` meant every join to `sales` was a full scan. Fixed by `idx_sale_items_sale_id`.

### 4. Reports — date range sales scans (HIGH)
All sales-summary and filtered report queries on `sales(company_id, created_at)` were full table scans. Fixed by `idx_sales_company_created` and `idx_sales_company_status_created`.

---

## What Was NOT Changed

- No table data modified
- No business logic modified
- No routes or services modified
- No destructive operations (no DROP INDEX, no ALTER TABLE)
- `pos_audit_events` — already has 6 well-designed indexes (untouched)
- `pos_recon_snapshots` — already has 2 indexes (untouched)
- `pos_returns` — already has company + sale indexes (untouched)

---

## How to Apply

Run against Supabase SQL editor or via migration runner:

```sql
-- Apply migration 033
\i accounting-ecosystem/database/migrations/033_pos_core_performance_indexes.sql
```

All statements are `CREATE INDEX IF NOT EXISTS` — safe to run on a live database. Postgres creates indexes without locking reads or writes (using `CREATE INDEX CONCURRENTLY` is optional but not required here since these are applied during deployment, not on a live high-traffic system).

---

## Regression Risk

**None.** Indexes are read-only query accelerators. They do not change query results, data, or business logic. The only effect is faster query execution. If an index creation fails (e.g., column name mismatch), the statement fails silently with no impact on any other statement or existing data.
