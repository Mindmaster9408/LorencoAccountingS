-- Migration 005: Add photo and notes columns to coaching_clients table
-- These fields are required for the client details tab (photo upload + coach notes).
-- Run in the ecosystem Supabase (glkndlzjkhwfsolueyhk) — the shared DB that holds all coaching_* tables.
-- Safe to run multiple times — uses IF NOT EXISTS guard.

-- Add missing columns to coaching_clients
ALTER TABLE coaching_clients
    ADD COLUMN IF NOT EXISTS photo TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- Add last_login column to coaching_users if missing (used by auth.routes.js)
ALTER TABLE coaching_users
    ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;

-- Create coaching_basis_submissions table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS coaching_basis_submissions (
    id                  SERIAL PRIMARY KEY,
    mode                TEXT NOT NULL DEFAULT 'coach_capture',
    status              TEXT NOT NULL DEFAULT 'draft',
    access_token        TEXT UNIQUE,
    respondent_name     TEXT NOT NULL,
    respondent_email    TEXT,
    respondent_phone    TEXT,
    preferred_lang      TEXT NOT NULL DEFAULT 'en',
    linked_lead_id      INTEGER,
    linked_client_id    INTEGER REFERENCES coaching_clients(id) ON DELETE SET NULL,
    created_by_user_id  INTEGER REFERENCES coaching_users(id) ON DELETE SET NULL,
    basis_answers       JSONB NOT NULL DEFAULT '{}'::jsonb,
    basis_results       JSONB,
    report_generated    JSONB,
    report_editable     JSONB NOT NULL DEFAULT '{}'::jsonb,
    source              TEXT NOT NULL DEFAULT 'coach_capture',
    submitted_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_basis_submissions_token  ON coaching_basis_submissions(access_token);
CREATE INDEX IF NOT EXISTS idx_coaching_basis_submissions_client ON coaching_basis_submissions(linked_client_id);
CREATE INDEX IF NOT EXISTS idx_coaching_basis_submissions_user   ON coaching_basis_submissions(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_coaching_basis_submissions_status ON coaching_basis_submissions(status);
