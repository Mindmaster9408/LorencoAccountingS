-- ============================================================================
-- Migration 168: Make the shared audit_log table DB-enforced append-only
-- ============================================================================
-- Charlie Proof tier scoping (2026-09-12) found that pos_audit_events
-- (migration 028_pos_audit_trail_foundation.sql) already has BEFORE UPDATE /
-- BEFORE DELETE triggers that unconditionally block any modification —
-- a genuine database-engine-level guarantee, not just "no code currently
-- happens to edit it." The generic, ecosystem-wide audit_log table (used by
-- every other module — accounting, practice, commander, collector,
-- inventory, shared/auth, etc.) had no such trigger: append-only there was
-- only a convention. This applies the exact same proven pattern to audit_log
-- too, so the same tamper-proof guarantee holds ecosystem-wide, not just
-- for POS.
--
-- No application code anywhere issues an UPDATE or DELETE against audit_log
-- today (confirmed by audit) — this migration changes nothing about current
-- behaviour, it only makes an already-true assumption enforceable.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS, safe to
-- re-run (this repo's CI applies every migration file on every push).
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'audit_log is append-only. Audit records cannot be modified or deleted. '
        'This table is governed by POPI Act and SARS 7-year retention requirements. '
        'Action: % on row id=%', TG_OP, OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

COMMENT ON TABLE audit_log IS
    'Append-only forensic audit log, shared across every module in the ecosystem. '
    'Governed by POPI Act (SA) and SARS 7-year audit retention requirement. '
    'UPDATE and DELETE are blocked at the database level by triggers (migration 168).';
