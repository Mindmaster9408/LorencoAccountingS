-- ─── Migration 015: SEAN Transaction Store ──────────────────────────────────
-- Creates the three tables that back the SEAN generic approval/governance engine.
-- These tables are referenced by:
--   backend/sean/transaction-store-routes.js  (/api/sean/store/*)
--   backend/sean/irp5-routes.js               (items sync)
--
-- Safe to run multiple times — all statements use IF NOT EXISTS.
-- Run in Supabase SQL Editor after 014_employee_work_hours.sql.
--
-- Tables:
--   sean_transaction_store — Generic approval queue for any entity type
--   sean_global_library    — Approved global standards (approved items land here)
--   sean_sync_log          — Immutable audit trail of every sync action
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. SEAN Transaction Store ─────────────────────────────────────────────────
-- Generic approval queue. When a new or edited entity (e.g. payroll item with
-- IRP5 code) is created in any app, it is submitted here for superadmin review.
-- Superadmin can then: APPROVE (→ global library + sync) | DISCARD (local only) | EDIT then APPROVE.
--
-- Safety rules (CLAUDE.md Part B, Rules B6/B9):
--   - Global sync ONLY fills fields that are blank/null in each target company
--   - A company with a different existing value is flagged as a conflict — never overwritten
--   - Every action is recorded in sean_sync_log

CREATE TABLE IF NOT EXISTS sean_transaction_store (
  id             SERIAL PRIMARY KEY,
  entity_type    VARCHAR(50)  NOT NULL,           -- 'payroll_item', 'product', 'account', etc.
  source_app     VARCHAR(50)  NOT NULL,           -- 'paytime', 'accounting', 'pos'
  company_id     INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_name      VARCHAR(255) NOT NULL,           -- human-readable display name
  item_key       VARCHAR(255) NOT NULL,           -- normalised key (lowercase, stripped)
  payload        JSONB        NOT NULL DEFAULT '{}', -- full item object snapshot
  proposed_field VARCHAR(100),                   -- field being standardised (e.g. 'irp5_code')
  proposed_value TEXT,                           -- proposed standard value
  previous_value TEXT,                           -- value before this change (for diffs)
  edited_payload JSONB,                          -- payload after superadmin edit (pre-approve)
  change_type    VARCHAR(50)  DEFAULT 'create',  -- 'create' | 'update'
  status         VARCHAR(20)  DEFAULT 'pending', -- 'pending' | 'approved' | 'discarded'
  submitted_by   TEXT,                           -- email/userId who submitted
  submitted_at   TIMESTAMPTZ  DEFAULT NOW(),
  reviewed_by    TEXT,                           -- superadmin who reviewed
  reviewed_at    TIMESTAMPTZ,
  review_notes   TEXT,
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sts_status    ON sean_transaction_store(status);
CREATE INDEX IF NOT EXISTS idx_sts_entity    ON sean_transaction_store(entity_type, source_app);
CREATE INDEX IF NOT EXISTS idx_sts_company   ON sean_transaction_store(company_id);
CREATE INDEX IF NOT EXISTS idx_sts_item_key  ON sean_transaction_store(entity_type, item_key);
CREATE INDEX IF NOT EXISTS idx_sts_submitted ON sean_transaction_store(submitted_at DESC);

COMMENT ON TABLE sean_transaction_store IS
  'SEAN generic approval queue. Items submitted from any app for superadmin governance review.';
COMMENT ON COLUMN sean_transaction_store.item_key IS
  'Normalised version of item_name (lowercase, punctuation stripped). Used for de-duplication.';
COMMENT ON COLUMN sean_transaction_store.proposed_field IS
  'The specific field being proposed for global standardisation (e.g. irp5_code).';


-- ── 2. SEAN Global Library ────────────────────────────────────────────────────
-- Approved standard values. One row per (entity_type, item_key, standard_field).
-- When a transaction store item is approved, the proposed_field/proposed_value
-- is upserted here. From the library, the standard is synced to all matching
-- entities across all companies (filling blank/null fields only).

CREATE TABLE IF NOT EXISTS sean_global_library (
  id              SERIAL PRIMARY KEY,
  entity_type     VARCHAR(50)  NOT NULL,           -- matches sean_transaction_store.entity_type
  item_key        VARCHAR(255) NOT NULL,           -- normalised item name
  item_name       VARCHAR(255) NOT NULL,           -- display name (last approved name)
  standard_field  VARCHAR(100) NOT NULL,           -- field holding the standard value
  standard_value  TEXT         NOT NULL,           -- the approved standard value
  payload         JSONB,                           -- full item payload at time of approval
  approved_by     TEXT,                            -- superadmin who approved
  approved_at     TIMESTAMPTZ,
  source_store_id INTEGER REFERENCES sean_transaction_store(id) ON DELETE SET NULL,
  sync_count      INTEGER      DEFAULT 0,          -- times this standard has been synced out
  last_synced_at  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(entity_type, item_key, standard_field)   -- one standard per (type, item, field)
);

CREATE INDEX IF NOT EXISTS idx_sgl_entity ON sean_global_library(entity_type);
CREATE INDEX IF NOT EXISTS idx_sgl_key    ON sean_global_library(entity_type, item_key);
CREATE INDEX IF NOT EXISTS idx_sgl_field  ON sean_global_library(standard_field);

COMMENT ON TABLE sean_global_library IS
  'SEAN approved global standards. Approved entries here are synced to all companies where the field is blank.';
COMMENT ON COLUMN sean_global_library.standard_value IS
  'The approved standard value for standard_field on items matching item_key. '
  'This is applied to blank/null fields only — never overwrites an existing different value.';


-- ── 3. SEAN Sync Log ─────────────────────────────────────────────────────────
-- Immutable audit trail. Every sync action (applied | skipped | error) is
-- recorded here. Used for accountability, rollback analysis, and reporting.

CREATE TABLE IF NOT EXISTS sean_sync_log (
  id                SERIAL PRIMARY KEY,
  library_id        INTEGER REFERENCES sean_global_library(id) ON DELETE SET NULL,
  target_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  action            VARCHAR(50) NOT NULL,  -- 'applied' | 'skipped_existing' | 'skipped_exception' | 'sync_back_applied' | 'error'
  field_written     VARCHAR(100),          -- which field was changed (or attempted)
  value_written     TEXT,                  -- value that was written (or attempted)
  previous_value    TEXT,                  -- value before the sync (null = was blank)
  authorized_by     TEXT,                  -- superadmin who authorised
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ssl_library ON sean_sync_log(library_id);
CREATE INDEX IF NOT EXISTS idx_ssl_company ON sean_sync_log(target_company_id);
CREATE INDEX IF NOT EXISTS idx_ssl_action  ON sean_sync_log(action);
CREATE INDEX IF NOT EXISTS idx_ssl_created ON sean_sync_log(created_at DESC);

COMMENT ON TABLE sean_sync_log IS
  'Immutable audit trail for every SEAN sync action. '
  'action=applied: value written. action=skipped_existing: already coded, not overwritten. '
  'action=skipped_exception: different code exists, excluded from sync (manual review required).';
