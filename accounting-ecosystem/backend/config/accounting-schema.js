/**
 * ============================================================================
 * Accounting Module — Auto Schema Migration
 * ============================================================================
 * Runs on server startup to ensure all accounting tables exist in Supabase.
 * Uses CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 * so it is safe to run on every startup.
 *
 * Call: await ensureAccountingSchema(pool)
 * where pool is a pg.Pool connected to Supabase direct PostgreSQL.
 * ============================================================================
 */

async function ensureAccountingSchema(pool) {
  const client = await pool.connect();
  try {
    console.log('  🔧 Accounting: Checking/creating schema...');

    // ── 1. Add SA-specific columns to companies table ─────────────────────────
    const companyColumns = [
      ['income_tax_number', 'VARCHAR(50)'],
      ['paye_reference',    'VARCHAR(50)'],
      ['uif_reference',     'VARCHAR(50)'],
      ['sdl_reference',     'VARCHAR(50)'],
      ['coid_number',       'VARCHAR(50)'],
      ['financial_year_end','VARCHAR(20)'],
      ['vat_period',        'VARCHAR(20)'],
      ['company_type',      'VARCHAR(50)'],
      ['physical_address',  'TEXT'],
      ['city',              'VARCHAR(100)'],
      ['postal_code',       'VARCHAR(20)'],
      ['postal_address',    'TEXT'],
      ['phone',             'VARCHAR(50)'],
      ['email',             'VARCHAR(255)'],
      ['website',           'VARCHAR(255)'],
      ['bank_name',         'VARCHAR(100)'],
      ['branch_code',       'VARCHAR(20)'],
      ['account_number',    'VARCHAR(50)'],
      ['account_type',      'VARCHAR(50)'],
      ['account_holder',    'VARCHAR(255)'],
      ['logo_url',          'TEXT'],
    ];
    for (const [col, type] of companyColumns) {
      await client.query(
        `ALTER TABLE companies ADD COLUMN IF NOT EXISTS ${col} ${type}`
      );
    }

    // ── 2. Accounting Periods ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounting_periods (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        from_date       DATE NOT NULL,
        to_date         DATE NOT NULL,
        is_locked       BOOLEAN DEFAULT false,
        locked_by_user_id INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 3. Chart of Accounts ──────────────────────────────────────────────────
    await client.query(`
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
      )
    `);

    // ── 3b. Add is_system column to accounts (safe on existing tables) ─────────
    await client.query(
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false`
    );

    // ── 4. Journal Headers ────────────────────────────────────────────────────
    await client.query(`
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
      )
    `);

    // ── 5. Journal Lines ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_lines (
        id          SERIAL PRIMARY KEY,
        journal_id  INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
        account_id  INTEGER NOT NULL REFERENCES accounts(id),
        line_number INTEGER,
        description TEXT,
        debit       NUMERIC(15,2) DEFAULT 0,
        credit      NUMERIC(15,2) DEFAULT 0,
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 6. Bank Accounts ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name                  VARCHAR(255) NOT NULL,
        bank_name             VARCHAR(255),
        account_number_masked VARCHAR(50),
        currency              VARCHAR(10) DEFAULT 'ZAR',
        ledger_account_id     INTEGER REFERENCES accounts(id),
        opening_balance       NUMERIC(15,2) DEFAULT 0,
        opening_balance_date  DATE,
        is_active             BOOLEAN DEFAULT true,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 7. Bank Transactions ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_transactions (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        bank_account_id     INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
        date                DATE NOT NULL,
        description         TEXT,
        amount              NUMERIC(15,2) NOT NULL,
        balance             NUMERIC(15,2),
        reference           VARCHAR(255),
        external_id         VARCHAR(255),
        status              VARCHAR(20) DEFAULT 'unmatched',
        matched_entity_type VARCHAR(50),
        matched_entity_id   INTEGER,
        matched_by_user_id  INTEGER REFERENCES users(id),
        reconciled_at       TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 8. Bank Transaction Attachments ───────────────────────────────────────
    await client.query(`
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
      )
    `);

    // ── 9. VAT Periods ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vat_periods (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        period_key              VARCHAR(20) NOT NULL,
        from_date               DATE NOT NULL,
        to_date                 DATE NOT NULL,
        filing_frequency        VARCHAR(20) DEFAULT 'bi-monthly',
        status                  VARCHAR(20) DEFAULT 'open',
        locked_by_user_id       INTEGER REFERENCES users(id),
        locked_at               TIMESTAMPTZ,
        submitted_by_user_id    INTEGER REFERENCES users(id),
        submitted_at            TIMESTAMPTZ,
        submission_reference    VARCHAR(100),
        payment_date            DATE,
        created_at              TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, period_key)
      )
    `);

    // ── 10. VAT Reconciliations ───────────────────────────────────────────────
    await client.query(`
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
      )
    `);

    // ── 11. VAT Reconciliation Lines ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vat_reconciliation_lines (
        id                      SERIAL PRIMARY KEY,
        vat_reconciliation_id   INTEGER NOT NULL REFERENCES vat_reconciliations(id) ON DELETE CASCADE,
        section_key             VARCHAR(50),
        row_key                 VARCHAR(100),
        label                   TEXT,
        line_order              INTEGER,
        vat_amount              NUMERIC(15,2) DEFAULT 0,
        tb_amount               NUMERIC(15,2) DEFAULT 0,
        statement_amount        NUMERIC(15,2) DEFAULT 0,
        difference_amount       NUMERIC(15,2) DEFAULT 0,
        account_id              INTEGER REFERENCES accounts(id),
        metadata                JSONB DEFAULT '{}'
      )
    `);

    // ── 12. VAT Submissions ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vat_submissions (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        vat_period_id           INTEGER NOT NULL REFERENCES vat_periods(id),
        vat_reconciliation_id   INTEGER REFERENCES vat_reconciliations(id),
        submission_date         DATE,
        submitted_by_user_id    INTEGER REFERENCES users(id),
        submission_reference    VARCHAR(100),
        output_vat              NUMERIC(15,2),
        input_vat               NUMERIC(15,2),
        net_vat                 NUMERIC(15,2),
        payment_date            DATE,
        payment_reference       VARCHAR(100),
        created_at              TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 13. VAT Reports ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vat_reports (
        id              SERIAL PRIMARY KEY,
        vat_period_id   INTEGER NOT NULL REFERENCES vat_periods(id),
        status          VARCHAR(20) DEFAULT 'draft',
        locked_by_user_id INTEGER REFERENCES users(id),
        locked_at       TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 14. PAYE Config — Income Types ────────────────────────────────────────
    await client.query(`
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
      )
    `);

    // ── 15. PAYE Config — Deduction Types ─────────────────────────────────────
    await client.query(`
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
      )
    `);

    // ── 16. PAYE Reconciliations ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS paye_reconciliations (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        paye_period_id        VARCHAR(20) NOT NULL,
        status                VARCHAR(20) DEFAULT 'draft',
        created_by_user_id    INTEGER REFERENCES users(id),
        approved_by_user_id   INTEGER REFERENCES users(id),
        approved_at           TIMESTAMPTZ,
        locked_at             TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 17. PAYE Employee Lines ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS paye_employee_lines (
        id                        SERIAL PRIMARY KEY,
        paye_reconciliation_id    INTEGER NOT NULL REFERENCES paye_reconciliations(id) ON DELETE CASCADE,
        employee_id               INTEGER NOT NULL REFERENCES employees(id),
        month_key                 VARCHAR(20) NOT NULL,
        gross_income              NUMERIC(15,2) DEFAULT 0,
        total_deductions          NUMERIC(15,2) DEFAULT 0,
        net_salary                NUMERIC(15,2) DEFAULT 0,
        bank_paid_amount          NUMERIC(15,2) DEFAULT 0,
        difference_amount         NUMERIC(15,2) DEFAULT 0,
        metadata_json             JSONB DEFAULT '{}',
        created_at                TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 18. PAYE Employee Income Lines ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS paye_employee_income_lines (
        id                    SERIAL PRIMARY KEY,
        paye_employee_line_id INTEGER NOT NULL REFERENCES paye_employee_lines(id) ON DELETE CASCADE,
        income_type_key       VARCHAR(100) NOT NULL,
        amount                NUMERIC(15,2) DEFAULT 0
      )
    `);

    // ── 19. PAYE Employee Deduction Lines ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS paye_employee_deduction_lines (
        id                    SERIAL PRIMARY KEY,
        paye_employee_line_id INTEGER NOT NULL REFERENCES paye_employee_lines(id) ON DELETE CASCADE,
        deduction_type_key    VARCHAR(100) NOT NULL,
        amount                NUMERIC(15,2) DEFAULT 0
      )
    `);

    // ── 20. Accounting Audit Log (separate from ecosystem audit_log) ──────────
    await client.query(`
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
      )
    `);

    // ── 21. POS Reconciliations (cash/card daily settlement tracking) ─────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_reconciliations (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL,
        date                    DATE NOT NULL,
        payment_method          VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'card')),
        pos_amount              DECIMAL(12,2) NOT NULL DEFAULT 0,
        bank_amount             DECIMAL(12,2) NOT NULL DEFAULT 0,
        journal_id              INTEGER,
        bank_description        TEXT,
        notes                   TEXT,
        reconciled_by_user_id   INTEGER,
        reconciled_at           TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, date, payment_method)
      )
    `);

    // ── 22. Indexes for performance ───────────────────────────────────────────
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_journals_company_date ON journals(company_id, date)',
      'CREATE INDEX IF NOT EXISTS idx_journal_lines_journal ON journal_lines(journal_id)',
      'CREATE INDEX IF NOT EXISTS idx_bank_txn_account ON bank_transactions(bank_account_id)',
      'CREATE INDEX IF NOT EXISTS idx_bank_txn_status ON bank_transactions(company_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_vat_periods_company ON vat_periods(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_paye_recon_company ON paye_reconciliations(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_accounting_audit ON accounting_audit_log(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_pos_recon_company ON pos_reconciliations(company_id, date)',
    ];
    for (const idx of indexes) {
      await client.query(idx);
    }

    console.log('  ✅ Accounting schema ready');
  } catch (err) {
    console.error('  ❌ Accounting schema migration failed:', err.message);
    // Non-fatal — server continues; accounting features may not work until fixed
  } finally {
    client.release();
  }
}

module.exports = { ensureAccountingSchema, seedDefaultAccounts };

/**
 * seedDefaultAccounts(companyId, client)
 * Seeds a standard SA chart of accounts for a company that has none.
 * Safe to call multiple times — checks count before inserting.
 */
async function seedDefaultAccounts(companyId, client) {
  const existing = await client.query(
    'SELECT COUNT(*) FROM accounts WHERE company_id = $1',
    [companyId]
  );
  if (parseInt(existing.rows[0].count) > 0) return 0; // already has accounts

  const accounts = [
    // ── Assets 1xxx ────────────────────────────────
    ['1000', 'Cash and Bank',              'asset',     'Main operating bank / cash account'],
    ['1100', 'Accounts Receivable',        'asset',     'Amounts owed by customers'],
    ['1200', 'Inventory',                  'asset',     'Stock held for resale'],
    ['1300', 'Prepaid Expenses',           'asset',     'Expenses paid in advance'],
    ['1400', 'VAT Input (Claimable)',      'asset',     'VAT paid on purchases — claimable from SARS'],
    ['1500', 'Fixed Assets',               'asset',     'Property, plant and equipment'],
    ['1510', 'Accumulated Depreciation',   'asset',     'Contra asset — accumulated depreciation'],
    // ── Liabilities 2xxx ───────────────────────────
    ['2000', 'Accounts Payable',           'liability', 'Amounts owed to suppliers'],
    ['2100', 'Short-term Loans',           'liability', 'Loans due within 12 months'],
    ['2200', 'Accrued Expenses',           'liability', 'Expenses incurred but not yet paid'],
    ['2300', 'VAT Output (Payable)',       'liability', 'VAT collected from customers — payable to SARS'],
    ['2400', 'PAYE / UIF Payable',         'liability', 'Employee tax withheld — payable to SARS'],
    ['2500', 'Long-term Loans',            'liability', 'Loans due after 12 months'],
    // ── Equity 3xxx ────────────────────────────────
    ['3000', 'Owner\'s Equity / Share Capital', 'equity', 'Capital contributed by owners'],
    ['3100', 'Retained Earnings',          'equity',    'Accumulated profits retained in the business'],
    // ── Income 4xxx ────────────────────────────────
    ['4000', 'Sales Revenue',              'income',    'Revenue from sales of goods'],
    ['4100', 'Service Revenue',            'income',    'Revenue from services rendered'],
    ['4200', 'Other Income',               'income',    'Interest received, sundry income'],
    // ── Expenses 5xxx-6xxx ─────────────────────────
    ['5000', 'Cost of Sales',              'expense',   'Cost of goods sold'],
    ['6000', 'Salaries and Wages',         'expense',   'Employee salaries and wages'],
    ['6100', 'Rent',                       'expense',   'Office / premises rental'],
    ['6200', 'Telephone and Internet',     'expense',   'Communication costs'],
    ['6300', 'Office Supplies',            'expense',   'Stationery and consumables'],
    ['6400', 'Motor Vehicle Expenses',     'expense',   'Fuel, repairs, licensing'],
    ['6500', 'Bank Charges',               'expense',   'Bank fees and transaction charges'],
    ['6600', 'Insurance',                  'expense',   'Business insurance premiums'],
    ['6700', 'Marketing and Advertising',  'expense',   'Promotion and advertising costs'],
    ['6800', 'Depreciation',               'expense',   'Depreciation of fixed assets'],
    ['6900', 'Accounting and Audit Fees',  'expense',   'Professional accounting fees'],
    ['6950', 'Other Expenses',             'expense',   'Sundry and miscellaneous expenses'],
  ];

  for (const [code, name, type, description] of accounts) {
    await client.query(
      `INSERT INTO accounts (company_id, code, name, type, description, is_active, is_system)
       VALUES ($1, $2, $3, $4, $5, true, false)
       ON CONFLICT (company_id, code) DO NOTHING`,
      [companyId, code, name, type, description]
    );
  }

  return accounts.length;
}
