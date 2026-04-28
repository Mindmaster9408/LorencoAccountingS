/**
 * ============================================================================
 * Payroll Module — Auto Schema Migration
 * ============================================================================
 * Runs on server startup to ensure all payroll tables exist in Supabase.
 * Uses CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 * so it is safe to run on every startup.
 *
 * Call: await ensurePayrollSchema(pool)
 * where pool is a pg.Pool connected to Supabase direct PostgreSQL.
 * ============================================================================
 */

async function ensurePayrollSchema(pool) {
  const client = await pool.connect();
  try {
    console.log('  🔧 Payroll: Checking/creating schema...');

    // ── payroll_kv_store_eco ──────────────────────────────────────────────────
    // Cloud-backed localStorage bridge. Stores per-company key/value payroll
    // page state (attendance, configs, employee lists) in Supabase so data
    // survives browser clears and works across devices.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_kv_store_eco (
        company_id TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (company_id, key)
      )
    `);

    // ── payroll_kv_store_eco: enable RLS ─────────────────────────────────────
    // Service-role key (used by backend) bypasses RLS automatically.
    await client.query(`
      ALTER TABLE payroll_kv_store_eco ENABLE ROW LEVEL SECURITY
    `);

    // ── employees: classification + director/contractor flags ────────────────
    // Payroll confidentiality classification for each employee.
    // 'public'       — visible to all Paytime users with PAYROLL.VIEW (default)
    // 'confidential' — visible only to users with can_view_confidential = true
    // 'executive'    — same as confidential; semantically marks directors/top management
    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS classification VARCHAR(20)
        NOT NULL DEFAULT 'public'
        CHECK (classification IN ('public', 'confidential', 'executive'))
    `);

    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS is_director   BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_contractor BOOLEAN NOT NULL DEFAULT false
    `);

    // ── employees: payroll-detail fields (required by employee-detail UI + PayrollDataService) ─
    // These fields are entered in the Edit Employee modal and must survive page reload.
    // basic_salary     — primary payroll salary (PayrollDataService reads employee.basic_salary)
    // medical_aid_members — number of medical-aid dependants (drives SARS medical credit calc)
    // tax_directive    — fixed tax directive rate % from SARS letter (overrides PAYE calc)
    // payment_method   — 'EFT' or 'Cash' (controls bank section visibility on payslip)
    // job_title        — display job title (separate from the HR-classification 'position' field)
    // bank_name / account_holder / account_number / branch_code — banking details for EFT payroll
    await client.query(`
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS basic_salary       DECIMAL(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS medical_aid_members INTEGER       DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tax_directive      DECIMAL(10,4) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS payment_method     VARCHAR(50)   DEFAULT 'EFT',
        ADD COLUMN IF NOT EXISTS job_title          VARCHAR(100),
        ADD COLUMN IF NOT EXISTS bank_name          VARCHAR(100),
        ADD COLUMN IF NOT EXISTS account_holder     VARCHAR(255),
        ADD COLUMN IF NOT EXISTS account_number     VARCHAR(50),
        ADD COLUMN IF NOT EXISTS branch_code        VARCHAR(50)
    `);

    // ── employee_work_schedule ────────────────────────────────────────────────
    // Per-employee work schedule: hourly flag, hours/day, Mon-Sun day types.
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_work_schedule (
        id              BIGSERIAL PRIMARY KEY,
        employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        company_id      INTEGER NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
        is_hourly_paid  BOOLEAN      NOT NULL DEFAULT false,
        hours_per_day   DECIMAL(5,2) NOT NULL DEFAULT 8.0,
        schedule_type   VARCHAR(20)  NOT NULL DEFAULT 'fixed'
                          CHECK (schedule_type IN ('fixed', 'flexible', 'roster')),
        working_days    JSONB NOT NULL DEFAULT '[
          {"day":"mon","enabled":true, "type":"normal","partial_hours":null},
          {"day":"tue","enabled":true, "type":"normal","partial_hours":null},
          {"day":"wed","enabled":true, "type":"normal","partial_hours":null},
          {"day":"thu","enabled":true, "type":"normal","partial_hours":null},
          {"day":"fri","enabled":true, "type":"normal","partial_hours":null},
          {"day":"sat","enabled":false,"type":"normal","partial_hours":null},
          {"day":"sun","enabled":false,"type":"normal","partial_hours":null}
        ]',
        full_days_per_week DECIMAL(5,3),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (employee_id, company_id)
      )
    `);

    // ── employee_eti ──────────────────────────────────────────────────────────
    // Employment Tax Incentive per employee: status, minimum wage, SEZ flags,
    // effective date, and full JSONB audit history of status changes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_eti (
        id              BIGSERIAL PRIMARY KEY,
        employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        company_id      INTEGER NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
        status          VARCHAR(30) NOT NULL DEFAULT 'qualified_not_claiming'
                          CHECK (status IN (
                            'qualified_not_claiming',
                            'qualified_claiming',
                            'disqualified'
                          )),
        min_wage_input_type VARCHAR(20) NOT NULL DEFAULT 'company_setup'
                          CHECK (min_wage_input_type IN (
                            'company_setup',
                            'monthly_amount',
                            'hourly_rate'
                          )),
        min_wage_amount             DECIMAL(12,2),
        original_employment_date    DATE,
        disqualified_months_before  INTEGER NOT NULL DEFAULT 0,
        sez_post_march_2019         BOOLEAN NOT NULL DEFAULT false,
        sez_pre_march_2019          BOOLEAN NOT NULL DEFAULT false,
        effective_date              DATE NOT NULL DEFAULT CURRENT_DATE,
        history                     JSONB NOT NULL DEFAULT '[]',
        updated_at                  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (employee_id, company_id)
      )
    `);

    // ── paytime_user_config ───────────────────────────────────────────────────
    // Fine-grained Paytime access config for payroll_admin users.
    // No row = unrestricted access (backward-compatible with all existing users).
    // modules        — which Paytime modules the user can access
    // employee_scope — 'all' or 'selected' (explicit list via paytime_employee_access)
    // can_view_confidential — whether restricted user can see confidential/executive employees
    await client.query(`
      CREATE TABLE IF NOT EXISTS paytime_user_config (
        id                   SERIAL PRIMARY KEY,
        user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        modules              TEXT[]  NOT NULL DEFAULT ARRAY['leave', 'payroll'],
        employee_scope       VARCHAR(20) NOT NULL DEFAULT 'all'
                               CHECK (employee_scope IN ('all', 'selected')),
        can_view_confidential BOOLEAN NOT NULL DEFAULT false,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, company_id)
      )
    `);

    // ── paytime_employee_access ───────────────────────────────────────────────
    // Explicit employee visibility list for users with employee_scope = 'selected'.
    // Mirrors the user_client_access pattern but for employees instead of eco_clients.
    await client.query(`
      CREATE TABLE IF NOT EXISTS paytime_employee_access (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, company_id, employee_id)
      )
    `);

    // ── companies: extended columns (migrations 018 + payslip + logo + export) ─
    // All ADD COLUMN IF NOT EXISTS — idempotent, safe to run on every startup.
    await client.query(`
      ALTER TABLE companies
        ADD COLUMN IF NOT EXISTS sdl_registered        BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS uif_registered        BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS logo_data             TEXT,
        ADD COLUMN IF NOT EXISTS payslip_display_name  VARCHAR(255),
        ADD COLUMN IF NOT EXISTS payslip_address_line1 VARCHAR(255),
        ADD COLUMN IF NOT EXISTS sage_salaries_account    VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sage_paye_account        VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sage_uif_account         VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sage_uif_expense_account VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sage_sdl_account         VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sage_sdl_expense_account VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sage_bank_account        VARCHAR(100),
        ADD COLUMN IF NOT EXISTS xero_wages_account       VARCHAR(100),
        ADD COLUMN IF NOT EXISTS xero_paye_account        VARCHAR(100),
        ADD COLUMN IF NOT EXISTS xero_uif_account         VARCHAR(100),
        ADD COLUMN IF NOT EXISTS xero_uif_expense_account VARCHAR(100),
        ADD COLUMN IF NOT EXISTS xero_bank_account        VARCHAR(100),
        ADD COLUMN IF NOT EXISTS absa_user_code      VARCHAR(50),
        ADD COLUMN IF NOT EXISTS fnb_originator_code VARCHAR(50)
    `);

    console.log('  ✅ Payroll schema ready.');
  } catch (err) {
    console.error('  ❌ Payroll schema migration failed:', err.message);
    // Non-fatal — server continues. Run migration 007 manually if needed.
  } finally {
    client.release();
  }
}

module.exports = { ensurePayrollSchema };
