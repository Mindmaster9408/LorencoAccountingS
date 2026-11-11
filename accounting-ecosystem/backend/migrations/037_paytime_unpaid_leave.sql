-- ============================================================================
-- Migration 037 — Paytime: approved unpaid leave becomes short time
-- ============================================================================
-- Ruan 2026-11-11. Change Impact Note: docs/paytime/UNPAID_LEAVE_CHANGE_IMPACT_NOTE.md
--
-- 1. payroll_short_time.source may now also be 'leave' (rows written from approved
--    unpaid leave). The payroll engine reads every short-time row, whatever the source.
-- 2. paytime_replace_period_rows() (payslip screen re-save) keeps 'leave' as well as
--    'attendance' — otherwise deleting another row would turn leave rows into 'manual'.
--    Same function as migration 029 otherwise.
-- 3. paytime_apply_unpaid_leave(): replaces one employee's 'leave' short-time row for a
--    period in ONE transaction; refuses (PERIOD_LOCKED) when the month is finalized.
--
-- Idempotent, additive.
-- ============================================================================

ALTER TABLE payroll_short_time DROP CONSTRAINT IF EXISTS payroll_short_time_source_check;
ALTER TABLE payroll_short_time ADD  CONSTRAINT payroll_short_time_source_check
  CHECK (source IN ('manual', 'attendance', 'leave'));

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
           CASE WHEN x.source IN ('attendance', 'leave') THEN x.source ELSE 'manual' END, FALSE
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

CREATE OR REPLACE FUNCTION paytime_apply_unpaid_leave(
  p_company_id   INTEGER,
  p_employee_id  INTEGER,
  p_period_id    INTEGER,
  p_hours        NUMERIC,
  p_description  TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM paytime_assert_period_open(p_company_id, p_employee_id, p_period_id);
  DELETE FROM payroll_short_time WHERE company_id = p_company_id AND employee_id = p_employee_id
                                   AND payroll_period_id = p_period_id AND source = 'leave';
  IF COALESCE(p_hours, 0) > 0 THEN
    INSERT INTO payroll_short_time (company_id, employee_id, payroll_period_id, hours_missed, description, source, is_deleted)
    VALUES (p_company_id, p_employee_id, p_period_id, p_hours, p_description, 'leave', FALSE);
    RETURN 1;
  END IF;
  RETURN 0;
END;
$$;
