-- ============================================================================
-- Migration 024 — taxable_percentage for partially-taxable payroll items
-- ============================================================================
-- Purpose:
--   Add taxable_percentage NUMERIC column to all three payroll item tables so
--   an item can be PARTIALLY taxable/UIF-applicable, not just fully on or off.
--
--   Real-world case this fixes: a fixed travel allowance is only 80% taxable
--   for PAYE by default (or 20% if a logbook proves >= 80% business use) —
--   and SARS uses the SAME percentage for UIF remuneration, since UIF
--   "remuneration" follows the same Fourth Schedule definition as PAYE
--   income. Confirmed against a SimplePay comparison payslip (2026-07-29):
--   Paytime had no mechanism to express this at all — affects_uif/is_taxable
--   are strict booleans (0% or 100%), never a fraction.
--
-- One shared field, not two:
--   Deliberately a single taxable_percentage column used for BOTH the UIF
--   base and PAYE taxable-income calculation, rather than two independently
--   editable percentages — the tax law uses the same split for both, and a
--   second copy would risk drifting out of sync the same way is_taxable
--   already drifts between payroll_items_master and payroll_items today
--   (that specific sync gap is closed by /api/payroll/items in this same
--   change, not by this migration).
--
-- Why three tables (mirrors 021_affects_uif.sql exactly):
--   payroll_items_master  — CRUD management table used by /api/payroll/items
--   payroll_items         — Calculation table used by PayrollDataService
--   payroll_period_inputs — one-off current-period inputs (optional item FK,
--                           so the value must be stamped directly, same
--                           reasoning as affects_uif/is_taxable on this table)
--
-- Default 100.00:
--   Every existing item is fully taxable/UIF-applicable today, so 100%
--   preserves current calculation behaviour exactly for every row that has
--   never touched this field — purely additive, no existing payslip changes
--   unless an item is deliberately set below 100.
--
-- Meaning, precisely: only takes effect when the item is otherwise
--   taxable/UIF-applicable (is_taxable/affects_uif != false). Those booleans
--   remain the master on/off switch; this percentage governs what FRACTION
--   of the amount counts when the boolean is true. The remainder flows into
--   non-taxable income (payroll-engine.js), not dropped.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
-- ============================================================================


-- ── payroll_items_master ──────────────────────────────────────────────────────
-- CRUD management table used by the Paytime Items UI (/api/payroll/items).

ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS taxable_percentage NUMERIC(5,2) NOT NULL DEFAULT 100.00
    CHECK (taxable_percentage BETWEEN 0 AND 100);

COMMENT ON COLUMN payroll_items_master.taxable_percentage IS
  'Percentage of this item''s amount that counts toward PAYE taxable income '
  'AND the UIF contribution base (same percentage for both — see SARS Fourth '
  'Schedule remuneration definition). Only applies when is_taxable/affects_uif '
  'are not explicitly false. Default 100 (fully taxable/UIF-applicable, '
  'identical to pre-existing behaviour). Example: a fixed travel allowance is '
  'typically 80 (80% taxable) unless a logbook proves >= 80% business use, in '
  'which case 20.';


-- ── payroll_items ─────────────────────────────────────────────────────────────
-- Calculation table used by PayrollDataService via employee_payroll_items join.
-- Engine reads taxable_percentage from this table at calculation time.

ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS taxable_percentage NUMERIC(5,2) NOT NULL DEFAULT 100.00
    CHECK (taxable_percentage BETWEEN 0 AND 100);

COMMENT ON COLUMN payroll_items.taxable_percentage IS
  'Percentage of this item''s amount that counts toward PAYE taxable income '
  'AND the UIF contribution base. Synced from payroll_items_master by '
  '/api/payroll/items PUT and /api/payroll/items/employee POST (at item '
  'creation time) — same sync path as affects_uif.';


-- ── payroll_period_inputs ─────────────────────────────────────────────────────
-- Current-period (one-off) inputs entered per employee per month.
-- These records do NOT always have a payroll_item_id link (the foreign key is
-- optional), so taxable_percentage CANNOT be reliably read via the
-- payroll_items join — storing it directly on the record is the only
-- reliable path, same reasoning as affects_uif/is_taxable on this table.
--
-- Default 100.00: all existing records remain fully taxable/UIF-applicable
-- until re-saved.

ALTER TABLE payroll_period_inputs
  ADD COLUMN IF NOT EXISTS taxable_percentage NUMERIC(5,2) NOT NULL DEFAULT 100.00
    CHECK (taxable_percentage BETWEEN 0 AND 100);

COMMENT ON COLUMN payroll_period_inputs.taxable_percentage IS
  'Percentage of this one-off input''s amount that counts toward PAYE taxable '
  'income AND the UIF contribution base. Set at insert time from '
  'payroll_items_master.taxable_percentage (matched by description), same as '
  'affects_uif/is_taxable. Default 100: fully taxable/UIF-applicable.';
