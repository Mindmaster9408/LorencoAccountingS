-- ============================================================================
-- 095_practice_client_identity_hardening.sql
-- Corrects data integrity issues introduced by the initial Practice/eco_client
-- integration (migrations 094 + first deploy of practice/index.js POST handler).
--
-- Problem 1: POST /practice/clients created eco_clients with apps: ['practice'].
--            The 'practice' app in eco_clients.apps is a PCC billing signal for
--            the PRACTICE FIRM ITSELF, not for client identity records.
--            These must be cleared.
--
-- Problem 2: Migration 094 step 4 also created eco_clients with apps: ['practice'].
--            Same issue — those eco_clients are client identity records, not firms.
--
-- Problem 3: Any practice_clients with eco_client_id IS NULL (orphaned by a
--            failed eco_client creation) must be linked before the NOT NULL
--            constraint can be added.
--
-- RUN SEQUENCE:
--   1. Run this script in Supabase SQL Editor.
--   2. Verify the audit queries (marked VERIFY) return 0 before proceeding.
--   3. Uncomment the NOT NULL constraint line at the bottom when safe.
-- ============================================================================

-- ============================================================================
-- SECTION A — Link still-orphaned practice_clients (eco_client_id IS NULL)
-- ============================================================================

-- A1. Link by registration_number match (company-scoped)
UPDATE practice_clients pc
SET    eco_client_id = ec.id,
       updated_at    = NOW()
FROM   eco_clients ec
WHERE  pc.eco_client_id                           IS NULL
  AND  ec.company_id                               = pc.company_id
  AND  pc.registration_number                     IS NOT NULL
  AND  pc.registration_number                     != ''
  AND  ec.id_number                               = pc.registration_number;

-- A2. Link by id_number match (individual clients, company-scoped)
UPDATE practice_clients pc
SET    eco_client_id = ec.id,
       updated_at    = NOW()
FROM   eco_clients ec
WHERE  pc.eco_client_id  IS NULL
  AND  ec.company_id      = pc.company_id
  AND  pc.id_number      IS NOT NULL
  AND  pc.id_number      != ''
  AND  ec.id_number       = pc.id_number;

-- A3. For any still-NULL rows: create eco_client with apps: [] (correct)
-- Only creates if no id_number clash exists.
INSERT INTO eco_clients
  (company_id, name, email, phone, id_number, client_type, apps, is_active, created_at, updated_at)
SELECT
  pc.company_id,
  pc.name,
  pc.email,
  pc.phone,
  COALESCE(pc.id_number, pc.registration_number),
  CASE WHEN pc.client_type = 'individual' THEN 'individual' ELSE 'business' END,
  ARRAY[]::text[],
  pc.is_active,
  pc.created_at,
  NOW()
FROM practice_clients pc
WHERE pc.eco_client_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM eco_clients ec2
    WHERE ec2.company_id = pc.company_id
      AND ec2.id_number  = COALESCE(pc.id_number, pc.registration_number)
      AND ec2.id_number  IS NOT NULL
  );

-- A4. Link the newly created eco_clients back
UPDATE practice_clients pc
SET    eco_client_id = ec.id,
       updated_at    = NOW()
FROM   eco_clients ec
WHERE  pc.eco_client_id IS NULL
  AND  ec.company_id    = pc.company_id
  AND  (
    (COALESCE(pc.id_number, pc.registration_number) IS NOT NULL
     AND ec.id_number = COALESCE(pc.id_number, pc.registration_number))
    OR
    (COALESCE(pc.id_number, pc.registration_number) IS NULL
     AND ec.name = pc.name AND ec.id_number IS NULL)
  );

-- VERIFY A: Should return 0. If not 0, investigate manually before proceeding.
-- SELECT COUNT(*) AS orphaned_practice_clients
-- FROM   practice_clients
-- WHERE  eco_client_id IS NULL;

-- ============================================================================
-- SECTION B — Remove 'practice' from eco_clients.apps where it was added
--             only as a faulty Practice-client-creation side effect
-- ============================================================================
-- Safe criteria:
--   1. apps is EXACTLY ['practice'] — only the erroneous marker, nothing else
--   2. client_company_id IS NULL — this eco_client is a raw identity record
--      (no linked isolated company); real accounting-practice firms activated
--      via PCC always have client_company_id set pointing to the firm's company
--
-- This protects real PCC-activated practice access:
--   - Lorenzo (accounting_practice) was activated from TIL's PCC:
--     Lorenzo's eco_client has client_company_id = Lorenzo_company_id → PROTECTED
--   - Turkstra Bakkery (client of Lorenzo) was wrongly created with apps:['practice']:
--     Turkstra's eco_client has client_company_id IS NULL → CLEANED

-- B-AUDIT (run manually first to review before cleanup):
-- SELECT id, name, company_id, client_company_id, apps, created_at
-- FROM   eco_clients
-- WHERE  apps = ARRAY['practice']
--   AND  client_company_id IS NULL
-- ORDER  BY company_id, name;

UPDATE eco_clients
SET    apps       = ARRAY[]::text[],
       updated_at = NOW()
WHERE  apps             = ARRAY['practice']
  AND  client_company_id IS NULL;

-- VERIFY B: Should return 0.
-- SELECT COUNT(*) AS wrongly_flagged_client_identities
-- FROM   eco_clients
-- WHERE  apps = ARRAY['practice']
--   AND  client_company_id IS NULL;

-- ============================================================================
-- SECTION C — Enforce NOT NULL on practice_clients.eco_client_id
-- ============================================================================
-- Only run after VERIFY A returns 0.

-- ALTER TABLE practice_clients
--   ALTER COLUMN eco_client_id SET NOT NULL;

-- COMMENT ON COLUMN practice_clients.eco_client_id IS
--   'FK to eco_clients — central client identity. NOT NULL enforced. '
--   'eco_clients.apps controls PCC/billing activation; Practice visibility '
--   'comes from the practice_clients link itself, not from eco_clients.apps.';

-- ============================================================================
-- SECTION D — Final verification queries (run after all sections)
-- ============================================================================
-- D1: Confirm no orphaned practice_clients
-- SELECT COUNT(*) FROM practice_clients WHERE eco_client_id IS NULL;
-- Expected: 0

-- D2: Confirm no client identity records (client_company_id IS NULL) have practice in apps
-- SELECT COUNT(*) FROM eco_clients WHERE 'practice' = ANY(apps) AND client_company_id IS NULL;
-- Expected: 0

-- D3: Confirm legitimate PCC-activated practice firms are untouched
-- SELECT id, name, company_id, client_company_id, apps
-- FROM   eco_clients
-- WHERE  'practice' = ANY(apps)
--   AND  client_company_id IS NOT NULL;
-- Expected: Only real accounting_practice firms that TIL activated via PCC
-- ============================================================================
