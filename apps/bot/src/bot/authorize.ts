/**
 * Authorization.
 *
 * Policy is deliberately the *intersection* style used by operational bots:
 *
 *   - if `DISCORD_ALLOWED_USER_IDS` is set, the author must be in it;
 *   - if `DISCORD_ALLOWED_CHANNEL_IDS` is set, the channel must be in it;
 *   - both must pass when both are set.
 *
 * With neither list set the bot is closed, not open. An unauthenticated Discord
 * bot in a guild is reachable by anyone with channel access, so "no allow-list"
 * can only ever mean "refuse everything" — the alternative is a remote code
 * execution surface. The refusal is polite and logs the ids so an operator can
 * add them.
 */

export interface AccessPolicy {
  readonly allowedUserIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
}

export type DenialReason = 'user' | 'channel' | 'no_allowlist';

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason };

export interface AccessSubject {
  readonly userId: string;
  readonly channelId: string;
}

export function authorize(subject: AccessSubject, policy: AccessPolicy): AccessDecision {
  const users = policy.allowedUserIds;
  const channels = policy.allowedChannelIds;
  if (users.length === 0 && channels.length === 0) {
    return { allowed: false, reason: 'no_allowlist' };
  }
  if (users.length > 0 && !users.includes(subject.userId)) {
    return { allowed: false, reason: 'user' };
  }
  if (channels.length > 0 && !channels.includes(subject.channelId)) {
    return { allowed: false, reason: 'channel' };
  }
  return { allowed: true };
}

/** True when the bot can act at all. Used for the one-time startup warning. */
export function policyIsClosed(policy: AccessPolicy): boolean {
  return policy.allowedUserIds.length === 0 && policy.allowedChannelIds.length === 0;
}

/** Log-safe description of the policy (never the token, only ids). */
export function describePolicy(policy: AccessPolicy): {
  users: number;
  channels: number;
  mode: 'closed' | 'allowlist';
} {
  return {
    users: policy.allowedUserIds.length,
    channels: policy.allowedChannelIds.length,
    mode: policyIsClosed(policy) ? 'closed' : 'allowlist',
  };
}