-- ============================================================================
-- Migration 016 — employee_work_schedule (singular, JSONB-based)
-- ============================================================================
-- Run in Supabase SQL Editor.
--
-- Creates employee_work_schedule: one row per employee per company.
-- Stores the full working-week configuration as a JSONB array (working_days)
-- plus scalar fields (is_hourly_paid, hours_per_day, schedule_type, full_days_per_week).
--
-- Distinct from employee_work_schedules (plural) which is per-row-per-day.
-- This table is used by GET/PUT /api/payroll/employees/:id/work-schedule.
-- ============================================================================

CREATE TABLE IF NOT EXISTS employee_work_schedule (
  id                  BIGSERIAL    PRIMARY KEY,
  employee_id         INTEGER      NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
  company_id          INTEGER      NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  is_hourly_paid      BOOLEAN      NOT NULL DEFAULT false,
  hours_per_day       DECIMAL(6,3) NOT NULL DEFAULT 8.0,
  schedule_type       VARCHAR(20)  NOT NULL DEFAULT 'fixed'
                        CHECK (schedule_type IN ('fixed', 'custom', 'flexi')),
  working_days        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  full_days_per_week  DECIMAL(6,3) NOT NULL DEFAULT 5.0,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_work_schedule_emp
  ON employee_work_schedule (employee_id, company_id);

-- RLS: service role bypasses; authenticated users scoped to their company via backend
ALTER TABLE employee_work_schedule ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'employee_work_schedule'
      AND policyname = 'service_role_all_employee_work_schedule'
  ) THEN
    CREATE POLICY "service_role_all_employee_work_schedule"
      ON employee_work_schedule
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;
