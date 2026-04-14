-- ============================================================================
-- Migration 015 — Payroll Supabase Migration
-- ============================================================================
-- Run in Supabase SQL Editor.
--
-- Creates all payroll-specific tables expected by PayrollDataService.
-- All statements are idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Does not alter or drop any existing tables.
--
-- Tables created:
--   employee_work_schedules     per-row-per-day work schedule
--   company_payroll_settings    tax year, rates, and rebates per company
--   payroll_items               earning/deduction master (service-expected column names)
--   employee_payroll_items      recurring items assigned per employee
--   payroll_period_inputs       one-off period line items per employee
--   payroll_overtime            overtime hours per employee per period
--   payroll_short_time          short-time hours per employee per period
--   payroll_multi_rate          multi-rate hours per employee per period
--   payroll_runs                batch payrun event header
--   payroll_snapshots           immutable per-employee per-period calculation record
--   paytime_user_config         fine-grained Paytime access config per user
--   paytime_employee_access     explicit employee visibility list per user
--
-- Note on name variants:
--   payroll_items coexists with payroll_items_master (different column names)
--   employee_payroll_items coexists with employee_recurring_inputs
--   payroll_period_inputs coexists with period_inputs
--   employee_work_schedules (plural, per-row) coexists with employee_work_schedule (singular, JSONB)
-- ============================================================================


-- ============================================================================
-- employees — payroll columns
-- ============================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS classification VARCHAR(20)
    NOT NULL DEFAULT 'public'
    CHECK (classification IN ('public', 'confidential', 'executive'));

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_director   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_contractor BOOLEAN NOT NULL DEFAULT false;


-- ============================================================================
-- companies — Paytime detail fields
-- ============================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS company_name           VARCHAR(255),
  ADD COLUMN IF NOT EXISTS trading_name           VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_number    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS nature_of_business     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS financial_year_end     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS paye_reference_number  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS uif_reference_number   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sdl_reference_number   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS coid_reference_number  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS income_tax_number      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS contact_email          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone          VARCHAR(50),
  ADD COLUMN IF NOT EXISTS website                VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_person         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_street         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_suburb         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_city           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_province       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_postal_code    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_name              VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bank_account_holder    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bank_account_number    VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_branch_code       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_account_type      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS pay_frequencies        TEXT[],
  ADD COLUMN IF NOT EXISTS pay_day                VARCHAR(20),
  ADD COLUMN IF NOT EXISTS normal_work_hours      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS logo_url               VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payslip_display_name   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payslip_address_line1  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_date      DATE,
  ADD COLUMN IF NOT EXISTS directors              JSONB DEFAULT '[]'::JSONB;


-- ============================================================================
-- employee_work_schedules
-- ============================================================================
-- Per-row-per-day. One row per (employee, company, day_of_week).
-- day_of_week: 0=SUN, 1=MON, 2=TUE, 3=WED, 4=THU, 5=FRI, 6=SAT
-- schedule_type: 'normal' = full day, 'partial' = hours_per_day is actual hours worked

CREATE TABLE IF NOT EXISTS employee_work_schedules (
  id            BIGSERIAL    PRIMARY KEY,
  employee_id   INTEGER      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id    INTEGER      NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  day_of_week   SMALLINT     NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_enabled    BOOLEAN      NOT NULL DEFAULT true,
  schedule_type VARCHAR(20)  NOT NULL DEFAULT 'normal'
                  CHECK (schedule_type IN ('normal', 'partial')),
  hours_per_day DECIMAL(5,2) NOT NULL DEFAULT 8.0,
  notes         TEXT,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, company_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_emp_work_schedules_employee
  ON employee_work_schedules (employee_id, company_id);


-- ============================================================================
-- company_payroll_settings
-- ============================================================================
-- One row per company. Defaults are SA 2026/2027 statutory values.

CREATE TABLE IF NOT EXISTS company_payroll_settings (
  id                        SERIAL        PRIMARY KEY,
  company_id                INTEGER       NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_year                  VARCHAR(20)   NOT NULL DEFAULT '2026/2027',
  uif_rate                  DECIMAL(8,6)  NOT NULL DEFAULT 0.01,
  sdl_rate                  DECIMAL(8,6)  NOT NULL DEFAULT 0.01,
  hourly_divisor            DECIMAL(8,4)  NOT NULL DEFAULT 173.33,
  medical_credit_main       DECIMAL(10,2) NOT NULL DEFAULT 364.00,
  medical_credit_first_dep  DECIMAL(10,2) NOT NULL DEFAULT 364.00,
  medical_credit_additional DECIMAL(10,2) NOT NULL DEFAULT 246.00,
  primary_rebate            DECIMAL(12,2) NOT NULL DEFAULT 17235.00,
  secondary_rebate          DECIMAL(12,2) NOT NULL DEFAULT 9444.00,
  tertiary_rebate           DECIMAL(12,2) NOT NULL DEFAULT 3145.00,
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id)
);


-- ============================================================================
-- payroll_items
-- ============================================================================
-- Earning/deduction master. Column names match PayrollDataService expectations:
-- code, name, item_category (not item_code, item_name, category).

CREATE TABLE IF NOT EXISTS payroll_items (
  id            SERIAL       PRIMARY KEY,
  company_id    INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code          VARCHAR(50)  NOT NULL,
  name          VARCHAR(255) NOT NULL,
  item_type     VARCHAR(20)  NOT NULL
                  CHECK (item_type IN ('earning', 'deduction', 'company_contribution')),
  item_category VARCHAR(50),
  is_taxable    BOOLEAN      NOT NULL DEFAULT true,
  is_recurring  BOOLEAN      NOT NULL DEFAULT false,
  irp5_code     VARCHAR(20),
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_payroll_items_company
  ON payroll_items (company_id);


-- ============================================================================
-- employee_payroll_items
-- ============================================================================
-- Recurring payroll items assigned per employee.

CREATE TABLE IF NOT EXISTS employee_payroll_items (
  id              SERIAL        PRIMARY KEY,
  employee_id     INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id      INTEGER       NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  payroll_item_id INTEGER       REFERENCES payroll_items(id) ON DELETE SET NULL,
  amount          DECIMAL(12,2),
  percentage      DECIMAL(8,4),
  item_type       VARCHAR(20)   NOT NULL
                    CHECK (item_type IN ('earning', 'deduction', 'company_contribution')),
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emp_payroll_items_employee
  ON employee_payroll_items (employee_id, company_id)
  WHERE is_active = true;


-- ============================================================================
-- payroll_period_inputs
-- ============================================================================
-- One-off earnings/deductions for a specific pay period per employee.

CREATE TABLE IF NOT EXISTS payroll_period_inputs (
  id                SERIAL        PRIMARY KEY,
  company_id        INTEGER       NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  employee_id       INTEGER       NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
  payroll_period_id INTEGER       NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  payroll_item_id   INTEGER       REFERENCES payroll_items(id) ON DELETE SET NULL,
  description       VARCHAR(255),
  amount            DECIMAL(12,2) NOT NULL DEFAULT 0,
  item_type         VARCHAR(20)   NOT NULL
                      CHECK (item_type IN ('earning', 'deduction', 'input')),
  is_deleted        BOOLEAN       NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_period_inputs_lookup
  ON payroll_period_inputs (company_id, employee_id, payroll_period_id)
  WHERE is_deleted = false;


-- ============================================================================
-- payroll_overtime
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_overtime (
  id                SERIAL       PRIMARY KEY,
  company_id        INTEGER      NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  employee_id       INTEGER      NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
  payroll_period_id INTEGER      NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  hours             DECIMAL(8,3) NOT NULL DEFAULT 0,
  rate_multiplier   DECIMAL(5,2) NOT NULL DEFAULT 1.5,
  description       VARCHAR(255),
  is_deleted        BOOLEAN      NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_overtime_lookup
  ON payroll_overtime (company_id, employee_id, payroll_period_id)
  WHERE is_deleted = false;


-- ============================================================================
-- payroll_short_time
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_short_time (
  id                SERIAL       PRIMARY KEY,
  company_id        INTEGER      NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  employee_id       INTEGER      NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
  payroll_period_id INTEGER      NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  hours_missed      DECIMAL(8,3) NOT NULL DEFAULT 0,
  description       VARCHAR(255),
  is_deleted        BOOLEAN      NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_short_time_lookup
  ON payroll_short_time (company_id, employee_id, payroll_period_id)
  WHERE is_deleted = false;


-- ============================================================================
-- payroll_multi_rate
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_multi_rate (
  id                SERIAL       PRIMARY KEY,
  company_id        INTEGER      NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  employee_id       INTEGER      NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
  payroll_period_id INTEGER      NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  hours             DECIMAL(8,3) NOT NULL DEFAULT 0,
  rate_multiplier   DECIMAL(5,2) NOT NULL DEFAULT 2.0,
  description       VARCHAR(255),
  is_deleted        BOOLEAN      NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_multi_rate_lookup
  ON payroll_multi_rate (company_id, employee_id, payroll_period_id)
  WHERE is_deleted = false;


-- ============================================================================
-- payroll_runs
-- ============================================================================
-- Batch payrun event header. One record per pay run event.

CREATE TABLE IF NOT EXISTS payroll_runs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      INTEGER      NOT NULL,
  period_key      TEXT         NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_finalized_unique
  ON payroll_runs (company_id, period_key)
  WHERE status = 'finalized';

CREATE INDEX IF NOT EXISTS idx_payroll_runs_company_period
  ON payroll_runs (company_id, period_key);


-- ============================================================================
-- payroll_snapshots
-- ============================================================================
-- Immutable per-employee per-period calculation record.
-- is_locked = TRUE means the row must never be mutated. Corrections create new rows.

CREATE TABLE IF NOT EXISTS payroll_snapshots (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         INTEGER      NOT NULL,
  employee_id        INTEGER      NOT NULL,
  payroll_run_id     UUID         REFERENCES payroll_runs(id) ON DELETE SET NULL,
  period_key         TEXT         NOT NULL,
  calculation_input  JSONB        NOT NULL,
  calculation_output JSONB        NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_snapshots_unique
  ON payroll_snapshots (company_id, employee_id, period_key);

CREATE INDEX IF NOT EXISTS idx_payroll_snapshots_period
  ON payroll_snapshots (company_id, period_key);

CREATE INDEX IF NOT EXISTS idx_payroll_snapshots_employee
  ON payroll_snapshots (company_id, employee_id);


-- ============================================================================
-- paytime_user_config
-- ============================================================================
-- Fine-grained Paytime access config for payroll_admin users.
-- No row = unrestricted access (backward-compatible with all existing users).

CREATE TABLE IF NOT EXISTS paytime_user_config (
  id                    SERIAL      PRIMARY KEY,
  user_id               INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id            INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  modules               TEXT[]      NOT NULL DEFAULT ARRAY['leave', 'payroll'],
  employee_scope        VARCHAR(20) NOT NULL DEFAULT 'all'
                          CHECK (employee_scope IN ('all', 'selected')),
  can_view_confidential BOOLEAN     NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, company_id)
);


-- ============================================================================
-- paytime_employee_access
-- ============================================================================
-- Explicit employee visibility list for users with employee_scope = 'selected'.

CREATE TABLE IF NOT EXISTS paytime_employee_access (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER     NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  granted_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, company_id, employee_id)
);


-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE employee_work_schedules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_payroll_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_payroll_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_period_inputs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_overtime           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_short_time         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_multi_rate         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE paytime_user_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE paytime_employee_access    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee_work_schedules',
    'company_payroll_settings',
    'payroll_items',
    'employee_payroll_items',
    'payroll_period_inputs',
    'payroll_overtime',
    'payroll_short_time',
    'payroll_multi_rate',
    'payroll_runs',
    'payroll_snapshots',
    'paytime_user_config',
    'paytime_employee_access'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = t AND policyname = 'Service role full access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY "Service role full access" ON %I FOR ALL USING (true) WITH CHECK (true)',
        t
      );
    END IF;
  END LOOP;
END
$$;
