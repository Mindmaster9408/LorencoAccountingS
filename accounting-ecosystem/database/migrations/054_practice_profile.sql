-- ============================================================================
-- 054_practice_profile.sql
-- Practice Profile — tenant-level identity for the accounting firm itself.
-- One row per company. Separate from practice_clients (which are the firm's
-- own clients). This table stores the FIRM'S practice identity, billing
-- defaults, branding, and compliance notes.
--
-- Critical distinction:
--   practice_profiles → the accounting firm using Lorenco Practice
--   practice_clients  → that firm's own client files
--
-- Companies table already holds: company_name, trading_name,
-- registration_number, contact_email, contact_phone, website, address_*.
-- This table focuses on practice-SPECIFIC fields not present there.
-- ============================================================================

CREATE TABLE IF NOT EXISTS practice_profiles (
    id                          SERIAL PRIMARY KEY,
    company_id                  INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,

    -- Practice Identity (practice-specific — not in companies table)
    tax_practitioner_number     TEXT,
    vat_registration_number     TEXT,
    practice_type               TEXT CHECK (practice_type IN (
                                    'sole_proprietor', 'partnership', 'company', 'cc', 'trust', 'other'
                                )),

    -- Practice Contact (may differ from company defaults in companies table)
    practice_email              TEXT,
    practice_phone              TEXT,
    practice_website            TEXT,

    -- Practice Physical Address
    address_line1               TEXT,
    address_line2               TEXT,
    address_city                TEXT,
    address_province            TEXT CHECK (address_province IN (
                                    'Gauteng', 'Western Cape', 'Eastern Cape', 'KwaZulu-Natal',
                                    'Free State', 'Limpopo', 'Mpumalanga', 'North West',
                                    'Northern Cape'
                                )),
    address_postal_code         TEXT,

    -- Workflow Defaults
    default_hourly_rate         NUMERIC(10, 2) CHECK (default_hourly_rate IS NULL OR default_hourly_rate >= 0),
    default_currency            TEXT NOT NULL DEFAULT 'ZAR',
    fiscal_year_end_month       INTEGER CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
    -- Soft reference to user ID (no FK to avoid cross-schema issues with auth.users)
    default_task_assignee_id    INTEGER,

    -- Branding
    primary_colour              TEXT,
    logo_url                    TEXT,

    -- Compliance / Internal Notes
    compliance_notes            TEXT,

    -- Flexible key-value store for future settings without schema migrations
    settings                    JSONB NOT NULL DEFAULT '{}',

    -- Audit timestamps (updated_at managed by application PUT handler, no trigger needed)
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_profiles_company ON practice_profiles(company_id);

COMMENT ON TABLE practice_profiles IS
    'Tenant-level profile for the accounting practice itself (NOT client data). '
    'One row per company. Stores practice identity, billing defaults, and branding. '
    'General company fields (name, trading name, reg number) live in the companies table.';

COMMENT ON COLUMN practice_profiles.tax_practitioner_number IS
    'SARS Tax Practitioner registration number for the firm.';

COMMENT ON COLUMN practice_profiles.vat_registration_number IS
    'VAT number of the practice itself. Separate from any client VAT numbers.';

COMMENT ON COLUMN practice_profiles.default_task_assignee_id IS
    'Soft reference to user ID. No FK constraint — validated at application layer. '
    'Used to pre-populate the assignee field when creating new tasks.';

COMMENT ON COLUMN practice_profiles.fiscal_year_end_month IS
    'Default fiscal year end month (1=Jan, 2=Feb, ..., 12=Dec). '
    'Used to calculate provisional tax and year-end deadlines.';

COMMENT ON COLUMN practice_profiles.settings IS
    'Flexible JSONB for future feature flags and preferences without schema migrations. '
    'E.g. { "auto_deadline_generation": true, "default_vat_period": "bi-monthly" }';
