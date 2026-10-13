-- ============================================================================
-- Migration 032 — Paytime Fase 11: hidden payroll items in SQL (was browser/KV)
-- ============================================================================
-- Payroll Items lets a company hide items (its own or the standard built-in list)
-- from the payslip item pickers. The list lived in the KV bridge
-- (hidden_payroll_items_<company>) — CLAUDE.md Part D. No KV data existed to migrate.
-- Additive, idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_hidden_items (
  company_id  INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_name   TEXT        NOT NULL,
  hidden_by   INTEGER,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, item_name)
);

COMMENT ON TABLE payroll_hidden_items IS
  'Paytime: payroll item names a company hides from the payslip item pickers. Migration 032.';
