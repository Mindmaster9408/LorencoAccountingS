-- ============================================================================
-- Migration 029 — Paytime Fase 8: attendance → payroll (approved proposals)
-- ============================================================================
-- Spec: docs/paytime/spec/05 PI-08 (option b, owner-confirmed), PI-09; finding V1.
-- Change Impact Note: docs/paytime/FASE8_CHANGE_IMPACT_NOTE.md
--
-- 1. payroll_overtime.source / payroll_short_time.source: 'manual' (default) or
--    'attendance'. Rows from an approved attendance proposal are visible and
--    deletable on the payslip like any other row, but re-applying attendance only
--    replaces the 'attendance' rows — never the ones typed in by hand.
-- 2. paytime_replace_period_rows() keeps a row's source when the payslip screen
--    re-saves the list (it re-sends every row).
-- 3. paytime_apply_attendance(): replaces one employee's attendance rows for a
--    period in ONE transaction; refuses (PERIOD_LOCKED) when the month is finalized.
--
-- Idempotent, additive. Existing rows become 'manual' (they were all typed in).
-- ============================================================================

ALTER TABLE payroll_overtime   ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE payroll_short_time ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE payroll_overtime   DROP CONSTRAINT IF EXISTS payroll_overtime_source_check;
ALTER TABLE payroll_overtime   ADD  CONSTRAINT payroll_overtime_source_check   CHECK (source IN ('manual', 'attendance'));
ALTER TABLE payroll_short_time DROP CONSTRAINT IF EXISTS payroll_short_time_source_check;
ALTER TABLE payroll_short_time ADD  CONSTRAINT payroll_short_time_source_check CHECK (source IN ('manual', 'attendance'));

-- ── shared lock check ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION paytime_assert_period_open(p_company_id INTEGER, p_employee_id INTEGER, p_period_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_period_key TEXT;
BEGIN
  SELECT period_key INTO v_period_key FROM payroll_periods WHERE id = p_period_id AND company_id = p_company_id;
  IF v_period_key IS NULL THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND';
  END IF;
  IF EXISTS (
    SELECT 1 FROM payroll_snapshots
     WHERE company_id = p_company_id AND employee_id = p_employee_id
       AND period_key = v_period_key AND is_locked = TRUE AND COALESCE(status, '') <> 'reversed'
  ) THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING DETAIL = v_period_key;
  END IF;
  RETURN v_period_key;
END;
$$;

-- ── 2. replace (payslip screen) now keeps source ────────────────────────────
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
  v_count INTEGER := 0;
BEGIN
  IF p_table NOT IN ('payroll_period_inputs', 'payroll_overtime', 'payroll_short_time', 'payroll_multi_rate') THEN
    RAISE EXCEPTION 'paytime_replace_period_rows: table % not allowed', p_table;
  END IF;
  PERFORM paytime_assert_period_open(p_company_id, p_employee_id, p_period_id);

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
    INSERT INTO payroll_overtime (company_id, employee_id, payroll_period_id, hours, rate_multiplier, description, source, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, COALESCE(x.hours, 0), COALESCE(x.rate_multiplier, 1.5), x.description,
           CASE WHEN x.source = 'attendance' THEN 'attendance' ELSE 'manual' END, FALSE
      FROM jsonb_to_recordset(p_rows) AS x(hours NUMERIC, rate_multiplier NUMERIC, description TEXT, source TEXT);
  ELSIF p_table = 'payroll_short_time' THEN
    INSERT INTO payroll_short_time (company_id, employee_id, payroll_period_id, hours_missed, description, source, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, COALESCE(x.hours_missed, 0), x.description,
           CASE WHEN x.source = 'attendance' THEN 'attendance' ELSE 'manual' END, FALSE
      FROM jsonb_to_recordset(p_rows) AS x(hours_missed NUMERIC, description TEXT, source TEXT);
  ELSE
    INSERT INTO payroll_multi_rate (company_id, employee_id, payroll_period_id, hours, rate_multiplier, description, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, COALESCE(x.hours, 0), COALESCE(x.rate_multiplier, 1), x.description, FALSE
      FROM jsonb_to_recordset(p_rows) AS x(hours NUMERIC, rate_multiplier NUMERIC, description TEXT);
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── 3. apply an approved attendance proposal ────────────────────────────────
CREATE OR REPLACE FUNCTION paytime_apply_attendance(
  p_company_id  INTEGER,
  p_employee_id INTEGER,
  p_period_id   INTEGER,
  p_overtime    JSONB,
  p_short_time  JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER := 0;
  v_n     INTEGER;
BEGIN
  PERFORM paytime_assert_period_open(p_company_id, p_employee_id, p_period_id);

  DELETE FROM payroll_overtime   WHERE company_id = p_company_id AND employee_id = p_employee_id
                                   AND payroll_period_id = p_period_id AND source = 'attendance';
  DELETE FROM payroll_short_time WHERE company_id = p_company_id AND employee_id = p_employee_id
                                   AND payroll_period_id = p_period_id AND source = 'attendance';

  IF p_overtime IS NOT NULL AND jsonb_typeof(p_overtime) = 'array' THEN
    INSERT INTO payroll_overtime (company_id, employee_id, payroll_period_id, hours, rate_multiplier, description, source, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, x.hours, COALESCE(x.rate_multiplier, 1.5), x.description, 'attendance', FALSE
      FROM jsonb_to_recordset(p_overtime) AS x(hours NUMERIC, rate_multiplier NUMERIC, description TEXT)
     WHERE COALESCE(x.hours, 0) > 0;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
  END IF;
  IF p_short_time IS NOT NULL AND jsonb_typeof(p_short_time) = 'array' THEN
    INSERT INTO payroll_short_time (company_id, employee_id, payroll_period_id, hours_missed, description, source, is_deleted)
    SELECT p_company_id, p_employee_id, p_period_id, x.hours_missed, x.description, 'attendance', FALSE
      FROM jsonb_to_recordset(p_short_time) AS x(hours_missed NUMERIC, description TEXT)
     WHERE COALESCE(x.hours_missed, 0) > 0;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_count := v_count + v_n;
  END IF;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION paytime_apply_attendance(INTEGER, INTEGER, INTEGER, JSONB, JSONB) IS
  'Paytime: replace one employee''s attendance-sourced overtime/short-time rows for a period; refuses a finalized month. Migration 029.';
