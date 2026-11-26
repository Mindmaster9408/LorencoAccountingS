-- 191 — Director register: add plain 'director' and 'member' (close corporation)
-- roles. Kept in step with backend/modules/practice/lib/director-roles.js.
--
-- Before: role IN ('executive','non_executive','alternate'), default 'executive'
--         — "Director" was refused and a role left out was stored as executive.
-- After:  also 'director' and 'member'; default 'director'. The API now picks
--         'member' for a CC and 'director' otherwise when no role is given;
--         the column default is only a fallback for direct inserts.
-- Existing rows (all 'executive') are left unchanged.

BEGIN;

ALTER TABLE practice_company_directors DROP CONSTRAINT IF EXISTS practice_company_directors_role_check;
ALTER TABLE practice_company_directors
  ADD CONSTRAINT practice_company_directors_role_check
  CHECK (role IN ('director', 'executive', 'non_executive', 'alternate', 'member'));
ALTER TABLE practice_company_directors ALTER COLUMN role SET DEFAULT 'director';

COMMIT;
