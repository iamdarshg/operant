/**
 * Tests for the extension-manifest contract.
 *
 * The important properties are policy properties, not shape properties: the
 * validator must be total (never throw on untrusted input, because it runs in
 * the host's extension loader), and it must refuse a manifest that wants a UI
 * surface without declaring the matching capability.
 */
import { describe, it, expect } from 'vitest';
import {
  ExtensionSlot,
  Permission,
  SEMVER_PATTERN,
  KEBAB_CASE_PATTERN,
  validateManifest,
} from './index.js';

const base = {
  id: 'acme-crm',
  name: 'Acme CRM',
  version: '1.0.0',
  apiVersion: 1,
};

/** Assert rejection and return the readable error list. */
function reject(input: unknown): string[] {
  const result = validateManifest(input);
  if (result.ok) {
    throw new Error(`expected rejection, got valid manifest for ${JSON.stringify(input)}`);
  }
  return result.errors;
}

describe('valid manifests', () => {
  it('accepts a minimal manifest and defaults permissions/contributions to empty', () => {
    const result = validateManifest(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('acme-crm');
    expect(result.manifest.permissions).toEqual([]);
    expect(result.manifest.contributes).toEqual([]);
  });

  it('accepts a full manifest with permissions and a slot contribution', () => {
    const result = validateManifest({
      ...base,
      permissions: ['network', 'filesystem', 'ui-slot', 'agent-tools'],
      contributes: [
        { slot: 'dashboard-panel', id: 'acme-panel' },
        { slot: 'command-palette', id: 'acme-commands' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.permissions).toContain('ui-slot');
    expect(result.manifest.contributes.map((c) => c.slot)).toEqual([
      'dashboard-panel',
      'command-palette',
    ]);
  });

  it('accepts empty permissions when nothing is contributed', () => {
    const result = validateManifest({ ...base, permissions: [], contributes: [] });
    expect(result.ok).toBe(true);
  });

  it('accepts permissions without any contributions', () => {
    const result = validateManifest({
      ...base,
      permissions: ['network', 'secrets'],
      contributes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.permissions).toEqual(['network', 'secrets']);
  });

  it('accepts prerelease and build-metadata versions', () => {
    expect(validateManifest({ ...base, version: '2.3.4-beta.1' }).ok).toBe(true);
    expect(validateManifest({ ...base, version: '2.3.4+build.9' }).ok).toBe(true);
  });
});

describe('total validation (never throws)', () => {
  it('rejects null without throwing', () => {
    expect(() => validateManifest(null)).not.toThrow();
    expect(validateManifest(null).ok).toBe(false);
    expect(reject(null).join(' ')).toContain('null');
  });

  it('rejects an array without throwing', () => {
    const input = [{ ...base }];
    expect(() => validateManifest(input)).not.toThrow();
    expect(validateManifest(input).ok).toBe(false);
    expect(reject(input).join(' ')).toContain('array');
  });

  it('rejects a string without throwing', () => {
    expect(() => validateManifest('acme-crm')).not.toThrow();
    expect(validateManifest('acme-crm').ok).toBe(false);
    expect(reject('acme-crm').join(' ')).toContain('string');
  });

  it('rejects undefined, numbers and booleans without throwing', () => {
    for (const input of [undefined, 42, true]) {
      expect(() => validateManifest(input)).not.toThrow();
      expect(validateManifest(input).ok).toBe(false);
    }
  });

  it('reports at least one readable error per rejection', () => {
    const errors = reject({ ...base, id: 'Bad_Id' });
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(typeof error).toBe('string');
      expect(error.length).toBeGreaterThan(0);
    }
  });
});

describe('identity fields', () => {
  it('rejects a missing id', () => {
    const { id: _omitted, ...noId } = base;
    const errors = reject(noId);
    expect(errors.some((e) => e.startsWith('id'))).toBe(true);
  });

  it('rejects non-kebab-case ids', () => {
    for (const id of ['AcmeCRM', 'acme_crm', 'ACME-CRM', '-acme', 'acme-']) {
      const errors = reject({ ...base, id });
      expect(errors.join(' ')).toContain('kebab-case');
    }
  });

  it('rejects a missing version', () => {
    const { version: _omitted, ...noVersion } = base;
    expect(reject(noVersion).some((e) => e.startsWith('version'))).toBe(true);
  });

  it('rejects non-semver versions', () => {
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', 'latest']) {
      const errors = reject({ ...base, version });
      expect(errors.join(' ')).toContain('semantic version');
    }
  });

  it('rejects a wrong apiVersion', () => {
    const errors = reject({ ...base, apiVersion: 2 });
    expect(errors.some((e) => e.startsWith('apiVersion'))).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(reject({ ...base, name: '' }).some((e) => e.startsWith('name'))).toBe(true);
  });
});

describe('permissions', () => {
  it('rejects an unknown permission', () => {
    const errors = reject({ ...base, permissions: ['telepathy'] });
    expect(errors.some((e) => e.startsWith('permissions'))).toBe(true);
    expect(errors.join(' ')).toContain('telepathy');
  });

  it('exposes the permission vocabulary', () => {
    expect(Permission.options).toEqual([
      'network',
      'filesystem',
      'process',
      'secrets',
      'ui-slot',
      'agent-tools',
    ]);
  });
});

describe('slot contributions', () => {
  it('rejects a slot contribution without the ui-slot permission, naming the slot', () => {
    const errors = reject({
      ...base,
      permissions: ['network'],
      contributes: [{ slot: 'settings-section', id: 'acme-settings' }],
    });
    const text = errors.join(' ');
    expect(text).toContain('settings-section');
    expect(text).toContain('ui-slot');
  });

  it('rejects a slot contribution when permissions are omitted', () => {
    const errors = reject({
      ...base,
      contributes: [{ slot: 'dashboard-panel', id: 'acme-panel' }],
    });
    expect(errors.join(' ')).toContain('ui-slot');
  });

  it('rejects duplicate contributions to the same slot', () => {
    const errors = reject({
      ...base,
      permissions: ['ui-slot'],
      contributes: [
        { slot: 'dashboard-panel', id: 'primary' },
        { slot: 'dashboard-panel', id: 'secondary' },
      ],
    });
    const text = errors.join(' ');
    expect(text).toContain('duplicate');
    expect(text).toContain('dashboard-panel');
  });

  it('rejects an unknown slot', () => {
    const errors = reject({
      ...base,
      permissions: ['ui-slot'],
      contributes: [{ slot: 'sidebar-widget', id: 'acme-widget' }],
    });
    expect(errors.some((e) => e.startsWith('contributes.0.slot'))).toBe(true);
  });

  it('rejects a contribution with an empty id', () => {
    const errors = reject({
      ...base,
      permissions: ['ui-slot'],
      contributes: [{ slot: 'overlay-card', id: '' }],
    });
    expect(errors.some((e) => e.startsWith('contributes.0.id'))).toBe(true);
  });

  it('exposes the slot vocabulary and the shared patterns', () => {
    expect(ExtensionSlot.options).toEqual([
      'dashboard-panel',
      'overlay-card',
      'settings-section',
      'command-palette',
      'voice-command',
    ]);
    expect(KEBAB_CASE_PATTERN.test('acme-crm-2')).toBe(true);
    expect(KEBAB_CASE_PATTERN.test('Acme')).toBe(false);
    expect(SEMVER_PATTERN.test('1.2.3')).toBe(true);
    expect(SEMVER_PATTERN.test('1.2')).toBe(false);
  });
});