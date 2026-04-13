-- ============================================================================
-- Migration 014 — Payroll Runs & Snapshots
-- ============================================================================
-- Run in Supabase SQL Editor.
--
-- Creates two tables:
--   payroll_runs      — one record per "pay run event" (who ran payroll, when)
--   payroll_snapshots — one immutable record per employee per period
--
-- DESIGN RULES:
--   - payroll_snapshots rows are NEVER deleted — corrections create new rows
--   - is_locked = TRUE means the row is immutable (finalized)
--   - Only one finalized run is allowed per company+period (enforced by
--     partial unique index on payroll_runs)
--   - Snapshots use (company_id, employee_id, period_key) as natural key
--     enforced by unique index
-- ============================================================================

-- ─── payroll_runs ────────────────────────────────────────────────────────────
-- Header record for a batch pay run. Groups all snapshots in one event.

CREATE TABLE IF NOT EXISTS payroll_runs (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      INTEGER      NOT NULL,
    period_key      TEXT         NOT NULL,   -- YYYY-MM
    status          TEXT         NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'finalized')),
    employee_count  INTEGER      NOT NULL DEFAULT 0,
    processed_count INTEGER      NOT NULL DEFAULT 0,
    error_count     INTEGER      NOT NULL DEFAULT 0,
    total_gross     NUMERIC(14,2),
    total_net       NUMERIC(14,2),
    total_paye      NUMERIC(14,2),
    total_uif       NUMERIC(14,2),
    total_sdl       NUMERIC(14,2),
    created_by      INTEGER,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finalized_by    INTEGER,
    finalized_at    TIMESTAMPTZ
);

-- One finalized run per company+period (drafts are not restricted)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_finalized_unique
    ON payroll_runs (company_id, period_key)
    WHERE status = 'finalized';

-- Fast lookups by company+period
CREATE INDEX IF NOT EXISTS idx_payroll_runs_company_period
    ON payroll_runs (company_id, period_key);


-- ─── payroll_snapshots ───────────────────────────────────────────────────────
-- Immutable calculation record per employee per period.
-- Once is_locked = TRUE this row must NEVER be mutated.

CREATE TABLE IF NOT EXISTS payroll_snapshots (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id         INTEGER      NOT NULL,
    employee_id        INTEGER      NOT NULL,
    payroll_run_id     UUID         REFERENCES payroll_runs(id) ON DELETE SET NULL,
    period_key         TEXT         NOT NULL,   -- YYYY-MM
    calculation_input  JSONB        NOT NULL,   -- full normalized engine input
    calculation_output JSONB        NOT NULL,   -- full engine output (all 16 fields)
    engine_version     TEXT         NOT NULL,
    schema_version     TEXT         NOT NULL DEFAULT '1.0',
    status             TEXT         NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'finalized')),
    is_locked          BOOLEAN      NOT NULL DEFAULT FALSE,
    created_by         INTEGER,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finalized_by       INTEGER,
    finalized_at       TIMESTAMPTZ
);

-- One snapshot per employee per period per company
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_snapshots_unique
    ON payroll_snapshots (company_id, employee_id, period_key);

-- Fast period-level lookups (used by finalize and history endpoints)
CREATE INDEX IF NOT EXISTS idx_payroll_snapshots_period
    ON payroll_snapshots (company_id, period_key);

-- Fast employee-level history lookups
CREATE INDEX IF NOT EXISTS idx_payroll_snapshots_employee
    ON payroll_snapshots (company_id, employee_id);


-- ─── Row Level Security ──────────────────────────────────────────────────────
-- Service-role key has full access. App layer enforces company_id isolation.

ALTER TABLE payroll_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'payroll_runs' AND policyname = 'Service role full access'
    ) THEN
        CREATE POLICY "Service role full access"
            ON payroll_runs FOR ALL USING (true) WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'payroll_snapshots' AND policyname = 'Service role full access'
    ) THEN
        CREATE POLICY "Service role full access"
            ON payroll_snapshots FOR ALL USING (true) WITH CHECK (true);
    END IF;
END
$$;
