-- ============================================================================
-- Migration 183: Ledger Leo — learned bank statement FORMATS (Sean + local AI)
-- ============================================================================
-- Ruan 2026-11-13: when a PDF statement in a new format is uploaded, Sean (the
-- local Ollama model on Ruan's computer) works out the FORMAT, and Leo
-- remembers it so the next statement in that format reads straight away.
--
--   bank_statement_formats   a learned recipe (format only — no transactions,
--                            amounts, account numbers or names; labels are
--                            letters/spaces only). Usable by the company it
--                            was learned in at once; usable by every company
--                            only after a super user approves it (Rule B2).
--   bank_format_requests     one "please learn this format" per upload. Holds
--                            the statement text while learning (client data,
--                            company-scoped) — cleared when learning ends.
--
-- The balance chain decides whether a recipe is right: a row only counts when
-- a printed amount equals the change in the printed balance.
-- Idempotent.
-- ============================================================================

-- New job kind for the local AI worker queue (migration 174).
ALTER TABLE local_ai_jobs DROP CONSTRAINT IF EXISTS local_ai_jobs_kind_check;
ALTER TABLE local_ai_jobs ADD CONSTRAINT local_ai_jobs_kind_check
  CHECK (kind IN ('slip_read', 'help_answer', 'bank_format'));

CREATE TABLE IF NOT EXISTS bank_statement_formats (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NULL REFERENCES companies(id) ON DELETE SET NULL, -- learned in
  bank_name           TEXT NULL,
  recipe              JSONB NOT NULL,
  global_status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (global_status IN ('pending','approved','rejected')),
  statements_verified INTEGER NOT NULL DEFAULT 1,
  rows_verified       INTEGER NOT NULL DEFAULT 0,
  learned_by          TEXT NOT NULL DEFAULT 'local-ai',
  approved_by         INTEGER NULL REFERENCES users(id),
  approved_at         TIMESTAMPTZ NULL,
  rejected_by         INTEGER NULL REFERENCES users(id),
  rejected_at         TIMESTAMPTZ NULL,
  rejection_reason    TEXT NULL,
  last_used_at        TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_statement_formats_company ON bank_statement_formats (company_id);
CREATE INDEX IF NOT EXISTS idx_bank_statement_formats_global ON bank_statement_formats (global_status);
ALTER TABLE bank_statement_formats ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bank_format_requests (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_hash       TEXT NULL,
  filename        TEXT NULL,
  statement_text  TEXT NULL,            -- cleared when learning ends
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','retry','learned','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  feedback        TEXT NULL,            -- what went wrong last try (for the model)
  format_id       INTEGER NULL REFERENCES bank_statement_formats(id) ON DELETE SET NULL,
  result          JSONB NULL,           -- counts only: rows, verified, unverified
  error           TEXT NULL,
  created_by      INTEGER NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_format_requests_company ON bank_format_requests (company_id, status);
ALTER TABLE bank_format_requests ENABLE ROW LEVEL SECURITY;
