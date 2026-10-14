-- ============================================================================
-- Migration 034 — Paytime WN-11: salary history with an effective month
-- ============================================================================
-- Ruan 2026-10-14: a salary change applies from a MONTH (whole month); if that month is
-- already finalized, the difference is paid as a once-off "Back pay" in the first open
-- month (finalized months stay untouched); increases may be scheduled ahead.
-- The calculation uses, for each month, the latest row with effective_period <= that
-- month; before the first row it uses that row's previous_salary; with no rows at all,
-- employees.basic_salary (exactly as today).
-- Additive, idempotent. No existing figures change (no rows are created here).
-- ============================================================================

CREATE TABLE IF NOT EXISTS employee_salary_history (
  id               BIGSERIAL    PRIMARY KEY,
  company_id       INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id      INTEGER      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_period TEXT         NOT NULL CHECK (effective_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  basic_salary     NUMERIC(14,2) NOT NULL CHECK (basic_salary >= 0),
  previous_salary  NUMERIC(14,2),
  reason           TEXT,
  backpay_amount   NUMERIC(14,2),
  backpay_period   TEXT,
  created_by       INTEGER,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_salary_history_emp
  ON employee_salary_history (company_id, employee_id, effective_period);

COMMENT ON TABLE employee_salary_history IS
  'Paytime WN-11: basic salary per effective month (who, when, old/new, reason, back pay). Migration 034.';
