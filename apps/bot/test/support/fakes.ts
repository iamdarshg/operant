/**
 * Test doubles.
 *
 * These are *Discord-shaped objects*, not mocks of the discord.js classes: the
 * bot only depends on the structural interfaces in `src/discord/types.ts`, which
 * is exactly what makes a gateway-free suite possible. `FakeFetch` stands in for
 * the network, so every HTTP assertion is made against the request the bot would
 * really have sent.
 */
import { sseStreamFrom } from '../../src/api/sse.js';
import type { BotConfig } from '../../src/config.js';
import type {
  ButtonInteraction,
  IncomingAttachment,
  IncomingMessage,
  InteractionReply,
  OutboundMessage,
  RenderableChannel,
  RenderableMessage,
} from '../../src/discord/types.js';
import type { ApprovalSink } from '../../src/bot/handler.js';
import type { FetchLike } from '../../src/api/client.js';

/* ------------------------------------------------------------------ *
 * Discord-shaped fakes
 * ------------------------------------------------------------------ */

export interface FakeMessageOptions {
  /** Fail this many edits before succeeding; used for 429 tests. */
  readonly failures?: number;
  readonly error?: unknown;
  readonly onEdit?: (payload: OutboundMessage) => void;
}

export class FakeMessage implements RenderableMessage {
  readonly id: string;
  readonly initial: OutboundMessage | undefined;
  readonly edits: OutboundMessage[] = [];
  readonly editTimes: number[] = [];
  attempts = 0;
  private remainingFailures: number;
  private readonly options: FakeMessageOptions;

  constructor(id: string, initial?: OutboundMessage, options: FakeMessageOptions = {}) {
    this.id = id;
    this.initial = initial;
    this.options = options;
    this.remainingFailures = options.failures ?? 0;
  }

  get lastContent(): string {
    const last = this.edits[this.edits.length - 1];
    return last?.content ?? this.initial?.content ?? '';
  }

  async edit(payload: OutboundMessage): Promise<unknown> {
    this.attempts += 1;
    this.editTimes.push(Date.now());
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw this.options.error ?? new Error('fake edit failure');
    }
    this.edits.push(payload);
    this.options.onEdit?.(payload);
    return undefined;
  }
}

export class FakeChannel implements RenderableChannel {
  readonly id: string;
  readonly sent: FakeMessage[] = [];
  readonly sendPayloads: OutboundMessage[] = [];

  constructor(id: string) {
    this.id = id;
  }

  async send(payload: OutboundMessage): Promise<RenderableMessage> {
    const message = new FakeMessage(`sent-${this.sent.length + 1}`, payload);
    this.sent.push(message);
    this.sendPayloads.push(payload);
    return message;
  }
}

export interface FakeIncomingOptions {
  readonly id?: string;
  readonly channelId?: string;
  readonly guildId?: string | null;
  readonly content?: string;
  readonly authorId?: string;
  readonly authorName?: string;
  readonly authorBot?: boolean;
  readonly attachments?: IncomingAttachment[];
  readonly channel?: RenderableChannel;
  readonly inThread?: boolean;
}

export class FakeIncomingMessage implements IncomingMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly channel: RenderableChannel;
  readonly content: string;
  readonly author: { id: string; bot: boolean; username: string; tag: string };
  readonly attachments: readonly IncomingAttachment[];
  readonly inThread: boolean;
  readonly replies: FakeMessage[] = [];

  constructor(options: FakeIncomingOptions = {}) {
    this.id = options.id ?? 'message-1';
    this.channelId = options.channelId ?? 'chan-1';
    this.guildId = options.guildId === undefined ? 'guild-1' : options.guildId;
    this.channel = options.channel ?? new FakeChannel(this.channelId);
    this.content = options.content ?? '';
    this.author = {
      id: options.authorId ?? 'user-1',
      bot: options.authorBot ?? false,
      username: options.authorName ?? 'alice',
      tag: `${options.authorName ?? 'alice'}#0001`,
    };
    this.attachments = options.attachments ?? [];
    this.inThread = options.inThread ?? false;
  }

  async reply(payload: OutboundMessage): Promise<RenderableMessage> {
    const message = new FakeMessage(`reply-${this.replies.length + 1}`, payload);
    this.replies.push(message);
    return message;
  }

  get lastReply(): FakeMessage | null {
    return this.replies[this.replies.length - 1] ?? null;
  }
}

export interface FakeInteractionOptions {
  readonly id?: string;
  readonly customId: string;
  readonly userId?: string;
  readonly username?: string;
  readonly channelId?: string;
  readonly messageId?: string;
  readonly userBot?: boolean;
}

export class FakeInteraction implements ButtonInteraction {
  readonly id: string;
  readonly customId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly channel: RenderableChannel;
  readonly user: { id: string; username: string; bot: boolean };
  readonly replies: (InteractionReply & { kind: 'reply' })[] = [];
  readonly updates: OutboundMessage[] = [];

  constructor(options: FakeInteractionOptions) {
    this.id = options.id ?? 'interaction-1';
    this.customId = options.customId;
    this.channelId = options.channelId ?? 'chan-1';
    this.messageId = options.messageId ?? 'card-1';
    this.channel = new FakeChannel(this.channelId);
    this.user = {
      id: options.userId ?? 'user-1',
      username: options.username ?? 'alice',
      bot: options.userBot ?? false,
    };
  }

  async reply(payload: InteractionReply): Promise<unknown> {
    this.replies.push({ ...payload, kind: 'reply' });
    return undefined;
  }

  async update(payload: OutboundMessage): Promise<unknown> {
    this.updates.push(payload);
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * HTTP fake
 * ------------------------------------------------------------------ */

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  /** Parsed JSON body, when the caller sent one. */
  readonly json: unknown;
}

export interface FakeFetch {
  readonly fetchImpl: FetchLike;
  readonly calls: RecordedCall[];
  /** Calls whose URL path matches, in order. */
  matching(method: string, pathFragment: string): RecordedCall[];
  count(method: string, pathFragment: string): number;
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof headers === 'object' && !Array.isArray(headers) && !(headers instanceof Headers)) {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      out[key.toLowerCase()] = String(value);
    }
    return out;
  }
  const entries = headers instanceof Headers ? headers.entries() : [];
  for (const [key, value] of entries) out[key.toLowerCase()] = value;
  return out;
}

/**
 * Build a fetch stand-in. The handler decides the response; every call is
 * recorded so a test can assert method, URL, headers and body.
 */
export function makeFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : null;
    let json: unknown = null;
    if (body) {
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        json = null;
      }
    }
    const call: RecordedCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers: normalizeHeaders(init?.headers),
      body,
      json,
    };
    calls.push(call);
    return handler(call);
  };
  return {
    fetchImpl,
    calls,
    matching: (method, pathFragment) =>
      calls.filter((call) => call.method === method && call.url.includes(pathFragment)),
    count: (method, pathFragment) =>
      calls.filter((call) => call.method === method && call.url.includes(pathFragment)).length,
  };
}

export function pathOf(url: string): string {
  return new URL(url).pathname;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

/* ------------------------------------------------------------------ *
 * Control-plane payload builders
 * ------------------------------------------------------------------ */

export function acceptedResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'task-1',
    jobId: 'job-1',
    agentId: 'engineering',
    status: 'queued',
    eventsUrl: '/v1/jobs/job-1/events',
    streamUrl: '/v1/jobs/job-1/stream',
    ...overrides,
  };
}

export function jobEventFrame(
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): string {
  const row = { seq, type, payload, at: '2026-11-15T00:00:00.000Z' };
  return `event: job_event\ndata: ${JSON.stringify(row)}\n\n`;
}

export function jobDoneFrame(payload: Record<string, unknown>): string {
  return `event: job_done\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Complete SSE transcript for a successful one-message job. */
export function successfulJobFrames(result = 'RESTART-SURVIVED'): string[] {
  return [
    jobEventFrame(0, 'job.status', { status: 'dispatched' }),
    jobEventFrame(1, 'job.status', { status: 'running' }),
    jobEventFrame(2, 'job.text', { text: result, final: false }),
    jobEventFrame(3, 'job.text', { text: result, final: true }),
    jobDoneFrame({ status: 'succeeded', result, error: null }),
  ];
}

export function sseResponse(chunks: readonly string[]): Response {
  return new Response(sseStreamFrom(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A push-controlled SSE response for tests that drive timing by hand. */
export interface ManualSse {
  readonly response: Response;
  send(chunk: string): void;
  close(): void;
}

export function manualSse(): ManualSse {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    send(chunk: string) {
      controller?.enqueue(encoder.encode(chunk));
    },
    close() {
      controller?.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Config + sink helpers
 * ------------------------------------------------------------------ */

export function makeTestConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    nodeEnv: 'test',
    isProduction: false,
    logLevel: 'error',
    apiBase: 'http://127.0.0.1:8787',
    apiToken: 'test-api-token',
    discordToken: 'placeholder.discord.token',
    allowedUserIds: ['user-1'],
    allowedChannelIds: [],
    editIntervalMs: 10,
    pollIntervalMs: 5,
    approvalPollMs: 10,
    maxAttachmentBytes: 25 * 1024 * 1024,
    requestTimeoutMs: 2_000,
    streamIdleTimeoutMs: 5_000,
    jobTimeoutMs: 60_000,
    ...overrides,
  };
}

export interface RecordingApprovalSink extends ApprovalSink {
  readonly tracked: string[];
  readonly untracked: string[];
  readonly interactions: number;
}

export function makeApprovalSink(): RecordingApprovalSink {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const sink: RecordingApprovalSink = {
    tracked,
    untracked,
    interactions: 0,
    trackTask(taskId) {
      tracked.push(taskId);
    },
    untrackTask(taskId) {
      untracked.push(taskId);
    },
    async handleInteraction() {
      sink.interactions += 1;
      return 'handled';
    },
    pollSoon() {},
    stop() {},
  };
  return sink;
}