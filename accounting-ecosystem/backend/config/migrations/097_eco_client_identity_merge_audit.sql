-- ============================================================================
-- 097_eco_client_identity_merge_audit.sql
-- Audit and merge duplicate eco_client identity records.
--
-- A "duplicate" is: same real-world client registered more than once under
-- the same practice (same company_id), resulting in multiple client_codes
-- for the same person or entity.
--
-- TABLES REFERENCING eco_clients.id (must be re-pointed on merge):
--   practice_clients.eco_client_id      ON DELETE SET NULL
--   customers.eco_client_id             ON DELETE SET NULL
--   employees.eco_client_id             ON DELETE SET NULL
--   eco_client_firm_access.eco_client_id ON DELETE CASCADE + UNIQUE(eco_client_id, firm_company_id)
--   user_client_access.eco_client_id    ON DELETE CASCADE + UNIQUE(user_id, company_id, eco_client_id)
--
-- RUN ORDER:
--   1. Run PHASE 1 (read-only) and review the output.
--   2. Decide which pairs to merge (HIGH confidence safe for auto; MEDIUM/LOW manual).
--   3. Uncomment and run PHASE 2 for each confirmed pair.
--   4. Run PHASE 3 verification.
--   5. Only after verification passes: uncomment the soft-delete block.
-- ============================================================================

-- ============================================================================
-- PHASE 1 — AUDIT QUERIES (READ-ONLY, safe to run anytime)
-- ============================================================================

-- ── A. Exact id_number duplicates within same practice ────────────────────────
-- These are HIGH confidence — same id/reg number = same legal entity.
SELECT
    ec1.company_id                             AS practice_company_id,
    ec1.id_number                              AS shared_id_number,
    ec1.id                                     AS record_A_id,
    ec1.name                                   AS record_A_name,
    ec1.client_code                            AS record_A_code,
    ec1.client_company_id                      AS record_A_linked_company,
    ec1.apps                                   AS record_A_apps,
    ec1.created_at                             AS record_A_created,
    ec2.id                                     AS record_B_id,
    ec2.name                                   AS record_B_name,
    ec2.client_code                            AS record_B_code,
    ec2.client_company_id                      AS record_B_linked_company,
    ec2.apps                                   AS record_B_apps,
    ec2.created_at                             AS record_B_created,
    -- Canonical selection: prefer one with client_company_id; then most apps; then older id
    CASE
      WHEN ec1.client_company_id IS NOT NULL AND ec2.client_company_id IS NULL THEN ec1.id
      WHEN ec2.client_company_id IS NOT NULL AND ec1.client_company_id IS NULL THEN ec2.id
      WHEN COALESCE(cardinality(ec1.apps), 0) >= COALESCE(cardinality(ec2.apps), 0) THEN
           CASE WHEN ec1.id < ec2.id THEN ec1.id ELSE ec2.id END
      ELSE CASE WHEN ec1.id < ec2.id THEN ec1.id ELSE ec2.id END
    END                                        AS recommended_canonical_id,
    CASE
      WHEN ec1.client_company_id IS NOT NULL AND ec2.client_company_id IS NULL THEN ec2.id
      WHEN ec2.client_company_id IS NOT NULL AND ec1.client_company_id IS NULL THEN ec1.id
      WHEN COALESCE(cardinality(ec1.apps), 0) >= COALESCE(cardinality(ec2.apps), 0) THEN
           CASE WHEN ec1.id < ec2.id THEN ec2.id ELSE ec1.id END
      ELSE CASE WHEN ec1.id < ec2.id THEN ec2.id ELSE ec1.id END
    END                                        AS recommended_duplicate_id,
    'HIGH'                                     AS confidence,
    true                                       AS safe_auto_merge,
    'Exact id_number match within same practice' AS reason
FROM eco_clients ec1
JOIN eco_clients ec2
  ON  ec1.company_id = ec2.company_id
  AND ec1.id_number  = ec2.id_number
  AND ec1.id_number IS NOT NULL
  AND ec1.id_number != ''
  AND ec1.id < ec2.id          -- Prevent self-join and symmetric duplicates
ORDER BY ec1.company_id, ec1.id_number;

-- ── B. Registration_number duplicates (stored on practice_clients, may differ from id_number)
SELECT
    pc1.company_id                             AS practice_company_id,
    pc1.registration_number                    AS shared_reg_number,
    pc1.eco_client_id                          AS eco_client_A,
    pc2.eco_client_id                          AS eco_client_B,
    ec1.client_code                            AS code_A,
    ec2.client_code                            AS code_B,
    ec1.name                                   AS eco_name_A,
    ec2.name                                   AS eco_name_B,
    'HIGH'                                     AS confidence,
    'Same registration_number on practice_clients linked to different eco_clients' AS reason
FROM practice_clients pc1
JOIN practice_clients pc2
  ON  pc1.company_id          = pc2.company_id
  AND pc1.registration_number = pc2.registration_number
  AND pc1.registration_number IS NOT NULL
  AND pc1.registration_number != ''
  AND pc1.eco_client_id IS NOT NULL
  AND pc2.eco_client_id IS NOT NULL
  AND pc1.eco_client_id != pc2.eco_client_id
  AND pc1.id < pc2.id
LEFT JOIN eco_clients ec1 ON ec1.id = pc1.eco_client_id
LEFT JOIN eco_clients ec2 ON ec2.id = pc2.eco_client_id
ORDER BY pc1.company_id, pc1.registration_number;

-- ── C. Name duplicates within same practice (case-insensitive, normalized) ────
-- MEDIUM confidence — names match but no id_number to confirm same entity.
SELECT
    ec1.company_id                             AS practice_company_id,
    lower(trim(ec1.name))                      AS normalized_name,
    ec1.id                                     AS record_A_id,
    ec1.name                                   AS record_A_name,
    ec1.client_code                            AS record_A_code,
    ec1.id_number                              AS record_A_id_number,
    ec1.client_company_id                      AS record_A_linked_company,
    ec1.apps                                   AS record_A_apps,
    ec2.id                                     AS record_B_id,
    ec2.name                                   AS record_B_name,
    ec2.client_code                            AS record_B_code,
    ec2.id_number                              AS record_B_id_number,
    ec2.client_company_id                      AS record_B_linked_company,
    ec2.apps                                   AS record_B_apps,
    'MEDIUM'                                   AS confidence,
    false                                      AS safe_auto_merge,
    'Same normalised name within same practice — manual review required' AS reason
FROM eco_clients ec1
JOIN eco_clients ec2
  ON  ec1.company_id         = ec2.company_id
  AND lower(trim(ec1.name))  = lower(trim(ec2.name))
  AND ec1.id < ec2.id
  -- Exclude pairs already captured by id_number match (already HIGH confidence above)
  AND NOT (ec1.id_number IS NOT NULL AND ec1.id_number != '' AND ec1.id_number = ec2.id_number)
ORDER BY ec1.company_id, lower(trim(ec1.name));

-- ── D. practice_clients with NULL eco_client_id ──────────────────────────────
SELECT
    pc.id            AS practice_client_id,
    pc.company_id    AS practice_company_id,
    pc.name          AS client_name,
    pc.registration_number,
    pc.id_number,
    pc.email,
    pc.created_at
FROM practice_clients pc
WHERE pc.eco_client_id IS NULL
ORDER BY pc.company_id, pc.name;
-- Expected: 0 rows after migrations 094/095 ran correctly.

-- ── E. Multiple client_codes for what appears to be the same client ───────────
-- Shows all eco_clients that share a practice + name, with their codes.
SELECT
    ec.company_id              AS practice_company_id,
    lower(trim(ec.name))       AS normalized_name,
    count(*)                   AS duplicate_count,
    array_agg(ec.id ORDER BY ec.id)           AS eco_client_ids,
    array_agg(ec.client_code ORDER BY ec.id)  AS client_codes,
    array_agg(ec.id_number ORDER BY ec.id)    AS id_numbers,
    min(ec.created_at)                         AS oldest_created
FROM eco_clients ec
GROUP BY ec.company_id, lower(trim(ec.name))
HAVING count(*) > 1
ORDER BY ec.company_id, normalized_name;

-- ── F. App/licence data on duplicate records ─────────────────────────────────
-- Shows which duplicates have app activations that must be preserved.
SELECT
    ec.id          AS eco_client_id,
    ec.name,
    ec.client_code,
    ec.company_id  AS practice_company_id,
    ec.apps,
    ec.addons,
    ec.client_company_id,
    (SELECT COUNT(*) FROM practice_clients pc WHERE pc.eco_client_id = ec.id) AS practice_links,
    (SELECT COUNT(*) FROM customers c        WHERE c.eco_client_id   = ec.id) AS customer_links,
    (SELECT COUNT(*) FROM employees e        WHERE e.eco_client_id   = ec.id) AS employee_links,
    (SELECT COUNT(*) FROM eco_client_firm_access cfa WHERE cfa.eco_client_id = ec.id) AS firm_access_links,
    (SELECT COUNT(*) FROM user_client_access  uca WHERE uca.eco_client_id  = ec.id) AS user_access_links
FROM eco_clients ec
WHERE ec.id IN (
    -- All IDs that appear in any of the duplicate sets above
    SELECT ec1.id FROM eco_clients ec1
    JOIN eco_clients ec2
      ON ec1.company_id = ec2.company_id
      AND lower(trim(ec1.name)) = lower(trim(ec2.name))
      AND ec1.id <> ec2.id
)
ORDER BY ec.company_id, ec.name, ec.id;

-- ============================================================================
-- PHASE 2 — SAFE MERGE SCRIPT
-- For each confirmed HIGH-confidence duplicate pair:
--   canonical_id  = the record to keep (from Phase 1 output)
--   duplicate_id  = the record to merge away
--
-- SUBSTITUTE :canonical_id and :duplicate_id before running.
-- Run one pair at a time. Verify after each pair.
-- ALL STATEMENTS BELOW ARE COMMENTED — UNCOMMENT ONE BLOCK AT A TIME.
-- ============================================================================

/*
-- ── STEP 1: Merge apps array on canonical (union — don't lose activations) ───
UPDATE eco_clients
SET    apps       = ARRAY(SELECT DISTINCT UNNEST(COALESCE(apps, '{}'))
                          UNION
                          SELECT DISTINCT UNNEST(COALESCE(
                            (SELECT apps FROM eco_clients WHERE id = :duplicate_id),
                          '{}'))),
       updated_at = NOW()
WHERE  id = :canonical_id;

-- ── STEP 2: Merge addons on canonical ────────────────────────────────────────
UPDATE eco_clients
SET    addons     = ARRAY(SELECT DISTINCT UNNEST(COALESCE(addons, '{}'))
                          UNION
                          SELECT DISTINCT UNNEST(COALESCE(
                            (SELECT addons FROM eco_clients WHERE id = :duplicate_id),
                          '{}'))),
       updated_at = NOW()
WHERE  id = :canonical_id;

-- ── STEP 3: Fill NULL identity fields on canonical from duplicate ─────────────
UPDATE eco_clients c
SET    email     = COALESCE(c.email,     d.email),
       phone     = COALESCE(c.phone,     d.phone),
       id_number = COALESCE(c.id_number, d.id_number),
       address   = COALESCE(c.address,   d.address),
       updated_at = NOW()
FROM   eco_clients d
WHERE  c.id = :canonical_id
  AND  d.id = :duplicate_id;

-- ── STEP 4: Re-point practice_clients ────────────────────────────────────────
UPDATE practice_clients
SET    eco_client_id = :canonical_id,
       updated_at    = NOW()
WHERE  eco_client_id = :duplicate_id;

-- ── STEP 5: Re-point customers ───────────────────────────────────────────────
UPDATE customers
SET    eco_client_id = :canonical_id
WHERE  eco_client_id = :duplicate_id;

-- ── STEP 6: Re-point employees ───────────────────────────────────────────────
UPDATE employees
SET    eco_client_id = :canonical_id
WHERE  eco_client_id = :duplicate_id;

-- ── STEP 7: Merge eco_client_firm_access (skip rows that already exist for canonical)
INSERT INTO eco_client_firm_access (eco_client_id, firm_company_id, is_active, granted_at)
SELECT :canonical_id, cfa.firm_company_id, cfa.is_active, cfa.granted_at
FROM   eco_client_firm_access cfa
WHERE  cfa.eco_client_id = :duplicate_id
  AND  NOT EXISTS (
    SELECT 1 FROM eco_client_firm_access existing
    WHERE  existing.eco_client_id   = :canonical_id
      AND  existing.firm_company_id = cfa.firm_company_id
  );

-- ── STEP 8: Merge user_client_access (skip rows that already exist for canonical)
INSERT INTO user_client_access (user_id, company_id, eco_client_id, granted_by, granted_at)
SELECT uca.user_id, uca.company_id, :canonical_id, uca.granted_by, uca.granted_at
FROM   user_client_access uca
WHERE  uca.eco_client_id = :duplicate_id
  AND  NOT EXISTS (
    SELECT 1 FROM user_client_access existing
    WHERE  existing.user_id       = uca.user_id
      AND  existing.company_id    = uca.company_id
      AND  existing.eco_client_id = :canonical_id
  );

-- ── STEP 9: Soft-delete the duplicate (do NOT hard-delete yet) ───────────────
-- Only run after verifying PHASE 3 verification queries pass.
UPDATE eco_clients
SET    is_active   = false,
       name        = name || ' [MERGED-INTO-' || :canonical_id::TEXT || ']',
       updated_at  = NOW()
WHERE  id = :duplicate_id;

-- ── ROLLBACK: If anything looks wrong, restore with: ─────────────────────────
-- UPDATE eco_clients SET is_active = true, name = <original_name>, updated_at = NOW() WHERE id = :duplicate_id;
-- UPDATE practice_clients SET eco_client_id = :duplicate_id, updated_at = NOW() WHERE eco_client_id = :canonical_id AND <conditions>;
-- (Keep duplicate alive until all references are confirmed on canonical.)
*/

-- ============================================================================
-- PHASE 3 — VERIFICATION (run after each merge pair)
-- ============================================================================

-- V1: Confirm no orphaned practice_clients
-- SELECT COUNT(*) FROM practice_clients WHERE eco_client_id IS NULL;
-- Expected: 0

-- V2: Confirm the duplicate_id no longer appears in any reference table
-- SELECT COUNT(*) FROM practice_clients    WHERE eco_client_id = :duplicate_id;
-- SELECT COUNT(*) FROM customers            WHERE eco_client_id = :duplicate_id;
-- SELECT COUNT(*) FROM employees            WHERE eco_client_id = :duplicate_id;
-- SELECT COUNT(*) FROM eco_client_firm_access WHERE eco_client_id = :duplicate_id;
-- SELECT COUNT(*) FROM user_client_access  WHERE eco_client_id = :duplicate_id;
-- All expected: 0

-- V3: Confirm canonical has the merged apps/addons
-- SELECT id, name, client_code, apps, addons FROM eco_clients WHERE id = :canonical_id;

-- V4: Confirm no remaining duplicates by id_number
-- SELECT company_id, id_number, COUNT(*) FROM eco_clients
-- WHERE id_number IS NOT NULL AND id_number != '' AND is_active = true
-- GROUP BY company_id, id_number HAVING COUNT(*) > 1;
-- Expected: 0 rows

-- V5: Confirm Turkstra (or any specific client) shows exactly one client_code
-- SELECT id, name, client_code, company_id FROM eco_clients
-- WHERE lower(trim(name)) LIKE '%turkstra%';
-- Expected: 1 row
-- ============================================================================
