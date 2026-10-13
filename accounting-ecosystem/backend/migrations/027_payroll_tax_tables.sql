-- ============================================================================
-- Migration 027 — payroll_tax_tables (one row per SA tax year)
-- ============================================================================
-- Spec: docs/paytime/spec/02_BELASTINGTABELLE.md (BT-01..15), Fase 1.
--
-- Replaces the "one active tax year" KV model (tax_config / tax_years_v2):
--   - every pay period automatically uses the table of ITS OWN tax year
--   - all years are stored side by side, ecosystem-wide (no company_id)
--   - a year must be confirmed before payroll for that year can be calculated
--   - only a super user in the global payroll authority company may edit
--
-- Bracket convention (SARS wording): tax = base + rate × (income − min), where
-- `min` is the PREVIOUS bracket's max ("R44 118 + 26% of taxable income above
-- R245 100"). The old KV tables stored min = previous max + 1, which was R1 off
-- (finding B10). `max` null = no upper limit.
--
-- Seeded from www.sars.gov.za (rates of tax for individuals + archive), checked
-- 2026-10-12. "2026/2027" is SARS's "2027 tax year" (1 Mar 2026 – 28 Feb 2027).
-- 2022/2023 and 2023/2024 rebates / medical credits are correct here; the code
-- defaults had them one year behind (finding W2).
--
-- Idempotent: CREATE IF NOT EXISTS + INSERT … ON CONFLICT DO NOTHING (existing
-- rows are never overwritten). Run in the Supabase SQL Editor.
-- The backend falls back to the old KV tax_config while this table is missing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_tax_tables (
  tax_year                   TEXT PRIMARY KEY CHECK (tax_year ~ '^\d{4}/\d{4}$'),
  valid_from                 DATE        NOT NULL,
  valid_to                   DATE        NOT NULL,
  brackets                   JSONB       NOT NULL,
  primary_rebate             NUMERIC(12,2) NOT NULL,
  secondary_rebate           NUMERIC(12,2) NOT NULL,
  tertiary_rebate            NUMERIC(12,2) NOT NULL,
  uif_rate                   NUMERIC(8,5)  NOT NULL,
  uif_monthly_cap            NUMERIC(12,2) NOT NULL,
  sdl_rate                   NUMERIC(8,5)  NOT NULL,
  medical_credit_main        NUMERIC(12,2) NOT NULL,
  medical_credit_first_dep   NUMERIC(12,2) NOT NULL,
  medical_credit_additional  NUMERIC(12,2) NOT NULL,
  confirmed                  BOOLEAN     NOT NULL DEFAULT FALSE,
  source                     TEXT,
  updated_by                 INTEGER,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE payroll_tax_tables IS
  'Paytime: SARS PAYE tables per tax year (ecosystem-wide). A pay period uses the row of its own tax year; only confirmed rows are used. See migration 027.';

INSERT INTO payroll_tax_tables
  (tax_year, valid_from, valid_to, brackets,
   primary_rebate, secondary_rebate, tertiary_rebate,
   uif_rate, uif_monthly_cap, sdl_rate,
   medical_credit_main, medical_credit_first_dep, medical_credit_additional,
   confirmed, source)
VALUES
  ('2021/2022', '2021-03-01', '2022-02-28',
   '[{"min":0,"max":216200,"base":0,"rate":0.18},{"min":216200,"max":337800,"base":38916,"rate":0.26},{"min":337800,"max":467500,"base":70532,"rate":0.31},{"min":467500,"max":613600,"base":110739,"rate":0.36},{"min":613600,"max":782200,"base":163335,"rate":0.39},{"min":782200,"max":1656600,"base":229089,"rate":0.41},{"min":1656600,"max":null,"base":587593,"rate":0.45}]',
   15714, 8613, 2871, 0.01, 177.12, 0.01, 332, 332, 224, TRUE,
   'SARS archive — 2022 tax year'),
  ('2022/2023', '2022-03-01', '2023-02-28',
   '[{"min":0,"max":226000,"base":0,"rate":0.18},{"min":226000,"max":353100,"base":40680,"rate":0.26},{"min":353100,"max":488700,"base":73726,"rate":0.31},{"min":488700,"max":641400,"base":115762,"rate":0.36},{"min":641400,"max":817600,"base":170734,"rate":0.39},{"min":817600,"max":1731600,"base":239452,"rate":0.41},{"min":1731600,"max":null,"base":614192,"rate":0.45}]',
   16425, 9000, 2997, 0.01, 177.12, 0.01, 347, 347, 234, TRUE,
   'SARS archive — 2023 tax year'),
  ('2023/2024', '2023-03-01', '2024-02-29',
   '[{"min":0,"max":237100,"base":0,"rate":0.18},{"min":237100,"max":370500,"base":42678,"rate":0.26},{"min":370500,"max":512800,"base":77362,"rate":0.31},{"min":512800,"max":673000,"base":121475,"rate":0.36},{"min":673000,"max":857900,"base":179147,"rate":0.39},{"min":857900,"max":1817000,"base":251258,"rate":0.41},{"min":1817000,"max":null,"base":644489,"rate":0.45}]',
   17235, 9444, 3145, 0.01, 177.12, 0.01, 364, 364, 246, TRUE,
   'SARS archive — 2024 tax year'),
  ('2024/2025', '2024-03-01', '2025-02-28',
   '[{"min":0,"max":237100,"base":0,"rate":0.18},{"min":237100,"max":370500,"base":42678,"rate":0.26},{"min":370500,"max":512800,"base":77362,"rate":0.31},{"min":512800,"max":673000,"base":121475,"rate":0.36},{"min":673000,"max":857900,"base":179147,"rate":0.39},{"min":857900,"max":1817000,"base":251258,"rate":0.41},{"min":1817000,"max":null,"base":644489,"rate":0.45}]',
   17235, 9444, 3145, 0.01, 177.12, 0.01, 364, 364, 246, TRUE,
   'SARS — 2025 tax year (unchanged from 2024)'),
  ('2025/2026', '2025-03-01', '2026-02-28',
   '[{"min":0,"max":237100,"base":0,"rate":0.18},{"min":237100,"max":370500,"base":42678,"rate":0.26},{"min":370500,"max":512800,"base":77362,"rate":0.31},{"min":512800,"max":673000,"base":121475,"rate":0.36},{"min":673000,"max":857900,"base":179147,"rate":0.39},{"min":857900,"max":1817000,"base":251258,"rate":0.41},{"min":1817000,"max":null,"base":644489,"rate":0.45}]',
   17235, 9444, 3145, 0.01, 177.12, 0.01, 364, 364, 246, TRUE,
   'SARS — 2026 tax year (no changes, 12 March 2025)'),
  ('2026/2027', '2026-03-01', '2027-02-28',
   '[{"min":0,"max":245100,"base":0,"rate":0.18},{"min":245100,"max":383100,"base":44118,"rate":0.26},{"min":383100,"max":530200,"base":79998,"rate":0.31},{"min":530200,"max":695800,"base":125599,"rate":0.36},{"min":695800,"max":887000,"base":185215,"rate":0.39},{"min":887000,"max":1878600,"base":259783,"rate":0.41},{"min":1878600,"max":null,"base":666339,"rate":0.45}]',
   17820, 9765, 3249, 0.01, 177.12, 0.01, 376, 376, 254, TRUE,
   'SARS — 2027 tax year (www.sars.gov.za, checked 2026-10-12)')
ON CONFLICT (tax_year) DO NOTHING;
