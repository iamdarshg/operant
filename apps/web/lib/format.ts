/** Display helpers. Every value shown comes from the API; nothing is synthesised. */

export const TERMINAL_TASK = ['succeeded', 'failed', 'cancelled'] as const;
export const TERMINAL_JOB = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const;

export function isTerminalTask(status: string): boolean {
  return (TERMINAL_TASK as readonly string[]).includes(status);
}

export function isTerminalJob(status: string): boolean {
  return (TERMINAL_JOB as readonly string[]).includes(status);
}

/** The API speaks snake_case state names; the board speaks the same words. */
export function stateWord(status: string): string {
  return status.replace(/_/g, ' ');
}

export type StateTone = 'live' | 'owed' | 'done' | 'failed' | 'idle';

export function stateTone(status: string): StateTone {
  if (status === 'running' || status === 'dispatched' || status === 'reviewing') return 'live';
  if (status === 'waiting_approval' || status === 'blocked') return 'owed';
  if (status === 'failed' || status === 'interrupted') return 'failed';
  if (status === 'succeeded') return 'done';
  return 'idle';
}

export function duration(fromIso: string | null, toIso: string | null, now = Date.now()): string {
  if (!fromIso) return 'not started';
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : now;
  const ms = Math.max(0, to - from);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

export function age(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function stamp(iso: string | null): string {
  if (!iso) return '—';
  // A bare clock time reads as *local* to whoever is looking at it. This page is
  // server-rendered and cannot know the viewer's zone, so it says the zone
  // instead of implying one. (An IST browser previously read 19:09:18 as local
  // evening when it was UTC.)
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** One line that says what an event actually carries, without inventing fields. */
export function eventLine(type: string, payload: Record<string, unknown>): string {
  const pick = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
  };
  const message = pick('message');
  if (message) {
    const chars = pick('chars');
    return chars ? `${message} ${chars} chars` : message;
  }
  if (type === 'job.text') {
    const text = pick('text') ?? '';
    const final = payload['final'] === true ? ' (final)' : '';
    return `${text.length > 160 ? `${text.slice(0, 160)}…` : text}${final}`;
  }
  if (type === 'job.status') {
    const phase = pick('phase');
    const status = pick('status');
    const reason = pick('reasonKind');
    return [phase, status, reason].filter(Boolean).join(' ');
  }
  if (type === 'job.usage') {
    const parts = ['promptTokens', 'completionTokens', 'toolCalls']
      .map((key) => {
        const value = pick(key);
        return value ? `${key} ${value}` : null;
      })
      .filter(Boolean);
    return parts.join(' ');
  }
  const entries = Object.entries(payload).slice(0, 4);
  if (entries.length === 0) return 'no payload';
  return entries
    .map(([key, value]) => `${key} ${typeof value === 'string' ? value.slice(0, 60) : JSON.stringify(value)?.slice(0, 60)}`)
    .join(' ');
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * A job that has not run yet reports usage as null, and a job with no
 * verifier reports no ids. Both are normal states, not errors.
 */
/**
 * Usage for a job, or `null` when it is not known yet.
 *
 * This used to substitute a zero-filled object, so every job still running displayed
 * "0 tokens" while the tape next to it streamed the real counts. A confident zero is
 * worse than an admission of ignorance: callers render an em dash instead.
 */
export function jobUsage(job: {
  usage?: { ms: number; events: number; toolCalls: number; promptTokens: number; completionTokens: number } | null;
}): { ms: number; events: number; toolCalls: number; promptTokens: number; completionTokens: number } | null {
  return job.usage ?? null;
}

