-- =============================================================================
-- Accounting Ecosystem — Unified Supabase Schema
-- =============================================================================
-- Run this in Supabase SQL Editor to create all tables.
-- Sections:
--   1. SHARED (companies, users, audit — used by all modules)
--   2. ECOSYSTEM (eco_clients — cross-app client registry)
--   3. POS Module (products, sales, tills, customers, inventory, etc.)
--   4. PAYROLL Module (periods, transactions, items, attendance, leave)
--   5. ACCOUNTING Module (placeholder - extends from Lorenco Accounting)
--
-- RLS policies enforce company isolation. Service-role key bypasses RLS.
-- =============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. SHARED TABLES — Always Active
-- =============================================================================

-- ─── Companies ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  trading_name VARCHAR(255),
  registration_number VARCHAR(100),
  vat_number VARCHAR(50),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  address TEXT,
  owner_user_id INTEGER,
  modules_enabled TEXT[] DEFAULT ARRAY['pos'],
  subscription_status VARCHAR(50) DEFAULT 'active',
  subscription_expires_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by_user_id INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Users (shared auth identity) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'cashier',
  is_super_admin BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  must_change_password BOOLEAN DEFAULT false,
  profile_photo_url VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── User ↔ Company access (multi-company support) ──────────────────────────
CREATE TABLE IF NOT EXISTS user_company_access (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'cashier',
  is_primary BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  granted_by_user_id INTEGER REFERENCES users(id),
  UNIQUE(user_id, company_id)
);

-- ─── Employees (shared across POS + Payroll) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  employee_code VARCHAR(50),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  id_number VARCHAR(20),
  email VARCHAR(255),
  phone VARCHAR(50),
  department VARCHAR(100),
  position VARCHAR(100),
  hire_date DATE,
  termination_date DATE,
  employment_status VARCHAR(50) DEFAULT 'active',
  employment_type VARCHAR(50) DEFAULT 'full_time',
  hourly_rate DECIMAL(10,2),
  salary DECIMAL(12,2),
  hours_per_week DECIMAL(4,2) DEFAULT 40.00,   -- used in hourly wage formula: salary / (hours_per_week × 4.33)
  hours_per_day DECIMAL(4,2) DEFAULT 8.00,     -- informational for attendance context
  tax_number VARCHAR(50),
  eco_client_id INTEGER,  -- linked after eco_clients table is created (FK added in migration 003)
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, employee_code)
);

-- ─── Audit Log (forensic — all modules) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  user_id INTEGER REFERENCES users(id),
  user_email VARCHAR(255) DEFAULT 'system',
  action_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100),
  module VARCHAR(50),
  field_name VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  ip_address VARCHAR(50),
  session_id VARCHAR(255),
  user_agent TEXT,
  additional_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);


-- =============================================================================
-- 2. ECOSYSTEM MODULE — Cross-App Client Registry
-- =============================================================================

-- ─── Eco Clients (universal client/contact shared across all apps) ────────────
CREATE TABLE IF NOT EXISTS eco_clients (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  email        VARCHAR(255),
  phone        VARCHAR(50),
  id_number    VARCHAR(100),
  address      TEXT,
  client_type  VARCHAR(50)  DEFAULT 'business',        -- 'individual' | 'business'
  apps         TEXT[]       DEFAULT ARRAY[]::TEXT[],   -- e.g. ['pos','payroll']
  notes        TEXT,
  is_active    BOOLEAN      DEFAULT true,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eco_clients_company ON eco_clients(company_id);
CREATE INDEX IF NOT EXISTS idx_eco_clients_email   ON eco_clients(email);
CREATE INDEX IF NOT EXISTS idx_eco_clients_active  ON eco_clients(is_active);

-- =============================================================================
-- 3. POS MODULE — Checkout Charlie
-- =============================================================================

-- ─── Product Categories ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  parent_id INTEGER REFERENCES categories(id),
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, name)
);

-- ─── Products ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_code VARCHAR(50) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id),
  category VARCHAR(100),
  unit_price DECIMAL(10,2) NOT NULL,
  cost_price DECIMAL(10,2),
  stock_quantity INTEGER DEFAULT 0,
  min_stock_level INTEGER DEFAULT 10,
  barcode VARCHAR(100),
  requires_vat BOOLEAN DEFAULT true,
  vat_rate DECIMAL(5,2) DEFAULT 15,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, product_code)
);

CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(company_id, barcode);

-- ─── Customers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_number VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  contact_person VARCHAR(255),
  contact_number VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(255),
  address_line_1 VARCHAR(255),
  address_line_2 VARCHAR(255),
  city VARCHAR(100),
  province VARCHAR(100),
  postal_code VARCHAR(20),
  tax_reference VARCHAR(50),
  id_number VARCHAR(50),
  customer_type VARCHAR(50) DEFAULT 'Cash Sale Customer',
  customer_group VARCHAR(50) DEFAULT 'retail',
  credit_limit DECIMAL(10,2) DEFAULT 0,
  current_balance DECIMAL(10,2) DEFAULT 0,
  loyalty_points INTEGER DEFAULT 0,
  notes TEXT,
  eco_client_id INTEGER REFERENCES eco_clients(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_company    ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_customers_eco_client ON customers(eco_client_id);

-- ─── Tills ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tills (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  till_name VARCHAR(255) NOT NULL,
  till_number VARCHAR(50) NOT NULL,
  location VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, till_number)
);

-- ─── Till Sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS till_sessions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  till_id INTEGER NOT NULL REFERENCES tills(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  opening_balance DECIMAL(10,2) NOT NULL,
  closing_balance DECIMAL(10,2),
  expected_balance DECIMAL(10,2),
  variance DECIMAL(10,2),
  status VARCHAR(20) DEFAULT 'open',
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  notes TEXT
);

-- ─── Sales ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_number VARCHAR(50) NOT NULL,
  till_session_id INTEGER REFERENCES till_sessions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  subtotal DECIMAL(10,2) NOT NULL,
  vat_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
  payment_status VARCHAR(50) DEFAULT 'completed',
  status VARCHAR(20) DEFAULT 'completed',
  receipt_number VARCHAR(50),
  voided_at TIMESTAMPTZ,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, sale_number)
);

CREATE INDEX IF NOT EXISTS idx_sales_company ON sales(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(company_id, created_at DESC);

-- ─── Sale Items ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(10,2) NOT NULL
);

-- ─── Sale Payments (multi-payment support) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  payment_method VARCHAR(50) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  reference VARCHAR(255),
  status VARCHAR(50) DEFAULT 'completed',
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  processed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Stock Adjustments ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  adjustment_type VARCHAR(50) NOT NULL,
  quantity_change INTEGER NOT NULL,
  quantity_before INTEGER,
  quantity_after INTEGER,
  reason TEXT,
  reference_number VARCHAR(100),
  adjusted_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VAT Settings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  is_vat_registered BOOLEAN DEFAULT false,
  vat_number VARCHAR(50),
  vat_rate DECIMAL(5,2) DEFAULT 15,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by_user_id INTEGER REFERENCES users(id),
  UNIQUE(company_id)
);

-- ─── Company Settings (POS-specific) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  till_float_amount DECIMAL(10,2) DEFAULT 500,
  receipt_header TEXT,
  receipt_footer TEXT,
  product_code_prefix VARCHAR(10) DEFAULT 'PRO',
  receipt_prefix VARCHAR(10) DEFAULT 'INV',
  next_receipt_number INTEGER DEFAULT 1,
  vat_rate DECIMAL(5,2) DEFAULT 15.00,
  open_drawer_on_sale BOOLEAN DEFAULT true,
  group_same_items BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by_user_id INTEGER REFERENCES users(id),
  UNIQUE(company_id)
);

-- ─── Barcode Settings ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS barcode_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_prefix VARCHAR(10) DEFAULT '600',
  current_sequence INTEGER DEFAULT 1000,
  barcode_type VARCHAR(20) DEFAULT 'EAN13',
  auto_generate BOOLEAN DEFAULT false,
  last_generated VARCHAR(50),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id)
);

-- ─── Suppliers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_code VARCHAR(50) NOT NULL,
  supplier_name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  address TEXT,
  payment_terms INTEGER DEFAULT 30,
  tax_reference VARCHAR(50),
  bank_name VARCHAR(100),
  bank_account VARCHAR(50),
  bank_branch_code VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, supplier_code)
);


-- =============================================================================
-- 3. PAYROLL MODULE — Lorenco Paytime
-- =============================================================================

-- ─── Employee Bank Details ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_bank_details (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_name VARCHAR(100),
  account_type VARCHAR(50),
  account_number VARCHAR(50),
  branch_code VARCHAR(20),
  is_primary BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Payroll Periods ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_periods (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_name VARCHAR(100) NOT NULL,
  period_key VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  pay_date DATE,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'approved', 'paid', 'locked')),
  processed_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_key)
);

-- ─── Payroll Items Master (earning/deduction definitions) ────────────────────
CREATE TABLE IF NOT EXISTS payroll_items_master (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_code VARCHAR(50) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('earning', 'deduction', 'company_contribution')),
  category VARCHAR(50),
  is_taxable BOOLEAN DEFAULT true,
  is_recurring BOOLEAN DEFAULT false,
  default_amount DECIMAL(12,2),
  calculation_type VARCHAR(20) DEFAULT 'fixed',
  calculation_rate DECIMAL(10,4),
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, item_code)
);

-- ─── Employee Payroll Setup (persistent salary/inputs per employee) ──────────
CREATE TABLE IF NOT EXISTS employee_payroll_setup (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  basic_salary DECIMAL(12,2) DEFAULT 0,
  tax_number VARCHAR(50),
  tax_status VARCHAR(20) DEFAULT 'normal',
  medical_aid_members INTEGER DEFAULT 0,
  tax_directive_rate DECIMAL(5,2),
  uif_exempt BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, company_id)
);

-- ─── Employee Recurring Inputs (regular allowances/deductions) ───────────────
CREATE TABLE IF NOT EXISTS employee_recurring_inputs (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_item_id INTEGER REFERENCES payroll_items_master(id),
  input_type VARCHAR(20) NOT NULL CHECK (input_type IN ('earning', 'deduction')),
  description VARCHAR(255),
  amount DECIMAL(12,2) NOT NULL,
  is_taxable BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Payroll Transactions (payslips per period per employee) ─────────────────
CREATE TABLE IF NOT EXISTS payroll_transactions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  basic_salary DECIMAL(12,2) DEFAULT 0,
  gross_income DECIMAL(12,2) DEFAULT 0,
  taxable_income DECIMAL(12,2) DEFAULT 0,
  paye DECIMAL(12,2) DEFAULT 0,
  uif_employee DECIMAL(12,2) DEFAULT 0,
  uif_employer DECIMAL(12,2) DEFAULT 0,
  sdl DECIMAL(12,2) DEFAULT 0,
  medical_credit DECIMAL(12,2) DEFAULT 0,
  total_deductions DECIMAL(12,2) DEFAULT 0,
  net_pay DECIMAL(12,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  processed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_tx_period ON payroll_transactions(company_id, period_id);

-- ─── Payslip Items (line items on each payslip) ──────────────────────────────
CREATE TABLE IF NOT EXISTS payslip_items (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES payroll_transactions(id) ON DELETE CASCADE,
  payroll_item_id INTEGER REFERENCES payroll_items_master(id),
  item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('earning', 'deduction', 'company_contribution', 'tax')),
  description VARCHAR(255) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  is_taxable BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Period Inputs (one-off inputs for a specific period) ────────────────────
CREATE TABLE IF NOT EXISTS period_inputs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  input_type VARCHAR(20) NOT NULL CHECK (input_type IN ('earning', 'deduction', 'overtime', 'short_time', 'multi_rate')),
  description VARCHAR(255),
  amount DECIMAL(12,2),
  hours DECIMAL(8,2),
  rate DECIMAL(10,2),
  rate_multiplier DECIMAL(5,2) DEFAULT 1,
  is_taxable BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Attendance ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  attendance_date DATE NOT NULL,
  clock_in TIMESTAMPTZ,
  clock_out TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'half_day', 'leave', 'holiday')),
  hours_worked DECIMAL(5,2),
  overtime_hours DECIMAL(5,2) DEFAULT 0,
  notes TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, employee_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(company_id, attendance_date);

-- ─── Leave ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_records (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type VARCHAR(50) NOT NULL CHECK (leave_type IN ('annual', 'sick', 'family', 'maternity', 'paternity', 'unpaid', 'other')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days_taken DECIMAL(5,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reason TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Leave Balances ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_balances (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type VARCHAR(50) NOT NULL,
  annual_entitlement DECIMAL(5,2) DEFAULT 0,
  balance DECIMAL(5,2) DEFAULT 0,
  carried_forward DECIMAL(5,2) DEFAULT 0,
  year INTEGER NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, employee_id, leave_type, year)
);

-- ─── Employee Notes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_notes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  note_type VARCHAR(50) DEFAULT 'general',
  content TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Pay Runs (batch processing tracker) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pay_runs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  run_number INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'draft',
  employee_count INTEGER DEFAULT 0,
  total_gross DECIMAL(14,2) DEFAULT 0,
  total_deductions DECIMAL(14,2) DEFAULT 0,
  total_net DECIMAL(14,2) DEFAULT 0,
  total_employer_cost DECIMAL(14,2) DEFAULT 0,
  processed_by INTEGER REFERENCES users(id),
  processed_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_id, run_number)
);

-- ─── Historical Payroll Records (imported) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_historical (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  period_key VARCHAR(20) NOT NULL,
  gross DECIMAL(12,2) DEFAULT 0,
  paye DECIMAL(12,2) DEFAULT 0,
  uif DECIMAL(12,2) DEFAULT 0,
  net DECIMAL(12,2) DEFAULT 0,
  source VARCHAR(50),
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, employee_id, period_key)
);

-- KV store — frontend localStorage bridge (cloud-backed, survives browser clears)
CREATE TABLE IF NOT EXISTS payroll_kv_store_eco (
  company_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, key)
);


-- =============================================================================
-- 4. ACCOUNTING MODULE — Lorenco Accounting
-- =============================================================================

-- ─── Chart of Accounts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_number VARCHAR(20) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('Asset', 'Liability', 'Equity', 'Income', 'Expense')),
  sub_type VARCHAR(100),
  description TEXT,
  opening_balance DECIMAL(14,2) DEFAULT 0,
  current_balance DECIMAL(14,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  is_system BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, account_number)
);

CREATE INDEX IF NOT EXISTS idx_coa_company ON chart_of_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_coa_type ON chart_of_accounts(company_id, account_type);

-- ─── Journal Entries ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_number VARCHAR(50) NOT NULL,
  date DATE NOT NULL,
  description TEXT NOT NULL,
  reference VARCHAR(255),
  type VARCHAR(50) DEFAULT 'general' CHECK (type IN ('general', 'opening', 'closing', 'adjustment', 'reversal', 'sales', 'purchase', 'payment', 'receipt')),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  total_debit DECIMAL(14,2) DEFAULT 0,
  total_credit DECIMAL(14,2) DEFAULT 0,
  period_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  posted_by INTEGER REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, journal_number)
);

CREATE INDEX IF NOT EXISTS idx_journal_company ON journal_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(company_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_status ON journal_entries(company_id, status);

-- ─── Journal Lines (double-entry debit/credit per account) ─────────────────
CREATE TABLE IF NOT EXISTS journal_lines (
  id SERIAL PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
  debit DECIMAL(14,2) DEFAULT 0,
  credit DECIMAL(14,2) DEFAULT 0,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jlines_journal ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_jlines_account ON journal_lines(account_id);

-- ─── Bank Accounts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_name VARCHAR(100) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  branch_code VARCHAR(20),
  account_type VARCHAR(50) DEFAULT 'current' CHECK (account_type IN ('current', 'savings', 'credit', 'investment')),
  linked_account_id INTEGER REFERENCES chart_of_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_acct_company ON bank_accounts(company_id);

-- ─── Bank Transactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id SERIAL PRIMARY KEY,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  description TEXT,
  reference VARCHAR(255),
  amount DECIMAL(14,2) NOT NULL,
  allocated_account_id INTEGER REFERENCES chart_of_accounts(id),
  is_reconciled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_account ON bank_transactions(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_transactions(bank_account_id, date DESC);

-- ─── Financial Periods ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_periods (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_name VARCHAR(100) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_by INTEGER REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_name)
);

CREATE INDEX IF NOT EXISTS idx_fin_period_company ON financial_periods(company_id);

-- Add FK from journal_entries.period_id → financial_periods (deferred because of table order)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_period') THEN
    ALTER TABLE journal_entries ADD CONSTRAINT fk_journal_period FOREIGN KEY (period_id) REFERENCES financial_periods(id);
  END IF;
END $$;

-- ─── Customer Invoices (Trade Debtors) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_invoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_number VARCHAR(50) NOT NULL,
  date DATE NOT NULL,
  due_date DATE,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'partial', 'overdue', 'cancelled')),
  subtotal DECIMAL(14,2) DEFAULT 0,
  vat_amount DECIMAL(14,2) DEFAULT 0,
  total_amount DECIMAL(14,2) DEFAULT 0,
  amount_paid DECIMAL(14,2) DEFAULT 0,
  balance_due DECIMAL(14,2) DEFAULT 0,
  notes TEXT,
  journal_id INTEGER REFERENCES journal_entries(id),
  payment_journal_id INTEGER REFERENCES journal_entries(id),
  sale_id INTEGER REFERENCES sales(id),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS customer_invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES chart_of_accounts(id),
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(10,2) DEFAULT 1,
  unit_price DECIMAL(14,2) DEFAULT 0,
  vat_rate DECIMAL(5,2) DEFAULT 15,
  line_total DECIMAL(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cust_inv_company ON customer_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_cust_inv_customer ON customer_invoices(customer_id);

-- ─── Supplier Invoices (Trade Creditors) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_number VARCHAR(50) NOT NULL,
  supplier_ref VARCHAR(100),
  date DATE NOT NULL,
  due_date DATE,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'partial', 'overdue', 'cancelled')),
  subtotal DECIMAL(14,2) DEFAULT 0,
  vat_amount DECIMAL(14,2) DEFAULT 0,
  total_amount DECIMAL(14,2) DEFAULT 0,
  amount_paid DECIMAL(14,2) DEFAULT 0,
  balance_due DECIMAL(14,2) DEFAULT 0,
  notes TEXT,
  journal_id INTEGER REFERENCES journal_entries(id),
  payment_journal_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES chart_of_accounts(id),
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(10,2) DEFAULT 1,
  unit_price DECIMAL(14,2) DEFAULT 0,
  vat_rate DECIMAL(5,2) DEFAULT 15,
  line_total DECIMAL(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supp_inv_company ON supplier_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_supp_inv_supplier ON supplier_invoices(supplier_id);

-- ─── PAYE Reconciliation Tables ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paye_config_income_types (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  label VARCHAR(200) NOT NULL,
  is_default BOOLEAN DEFAULT false,
  is_custom BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, key)
);

CREATE TABLE IF NOT EXISTS paye_config_deduction_types (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  label VARCHAR(200) NOT NULL,
  is_default BOOLEAN DEFAULT false,
  is_custom BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, key)
);

CREATE TABLE IF NOT EXISTS paye_periods (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'LOCKED')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, from_date, to_date)
);

CREATE TABLE IF NOT EXISTS paye_reconciliations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  paye_period_id INTEGER NOT NULL REFERENCES paye_periods(id) ON DELETE CASCADE,
  version INTEGER DEFAULT 1,
  status VARCHAR(20) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'LOCKED')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paye_employee_lines (
  id SERIAL PRIMARY KEY,
  paye_reconciliation_id INTEGER NOT NULL REFERENCES paye_reconciliations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  month_key VARCHAR(7) NOT NULL,
  gross_income DECIMAL(15,2) DEFAULT 0,
  total_deductions DECIMAL(15,2) DEFAULT 0,
  net_salary DECIMAL(15,2) DEFAULT 0,
  bank_paid_amount DECIMAL(15,2) DEFAULT 0,
  difference_amount DECIMAL(15,2) DEFAULT 0,
  metadata_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(paye_reconciliation_id, employee_id, month_key)
);

CREATE TABLE IF NOT EXISTS paye_employee_income_lines (
  id SERIAL PRIMARY KEY,
  paye_employee_line_id INTEGER NOT NULL REFERENCES paye_employee_lines(id) ON DELETE CASCADE,
  income_type_key VARCHAR(100) NOT NULL,
  amount DECIMAL(15,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paye_employee_deduction_lines (
  id SERIAL PRIMARY KEY,
  paye_employee_line_id INTEGER NOT NULL REFERENCES paye_employee_lines(id) ON DELETE CASCADE,
  deduction_type_key VARCHAR(100) NOT NULL,
  amount DECIMAL(15,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- 5. ROW LEVEL SECURITY (RLS) — Company Isolation
-- =============================================================================
-- Enable RLS on all tables with company_id.
-- The service-role key bypasses RLS (used by backend).
-- These policies apply only to the anon/authenticated keys.

-- Enable RLS
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_company_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tills ENABLE ROW LEVEL SECURITY;
ALTER TABLE till_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vat_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_payroll_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_recurring_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslip_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_historical ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_kv_store_eco ENABLE ROW LEVEL SECURITY;

-- Accounting tables RLS
ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_lines ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 6. HELPER FUNCTIONS
-- =============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables with updated_at
CREATE TRIGGER update_companies_updated_at BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_payroll_periods_updated_at BEFORE UPDATE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_payroll_transactions_updated_at BEFORE UPDATE ON payroll_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employee_payroll_setup_updated_at BEFORE UPDATE ON employee_payroll_setup FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employee_bank_details_updated_at BEFORE UPDATE ON employee_bank_details FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Accounting triggers
CREATE TRIGGER update_chart_of_accounts_updated_at BEFORE UPDATE ON chart_of_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_journal_entries_updated_at BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_bank_accounts_updated_at BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_bank_transactions_updated_at BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_financial_periods_updated_at BEFORE UPDATE ON financial_periods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customer_invoices_updated_at BEFORE UPDATE ON customer_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_supplier_invoices_updated_at BEFORE UPDATE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================================================
-- 7. SEED DATA — SA Tax Tables (2024/2025)
-- =============================================================================
-- This would normally be in a separate seed file. Included here for completeness.

-- You can run this to create default payroll items for a company:
-- SELECT initialize_payroll_defaults(1);  -- pass company_id

CREATE OR REPLACE FUNCTION initialize_payroll_defaults(p_company_id INTEGER)
RETURNS VOID AS $$
BEGIN
  -- Default earning types
  INSERT INTO payroll_items_master (company_id, item_code, item_name, item_type, category, is_taxable, is_recurring, sort_order)
  VALUES
    (p_company_id, 'BASIC', 'Basic Salary', 'earning', 'salary', true, true, 1),
    (p_company_id, 'OT_NORMAL', 'Overtime (1.5x)', 'earning', 'overtime', true, false, 10),
    (p_company_id, 'OT_SUNDAY', 'Sunday Overtime (2x)', 'earning', 'overtime', true, false, 11),
    (p_company_id, 'OT_PUBLIC', 'Public Holiday (2x)', 'earning', 'overtime', true, false, 12),
    (p_company_id, 'TRAVEL', 'Travel Allowance', 'earning', 'allowance', true, true, 20),
    (p_company_id, 'CELL', 'Cellphone Allowance', 'earning', 'allowance', true, true, 21),
    (p_company_id, 'BONUS', 'Bonus', 'earning', 'bonus', true, false, 30),
    (p_company_id, 'COMMISSION', 'Commission', 'earning', 'commission', true, false, 31)
  ON CONFLICT (company_id, item_code) DO NOTHING;

  -- Default deduction types
  INSERT INTO payroll_items_master (company_id, item_code, item_name, item_type, category, is_taxable, is_recurring, sort_order)
  VALUES
    (p_company_id, 'PAYE', 'PAYE Income Tax', 'deduction', 'tax', false, true, 1),
    (p_company_id, 'UIF_EMP', 'UIF (Employee)', 'deduction', 'statutory', false, true, 2),
    (p_company_id, 'PENSION', 'Pension Fund', 'deduction', 'retirement', true, true, 10),
    (p_company_id, 'PROVIDENT', 'Provident Fund', 'deduction', 'retirement', true, true, 11),
    (p_company_id, 'MED_AID', 'Medical Aid', 'deduction', 'medical', false, true, 20),
    (p_company_id, 'LOAN', 'Loan Repayment', 'deduction', 'other', false, false, 30)
  ON CONFLICT (company_id, item_code) DO NOTHING;

  -- Company contributions
  INSERT INTO payroll_items_master (company_id, item_code, item_name, item_type, category, is_taxable, is_recurring, sort_order)
  VALUES
    (p_company_id, 'UIF_ER', 'UIF (Employer)', 'company_contribution', 'statutory', false, true, 1),
    (p_company_id, 'SDL', 'Skills Development Levy', 'company_contribution', 'statutory', false, true, 2)
  ON CONFLICT (company_id, item_code) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- KV STORE TABLES — Added for cloud storage migration (no browser localStorage)
-- All business data is stored here instead of browser localStorage.
-- ============================================================================

-- Global ecosystem KV store (frontend-ecosystem)
CREATE TABLE IF NOT EXISTS app_kv_store (
  company_id  TEXT        NOT NULL,
  key         TEXT        NOT NULL,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

-- POS module KV store (accounting-ecosystem frontend-pos)
CREATE TABLE IF NOT EXISTS pos_kv_store (
  company_id  TEXT        NOT NULL,
  key         TEXT        NOT NULL,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

-- Accounting module KV store (accounting-ecosystem frontend-accounting)
-- Note: accounting_kv_store already existed; this is a safety guard
CREATE TABLE IF NOT EXISTS accounting_kv_store (
  company_id  TEXT        NOT NULL,
  key         TEXT        NOT NULL,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);
