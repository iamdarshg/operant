/**
 * Routing: a plain message in an allowed channel is a request.
 *
 * These tests use the real `OperantApi` client over a faked `fetch`, so the
 * assertions are about the wire — method, path, bearer header and JSON body —
 * not about a stubbed method call.
 */
import { describe, expect, it } from 'vitest';
import { OperantApi } from '../src/api/client.js';
import { OperantBot, type BotApi } from '../src/bot/handler.js';
import { conversationIdForChannel } from '../src/bot/conversation.js';
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

function buildBot(options: {
  allowedUserIds?: string[];
  allowedChannelIds?: string[];
  editIntervalMs?: number;
} = {}) {
  const fetcher = makeFetch((call) => {
    if (call.method === 'POST' && call.url.includes('/v1/requests')) {
      return jsonResponse(202, acceptedResponse());
    }
    if (call.url.includes('/stream')) return sseResponse(successfulJobFrames());
    if (call.url.includes('/events')) return jsonResponse(200, { events: [] });
    if (call.url.includes('/v1/tasks/')) {
      return jsonResponse(200, { task: { id: 'task-1', status: 'succeeded' }, jobs: [] });
    }
    return jsonResponse(404, { error: 'not_found' });
  });
  const config = makeTestConfig({
    allowedUserIds: options.allowedUserIds ?? ['user-1'],
    allowedChannelIds: options.allowedChannelIds ?? [],
    editIntervalMs: options.editIntervalMs ?? 10,
  });
  const api = new OperantApi({
    base: config.apiBase,
    token: config.apiToken,
    fetchImpl: fetcher.fetchImpl,
    maxRetries: 0,
  });
  const bot = new OperantBot({
    config,
    api,
    logger: silentLogger(),
    approvals: makeApprovalSink(),
  });
  return { bot, fetcher, config };
}

describe('message routing', () => {
  it('posts a plain message to /v1/requests with origin, author and derived conversation', async () => {
    const { bot, fetcher } = buildBot();
    const message = new FakeIncomingMessage({
      channelId: 'chan-1',
      content: 'please make the failing test pass',
    });

    await bot.handleMessage(message);
    await bot.whenIdle();

    const posts = fetcher.matching('POST', '/v1/requests');
    expect(posts).toHaveLength(1);
    const call = posts[0]!;
    expect(call.json).toMatchObject({
      text: 'please make the failing test pass',
      origin: 'discord',
      requestedBy: 'user-1',
      conversationId: conversationIdForChannel('chan-1'),
    });
    // The bearer token from config is what authenticates the call.
    expect(call.headers['authorization']).toBe('Bearer test-api-token');
    expect(call.headers['content-type']).toBe('application/json');

    await bot.shutdown();
  });

  it('posts the "working" reply before it calls the control plane', async () => {
    let repliesWhenRequestWasSent = -1;
    const message = new FakeIncomingMessage({ channelId: 'chan-2', content: 'build the thing' });
    const fetcher = makeFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/v1/requests')) {
        repliesWhenRequestWasSent = message.replies.length;
        return jsonResponse(202, acceptedResponse());
      }
      if (call.url.includes('/stream')) return sseResponse(successfulJobFrames('done'));
      return jsonResponse(404, { error: 'not_found' });
    });
    const config = makeTestConfig({ editIntervalMs: 10 });
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

    await bot.handleMessage(message);
    expect(repliesWhenRequestWasSent).toBe(1);
    expect(message.replies[0]!.initial?.content).toContain('Request accepted');
    await bot.shutdown();
  });

  it('edits the working reply into the completed result', async () => {
    const { bot } = buildBot();
    const message = new FakeIncomingMessage({ channelId: 'chan-3', content: 'say RESTART-SURVIVED' });

    await bot.handleMessage(message);
    await bot.whenIdle();

    const reply = message.replies[0]!;
    expect(reply.edits.length).toBeGreaterThan(0);
    expect(reply.lastContent).toContain('Work completed');
    expect(reply.lastContent).toContain('RESTART-SURVIVED');
    expect(reply.lastContent).toContain('status succeeded');

    await bot.shutdown();
  });

  it('does not block the gateway while a job is still streaming', async () => {
    const api: BotApi = {
      createRequest: async () => ({
        taskId: 'task-long',
        jobId: 'job-long',
        agentId: 'engineering',
        status: 'queued',
        eventsUrl: '/v1/jobs/job-long/events',
        streamUrl: '/v1/jobs/job-long/stream',
      }),
      transcribe: async () => {
        throw new Error('not used');
      },
      openJobStream: (_jobId, _after, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted by shutdown')));
        }),
      getJobEvents: async () => [],
      getTask: async () => ({
        task: {
          id: 'task-long',
          intent: 'x',
          title: 'x',
          status: 'running',
          requestedBy: 'user-1',
          origin: 'discord',
          conversationId: null,
          progressNote: null,
          failureReason: null,
          createdAt: null,
          finishedAt: null,
        },
        jobs: [],
      }),
    };
    const bot = new OperantBot({
      config: makeTestConfig(),
      api,
      logger: silentLogger(),
      approvals: makeApprovalSink(),
    });
    const message = new FakeIncomingMessage({ content: 'long running job' });

    const raced = await Promise.race([
      bot.handleMessage(message).then(() => 'returned' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ]);
    expect(raced).toBe('returned');
    expect(message.replies[0]!.initial?.content).toContain('Request accepted');

    await bot.shutdown();
  });

  it('refuses an unauthorized user and makes no API call at all', async () => {
    const fetcher = makeFetch(() => {
      throw new Error('the control plane must not be called for an unauthorized user');
    });
    const config = makeTestConfig({ allowedUserIds: ['user-1'], allowedChannelIds: [] });
    const bot = new OperantBot({
      config,
      api: new OperantApi({
        base: config.apiBase,
        token: config.apiToken,
        fetchImpl: fetcher.fetchImpl,
      }),
      logger: silentLogger(),
      approvals: makeApprovalSink(),
    });
    const message = new FakeIncomingMessage({
      authorId: 'mallory',
      authorName: 'mallory',
      content: 'delete production',
      channelId: 'chan-1',
    });

    await bot.handleMessage(message);

    expect(fetcher.calls).toHaveLength(0);
    expect(message.replies).toHaveLength(1);
    expect(message.lastReply!.initial?.content).toContain('not on the allow-list');
    expect(message.lastReply!.initial?.content).toContain('Nothing was sent');
    await bot.shutdown();
  });

  it('refuses everyone when no allow-list is configured (fail closed)', async () => {
    const fetcher = makeFetch(() => jsonResponse(202, acceptedResponse()));
    const config = makeTestConfig({ allowedUserIds: [], allowedChannelIds: [] });
    const bot = new OperantBot({
      config,
      api: new OperantApi({
        base: config.apiBase,
        token: config.apiToken,
        fetchImpl: fetcher.fetchImpl,
      }),
      logger: silentLogger(),
      approvals: makeApprovalSink(),
    });

    await bot.handleMessage(new FakeIncomingMessage({ content: 'anything' }));

    expect(fetcher.calls).toHaveLength(0);
    await bot.shutdown();
  });

  it('treats /status as an affordance, not a request', async () => {
    const { bot, fetcher } = buildBot();
    const message = new FakeIncomingMessage({ content: '/status' });

    await bot.handleMessage(message);

    expect(fetcher.calls).toHaveLength(0);
    expect(message.lastReply!.initial?.content).toContain('Nothing has been asked in this channel yet');
    await bot.shutdown();
  });

  it('explains MESSAGE_CONTENT instead of silently ignoring an empty message', async () => {
    const { bot, fetcher } = buildBot();
    const message = new FakeIncomingMessage({ content: '' });

    await bot.handleMessage(message);

    expect(fetcher.calls).toHaveLength(0);
    expect(message.lastReply!.initial?.content).toContain('MESSAGE_CONTENT');
    expect(message.lastReply!.initial?.content).toContain('voice note');
    await bot.shutdown();
  });

  it('replies with a clear notice when the control plane is down, and stays up', async () => {
    const fetcher = makeFetch(() => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    const config = makeTestConfig({ editIntervalMs: 10 });
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
    const message = new FakeIncomingMessage({ content: 'run the build' });

    await bot.handleMessage(message);

    expect(message.replies).toHaveLength(1);
    expect(message.lastReply!.lastContent).toContain('could not reach the Operant control plane');
    // A second message still works: the failure did not corrupt state.
    await bot.handleMessage(new FakeIncomingMessage({ content: 'try again' }));
    expect(fetcher.count('POST', '/v1/requests')).toBe(2);
    await bot.shutdown();
  });

  it('does not treat a non-audio attachment as a voice message', async () => {
    const { bot, fetcher } = buildBot();
    const message = new FakeIncomingMessage({
      content: '',
      attachments: [
        { id: 'a1', name: 'screenshot.png', url: 'https://cdn.example/x.png', size: 10, contentType: 'image/png' },
      ],
    });

    await bot.handleMessage(message);

    expect(fetcher.calls).toHaveLength(0);
    expect(message.lastReply!.initial?.content).toContain('MESSAGE_CONTENT');
  });
});