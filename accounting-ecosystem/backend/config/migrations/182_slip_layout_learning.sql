-- ============================================================================
-- Migration 182: Slips — layout learning (per company + global via Sean)
-- ============================================================================
-- Ruan 2026-11-13: "seker inligting is globale inligting, maar die slip self
-- nee — dit is die kliënt se inligting."
--
-- What is learned: what a supplier's slip LOOKS like —
--   total_line   on which labelled line the total sits ("same:total due",
--                or "next:amount" = label alone, amount on the next line)
--   date_format  how the date is written (dmy / mdy / ymd / text)
-- per chain (keyed on the supplier VAT number, same for every branch) and
-- per branch (store number printed on the slip, e.g. Woolworths Potch).
--
-- NEVER stored here: amounts, dates, card digits, slip images or OCR text.
--
-- Levels (lookup order, first hit wins):
--   1. this company's own confirmations (automatic, needs 2 agreeing slips)
--   2. global approved patterns — branch, then chain
--   3. the generic parser
-- Global patterns exist only after a super user approves a Sean proposal
-- (CLAUDE.md Rule B2), and a proposal needs >= 2 different companies whose
-- slips agree — so a label that is really one client's data (a name on an
-- account line) cannot become global.
--
-- Idempotent.
-- ============================================================================

-- ── Events: what a person confirmed on one slip (per company) ───────────────
CREATE TABLE IF NOT EXISTS slip_layout_events (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slip_id         INTEGER NULL REFERENCES slips(id) ON DELETE SET NULL,
  level           TEXT NOT NULL CHECK (level IN ('chain','branch')),
  chain_key       TEXT NOT NULL,          -- 'vat:4xxxxxxxxx' or 'name:<namekey>'
  branch_key      TEXT NULL,              -- 'store:123' when printed on the slip
  facet           TEXT NOT NULL CHECK (facet IN ('total_line','date_format')),
  value           TEXT NOT NULL,          -- e.g. 'same:total due', 'dmy'
  global_subject  TEXT NULL,              -- 'vat:...|store:123|total_line'; NULL = never global (name-keyed)
  supplier_name   TEXT NULL,              -- display only
  created_by      INTEGER NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One row per slip per facet per level; a re-save replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slip_layout_events_slip
  ON slip_layout_events (slip_id, facet, level);
CREATE INDEX IF NOT EXISTS idx_slip_layout_events_company
  ON slip_layout_events (company_id, chain_key);
CREATE INDEX IF NOT EXISTS idx_slip_layout_events_subject
  ON slip_layout_events (global_subject) WHERE global_subject IS NOT NULL;
ALTER TABLE slip_layout_events ENABLE ROW LEVEL SECURITY;

-- ── Patterns: global, anonymised (no company ids) ───────────────────────────
CREATE TABLE IF NOT EXISTS slip_layout_patterns (
  id                SERIAL PRIMARY KEY,
  source_app        TEXT NOT NULL DEFAULT 'slips',
  layout_subject    TEXT NOT NULL,
  layout_value      TEXT NOT NULL,
  chain_key         TEXT NULL,
  branch_key        TEXT NULL,             -- NULL = applies to the whole chain
  facet             TEXT NULL,
  supplier_name     TEXT NULL,
  confidence_score  NUMERIC(5,2) NOT NULL DEFAULT 0,
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  clients_observed  INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate','proposed','approved','rejected')),
  last_analyzed_at  TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_app, layout_subject, layout_value)
);
CREATE INDEX IF NOT EXISTS idx_slip_layout_patterns_status
  ON slip_layout_patterns (status, layout_subject);
ALTER TABLE slip_layout_patterns ENABLE ROW LEVEL SECURITY;

-- ── Proposals: Sean's approval queue (Rule B2/B8) ──────────────────────────
CREATE TABLE IF NOT EXISTS slip_layout_proposals (
  id                  SERIAL PRIMARY KEY,
  pattern_id          INTEGER NOT NULL REFERENCES slip_layout_patterns(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected')),
  proposed_by_system  BOOLEAN NOT NULL DEFAULT TRUE,
  proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by         INTEGER NULL REFERENCES users(id),
  approved_at         TIMESTAMPTZ NULL,
  rejected_by         INTEGER NULL REFERENCES users(id),
  rejected_at         TIMESTAMPTZ NULL,
  rejection_reason    TEXT NULL,
  -- snapshot at proposal time (audit record)
  snapshot_subject    TEXT NULL,
  snapshot_value      TEXT NULL,
  snapshot_supplier   TEXT NULL,
  snapshot_confidence NUMERIC(5,2) NULL,
  snapshot_clients    INTEGER NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pattern_id)   -- one proposal per pattern, ever: a rejection is final
);
CREATE INDEX IF NOT EXISTS idx_slip_layout_proposals_status ON slip_layout_proposals (status);
ALTER TABLE slip_layout_proposals ENABLE ROW LEVEL SECURITY;
