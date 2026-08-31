-- ============================================================================
-- 159_sean_intent_patterns.sql
-- ============================================================================
-- New table for sean-webapp's chat intent-classification cache
-- (lib/intent-classifier.ts:classifyIntent()) — avoids re-calling the LLM
-- for a previously-seen phrasing. No existing SEVCO equivalent for this one
-- (it's sean-webapp-specific, not shared with the IRP5/bank-learning/
-- transaction-store pipelines), but it still goes through this .sql
-- pipeline rather than `prisma migrate`, for one consistent rule: any table
-- living in the shared brain space gets its DDL from the one auditable
-- pipeline the rest of backend/sean/ already uses. See
-- sean-webapp/prisma/schema.prisma's hand-authored IntentPattern model.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sean_intent_patterns (
  id                 BIGSERIAL PRIMARY KEY,
  normalized_pattern TEXT NOT NULL UNIQUE,
  intent_type        TEXT NOT NULL,
  domain             TEXT NOT NULL DEFAULT 'OTHER',
  confidence         NUMERIC(5,4) DEFAULT 0.7,
  source             TEXT NOT NULL DEFAULT 'llm',
  used_count         INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sean_intent_patterns_type ON sean_intent_patterns(intent_type);

-- Matches the ecosystem's 138_rls_public_exposure_gap_fix.sql convention:
-- deny-all-except-owner/service-role on every new Supabase-reachable table
-- by default (no explicit policy needed — this table has no per-company
-- ownership concept, same reasoning as sean_patterns_global/sean_codex_articles).
ALTER TABLE sean_intent_patterns ENABLE ROW LEVEL SECURITY;
