-- Migration 019: Add exercise_data and journey_progress to coaching_clients
-- Run this in the COACHING Supabase project (the one pointed to by COACHING_DATABASE_URL)
-- These columns allow exercise answers and journey step completion to be persisted per client.

ALTER TABLE coaching_clients
    ADD COLUMN IF NOT EXISTS exercise_data   JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS journey_progress JSONB NOT NULL DEFAULT '{}';

-- Index for potential JSON queries on these columns
CREATE INDEX IF NOT EXISTS idx_coaching_clients_exercise_data
    ON coaching_clients USING gin (exercise_data);

CREATE INDEX IF NOT EXISTS idx_coaching_clients_journey_progress
    ON coaching_clients USING gin (journey_progress);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'coaching_clients'
  AND column_name IN ('exercise_data', 'journey_progress');
