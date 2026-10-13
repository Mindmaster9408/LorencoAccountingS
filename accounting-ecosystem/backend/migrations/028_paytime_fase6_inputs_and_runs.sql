-- ============================================================================
-- Migration 028 — Paytime Fase 6: locked-period inputs + superseded draft runs
-- ============================================================================
-- Spec: docs/paytime/spec/07 (UF-06), 08 (PS-02); findings B3, V5.
-- Change Impact Note: docs/paytime/FASE6_CHANGE_IMPACT_NOTE.md
--
-- 1. paytime_replace_period_rows(): replaces an employee's current inputs /
--    overtime / short time / multi-rate for one pay period in ONE transaction
--    (the old routes deleted first and inserted afterwards — a failed insert
--    lost the inputs), and refuses when that employee's month is finalized
--    (a locked, non-reversed snapshot exists) — error PERIOD_LOCKED.
-- 2. payroll_runs.status gains 'superseded' (+ who/when). A draft run whose
--    snapshots were all recalculated into a newer run is marked superseded and
--    can no longer be finalized (UF-06).
--
-- Idempotent. Additive only — no data is changed by this file.
-- The backend falls back to the old behaviour while this has not run.
-- ============================================================================

-- ── 1. Atomic, lock-aware replace of period inputs ──────────────────────────
CREATE OR REPLACE FUNCTION paytime_replace_period_rows(
  p_table       TEXT,
  p_company_id  INTEGER,
  p_employee_id INTEGER,
  p_period_id   INTEGER,
  p_rows        JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_period_key TEXT;
  v_count      INTEGER := 0;
BEGIN
  IF p_table NOT IN ('payroll_period_inputs', 'payroll_overtime', 'payroll_short_time', 'payroll_multi_rate') THEN
    RAISE EXCEPTION 'paytime_replace_period_rows: table % not allowed', p_table;
  END IF;

  SELECT period_key INTO v_period_key
    FROM payroll_periods
   WHERE id = p_period_id AND company_id = p_company_id;
  IF v_period_key IS NULL THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payroll_snapshots
     WHERE company_id = p_company_id AND employee_id = p_employee_id
       AND period_key = v_period_key AND is_locked = TRUE
       AND COALESCE(status, '') <> 'reversed'
  ) THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING DETAIL = v_period_key;
  END IF;

  EXECUTE format('DELETE FROM %I WHERE company_id = $1 AND employee_id = $2 AND payroll_period_id = $3', p_table)
    USING p_company_id, p_employee_id, p_period_id;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  IF p_table = 'payroll_period_inputs' THEN
    INSERT INTO payroll_period_inputs
      (company_id, employee_id, payroll_period_id, payroll_item_id, description, amount, item_type, affects_uif, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, x.payroll_item_id, x.description,
           COALESCE(x.amount, 0), COALESCE(x.item_type, 'earning'), COALESCE(x.affects_uif, TRUE), FALSE
      FROM jsonb_to_recordset(p_rows) AS x(payroll_item_id INTEGER, description TEXT, amount NUMERIC, item_type TEXT, affects_uif BOOLEAN);
  ELSIF p_table = 'payroll_overtime' THEN
    INSERT INTO payroll_overtime (company_id, employee_id, payroll_period_id, hours, rate_multiplier, description, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, COALESCE(x.hours, 0), COALESCE(x.rate_multiplier, 1.5), x.description, FALSE
      FROM jsonb_to_recordset(p_rows) AS x(hours NUMERIC, rate_multiplier NUMERIC, description TEXT);
  ELSIF p_table = 'payroll_short_time' THEN
    INSERT INTO payroll_short_time (company_id, employee_id, payroll_period_id, hours_missed, description, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, COALESCE(x.hours_missed, 0), x.description, FALSE
      FROM jsonb_to_recordset(p_rows) AS x(hours_missed NUMERIC, description TEXT);
  ELSE
    INSERT INTO payroll_multi_rate (company_id, employee_id, payroll_period_id, hours, rate_multiplier, description, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, COALESCE(x.hours, 0), COALESCE(x.rate_multiplier, 1), x.description, FALSE
      FROM jsonb_to_recordset(p_rows) AS x(hours NUMERIC, rate_multiplier NUMERIC, description TEXT);
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION paytime_replace_period_rows(TEXT, INTEGER, INTEGER, INTEGER, JSONB) IS
  'Paytime: replace one employee''s period inputs atomically; refuses (PERIOD_LOCKED) when the month is finalized. Migration 028.';

-- ── 2. Superseded draft runs ────────────────────────────────────────────────
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_status_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_status_check
  CHECK (status IN ('draft', 'finalized', 'reversed', 'superseded'));

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS superseded_by_run_id UUID;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
