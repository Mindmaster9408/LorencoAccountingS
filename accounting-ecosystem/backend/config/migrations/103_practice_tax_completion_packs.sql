-- Migration 103: Tax Compliance Finalization + Completion Evidence Pack
-- Codebox 45 — Lorenco Practice Management
--
-- NOT SARS integration. NOT document storage.
-- This is an INTERNAL PRACTICE QUALITY CONTROL AND SIGN-OFF MODULE.
-- Nothing can bypass the completion quality gate.
--
-- Tables created (all IF NOT EXISTS — safe to re-run):
--   practice_tax_completion_packs
--   practice_tax_completion_items
--   practice_tax_completion_events

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_tax_completion_packs
-- One pack per tax matter — the top-level quality gate record.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_tax_completion_packs (
    id                   SERIAL PRIMARY KEY,
    company_id           INTEGER NOT NULL,
    client_id            INTEGER NOT NULL,
    submission_id        INTEGER,                -- plain integer, no FK (Codebox 41 convention)

    -- What kind of tax matter this covers
    source_type          TEXT NOT NULL CHECK (source_type IN (
                             'individual_tax', 'company_tax', 'provisional_tax', 'vat', 'payroll'
                         )),
    source_id            INTEGER,                -- optional additional source reference

    -- Lifecycle
    pack_status          TEXT NOT NULL DEFAULT 'draft' CHECK (pack_status IN (
                             'draft', 'review_pending', 'approved', 'completed', 'cancelled'
                         )),

    -- Completion score: 0–100 (percentage of required items marked complete)
    completion_score     INTEGER NOT NULL DEFAULT 0 CHECK (completion_score BETWEEN 0 AND 100),

    -- Resolution
    completion_date      DATE,
    approved_by          INTEGER,               -- user_id of approving partner
    approved_at          TIMESTAMPTZ,

    -- Notes
    review_notes         TEXT,                  -- reviewer notes (set during review)
    partner_notes        TEXT,                  -- partner sign-off notes
    completion_summary   TEXT,                  -- human-readable outcome summary

    -- Immutable frozen snapshot set at completion (JSONB)
    completion_snapshot  JSONB,

    -- Flexible overrides and metadata (partner_overrides array stored here)
    settings             JSONB NOT NULL DEFAULT '{}',

    -- Ownership
    created_by           INTEGER,
    updated_by           INTEGER,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ptcp_company_id
    ON practice_tax_completion_packs (company_id);

CREATE INDEX IF NOT EXISTS idx_ptcp_client_id
    ON practice_tax_completion_packs (company_id, client_id);

CREATE INDEX IF NOT EXISTS idx_ptcp_submission_id
    ON practice_tax_completion_packs (submission_id)
    WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ptcp_pack_status
    ON practice_tax_completion_packs (company_id, pack_status);

CREATE INDEX IF NOT EXISTS idx_ptcp_completion_date
    ON practice_tax_completion_packs (completion_date DESC)
    WHERE completion_date IS NOT NULL;

-- Partial index — active packs needing attention
CREATE INDEX IF NOT EXISTS idx_ptcp_active
    ON practice_tax_completion_packs (company_id, completion_score, pack_status)
    WHERE pack_status NOT IN ('completed', 'cancelled');

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION fn_ptcp_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_ptcp_updated_at ON practice_tax_completion_packs;
CREATE TRIGGER tg_ptcp_updated_at
    BEFORE UPDATE ON practice_tax_completion_packs
    FOR EACH ROW EXECUTE FUNCTION fn_ptcp_updated_at();

COMMENT ON TABLE practice_tax_completion_packs IS
    'Codebox 45 — Internal quality control and sign-off gate before a tax matter is considered complete. NOT SARS integration. NOT document storage. Enforces checklist completion, partner approval, and blocking-condition checks.';

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_tax_completion_items
-- Checklist items for a completion pack. One row per required task.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_tax_completion_items (
    id                   SERIAL PRIMARY KEY,
    company_id           INTEGER NOT NULL,
    completion_pack_id   INTEGER NOT NULL,       -- plain integer, no FK

    item_type            TEXT NOT NULL CHECK (item_type IN (
                             'submission_proof', 'assessment', 'payment_proof', 'refund_proof',
                             'reconciliation', 'dispute', 'supporting_documents', 'working_papers',
                             'client_approval', 'partner_review', 'internal_review', 'other'
                         )),
    item_name            TEXT NOT NULL,          -- human label, e.g. "AFS Review"
    required             BOOLEAN NOT NULL DEFAULT TRUE,
    completed            BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at         TIMESTAMPTZ,
    completed_by         INTEGER,                -- user_id
    notes                TEXT,
    sort_order           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ptci_pack_id
    ON practice_tax_completion_items (completion_pack_id);

CREATE INDEX IF NOT EXISTS idx_ptci_company_pack
    ON practice_tax_completion_items (company_id, completion_pack_id);

COMMENT ON TABLE practice_tax_completion_items IS
    'Codebox 45 — Checklist items for a completion pack. Default items are generated per source_type. All required items must be marked complete before the pack can be completed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_tax_completion_events  (append-only audit log)
-- Never updated. Never deleted. 7-year retention.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_tax_completion_events (
    id                   SERIAL PRIMARY KEY,
    company_id           INTEGER NOT NULL,
    completion_pack_id   INTEGER NOT NULL,       -- plain integer, no FK
    event_type           TEXT NOT NULL,
    old_status           TEXT,
    new_status           TEXT,
    actor_user_id        INTEGER,
    notes                TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ptce_pack_id
    ON practice_tax_completion_events (completion_pack_id);

CREATE INDEX IF NOT EXISTS idx_ptce_company_pack
    ON practice_tax_completion_events (company_id, completion_pack_id);

CREATE INDEX IF NOT EXISTS idx_ptce_created_desc
    ON practice_tax_completion_events (created_at DESC);

COMMENT ON TABLE practice_tax_completion_events IS
    'Codebox 45 — Append-only audit log for completion pack lifecycle events. Never updated or deleted. 7-year retention.';
