/**
 * Approvals.
 *
 * A pending approval is a job that is *stopped* until a human decides, so the
 * bot's job is to make the decision cheap and the authority explicit:
 *
 *  - the card names the action, the risk, the task and the deadline;
 *  - Approve/Reject are the only controls, and their custom ids carry the
 *    approval id so a click is unambiguous;
 *  - the clicker is authorized with the same allow-list as messages — an
 *    approval button must never be a second, weaker door;
 *  - the card is edited to show the decision and its button row is removed, so
 *    nobody can click a settled approval into a different outcome;
 *  - the API's 409 ("not pending") is surfaced as "already decided", not as an
 *    error, because it is a race the UI should absorb.
 */
import { ApiError, describeError, type OperantApi } from '../api/client.js';
import type { ApprovalRecord } from '../api/types.js';
import type { ButtonInteraction, RenderableChannel, RenderableMessage } from '../discord/types.js';
import type { Logger } from '../logger.js';
import { authorize, type AccessPolicy } from './authorize.js';
import {
  alreadyDecidedNotice,
  approvalCard,
  decisionMessage,
  parseApprovalCustomId,
  unauthorizedClickReply,
} from './copy.js';
import { realClock, type Clock } from './rate-limit.js';

export interface ApprovalWatcherDeps {
  readonly api: Pick<OperantApi, 'listApprovals' | 'decideApproval'>;
  readonly logger: Logger;
  readonly policy: AccessPolicy;
  readonly pollMs: number;
  readonly clock?: Clock;
  /** Extracted for tests; defaults to a real timer. */
  readonly onPosted?: (approvalId: string, messageId: string) => void;
}

interface TrackedTask {
  readonly taskId: string;
  readonly channel: RenderableChannel;
}

interface PostedApproval {
  readonly approvalId: string;
  readonly taskId: string;
  readonly channelId: string;
  message: RenderableMessage;
}

export class ApprovalWatcher {
  private readonly deps: ApprovalWatcherDeps;
  private readonly clock: Clock;
  private readonly tracked = new Map<string, TrackedTask>();
  private readonly posted = new Map<string, PostedApproval>();
  private readonly decided = new Map<string, 'approved' | 'rejected'>();
  private timer: unknown = null;
  private stopped = true;
  private polling = false;

  constructor(deps: ApprovalWatcherDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
  }

  /** Start watching a task's channel; called when a request is accepted. */
  trackTask(taskId: string, channel: RenderableChannel): void {
    this.tracked.set(taskId, { taskId, channel });
  }

  untrackTask(taskId: string): void {
    this.tracked.delete(taskId);
  }

  /** True once this approval has a card in a channel. */
  hasPosted(approvalId: string): boolean {
    return this.posted.has(approvalId);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Poll immediately (used when a job event announces an approval). */
  pollSoon(): void {
    if (this.stopped) return;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => this.scheduleNext());
    }, 0);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => this.scheduleNext());
    }, this.deps.pollMs);
  }

  /**
   * One sweep of `/v1/approvals`. Returns how many cards were posted.
   * Never throws: a control-plane hiccup must not take the watcher down.
   */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    if (this.tracked.size === 0) return 0;
    this.polling = true;
    try {
      const pending = await this.deps.api.listApprovals('pending');
      let postedCount = 0;
      for (const approval of pending) {
        if (this.posted.has(approval.id)) continue;
        const taskId = approval.taskId;
        if (!taskId) continue;
        const tracked = this.tracked.get(taskId);
        if (!tracked) continue;
        const message = await tracked.channel.send(approvalCard(approval));
        this.posted.set(approval.id, {
          approvalId: approval.id,
          taskId,
          channelId: tracked.channel.id,
          message,
        });
        postedCount += 1;
        this.deps.logger.info('approval card posted', {
          approvalId: approval.id,
          taskId,
          risk: approval.risk,
        });
        this.deps.onPosted?.(approval.id, message.id);
      }
      return postedCount;
    } catch (error) {
      this.deps.logger.warn('approval sweep failed; will retry', {
        error: describeError(error),
      });
      return 0;
    } finally {
      this.polling = false;
    }
  }

  /**
   * Handle a button click. Returns 'ignored' for interactions this bot does not
   * own (another component id), 'handled' otherwise.
   */
  async handleInteraction(interaction: ButtonInteraction): Promise<'handled' | 'ignored'> {
    const parsed = parseApprovalCustomId(interaction.customId);
    if (!parsed) {
      this.deps.logger.debug('ignoring interaction with a foreign custom id', {
        customId: interaction.customId,
      });
      return 'ignored';
    }
    if (interaction.user.bot === true) {
      this.deps.logger.debug('ignoring interaction from a bot user', { userId: interaction.user.id });
      return 'ignored';
    }

    // Authorization happens before any write. This is the same allow-list that
    // gates messages: approving an action is at least as sensitive as asking for
    // one, so a click from a stranger must not reach the API.
    const decision = authorize(
      { userId: interaction.user.id, channelId: interaction.channelId },
      this.deps.policy,
    );
    if (!decision.allowed) {
      this.deps.logger.warn('unauthorized approval click refused', {
        userId: interaction.user.id,
        channelId: interaction.channelId,
        approvalId: parsed.approvalId,
        reason: decision.reason,
      });
      await interaction.reply(unauthorizedClickReply()).catch(() => {});
      return 'handled';
    }

    const decisionWord = parsed.action;
    const decidedBy = `${interaction.user.username} (${interaction.user.id})`;
    const local = this.posted.get(parsed.approvalId);

    try {
      const updated = await this.deps.api.decideApproval(parsed.approvalId, {
        decision: decisionWord,
        decidedBy,
      });
      this.decided.set(parsed.approvalId, decisionWord === 'approve' ? 'approved' : 'rejected');
      const payload = decisionMessage({
        approvalId: parsed.approvalId,
        taskId: updated.taskId ?? local?.taskId ?? null,
        summary: updated.summary,
        decision: decisionWord,
        decidedBy,
      });
      await this.applyDecision(interaction, payload);
      this.deps.logger.info('approval decided', {
        approvalId: parsed.approvalId,
        decision: decisionWord,
        decidedBy,
      });
      return 'handled';
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const payload = {
          content: alreadyDecidedNotice(),
          components: [],
          allowedMentions: { parse: [] },
        };
        await this.applyDecision(interaction, payload);
        this.deps.logger.info('approval was already decided', {
          approvalId: parsed.approvalId,
        });
        return 'handled';
      }
      this.deps.logger.error('approval decision failed', {
        approvalId: parsed.approvalId,
        error: describeError(error),
      });
      await interaction
        .reply({
          content: `⚠️ I could not record that decision: ${describeError(error)}`,
          ephemeral: true,
        })
        .catch(() => {});
      return 'handled';
    }
  }

  /** Edit the card in place; falls back to the stored message if `update` fails. */
  private async applyDecision(
    interaction: ButtonInteraction,
    payload: Parameters<ButtonInteraction['update']>[0],
  ): Promise<void> {
    try {
      await interaction.update(payload);
    } catch (error) {
      this.deps.logger.warn('interaction.update failed; trying stored message', {
        interactionId: interaction.id,
        error: describeError(error),
      });
      const local = this.posted.get(parseApprovalCustomId(interaction.customId)?.approvalId ?? '');
      if (local) await local.message.edit(payload).catch(() => {});
    }
  }

  /** Local view of approvals decided in this process (used by tests/diagnostics). */
  decisionFor(approvalId: string): 'approved' | 'rejected' | null {
    return this.decided.get(approvalId) ?? null;
  }

  /** Which approvals have cards, by id. */
  postedIds(): string[] {
    return [...this.posted.keys()];
  }

  /** Test/diagnostic access to a posted approval without exposing the message. */
  trackOf(approvalId: string): { taskId: string; channelId: string } | null {
    const entry = this.posted.get(approvalId);
    return entry ? { taskId: entry.taskId, channelId: entry.channelId } : null;
  }
}

/** Re-exported so callers do not need the type import for a card. */
export type { ApprovalRecord };