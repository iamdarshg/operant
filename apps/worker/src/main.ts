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
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { runDshJob, type NormalizedEvent } from '@operant/dsh-adapter';
import { assessToolCall, nextRunAt, describeRule } from '@operant/core';
import {
  appendJobEvents,
  claimNextJob,
  createApprovalForBlockedJob,
  createDb,
  createTaskWithJob,
  dueSchedules,
  finalizeJob,
  getTask,
  insertMemory,
  markJobDispatched,
  markScheduleRan,
  recordArtifacts,
  recordUsage,
  renewLease,
  type JobRow,
} from '@operant/db';
import { recordIncident } from '@operant/learning';

const DB_URL = process.env['DATABASE_URL'] ?? '';
const CONCURRENCY = Math.min(Number(process.env['WORKER_CONCURRENCY'] ?? 2), 4);
const DSH_PROFILE = process.env['OPERANT_DSH_PROFILE'] ?? 'operant';
const WORKSPACE_ROOT = process.env['OPERANT_WORKSPACE_ROOT'] ?? './data/jobs';
// Renew well inside the 180 s lease so a rebooted worker's job is reclaimable
// within ~3 minutes instead of stalling on a long lease.
const RENEW_MS = 45_000;
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
async function promptFor(job: JobRow): Promise<{ prompt: string; permissionMode: string; allowedTools: string[] }> {
  const [agent] = (await db`
    SELECT system_overlay, permission_mode, allowed_tools FROM agents WHERE id = ${job.agent_id}`) as {
    system_overlay: string;
    permission_mode: string;
    allowed_tools: string[] | null;
  }[];
  const overlay = agent?.system_overlay?.trim();
  const prompt = overlay ? `${overlay}\n\n---\n\n${job.prompt}` : job.prompt;
  return {
    prompt,
    permissionMode: agent?.permission_mode ?? job.permission_mode,
    allowedTools: (agent?.allowed_tools ?? []).map((t) => t.toLowerCase()),
  };
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
  const { prompt, permissionMode, allowedTools: agentTools } = await promptFor(job);

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
      // Tool-call boundary. This is the enforcement layer that does not depend
      // on how the request was phrased: if the agent is about to run something
      // consequential, it stops here and a human decides.
      guardToolCall: (tool, toolArgs) => {
        // Per-agent tool authorization. An empty list means "unspecified", not
        // "nothing allowed" — failing closed there would silently break every
        // agent that predates this column.
        const permitted = agentTools.length === 0 || agentTools.includes(tool.toLowerCase());
        if (!permitted && PRIVILEGED_TOOLS.has(tool.toLowerCase())) {
          return { block: true, reason: `${NOT_PERMITTED}: agent '${job.agent_id}' may not use ${tool}` };
        }
        // A human may have approved ONE exact command for this job. Permitting
        // only an exact match (not a substring) keeps the approval narrow: it
        // cannot be widened into "run anything that contains this string".
        const approved = Array.isArray(job.approved_commands) ? (job.approved_commands as unknown[]) : [];
        const candidate = (toolArgs as { command?: unknown } | null)?.command;
        if (approved.length > 0 && typeof candidate === 'string' && approved.includes(candidate)) {
          return { block: false };
        }
        const verdict = assessToolCall(tool, toolArgs);
        return verdict.block ? { block: true, reason: verdict.reason } : { block: false };
      },
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

  // The tool-call guard stopped the run. Do not retry — retrying would hit the
  // same rule. Escalate: the task waits for a human, and approving it launches a
  // fresh job that is explicitly permitted to run the approved command.
  if (result.blockedByPolicy) {
    // A permission violation is not a decision for a human to overrule: the agent
    // simply is not allowed to use that tool. Offering an "approve" here would let
    // the approval path grant what the agent configuration explicitly withholds.
    if (result.blockedByPolicy.reason.startsWith(NOT_PERMITTED)) {
      await finalizeJob(db, job.id, {
        status: 'failed',
        error: result.blockedByPolicy.reason,
        usage,
        sessionId: result.sessionId,
      });
      log('tool not permitted for agent; job failed', {
        jobId: job.id,
        agent: job.agent_id,
        tool: result.blockedByPolicy.tool,
      });
      return;
    }

    const verdict = assessToolCall(result.blockedByPolicy.tool, result.blockedByPolicy.args);
    const approvedPrompt = [
      `The operator approved this exact command for this task: ${JSON.stringify(result.blockedByPolicy.args).slice(0, 800)}`,
      `(It was blocked by policy: ${result.blockedByPolicy.reason}.)`,
      '',
      prompt,
    ].join('\n');
    const { approvalId } = await createApprovalForBlockedJob(db, {
      taskId: job.task_id,
      jobId: job.id,
      tool: result.blockedByPolicy.tool,
      toolArgs: result.blockedByPolicy.args,
      reason: result.blockedByPolicy.reason,
      risk: verdict.risk,
      kind: verdict.kind,
      spec: {
        agentId: job.agent_id,
        title: job.title,
        prompt: approvedPrompt,
        workspacePath: job.workspace_path,
        permissionMode,
        dshProfile: job.dsh_profile,
      },
    });
    log('tool call blocked; awaiting approval', {
      jobId: job.id,
      tool: result.blockedByPolicy.tool,
      approvalId,
    });
    return;
  }

  if (result.ok) {
    await finalizeJob(db, job.id, {
      status: 'succeeded',
      result: result.finalText,
      usage,
      sessionId: result.sessionId,
    });

    // Record what the job actually produced, so a deliverable can be found later
    // instead of being buried in a workspace nobody knows the path to.
    const produced = await collectArtifacts(job.workspace_path).catch(() => []);
    if (produced.length > 0) {
      const recorded = await recordArtifacts(db, job.task_id, job.id, produced).catch(() => 0);
      log('artifacts recorded', { jobId: job.id, found: produced.length, inserted: recorded });
    }

    // `requireVerification` used to be stored and never read — a checkbox that
    // lied. When the operator asked for independent verification, enqueue a
    // review job now and record it as the verifier of this job.
    if (task.require_verification && job.kind === 'execute') {
      const [existing] = (await db`
        SELECT id FROM jobs WHERE task_id = ${task.id} AND kind IN ('review','verify') LIMIT 1`) as { id: string }[];
      if (!existing) {
        const verifyPrompt = [
          'You are the independent verifier. Another agent produced the result below; you did not write it.',
          '',
          `ORIGINAL REQUEST: ${task.intent}`,
          '',
          'RESULT CLAIMED:',
          (result.finalText ?? '(no result text)').slice(0, 3000),
          '',
          `WORKING DIRECTORY: ${job.workspace_path}`,
          '',
          'RULES:',
          '- Check the claim against reality; run the commands you rely on.',
          '- Report VERIFIED or NOT VERIFIED with the specific evidence (command output, file:line).',
          '- If the claim cannot be checked, say so instead of approving it.',
          '- Keep it under 200 words.',
        ].join('\n');
        const [verifier] = (await db`
          INSERT INTO jobs (task_id, kind, agent_id, parent_job_id, title, prompt, workspace_path,
                            permission_mode, max_attempts, dsh_profile)
          VALUES (${task.id}, 'review', 'review', ${job.id}, ${`Verify: ${task.title}`.slice(0, 200)},
                  ${verifyPrompt}, ${job.workspace_path}, 'read-only', 1, ${job.dsh_profile})
          RETURNING id`) as { id: string }[];
        if (verifier) {
          await db`UPDATE jobs SET verified_by_job_ids = array_append(verified_by_job_ids, ${verifier.id}::uuid),
                                   updated_at = now()
                    WHERE id = ${job.id}`;
          // The task is not done while its independent reviewer is still running.
          // finalizeJob() above marked it `succeeded` because, at that instant,
          // the verifier did not exist yet.
          await db`UPDATE tasks SET status = 'reviewing', updated_at = now()
                    WHERE id = ${task.id} AND status = 'succeeded'`;
          log('verification job queued', { jobId: job.id, verifierJobId: verifier.id });
        }
      }
    }
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

/**
 * Fire due schedules.
 *
 * The `schedules` table existed since the first migration and nothing ever read
 * it — a documented capability that did not exist. Each tick claims an occurrence
 * atomically (`markScheduleRan` is guarded on the exact `next_run_at` it read), so
 * two workers polling at the same moment cannot double-fire.
 */
async function schedulerTick(): Promise<void> {
  const due = await dueSchedules(db);
  for (const s of due) {
    const firedAt = s.next_run_at;
    if (!firedAt) continue;

    let next: Date | null = null;
    try {
      next = nextRunAt(s.rrule, s.timezone, firedAt);
    } catch (err) {
      // An unsupported rule disables itself rather than retrying forever.
      log('schedule rule unsupported; disabling', { scheduleId: s.id, rule: s.rrule, error: String(err).slice(0, 200) });
      await markScheduleRan(db, s.id, null).catch(() => {});
      continue;
    }

    const claimed = await markScheduleRan(db, s.id, next);
    if (!claimed) continue; // another worker took this occurrence

    try {
      const taskId = randomUUID();
      const workspacePath = join(WORKSPACE_ROOT, taskId);
      await mkdir(workspacePath, { recursive: true });
      const { task } = await createTaskWithJob(
        db,
        { intent: s.prompt, title: s.title, requestedBy: 'schedule', origin: 'schedule' },
        {
          kind: 'execute',
          agentId: s.agent_slug,
          title: s.title,
          prompt: `SCHEDULED TASK (${describeRule(s.rrule)})\n\n${s.prompt}\n\nWORKING DIRECTORY: ${workspacePath}`,
          workspacePath,
          permissionMode: 'workspace-write',
        },
      );
      log('schedule fired', { scheduleId: s.id, taskId: task.id, nextRunAt: next?.toISOString() ?? null });
    } catch (err) {
      log('schedule could not enqueue a task', { scheduleId: s.id, error: String(err).slice(0, 300) });
    }
  }
}

/**
 * Collect the files a job left behind.
 *
 * Walks the job's own workspace only (the one path the worker created), skips
 * dependency/vendor directories and anything large enough to be a build artifact
 * rather than a deliverable. The sha256 is what makes the record verifiable: a
 * reported artifact can be checked against the bytes on disk.
 */
async function collectArtifacts(workspacePath: string): Promise<
  { path: string; filename: string; mimeType: string; bytes: number; sha256: string }[]
> {
  const out: { path: string; filename: string; mimeType: string; bytes: number; sha256: string }[] = [];
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '__pycache__', '.venv']);
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_FILES = 50;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        if (info.size === 0 || info.size > MAX_BYTES) continue;
        const bytes = await readFile(full);
        out.push({
          path: full,
          filename: entry.name,
          mimeType: mimeFor(entry.name),
          bytes: info.size,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } catch {
        // A file that vanished mid-scan is not an error worth failing the job for.
      }
    }
  };

  await walk(workspacePath, 0);
  return out;
}

/** Minimal, honest extension→type map; unknown types are application/octet-stream. */
function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
    html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', pdf: 'application/pdf',
    zip: 'application/zip', wav: 'audio/wav', mp3: 'audio/mpeg', log: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Tools that can change the machine or the workspace.
 *
 * `allowed_tools` was stored per agent and enforced by nothing — the security
 * review called it documentation, correctly. Only these tools are gated: gating
 * observational tools (read, glob, grep, the web tools, job inspection) would
 * break agents for no safety gain, and a permission list that blocks reading is
 * theatre.
 */
const PRIVILEGED_TOOLS = new Set(['bash', 'pwsh', 'shell', 'write', 'edit', 'multiedit', 'apply_patch']);

/** Reason prefix used to distinguish "not permitted" from "dangerous". */
const NOT_PERMITTED = 'tool-not-permitted';

async function loop(slot: number): Promise<void> {
  active += 1;
  // A worker must OUTLIVE a briefly unavailable database. Previously a failed
  // claim threw out of the loop, exited the process, and systemd's start-rate
  // limit then marked the unit permanently failed — observed for real on the
  // first reboot test. Back off instead.
  let backoffMs = 1000;
  try {
    while (!shuttingDown) {
      let job: JobRow | null = null;
      try {
        job = await claimNextJob(db, `${workerId}#${slot}`);
        backoffMs = 1000;
      } catch (err) {
        log('claim failed; backing off', { slot, error: String(err).slice(0, 300), backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
        continue;
      }
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

// Scheduler: one tick at boot, then every minute. Idempotent, so a restart or a
// second worker cannot fire the same occurrence twice.
void schedulerTick().catch((err) => log('scheduler tick failed', { error: String(err).slice(0, 300) }));
setInterval(() => {
  void schedulerTick().catch((err) => log('scheduler tick failed', { error: String(err).slice(0, 300) }));
}, 60_000);


