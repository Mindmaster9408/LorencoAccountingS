-- ============================================================================
-- Migration: Add Voluntary Tax Over-Deduction Config Table
-- ============================================================================
-- This table stores configuration for the "Voluntary Tax Over-Deduction" payroll item.
-- Supports both fixed and bonus-linked options per employee.

CREATE TABLE IF NOT EXISTS voluntary_tax_config (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('fixed', 'bonus_linked')),
  fixed_amount DECIMAL(15,2),
  expected_bonus DECIMAL(15,2),
  bonus_month INTEGER, -- 1=Jan, 12=Dec
  start_month INTEGER, -- 1=Jan, 12=Dec
  calculated_monthly_adjustment DECIMAL(15,2),
  last_recalculated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voluntary_tax_config_employee ON voluntary_tax_config(employee_id);

-- ============================================================================
-- Add deduction type to paye_config_deduction_types
-- (This can also be done via the app config UI, but included here for completeness)
INSERT INTO paye_config_deduction_types (company_id, key, label, is_default, is_custom, is_active)
SELECT c.id, 'voluntary_tax_overdeduction', 'Voluntary Tax Over-Deduction', false, true, true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM paye_config_deduction_types d WHERE d.company_id = c.id AND d.key = 'voluntary_tax_overdeduction'
);
-- ============================================================================
