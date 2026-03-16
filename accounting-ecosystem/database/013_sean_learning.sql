-- ============================================================================
-- 013_sean_learning.sql
-- SEAN AI Learning Architecture — Bank Allocation Learning + Ecosystem Apps
-- Safe to run multiple times — all statements use IF NOT EXISTS / ON CONFLICT.
-- Run in Supabase SQL Editor after 012_accounting_schema.sql.
-- ============================================================================

-- ── 1. Ecosystem App Registry ─────────────────────────────────────────────────
-- Every app in the Lorenco ecosystem registers here.
-- SEAN reads this table dynamically — no code change needed when new apps are added.
CREATE TABLE IF NOT EXISTS ecosystem_apps (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,           -- Display name: "Accounting"
  slug        VARCHAR(50)  NOT NULL UNIQUE,    -- Machine key: "accounting"
  description TEXT,
  icon        VARCHAR(10)  DEFAULT '📦',       -- Emoji icon
  color       VARCHAR(20)  DEFAULT '#6366f1',  -- Brand colour (hex)
  is_active   BOOLEAN      DEFAULT true,
  sort_order  INTEGER      DEFAULT 0,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Seed the three live apps (idempotent)
INSERT INTO ecosystem_apps (name, slug, description, icon, color, sort_order) VALUES
  ('Accounting',        'accounting',   'General ledger, bank reconciliation, AP/AR, VAT, reports', '📒', '#10b981', 1),
  ('Paytime',           'paytime',      'Payroll processing, IRP5 coding, employee management',       '💼', '#6366f1', 2),
  ('Checkout Charlie',  'pos',          'Point-of-sale transactions, daily cash reconciliation',      '🛒', '#f59e0b', 3)
ON CONFLICT (slug) DO NOTHING;


-- ── 2. import_source on bank_transactions ────────────────────────────────────
-- Tracks HOW a bank transaction entered the system.
-- SEAN only learns from trusted sources: 'pdf' and 'api'.
-- Untrusted: 'csv', 'manual'
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS import_source VARCHAR(20) DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS idx_bank_txn_import_source ON bank_transactions(company_id, import_source);


-- ── 3. SEAN Bank Learning Events ─────────────────────────────────────────────
-- Immutable log of every bank-transaction allocation made from a TRUSTED source.
-- One row per allocation. Company_id is stored for audit but patterns are
-- anonymised before being promoted to global learning.
CREATE TABLE IF NOT EXISTS sean_bank_learning_events (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id    INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
  import_source          VARCHAR(20) NOT NULL,  -- 'pdf' | 'api' (only trusted written here)
  bank_name              VARCHAR(100),          -- e.g. "ABSA"
  raw_description        TEXT NOT NULL,         -- original transaction description
  normalized_description TEXT NOT NULL,         -- lowercased, stripped
  allocated_account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  allocated_account_code VARCHAR(20),
  allocated_account_name VARCHAR(255),
  journal_id             INTEGER REFERENCES journals(id) ON DELETE SET NULL,
  created_by_user_id     INTEGER REFERENCES users(id),
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sble_company      ON sean_bank_learning_events(company_id);
CREATE INDEX IF NOT EXISTS idx_sble_normalized   ON sean_bank_learning_events(normalized_description);
CREATE INDEX IF NOT EXISTS idx_sble_account_code ON sean_bank_learning_events(allocated_account_code);
CREATE INDEX IF NOT EXISTS idx_sble_created      ON sean_bank_learning_events(created_at);


-- ── 4. SEAN Bank Allocation Patterns ─────────────────────────────────────────
-- Anonymised patterns discovered across companies.
-- Each pattern maps a normalised description → suggested account code.
-- Privacy: company names / client names are NEVER stored here.
CREATE TABLE IF NOT EXISTS sean_bank_allocation_patterns (
  id                     SERIAL PRIMARY KEY,
  source_app             VARCHAR(50)  DEFAULT 'accounting',
  industry               VARCHAR(100),           -- NULL = universal
  sub_industry           VARCHAR(100),
  bank_name              VARCHAR(100),            -- NULL = any bank
  normalized_description TEXT         NOT NULL,   -- anonymised pattern key
  suggested_account_code VARCHAR(20)  NOT NULL,
  suggested_account_name VARCHAR(255),
  confidence_score       NUMERIC(5,2) DEFAULT 0,
  occurrence_count       INTEGER      DEFAULT 1,
  clients_observed       INTEGER      DEFAULT 1,  -- distinct companies seen
  status                 VARCHAR(20)  DEFAULT 'candidate',
  -- status: candidate → proposed → approved | rejected
  notes                  TEXT,
  authorized_by          INTEGER REFERENCES users(id),
  authorized_at          TIMESTAMPTZ,
  last_analyzed_at       TIMESTAMPTZ  DEFAULT NOW(),
  created_at             TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(normalized_description, suggested_account_code, source_app)
);

CREATE INDEX IF NOT EXISTS idx_sbap_description  ON sean_bank_allocation_patterns(normalized_description);
CREATE INDEX IF NOT EXISTS idx_sbap_status       ON sean_bank_allocation_patterns(status);
CREATE INDEX IF NOT EXISTS idx_sbap_confidence   ON sean_bank_allocation_patterns(confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_sbap_source       ON sean_bank_allocation_patterns(source_app);


-- ── 5. SEAN Bank Learning Proposals ──────────────────────────────────────────
-- Authorization workflow: pattern must be reviewed before global propagation.
-- Mirrors the IRP5 approval workflow (Rules B7–B8 in CLAUDE.md).
CREATE TABLE IF NOT EXISTS sean_bank_learning_proposals (
  id                SERIAL PRIMARY KEY,
  pattern_id        INTEGER NOT NULL REFERENCES sean_bank_allocation_patterns(id) ON DELETE CASCADE,
  status            VARCHAR(20) DEFAULT 'pending',
  -- status: pending → approved | rejected
  proposed_at       TIMESTAMPTZ DEFAULT NOW(),
  proposed_by_system BOOLEAN    DEFAULT true,
  reviewed_by       INTEGER REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  -- Snapshot at time of proposal (immutable audit record)
  snapshot_description  TEXT,
  snapshot_account_code VARCHAR(20),
  snapshot_confidence   NUMERIC(5,2),
  snapshot_clients      INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pattern_id)  -- one active proposal per pattern at a time
);

CREATE INDEX IF NOT EXISTS idx_sblp_status    ON sean_bank_learning_proposals(status);
CREATE INDEX IF NOT EXISTS idx_sblp_pattern   ON sean_bank_learning_proposals(pattern_id);
CREATE INDEX IF NOT EXISTS idx_sblp_reviewed  ON sean_bank_learning_proposals(reviewed_by);


-- ── 6. SEAN Codex Articles ────────────────────────────────────────────────────
-- The CODEX: SA tax rules, accounting rules, industry logic, SEAN knowledge.
-- Renamed from "Knowledge Base" — CODEX is the official term going forward.
-- sean_knowledge_items (existing) remains for encrypted/per-company items.
-- This table holds the global, structured reference library.
CREATE TABLE IF NOT EXISTS sean_codex_articles (
  id               SERIAL PRIMARY KEY,
  category         VARCHAR(100) NOT NULL,   -- e.g. 'bank_charges', 'vat', 'paye'
  subcategory      VARCHAR(100),
  industry         VARCHAR(100),            -- NULL = universal
  sub_industry     VARCHAR(100),
  title            TEXT NOT NULL,
  law_reference    VARCHAR(255),            -- e.g. 'Income Tax Act s11(a)'
  explanation      TEXT NOT NULL,
  example          TEXT,
  related_accounts TEXT[],                  -- account codes that this rule touches
  keywords         TEXT[],                  -- for matching
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sca_category   ON sean_codex_articles(category);
CREATE INDEX IF NOT EXISTS idx_sca_industry   ON sean_codex_articles(industry);

-- Seed universal Codex articles (idempotent via unique title check)
INSERT INTO sean_codex_articles (category, title, law_reference, explanation, example, related_accounts, keywords)
VALUES
(
  'bank_charges',
  'Bank Service Charges — Tax Deductibility',
  'Income Tax Act s11(a)',
  'Monthly bank service fees, transaction fees, and account maintenance charges paid to a South African bank are deductible as a business expense under s11(a) of the Income Tax Act, provided they are incurred in the production of income and not of a capital nature.',
  'ABSA Monthly Account Fee → allocate to Account 6700 (Bank Charges and Fees)',
  ARRAY['6700'],
  ARRAY['bank fee','monthly fee','service charge','bank charges','account fee','transaction fee','maintenance fee','absa','fnb','standard bank','nedbank','capitec']
),
(
  'vat',
  'Input VAT on Bank Charges',
  'Value-Added Tax Act s7',
  'Bank charges are generally VAT-exempt (financial services). No input VAT may be claimed on standard bank service fees. However, certain bank fees that are not exempt (e.g. safety deposit box rental) may carry VAT — verify with the specific fee description.',
  'Monthly account fee — no VAT claimable. Safety deposit box — VAT may apply.',
  ARRAY['6700','1400'],
  ARRAY['bank fee','vat','input vat','exempt','financial services']
),
(
  'fuel',
  'Fuel and Petrol — Business vs Private Use',
  'Income Tax Act s11(a), s23(b)',
  'Fuel purchased for business vehicles is deductible as a business expense. Where a vehicle is used for both business and private purposes, only the business proportion is deductible. A logbook is required to substantiate the business-use percentage.',
  'Engen fuel R1,200 — if vehicle 80% business use, deductible portion = R960',
  ARRAY['6300'],
  ARRAY['fuel','petrol','diesel','engen','sasol','bp','caltex','total','shell','filling station']
),
(
  'salaries',
  'Salaries and Wages — Employer Obligations',
  'Fourth Schedule to the Income Tax Act; UIF Act',
  'Employers must deduct PAYE from employee remuneration and remit to SARS by the 7th of the following month (or last business day). UIF contributions (employer 1% + employee 1% of gross, capped) are payable monthly. SDL (1% of payroll) is due if annual payroll > R500,000.',
  'Monthly payroll R50,000: PAYE withheld per tables, UIF R500 (employer) + R500 (employee), SDL R500 if applicable.',
  ARRAY['6000','2400','2410'],
  ARRAY['salary','wages','paye','uif','sdl','payroll','remuneration','employee']
),
(
  'cost_of_sales',
  'Cost of Sales — Direct vs Indirect Costs',
  'Generally Accepted Accounting Practice (GAAP)',
  'Cost of Sales (COS) includes all direct costs attributable to goods sold: raw materials, direct labour, and direct overheads. Indirect costs (rent, admin) are operating expenses, not COS. Correct classification affects gross profit calculation and meaningful P&L analysis.',
  'Bakery: flour, yeast, packaging → COS. Admin salaries, electricity → operating expense.',
  ARRAY['5000','5100','5200'],
  ARRAY['cost of sales','cos','goods sold','materials','direct labour','inventory','stock']
)
ON CONFLICT DO NOTHING;
