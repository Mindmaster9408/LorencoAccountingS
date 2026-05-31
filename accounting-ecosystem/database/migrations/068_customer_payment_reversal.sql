-- ============================================================================
-- Migration 068: Customer Payment Reversal Metadata
-- ============================================================================
-- Purpose:
--   Adds reversal-tracking columns to customer_payments so that a formal
--   payment reversal is permanently recorded with who reversed it, when, why,
--   and which GL journal was created to reverse the original posting.
--
-- Context:
--   customer_payments currently has no reversal metadata (only is_reversed was
--   added to supplier_payments in migration 067). customer_payments has no
--   status field and no reversal fields. All payments are implicitly active.
--   A reversed payment has no system record.
--   This migration enables the formal POST /payments/:id/void endpoint added
--   in ACC-HARDEN-020.
--
-- Columns added:
--   is_reversed           — boolean flag, default false (safe default)
--   reversed_at           — timestamp of the reversal action
--   reversed_by_user_id   — user who performed the reversal
--   reversal_reason       — optional reason text (audit trail)
--   reversal_journal_id   — FK to the reversal GL journal created by the void
--
-- Concurrency guard (application layer):
--   The void endpoint uses:
--     UPDATE customer_payments SET is_reversed=true ... WHERE id=X AND is_reversed=false
--   rowCount=0 → 409 (concurrent reversal already committed).
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 012_accounting_schema.sql (customer_payments table)
--               064_payment_idempotency.sql (idempotency_key already on table)
-- Safe: ADD COLUMN IF NOT EXISTS — no data change, no existing rows affected
--       is_reversed DEFAULT false — all existing rows default to not reversed
-- ============================================================================

ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS is_reversed           BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by_user_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason       TEXT,
  ADD COLUMN IF NOT EXISTS reversal_journal_id   INTEGER     REFERENCES journals(id) ON DELETE SET NULL;

COMMENT ON COLUMN customer_payments.is_reversed IS
  'True when the payment has been formally reversed. Default false for all existing rows.';

COMMENT ON COLUMN customer_payments.reversed_at IS
  'Timestamp of the reversal action. NULL for non-reversed payments.';

COMMENT ON COLUMN customer_payments.reversed_by_user_id IS
  'User who performed the reversal. Retained for audit even if user is deleted.';

COMMENT ON COLUMN customer_payments.reversal_reason IS
  'Optional reason provided by the accountant at reversal time.';

COMMENT ON COLUMN customer_payments.reversal_journal_id IS
  'FK to the GL journal that reversed the original payment journal. '
  'Null if the GL reversal failed (see CUSTOMER_PAYMENT_REVERSAL_GL_FAILED audit event).';

-- Index for filtering active (non-reversed) payments quickly
CREATE INDEX IF NOT EXISTS idx_customer_payments_active
  ON customer_payments (company_id, is_reversed)
  WHERE is_reversed = false;

-- ============================================================================
-- Summary:
--   customer_payments.is_reversed           BOOLEAN     NOT NULL DEFAULT false
--   customer_payments.reversed_at           TIMESTAMPTZ nullable
--   customer_payments.reversed_by_user_id   INTEGER     nullable FK → users.id
--   customer_payments.reversal_reason       TEXT        nullable
--   customer_payments.reversal_journal_id   INTEGER     nullable FK → journals.id
--
--   All existing rows default to is_reversed=false — unaffected.
--   A reversed payment will have: is_reversed=true, reversed_at=<ts>,
--   reversed_by_user_id=<uid>, reversal_journal_id=<jid | null>.
-- ============================================================================
