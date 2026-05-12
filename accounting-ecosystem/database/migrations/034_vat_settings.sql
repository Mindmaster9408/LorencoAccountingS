-- ============================================================================
-- Migration 034: VAT Settings Table
-- ============================================================================
-- Creates the vat_settings table used by:
--   - /api/accounting/vat-settings (list, create, update, deactivate)
--   - /api/accounting/vat-settings/active (active VAT categories for a date)
--   - Bank allocation UI (VAT category dropdown)
--   - Supplier and customer invoice VAT calculations
--
-- One row per VAT category per company. Supports multiple rates over time
-- via effective_from / effective_to. Soft-delete via is_active = false.
--
-- NOTE: The server auto-creates this table at startup via accounting-schema.js.
-- Run this manually in Supabase SQL Editor only if the auto-migration has not
-- yet run (e.g. ACCOUNTING_DATABASE_URL is not configured on the server).
--
-- company_id is INTEGER (matches the accounting module's companies.id type).
-- No RLS — the accounting module uses the Supabase service role client, which
-- bypasses RLS. Application-level isolation is enforced via company_id filter
-- in every query.
-- ============================================================================

CREATE TABLE IF NOT EXISTS vat_settings (
    id             SERIAL PRIMARY KEY,
    company_id     INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code           VARCHAR(30)  NOT NULL,           -- e.g. 'standard', 'zero', 'exempt'
    name           VARCHAR(100) NOT NULL,           -- display label
    rate           NUMERIC(5,2) NOT NULL DEFAULT 0, -- 0 = exempt/zero, 15 = 15%
    is_capital     BOOLEAN      NOT NULL DEFAULT FALSE, -- true for capital goods (standard_capital)
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    effective_from DATE         NOT NULL DEFAULT '1990-01-01', -- rate applies from this date
    effective_to   DATE,                            -- NULL = currently active
    sort_order     INTEGER      NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ           DEFAULT NOW(),

    -- Each company can only have one row per (code, effective_from) combination
    UNIQUE (company_id, code, effective_from)
);

-- Index for the most common query pattern: active settings for a company on a date
CREATE INDEX IF NOT EXISTS idx_vat_settings_company
    ON vat_settings (company_id, is_active);

-- ============================================================================
-- Seed SA Default VAT Categories for all existing companies
-- ============================================================================
-- After creating the table, seed defaults for every company that doesn't have
-- any vat_settings yet. This mirrors what POST /api/accounting/vat-settings/seed-defaults does.
--
-- Uncomment and run this block only if you want to auto-seed all companies:
--
-- INSERT INTO vat_settings (company_id, code, name, rate, is_capital, is_active, effective_from, sort_order)
-- SELECT
--     c.id,
--     v.code, v.name, v.rate::NUMERIC(5,2), v.is_capital, v.is_active, v.effective_from::DATE, v.sort_order
-- FROM companies c
-- CROSS JOIN (
--     VALUES
--     ('standard',         'Standard Rate (15%)',           15, false, true,  '2018-04-01', 10),
--     ('standard_capital', 'Standard Rate — Capital (15%)', 15, true,  true,  '2018-04-01', 20),
--     ('zero',             'Zero Rated (0%)',                0, false, true,  '1990-01-01', 30),
--     ('exempt',           'Exempt',                         0, false, true,  '1990-01-01', 40),
--     ('old_rate',         'Old Rate (14%)',                14, false, false, '1990-01-01', 50),
--     ('old_rate_capital', 'Old Rate — Capital (14%)',      14, true,  false, '1990-01-01', 60)
-- ) AS v(code, name, rate, is_capital, is_active, effective_from, sort_order)
-- WHERE NOT EXISTS (
--     SELECT 1 FROM vat_settings vs
--     WHERE vs.company_id = c.id AND vs.code = v.code AND vs.effective_from = v.effective_from::DATE
-- );
