/**
 * Gateway intents.
 *
 * Exactly three are requested:
 *
 *   GUILDS              — channel/thread metadata, so a message can be mapped to
 *                         a conversation and posted back into the right channel.
 *   GUILD_MESSAGES      — message create/update events in guild channels.
 *   GUILD_VOICE_STATES  — voice-channel membership; the bot joins no voice
 *                         channel itself, but presence in this intent is what
 *                         lets a future voice-mode path see who is speaking.
 *
 * `MESSAGE_CONTENT` is **not** in this list because it is a *privileged* intent
 * that must be enabled per-application in the Discord developer portal
 * (Bot → Privileged Gateway Intents). Plain-language reading — the bot's primary
 * path — depends on it:
 *
 *   With MESSAGE_CONTENT enabled:  `message.content` contains the user's text,
 *                                  so any plain message works.
 *   Without it:                    `content` arrives empty except for the bot's
 *                                  own mentions and direct messages. The bot
 *                                  still receives the event and attachments, so
 *                                  it degrades to: (a) requests that @mention the
 *                                  bot, (b) voice/audio attachments, which carry
 *                                  no text requirement, and (c) an explicit hint
 *                                  telling the user the intent must be enabled
 *                                  instead of silently ignoring them.
 *
 * The bot therefore starts without the privileged intent and remains useful,
 * but never pretends it can read what Discord withheld.
 */

/** The intents the bot requests, named as discord.js names them. */
export const REQUIRED_INTENT_NAMES = ['Guilds', 'GuildMessages', 'GuildVoiceStates'] as const;

export type RequiredIntentName = (typeof REQUIRED_INTENT_NAMES)[number];

/** Documented degradation, surfaced in logs, `--check`, and user-facing hints. */
export const MESSAGE_CONTENT_NOTE =
  'MESSAGE_CONTENT is privileged and must be enabled in the Discord developer portal (Bot > Privileged Gateway Intents) for plain-message reading. Without it the bot only understands @mentions, direct messages, and voice attachments, and replies with a hint.';

/**
 * Compose intent bits from discord.js's enum-like table. Kept dependency-free so
 * unit tests can assert the exact bitmask without importing the library.
 */
export function composeIntents(
  intentTable: Readonly<Record<RequiredIntentName, number>>,
): number {
  return REQUIRED_INTENT_NAMES.reduce((bits, name) => bits | intentTable[name], 0);
}

/**
 * Discord's documented bit values, repeated here so a test can prove the
 * composition without trusting discord.js's constants.
 *
 * Guilds = 1<<0, GuildMessages = 1<<9, GuildVoiceStates = 1<<7.
 */
export const DOCUMENTED_INTENT_BITS: Readonly<Record<RequiredIntentName, number>> = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  GuildVoiceStates: 1 << 7,
};

/** 641: the numeric value sent in the IDENTIFY payload. */
export const DOCUMENTED_INTENT_MASK = composeIntents(DOCUMENTED_INTENT_BITS);