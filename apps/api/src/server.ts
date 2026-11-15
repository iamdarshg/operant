/**
 * Operant control-plane API.
 *
 * Responsibilities are deliberately narrow: own task/job lifecycle, persist the
 * event trail, and serve it to the Discord bot and the dashboard through one
 * typed surface. It does NOT execute agents itself — that is the worker's job,
 * so a long run can never block an HTTP request (the same reason the Discord bot
 * must never await a job inline).
 *
 * Security posture:
 *  - fails closed: with no OPERANT_BOT_TOKEN the process refuses to boot rather
 *    than serving an unauthenticated control plane
 *  - every mutation is bearer-authenticated and written to audit_log
 *  - request bodies are schema-validated before touching the database
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CreateRequestInput,
  DecideApprovalInput,
  MemorySearchInput,
  TERMINAL_JOB_STATUSES,
} from '@operant/core';
import {
  cancelTask,
  createDb,
  createTaskWithJob,
  getJob,
  getJobEvents,
  getJobsForTask,
  getTask,
  insertMemory,
  listTasks,
  recordHealth,
  searchMemories,
  usageSummary,
} from '@operant/db';

const PORT = Number(process.env['OPERANT_API_PORT'] ?? 8787);
const HOST = process.env['OPERANT_API_HOST'] ?? '127.0.0.1';
const TOKEN = process.env['OPERANT_BOT_TOKEN'] ?? '';
const DB_URL = process.env['DATABASE_URL'] ?? '';
const WORKSPACE_ROOT = process.env['DSH_WORKSPACE_ROOT'] ?? join(process.cwd(), 'data', 'jobs');
const DSH_PROFILE = process.env['DSH_PROFILE'] ?? 'operant';

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    'FATAL: OPERANT_BOT_TOKEN is unset or too short. Refusing to start an unauthenticated control plane.',
  );
  process.exit(1);
}
if (!DB_URL) {
  console.error('FATAL: DATABASE_URL is unset.');
  process.exit(1);
}

const db = createDb(DB_URL);
const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

await app.register(cors, { origin: true, credentials: false });

/** Bearer check. Uses a constant-time-ish comparison to avoid timing leaks. */
function authorized(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= provided[i]! ^ expected[i]!;
  return diff === 0;
}

app.addHook('onRequest', async (req, reply) => {
  // Health is unauthenticated on purpose so a supervisor can probe liveness
  // without holding a credential. It exposes no work product.
  if (req.url === '/v1/health' || req.url.startsWith('/v1/health?')) return;
  if (!authorized(req.headers.authorization)) {
    req.log.warn({ url: req.url, ip: req.ip }, 'unauthorized request');
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

/* ------------------------------------------------------------------ health */

app.get('/v1/health', async () => {
  const checks: { name: string; state: string; detail?: string }[] = [];
  try {
    const t0 = Date.now();
    await db`SELECT 1`;
    checks.push({ name: 'postgres', state: 'healthy', detail: `${Date.now() - t0}ms` });
    await recordHealth(db, 'postgres', 'healthy', Date.now() - t0, null);
  } catch (err) {
    checks.push({ name: 'postgres', state: 'unhealthy', detail: String(err) });
    await recordHealth(db, 'postgres', 'unhealthy', null, String(err)).catch(() => {});
  }
  const degraded = checks.some((c) => c.state !== 'healthy');
  return { state: degraded ? 'degraded' : 'healthy', checks, dshProfile: DSH_PROFILE };
});

/* ------------------------------------------------------------------ requests */

app.post('/v1/requests', async (req, reply) => {
  const parsed = CreateRequestInput.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
  }
  const input = parsed.data;

  const agentId = input.agentSlug ?? defaultAgentFor(input.text);
  const taskId = randomUUID();
  const workspacePath = join(WORKSPACE_ROOT, taskId);
  await mkdir(workspacePath, { recursive: true });

  const { task, job } = await createTaskWithJob(
    db,
    {
      intent: input.text,
      title: titleFrom(input.text),
      requestedBy: input.requestedBy,
      origin: input.origin,
      projectPath: input.projectPath ?? null,
      requireVerification: input.requireVerification ?? false,
    },
    {
      kind: 'execute',
      agentId,
      title: titleFrom(input.text),
      prompt: buildPrompt(input.text, workspacePath, input.projectPath),
      workspacePath,
      permissionMode: 'workspace-write',
      dshProfile: DSH_PROFILE,
    },
  );

  req.log.info({ taskId: task.id, jobId: job.id, agentId }, 'request accepted');
  return reply.code(202).send({
    taskId: task.id,
    jobId: job.id,
    agentId,
    status: task.status,
    eventsUrl: `/v1/jobs/${job.id}/events`,
    streamUrl: `/v1/jobs/${job.id}/stream`,
  });
});

/* --------------------------------------------------------------------- tasks */

app.get('/v1/tasks', async (req) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), status: z.string().optional() }).parse(req.query);
  return { tasks: await listTasks(db, q.limit, q.status) };
});

app.get('/v1/tasks/:id', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const task = await getTask(db, id);
  if (!task) return reply.code(404).send({ error: 'not_found' });
  const jobs = await getJobsForTask(db, id);
  return { task, jobs };
});

app.post('/v1/tasks/:id/cancel', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const cancelled = await cancelTask(db, id, 'api');
  req.log.info({ taskId: id, cancelled }, 'task cancelled');
  return { cancelled };
});

/* ---------------------------------------------------------------------- jobs */

app.get('/v1/jobs/:id', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const job = await getJob(db, id);
  if (!job) return reply.code(404).send({ error: 'not_found' });
  return { job };
});

app.get('/v1/jobs/:id/events', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { after } = z.object({ after: z.coerce.number().int().default(-1) }).parse(req.query);
  return { events: await getJobEvents(db, id, after) };
});

/**
 * Server-sent events over the persisted trail.
 *
 * Polling the table (rather than holding an in-memory bus) means a client that
 * reconnects after a restart resumes from `after=<lastSeq>` and misses nothing.
 */
app.get('/v1/jobs/:id/stream', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { after } = z.object({ after: z.coerce.number().int().default(-1) }).parse(req.query);

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let lastSeq = after;
  let closed = false;
  req.raw.on('close', () => {
    closed = true;
  });

  const send = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    while (!closed) {
      const rows = (await getJobEvents(db, id, lastSeq, 200)) as unknown as {
        seq: number;
        type: string;
        payload: unknown;
        at: Date;
      }[];
      for (const row of rows) {
        lastSeq = row.seq;
        send('job_event', row);
      }
      const job = await getJob(db, id);
      if (!job) {
        send('error', { error: 'job vanished' });
        break;
      }
      if (TERMINAL_JOB_STATUSES.includes(job.status as never)) {
        send('job_done', { status: job.status, result: job.result, error: job.error });
        break;
      }
      if (rows.length === 0) {
        // Heartbeat keeps intermediaries from closing an idle stream.
        reply.raw.write(': keepalive\n\n');
        await sleep(700);
      }
    }
  } finally {
    reply.raw.end();
  }
  return reply;
});

/* -------------------------------------------------------------------- memory */

app.get('/v1/memory/search', async (req) => {
  const parsed = MemorySearchInput.safeParse({
    query: (req.query as Record<string, unknown>)['q'],
    limit: (req.query as Record<string, unknown>)['limit'] ?? 8,
    projectKey: (req.query as Record<string, unknown>)['projectKey'],
  });
  if (!parsed.success) return { error: 'invalid_query', issues: parsed.error.issues, results: [] };
  const rows = await searchMemories(db, parsed.data.query, {
    limit: parsed.data.limit,
    projectKey: parsed.data.projectKey,
  });
  return {
    results: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      excerpt: r.body.slice(0, 600),
      importance: r.importance,
      matchedBy: r.matched_by,
      score: r.rank,
    })),
  };
});

app.post('/v1/memory', async (req, reply) => {
  const body = z
    .object({
      kind: z.enum(['episodic', 'semantic', 'procedural', 'failure', 'evaluation']),
      scope: z.enum(['global', 'project']).optional(),
      projectKey: z.string().nullable().optional(),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(20000),
      tags: z.array(z.string()).max(20).optional(),
      importance: z.number().min(0).max(1).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'invalid_memory', issues: body.error.issues });
  const row = await insertMemory(db, {
    kind: body.data.kind,
    scope: body.data.scope,
    projectKey: body.data.projectKey ?? null,
    title: body.data.title,
    body: body.data.body,
    tags: body.data.tags,
    importance: body.data.importance,
  });
  await db`INSERT INTO audit_log (action, actor, payload)
           VALUES ('memory.written', 'api', ${db.json({ id: row.id, kind: row.kind } as never)})`;
  return reply.code(201).send({ memory: row });
});

/* -------------------------------------------------------------------- agents */

app.get('/v1/agents', async () => {
  const agents = await db`SELECT id, display_name, role, description, permission_mode, enabled, max_concurrency
                            FROM agents ORDER BY id`;
  return { agents };
});

/* ----------------------------------------------------------------- approvals */

app.get('/v1/approvals', async () => {
  const approvals = await db`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100`;
  return { approvals };
});

app.post('/v1/approvals/:id/decide', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const parsed = DecideApprovalInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_decision', issues: parsed.error.issues });
  const status = parsed.data.decision === 'approve' ? 'approved' : 'rejected';
  const rows = await db`
    UPDATE approvals SET status = ${status}, decided_by = ${parsed.data.decidedBy},
                         decision_note = ${parsed.data.note ?? null}, decided_at = now()
     WHERE id = ${id} AND status = 'pending'
    RETURNING *`;
  if (rows.length === 0) return reply.code(409).send({ error: 'not_pending_or_missing' });
  await db`INSERT INTO audit_log (action, actor, payload)
           VALUES ('approval.decided', ${parsed.data.decidedBy}, ${db.json({ id, status } as never)})`;
  return { approval: rows[0] };
});

/* --------------------------------------------------------------------- usage */

app.get('/v1/usage', async () => ({ usage: await usageSummary(db) }));

/* -------------------------------------------------------------------- helpers */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Short title from the user's own words. No model call, no invention. */
function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 90 ? oneLine : `${oneLine.slice(0, 87)}…`;
}

/** Route to a specialist when the intent is unambiguous, else generalist. */
function defaultAgentFor(text: string): string {
  const t = text.toLowerCase();
  if (/\b(review|critique|audit my|second opinion)\b/.test(t)) return 'review';
  if (/\b(research|investigate|compare|find out|look up|what have we learned)\b/.test(t)) return 'research';
  if (/\b(fix|implement|refactor|build|debug|test|patch|commit|deploy)\b/.test(t)) return 'engineering';
  return 'generalist';
}

/**
 * The instruction handed to DSH. Kept small and explicit: the workspace is
 * named, the exit criteria are stated, and the agent is told not to claim
 * success it cannot show.
 */
function buildPrompt(intent: string, workspace: string, projectPath: string | null | undefined): string {
  const lines = [
    `TASK: ${intent}`,
    '',
    `WORKING DIRECTORY: ${workspace}`,
  ];
  if (projectPath) lines.push(`PROJECT UNDER WORK: ${projectPath}`);
  lines.push(
    '',
    'RULES:',
    '- Do the work, do not merely describe a plan, unless the task is explicitly a plan request.',
    '- Run the commands you rely on. Never report a test as passing unless you ran it and saw it pass.',
    '- If you cannot complete the task, say exactly what blocked you and what you tried.',
    '- Keep the final answer under 400 words: what you did, how it was verified, and anything left undone.',
  );
  return lines.join('\n');
}

/* --------------------------------------------------------------------- boot */

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.end({ timeout: 5 });
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
app.log.info({ port: PORT, host: HOST, profile: DSH_PROFILE }, 'operant api listening');