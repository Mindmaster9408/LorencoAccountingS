-- ============================================================================
-- 158_sean_knowledge_items_webapp_columns.sql
-- ============================================================================
-- Extends the existing sean_knowledge_items table (created in
-- 001_sean_tables.sql, part of the legacy SEAN codex/pattern pipeline —
-- backend/sean/supabase-store.js) so sean-webapp's conversational "brain"
-- (Prisma KnowledgeItem model) can live in this SAME table instead of its
-- own isolated SQLite file. This is the sean-webapp -> SEVCO consolidation
-- (2026-08-31) — see plan doc for full rationale.
--
-- IMPORTANT: this table's DDL is owned EXCLUSIVELY by this .sql migration
-- pipeline, forever. sean-webapp/prisma/schema.prisma models this table via
-- a hand-authored @@map (never `prisma db pull`, never `prisma migrate` DDL
-- against it) — see sean-webapp/prisma/schema.prisma's KnowledgeItem model
-- comment. If this table's columns ever change here, that Prisma model must
-- be updated in the same PR.
--
-- Legacy columns NOT touched by sean-webapp (left as-is for the older
-- pipeline): id (BIGSERIAL, reused as-is — sean-webapp's KnowledgeItem.id
-- changes from a cuid String to Int to match), content (JSONB — sean-webapp
-- uses the new content_text TEXT column instead, never JSON.parse'd),
-- domain (TEXT — reused directly via Prisma's primaryDomain @map, same
-- value vocabulary/default), company_id (INTEGER FK to companies — NOT the
-- same concept as scope_client_id below, left completely alone).
-- ============================================================================

ALTER TABLE sean_knowledge_items
  ADD COLUMN IF NOT EXISTS scope_type          TEXT DEFAULT 'GLOBAL',
  ADD COLUMN IF NOT EXISTS scope_client_id      TEXT,
  ADD COLUMN IF NOT EXISTS content_text         TEXT,
  ADD COLUMN IF NOT EXISTS secondary_domains    TEXT DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS slug                 TEXT,
  ADD COLUMN IF NOT EXISTS kb_version           INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_by_id     BIGINT,
  ADD COLUMN IF NOT EXISTS source_type          TEXT,
  ADD COLUMN IF NOT EXISTS source_url           TEXT,
  ADD COLUMN IF NOT EXISTS source_section       TEXT,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS approved_by_user_id  TEXT,
  ADD COLUMN IF NOT EXISTS approved_at          TIMESTAMPTZ;

-- Partial unique index (not a plain UNIQUE constraint) — legacy rows may
-- have a NULL citation_id, which would make a plain constraint fail. Run
-- the preflight dupe-check below in each environment before this migration.
--   SELECT count(*), count(citation_id), count(DISTINCT citation_id)
--   FROM sean_knowledge_items;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sean_knowledge_citation_unique
  ON sean_knowledge_items(citation_id) WHERE citation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sean_knowledge_scope_type   ON sean_knowledge_items(scope_type);
CREATE INDEX IF NOT EXISTS idx_sean_knowledge_scope_client ON sean_knowledge_items(scope_client_id);
CREATE INDEX IF NOT EXISTS idx_sean_knowledge_slug         ON sean_knowledge_items(slug);
CREATE INDEX IF NOT EXISTS idx_sean_knowledge_source_type  ON sean_knowledge_items(source_type);
