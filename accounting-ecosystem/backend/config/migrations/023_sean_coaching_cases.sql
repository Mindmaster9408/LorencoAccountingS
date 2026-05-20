-- =============================================================================
-- Migration 023: SEAN Coaching Cases + Audit Log
-- =============================================================================
-- Creates the coaching case store and audit log table for the Sean AI
-- Coaching module.
--
-- PRIVACY RULES (see coaching-engine.js + coaching-routes.js):
--   - Cases are company-scoped: company A cannot read company B cases
--   - Cases may contain sensitive emotional/behavioural content
--   - Do NOT label users with diagnoses — these are "signals" only
--   - All access is logged in sean_coaching_audit_log
--
-- GOVERNANCE:
--   - coaching_case_created, coaching_chat_submitted, coaching_response_suggested,
--     coaching_feedback_saved, coaching_pattern_built are all audited
--
-- Run in Supabase SQL Editor. Idempotent — safe to re-run.
-- =============================================================================

-- ── Main coaching case store ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sean_coaching_cases (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- The input that triggered this case (the coaching question or statement)
    trigger_phrase      TEXT,

    -- Extended context around the trigger (background, situation)
    context             TEXT,

    -- Detected personality/emotional signals from coaching-engine.js
    -- Stored as: { signals: [{label, score, matchedKeywords}], dominant: string }
    -- These are coaching signals ONLY — NOT medical or psychological diagnoses
    personality_signals JSONB DEFAULT '{}'::jsonb,

    -- Broad emotional state label: 'anxious', 'stuck', 'motivated', etc.
    emotional_state     TEXT,

    -- The coaching response that was used / suggested
    response_used       TEXT,

    -- What outcome was reported: 'positive', 'negative', 'neutral', 'unknown'
    outcome             TEXT,

    -- Grouped pattern label for clustering similar cases
    pattern_group       TEXT,

    -- Confidence score [0..1] — from engine or from manual entry
    confidence          NUMERIC(5,4) CHECK (confidence >= 0 AND confidence <= 1),

    -- True when this case was learned from user feedback (not manually entered)
    learned_from_user   BOOLEAN NOT NULL DEFAULT false,

    -- Who created this case (user email or system identifier)
    created_by          TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_sean_coaching_company_id
    ON sean_coaching_cases (company_id);

CREATE INDEX IF NOT EXISTS idx_sean_coaching_pattern_group
    ON sean_coaching_cases (company_id, pattern_group)
    WHERE pattern_group IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sean_coaching_created_at
    ON sean_coaching_cases (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sean_coaching_learned
    ON sean_coaching_cases (company_id, learned_from_user)
    WHERE learned_from_user = true;

CREATE INDEX IF NOT EXISTS idx_sean_coaching_emotional_state
    ON sean_coaching_cases (company_id, emotional_state)
    WHERE emotional_state IS NOT NULL;

-- ── Audit log for all coaching actions ───────────────────────────────────────
-- Logged actions:
--   coaching_case_created
--   coaching_chat_submitted
--   coaching_response_suggested
--   coaching_feedback_saved
--   coaching_pattern_built
CREATE TABLE IF NOT EXISTS sean_coaching_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    company_id  INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    user_id     TEXT,
    action      VARCHAR(100) NOT NULL,
    case_id     BIGINT REFERENCES sean_coaching_cases(id) ON DELETE SET NULL,
    confidence  NUMERIC(5,4),
    -- Extra context: pattern_group, input_length, signal_count, etc.
    -- No raw sensitive text in this column — summary only
    metadata    JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sean_coaching_audit_company
    ON sean_coaching_audit_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sean_coaching_audit_action
    ON sean_coaching_audit_log (action, created_at DESC);

-- =============================================================================
-- Verification query — run after migration to confirm tables exist
-- =============================================================================
SELECT
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns c2
     WHERE c2.table_name = t.table_name) AS column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN ('sean_coaching_cases', 'sean_coaching_audit_log')
ORDER BY table_name;
