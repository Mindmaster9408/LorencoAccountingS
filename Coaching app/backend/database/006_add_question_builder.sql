-- 006_add_question_builder.sql
-- Question Builder foundation — global reusable question library.
-- Self-created at runtime by question-builder.routes.js (ensureQuestionBuilderTables).
-- This file is a reference/manual-run copy of the same DDL.
--
-- Safe to run multiple times: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- No DROP statements, no destructive operations.

-- ─── coaching_questions ──────────────────────────────────────────────────────
-- Global reusable questions created by the coach.
-- Answers are NOT stored here — they are client-specific (see coaching_client_question_answers).

CREATE TABLE IF NOT EXISTS coaching_questions (
    id                  SERIAL PRIMARY KEY,
    question_text       TEXT NOT NULL,
    question_type       TEXT NOT NULL,
        -- Allowed: short_text | long_text | rating | yes_no | single_choice | multi_choice
    category            TEXT,
        -- Examples: PGF | Four Quadrants | Session | Reflection | General
    context_key         TEXT,
        -- Examples: pgf.present | pgf.gap | pgf.future | four_quadrants.goals | session.checkin
    scale_min           INTEGER,
    scale_max           INTEGER,
    scale_label_min     TEXT,
    scale_label_max     TEXT,
    options             JSONB NOT NULL DEFAULT '[]'::jsonb,
        -- Used for single_choice and multi_choice types
    help_text           TEXT,
    is_required         BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_by_user_id  INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cq_category    ON coaching_questions(category);
CREATE INDEX IF NOT EXISTS idx_cq_context_key ON coaching_questions(context_key);
CREATE INDEX IF NOT EXISTS idx_cq_is_active   ON coaching_questions(is_active);

-- ─── coaching_client_question_assignments ────────────────────────────────────
-- Links global questions to a specific client + context.
-- Allows the coach to select which questions apply to a given client journey step.

CREATE TABLE IF NOT EXISTS coaching_client_question_assignments (
    id                  SERIAL PRIMARY KEY,
    client_id           INTEGER NOT NULL,
    question_id         INTEGER NOT NULL,
    context_key         TEXT NOT NULL,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id  INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ccqa_client_ctx ON coaching_client_question_assignments(client_id, context_key);

-- ─── coaching_client_question_answers ────────────────────────────────────────
-- Client-specific, context-specific answers to assigned questions.
-- All three answer columns (text / number / json) are optional;
-- the appropriate one is populated based on question_type.

CREATE TABLE IF NOT EXISTS coaching_client_question_answers (
    id                  SERIAL PRIMARY KEY,
    client_id           INTEGER NOT NULL,
    question_id         INTEGER NOT NULL,
    context_key         TEXT NOT NULL,
    answer_text         TEXT,
    answer_number       NUMERIC,
    answer_json         JSONB,
    answered_at         TIMESTAMPTZ DEFAULT now(),
    created_by_user_id  INTEGER,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ccqans_client_ctx ON coaching_client_question_answers(client_id, context_key);
CREATE INDEX IF NOT EXISTS idx_ccqans_question   ON coaching_client_question_answers(question_id);
