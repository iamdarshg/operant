/**
 * Job tracking: SSE first, polling fallback.
 *
 * This is the module that keeps the gateway responsive. `track()` runs detached
 * from the message handler: the handler posts a "working" reply and returns, and
 * this class drains the event stream and edits that reply at a rate Discord will
 * tolerate.
 *
 * Two transports exist because they fail differently:
 *
 *   - SSE (`/v1/jobs/:id/stream`) is preferred: one connection, no polling load,
 *     resumes from `after=<seq>` so a reconnect misses nothing.
 *   - Polling (`/v1/jobs/:id/events`) is the fallback for when a proxy kills the
 *     stream or the endpoint is unreachable. It reuses the same `seq` cursor.
 *
 * Neither transport is allowed to throw into the gateway: every failure becomes
 * a logged warning plus a user-visible message, and the bot stays up.
 */
import { describeError, type OperantApi } from '../api/client.js';
import { readSseResponse } from '../api/sse.js';
import {
  isJobStatus,
  isTerminalJobStatus,
  type JobEventRecord,
} from '../api/types.js';
import type { RenderableMessage } from '../discord/types.js';
import type { Logger } from '../logger.js';
import { renderProgress, type ProgressState } from './copy.js';
import { MessageEditor, realClock, type Clock } from './rate-limit.js';

export interface JobTarget {
  readonly taskId: string;
  readonly jobId: string;
  readonly conversationId: string;
  readonly intent: string;
  readonly agentId: string | null;
  /** The reply the bot already posted; it is edited in place. */
  readonly message: RenderableMessage;
}

export interface JobOutcome {
  readonly status: string;
  readonly result: string | null;
  readonly error: string | null;
  readonly eventCount: number;
}

export interface JobRunnerDeps {
  /** Only the endpoints the runner needs, so tests can pass a narrow fake. */
  readonly api: Pick<OperantApi, 'openJobStream' | 'getJobEvents' | 'getTask'>;
  readonly logger: Logger;
  readonly editIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly clock?: Clock;
  /** Called once when a job reaches a terminal state. */
  readonly onFinished?: (turn: {
    conversationId: string;
    taskId: string;
    jobId: string;
    intent: string;
    status: string;
    result: string | null;
  }) => void;
  /** Called when the job reports it is waiting for a human decision. */
  readonly onApprovalRequested?: (input: { taskId: string; jobId: string; approvalId: string }) => void;
}

/** What the message handler needs from the tracker; satisfied by `JobRunner`. */
export interface JobTracker {
  track(target: JobTarget): Promise<JobOutcome>;
  abortAll(): void;
}

interface MutableState {
  status: string;
  eventCount: number;
  toolCalls: string[];
  lastText: string | null;
  result: string | null;
  error: string | null;
  approvalPending: boolean;
}

export class JobRunner {
  private readonly deps: JobRunnerDeps;
  private readonly clock: Clock;
  private readonly active = new Map<string, AbortController>();

  constructor(deps: JobRunnerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
  }

  /** Abort every in-flight stream; used for shutdown and by tests. */
  abortAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  async track(target: JobTarget): Promise<JobOutcome> {
    const state: MutableState = {
      status: 'queued',
      eventCount: 0,
      toolCalls: [],
      lastText: null,
      result: null,
      error: null,
      approvalPending: false,
    };

    const editor = new MessageEditor(target.message, {
      intervalMs: this.deps.editIntervalMs,
      logger: this.deps.logger,
      clock: this.clock,
    });
    const startedAt = this.clock.now();
    const render = (): string =>
      renderProgress(this.snapshot(target, state, startedAt));

    editor.set(render());

    const controller = new AbortController();
    this.active.set(target.taskId, controller);

    let transport: 'sse' | 'poll' = 'sse';
    let cursor = -1;
    let done = false;
    let sawDoneFrame = false;

    try {
      try {
        const consumed = await this.consumeStream(
          target,
          state,
          controller.signal,
          render,
          editor,
          cursor,
        );
        cursor = consumed.cursor;
        sawDoneFrame = consumed.sawDoneFrame;
        done = isTerminalJobStatus(state.status);
      } catch (error) {
        if (controller.signal.aborted) {
          // Shutdown, not a failure: leave the message in its last known state.
          this.deps.logger.info('job tracking aborted', { taskId: target.taskId, jobId: target.jobId });
          done = true;
        } else {
          transport = 'poll';
          this.deps.logger.warn('SSE stream failed; falling back to polling', {
            taskId: target.taskId,
            jobId: target.jobId,
            error: describeError(error),
          });
        }
      }

      // A terminal status without the closing `job_done` frame (a stream cut by
      // a proxy, or a control plane that only persisted the status) would leave
      // the reason/result blank. One authoritative read fills it in.
      if (done && !sawDoneFrame && !controller.signal.aborted) {
        await this.enrichFromTask(target, state);
        editor.set(render());
      }

      if (!done && !controller.signal.aborted) {
        await this.pollUntilDone(target, state, render, editor, cursor, controller.signal);
      }
    } catch (error) {
      state.error = state.error ?? describeError(error);
      state.status = isTerminalJobStatus(state.status) ? state.status : 'failed';
      this.deps.logger.error('job tracking failed', {
        taskId: target.taskId,
        jobId: target.jobId,
        transport,
        error: describeError(error),
      });
    } finally {
      this.active.delete(target.taskId);
      try {
        await editor.flushFinal(render());
      } catch (error) {
        this.deps.logger.warn('final edit failed', {
          messageId: target.message.id,
          error: describeError(error),
        });
      }
      editor.stop();
    }

    const outcome: JobOutcome = {
      status: state.status,
      result: state.result,
      error: state.error,
      eventCount: state.eventCount,
    };

    this.deps.onFinished?.({
      conversationId: target.conversationId,
      taskId: target.taskId,
      jobId: target.jobId,
      intent: target.intent,
      status: outcome.status,
      result: outcome.result,
    });

    return outcome;
  }

  private snapshot(target: JobTarget, state: MutableState, startedAt: number): ProgressState {
    return {
      taskId: target.taskId,
      jobId: target.jobId,
      agentId: target.agentId,
      intent: target.intent,
      status: state.status,
      eventCount: state.eventCount,
      toolCalls: state.toolCalls,
      lastText: state.lastText,
      result: state.result,
      error: state.error,
      approvalCount: state.approvalPending ? 1 : 0,
      elapsedMs: Math.max(0, this.clock.now() - startedAt),
    };
  }

  /** Returns the last sequence number consumed and whether `job_done` was seen. */
  private async consumeStream(
    target: JobTarget,
    state: MutableState,
    signal: AbortSignal,
    render: () => string,
    editor: MessageEditor,
    cursor: number,
  ): Promise<{ cursor: number; sawDoneFrame: boolean }> {
    let sawDoneFrame = false;
    const response = await this.deps.api.openJobStream(target.jobId, cursor, signal);
    for await (const frame of readSseResponse(response)) {
      if (signal.aborted) break;
      if (frame.event === 'job_event') {
        const parsed = safeJson(frame.data);
        if (parsed) {
          const event = parsed as JobEventRecord;
          cursor = this.applyEvent(event, state, target);
          editor.set(render());
        }
      } else if (frame.event === 'job_done') {
        const parsed = safeJson(frame.data) as Record<string, unknown> | null;
        this.applyDone(parsed, state);
        editor.set(render());
        sawDoneFrame = true;
        break;
      } else if (frame.event === 'error') {
        throw new Error(`stream error frame: ${frame.data}`);
      }
      // Unknown frames are ignored on purpose: a new event type must not break
      // progress rendering for jobs that are already running.
    }
    return { cursor, sawDoneFrame };
  }

  /** Best-effort authoritative fill from `/v1/tasks/:id` after a broken stream. */
  private async enrichFromTask(target: JobTarget, state: MutableState): Promise<void> {
    try {
      const { task, jobs } = await this.deps.api.getTask(target.taskId);
      const job = jobs.find((entry) => entry.id === target.jobId);
      if (job) {
        if (!state.result && job.result) state.result = job.result;
        if (!state.error && job.error) state.error = job.error;
        if (isTerminalJobStatus(job.status)) state.status = job.status;
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        state.status = task.status;
        state.error = state.error ?? task.failureReason;
      }
    } catch (error) {
      this.deps.logger.warn('could not enrich a finished job from the task row', {
        taskId: target.taskId,
        error: describeError(error),
      });
    }
  }

  private async pollUntilDone(
    target: JobTarget,
    state: MutableState,
    render: () => string,
    editor: MessageEditor,
    cursor: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.clock.now() + this.deps.jobTimeoutMs;
    let polls = 0;
    while (!signal.aborted) {
      if (this.clock.now() > deadline) {
        state.error = state.error ?? 'timed out while waiting for the job to finish';
        state.status = 'failed';
        return;
      }
      try {
        const events = await this.deps.api.getJobEvents(target.jobId, cursor);
        for (const event of events) {
          cursor = this.applyEvent(event, state, target);
        }
        if (events.length > 0) {
          editor.set(render());
          if (isTerminalJobStatus(state.status)) return;
        }
        // The event trail carries no "still open" marker, so every few polls the
        // task row is authoritatively checked. This is what makes a job that
        // failed before writing a terminal event still reach a terminal state.
        polls += 1;
        if (polls % 3 === 0 || events.length === 0) {
          const { task, jobs } = await this.deps.api.getTask(target.taskId);
          const job = jobs.find((entry) => entry.id === target.jobId);
          if (job) {
            state.result = state.result ?? job.result;
            state.error = state.error ?? job.error;
            if (isTerminalJobStatus(job.status)) {
              state.status = job.status;
              editor.set(render());
              return;
            }
            if (isJobStatus(state.status)) state.status = job.status;
          } else if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
            state.status = task.status === 'succeeded' ? 'succeeded' : task.status === 'failed' ? 'failed' : 'cancelled';
            editor.set(render());
            return;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        this.deps.logger.warn('poll failed; will retry', {
          jobId: target.jobId,
          error: describeError(error),
        });
      }
      await this.clock.sleep(this.deps.pollIntervalMs);
    }
  }

  /** Fold one persisted event into the displayed state. Returns the new cursor. */
  applyEvent(event: JobEventRecord, state: MutableState, context: { taskId: string; jobId: string }): number {
    state.eventCount += 1;
    const payload = event.payload;
    switch (event.type) {
      case 'job.status': {
        const status = payload['status'];
        if (isJobStatus(status)) {
          state.status = status;
          if (status === 'running' || status === 'dispatched') state.approvalPending = false;
        }
        break;
      }
      case 'job.text': {
        const text = payload['text'];
        if (typeof text === 'string' && text.trim() !== '') {
          state.lastText = text;
          // A final text is the job's answer; keep it separate from the live feed.
          if (payload['final'] === true) state.result = text;
        }
        break;
      }
      case 'job.tool_call': {
        const tool = payload['tool'];
        if (typeof tool === 'string' && !state.toolCalls.includes(tool)) {
          state.toolCalls.push(tool);
        }
        break;
      }
      case 'job.log': {
        const level = payload['level'];
        const message = payload['message'];
        if (level === 'error' && typeof message === 'string') state.error = state.error ?? message;
        break;
      }
      case 'job.approval': {
        state.approvalPending = true;
        state.status = 'waiting_approval';
        const approvalId = payload['approvalId'];
        if (typeof approvalId === 'string') {
          this.deps.onApprovalRequested?.({
            taskId: context.taskId,
            jobId: context.jobId,
            approvalId,
          });
        }
        break;
      }
      default:
        break;
    }
    return Math.max(-1, event.seq);
  }

  private applyDone(payload: Record<string, unknown> | null, state: MutableState): void {
    if (!payload) return;
    const status = payload['status'];
    if (typeof status === 'string') state.status = status;
    const result = payload['result'];
    if (typeof result === 'string' && result.trim() !== '') state.result = result;
    const error = payload['error'];
    if (typeof error === 'string' && error.trim() !== '') state.error = error;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}