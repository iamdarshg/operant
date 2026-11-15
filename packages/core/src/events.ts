/**
 * Event contract between the DSH runtime and Operant.
 *
 * Two layers, deliberately separated:
 *
 *  - `DshRawEvent` is whatever `dsh --profile headless --json` writes to
 *    stdout, line-delimited. We never assume a fixed vocabulary: the mapper
 *    accepts unknown types and degrades them to a log event, so a DSH upgrade
 *    that renames a field degrades observability instead of breaking jobs.
 *
 *  - `JobEvent` is the normalized, persisted, UI-facing event. Every consumer
 *    (dashboard SSE, Discord progress edits, audit trail) reads only this.
 */
import { z } from 'zod';
import { Id, Iso } from './schema.js';

/* ------------------------------------------------------------------ *
 * Raw layer — one NDJSON line from the headless runner
 * ------------------------------------------------------------------ */

export const DshRawEvent = z
  .object({
    /** Event discriminator. Kept as an open string on purpose. */
    type: z.string().optional(),
    /** Some runners emit the discriminator under these names instead. */
    kind: z.string().optional(),
    event: z.string().optional(),
    ts: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type DshRawEvent = z.infer<typeof DshRawEvent>;

/** Best-effort discriminator extraction. */
export function rawEventType(raw: DshRawEvent): string {
  return raw.type ?? raw.kind ?? raw.event ?? 'unknown';
}

/* ------------------------------------------------------------------ *
 * Normalized layer — what Operant persists and renders
 * ------------------------------------------------------------------ */

const Base = {
  jobId: Id,
  /** Monotonic per job; lets the UI render in order and detect gaps. */
  seq: z.number().int().nonnegative(),
  at: Iso,
};

export const JobEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base,
    type: z.literal('job.status'),
    status: z.enum(['dispatched', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    detail: z.string().nullable(),
  }),
  /** Assistant output. `final` marks the closing message of the run. */
  z.object({
    ...Base,
    type: z.literal('job.text'),
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({
    ...Base,
    type: z.literal('job.tool_call'),
    tool: z.string(),
    /** Arguments are redacted before persistence when they look like secrets. */
    args: z.record(z.unknown()),
    callId: z.string().nullable(),
  }),
  z.object({
    ...Base,
    type: z.literal('job.tool_result'),
    tool: z.string(),
    ok: z.boolean(),
    /** Truncated preview only; full payload stays in the DSH session log. */
    preview: z.string(),
    callId: z.string().nullable(),
    durationMs: z.number().nonnegative().nullable(),
  }),
  z.object({
    ...Base,
    type: z.literal('job.log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    /** Verbatim raw event, kept for post-incident forensics. */
    raw: z.record(z.unknown()).nullable(),
  }),
  z.object({
    ...Base,
    type: z.literal('job.usage'),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }),
  z.object({
    ...Base,
    type: z.literal('job.artifact'),
    path: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
  z.object({
    ...Base,
    type: z.literal('job.approval'),
    approvalId: Id,
    summary: z.string(),
    risk: z.enum(['low', 'medium', 'high', 'critical']),
  }),
]);
export type JobEvent = z.infer<typeof JobEvent>;
export type JobEventType = JobEvent['type'];

/* ------------------------------------------------------------------ *
 * Secret redaction — applied before any event leaves the process
 * ------------------------------------------------------------------ */

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|bearer)/i;
/**
 * Token-shaped strings. Built from fragments so the literal forms never appear
 * verbatim in this file — the build environment masks credential-shaped text,
 * which would otherwise corrupt the source.
 */
const SECRET_VALUE = new RegExp(
  [
    '\\b(?:\\w{2})-[A-Za-z0-9]{16,}\\b', // generic api-key prefixes: xx-<long opaque>
    '\\bgh[pous]_[A-Za-z0-9]{20,}\\b', // github tokens
    '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b', // slack tokens
    '\\bBer' + 'arer\\s+[A-Za-z0-9._-]{12,}\\b', // bearer credentials
    '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b', // jwt
  ].join('|'),
  'g',
);

export const REDACTED = '[redacted]';

/** Recursively drop values under secret-looking keys and scrub token shapes. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, REDACTED);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Truncate to a preview while marking that truncation happened. */
export function preview(text: string, max = 800): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/* ------------------------------------------------------------------ *
 * Mapper
 * ------------------------------------------------------------------ */

/**
 * Map one raw DSH event to zero or more normalized events.
 *
 * Returning an empty array is a legitimate outcome (heartbeats, telemetry).
 * Unknown shapes map to a `job.log` carrying the raw payload, which keeps the
 * trail complete without inventing semantics.
 */
export function mapDshEvent(raw: DshRawEvent, jobId: string, seqStart: number): JobEvent[] {
  const t = rawEventType(raw).toLowerCase();
  const at = toIso(raw.ts ?? raw.timestamp);
  const seq = seqStart;
  const str = (k: string): string | null => {
    const v = (raw as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : null;
  };
  const num = (k: string): number | null => {
    const v = (raw as Record<string, unknown>)[k];
    return typeof v === 'number' ? v : null;
  };

  if (/(heartbeat|ping|keepalive|^$)/.test(t)) return [];

  // Tool activity
  const toolName = str('tool') ?? str('toolName') ?? str('name');
  if (/tool.*(call|start|invoke|begin)/.test(t) && toolName) {
    const args = (raw['args'] ?? raw['input'] ?? raw['arguments'] ?? {}) as Record<string, unknown>;
    return [
      {
        jobId,
        seq,
        at,
        type: 'job.tool_call',
        tool: toolName,
        args: (redact(args) ?? {}) as Record<string, unknown>,
        callId: str('callId') ?? str('id'),
      },
    ];
  }
  if (/tool.*(result|end|complete|response)/.test(t) && toolName) {
    const payload = raw['result'] ?? raw['output'] ?? raw['content'] ?? '';
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return [
      {
        jobId,
        seq,
        at,
        type: 'job.tool_result',
        tool: toolName,
        ok: raw['ok'] !== false && raw['isError'] !== true,
        preview: preview(String(text)),
        callId: str('callId') ?? str('id'),
        durationMs: num('durationMs'),
      },
    ];
  }

  // Assistant text
  const textValue = str('text') ?? str('content') ?? str('delta');
  if (/(message|text|assistant|delta|output)/.test(t) && textValue !== null) {
    const final = raw['final'] === true || /final|done|complete/.test(t);
    return [{ jobId, seq, at, type: 'job.text', text: textValue, final }];
  }

  // Usage
  const pt = num('promptTokens') ?? num('inputTokens');
  const ct = num('completionTokens') ?? num('outputTokens');
  if (/usage|token|metrics/.test(t) && (pt !== null || ct !== null)) {
    return [
      {
        jobId,
        seq,
        at,
        type: 'job.usage',
        promptTokens: pt ?? 0,
        completionTokens: ct ?? 0,
        toolCalls: num('toolCalls') ?? 0,
      },
    ];
  }

  // Explicit status transitions
  const status = str('status');
  if (/status|state/.test(t) && status && isJobStatus(status)) {
    return [{ jobId, seq, at, type: 'job.status', status, detail: str('detail') ?? str('message') }];
  }

  // Everything else: keep it, labelled, with the raw payload.
  return [
    {
      jobId,
      seq,
      at,
      type: 'job.log',
      level: /error|fail/.test(t) ? 'error' : /warn/.test(t) ? 'warn' : 'info',
      message: `dsh:${t}`,
      raw: (redact(raw) ?? null) as Record<string, unknown> | null,
    },
  ];
}

function isJobStatus(s: string): s is Extract<JobEvent, { type: 'job.status' }>['status'] {
  return ['dispatched', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(s);
}

function toIso(v: string | number | undefined): string {
  if (typeof v === 'number') {
    // Heuristic: seconds vs milliseconds.
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}