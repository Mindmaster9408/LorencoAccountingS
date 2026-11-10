-- ============================================================================
-- Migration 174: Local AI worker queue (Slip Capture layer 3 — local, not external)
-- ============================================================================
-- Ruan 2026-11-10: until there is budget for Claude, a model runs on his own
-- computer (Ollama). The app is in the cloud and cannot reach that computer, so
-- the computer's worker ASKS for work: the server queues a job here, the worker
-- claims it over HTTPS (its own token), reads the slip locally and posts the
-- answer back. Nothing is sent to an external AI service.
--
-- Generic on purpose (kind): 'slip_read' (Slip Capture layer 3) and 'help_answer'
-- (SEVCO help chatbot); other features can use the same worker later. A job only ever produces a SUGGESTION.
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_ai_jobs (
  id            BIGSERIAL    PRIMARY KEY,
  company_id    INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          TEXT         NOT NULL CHECK (kind IN ('slip_read', 'help_answer')),
  ref_id        BIGINT       NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  attempts      INTEGER      NOT NULL DEFAULT 0,
  max_attempts  INTEGER      NOT NULL DEFAULT 3,
  claimed_by    TEXT         NULL,
  lease_until   TIMESTAMPTZ  NULL,
  error         TEXT         NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  done_at       TIMESTAMPTZ  NULL
);

-- One open job per item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_ai_jobs_open
  ON local_ai_jobs (kind, ref_id) WHERE status IN ('queued', 'claimed');
CREATE INDEX IF NOT EXISTS idx_local_ai_jobs_queue ON local_ai_jobs (status, kind, id);
ALTER TABLE local_ai_jobs ENABLE ROW LEVEL SECURITY;

-- Which workers are alive (last heartbeat), so the app can say "AI reader offline".
CREATE TABLE IF NOT EXISTS local_ai_workers (
  worker_id   TEXT         PRIMARY KEY,
  last_seen   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  info        JSONB        NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE local_ai_workers ENABLE ROW LEVEL SECURITY;

-- Claim the oldest open job of the given kinds (a claimed job whose lease ran out
-- is open again). Jobs that used up their attempts become 'failed'.
CREATE OR REPLACE FUNCTION local_ai_claim(p_worker TEXT, p_kinds TEXT[], p_lease_seconds INTEGER)
RETURNS SETOF local_ai_jobs
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE local_ai_jobs
     SET status = 'failed', error = COALESCE(error, 'No answer from the worker after ' || attempts || ' attempts'),
         updated_at = now(), done_at = now()
   WHERE status = 'claimed' AND lease_until < now() AND attempts >= max_attempts;

  RETURN QUERY
  UPDATE local_ai_jobs j
     SET status = 'claimed', claimed_by = p_worker, attempts = j.attempts + 1,
         lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   WHERE j.id = (
     SELECT id FROM local_ai_jobs
      WHERE kind = ANY (p_kinds)
        AND attempts < max_attempts
        AND (status = 'queued' OR (status = 'claimed' AND lease_until < now()))
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING j.*;
END;
$$;

COMMENT ON TABLE local_ai_jobs IS
  'Work for the local AI worker on Ruan''s computer (Ollama). Suggestions only. Migration 174.';
