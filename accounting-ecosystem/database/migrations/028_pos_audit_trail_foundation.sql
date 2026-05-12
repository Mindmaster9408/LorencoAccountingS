-- Migration 028: Enterprise POS Audit Trail Foundation
-- Creates pos_audit_events — a dedicated, append-only audit log for all POS events.
--
-- Design decisions:
--   - Separate table from audit_log: POS events require columns (till_id,
--     till_session_id, sale_id, source, action_category) that do not belong
--     in the general ecosystem audit table.
--   - NO foreign key constraints on POS context columns: audit records must
--     survive even if the parent record (sale, session, product) is deleted.
--     A deleted record having an audit trail is the entire point — FKs would
--     prevent that. Referential integrity is enforced at the application layer.
--   - Append-only enforced by database triggers — UPDATE and DELETE are blocked
--     at the engine level regardless of role or permission.
--   - JSONB snapshots (before/after) enable structured diffing without adding
--     a column for every tracked field.
--   - action_category column enables fast category-level reporting without
--     LIKE '%sale%' full-table scans.
--   - Partial indexes on source and sale_id keep index size small while covering
--     the most common forensic query patterns.
--
-- Compliance: POPI Act (SA), SARS 7-year audit record retention requirement.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- Date: 2026-05-12
-- Depends on: 027_pos_create_sale_atomic_idempotent.sql

-- ── 1. Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pos_audit_events (
    id                  BIGSERIAL PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- User context (nullable: pre-company events such as LOGIN_FAILED have no company context)
    company_id          INTEGER,
    user_id             INTEGER,
    user_email          TEXT,
    user_role           TEXT,               -- 'cashier' | 'manager' | 'admin' | 'system'

    -- POS context (no FK constraints by design — see header note)
    till_id             INTEGER,            -- references tills.id
    till_session_id     INTEGER,            -- references till_sessions.id
    sale_id             INTEGER,            -- references sales.id
    product_id          INTEGER,            -- references products.id

    -- Event classification
    action_category     TEXT NOT NULL,      -- 'sale' | 'session' | 'product' | 'inventory' | 'auth' | 'receipt' | 'override' | 'sync'
    action_type         TEXT NOT NULL,      -- e.g. 'SALE_CREATED', 'SALE_VOIDED', 'RECEIPT_PRINTED'
    source              TEXT NOT NULL DEFAULT 'online',  -- 'online' | 'offline_sync' | 'system'

    -- Entity (for cross-category lookups)
    entity_type         TEXT,
    entity_id           TEXT,

    -- Structured change record
    before_snapshot     JSONB,              -- relevant state before the action (null for creation events)
    after_snapshot      JSONB,              -- relevant state after the action (null for failure/deletion events)

    -- Request metadata
    ip_address          TEXT,
    user_agent          TEXT,

    -- Extra context
    notes               TEXT,
    metadata            JSONB
);

-- ── 2. Indexes ────────────────────────────────────────────────────────────────
-- Designed for the most common forensic and reporting query patterns.

-- Primary audit trail: all events for a company in time order (partial — auth events may have NULL company_id)
CREATE INDEX IF NOT EXISTS idx_pos_audit_company_time
    ON pos_audit_events (company_id, created_at DESC)
    WHERE company_id IS NOT NULL;

-- Per-sale event history (fraud investigation, dispute resolution)
CREATE INDEX IF NOT EXISTS idx_pos_audit_sale
    ON pos_audit_events (sale_id)
    WHERE sale_id IS NOT NULL;

-- Per-session report (till reconciliation)
CREATE INDEX IF NOT EXISTS idx_pos_audit_session
    ON pos_audit_events (till_session_id)
    WHERE till_session_id IS NOT NULL;

-- Category + type filtering (manager reviewing sale events for a period)
CREATE INDEX IF NOT EXISTS idx_pos_audit_category_type
    ON pos_audit_events (company_id, action_category, action_type, created_at DESC)
    WHERE company_id IS NOT NULL;

-- Offline sync audit trail (partial — only sync events)
CREATE INDEX IF NOT EXISTS idx_pos_audit_offline_sync
    ON pos_audit_events (company_id, created_at DESC)
    WHERE source = 'offline_sync';

-- Auth event index — pre-company events (LOGIN_FAILED) have NULL company_id
CREATE INDEX IF NOT EXISTS idx_pos_audit_auth
    ON pos_audit_events (action_category, created_at DESC)
    WHERE action_category = 'auth';

-- ── 3. Append-only enforcement ────────────────────────────────────────────────
-- Database-level guarantee: no row in pos_audit_events can ever be modified or
-- deleted, regardless of role, permission, or direct SQL. This protects the
-- audit trail against tampering even by service-role queries.
--
-- Both triggers fire BEFORE the operation so the operation never reaches storage.

CREATE OR REPLACE FUNCTION prevent_pos_audit_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'pos_audit_events is append-only. Audit records cannot be modified or deleted. '
        'This table is governed by POPI Act and SARS 7-year retention requirements. '
        'Action: % on row id=%', TG_OP, OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS pos_audit_no_update ON pos_audit_events;
CREATE TRIGGER pos_audit_no_update
    BEFORE UPDATE ON pos_audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_pos_audit_modification();

DROP TRIGGER IF EXISTS pos_audit_no_delete ON pos_audit_events;
CREATE TRIGGER pos_audit_no_delete
    BEFORE DELETE ON pos_audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_pos_audit_modification();

-- ── 4. Table and column documentation ────────────────────────────────────────

COMMENT ON TABLE pos_audit_events IS
    'Append-only enterprise audit log for all POS events (sales, sessions, stock, receipts, auth). '
    'No FK constraints by design — audit records must survive parent record deletion. '
    'Governed by POPI Act (SA) and SARS 7-year audit retention requirement. '
    'UPDATE and DELETE are blocked at the database level by triggers.';

COMMENT ON COLUMN pos_audit_events.source IS
    'Event origin: online = real-time POS transaction, offline_sync = replayed from offline queue, system = automated/background process.';

COMMENT ON COLUMN pos_audit_events.action_category IS
    'High-level event category: sale | session | product | inventory | auth | receipt | override | sync';

COMMENT ON COLUMN pos_audit_events.action_type IS
    'Specific event type constant. See posAuditLogger.js POS_EVENTS for the canonical list.';

COMMENT ON COLUMN pos_audit_events.before_snapshot IS
    'JSONB snapshot of relevant entity state before this action. Null for creation events.';

COMMENT ON COLUMN pos_audit_events.after_snapshot IS
    'JSONB snapshot of relevant entity state after this action. Null for failure or deletion events.';

COMMENT ON COLUMN pos_audit_events.till_id IS
    'References tills.id — no FK constraint so audit records survive till deletion.';

COMMENT ON COLUMN pos_audit_events.till_session_id IS
    'References till_sessions.id — no FK constraint so audit records survive session deletion.';

COMMENT ON COLUMN pos_audit_events.sale_id IS
    'References sales.id — no FK constraint so audit records survive sale deletion or voiding.';
