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

    // ── 3c. Add COA enhancement columns to accounts (safe on existing tables) ──
    const accountEnhancementColumns = [
      ['sub_type',        'VARCHAR(50)'],
      ['reporting_group', 'VARCHAR(100)'],
      ['sort_order',      'INTEGER DEFAULT 0'],
      ['vat_code',        'VARCHAR(20)'],
    ];
    for (const [col, type] of accountEnhancementColumns) {
      await client.query(
        `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ${col} ${type}`
      );
    }

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

    // ── 22a. COA Templates ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS coa_templates (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        description TEXT,
        industry    VARCHAR(100) DEFAULT 'general',
        is_default  BOOLEAN DEFAULT false,
        version     VARCHAR(20) DEFAULT '1.0',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 22b. COA Template Accounts ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS coa_template_accounts (
        id               SERIAL PRIMARY KEY,
        template_id      INTEGER NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
        code             VARCHAR(20) NOT NULL,
        name             VARCHAR(255) NOT NULL,
        type             VARCHAR(50) NOT NULL,
        sub_type         VARCHAR(50),
        reporting_group  VARCHAR(100),
        parent_code      VARCHAR(20),
        description      TEXT,
        sort_order       INTEGER DEFAULT 0,
        is_system_account BOOLEAN DEFAULT false,
        vat_code         VARCHAR(20),
        UNIQUE(template_id, code)
      )
    `);

    // ── 22c. COA Segments (schema-ready for cost-centre / farming dimensions) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS coa_segments (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name        VARCHAR(100) NOT NULL,
        description TEXT,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS coa_segment_values (
        id          SERIAL PRIMARY KEY,
        segment_id  INTEGER NOT NULL REFERENCES coa_segments(id) ON DELETE CASCADE,
        code        VARCHAR(50) NOT NULL,
        name        VARCHAR(255) NOT NULL,
        is_active   BOOLEAN DEFAULT true,
        UNIQUE(segment_id, code)
      )
    `);

    // ── 22d. Seed Standard SA Base COA Template (idempotent) ─────────────────
    await seedCOABaseTemplate(client);

    // ── 22e. Template hierarchy + Sean AI metadata on coa_templates ───────────
    await client.query(`ALTER TABLE coa_templates ADD COLUMN IF NOT EXISTS parent_template_id INTEGER REFERENCES coa_templates(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE coa_templates ADD COLUMN IF NOT EXISTS sean_metadata JSONB DEFAULT '{}'::jsonb`);

    // ── 22f. company_template_assignments — which templates each company used ─
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_template_assignments (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        template_id    INTEGER NOT NULL REFERENCES coa_templates(id),
        applied_at     TIMESTAMPTZ DEFAULT NOW(),
        accounts_added INTEGER DEFAULT 0,
        UNIQUE(company_id, template_id)
      )
    `);

    // ── 22g. Segment dimension on journal_lines (dimensional reporting) ────────
    await client.query(`ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS segment_value_id INTEGER REFERENCES coa_segment_values(id) ON DELETE SET NULL`);

    // ── 22h. Enhance coa_segment_values: sorting + colour for UI ──────────────
    await client.query(`ALTER TABLE coa_segment_values ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE coa_segment_values ADD COLUMN IF NOT EXISTS color VARCHAR(20)`);

    // ── 22i. Seed Farming SA Overlay Template (idempotent) ────────────────────
    await seedFarmingTemplate(client);

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
      'CREATE INDEX IF NOT EXISTS idx_coa_tmpl_accounts_tmpl ON coa_template_accounts(template_id)',
      'CREATE INDEX IF NOT EXISTS idx_accounts_sub_type ON accounts(company_id, sub_type)',
      'CREATE INDEX IF NOT EXISTS idx_accounts_sort ON accounts(company_id, sort_order)',
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

module.exports = { ensureAccountingSchema, seedDefaultAccounts, provisionFromTemplate, applyTemplateOverlay, getDefaultTemplate };

// ============================================================================
// COA Template — Standard SA Base (76 accounts)
// ============================================================================
// type field:    asset | liability | equity | income | expense  (DB constraint)
// sub_type:      current_asset | non_current_asset | current_liability |
//                non_current_liability | equity | operating_income | other_income |
//                cost_of_sales | operating_expense | finance_cost | depreciation_amort
// reporting_group: used for frontend grouping within sub_type
// sort_order:    numeric sort key (matches account code for natural ordering)
// ============================================================================

const STANDARD_SA_BASE = [
  // ── ASSETS — Current (1000–1599) ─────────────────────────────────────────
  // code, name, type, sub_type, reporting_group, description, sort_order, is_system
  ['1000', 'Cash on Hand',                         'asset', 'current_asset',     'bank_cash',               'Cash held on premises or in till',                                    1000, false],
  ['1010', 'Bank — Cheque Account',                'asset', 'current_asset',     'bank_cash',               'Primary business cheque/current account',                             1010, false],
  ['1020', 'Petty Cash',                           'asset', 'current_asset',     'bank_cash',               'Small cash float for minor expenses',                                 1020, false],
  ['1030', 'Bank — Savings / Call Account',        'asset', 'current_asset',     'bank_cash',               'Business savings account or call deposit earning interest',           1030, false],
  ['1100', 'Accounts Receivable',                  'asset', 'current_asset',     'debtors',                 'Amounts owed by customers for goods or services',                     1100, false],
  ['1110', 'Allowance for Doubtful Debts',         'asset', 'current_asset',     'debtors',                 'Contra asset — provision for bad debts',                              1110, false],
  ['1200', 'Inventory',                            'asset', 'current_asset',     'inventory',               'Stock of goods held for resale or production',                        1200, false],
  ['1300', 'Prepaid Expenses',                     'asset', 'current_asset',     'prepayments',             'Expenses paid in advance (insurance, rent)',                          1300, false],
  ['1400', 'VAT Input (Claimable)',                'asset', 'current_asset',     'vat_asset',               'VAT paid on business purchases — claimable from SARS',                1400, false],
  ['1500', 'Other Current Assets',                 'asset', 'current_asset',     'other_current_asset',     'Sundry short-term assets not classified above',                       1500, false],
  // ── ASSETS — Non-Current / Fixed (1600–1799) ─────────────────────────────
  ['1600', 'Land and Buildings',                   'asset', 'non_current_asset', 'fixed_assets',            'Property owned by the business',                                      1600, false],
  ['1610', 'Plant and Machinery',                  'asset', 'non_current_asset', 'fixed_assets',            'Production plant, equipment, and machinery',                          1610, false],
  ['1620', 'Motor Vehicles',                       'asset', 'non_current_asset', 'fixed_assets',            'Vehicles owned by the business',                                      1620, false],
  ['1630', 'Office Furniture and Equipment',       'asset', 'non_current_asset', 'fixed_assets',            'Desks, chairs, and office fittings',                                  1630, false],
  ['1640', 'Computer Equipment',                   'asset', 'non_current_asset', 'fixed_assets',            'Computers, servers, and peripherals',                                 1640, false],
  ['1700', 'Accum Depreciation — Buildings',       'asset', 'non_current_asset', 'accumulated_depreciation','Contra asset — accumulated depreciation on buildings',                1700, false],
  ['1710', 'Accum Depreciation — Plant',           'asset', 'non_current_asset', 'accumulated_depreciation','Contra asset — accumulated depreciation on plant and machinery',       1710, false],
  ['1720', 'Accum Depreciation — Vehicles',        'asset', 'non_current_asset', 'accumulated_depreciation','Contra asset — accumulated depreciation on motor vehicles',           1720, false],
  ['1730', 'Accum Depreciation — Equipment',       'asset', 'non_current_asset', 'accumulated_depreciation','Contra asset — accumulated depreciation on office and IT equipment',  1730, false],
  // ── ASSETS — Intangible (1800–1899) ──────────────────────────────────────
  ['1800', 'Goodwill',                             'asset', 'non_current_asset', 'fixed_assets',            'Goodwill acquired on purchase of a business',                         1800, false],
  ['1810', 'Trademarks, Patents and Licences',     'asset', 'non_current_asset', 'fixed_assets',            'Registered intellectual property and exclusive licences',             1810, false],
  ['1850', 'Long-term Investments',                'asset', 'non_current_asset', 'fixed_assets',            'Shares, bonds, and other investments held for more than 12 months',   1850, false],
  ['1900', 'Accum Amortisation — Intangibles',     'asset', 'non_current_asset', 'accumulated_depreciation','Contra asset — accumulated amortisation on intangible assets',         1900, false],

  // ── LIABILITIES — Current (2000–2599) ────────────────────────────────────
  ['2000', 'Accounts Payable',                     'liability', 'current_liability',     'creditors',         'Amounts owed to suppliers for goods and services',                  2000, false],
  ['2050', 'Credit Card Payable',                  'liability', 'current_liability',     'creditors',         'Outstanding balance on business credit card',                        2050, false],
  ['2100', 'Short-term Loans',                     'liability', 'current_liability',     'short_term_loans',  'Loans and credit facilities due within 12 months',                  2100, false],
  ['2110', 'Bank Overdraft',                       'liability', 'current_liability',     'bank_cash',         'Overdraft balance on business bank account',                        2110, false],
  ['2200', 'Accrued Expenses',                     'liability', 'current_liability',     'accruals',          'Expenses incurred but not yet billed or paid',                      2200, false],
  ['2210', 'Customer Deposits Received',           'liability', 'current_liability',     'accruals',          'Deposits received from customers ahead of delivery',                2210, false],
  ['2300', 'VAT Output (Payable)',                 'liability', 'current_liability',     'vat_liability',     'VAT collected from customers — payable to SARS',                    2300, false],
  ['2400', 'PAYE / UIF Payable',                   'liability', 'current_liability',     'paye_payable',      'Employee PAYE and UIF deductions withheld — payable to SARS',       2400, false],
  ['2410', 'SDL Payable',                          'liability', 'current_liability',     'paye_payable',      'Skills Development Levy payable to SARS',                           2410, false],
  ['2500', 'Income Tax Payable',                   'liability', 'current_liability',     'tax_payable',       'Provisional and assessed income tax payable to SARS',               2500, false],
  ['2600', 'Dividends Payable',                    'liability', 'current_liability',     'accruals',          'Dividends declared but not yet paid to shareholders',               2600, false],
  // ── LIABILITIES — Non-Current (2700–2799) ────────────────────────────────
  ['2700', 'Long-term Loans',                      'liability', 'non_current_liability', 'long_term_loans',   'Loans and borrowings due after 12 months',                          2700, false],
  ['2710', 'Finance Lease Obligations',            'liability', 'non_current_liability', 'long_term_loans',   'Capital lease liabilities (vehicles, equipment)',                   2710, false],
  ['2750', 'Deferred Tax Liability',               'liability', 'non_current_liability', 'long_term_loans',   'Tax liability arising from temporary differences between accounting and tax',  2750, false],

  // ── EQUITY (3000–3299) ────────────────────────────────────────────────────
  ['3000', "Owner's Equity / Share Capital",       'equity', 'equity', 'share_capital',     'Capital contributed by owners or shareholders',                                       3000, false],
  ['3100', 'Retained Earnings',                    'equity', 'equity', 'retained_earnings', 'Accumulated net profits retained in the business',                                    3100, false],
  ['3200', 'Drawings',                             'equity', 'equity', 'drawings',          'Amounts withdrawn by owners from the business',                                       3200, false],

  // ── INCOME — Operating (4000–4499) ───────────────────────────────────────
  ['4000', 'Sales Revenue',                        'income', 'operating_income', 'operating_income', 'Revenue from sales of goods to customers',                                   4000, false],
  ['4100', 'Service Revenue',                      'income', 'operating_income', 'operating_income', 'Revenue from services rendered to clients',                                  4100, false],
  ['4200', 'Commission Income',                    'income', 'operating_income', 'operating_income', 'Commission earned on sales or referrals',                                    4200, false],
  ['4300', 'Contract Revenue',                     'income', 'operating_income', 'operating_income', 'Revenue from long-term contracts or projects',                               4300, false],
  // ── INCOME — Other (4500–4999) ────────────────────────────────────────────
  ['4500', 'Interest Received',                    'income', 'other_income', 'other_income', 'Interest earned on bank accounts and investments',                                   4500, false],
  ['4600', 'Rental Income',                        'income', 'other_income', 'other_income', 'Rental income from property or assets leased out',                                   4600, false],
  ['4700', 'Profit on Disposal of Assets',         'income', 'other_income', 'other_income', 'Gain on sale of fixed assets',                                                       4700, false],
  ['4800', 'Other Income',                         'income', 'other_income', 'other_income', 'Sundry income not classifiable above',                                               4800, false],

  // ── COST OF SALES (5000–5999) ─────────────────────────────────────────────
  ['5000', 'Cost of Sales — Materials',            'expense', 'cost_of_sales', 'cost_of_sales', 'Direct cost of materials or stock sold',                                          5000, false],
  ['5100', 'Cost of Sales — Direct Labour',        'expense', 'cost_of_sales', 'cost_of_sales', 'Labour directly attributable to goods or services sold',                         5100, false],
  ['5200', 'Freight and Delivery — Inward',        'expense', 'cost_of_sales', 'cost_of_sales', 'Shipping and freight costs to receive stock',                                     5200, false],
  ['5300', 'Subcontractors and Outsourcing',       'expense', 'cost_of_sales', 'cost_of_sales', 'Third-party labour or services directly tied to sales',                          5300, false],
  ['5400', 'Inventory Write-offs',                 'expense', 'cost_of_sales', 'cost_of_sales', 'Stock written off due to damage, expiry, or obsolescence',                       5400, false],

  // ── OPERATING EXPENSES — Personnel (6000–6099) ───────────────────────────
  ['6000', 'Salaries and Wages',                   'expense', 'operating_expense', 'personnel', 'Employee salaries, wages, and overtime',                                         6000, false],
  ['6010', 'Bonuses and Incentives',               'expense', 'operating_expense', 'personnel', 'Performance bonuses and incentive payments',                                      6010, false],
  ['6020', 'Employer UIF Contributions',           'expense', 'operating_expense', 'personnel', 'Employer share of UIF contributions',                                             6020, false],
  ['6030', 'Employer SDL Contributions',           'expense', 'operating_expense', 'personnel', 'Skills Development Levy paid by employer',                                        6030, false],
  ['6040', 'Medical Aid — Employer Contribution',  'expense', 'operating_expense', 'personnel', 'Employer contribution to employee medical aid',                                   6040, false],
  ['6050', 'Pension / Provident — Employer',       'expense', 'operating_expense', 'personnel', 'Employer contribution to pension or provident fund',                              6050, false],
  ['6060', 'Staff Training and Welfare',           'expense', 'operating_expense', 'personnel', 'Staff development, training, and welfare costs',                                  6060, false],
  ['6070', 'Recruitment and HR Costs',             'expense', 'operating_expense', 'personnel', 'Recruitment agency fees, job advertising, and HR administration',                 6070, false],
  // ── OPERATING EXPENSES — Occupancy (6100–6199) ───────────────────────────
  ['6100', 'Rent — Office / Premises',             'expense', 'operating_expense', 'occupancy', 'Office, factory, or retail premises rental',                                      6100, false],
  ['6110', 'Rates and Taxes',                      'expense', 'operating_expense', 'occupancy', 'Municipal rates and property taxes',                                              6110, false],
  ['6120', 'Electricity and Water',                'expense', 'operating_expense', 'occupancy', 'Utilities consumed at business premises',                                         6120, false],
  ['6130', 'Cleaning and Maintenance',             'expense', 'operating_expense', 'occupancy', 'Premises cleaning, repairs, and routine maintenance',                             6130, false],
  ['6140', 'Security and Alarm Costs',             'expense', 'operating_expense', 'occupancy', 'Security guards, alarm monitoring, and access control costs',                     6140, false],
  // ── OPERATING EXPENSES — Communication (6200–6299) ───────────────────────
  ['6200', 'Telephone and Internet',               'expense', 'operating_expense', 'communication', 'Landline, mobile, and internet costs',                                        6200, false],
  ['6210', 'Postage and Courier',                  'expense', 'operating_expense', 'communication', 'Postage, courier, and delivery costs',                                        6210, false],
  // ── OPERATING EXPENSES — Motor Vehicle (6300–6399) ───────────────────────
  ['6300', 'Motor Vehicle — Fuel',                 'expense', 'operating_expense', 'motor', 'Fuel costs for business vehicles',                                                    6300, false],
  ['6310', 'Motor Vehicle — Repairs and Maintenance','expense','operating_expense', 'motor', 'Vehicle servicing, tyres, and repairs',                                              6310, false],
  ['6320', 'Motor Vehicle — Insurance and Licensing','expense','operating_expense', 'motor', 'Vehicle insurance premiums and licence fees',                                        6320, false],
  ['6330', 'Travel and Accommodation',             'expense', 'operating_expense', 'motor', 'Business travel, flights, hotels, and subsistence',                                   6330, false],
  // ── OPERATING EXPENSES — Admin (6400–6499) ───────────────────────────────
  ['6400', 'Office Supplies and Stationery',       'expense', 'operating_expense', 'admin', 'Stationery, paper, pens, and consumables',                                            6400, false],
  ['6410', 'Printing and Photocopying',            'expense', 'operating_expense', 'admin', 'Printing, photocopying, and document costs',                                          6410, false],
  // ── OPERATING EXPENSES — IT and Software (6500–6599) ─────────────────────
  ['6500', 'Computer and IT Expenses',             'expense', 'operating_expense', 'it_software', 'Hardware repairs, accessories, and IT support',                                 6500, false],
  ['6510', 'Software Subscriptions',               'expense', 'operating_expense', 'it_software', 'Cloud software, SaaS subscriptions, and licences',                              6510, false],
  // ── OPERATING EXPENSES — Professional Fees (6600–6699) ───────────────────
  ['6600', 'Accounting and Audit Fees',            'expense', 'operating_expense', 'professional_fees', 'Fees paid to auditors and accounting firms',                              6600, false],
  ['6610', 'Legal and Compliance Fees',            'expense', 'operating_expense', 'professional_fees', 'Legal advice, CIPC filings, and compliance costs',                        6610, false],
  ['6620', 'Consulting Fees',                      'expense', 'operating_expense', 'professional_fees', 'Management consulting and specialist advisory fees',                      6620, false],
  // ── OPERATING EXPENSES — Banking (6700–6799) ─────────────────────────────
  ['6700', 'Bank Charges and Fees',                'expense', 'operating_expense', 'banking', 'Bank service fees, transaction charges, and merchant costs',                        6700, false],
  // ── OPERATING EXPENSES — Insurance (6800–6899) ───────────────────────────
  ['6800', 'Insurance — Business',                 'expense', 'operating_expense', 'insurance', 'Business insurance, public liability, and indemnity cover',                       6800, false],
  ['6810', 'Insurance — Assets',                   'expense', 'operating_expense', 'insurance', 'Insurance premiums for plant, equipment, and property',                           6810, false],
  // ── OPERATING EXPENSES — Marketing (6900–6949) ───────────────────────────
  ['6900', 'Marketing and Advertising',            'expense', 'operating_expense', 'marketing', 'Advertising, social media, and promotional material costs',                       6900, false],
  ['6910', 'Entertainment and Hospitality',        'expense', 'operating_expense', 'marketing', 'Client entertainment, meals, and business hospitality',                           6910, false],
  // ── OPERATING EXPENSES — Sundry (6950–6999) ──────────────────────────────
  ['6950', 'Donations and Subscriptions',          'expense', 'operating_expense', 'sundry', 'Charitable donations and professional membership subscriptions',                     6950, false],
  ['6990', 'Other Operating Expenses',             'expense', 'operating_expense', 'sundry', 'Miscellaneous operating expenses not classified above',                              6990, false],

  // ── FINANCE COSTS (7000–7499) ─────────────────────────────────────────────
  ['7000', 'Interest Expense — Bank Loans',        'expense', 'finance_cost', 'finance_costs', 'Interest on overdrafts and business loans',                                       7000, false],
  ['7010', 'Interest Expense — Finance Leases',    'expense', 'finance_cost', 'finance_costs', 'Finance charge portion of lease payments',                                        7010, false],
  ['7020', 'Other Finance Charges',                'expense', 'finance_cost', 'finance_costs', 'Sundry financial charges (factoring, facility fees)',                             7020, false],

  // ── DEPRECIATION AND AMORTISATION (7500–7999) ────────────────────────────
  ['7500', 'Depreciation — Buildings',             'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation charge on buildings',                                    7500, false],
  ['7510', 'Depreciation — Plant and Machinery',   'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation charge on plant and machinery',                          7510, false],
  ['7520', 'Depreciation — Motor Vehicles',        'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation charge on motor vehicles',                               7520, false],
  ['7530', 'Depreciation — Equipment',             'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation charge on office and IT equipment',                      7530, false],
  ['7540', 'Amortisation — Intangible Assets',     'expense', 'depreciation_amort', 'depreciation', 'Amortisation of patents, trademarks, and other intangibles',                7540, false],
];

const TEMPLATE_NAME = 'Standard SA Base';

/**
 * seedCOABaseTemplate(client)
 * Idempotently creates the Standard SA Base template and its accounts.
 * Safe to run on every startup — only inserts if the template doesn't exist.
 */
async function seedCOABaseTemplate(client) {
  // Check if template already exists
  const existing = await client.query(
    `SELECT id FROM coa_templates WHERE name = $1`,
    [TEMPLATE_NAME]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Create template record
  const tmplResult = await client.query(
    `INSERT INTO coa_templates (name, description, industry, is_default, version)
     VALUES ($1, $2, $3, true, '1.0')
     RETURNING id`,
    [
      TEMPLATE_NAME,
      'Standard South African Chart of Accounts suitable for most SME businesses. ' +
      'Structured for proper SA P&L reporting: Gross Profit → Operating Profit → Net Profit. ' +
      'Compliant with SARS reporting requirements.',
      'general',
    ]
  );
  const templateId = tmplResult.rows[0].id;

  // Insert all template accounts
  for (const [code, name, type, sub_type, reporting_group, description, sort_order, is_system_account] of STANDARD_SA_BASE) {
    await client.query(
      `INSERT INTO coa_template_accounts
         (template_id, code, name, type, sub_type, reporting_group, description, sort_order, is_system_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (template_id, code) DO NOTHING`,
      [templateId, code, name, type, sub_type, reporting_group, description, sort_order, is_system_account]
    );
  }

  console.log(`  📋 COA: Seeded "${TEMPLATE_NAME}" template (${STANDARD_SA_BASE.length} accounts)`);
  return templateId;
}

/**
 * getDefaultTemplate(client)
 * Returns { id, name } of the default COA template.
 */
async function getDefaultTemplate(client) {
  const result = await client.query(
    `SELECT id, name FROM coa_templates WHERE is_default = true ORDER BY id LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * provisionFromTemplate(companyId, client, templateId?)
 * Instantiates a COA template into the accounts table for a company.
 * Safe to call multiple times — checks if company already has accounts first.
 * If templateId is omitted, uses the default template.
 *
 * @returns {number} count of accounts inserted (0 if company already had accounts)
 */
async function provisionFromTemplate(companyId, client, templateId = null) {
  // Check if company already has accounts
  const existing = await client.query(
    'SELECT COUNT(*) FROM accounts WHERE company_id = $1',
    [companyId]
  );
  if (parseInt(existing.rows[0].count) > 0) return 0;

  // Resolve template
  let tmplId = templateId;
  if (!tmplId) {
    const dflt = await getDefaultTemplate(client);
    if (!dflt) throw new Error('No default COA template found. Run ensureAccountingSchema first.');
    tmplId = dflt.id;
  }

  // Fetch template accounts
  const tmplAccounts = await client.query(
    `SELECT * FROM coa_template_accounts WHERE template_id = $1 ORDER BY sort_order, code`,
    [tmplId]
  );

  if (tmplAccounts.rows.length === 0) {
    throw new Error(`COA template ${tmplId} has no accounts.`);
  }

  // Insert into accounts table (including vat_code from template)
  let inserted = 0;
  for (const ta of tmplAccounts.rows) {
    const result = await client.query(
      `INSERT INTO accounts
         (company_id, code, name, type, sub_type, reporting_group, description,
          sort_order, vat_code, is_active, is_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false)
       ON CONFLICT (company_id, code) DO NOTHING
       RETURNING id`,
      [companyId, ta.code, ta.name, ta.type, ta.sub_type, ta.reporting_group,
       ta.description, ta.sort_order, ta.vat_code || null]
    );
    if (result.rows.length > 0) inserted++;
  }

  // Record which template was applied (idempotent)
  await client.query(
    `INSERT INTO company_template_assignments (company_id, template_id, accounts_added)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, template_id) DO UPDATE SET accounts_added = EXCLUDED.accounts_added`,
    [companyId, tmplId, inserted]
  );

  return inserted;
}

/**
 * seedDefaultAccounts(companyId, client)
 * Legacy entry point — delegates to provisionFromTemplate with default template.
 * Preserved for backwards-compatibility with existing callers.
 */
async function seedDefaultAccounts(companyId, client) {
  return provisionFromTemplate(companyId, client);
}

// ============================================================================
// COA Template — Farming SA Overlay (industry-specific accounts)
// ============================================================================
// This is an OVERLAY template — it adds farming-specific accounts to a company
// that has already provisioned the Standard SA Base template.
// It uses applyTemplateOverlay() not provisionFromTemplate().
//
// Account ranges used (all within standard numbering to avoid clashes):
//   1250–1290  Biological assets (livestock, growing crops, nursery stock)
//   4050–4090  Farming income streams
//   5050–5090  Direct farming cost of sales
//   6080–6089  Farming-specific labour (not in base)
//   7550–7590  Depreciation on farming-specific assets
// ============================================================================

const FARMING_SA_OVERLAY = [
  // ── BIOLOGICAL ASSETS — Current (livestock held for sale, growing crops) ──
  // These are current assets when expected to be sold within 12 months
  ['1250', 'Livestock — Cattle (Current)',          'asset', 'current_asset',     'inventory',               'Cattle and other livestock held for sale within 12 months (at NRV)',  1250, false],
  ['1255', 'Livestock — Small Stock (Current)',     'asset', 'current_asset',     'inventory',               'Sheep, goats, pigs, and poultry held for sale within 12 months',      1255, false],
  ['1260', 'Growing Crops — In Field',              'asset', 'current_asset',     'inventory',               'Cost of crops in the ground not yet harvested',                       1260, false],
  ['1265', 'Harvested Produce — In Store',          'asset', 'current_asset',     'inventory',               'Harvested grain, fruit, nuts, or produce awaiting sale',              1265, false],
  ['1270', 'Nursery Stock and Seedlings',           'asset', 'current_asset',     'inventory',               'Plant nursery stock and seedlings held for sale',                     1270, false],
  // ── BIOLOGICAL ASSETS — Non-Current (bearer plants, breeding stock) ────────
  ['1660', 'Bearer Plants — Orchards and Vineyards','asset', 'non_current_asset', 'fixed_assets',            'Permanent orchards, vineyards, and plantations (IAS 16)',             1660, false],
  ['1670', 'Livestock — Breeding Stock',            'asset', 'non_current_asset', 'fixed_assets',            'Breeding animals retained for long-term production (IAS 41)',         1670, false],
  ['1680', 'Irrigation and Water Infrastructure',   'asset', 'non_current_asset', 'fixed_assets',            'Irrigation systems, dams, and water distribution infrastructure',      1680, false],
  ['1690', 'Fencing and Farm Structures',           'asset', 'non_current_asset', 'fixed_assets',            'Game fencing, kraals, sheds, silos, and farm buildings',              1690, false],
  ['1740', 'Accum Depreciation — Bearer Plants',    'asset', 'non_current_asset', 'accumulated_depreciation','Contra asset — accumulated depreciation on orchards and plantations',  1740, false],
  ['1750', 'Accum Depreciation — Farm Infrastructure','asset','non_current_asset','accumulated_depreciation','Contra asset — accumulated depreciation on irrigation and structures',  1750, false],
  // ── FARMING INCOME (4050–4099) ─────────────────────────────────────────────
  ['4050', 'Cattle Sales',                          'income', 'operating_income', 'operating_income', 'Proceeds from sale of cattle and calves',                                    4050, false],
  ['4055', 'Small Stock Sales',                     'income', 'operating_income', 'operating_income', 'Proceeds from sale of sheep, goats, pigs, and poultry',                     4055, false],
  ['4060', 'Grain Crop Sales',                      'income', 'operating_income', 'operating_income', 'Revenue from maize, wheat, sorghum, soybeans, and other grain crops',       4060, false],
  ['4065', 'Fruit and Vegetable Sales',             'income', 'operating_income', 'operating_income', 'Revenue from fresh fruit, vegetables, and produce',                         4065, false],
  ['4070', 'Nut Sales',                             'income', 'operating_income', 'operating_income', 'Revenue from macadamia, pecan, and other nut crops',                        4070, false],
  ['4075', 'Dairy Sales',                           'income', 'operating_income', 'operating_income', 'Revenue from milk, cream, and other dairy products',                        4075, false],
  ['4080', 'Game Sales and Trophy Fees',            'income', 'operating_income', 'operating_income', 'Revenue from live game sales, trophy hunting, and game auctions',           4080, false],
  ['4085', 'Agri-Tourism and Accommodation',        'income', 'other_income',     'other_income',     'Income from farm stays, tours, activities, and events',                     4085, false],
  ['4090', 'Government Grants — Farming',           'income', 'other_income',     'other_income',     'DAFF grants, CASP grants, and other agricultural subsidies',                4090, false],
  // ── DIRECT FARMING COST OF SALES (5050–5099) ──────────────────────────────
  ['5050', 'Livestock Purchases',                   'expense', 'cost_of_sales', 'cost_of_sales', 'Purchase cost of cattle, sheep, and other livestock bought for resale',          5050, false],
  ['5055', 'Animal Feed and Supplements',           'expense', 'cost_of_sales', 'cost_of_sales', 'Feed, licks, minerals, and nutritional supplements for livestock',              5055, false],
  ['5060', 'Veterinary and Animal Health',          'expense', 'cost_of_sales', 'cost_of_sales', 'Vet fees, vaccines, dipping, dosing, and animal health products',               5060, false],
  ['5065', 'Seeds and Planting Material',           'expense', 'cost_of_sales', 'cost_of_sales', 'Crop seeds, seedlings, cuttings, and grafted plants',                           5065, false],
  ['5070', 'Fertilisers and Soil Amendments',       'expense', 'cost_of_sales', 'cost_of_sales', 'Fertiliser, lime, compost, and soil conditioners applied to crops',             5070, false],
  ['5075', 'Pesticides, Herbicides and Fungicides', 'expense', 'cost_of_sales', 'cost_of_sales', 'Chemical crop protection products and application costs',                       5075, false],
  ['5080', 'Irrigation and Water Costs',            'expense', 'cost_of_sales', 'cost_of_sales', 'Water levies, irrigation electricity, and pump maintenance allocated to crops', 5080, false],
  ['5085', 'Harvesting and Transport',              'expense', 'cost_of_sales', 'cost_of_sales', 'Contract harvesting, transport to market, and post-harvest handling',           5085, false],
  ['5090', 'Packing Materials and Cold Storage',    'expense', 'cost_of_sales', 'cost_of_sales', 'Cartons, bags, pallets, grading, and cold chain storage costs',                 5090, false],
  // ── FARMING OPERATING EXPENSES (6080–6089) ────────────────────────────────
  ['6080', 'Casual and Seasonal Farm Labour',       'expense', 'operating_expense', 'personnel', 'Casual and seasonal labour not included in permanent payroll',                   6080, false],
  ['6085', 'Labour Housing and Amenities',          'expense', 'operating_expense', 'personnel', 'Farm worker housing maintenance, water, and sanitation costs',                   6085, false],
  // ── DEPRECIATION — Farming-Specific (7550–7599) ───────────────────────────
  ['7550', 'Depreciation — Bearer Plants',          'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation on orchards, vineyards, and permanent plantations',     7550, false],
  ['7560', 'Depreciation — Farm Infrastructure',    'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation on irrigation, fencing, and farm structures',           7560, false],
  ['7570', 'Depreciation — Farm Equipment',         'expense', 'depreciation_amort', 'depreciation', 'Annual depreciation on tractors, combine harvesters, and implements',       7570, false],
];

const FARMING_TEMPLATE_NAME = 'Farming SA Overlay';

/**
 * seedFarmingTemplate(client)
 * Idempotently creates the Farming SA Overlay template.
 * This is an overlay — it extends Standard SA Base, not a standalone template.
 */
async function seedFarmingTemplate(client) {
  // Check if already seeded
  const existing = await client.query(
    `SELECT id FROM coa_templates WHERE name = $1`,
    [FARMING_TEMPLATE_NAME]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Get parent template (Standard SA Base)
  const parent = await client.query(
    `SELECT id FROM coa_templates WHERE name = $1`,
    [TEMPLATE_NAME]
  );
  const parentId = parent.rows.length > 0 ? parent.rows[0].id : null;

  // Create farming overlay template
  const tmplResult = await client.query(
    `INSERT INTO coa_templates (name, description, industry, is_default, version, parent_template_id, sean_metadata)
     VALUES ($1, $2, $3, false, '1.0', $4, $5)
     RETURNING id`,
    [
      FARMING_TEMPLATE_NAME,
      'Farming-specific accounts for South African agricultural businesses. ' +
      'Apply as an overlay on top of Standard SA Base. Covers biological assets (livestock, crops, orchards), ' +
      'farming income streams, direct farming costs, and farming-specific depreciation.',
      'farming',
      parentId,
      JSON.stringify({
        overlay: true,
        requires_base_template: TEMPLATE_NAME,
        industry_segments_suggested: ['Enterprise', 'Cattle', 'Grain', 'Fruit', 'Game'],
        sean_notes: 'Use coa_segments to create enterprise dimension for this company after provisioning.',
      }),
    ]
  );
  const templateId = tmplResult.rows[0].id;

  // Insert farming accounts
  for (const [code, name, type, sub_type, reporting_group, description, sort_order, is_system_account] of FARMING_SA_OVERLAY) {
    await client.query(
      `INSERT INTO coa_template_accounts
         (template_id, code, name, type, sub_type, reporting_group, description, sort_order, is_system_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (template_id, code) DO NOTHING`,
      [templateId, code, name, type, sub_type, reporting_group, description, sort_order, is_system_account]
    );
  }

  console.log(`  🌾 COA: Seeded "${FARMING_TEMPLATE_NAME}" overlay template (${FARMING_SA_OVERLAY.length} accounts)`);
  return templateId;
}

/**
 * applyTemplateOverlay(companyId, client, templateId)
 * Adds overlay template accounts to a company that has ALREADY been provisioned
 * with a base template. Unlike provisionFromTemplate, this works on companies
 * that already have accounts — it only adds accounts that don't yet exist.
 *
 * Use case: A farming client who already has Standard SA Base gets Farming SA Overlay applied.
 *
 * @returns {number} count of new accounts added
 */
async function applyTemplateOverlay(companyId, client, templateId) {
  // Verify company has accounts (overlay requires existing COA)
  const existing = await client.query(
    'SELECT COUNT(*) FROM accounts WHERE company_id = $1',
    [companyId]
  );
  if (parseInt(existing.rows[0].count) === 0) {
    throw new Error('Cannot apply overlay: company has no base chart of accounts. Provision a base template first.');
  }

  // Verify template exists and is an overlay (has parent_template_id)
  const tmpl = await client.query(
    `SELECT id, name, parent_template_id FROM coa_templates WHERE id = $1`,
    [templateId]
  );
  if (tmpl.rows.length === 0) {
    throw new Error(`COA template ${templateId} not found.`);
  }

  // Fetch template accounts
  const tmplAccounts = await client.query(
    `SELECT * FROM coa_template_accounts WHERE template_id = $1 ORDER BY sort_order, code`,
    [templateId]
  );

  if (tmplAccounts.rows.length === 0) {
    throw new Error(`COA template ${templateId} has no accounts.`);
  }

  // Insert only accounts that don't already exist for this company
  let inserted = 0;
  for (const ta of tmplAccounts.rows) {
    const result = await client.query(
      `INSERT INTO accounts
         (company_id, code, name, type, sub_type, reporting_group, description,
          sort_order, vat_code, is_active, is_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false)
       ON CONFLICT (company_id, code) DO NOTHING
       RETURNING id`,
      [companyId, ta.code, ta.name, ta.type, ta.sub_type, ta.reporting_group,
       ta.description, ta.sort_order, ta.vat_code || null]
    );
    if (result.rows.length > 0) inserted++;
  }

  // Record assignment (idempotent)
  await client.query(
    `INSERT INTO company_template_assignments (company_id, template_id, accounts_added)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, template_id) DO UPDATE SET accounts_added = EXCLUDED.accounts_added`,
    [companyId, templateId, inserted]
  );

  return inserted;
}
