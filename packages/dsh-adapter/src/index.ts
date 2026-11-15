/**
 * DSH job adapter.
 *
 * Turns `dsh --profile <p> --json` into a cancellable, observable, resumable job.
 *
 * Contract facts this is built on (verified by live runs on 2026-11-15, not
 * inferred from documentation):
 *
 *   - The runner emits **newline-delimited JSON on stdout**. Observed types:
 *     `session`, `status` (phase: turn_start | step_start | step_end | turn_end),
 *     `thinking`, `text`, `tool_call`, `tool_result`, `final`, `error`.
 *   - `session` carries the `sessionId` used for `--session-id` resume.
 *   - `final.text` holds the answer; `final.reason.kind` is `completed`,
 *     `aborted`, `blocked`, `error`, `max-tokens` or `interrupted`.
 *   - Exit code 0 means "a turn completed", not "the task succeeded" — the
 *     reason kind decides that.
 *
 * Two deliberate choices:
 *
 *  1. **The prompt is written to stdin, never argv.** It means user intent can
 *     never be parsed as a flag, no shell quoting can corrupt it, and the
 *     command line stays a fixed, auditable string.
 *  2. **Unknown event types are preserved, not dropped.** A DSH upgrade that
 *     renames an event degrades observability instead of silently losing the
 *     trail.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { redact } from '@operant/core';

export type DshEventType =
  | 'session'
  | 'status'
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'final'
  | 'error'
  | 'unknown';

/** One normalized event, ready to persist as a `job_events` row. */
export interface NormalizedEvent {
  seq: number;
  type:
    | 'job.status'
    | 'job.text'
    | 'job.tool_call'
    | 'job.tool_result'
    | 'job.log'
    | 'job.usage';
  payload: Record<string, unknown>;
}

export interface RunOptions {
  /** DSH profile name. Restricted to a slug so it cannot inject shell syntax. */
  profile: string;
  /** The task text. Delivered on stdin. */
  prompt: string;
  /** Working directory for the agent. */
  cwd: string;
  permissionMode?: string | undefined;
  /** Resume an existing DSH session (restart recovery). */
  sessionId?: string | undefined;
  /** Hard wall-clock limit; the child is killed when it expires. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Receives every normalized event, in order, as it happens. */
  onEvent?: ((event: NormalizedEvent) => void) | undefined;
  /** Called on each parsed raw event, before normalization (for tests). */
  onRaw?: ((raw: Record<string, unknown>) => void) | undefined;
}

export interface RunResult {
  sessionId: string | null;
  /** The final assistant message, or null when the run produced none. */
  finalText: string | null;
  /** TurnEndReason.kind from the runner, or 'unknown' if it never arrived. */
  reasonKind: string;
  reasonError: string | null;
  exitCode: number | null;
  /** Whether the run is a success under our own policy, not just an exit code. */
  ok: boolean;
  usage: { promptTokens: number; completionTokens: number; toolCalls: number } | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  eventCount: number;
}

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Map one raw runner event onto a persisted event shape. */
export function normalize(raw: Record<string, unknown>, seq: number): NormalizedEvent | null {
  const type = typeof raw['type'] === 'string' ? raw['type'] : 'unknown';
  const num = (k: string): number | null => (typeof raw[k] === 'number' ? (raw[k] as number) : null);
  const str = (k: string): string | null => (typeof raw[k] === 'string' ? (raw[k] as string) : null);

  switch (type) {
    case 'session':
      return {
        seq,
        type: 'job.status',
        payload: { status: 'dispatched', sessionId: str('sessionId'), cwd: str('cwd') },
      };

    case 'status': {
      const phase = str('phase');
      if (phase === 'turn_start') {
        return { seq, type: 'job.status', payload: { status: 'running', phase } };
      }
      if (phase === 'step_start') {
        return { seq, type: 'job.log', payload: { level: 'debug', message: `step ${num('step') ?? '?'} started` } };
      }
      if (phase === 'step_end') {
        const u = raw['usage'] as Record<string, unknown> | undefined;
        if (u) {
          return {
            seq,
            type: 'job.usage',
            payload: {
              promptTokens: Number(u['inputTokens'] ?? 0),
              completionTokens: Number(u['outputTokens'] ?? 0),
              toolCalls: 0,
            },
          };
        }
        return { seq, type: 'job.log', payload: { level: 'debug', message: `step ${num('step') ?? '?'} ended` } };
      }
      if (phase === 'turn_end') {
        const reason = raw['reason'] as Record<string, unknown> | undefined;
        return {
          seq,
          type: 'job.status',
          payload: { status: 'turn_end', reasonKind: reason?.['kind'] ?? 'unknown' },
        };
      }
      return { seq, type: 'job.log', payload: { level: 'debug', message: `phase ${phase ?? 'unknown'}` } };
    }

    case 'text':
      return {
        seq,
        type: 'job.text',
        payload: { text: String(raw['text'] ?? ''), final: false },
      };

    case 'thinking':
      // Reasoning is recorded as a log line only: it is not the answer, and
      // persisting it verbatim would bloat the trail for no operator value.
      return {
        seq,
        type: 'job.log',
        payload: { level: 'debug', message: 'thinking', chars: String(raw['text'] ?? '').length },
      };

    case 'tool_call':
      return {
        seq,
        type: 'job.tool_call',
        payload: {
          tool: String(raw['tool'] ?? 'unknown'),
          args: (redact(raw['input']) ?? {}) as Record<string, unknown>,
          callId: str('callId'),
        },
      };

    case 'tool_result': {
      const status = str('status');
      const result = raw['result'] ?? raw['error'] ?? '';
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return {
        seq,
        type: 'job.tool_result',
        payload: {
          callId: str('callId'),
          ok: status !== 'error',
          status: status ?? 'unknown',
          preview: text.length > 900 ? `${text.slice(0, 900)}… [truncated ${text.length - 900}]` : text,
          durationMs: num('durationMs'),
        },
      };
    }

    case 'final':
      return {
        seq,
        type: 'job.text',
        payload: { text: String(raw['text'] ?? ''), final: true },
      };

    case 'error':
      return {
        seq,
        type: 'job.log',
        payload: { level: 'error', message: String(raw['message'] ?? 'unknown error') },
      };

    default:
      return {
        seq,
        type: 'job.log',
        payload: { level: 'info', message: `dsh:${type}`, raw: (redact(raw) ?? null) as Record<string, unknown> },
      };
  }
}

/**
 * Run one DSH job to completion.
 *
 * Resolves (never rejects) for ordinary outcomes; only a programming error such
 * as an invalid profile name throws, so a caller can always finalize the job.
 */
export async function runDshJob(options: RunOptions): Promise<RunResult> {
  const { profile, prompt, cwd, permissionMode, sessionId, timeoutMs, signal, onEvent, onRaw } = options;

  if (!PROFILE_RE.test(profile)) {
    throw new Error(`invalid dsh profile name: ${JSON.stringify(profile)}`);
  }

  const args = ['--profile', profile, '--json'];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (sessionId) args.push('--session-id', sessionId);

  const isWindows = process.platform === 'win32';
  const child: ChildProcessWithoutNullStreams = isWindows
    ? // .cmd shims are not directly executable on Windows; go through cmd.exe with
      // a FIXED argv (no user text is ever concatenated into this string).
      spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `dsh ${args.map(shellQuote).join(' ')}`], {
        cwd,
        env: safeEnv(),
        windowsHide: true,
      })
    : spawn('dsh', args, { cwd, env: safeEnv() });

  let seq = 0;
  let eventCount = 0;
  let session: string | null = null;
  let finalText: string | null = null;
  let reasonKind = 'unknown';
  let reasonError: string | null = null;
  let usage: RunResult['usage'] = null;
  let stderr = '';
  let timedOut = false;
  let cancelled = false;

  const emit = (e: NormalizedEvent | null): void => {
    if (!e) return;
    eventCount += 1;
    if (e.type === 'job.usage') {
      const p = e.payload as { promptTokens: number; completionTokens: number; toolCalls: number };
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + p.promptTokens,
        completionTokens: (usage?.completionTokens ?? 0) + p.completionTokens,
        toolCalls: (usage?.toolCalls ?? 0) + p.toolCalls,
      };
    }
    onEvent?.(e);
  };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        emit({ seq: seq++, type: 'job.log', payload: { level: 'warn', message: 'unparseable stdout line', line: line.slice(0, 300) } });
        continue;
      }
      onRaw?.(raw);
      // Track the fields we must return to the caller.
      const t = raw['type'];
      if (t === 'session' && typeof raw['sessionId'] === 'string') session = raw['sessionId'];
      if (t === 'final') {
        if (typeof raw['text'] === 'string') finalText = raw['text'];
        const r = raw['reason'] as Record<string, unknown> | undefined;
        if (r) {
          reasonKind = String(r['kind'] ?? 'unknown');
          const err = r['error'] as Record<string, unknown> | undefined;
          reasonError = err ? String(err['message'] ?? '') : null;
        }
      }
      if (t === 'tool_call') emit({ seq: seq++, type: 'job.log', payload: { level: 'debug', message: `tool ${String(raw['tool'])}` } });
      const norm = normalize(raw, seq++);
      // `job.text` for thinking/final is handled above; still persist them.
      emit(norm);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs)
    : null;

  const onAbort = (): void => {
    cancelled = true;
    child.kill();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Deliver the task on stdin, then close it: dsh reads the task from stdin and
  // will not start the turn until EOF.
  child.stdin.on('error', () => {
    /* the child may exit before consuming stdin; the exit handler reports it */
  });
  child.stdin.end(prompt, 'utf8');

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      stderr += `\nspawn error: ${String(err)}`;
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });

  if (timer) clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  // Flush a trailing partial line.
  const tail = buffer.trim();
  if (tail.length > 0) {
    try {
      const raw = JSON.parse(tail) as Record<string, unknown>;
      onRaw?.(raw);
      const norm = normalize(raw, seq++);
      emit(norm);
    } catch {
      /* ignore a truncated final line */
    }
  }

  const ok = reasonKind === 'completed' && exitCode === 0 && !timedOut && !cancelled;

  if (stderr.trim().length > 0 && !ok) {
    emit({
      seq: seq++,
      type: 'job.log',
      payload: { level: 'error', message: `stderr: ${stderr.trim().slice(-1500)}` },
    });
  }

  return {
    sessionId: session,
    finalText,
    reasonKind,
    reasonError,
    exitCode,
    ok,
    usage,
    stderr,
    timedOut,
    cancelled,
    eventCount,
  };
}

/** Quote one argv token for cmd.exe. Only ever used on fixed internal tokens. */
function shellQuote(token: string): string {
  return /^[A-Za-z0-9._:\-/]+$/.test(token) ? token : `"${token.replace(/"/g, '\\"')}"`;
}

/**
 * Environment for the child. Credentials are inherited deliberately (the model
 * route needs them) but anything that could make the agent behave differently
 * by accident is stripped.
 */
function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['NODE_OPTIONS'];
  delete env['DSH_DEBUG'];
  return env;
}