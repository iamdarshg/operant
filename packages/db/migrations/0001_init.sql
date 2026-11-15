-- Operant control-plane schema (Postgres 16+).
--
-- Design notes that matter:
--  * Plain SQL, no ORM: the domain is small and hand-written SQL keeps the
--    migration and the query layer from drifting apart.
--  * Idempotent (IF NOT EXISTS everywhere) so a redeploy is safe.
--  * job_events is append-only with a per-job monotonic `seq`; the UI orders by
--    it and can detect gaps after a restart instead of silently reordering.
--  * Memory search uses a generated tsvector + GIN index. No pgvector: lexical
--    retrieval plus importance/recency ranking is enough at personal scale, and
--    it degrades predictably when embeddings are absent.
--  * Nothing here stores secrets. Credentials live outside the database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------ identity
CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,              -- discord:1234 / dashboard:email
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator'
                  CHECK (role IN ('operator','viewer','agent')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);

-- --------------------------------------------------------------- conversations
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref  TEXT UNIQUE NOT NULL,           -- discord channel/thread id
  channel       TEXT NOT NULL,
  project_key   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------- agents
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,             -- stable slug
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  model_provider  TEXT,
  model_id        TEXT,
  system_overlay  TEXT NOT NULL DEFAULT '',
  allowed_tools   TEXT[] NOT NULL DEFAULT '{}',
  permission_mode TEXT NOT NULL DEFAULT 'workspace-write',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 1 AND 8),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent           TEXT NOT NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','planning','running','waiting_approval',
                                       'reviewing','succeeded','failed','cancelled','blocked')),
  project_key      TEXT,
  project_path     TEXT,
  requested_by     TEXT NOT NULL,
  origin           TEXT NOT NULL
                     CHECK (origin IN ('discord','dashboard','schedule','api','system')),
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  supervisor_job_id UUID,
  progress_note    TEXT,
  failure_reason   TEXT,
  require_verification BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tasks_status_idx  ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks (created_at DESC);

-- ------------------------------------------------------------------------ jobs
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('plan','execute','review','verify','research','transcribe','synthesize')),
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','dispatched','running','waiting_approval',
                                       'succeeded','failed','cancelled','interrupted')),
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  parent_job_id    UUID REFERENCES jobs(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  dsh_profile      TEXT NOT NULL DEFAULT 'operant',
  dsh_session_id   TEXT,
  attempt          INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  max_attempts     INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  workspace_path   TEXT NOT NULL,
  permission_mode  TEXT NOT NULL DEFAULT 'workspace-write',
  verified_by_job_ids UUID[] NOT NULL DEFAULT '{}',
  result           TEXT,
  error            TEXT,
  usage            JSONB,
  -- A worker holds a lease while executing; a stale lease is how a crashed
  -- worker's job becomes recoverable instead of stuck forever.
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_status_idx    ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_task_idx      ON jobs (task_id);
CREATE INDEX IF NOT EXISTS jobs_lease_idx     ON jobs (status, lease_expires_at);

-- ------------------------------------------------------------------ job_events
CREATE TABLE IF NOT EXISTS job_events (
  id       BIGSERIAL PRIMARY KEY,
  job_id   UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  type     TEXT NOT NULL,
  payload  JSONB NOT NULL,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, seq);

-- -------------------------------------------------------------------- artifacts
CREATE TABLE IF NOT EXISTS artifacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  bytes       BIGINT NOT NULL,
  sha256      CHAR(64) NOT NULL,
  remote_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id);

-- -------------------------------------------------------------------- approvals
CREATE TABLE IF NOT EXISTS approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID REFERENCES tasks(id) ON DELETE CASCADE,
  job_id        UUID REFERENCES jobs(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  action        JSONB NOT NULL,
  risk          TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  decision_note TEXT,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (status, created_at DESC);

-- ---------------------------------------------------------------------- memory
CREATE TABLE IF NOT EXISTS memories (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL
                   CHECK (kind IN ('episodic','semantic','procedural','failure','evaluation')),
  scope          TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('global','project')),
  project_key    TEXT,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  importance     REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  hits           INTEGER NOT NULL DEFAULT 0,
  source_task_id UUID,
  source_job_id  UUID,
  active         BOOLEAN NOT NULL DEFAULT true,
  superseded_by  UUID,
  embedding      JSONB,
  search_tsv     tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                   setweight(to_tsvector('english', coalesce(body,'')),  'B')
                 ) STORED,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS memories_tsv_idx  ON memories USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories (kind, scope, active);
CREATE INDEX IF NOT EXISTS memories_project_idx ON memories (project_key) WHERE project_key IS NOT NULL;

-- ------------------------------------------------------------------- incidents
CREATE TABLE IF NOT EXISTS incidents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint  TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  symptom      TEXT NOT NULL,
  root_cause   TEXT,
  category     TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (category IN ('dependency_missing','config_drift','auth_failure','network',
                                     'resource_exhaustion','tool_misuse','model_quality','code_defect','unknown')),
  occurrences  INTEGER NOT NULL DEFAULT 1,
  task_ids     UUID[] NOT NULL DEFAULT '{}',
  job_ids      UUID[] NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','diagnosed','mitigated','resolved','wontfix')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- improvements
CREATE TABLE IF NOT EXISTS improvements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  rationale   TEXT NOT NULL,
  change      JSONB NOT NULL,
  risk        TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  status      TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','testing','test_failed','reviewed','promoted','rolled_back','rejected')),
  evidence    JSONB NOT NULL DEFAULT '[]',
  rollback    JSONB NOT NULL,
  reviewed_by TEXT,
  promoted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- schedules
CREATE TABLE IF NOT EXISTS schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  rrule       TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Calcutta',
  prompt      TEXT NOT NULL,
  agent_slug  TEXT NOT NULL DEFAULT 'generalist',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- usage / cost
CREATE TABLE IF NOT EXISTS usage_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID REFERENCES jobs(id) ON DELETE CASCADE,
  task_id           UUID REFERENCES tasks(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('llm','tool','speech','storage')),
  provider          TEXT NOT NULL,
  model             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  units             DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_micros       BIGINT,
  currency          CHAR(3) DEFAULT 'USD',
  at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_at_idx ON usage_events (at DESC);

-- -------------------------------------------------------------------- auditlog
CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  action  TEXT NOT NULL,
  actor   TEXT NOT NULL,
  task_id UUID,
  job_id  UUID,
  payload JSONB NOT NULL DEFAULT '{}',
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log (at DESC);

-- ----------------------------------------------------------------- healthchecks
CREATE TABLE IF NOT EXISTS health_checks (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('healthy','degraded','unhealthy','unknown')),
  latency_ms DOUBLE PRECISION,
  detail     TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_name_idx ON health_checks (name, checked_at DESC);

-- ------------------------------------------------------------------- seed data
-- Default specialist agents. On conflict we do NOT overwrite operator edits.
INSERT INTO agents (id, display_name, role, description, permission_mode, max_concurrency, system_overlay, allowed_tools)
VALUES
  ('engineering', 'Engineering', 'engineer',
   'Implements and repairs code in a project workspace.',
   'workspace-write', 2,
   'You are the engineering specialist. Work only inside the workspace directory you were given. Read before writing. Run the tests you claim pass. If a command fails, paste its real output rather than describing it.',
   ARRAY['read','write','edit','glob','grep','pwsh','bash']),
  ('review', 'Review', 'reviewer',
   'Independent critique of another agent''s artifact. Never the same context that produced it.',
   'read-only', 2,
   'You are an independent reviewer. You did not write the code you are reviewing. Look for concrete defects with file:line evidence, missing tests, and claims that are not backed by a command that was actually run. Do not approve by summary alone.',
   ARRAY['read','glob','grep','bash','pwsh']),
  ('research', 'Research', 'researcher',
   'Read-only investigation across sources and repositories.',
   'read-only', 3,
   'You are a research specialist. Separate verified facts from inference, cite the file path or URL for every claim, and state explicitly what you could not verify.',
   ARRAY['read','glob','grep','web_search','web_fetch']),
  ('generalist', 'Generalist', 'generalist',
   'Default agent for ordinary requests.',
   'workspace-write', 2,
   'You are a generalist operator. Be concise and concrete. When a request is ambiguous, state the interpretation you chose instead of stalling.',
   ARRAY['read','write','edit','glob','grep','pwsh','bash','web_search','web_fetch'])
ON CONFLICT (id) DO NOTHING;