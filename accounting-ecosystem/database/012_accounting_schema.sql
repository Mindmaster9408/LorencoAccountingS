-- ============================================================================
-- 012_accounting_schema.sql
-- One-time migration: creates all accounting module tables in Supabase.
-- Safe to run multiple times — all statements use IF NOT EXISTS.
-- Run this in the Supabase SQL Editor if accounting tables are missing.
-- ============================================================================

-- ── 1. SA-specific columns on companies ──────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS income_tax_number VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS paye_reference    VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS uif_reference     VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sdl_reference     VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS coid_number       VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS financial_year_end VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vat_period        VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_type      VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS physical_address  TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city              VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS postal_code       VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS postal_address    TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone             VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email             VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website           VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_name         VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS branch_code       VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_number    VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_type      VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_holder    VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url          TEXT;

-- ── 2. Accounting Periods ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounting_periods (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_date         DATE NOT NULL,
  to_date           DATE NOT NULL,
  is_locked         BOOLEAN DEFAULT false,
  locked_by_user_id INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. Chart of Accounts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        VARCHAR(20) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  type        VARCHAR(50) NOT NULL,
  parent_id   INTEGER REFERENCES accounts(id),
  description TEXT,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, code)
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_system        BOOLEAN DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sub_type         VARCHAR(50);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reporting_group  VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sort_order       INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vat_code         VARCHAR(20);

-- ── 4. Journal Headers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journals (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date                    DATE NOT NULL,
  reference               VARCHAR(100),
  description             TEXT,
  status                  VARCHAR(20) DEFAULT 'draft',
  source_type             VARCHAR(50) DEFAULT 'manual',
  created_by_user_id      INTEGER REFERENCES users(id),
  posted_at               TIMESTAMPTZ,
  posted_by_user_id       INTEGER REFERENCES users(id),
  reversal_of_journal_id  INTEGER REFERENCES journals(id),
  reversed_by_journal_id  INTEGER REFERENCES journals(id),
  metadata                JSONB DEFAULT '{}',
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. Journal Lines ──────────────────────────────────────────────────────────
-- NOTE: journal_lines may already exist from schema.sql with FK pointing to
-- journal_entries(id) instead of journals(id). We CREATE if missing, then:
--  a) Drop the old FK so the accounting module can insert rows for journals.
--  b) Add missing columns.
CREATE TABLE IF NOT EXISTS journal_lines (
  id          SERIAL PRIMARY KEY,
  journal_id  INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  line_number INTEGER,
  description TEXT,
  debit       NUMERIC(15,2) DEFAULT 0,
  credit      NUMERIC(15,2) DEFAULT 0,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Drop old FK that pointed at journal_entries — accounting module uses journals
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_journal_id_fkey;
-- Add missing columns
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS line_number       INTEGER;
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS metadata          JSONB DEFAULT '{}';
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS segment_value_id  INTEGER;

-- ── 6. Bank Accounts ──────────────────────────────────────────────────────────
-- NOTE: bank_accounts may already exist from the shared schema.sql with a
-- different column set. We CREATE if missing, then ALTER to add any missing
-- columns the accounting module requires.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                  VARCHAR(255),
  bank_name             VARCHAR(255),
  account_number_masked VARCHAR(50),
  currency              VARCHAR(10) DEFAULT 'ZAR',
  ledger_account_id     INTEGER REFERENCES accounts(id),
  opening_balance       NUMERIC(15,2) DEFAULT 0,
  opening_balance_date  DATE,
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
-- Ensure accounting-required columns exist on the pre-existing table
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS name                 VARCHAR(255);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number_masked VARCHAR(50);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS currency              VARCHAR(10) DEFAULT 'ZAR';
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS ledger_account_id    INTEGER REFERENCES accounts(id);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_balance       NUMERIC(15,2) DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_balance_date  DATE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_active             BOOLEAN DEFAULT true;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();

-- ── 7. Bank Transactions ──────────────────────────────────────────────────────
-- NOTE: bank_transactions may already exist from schema.sql without company_id
-- or status. We CREATE if missing, then ALTER to add required columns.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                  SERIAL PRIMARY KEY,
  bank_account_id     INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  date                DATE NOT NULL,
  description         TEXT,
  amount              NUMERIC(15,2) NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
-- Ensure accounting-required columns exist on the pre-existing table
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS company_id          INTEGER REFERENCES companies(id);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS balance              NUMERIC(15,2);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reference            VARCHAR(255);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS external_id          VARCHAR(255);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS status               VARCHAR(20) DEFAULT 'unmatched';
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_entity_type  VARCHAR(50);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_entity_id    INTEGER;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_by_user_id   INTEGER REFERENCES users(id);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reconciled_at        TIMESTAMPTZ;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW();

-- ── 8. Bank Transaction Attachments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transaction_attachments (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id  INTEGER NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  filename             VARCHAR(255) NOT NULL,
  original_filename    VARCHAR(255),
  file_path            TEXT,
  file_size            INTEGER,
  mime_type            VARCHAR(100),
  uploaded_by_user_id  INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── 9. VAT Periods ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_periods (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_key            VARCHAR(20) NOT NULL,
  from_date             DATE NOT NULL,
  to_date               DATE NOT NULL,
  filing_frequency      VARCHAR(20) DEFAULT 'bi-monthly',
  status                VARCHAR(20) DEFAULT 'open',
  locked_by_user_id     INTEGER REFERENCES users(id),
  locked_at             TIMESTAMPTZ,
  submitted_by_user_id  INTEGER REFERENCES users(id),
  submitted_at          TIMESTAMPTZ,
  submission_reference  VARCHAR(100),
  payment_date          DATE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_key)
);

-- ── 10. VAT Reconciliations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_reconciliations (
  id                          SERIAL PRIMARY KEY,
  company_id                  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vat_period_id               INTEGER NOT NULL REFERENCES vat_periods(id),
  version                     INTEGER DEFAULT 1,
  status                      VARCHAR(20) DEFAULT 'draft',
  created_by_user_id          INTEGER REFERENCES users(id),
  soa_amount                  NUMERIC(15,2),
  metadata                    JSONB DEFAULT '{}',
  updated_at                  TIMESTAMPTZ DEFAULT NOW(),
  approved_by_user_id         INTEGER REFERENCES users(id),
  approved_at                 TIMESTAMPTZ,
  diff_authorized             BOOLEAN DEFAULT false,
  diff_authorized_by_user_id  INTEGER REFERENCES users(id),
  diff_authorized_by_initials VARCHAR(10),
  diff_authorized_at          TIMESTAMPTZ,
  soa_authorized              BOOLEAN DEFAULT false,
  soa_authorized_by_user_id   INTEGER REFERENCES users(id),
  soa_authorized_by_initials  VARCHAR(10),
  soa_authorized_at           TIMESTAMPTZ,
  locked_by_user_id           INTEGER REFERENCES users(id),
  locked_at                   TIMESTAMPTZ,
  submitted_by_user_id        INTEGER REFERENCES users(id),
  submitted_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 11. VAT Reconciliation Lines ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_reconciliation_lines (
  id                    SERIAL PRIMARY KEY,
  vat_reconciliation_id INTEGER NOT NULL REFERENCES vat_reconciliations(id) ON DELETE CASCADE,
  section_key           VARCHAR(50),
  row_key               VARCHAR(100),
  label                 TEXT,
  line_order            INTEGER,
  vat_amount            NUMERIC(15,2) DEFAULT 0,
  tb_amount             NUMERIC(15,2) DEFAULT 0,
  statement_amount      NUMERIC(15,2) DEFAULT 0,
  difference_amount     NUMERIC(15,2) DEFAULT 0,
  account_id            INTEGER REFERENCES accounts(id),
  metadata              JSONB DEFAULT '{}'
);

-- ── 12. VAT Submissions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_submissions (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vat_period_id         INTEGER NOT NULL REFERENCES vat_periods(id),
  vat_reconciliation_id INTEGER REFERENCES vat_reconciliations(id),
  submission_date       DATE,
  submitted_by_user_id  INTEGER REFERENCES users(id),
  submission_reference  VARCHAR(100),
  output_vat            NUMERIC(15,2),
  input_vat             NUMERIC(15,2),
  net_vat               NUMERIC(15,2),
  payment_date          DATE,
  payment_reference     VARCHAR(100),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── 13. VAT Reports ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_reports (
  id                SERIAL PRIMARY KEY,
  vat_period_id     INTEGER NOT NULL REFERENCES vat_periods(id),
  status            VARCHAR(20) DEFAULT 'draft',
  locked_by_user_id INTEGER REFERENCES users(id),
  locked_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 14. PAYE Config — Income Types ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paye_config_income_types (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         VARCHAR(100) NOT NULL,
  label       VARCHAR(255) NOT NULL,
  is_default  BOOLEAN DEFAULT false,
  is_custom   BOOLEAN DEFAULT true,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, key)
);

-- ── 15. PAYE Config — Deduction Types ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paye_config_deduction_types (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         VARCHAR(100) NOT NULL,
  label       VARCHAR(255) NOT NULL,
  is_default  BOOLEAN DEFAULT false,
  is_custom   BOOLEAN DEFAULT true,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, key)
);

-- ── 16. PAYE Reconciliations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paye_reconciliations (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  paye_period_id      VARCHAR(20) NOT NULL,
  status              VARCHAR(20) DEFAULT 'draft',
  created_by_user_id  INTEGER REFERENCES users(id),
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  locked_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── 17. PAYE Employee Lines ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paye_employee_lines (
  id                      SERIAL PRIMARY KEY,
  paye_reconciliation_id  INTEGER NOT NULL REFERENCES paye_reconciliations(id) ON DELETE CASCADE,
  employee_id             INTEGER NOT NULL REFERENCES employees(id),
  month_key               VARCHAR(20) NOT NULL,
  gross_income            NUMERIC(15,2) DEFAULT 0,
  total_deductions        NUMERIC(15,2) DEFAULT 0,
  net_salary              NUMERIC(15,2) DEFAULT 0,
  bank_paid_amount        NUMERIC(15,2) DEFAULT 0,
  difference_amount       NUMERIC(15,2) DEFAULT 0,
  metadata_json           JSONB DEFAULT '{}',
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── 18. PAYE Employee Income Lines ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paye_employee_income_lines (
  id                    SERIAL PRIMARY KEY,
  paye_employee_line_id INTEGER NOT NULL REFERENCES paye_employee_lines(id) ON DELETE CASCADE,
  income_type_key       VARCHAR(100) NOT NULL,
  amount                NUMERIC(15,2) DEFAULT 0
);

-- ── 19. PAYE Employee Deduction Lines ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paye_employee_deduction_lines (
  id                    SERIAL PRIMARY KEY,
  paye_employee_line_id INTEGER NOT NULL REFERENCES paye_employee_lines(id) ON DELETE CASCADE,
  deduction_type_key    VARCHAR(100) NOT NULL,
  amount                NUMERIC(15,2) DEFAULT 0
);

-- ── 20. Accounting Audit Log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounting_audit_log (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_type  VARCHAR(20) DEFAULT 'user',
  actor_id    INTEGER REFERENCES users(id),
  action_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id   INTEGER,
  before_json JSONB,
  after_json  JSONB,
  reason      TEXT,
  metadata    JSONB DEFAULT '{}',
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 21. POS Reconciliations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pos_reconciliations (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL,
  date                  DATE NOT NULL,
  payment_method        VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'card')),
  pos_amount            DECIMAL(12,2) NOT NULL DEFAULT 0,
  bank_amount           DECIMAL(12,2) NOT NULL DEFAULT 0,
  journal_id            INTEGER,
  bank_description      TEXT,
  notes                 TEXT,
  reconciled_by_user_id INTEGER,
  reconciled_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, date, payment_method)
);

-- ── 22a. COA Templates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coa_templates (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  industry    VARCHAR(100) DEFAULT 'general',
  is_default  BOOLEAN DEFAULT false,
  version     VARCHAR(20) DEFAULT '1.0',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE coa_templates ADD COLUMN IF NOT EXISTS parent_template_id INTEGER REFERENCES coa_templates(id) ON DELETE SET NULL;
ALTER TABLE coa_templates ADD COLUMN IF NOT EXISTS sean_metadata JSONB DEFAULT '{}'::jsonb;

-- ── 22b. COA Template Accounts ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coa_template_accounts (
  id                SERIAL PRIMARY KEY,
  template_id       INTEGER NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
  code              VARCHAR(20) NOT NULL,
  name              VARCHAR(255) NOT NULL,
  type              VARCHAR(50) NOT NULL,
  sub_type          VARCHAR(50),
  reporting_group   VARCHAR(100),
  parent_code       VARCHAR(20),
  description       TEXT,
  sort_order        INTEGER DEFAULT 0,
  is_system_account BOOLEAN DEFAULT false,
  vat_code          VARCHAR(20),
  UNIQUE(template_id, code)
);

-- ── 22c. COA Segments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coa_segments (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coa_segment_values (
  id         SERIAL PRIMARY KEY,
  segment_id INTEGER NOT NULL REFERENCES coa_segments(id) ON DELETE CASCADE,
  code       VARCHAR(50) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  is_active  BOOLEAN DEFAULT true,
  UNIQUE(segment_id, code)
);
ALTER TABLE coa_segment_values ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE coa_segment_values ADD COLUMN IF NOT EXISTS color      VARCHAR(20);

-- ── 22d. Company Template Assignments ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_template_assignments (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id    INTEGER NOT NULL REFERENCES coa_templates(id),
  applied_at     TIMESTAMPTZ DEFAULT NOW(),
  accounts_added INTEGER DEFAULT 0,
  UNIQUE(company_id, template_id)
);

-- ── 23. Suppliers / AP ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                VARCHAR(50),
  name                VARCHAR(255) NOT NULL,
  type                VARCHAR(20) DEFAULT 'company',
  contact_name        VARCHAR(255),
  email               VARCHAR(255),
  phone               VARCHAR(50),
  vat_number          VARCHAR(50),
  registration_number VARCHAR(50),
  address             TEXT,
  city                VARCHAR(100),
  postal_code         VARCHAR(20),
  country             VARCHAR(100) DEFAULT 'South Africa',
  payment_terms       INTEGER DEFAULT 30,
  default_account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  bank_name           VARCHAR(100),
  bank_account_number VARCHAR(50),
  bank_branch_code    VARCHAR(20),
  notes               TEXT,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_number      VARCHAR(100),
  reference           VARCHAR(100),
  invoice_date        DATE NOT NULL,
  due_date            DATE,
  vat_inclusive       BOOLEAN DEFAULT false,
  subtotal_ex_vat     NUMERIC(15,2) DEFAULT 0,
  vat_amount          NUMERIC(15,2) DEFAULT 0,
  total_inc_vat       NUMERIC(15,2) DEFAULT 0,
  amount_paid         NUMERIC(15,2) DEFAULT 0,
  status              VARCHAR(20) DEFAULT 'draft',
  notes               TEXT,
  journal_id          INTEGER REFERENCES journals(id) ON DELETE SET NULL,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
  id                   SERIAL PRIMARY KEY,
  invoice_id           INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  description          TEXT NOT NULL,
  account_id           INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  quantity             NUMERIC(10,3) DEFAULT 1,
  unit_price           NUMERIC(15,4) DEFAULT 0,
  line_subtotal_ex_vat NUMERIC(15,2) DEFAULT 0,
  vat_rate             NUMERIC(5,2) DEFAULT 15,
  vat_amount           NUMERIC(15,2) DEFAULT 0,
  line_total_inc_vat   NUMERIC(15,2) DEFAULT 0,
  sort_order           INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id         INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  po_number           VARCHAR(100),
  po_date             DATE NOT NULL,
  expected_date       DATE,
  vat_inclusive       BOOLEAN DEFAULT false,
  subtotal_ex_vat     NUMERIC(15,2) DEFAULT 0,
  vat_amount          NUMERIC(15,2) DEFAULT 0,
  total_inc_vat       NUMERIC(15,2) DEFAULT 0,
  status              VARCHAR(20) DEFAULT 'draft',
  notes               TEXT,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                   SERIAL PRIMARY KEY,
  po_id                INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description          TEXT NOT NULL,
  quantity             NUMERIC(10,3) DEFAULT 1,
  unit_price           NUMERIC(15,4) DEFAULT 0,
  line_subtotal_ex_vat NUMERIC(15,2) DEFAULT 0,
  vat_rate             NUMERIC(5,2) DEFAULT 15,
  vat_amount           NUMERIC(15,2) DEFAULT 0,
  line_total_inc_vat   NUMERIC(15,2) DEFAULT 0,
  sort_order           INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
  payment_date        DATE NOT NULL,
  payment_method      VARCHAR(50) DEFAULT 'bank_transfer',
  reference           VARCHAR(100),
  amount              NUMERIC(15,2) NOT NULL,
  notes               TEXT,
  bank_transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
  journal_id          INTEGER REFERENCES journals(id) ON DELETE SET NULL,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS bank_ledger_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  id         SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  amount     NUMERIC(15,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(payment_id, invoice_id)
);

-- ── 24. Accounting KV Store ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounting_kv_store (
  company_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, key)
);

-- ── 25. Customer AR ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_invoices (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id         INTEGER,
  customer_name       TEXT NOT NULL,
  invoice_number      TEXT NOT NULL,
  reference           TEXT,
  invoice_date        DATE NOT NULL,
  due_date            DATE,
  status              TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','part_paid','void')),
  subtotal_ex_vat     NUMERIC(15,2) DEFAULT 0,
  vat_amount          NUMERIC(15,2) DEFAULT 0,
  total_inc_vat       NUMERIC(15,2) DEFAULT 0,
  amount_paid         NUMERIC(15,2) DEFAULT 0,
  notes               TEXT,
  journal_id          INTEGER REFERENCES journals(id) ON DELETE SET NULL,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_invoice_lines (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  quantity        NUMERIC(15,4) DEFAULT 1,
  unit_price      NUMERIC(15,4) DEFAULT 0,
  vat_rate        NUMERIC(5,2) DEFAULT 15,
  subtotal_ex_vat NUMERIC(15,2) DEFAULT 0,
  vat_amount      NUMERIC(15,2) DEFAULT 0,
  total_inc_vat   NUMERIC(15,2) DEFAULT 0,
  sort_order      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_payments (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id            INTEGER,
  customer_name          TEXT NOT NULL,
  payment_date           DATE NOT NULL,
  payment_method         TEXT DEFAULT 'bank_transfer',
  reference              TEXT,
  amount                 NUMERIC(15,2) NOT NULL,
  bank_ledger_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  notes                  TEXT,
  journal_id             INTEGER REFERENCES journals(id) ON DELETE SET NULL,
  created_by_user_id     INTEGER REFERENCES users(id),
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_payment_allocations (
  id             SERIAL PRIMARY KEY,
  payment_id     INTEGER NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  invoice_id     INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount_applied NUMERIC(15,2) NOT NULL,
  UNIQUE(payment_id, invoice_id)
);

-- ── 26. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_accounts_company          ON accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_journals_company_date     ON journals(company_id, date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_journal     ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_bank_txn_account          ON bank_transactions(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_txn_status           ON bank_transactions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_vat_periods_company       ON vat_periods(company_id);
CREATE INDEX IF NOT EXISTS idx_paye_recon_company        ON paye_reconciliations(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_audit          ON accounting_audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_pos_recon_company         ON pos_reconciliations(company_id, date);
CREATE INDEX IF NOT EXISTS idx_coa_tmpl_accounts_tmpl   ON coa_template_accounts(template_id);
CREATE INDEX IF NOT EXISTS idx_accounts_sub_type         ON accounts(company_id, sub_type);
CREATE INDEX IF NOT EXISTS idx_accounts_sort             ON accounts(company_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_suppliers_company         ON suppliers(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_company ON supplier_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_status  ON supplier_invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_supplier_inv_lines_invoice ON supplier_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_company   ON purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_company ON supplier_payments(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_customer_invoices_company ON customer_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_invoices_status  ON customer_invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_inv_lines_invoice ON customer_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_company ON customer_payments(company_id);

-- ── 27. Standard SA Base COA Template (idempotent seed) ──────────────────────
DO $$
DECLARE
  tmpl_id INTEGER;
BEGIN
  -- Insert template only if it doesn't exist
  INSERT INTO coa_templates (name, description, industry, is_default, version)
  VALUES ('Standard SA Base', 'Standard South African Chart of Accounts', 'general', true, '1.0')
  ON CONFLICT DO NOTHING;

  SELECT id INTO tmpl_id FROM coa_templates WHERE name = 'Standard SA Base' LIMIT 1;

  -- Insert all 76 standard accounts (ON CONFLICT = safe re-run)
  INSERT INTO coa_template_accounts (template_id, code, name, type, sub_type, reporting_group, description, sort_order, is_system_account) VALUES
  (tmpl_id,'1000','Cash on Hand','asset','current_asset','bank_cash','Cash held on premises or in till',1000,false),
  (tmpl_id,'1010','Bank — Cheque Account','asset','current_asset','bank_cash','Primary business cheque/current account',1010,false),
  (tmpl_id,'1020','Petty Cash','asset','current_asset','bank_cash','Small cash float for minor expenses',1020,false),
  (tmpl_id,'1030','Bank — Savings / Call Account','asset','current_asset','bank_cash','Business savings account or call deposit earning interest',1030,false),
  (tmpl_id,'1100','Accounts Receivable','asset','current_asset','debtors','Amounts owed by customers for goods or services',1100,false),
  (tmpl_id,'1110','Allowance for Doubtful Debts','asset','current_asset','debtors','Contra asset — provision for bad debts',1110,false),
  (tmpl_id,'1200','Inventory','asset','current_asset','inventory','Stock of goods held for resale or production',1200,false),
  (tmpl_id,'1300','Prepaid Expenses','asset','current_asset','prepayments','Expenses paid in advance (insurance, rent)',1300,false),
  (tmpl_id,'1400','VAT Input (Claimable)','asset','current_asset','vat_asset','VAT paid on business purchases — claimable from SARS',1400,false),
  (tmpl_id,'1500','Other Current Assets','asset','current_asset','other_current_asset','Sundry short-term assets not classified above',1500,false),
  (tmpl_id,'1600','Land and Buildings','asset','non_current_asset','fixed_assets','Property owned by the business',1600,false),
  (tmpl_id,'1610','Plant and Machinery','asset','non_current_asset','fixed_assets','Production plant, equipment, and machinery',1610,false),
  (tmpl_id,'1620','Motor Vehicles','asset','non_current_asset','fixed_assets','Vehicles owned by the business',1620,false),
  (tmpl_id,'1630','Office Furniture and Equipment','asset','non_current_asset','fixed_assets','Desks, chairs, and office fittings',1630,false),
  (tmpl_id,'1640','Computer Equipment','asset','non_current_asset','fixed_assets','Computers, servers, and peripherals',1640,false),
  (tmpl_id,'1700','Accum Depreciation — Buildings','asset','non_current_asset','accumulated_depreciation','Contra asset — accumulated depreciation on buildings',1700,false),
  (tmpl_id,'1710','Accum Depreciation — Plant','asset','non_current_asset','accumulated_depreciation','Contra asset — accumulated depreciation on plant and machinery',1710,false),
  (tmpl_id,'1720','Accum Depreciation — Vehicles','asset','non_current_asset','accumulated_depreciation','Contra asset — accumulated depreciation on motor vehicles',1720,false),
  (tmpl_id,'1730','Accum Depreciation — Equipment','asset','non_current_asset','accumulated_depreciation','Contra asset — accumulated depreciation on office and IT equipment',1730,false),
  (tmpl_id,'1800','Goodwill','asset','non_current_asset','fixed_assets','Goodwill acquired on purchase of a business',1800,false),
  (tmpl_id,'1810','Trademarks, Patents and Licences','asset','non_current_asset','fixed_assets','Registered intellectual property and exclusive licences',1810,false),
  (tmpl_id,'1850','Long-term Investments','asset','non_current_asset','fixed_assets','Shares, bonds, and other investments held for more than 12 months',1850,false),
  (tmpl_id,'1900','Accum Amortisation — Intangibles','asset','non_current_asset','accumulated_depreciation','Contra asset — accumulated amortisation on intangible assets',1900,false),
  (tmpl_id,'2000','Accounts Payable','liability','current_liability','creditors','Amounts owed to suppliers for goods and services',2000,false),
  (tmpl_id,'2050','Credit Card Payable','liability','current_liability','creditors','Outstanding balance on business credit card',2050,false),
  (tmpl_id,'2100','Short-term Loans','liability','current_liability','short_term_loans','Loans and credit facilities due within 12 months',2100,false),
  (tmpl_id,'2110','Bank Overdraft','liability','current_liability','bank_cash','Overdraft balance on business bank account',2110,false),
  (tmpl_id,'2200','Accrued Expenses','liability','current_liability','accruals','Expenses incurred but not yet billed or paid',2200,false),
  (tmpl_id,'2210','Customer Deposits Received','liability','current_liability','accruals','Deposits received from customers ahead of delivery',2210,false),
  (tmpl_id,'2300','VAT Output (Payable)','liability','current_liability','vat_liability','VAT collected from customers — payable to SARS',2300,false),
  (tmpl_id,'2400','PAYE / UIF Payable','liability','current_liability','paye_payable','Employee PAYE and UIF deductions withheld — payable to SARS',2400,false),
  (tmpl_id,'2410','SDL Payable','liability','current_liability','paye_payable','Skills Development Levy payable to SARS',2410,false),
  (tmpl_id,'2500','Income Tax Payable','liability','current_liability','tax_payable','Provisional and assessed income tax payable to SARS',2500,false),
  (tmpl_id,'2600','Dividends Payable','liability','current_liability','accruals','Dividends declared but not yet paid to shareholders',2600,false),
  (tmpl_id,'2700','Long-term Loans','liability','non_current_liability','long_term_loans','Loans and borrowings due after 12 months',2700,false),
  (tmpl_id,'2710','Finance Lease Obligations','liability','non_current_liability','long_term_loans','Capital lease liabilities (vehicles, equipment)',2710,false),
  (tmpl_id,'2750','Deferred Tax Liability','liability','non_current_liability','long_term_loans','Tax liability arising from temporary differences between accounting and tax',2750,false),
  (tmpl_id,'3000','Owner''s Equity / Share Capital','equity','equity','share_capital','Capital contributed by owners or shareholders',3000,false),
  (tmpl_id,'3100','Retained Earnings','equity','equity','retained_earnings','Accumulated net profits retained in the business',3100,false),
  (tmpl_id,'3200','Drawings','equity','equity','drawings','Amounts withdrawn by owners from the business',3200,false),
  (tmpl_id,'4000','Sales Revenue','income','operating_income','operating_income','Revenue from sales of goods to customers',4000,false),
  (tmpl_id,'4100','Service Revenue','income','operating_income','operating_income','Revenue from services rendered to clients',4100,false),
  (tmpl_id,'4200','Commission Income','income','operating_income','operating_income','Commission earned on sales or referrals',4200,false),
  (tmpl_id,'4300','Contract Revenue','income','operating_income','operating_income','Revenue from long-term contracts or projects',4300,false),
  (tmpl_id,'4500','Interest Received','income','other_income','other_income','Interest earned on bank accounts and investments',4500,false),
  (tmpl_id,'4600','Rental Income','income','other_income','other_income','Rental income from property or assets leased out',4600,false),
  (tmpl_id,'4700','Profit on Disposal of Assets','income','other_income','other_income','Gain on sale of fixed assets',4700,false),
  (tmpl_id,'4800','Other Income','income','other_income','other_income','Sundry income not classifiable above',4800,false),
  (tmpl_id,'5000','Cost of Sales — Materials','expense','cost_of_sales','cost_of_sales','Direct cost of materials or stock sold',5000,false),
  (tmpl_id,'5100','Cost of Sales — Direct Labour','expense','cost_of_sales','cost_of_sales','Labour directly attributable to goods or services sold',5100,false),
  (tmpl_id,'5200','Freight and Delivery — Inward','expense','cost_of_sales','cost_of_sales','Shipping and freight costs to receive stock',5200,false),
  (tmpl_id,'5300','Subcontractors and Outsourcing','expense','cost_of_sales','cost_of_sales','Third-party labour or services directly tied to sales',5300,false),
  (tmpl_id,'5400','Inventory Write-offs','expense','cost_of_sales','cost_of_sales','Stock written off due to damage, expiry, or obsolescence',5400,false),
  (tmpl_id,'6000','Salaries and Wages','expense','operating_expense','personnel','Employee salaries, wages, and overtime',6000,false),
  (tmpl_id,'6010','Bonuses and Incentives','expense','operating_expense','personnel','Performance bonuses and incentive payments',6010,false),
  (tmpl_id,'6020','Employer UIF Contributions','expense','operating_expense','personnel','Employer share of UIF contributions',6020,false),
  (tmpl_id,'6030','Employer SDL Contributions','expense','operating_expense','personnel','Skills Development Levy paid by employer',6030,false),
  (tmpl_id,'6040','Medical Aid — Employer Contribution','expense','operating_expense','personnel','Employer contribution to employee medical aid',6040,false),
  (tmpl_id,'6050','Pension / Provident — Employer','expense','operating_expense','personnel','Employer contribution to pension or provident fund',6050,false),
  (tmpl_id,'6060','Staff Training and Welfare','expense','operating_expense','personnel','Staff development, training, and welfare costs',6060,false),
  (tmpl_id,'6070','Recruitment and HR Costs','expense','operating_expense','personnel','Recruitment agency fees, job advertising, and HR administration',6070,false),
  (tmpl_id,'6100','Rent — Office / Premises','expense','operating_expense','occupancy','Office, factory, or retail premises rental',6100,false),
  (tmpl_id,'6110','Rates and Taxes','expense','operating_expense','occupancy','Municipal rates and property taxes',6110,false),
  (tmpl_id,'6120','Electricity and Water','expense','operating_expense','occupancy','Utilities consumed at business premises',6120,false),
  (tmpl_id,'6130','Cleaning and Maintenance','expense','operating_expense','occupancy','Premises cleaning, repairs, and routine maintenance',6130,false),
  (tmpl_id,'6140','Security and Alarm Costs','expense','operating_expense','occupancy','Security guards, alarm monitoring, and access control costs',6140,false),
  (tmpl_id,'6200','Telephone and Internet','expense','operating_expense','communication','Landline, mobile, and internet costs',6200,false),
  (tmpl_id,'6210','Postage and Courier','expense','operating_expense','communication','Postage, courier, and delivery costs',6210,false),
  (tmpl_id,'6300','Motor Vehicle — Fuel','expense','operating_expense','motor','Fuel costs for business vehicles',6300,false),
  (tmpl_id,'6310','Motor Vehicle — Repairs and Maintenance','expense','operating_expense','motor','Vehicle servicing, tyres, and repairs',6310,false),
  (tmpl_id,'6320','Motor Vehicle — Insurance and Licensing','expense','operating_expense','motor','Vehicle insurance premiums and licence fees',6320,false),
  (tmpl_id,'6330','Travel and Accommodation','expense','operating_expense','motor','Business travel, flights, hotels, and subsistence',6330,false),
  (tmpl_id,'6400','Office Supplies and Stationery','expense','operating_expense','admin','Stationery, paper, pens, and consumables',6400,false),
  (tmpl_id,'6410','Printing and Photocopying','expense','operating_expense','admin','Printing, photocopying, and document costs',6410,false),
  (tmpl_id,'6500','Computer and IT Expenses','expense','operating_expense','it_software','Hardware repairs, accessories, and IT support',6500,false),
  (tmpl_id,'6510','Software Subscriptions','expense','operating_expense','it_software','Cloud software, SaaS subscriptions, and licences',6510,false),
  (tmpl_id,'6600','Accounting and Audit Fees','expense','operating_expense','professional_fees','Fees paid to auditors and accounting firms',6600,false),
  (tmpl_id,'6610','Legal and Compliance Fees','expense','operating_expense','professional_fees','Legal advice, CIPC filings, and compliance costs',6610,false),
  (tmpl_id,'6620','Consulting Fees','expense','operating_expense','professional_fees','Management consulting and specialist advisory fees',6620,false),
  (tmpl_id,'6700','Bank Charges and Fees','expense','operating_expense','banking','Bank service fees, transaction charges, and merchant costs',6700,false),
  (tmpl_id,'6800','Insurance — Business','expense','operating_expense','insurance','Business insurance, public liability, and indemnity cover',6800,false),
  (tmpl_id,'6810','Insurance — Assets','expense','operating_expense','insurance','Insurance premiums for plant, equipment, and property',6810,false),
  (tmpl_id,'6900','Marketing and Advertising','expense','operating_expense','marketing','Advertising, social media, and promotional material costs',6900,false),
  (tmpl_id,'6910','Entertainment and Hospitality','expense','operating_expense','marketing','Client entertainment, meals, and business hospitality',6910,false),
  (tmpl_id,'6950','Donations and Subscriptions','expense','operating_expense','sundry','Charitable donations and professional membership subscriptions',6950,false),
  (tmpl_id,'6990','Other Operating Expenses','expense','operating_expense','sundry','Miscellaneous operating expenses not classified above',6990,false),
  (tmpl_id,'7000','Interest Expense — Bank Loans','expense','finance_cost','finance_costs','Interest on overdrafts and business loans',7000,false),
  (tmpl_id,'7010','Interest Expense — Finance Leases','expense','finance_cost','finance_costs','Finance charge portion of lease payments',7010,false),
  (tmpl_id,'7020','Other Finance Charges','expense','finance_cost','finance_costs','Sundry financial charges (factoring, facility fees)',7020,false),
  (tmpl_id,'7500','Depreciation — Buildings','expense','depreciation_amort','depreciation','Annual depreciation charge on buildings',7500,false),
  (tmpl_id,'7510','Depreciation — Plant and Machinery','expense','depreciation_amort','depreciation','Annual depreciation charge on plant and machinery',7510,false),
  (tmpl_id,'7520','Depreciation — Motor Vehicles','expense','depreciation_amort','depreciation','Annual depreciation charge on motor vehicles',7520,false),
  (tmpl_id,'7530','Depreciation — Equipment','expense','depreciation_amort','depreciation','Annual depreciation charge on office and IT equipment',7530,false),
  (tmpl_id,'7540','Amortisation — Intangible Assets','expense','depreciation_amort','depreciation','Amortisation of patents, trademarks, and other intangibles',7540,false)
  ON CONFLICT (template_id, code) DO NOTHING;

END $$;
