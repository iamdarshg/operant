/**
 * Tests for the one DSH→Operant event mapper.
 *
 * These assert against the event shapes observed from real `dsh --json` runs
 * (session / status / thinking / text / tool_call / tool_result / final / error),
 * so a runner upgrade that changes a field fails here rather than silently
 * producing an empty event trail.
 */
import { describe, it, expect } from 'vitest';
import { REDACTED } from '@operant/core';
import { normalize, safeEnv } from './index.js';

describe('agent child environment (security: no control-plane credentials)', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    NODE_ENV: 'production',
    SURPLUS_API_KEY: 'provider-key-is-expected',
    // These must never reach an agent.
    OPERANT_BOT_TOKEN: 'control-plane-bearer',
    DATABASE_URL: 'postgres://user:pw@host/db',
    OPERANT_SESSION_SECRET: 'session-secret',
    DISCORD_BOT_TOKEN: 'discord-token',
    GOOGLE_APPLICATION_CREDENTIALS: '/secrets/gcp.json',
  };

  it('withholds the control-plane bearer and the database URL', () => {
    const env = safeEnv(parent);
    expect(env['OPERANT_BOT_TOKEN']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['OPERANT_SESSION_SECRET']).toBeUndefined();
    expect(env['DISCORD_BOT_TOKEN']).toBeUndefined();
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
  });

  it('still passes what the agent legitimately needs', () => {
    const env = safeEnv(parent);
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/u');
    expect(env['SURPLUS_API_KEY']).toBe('provider-key-is-expected');
  });

  it('does not mutate the parent environment', () => {
    const copy = { ...parent };
    safeEnv(parent);
    expect(parent).toEqual(copy);
  });
});

describe('normalize: real DSH event shapes', () => {
  it('session -> job.status(dispatched) carrying the resumable session id', () => {
    const e = normalize({ type: 'session', sessionId: 'session-77e85d8b', cwd: '/app/data/jobs/x' }, 0);
    expect(e?.type).toBe('job.status');
    expect(e?.payload['status']).toBe('dispatched');
    expect(e?.payload['sessionId']).toBe('session-77e85d8b');
  });

  it('status/turn_start -> running', () => {
    const e = normalize({ type: 'status', phase: 'turn_start', turn: 1 }, 1);
    expect(e?.type).toBe('job.status');
    expect(e?.payload['status']).toBe('running');
  });

  it('status/step_end with usage -> job.usage with the real token counts', () => {
    const e = normalize({ type: 'status', phase: 'step_end', step: 1, usage: { inputTokens: 673, outputTokens: 175 } }, 2);
    expect(e?.type).toBe('job.usage');
    expect(e?.payload).toMatchObject({ promptTokens: 673, completionTokens: 175 });
  });

  it('status/turn_end carries the reason kind', () => {
    const e = normalize({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }, 3);
    expect(e?.type).toBe('job.status');
    expect(e?.payload['reasonKind']).toBe('completed');
  });

  it('tool_call -> job.tool_call and redacts secret-shaped argument keys', () => {
    const e = normalize(
      { type: 'tool_call', callId: 'c1', tool: 'web_search', input: { queries: ['x'], apiKey: 'should-not-persist' } },
      4,
    );
    expect(e?.type).toBe('job.tool_call');
    expect(e?.payload['tool']).toBe('web_search');
    const args = e?.payload['args'] as Record<string, unknown>;
    expect(args['queries']).toEqual(['x']);
    expect(args['apiKey']).toBe(REDACTED);
  });

  it('tool_result completed vs error sets the ok flag honestly', () => {
    const ok = normalize({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'fine' }, 5);
    expect(ok?.type).toBe('job.tool_result');
    expect(ok?.payload['ok']).toBe(true);

    const bad = normalize({ type: 'tool_result', callId: 'c2', status: 'error', error: 'boom' }, 6);
    expect(bad?.payload['ok']).toBe(false);
  });

  it('final -> job.text with final:true and the answer verbatim', () => {
    const e = normalize({ type: 'final', text: 'OPERANT-SLICE-OK', reason: { kind: 'completed' } }, 7);
    expect(e?.type).toBe('job.text');
    expect(e?.payload['text']).toBe('OPERANT-SLICE-OK');
    expect(e?.payload['final']).toBe(true);
  });

  it('thinking is recorded as a log line, not as the answer', () => {
    const e = normalize({ type: 'thinking', text: 'considering the options…' }, 8);
    expect(e?.type).toBe('job.log');
    expect(e?.payload['level']).toBe('debug');
  });

  it('error -> job.log at error level', () => {
    const e = normalize({ type: 'error', message: 'MISSING_CREDENTIAL: no API key' }, 9);
    expect(e?.type).toBe('job.log');
    expect(e?.payload['level']).toBe('error');
  });

  it('unknown event types are preserved as logs instead of dropped', () => {
    const e = normalize({ type: 'future_event', detail: 'x' }, 10);
    expect(e?.type).toBe('job.log');
    expect(e?.payload['message']).toContain('future_event');
  });

  it('truncates a huge tool result instead of persisting it whole', () => {
    const e = normalize({ type: 'tool_result', callId: 'c3', status: 'completed', result: 'z'.repeat(5000) }, 11);
    const preview = e?.payload['preview'] as string;
    expect(preview.length).toBeLessThan(1100);
    expect(preview).toContain('truncated');
  });
});