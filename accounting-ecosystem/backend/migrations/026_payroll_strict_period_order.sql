-- ============================================================================
-- Migration 026 — companies.payroll_strict_period_order
-- ============================================================================
-- Purpose (docs/paytime/spec/07_UITVOER_EN_FINALISERING.md UF-04, decided by
-- Ruan 2026-10-12):
--   PAYE year-to-date uses the previous months' finalized payroll. When this
--   flag is TRUE, "Calculate payslip" and Execute Payroll refuse to calculate
--   a month for an employee whose PREVIOUS month is not finalized yet
--   (exception: the employee's first month in Paytime this tax year).
--   When FALSE, calculation is allowed and finalizing only warns (with
--   confirmation) about open earlier months.
--
-- Default TRUE: every new company is strict from day one.
-- Existing companies whose Paytime history has gaps (months run outside
-- Paytime, found 2026-10-12) are set FALSE until their missing months are
-- imported (Fase 12); a super user then switches them on:
--   UPDATE companies SET payroll_strict_period_order = TRUE WHERE id = <id>;
--
-- The backend treats a missing column as FALSE (non-strict), so the code is
-- safe to deploy before this migration runs.
--
-- Idempotent — safe to re-run (the UPDATE only applies to the listed ids).
-- Run in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS payroll_strict_period_order BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN companies.payroll_strict_period_order IS
  'Paytime: TRUE = a month cannot be calculated until the previous month is finalized '
  '(employee''s first Paytime month exempt). FALSE = calculate allowed, finalize warns. '
  'See migration 026 and docs/paytime/spec/07.';

-- Companies with gaps in their 2026/27 Paytime history on 2026-10-12:
--   1 The Infinite Legacy, 7 Turkstra Bakkery, 11 A en E le Grange Trust,
--   38 Lorenco Accounting Services, 39 Bakmeester, 40 Lorenco Ecosystum,
--   51 Infinite Legacy — TEST.
-- Pennygrow (2) and all other companies stay TRUE.
UPDATE companies
   SET payroll_strict_period_order = FALSE
 WHERE id IN (1, 7, 11, 38, 39, 40, 51);
