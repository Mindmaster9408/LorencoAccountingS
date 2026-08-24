-- =============================================================================
-- Migration 147: Expand supplier_invoices.status CHECK constraint
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: found by live-testing invoice creation in the "Infinite Legacy —
-- TEST" company (2026-08-24). supplier_invoices_status_check only allowed
-- ('draft','approved','partial','paid','overdue','cancelled') — but every
-- route in suppliers.js consistently sets/reads/filters on 'unpaid',
-- 'part_paid', and 'void' (invoiceStatus() helper, the void endpoint, aging
-- reports, dashboard stats, payment allocation/reversal). Only draft/paid/
-- cancelled overlapped with what the code actually uses. This is one more
-- reason POST /invoices had never succeeded for any real client — even after
-- the column-name fixes in the same audit, every invoice creation would have
-- failed on this constraint the moment a real chart of accounts existed
-- (confirmed: the constraint rejected the exact 'unpaid' status the create
-- route always sets on a brand-new invoice).
--
-- Decision (confirmed with user 2026-08-24): expand the constraint to also
-- allow the application's existing, consistently-used vocabulary, rather
-- than rewrite invoiceStatus() and every status comparison across the file
-- to adopt the constraint's original (untested, never-exercised) 6-state
-- vocabulary. Purely additive to the constraint — approved/partial/overdue
-- remain valid too, in case anything else already relies on them existing.
-- =============================================================================

ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_status_check;

ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_status_check
  CHECK (status IN ('draft', 'approved', 'partial', 'paid', 'overdue', 'cancelled', 'unpaid', 'part_paid', 'void'));

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'supplier_invoices'::regclass AND conname = 'supplier_invoices_status_check';
