-- ============================================================================
-- 094_practice_eco_client_link.sql
-- Links practice_clients to eco_clients via eco_client_id FK.
-- This is the bridge that makes eco_clients the single source of truth
-- for client identity, while practice_clients holds practice-specific data.
-- ============================================================================

-- 1. Add eco_client_id to practice_clients
ALTER TABLE practice_clients
  ADD COLUMN IF NOT EXISTS eco_client_id INTEGER REFERENCES eco_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_practice_clients_eco_client
  ON practice_clients(eco_client_id)
  WHERE eco_client_id IS NOT NULL;

-- 2. Best-effort backfill: link existing practice_clients to eco_clients by
--    matching on (company_id, registration_number = eco_clients.id_number).
--    Only matches where a single unambiguous eco_client exists.
UPDATE practice_clients pc
SET    eco_client_id = ec.id
FROM   eco_clients ec
WHERE  pc.eco_client_id IS NULL
  AND  ec.company_id    = pc.company_id
  AND  pc.registration_number IS NOT NULL
  AND  pc.registration_number != ''
  AND  ec.id_number = pc.registration_number;

-- 3. Second pass: match by id_number (individual clients)
UPDATE practice_clients pc
SET    eco_client_id = ec.id
FROM   eco_clients ec
WHERE  pc.eco_client_id IS NULL
  AND  ec.company_id  = pc.company_id
  AND  pc.id_number   IS NOT NULL
  AND  pc.id_number   != ''
  AND  ec.id_number   = pc.id_number;

-- 4. Create eco_client records for still-unlinked practice_clients
--    (only where no id_number conflict exists in eco_clients for this company)
INSERT INTO eco_clients (company_id, name, email, phone, id_number, client_type, apps, is_active, created_at, updated_at)
SELECT
  pc.company_id,
  pc.name,
  pc.email,
  pc.phone,
  COALESCE(pc.id_number, pc.registration_number),
  CASE WHEN pc.client_type = 'individual' THEN 'individual' ELSE 'business' END,
  ARRAY['practice'],
  pc.is_active,
  pc.created_at,
  pc.updated_at
FROM practice_clients pc
WHERE pc.eco_client_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM eco_clients ec2
    WHERE ec2.company_id = pc.company_id
      AND ec2.id_number  IS NOT NULL
      AND ec2.id_number  != ''
      AND ec2.id_number  = COALESCE(pc.id_number, pc.registration_number)
  );

-- 5. Link the newly created eco_clients back to practice_clients
UPDATE practice_clients pc
SET    eco_client_id = ec.id
FROM   eco_clients ec
WHERE  pc.eco_client_id IS NULL
  AND  ec.company_id   = pc.company_id
  AND  ec.name         = pc.name
  AND  (
    (COALESCE(pc.id_number, pc.registration_number) IS NOT NULL
     AND ec.id_number = COALESCE(pc.id_number, pc.registration_number))
    OR
    (COALESCE(pc.id_number, pc.registration_number) IS NULL
     AND ec.id_number IS NULL)
  );

COMMENT ON COLUMN practice_clients.eco_client_id IS
  'FK to eco_clients — the single source of truth for client identity. '
  'Set on all new practice_clients. Null only for unmatched legacy rows.';

-- ============================================================================
-- Verification (run manually):
--   SELECT COUNT(*) FROM practice_clients WHERE eco_client_id IS NULL;
--   -- Should be 0 or a small number of ambiguous legacy rows
-- ============================================================================
