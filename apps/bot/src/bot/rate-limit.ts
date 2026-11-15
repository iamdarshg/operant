/**
 * Rate-limited in-place editing.
 *
 * A job can emit dozens of events per second. Discord's REST API will happily
 * accept a burst and then 429 the whole bot, which would stall *every* channel —
 * the exact failure the bot must not have. So edits are coalesced:
 *
 *   - at most one edit per message per interval (default 1.5 s);
 *   - intermediate states are dropped, only the newest is sent;
 *   - a terminal edit waits out the remaining interval instead of forcing an
 *     early write, so the cap holds even for the final message;
 *   - a 429 sets a hard `retry-after` gate that overrides the interval.
 *
 * The clock is injectable, which is how the tests assert the cap deterministically
 * without sleeping.
 */
import type { RenderableMessage } from '../discord/types.js';
import type { Logger } from '../logger.js';

export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
  },
  sleep: (ms) =>
    ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface MessageEditorOptions {
  readonly intervalMs?: number;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/**
 * Extract a wait from a Discord rate-limit error. discord.js exposes `retryAfter`
 * in milliseconds on `RateLimitError`, while the raw HTTP body uses
 * `retry_after` in seconds; both are accepted.
 */
export function retryAfterMsFromError(error: unknown): number | null {
  const cap = 60_000;
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const raw = (record['rawError'] && typeof record['rawError'] === 'object'
    ? (record['rawError'] as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const status = record['status'] ?? raw['status'];
  const explicitMs = record['retryAfterMs'];
  if (typeof explicitMs === 'number' && Number.isFinite(explicitMs) && explicitMs >= 0) {
    return Math.min(cap, Math.round(explicitMs));
  }
  const discordJs = record['retryAfter'];
  if (typeof discordJs === 'number' && Number.isFinite(discordJs) && discordJs >= 0) {
    // discord.js reports milliseconds; small values are still milliseconds here.
    return Math.min(cap, Math.round(discordJs));
  }
  const seconds = raw['retry_after'];
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(cap, Math.round(seconds * 1000));
  }
  if (status === 429) return 1_000;
  return null;
}

export class MessageEditor {
  private readonly message: RenderableMessage;
  private readonly intervalMs: number;
  private readonly logger?: Logger;
  private readonly clock: Clock;
  private pending: string | null = null;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  private lastEditAt: number;
  private lastSent: string | null = null;
  private retryAt = 0;
  private closed = false;
  private edits = 0;
  private attempts = 0;

  constructor(message: RenderableMessage, options: MessageEditorOptions = {}) {
    this.message = message;
    this.intervalMs = options.intervalMs ?? 1_500;
    this.logger = options.logger;
    this.clock = options.clock ?? realClock;
    this.lastEditAt = this.clock.now();
  }

  /** Edits that reached Discord successfully. */
  get editCount(): number {
    return this.edits;
  }

  /** Edit attempts, including ones that failed. */
  get attemptCount(): number {
    return this.attempts;
  }

  get lastContent(): string | null {
    return this.lastSent;
  }

  /**
   * Offer the newest state. Never awaits: the caller is an event loop that must
   * keep draining the stream.
   */
  set(content: string): void {
    if (this.closed) return;
    if (content === this.lastSent) return;
    this.pending = content;
    this.schedule();
  }

  /** Force the current pending state out, then stop accepting updates. */
  async close(): Promise<void> {
    await this.flushFinal();
    this.stop();
  }

  /**
   * Flush the newest state as the terminal edit, honouring both the interval and
   * any outstanding rate-limit gate. Safe to call twice.
   */
  async flushFinal(content?: string): Promise<void> {
    if (content !== undefined) this.pending = content;
    this.clearTimer();
    if (this.pending === null || this.closed) {
      if (this.inflight) await this.inflight;
      return;
    }
    await this.waitForGate();
    await this.flush();
    // A 429 during the terminal edit must not silently drop the final state.
    if (this.pending !== null && !this.closed) {
      await this.waitForGate();
      await this.flush();
    }
  }

  stop(): void {
    this.closed = true;
    this.clearTimer();
    this.pending = null;
  }

  private async waitForGate(): Promise<void> {
    const now = this.clock.now();
    const gate = Math.max(this.lastEditAt + this.intervalMs, this.retryAt);
    const wait = gate - now;
    if (wait > 0) await this.clock.sleep(wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.closed || this.timer !== null || this.pending === null) return;
    const now = this.clock.now();
    const gate = Math.max(this.lastEditAt + this.intervalMs, this.retryAt);
    const wait = Math.max(0, gate - now);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    if (this.inflight) {
      await this.inflight;
      if (this.closed) return;
    }
    const content = this.pending;
    this.pending = null;
    if (content === null || content === this.lastSent) return;

    this.attempts += 1;
    const run = (async () => {
      try {
        await this.message.edit({ content });
        this.edits += 1;
        this.lastSent = content;
        this.lastEditAt = this.clock.now();
        this.retryAt = 0;
      } catch (error) {
        const retryAfterMs = retryAfterMsFromError(error);
        this.lastEditAt = this.clock.now();
        if (retryAfterMs !== null) {
          this.retryAt = this.clock.now() + retryAfterMs;
          this.logger?.warn('discord edit rate-limited; backing off', {
            retryAfterMs,
            messageId: this.message.id,
          });
        } else {
          this.logger?.warn('discord edit failed', {
            messageId: this.message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Keep the unsent text so the next tick retries it.
        if (this.pending === null) this.pending = content;
      }
    })();

    this.inflight = run;
    try {
      await run;
    } finally {
      this.inflight = null;
    }
    this.schedule();
  }
}