-- ============================================================================
-- Migration 030 — Paytime Fase 10: "not yet registered with SARS"
-- ============================================================================
-- Spec: docs/paytime/spec/03 WN-02 (owner-confirmed option b).
-- A SARS tax number is required for every employee, unless this flag is set.
-- A flagged (or numberless) employee gets a warning on every pay run and is
-- marked blocked for IRP5/EMP501 until the number is filled in.
--
-- Additive, idempotent. Existing employees default to FALSE (unchanged).
-- ============================================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS tax_number_pending BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN employees.tax_number_pending IS
  'Paytime WN-02: employee not yet registered with SARS — allowed without tax number; warned on every run; IRP5/EMP501 blocked until filled in. Migration 030.';
