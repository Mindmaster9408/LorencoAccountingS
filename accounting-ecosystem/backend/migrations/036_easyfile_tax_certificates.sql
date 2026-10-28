-- ============================================================================
-- Migration 036 — Paytime RS-07: SARS e@syFile import file (IRP5 / IT3(a))
-- ============================================================================
-- Ruan 2026-10-28: "bou dat ek kan import in easyfile". Format: SARS BRS PAYE Employer
-- Reconciliation V25.3.0 (Jun 2026), checked against two SimplePay files e@syFile accepted.
--
-- What SARS needs that Paytime did not store:
--   employees  — residential address (mandatory on every IRP5/IT3(a)), passport country
--                and date of birth for employees without an SA ID, nature of person,
--                bank account type + account holder relationship (codes 3240 / 3246).
--   companies  — SIC7 industry code (codes 2082 / 3263, mandatory).
--   payroll_tax_certificates — every certificate number handed out. SARS: a number is
--                unique per employee and may never be reused, and a final certificate
--                issued at the interim must keep its number at year end.
--
-- Additive, idempotent. No existing figures change.
-- ============================================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_unit_number   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_complex       TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_street_number TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_street_name   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_suburb        TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_city          TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_postal_code   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS res_country_code  TEXT;          -- 2 letters, NULL = ZA
ALTER TABLE employees ADD COLUMN IF NOT EXISTS passport_country  TEXT;          -- 3 letters (SARS Appendix A), e.g. ZWE
ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_birth     DATE;          -- only needed without an SA ID
ALTER TABLE employees ADD COLUMN IF NOT EXISTS nature_of_person  TEXT;          -- NULL = A (individual with ID/passport)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_type SMALLINT;      -- SARS 3240: 1 current, 2 savings, 3 transmission, 4 bond, 5 credit card, 6 subscription share, 7 foreign
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_relationship SMALLINT; -- SARS 3246: 1 own, 2 joint, 3 third party (NULL = own)

DO $$ BEGIN
  ALTER TABLE employees ADD CONSTRAINT employees_nature_of_person_chk
    CHECK (nature_of_person IS NULL OR nature_of_person IN ('A','B','M','N','R'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employees ADD CONSTRAINT employees_bank_account_type_chk
    CHECK (bank_account_type IS NULL OR bank_account_type BETWEEN 1 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employees ADD CONSTRAINT employees_bank_account_relationship_chk
    CHECK (bank_account_relationship IS NULL OR bank_account_relationship BETWEEN 1 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS sic7_code TEXT;                  -- 5 digits (SARS Appendix C)

CREATE TABLE IF NOT EXISTS payroll_tax_certificates (
  id                  BIGSERIAL    PRIMARY KEY,
  company_id          INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         INTEGER      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  transaction_year    INTEGER      NOT NULL,                       -- SARS 2030, e.g. 2027 for 2026/2027
  cert_period         TEXT         NOT NULL CHECK (cert_period IN ('02','08')),
  recon_period        INTEGER      NOT NULL,                       -- SARS 2031, YYYYMM
  certificate_number  TEXT         UNIQUE CHECK (certificate_number IS NULL OR certificate_number ~ '^[0-9A-Z]{30}$'),
  certificate_type    TEXT         NOT NULL CHECK (certificate_type IN ('IRP5','IT3(a)')),
  status              TEXT         NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
  totals              JSONB,                                       -- what was declared (audit)
  generated_by        INTEGER,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One live certificate per employee per year per period digits; cancelled ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_tax_certificates_live
  ON payroll_tax_certificates (company_id, employee_id, transaction_year, cert_period)
  WHERE status = 'issued';

COMMENT ON TABLE payroll_tax_certificates IS
  'Paytime RS-07: IRP5/IT3(a) certificate numbers issued in e@syFile exports — never reused (SARS BRS code 3010). Migration 036.';
