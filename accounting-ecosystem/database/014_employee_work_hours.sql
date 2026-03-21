-- ─── Migration 014: Employee Work Hours ──────────────────────────────────────
-- Adds hours_per_week and hours_per_day to the employees table.
-- These fields drive the hourly wage formula used in overtime and short time calculations:
--
--   Hourly wage = Monthly Salary / (hours_per_week × 4.33)
--   Overtime rate = Hourly wage × 1.5
--   Short time value = Hourly wage × hours_missed
--
-- Default: 40 hours/week (SA standard), 8 hours/day.
-- Existing employees without these fields set will automatically use the default,
-- which produces the same result as the old HOURLY_DIVISOR = 173.33 constant (40 × 4.33).
--
-- Run order: after 013_sean_learning.sql

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS hours_per_week DECIMAL(4,2) DEFAULT 40.00;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS hours_per_day DECIMAL(4,2) DEFAULT 8.00;

COMMENT ON COLUMN employees.hours_per_week IS
  'Standard weekly working hours. Used in hourly wage formula: Salary / (hours_per_week × 4.33). Default 40 hours = SA standard.';

COMMENT ON COLUMN employees.hours_per_day IS
  'Standard daily working hours. Informational — used for attendance context. Default 8 hours.';
