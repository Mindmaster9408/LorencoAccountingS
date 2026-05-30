-- ============================================================================
-- Migration 057: Pilot Smoke Test Pack
-- Created: 2026-05
-- Purpose: Store structured QA test run sessions and per-test results for
--          guided runtime smoke testing of the Lorenco Accounting module.
--
-- Design notes:
--   - Test templates are hardcoded in the API (no DB table needed).
--   - Runs are company-scoped. No cross-company visibility.
--   - Results use test_key as the stable identifier for each test item.
--   - All result status values are constrained via CHECK.
-- ============================================================================

-- ─── pilot_smoke_test_runs ───────────────────────────────────────────────────
-- One row per QA test session. Company-scoped.
CREATE TABLE IF NOT EXISTS pilot_smoke_test_runs (
  id              BIGSERIAL    PRIMARY KEY,
  company_id      BIGINT       NOT NULL,
  tester_name     TEXT         NOT NULL,
  build_version   TEXT,
  notes           TEXT,
  -- Denormalised summary counters — updated by triggers or app layer on each result save.
  -- Avoids full-table scans for the run summary header display.
  total_count     INT          NOT NULL DEFAULT 0,
  passed_count    INT          NOT NULL DEFAULT 0,
  failed_count    INT          NOT NULL DEFAULT 0,
  blocked_count   INT          NOT NULL DEFAULT 0,
  not_tested_count INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pstr_company_id ON pilot_smoke_test_runs (company_id);
CREATE INDEX IF NOT EXISTS idx_pstr_created_at ON pilot_smoke_test_runs (company_id, created_at DESC);

-- ─── pilot_smoke_test_results ────────────────────────────────────────────────
-- One row per test item per run. The (run_id, test_key) pair is unique.
CREATE TABLE IF NOT EXISTS pilot_smoke_test_results (
  id              BIGSERIAL    PRIMARY KEY,
  run_id          BIGINT       NOT NULL REFERENCES pilot_smoke_test_runs (id) ON DELETE CASCADE,
  company_id      BIGINT       NOT NULL,
  category        TEXT         NOT NULL,  -- e.g. 'bank', 'vat', 'ar_ap', 'reports', 'historical', 'security'
  test_key        TEXT         NOT NULL,  -- stable machine key, e.g. 'bank_import_statement'
  test_name       TEXT         NOT NULL,  -- display name
  severity        TEXT         NOT NULL DEFAULT 'normal'
                               CHECK (severity IN ('critical', 'high', 'normal', 'low')),
  status          TEXT         NOT NULL DEFAULT 'not_tested'
                               CHECK (status IN ('pass', 'fail', 'blocked', 'not_tested')),
  notes           TEXT,
  screenshot_ref  TEXT,
  error_text      TEXT,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_pilot_result_run_key UNIQUE (run_id, test_key)
);

CREATE INDEX IF NOT EXISTS idx_pstres_run_id    ON pilot_smoke_test_results (run_id);
CREATE INDEX IF NOT EXISTS idx_pstres_company_id ON pilot_smoke_test_results (company_id);
