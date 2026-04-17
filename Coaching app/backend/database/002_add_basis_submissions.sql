-- Migration 002: Add basis_submissions table
-- Phase 2A: BASIS as External Entry Point into the Coaching System
--
-- Replaces the localStorage-based assessment token system with
-- a server-backed submissions table that supports a full lifecycle:
--   draft → submitted → reviewed → converted
--
-- Two modes are supported:
--   coach_capture  — coach fills in answers manually during a session
--   public_link    — client receives a link and completes independently

CREATE TABLE IF NOT EXISTS basis_submissions (
    id                  SERIAL PRIMARY KEY,

    -- Submission mode and lifecycle status
    mode                TEXT NOT NULL DEFAULT 'coach_capture',   -- 'coach_capture' | 'public_link'
    status              TEXT NOT NULL DEFAULT 'draft',           -- 'draft' | 'submitted' | 'reviewed' | 'converted'

    -- Server-issued token for public_link mode (replaces localStorage tokens)
    access_token        TEXT UNIQUE,

    -- Who the assessment is for
    respondent_name     TEXT NOT NULL,
    respondent_email    TEXT,
    respondent_phone    TEXT,
    preferred_lang      TEXT NOT NULL DEFAULT 'en',

    -- Links back to other entities
    linked_lead_id      INTEGER,   -- if converted from a public lead submission
    linked_client_id    INTEGER,   -- if linked to an existing coaching client
    created_by_user_id  INTEGER,   -- the coach who created/owns this submission

    -- Assessment data
    -- basis_answers stored in flat format: { "BALANS_1": 7, "AKSIE_1": 3, ... }
    basis_answers       JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Computed results: { sectionScores: {...}, basisOrder: [...], timestamp: "..." }
    basis_results       JSONB,

    -- Snapshot of the generated report: { markdown: "...", generatedAt: "..." }
    -- Stored so coach edits do not lose the original system-generated content.
    report_generated    JSONB,

    -- Coach-editable sections merged over report_generated at render time.
    -- Allowed keys: coachNotes, productsPage, invitationText, quotationText
    report_editable     JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Where this submission originated
    source              TEXT NOT NULL DEFAULT 'coach_capture',   -- 'coach_capture' | 'public_link' | 'lead_conversion'

    submitted_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common lookup patterns
CREATE INDEX IF NOT EXISTS idx_basis_submissions_token
    ON basis_submissions(access_token);

CREATE INDEX IF NOT EXISTS idx_basis_submissions_client
    ON basis_submissions(linked_client_id);

CREATE INDEX IF NOT EXISTS idx_basis_submissions_user
    ON basis_submissions(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_basis_submissions_status
    ON basis_submissions(status);
