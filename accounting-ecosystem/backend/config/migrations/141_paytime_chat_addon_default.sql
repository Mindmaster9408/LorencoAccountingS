-- =============================================================================
-- Migration 141: Default-enable Paytime Sean Chat addon on the TEST company
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Purpose: SEVCO Phase 2b gates Sean Chat (frontend-payroll/sean-chat.html,
-- backend/modules/paytime-chat/) behind a per-company 'paytime_chat' addon,
-- toggled via the existing eco_clients.addons / companies.modules_enabled
-- mechanism (same pattern as 'sean'/'serial_tracking' — see the sync block
-- added to PUT /api/eco-clients/:id in this same change).
--
-- CLAUDE.md Rule H2: whenever a new app/addon is added, it must be enabled
-- by default on the designated sandbox company ("Infinite Legacy — TEST",
-- eco_clients.id = 44, client_company_id / companies.id = 51) so the sandbox
-- always has full platform coverage for testing. This does NOT enable it for
-- any real client — real clients stay opted-out until a superuser
-- deliberately activates them via the toggle, which is the entire point of
-- this feature.
-- =============================================================================

BEGIN;

UPDATE eco_clients
SET addons = array_append(addons, 'paytime_chat')
WHERE id = 44
  AND NOT ('paytime_chat' = ANY(addons));

UPDATE companies
SET modules_enabled = array_append(modules_enabled, 'paytime_chat')
WHERE id = 51
  AND NOT ('paytime_chat' = ANY(modules_enabled));

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT id, addons FROM eco_clients WHERE id = 44;
SELECT id, modules_enabled FROM companies WHERE id = 51;
