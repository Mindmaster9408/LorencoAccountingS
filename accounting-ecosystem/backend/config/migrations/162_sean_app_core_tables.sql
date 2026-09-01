-- ============================================================================
-- 162_sean_app_core_tables.sql
-- ============================================================================
-- sean-webapp's own exclusively-owned tables, moving off its local SQLite
-- (prisma/dev.db) onto this shared production Postgres — the second half
-- of the sean-webapp -> SEVCO consolidation (see 158/159/161 for the
-- shared-brain tables). All prefixed `sean_app_` to avoid any collision
-- with existing tables in this same database (e.g. `users`, `companies`)
-- and to make it visually obvious at a glance which tables belong
-- exclusively to sean-webapp vs. the shared SEVCO brain vs. the rest of
-- the ecosystem.
--
-- No foreign-key constraints between these tables — sean-webapp's Prisma
-- schema uses `relationMode = "prisma"` (enforces relations at the
-- application/query level), which is required anyway for the two tables
-- it references outside this set (sean_knowledge_items, both owned by the
-- shared .sql pipeline, never by sean-webapp's own Prisma migrate). Applying
-- the same style consistently here rather than mixing FK and non-FK tables.
--
-- No cuid()-as-DB-default anywhere — Prisma's @default(cuid()) is generated
-- application-side before INSERT, not a Postgres sequence/function, so
-- these id columns are plain TEXT PRIMARY KEY with no DEFAULT.
--
-- CompanyNote (SQLite model) intentionally NOT carried forward — confirmed
-- zero code references anywhere in sean-webapp, dead model.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sean_app_users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sean_app_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sean_app_clients (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  code                  TEXT NOT NULL UNIQUE,
  description           TEXT,
  is_active             BOOLEAN DEFAULT TRUE,
  eco_company_id        TEXT UNIQUE,
  industry_id           TEXT,
  business_type         TEXT,
  vat_registered        BOOLEAN DEFAULT FALSE,
  vat_number            TEXT,
  company_reg_number    TEXT,
  business_description  TEXT,
  main_products         TEXT DEFAULT '[]',
  main_services         TEXT DEFAULT '[]',
  main_expense_types    TEXT DEFAULT '[]',
  main_income_types     TEXT DEFAULT '[]',
  financial_year_end    TEXT,
  contact_person        TEXT,
  contact_email         TEXT,
  contact_phone         TEXT,
  data_isolation_level  TEXT DEFAULT 'STRICT',
  default_min_confidence NUMERIC(4,3) DEFAULT 0.8,
  auto_allocate_enabled BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_clients_code          ON sean_app_clients(code);
CREATE INDEX IF NOT EXISTS idx_sean_app_clients_is_active     ON sean_app_clients(is_active);
CREATE INDEX IF NOT EXISTS idx_sean_app_clients_industry_id   ON sean_app_clients(industry_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_clients_business_type ON sean_app_clients(business_type);

CREATE TABLE IF NOT EXISTS sean_app_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT DEFAULT 'Untitled',
  module     TEXT DEFAULT 'general',
  client_id  TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_conversations_client_id ON sean_app_conversations(client_id);

CREATE TABLE IF NOT EXISTS sean_app_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT DEFAULT 'user',
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sean_app_audit_log (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  action_type  TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  details_json TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_audit_log_action_type ON sean_app_audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_sean_app_audit_log_user_id     ON sean_app_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_audit_log_created_at  ON sean_app_audit_log(created_at);

CREATE TABLE IF NOT EXISTS sean_app_bank_transactions (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  date                  TIMESTAMPTZ NOT NULL,
  description           TEXT NOT NULL,
  raw_description       TEXT NOT NULL,
  amount                DOUBLE PRECISION NOT NULL,
  is_debit              BOOLEAN DEFAULT TRUE,
  suggested_category    TEXT,
  suggested_confidence  DOUBLE PRECISION,
  confirmed_category    TEXT,
  confirmed_by_user_id  TEXT,
  feedback              TEXT,
  processed             BOOLEAN DEFAULT FALSE,
  client_id             TEXT,
  bank_account          TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_bank_tx_user_id            ON sean_app_bank_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_bank_tx_confirmed_category ON sean_app_bank_transactions(confirmed_category);
CREATE INDEX IF NOT EXISTS idx_sean_app_bank_tx_processed          ON sean_app_bank_transactions(processed);
CREATE INDEX IF NOT EXISTS idx_sean_app_bank_tx_date               ON sean_app_bank_transactions(date);
CREATE INDEX IF NOT EXISTS idx_sean_app_bank_tx_client_id          ON sean_app_bank_transactions(client_id);

CREATE TABLE IF NOT EXISTS sean_app_allocation_rules (
  id                  TEXT PRIMARY KEY,
  pattern             TEXT NOT NULL,
  normalized_pattern  TEXT NOT NULL,
  category            TEXT NOT NULL,
  confidence          DOUBLE PRECISION DEFAULT 0.7,
  learned_from_count  INTEGER DEFAULT 1,
  created_by_user_id  TEXT,
  client_id           TEXT,
  is_global           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_alloc_rules_pattern    ON sean_app_allocation_rules(normalized_pattern);
CREATE INDEX IF NOT EXISTS idx_sean_app_alloc_rules_category   ON sean_app_allocation_rules(category);
CREATE INDEX IF NOT EXISTS idx_sean_app_alloc_rules_confidence ON sean_app_allocation_rules(confidence);
CREATE INDEX IF NOT EXISTS idx_sean_app_alloc_rules_client_id  ON sean_app_allocation_rules(client_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_alloc_rules_is_global  ON sean_app_allocation_rules(is_global);

CREATE TABLE IF NOT EXISTS sean_app_industries (
  id                     TEXT PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  description            TEXT,
  parent_id              TEXT,
  typical_expenses       TEXT DEFAULT '[]',
  typical_income         TEXT DEFAULT '[]',
  common_vendors         TEXT DEFAULT '[]',
  learning_contributors  INTEGER DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_industries_code      ON sean_app_industries(code);
CREATE INDEX IF NOT EXISTS idx_sean_app_industries_parent_id ON sean_app_industries(parent_id);

CREATE TABLE IF NOT EXISTS sean_app_industry_patterns (
  id                  TEXT PRIMARY KEY,
  industry_id         TEXT NOT NULL,
  normalized_pattern  TEXT NOT NULL,
  suggested_category  TEXT NOT NULL,
  confidence          DOUBLE PRECISION DEFAULT 0.5,
  occurrence_count    INTEGER DEFAULT 1,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (industry_id, normalized_pattern)
);
CREATE INDEX IF NOT EXISTS idx_sean_app_ind_patterns_industry_id ON sean_app_industry_patterns(industry_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_ind_patterns_pattern     ON sean_app_industry_patterns(normalized_pattern);
CREATE INDEX IF NOT EXISTS idx_sean_app_ind_patterns_category    ON sean_app_industry_patterns(suggested_category);

CREATE TABLE IF NOT EXISTS sean_app_privacy_audit_log (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  client_id      TEXT,
  action_type    TEXT NOT NULL,
  data_type      TEXT NOT NULL,
  description    TEXT,
  ip_address     TEXT,
  user_agent     TEXT,
  was_anonymized BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_privacy_log_user_id     ON sean_app_privacy_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_privacy_log_client_id   ON sean_app_privacy_audit_log(client_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_privacy_log_action_type ON sean_app_privacy_audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_sean_app_privacy_log_created_at  ON sean_app_privacy_audit_log(created_at);

CREATE TABLE IF NOT EXISTS sean_app_client_categories (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  keywords    TEXT DEFAULT '[]',
  parent_code TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, code)
);
CREATE INDEX IF NOT EXISTS idx_sean_app_client_categories_client_id ON sean_app_client_categories(client_id);

CREATE TABLE IF NOT EXISTS sean_app_allowed_emails (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  role                TEXT DEFAULT 'SUPER_USER',
  has_coaching_access BOOLEAN DEFAULT FALSE,
  added_by            TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_allowed_emails_email               ON sean_app_allowed_emails(email);
CREATE INDEX IF NOT EXISTS idx_sean_app_allowed_emails_has_coaching_access ON sean_app_allowed_emails(has_coaching_access);

CREATE TABLE IF NOT EXISTS sean_app_coaching_data_access (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  client_id   TEXT,
  access_type TEXT NOT NULL,
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sean_app_coaching_access_user_id     ON sean_app_coaching_data_access(user_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_coaching_access_client_id   ON sean_app_coaching_data_access(client_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_coaching_access_accessed_at ON sean_app_coaching_data_access(accessed_at);

CREATE TABLE IF NOT EXISTS sean_app_agent (
  id                            TEXT PRIMARY KEY,
  name                          TEXT DEFAULT 'Sean',
  status                        TEXT DEFAULT 'INACTIVE',
  authorized_actions            TEXT DEFAULT '[]',
  auto_allocate_enabled         BOOLEAN DEFAULT FALSE,
  auto_allocate_interval        INTEGER DEFAULT 60,
  auto_allocate_min_confidence  DOUBLE PRECISION DEFAULT 0.8,
  auto_allocate_last_run        TIMESTAMPTZ,
  auto_allocate_next_run        TIMESTAMPTZ,
  llm_fallback_enabled          BOOLEAN DEFAULT TRUE,
  llm_fallback_provider         TEXT,
  total_allocations             INTEGER DEFAULT 0,
  total_llm_calls               INTEGER DEFAULT 0,
  created_at                    TIMESTAMPTZ DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_agent_status ON sean_app_agent(status);

CREATE TABLE IF NOT EXISTS sean_app_allocation_job_runs (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL,
  status                  TEXT DEFAULT 'RUNNING',
  started_at              TIMESTAMPTZ DEFAULT NOW(),
  completed_at            TIMESTAMPTZ,
  transactions_processed  INTEGER DEFAULT 0,
  auto_allocated          INTEGER DEFAULT 0,
  llm_allocated           INTEGER DEFAULT 0,
  needs_review            INTEGER DEFAULT 0,
  errors                  INTEGER DEFAULT 0,
  details_json            TEXT,
  error_message           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sean_app_job_runs_agent_id  ON sean_app_allocation_job_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_sean_app_job_runs_status    ON sean_app_allocation_job_runs(status);
CREATE INDEX IF NOT EXISTS idx_sean_app_job_runs_started_at ON sean_app_allocation_job_runs(started_at);

CREATE TABLE IF NOT EXISTS sean_app_allocation_llm_cache (
  id                  TEXT PRIMARY KEY,
  normalized_pattern  TEXT NOT NULL UNIQUE,
  suggested_category  TEXT NOT NULL,
  reasoning           TEXT,
  provider            TEXT NOT NULL,
  confidence          DOUBLE PRECISION DEFAULT 0.7,
  used_count          INTEGER DEFAULT 1,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_app_llm_cache_pattern  ON sean_app_allocation_llm_cache(normalized_pattern);
CREATE INDEX IF NOT EXISTS idx_sean_app_llm_cache_category ON sean_app_allocation_llm_cache(suggested_category);

-- RLS: matches 138_rls_public_exposure_gap_fix.sql's convention of
-- deny-all-except-owner/service-role on every Supabase-reachable table.
-- sean-webapp connects via the same direct-Postgres role the rest of the
-- ecosystem already uses (ACCOUNTING_DATABASE_URL-style), which owns these
-- tables and so is unaffected by RLS being enabled with no explicit policy.
ALTER TABLE sean_app_users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_sessions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_bank_transactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_allocation_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_industries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_industry_patterns     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_privacy_audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_client_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_allowed_emails        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_coaching_data_access  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_agent                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_allocation_job_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sean_app_allocation_llm_cache  ENABLE ROW LEVEL SECURITY;
