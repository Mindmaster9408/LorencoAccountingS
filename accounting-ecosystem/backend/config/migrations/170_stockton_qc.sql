-- ============================================================================
-- Migration 170: Stockton quality control (finished-production QC gate)
-- ============================================================================
-- Scope decided with Ruan (2026-09-13): finished production only for v1
-- (not incoming goods yet), a QC fail blocks stock in place rather than
-- requiring physical relocation to a quarantine bin, maker-checker enforced
-- (inspector must differ from whoever ran the batch), and lot/batch-level
-- granularity (matching the lot tracking already built in migration 169 —
-- not full unit serialization).
--
-- A finished-production batch (production_batches) now gets a linked
-- inventory_stock_lot at completion time, held at qc_status='pending' until
-- someone inspects it. inventory_stock_lots created from normal goods
-- receiving default to qc_status='passed' — incoming-goods QC isn't in
-- scope yet, so that path is completely unaffected.
--
-- Enforcement lives at the lot-consumption layer (routes/stock-lots.js
-- POST /:id/consume) — a pending or failed lot cannot be consumed/shipped.
-- This deliberately does NOT touch the aggregate current_stock/ATP
-- calculation used everywhere else (sales, reservations) — that's a much
-- larger, higher-risk change to the core stock engine for a v1 gate; the
-- produced quantity still shows as physically on hand, it just can't move
-- out through the lot pathway until QC passes.
--
-- Idempotent, safe to re-run.
-- ============================================================================

ALTER TABLE inventory_stock_lots ADD COLUMN IF NOT EXISTS qc_status TEXT NOT NULL DEFAULT 'passed'
  CHECK (qc_status IN ('pending', 'passed', 'failed'));

ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS qc_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (qc_status IN ('pending', 'passed', 'failed', 'partial'));
ALTER TABLE production_batches ADD COLUMN IF NOT EXISTS linked_lot_id INTEGER NULL REFERENCES inventory_stock_lots(id);

CREATE TABLE IF NOT EXISTS production_batch_qc_inspections (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id           INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  inspector_id       INTEGER NOT NULL REFERENCES users(id),
  result             TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'partial')),
  quantity_inspected NUMERIC(18,4) NOT NULL,
  quantity_passed    NUMERIC(18,4) NOT NULL,
  quantity_rejected  NUMERIC(18,4) NOT NULL DEFAULT 0,
  rejection_reason   TEXT NULL,
  notes              TEXT NULL,
  inspected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qc_inspections_batch ON production_batch_qc_inspections (batch_id);
