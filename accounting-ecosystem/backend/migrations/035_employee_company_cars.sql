-- ============================================================================
-- Migration 035 — Paytime IT-07: company car fringe benefit (Seventh Schedule para 7)
-- ============================================================================
-- Ruan 2026-10-14: a calculator per employee. Stored: the car's determined value, whether
-- a maintenance plan is included, whether business use is at least 80% (employer
-- satisfied), and the months it is available. Paytime calculates each month:
--   value  = determined value × 3.5%  (2.5% with a maintenance plan)
--   PAYE on 80% of the value (20% when business use ≥ 80%) — IRP5 code 3802
-- Additive, idempotent. No existing figures change (no rows are created here).
-- ============================================================================

CREATE TABLE IF NOT EXISTS employee_company_cars (
  id                BIGSERIAL     PRIMARY KEY,
  company_id        INTEGER       NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id       INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  description       TEXT,
  determined_value  NUMERIC(14,2) NOT NULL CHECK (determined_value > 0),
  maintenance_plan  BOOLEAN       NOT NULL DEFAULT FALSE,
  business_use_80   BOOLEAN       NOT NULL DEFAULT FALSE,
  start_period      TEXT          NOT NULL CHECK (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  end_period        TEXT          CHECK (end_period IS NULL OR end_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_by        INTEGER,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CHECK (end_period IS NULL OR end_period >= start_period)
);

CREATE INDEX IF NOT EXISTS idx_employee_company_cars_emp ON employee_company_cars (company_id, employee_id);

COMMENT ON TABLE employee_company_cars IS
  'Paytime IT-07: company car fringe benefit per employee (determined value, maintenance plan, ≥80% business use, months). Migration 035.';
