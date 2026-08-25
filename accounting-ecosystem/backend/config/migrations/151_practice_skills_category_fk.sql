-- =============================================================================
-- Migration 151: Add the 2 category_id FKs missed by migration 150
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: migration 150's generator script deliberately excluded
-- `category_id` as ambiguous during exploration (it could mean
-- practice_skill_categories for either practice_skills or
-- practice_certifications) but the final generator never added a
-- resolution rule for it, so both were silently omitted from the 198.
-- Confirmed live after migration 150 ran: both still fail with the same
-- PGRST200 "no relationship found" error.
--
-- Fix: add both, same NOT VALID safe pattern as migration 150.
-- =============================================================================

ALTER TABLE practice_skills ADD CONSTRAINT practice_skills_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES practice_skill_categories(id) NOT VALID;

ALTER TABLE practice_certifications ADD CONSTRAINT practice_certifications_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES practice_skill_categories(id) NOT VALID;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT conname FROM pg_constraint
WHERE conname IN ('practice_skills_category_id_fkey', 'practice_certifications_category_id_fkey');
