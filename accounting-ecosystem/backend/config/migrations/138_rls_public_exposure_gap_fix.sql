-- ============================================================
-- Migration 138: RLS Gap Fix — Publicly Accessible Tables
-- ============================================================
--
-- Root cause: Supabase flagged "Table publicly accessible" (RLS not
-- enabled) on 2026-07-20. A full scan of all 425 tables exposed via
-- PostgREST — comparing service-role row counts against what an
-- unauthenticated request using only the public anon key can see —
-- confirmed 40 tables with real data readable by ANYONE with the project
-- URL, with zero authentication, completely bypassing the Express
-- backend's auth/permission/multi-tenant logic entirely. A first run of
-- Sections 1/2 below correctly fixed 32 of the 40; a follow-up scan found
-- the remaining 8 — all payroll_* — still fully exposed despite correct
-- policies now existing on them, which led to Section 3 (see there) and,
-- via a broader query, 5 MORE tables carrying the same underlying problem
-- that hadn't shown up in the original scan only because they were empty
-- at the time. 45 tables total, across all three sections.
--
-- Most severely: payroll_snapshots (67 real payslips — gross pay, PAYE,
-- UIF, net pay per employee) was returning ALL rows to an anonymous
-- request. Several sibling payroll_* tables are listed in migration
-- 091_rls_policies_phase1.sql's own ALTER TABLE statements, yet tested as
-- exposed in the live database — meaning either 091 was never fully
-- applied, or these specific tables were recreated afterward and lost
-- their RLS state. This migration does not depend on knowing which; it
-- re-asserts RLS on every currently-exposed table found by the live scan,
-- which is idempotent and safe to run even if some of it duplicates 091.
--
-- Same safety property as 091: the backend connects exclusively via the
-- Supabase service-role key, which bypasses ALL RLS unconditionally.
-- Enabling RLS here changes NOTHING about how the app itself behaves —
-- it only removes the ability for an unauthenticated anon-key request to
-- read/write/delete these tables directly against Supabase's API.
--
-- Two treatments, matching 091's own Category A / Category C split:
--
-- SECTION 1 (Category A — has a single, non-nullable company_id column):
-- standard company-isolation policy, identical pattern to 091.
--
-- SECTION 2 (Category C — no clean company_id, spans multiple companies,
-- is deliberately global/shared reference data, or is Coaching personal
-- data that must stay invisible to everyone but its one authorized user
-- per CLAUDE.md Rule F2): RLS enabled with NO policy at all. Postgres
-- RLS defaults to deny-all for every role except the table owner/
-- service-role when a table has RLS enabled and zero policies — this is
-- the correct, safe default here since none of these tables are ever
-- queried by anon/authenticated roles in the app's real architecture.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE POLICY.
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op if already set.
-- Safe to run multiple times. Run once in the Supabase SQL Editor.
-- Expected result: "Success. No rows returned"
-- ============================================================

-- Re-declare the helper functions defined in 091, in case that migration
-- was never actually applied to this database (CREATE OR REPLACE is a
-- no-op if they already exist and are identical).
CREATE OR REPLACE FUNCTION app_company_id()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::integer
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_super_admin', true), '')::boolean, false)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Category A: single, non-nullable company_id column
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pos_purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_purchase_order_items_company_isolation" ON pos_purchase_order_items;
CREATE POLICY "pos_purchase_order_items_company_isolation" ON pos_purchase_order_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_purchase_orders_company_isolation" ON pos_purchase_orders;
CREATE POLICY "pos_purchase_orders_company_isolation" ON pos_purchase_orders
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_items_company_isolation" ON payroll_items;
CREATE POLICY "payroll_items_company_isolation" ON payroll_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_short_time ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_short_time_company_isolation" ON payroll_short_time;
CREATE POLICY "payroll_short_time_company_isolation" ON payroll_short_time
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "accounting_periods_company_isolation" ON accounting_periods;
CREATE POLICY "accounting_periods_company_isolation" ON accounting_periods
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE bom_headers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bom_headers_company_isolation" ON bom_headers;
CREATE POLICY "bom_headers_company_isolation" ON bom_headers
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_runs_company_isolation" ON payroll_runs;
CREATE POLICY "payroll_runs_company_isolation" ON payroll_runs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE vat_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vat_periods_company_isolation" ON vat_periods;
CREATE POLICY "vat_periods_company_isolation" ON vat_periods
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "work_orders_company_isolation" ON work_orders;
CREATE POLICY "work_orders_company_isolation" ON work_orders
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE accounting_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "accounting_audit_log_company_isolation" ON accounting_audit_log;
CREATE POLICY "accounting_audit_log_company_isolation" ON accounting_audit_log
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE company_template_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "company_template_assignments_company_isolation" ON company_template_assignments;
CREATE POLICY "company_template_assignments_company_isolation" ON company_template_assignments
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE user_app_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_app_access_company_isolation" ON user_app_access;
CREATE POLICY "user_app_access_company_isolation" ON user_app_access
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_company_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_company_transfers_company_isolation" ON pos_company_transfers;
CREATE POLICY "pos_company_transfers_company_isolation" ON pos_company_transfers
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_company_transfer_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_company_transfer_items_company_isolation" ON pos_company_transfer_items;
CREATE POLICY "pos_company_transfer_items_company_isolation" ON pos_company_transfer_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_multi_rate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_multi_rate_company_isolation" ON payroll_multi_rate;
CREATE POLICY "payroll_multi_rate_company_isolation" ON payroll_multi_rate
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE employee_payroll_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "employee_payroll_items_company_isolation" ON employee_payroll_items;
CREATE POLICY "employee_payroll_items_company_isolation" ON employee_payroll_items
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE sean_bank_learning_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sean_bank_learning_events_company_isolation" ON sean_bank_learning_events;
CREATE POLICY "sean_bank_learning_events_company_isolation" ON sean_bank_learning_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- The single most severe finding — 67 real payslips (gross pay, PAYE,
-- UIF, net pay per employee) were fully readable by an anonymous request.
ALTER TABLE payroll_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_snapshots_company_isolation" ON payroll_snapshots;
CREATE POLICY "payroll_snapshots_company_isolation" ON payroll_snapshots
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE pos_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pos_devices_company_isolation" ON pos_devices;
CREATE POLICY "pos_devices_company_isolation" ON pos_devices
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_overtime ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_overtime_company_isolation" ON payroll_overtime;
CREATE POLICY "payroll_overtime_company_isolation" ON payroll_overtime
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE barcode_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "barcode_settings_company_isolation" ON barcode_settings;
CREATE POLICY "barcode_settings_company_isolation" ON barcode_settings
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE payroll_period_inputs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_period_inputs_company_isolation" ON payroll_period_inputs;
CREATE POLICY "payroll_period_inputs_company_isolation" ON payroll_period_inputs
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- accounting_kv_store's primary key is (company_id, key) — no surrogate id —
-- same isolation predicate still applies cleanly. UNLIKE every other table
-- here, company_id on THIS table is TEXT, not integer (config/accounting-
-- schema.js: "company_id TEXT NOT NULL") — confirmed live (a real row
-- returned company_id "4" as a JSON string, not a number) after the first
-- run of this migration failed with "operator does not exist: text =
-- integer". app_company_id() itself stays integer (every other table needs
-- that), so the cast happens here, on the one table that's different.
ALTER TABLE accounting_kv_store ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "accounting_kv_store_company_isolation" ON accounting_kv_store;
CREATE POLICY "accounting_kv_store_company_isolation" ON accounting_kv_store
  USING (app_is_super_admin() = true OR company_id = app_company_id()::text)
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id()::text);

ALTER TABLE eco_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "eco_clients_company_isolation" ON eco_clients;
CREATE POLICY "eco_clients_company_isolation" ON eco_clients
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_statutory_schedule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_statutory_schedule_company_isolation" ON practice_statutory_schedule;
CREATE POLICY "practice_statutory_schedule_company_isolation" ON practice_statutory_schedule
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_notifications_company_isolation" ON practice_notifications;
CREATE POLICY "practice_notifications_company_isolation" ON practice_notifications
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE practice_work_queue_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "practice_work_queue_events_company_isolation" ON practice_work_queue_events;
CREATE POLICY "practice_work_queue_events_company_isolation" ON practice_work_queue_events
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bank_transactions_company_isolation" ON bank_transactions;
CREATE POLICY "bank_transactions_company_isolation" ON bank_transactions
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- Found via the broader "any table still carrying the rogue 'Service role
-- full access' policy" check (Section 3) — these 4 didn't show up in the
-- original 425-table exposure scan simply because they had 0 rows at the
-- time, not because they were safe. All four have a proper, non-nullable
-- integer company_id (migrations/015_payroll_supabase_migration.sql,
-- config/payroll-schema.js) — standard Category A treatment.
ALTER TABLE company_payroll_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "company_payroll_settings_company_isolation" ON company_payroll_settings;
CREATE POLICY "company_payroll_settings_company_isolation" ON company_payroll_settings
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE employee_work_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "employee_work_schedules_company_isolation" ON employee_work_schedules;
CREATE POLICY "employee_work_schedules_company_isolation" ON employee_work_schedules
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE paytime_user_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "paytime_user_config_company_isolation" ON paytime_user_config;
CREATE POLICY "paytime_user_config_company_isolation" ON paytime_user_config
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

ALTER TABLE paytime_employee_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "paytime_employee_access_company_isolation" ON paytime_employee_access;
CREATE POLICY "paytime_employee_access_company_isolation" ON paytime_employee_access
  USING (app_is_super_admin() = true OR company_id = app_company_id())
  WITH CHECK (app_is_super_admin() = true OR company_id = app_company_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Category C: no clean single-company_id ownership, deliberately
-- global/shared reference data, or Coaching personal data. RLS enabled with
-- ZERO policies — Postgres denies every role except table owner/service-role
-- by default in that state. This is strictly protective; the app's own
-- backend is entirely unaffected (service-role always bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE work_order_materials      ENABLE ROW LEVEL SECURITY; -- child of work_orders, no own company_id
ALTER TABLE bom_lines                 ENABLE ROW LEVEL SECURITY; -- child of bom_headers, no own company_id
ALTER TABLE coa_template_accounts     ENABLE ROW LEVEL SECURITY; -- child of coa_templates, no own company_id
ALTER TABLE coa_templates             ENABLE ROW LEVEL SECURITY; -- shared reference templates, no company_id
ALTER TABLE inter_company_relationships ENABLE ROW LEVEL SECURITY; -- spans two companies, no single company_id
ALTER TABLE inter_company_invoices    ENABLE ROW LEVEL SECURITY; -- spans sender/receiver company_id, no single column
ALTER TABLE ecosystem_apps            ENABLE ROW LEVEL SECURITY; -- app registry — must not leak which apps exist (Rule F2)
ALTER TABLE sean_bank_allocation_patterns ENABLE ROW LEVEL SECURITY; -- global AI learning patterns, no company_id
ALTER TABLE sean_patterns_global       ENABLE ROW LEVEL SECURITY; -- explicitly global by design
ALTER TABLE sean_codex_articles        ENABLE ROW LEVEL SECURITY; -- global reference content, no company_id
ALTER TABLE sean_sync_log              ENABLE ROW LEVEL SECURITY; -- sync audit log, no single-company ownership
ALTER TABLE sean_knowledge_items       ENABLE ROW LEVEL SECURITY; -- company_id is nullable (global entries exist) — same "complex ownership" exclusion 091 already documented for this table

-- payroll_kv_store (NOT payroll_kv_store_eco, which is the live table the
-- app actually queries — routes/payroll-employee-sync.js) has zero
-- references anywhere in this codebase and zero rows live. Everything
-- points to this being an orphaned predecessor table nobody ever dropped.
-- No CREATE TABLE for it exists to confirm a column layout, so — same
-- reasoning as the rest of this section — deny-all-except-service-role
-- rather than guess at a company_isolation policy against an unknown
-- schema. If it truly is dead, this changes nothing; if it turns out to
-- still be read somewhere, it was already returning 0 rows to anon either
-- way and this only closes the same rogue-policy hole as its siblings.
ALTER TABLE payroll_kv_store           ENABLE ROW LEVEL SECURITY;

-- Coaching data — must stay invisible to everyone except the one authorized
-- user (has_coaching_access = true), enforced today entirely in application
-- code (backend/shared/routes/auth.js, dashboard.html). None of these tables
-- have a company_id at all, so deny-all-except-service-role is not just
-- safe here, it is the ONLY correct policy — a company-scoped policy would
-- be actively wrong for data that must not follow normal company boundaries.
ALTER TABLE coaching_spil_profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_client_question_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_questions                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_client_question_answers      ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — Rogue "Service role full access" policy (found live, after the
-- first run of this migration went through cleanly but a follow-up scan
-- showed 8 payroll_* tables were STILL fully exposed to anon).
--
-- A pre-existing policy named "Service role full access" has qual `true`
-- and applies TO PUBLIC (every Postgres role, not just service_role; it was
-- evidently meant to be scoped `TO service_role` and never was). Postgres
-- combines multiple PERMISSIVE policies for a role with OR, so this one
-- policy alone grants every role — including anon — unconditional access,
-- completely overriding any company_isolation policy from Sections 1/2
-- above, no matter how correct that policy is.
--
-- A second, broader check (`SELECT ... FROM pg_policies WHERE policyname =
-- 'Service role full access' OR (roles = '{public}' AND qual = 'true')`)
-- found this same policy on 13 tables total, not just the original 8 — the
-- other 5 (company_payroll_settings, employee_work_schedules,
-- payroll_kv_store, paytime_employee_access, paytime_user_config) didn't
-- appear in the original 425-table exposure scan purely because they had 0
-- rows at scan time, not because they were safe — same rogue policy, just
-- no data yet to reveal it. All 13 are covered by Sections 1/2 above and
-- this drop list.
--
-- It is also entirely unnecessary: Supabase's service_role already carries
-- BYPASSRLS at the role level, which is what actually lets this app's
-- backend (which connects exclusively via the service-role key) ignore RLS
-- — the same fact this whole migration's safety argument already rests on.
-- This policy never did anything for the backend; it only ever did the one
-- harmful thing of also letting anon in. Dropping it is pure risk reduction.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Service role full access" ON payroll_items;
DROP POLICY IF EXISTS "Service role full access" ON payroll_runs;
DROP POLICY IF EXISTS "Service role full access" ON payroll_short_time;
DROP POLICY IF EXISTS "Service role full access" ON payroll_multi_rate;
DROP POLICY IF EXISTS "Service role full access" ON employee_payroll_items;
DROP POLICY IF EXISTS "Service role full access" ON payroll_overtime;
DROP POLICY IF EXISTS "Service role full access" ON payroll_period_inputs;
DROP POLICY IF EXISTS "Service role full access" ON payroll_snapshots;
DROP POLICY IF EXISTS "Service role full access" ON company_payroll_settings;
DROP POLICY IF EXISTS "Service role full access" ON employee_work_schedules;
DROP POLICY IF EXISTS "Service role full access" ON payroll_kv_store;
DROP POLICY IF EXISTS "Service role full access" ON paytime_employee_access;
DROP POLICY IF EXISTS "Service role full access" ON paytime_user_config;
