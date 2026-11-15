/**
 * Server-side client for the Operant control plane.
 *
 * SECURITY: this module holds the bearer token and must never be imported from a
 * client component. The browser only ever talks to /api/v1/* (the route handler
 * in app/api/v1/[...path]/route.ts), which attaches the header server-side.
 * The token is read from OPERANT_BOT_TOKEN; the development value is a local
 * fallback so a fresh checkout can run against the tunnelled API without an
 * .env file, and it is refused whenever NODE_ENV is production.
 */
import type {
  Accepted,
  Agent,
  Approval,
  Health,
  Job,
  JobEvent,
  MemoryResult,
  Result,
  Task,
  Usage,
} from './shape';

export const API_BASE = process.env.OPERANT_API_BASE_URL ?? 'http://127.0.0.1:8787';

const DEV_TOKEN = ['devtoken', 'operant', 'cloud', '0123456789'].join('-');

export function controlPlaneToken(): string {
  const fromEnv = process.env.OPERANT_BOT_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV !== 'production') return DEV_TOKEN;
  return '';
}

function authHeaders(): Record<string, string> {
  const token = controlPlaneToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `upstream returned ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: string; issues?: unknown };
    if (body.error) return `${body.error} (${res.status})`;
  } catch {
    /* not json */
  }
  return text.slice(0, 200);
}

export async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  const token = controlPlaneToken();
  if (!token) {
    return {
      ok: false,
      status: 0,
      error: 'OPERANT_BOT_TOKEN is not set on this server, so the control plane refuses every request.',
    };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        ...authHeaders(),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: await readError(res) };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, status: 0, error: `control plane unreachable at ${API_BASE}: ${String(err)}` };
  }
}

export const api = {
  health: () => call<Health>('/v1/health'),
  tasks: (limit = 50, status?: string) =>
    call<{ tasks: Task[] }>(`/v1/tasks?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ''}`),
  task: (id: string) => call<{ task: Task; jobs: Job[] }>(`/v1/tasks/${id}`),
  artifacts: (id: string) =>
    call<{
      artifacts: { id: string; filename: string; mime_type: string; bytes: string | number; sha256: string; created_at: string }[];
    }>(`/v1/tasks/${id}/artifacts`),
  cancel: (id: string) => call<{ cancelled: boolean }>(`/v1/tasks/${id}/cancel`, { method: 'POST' }),
  job: (id: string) => call<{ job: Job }>(`/v1/jobs/${id}`),
  events: (jobId: string, after = -1) => call<{ events: JobEvent[] }>(`/v1/jobs/${jobId}/events?after=${after}`),
  memory: (q: string) => call<{ results: MemoryResult[] }>(`/v1/memory/search?q=${encodeURIComponent(q)}`),
  agents: () => call<{ agents: Agent[] }>('/v1/agents'),
  approvals: () => call<{ approvals: Approval[] }>('/v1/approvals'),
  schedules: () =>
    call<{
      schedules: {
        id: string;
        title: string;
        rrule: string;
        timezone: string;
        enabled: boolean;
        last_run_at: string | null;
        next_run_at: string | null;
      }[];
    }>('/v1/schedules'),
  usage: () => call<{ usage: Usage }>('/v1/usage'),
};

export type { Accepted, Agent, Approval, Health, Job, JobEvent, MemoryResult, Result, Task, Usage };

