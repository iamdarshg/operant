/**
 * SSE → message edits.
 *
 * Two things are proven here, and the second one is the reason this bot exists:
 *
 *  1. events update the *same* message in place, and the update rate is capped;
 *  2. when SSE is unavailable the bot falls back to polling instead of leaving
 *     the user with a message that never changes.
 *
 * Timers are faked, so the interval assertion is exact rather than approximate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRunner } from '../src/bot/job-runner.js';
import { MessageEditor } from '../src/bot/rate-limit.js';
import { parseSseBlock, readSseStream } from '../src/api/sse.js';
import { silentLogger } from '../src/logger.js';
import {
  FakeMessage,
  jobDoneFrame,
  jobEventFrame,
  manualSse,
} from './support/fakes.js';
import type { JobEventRecord, JobRecord, TaskRecord } from '../src/api/types.js';

afterEach(() => {
  vi.useRealTimers();
});

const taskRow = (status = 'succeeded'): TaskRecord => ({
  id: 'task-1',
  intent: 'do the work',
  title: 'do the work',
  status,
  requestedBy: 'user-1',
  origin: 'discord',
  conversationId: 'discord:chan-1',
  progressNote: null,
  failureReason: null,
  createdAt: null,
  finishedAt: null,
});

const jobRow = (status = 'succeeded', result: string | null = 'job result'): JobRecord => ({
  id: 'job-1',
  taskId: 'task-1',
  kind: 'execute',
  status,
  title: 'job',
  result,
  error: null,
  agentId: 'engineering',
  finishedAt: null,
});

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): JobEventRecord => ({ seq, type, payload, at: null });

describe('edit batching', () => {
  it('coalesces a burst of SSE events into at most one edit per interval', async () => {
    vi.useFakeTimers();
    const stream = manualSse();
    const runner = new JobRunner({
      api: {
        openJobStream: async () => stream.response,
        getJobEvents: async () => [],
        getTask: async () => ({ task: taskRow(), jobs: [jobRow()] }),
      },
      logger: silentLogger(),
      editIntervalMs: 1_500,
      pollIntervalMs: 1_000,
      jobTimeoutMs: 60_000,
    });
    const message = new FakeMessage('m-1');
    const tracking = runner.track({
      taskId: 'task-1',
      jobId: 'job-1',
      conversationId: 'discord:chan-1',
      intent: 'do the work',
      agentId: 'engineering',
      message,
    });
    await vi.advanceTimersByTimeAsync(1);

    stream.send(jobEventFrame(0, 'job.status', { status: 'running' }));
    stream.send(jobEventFrame(1, 'job.text', { text: 'alpha' }));
    stream.send(jobEventFrame(2, 'job.tool_call', { tool: 'bash' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(message.edits).toHaveLength(0);

    // First edit lands exactly at the interval.
    await vi.advanceTimersByTimeAsync(1_400);
    expect(message.edits).toHaveLength(1);
    expect(message.edits[0]!.content).toContain('Background activity');
    expect(message.edits[0]!.content).toContain('bash');

    // Three more events inside one window collapse into the single next edit.
    stream.send(jobEventFrame(3, 'job.text', { text: 'beta' }));
    stream.send(jobEventFrame(4, 'job.text', { text: 'gamma' }));
    stream.send(jobEventFrame(5, 'job.text', { text: 'delta' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(message.edits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(message.edits).toHaveLength(2);
    expect(message.edits[1]!.content).toContain('delta');

    stream.send(jobDoneFrame({ status: 'succeeded', result: 'all done', error: null }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(message.edits).toHaveLength(3);
    expect(message.edits[2]!.content).toContain('Work completed');
    expect(message.edits[2]!.content).toContain('all done');

    const outcome = await tracking;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.result).toBe('all done');
    expect(outcome.eventCount).toBe(6);

    // The invariant, measured on the recorded edit timestamps.
    const gaps = message.editTimes.slice(1).map((at, index) => at - message.editTimes[index]!);
    expect(gaps.length).toBe(2);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1_500);
    // Six events, three edits: coalescing actually happened.
    expect(message.edits.length).toBeLessThan(outcome.eventCount);
  });

  it('renders a failure with its reason', async () => {
    vi.useFakeTimers();
    const stream = manualSse();
    const runner = new JobRunner({
      api: {
        openJobStream: async () => stream.response,
        getJobEvents: async () => [],
        getTask: async () => ({ task: taskRow('failed'), jobs: [jobRow('failed', null)] }),
      },
      logger: silentLogger(),
      editIntervalMs: 1_000,
      pollIntervalMs: 500,
      jobTimeoutMs: 60_000,
    });
    const message = new FakeMessage('m-2');
    const tracking = runner.track({
      taskId: 'task-1',
      jobId: 'job-1',
      conversationId: 'discord:chan-1',
      intent: 'do the work',
      agentId: null,
      message,
    });
    await vi.advanceTimersByTimeAsync(1);

    stream.send(jobEventFrame(0, 'job.status', { status: 'running' }));
    stream.send(jobEventFrame(1, 'job.status', { status: 'failed' }));
    stream.send(jobDoneFrame({ status: 'failed', result: null, error: 'dsh exited with code 1' }));
    await vi.advanceTimersByTimeAsync(1_000);

    await tracking;
    expect(message.lastContent).toContain('Work failed');
    expect(message.lastContent).toContain('dsh exited with code 1');
  });
});

describe('polling fallback', () => {
  it('polls /v1/jobs/:id/events when the SSE stream is unavailable', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const runner = new JobRunner({
      api: {
        openJobStream: async () => {
          throw new Error('proxy closed the stream');
        },
        getJobEvents: async () => {
          polls += 1;
          return [
            event(0, 'job.status', { status: 'running' }),
            event(1, 'job.text', { text: 'polled answer', final: true }),
            event(2, 'job.status', { status: 'succeeded' }),
          ];
        },
        getTask: async () => ({ task: taskRow(), jobs: [jobRow()] }),
      },
      logger: silentLogger(),
      editIntervalMs: 1_000,
      pollIntervalMs: 500,
      jobTimeoutMs: 60_000,
    });
    const message = new FakeMessage('m-3');
    const tracking = runner.track({
      taskId: 'task-1',
      jobId: 'job-1',
      conversationId: 'discord:chan-1',
      intent: 'do the work',
      agentId: 'engineering',
      message,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await tracking;

    expect(outcome.status).toBe('succeeded');
    expect(outcome.result).toBe('polled answer');
    expect(message.lastContent).toContain('Work completed');
    expect(message.lastContent).toContain('polled answer');
  });
});

describe('rate-limit handling', () => {
  it('honours retry-after from a 429 before the next edit', async () => {
    vi.useFakeTimers();
    const message = new FakeMessage('m-4', undefined, {
      failures: 1,
      error: { status: 429, retryAfter: 2_000 },
    });
    const editor = new MessageEditor(message, { intervalMs: 1_500 });

    editor.set('first state');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(message.attempts).toBe(1);
    expect(message.edits).toHaveLength(0);

    // The interval alone would allow an edit at 3_000ms; the 429 pushes it to 3_500ms.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(message.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(message.attempts).toBe(2);
    expect(message.edits).toHaveLength(1);
    expect(message.edits[0]!.content).toBe('first state');

    editor.stop();
  });

  it('applies a retry-after gate that is longer than the edit interval', async () => {
    vi.useFakeTimers();
    const message = new FakeMessage('m-5', undefined, {
      failures: 1,
      error: { status: 429, retryAfter: 5_000 },
    });
    const editor = new MessageEditor(message, { intervalMs: 1_500 });
    editor.set('only state');
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(message.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(message.edits).toHaveLength(1);
    editor.stop();
  });
});

describe('SSE parsing', () => {
  it('drops keepalive comments and defaults the event name', () => {
    expect(parseSseBlock(': keepalive')).toBeNull();
    expect(parseSseBlock('data: {"a":1}')).toEqual({ event: 'message', data: '{"a":1}' });
    expect(parseSseBlock('event: job_done\ndata: {"ok":true}')).toEqual({
      event: 'job_done',
      data: '{"ok":true}',
    });
    expect(parseSseBlock('event: job_done\nid: 7\n\nretry: 10')).toBeNull();
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: job_e'));
        controller.enqueue(encoder.encode('vent\ndata: {"seq":1}\n\nevent: job_done\n'));
        controller.enqueue(encoder.encode('data: {"status":"succeeded"}\n\n'));
        controller.close();
      },
    });
    const frames: { event: string; data: string }[] = [];
    for await (const frame of readSseStream(stream)) frames.push(frame);
    expect(frames).toEqual([
      { event: 'job_event', data: '{"seq":1}' },
      { event: 'job_done', data: '{"status":"succeeded"}' },
    ]);
  });
});