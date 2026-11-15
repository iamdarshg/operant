/**
 * The only file that touches discord.js.
 *
 * Everything else speaks the structural types in `./types.ts`, which is what
 * makes the bot's logic testable without a gateway. This adapter is deliberately
 * thin — it converts discord.js objects into the bot's shapes and hands them to
 * `OperantBot`, and converts outbound payloads back.
 *
 * **This file cannot be unit-tested here**: it needs a live gateway and a bot
 * token, neither of which exists in this environment. It is type-checked by the
 * build, and its behaviour is exercised only indirectly through the structural
 * objects the rest of the bot is tested with. Nothing in the test suite claims
 * otherwise.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  type ButtonInteraction as DiscordButtonInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type Message,
  type MessageEditOptions,
  type MessageReplyOptions,
  type RepliableInteraction,
  type TextBasedChannel,
} from 'discord.js';
import type { Logger } from '../logger.js';
import type { BotConfig } from '../config.js';
import { MESSAGE_CONTENT_NOTE, composeIntents } from './intents.js';
import type {
  ButtonInteraction,
  IncomingAttachment,
  IncomingMessage,
  OutboundMessage,
  RenderableChannel,
  RenderableMessage,
} from './types.js';

export interface GatewayHandlers {
  readonly logger: Logger;
  onMessage(message: IncomingMessage): Promise<void>;
  onInteraction(interaction: ButtonInteraction): Promise<void>;
}

export interface GatewayHandle {
  stop(): Promise<void>;
}

/**
 * Payload shapes cross the adapter boundary as plain REST objects. The casts are
 * the seam: the bot builds the exact embed/component JSON Discord's REST API
 * accepts, and these helpers only re-label it for the library's generic types
 * (whose `flags` unions differ per call site).
 */
function toReplyOptions(payload: OutboundMessage): MessageReplyOptions {
  return payload as unknown as MessageReplyOptions;
}

function toEditOptions(payload: OutboundMessage): MessageEditOptions {
  return payload as unknown as MessageEditOptions;
}

function toInteractionReplyOptions(
  payload: OutboundMessage & { readonly ephemeral?: boolean },
): InteractionReplyOptions {
  return {
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(payload.embeds ? { embeds: payload.embeds as unknown as InteractionReplyOptions['embeds'] } : {}),
    ...(payload.components
      ? { components: payload.components as unknown as InteractionReplyOptions['components'] }
      : {}),
    ...(payload.ephemeral === true ? { ephemeral: true } : {}),
  };
}

function toInteractionUpdateOptions(payload: OutboundMessage): InteractionUpdateOptions {
  return payload as unknown as InteractionUpdateOptions;
}

/**
 * Build the client with the minimum usable intents.
 *
 * MESSAGE_CONTENT is intentionally absent: it is privileged. See
 * `./intents.ts` for what still works without it and what the user is told.
 */
export function createGatewayClient(): Client {
  return new Client({
    intents: composeIntents({
      Guilds: GatewayIntentBits.Guilds,
      GuildMessages: GatewayIntentBits.GuildMessages,
      GuildVoiceStates: GatewayIntentBits.GuildVoiceStates,
    }),
    // Replies echo user text; never ping anyone because of it.
    allowedMentions: { parse: [], repliedUser: false },
  });
}

function isSendable(
  channel: TextBasedChannel | null | undefined,
): channel is TextBasedChannel & {
  send(payload: MessageReplyOptions): Promise<Message>;
} {
  if (!channel) return false;
  return typeof (channel as { send?: unknown }).send === 'function';
}

/** Adapt a channel to the narrow send surface, or null when it cannot post. */
export function adaptChannel(channel: TextBasedChannel | null | undefined): RenderableChannel | null {
  if (!isSendable(channel)) return null;
  const target = channel;
  return {
    id: target.id,
    send: async (payload) => {
      const sent = await target.send(toReplyOptions(payload));
      return adaptSentMessage(sent);
    },
  };
}

function adaptSentMessage(message: Message): RenderableMessage {
  return {
    id: message.id,
    edit: async (payload) => message.edit(toEditOptions(payload)),
  };
}

export function adaptMessage(message: Message): IncomingMessage | null {
  const channel = adaptChannel(message.channel as TextBasedChannel | null);
  if (!channel) return null;
  const attachments: IncomingAttachment[] = [];
  for (const attachment of message.attachments.values()) {
    attachments.push({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      size: attachment.size,
      contentType: attachment.contentType ?? null,
    });
  }
  const channelIsThread =
    typeof (message.channel as { isThread?: unknown }).isThread === 'function'
      ? (message.channel as { isThread(): boolean }).isThread()
      : false;

  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    channel,
    content: message.content,
    author: {
      id: message.author.id,
      bot: message.author.bot,
      username: message.author.username,
      tag: message.author.tag,
    },
    attachments,
    inThread: channelIsThread,
    reply: async (payload) => {
      const sent = await message.reply(toReplyOptions(payload));
      return adaptSentMessage(sent);
    },
  };
}

function isRepliableButton(interaction: Interaction): interaction is DiscordButtonInteraction {
  return interaction.isButton();
}

export function adaptInteraction(interaction: Interaction): ButtonInteraction | null {
  if (!isRepliableButton(interaction)) return null;
  const channel = adaptChannel(interaction.channel as TextBasedChannel | null);
  if (!channel) return null;
  const repliable = interaction as RepliableInteraction;
  return {
    id: interaction.id,
    customId: interaction.customId,
    messageId: interaction.message.id,
    channelId: interaction.channelId,
    channel,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      bot: interaction.user.bot,
    },
    reply: async (payload) => {
      await repliable.reply(toInteractionReplyOptions(payload));
    },
    update: async (payload) => {
      await interaction.update(toInteractionUpdateOptions(payload));
    },
  };
}

/**
 * Log in and start dispatching. Rejects if Discord refuses the token; the caller
 * turns that into a clean exit rather than an unhandled rejection.
 */
export async function startGateway(
  handlers: GatewayHandlers,
  token: string,
  config: BotConfig,
): Promise<GatewayHandle> {
  const logger = handlers.logger;
  const client = createGatewayClient();

  client.on(Events.Error, (error) => {
    logger.error('discord gateway error', { error: error.message });
  });
  client.on(Events.Warn, (message) => {
    logger.warn('discord gateway warning', { detail: message });
  });

  client.on(Events.MessageCreate, (message) => {
    const adapted = adaptMessage(message);
    if (!adapted) return;
    void handlers.onMessage(adapted).catch((error: unknown) => {
      logger.error('message handler failed', {
        channelId: adapted.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    const adapted = adaptInteraction(interaction);
    if (!adapted) return;
    void handlers.onInteraction(adapted).catch((error: unknown) => {
      logger.error('interaction handler failed', {
        interactionId: adapted.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  client.once(Events.ClientReady, (ready) => {
    logger.info('discord gateway ready', {
      user: ready.user.username,
      userId: ready.user.id,
      guilds: ready.guilds.cache.size,
      intents: composeIntents({
        Guilds: GatewayIntentBits.Guilds,
        GuildMessages: GatewayIntentBits.GuildMessages,
        GuildVoiceStates: GatewayIntentBits.GuildVoiceStates,
      }),
      messageContentIntent: false,
    });
    logger.info('intent note', { detail: MESSAGE_CONTENT_NOTE });
    if (config.allowedUserIds.length === 0 && config.allowedChannelIds.length === 0) {
      logger.warn(
        'no discord allow-list configured — every message will be refused until DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOWED_CHANNEL_IDS is set',
      );
    }
  });

  await client.login(token);
  return {
    stop: async () => {
      client.removeAllListeners();
      await client.destroy();
    },
  };
}