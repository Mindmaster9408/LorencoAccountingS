-- =============================================================================
-- Migration 157: Full-access trial period on companies
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: a brand-new self-registered "Accounting Practice" account
-- (POST /api/auth/register, account_type: 'accountant') got
-- account_holder_type = 'accounting_practice' correctly, but
-- modules_enabled was hardcoded to ['pos','payroll','accounting','sean'] —
-- 'practice' was never included, so the very app they signed up specifically
-- to use (Firmflow) was blocked immediately by the Practice Module Gate
-- (shared/routes/auth.js, "Practice Management is not enabled for your
-- company"). Confirmed no other code path ever added 'practice' to
-- modules_enabled at registration time.
--
-- Fix (Ruan's explicit call, 2026-08-29): every new signup — accounting
-- practice or business owner — gets FULL access to every app they're
-- eligible for during a 30-day trial (same 30-day convention as the existing
-- Paytime demo company), then automatically drops back to the real paid
-- baseline once the trial ends. Business owners are never eligible for
-- Firmflow (practice) at any point, trial included — that stays
-- accounting-practice-only, unconditionally.
--
-- trial_expires_at   — when the trial ends. NULL means "not on a trial"
--                      (either never was, or already reverted).
-- trial_base_modules — the modules_enabled to revert to once the trial
--                      ends — captured at signup so the revert never has to
--                      guess what the company actually paid for.
--
-- Purely additive — no existing column touched, no existing company's
-- modules_enabled changed by this migration (both new columns default to
-- NULL, so every existing company is simply "not on a trial").
-- =============================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS trial_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_base_modules JSONB;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'companies' AND column_name IN ('trial_expires_at', 'trial_base_modules');
