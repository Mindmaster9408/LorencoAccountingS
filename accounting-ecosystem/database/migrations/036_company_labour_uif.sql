-- Migration 036: Add Labour UIF Number to companies
-- The Department of Labour assigns a separate UIF reference number
-- for employer registration, distinct from the SARS UIF reference.
ALTER TABLE companies
ADD COLUMN IF NOT EXISTS labour_uif_number text;
