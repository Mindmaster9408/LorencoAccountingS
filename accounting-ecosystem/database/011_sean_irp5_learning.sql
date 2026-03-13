-- ============================================================================
-- Migration 011 — Sean IRP5 Learning Engine
-- ============================================================================
-- Adds IRP5 code support to payroll items and creates the Sean learning
-- infrastructure for controlled IRP5 code standardization across clients.
--
-- SAFETY RULES (enforced in application layer, documented here):
--   1. Sean may ONLY insert irp5_code where it is NULL/empty.
--   2. Sean may NEVER overwrite an existing irp5_code automatically.
--   3. Global propagation requires explicit authorization (see approvals table).
--   4. Every propagation write is recorded in sean_irp5_propagation_log.
--
-- References:
--   CLAUDE.md Part B — Rules B1–B11
--   docs/sean-paytime-learning.md
-- ============================================================================

-- ─── Step 1 — Add irp5_code to payroll_items_master ─────────────────────────
-- Nullable: existing rows simply have no code yet; that is correct.
-- Sean learns what the code should be from client usage over time.

ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS irp5_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS irp5_code_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS irp5_code_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN payroll_items_master.irp5_code IS
  'SARS IRP5 / IT3(a) income code for this payroll item. Nullable — Sean learns this. Never auto-overwritten once set.';

CREATE INDEX IF NOT EXISTS idx_payroll_items_irp5 ON payroll_items_master(irp5_code)
  WHERE irp5_code IS NOT NULL;

-- ─── Step 2 — Sean Learning Events ──────────────────────────────────────────
-- Captured whenever an irp5_code is created or changed on a payroll item.
-- One row per change event — immutable audit trail.

CREATE TABLE IF NOT EXISTS sean_learning_events (
  id                  SERIAL PRIMARY KEY,
  source_app          VARCHAR(50)  NOT NULL DEFAULT 'paytime',
  client_id           INTEGER      REFERENCES eco_clients(id)  ON DELETE SET NULL,
  company_id          INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_item_id     INTEGER      REFERENCES payroll_items_master(id) ON DELETE SET NULL,
  payroll_item_name   TEXT         NOT NULL,
  item_category       VARCHAR(100),
  previous_irp5_code  VARCHAR(10),
  new_irp5_code       VARCHAR(10)  NOT NULL,
  change_type         VARCHAR(20)  NOT NULL
    CHECK (change_type IN ('new_item', 'code_added', 'code_changed')),
  changed_by          INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  tax_year            VARCHAR(9),                          -- e.g. '2025/2026'
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sean_learning_events IS
  'Immutable log of every IRP5 code change. Sean learns from these events.';

CREATE INDEX IF NOT EXISTS idx_sle_source_app    ON sean_learning_events(source_app);
CREATE INDEX IF NOT EXISTS idx_sle_company       ON sean_learning_events(company_id);
CREATE INDEX IF NOT EXISTS idx_sle_item_name     ON sean_learning_events(payroll_item_name);
CREATE INDEX IF NOT EXISTS idx_sle_new_code      ON sean_learning_events(new_irp5_code);
CREATE INDEX IF NOT EXISTS idx_sle_created       ON sean_learning_events(created_at DESC);

-- ─── Step 3 — Sean IRP5 Mapping Patterns ─────────────────────────────────────
-- Aggregated knowledge: Sean consolidates learning events into patterns.
-- One row per (normalized_item_name, suggested_irp5_code) combination.
-- Updated by the pattern-analysis job whenever new events arrive.

CREATE TABLE IF NOT EXISTS sean_irp5_mapping_patterns (
  id                    SERIAL PRIMARY KEY,
  source_app            VARCHAR(50)  NOT NULL DEFAULT 'paytime',
  normalized_item_name  TEXT         NOT NULL,             -- lowercase, trimmed
  item_category         VARCHAR(100),
  suggested_irp5_code   VARCHAR(10)  NOT NULL,
  confidence_score      DECIMAL(5,2) NOT NULL DEFAULT 0,   -- 0.00–100.00
  occurrence_count      INTEGER      NOT NULL DEFAULT 0,
  clients_observed      INTEGER      NOT NULL DEFAULT 0,   -- distinct company count
  clients_json          JSONB        NOT NULL DEFAULT '[]', -- [{ company_id, item_name }]
  status                VARCHAR(20)  NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'proposed', 'approved', 'rejected', 'superseded')),
  last_analyzed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (source_app, normalized_item_name, suggested_irp5_code)
);

COMMENT ON TABLE sean_irp5_mapping_patterns IS
  'Sean-discovered patterns: which IRP5 code is most commonly used per item meaning.';

CREATE INDEX IF NOT EXISTS idx_simp_source      ON sean_irp5_mapping_patterns(source_app);
CREATE INDEX IF NOT EXISTS idx_simp_item        ON sean_irp5_mapping_patterns(normalized_item_name);
CREATE INDEX IF NOT EXISTS idx_simp_code        ON sean_irp5_mapping_patterns(suggested_irp5_code);
CREATE INDEX IF NOT EXISTS idx_simp_status      ON sean_irp5_mapping_patterns(status);
CREATE INDEX IF NOT EXISTS idx_simp_confidence  ON sean_irp5_mapping_patterns(confidence_score DESC);

-- ─── Step 4 — Sean IRP5 Propagation Approvals ────────────────────────────────
-- Tracks the authorization lifecycle for each proposed global mapping.
-- A mapping may only be propagated once an authorized user has approved it.
-- RULE: approval grants permission to fill MISSING codes only — never overwrite.

CREATE TABLE IF NOT EXISTS sean_irp5_propagation_approvals (
  id                    SERIAL PRIMARY KEY,
  mapping_pattern_id    INTEGER      NOT NULL
    REFERENCES sean_irp5_mapping_patterns(id) ON DELETE CASCADE,
  proposed_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  proposed_by_system    BOOLEAN      NOT NULL DEFAULT TRUE,  -- system-generated
  approved_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  rejected_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  rejected_at           TIMESTAMPTZ,
  rejection_reason      TEXT,
  status                VARCHAR(20)  NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'propagated')),
  -- Snapshot of what was proposed (immutable after creation)
  snapshot_normalized_name  TEXT     NOT NULL,
  snapshot_irp5_code        VARCHAR(10) NOT NULL,
  snapshot_confidence       DECIMAL(5,2),
  snapshot_clients_count    INTEGER,
  -- Propagation result (filled after propagation runs)
  propagation_ran_at        TIMESTAMPTZ,
  propagation_applied_count INTEGER,    -- rows updated
  propagation_skipped_count INTEGER,    -- rows with existing code (skipped)
  propagation_exception_count INTEGER,  -- conflicting-code clients
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sean_irp5_propagation_approvals IS
  'Authorization lifecycle for each proposed IRP5 mapping. No propagation without an approved row here.';

CREATE INDEX IF NOT EXISTS idx_sipa_pattern  ON sean_irp5_propagation_approvals(mapping_pattern_id);
CREATE INDEX IF NOT EXISTS idx_sipa_status   ON sean_irp5_propagation_approvals(status);
CREATE INDEX IF NOT EXISTS idx_sipa_approved ON sean_irp5_propagation_approvals(approved_by);

-- ─── Step 5 — Sean IRP5 Propagation Log (Audit Trail) ────────────────────────
-- Immutable record of every actual write Sean made during propagation.
-- One row per payroll_items_master row that was updated.

CREATE TABLE IF NOT EXISTS sean_irp5_propagation_log (
  id                    SERIAL PRIMARY KEY,
  approval_id           INTEGER      NOT NULL
    REFERENCES sean_irp5_propagation_approvals(id) ON DELETE CASCADE,
  company_id            INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_item_id       INTEGER      REFERENCES payroll_items_master(id) ON DELETE SET NULL,
  payroll_item_name     TEXT         NOT NULL,
  irp5_code_written     VARCHAR(10)  NOT NULL,
  previous_irp5_code    VARCHAR(10),          -- must be NULL for this row to exist (safety guard)
  action                VARCHAR(20)  NOT NULL
    CHECK (action IN ('applied', 'skipped_existing', 'skipped_exception', 'error')),
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sean_irp5_propagation_log IS
  'Immutable audit trail of every write (or skip). action=skipped_existing means item already had a code — never overwritten.';

CREATE INDEX IF NOT EXISTS idx_sipl_approval  ON sean_irp5_propagation_log(approval_id);
CREATE INDEX IF NOT EXISTS idx_sipl_company   ON sean_irp5_propagation_log(company_id);
CREATE INDEX IF NOT EXISTS idx_sipl_action    ON sean_irp5_propagation_log(action);
CREATE INDEX IF NOT EXISTS idx_sipl_created   ON sean_irp5_propagation_log(created_at DESC);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Learning events and propagation logs are company-isolated.
-- Patterns and approvals are ecosystem-level (admin only).

ALTER TABLE sean_learning_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_irp5_propagation_log      ENABLE ROW LEVEL SECURITY;

-- Company staff can see their own learning events
DROP POLICY IF EXISTS sle_company_isolation ON sean_learning_events;
CREATE POLICY sle_company_isolation ON sean_learning_events
  FOR SELECT
  USING (
    company_id = (current_setting('request.jwt.claims', true)::json->>'companyId')::integer
  );

-- Company staff can see their own propagation log entries
DROP POLICY IF EXISTS sipl_company_isolation ON sean_irp5_propagation_log;
CREATE POLICY sipl_company_isolation ON sean_irp5_propagation_log
  FOR SELECT
  USING (
    company_id = (current_setting('request.jwt.claims', true)::json->>'companyId')::integer
  );

-- Global patterns and approvals: no row-level policy — controlled by application auth middleware
