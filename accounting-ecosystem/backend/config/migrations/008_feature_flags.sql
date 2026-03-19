-- ============================================================================
-- Migration 008: Feature Flags Table
-- ============================================================================
-- Centralised feature flag / rollout control system for the Lorenco ecosystem.
-- Enables gradual rollout of new features:
--   disabled → superuser → test_client → selected_clients → all
--
-- Safe to run multiple times (all statements use IF NOT EXISTS / IF EXISTS).
-- ============================================================================

-- ── Create feature_flags table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feature_flags (
  id                  SERIAL PRIMARY KEY,
  flag_key            VARCHAR(100) UNIQUE NOT NULL,
  display_name        VARCHAR(200) NOT NULL,
  description         TEXT,
  app                 VARCHAR(50) NOT NULL DEFAULT 'global',
  is_active           BOOLEAN NOT NULL DEFAULT false,

  -- rollout_level controls who can access the feature:
  --   disabled        — off for everyone
  --   superuser       — only isSuperAdmin users
  --   test_client     — superusers + companies in allowed_company_ids
  --   selected_clients — superusers + broader explicit company list
  --   all             — fully rolled out (all authenticated users)
  rollout_level       VARCHAR(30) NOT NULL DEFAULT 'disabled'
                        CHECK (rollout_level IN ('disabled','superuser','test_client','selected_clients','all')),

  -- Companies explicitly allowed when rollout_level is test_client or selected_clients.
  -- Stored as integer array of company IDs.
  allowed_company_ids INTEGER[] NOT NULL DEFAULT '{}',

  -- Audit trail
  updated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_feature_flags_key ON feature_flags(flag_key);
CREATE INDEX IF NOT EXISTS idx_feature_flags_app ON feature_flags(app);
CREATE INDEX IF NOT EXISTS idx_feature_flags_active ON feature_flags(is_active) WHERE is_active = true;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Service-role key (used by backend) bypasses RLS automatically.
-- Authenticated Supabase users should not have direct table access.

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- ── Seed: initial Paytime feature flags ──────────────────────────────────────
-- These are example flags that can be activated via the admin API.
-- All start as disabled — they must be explicitly activated.

INSERT INTO feature_flags (flag_key, display_name, description, app, is_active, rollout_level)
VALUES
  (
    'PAYTIME_ENHANCED_PAYSLIP',
    'Enhanced Payslip Layout',
    'New payslip design with itemised breakdown, tax summary, and YTD totals.',
    'paytime', false, 'disabled'
  ),
  (
    'PAYTIME_BULK_PAYRUN',
    'Bulk Pay Run Processing',
    'Process multiple employees in a single pay run with batch validation.',
    'paytime', false, 'disabled'
  ),
  (
    'PAYTIME_LEAVE_PORTAL',
    'Employee Leave Self-Service Portal',
    'Employees can view leave balances and submit leave requests directly.',
    'paytime', false, 'disabled'
  ),
  (
    'PAYTIME_SEAN_TAX_OPTIMISER',
    'SEAN Tax Optimisation Recommendations',
    'AI-powered tax optimisation suggestions per employee based on YTD earnings.',
    'paytime', false, 'disabled'
  ),
  (
    'PAYTIME_IRP5_EXPORT',
    'IRP5 Certificate Export',
    'Generate and export IRP5 certificates for SARS e@syFile submission.',
    'paytime', false, 'disabled'
  )
ON CONFLICT (flag_key) DO NOTHING;
