-- =============================================================================
-- Migration 140: Paytime Sean Chat — action log
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Purpose: SEVCO's Paytime chat feature lets a superuser type a natural-
-- language payroll request (e.g. "gee Jan 5 ure oortyd") which is matched
-- against a deterministic recipe (no external LLM), confirmed, then executed
-- through the existing validated Paytime routes (transactions.js/employees.js)
-- — never a direct write from this table's owning module. This table is the
-- immutable audit/learning log for every attempt (successful or refused),
-- following the same convention as sean_learning_events / sean_irp5_
-- propagation_log (see database/011_sean_irp5_learning.sql): who asked, exact
-- text, what was matched, what happened. Purely additive — no existing table
-- touched, no existing payroll table altered.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS sean_paytime_chat_actions (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id         INTEGER      REFERENCES employees(id) ON DELETE SET NULL,
    requested_by        INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    raw_text            TEXT         NOT NULL,
    matched_recipe      TEXT,        -- 'ADD_OVERTIME'|'ADD_SHORT_TIME'|'ADD_PAYSLIP_ITEM'|'ADJUST_SALARY'|NULL (no match)
    slots               JSONB,       -- extracted amount/hours/description/period_key etc.
    period_key          TEXT,        -- YYYY-MM
    lock_check_result   TEXT         NOT NULL DEFAULT 'not_checked'
                                        CHECK (lock_check_result IN ('not_checked','unlocked','locked_refused')),
    execution_result    JSONB,       -- { success, error, response } from the downstream route call
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sean_paytime_chat_actions_company
    ON sean_paytime_chat_actions (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sean_paytime_chat_actions_employee
    ON sean_paytime_chat_actions (employee_id, period_key);

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'sean_paytime_chat_actions'
ORDER BY ordinal_position;
