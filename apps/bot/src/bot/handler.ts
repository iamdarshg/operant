/**
 * Message routing — the bot's one rule: a plain message in an allowed channel is
 * a request.
 *
 * The handler is intentionally short and synchronous in shape:
 *
 *   1. ignore bots;
 *   2. authorize (a refusal never reaches the API);
 *   3. read voice, if any (transcript becomes the request text);
 *   4. post a "working" reply **before** calling the control plane;
 *   5. POST /v1/requests, register the conversation turn, and hand the message to
 *      the job tracker without awaiting it.
 *
 * Step 4-before-5 and step 5-without-awaiting are the two properties that keep
 * one long job from stalling the gateway: the handler's latency is a couple of
 * Discord writes plus one HTTP round-trip, regardless of how long the work takes.
 */
import { ApiError, describeError, type OperantApi } from '../api/client.js';
import type { BotConfig } from '../config.js';
import type { ButtonInteraction, IncomingMessage, RenderableChannel, RenderableMessage } from '../discord/types.js';
import type { Logger } from '../logger.js';
import { authorize, policyIsClosed, type AccessPolicy } from './authorize.js';
import { conversationIdForChannel, pendingNotice, withContinuationContext, ConversationStore } from './conversation.js';
import {
  apiDownNotice,
  apiRejectedNotice,
  emptyContentHint,
  renderAccepted,
  refusalText,
  transcriptAck,
  transcriptionFailedNotice,
} from './copy.js';
import { JobRunner, type JobTarget, type JobTracker } from './job-runner.js';
import { realClock, type Clock } from './rate-limit.js';
import { findAudioAttachment, transcribeAudioAttachment, type VoiceDeps } from './voice.js';

/** The control-plane surface the bot needs; narrow so tests can fake it. */
export type BotApi = Pick<
  OperantApi,
  'createRequest' | 'transcribe' | 'openJobStream' | 'getJobEvents' | 'getTask'
>;

export interface ApprovalSink {
  trackTask(taskId: string, channel: RenderableChannel): void;
  untrackTask(taskId: string): void;
  handleInteraction(interaction: ButtonInteraction): Promise<'handled' | 'ignored'>;
  pollSoon?(): void;
  stop?(): void;
}

export interface BotDeps {
  readonly config: BotConfig;
  readonly api: BotApi;
  readonly logger: Logger;
  readonly approvals: ApprovalSink;
  readonly conversations?: ConversationStore;
  readonly clock?: Clock;
  /** Injected so the voice download can be faked in tests. */
  readonly fetchImpl?: VoiceDeps['fetchImpl'];
}

const STATUS_AFFORDANCE = /^\s*\/(status)\s*$/i;

export class OperantBot {
  readonly conversations: ConversationStore;
  private readonly deps: BotDeps;
  private readonly clock: Clock;
  private readonly runner: JobRunner;
  private readonly inFlight = new Set<Promise<unknown>>();
  private shuttingDown = false;

  constructor(deps: BotDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.conversations = deps.conversations ?? new ConversationStore();

    this.runner = new JobRunner({
      api: deps.api,
      logger: deps.logger,
      editIntervalMs: deps.config.editIntervalMs,
      pollIntervalMs: deps.config.pollIntervalMs,
      jobTimeoutMs: deps.config.jobTimeoutMs,
      ...(deps.clock ? { clock: deps.clock } : {}),
      onFinished: (turn) => {
        this.conversations.remember(turn.conversationId, {
          taskId: turn.taskId,
          jobId: turn.jobId,
          status: turn.status,
          intent: turn.intent,
          result: turn.result,
          at: this.clock.now(),
        });
        this.deps.approvals.untrackTask(turn.taskId);
        this.deps.logger.info('job finished', {
          taskId: turn.taskId,
          jobId: turn.jobId,
          status: turn.status,
        });
      },
      onApprovalRequested: ({ taskId, jobId, approvalId }) => {
        this.deps.logger.info('job is waiting for approval', { taskId, jobId, approvalId });
        this.deps.approvals.pollSoon?.();
      },
    });
  }

  get policy(): AccessPolicy {
    return {
      allowedUserIds: this.deps.config.allowedUserIds,
      allowedChannelIds: this.deps.config.allowedChannelIds,
    };
  }

  /**
   * Handle one message. Resolves once the request has been accepted (or refused);
   * it does not wait for the job.
   */
  async handleMessage(message: IncomingMessage): Promise<void> {
    if (message.author.bot) return;

    const policy = this.policy;
    const decision = authorize(
      { userId: message.author.id, channelId: message.channelId },
      policy,
    );
    if (!decision.allowed) {
      // Deliberately before any API call: refusal must not create a task.
      this.deps.logger.warn('refused unauthorized message', {
        userId: message.author.id,
        channelId: message.channelId,
        guildId: message.guildId,
        reason: decision.reason,
        closed: policyIsClosed(policy),
      });
      await this.post(message, refusalText(decision.reason));
      return;
    }

    const conversationId = conversationIdForChannel(message.channelId);
    const audio = findAudioAttachment(message.attachments);
    let text = message.content.trim();

    if (audio) {
      const ack = await this.post(message, '🎙️ Transcribing your voice message…');
      if (!ack) return;
      const result = await transcribeAudioAttachment(audio, {
        api: this.deps.api,
        logger: this.deps.logger,
        maxAttachmentBytes: this.deps.config.maxAttachmentBytes,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
      if (!result.ok) {
        await this.edit(ack, transcriptionFailedNotice(result.error));
        return;
      }
      this.deps.logger.info('transcribed voice message', {
        channelId: message.channelId,
        bytes: result.bytes,
        durationSec: result.transcript.durationSec,
        model: result.transcript.model,
        rtf: result.transcript.rtf,
      });
      await this.edit(ack, transcriptAck(result.transcript));
      const spoken = result.transcript.text.trim();
      text = text === '' ? spoken : `${text}\n\n${spoken}`;
    }

    if (text === '') {
      await this.post(message, emptyContentHint());
      return;
    }

    if (STATUS_AFFORDANCE.test(text)) {
      await this.post(message, this.statusSummary(conversationId));
      return;
    }

    await this.submit(message, text, conversationId);
  }

  /** Accept a request and start tracking it; returns as soon as the API answers. */
  private async submit(message: IncomingMessage, text: string, conversationId: string): Promise<void> {
    const prior = this.conversations.lastFinished(conversationId);
    const requestText = withContinuationContext(text, prior);
    const continued = requestText !== text;

    // The reply is posted first so the user sees "accepted" even if the control
    // plane is slow. It is the message every later state edits in place.
    const working = await this.post(message, renderAccepted(text));
    if (!working) return;

    let accepted;
    try {
      accepted = await this.deps.api.createRequest({
        text: requestText,
        origin: 'discord',
        requestedBy: message.author.id,
        conversationId,
        requireVerification: false,
      });
    } catch (error) {
      this.deps.logger.error('request submission failed', {
        channelId: message.channelId,
        conversationId,
        error: describeError(error),
      });
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      await this.edit(working, rejected ? apiRejectedNotice(describeError(error)) : apiDownNotice(describeError(error)));
      return;
    }

    if (!accepted.taskId || !accepted.jobId) {
      this.deps.logger.error('control plane accepted the request without ids', {
        channelId: message.channelId,
        response: accepted,
      });
      await this.edit(working, apiDownNotice('the control plane returned an incomplete response'));
      return;
    }

    this.deps.logger.info('request accepted', {
      taskId: accepted.taskId,
      jobId: accepted.jobId,
      agentId: accepted.agentId,
      channelId: message.channelId,
      conversationId,
      continued,
    });

    this.conversations.remember(conversationId, {
      taskId: accepted.taskId,
      jobId: accepted.jobId,
      status: accepted.status,
      intent: text,
      result: null,
      at: this.clock.now(),
    });
    this.deps.approvals.trackTask(accepted.taskId, message.channel);

    const target: JobTarget = {
      taskId: accepted.taskId,
      jobId: accepted.jobId,
      conversationId,
      intent: text,
      agentId: accepted.agentId || null,
      message: working,
    };

    // Detached on purpose: the gateway must return to serving other channels.
    const tracking = this.runner
      .track(target)
      .catch((error: unknown) => {
        this.deps.logger.error('job tracking crashed', {
          taskId: accepted.taskId,
          error: describeError(error),
        });
      })
      .finally(() => {
        this.inFlight.delete(tracking);
      });
    this.inFlight.add(tracking);
  }

  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    await this.deps.approvals.handleInteraction(interaction);
  }

  /** Resolve once every detached job tracker has settled (tests, graceful stop). */
  async whenIdle(): Promise<void> {
    for (let round = 0; round < 5 && this.inFlight.size > 0; round += 1) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Abort in-flight streams and let the watcher stop; never throws. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.runner.abortAll();
    this.deps.approvals.stop?.();
    await this.whenIdle();
  }

  /** Human-readable status for `/status`; reads local state, no API call. */
  private statusSummary(conversationId: string): string {
    const turns = this.conversations.list(conversationId).slice(-3);
    if (turns.length === 0) {
      return 'Nothing has been asked in this channel yet. Send a plain message and I will treat it as a request.';
    }
    const lines = ['📋 **Recent work in this channel**'];
    for (const turn of turns) {
      const marker =
        turn.status === 'succeeded'
          ? '✅'
          : turn.status === 'failed'
            ? '❌'
            : turn.status === 'cancelled'
              ? '🚫'
              : '⏳';
      lines.push(`${marker} \`${turn.taskId.slice(0, 8)}\` ${turn.status} — ${turn.intent.slice(0, 80)}`);
    }
    const last = turns[turns.length - 1];
    if (last && !['succeeded', 'failed', 'cancelled'].includes(last.status)) {
      lines.push('', pendingNotice(last));
    }
    return lines.join('\n').slice(0, 1_900);
  }

  private async post(message: IncomingMessage, content: string): Promise<RenderableMessage | null> {
    try {
      return await message.reply({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      this.deps.logger.warn('could not post a reply', {
        channelId: message.channelId,
        messageId: message.id,
        error: describeError(error),
      });
      return null;
    }
  }

  private async edit(message: RenderableMessage, content: string): Promise<void> {
    try {
      await message.edit({ content });
    } catch (error) {
      this.deps.logger.warn('could not edit a message', {
        messageId: message.id,
        error: describeError(error),
      });
    }
  }
}