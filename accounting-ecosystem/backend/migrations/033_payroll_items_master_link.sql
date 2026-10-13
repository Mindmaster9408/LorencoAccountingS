-- ============================================================================
-- Migration 033 — Paytime IT-02 / IT-13: link calculation items to the Payroll Items
-- screen by a fixed ID, not by name
-- ============================================================================
-- payroll_items (the row an employee's assignment points to) found its settings and
-- IRP5 code in payroll_items_master by NAME. Renaming an item on the Payroll Items
-- screen therefore cut every employee's assignment loose from its settings, and two
-- items with the same name (company 7: "Savings" as earning and as deduction) were
-- ambiguous.
-- This adds payroll_items.master_item_id and fills it for existing rows by name AND
-- side (earning / deduction / employer contribution). Rows with no unique match stay
-- NULL and keep working by name + side exactly as before.
-- Additive, idempotent. No figures change.
-- ============================================================================

ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS master_item_id INTEGER
  REFERENCES payroll_items_master(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_items_master_item_id ON payroll_items(master_item_id);

-- side: deduction / employer / earning (income, allowance, earning, anything else)
WITH m AS (
  SELECT id, company_id, lower(trim(item_name)) AS n,
         CASE WHEN item_type = 'deduction' THEN 'deduction'
              WHEN item_type IN ('employer_contribution', 'company_contribution') THEN 'employer'
              ELSE 'earning' END AS side
    FROM payroll_items_master
), uniq AS (
  SELECT company_id, n, side, min(id) AS id
    FROM m GROUP BY company_id, n, side HAVING count(*) = 1
)
UPDATE payroll_items p
   SET master_item_id = u.id
  FROM uniq u
 WHERE p.master_item_id IS NULL
   AND u.company_id = p.company_id
   AND u.n = lower(trim(p.name))
   AND u.side = CASE WHEN p.item_type = 'deduction' THEN 'deduction'
                     WHEN p.item_type IN ('employer_contribution', 'company_contribution') THEN 'employer'
                     ELSE 'earning' END;

COMMENT ON COLUMN payroll_items.master_item_id IS
  'Paytime IT-02: the Payroll Items screen row (payroll_items_master.id) this calculation item belongs to. Migration 033.';
