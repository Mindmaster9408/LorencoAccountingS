-- ============================================================================
-- Migration 038 — Manager Emergency Controls (Workstream 11B)
-- ============================================================================
-- Adds:
--   1. Till emergency control columns (lock + printer degraded mode)
--   2. pos_emergency_state table (per-company persistent sync pause + future flags)
-- ============================================================================

-- ─── 1. Till lock and printer degraded mode ──────────────────────────────────

ALTER TABLE tills
  ADD COLUMN IF NOT EXISTS is_locked               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_reason            TEXT,
  ADD COLUMN IF NOT EXISTS locked_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by_email          TEXT,
  ADD COLUMN IF NOT EXISTS is_printer_degraded      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS printer_degraded_reason  TEXT,
  ADD COLUMN IF NOT EXISTS printer_degraded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS printer_degraded_by_email TEXT;

COMMENT ON COLUMN tills.is_locked IS
  'When true, this till cannot process new sales. Set by manager emergency lock.';
COMMENT ON COLUMN tills.is_printer_degraded IS
  'When true, cashier sees printer degraded warning. Checkout still allowed.';

-- ─── 2. Per-company emergency state ──────────────────────────────────────────
-- Single row per company. Primary key on company_id enforces this.
-- sync_paused: when true, the POS frontend halts offline sale replay attempts.

CREATE TABLE IF NOT EXISTS pos_emergency_state (
  company_id            INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  sync_paused           BOOLEAN NOT NULL DEFAULT FALSE,
  sync_paused_by        TEXT,
  sync_paused_reason    TEXT,
  sync_paused_at        TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE pos_emergency_state IS
  'Per-company emergency control flags for the POS module. '
  'Persistent across browser reloads. Single row per company via PK. '
  'Managed exclusively via /api/pos/emergency/* endpoints.';

-- Index for the common GET by company_id (PK already covers this, but documenting intent)
-- No extra index needed — company_id is the PRIMARY KEY.
