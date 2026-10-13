-- ============================================================================
-- Migration 031 — Paytime Fase 11.3: basic salary from the legacy KV into employees
-- ============================================================================
-- DATA change (Ruan's go-ahead required). Change Impact Note: FASE11_CHANGE_IMPACT_NOTE.md
--
-- PayrollDataService falls back to the legacy KV row `emp_payroll_<company>_<employee>`
-- when employees.basic_salary is empty. On 2026-10-13, 20 employees (18 active, 11
-- companies) got their salary ONLY through that fallback. This copies the KV salary
-- into employees.basic_salary for exactly those employees, so the fallback can be
-- removed without anyone's salary becoming R0.
--
-- Only touches rows where the DB salary is NULL/0 and the KV salary is > 0.
-- Every change is written to audit_log (old/new value). Idempotent (second run: 0 rows).
-- ============================================================================

WITH src AS (
  SELECT e.id, e.company_id, (k.value->>'basic_salary')::numeric AS kv_salary
    FROM employees e
    JOIN payroll_kv_store_eco k
      ON k.company_id::text = e.company_id::text
     AND k.key = 'emp_payroll_' || e.company_id || '_' || e.id
   WHERE COALESCE(e.basic_salary, 0) = 0
     AND COALESCE((k.value->>'basic_salary')::numeric, 0) > 0
), upd AS (
  UPDATE employees e
     SET basic_salary = src.kv_salary, updated_at = now()
    FROM src
   WHERE e.id = src.id
  RETURNING e.id, e.company_id, src.kv_salary
)
INSERT INTO audit_log (company_id, user_email, module, action_type, entity_type, entity_id, field_name, old_value, new_value, metadata, created_at)
SELECT company_id, 'migration-031', 'payroll', 'UPDATE', 'employee', id::text, 'basic_salary', '0',
       kv_salary::text, '{"reason":"Fase 11.3 backfill from legacy KV emp_payroll"}', now()
  FROM upd;
