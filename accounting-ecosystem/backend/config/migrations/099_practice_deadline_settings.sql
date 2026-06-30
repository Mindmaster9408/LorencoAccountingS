-- ============================================================================
-- 099_practice_deadline_settings.sql
-- Stores per-practice deadline offset configuration.
--
-- Partners can set how many working days before the statutory (SARS) deadline
-- the practice wants to complete each obligation type. For example, if VAT
-- monthly is statutorily due on the last working day of the following month,
-- a practice may set offset_days = 6 so their internal deadline is 6 working
-- days earlier (roughly the 25th).
--
-- Statutory deadlines are computed in application code from SA law; only the
-- practice offset is stored here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS practice_deadline_settings (
  id              SERIAL      PRIMARY KEY,
  company_id      INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  obligation_type VARCHAR(60) NOT NULL,
  offset_days     INTEGER     NOT NULL DEFAULT 0 CHECK (offset_days >= 0 AND offset_days <= 30),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, obligation_type)
);

CREATE INDEX IF NOT EXISTS idx_practice_dl_settings_company
  ON practice_deadline_settings(company_id);

COMMENT ON TABLE practice_deadline_settings IS
  'Practice-specific deadline offsets. offset_days = working days before the '
  'statutory (SARS/CIPC) deadline that this practice targets for completion.';
