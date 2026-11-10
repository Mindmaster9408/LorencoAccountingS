-- ============================================================================
-- Migration 176: SEVCO help chatbot — questions, answers and feedback
-- ============================================================================
-- Ruan 2026-11-10: SEVCO is the brain; every app's chatbot gets its knowledge
-- there. The knowledge itself lives in sean_knowledge_items (domain e.g.
-- 'PAYTIME_HELP', one row per language 'AF'/'EN' sharing a slug, status
-- DRAFT → APPROVED by a super user, versioned via superseded_by_id) — no new
-- table for that.
--
-- This table keeps each question asked in an app's chatbot:
--   - the articles that matched (shown immediately, no AI needed)
--   - the local AI answer (Ollama on Ruan's computer, via local_ai_jobs)
--   - thumbs up/down
-- Unmatched questions and thumbs-down are the "what is missing" list in SEVCO.
-- The bot never learns by itself: a super user writes/approves the article.
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sevco_help_questions (
  id              BIGSERIAL    PRIMARY KEY,
  app             TEXT         NOT NULL,                 -- 'paytime', later 'leo', 'charlie' …
  company_id      INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         INTEGER      NULL,
  language        TEXT         NOT NULL DEFAULT 'AF' CHECK (language IN ('AF', 'EN')),
  question        TEXT         NOT NULL CHECK (char_length(question) BETWEEN 2 AND 1000),
  matched_slugs   TEXT[]       NOT NULL DEFAULT '{}',
  match_score     NUMERIC(8,3) NULL,
  status          TEXT         NOT NULL CHECK (status IN ('matched', 'unmatched')),
  ai_status       TEXT         NOT NULL DEFAULT 'none'
                               CHECK (ai_status IN ('none', 'queued', 'done', 'failed')),
  ai_answer       TEXT         NULL,
  ai_model        TEXT         NULL,
  feedback        TEXT         NULL CHECK (feedback IS NULL OR feedback IN ('up', 'down')),
  feedback_note   TEXT         NULL,
  reviewed_at     TIMESTAMPTZ  NULL,                     -- a super user dealt with it in SEVCO
  reviewed_by     INTEGER      NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sevco_help_questions_review
  ON sevco_help_questions (app, reviewed_at, created_at DESC);
ALTER TABLE sevco_help_questions ENABLE ROW LEVEL SECURITY;

-- Help articles are looked up by app domain + language + status.
CREATE INDEX IF NOT EXISTS idx_sean_knowledge_items_help
  ON sean_knowledge_items (domain, language, status);

COMMENT ON TABLE sevco_help_questions IS
  'SEVCO help chatbot: questions, matched articles, local AI answer, feedback. Migration 176.';
