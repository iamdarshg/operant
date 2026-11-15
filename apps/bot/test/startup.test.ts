/**
 * Startup and `--check`.
 *
 * The contract under test: a missing Discord token is a *clean* exit 1 with the
 * exact variable named — not a thrown stack trace — and `--check` reports the
 * truth about configuration and the control plane without opening a gateway.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { run as runAgain } from '../src/index.js';
import { DOCUMENTED_INTENT_MASK, MESSAGE_CONTENT_NOTE } from '../src/discord/intents.js';
import { createLogger } from '../src/logger.js';
import { jsonResponse, makeFetch } from './support/fakes.js';

function capture() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
    text: () => lines.join('\n'),
  };
}

const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  ...extra,
});

const VALID_TOKEN = `${'M'.repeat(24)}.${'a'.repeat(6)}.${'z'.repeat(27)}`;

function healthyApi(fetcherCalls: { count: number } = { count: 0 }) {
  return makeFetch((call) => {
    fetcherCalls.count += 1;
    if (call.url.includes('/v1/health')) {
      return jsonResponse(200, { state: 'healthy', checks: [{ name: 'postgres', state: 'healthy' }], dshProfile: 'operant' });
    }
    if (call.url.includes('/v1/tasks')) return jsonResponse(200, { tasks: [] });
    return jsonResponse(404, { error: 'not_found' });
  });
}

describe('missing token', () => {
  it('exits 1 and names DISCORD_BOT_TOKEN, without throwing or calling the network', async () => {
    const out = capture();
    const err = capture();
    let networkCalls = 0;

    const code = await run([], {
      env: env(),
      stdout: out.write,
      stderr: err.write,
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse(500, { error: 'should not be called' });
      },
      registerSignals: false,
    });

    expect(code).toBe(1);
    expect(networkCalls).toBe(0);
    expect(err.text()).toContain('DISCORD_BOT_TOKEN');
    expect(err.text()).toContain('gateway cannot log in');
    expect(err.text()).toContain('refusing to start');
    // No gateway handle was ever produced.
    expect(out.text()).not.toContain('operant bot is running');
  });

  it('never throws the rejection to the caller', async () => {
    const err = capture();
    const attempt = run([], { env: env(), stdout: () => {}, stderr: err.write, registerSignals: false });
    await expect(attempt).resolves.toBe(1);
  });
});

describe('--check', () => {
  it('reports config ok, API reachable, token missing and exits 1', async () => {
    const out = capture();
    const fetcher = healthyApi();

    const code = await run(['--check'], {
      env: env(),
      stdout: out.write,
      stderr: out.write,
      fetchImpl: fetcher.fetchImpl,
    });

    expect(code).toBe(1);
    const text = out.text();
    expect(text).toContain('config ok');
    expect(text).toContain('API reachable');
    expect(text).toContain('DISCORD_BOT_TOKEN missing');
    expect(text).toContain('token missing');
    expect(text).toMatch(/NOT RUNNABLE \(exit 1\)/);
    // Health + auth probe, and nothing else.
    expect(fetcher.count('GET', '/v1/health')).toBe(1);
    expect(fetcher.count('GET', '/v1/tasks')).toBe(1);
  });

  it('exits 0 when the API answers, the bearer is accepted, and a token is present', async () => {
    const out = capture();
    const fetcher = healthyApi();

    const code = await run(['--check'], {
      env: env({ DISCORD_BOT_TOKEN: VALID_TOKEN }),
      stdout: out.write,
      stderr: out.write,
      fetchImpl: fetcher.fetchImpl,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain('RUNNABLE (exit 0)');
    const tasksCall = fetcher.matching('GET', '/v1/tasks')[0]!;
    expect(tasksCall.headers['authorization']).toBe('Bearer devtoken-operant-cloud-0123456789');
  });

  it('exits 1 when the control plane is unreachable', async () => {
    const out = capture();
    const code = await run(['--check'], {
      env: env({ DISCORD_BOT_TOKEN: VALID_TOKEN }),
      stdout: out.write,
      stderr: out.write,
      fetchImpl: async () => {
        throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8787');
      },
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('API unreachable');
    expect(out.text()).toContain('NOT RUNNABLE');
  });

  it('exits 1 when the bearer token is rejected', async () => {
    const out = capture();
    const fetcher = makeFetch((call) => {
      if (call.url.includes('/v1/health')) return jsonResponse(200, { state: 'healthy' });
      return jsonResponse(401, { error: 'unauthorized' });
    });
    const code = await run(['--check'], {
      env: env({ DISCORD_BOT_TOKEN: VALID_TOKEN }),
      stdout: out.write,
      stderr: out.write,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('API auth rejected');
    expect(out.text()).toContain('NOT RUNNABLE');
  });

  it('documents the intents and the MESSAGE_CONTENT degradation', async () => {
    const out = capture();
    await run(['--check'], {
      env: env(),
      stdout: out.write,
      stderr: out.write,
      fetchImpl: healthyApi().fetchImpl,
    });
    expect(out.text()).toContain('GUILDS | GUILD_MESSAGES | GUILD_VOICE_STATES');
    expect(out.text()).toContain(String(DOCUMENTED_INTENT_MASK));
    expect(out.text()).toContain(MESSAGE_CONTENT_NOTE);
  });
});

describe('production mode', () => {
  it('refuses to fall back to development API values', async () => {
    const out = capture();
    const err = capture();
    const code = await run([], {
      env: env({ NODE_ENV: 'production', DISCORD_BOT_TOKEN: VALID_TOKEN }),
      stdout: out.write,
      stderr: err.write,
      registerSignals: false,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('OPERANT_API_BASE');
    expect(err.text()).toContain('OPERANT_BOT_TOKEN');
  });
});

describe('gateway startup', () => {
  it('exits 1 cleanly when Discord rejects the login', async () => {
    const out = capture();
    const err = capture();
    const code = await run([], {
      env: env({ DISCORD_BOT_TOKEN: VALID_TOKEN }),
      stdout: out.write,
      stderr: err.write,
      registerSignals: false,
      startGateway: async () => {
        throw new Error('An invalid token was provided.');
      },
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('Discord login failed');
  });

  it('starts the gateway with the configured token and hands over handlers', async () => {
    const out = capture();
    const received: { token: string; hasMessageHandler: boolean; hasInteractionHandler: boolean } = {
      token: '',
      hasMessageHandler: false,
      hasInteractionHandler: false,
    };
    let shutdown: (() => Promise<void>) | null = null;
    let stopped = false;

    const code = await run([], {
      env: env({ DISCORD_BOT_TOKEN: VALID_TOKEN, DISCORD_ALLOWED_USER_IDS: 'user-1' }),
      stdout: out.write,
      stderr: out.write,
      logger: createLogger('info', out.write),
      registerSignals: false,
      fetchImpl: healthyApi().fetchImpl,
      onStarted: (fn) => {
        shutdown = fn;
      },
      startGateway: async (handlers, token) => {
        received.token = token;
        received.hasMessageHandler = typeof handlers.onMessage === 'function';
        received.hasInteractionHandler = typeof handlers.onInteraction === 'function';
        return {
          stop: async () => {
            stopped = true;
          },
        };
      },
    });

    expect(code).toBe(0);
    expect(received.token).toBe(VALID_TOKEN);
    expect(received.hasMessageHandler).toBe(true);
    expect(received.hasInteractionHandler).toBe(true);
    expect(out.text()).toContain('operant bot is running');

    expect(shutdown).not.toBeNull();
    await shutdown!();
    expect(stopped).toBe(true);
  });
});

describe('module surface', () => {
  it('exports a single stable run() entry point', () => {
    expect(runAgain).toBe(run);
  });
});