/**
 * Contract tests for the pieces where a silent regression would be expensive:
 * secret redaction (leaks) and DSH event mapping (the whole event trail).
 */
import { describe, it, expect } from 'vitest';
import { redact, preview, REDACTED } from './events.js';
import { CreateRequestInput, TaskStatus } from './schema.js';

// The API treats exactly these as terminal; a drift here would leave tasks
// spinning forever in the UI.
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

describe('redaction', () => {
  it('drops values under secret-looking keys at any depth', () => {
    const out = redact({
      apiKey: 'abc',
      nested: { authorization: 'Bearer xyz', token: 'shh', keep: 'visible' },
      list: [{ password: 'p' }],
    }) as Record<string, unknown>;
    expect(out['apiKey']).toBe(REDACTED);
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['authorization']).toBe(REDACTED);
    expect(nested['token']).toBe(REDACTED);
    expect(nested['keep']).toBe('visible');
    expect((out['list'] as Record<string, unknown>[])[0]!['password']).toBe(REDACTED);
  });

  it('scrubs token-shaped strings inside ordinary values', () => {
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
    const out = redact(`header ${jwt} trailing`) as string;
    expect(out).not.toContain('eyJa');
    expect(out).toContain(REDACTED);
  });

  it('leaves normal text untouched', () => {
    expect(redact('the build failed on step 3')).toBe('the build failed on step 3');
  });

  it('does not recurse forever on deep structures', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});

describe('preview', () => {
  it('marks truncation and bounds length', () => {
    const long = 'x'.repeat(2000);
    const p = preview(long, 100);
    expect(p.length).toBeLessThan(220);
    expect(p).toContain('truncated');
  });
  it('returns short text unchanged', () => {
    expect(preview('short', 100)).toBe('short');
  });
});

describe('request contract', () => {
  it('accepts a minimal request and rejects an empty intent', () => {
    expect(CreateRequestInput.safeParse({ text: 'do it', origin: 'dashboard', requestedBy: 'u' }).success).toBe(true);
    expect(CreateRequestInput.safeParse({ text: '', origin: 'dashboard', requestedBy: 'u' }).success).toBe(false);
  });

  it('rejects an unknown origin', () => {
    expect(CreateRequestInput.safeParse({ text: 'x', origin: 'carrier-pigeon', requestedBy: 'u' }).success).toBe(false);
  });

  it('enumerates every terminal status the API relies on', () => {
    for (const s of TERMINAL) expect(TaskStatus.safeParse(s).success).toBe(true);
  });
});
