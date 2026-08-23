-- =============================================================================
-- Migration 145: Add emp201_data to paye_reconciliations
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: paye-reconciliation.html's saveDraft() PUT payload has always
-- included emp201Data (the SARS EMP201 PAYE/UIF/SDL actuals a user types
-- against the reconciliation), but payeReconciliationService.saveDraft only
-- ever destructured { employeeLines, incomeLines, deductionLines } from the
-- request body — emp201Data was silently discarded, never persisted anywhere.
--
-- Fix: add a nullable JSONB column and have saveDraft/getDraft read and write
-- it. Purely additive — no existing column touched, no existing row affected.
-- =============================================================================

ALTER TABLE paye_reconciliations
  ADD COLUMN IF NOT EXISTS emp201_data JSONB;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'paye_reconciliations' AND column_name = 'emp201_data';
