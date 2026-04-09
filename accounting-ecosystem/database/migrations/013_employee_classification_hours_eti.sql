-- ============================================================================
-- Migration 013: Employee Classification, Work Schedule, and ETI
-- ============================================================================
-- Adds fields required to match SimplePay's Edit Info sections:
--   - Classification (Director, Contractor, UIF Exempt, work hours type)
--   - Regular Hours (schedule, per-day types, partial hours)
--   - ETI (Employment Tax Incentive status, minimum wage, SEZ flags, history)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Classification columns on employees table
-- ---------------------------------------------------------------------------
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_director      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_contractor    BOOLEAN NOT NULL DEFAULT false;

-- employment_type already exists (full_time / part_time).
-- uif_exempt already exists on employee_payroll_setup.

-- ---------------------------------------------------------------------------
-- 2. Work schedule table
--    One row per employee. Stores hourly-paid flag, hours/day, and a JSONB
--    array of working-day configurations (Mon–Sun).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_work_schedule (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id      BIGINT NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,

  is_hourly_paid  BOOLEAN      NOT NULL DEFAULT false,
  hours_per_day   DECIMAL(5,2) NOT NULL DEFAULT 8.0,
  schedule_type   VARCHAR(20)  NOT NULL DEFAULT 'fixed'
                    CHECK (schedule_type IN ('fixed', 'flexible', 'roster')),

  -- Array of {day, enabled, type, partial_hours}
  -- day: mon|tue|wed|thu|fri|sat|sun
  -- type: normal|partial
  -- partial_hours: decimal, only used when type = 'partial'
  working_days    JSONB NOT NULL DEFAULT '[
    {"day":"mon","enabled":true, "type":"normal","partial_hours":null},
    {"day":"tue","enabled":true, "type":"normal","partial_hours":null},
    {"day":"wed","enabled":true, "type":"normal","partial_hours":null},
    {"day":"thu","enabled":true, "type":"normal","partial_hours":null},
    {"day":"fri","enabled":true, "type":"normal","partial_hours":null},
    {"day":"sat","enabled":false,"type":"normal","partial_hours":null},
    {"day":"sun","enabled":false,"type":"normal","partial_hours":null}
  ]',

  -- Stored for display; recalculated on every save.
  -- Normal day = 1.0 full day; partial day = partial_hours / hours_per_day.
  full_days_per_week DECIMAL(5,3),

  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (employee_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_emp_work_schedule_employee ON employee_work_schedule(employee_id);
CREATE INDEX IF NOT EXISTS idx_emp_work_schedule_company  ON employee_work_schedule(company_id);

-- ---------------------------------------------------------------------------
-- 3. ETI (Employment Tax Incentive) table
--    One row per employee. History of status changes stored as JSONB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_eti (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id      BIGINT NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,

  status          VARCHAR(30) NOT NULL DEFAULT 'qualified_not_claiming'
                    CHECK (status IN (
                      'qualified_not_claiming',
                      'qualified_claiming',
                      'disqualified'
                    )),

  -- How minimum wage is determined for ETI calculations
  min_wage_input_type VARCHAR(20) NOT NULL DEFAULT 'company_setup'
                    CHECK (min_wage_input_type IN (
                      'company_setup',
                      'monthly_amount',
                      'hourly_rate'
                    )),
  min_wage_amount DECIMAL(12,2),   -- populated when type != 'company_setup'

  original_employment_date DATE,   -- date employee first joined for ETI purposes
  disqualified_months_before INTEGER NOT NULL DEFAULT 0,

  -- Special Economic Zone flags
  sez_post_march_2019 BOOLEAN NOT NULL DEFAULT false,  -- from March 2019
  sez_pre_march_2019  BOOLEAN NOT NULL DEFAULT false,  -- prior to March 2019

  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Audit trail: [{effective_date, changes: {field: {from, to}}, recorded_at}]
  history         JSONB NOT NULL DEFAULT '[]',

  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (employee_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_emp_eti_employee ON employee_eti(employee_id);
CREATE INDEX IF NOT EXISTS idx_emp_eti_company  ON employee_eti(company_id);
