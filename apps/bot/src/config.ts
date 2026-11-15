/**
 * Bot configuration.
 *
 * Two rules shape this module:
 *
 *  1. **Fail closed, fail loudly.** Every missing or malformed setting is
 *     collected into one `ConfigError` so the operator sees the complete list in
 *     a single run instead of discovering problems one restart at a time.
 *  2. **Dev defaults are dev-only.** The control-plane base URL and bearer token
 *     have development fallbacks so the bot can be exercised against a local
 *     API, but those fallbacks are *refused* when `NODE_ENV=production`. Nothing
 *     that looks like a credential is ever defaulted in production.
 *
 * `DISCORD_BOT_TOKEN` has no fallback in any environment. Without it the gateway
 * cannot authenticate, so it is reported as missing and the process exits 1.
 */

/** Local tunnel target used during development on the operator's laptop. */
export const DEV_API_BASE = 'http://127.0.0.1:8787';
/** Development-only bearer token for the local control plane. */
export const DEV_API_TOKEN = 'devtoken-operant-cloud-0123456789';

/** Discord's hard cap for a single attachment download we are willing to read. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface BotConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly logLevel: LogLevelName;
  /** Control-plane base URL, no trailing slash. */
  readonly apiBase: string;
  /** Bearer token for the control plane. */
  readonly apiToken: string;
  /** Discord gateway token. Empty only in the `--check` path. */
  readonly discordToken: string;
  readonly allowedUserIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  /** Minimum gap between edits of the same Discord message. */
  readonly editIntervalMs: number;
  /** Fallback poll cadence when SSE is unavailable. */
  readonly pollIntervalMs: number;
  /** Cadence for the pending-approval sweep. */
  readonly approvalPollMs: number;
  /** Reject audio attachments larger than this before downloading. */
  readonly maxAttachmentBytes: number;
  /** Per-HTTP-request timeout for ordinary JSON calls. */
  readonly requestTimeoutMs: number;
  /** Abort an SSE stream that has been silent for this long (keepalives count). */
  readonly streamIdleTimeoutMs: number;
  /** Give up tracking a job after this long. */
  readonly jobTimeoutMs: number;
}

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevelName[] = ['debug', 'info', 'warn', 'error'];

export interface LoadConfigOptions {
  /**
   * `--check` inspects the configuration without being able to start, so it must
   * be able to *report* a missing Discord token instead of failing on it.
   */
  readonly allowMissingDiscordToken?: boolean;
  readonly defaults?: Partial<BotConfig>;
}

/** One actionable configuration problem, phrased for the operator. */
export interface ConfigProblem {
  readonly variable: string;
  readonly detail: string;
}

export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const lines = problems.map((p) => `  - ${p.variable}: ${p.detail}`);
    super(`invalid bot configuration (${problems.length} problem(s)):\n${lines.join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }

  /** Names of the variables that must be supplied, in report order. */
  missingVariables(): string[] {
    return this.problems.map((p) => p.variable);
  }
}

function isProduction(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}

function readString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  problems: ConfigProblem[],
  min: number,
): number {
  const raw = readString(env, name);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    problems.push({
      variable: name,
      detail: `must be an integer >= ${min}, got ${JSON.stringify(raw)}`,
    });
    return fallback;
  }
  return value;
}

/** Comma-separated Discord snowflakes. Blank entries are ignored. */
export function parseIdList(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read and validate configuration.
 *
 * @throws ConfigError listing every problem at once.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): BotConfig {
  const problems: ConfigProblem[] = [];
  const nodeEnv = readString(env, 'NODE_ENV') || 'development';
  const production = isProduction(nodeEnv);
  const defaults = options.defaults ?? {};

  const logRaw = readString(env, 'LOG_LEVEL').toLowerCase();
  let logLevel: LogLevelName = 'info';
  if (logRaw !== '') {
    if ((LOG_LEVELS as readonly string[]).includes(logRaw)) {
      logLevel = logRaw as LogLevelName;
    } else {
      problems.push({
        variable: 'LOG_LEVEL',
        detail: `must be one of ${LOG_LEVELS.join('|')}, got ${JSON.stringify(logRaw)}`,
      });
    }
  }
  if (defaults.logLevel) logLevel = defaults.logLevel;

  // ---- control plane ----------------------------------------------------
  let apiBase = readString(env, 'OPERANT_API_BASE');
  if (apiBase === '') {
    if (production) {
      problems.push({
        variable: 'OPERANT_API_BASE',
        detail: `is required when NODE_ENV=production (no development fallback is used)`,
      });
    } else {
      apiBase = defaults.apiBase ?? DEV_API_BASE;
    }
  }
  apiBase = apiBase.replace(/\/+$/, '');
  if (apiBase !== '') {
    let parsed: URL | null = null;
    try {
      parsed = new URL(apiBase);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      problems.push({
        variable: 'OPERANT_API_BASE',
        detail: `must be an absolute http(s) URL, got ${JSON.stringify(apiBase)}`,
      });
    }
  }

  let apiToken = readString(env, 'OPERANT_BOT_TOKEN');
  if (apiToken === '') {
    if (production) {
      problems.push({
        variable: 'OPERANT_BOT_TOKEN',
        detail: 'is required when NODE_ENV=production (the API rejects unauthenticated calls)',
      });
    } else {
      apiToken = defaults.apiToken ?? DEV_API_TOKEN;
    }
  }

  // ---- discord gateway --------------------------------------------------
  const discordToken = readString(env, 'DISCORD_BOT_TOKEN');
  if (discordToken === '' && !options.allowMissingDiscordToken) {
    problems.push({
      variable: 'DISCORD_BOT_TOKEN',
      detail:
        'is unset and has no fallback — create a bot application, copy the bot token, and set this variable; the gateway cannot log in without it',
    });
  }

  // ---- authorization ----------------------------------------------------
  // An empty list is not an error: it is a *closed* door. The bot refuses every
  // message until an operator opts someone in, and says so at startup.
  const allowedUserIds = parseIdList(env['DISCORD_ALLOWED_USER_IDS']);
  const allowedChannelIds = parseIdList(env['DISCORD_ALLOWED_CHANNEL_IDS']);

  const config: BotConfig = {
    nodeEnv,
    isProduction: production,
    logLevel,
    apiBase,
    apiToken,
    discordToken,
    allowedUserIds,
    allowedChannelIds,
    editIntervalMs: readInt(env, 'DISCORD_EDIT_INTERVAL_MS', 1_500, problems, 200),
    pollIntervalMs: readInt(env, 'DISCORD_POLL_INTERVAL_MS', 2_000, problems, 250),
    approvalPollMs: readInt(env, 'DISCORD_APPROVAL_POLL_MS', 5_000, problems, 500),
    maxAttachmentBytes: readInt(
      env,
      'DISCORD_MAX_ATTACHMENT_BYTES',
      DEFAULT_MAX_ATTACHMENT_BYTES,
      problems,
      1_024,
    ),
    requestTimeoutMs: readInt(env, 'DISCORD_REQUEST_TIMEOUT_MS', 15_000, problems, 500),
    streamIdleTimeoutMs: readInt(env, 'DISCORD_STREAM_IDLE_TIMEOUT_MS', 60_000, problems, 1_000),
    jobTimeoutMs: readInt(env, 'DISCORD_JOB_TIMEOUT_MS', 30 * 60_000, problems, 10_000),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * A Discord bot token is three dot-separated base64url-ish segments. We only
 * *warn* on a mismatch: Discord is the only authority on token validity, and a
 * format change must not lock an operator out of starting the bot.
 */
export function looksLikeDiscordToken(token: string): boolean {
  return /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(token);
}

/**
 * Whether authorization is possible at all. With neither allow-list populated
 * the bot is closed by design; the gateway should log this loudly once.
 */
export function accessListsConfigured(config: BotConfig): boolean {
  return config.allowedUserIds.length > 0 || config.allowedChannelIds.length > 0;
}