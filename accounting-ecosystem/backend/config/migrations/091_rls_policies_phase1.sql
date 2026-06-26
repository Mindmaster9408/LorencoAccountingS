-- ============================================================
-- Migration 091: RLS Phase 1 — Define Policies, Zero Enforcement
-- ============================================================
--
-- PHASE 1: Policies are defined but COMPLETELY INERT.
-- The backend connects exclusively via the Supabase service-role key,
-- which bypasses ALL RLS policies unconditionally.
-- Adding these policies to a service-role-only backend changes NOTHING
-- in production — no query behaviour, no access control, no performance.
--
-- Purpose: Pre-stage correct RLS policies so Phase 3 enforcement can be
-- activated per-wave without writing new SQL.
--
-- What is included: Category A tables only — tables with a single
-- non-nullable company_id column where every existing route already
-- filters by that column. Standard USING/WITH CHECK pattern.
--
-- What is excluded:
--   - Category B (complex ownership): inter_company_*, eco_clients,
--     eco_client_firm_access, sean_knowledge_items (nullable),
--     sean_allocation_rules (is_global), practice_workflow_templates
--     (nullable), practice_tax_year_configs (nullable),
--     practice_tax_brackets (nullable)
--   - Category C (service-role only): users, companies,
--     user_company_access, feature_flags, password_reset_tokens,
--     payroll_kv_store_eco, sean_global_patterns,
--     legacy_gl_account_mappings
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE POLICY.
--             CREATE OR REPLACE FUNCTION for helpers.
--             ALTER TABLE ENABLE ROW LEVEL SECURITY is a no-op if already set.
--
-- Safe to run multiple times. Run once in Supabase SQL Editor.
-- Expected result: "Success. No rows returned"
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTIONS
-- Read per-request session variables set by the backend via set_config().
-- During Phase 1 these are never called (service-role bypasses all policies).
-- During Phase 3 the backend sets them before each user-facing query via:
--   pool.query("SELECT set_config('app.company_id', $1, true)", [String(req.companyId)])
--   pool.query("SELECT set_config('app.user_id', $2, true)", [String(req.user.userId)])
--   pool.query("SELECT set_config('app.is_super_admin', $3, true)", [String(!!req.user.isSuperAdmin)])
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_company_id()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::integer
$$;

CREATE OR REPLACE FUNCTION app_user_id()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::integer
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_super_admin', true), '')::boolean, false)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — POS / RETAIL
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "products_company_isolation" ON products;
CREATE POLICY "products_company_isolation" ON products
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_company_isolation" ON sales;
CREATE POLICY "sales_company_isolation" ON sales
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_items_company_isolation" ON sale_items;
CREATE POLICY "sale_items_company_isolation" ON sale_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customers_company_isolation" ON customers;
CREATE POLICY "customers_company_isolation" ON customers
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE tills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tills_company_isolation" ON tills;
CREATE POLICY "tills_company_isolation" ON tills
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE till_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "till_sessions_company_isolation" ON till_sessions;
CREATE POLICY "till_sessions_company_isolation" ON till_sessions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_daily_discounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_daily_discounts_company_isolation" ON pos_daily_discounts;
CREATE POLICY "pos_daily_discounts_company_isolation" ON pos_daily_discounts
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_returns_company_isolation" ON pos_returns;
CREATE POLICY "pos_returns_company_isolation" ON pos_returns
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_adjustments_company_isolation" ON inventory_adjustments;
CREATE POLICY "inventory_adjustments_company_isolation" ON inventory_adjustments
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_stock_takes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_stock_takes_company_isolation" ON pos_stock_takes;
CREATE POLICY "pos_stock_takes_company_isolation" ON pos_stock_takes
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_stock_take_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_stock_take_items_company_isolation" ON pos_stock_take_items;
CREATE POLICY "pos_stock_take_items_company_isolation" ON pos_stock_take_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_supplier_receives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_supplier_receives_company_isolation" ON pos_supplier_receives;
CREATE POLICY "pos_supplier_receives_company_isolation" ON pos_supplier_receives
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_supplier_receive_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_supplier_receive_items_company_isolation" ON pos_supplier_receive_items;
CREATE POLICY "pos_supplier_receive_items_company_isolation" ON pos_supplier_receive_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_stock_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_stock_transfers_company_isolation" ON pos_stock_transfers;
CREATE POLICY "pos_stock_transfers_company_isolation" ON pos_stock_transfers
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_stock_transfer_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_stock_transfer_items_company_isolation" ON pos_stock_transfer_items;
CREATE POLICY "pos_stock_transfer_items_company_isolation" ON pos_stock_transfer_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE loyalty_programs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "loyalty_programs_company_isolation" ON loyalty_programs;
CREATE POLICY "loyalty_programs_company_isolation" ON loyalty_programs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "loyalty_transactions_company_isolation" ON loyalty_transactions;
CREATE POLICY "loyalty_transactions_company_isolation" ON loyalty_transactions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE customer_account_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_acct_txns_company_isolation" ON customer_account_transactions;
CREATE POLICY "customer_acct_txns_company_isolation" ON customer_account_transactions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_emergency_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_emergency_state_company_isolation" ON pos_emergency_state;
CREATE POLICY "pos_emergency_state_company_isolation" ON pos_emergency_state
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — PAYROLL
-- Stability-locked module. Phase 3 wave requires full TEST-PAY-01 to TEST-PAY-14.
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "employees_company_isolation" ON employees;
CREATE POLICY "employees_company_isolation" ON employees
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_runs_company_isolation" ON payroll_runs;
CREATE POLICY "payroll_runs_company_isolation" ON payroll_runs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_items_company_isolation" ON payroll_items;
CREATE POLICY "payroll_items_company_isolation" ON payroll_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_recon_submitted ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_recon_submitted_company_isolation" ON payroll_recon_submitted;
CREATE POLICY "payroll_recon_submitted_company_isolation" ON payroll_recon_submitted
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_recon_finalized ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_recon_finalized_company_isolation" ON payroll_recon_finalized;
CREATE POLICY "payroll_recon_finalized_company_isolation" ON payroll_recon_finalized
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — ACCOUNTING
-- customer_invoice_lines and customer_quote_lines have no direct company_id —
-- they use a subquery through their parent table.
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "accounts_company_isolation" ON accounts;
CREATE POLICY "accounts_company_isolation" ON accounts
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE journals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "journals_company_isolation" ON journals;
CREATE POLICY "journals_company_isolation" ON journals
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE customer_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_invoices_company_isolation" ON customer_invoices;
CREATE POLICY "customer_invoices_company_isolation" ON customer_invoices
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- customer_invoice_lines has no direct company_id — join through parent
ALTER TABLE customer_invoice_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_invoice_lines_company_isolation" ON customer_invoice_lines;
CREATE POLICY "customer_invoice_lines_company_isolation" ON customer_invoice_lines
  USING (
    app_is_super_admin() = true
    OR invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = app_company_id())
  )
  WITH CHECK (
    app_is_super_admin() = true
    OR invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = app_company_id())
  );

ALTER TABLE customer_quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_quotes_company_isolation" ON customer_quotes;
CREATE POLICY "customer_quotes_company_isolation" ON customer_quotes
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- customer_quote_lines has no direct company_id — join through parent
ALTER TABLE customer_quote_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_quote_lines_company_isolation" ON customer_quote_lines;
CREATE POLICY "customer_quote_lines_company_isolation" ON customer_quote_lines
  USING (
    app_is_super_admin() = true
    OR quote_id IN (SELECT id FROM customer_quotes WHERE company_id = app_company_id())
  )
  WITH CHECK (
    app_is_super_admin() = true
    OR quote_id IN (SELECT id FROM customer_quotes WHERE company_id = app_company_id())
  );

ALTER TABLE accounting_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "accounting_items_company_isolation" ON accounting_items;
CREATE POLICY "accounting_items_company_isolation" ON accounting_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE customer_credit_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_credit_notes_company_isolation" ON customer_credit_notes;
CREATE POLICY "customer_credit_notes_company_isolation" ON customer_credit_notes
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE legacy_gl_import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "legacy_gl_import_batches_company_isolation" ON legacy_gl_import_batches;
CREATE POLICY "legacy_gl_import_batches_company_isolation" ON legacy_gl_import_batches
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE legacy_gl_import_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "legacy_gl_import_lines_company_isolation" ON legacy_gl_import_lines;
CREATE POLICY "legacy_gl_import_lines_company_isolation" ON legacy_gl_import_lines
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — INVENTORY / STOREHOUSE
-- purchase_order_items has no direct company_id — join through parent.
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "warehouses_company_isolation" ON warehouses;
CREATE POLICY "warehouses_company_isolation" ON warehouses
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_items_company_isolation" ON inventory_items;
CREATE POLICY "inventory_items_company_isolation" ON inventory_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "suppliers_company_isolation" ON suppliers;
CREATE POLICY "suppliers_company_isolation" ON suppliers
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stock_movements_company_isolation" ON stock_movements;
CREATE POLICY "stock_movements_company_isolation" ON stock_movements
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_orders_company_isolation" ON purchase_orders;
CREATE POLICY "purchase_orders_company_isolation" ON purchase_orders
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- purchase_order_items has no direct company_id — join through parent
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_order_items_company_isolation" ON purchase_order_items;
CREATE POLICY "purchase_order_items_company_isolation" ON purchase_order_items
  USING (
    app_is_super_admin() = true
    OR purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = app_company_id())
  )
  WITH CHECK (
    app_is_super_admin() = true
    OR purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = app_company_id())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — PRACTICE MANAGEMENT (CORE)
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_profiles_company_isolation" ON practice_profiles;
CREATE POLICY "practice_profiles_company_isolation" ON practice_profiles
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_clients_company_isolation" ON practice_clients;
CREATE POLICY "practice_clients_company_isolation" ON practice_clients
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tasks_company_isolation" ON practice_tasks;
CREATE POLICY "practice_tasks_company_isolation" ON practice_tasks
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_task_review_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_task_review_events_company_isolation" ON practice_task_review_events;
CREATE POLICY "practice_task_review_events_company_isolation" ON practice_task_review_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_time_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_time_entries_company_isolation" ON practice_time_entries;
CREATE POLICY "practice_time_entries_company_isolation" ON practice_time_entries
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_deadlines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_deadlines_company_isolation" ON practice_deadlines;
CREATE POLICY "practice_deadlines_company_isolation" ON practice_deadlines
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_deadline_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_deadline_events_company_isolation" ON practice_deadline_events;
CREATE POLICY "practice_deadline_events_company_isolation" ON practice_deadline_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_compliance_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_compliance_rules_company_isolation" ON practice_compliance_rules;
CREATE POLICY "practice_compliance_rules_company_isolation" ON practice_compliance_rules
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_team_members_company_isolation" ON practice_team_members;
CREATE POLICY "practice_team_members_company_isolation" ON practice_team_members
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_service_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_service_catalog_company_isolation" ON practice_service_catalog;
CREATE POLICY "practice_service_catalog_company_isolation" ON practice_service_catalog
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_client_engagements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_client_engagements_company_isolation" ON practice_client_engagements;
CREATE POLICY "practice_client_engagements_company_isolation" ON practice_client_engagements
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_client_engagement_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_client_engagement_events_co_iso" ON practice_client_engagement_events;
CREATE POLICY "practice_client_engagement_events_co_iso" ON practice_client_engagement_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_engagement_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_engagement_periods_company_isolation" ON practice_engagement_periods;
CREATE POLICY "practice_engagement_periods_company_isolation" ON practice_engagement_periods
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_client_health_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_client_health_snapshots_co_iso" ON practice_client_health_snapshots;
CREATE POLICY "practice_client_health_snapshots_co_iso" ON practice_client_health_snapshots
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_client_health_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_client_health_actions_co_iso" ON practice_client_health_actions;
CREATE POLICY "practice_client_health_actions_co_iso" ON practice_client_health_actions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_reminders_company_isolation" ON practice_reminders;
CREATE POLICY "practice_reminders_company_isolation" ON practice_reminders
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_client_communications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_client_comms_company_isolation" ON practice_client_communications;
CREATE POLICY "practice_client_comms_company_isolation" ON practice_client_communications
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_document_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_document_requests_company_isolation" ON practice_document_requests;
CREATE POLICY "practice_document_requests_company_isolation" ON practice_document_requests
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_document_checklists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_document_checklists_co_iso" ON practice_document_checklists;
CREATE POLICY "practice_document_checklists_co_iso" ON practice_document_checklists
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_document_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_doc_checklist_items_co_iso" ON practice_document_checklist_items;
CREATE POLICY "practice_doc_checklist_items_co_iso" ON practice_document_checklist_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_compliance_packs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_compliance_packs_company_isolation" ON practice_compliance_packs;
CREATE POLICY "practice_compliance_packs_company_isolation" ON practice_compliance_packs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_compliance_pack_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_compliance_pack_items_co_iso" ON practice_compliance_pack_items;
CREATE POLICY "practice_compliance_pack_items_co_iso" ON practice_compliance_pack_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_compliance_pack_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_compliance_pack_events_co_iso" ON practice_compliance_pack_events;
CREATE POLICY "practice_compliance_pack_events_co_iso" ON practice_compliance_pack_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_billing_packs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_billing_packs_company_isolation" ON practice_billing_packs;
CREATE POLICY "practice_billing_packs_company_isolation" ON practice_billing_packs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_billing_pack_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_billing_pack_lines_co_iso" ON practice_billing_pack_lines;
CREATE POLICY "practice_billing_pack_lines_co_iso" ON practice_billing_pack_lines
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_billing_pack_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_billing_pack_events_co_iso" ON practice_billing_pack_events;
CREATE POLICY "practice_billing_pack_events_co_iso" ON practice_billing_pack_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — PRACTICE TAX
-- Phase 3 enforcement requires dedicated wave gate before payroll (Wave 5).
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_taxpayer_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_taxpayer_profiles_company_isolation" ON practice_taxpayer_profiles;
CREATE POLICY "practice_taxpayer_profiles_company_isolation" ON practice_taxpayer_profiles
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_taxpayer_income_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_taxpayer_income_sources_co_iso" ON practice_taxpayer_income_sources;
CREATE POLICY "practice_taxpayer_income_sources_co_iso" ON practice_taxpayer_income_sources
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_taxpayer_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_taxpayer_deductions_co_iso" ON practice_taxpayer_deductions;
CREATE POLICY "practice_taxpayer_deductions_co_iso" ON practice_taxpayer_deductions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_taxpayer_readiness_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_taxpayer_readiness_items_co_iso" ON practice_taxpayer_readiness_items;
CREATE POLICY "practice_taxpayer_readiness_items_co_iso" ON practice_taxpayer_readiness_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_individual_tax_returns_co_iso" ON practice_individual_tax_returns;
CREATE POLICY "practice_individual_tax_returns_co_iso" ON practice_individual_tax_returns
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_individual_tax_items_co_iso" ON practice_individual_tax_items;
CREATE POLICY "practice_individual_tax_items_co_iso" ON practice_individual_tax_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_income_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_ind_tax_income_entries_co_iso" ON practice_individual_tax_income_entries;
CREATE POLICY "practice_ind_tax_income_entries_co_iso" ON practice_individual_tax_income_entries
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_deduction_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_ind_tax_deduction_entries_co_iso" ON practice_individual_tax_deduction_entries;
CREATE POLICY "practice_ind_tax_deduction_entries_co_iso" ON practice_individual_tax_deduction_entries
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_individual_tax_events_co_iso" ON practice_individual_tax_events;
CREATE POLICY "practice_individual_tax_events_co_iso" ON practice_individual_tax_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_calculations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_ind_tax_calcs_co_iso" ON practice_individual_tax_calculations;
CREATE POLICY "practice_ind_tax_calcs_co_iso" ON practice_individual_tax_calculations
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_calculation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_ind_tax_calc_events_co_iso" ON practice_individual_tax_calculation_events;
CREATE POLICY "practice_ind_tax_calc_events_co_iso" ON practice_individual_tax_calculation_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_review_packs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_ind_tax_review_packs_co_iso" ON practice_individual_tax_review_packs;
CREATE POLICY "practice_ind_tax_review_packs_co_iso" ON practice_individual_tax_review_packs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_individual_tax_review_pack_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_ind_tax_review_pack_events_co_iso" ON practice_individual_tax_review_pack_events;
CREATE POLICY "practice_ind_tax_review_pack_events_co_iso" ON practice_individual_tax_review_pack_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_company_tax_returns_co_iso" ON practice_company_tax_returns;
CREATE POLICY "practice_company_tax_returns_co_iso" ON practice_company_tax_returns
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_company_tax_adjustments_co_iso" ON practice_company_tax_adjustments;
CREATE POLICY "practice_company_tax_adjustments_co_iso" ON practice_company_tax_adjustments
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_readiness_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_co_tax_readiness_items_co_iso" ON practice_company_tax_readiness_items;
CREATE POLICY "practice_co_tax_readiness_items_co_iso" ON practice_company_tax_readiness_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_company_tax_events_co_iso" ON practice_company_tax_events;
CREATE POLICY "practice_company_tax_events_co_iso" ON practice_company_tax_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_calculations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_co_tax_calcs_co_iso" ON practice_company_tax_calculations;
CREATE POLICY "practice_co_tax_calcs_co_iso" ON practice_company_tax_calculations
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_calculation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_co_tax_calc_events_co_iso" ON practice_company_tax_calculation_events;
CREATE POLICY "practice_co_tax_calc_events_co_iso" ON practice_company_tax_calculation_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_review_packs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_co_tax_review_packs_co_iso" ON practice_company_tax_review_packs;
CREATE POLICY "practice_co_tax_review_packs_co_iso" ON practice_company_tax_review_packs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_company_tax_review_pack_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_co_tax_review_pack_events_co_iso" ON practice_company_tax_review_pack_events;
CREATE POLICY "practice_co_tax_review_pack_events_co_iso" ON practice_company_tax_review_pack_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_work_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_work_actions_co_iso" ON practice_tax_work_actions;
CREATE POLICY "practice_tax_work_actions_co_iso" ON practice_tax_work_actions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_work_action_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_work_action_events_co_iso" ON practice_tax_work_action_events;
CREATE POLICY "practice_tax_work_action_events_co_iso" ON practice_tax_work_action_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_checklist_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_checklist_templates_co_iso" ON practice_tax_checklist_templates;
CREATE POLICY "practice_tax_checklist_templates_co_iso" ON practice_tax_checklist_templates
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_checklist_template_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_checklist_tmpl_items_co_iso" ON practice_tax_checklist_template_items;
CREATE POLICY "practice_tax_checklist_tmpl_items_co_iso" ON practice_tax_checklist_template_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_checklist_template_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_checklist_tmpl_events_co_iso" ON practice_tax_checklist_template_events;
CREATE POLICY "practice_tax_checklist_tmpl_events_co_iso" ON practice_tax_checklist_template_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_bulk_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_bulk_operations_co_iso" ON practice_tax_bulk_operations;
CREATE POLICY "practice_tax_bulk_operations_co_iso" ON practice_tax_bulk_operations
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_bulk_operation_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_bulk_op_items_co_iso" ON practice_tax_bulk_operation_items;
CREATE POLICY "practice_tax_bulk_op_items_co_iso" ON practice_tax_bulk_operation_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_bulk_operation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_bulk_op_events_co_iso" ON practice_tax_bulk_operation_events;
CREATE POLICY "practice_tax_bulk_op_events_co_iso" ON practice_tax_bulk_operation_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_provisional_tax_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_provisional_tax_plans_co_iso" ON practice_provisional_tax_plans;
CREATE POLICY "practice_provisional_tax_plans_co_iso" ON practice_provisional_tax_plans
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_provisional_tax_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_provisional_tax_periods_co_iso" ON practice_provisional_tax_periods;
CREATE POLICY "practice_provisional_tax_periods_co_iso" ON practice_provisional_tax_periods
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_provisional_tax_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_provisional_tax_events_co_iso" ON practice_provisional_tax_events;
CREATE POLICY "practice_provisional_tax_events_co_iso" ON practice_provisional_tax_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_reporting_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_reporting_snapshots_co_iso" ON practice_tax_reporting_snapshots;
CREATE POLICY "practice_tax_reporting_snapshots_co_iso" ON practice_tax_reporting_snapshots
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_pipeline_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_pipeline_events_co_iso" ON practice_tax_pipeline_events;
CREATE POLICY "practice_tax_pipeline_events_co_iso" ON practice_tax_pipeline_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_submissions_co_iso" ON practice_tax_submissions;
CREATE POLICY "practice_tax_submissions_co_iso" ON practice_tax_submissions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_submission_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_submission_evidence_co_iso" ON practice_tax_submission_evidence;
CREATE POLICY "practice_tax_submission_evidence_co_iso" ON practice_tax_submission_evidence
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_tax_submission_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_tax_submission_events_co_iso" ON practice_tax_submission_events;
CREATE POLICY "practice_tax_submission_events_co_iso" ON practice_tax_submission_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — SEAN AI (COMPANY-SCOPED)
-- Excludes: sean_knowledge_items (nullable company_id — Category B),
--           sean_allocation_rules (is_global flag — Category B),
--           sean_global_patterns (no company_id column — Category C),
--           sean_sync_log (no company_id column — confirmed by diagnostic query
--                          2026-06-26; structure requires manual review before Phase 3).
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sean_codex_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_codex_entries_company_isolation" ON sean_codex_entries;
CREATE POLICY "sean_codex_entries_company_isolation" ON sean_codex_entries
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sean_bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_bank_transactions_company_isolation" ON sean_bank_transactions;
CREATE POLICY "sean_bank_transactions_company_isolation" ON sean_bank_transactions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sean_learning_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_learning_log_company_isolation" ON sean_learning_log;
CREATE POLICY "sean_learning_log_company_isolation" ON sean_learning_log
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sean_import_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_import_logs_company_isolation" ON sean_import_logs;
CREATE POLICY "sean_import_logs_company_isolation" ON sean_import_logs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sean_transaction_store ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_transaction_store_company_isolation" ON sean_transaction_store;
CREATE POLICY "sean_transaction_store_company_isolation" ON sean_transaction_store
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- sean_sync_log: EXCLUDED — no company_id column (confirmed 2026-06-26).
-- Requires schema inspection before a policy can be written. Deferred to Phase 3 planning.

ALTER TABLE sean_coaching_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_coaching_cases_company_isolation" ON sean_coaching_cases;
CREATE POLICY "sean_coaching_cases_company_isolation" ON sean_coaching_cases
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sean_coaching_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_coaching_audit_log_company_isolation" ON sean_coaching_audit_log;
CREATE POLICY "sean_coaching_audit_log_company_isolation" ON sean_coaching_audit_log
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — POS AUTH / PREFERENCES
-- Phase 1 policies are inert while backend uses service-role.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE user_pos_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_pos_pins_company_isolation" ON user_pos_pins;
CREATE POLICY "user_pos_pins_company_isolation" ON user_pos_pins
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_pin_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_pin_attempts_company_isolation" ON pos_pin_attempts;
CREATE POLICY "pos_pin_attempts_company_isolation" ON pos_pin_attempts
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_user_product_shortcuts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_user_product_shortcuts_co_iso" ON pos_user_product_shortcuts;
CREATE POLICY "pos_user_product_shortcuts_co_iso" ON pos_user_product_shortcuts
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- END OF PHASE 1 MIGRATION
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tables included: 113 tables across 8 sections
--   Section 1 — POS / Retail:              19 tables
--   Section 2 — Payroll:                    5 tables
--   Section 3 — Accounting:               10 tables (3 using parent-join policies)
--   Section 4 — Inventory / Storehouse:    6 tables (1 using parent-join policy)
--   Section 5 — Practice Core:            26 tables
--   Section 6 — Practice Tax:             33 tables
--   Section 7 — SEAN AI:                   7 tables (sean_sync_log excluded — no company_id)
--   Section 8 — POS Auth / Prefs:          3 tables
--   Helper functions:                       3 functions (app_company_id, app_user_id, app_is_super_admin)
--
-- Tables excluded (reasons documented in RLS_IMPLEMENTATION_PLAN_2026-06-25.md):
--   Category B (complex ownership):
--     inter_company_invoices, inter_company_relationships,
--     eco_clients, eco_client_firm_access,
--     sean_knowledge_items (nullable company_id),
--     sean_allocation_rules (is_global flag),
--     sean_sync_log (no company_id column — confirmed 2026-06-26, deferred to Phase 3),
--     practice_workflow_templates (nullable company_id),
--     practice_tax_year_configs (nullable company_id),
--     practice_tax_brackets (nullable company_id),
--     practice_tax_config_events (nullable company_id)
--   Category C (service-role only, no user-facing policies):
--     users, companies, user_company_access, feature_flags,
--     password_reset_tokens, payroll_kv_store_eco,
--     sean_global_patterns, legacy_gl_account_mappings
--
-- No backend code changed. No enforcement mechanism added.
-- All existing application behaviour is completely unchanged.
-- ─────────────────────────────────────────────────────────────────────────────
