/**
 * HTTP client for the Operant control plane.
 *
 * Design constraints that come straight from the bot's requirements:
 *
 *  - **The gateway must never block.** Every call is bounded by a timeout and
 *    callers never await a job inline; this client only handles the short
 *    control-plane calls.
 *  - **429 is honoured, not swallowed.** `retry-after` is read (seconds or
 *    milliseconds) and the retry waits exactly that long, capped so a broken
 *    header cannot wedge the process.
 *  - **Errors are typed.** `ApiError` carries the HTTP status and the API's
 *    machine-readable code so callers can say something true ("transcription
 *    failed", "approval already decided") instead of "something went wrong".
 *
 * `fetch` is injected. Tests therefore never open a socket and can assert the
 * exact method, URL and body of every call.
 */
import type { Logger } from '../logger.js';
import {
  normalizeApproval,
  normalizeJob,
  normalizeJobEvent,
  normalizeTask,
  type ApprovalRecord,
  type ApprovalStatus,
  type CreateRequestResponse,
  type HealthResponse,
  type JobEventRecord,
  type JobRecord,
  type TaskRecord,
  type TranscribeResponse,
} from './types.js';

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export type SleepFn = (ms: number) => Promise<void>;

export interface ApiClientOptions {
  readonly base: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly sleep?: SleepFn;
  /** Retries for transient failures (429, 502, 503, network). */
  readonly maxRetries?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    body: unknown,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The API could not be reached at all (DNS, refused connection, timeout). */
export class ApiUnreachableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ApiUnreachableError';
    this.cause = cause;
  }
}

export interface CreateRequestInput {
  readonly text: string;
  readonly origin: 'discord';
  readonly requestedBy: string;
  readonly conversationId?: string;
  readonly requireVerification?: boolean;
  readonly attachments?: readonly {
    filename: string;
    mimeType: string;
    ref: string;
    bytes: number;
  }[];
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `retry-after` (seconds, possibly fractional) or `x-ratelimit-reset-after`. */
export function retryAfterMsFromHeaders(headers: Headers): number | null {
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
}

function withTimeout(ms: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCode(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = record['error'] ?? record['code'];
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return `http_${status}`;
}

const QUERY_KEYS = ['limit', 'status', 'conversationId', 'after', 'q'] as const;

function buildQuery(params?: Partial<Record<(typeof QUERY_KEYS)[number], string | number>>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export class OperantApi {
  readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: Logger;
  private readonly timeoutMs: number;
  private readonly sleep: SleepFn;
  private readonly maxRetries: number;

  constructor(options: ApiClientOptions) {
    this.base = options.base.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 2;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      ...extra,
    };
  }

  /**
   * One JSON call with bounded retries. Returns the parsed body (or null).
   */
  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.base}${path}`;
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: this.headers(
            body === undefined ? undefined : { 'content-type': 'application/json' },
          ),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: withTimeout(options.timeoutMs ?? this.timeoutMs, options.signal),
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          attempt += 1;
          const delay = Math.min(2_000, 250 * 2 ** (attempt - 1));
          this.logger?.warn('control plane unreachable; retrying', {
            url,
            attempt,
            delayMs: delay,
            error: describeError(error),
          });
          await this.sleep(delay);
          continue;
        }
        throw new ApiUnreachableError(
          `control plane unreachable: ${method} ${path} — ${describeError(error)}`,
          error,
        );
      }

      const text = await response.text();
      const parsed = parseJson(text);

      if (!response.ok) {
        const retryAfterMs = retryAfterMsFromHeaders(response.headers);
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          attempt += 1;
          const delay = retryAfterMs ?? Math.min(2_000, 250 * 2 ** (attempt - 1));
          this.logger?.warn('control plane returned a retryable status', {
            url,
            status: response.status,
            attempt,
            delayMs: delay,
          });
          await this.sleep(delay);
          continue;
        }
        throw new ApiError(
          response.status,
          errorCode(response.status, parsed),
          `${method} ${path} failed with HTTP ${response.status}: ${truncate(text, 300)}`,
          parsed,
          retryAfterMs,
        );
      }

      return parsed as T;
    }
  }

  /* ---------------------------------------------------------- control plane */

  async createRequest(input: CreateRequestInput): Promise<CreateRequestResponse> {
    const payload: Record<string, unknown> = {
      text: input.text,
      origin: input.origin,
      requestedBy: input.requestedBy,
    };
    if (input.conversationId) payload['conversationId'] = input.conversationId;
    if (input.requireVerification !== undefined) {
      payload['requireVerification'] = input.requireVerification;
    }
    if (input.attachments && input.attachments.length > 0) {
      payload['attachments'] = input.attachments;
    }
    const response = await this.request<Record<string, unknown>>('POST', '/v1/requests', payload);
    return {
      taskId: asString(response['taskId']) ?? '',
      jobId: asString(response['jobId']) ?? '',
      agentId: asString(response['agentId']) ?? '',
      status: asString(response['status']) ?? 'queued',
      eventsUrl: asString(response['eventsUrl']) ?? '',
      streamUrl: asString(response['streamUrl']) ?? '',
    };
  }

  async listTasks(params: { limit?: number; status?: string; conversationId?: string } = {}): Promise<
    TaskRecord[]
  > {
    const response = await this.request<Record<string, unknown>>(
      'GET',
      `/v1/tasks${buildQuery(params)}`,
    );
    const rows = Array.isArray(response['tasks']) ? (response['tasks'] as unknown[]) : [];
    return rows.map(normalizeTask);
  }

  async getTask(taskId: string): Promise<{ task: TaskRecord; jobs: JobRecord[] }> {
    const response = await this.request<Record<string, unknown>>(
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}`,
    );
    const jobs = Array.isArray(response['jobs']) ? (response['jobs'] as unknown[]) : [];
    return { task: normalizeTask(response['task']), jobs: jobs.map(normalizeJob) };
  }

  async cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
    const response = await this.request<Record<string, unknown>>(
      'POST',
      `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
      {},
    );
    return { cancelled: response['cancelled'] === true };
  }

  /* ------------------------------------------------------------------ jobs */

  async getJobEvents(jobId: string, after = -1): Promise<JobEventRecord[]> {
    const response = await this.request<Record<string, unknown>>(
      'GET',
      `/v1/jobs/${encodeURIComponent(jobId)}/events${buildQuery({ after })}`,
    );
    const rows = Array.isArray(response['events']) ? (response['events'] as unknown[]) : [];
    return rows.map(normalizeJobEvent).filter((event) => event.type !== '');
  }

  /**
   * Open the SSE stream. Returns the raw `Response` so the caller decides what
   * to do with frames; non-2xx responses throw `ApiError`.
   */
  async openJobStream(
    jobId: string,
    after = -1,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.base}/v1/jobs/${encodeURIComponent(jobId)}/stream${buildQuery({ after })}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers({ accept: 'text/event-stream' }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ApiUnreachableError(
        `control plane stream unreachable: ${describeError(error)}`,
        error,
      );
    }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        errorCode(response.status, null),
        `GET /v1/jobs/${jobId}/stream failed with HTTP ${response.status}`,
        null,
        retryAfterMsFromHeaders(response.headers),
      );
    }
    return response;
  }

  /* ------------------------------------------------------------- approvals */

  async listApprovals(status: ApprovalStatus | 'pending' = 'pending'): Promise<ApprovalRecord[]> {
    const response = await this.request<Record<string, unknown>>('GET', '/v1/approvals');
    const rows = Array.isArray(response['approvals']) ? (response['approvals'] as unknown[]) : [];
    return rows.map(normalizeApproval).filter((approval) => approval.status === status);
  }

  async decideApproval(
    approvalId: string,
    input: { decision: 'approve' | 'reject'; decidedBy: string; note?: string },
  ): Promise<ApprovalRecord> {
    const body: Record<string, unknown> = {
      decision: input.decision,
      decidedBy: input.decidedBy,
    };
    if (input.note !== undefined) body['note'] = input.note;
    const response = await this.request<Record<string, unknown>>(
      'POST',
      `/v1/approvals/${encodeURIComponent(approvalId)}/decide`,
      body,
    );
    return normalizeApproval(response['approval']);
  }

  /* ----------------------------------------------------------------- voice */

  /**
   * Transcribe base64 audio.
   *
   * The published contract names the payload `audioBase64`; the deployed API
   * validates `ref` (the same base64 string) because it reuses the shared
   * `TranscribeInput` schema. Both keys are sent so one call works against
   * either version — this is contract skew, not duplication for its own sake.
   */
  async transcribe(
    audioBase64: string,
    options: { language?: string; profile?: 'fast' | 'accurate' } = {},
  ): Promise<TranscribeResponse> {
    const body: Record<string, unknown> = {
      audioBase64,
      ref: audioBase64,
      profile: options.profile ?? 'fast',
    };
    if (options.language) body['language'] = options.language;
    const response = await this.request<Record<string, unknown>>(
      'POST',
      '/v1/voice/transcribe',
      body,
      // Transcription of a long clip outlives an ordinary control-plane call.
      { timeoutMs: Math.max(this.timeoutMs, 120_000) },
    );
    return {
      text: asString(response['text']) ?? '',
      language: asString(response['language']),
      durationSec: asNumber(response['durationSec']) ?? 0,
      model: asString(response['model']) ?? 'unknown',
      rtf: asNumber(response['rtf']),
    };
  }

  /* ---------------------------------------------------------------- health */

  async health(): Promise<HealthResponse> {
    const response = await this.request<Record<string, unknown>>('GET', '/v1/health');
    const checks = Array.isArray(response['checks']) ? response['checks'] : undefined;
    return {
      state: asString(response['state']) ?? 'unknown',
      ...(checks ? { checks: checks as { name: string; state: string; detail?: string }[] } : {}),
      ...(asString(response['dshProfile']) ? { dshProfile: asString(response['dshProfile'])! } : {}),
    };
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** Human-readable error for logs and Discord copy. Never leaks the token. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof ApiUnreachableError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}