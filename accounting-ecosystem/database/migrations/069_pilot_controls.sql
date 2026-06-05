-- ============================================================================
-- Migration 069 — Pilot Governance: Sign-Off History + Risk Register
-- ============================================================================
-- Creates two tables for the Pilot Controls governance layer.
-- All records are append-only or soft-updated — nothing is ever hard-deleted.
-- Multi-tenant safety: every row is scoped by company_id.
-- ============================================================================

-- ── pilot_signoffs ───────────────────────────────────────────────────────────
-- Stores every governance checklist sign-off event.
-- APPEND-ONLY: a new row is inserted for every sign-off.
-- Prior sign-offs for the same company/type/period are NEVER modified.
-- The most recent row (by signed_at) is the authoritative state.
-- Callers must ORDER BY signed_at DESC and take the first row.

CREATE TABLE IF NOT EXISTS pilot_signoffs (
    id                 SERIAL          PRIMARY KEY,
    company_id         INTEGER         NOT NULL,

    -- Who signed (stored at sign-off time so history remains accurate
    -- even if the user account is renamed or deleted later)
    user_id            INTEGER,
    signed_by_name     VARCHAR(150),

    -- What was signed
    period             VARCHAR(20)     NOT NULL,
    -- Period formats:
    --   daily      → 'YYYY-MM-DD'   e.g. '2026-06-05'
    --   weekly     → 'YYYY-WNN'     e.g. '2026-W23'
    --   month_end  → 'YYYY-MM'      e.g. '2026-05'
    --   vat        → 'YYYY-MM'
    --   bank_recon → 'YYYY-MM'
    --   diagnostics→ 'YYYY-MM'

    checklist_type     VARCHAR(30)     NOT NULL,
    -- Allowed values: 'daily' | 'weekly' | 'month_end' | 'vat' | 'bank_recon' | 'diagnostics'

    -- Item states: JSONB map of { item_id: 'done' | 'exception' | 'na' | 'pending' }
    checklist_answers  JSONB           NOT NULL DEFAULT '{}',

    -- Summary flags computed at sign-off time (denormalised for fast queries)
    has_exceptions     BOOLEAN         NOT NULL DEFAULT FALSE,
    items_total        SMALLINT        NOT NULL DEFAULT 0,
    items_done         SMALLINT        NOT NULL DEFAULT 0,
    items_exception    SMALLINT        NOT NULL DEFAULT 0,
    items_na           SMALLINT        NOT NULL DEFAULT 0,

    -- Free-text fields
    exceptions         TEXT,   -- required when has_exceptions = true
    notes              TEXT,

    signed_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pilot_signoffs_company
    ON pilot_signoffs (company_id);

CREATE INDEX IF NOT EXISTS idx_pilot_signoffs_type_period
    ON pilot_signoffs (company_id, checklist_type, period, signed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pilot_signoffs_recent
    ON pilot_signoffs (company_id, signed_at DESC);

COMMENT ON TABLE pilot_signoffs IS
    'Pilot governance: append-only checklist sign-off history. One row per '
    'sign-off event. Prior records for the same period/type are never '
    'overwritten — all history is retained for audit purposes.';

-- ── pilot_risks ──────────────────────────────────────────────────────────────
-- Known-risk register for pilot governance.
-- Risks are never hard-deleted. resolved_at captures when a risk was closed.

CREATE TABLE IF NOT EXISTS pilot_risks (
    id                   SERIAL          PRIMARY KEY,
    company_id           INTEGER         NOT NULL,

    -- Risk definition
    risk_title           VARCHAR(255)    NOT NULL,
    severity             VARCHAR(20)     NOT NULL DEFAULT 'medium',
    -- Allowed: 'critical' | 'high' | 'medium' | 'low'

    affected_area        VARCHAR(50),
    -- Allowed: 'ar' | 'ap' | 'vat' | 'bank' | 'reporting' | 'general' | null

    mitigation           TEXT,
    owner                VARCHAR(100),

    -- Lifecycle
    status               VARCHAR(20)     NOT NULL DEFAULT 'open',
    -- Allowed: 'open' | 'mitigated' | 'resolved' | 'accepted'

    -- Who created and who resolved (stored at event time)
    created_by_user_id   INTEGER,
    created_by_name      VARCHAR(150),
    resolved_by_user_id  INTEGER,
    resolved_by_name     VARCHAR(150),

    created_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    resolved_at          TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pilot_risks_company
    ON pilot_risks (company_id);

CREATE INDEX IF NOT EXISTS idx_pilot_risks_status
    ON pilot_risks (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pilot_risks_severity
    ON pilot_risks (company_id, severity, status);

COMMENT ON TABLE pilot_risks IS
    'Pilot governance: known-risk register. Risks are never hard-deleted. '
    'resolved_at captures when the risk was closed. Full lifecycle history '
    'is preserved via status transitions and audit log events.';
