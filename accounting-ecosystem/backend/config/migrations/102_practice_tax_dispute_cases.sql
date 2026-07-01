-- Migration 102: Tax Assessment Objection + Correction Workflow Foundation
-- Codebox 44 — Lorenco Practice Management
--
-- NOT SARS API. NOT eFiling objection submission.
-- This is manual internal tracking for corrections, objections, NOO, ADR, Tax Court escalations.
--
-- Tables created (all IF NOT EXISTS — safe to re-run):
--   practice_tax_dispute_cases
--   practice_tax_dispute_evidence
--   practice_tax_dispute_events
--
-- Cross-table references use plain INTEGER (no FK constraints), matching the
-- established convention from migrations 089, 100, 101. Ownership verified in code.

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_tax_dispute_cases
-- One row per tracked dispute / correction / objection case.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_tax_dispute_cases (
    id                         SERIAL PRIMARY KEY,
    company_id                 INTEGER NOT NULL,

    -- Where this dispute originated
    source_type                TEXT NOT NULL CHECK (source_type IN (
                                   'tax_submission', 'sars_statement_line', 'assessment',
                                   'payment_case', 'manual'
                               )),
    source_id                  INTEGER,                        -- plain integer, no FK

    -- What kind of dispute this is
    case_type                  TEXT NOT NULL CHECK (case_type IN (
                                   'correction', 'objection', 'noo', 'adr',
                                   'appeal', 'tax_court', 'manual_review'
                               )),

    -- Current lifecycle status (12 values)
    case_status                TEXT NOT NULL DEFAULT 'open' CHECK (case_status IN (
                                   'open', 'pending_submission', 'submitted', 'acknowledged',
                                   'under_review', 'response_received', 'accepted', 'rejected',
                                   'escalated', 'appealing', 'completed', 'cancelled'
                               )),

    -- Core fields
    title                      TEXT NOT NULL,
    description                TEXT,

    -- Client + submission linkage
    client_id                  INTEGER NOT NULL,
    submission_id              INTEGER,                        -- plain integer, no FK

    -- SARS references
    assessment_reference       TEXT,
    sars_case_number           TEXT,
    sars_dispute_reference     TEXT,

    -- Tax context
    tax_type                   TEXT CHECK (tax_type IN (
                                   'itr12', 'itr14', 'irp6', 'emp201', 'emp501', 'vat201', 'other'
                               )),
    tax_year                   TEXT,
    period_label               TEXT,

    -- Key dates
    date_opened                DATE,
    submission_deadline        DATE,
    response_deadline          DATE,
    sars_response_date         DATE,

    -- Outcome (populated when resolved)
    outcome                    TEXT,
    outcome_amount             NUMERIC(14, 2),
    outcome_notes              TEXT,

    -- Work management
    priority                   TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    responsible_team_member_id INTEGER,

    -- Notes
    notes                      TEXT,
    internal_notes             TEXT,

    -- Ownership
    created_by                 INTEGER,
    updated_by                 INTEGER,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ptdc_company_id
    ON practice_tax_dispute_cases (company_id);

CREATE INDEX IF NOT EXISTS idx_ptdc_company_status
    ON practice_tax_dispute_cases (company_id, case_status);

CREATE INDEX IF NOT EXISTS idx_ptdc_company_type
    ON practice_tax_dispute_cases (company_id, case_type);

CREATE INDEX IF NOT EXISTS idx_ptdc_client_id
    ON practice_tax_dispute_cases (company_id, client_id);

CREATE INDEX IF NOT EXISTS idx_ptdc_submission_id
    ON practice_tax_dispute_cases (submission_id)
    WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ptdc_source
    ON practice_tax_dispute_cases (company_id, source_type, source_id)
    WHERE source_id IS NOT NULL;

-- Partial index: active cases needing action (most common query)
CREATE INDEX IF NOT EXISTS idx_ptdc_active_priority
    ON practice_tax_dispute_cases (company_id, priority, submission_deadline)
    WHERE case_status NOT IN ('completed', 'cancelled');

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION fn_ptdc_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_ptdc_updated_at ON practice_tax_dispute_cases;
CREATE TRIGGER tg_ptdc_updated_at
    BEFORE UPDATE ON practice_tax_dispute_cases
    FOR EACH ROW EXECUTE FUNCTION fn_ptdc_updated_at();

COMMENT ON TABLE practice_tax_dispute_cases IS
    'Codebox 44 — Manual internal tracking for tax corrections, objections, NOO, ADR, appeals, and Tax Court escalations. NOT SARS API. NOT eFiling integration. All data manually entered by practice staff.';

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_tax_dispute_evidence
-- Supporting documents and correspondence for a dispute case.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_tax_dispute_evidence (
    id                   SERIAL PRIMARY KEY,
    company_id           INTEGER NOT NULL,
    dispute_case_id      INTEGER NOT NULL,                     -- plain integer, no FK

    evidence_type        TEXT NOT NULL CHECK (evidence_type IN (
                             'sars_correspondence', 'supporting_document', 'objection_form',
                             'legal_advice', 'tax_calculation', 'payment_proof',
                             'acknowledgement', 'other'
                         )),
    evidence_title       TEXT NOT NULL,
    evidence_date        DATE,
    evidence_note        TEXT,
    external_reference   TEXT,

    -- Verification
    is_verified          BOOLEAN NOT NULL DEFAULT FALSE,
    verified_by          INTEGER,
    verified_at          TIMESTAMPTZ,

    -- Ownership
    created_by           INTEGER,
    updated_by           INTEGER,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ptde_case_id
    ON practice_tax_dispute_evidence (dispute_case_id);

CREATE INDEX IF NOT EXISTS idx_ptde_company_case
    ON practice_tax_dispute_evidence (company_id, dispute_case_id);

CREATE OR REPLACE FUNCTION fn_ptde_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_ptde_updated_at ON practice_tax_dispute_evidence;
CREATE TRIGGER tg_ptde_updated_at
    BEFORE UPDATE ON practice_tax_dispute_evidence
    FOR EACH ROW EXECUTE FUNCTION fn_ptde_updated_at();

COMMENT ON TABLE practice_tax_dispute_evidence IS
    'Codebox 44 — Evidence records for tax dispute cases. Plain integer reference to parent case (no FK constraint). Ownership verified in application code.';

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_tax_dispute_events  (append-only audit log)
-- Never updated. Never deleted. 7-year audit retention (same as Codebox 41-43).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_tax_dispute_events (
    id               SERIAL PRIMARY KEY,
    company_id       INTEGER NOT NULL,
    dispute_case_id  INTEGER NOT NULL,                         -- plain integer, no FK
    event_type       TEXT NOT NULL,
    old_status       TEXT,
    new_status       TEXT,
    actor_user_id    INTEGER,
    notes            TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ptdev_case_id
    ON practice_tax_dispute_events (dispute_case_id);

CREATE INDEX IF NOT EXISTS idx_ptdev_company_case
    ON practice_tax_dispute_events (company_id, dispute_case_id);

CREATE INDEX IF NOT EXISTS idx_ptdev_created_desc
    ON practice_tax_dispute_events (created_at DESC);

COMMENT ON TABLE practice_tax_dispute_events IS
    'Codebox 44 — Append-only event log for tax dispute cases. Never updated or deleted. 7-year audit retention aligned with SARS compliance requirements.';
