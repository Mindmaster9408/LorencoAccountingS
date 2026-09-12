-- ============================================================================
-- Migration 167: Company jurisdiction + currency (international rollout prep)
-- ============================================================================
-- Charlie (POS) and Stockton (Inventory) are being made sellable to
-- international firms — same 4 jurisdictions already agreed for the
-- Document Collector (migration 166): South Africa, UK, Australia/NZ, US.
-- UK is the priority/first market, but all 4 stay in the architecture.
--
-- Both modules were audited (2026-09-12) and found to have NO deep SARS/
-- CIPC/PAYE/UIF coupling — the only real dependency is cosmetic (hardcoded
-- Rand formatting, hardcoded "VAT" labels, a couple of hardcoded 'ZAR'/15%
-- defaults). So this is purely additive: two new columns on `companies`
-- with SAFE DEFAULTS that preserve today's exact South African behavior for
-- every existing company. Nothing changes for anyone unless a company is
-- deliberately switched to a different jurisdiction.
--
-- Idempotent: IF NOT EXISTS / DO block guards throughout, safe to re-run
-- (this repo's CI applies every migration file on every push).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'jurisdiction'
  ) THEN
    ALTER TABLE companies
      ADD COLUMN jurisdiction TEXT NOT NULL DEFAULT 'ZA'
      CHECK (jurisdiction IN ('ZA', 'UK', 'AU_NZ', 'US'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'currency_code'
  ) THEN
    ALTER TABLE companies
      ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'ZAR';
  END IF;
END $$;
