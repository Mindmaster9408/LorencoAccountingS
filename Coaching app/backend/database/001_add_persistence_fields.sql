-- Migration: Add exercise_data and journey_progress JSONB fields
-- Purpose: Fix critical data persistence bug (Phase 1)
-- Date: April 13, 2026
-- Backwards compatible: YES (defaults to empty JSON)

-- Add exercise_data column (stores all exercise form responses)
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS exercise_data JSONB DEFAULT '{}'::jsonb;

-- Add journey_progress column (stores step completion, notes, dates)
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS journey_progress JSONB DEFAULT '{
  "currentStep": 1,
  "completedSteps": [],
  "stepNotes": {},
  "stepCompletionDates": {}
}'::jsonb;

-- Ensure column constraints
ALTER TABLE clients
ALTER COLUMN exercise_data SET DEFAULT '{}'::jsonb,
ALTER COLUMN journey_progress SET DEFAULT '{
  "currentStep": 1,
  "completedSteps": [],
  "stepNotes": {},
  "stepCompletionDates": {}
}'::jsonb;

-- Index for performance (if querying by exercise/journey data)
CREATE INDEX IF NOT EXISTS idx_clients_has_exercise_data ON clients USING gin(exercise_data);
CREATE INDEX IF NOT EXISTS idx_clients_has_journey_progress ON clients USING gin(journey_progress);

-- Confirmation
SELECT 
    table_name,
    column_name,
    data_type,
    column_default
FROM information_schema.columns
WHERE table_name = 'clients' 
  AND column_name IN ('exercise_data', 'journey_progress')
ORDER BY column_name;
