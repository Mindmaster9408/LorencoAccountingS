-- Migration 040: Add employee_id to user_company_access
-- Stores a per-company staff reference code (e.g. "TIL-01", "EMP-001") for a user.
-- Nullable VARCHAR — no FK to employees table; this is a soft human-readable reference.
-- Safe to re-run: IF NOT EXISTS guard.

ALTER TABLE user_company_access
  ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50);
