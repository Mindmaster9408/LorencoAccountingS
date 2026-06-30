-- ============================================================================
-- 096_eco_client_code_trigger.sql
-- Root cause: eco_clients created after migration 092 (which backfilled
-- client_code via a one-time UPDATE) have client_code = NULL because no
-- trigger or application-level code generates it on INSERT.
--
-- Affected rows:
--   - eco_clients created by migration 094 backfill (step 4 INSERT)
--   - eco_clients created by POST /api/practice/clients (new client flow)
--   - Any future INSERT that doesn't supply a client_code
--
-- Fix:
--   A. Backfill NULL client_code using the same deterministic formula as 092.
--   B. Create a BEFORE INSERT trigger so future INSERTs auto-generate client_code.
--
-- The formula:  'CLT-' || UPPER(SUBSTRING(md5('lec092-client-' || id::TEXT), 1, 8))
-- This is collision-free for any practical dataset size and matches all existing codes.
-- PostgreSQL allocates the sequence id BEFORE BEFORE INSERT triggers fire,
-- so NEW.id is available inside the trigger body.
-- ============================================================================

-- ── A. Backfill existing NULLs ───────────────────────────────────────────────

UPDATE eco_clients
SET    client_code = 'CLT-' || UPPER(SUBSTRING(md5('lec092-client-' || id::TEXT), 1, 8)),
       updated_at  = NOW()
WHERE  client_code IS NULL;

-- ── B. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_eco_client_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_code IS NULL THEN
    NEW.client_code := 'CLT-' || UPPER(SUBSTRING(md5('lec092-client-' || NEW.id::TEXT), 1, 8));
  END IF;
  RETURN NEW;
END;
$$;

-- ── C. Attach trigger to eco_clients ─────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_eco_client_code ON eco_clients;

CREATE TRIGGER trg_eco_client_code
  BEFORE INSERT ON eco_clients
  FOR EACH ROW
  EXECUTE FUNCTION fn_eco_client_code();

-- ── Verification queries (run manually after applying) ────────────────────────
-- 1. No NULLs remain:
--    SELECT COUNT(*) FROM eco_clients WHERE client_code IS NULL;
--    Expected: 0
--
-- 2. All codes follow CLT-XXXXXXXX format:
--    SELECT COUNT(*) FROM eco_clients WHERE client_code NOT LIKE 'CLT-%';
--    Expected: 0
--
-- 3. Trigger exists:
--    SELECT tgname FROM pg_trigger WHERE tgrelid = 'eco_clients'::regclass;
--    Expected: trg_eco_client_code in results
-- ============================================================================
