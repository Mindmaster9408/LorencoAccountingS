-- ============================================================================
-- 098_practice_vat_bi_monthly_parity.sql
-- Adds vat_bi_monthly_parity to practice_clients.
--
-- South African SARS bi-monthly VAT filers are assigned to either:
--   Category A (odd months):  Jan, Mar, May, Jul, Sep, Nov
--   Category B (even months): Feb, Apr, Jun, Aug, Oct, Dec
--
-- This column stores which cycle the client is on. Only meaningful when
-- vat_payment_sequence = 'bi_monthly'. NULL for all other sequences.
-- ============================================================================

ALTER TABLE practice_clients
  ADD COLUMN IF NOT EXISTS vat_bi_monthly_parity VARCHAR(4)
  CHECK (vat_bi_monthly_parity IN ('odd', 'even'));

COMMENT ON COLUMN practice_clients.vat_bi_monthly_parity IS
  'SARS bi-monthly VAT cycle: ''odd'' = Jan/Mar/May/Jul/Sep/Nov (Category A), '
  '''even'' = Feb/Apr/Jun/Aug/Oct/Dec (Category B). NULL unless vat_payment_sequence = ''bi_monthly''.';
