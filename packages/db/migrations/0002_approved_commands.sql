-- Approved tool calls.
--
-- When the tool-call guard stops a run, a human may approve that exact command.
-- Approving must actually permit it, otherwise the approval is a dead end that
-- blocks the same command again forever — a gate that can never be passed is as
-- broken as one that never closes.
--
-- Additive and idempotent, so a rollback of the application never needs a schema
-- rollback.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS approved_commands JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN jobs.approved_commands IS
  'Exact tool commands a human approved for this job; the tool-boundary guard permits only these.';