/**
 * Conversation continuity.
 *
 * The requirement has two halves and both are tested: the id must be a stable
 * function of the Discord channel/thread, and a follow-up in a channel that
 * already produced a result must carry that result into the new request text.
 */
import { describe, expect, it } from 'vitest';
import { OperantApi } from '../src/api/client.js';
import { OperantBot } from '../src/bot/handler.js';
import {
  ConversationStore,
  conversationIdForChannel,
  pendingNotice,
  withContinuationContext,
  type ConversationTurn,
} from '../src/bot/conversation.js';
import { silentLogger } from '../src/logger.js';
import {
  FakeIncomingMessage,
  acceptedResponse,
  jsonResponse,
  makeApprovalSink,
  makeFetch,
  makeTestConfig,
  sseResponse,
  successfulJobFrames,
} from './support/fakes.js';

const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  taskId: 'task-1',
  jobId: 'job-1',
  status: 'succeeded',
  intent: 'add a health endpoint',
  result: 'Added GET /v1/health and a test that proves it returns 200.',
  at: 1_000,
  ...overrides,
});

describe('conversationId derivation', () => {
  it('is a pure function of the channel id', () => {
    expect(conversationIdForChannel('chan-1')).toBe('discord:chan-1');
    expect(conversationIdForChannel('chan-1')).toBe(conversationIdForChannel('chan-1'));
  });

  it('separates channels and threads from one another', () => {
    expect(conversationIdForChannel('chan-1')).not.toBe(conversationIdForChannel('chan-2'));
    // A thread has its own channel id in Discord, so it gets its own conversation.
    expect(conversationIdForChannel('thread-1')).not.toBe(conversationIdForChannel('chan-1'));
  });

  it('stays within the API id limits (1..64 chars)', () => {
    const id = conversationIdForChannel('1234567890123456789');
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});

describe('ConversationStore', () => {
  it('returns the last finished turn and ignores in-flight ones', () => {
    const store = new ConversationStore();
    store.remember('c', turn({ taskId: 'a', status: 'running', result: null }));
    expect(store.lastFinished('c')).toBeNull();

    store.remember('c', turn({ taskId: 'b', result: 'done B' }));
    expect(store.lastFinished('c')?.taskId).toBe('b');

    store.remember('c', turn({ taskId: 'z', status: 'failed', result: 'boom' }));
    // A failed turn is not context for the next request.
    expect(store.lastFinished('c')?.taskId).toBe('b');
    expect(store.last('c')?.taskId).toBe('z');
  });

  it('replaces a turn rather than duplicating it when the same task is recorded twice', () => {
    const store = new ConversationStore();
    store.remember('c', turn({ taskId: 'a', status: 'queued', result: null }));
    store.remember('c', turn({ taskId: 'a', status: 'succeeded', result: 'final' }));
    expect(store.list('c')).toHaveLength(1);
    expect(store.list('c')[0]!.status).toBe('succeeded');
  });

  it('seeds from control-plane tasks after a restart', () => {
    const store = new ConversationStore();
    const added = store.hydrate('discord:chan-1', [
      {
        id: 'task-9',
        intent: 'older work',
        title: 'older work',
        status: 'succeeded',
        requestedBy: 'user-1',
        origin: 'discord',
        conversationId: 'discord:chan-1',
        progressNote: null,
        failureReason: null,
        createdAt: '2026-11-15T10:00:00.000Z',
        finishedAt: null,
      },
    ]);
    expect(added).toBe(1);
    expect(store.list('discord:chan-1')).toHaveLength(1);
    // Hydration without a job id is still enough to recognise the task.
    expect(store.hydrate('discord:chan-1', [])).toBe(0);
  });
});

describe('withContinuationContext', () => {
  it('does nothing when there is no prior result', () => {
    expect(withContinuationContext('next step', null)).toBe('next step');
    expect(withContinuationContext('next step', turn({ result: null }))).toBe('next step');
  });

  it('injects the earlier request and its outcome ahead of the new text', () => {
    const merged = withContinuationContext('now add a test for it', turn());
    expect(merged).toContain('Conversation context');
    expect(merged).toContain('add a health endpoint');
    expect(merged).toContain('GET /v1/health');
    expect(merged.endsWith('now add a test for it')).toBe(true);
  });

  it('keeps the user text intact when the combined request would exceed the API limit', () => {
    const long = 'x'.repeat(7_900);
    const merged = withContinuationContext(long, turn());
    expect(merged).toBe(long);
  });

  it('names the in-flight task in the pending notice', () => {
    expect(pendingNotice(turn({ taskId: 'abcdef1234', status: 'running' }))).toContain('abcdef12');
  });
});

describe('conversation continuity end to end', () => {
  function build() {
    const fetcher = makeFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/v1/requests')) {
        return jsonResponse(202, acceptedResponse());
      }
      if (call.url.includes('/stream')) return sseResponse(successfulJobFrames('Result number one'));
      return jsonResponse(404, { error: 'not_found' });
    });
    const config = makeTestConfig({ editIntervalMs: 5 });
    const bot = new OperantBot({
      config,
      api: new OperantApi({
        base: config.apiBase,
        token: config.apiToken,
        fetchImpl: fetcher.fetchImpl,
        maxRetries: 0,
      }),
      logger: silentLogger(),
      approvals: makeApprovalSink(),
    });
    return { bot, fetcher };
  }

  it('sends a follow-up with the earlier result as context, in the same conversation', async () => {
    const { bot, fetcher } = build();

    await bot.handleMessage(new FakeIncomingMessage({ channelId: 'chan-1', content: 'build a health endpoint' }));
    await bot.whenIdle();

    await bot.handleMessage(new FakeIncomingMessage({ channelId: 'chan-1', content: 'now document it' }));
    await bot.whenIdle();

    const posts = fetcher.matching('POST', '/v1/requests');
    expect(posts).toHaveLength(2);
    const first = posts[0]!.json as Record<string, unknown>;
    const second = posts[1]!.json as Record<string, unknown>;

    expect(first['conversationId']).toBe('discord:chan-1');
    expect(second['conversationId']).toBe('discord:chan-1');
    expect(String(first['text'])).toBe('build a health endpoint');
    expect(String(second['text'])).toContain('Conversation context');
    expect(String(second['text'])).toContain('Result number one');
    expect(String(second['text']).endsWith('now document it')).toBe(true);

    await bot.shutdown();
  });

  it('does not leak one channel\'s context into another channel', async () => {
    const { bot, fetcher } = build();

    await bot.handleMessage(new FakeIncomingMessage({ channelId: 'chan-1', content: 'work in one' }));
    await bot.whenIdle();
    await bot.handleMessage(new FakeIncomingMessage({ channelId: 'chan-2', content: 'work in two' }));
    await bot.whenIdle();

    const posts = fetcher.matching('POST', '/v1/requests');
    const second = posts[1]!.json as Record<string, unknown>;
    expect(second['conversationId']).toBe('discord:chan-2');
    expect(String(second['text'])).not.toContain('Conversation context');

    await bot.shutdown();
  });
});