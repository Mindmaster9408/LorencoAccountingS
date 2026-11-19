-- ============================================================================
-- 187 — Bot decisions + per-key bot policy (GrokBot, Codebox 4, 2026-11-19)
-- ============================================================================
-- 1. user_api_tokens.policy — what a bot using this key may do on its own.
--    Set by a person in Profile → Bot / AI access keys; never changeable through
--    the bot connection. Empty object = safe defaults (see shared/services/apiTokens.js).
-- 2. bot_decisions — every allocation decision a bot makes, with its reason and
--    the evidence it weighed (approved rule, Sean's suggestion, its own view).
--    Decisions that need a person (director/owner lines, disagreeing with Sean,
--    "approve everything" policy, exceptions the bot raises) wait here with
--    status 'pending_approval' / 'exception' until a person approves or rejects
--    them on the Bot Review page. Generic by design (action / entity columns) so
--    later bot actions can use the same queue.
-- Safe to re-run.
-- ============================================================================

ALTER TABLE user_api_tokens ADD COLUMN IF NOT EXISTS policy JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS bot_decisions (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bot_user_id          INTEGER NOT NULL REFERENCES users(id),
  api_token_id         BIGINT REFERENCES user_api_tokens(id) ON DELETE SET NULL,
  correlation_id       TEXT,
  action               TEXT NOT NULL DEFAULT 'allocate',          -- allocate | exception
  entity_type          TEXT NOT NULL DEFAULT 'bank_transaction',
  entity_id            BIGINT NOT NULL,                            -- bank_transactions.id
  status               TEXT NOT NULL CHECK (status IN
                         ('posted', 'pending_approval', 'exception', 'approved', 'rejected', 'failed')),
  decision_source      TEXT CHECK (decision_source IN ('rule', 'sean', 'evidence', 'bot')),
  proposed             JSONB,                                      -- { lines: [{accountId, amount, vatSettingId, vatInclusive, description}], description }
  rule_suggestion      JSONB,                                      -- the approved rule that applied, if any
  sean_suggestion      JSONB,                                      -- Sean's suggestion at decision time, if any
  reason               TEXT NOT NULL,                              -- the bot's reason
  disagreement_reason  TEXT,                                       -- required when the bot differs from Sean
  evidence             TEXT,
  hold_reasons         TEXT[] NOT NULL DEFAULT '{}',
  journal_id           BIGINT,
  error                TEXT,
  reviewed_by          INTEGER REFERENCES users(id),
  reviewed_at          TIMESTAMPTZ,
  review_note          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_decisions_company_status ON bot_decisions (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_decisions_entity ON bot_decisions (company_id, entity_type, entity_id);
-- One open item per bank line at a time (a line cannot wait for approval twice).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_decisions_one_open
  ON bot_decisions (company_id, entity_type, entity_id)
  WHERE status IN ('pending_approval', 'exception');

ALTER TABLE bot_decisions ENABLE ROW LEVEL SECURITY;   -- server-side access only (service key)
