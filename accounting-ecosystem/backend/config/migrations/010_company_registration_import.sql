-- ============================================================================
-- Migration 010: Company Registration Import Fields
-- ============================================================================
-- Adds columns required for the PDF client import feature:
--   companies.registration_date   — date of CIPC registration
--   companies.directors           — JSON array of director names
--   eco_clients.import_source     — how the client was created (manual / pdf-import)
--
-- Safe to run multiple times (uses IF NOT EXISTS / idempotent).
-- Run this in Supabase SQL Editor before using the PDF import feature.
-- ============================================================================

-- companies: registration date (from CIPC document)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS registration_date DATE;

-- companies: directors/members extracted from registration document
-- Stored as JSONB array of name strings: ["John Smith", "Jane Doe"]
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS directors JSONB DEFAULT '[]'::JSONB;

-- eco_clients: track how the client was created
-- 'manual' | 'pdf-import' | null (legacy records)
ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS import_source VARCHAR(50) DEFAULT NULL;
