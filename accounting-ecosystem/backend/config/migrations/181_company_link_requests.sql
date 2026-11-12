-- 181_company_link_requests.sql
-- "Link an existing company" (Ruan, 2026-11-12): a practice asks a company
-- that already uses the Eco (e.g. a self-registered business) for access to
-- specific apps; the company's own management says yes/no per app.
--
-- On approval an eco_clients row is created under the practice with
-- access_link = true and apps = the approved apps. Such a row is an ACCESS
-- grant, not a subscription:
--   - it never changes the company's own modules_enabled or details,
--   - it is never invoiced (the company pays for itself),
--   - sso-launch only lets the practice into the approved apps.

ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS access_link BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS company_link_requests (
  id                   BIGSERIAL PRIMARY KEY,
  practice_company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_apps       TEXT[]  NOT NULL,
  approved_apps        TEXT[],
  status               TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  message              TEXT,
  requested_by         INTEGER,
  requested_by_name    TEXT,
  requested_by_email   TEXT,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by           INTEGER,
  decided_by_name      TEXT,
  decided_at           TIMESTAMPTZ,
  decision_note        TEXT,
  eco_client_id        INTEGER REFERENCES eco_clients(id) ON DELETE SET NULL,
  CHECK (practice_company_id <> target_company_id)
);

-- One open request per practice + company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_link_requests_open
  ON company_link_requests (practice_company_id, target_company_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_company_link_requests_target
  ON company_link_requests (target_company_id, status);

ALTER TABLE company_link_requests ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
