-- ============================================================================
-- Migration 166: Smart Client Document Collector — core schema
-- ============================================================================
-- New module `collector`: lets a firm (starting with Lorenco itself) stop
-- manually chasing clients for monthly bookkeeping source documents. Staff
-- define a recurring checklist per client; each month a "period" opens; the
-- client gets one email with a secure, reusable link to an outstanding-
-- document checklist; they upload files against it; staff review exceptions.
--
-- Every table is company_id-scoped exactly like every other module in this
-- ecosystem (companies/users/JWT already provide multi-tenancy — no new
-- tenant/role system is introduced here).
--
-- Idempotent: IF NOT EXISTS throughout (this repo's CI applies every file in
-- this directory on every push, with no migration-tracking table).
-- ============================================================================

-- ── collector_clients ─────────────────────────────────────────────────────
-- practice_client_id is an OPTIONAL convenience link for Lorenco's own use
-- (Firmflow already knows about e.g. Turkstra Bakkery) — nothing in this
-- module may assume it is non-null, since this must work standalone for a
-- firm with no Firmflow/Practice module at all.
CREATE TABLE IF NOT EXISTS collector_clients (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  practice_client_id      INTEGER NULL REFERENCES practice_clients(id) ON DELETE SET NULL,
  display_name            TEXT NOT NULL,
  primary_contact_name    TEXT,
  primary_contact_email   TEXT NOT NULL,
  cc_emails               TEXT[] NULL,
  jurisdiction            TEXT NOT NULL DEFAULT 'ZA' CHECK (jurisdiction IN ('ZA','UK','AU_NZ','US')),
  timezone                TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  notes                   TEXT,
  created_by_user_id      INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collector_clients_company ON collector_clients (company_id, status);

-- ── collector_requirement_templates ──────────────────────────────────────
-- The recurring checklist definition per client (edited by staff over time).
CREATE TABLE IF NOT EXISTS collector_requirement_templates (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       INTEGER NOT NULL REFERENCES collector_clients(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL DEFAULT 'other'
    CHECK (doc_type IN ('bank_statement','petty_cash','payroll_report','sales_invoices','purchase_receipts','ar_ap','other')),
  label           TEXT NOT NULL,
  description     TEXT,
  frequency       TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly','quarterly','annual')),
  is_required     BOOLEAN NOT NULL DEFAULT true,
  active          BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collector_templates_client ON collector_requirement_templates (client_id, active);

-- ── collector_periods ─────────────────────────────────────────────────────
-- One row per client per month. `closed` is what actually kills the upload
-- link (see collector_upload_tokens) — independent of token expiry.
CREATE TABLE IF NOT EXISTS collector_periods (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       INTEGER NOT NULL REFERENCES collector_clients(id) ON DELETE CASCADE,
  period_label    TEXT NOT NULL,
  period_start    DATE,
  period_end      DATE,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','closed')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ NULL,
  closed_at       TIMESTAMPTZ NULL,
  created_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, period_label)
);
CREATE INDEX IF NOT EXISTS idx_collector_periods_client ON collector_periods (client_id, status);

-- ── collector_period_items ────────────────────────────────────────────────
-- Snapshot of what's owed THIS period. Deliberately copies label/doc_type
-- from the template at open-time — later template edits must never rewrite
-- the history of an already-open or closed period.
CREATE TABLE IF NOT EXISTS collector_period_items (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_id         INTEGER NOT NULL REFERENCES collector_periods(id) ON DELETE CASCADE,
  template_id       INTEGER NULL REFERENCES collector_requirement_templates(id) ON DELETE SET NULL,
  label             TEXT NOT NULL,
  doc_type          TEXT NOT NULL DEFAULT 'other',
  is_required       BOOLEAN NOT NULL DEFAULT true,
  status            TEXT NOT NULL DEFAULT 'outstanding'
    CHECK (status IN ('outstanding','submitted','needs_review','accepted','waived')),
  waived_reason     TEXT,
  waived_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collector_period_items_period ON collector_period_items (period_id, status);

-- ── collector_upload_tokens ───────────────────────────────────────────────
-- Deliberate divergence from password_reset_tokens: this link stays valid
-- and REUSABLE across many visits over the whole open period (a client
-- uploads in batches over days), not single-use. UNIQUE(period_id) makes
-- "resend = reuse existing token" race-safe by construction — the token
-- service does an upsert-style lookup, never a blind insert.
CREATE TABLE IF NOT EXISTS collector_upload_tokens (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id           INTEGER NOT NULL REFERENCES collector_clients(id) ON DELETE CASCADE,
  period_id           INTEGER NOT NULL REFERENCES collector_periods(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ NULL,
  last_used_at        TIMESTAMPTZ NULL,
  created_by_user_id  INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id)
);

-- ── collector_documents ───────────────────────────────────────────────────
-- Same forensic shape as supplier_invoice_ocr_drafts (migration 063): raw
-- extraction is immutable, reviewer corrections live in separate columns,
-- nothing here is accounting/intake truth until a human explicitly accepts
-- it. period_item_id is nullable — "no matching checklist line" is itself
-- an exception state, not an error.
CREATE TABLE IF NOT EXISTS collector_documents (
  id                              SERIAL PRIMARY KEY,
  company_id                      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id                       INTEGER NOT NULL REFERENCES collector_clients(id) ON DELETE CASCADE,
  period_id                       INTEGER NOT NULL REFERENCES collector_periods(id) ON DELETE CASCADE,
  period_item_id                  INTEGER NULL REFERENCES collector_period_items(id) ON DELETE SET NULL,

  status                          TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','classified','needs_review','accepted','rejected')),

  original_filename               TEXT,
  file_mime_type                  TEXT,
  file_size_bytes                 INTEGER,
  storage_bucket                  TEXT NOT NULL DEFAULT 'collector-documents',
  storage_path                    TEXT NOT NULL,
  sha256_hash                     TEXT NOT NULL,

  -- AI output — immutable once written (Phase 2, not yet populated by Phase 1)
  ai_raw                          JSONB NOT NULL DEFAULT '{}',
  ai_extracted                    JSONB NOT NULL DEFAULT '{}',
  ai_confidence                   JSONB NOT NULL DEFAULT '{}',
  ai_doc_type_guess               TEXT,
  ai_period_guess                 TEXT,
  ai_match_confidence             NUMERIC(4,3),

  -- Reviewer corrections — never overwrites the AI/raw fields above
  reviewer_notes                  TEXT,
  reviewer_corrected_period_item_id INTEGER NULL REFERENCES collector_period_items(id) ON DELETE SET NULL,

  flag_reason                     TEXT
    CHECK (flag_reason IS NULL OR flag_reason IN
      ('low_confidence','wrong_period','unreadable','possible_duplicate','no_matching_item','manual_flag','ai_call_failed')),

  uploaded_via_token_id           INTEGER NULL REFERENCES collector_upload_tokens(id) ON DELETE SET NULL,
  uploaded_ip                     TEXT,
  uploaded_user_agent             TEXT,

  reviewed_by_user_id             INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                     TIMESTAMPTZ NULL,
  accepted_at                     TIMESTAMPTZ NULL,
  rejected_at                     TIMESTAMPTZ NULL,
  rejection_reason                TEXT,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collector_documents_company_status ON collector_documents (company_id, status);
CREATE INDEX IF NOT EXISTS idx_collector_documents_client_period ON collector_documents (client_id, period_id);
CREATE INDEX IF NOT EXISTS idx_collector_documents_hash ON collector_documents (sha256_hash);

-- ── collector_comms_log ───────────────────────────────────────────────────
-- `channel` defaults 'email' but is its own column (not hardcoded) so a
-- future WhatsApp channel needs no schema change.
CREATE TABLE IF NOT EXISTS collector_comms_log (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id           INTEGER NOT NULL REFERENCES collector_clients(id) ON DELETE CASCADE,
  period_id           INTEGER NOT NULL REFERENCES collector_periods(id) ON DELETE CASCADE,
  token_id            INTEGER NULL REFERENCES collector_upload_tokens(id) ON DELETE SET NULL,
  comm_type           TEXT NOT NULL CHECK (comm_type IN ('initial_request','reminder','completion_confirmation','exception_notice')),
  channel             TEXT NOT NULL DEFAULT 'email',
  recipient_email     TEXT NOT NULL,
  subject             TEXT,
  send_result         TEXT NOT NULL CHECK (send_result IN ('sent','failed','not_configured')),
  provider_message_id TEXT,
  error_message       TEXT,
  sent_by_user_id     INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collector_comms_period ON collector_comms_log (period_id, created_at DESC);

-- ── updated_at triggers ───────────────────────────────────────────────────
-- update_updated_at_column() is used by migration 063/020, but those live in
-- accounting-ecosystem/database/migrations/ — a directory this repo's CI does
-- NOT apply (only backend/config/migrations/*.sql runs on every push). Rather
-- than assume that function already exists live, define it here too via
-- CREATE OR REPLACE — idempotent and harmless if it's already present.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS collector_clients_updated_at ON collector_clients;
CREATE TRIGGER collector_clients_updated_at
  BEFORE UPDATE ON collector_clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS collector_templates_updated_at ON collector_requirement_templates;
CREATE TRIGGER collector_templates_updated_at
  BEFORE UPDATE ON collector_requirement_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS collector_periods_updated_at ON collector_periods;
CREATE TRIGGER collector_periods_updated_at
  BEFORE UPDATE ON collector_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS collector_period_items_updated_at ON collector_period_items;
CREATE TRIGGER collector_period_items_updated_at
  BEFORE UPDATE ON collector_period_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS collector_documents_updated_at ON collector_documents;
CREATE TRIGGER collector_documents_updated_at
  BEFORE UPDATE ON collector_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FOLLOW-UP NOTE
-- Area: collector_documents AI columns
-- Dependency: ANTHROPIC_API_KEY (not yet provided) + modules/collector/services/classificationService.js (Phase 2, not built this round)
-- What was done now: schema is ready for AI output (ai_raw/ai_extracted/ai_confidence/etc.), but Phase 1 ships with these columns always at their defaults — every upload lands as status='uploaded' and staff manually matches/accepts it.
-- What still needs to be checked: once ANTHROPIC_API_KEY is available, wire classificationService.js into the upload route per the approved plan (see plan file / project_document_collector_agent_concept memory).
-- Risk if not checked: none — Phase 1 is fully functional without AI, this is additive.
-- Recommended next review point: when Ruan is ready to provide the Anthropic credential.
-- ============================================================================
