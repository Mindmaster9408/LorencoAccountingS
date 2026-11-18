-- ============================================================================
-- Migration 185: help bots — "explain step by step" follow-ups (Pip, Lenny)
-- ============================================================================
-- Ruan 2026-11-17: the first answer stays the approved article (no AI). Only
-- when the client asks further does the local AI explain THAT article in small,
-- simple steps, as a conversation. Never tax/accounting advice.
--
--   kind       'ask'     = a first question (articles only)
--              'explain' = a follow-up on an earlier question (parent_id)
--   parent_id  the first question the follow-up belongs to (same company)
--   ai_status  + 'blocked' = the server's answer check rejected the AI answer
--              (numbers/codes/tax words not in the article) — the client never
--              sees it; it shows up in SEVCO's "questions to deal with".
-- Idempotent.
-- ============================================================================

ALTER TABLE sevco_help_questions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE sevco_help_questions ADD COLUMN IF NOT EXISTS parent_id BIGINT NULL
  REFERENCES sevco_help_questions(id) ON DELETE CASCADE;

-- How many of the article's steps the client had already been shown (so the AI
-- continues from there instead of starting over).
ALTER TABLE sevco_help_questions ADD COLUMN IF NOT EXISTS at_step SMALLINT NULL;

ALTER TABLE sevco_help_questions DROP CONSTRAINT IF EXISTS sevco_help_questions_kind_check;
ALTER TABLE sevco_help_questions
  ADD CONSTRAINT sevco_help_questions_kind_check CHECK (kind IN ('ask', 'explain'));

ALTER TABLE sevco_help_questions DROP CONSTRAINT IF EXISTS sevco_help_questions_ai_status_check;
ALTER TABLE sevco_help_questions
  ADD CONSTRAINT sevco_help_questions_ai_status_check CHECK (ai_status IN ('none', 'queued', 'done', 'failed', 'blocked'));

CREATE INDEX IF NOT EXISTS idx_sevco_help_questions_parent
  ON sevco_help_questions (parent_id, id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sevco_help_questions_company_recent
  ON sevco_help_questions (company_id, created_at DESC);
