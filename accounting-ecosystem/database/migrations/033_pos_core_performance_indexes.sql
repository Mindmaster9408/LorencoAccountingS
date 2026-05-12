-- ============================================================================
-- Migration 033 — POS Core Performance Indexes
-- ============================================================================
-- Workstream 5D: Core DB Index + Query Performance Audit
--
-- SAFE: CREATE INDEX IF NOT EXISTS only.
-- No table data changes. No business logic changes. No destructive operations.
-- All indexes are non-unique B-tree indexes unless noted.
-- Safe to run multiple times (idempotent).
--
-- Audit source: routes/reports.js, routes/sessions.js, routes/inventory.js,
--               routes/recovery.js, routes/reconciliation.js,
--               services/posReconService.js
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PRODUCTS
-- No performance indexes existed. All product loads, inventory views,
-- and low-stock filters do full table scans filtered in application code.
-- ----------------------------------------------------------------------------

-- Every product list load: GET /inventory, GET /products, reports
CREATE INDEX IF NOT EXISTS idx_products_company_active
    ON products (company_id, is_active);

-- Low-stock dashboard filter: .lte('stock_quantity', threshold)
CREATE INDEX IF NOT EXISTS idx_products_company_active_stock
    ON products (company_id, is_active, stock_quantity);

-- ----------------------------------------------------------------------------
-- SALES
-- Only existing index: idx_sales_idempotency_key (partial unique, idempotency only).
-- All report date-range scans, session-based recon lookups, and cashier
-- performance queries do full table scans.
-- ----------------------------------------------------------------------------

-- Sales-summary report: company_id + date range ordered by created_at DESC
CREATE INDEX IF NOT EXISTS idx_sales_company_created
    ON sales (company_id, created_at DESC);

-- Status-filtered report queries: completed sales in date range
CREATE INDEX IF NOT EXISTS idx_sales_company_status_created
    ON sales (company_id, status, created_at DESC);

-- posReconService: sales for a till session (most critical recon lookup)
CREATE INDEX IF NOT EXISTS idx_sales_session_company
    ON sales (till_session_id, company_id);

-- Session close: expected balance calculation filters by session+status
CREATE INDEX IF NOT EXISTS idx_sales_session_status
    ON sales (till_session_id, status);

-- Cashier performance report: company_id + user_id
CREATE INDEX IF NOT EXISTS idx_sales_company_user_created
    ON sales (company_id, user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- SALE_ITEMS
-- No indexes existed. Top-products report and receipt retrieval join
-- sale_items to sales via sale_id — currently a full table scan per sale.
-- ----------------------------------------------------------------------------

-- Every sale_items join: receipt retrieval, top-products report aggregation
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id
    ON sale_items (sale_id);

-- Product-level aggregation: revenue and units sold per product
CREATE INDEX IF NOT EXISTS idx_sale_items_company_product
    ON sale_items (company_id, product_id);

-- ----------------------------------------------------------------------------
-- SALE_PAYMENTS
-- No indexes existed. posReconService calls:
--   .in('sale_id', saleIds)  — up to hundreds of IDs per session
-- Full table scan on every reconciliation. Most critical missing index.
-- ----------------------------------------------------------------------------

-- posReconService: payment method totals per sale (IN array lookup)
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id
    ON sale_payments (sale_id);

-- Payment method reporting: totals by method across company
CREATE INDEX IF NOT EXISTS idx_sale_payments_company_method
    ON sale_payments (company_id, payment_method);

-- ----------------------------------------------------------------------------
-- TILL_SESSIONS
-- Created by core schema (not a POS migration). Index status unverified
-- by migration audit. Adding guards for all known query patterns.
-- All are IF NOT EXISTS — no risk if Supabase auto-created any.
-- ----------------------------------------------------------------------------

-- GET /sessions list: active sessions for company
CREATE INDEX IF NOT EXISTS idx_till_sessions_company_status
    ON till_sessions (company_id, status);

-- GET /sessions/current: find open session for current user
CREATE INDEX IF NOT EXISTS idx_till_sessions_company_user_status
    ON till_sessions (company_id, user_id, status);

-- Session history list: ordered by opened_at
CREATE INDEX IF NOT EXISTS idx_till_sessions_company_opened
    ON till_sessions (company_id, opened_at DESC);

-- ----------------------------------------------------------------------------
-- INVENTORY_ADJUSTMENTS
-- Only existing index: idx_inventory_adj_company (company_id only).
-- Adjustment history list orders by created_at — requires composite index.
-- ----------------------------------------------------------------------------

-- Adjustment history list: company_id + time-ordered
CREATE INDEX IF NOT EXISTS idx_inventory_adj_company_created
    ON inventory_adjustments (company_id, created_at DESC);

-- Per-product adjustment history
CREATE INDEX IF NOT EXISTS idx_inventory_adj_product
    ON inventory_adjustments (product_id);

-- ============================================================================
-- Already well-indexed — no changes needed:
--   pos_audit_events    — 6 indexes from migration 028
--   pos_recon_snapshots — 2 indexes from migration 029
--   pos_returns         — idx_pos_returns_company, idx_pos_returns_sale
-- ============================================================================
