-- ============================================================================
-- 161_sean_intent_patterns_missing_columns.sql
-- ============================================================================
-- 159_sean_intent_patterns.sql was written from a summarized catalog of
-- sean-webapp's IntentPattern Prisma model and missed two fields that model
-- actually has: `provider` (which LLM produced a learned entry; null for
-- seeded ones) and `reasoning` (short LLM justification, kept for
-- debugging). Caught before any application code went live against this
-- table (zero rows exist), so a plain idempotent ADD COLUMN is sufficient —
-- no backfill needed.
-- ============================================================================

ALTER TABLE sean_intent_patterns
  ADD COLUMN IF NOT EXISTS provider  TEXT,
  ADD COLUMN IF NOT EXISTS reasoning TEXT;
