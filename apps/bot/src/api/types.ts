/**
 * Control-plane wire types, mirrored from `@operant/core`'s contract.
 *
 * Why mirrored instead of imported: the bot must build and run standalone
 * (`pnpm --filter @operant/bot build` must not depend on another package having
 * been compiled first). The field names below are pinned by contract tests, and
 * the live API is tolerant of extra/nullable fields, so drift shows up as a test
 * failure rather than a runtime surprise.
 *
 * The deployed API returns Postgres rows (snake_case). The dashboard-era typed
 * contract uses camelCase. Every normalizer here accepts both, so the bot works
 * against the running control plane and against a future serializer change.
 */

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'reviewing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export type JobStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];

const TASK_STATUS_SET = new Set<string>([
  'queued',
  'planning',
  'running',
  'waiting_approval',
  'reviewing',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);

const JOB_STATUS_SET = new Set<string>([
  'queued',
  'dispatched',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUS_SET.has(value);
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && JOB_STATUS_SET.has(value);
}

export function isTerminalJobStatus(value: unknown): boolean {
  return typeof value === 'string' && (TERMINAL_JOB_STATUSES as readonly string[]).includes(value);
}

/** Approval lifecycle on the control plane. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface TaskRecord {
  readonly id: string;
  readonly intent: string;
  readonly title: string;
  readonly status: TaskStatus | string;
  readonly requestedBy: string;
  readonly origin: string;
  readonly conversationId: string | null;
  readonly progressNote: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string | null;
  readonly finishedAt: string | null;
}

export interface JobRecord {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly status: JobStatus | string;
  readonly title: string;
  readonly result: string | null;
  readonly error: string | null;
  readonly agentId: string | null;
  readonly finishedAt: string | null;
}

/** One persisted job event, as served by `/v1/jobs/:id/events` and `/stream`. */
export interface JobEventRecord {
  readonly seq: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly at: string | null;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly taskId: string | null;
  readonly jobId: string | null;
  readonly summary: string;
  readonly status: ApprovalStatus | string;
  readonly risk: string;
  readonly action: { kind: string; payload: Record<string, unknown> } | null;
  readonly requestedBy: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string | null;
}

/** 202 response from `POST /v1/requests`. */
export interface CreateRequestResponse {
  readonly taskId: string;
  readonly jobId: string;
  readonly agentId: string;
  readonly status: string;
  readonly eventsUrl: string;
  readonly streamUrl: string;
}

export interface TranscribeResponse {
  readonly text: string;
  readonly language: string | null;
  readonly durationSec: number;
  readonly model: string;
  readonly rtf: number | null;
}

export interface HealthResponse {
  readonly state: string;
  readonly checks?: readonly { name: string; state: string; detail?: string }[];
  readonly dshProfile?: string;
}

/* ------------------------------------------------------------------ *
 * Row readers — snake_case today, camelCase tolerated
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === 'object' ? (value as Row) : {};
}

function str(source: Row, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function num(source: Row, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

export function normalizeTask(value: unknown): TaskRecord {
  const row_ = row(value);
  const id = str(row_, 'id') ?? '';
  const intent = str(row_, 'intent') ?? '';
  return {
    id,
    intent,
    title: str(row_, 'title') ?? intent,
    status: str(row_, 'status') ?? 'queued',
    requestedBy: str(row_, 'requestedBy', 'requested_by') ?? 'unknown',
    origin: str(row_, 'origin') ?? 'api',
    conversationId: str(row_, 'conversationId', 'conversation_id'),
    progressNote: str(row_, 'progressNote', 'progress_note'),
    failureReason: str(row_, 'failureReason', 'failure_reason'),
    createdAt: str(row_, 'createdAt', 'created_at'),
    finishedAt: str(row_, 'finishedAt', 'finished_at'),
  };
}

export function normalizeJob(value: unknown): JobRecord {
  const row_ = row(value);
  return {
    id: str(row_, 'id') ?? '',
    taskId: str(row_, 'taskId', 'task_id') ?? '',
    kind: str(row_, 'kind') ?? 'execute',
    status: str(row_, 'status') ?? 'queued',
    title: str(row_, 'title') ?? '',
    result: str(row_, 'result'),
    error: str(row_, 'error'),
    agentId: str(row_, 'agentId', 'agent_id'),
    finishedAt: str(row_, 'finishedAt', 'finished_at'),
  };
}

export function normalizeJobEvent(value: unknown): JobEventRecord {
  const row_ = row(value);
  return {
    seq: num(row_, 'seq'),
    type: str(row_, 'type') ?? 'unknown',
    payload: row(row_['payload']),
    at: str(row_, 'at'),
  };
}

export function normalizeApproval(value: unknown): ApprovalRecord {
  const row_ = row(value);
  const action = row(row_['action']);
  const actionKind = str(action, 'kind');
  return {
    id: str(row_, 'id') ?? '',
    taskId: str(row_, 'taskId', 'task_id'),
    jobId: str(row_, 'jobId', 'job_id'),
    summary: str(row_, 'summary') ?? '(no summary)',
    status: str(row_, 'status') ?? 'pending',
    risk: str(row_, 'risk') ?? 'medium',
    action: actionKind ? { kind: actionKind, payload: row(action['payload']) } : null,
    requestedBy: str(row_, 'requestedBy', 'requested_by'),
    expiresAt: str(row_, 'expiresAt', 'expires_at'),
    createdAt: str(row_, 'createdAt', 'created_at'),
  };
}