-- ============================================================
-- 056 — Practice Client CRM Expansion
-- Extends practice_clients with CRM fields and creates
-- practice_client_contacts sub-table.
-- Safe: all ADD COLUMN IF NOT EXISTS — existing rows unaffected.
-- ============================================================

-- ── A. Extend practice_clients ────────────────────────────────────────────────

-- Entity type
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'company'
    CHECK (client_type IN ('company','cc','trust','partnership','sole_proprietor','individual','other'));

-- Additional contact
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS secondary_phone TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS website TEXT;

-- Fiscal year as integer (keeps fiscal_year_end TEXT for backward compat)
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS financial_year_end_month INTEGER
    CHECK (financial_year_end_month BETWEEN 1 AND 12);

-- Individual taxpayer fields (only populated when client_type = 'individual')
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS id_number TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS passport_number TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- Tax reference numbers
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS income_tax_number TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS paye_reference_number TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS uif_reference_number TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS sdl_reference_number TEXT;

-- Compliance flags
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS vat_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS paye_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS provisional_taxpayer BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS uif_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS sdl_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS coida_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS cipc_registered BOOLEAN NOT NULL DEFAULT FALSE;

-- Physical address (structured, replaces free-text address column which remains for backward compat)
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS address_province TEXT
    CHECK (address_province IN (
        'Eastern Cape','Free State','Gauteng','KwaZulu-Natal',
        'Limpopo','Mpumalanga','Northern Cape','North West','Western Cape'
    ));
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS address_postal_code TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS address_country TEXT NOT NULL DEFAULT 'South Africa';

-- Postal address
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_same_as_physical BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_address_line1 TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_address_line2 TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_city TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_province TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_postal_code TEXT;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS postal_country TEXT;

-- Practice ownership (soft refs — consistent with team member user_id pattern; no FK across schema)
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS responsible_team_member_id INTEGER;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS reviewer_team_member_id INTEGER;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS partner_team_member_id INTEGER;

-- Workflow status
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'active'
    CHECK (onboarding_status IN ('prospect','onboarding','active','on_hold','archived'));

-- Risk rating
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS risk_rating TEXT NOT NULL DEFAULT 'normal'
    CHECK (risk_rating IN ('low','normal','medium','high','flagged'));

-- Billing defaults
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS billing_rate_override NUMERIC(12,2)
    CHECK (billing_rate_override >= 0);
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS billing_currency TEXT NOT NULL DEFAULT 'ZAR';
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER NOT NULL DEFAULT 30
    CHECK (payment_terms_days >= 0);

-- Internal notes (separate from client-visible notes)
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS internal_notes TEXT;

-- Settings blob for future extensibility
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';

-- Audit columns
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS updated_by INTEGER;

-- Indexes for common filter patterns
CREATE INDEX IF NOT EXISTS idx_practice_clients_company_type
    ON practice_clients (company_id, client_type);

CREATE INDEX IF NOT EXISTS idx_practice_clients_company_onboarding
    ON practice_clients (company_id, onboarding_status);

CREATE INDEX IF NOT EXISTS idx_practice_clients_company_responsible
    ON practice_clients (company_id, responsible_team_member_id)
    WHERE responsible_team_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_practice_clients_company_risk
    ON practice_clients (company_id, risk_rating);

-- ── B. Create practice_client_contacts ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_client_contacts (
    id                          SERIAL PRIMARY KEY,
    company_id                  INTEGER NOT NULL,
    client_id                   INTEGER NOT NULL REFERENCES practice_clients(id) ON DELETE CASCADE,
    contact_name                TEXT NOT NULL,
    role                        TEXT,
    email                       TEXT,
    phone                       TEXT,
    mobile                      TEXT,
    is_primary                  BOOLEAN NOT NULL DEFAULT FALSE,
    receives_tax_correspondence  BOOLEAN NOT NULL DEFAULT FALSE,
    receives_billing            BOOLEAN NOT NULL DEFAULT FALSE,
    receives_payroll            BOOLEAN NOT NULL DEFAULT FALSE,
    receives_cipc               BOOLEAN NOT NULL DEFAULT FALSE,
    notes                       TEXT,
    is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by                  INTEGER,
    updated_by                  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_practice_client_contacts_client
    ON practice_client_contacts (client_id);

CREATE INDEX IF NOT EXISTS idx_practice_client_contacts_company_client
    ON practice_client_contacts (company_id, client_id);
