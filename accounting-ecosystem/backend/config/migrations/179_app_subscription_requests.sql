-- ============================================================================
-- 179_app_subscription_requests.sql
-- ============================================================================
-- Clients may no longer switch apps on by themselves (Ruan, 2026-11-11).
--
-- Before: any manager of a client (business owner, accountant, ...) could tick
-- an app in the ECO Hub "+ Add" modal and it went live immediately — Lorenco
-- was never told and never got the chance to discuss pricing or invoice it.
--
-- Now:
--   * Switching an app ON  = a REQUEST (kind 'add', status 'pending').
--     Ruan + Anton get an email; a super admin approves or declines it in
--     the Platform Control panel. Only approval switches the app on.
--   * Switching an app OFF = in the client's own hands (kind 'cancel',
--     status 'scheduled'). Clients are billed a month in advance, so the app
--     stays on until the client's next billing date (effective_date) and is
--     then switched off automatically by the hourly runner in
--     shared/services/appSubscriptions.js. The client can undo before then.
--     Switching off never deletes data — it only hides the app.
--   * Super admins still switch apps on/off directly (CLAUDE.md Rule F1).
--
-- eco_clients.billing_day = the day of the month this client is invoiced
-- (each client has its own). Set by a super admin; when still empty it is
-- filled with the day of the first approved request.
--
-- Idempotency: the partial unique index allows at most ONE open request
-- (pending add or scheduled cancel) per client per app.
-- ============================================================================

ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS billing_day SMALLINT
    CHECK (billing_day IS NULL OR (billing_day BETWEEN 1 AND 31));

CREATE TABLE IF NOT EXISTS app_subscription_requests (
  id                 SERIAL PRIMARY KEY,
  eco_client_id      INTEGER NOT NULL REFERENCES eco_clients(id) ON DELETE CASCADE,
  app_key            VARCHAR(40) NOT NULL,
  kind               VARCHAR(10) NOT NULL CHECK (kind IN ('add', 'cancel')),
  -- add:    pending → approved | declined | withdrawn
  -- cancel: scheduled → applying → applied | undone
  status             VARCHAR(12) NOT NULL CHECK (status IN
                       ('pending', 'approved', 'declined', 'withdrawn',
                        'scheduled', 'applying', 'applied', 'undone')),
  requested_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name  VARCHAR(255),
  requested_by_email VARCHAR(255),
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Price/terms text the client saw and accepted (null while price lists are
  -- still being finalised — the client then accepted "Lorenco will confirm").
  price_shown        TEXT,
  -- cancel only: the date the app switches off (the client's next billing date)
  effective_date     DATE,
  decided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  applied_at         TIMESTAMPTZ,
  last_error         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_sub_requests_open
  ON app_subscription_requests (eco_client_id, app_key)
  WHERE status IN ('pending', 'scheduled', 'applying');

CREATE INDEX IF NOT EXISTS idx_app_sub_requests_status
  ON app_subscription_requests (status, effective_date);

-- Server-only table (backend uses the service role). Same RLS stance as the
-- other server-only tables: enabled, no policies → no anon/authenticated access.
ALTER TABLE app_subscription_requests ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
