/**
 * Tests for the self-improvement loop's decision logic.
 *
 * The valuable properties here are *policy* properties: a single failure must
 * never trigger a change, volatile tokens must not change the fingerprint (or
 * repeats would never be detected), and medium/high-risk changes must not be
 * promotable without review.
 */
import { describe, it, expect } from 'vitest';
import { classifyFailure, normalize, planProposal, recoveryProcedure, hash64 } from './index.js';

describe('normalize', () => {
  it('strips volatile instance details but keeps the shape', () => {
    const a = normalize('Job 5f2b8c1e-1111-2222-3333-444455556666 failed at /opt/app/data/jobs/x on port 8787 after 300ms');
    const b = normalize('Job 9a9a9a9a-aaaa-bbbb-cccc-ddddeeeeffff failed at /home/u/app/data/jobs/y on port 55432 after 900ms');
    expect(a).toBe(b);
    expect(a).toContain('<uuid>');
    expect(a).toContain('<path>');
  });

  it('keeps discriminative words', () => {
    expect(normalize('MODULE_NOT_FOUND: lodash')).toContain('module_not_found');
  });
});

describe('fingerprint stability', () => {
  it('is identical for the same class of failure across instances', () => {
    // Same failure class, same package, different version numbers / timings.
    const f1 = classifyFailure('npm error code ETARGET No matching version found for @deepseek-ai/dsh@*. (after 1200ms)').fingerprint;
    const f2 = classifyFailure('npm error code ETARGET No matching version found for @deepseek-ai/dsh@*. (after 830ms)').fingerprint;
    expect(f1).toBe(f2);
  });

  it('treats a different missing package as a different incident', () => {
    // Deliberate: a different dependency needs a different fix, so it must not
    // be collapsed into the same fingerprint as the original.
    const a = classifyFailure('npm error code ETARGET No matching version found for @deepseek-ai/dsh@*.').fingerprint;
    const b = classifyFailure('npm error code ETARGET No matching version found for lodash@*.').fingerprint;
    expect(a).not.toBe(b);
  });

  it('differs between genuinely different failure classes', () => {
    const a = classifyFailure('ECONNREFUSED 127.0.0.1:8787').fingerprint;
    const b = classifyFailure('ENOSPC: no space left on device').fingerprint;
    expect(a).not.toBe(b);
  });

  it('hash64 is deterministic', () => {
    expect(hash64('abc')).toBe(hash64('abc'));
    expect(hash64('abc')).not.toBe(hash64('abd'));
  });
});

describe('classification', () => {
  const cases: [string, string][] = [
    ['npm error code ETARGET No matching version found', 'dependency_missing'],
    ['MISSING_CREDENTIAL: no API key for provider route', 'auth_failure'],
    ['provider "surplus" model "x" does not support reasoning effort "high"', 'config_drift'],
    ['dsh: /app/.env sets "DSH_PROFILE", which only the launching environment may set', 'config_drift'],
    ['multiple usable web providers are registered', 'config_drift'],
    // Real stderr shape from a live failed run: DSH exits 1 on an unknown profile.
    ['Error: dsh: profile "nosuchprofile" does not exist; create it with \'dsh plugin --profile nosuchprofile add <package>\'', 'config_drift'],
    ['ENOSPC: no space left on device, write', 'resource_exhaustion'],
    ['ECONNREFUSED 127.0.0.1:3900', 'network'],
    ['AssertionError: expected 1 to be 2', 'code_defect'],
    ['totally novel exotic failure', 'unknown'],
  ];

  for (const [text, expected] of cases) {
    it(`classifies ${JSON.stringify(text.slice(0, 40))} as ${expected}`, () => {
      expect(classifyFailure(text).category).toBe(expected);
    });
  }

  it('marks network failures transient', () => {
    expect(classifyFailure('ECONNREFUSED 127.0.0.1:3900').transient).toBe(true);
  });
});

describe('proposal policy (the guardrails)', () => {
  it('never acts on a single occurrence', () => {
    const plan = planProposal({ category: 'dependency_missing', occurrences: 1, remedy: 'procedural', title: 'x' });
    expect(plan.autoPromotable).toBe(false);
    expect(plan.rationale).toContain('single occurrence');
  });

  it('auto-promotes only low-risk knowledge for a repeat dependency failure', () => {
    const plan = planProposal({ category: 'dependency_missing', occurrences: 3, remedy: 'procedural', title: 'x' });
    expect(plan.autoPromotable).toBe(true);
    expect(plan.kind).toBe('knowledge');
    expect(plan.risk).toBe('low');
  });

  it('never auto-promotes a config change', () => {
    const plan = planProposal({ category: 'config_drift', occurrences: 5, remedy: 'config', title: 'x' });
    expect(plan.autoPromotable).toBe(false);
    expect(plan.risk).toBe('medium');
  });

  it('never auto-promotes anything credential-adjacent', () => {
    const plan = planProposal({ category: 'auth_failure', occurrences: 9, remedy: 'semantic', title: 'x' });
    expect(plan.autoPromotable).toBe(false);
    expect(plan.risk).toBe('high');
  });

  it('requires review for resource/retry changes', () => {
    const plan = planProposal({ category: 'resource_exhaustion', occurrences: 4, remedy: 'procedural', title: 'x' });
    expect(plan.autoPromotable).toBe(false);
    expect(plan.kind).toBe('retry_policy');
  });
});

describe('recovery knowledge', () => {
  it('produces a concrete procedure for the classes we may record', () => {
    const proc = recoveryProcedure(classifyFailure('ENOENT: command not found: pnpm'));
    expect(proc).not.toBeNull();
    expect(proc!.body.length).toBeGreaterThan(80);
    expect(proc!.tags).toContain('recovery');
  });

  it('returns null for classes we must not paper over', () => {
    expect(recoveryProcedure(classifyFailure('AssertionError: expected 1 to be 2'))).toBeNull();
  });
});