-- =============================================================================
-- Migration 003: eco_clients table + eco_client_id columns
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- Creates the cross-app client table used by the Ecosystem dashboard.
-- =============================================================================

-- ─── eco_clients ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eco_clients (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  email          VARCHAR(255),
  phone          VARCHAR(50),
  id_number      VARCHAR(100),
  address        TEXT,
  client_type    VARCHAR(50) DEFAULT 'business',   -- 'individual' | 'business'
  apps           TEXT[]      DEFAULT ARRAY[]::TEXT[], -- e.g. ['pos','payroll']
  notes          TEXT,
  is_active      BOOLEAN     DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_eco_clients_company  ON eco_clients(company_id);
CREATE INDEX IF NOT EXISTS idx_eco_clients_email    ON eco_clients(email);
CREATE INDEX IF NOT EXISTS idx_eco_clients_active   ON eco_clients(is_active);

-- ─── Link columns on existing tables ─────────────────────────────────────────
-- Allow customers and employees to reference the eco_client that created them.
ALTER TABLE customers  ADD COLUMN IF NOT EXISTS eco_client_id INTEGER REFERENCES eco_clients(id) ON DELETE SET NULL;
ALTER TABLE employees  ADD COLUMN IF NOT EXISTS eco_client_id INTEGER REFERENCES eco_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_eco_client ON customers(eco_client_id);
CREATE INDEX IF NOT EXISTS idx_employees_eco_client ON employees(eco_client_id);
