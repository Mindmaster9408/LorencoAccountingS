-- ============================================================================
-- Migration 065 — Practice: Service Catalog + Client Engagements
-- ============================================================================
-- Tables:
--   practice_service_catalog          — master list of services the practice offers
--   practice_client_engagements       — formal service relationships per client
--   practice_client_engagement_events — audit trail of engagement lifecycle events
--
-- Key rules enforced at API layer (not DB):
--   - service_category must be one of the allowed values
--   - fee_frequency must be one of the allowed values
--   - billing_type must be one of: fixed, hourly, retainer
--   - engagement status transitions: active → paused → active, active/paused → ended/cancelled
--   - auto_create_workflow and auto_create_deadline are stored but NEVER executed
--   - workflow_template_id is stored for reference only — no auto-creation
-- ============================================================================

-- ─── 1. Service Catalog ──────────────────────────────────────────────────────
-- One row per service type the practice offers.
-- Shared across all clients — a catalog entry is a template, not a client record.

CREATE TABLE IF NOT EXISTS practice_service_catalog (
    id                           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id                   INTEGER NOT NULL,
    service_code                 TEXT,                        -- short code e.g. VAT201, AFS, PAYROLL
    service_name                 TEXT NOT NULL,               -- display name e.g. "VAT Returns"
    service_category             TEXT NOT NULL,               -- vat|paye|emp501|income_tax|annual_financials|bookkeeping|payroll|secretarial|consulting|cipc|other
    description                  TEXT,
    default_fee_amount           NUMERIC(12, 2),              -- default fixed fee or rate
    default_fee_frequency        TEXT DEFAULT 'monthly',      -- monthly|quarterly|biannual|annual|once_off|per_hour
    default_billing_type         TEXT DEFAULT 'fixed',        -- fixed|hourly|retainer
    default_hourly_rate          NUMERIC(12, 2),              -- overrides practice default when set
    estimated_hours_per_period   NUMERIC(8, 2),               -- used for retainer / capacity planning
    default_workflow_template_id INTEGER,                     -- FK to practice_workflow_templates (stored, not auto-executed)
    auto_create_workflow         BOOLEAN NOT NULL DEFAULT FALSE, -- stored only — NOT executed by the system
    auto_create_deadline         BOOLEAN NOT NULL DEFAULT FALSE, -- stored only — NOT executed by the system
    is_active                    BOOLEAN NOT NULL DEFAULT TRUE,
    display_order                INTEGER NOT NULL DEFAULT 0,
    notes                        TEXT,
    settings                     JSONB NOT NULL DEFAULT '{}',
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by                   INTEGER
);

-- Indexes on practice_service_catalog
CREATE INDEX IF NOT EXISTS idx_service_catalog_company
    ON practice_service_catalog (company_id);

CREATE INDEX IF NOT EXISTS idx_service_catalog_category
    ON practice_service_catalog (company_id, service_category);

CREATE INDEX IF NOT EXISTS idx_service_catalog_active
    ON practice_service_catalog (company_id, is_active)
    WHERE is_active = TRUE;

-- ─── 2. Client Engagements ───────────────────────────────────────────────────
-- One row per formal service relationship between practice and client.
-- A client may have many engagements (e.g. VAT + Payroll + Annual Financials).

CREATE TABLE IF NOT EXISTS practice_client_engagements (
    id                         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id                 INTEGER NOT NULL,
    client_id                  INTEGER NOT NULL,               -- FK to practice_clients
    service_catalog_id         INTEGER,                        -- optional FK to practice_service_catalog
    engagement_name            TEXT NOT NULL,                  -- display name (may copy from catalog)
    service_category           TEXT NOT NULL,                  -- vat|paye|emp501|income_tax|annual_financials|bookkeeping|payroll|secretarial|consulting|cipc|other
    description                TEXT,

    -- Status
    status                     TEXT NOT NULL DEFAULT 'active', -- active|paused|ended|cancelled
    start_date                 DATE,
    end_date                   DATE,                           -- planned/expected end date

    -- Ownership
    responsible_team_member_id INTEGER,                        -- FK to practice_team_members
    reviewer_team_member_id    INTEGER,
    partner_team_member_id     INTEGER,

    -- Fee
    fee_amount                 NUMERIC(12, 2),
    fee_frequency              TEXT DEFAULT 'monthly',         -- monthly|quarterly|biannual|annual|once_off|per_hour
    billing_type               TEXT DEFAULT 'fixed',           -- fixed|hourly|retainer
    hourly_rate                NUMERIC(12, 2),
    estimated_hours_per_period NUMERIC(8, 2),
    currency                   TEXT NOT NULL DEFAULT 'ZAR',

    -- Workflow linkage (stored for reference only — auto_create flags are NOT executed)
    workflow_template_id       INTEGER,                        -- FK to practice_workflow_templates (reference only)
    auto_create_workflow       BOOLEAN NOT NULL DEFAULT FALSE, -- stored only
    auto_create_deadline       BOOLEAN NOT NULL DEFAULT FALSE, -- stored only

    -- Notes
    notes                      TEXT,
    internal_notes             TEXT,
    settings                   JSONB NOT NULL DEFAULT '{}',

    -- Lifecycle
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by                 INTEGER,
    updated_by                 INTEGER,
    ended_at                   TIMESTAMPTZ,                    -- populated when status → ended
    ended_by                   INTEGER,
    cancelled_at               TIMESTAMPTZ,                    -- populated when status → cancelled
    cancelled_by               INTEGER
);

-- Indexes on practice_client_engagements
CREATE INDEX IF NOT EXISTS idx_engagements_company
    ON practice_client_engagements (company_id);

CREATE INDEX IF NOT EXISTS idx_engagements_client
    ON practice_client_engagements (company_id, client_id);

CREATE INDEX IF NOT EXISTS idx_engagements_status
    ON practice_client_engagements (company_id, status);

CREATE INDEX IF NOT EXISTS idx_engagements_catalog
    ON practice_client_engagements (company_id, service_catalog_id)
    WHERE service_catalog_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engagements_responsible
    ON practice_client_engagements (company_id, responsible_team_member_id)
    WHERE responsible_team_member_id IS NOT NULL;

-- ─── 3. Engagement Events ────────────────────────────────────────────────────
-- Audit trail for every engagement lifecycle event.
-- Non-fatal: event log failures must never abort engagement operations.

CREATE TABLE IF NOT EXISTS practice_client_engagement_events (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    INTEGER NOT NULL,
    engagement_id INTEGER NOT NULL,
    event_type    TEXT NOT NULL,   -- engagement_created|engagement_updated|status_changed|engagement_ended|engagement_cancelled|engagement_paused|engagement_reactivated
    old_status    TEXT,            -- previous status for status_changed events
    new_status    TEXT,            -- new status for status_changed events
    actor_user_id INTEGER,         -- user who triggered the event
    notes         TEXT,            -- human-readable reason or note
    metadata      JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on practice_client_engagement_events
CREATE INDEX IF NOT EXISTS idx_engagement_events_company
    ON practice_client_engagement_events (company_id);

CREATE INDEX IF NOT EXISTS idx_engagement_events_engagement
    ON practice_client_engagement_events (company_id, engagement_id);

CREATE INDEX IF NOT EXISTS idx_engagement_events_type
    ON practice_client_engagement_events (event_type);

CREATE INDEX IF NOT EXISTS idx_engagement_events_created
    ON practice_client_engagement_events (created_at DESC);

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Run after applying this migration to confirm all objects were created:
--
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'practice_service_catalog',
--     'practice_client_engagements',
--     'practice_client_engagement_events'
--   )
-- ORDER BY table_name;
-- (expect 3 rows)
--
-- SELECT indexname FROM pg_indexes
-- WHERE tablename IN (
--   'practice_service_catalog',
--   'practice_client_engagements',
--   'practice_client_engagement_events'
-- )
-- ORDER BY indexname;
-- (expect 12 rows: 3 + 5 + 4)
