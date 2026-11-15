/**
 * Durable storage for Operant.
 *
 * Plain SQL over `postgres` (porsager). The two ideas worth knowing:
 *
 *  1. **The job queue is the table.** A job is claimed with
 *     `FOR UPDATE SKIP LOCKED` plus a lease. A crashed worker's lease expires and
 *     the job becomes claimable again, so a restart resumes work instead of
 *     stranding it. There is no separate broker to drift out of sync.
 *
 *  2. **Events are append-only and numbered.** `seq` is assigned by the writer and
 *     the (job_id, seq) unique constraint makes a duplicate impossible rather
 *     than silently orderable.
 */
import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Db = postgres.Sql<Record<string, never>>;

export function createDb(connectionString: string, max = 10): Db {
  return postgres(connectionString, {
    max,
    // Notices here are noise (extension already exists, etc.); errors still throw.
    onnotice: () => {},
    idle_timeout: 30,
  });
}

/** Apply every `*.sql` in `dir` in lexical order. Each file must be idempotent. */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sqlText = await readFile(join(dir, file), 'utf8');
    await db.unsafe(sqlText);
    applied.push(file);
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * Tasks and jobs
 * ------------------------------------------------------------------ */

export interface NewTaskInput {
  intent: string;
  title: string;
  requestedBy: string;
  origin: 'discord' | 'dashboard' | 'schedule' | 'api' | 'system';
  projectKey?: string | null;
  projectPath?: string | null;
  conversationId?: string | null;
  requireVerification?: boolean;
}

export interface NewJobInput {
  taskId: string;
  kind: 'plan' | 'execute' | 'review' | 'verify' | 'research' | 'transcribe' | 'synthesize';
  agentId: string;
  title: string;
  prompt: string;
  workspacePath: string;
  permissionMode?: string;
  parentJobId?: string | null;
  maxAttempts?: number;
  dshProfile?: string;
}

export interface TaskRow {
  id: string;
  intent: string;
  title: string;
  status: string;
  project_key: string | null;
  project_path: string | null;
  requested_by: string;
  origin: string;
  progress_note: string | null;
  failure_reason: string | null;
  require_verification: boolean;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface JobRow {
  id: string;
  task_id: string;
  kind: string;
  status: string;
  agent_id: string;
  title: string;
  prompt: string;
  dsh_profile: string;
  dsh_session_id: string | null;
  attempt: number;
  max_attempts: number;
  workspace_path: string;
  permission_mode: string;
  result: string | null;
  error: string | null;
  usage: unknown;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/**
 * Create a task and its first job atomically. A task with no job would be
 * unreachable work, so they are one unit.
 */
export async function createTaskWithJob(
  db: Db,
  task: NewTaskInput,
  job: Omit<NewJobInput, 'taskId'>,
): Promise<{ task: TaskRow; job: JobRow }> {
  return db.begin(async (tx) => {
    const [t] = await tx<TaskRow[]>`
      INSERT INTO tasks (intent, title, requested_by, origin, project_key, project_path,
                         conversation_id, require_verification, status, started_at)
      VALUES (${task.intent}, ${task.title}, ${task.requestedBy}, ${task.origin},
              ${task.projectKey ?? null}, ${task.projectPath ?? null},
              ${task.conversationId ?? null}, ${task.requireVerification ?? false},
              'queued', now())
      RETURNING *`;
    if (!t) throw new Error('task insert returned no row');
    const [j] = await tx<JobRow[]>`
      INSERT INTO jobs (task_id, kind, agent_id, parent_job_id, title, prompt, workspace_path,
                        permission_mode, max_attempts, dsh_profile)
      VALUES (${t.id}, ${job.kind}, ${job.agentId}, ${job.parentJobId ?? null}, ${job.title},
              ${job.prompt}, ${job.workspacePath}, ${job.permissionMode ?? 'workspace-write'},
              ${job.maxAttempts ?? 2}, ${job.dshProfile ?? 'operant'})
      RETURNING *`;
    if (!j) throw new Error('job insert returned no row');
    await tx`INSERT INTO audit_log (action, actor, task_id, job_id, payload)
             VALUES ('task.created', ${task.requestedBy}, ${t.id}, ${j.id},
                     ${tx.json({ origin: task.origin, intent: task.intent } as never)})`;
    return { task: t, job: j };
  }) as Promise<{ task: TaskRow; job: JobRow }>;
}

/**
 * Claim the oldest queued job, or one whose lease expired (a dead worker).
 * Returns null when there is nothing to do — which is not an error.
 *
 * The claim and the task's status transition happen in ONE statement. Doing it
 * in two (claim here, update the task later from the worker) left the task
 * showing `queued` for the whole run, because the worker only learned the
 * session id after the child process had already spawned.
 */
export async function claimNextJob(db: Db, workerId: string, leaseSeconds = 900): Promise<JobRow | null> {
  const rows = await db<JobRow[]>`
    WITH claimed AS (
      UPDATE jobs
         SET status = 'running',
             lease_owner = ${workerId},
             lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval,
             started_at = coalesce(started_at, now()),
             updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
          WHERE status = 'queued'
             OR (status IN ('running','dispatched') AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1)
      RETURNING *
    ), touched AS (
      UPDATE tasks t
         SET status = 'running',
             started_at = coalesce(t.started_at, now()),
             updated_at = now()
        WHERE t.id IN (SELECT task_id FROM claimed)
          AND t.status IN ('queued','planning')
    )
    SELECT * FROM claimed`;
  return rows[0] ?? null;
}

/** Extend a lease while a long run is still producing events. */
export async function renewLease(db: Db, jobId: string, workerId: string, leaseSeconds = 900): Promise<void> {
  await db`UPDATE jobs
             SET lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval, updated_at = now()
           WHERE id = ${jobId} AND lease_owner = ${workerId}`;
}

export async function markJobDispatched(db: Db, jobId: string, sessionId: string | null): Promise<void> {
  await db`UPDATE jobs SET status = 'running', dsh_session_id = coalesce(${sessionId}, dsh_session_id),
                              updated_at = now()
            WHERE id = ${jobId}`;
  await db`UPDATE tasks SET status = 'running', updated_at = now()
            WHERE id = (SELECT task_id FROM jobs WHERE id = ${jobId}) AND status IN ('queued','planning')`;
}

export interface JobEventInput {
  seq: number;
  type: string;
  payload: unknown;
}

export async function appendJobEvents(db: Db, jobId: string, events: JobEventInput[]): Promise<void> {
  if (events.length === 0) return;
  // `payload` is an arbitrary JSON object from the runner. The driver types its
  // bulk-insert helper against a JSON-safe union, so the cast is at the call
  // site rather than widening every caller to that union.
  const rows = events.map((e) => ({
    job_id: jobId,
    seq: e.seq,
    type: e.type,
    payload: e.payload as never,
  }));
  await db`INSERT INTO job_events ${db(rows, 'job_id', 'seq', 'type', 'payload')}
           ON CONFLICT (job_id, seq) DO NOTHING`;
}

export interface FinalizeInput {
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  result?: string | null;
  error?: string | null;
  usage?: unknown;
  sessionId?: string | null;
}

/**
 * Close a job and roll the outcome up to its task.
 *
 * Task status is derived, never set directly by the caller: a task is only
 * `succeeded` when every job succeeded, which is what stops a failed reviewer
 * from being reported as a success.
 */
export async function finalizeJob(db: Db, jobId: string, input: FinalizeInput): Promise<void> {
  await db.begin(async (tx) => {
    await tx`UPDATE jobs
                SET status = ${input.status},
                    result = ${input.result ?? null},
                    error = ${input.error ?? null},
                    usage = ${input.usage === undefined ? null : tx.json(input.usage as never)},
                    dsh_session_id = coalesce(${input.sessionId ?? null}, dsh_session_id),
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    finished_at = now(),
                    updated_at = now()
              WHERE id = ${jobId}`;

    const [taskId] = await tx<{ task_id: string }[]>`SELECT task_id FROM jobs WHERE id = ${jobId}`;
    if (!taskId) return;

    const [agg] = await tx<{ total: number; succeeded: number; failed: number; open: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
             count(*) FILTER (WHERE status IN ('failed','cancelled','interrupted'))::int AS failed,
             count(*) FILTER (WHERE status IN ('queued','dispatched','running','waiting_approval'))::int AS open
        FROM jobs WHERE task_id = ${taskId.task_id}`;
    if (!agg) return;

    let status: string;
    let failure: string | null = null;
    if (agg.open > 0) status = 'running';
    else if (agg.failed > 0) {
      status = 'failed';
      const [f] = await tx<{ error: string | null }[]>`
        SELECT error FROM jobs WHERE task_id = ${taskId.task_id} AND error IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`;
      failure = f?.error ?? 'one or more jobs failed';
    } else status = 'succeeded';

    await tx`UPDATE tasks
                SET status = ${status},
                    failure_reason = ${failure},
                    finished_at = CASE WHEN ${status} IN ('succeeded','failed','cancelled') THEN now() ELSE finished_at END,
                    updated_at = now()
              WHERE id = ${taskId.task_id}`;
  });
}

export async function getTask(db: Db, id: string): Promise<TaskRow | null> {
  const [t] = await db<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id}`;
  return t ?? null;
}

export async function listTasks(db: Db, limit = 50, status?: string): Promise<TaskRow[]> {
  if (status) {
    return db<TaskRow[]>`SELECT * FROM tasks WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  return db<TaskRow[]>`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ${limit}`;
}

export async function getJobsForTask(db: Db, taskId: string): Promise<JobRow[]> {
  return db<JobRow[]>`SELECT * FROM jobs WHERE task_id = ${taskId} ORDER BY created_at ASC`;
}

export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  const [j] = await db<JobRow[]>`SELECT * FROM jobs WHERE id = ${id}`;
  return j ?? null;
}

export async function getJobEvents(db: Db, jobId: string, afterSeq = -1, limit = 500) {
  return db`SELECT id, job_id, seq, type, payload, at FROM job_events
             WHERE job_id = ${jobId} AND seq > ${afterSeq}
             ORDER BY seq ASC LIMIT ${limit}`;
}

/** Cancel a task and every job still open under it. */
export async function cancelTask(db: Db, taskId: string, actor: string): Promise<number> {
  return db.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE jobs SET status = 'cancelled', finished_at = now(), updated_at = now()
       WHERE task_id = ${taskId} AND status IN ('queued','dispatched','running','waiting_approval')
      RETURNING id`;
    await tx`UPDATE tasks SET status = 'cancelled', finished_at = now(), updated_at = now()
              WHERE id = ${taskId} AND status NOT IN ('succeeded','failed','cancelled')`;
    await tx`INSERT INTO audit_log (action, actor, task_id, payload)
             VALUES ('job.cancelled', ${actor}, ${taskId}, ${tx.json({ count: rows.length } as never)})`;
    return rows.length;
  }) as Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

export interface MemoryRow {
  id: string;
  kind: string;
  scope: string;
  project_key: string | null;
  title: string;
  body: string;
  tags: string[];
  importance: number;
  hits: number;
  active: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

export interface NewMemoryInput {
  kind: 'episodic' | 'semantic' | 'procedural' | 'failure' | 'evaluation';
  scope?: 'global' | 'project';
  projectKey?: string | null;
  title: string;
  body: string;
  tags?: string[];
  importance?: number;
  sourceTaskId?: string | null;
  sourceJobId?: string | null;
}

export async function insertMemory(db: Db, m: NewMemoryInput): Promise<MemoryRow> {
  const [row] = await db<MemoryRow[]>`
    INSERT INTO memories (kind, scope, project_key, title, body, tags, importance, source_task_id, source_job_id)
    VALUES (${m.kind}, ${m.scope ?? (m.projectKey ? 'project' : 'global')}, ${m.projectKey ?? null},
            ${m.title}, ${m.body}, ${m.tags ?? []}, ${m.importance ?? 0.5},
            ${m.sourceTaskId ?? null}, ${m.sourceJobId ?? null})
    RETURNING id, kind, scope, project_key, title, body, tags, importance, hits, active, created_at, last_used_at`;
  if (!row) throw new Error('memory insert returned no row');
  return row;
}

/**
 * Rank memories for a query. Lexical first (ts_rank, weighted title > body),
 * then importance and recency as tie-breakers. If the query matches nothing
 * lexically we fall back to substring matching so a phrasing mismatch still
 * surfaces something instead of an empty answer.
 */
export async function searchMemories(
  db: Db,
  query: string,
  opts: { kinds?: string[]; scope?: string; projectKey?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? 8;
  const rows = await db<
    (MemoryRow & { rank: number; matched_by: string })[]
  >`
    WITH q AS (SELECT websearch_to_tsquery('english', ${query}) AS tsq)
    SELECT m.id, m.kind, m.scope, m.project_key, m.title, m.body, m.tags, m.importance, m.hits,
           m.active, m.created_at, m.last_used_at,
           ts_rank(m.search_tsv, q.tsq) AS rank, 'lexical'::text AS matched_by
      FROM memories m, q
     WHERE m.active
       AND m.search_tsv @@ q.tsq
       AND (${opts.kinds ?? null}::text[] IS NULL OR m.kind = ANY(${opts.kinds ?? null}::text[]))
       AND (${opts.scope ?? null}::text IS NULL OR m.scope = ${opts.scope ?? null})
       AND (${opts.projectKey ?? null}::text IS NULL OR m.project_key = ${opts.projectKey ?? null}
            OR m.scope = 'global')
     ORDER BY rank DESC, m.importance DESC, m.created_at DESC
     LIMIT ${limit}`;

  if (rows.length > 0) {
    await db`UPDATE memories SET hits = hits + 1, last_used_at = now()
              WHERE id = ANY(${rows.map((r) => r.id)})`;
    return rows;
  }

  const fallback = await db<(MemoryRow & { rank: number; matched_by: string })[]>`
    SELECT m.id, m.kind, m.scope, m.project_key, m.title, m.body, m.tags, m.importance, m.hits,
           m.active, m.created_at, m.last_used_at,
           0::float8 AS rank, 'substring'::text AS matched_by
      FROM memories m
     WHERE m.active
       AND (m.title ILIKE ${'%' + query + '%'} OR m.body ILIKE ${'%' + query + '%'})
     ORDER BY m.importance DESC, m.created_at DESC
     LIMIT ${limit}`;
  if (fallback.length > 0) {
    await db`UPDATE memories SET hits = hits + 1, last_used_at = now()
              WHERE id = ANY(${fallback.map((r) => r.id)})`;
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Usage, audit, health
 * ------------------------------------------------------------------ */

export async function recordUsage(
  db: Db,
  u: {
    jobId?: string | null;
    taskId?: string | null;
    kind: 'llm' | 'tool' | 'speech' | 'storage';
    provider: string;
    model?: string | null;
    promptTokens?: number;
    completionTokens?: number;
    units?: number;
  },
): Promise<void> {
  await db`INSERT INTO usage_events (job_id, task_id, kind, provider, model, prompt_tokens, completion_tokens, units)
           VALUES (${u.jobId ?? null}, ${u.taskId ?? null}, ${u.kind}, ${u.provider}, ${u.model ?? null},
                   ${u.promptTokens ?? 0}, ${u.completionTokens ?? 0}, ${u.units ?? 0})`;
}

export async function recordHealth(
  db: Db,
  name: string,
  state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown',
  latencyMs: number | null,
  detail: string | null,
): Promise<void> {
  await db`INSERT INTO health_checks (name, state, latency_ms, detail)
           VALUES (${name}, ${state}, ${latencyMs}, ${detail})`;
}

export async function usageSummary(db: Db) {
  const [row] = await db<{ prompt_tokens: number; completion_tokens: number; jobs: number }[]>`
    SELECT coalesce(sum(prompt_tokens),0)::int AS prompt_tokens,
           coalesce(sum(completion_tokens),0)::int AS completion_tokens,
           count(DISTINCT job_id)::int AS jobs
      FROM usage_events`;
  return row ?? { prompt_tokens: 0, completion_tokens: 0, jobs: 0 };
}