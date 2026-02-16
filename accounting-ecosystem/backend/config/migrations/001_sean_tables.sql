-- ============================================================================
-- SEAN AI & Inter-Company & Eco-Clients — Supabase Table Creation
-- ============================================================================
-- Run this in the Supabase SQL Editor to create all required tables
-- for SEAN AI, Inter-Company invoicing, and Ecosystem Clients.
-- ============================================================================

-- ─── SEAN Codex Entries (encrypted private company data) ─────────────────────
CREATE TABLE IF NOT EXISTS sean_codex_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  context_hash TEXT NOT NULL,
  encrypted_context TEXT,
  encrypted_decision TEXT,
  confidence NUMERIC(5,2) DEFAULT 0,
  times_used INTEGER DEFAULT 0,
  last_used TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_codex_company_hash ON sean_codex_entries(company_id, context_hash);

-- ─── SEAN Global Patterns (anonymized cross-company patterns) ────────────────
CREATE TABLE IF NOT EXISTS sean_global_patterns (
  id BIGSERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL DEFAULT 'merchant_allocation',
  pattern_key TEXT NOT NULL UNIQUE,
  amount_range TEXT DEFAULT 'any',
  merchant_pattern TEXT,
  companies_contributed INTEGER DEFAULT 1,
  total_occurrences INTEGER DEFAULT 1,
  outcome_distribution JSONB DEFAULT '{}',
  confidence_score NUMERIC(5,2) DEFAULT 50,
  reasoning TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_updated TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_patterns_key ON sean_global_patterns(pattern_key);

-- ─── SEAN Knowledge Items (tax rules, codex packs, etc.) ────────────────────
CREATE TABLE IF NOT EXISTS sean_knowledge_items (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'OTHER',
  layer TEXT NOT NULL DEFAULT 'FIRM',
  company_id INTEGER REFERENCES companies(id),
  content JSONB,
  content_type TEXT DEFAULT 'text',
  tags TEXT[] DEFAULT '{}',
  citation_id TEXT,
  status TEXT DEFAULT 'APPROVED',
  version INTEGER DEFAULT 1,
  language TEXT DEFAULT 'EN',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_knowledge_domain ON sean_knowledge_items(domain, status);
CREATE INDEX IF NOT EXISTS idx_sean_knowledge_company ON sean_knowledge_items(company_id);

-- ─── SEAN Allocation Rules (learned company-specific patterns) ───────────────
CREATE TABLE IF NOT EXISTS sean_allocation_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  is_global BOOLEAN DEFAULT FALSE,
  normalized_pattern TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence NUMERIC(5,4) DEFAULT 0.80,
  learned_from_count INTEGER DEFAULT 1,
  last_matched TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_rules_company ON sean_allocation_rules(company_id, normalized_pattern);
CREATE INDEX IF NOT EXISTS idx_sean_rules_global ON sean_allocation_rules(is_global) WHERE is_global = TRUE;

-- ─── SEAN Bank Transactions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sean_bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  date DATE NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  type TEXT DEFAULT 'debit',
  merchant TEXT,
  suggested_category TEXT,
  confirmed_category TEXT,
  confidence NUMERIC(5,2) DEFAULT 0,
  match_type TEXT,
  allocated_by TEXT,
  import_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_txns_company ON sean_bank_transactions(company_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_sean_txns_unallocated ON sean_bank_transactions(company_id) WHERE confirmed_category IS NULL;

-- ─── SEAN Learning Log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sean_learning_log (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  interaction_type TEXT,
  input_context JSONB,
  response_given JSONB,
  was_correct BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_learning_company ON sean_learning_log(company_id, created_at DESC);

-- ─── SEAN Import Logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sean_import_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  import_id TEXT NOT NULL,
  filename TEXT,
  status TEXT DEFAULT 'pending',
  total_rows INTEGER DEFAULT 0,
  auto_allocated INTEGER DEFAULT 0,
  needs_review INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sean_imports_company ON sean_import_logs(company_id, import_id);

-- ─── Inter-Company Invoices ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inter_company_invoices (
  id BIGSERIAL PRIMARY KEY,
  sender_company_id INTEGER NOT NULL REFERENCES companies(id),
  receiver_company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_number TEXT NOT NULL,
  date DATE NOT NULL,
  due_date DATE,
  line_items JSONB DEFAULT '[]',
  subtotal NUMERIC(12,2) DEFAULT 0,
  vat_amount NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  notes TEXT,
  sender_status TEXT DEFAULT 'sent',
  receiver_status TEXT DEFAULT 'pending',
  payment_status TEXT DEFAULT 'unpaid',
  amount_paid NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ic_invoices_sender ON inter_company_invoices(sender_company_id);
CREATE INDEX IF NOT EXISTS idx_ic_invoices_receiver ON inter_company_invoices(receiver_company_id);

-- ─── Inter-Company Relationships ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inter_company_relationships (
  id BIGSERIAL PRIMARY KEY,
  company_a_id INTEGER NOT NULL REFERENCES companies(id),
  company_b_id INTEGER NOT NULL REFERENCES companies(id),
  initiated_by INTEGER REFERENCES companies(id),
  status TEXT DEFAULT 'pending',
  company_a_confirmed BOOLEAN DEFAULT FALSE,
  company_b_confirmed BOOLEAN DEFAULT FALSE,
  permissions JSONB DEFAULT '{"send_invoices": true, "receive_invoices": true, "auto_match_payments": false}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ic_rel_companies ON inter_company_relationships(company_a_id, company_b_id);

-- ─── Eco Clients (Cross-App Client Management) ─────────────────────────────
CREATE TABLE IF NOT EXISTS eco_clients (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  id_number TEXT,
  address TEXT,
  client_type TEXT DEFAULT 'business',
  apps TEXT[] DEFAULT '{}',
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eco_clients_company ON eco_clients(company_id, is_active);

-- ─── Add eco_client_id to customers and employees for cross-app linking ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'eco_client_id') THEN
    ALTER TABLE customers ADD COLUMN eco_client_id BIGINT REFERENCES eco_clients(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'employees' AND column_name = 'eco_client_id') THEN
    ALTER TABLE employees ADD COLUMN eco_client_id BIGINT REFERENCES eco_clients(id);
  END IF;
END $$;

-- ─── Add inter-company columns to companies table if missing ────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'inter_company_enabled') THEN
    ALTER TABLE companies ADD COLUMN inter_company_enabled BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'invitation_code') THEN
    ALTER TABLE companies ADD COLUMN invitation_code TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'tax_number') THEN
    ALTER TABLE companies ADD COLUMN tax_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'vat_number') THEN
    ALTER TABLE companies ADD COLUMN vat_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'email_domain') THEN
    ALTER TABLE companies ADD COLUMN email_domain TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'city') THEN
    ALTER TABLE companies ADD COLUMN city TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'industry') THEN
    ALTER TABLE companies ADD COLUMN industry TEXT;
  END IF;
END $$;
