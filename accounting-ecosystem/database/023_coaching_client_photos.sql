-- =============================================================================
-- Migration 023: Supabase Storage — Client Profile Photos
-- =============================================================================
-- Run this in the Supabase SQL Editor BEFORE deploying backend changes.
--
-- Purpose:
--   Adds a profile_photo_path column to coaching_clients.
--   This stores only the Supabase Storage object path (e.g. coach_1/client_2/profile.jpg),
--   NOT the base64 blob. The backend generates signed URLs from this path on demand.
--
-- The existing `photo TEXT` column (base64 blob) is NOT dropped here.
--   - Legacy clients with base64 photos continue to work in the client detail view.
--   - New uploads go to Supabase Storage; profile_photo_path is populated.
--   - After all clients have re-uploaded, run the cleanup step below (commented out).
--
-- STORAGE BUCKET SETUP (one-time, do this BEFORE running this migration):
--   Supabase Dashboard → Storage → New Bucket
--   Bucket name: client-profile-photos
--   Set to: PRIVATE (not public)
--   Leave RLS as-is — the backend uses the service role key and bypasses RLS.
-- =============================================================================

-- Add the storage path column (idempotent)
ALTER TABLE coaching_clients
    ADD COLUMN IF NOT EXISTS profile_photo_path TEXT DEFAULT NULL;

-- Index: fast lookup of clients that have a Supabase Storage photo
CREATE INDEX IF NOT EXISTS idx_coaching_clients_photo_path
    ON coaching_clients(coach_id)
    WHERE profile_photo_path IS NOT NULL;

-- =============================================================================
-- OPTIONAL CLEANUP (run ONLY after all clients have re-uploaded via new flow)
-- =============================================================================
-- Once every client has a profile_photo_path set, the legacy base64 `photo`
-- column can be cleared to reclaim database storage:
--
-- UPDATE coaching_clients
--    SET photo = NULL
--  WHERE profile_photo_path IS NOT NULL
--    AND photo IS NOT NULL;
--
-- Do NOT drop the photo column yet — keep it for backward compatibility.
-- =============================================================================
