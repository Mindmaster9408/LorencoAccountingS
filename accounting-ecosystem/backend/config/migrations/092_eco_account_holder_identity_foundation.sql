-- ============================================================================
-- Migration 092 — Eco Account Holder Identity Foundation
-- ============================================================================
-- Adds practice_code to companies and client_code to eco_clients.
-- Backfills existing rows. Adds per-practice duplicate protection index.
-- Marks users.role as LEGACY.
--
-- Safe to run on a live database:
--   - All ALTER TABLE use IF NOT EXISTS
--   - All CREATE INDEX use IF NOT EXISTS
--   - Backfills are UPDATE ... WHERE column IS NULL (idempotent)
--   - No existing data is removed or modified in a breaking way
--   - All new columns are nullable (no NOT NULL constraint added yet)
-- ============================================================================

-- ── 1. Practice Code on companies ──────────────────────────────────────────
-- Human-readable unique identifier for accounting practice companies.
-- Format: PRAC-NNNN  (e.g. PRAC-0001, PRAC-0042)
-- Generated only for account_holder_type = 'accounting_practice'.
-- Business owners and standalone companies do not get a practice_code.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS practice_code VARCHAR(20);

-- Unique index (partial — only where not null, so NULL rows are never in conflict)
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_practice_code
  ON companies (practice_code)
  WHERE practice_code IS NOT NULL;

-- ── 2. Backfill practice_code for existing accounting practices ──────────────
-- Assigns PRAC-0001, PRAC-0002, etc. in order of company creation (id ASC).
-- Rows that already have a practice_code are skipped (WHERE practice_code IS NULL).

UPDATE companies
SET practice_code = 'PRAC-' || LPAD(rn::TEXT, 4, '0')
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
  FROM companies
  WHERE account_holder_type = 'accounting_practice'
    AND practice_code IS NULL
) sub
WHERE companies.id = sub.id;

-- ── 3. Client Code on eco_clients ──────────────────────────────────────────
-- Random, non-sequential unique reference for every eco_client.
-- Format: CLT-XXXXXXXX  (8 uppercase hex chars — e.g. CLT-A3F9B2C1)
-- Globally unique (not scoped per-practice) so it can be used as an external reference.
-- The serial id column is never used as a client reference in any UI or API.

ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS client_code VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_clients_client_code
  ON eco_clients (client_code)
  WHERE client_code IS NOT NULL;

-- ── 4. Backfill client_code for existing eco_clients ────────────────────────
-- Uses a deterministic seed per row (namespace + id) so the result is stable
-- across re-runs and collision-free for any realistic dataset size.
-- Existing rows with a non-null client_code are skipped.

UPDATE eco_clients
SET client_code = 'CLT-' || UPPER(SUBSTRING(md5('lec092-client-' || id::TEXT), 1, 8))
WHERE client_code IS NULL;

-- ── 5. Per-practice uniqueness on registration / ID number ──────────────────
-- Prevents a practice from adding the same client twice under different names.
-- Scoped to (company_id, id_number) so the same client CAN exist under different
-- practices (inter-practice clients are valid — each practice registers them independently).
-- Partial: only applied where id_number is present and non-empty.

CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_clients_practice_id_number
  ON eco_clients (company_id, id_number)
  WHERE id_number IS NOT NULL AND id_number != '';

-- ── 6. Mark users.role as LEGACY ────────────────────────────────────────────
-- The users.role column is no longer used for any access control decision.
-- The authoritative role for every context is user_company_access.role.
-- The column is left in place to avoid breaking any external integrations
-- that may still read it, but no application code should write to or trust it.

COMMENT ON COLUMN users.role IS
  'LEGACY — do not use for access decisions. '
  'The authoritative role for any company context is always user_company_access.role. '
  'This column is retained only for backward compatibility. '
  'Added: migration 092 (2026-06-26).';

-- ============================================================================
-- Verification queries (run manually after applying migration)
-- ============================================================================
--
-- Check practice codes assigned:
--   SELECT id, company_name, account_holder_type, practice_code
--   FROM companies
--   WHERE account_holder_type = 'accounting_practice'
--   ORDER BY id;
--
-- Check client codes assigned:
--   SELECT id, name, client_code FROM eco_clients ORDER BY id LIMIT 20;
--
-- Confirm uniqueness index on id_number:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'eco_clients' AND indexname = 'idx_eco_clients_practice_id_number';
--
-- Confirm no practice_code collisions:
--   SELECT practice_code, COUNT(*) FROM companies
--   WHERE practice_code IS NOT NULL
--   GROUP BY practice_code HAVING COUNT(*) > 1;
-- ============================================================================
