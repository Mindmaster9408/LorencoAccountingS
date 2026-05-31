-- ============================================================================
-- Migration 066: Supplier Invoice Void Metadata
-- ============================================================================
-- Purpose:
--   Adds void-tracking columns to supplier_invoices so that a formal void
--   event is permanently recorded with who voided it, when, and why.
--
-- Context:
--   Customer invoices already have a formal void path (POST /:id/void).
--   Supplier invoices did not. This migration enables the equivalent
--   supplier invoice void endpoint added in ACC-HARDEN-018.
--
-- Columns added:
--   voided_at           — timestamp of the void action
--   voided_by_user_id   — user who performed the void (FK to users)
--   void_reason         — optional reason text (audit trail)
--
-- Status field:
--   supplier_invoices.status has no CHECK constraint (VARCHAR(20)).
--   'void' is a valid new status value. Existing valid values:
--   'draft', 'unpaid', 'part_paid', 'paid', 'cancelled'
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 012_accounting_schema.sql (supplier_invoices table)
-- Safe: ADD COLUMN IF NOT EXISTS — no data change, no existing rows affected
-- ============================================================================

ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS voided_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason       TEXT;

COMMENT ON COLUMN supplier_invoices.voided_at IS
  'Timestamp when the invoice was formally voided. NULL for non-voided invoices.';

COMMENT ON COLUMN supplier_invoices.voided_by_user_id IS
  'User who performed the void action. Retained for audit even if user is deleted.';

COMMENT ON COLUMN supplier_invoices.void_reason IS
  'Optional reason provided by the accountant at void time.';

-- ============================================================================
-- Summary:
--   supplier_invoices.voided_at          TIMESTAMPTZ  nullable
--   supplier_invoices.voided_by_user_id  INTEGER      nullable FK → users.id
--   supplier_invoices.void_reason        TEXT         nullable
--
--   All existing rows retain NULL for these columns — unaffected.
--   A voided invoice will have: status='void', voided_at=<timestamp>,
--   voided_by_user_id=<user>, void_reason=<text|null>.
-- ============================================================================
