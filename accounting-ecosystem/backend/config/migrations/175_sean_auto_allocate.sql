-- ============================================================================
-- 175 — Sean auto-allocation (Ledger Leo bank, Phase 2)
-- ============================================================================
-- companies.sean_auto_allocate
--   Per-client switch: when true, Sean posts the bank lines he is sure of after
--   import (own history, 5+ times always the same account/VAT, ≤ R5 000).
--   Default OFF — Ruan switches it on per client (decision 2026-11-10).
--
-- bank_transactions.allocation_source
--   Who decided an allocation: 'manual' | 'bank_rule' | 'payroll' | 'sean_auto'.
--   NULL for lines allocated before this migration and for unmatched lines.
--   Shown as the "🤖 Sean" badge in the Reviewed tab.
--
-- Additive only; safe to run more than once.
-- ============================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS sean_auto_allocate boolean NOT NULL DEFAULT false;

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS allocation_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_allocation_source_check'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT bank_transactions_allocation_source_check
      CHECK (allocation_source IS NULL OR allocation_source IN ('manual', 'bank_rule', 'payroll', 'sean_auto'));
  END IF;
END $$;

-- PostgREST must see the new columns
NOTIFY pgrst, 'reload schema';
