/**
 * Policy tests. Two properties matter:
 *  1. genuinely consequential intents are gated (false negatives are dangerous)
 *  2. ordinary engineering work is NOT gated (a gate that cries wolf gets
 *     approved blindly, which is worse than no gate)
 */
import { describe, it, expect } from 'vitest';
import { assessIntent, requiresApproval } from './policy.js';

describe('gated intents', () => {
  const gated: [string, string][] = [
    ['rm -rf /var/lib/postgresql and reinitialise', 'destructive'],
    ['Drop table users and recreate it', 'destructive'],
    ['Pay the outstanding invoice for the GPU rental', 'spend'],
    ['Upgrade my plan to the annual tier', 'spend'],
    ['Rotate the API key on the production service', 'account_change'],
    ['Grant access to the billing dashboard for the intern', 'account_change'],
    ['Deploy to production and restart the API', 'production_config'],
    ['Send an email to the client summarising the outage', 'external_message'],
    ['Post to the team channel that the build is red', 'external_message'],
    ['Write the new credentials into /etc/operant/operant.env', 'file_write_outside_workspace'],
  ];

  for (const [text, kind] of gated) {
    it(`gates ${JSON.stringify(text.slice(0, 42))} as ${kind}`, () => {
      const a = assessIntent(text);
      expect(a.required).toBe(true);
      expect(a.kind).toBe(kind);
      expect(a.reasons.length).toBeGreaterThan(0);
      expect(a.summary).toContain('approv');
    });
  }

  it('rates destructive operations above mere config changes', () => {
    const destructive = assessIntent('rm -rf the whole build cache directory');
    const config = assessIntent('deploy to production');
    expect(destructive.risk).toBe('critical');
    expect(config.risk).toBe('medium');
  });
});

describe('ordinary work must NOT be gated', () => {
  const allowed = [
    'Reply with exactly OPERANT-SLICE-OK and nothing else.',
    'Work on Copperline and investigate the failing tests.',
    'Review the latest changes in my aerospace project.',
    'Summarise the last three failed builds and what they had in common.',
    'Transcribe this recording and summarise the action items.',
    'Refactor the parser to remove the duplicate owner and run the tests.',
    'Read apps/api/src/server.ts and tell me which port it listens on.',
    'Create a new Postgres table for events and migrate the data into it.',
  ];

  for (const text of allowed) {
    it(`allows ${JSON.stringify(text.slice(0, 42))}`, () => {
      expect(assessIntent(text).required).toBe(false);
    });
  }

  it('does not gate on the word "test" or a stray path', () => {
    expect(requiresApproval('run the test suite and paste the output')).toBe(false);
    expect(requiresApproval('the config lives in /etc/operant but just read it')).toBe(false);
  });
});

describe('assessment shape', () => {
  it('always returns a usable kind and summary', () => {
    for (const text of ['rm -rf x', 'deploy to production', 'harmless task']) {
      const a = assessIntent(text);
      expect(typeof a.kind).toBe('string');
      expect(typeof a.summary).toBe('string');
      expect(a.summary.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high', 'critical']).toContain(a.risk);
    }
  });
});