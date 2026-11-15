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
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  CreateRequestInput,
  DecideApprovalInput,
  MemorySearchInput,
  TERMINAL_JOB_STATUSES,
  assessIntent,
  nextRunAt,
  TaskListWire,
  TaskDetailWire,
} from '@operant/core';
import {
  cancelTask,
  createDb,
  createTaskAwaitingApproval,
  createSchedule,
  createTaskWithJob,
  decideApproval,
  deleteSchedule,
  getJob,
  getJobEvents,
  getJobsForTask,
  getTask,
  insertMemory,
  getArtifact,
  listArtifacts,
  listSchedules,
  listTasks,
  recordHealth,
  recordUsage,
  searchMemories,
  usageSummary,
} from '@operant/db';
import {
  learningSummary,
  learningTick,
  promoteImprovement,
  rollbackImprovement,
} from '@operant/learning';

const PORT = Number(process.env['OPERANT_API_PORT'] ?? 8787);
const HOST = process.env['OPERANT_API_HOST'] ?? '127.0.0.1';
const TOKEN = process.env['OPERANT_BOT_TOKEN'] ?? '';
const DB_URL = process.env['DATABASE_URL'] ?? '';
const WORKSPACE_ROOT = process.env['OPERANT_WORKSPACE_ROOT'] ?? join(process.cwd(), 'data', 'jobs');
const DSH_PROFILE = process.env['OPERANT_DSH_PROFILE'] ?? 'operant';

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

/**
 * Tolerate an empty body on POSTs that declare JSON.
 *
 * Fastify's default JSON parser rejects `content-type: application/json` with a
 * zero-length body (FST_ERR_CTP_EMPTY_JSON_BODY). Endpoints like
 * `POST /v1/tasks/:id/cancel` take no body, so a client that sets the header
 * anyway — which a naive proxy will do — got a 400 and the control appeared
 * broken. An empty body means "no arguments", not "malformed request".
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length === 0) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    done(err as Error, undefined);
  }
});

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

/**
 * Auth-failure throttle.
 *
 * The independent review found no rate limiting at all: 120 wrong-token requests
 * produced 120×401 and zero 429. A bearer-only surface with unlimited attempts is
 * an offline-bruteforce invitation.
 *
 * In-memory and per-process on purpose: this is a single-instance control plane,
 * and a shared store would add a dependency just to protect one hook. The window
 * is short because the goal is to stop scripted guessing, not to punish one
 * mistyped token.
 */
const AUTH_WINDOW_MS = 5 * 60_000;
const AUTH_MAX_FAILURES = 20;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function authThrottle(ip: string): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) return { blocked: false, retryAfterSec: 0 };
  if (entry.count < AUTH_MAX_FAILURES) return { blocked: false, retryAfterSec: 0 };
  return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}

function noteAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count += 1;
  }
  // Bound the map so a flood of distinct IPs cannot grow memory without limit.
  if (authFailures.size > 5000) {
    for (const [key, value] of authFailures) {
      if (value.resetAt <= now) authFailures.delete(key);
    }
  }
}

app.addHook('onRequest', async (req, reply) => {
  // Health is unauthenticated on purpose so a supervisor can probe liveness
  // without holding a credential. It exposes no work product.
  if (req.url === '/v1/health' || req.url.startsWith('/v1/health?')) return;

  // Check the credential FIRST. Throttling before authentication would let an
  // attacker lock the operator out of their own control plane for the whole
  // window, which is a worse failure than the brute-force it prevents.
  if (authorized(req.headers.authorization)) return;

  const gate = authThrottle(req.ip);
  if (gate.blocked) {
    req.log.warn({ url: req.url, ip: req.ip }, 'auth failures exceeded; throttling');
    reply.header('retry-after', String(gate.retryAfterSec));
    return reply.code(429).send({ error: 'too_many_auth_failures', retryAfterSec: gate.retryAfterSec });
  }

  noteAuthFailure(req.ip);
  req.log.warn({ url: req.url, ip: req.ip }, 'unauthorized request');
  return reply.code(401).send({ error: 'unauthorized' });
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

  // Conversation continuity: an external reference (Discord channel/thread id)
  // is upserted so follow-up messages attach to the same conversation without
  // the caller having to know our internal ids.
  let conversationUuid: string | null = null;
  if (input.conversationId) {
    const [conv] = await db<{ id: string }[]>`
      INSERT INTO conversations (external_ref, channel)
      VALUES (${input.conversationId}, ${input.origin})
      ON CONFLICT (external_ref) DO UPDATE SET updated_at = now()
      RETURNING id`;
    conversationUuid = conv?.id ?? null;
  }

  const prompt = buildPrompt(input.text, workspacePath, input.projectPath);
  const jobSpec = {
    agentId,
    title: titleFrom(input.text),
    prompt,
    workspacePath,
    permissionMode: 'workspace-write',
    dshProfile: DSH_PROFILE,
  };

  // Consequential-action gate. If the intent touches money, credentials,
  // destructive operations or external messaging, NOTHING is enqueued: the task
  // is created in `waiting_approval` and a job row only comes into existence
  // once a human approves it. A queued-but-gated job would be claimable by a
  // worker and the gate would be decorative.
  const risk = assessIntent(input.text);
  if (risk.required) {
    const { task, approvalId } = await createTaskAwaitingApproval(
      db,
      {
        intent: input.text,
        title: titleFrom(input.text),
        requestedBy: input.requestedBy,
        origin: input.origin,
        projectPath: input.projectPath ?? null,
        requireVerification: input.requireVerification ?? false,
        conversationId: conversationUuid,
      },
      jobSpec,
      { summary: risk.summary, actionKind: risk.kind, risk: risk.risk, reasons: risk.reasons },
    );
    req.log.info({ taskId: task.id, approvalId, risk: risk.risk, kind: risk.kind }, 'request held for approval');
    return reply.code(202).send({
      taskId: task.id,
      jobId: null,
      agentId,
      status: task.status,
      approvalRequired: true,
      approvalId,
      risk: risk.risk,
      reasons: risk.reasons,
      summary: risk.summary,
    });
  }

  const { task, job } = await createTaskWithJob(
    db,
    {
      intent: input.text,
      title: titleFrom(input.text),
      requestedBy: input.requestedBy,
      origin: input.origin,
      projectPath: input.projectPath ?? null,
      requireVerification: input.requireVerification ?? false,
      conversationId: conversationUuid,
    },
    { kind: 'execute', ...jobSpec },
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
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      status: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .parse(req.query);

  const tasks = q.conversationId
    ? // Resolve the caller's external reference, never expose our internal ids as
      // the identity a client must remember.
      await db`
        SELECT t.* FROM tasks t
          JOIN conversations c ON c.id = t.conversation_id
         WHERE c.external_ref = ${q.conversationId}
         ORDER BY t.created_at DESC LIMIT ${q.limit}`
    : await listTasks(db, q.limit, q.status);

  // Validate what we are about to send. Nothing did this before, which is how the
  // declared types drifted away from the wire format unnoticed.
  const parsed = TaskListWire.safeParse({ tasks });
  if (!parsed.success) {
    req.log.error({ issues: parsed.error.issues.slice(0, 5) }, 'task list violates the wire contract');
    throw Object.assign(new Error('response_contract_violation'), { statusCode: 500 });
  }
  return parsed.data;
});

app.get('/v1/tasks/:id', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const task = await getTask(db, id);
  if (!task) return reply.code(404).send({ error: 'not_found' });
  const jobs = await getJobsForTask(db, id);

  const parsed = TaskDetailWire.safeParse({ task, jobs });
  if (!parsed.success) {
    req.log.error({ issues: parsed.error.issues.slice(0, 5) }, 'task detail violates the wire contract');
    throw Object.assign(new Error('response_contract_violation'), { statusCode: 500 });
  }
  return parsed.data;
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

  // One transaction: the approval can never be marked approved without the job
  // existing, and the job can never appear without the approval.
  const result = await decideApproval(
    db,
    id,
    parsed.data.decision,
    parsed.data.decidedBy,
    parsed.data.note,
  );
  if (!result.ok) return reply.code(409).send({ error: 'not_pending_or_missing', detail: result.reason });
  return {
    decided: true,
    decision: parsed.data.decision,
    taskId: result.taskId,
    jobId: result.jobId,
    status: result.status,
    ...(result.jobId ? { streamUrl: `/v1/jobs/${result.jobId}/stream` } : {}),
  };
});

/* --------------------------------------------------------------------- usage */

app.get('/v1/usage', async () => ({ usage: await usageSummary(db) }));

/* --------------------------------------------------------------- voice (proxy)
 *
 * Speech is proxied through the control plane rather than called from the bot
 * or the browser directly. Two reasons: the service listens on the VM's
 * loopback only, and keeping the only client server-side means the speech
 * endpoint never needs to be reachable from a client device.
 *
 * Failures are passed through verbatim. A licence error from VoiceStudio is
 * actionable information ("accept this licence") and must not be flattened into
 * a generic 500.
 */
const VOICE_BASE = process.env['VOICESTUDIO_BASE_URL'] ?? 'http://127.0.0.1:3900';

app.get('/v1/voice/health', async (_req, reply) => {
  try {
    const r = await fetch(`${VOICE_BASE}/health`, { signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    return reply.code(r.ok ? 200 : 502).send({ state: r.ok ? 'healthy' : 'degraded', detail: body });
  } catch (err) {
    return reply.code(503).send({ state: 'unreachable', detail: String(err) });
  }
});

app.get('/v1/voice/voices', async (_req, reply) => {
  try {
    const r = await fetch(`${VOICE_BASE}/v1/audio/voices`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return reply.code(502).send({ error: 'voice_service_error', status: r.status, detail: await r.text() });
    return r.json();
  } catch (err) {
    return reply.code(503).send({ error: 'voice_service_unreachable', detail: String(err) });
  }
});

app.post('/v1/voice/transcribe', async (req, reply) => {
  // Accept BOTH `audioBase64` (what the documented contract and the bot use)
  // and `ref` (the shared TranscribeInput field). Accepting both removes a
  // real skew that already caused one client to send two keys defensively.
  const Body = z.object({
    audioBase64: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    language: z.string().optional(),
    profile: z.enum(['fast', 'accurate']).optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_transcribe_input', issues: parsed.error.issues });
  const payload = parsed.data.audioBase64 ?? parsed.data.ref;
  if (!payload) return reply.code(400).send({ error: 'missing_audio', detail: 'send audioBase64 (or ref) as a base64 string' });

  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return reply.code(400).send({ error: 'empty_audio' });
  if (bytes.length > 25 * 1024 * 1024) {
    return reply.code(413).send({ error: 'audio_too_large', bytes: bytes.length, limit: 25 * 1024 * 1024 });
  }

  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'input.wav');
    const r = await fetch(`${VOICE_BASE}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      ...(parsed.data.language ? { headers: { 'x-language': parsed.data.language } } : {}),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await r.text();
    if (!r.ok) {
      req.log.warn({ status: r.status }, 'voice transcription failed');
      return reply.code(502).send({ error: 'transcription_failed', status: r.status, detail: raw.slice(0, 1200) });
    }
    let upstream: Record<string, unknown>;
    try {
      upstream = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return reply.code(502).send({ error: 'unparseable_transcription', detail: raw.slice(0, 600) });
    }
    const elapsed = (Date.now() - t0) / 1000;
    const duration = Number(upstream['duration'] ?? upstream['duration_s'] ?? 0);
    await recordUsage(db, {
      kind: 'speech',
      provider: 'voicestudio',
      model: String(upstream['engine'] ?? 'faster-whisper'),
      units: duration,
    }).catch(() => {});
    return {
      text: String(upstream['text'] ?? ''),
      language: (upstream['language'] as string | undefined) ?? null,
      durationSec: duration,
      model: String(upstream['engine'] ?? 'faster-whisper'),
      // Real-time factor computed from the measured wall clock, not claimed.
      rtf: duration > 0 ? Number((elapsed / duration).toFixed(3)) : null,
    };
  } catch (err) {
    return reply.code(503).send({ error: 'voice_service_unreachable', detail: String(err) });
  }
});

/* ------------------------------------------------------------------ artifacts */

app.get('/v1/tasks/:id/artifacts', async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  return { artifacts: await listArtifacts(db, id) };
});

app.get('/v1/artifacts/:id/download', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const artifact = await getArtifact(db, id);
  if (!artifact) return reply.code(404).send({ error: 'not_found' });

  // Confinement: serve only paths inside the configured workspace root, even
  // though the path came from our own database. A stored path is data, not trust.
  const root = resolve(process.env['OPERANT_WORKSPACE_ROOT'] ?? './data/jobs');
  const resolved = resolve(artifact.path);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    req.log.warn({ artifactId: id, path: artifact.path }, 'artifact path escapes the workspace root');
    return reply.code(403).send({ error: 'outside_workspace' });
  }

  const bytes = await readFile(resolved).catch(() => null);
  if (!bytes) return reply.code(404).send({ error: 'file_missing' });

  const safeName = artifact.filename.replace(/["\\\r\n]/g, '');
  return reply
    .header('content-type', artifact.mime_type)
    .header('content-disposition', `attachment; filename="${safeName}"`)
    .header('x-content-sha256', artifact.sha256)
    .send(bytes);
});

/* ------------------------------------------------------------------ schedules */

app.get('/v1/schedules', async () => ({ schedules: await listSchedules(db) }));

app.post('/v1/schedules', async (req, reply) => {
  const parsed = z
    .object({
      title: z.string().min(1).max(120),
      // A documented subset of RFC 5545; unsupported rules are rejected rather
      // than silently mis-scheduled.
      rrule: z.string().min(3).max(200),
      timezone: z.string().min(3).max(64).default('Asia/Calcutta'),
      prompt: z.string().min(1).max(4000),
      agentSlug: z.string().min(2).max(32).default('generalist'),
    })
    .safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_schedule', issues: parsed.error.issues });

  let nextRun: Date;
  try {
    nextRun = nextRunAt(parsed.data.rrule, parsed.data.timezone, new Date());
  } catch (err) {
    return reply.code(400).send({ error: 'invalid_rrule', detail: String(err) });
  }

  const row = await createSchedule(db, { ...parsed.data, nextRunAt: nextRun });
  req.log.info({ scheduleId: row.id, nextRunAt: nextRun.toISOString() }, 'schedule created');
  return reply.code(201).send({ schedule: row });
});

app.delete('/v1/schedules/:id', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const removed = await deleteSchedule(db, id);
  return removed ? { deleted: true } : reply.code(404).send({ error: 'not_found' });
});

/* ------------------------------------------------------------------ learning */

app.get('/v1/learning/summary', async () => ({ summary: await learningSummary(db) }));

app.get('/v1/learning/incidents', async () => {
  const incidents = await db`SELECT * FROM incidents ORDER BY last_seen_at DESC LIMIT 100`;
  return { incidents };
});

app.get('/v1/learning/improvements', async () => {
  const improvements = await db`SELECT * FROM improvements ORDER BY created_at DESC LIMIT 100`;
  return { improvements };
});

/** Run one pass of the loop now (the scheduler will call the same function). */
app.post('/v1/learning/tick', async (req) => {
  const result = await learningTick(db);
  req.log.info(result, 'learning tick');
  return result;
});

app.post('/v1/learning/improvements/:id/promote', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { reviewer } = z.object({ reviewer: z.string().min(1).default('api') }).parse(req.body ?? {});
  const result = await promoteImprovement(db, id, reviewer);
  return result.ok ? { promoted: true } : reply.code(409).send(result);
});

app.post('/v1/learning/improvements/:id/rollback', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { actor } = z.object({ actor: z.string().min(1).default('api') }).parse(req.body ?? {});
  const result = await rollbackImprovement(db, id, actor);
  return result.ok ? { rolledBack: true } : reply.code(409).send(result);
});

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




