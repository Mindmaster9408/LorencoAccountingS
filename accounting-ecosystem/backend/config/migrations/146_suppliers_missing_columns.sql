-- =============================================================================
-- Migration 146: Add missing columns to suppliers
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: full audit of suppliers.js (2026-08-24) found that POST /suppliers
-- and PUT /suppliers/:id have always written to type, registration_number,
-- city, postal_code — all real, live form fields on suppliers.html (fieldType,
-- fieldRegNo, fieldCity, fieldPostal) — but none of these columns exist on the
-- live suppliers table. Every supplier create/update has been silently
-- discarding this data (Postgres rejects the whole insert/update with a
-- "column does not exist" error, which the route swallows into a generic 500).
--
-- Fix: add the 4 missing nullable columns. Purely additive — no existing
-- column touched, no existing row affected.
-- =============================================================================

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS registration_number TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'suppliers' AND column_name IN ('type', 'registration_number', 'city', 'postal_code')
ORDER BY column_name;
