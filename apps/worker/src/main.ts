/**
 * Operant job worker.
 *
 * Pulls one job at a time from the durable queue, runs it through DSH, streams
 * its events into Postgres, and finalizes it. Designed so that killing this
 * process at any moment is safe:
 *
 *   - the job was claimed with a lease, so a crash leaves a reclaimable row
 *     rather than a permanently "running" ghost
 *   - events are appended with per-job sequence numbers, so a resumed run
 *     continues the trail instead of restarting it
 *   - the DSH session id is persisted, so a retry can resume the same session
 *
 * Concurrency is capped by WORKER_CONCURRENCY (default 2). The VM has 8 vCPU and
 * 32 GiB, but agent runs are I/O-bound on the model API, so a small cap keeps
 * CPU for the speech service and builds.
 */
import { hostname } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runDshJob, type NormalizedEvent } from '@operant/dsh-adapter';
import {
  appendJobEvents,
  claimNextJob,
  createDb,
  finalizeJob,
  getTask,
  insertMemory,
  markJobDispatched,
  recordUsage,
  renewLease,
  type JobRow,
} from '@operant/db';
import { recordIncident } from '@operant/learning';

const DB_URL = process.env['DATABASE_URL'] ?? '';
const CONCURRENCY = Math.min(Number(process.env['WORKER_CONCURRENCY'] ?? 2), 4);
const DSH_PROFILE = process.env['OPERANT_DSH_PROFILE'] ?? 'operant';
const RENEW_MS = 60_000;
const JOB_TIMEOUT_MS = Number(process.env['JOB_TIMEOUT_MS'] ?? 20 * 60_000);

if (!DB_URL) {
  console.error('FATAL: DATABASE_URL is unset.');
  process.exit(1);
}

const db = createDb(DB_URL, CONCURRENCY + 2);
const workerId = `${hostname()}-${process.pid}`;

let shuttingDown = false;
let active = 0;

function log(msg: string, extra?: Record<string, unknown>): void {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] [${workerId}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
}

/** Flush buffered events in batches so a chatty run does not cost one round-trip per token. */
class EventBuffer {
  private pending: { seq: number; type: string; payload: unknown }[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly jobId: string,
    private readonly onFlushed?: (count: number) => void,
  ) {}

  push(event: NormalizedEvent): void {
    this.pending.push({ seq: event.seq, type: event.type, payload: event.payload });
    if (this.pending.length >= 25) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      await appendJobEvents(db, this.jobId, batch);
      this.onFlushed?.(batch.length);
    } catch (err) {
      // Losing an event row must not kill the run; put them back for the next flush.
      log('event flush failed, re-queueing', { error: String(err), count: batch.length });
      this.pending = [...batch, ...this.pending];
    }
  }
}

/** Build the prompt actually handed to the agent, including its role overlay. */
async function promptFor(job: JobRow): Promise<{ prompt: string; permissionMode: string }> {
  const [agent] = (await db`
    SELECT system_overlay, permission_mode FROM agents WHERE id = ${job.agent_id}`) as {
    system_overlay: string;
    permission_mode: string;
  }[];
  const overlay = agent?.system_overlay?.trim();
  const prompt = overlay ? `${overlay}\n\n---\n\n${job.prompt}` : job.prompt;
  return { prompt, permissionMode: agent?.permission_mode ?? job.permission_mode };
}

async function executeJob(job: JobRow): Promise<void> {
  const task = await getTask(db, job.task_id);
  if (!task) {
    await finalizeJob(db, job.id, { status: 'failed', error: 'task disappeared before execution' });
    return;
  }
  if (task.status === 'cancelled') {
    await finalizeJob(db, job.id, { status: 'cancelled', error: 'task was cancelled before the job started' });
    return;
  }

  await mkdir(job.workspace_path, { recursive: true });

  const buffer = new EventBuffer(job.id);
  const { prompt, permissionMode } = await promptFor(job);

  log('job start', { jobId: job.id, kind: job.kind, agent: job.agent_id, attempt: job.attempt });

  const renew = setInterval(() => {
    void renewLease(db, job.id, workerId).catch(() => {});
  }, RENEW_MS);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  let result;
  try {
    result = await runDshJob({
      profile: job.dsh_profile || DSH_PROFILE,
      prompt,
      cwd: job.workspace_path,
      permissionMode,
      sessionId: job.attempt > 1 ? (job.dsh_session_id ?? undefined) : undefined,
      timeoutMs: JOB_TIMEOUT_MS,
      signal: controller.signal,
      onEvent: (event) => buffer.push(event),
    });
  } finally {
    clearInterval(renew);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    await buffer.flush();
  }

  if (result.sessionId && result.sessionId !== job.dsh_session_id) {
    await markJobDispatched(db, job.id, result.sessionId);
  }

  if (result.usage) {
    await recordUsage(db, {
      jobId: job.id,
      taskId: job.task_id,
      kind: 'llm',
      provider: 'surplus',
      model: 'deepseek-v4.1-flash-1017',
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    }).catch(() => {});
  }

  const usage = {
    ...(result.usage ?? { promptTokens: 0, completionTokens: 0, toolCalls: 0 }),
    events: result.eventCount,
    ms: 0,
  };

  if (result.cancelled) {
    await finalizeJob(db, job.id, { status: 'cancelled', error: 'cancelled by operator', usage, sessionId: result.sessionId });
    log('job cancelled', { jobId: job.id });
    return;
  }

  if (result.ok) {
    await finalizeJob(db, job.id, {
      status: 'succeeded',
      result: result.finalText,
      usage,
      sessionId: result.sessionId,
    });
    // Episodic memory: what happened, in the user's terms. Written only on
    // success so a failed attempt cannot masquerade as a lesson.
    await insertMemory(db, {
      kind: 'episodic',
      projectKey: task.project_path ?? null,
      title: task.title.slice(0, 180),
      body: `Intent: ${task.intent}\n\nOutcome: ${(result.finalText ?? '').slice(0, 4000)}`,
      tags: [`agent:${job.agent_id}`, `job:${job.id}`],
      importance: 0.4,
      sourceTaskId: task.id,
      sourceJobId: job.id,
    }).catch(() => {});
    log('job succeeded', { jobId: job.id, chars: result.finalText?.length ?? 0 });
  } else {
    const reason = result.timedOut
      ? `timed out after ${JOB_TIMEOUT_MS}ms`
      : (result.reasonError ?? `turn ended with reason "${result.reasonKind}" (exit ${result.exitCode})`);

    // Retry with a limit, resuming the same DSH session when one exists.
    if (job.attempt < job.max_attempts) {
      await db`
        UPDATE jobs SET status = 'queued', attempt = attempt + 1, error = ${reason},
                        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = ${job.id}`;
      log('job failed, requeued', { jobId: job.id, attempt: job.attempt, max: job.max_attempts, reason });
    } else {
      await finalizeJob(db, job.id, {
        status: result.timedOut ? 'interrupted' : 'failed',
        error: reason,
        usage,
        sessionId: result.sessionId,
      });
      await insertMemory(db, {
        kind: 'failure',
        projectKey: task.project_path ?? null,
        title: `Failed: ${task.title.slice(0, 160)}`,
        body: `Intent: ${task.intent}\n\nFailure: ${reason}\n\nStderr tail:\n${result.stderr.slice(-1500)}`,
        tags: [`agent:${job.agent_id}`, `reason:${result.reasonKind}`],
        importance: 0.7,
        sourceTaskId: task.id,
        sourceJobId: job.id,
      }).catch(() => {});
      // Classify + fingerprint the failure so a repeat is detectable. A single
      // occurrence only records history; the learning tick decides whether a
      // repeat justifies a change.
      //
      // The symptom deliberately includes the runner's stderr: the terse
      // "turn ended with reason unknown" alone classifies as `unknown`, whereas
      // the stderr tail usually names the real cause (missing profile, missing
      // credential, reserved env var). Better classification means a repeat is
      // routed to the right remedy instead of a generic proposal.
      const symptom = [
        reason,
        result.stderr.trim().length > 0 ? `stderr: ${result.stderr.trim().slice(-1500)}` : '',
      ]
        .filter((s) => s.length > 0)
        .join('\n');
      await recordIncident(db, symptom, { taskId: task.id, jobId: job.id }).catch((err) => {
        log('incident record failed', { jobId: job.id, error: String(err) });
      });
      log('job failed permanently', { jobId: job.id, reason });
    }
  }
}

async function loop(slot: number): Promise<void> {
  active += 1;
  try {
    while (!shuttingDown) {
      const job = await claimNextJob(db, `${workerId}#${slot}`);
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      try {
        await executeJob(job);
      } catch (err) {
        log('worker error', { jobId: job.id, error: String(err) });
        await finalizeJob(db, job.id, { status: 'failed', error: `worker error: ${String(err)}` }).catch(() => {});
      }
    }
  } finally {
    active -= 1;
  }
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log('draining: no new jobs claimed', { active, sig });
    // Give in-flight runs a bounded window to finish; their leases expire anyway.
    setTimeout(() => {
      void db.end({ timeout: 3 }).finally(() => process.exit(0));
    }, 15_000);
  });
}

log('worker starting', { concurrency: CONCURRENCY, profile: DSH_PROFILE, workspace: join('.', 'data', 'jobs') });
for (let i = 0; i < CONCURRENCY; i += 1) void loop(i);