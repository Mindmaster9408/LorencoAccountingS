-- ============================================================================
-- Migration 177: SEVCO help chatbot — 'advice' question status
-- ============================================================================
-- Ruan 2026-11-11: Pip (free) explains how the app works. Tax/advice questions
-- ("is a cellphone allowance taxable?", "which IRP5 code must I use?") belong to
-- the paid Sean AI add-on. Pip recognises them, answers with the paid add-on
-- message instead of an article, and records them with status 'advice' so
-- SEVCO shows which clients ask for that kind of help.
--
-- Until this runs the API stores such questions as 'unmatched' (same message to
-- the user), so nothing breaks. Idempotent.
-- ============================================================================

ALTER TABLE sevco_help_questions DROP CONSTRAINT IF EXISTS sevco_help_questions_status_check;
ALTER TABLE sevco_help_questions
  ADD CONSTRAINT sevco_help_questions_status_check CHECK (status IN ('matched', 'unmatched', 'advice'));
