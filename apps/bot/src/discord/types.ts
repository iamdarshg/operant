/**
 * Structural Discord types.
 *
 * The bot never talks to discord.js directly outside `discord/gateway.ts`. It
 * works against these narrow interfaces, which have two consequences worth
 * stating because they are the reason this design was chosen:
 *
 *  - the routing/streaming/approval logic is unit-testable with plain objects,
 *    so the suite proves behaviour without a gateway or a network;
 *  - discord.js upgrades that change unrelated surface area cannot ripple
 *    through the bot's logic — only the adapter has to keep up.
 *
 * Shapes mirror discord.js v14's REST payloads (`embeds`, `components`,
 * `allowedMentions`) so the adapter is a straight pass-through.
 */

export interface OutboundEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface OutboundEmbed {
  readonly title?: string;
  readonly description?: string;
  /** Integer colour, 0xRRGGBB. */
  readonly color?: number;
  readonly fields?: readonly OutboundEmbedField[];
  readonly footer?: { readonly text: string };
  readonly timestamp?: string;
}

export interface OutboundButton {
  readonly type: 2;
  /** 1 primary, 2 secondary, 3 success, 4 danger. */
  readonly style: 1 | 2 | 3 | 4;
  readonly label: string;
  readonly custom_id: string;
  readonly disabled?: boolean;
}

export interface OutboundActionRow {
  readonly type: 1;
  readonly components: readonly OutboundButton[];
}

export interface OutboundMessage {
  readonly content?: string;
  readonly embeds?: readonly OutboundEmbed[];
  readonly components?: readonly OutboundActionRow[];
  /** Keep the bot from pinging anyone by echoing text. */
  readonly allowedMentions?: { readonly parse: readonly string[] };
}

/** Anything the bot can edit in place. */
export interface RenderableMessage {
  readonly id: string;
  edit(payload: OutboundMessage): Promise<unknown>;
}

/** Anything the bot can post into. */
export interface RenderableChannel {
  readonly id: string;
  send(payload: OutboundMessage): Promise<RenderableMessage>;
}

export interface IncomingAttachment {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly contentType: string | null;
}

export interface IncomingAuthor {
  readonly id: string;
  readonly bot: boolean;
  readonly username: string;
  /** `username#discriminator` or the new global display name. */
  readonly tag?: string;
}

export interface IncomingMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly channel: RenderableChannel;
  readonly content: string;
  readonly author: IncomingAuthor;
  readonly attachments: readonly IncomingAttachment[];
  /** True when the message arrived in a thread (own channel id, own conversation). */
  readonly inThread?: boolean;
  reply(payload: OutboundMessage): Promise<RenderableMessage>;
}

export interface InteractionReply extends OutboundMessage {
  readonly ephemeral?: boolean;
}

/** The slice of a button interaction the bot actually uses. */
export interface ButtonInteraction {
  readonly id: string;
  readonly customId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly channel: RenderableChannel;
  readonly user: { readonly id: string; readonly username: string; readonly bot?: boolean };
  /** Acknowledge privately; used for refusals and confirmations. */
  reply(payload: InteractionReply): Promise<unknown>;
  /** Edit the message the button belongs to (the approval card). */
  update(payload: OutboundMessage): Promise<unknown>;
}