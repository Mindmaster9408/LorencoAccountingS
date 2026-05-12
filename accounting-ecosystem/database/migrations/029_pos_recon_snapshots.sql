-- Migration 029: POS Reconciliation Snapshots
-- Creates pos_recon_snapshots — immutable, append-only till reconciliation snapshots.
--
-- Design decisions:
--   - NO FK constraints by design: snapshots must survive deletion of parent
--     sessions, sales, or users (same philosophy as pos_audit_events).
--   - Append-only enforced by DB triggers: UPDATE and DELETE are blocked at the
--     engine level regardless of role. Historical totals can never be altered.
--   - Snapshot is created automatically when complete-cashup fires (non-blocking).
--     Can also be created manually by a manager via POST /api/pos/sessions/:id/snapshot.
--   - payment_breakdown and refund_breakdown are JSONB for forward compatibility
--     (new payment methods don't require a schema migration).
--   - expected_cash_in_drawer is the forensically correct cash figure:
--       opening_balance + payment_cash - refund_cash
--     This differs from the legacy till_sessions.expected_balance (which is
--     opening + all-methods sales, ignoring refunds and payment method splits).
--   - consistency_issues is JSONB array of detected anomalies. Null means clean.
--   - is_consistent = false indicates the session had detectable anomalies at
--     snapshot time. The snapshot is still created — it records the problem.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- Date: 2026-05-12
-- Depends on: 028_pos_audit_trail_foundation.sql

-- ── 1. Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pos_recon_snapshots (
    id                      BIGSERIAL PRIMARY KEY,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Session reference (no FK — survives session deletion)
    till_session_id         INTEGER NOT NULL,
    company_id              INTEGER NOT NULL,
    till_id                 INTEGER,

    -- Who was on the till
    cashier_user_id         INTEGER,
    cashier_email           TEXT,

    -- Who triggered the snapshot
    generated_by_user_id    INTEGER,
    generated_by_email      TEXT,
    triggered_by            TEXT NOT NULL DEFAULT 'cashup',  -- 'cashup' | 'manual'

    -- Session state at snapshot time
    session_opened_at       TIMESTAMPTZ,
    session_closed_at       TIMESTAMPTZ,
    session_status          TEXT,

    -- Opening float
    opening_balance         NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Completed sale totals (from sales table)
    sale_count              INTEGER NOT NULL DEFAULT 0,
    gross_sales             NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_total          NUMERIC(12,2) NOT NULL DEFAULT 0,
    vat_total               NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Voided sale totals
    void_count              INTEGER NOT NULL DEFAULT 0,
    void_total              NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Payment totals by method (from sale_payments — authoritative breakdown)
    payment_cash            NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_card            NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_eft             NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_account         NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_other           NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Refund totals (from pos_returns)
    refund_count            INTEGER NOT NULL DEFAULT 0,
    refund_total            NUMERIC(12,2) NOT NULL DEFAULT 0,
    refund_cash             NUMERIC(12,2) NOT NULL DEFAULT 0,
    refund_card             NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Derived totals
    net_sales               NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- Forensically correct cash-in-drawer expectation:
    --   opening_balance + cash_payments - cash_refunds
    expected_cash_in_drawer NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- What cashier physically counted at cashup
    counted_cash            NUMERIC(12,2),
    counted_card            NUMERIC(12,2),
    counted_other           NUMERIC(12,2),
    total_counted           NUMERIC(12,2),

    -- Variance = total_counted - expected_cash_in_drawer (for cash reconciliation)
    -- Note: the legacy variance on till_sessions uses expected_balance (all-methods).
    --       This variance uses the correct payment-method-split expected figure.
    cash_variance           NUMERIC(12,2),

    -- Full payment and refund breakdown (JSONB — forward-compatible)
    payment_breakdown       JSONB,
    refund_breakdown        JSONB,

    -- Consistency check results
    is_consistent           BOOLEAN NOT NULL DEFAULT true,
    consistency_issues      JSONB   -- null if clean; array of issue objects if not
);

-- ── 2. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pos_recon_company_time
    ON pos_recon_snapshots (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_recon_session
    ON pos_recon_snapshots (till_session_id);

-- ── 3. Append-only enforcement ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prevent_recon_snapshot_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'pos_recon_snapshots is append-only. Reconciliation snapshots cannot be '
        'modified or deleted. Historical till totals are immutable by design. '
        'Action: % on row id=%', TG_OP, OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS pos_recon_no_update ON pos_recon_snapshots;
CREATE TRIGGER pos_recon_no_update
    BEFORE UPDATE ON pos_recon_snapshots
    FOR EACH ROW EXECUTE FUNCTION prevent_recon_snapshot_modification();

DROP TRIGGER IF EXISTS pos_recon_no_delete ON pos_recon_snapshots;
CREATE TRIGGER pos_recon_no_delete
    BEFORE DELETE ON pos_recon_snapshots
    FOR EACH ROW EXECUTE FUNCTION prevent_recon_snapshot_modification();

-- ── 4. Table documentation ────────────────────────────────────────────────────

COMMENT ON TABLE pos_recon_snapshots IS
    'Append-only immutable till reconciliation snapshots. Created automatically '
    'on complete-cashup and on demand by managers. No FK constraints — survives '
    'deletion of parent sessions, sales, or users. UPDATE and DELETE are blocked '
    'at the database level by triggers. expected_cash_in_drawer is the '
    'forensically correct cash figure (opening + cash_payments - cash_refunds), '
    'which differs from the legacy till_sessions.expected_balance column.';

COMMENT ON COLUMN pos_recon_snapshots.expected_cash_in_drawer IS
    'Forensically correct cash-in-drawer expectation: opening_balance + payment_cash - refund_cash. '
    'Differs from till_sessions.expected_balance (which is opening + all-method sales, ignoring refunds).';

COMMENT ON COLUMN pos_recon_snapshots.cash_variance IS
    'Variance between total_counted and expected_cash_in_drawer at cashup time. '
    'Uses the correct payment-split expected figure, not the legacy all-methods figure.';

COMMENT ON COLUMN pos_recon_snapshots.consistency_issues IS
    'JSONB array of detected anomalies at snapshot time. Null means no issues detected. '
    'is_consistent = false when this array is non-empty.';
