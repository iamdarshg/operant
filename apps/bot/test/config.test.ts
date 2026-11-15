/**
 * Configuration and copy.
 *
 * Configuration is where fail-closed behaviour starts: production must refuse
 * development defaults, allow-lists must parse exactly, and every problem must be
 * reported at once rather than one restart at a time.
 *
 * The copy tests pin the four states a human must be able to tell apart.
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_API_BASE,
  DEV_API_TOKEN,
  accessListsConfigured,
  loadConfig,
  looksLikeDiscordToken,
  parseIdList,
} from '../src/config.js';
import {
  HEADLINES,
  approvalCard,
  decisionMessage,
  phaseOf,
  renderAccepted,
  renderProgress,
  type ProgressState,
} from '../src/bot/copy.js';
import { DOCUMENTED_INTENT_MASK, REQUIRED_INTENT_NAMES, composeIntents } from '../src/discord/intents.js';

const baseEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  ...extra,
});

const state = (overrides: Partial<ProgressState> = {}): ProgressState => ({
  taskId: 'task-1',
  jobId: 'job-1',
  agentId: 'engineering',
  intent: 'fix the flaky test',
  status: 'running',
  eventCount: 0,
  toolCalls: [],
  lastText: null,
  result: null,
  error: null,
  approvalCount: 0,
  elapsedMs: 0,
  ...overrides,
});

describe('config', () => {
  it('uses development fallbacks outside production', () => {
    const config = loadConfig(baseEnv(), { allowMissingDiscordToken: true });
    expect(config.apiBase).toBe(DEV_API_BASE);
    expect(config.apiToken).toBe(DEV_API_TOKEN);
    expect(config.isProduction).toBe(false);
    expect(config.editIntervalMs).toBe(1_500);
  });

  it('refuses development fallbacks in production', () => {
    const attempt = () => loadConfig(baseEnv({ NODE_ENV: 'production' }));
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.missingVariables()).toContain('OPERANT_API_BASE');
      expect(configError.missingVariables()).toContain('OPERANT_BOT_TOKEN');
      expect(configError.message).toContain('required when NODE_ENV=production');
    }
  });

  it('reports a missing Discord token with an actionable message', () => {
    try {
      loadConfig(baseEnv());
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.missingVariables()).toContain('DISCORD_BOT_TOKEN');
      expect(configError.message).toContain('gateway cannot log in');
      // One line per problem, containing the variable name.
      expect(configError.problems.some((problem) => problem.variable === 'DISCORD_BOT_TOKEN')).toBe(true);
    }
  });

  it('collects every problem instead of failing on the first', () => {
    try {
      loadConfig({
        NODE_ENV: 'production',
        OPERANT_API_BASE: 'not-a-url',
        DISCORD_EDIT_INTERVAL_MS: '10',
        LOG_LEVEL: 'loud',
      });
    } catch (error) {
      const configError = error as ConfigError;
      const names = configError.missingVariables();
      expect(names).toContain('OPERANT_API_BASE');
      expect(names).toContain('OPERANT_BOT_TOKEN');
      expect(names).toContain('DISCORD_BOT_TOKEN');
      expect(names).toContain('DISCORD_EDIT_INTERVAL_MS');
      expect(names).toContain('LOG_LEVEL');
    }
  });

  it('parses comma-separated allow-lists, ignoring blanks and whitespace', () => {
    expect(parseIdList(' 123, 456 ,,789 ')).toEqual(['123', '456', '789']);
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList(undefined)).toEqual([]);
    const config = loadConfig(
      baseEnv({
        DISCORD_BOT_TOKEN: 't',
        DISCORD_ALLOWED_USER_IDS: '1,2',
        DISCORD_ALLOWED_CHANNEL_IDS: '3',
      }),
    );
    expect(config.allowedUserIds).toEqual(['1', '2']);
    expect(config.allowedChannelIds).toEqual(['3']);
    expect(accessListsConfigured(config)).toBe(true);
  });

  it('reports an empty allow-list as closed, not open', () => {
    const config = loadConfig(baseEnv({ DISCORD_BOT_TOKEN: 't' }));
    expect(config.allowedUserIds).toEqual([]);
    expect(accessListsConfigured(config)).toBe(false);
  });

  it('recognises the shape of a Discord token but does not pretend to validate it', () => {
    expect(looksLikeDiscordToken(`${'M'.repeat(24)}.${'a'.repeat(6)}.${'z'.repeat(27)}`)).toBe(true);
    expect(looksLikeDiscordToken('not-a-token')).toBe(false);
    expect(looksLikeDiscordToken('')).toBe(false);
  });
});

describe('intents', () => {
  it('requests exactly GUILDS | GUILD_MESSAGES | GUILD_VOICE_STATES', () => {
    expect(REQUIRED_INTENT_NAMES).toEqual(['Guilds', 'GuildMessages', 'GuildVoiceStates']);
    expect(DOCUMENTED_INTENT_MASK).toBe((1 << 0) | (1 << 9) | (1 << 7));
    expect(DOCUMENTED_INTENT_MASK).toBe(641);
  });

  it('does not request the privileged MESSAGE_CONTENT intent', () => {
    const MESSAGE_CONTENT = 1 << 15;
    expect(DOCUMENTED_INTENT_MASK & MESSAGE_CONTENT).toBe(0);
  });

  it('composes from a table rather than hard-coding one number', () => {
    expect(composeIntents({ Guilds: 1, GuildMessages: 512, GuildVoiceStates: 128 })).toBe(641);
  });
});

describe('message copy distinguishes the four states', () => {
  it('has one distinct headline per activity state', () => {
    const headlines = Object.values(HEADLINES);
    expect(new Set(headlines).size).toBe(headlines.length);
    expect(HEADLINES.request).toContain('Request accepted');
    expect(HEADLINES.background).toContain('Background activity');
    expect(HEADLINES.completed).toContain('Work completed');
    expect(HEADLINES.waiting_approval).toContain('approval required');
  });

  it('derives the phase from status, activity and approvals', () => {
    expect(phaseOf(state({ status: 'running' }))).toBe('request'); // no events yet
    expect(phaseOf(state({ status: 'running', eventCount: 3 }))).toBe('background');
    expect(phaseOf(state({ status: 'succeeded', result: 'ok' }))).toBe('completed');
    expect(phaseOf(state({ status: 'failed', error: 'boom' }))).toBe('failed');
    expect(phaseOf(state({ status: 'cancelled' }))).toBe('cancelled');
    expect(phaseOf(state({ status: 'waiting_approval' }))).toBe('waiting_approval');
    expect(phaseOf(state({ status: 'running', eventCount: 2, approvalCount: 1 }))).toBe('waiting_approval');
  });

  it('renders a completed state with the result and facts', () => {
    const text = renderProgress(
      state({ status: 'succeeded', result: 'Added the test and it passes.', eventCount: 6, elapsedMs: 4_200 }),
    );
    expect(text).toContain(HEADLINES.completed);
    expect(text).toContain('Added the test and it passes.');
    expect(text).toContain('task `task-1`');
    expect(text).toContain('agent `engineering`');
    expect(text).toContain('4s');
  });

  it('renders a failed state with the reason', () => {
    const text = renderProgress(state({ status: 'failed', error: 'model quota exhausted' }));
    expect(text).toContain(HEADLINES.failed);
    expect(text).toContain('model quota exhausted');
  });

  it('always fits inside the Discord content limit', () => {
    const text = renderProgress(
      state({ status: 'succeeded', result: 'y'.repeat(10_000), intent: 'x'.repeat(4_000) }),
    );
    expect(text.length).toBeLessThanOrEqual(1_900);
  });

  it('acknowledges a request without claiming it finished', () => {
    const text = renderAccepted('fix the build');
    expect(text).toContain('Request accepted');
    expect(text).toContain('fix the build');
    expect(text).not.toContain('Work completed');
  });
});

describe('approval copy', () => {
  const approval = {
    id: 'ap-1',
    taskId: 'task-1',
    jobId: 'job-1',
    summary: 'Delete the workspace',
    status: 'pending' as const,
    risk: 'critical',
    action: { kind: 'destructive', payload: { command: 'rm -rf ./data' } },
    requestedBy: 'agent:engineering',
    expiresAt: '2026-11-15T01:00:00.000Z',
    createdAt: null,
  };

  it('colours the card by risk and carries the action', () => {
    const card = approvalCard(approval);
    expect(card.embeds?.[0]?.color).toBe(0xe01e37);
    expect(card.embeds?.[0]?.fields?.some((field) => field.name === 'Action')).toBe(true);
    expect(card.components?.[0]?.components).toHaveLength(2);
  });

  it('removes the buttons once a decision is recorded', () => {
    const decided = decisionMessage({
      approvalId: 'ap-1',
      taskId: 'task-1',
      summary: 'Delete the workspace',
      decision: 'reject',
      decidedBy: 'alice (user-1)',
    });
    expect(decided.components).toEqual([]);
    expect(decided.content).toContain('Rejected by');
    expect(decided.embeds?.[0]?.title).toBe('Rejected');
  });
});