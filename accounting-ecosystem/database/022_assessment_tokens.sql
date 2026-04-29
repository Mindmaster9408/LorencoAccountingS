-- Migration 022: Assessment token storage for the client-facing assessment portal
-- Tokens are single-use links a coach sends to a client so they can complete
-- their BASIS assessment independently.  Previously stored in browser localStorage
-- (broken: only worked in the coach's own browser).  Migrated to server so any
-- browser can validate and submit.
--
-- Run once against the production database.
-- Safe to re-run (CREATE TABLE / INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS coaching_assessment_tokens (
    id           SERIAL       PRIMARY KEY,
    token        VARCHAR(400) NOT NULL UNIQUE,
    client_id    INTEGER      NOT NULL REFERENCES coaching_clients(id) ON DELETE CASCADE,
    client_name  VARCHAR(255),
    created_at   TIMESTAMPTZ  DEFAULT NOW(),
    expires_at   TIMESTAMPTZ  DEFAULT (NOW() + INTERVAL '30 days'),
    completed    BOOLEAN      DEFAULT FALSE,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_coaching_assessment_tokens_token
    ON coaching_assessment_tokens (token);
