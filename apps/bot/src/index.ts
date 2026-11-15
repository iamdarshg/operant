#!/usr/bin/env node
/**
 * Bot entry point and `--check` doctor.
 *
 * Two startup guarantees are baked in here, because they are the difference
 * between a supervised process and a crash loop:
 *
 *  1. **A missing token is a clean exit, not a stack trace.** Configuration is
 *     validated before anything is constructed, every problem is printed with
 *     the exact variable name, and the process exits 1. No unhandled rejection,
 *     no half-initialised gateway.
 *  2. **`--check` is a real doctor.** It validates configuration, probes the
 *     control plane's health endpoint, verifies the bearer token is accepted, and
 *     reports whether the Discord token is present — then exits 0 or 1. It never
 *     opens a gateway, so it is safe to run in CI or a container healthcheck.
 *
 * The Discord token itself is never validated here: only Discord can do that,
 * and pretending otherwise would be a lie the operator would discover later.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  ConfigError,
  accessListsConfigured,
  loadConfig,
  looksLikeDiscordToken,
  type BotConfig,
} from './config.js';
import { createLogger, type Logger } from './logger.js';
import { ApiError, OperantApi, describeError, type FetchLike } from './api/client.js';
import { describePolicy } from './bot/authorize.js';
import { ApprovalWatcher } from './bot/approvals.js';
import { OperantBot } from './bot/handler.js';
import type { GatewayHandle, GatewayHandlers } from './discord/gateway.js';
import { MESSAGE_CONTENT_NOTE, DOCUMENTED_INTENT_MASK } from './discord/intents.js';

export interface RunDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly fetchImpl?: FetchLike;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Injected in tests so no socket is opened and discord.js is never loaded. */
  readonly startGateway?: (
    handlers: GatewayHandlers,
    token: string,
    config: BotConfig,
  ) => Promise<GatewayHandle>;
  /** Tests keep signal handling off so they do not accumulate listeners. */
  readonly registerSignals?: boolean;
  /** Receives a shutdown handle once the gateway is up (tests, embedders). */
  readonly onStarted?: (shutdown: () => Promise<void>) => void;
}

const USAGE = [
  'operant discord bot',
  '',
  'Usage:',
  '  node dist/index.js            start the bot (requires DISCORD_BOT_TOKEN)',
  '  node dist/index.js --check    validate config + control-plane reachability, then exit 0/1',
  '  node dist/index.js --help     show this text',
  '',
  'Required environment:',
  '  DISCORD_BOT_TOKEN            Discord bot token (no fallback, ever)',
  '  OPERANT_API_BASE             control-plane base URL (dev fallback when NODE_ENV!=production)',
  '  OPERANT_BOT_TOKEN            control-plane bearer token (dev fallback when NODE_ENV!=production)',
  '  DISCORD_ALLOWED_USER_IDS     comma-separated user ids allowed to use the bot',
  '  DISCORD_ALLOWED_CHANNEL_IDS  comma-separated channel ids the bot listens in',
  '',
  'With neither allow-list set the bot refuses every message (fail closed).',
].join('\n');

/** Validate + probe, print a readable report, return the exit code. */
async function runCheck(config: BotConfig, deps: Required<Pick<RunDeps, 'stdout'>> & {
  logger: Logger;
  fetchImpl?: FetchLike;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  const out = deps.stdout;
  const logger = deps.logger;
  const policy = {
    allowedUserIds: config.allowedUserIds,
    allowedChannelIds: config.allowedChannelIds,
  };
  const policyInfo = describePolicy(policy);

  out(
    `config ok — api=${config.apiBase} · node_env=${config.nodeEnv} · allow-list users=${policyInfo.users} channels=${policyInfo.channels} (${policyInfo.mode}) · edit interval ${config.editIntervalMs}ms`,
  );
  out(
    `intents — GUILDS | GUILD_MESSAGES | GUILD_VOICE_STATES (mask ${DOCUMENTED_INTENT_MASK}); MESSAGE_CONTENT is privileged and NOT requested`,
  );

  if (config.isProduction) {
    out('env guard — NODE_ENV=production, so no development API base/token fallback was used');
  } else if (
    !deps.env['OPERANT_API_BASE'] ||
    !deps.env['OPERANT_BOT_TOKEN']
  ) {
    out('env note — development fallbacks are active for OPERANT_API_BASE / OPERANT_BOT_TOKEN');
  }

  const api = new OperantApi({
    base: config.apiBase,
    token: config.apiToken,
    logger,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    timeoutMs: Math.min(config.requestTimeoutMs, 10_000),
    maxRetries: 0,
  });

  let apiReachable = false;
  let apiAuthorized = false;

  try {
    const health = await api.health();
    apiReachable = true;
    const checks = (health.checks ?? []).map((check) => `${check.name}=${check.state}`).join(' ');
    out(
      `API reachable — GET /v1/health state=${health.state}${health.dshProfile ? ` dshProfile=${health.dshProfile}` : ''}${checks ? ` [${checks}]` : ''}`,
    );
    if (health.state !== 'healthy') {
      out(`API note — the control plane reports ${health.state}; requests may queue but will not run`);
    }
  } catch (error) {
    out(`API unreachable — ${describeError(error)}`);
    out(`API hint — is the control plane running at ${config.apiBase}?`);
  }

  if (apiReachable) {
    try {
      const tasks = await api.listTasks({ limit: 1 });
      apiAuthorized = true;
      out(`API auth ok — bearer accepted by GET /v1/tasks (${tasks.length} task${tasks.length === 1 ? '' : 's'} visible)`);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      out(
        status === 401
          ? 'API auth rejected — OPERANT_BOT_TOKEN is not the token the control plane expects'
          : `API auth check failed — ${describeError(error)}`,
      );
    }
  }

  const tokenPresent = config.discordToken !== '';
  if (!tokenPresent) {
    out('DISCORD_BOT_TOKEN missing — the Discord gateway cannot log in; startup would exit 1');
  } else if (looksLikeDiscordToken(config.discordToken)) {
    out('DISCORD_BOT_TOKEN present (shape only — token validity is only knowable from Discord)');
  } else {
    out(
      'DISCORD_BOT_TOKEN present but does not look like a Discord bot token (expected 3 dot-separated segments) — not rejected here',
    );
  }
  if (!accessListsConfigured(config)) {
    out('allow-list empty — this is fail-closed: every message will be refused until ids are configured');
  }
  out(`intents degraded mode — ${MESSAGE_CONTENT_NOTE}`);

  const runnable = apiReachable && apiAuthorized && tokenPresent;
  out(
    runnable
      ? 'check: config ok · API reachable · token present → RUNNABLE (exit 0)'
      : `check: config ok${apiReachable ? ' · API reachable' : ' · API UNREACHABLE'}${apiAuthorized ? '' : ' · API UNAUTHORIZED'}${tokenPresent ? ' · token present' : ' · token missing'} → NOT RUNNABLE (exit 1)`,
  );
  return runnable ? 0 : 1;
}

/**
 * The whole process, as a function returning an exit code. Throwing is reserved
 * for genuine programming errors; configuration and connectivity problems are
 * reported and returned.
 */
export async function run(argv: readonly string[], deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }
  const checkOnly = argv.includes('--check');
  const unknown = argv.filter((arg) => !['--check', '--help', '-h'].includes(arg));
  if (unknown.length > 0) {
    err(`unrecognised argument(s): ${unknown.join(' ')}`);
    out(USAGE);
    return 2;
  }

  let config: BotConfig;
  try {
    config = loadConfig(env, { allowMissingDiscordToken: checkOnly });
  } catch (error) {
    if (error instanceof ConfigError) {
      // Exactly what is missing, one line per variable, then a clean exit 1.
      err(`FATAL: refusing to start — ${error.problems.length} configuration problem(s):`);
      for (const problem of error.problems) {
        err(`  ${problem.variable}: ${problem.detail}`);
      }
      err('Set the variables above and start again. `--check` validates them without logging in.');
      return 1;
    }
    err(`FATAL: could not load configuration — ${describeError(error)}`);
    return 1;
  }

  const logger = deps.logger ?? createLogger(config.logLevel);

  if (checkOnly) {
    return runCheck(config, {
      stdout: out,
      logger,
      env,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  // Defensive: `loadConfig` requires the token unless --check asked otherwise.
  if (config.discordToken === '') {
    err('FATAL: DISCORD_BOT_TOKEN is missing — the Discord gateway cannot log in.');
    return 1;
  }

  logger.info('starting operant bot', {
    api: config.apiBase,
    nodeEnv: config.nodeEnv,
    intents: 'GUILDS|GUILD_MESSAGES|GUILD_VOICE_STATES',
    messageContent: MESSAGE_CONTENT_NOTE,
  });

  const api = new OperantApi({
    base: config.apiBase,
    token: config.apiToken,
    logger,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    timeoutMs: config.requestTimeoutMs,
  });

  const approvals = new ApprovalWatcher({
    api,
    logger,
    policy: {
      allowedUserIds: config.allowedUserIds,
      allowedChannelIds: config.allowedChannelIds,
    },
    pollMs: config.approvalPollMs,
  });

  const bot = new OperantBot({
    config,
    api,
    logger,
    approvals,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const handlers: GatewayHandlers = {
    logger,
    onMessage: (message) => bot.handleMessage(message),
    onInteraction: (interaction) => bot.handleInteraction(interaction),
  };

  let gateway: GatewayHandle;
  try {
    // Loaded lazily so `--check` (and the test suite) never import discord.js.
    const startGateway =
      deps.startGateway ??
      (await import('./discord/gateway.js')).startGateway;
    gateway = await startGateway(handlers, config.discordToken, config);
  } catch (error) {
    err(`FATAL: Discord login failed — ${describeError(error)}`);
    logger.error('discord login failed', {
      error: describeError(error),
      hint: 'check DISCORD_BOT_TOKEN; the bot token is only issued once and cannot be recovered',
    });
    return 1;
  }

  approvals.start();
  logger.info('operant bot is running', {
    api: config.apiBase,
    allowlist: describePolicy({
      allowedUserIds: config.allowedUserIds,
      allowedChannelIds: config.allowedChannelIds,
    }),
  });

  const stop = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    try {
      await bot.shutdown();
      await gateway.stop();
    } catch (error) {
      logger.error('shutdown error', { error: describeError(error) });
    }
  };

  if (deps.onStarted) {
    deps.onStarted(async () => {
      await stop('api');
    });
  }

  if (deps.registerSignals !== false) {
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        void stop(signal).then(() => {
          process.exitCode = 0;
        });
      });
    }
  }

  return 0;
}

/** True when this module is the process entry point (not imported by a test). */
export function isEntryPoint(
  moduleUrl: string = import.meta.url,
  argvPath: string | undefined = process.argv[1],
): boolean {
  if (!argvPath) return false;
  try {
    return pathToFileURL(resolve(argvPath)).href === pathToFileURL(fileURLToPath(moduleUrl)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `.then` handlers, not a top-level throw: a rejected promise here would crash
  // the process with an unhandled-rejection trace instead of a clean message.
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`FATAL: unexpected startup failure — ${describeError(error)}\n`);
      process.exitCode = 1;
    });
}