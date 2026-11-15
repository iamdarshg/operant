/**
 * The proxy allow-list is a security boundary: every path it forwards is
 * reachable by any browser that can load the dashboard, with the bearer token
 * attached server-side. These tests pin what is reachable and — more importantly —
 * what is not.
 */
import { describe, it, expect } from 'vitest';
import { isProxied } from './proxy-policy.js';

const ID = '26fd1310-3e1d-433e-8f72-14e6b3f07418';

describe('allow-listed paths are reachable', () => {
  const allowed: [('GET' | 'POST' | 'DELETE'), string[]][] = [
    ['GET', ['health']],
    ['GET', ['tasks']],
    ['GET', ['tasks', ID]],
    ['GET', ['tasks', ID, 'artifacts']],
    ['GET', ['artifacts', ID, 'download']],
    ['GET', ['jobs', ID]],
    ['GET', ['jobs', ID, 'events']],
    ['GET', ['jobs', ID, 'stream']],
    ['GET', ['memory', 'search']],
    ['GET', ['agents']],
    ['GET', ['approvals']],
    ['GET', ['schedules']],
    ['GET', ['usage']],
    ['POST', ['requests']],
    ['POST', ['memory']],
    ['POST', ['schedules']],
    ['POST', ['tasks', ID, 'cancel']],
    ['POST', ['approvals', ID, 'decide']],
    ['DELETE', ['schedules', ID]],
  ];

  for (const [method, segments] of allowed) {
    it(`${method} /v1/${segments.join('/')}`, () => {
      expect(isProxied(method, segments)).toBe(true);
    });
  }
});

describe('everything else is refused', () => {
  const refused: [('GET' | 'POST' | 'DELETE'), string[]][] = [
    // Nothing at the root, nothing undefined.
    ['GET', []],
    ['GET', ['nope']],
    // Path traversal and encoded traversal must not match a UUID slot.
    ['GET', ['tasks', '../../etc/passwd']],
    ['GET', ['tasks', '..%2f..%2fetc']],
    ['GET', ['artifacts', '../../../etc/passwd', 'download']],
    // A UUID shape is required, not just any id.
    ['GET', ['tasks', '123']],
    ['GET', ['jobs', 'not-a-uuid']],
    // Extra segments are not silently tolerated.
    ['GET', ['tasks', ID, 'extra']],
    ['GET', ['jobs', ID, 'events', 'more']],
    // Methods that are not exposed at all.
    ['GET', ['requests']],
    ['POST', ['tasks']],
    ['POST', ['agents']],
    ['DELETE', ['tasks', ID]],
    ['DELETE', ['memory']],
    // Admin-ish paths must never be proxied.
    ['GET', ['learning', 'summary']],
    ['POST', ['learning', 'tick']],
    ['GET', ['voice', 'health']],
  ];

  for (const [method, segments] of refused) {
    it(`${method} /v1/${segments.join('/')} is not proxied`, () => {
      expect(isProxied(method, segments)).toBe(false);
    });
  }
});

describe('the whitelist is exact, not a prefix match', () => {
  it('does not accept a path that merely starts with an allowed one', () => {
    expect(isProxied('GET', ['tasksXYZ'])).toBe(false);
    expect(isProxied('GET', ['health', 'extra'])).toBe(false);
    expect(isProxied('POST', ['requests', 'extra'])).toBe(false);
  });

  it('is case-sensitive, so /v1/TASKS does not slip through', () => {
    expect(isProxied('GET', ['TASKS'])).toBe(false);
  });
});