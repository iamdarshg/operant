/**
 * Typed plugin-extension contract.
 *
 * An extension manifest is the only thing the host trusts from third-party
 * code, so the schema is the security boundary: the ids it can claim, the
 * capabilities it asks for, and the surfaces it wants to draw into. Nothing
 * here executes extension code — it describes what the host will allow.
 *
 * Two rules are worth stating because they are not obvious from the zod types:
 *
 * 1. Contributing to *any* slot is a UI capability, so a manifest that
 *    contributes a slot must also declare the `ui-slot` permission. Otherwise
 *    an extension could draw into the dashboard while claiming only, say,
 *    `network`.
 * 2. A slot may be contributed at most once per extension. Two panels
 *    claiming the same slot id is a conflict the host cannot resolve
 *    deterministically, so it is rejected at validation time instead of
 *    surfacing as a UI bug later.
 */
import { z } from 'zod';

/** Capabilities an extension must declare up front. */
export const Permission = z.enum([
  'network',
  'filesystem',
  'process',
  'secrets',
  'ui-slot',
  'agent-tools',
]);
export type Permission = z.infer<typeof Permission>;

/** Places in the host UI an extension may contribute to. */
export const ExtensionSlot = z.enum([
  'dashboard-panel',
  'overlay-card',
  'settings-section',
  'command-palette',
  'voice-command',
]);
export type ExtensionSlot = z.infer<typeof ExtensionSlot>;

/** Lowercase words joined by single hyphens: `acme.crm` is out, `acme-crm` is in. */
export const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** MAJOR.MINOR.PATCH with optional prerelease and build metadata. */
export const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** One surface an extension wants to occupy. */
export const ExtensionContribution = z.object({
  slot: ExtensionSlot,
  id: z.string().min(1, 'contribution id must not be empty'),
});
export type ExtensionContribution = z.infer<typeof ExtensionContribution>;

const ExtensionManifestObject = z.object({
  id: z
    .string()
    .regex(
      KEBAB_CASE_PATTERN,
      'id must be kebab-case: lowercase letters, digits and single hyphens (e.g. "acme-crm")',
    ),
  name: z.string().min(1, 'name must not be empty'),
  version: z
    .string()
    .regex(
      SEMVER_PATTERN,
      'version must be a semantic version, e.g. "1.2.3" or "1.2.3-beta.1"',
    ),
  apiVersion: z.literal(1),
  permissions: z.array(Permission).default([]),
  contributes: z.array(ExtensionContribution).default([]),
});

/**
 * The manifest schema, including the cross-field rules (slot contributions
 * require `ui-slot`; a slot may be claimed once). Keeping those rules inside
 * the schema means `ExtensionManifest.safeParse` and `validateManifest` cannot
 * drift apart.
 */
export const ExtensionManifest = ExtensionManifestObject.superRefine((manifest, ctx) => {
  const claimedSlots = new Set<ExtensionSlot>();

  manifest.contributes.forEach((contribution, index) => {
    if (claimedSlots.has(contribution.slot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributes', index, 'slot'],
        message: `duplicate contribution for slot "${contribution.slot}"; each slot may be contributed at most once`,
      });
    }
    claimedSlots.add(contribution.slot);

    if (!manifest.permissions.includes('ui-slot')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributes', index, 'slot'],
        message: `contributes the "${contribution.slot}" slot but does not declare the "ui-slot" permission`,
      });
    }
  });
});
export type ExtensionManifest = z.infer<typeof ExtensionManifest>;

/** Discriminated result so callers handle failure explicitly. */
export type ManifestValidation =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; errors: string[] };

/** Human wording for whatever a non-object `input` actually was. */
function describeInput(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'an array';
  if (input === undefined) return 'undefined';
  switch (typeof input) {
    case 'string':
      return 'a string';
    case 'number':
    case 'bigint':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'function':
      return 'a function';
    case 'symbol':
      return 'a symbol';
    default:
      return typeof input;
  }
}

/** `path.to.field: message`, or just `message` for root-level issues. */
function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Validate untrusted input against {@link ExtensionManifest}.
 *
 * Never throws — not for `null`, arrays, strings, numbers, or hostile objects
 * with throwing getters. A manifest that cannot be read is a rejected manifest,
 * not a crash in the host's extension loader.
 */
export function validateManifest(input: unknown): ManifestValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [`manifest must be a plain object, received ${describeInput(input)}`],
    };
  }

  try {
    const result = ExtensionManifest.safeParse(input);
    if (result.success) {
      return { ok: true, manifest: result.data };
    }
    return { ok: false, errors: result.error.issues.map(formatIssue) };
  } catch (error) {
    return {
      ok: false,
      errors: [
        `manifest could not be validated: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}