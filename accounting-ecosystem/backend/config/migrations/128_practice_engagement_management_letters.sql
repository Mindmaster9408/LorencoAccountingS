-- Migration 128: Practice Engagement Management + Engagement Letter Foundation
-- Codebox 71 — Lorenco Practice Management
--
-- NOT document generation. NOT e-signature. NOT automatic proposal
-- acceptance. NOT legal drafting. Structured engagement governance and
-- engagement-letter TRACKING only — future PDF/e-signature must plug into
-- this foundation, not replace it.
--
-- ══════════════════════════════════════════════════════════════════════════
-- MANDATORY PRE-BUILD AUDIT (RULE A1) — FULL FINDINGS
-- ══════════════════════════════════════════════════════════════════════════
-- A complete Engagement Management system ALREADY EXISTS and is LIVE,
-- built across Codeboxes 15/16 (migrations 065-067):
--
--   practice_service_catalog           (065) — master service list
--   practice_client_engagements        (065) — one row per client engagement
--   practice_client_engagement_events  (065) — append-only audit trail (no
--                                               DB CHECK on event_type)
--   practice_engagement_periods        (067) — manual recurrence period queue
--
-- practice_client_engagements already has (065/066/067): id, company_id,
-- client_id, service_catalog_id, engagement_name, service_category,
-- description, status ('active'|'paused'|'ended'|'cancelled' — API-layer
-- only, no DB CHECK), start_date, end_date, responsible_team_member_id,
-- reviewer_team_member_id, partner_team_member_id, fee_amount NUMERIC(12,2),
-- fee_frequency, billing_type, hourly_rate, estimated_hours_per_period,
-- currency, workflow_template_id, auto_create_workflow, auto_create_deadline,
-- notes, internal_notes, settings, created_at/updated_at/created_by/updated_by,
-- ended_at/ended_by, cancelled_at/cancelled_by, plus (066) generation-tracking
-- columns and (067) recurrence-definition columns.
--
-- The existing router (modules/practice/engagements.js, 638 lines, mounted at
-- router root in index.js) reads/writes ALL of the above via 16 endpoints,
-- and its generate-workflow/generation-preview endpoints GATE on
-- `status === 'active'` (engagements.js lines 481, 502). This is a genuine,
-- LIVE functional dependency — not just a naming convention — and is the
-- single most important fact this migration and its router must respect.
--
-- DECISION: This codebox is built as an ENHANCEMENT LAYER, per explicit
-- instruction. It does NOT duplicate practice_service_catalog,
-- practice_client_engagements, or practice_client_engagement_events.
-- Instead:
--   1. practice_client_engagements is ALTERed (additive columns only) to add
--      risk acceptance, scope clarity, letter-tracking, and a richer
--      review/renewal lifecycle.
--   2. Two genuinely new tables are created (practice_engagement_letters,
--      practice_engagement_management_events) since no existing table covers
--      engagement-letter tracking or this enhancement layer's own richer,
--      DB-CHECK-constrained event vocabulary.
--   3. Where the spec's requested field already exists with an equivalent
--      meaning, the EXISTING column is reused and mapped, not duplicated —
--      see the ALTER section below for the definitive per-field mapping.
--   4. engagements.js is NEVER modified. Not one line. All existing
--      endpoints, exports, and behavior are 100% preserved.
--
-- ══════════════════════════════════════════════════════════════════════════
-- FIELD-BY-FIELD MAPPING — what's reused vs. genuinely new
-- ══════════════════════════════════════════════════════════════════════════
--   spec: engagement_status (10 values)  -> NEW column. The existing `status`
--         column (4 values: active|paused|ended|cancelled) continues to
--         drive engagements.js's own behavior UNCHANGED — including its live
--         generate-workflow gate. engagement_status is a richer, SEPARATE,
--         ADDITIONAL lifecycle model, matching the precedent already
--         established in migration 125 (Entity Lifecycle's
--         current_lifecycle_status vs. Secretarial's company_status) —
--         EXCEPT for one deliberate difference: because `status === 'active'`
--         has a real, live functional dependency (the generate-workflow
--         gate), engagement-management.js's own actions DO write to the
--         legacy `status` column for the specific transitions where a clean,
--         unambiguous equivalent exists (active/paused/ended/cancelled) —
--         see engagement-management.js's STATUS_SYNC_MAP for the exact,
--         documented mapping. Never guessed, never silently drifted.
--   spec: engagement_type              -> NEW column. Existing
--         service_category is a SARS/CIPC-specific vocabulary drawn from
--         practice_service_catalog (vat|paye|emp501|...); engagement_type is
--         a broader practice service-LINE classification for KPI grouping —
--         a different granularity, not a duplicate. Both columns co-exist.
--   spec: fee_basis                   -> NEW column. Existing billing_type
--         (fixed|hourly|retainer) is a narrower 3-value vocabulary already
--         driving existing fee logic; fee_basis is the spec's broader
--         9-value classification. Both co-exist; billing_type is untouched.
--   spec: fee_amount NUMERIC(14,2)     -> REUSED existing fee_amount
--         NUMERIC(12,2) as-is. The column type is NOT altered — changing an
--         already-live column's numeric precision carries real (if small)
--         risk for zero benefit at current fee scales; documented as an
--         accepted, deliberate minor deviation.
--   spec: billing_frequency           -> NEW column. Existing fee_frequency
--         (monthly|quarterly|biannual|annual|once_off|per_hour) already
--         drives existing fee-quotation logic under a different vocabulary;
--         billing_frequency is the spec's distinct invoicing-cadence concept
--         (monthly|quarterly|annual|once_off|ad_hoc|other). Both co-exist.
--   spec: responsible_partner_id      -> REUSED existing partner_team_member_id.
--   spec: responsible_manager_id      -> REUSED existing responsible_team_member_id.
--         (reviewer_team_member_id continues to serve its existing purpose,
--         untouched.)
--   spec: start_date, end_date, notes, internal_notes, settings,
--         created_at/updated_at/created_by/updated_by -> REUSED as-is.
--   Everything else in the spec's field list genuinely does not exist yet
--   and is added below as a new, purely additive column.
--
-- ══════════════════════════════════════════════════════════════════════════
--
-- Tables created (all IF NOT EXISTS — safe to re-run):
--   practice_engagement_letters
--   practice_engagement_management_events

-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER: practice_client_engagements (additive only — see mapping above)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_client_engagements
    ADD COLUMN IF NOT EXISTS engagement_status TEXT NOT NULL DEFAULT 'draft' CHECK (engagement_status IN (
        'draft', 'proposed', 'active', 'paused', 'under_review', 'renewal_due',
        'renewed', 'ended', 'cancelled', 'rejected'
    )),
    ADD COLUMN IF NOT EXISTS engagement_type TEXT CHECK (engagement_type IS NULL OR engagement_type IN (
        'accounting', 'tax', 'payroll', 'secretarial', 'advisory', 'compliance',
        'bookkeeping', 'company_secretarial', 'management', 'custom'
    )),
    ADD COLUMN IF NOT EXISTS scope_summary TEXT,
    ADD COLUMN IF NOT EXISTS scope_inclusions JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS scope_exclusions JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS fee_basis TEXT CHECK (fee_basis IS NULL OR fee_basis IN (
        'fixed_monthly', 'fixed_annual', 'hourly', 'per_service', 'once_off',
        'retainer', 'quote_based', 'no_charge', 'other'
    )),
    ADD COLUMN IF NOT EXISTS billing_frequency TEXT CHECK (billing_frequency IS NULL OR billing_frequency IN (
        'monthly', 'quarterly', 'annual', 'once_off', 'ad_hoc', 'other'
    )),
    ADD COLUMN IF NOT EXISTS next_review_date DATE,
    ADD COLUMN IF NOT EXISTS renewal_date DATE,
    ADD COLUMN IF NOT EXISTS reviewed_by INTEGER,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    ADD COLUMN IF NOT EXISTS risk_notes TEXT,
    ADD COLUMN IF NOT EXISTS risk_accepted_by INTEGER,
    ADD COLUMN IF NOT EXISTS risk_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS risk_acceptance_reason TEXT,
    ADD COLUMN IF NOT EXISTS engagement_letter_status TEXT NOT NULL DEFAULT 'not_required' CHECK (engagement_letter_status IN (
        'not_required', 'required', 'drafted', 'sent', 'signed', 'waived', 'expired'
    )),
    ADD COLUMN IF NOT EXISTS engagement_letter_reference TEXT,
    ADD COLUMN IF NOT EXISTS engagement_letter_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS engagement_letter_signed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS engagement_letter_waiver_reason TEXT,
    ADD COLUMN IF NOT EXISTS client_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS client_accepted_by_name TEXT,
    ADD COLUMN IF NOT EXISTS termination_reason TEXT,
    ADD COLUMN IF NOT EXISTS review_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_pce_engagement_status  ON practice_client_engagements (company_id, engagement_status);
CREATE INDEX IF NOT EXISTS idx_pce_risk_level         ON practice_client_engagements (company_id, risk_level);
CREATE INDEX IF NOT EXISTS idx_pce_letter_status       ON practice_client_engagements (company_id, engagement_letter_status);
CREATE INDEX IF NOT EXISTS idx_pce_next_review_date    ON practice_client_engagements (company_id, next_review_date) WHERE next_review_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pce_renewal_date         ON practice_client_engagements (company_id, renewal_date) WHERE renewal_date IS NOT NULL;

COMMENT ON COLUMN practice_client_engagements.engagement_status IS
    'Codebox 71 — Richer, SEPARATE lifecycle model from the legacy status column (active|paused|ended|cancelled, Codebox 15/16). engagement-management.js keeps the legacy status column in sync ONLY for the active/paused/ended/cancelled transitions (see STATUS_SYNC_MAP) because engagements.js''s generate-workflow gate has a live functional dependency on status=''active''. draft/proposed/under_review/renewal_due/renewed/rejected never touch the legacy column beyond that mapping.';

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_engagement_letters
-- Tracking only — no document content, no PDF, no e-signature.
-- content_snapshot is a structured audit copy (same pattern as Codebox 64's
-- resolution content_snapshot), never a generated/rendered document.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_engagement_letters (
    id                      INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    company_id               INTEGER NOT NULL,
    client_id                  INTEGER NOT NULL,   -- plain integer, no FK — practice_clients (Codebox 41 convention)
    engagement_id                 INTEGER NOT NULL,   -- plain integer, no FK — practice_client_engagements

    letter_status                    TEXT NOT NULL DEFAULT 'draft' CHECK (letter_status IN (
                                         'draft', 'sent', 'signed', 'waived', 'expired', 'archived', 'cancelled'
                                     )),
    letter_title                       TEXT NOT NULL,
    letter_reference                     TEXT,
    version                                INTEGER NOT NULL DEFAULT 1,

    sent_at                                  TIMESTAMPTZ,
    signed_at                                  TIMESTAMPTZ,
    waived_at                                    TIMESTAMPTZ,
    waiver_reason                                  TEXT,
    expiry_date                                      DATE,

    notes                                              TEXT,
    internal_notes                                       TEXT,

    -- Structured, point-in-time audit copy of the letter's key fields at
    -- creation/send time — NOT a generated document (no PDF/e-signature here).
    content_snapshot                                       JSONB,

    created_by                                               INTEGER,
    updated_by                                                 INTEGER,
    created_at                                                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                                                    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pel_company_id      ON practice_engagement_letters (company_id);
CREATE INDEX IF NOT EXISTS idx_pel_client_id        ON practice_engagement_letters (client_id);
CREATE INDEX IF NOT EXISTS idx_pel_engagement_id    ON practice_engagement_letters (engagement_id);
CREATE INDEX IF NOT EXISTS idx_pel_letter_status    ON practice_engagement_letters (company_id, letter_status);

CREATE OR REPLACE FUNCTION fn_pel_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_pel_updated_at ON practice_engagement_letters;
CREATE TRIGGER tg_pel_updated_at
    BEFORE UPDATE ON practice_engagement_letters
    FOR EACH ROW EXECUTE FUNCTION fn_pel_updated_at();

COMMENT ON TABLE practice_engagement_letters IS
    'Codebox 71 — Engagement letter TRACKING only (draft/sent/signed/waived/expired/archived/cancelled). NOT document generation, NOT e-signature — content_snapshot is a structured audit copy, not a rendered/signed document. Links to practice_client_engagements (Codebox 15).';

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: practice_engagement_management_events  (append-only audit log)
-- A NEW, DB-CHECK-constrained events table for THIS enhancement layer's own
-- richer lifecycle — deliberately separate from the existing
-- practice_client_engagement_events (Codebox 15/16, no CHECK constraint,
-- owned entirely by engagements.js, never written to by this module).
-- Never updated. Never deleted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_engagement_management_events (
    id                 INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    company_id          INTEGER NOT NULL,
    client_id             INTEGER,   -- plain integer, no FK — practice_clients (denormalized for fast per-client history queries)

    engagement_id           INTEGER,   -- plain integer, no FK — practice_client_engagements. Nullable — letter-only events may omit it if not resolvable.
    letter_id                 INTEGER,   -- plain integer, no FK — practice_engagement_letters. Nullable — engagement-only events omit it.

    event_type                  TEXT NOT NULL CHECK (event_type IN (
                                    'engagement_created', 'engagement_updated', 'engagement_proposed', 'engagement_activated',
                                    'engagement_paused', 'engagement_resumed', 'engagement_review_started', 'engagement_review_completed',
                                    'engagement_renewal_due', 'engagement_renewed', 'engagement_ended', 'engagement_cancelled',
                                    'engagement_risk_accepted', 'letter_created', 'letter_sent', 'letter_signed', 'letter_waived', 'letter_expired'
                                )),
    old_status                    TEXT,
    new_status                      TEXT,

    actor_user_id                      INTEGER,
    notes                                 TEXT,
    metadata                              JSONB NOT NULL DEFAULT '{}',
    created_at                              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_peme_company_id     ON practice_engagement_management_events (company_id);
CREATE INDEX IF NOT EXISTS idx_peme_engagement_id   ON practice_engagement_management_events (engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_peme_letter_id        ON practice_engagement_management_events (letter_id) WHERE letter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_peme_client_id          ON practice_engagement_management_events (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_peme_created_at          ON practice_engagement_management_events (created_at DESC);

COMMENT ON TABLE practice_engagement_management_events IS
    'Codebox 71 — Append-only log of THIS enhancement layer''s engagement_status/risk/letter lifecycle. Deliberately separate from practice_client_engagement_events (Codebox 15/16, which tracks the legacy status column and remains owned entirely by engagements.js). Never updated or deleted.';
