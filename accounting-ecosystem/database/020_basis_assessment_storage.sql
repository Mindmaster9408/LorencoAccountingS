-- Migration 020: Add BASIS assessment storage to coaching_clients
-- Purpose: Persist basis_answers and basis_results per client so the
--          report generator has data across page reloads.
--
-- Run once against the production database.
-- Safe to re-run (ADD COLUMN IF NOT EXISTS).

ALTER TABLE coaching_clients
    ADD COLUMN IF NOT EXISTS basis_answers JSONB,
    ADD COLUMN IF NOT EXISTS basis_results JSONB;
