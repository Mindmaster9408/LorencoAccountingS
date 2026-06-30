-- ============================================================================
-- 093_practice_client_compliance_settings.sql
-- Adds VAT payment sequence, last VAT submission month, COIDA registration
-- number, and COIDA due month to practice_clients.
-- Run in Supabase SQL Editor.
-- ============================================================================

ALTER TABLE practice_clients
    ADD COLUMN IF NOT EXISTS vat_payment_sequence       TEXT CHECK (vat_payment_sequence IN (
                                                            'monthly','bi_monthly','quarterly','6_monthly','annual'
                                                        )),
    ADD COLUMN IF NOT EXISTS vat_last_submission_month  INTEGER CHECK (vat_last_submission_month BETWEEN 1 AND 12),
    ADD COLUMN IF NOT EXISTS coida_registration_number  TEXT,
    ADD COLUMN IF NOT EXISTS coida_due_month            INTEGER CHECK (coida_due_month BETWEEN 1 AND 12);

COMMENT ON COLUMN practice_clients.vat_payment_sequence IS
    'How often the client submits VAT returns: monthly, bi_monthly (every 2 months), quarterly (every 4 months), 6_monthly, or annual.';

COMMENT ON COLUMN practice_clients.vat_last_submission_month IS
    'The last month (1=Jan…12=Dec) in which a VAT return was submitted. '
    'Required when vat_payment_sequence is not monthly, to calculate future submission dates.';

COMMENT ON COLUMN practice_clients.coida_registration_number IS
    'COIDA / Workmens Compensation Fund registration number for this client.';

COMMENT ON COLUMN practice_clients.coida_due_month IS
    'Month (1=Jan…12=Dec) in which the client''s annual WCF return is due.';
