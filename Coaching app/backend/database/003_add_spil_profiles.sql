-- Migration 003: Add spil_profiles table
-- SPIL-E Personality Profile Engine
--
-- Parallel to basis_submissions — completely separate module.
-- Does NOT affect basis_submissions or any existing table.
--
-- SPIL dimensions: STRUKTUUR, PRESTASIE, INSIG, LIEFDE, EMOSIE, INISIATIEF
-- 10 questions per dimension = 60 total answers per profile
-- Scoring: simple SUM per dimension (1–10 scale, no reverse scoring)

CREATE TABLE IF NOT EXISTS spil_profiles (
    id SERIAL PRIMARY KEY,

    -- Respondent identity
    respondent_name     TEXT NOT NULL,
    respondent_email    TEXT,
    respondent_phone    TEXT,

    preferred_lang      TEXT DEFAULT 'en',

    -- Raw answers — flat format: { "STRUKTUUR_1": 7, "PRESTASIE_1": 4, ... }
    answers             JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Computed results — populated after engine runs
    -- { STRUKTUUR: 72, PRESTASIE: 65, INSIG: 80, LIEFDE: 55, EMOSIE: 60, INISIATIEF: 78 }
    scores              JSONB,

    -- Ranked dimension order (highest to lowest, tie-breaker applied)
    -- ["INSIG", "INISIATIEF", "PRESTASIE", "EMOSIE", "STRUKTUUR", "LIEFDE"]
    ranking             JSONB,

    -- Generated SPIL code string
    -- "INSIG – INISIATIEF – PRESTASIE – EMOSIE – STRUKTUUR – LIEFDE"
    spil_code           TEXT,

    -- Full report snapshot (generated, system-authored)
    -- { markdown: "...", generatedAt: "..." }
    report_generated    JSONB,

    -- Internal coach notes (editable, separate from generated report)
    -- { coachNotes: "...", nextSteps: "..." }
    report_internal     JSONB,

    -- Ownership and linking
    created_by_user_id  INTEGER,
    linked_client_id    INTEGER,

    -- Lifecycle timestamps
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common lookup patterns
CREATE INDEX IF NOT EXISTS idx_spil_profiles_client
    ON spil_profiles(linked_client_id);

CREATE INDEX IF NOT EXISTS idx_spil_profiles_user
    ON spil_profiles(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_spil_profiles_email
    ON spil_profiles(respondent_email);
