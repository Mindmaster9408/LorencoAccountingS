-- ============================================================================
-- 055_practice_team_members.sql
-- Practice Team Members — internal staff/users of the accounting firm.
--
-- Architecture note:
--   practice_team_members → people working INSIDE the accounting firm
--   practice_clients      → the firm's own client files
--   practice_profiles     → the firm's own identity
--
-- User linking:
--   user_id is optional. A team member may be:
--   (a) Linked to a login account (user_id not null) — can receive task assignments
--   (b) Standalone (user_id null) — on roster only, cannot be assigned tasks yet.
--       Task assignment requires user_id because practice_tasks.assigned_to
--       stores a user ID from the users table. A future migration can add an
--       assigned_team_member_id column to support standalone assignment.
--
-- ID types: SERIAL INTEGER — consistent with all existing practice_* tables.
-- updated_at: managed by application PUT handler (no DB trigger, consistent
--   with existing pattern in practice routes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS practice_team_members (
    id                      SERIAL PRIMARY KEY,
    company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Optional link to a Lorenco login account (user_id in users table)
    -- Soft reference via INTEGER only — no FK to avoid auth schema complexity.
    -- Validated at application layer.
    user_id                 INTEGER,

    -- Core identity
    display_name            TEXT NOT NULL,
    email                   TEXT,
    phone                   TEXT,

    -- Role within the practice
    role                    TEXT NOT NULL DEFAULT 'staff' CHECK (role IN (
                                'owner', 'partner', 'manager', 'senior',
                                'staff', 'admin', 'reviewer', 'viewer'
                            )),
    job_title               TEXT,
    department              TEXT,

    -- Billing defaults (per-member override of practice default)
    default_hourly_rate     NUMERIC(12, 2) CHECK (
                                default_hourly_rate IS NULL OR default_hourly_rate >= 0
                            ),

    -- Capability flags (used for task routing and future workflow)
    can_receive_tasks       BOOLEAN NOT NULL DEFAULT TRUE,
    can_review_work         BOOLEAN NOT NULL DEFAULT FALSE,
    can_approve_work        BOOLEAN NOT NULL DEFAULT FALSE,

    -- Lifecycle
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    notes                   TEXT,

    -- Flexible extension point
    settings                JSONB NOT NULL DEFAULT '{}',

    -- Audit
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              INTEGER,   -- soft ref to users(id)
    updated_by              INTEGER    -- soft ref to users(id)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_practice_team_company
    ON practice_team_members(company_id);

CREATE INDEX IF NOT EXISTS idx_practice_team_user
    ON practice_team_members(user_id)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_practice_team_active
    ON practice_team_members(company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_practice_team_role
    ON practice_team_members(company_id, role);

-- Prevent same login user being linked to multiple team records in the same company
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_team_user_company_unique
    ON practice_team_members(company_id, user_id)
    WHERE user_id IS NOT NULL;

-- Prevent duplicate email within the same company (optional email, only when provided)
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_team_email_company_unique
    ON practice_team_members(company_id, email)
    WHERE email IS NOT NULL AND email <> '';

-- ── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE practice_team_members IS
    'Internal staff/team members of the accounting practice. '
    'Separate from practice_clients (the firm''s clients). '
    'One record per person per company. user_id optionally links to a login account.';

COMMENT ON COLUMN practice_team_members.user_id IS
    'Optional soft reference to users(id). No FK constraint — avoids auth schema complexity. '
    'When set, this team member can receive task assignments (practice_tasks.assigned_to stores user_id). '
    'When null, team member appears on roster only and cannot be task-assigned until a future '
    'assigned_team_member_id column is added to practice_tasks.';

COMMENT ON COLUMN practice_team_members.can_receive_tasks IS
    'Controls whether this member appears in the task assignee picker.';

COMMENT ON COLUMN practice_team_members.can_review_work IS
    'Reserved for future review/approval workflow routing.';

COMMENT ON COLUMN practice_team_members.can_approve_work IS
    'Reserved for future approval workflow routing.';

COMMENT ON COLUMN practice_team_members.settings IS
    'Flexible JSONB for future per-member preferences (notification settings, custom rates, etc.).';
