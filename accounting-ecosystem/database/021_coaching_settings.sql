-- Migration 021: Coaching settings storage
-- Stores global app configuration: company details, branding, report templates.
-- Previously stored in browser localStorage — migrated to server so settings
-- persist across devices and browsers.
--
-- Run once against the production database.
-- Safe to re-run (CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS coaching_settings (
    id            SERIAL      PRIMARY KEY,
    settings_key  VARCHAR(50) NOT NULL DEFAULT 'global',
    settings_data JSONB       NOT NULL DEFAULT '{}',
    updated_at    TIMESTAMPTZ          DEFAULT NOW(),
    CONSTRAINT coaching_settings_key_unique UNIQUE (settings_key)
);

-- Seed one global row so GET /api/coaching/settings always finds a row.
INSERT INTO coaching_settings (settings_key, settings_data)
VALUES ('global', '{}')
ON CONFLICT (settings_key) DO NOTHING;
