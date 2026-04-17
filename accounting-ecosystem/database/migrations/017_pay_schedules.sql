-- ============================================================================
-- Migration 017 — Company Pay Schedules + Employee Assignment
-- ============================================================================
-- Run in Supabase SQL Editor.
-- All statements are idempotent.
--
-- Creates:
--   company_pay_schedules   - per-company named pay schedule definitions
--   employees.pay_schedule_id - FK linking each employee to a schedule
--
-- Backward-compat migration:
--   For companies that already have pay_day set and no schedules yet,
--   a default "Monthly – Day N" schedule is automatically created.
--
-- Tax impact: NONE. This table is for operational grouping only.
--   PAYE/UIF calculations remain employee-level and company-level as before.
-- ============================================================================

-- ── 1. company_pay_schedules ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_pay_schedules (
  id                    SERIAL       PRIMARY KEY,
  company_id            INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  schedule_name         VARCHAR(100) NOT NULL,
  -- frequency_type: monthly | weekly | bi_weekly
  frequency_type        VARCHAR(20)  NOT NULL
                          CHECK (frequency_type IN ('monthly', 'weekly', 'bi_weekly')),
  -- monthly: day 1-31. ignored when is_last_day_of_month = true
  monthly_day           SMALLINT     CHECK (monthly_day BETWEEN 1 AND 31),
  -- true → pay on the last calendar day of the month
  is_last_day_of_month  BOOLEAN      NOT NULL DEFAULT false,
  -- weekly / bi_weekly: 0=SUN 1=MON 2=TUE 3=WED 4=THU 5=FRI 6=SAT
  weekly_day            SMALLINT     CHECK (weekly_day BETWEEN 0 AND 6),
  is_active             BOOLEAN      NOT NULL DEFAULT true,
  display_order         SMALLINT     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, schedule_name)
);

CREATE INDEX IF NOT EXISTS idx_company_pay_schedules_company
  ON company_pay_schedules (company_id)
  WHERE is_active = true;

-- RLS: service role only — queries scoped by company_id in app layer
ALTER TABLE company_pay_schedules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'company_pay_schedules'
      AND policyname = 'service_role_all_company_pay_schedules'
  ) THEN
    CREATE POLICY "service_role_all_company_pay_schedules"
      ON company_pay_schedules
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;


-- ── 2. employees.pay_schedule_id ─────────────────────────────────────────────

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS pay_schedule_id INTEGER
    REFERENCES company_pay_schedules(id) ON DELETE SET NULL;


-- ── 3. Backward-compatible migration ─────────────────────────────────────────
-- For each company that has an existing pay_day value but no schedules yet,
-- create a default "Monthly – Day N" schedule.
-- Skips companies that already have schedules (idempotent).
-- Does NOT assign employees — they remain unassigned until configured manually.

INSERT INTO company_pay_schedules (
  company_id, schedule_name, frequency_type,
  monthly_day, is_last_day_of_month, display_order
)
SELECT
  c.id,
  CASE
    WHEN c.pay_day IS NOT NULL AND c.pay_day ~ '^[0-9]+$' AND c.pay_day::INTEGER BETWEEN 1 AND 31
      THEN 'Monthly – Day ' || c.pay_day
    ELSE 'Monthly – End of Month'
  END,
  'monthly',
  CASE
    WHEN c.pay_day IS NOT NULL AND c.pay_day ~ '^[0-9]+$' AND c.pay_day::INTEGER BETWEEN 1 AND 31
      THEN c.pay_day::SMALLINT
    ELSE NULL
  END,
  CASE
    WHEN c.pay_day IS NULL OR NOT (c.pay_day ~ '^[0-9]+$') THEN true
    ELSE false
  END,
  0
FROM companies c
WHERE (c.pay_day IS NOT NULL OR c.pay_frequencies IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM company_pay_schedules ps WHERE ps.company_id = c.id
  );
