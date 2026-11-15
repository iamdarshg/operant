/**
 * Conversation continuity.
 *
 * A Discord channel (or thread) *is* the conversation. Deriving the id from the
 * channel id has three properties that matter:
 *
 *  - follow-up messages in the same channel attach to the same conversation with
 *    no command, slash syntax or memory in the DSH session;
 *  - a thread gets its own id, so a side discussion cannot contaminate the main
 *    channel's context, and a reply inside the thread continues the thread;
 *  - the mapping is stable across bot restarts because it is a pure function of
 *    the channel id — nothing needs to be persisted to survive a restart.
 *
 * The Discord gateway does not hand the bot a transcript, so continuity is also
 * *synthesised*: the last finished task in the conversation is folded into the
 * new request text as context, which is what the control-plane contract supports
 * today (it accepts `conversationId` but exposes no thread history endpoint).
 */
import type { TaskRecord } from '../api/types.js';

/** One completed or accepted turn, remembered per conversation. */
export interface ConversationTurn {
  readonly taskId: string;
  readonly jobId: string;
  readonly status: string;
  readonly intent: string;
  readonly result: string | null;
  readonly at: number;
}

/** How many turns to remember per conversation before evicting the oldest. */
const MAX_TURNS_PER_CONVERSATION = 8;
/** Keep the injected context small; the API caps request text at 8000 chars. */
const MAX_CONTEXT_CHARS = 1_200;

/**
 * Stable conversation id for a channel or thread.
 *
 * Prefixed so it can never collide with a dashboard- or schedule-originated
 * conversation id, and so a support engineer reading the database knows where a
 * conversation came from.
 */
export function conversationIdForChannel(channelId: string): string {
  return `discord:${channelId}`;
}

export class ConversationStore {
  private readonly turns = new Map<string, ConversationTurn[]>();

  /** Append (or replace) a turn for a conversation. */
  remember(conversationId: string, turn: ConversationTurn): void {
    const current = this.turns.get(conversationId) ?? [];
    const withoutDuplicate = current.filter((entry) => entry.taskId !== turn.taskId);
    this.turns.set(conversationId, [...withoutDuplicate, turn].slice(-MAX_TURNS_PER_CONVERSATION));
  }

  list(conversationId: string): readonly ConversationTurn[] {
    return this.turns.get(conversationId) ?? [];
  }

  /** Most recent turn that reached a terminal state with a usable result. */
  lastFinished(conversationId: string): ConversationTurn | null {
    const list = this.turns.get(conversationId) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const turn = list[index];
      if (!turn) continue;
      if (turn.status === 'succeeded' && turn.result && turn.result.trim() !== '') return turn;
    }
    return null;
  }

  /** Most recent turn regardless of state; used for "still running" hints. */
  last(conversationId: string): ConversationTurn | null {
    const list = this.turns.get(conversationId) ?? [];
    return list[list.length - 1] ?? null;
  }

  /**
   * Seed from the control plane so continuity survives a bot restart.
   * Returns the number of turns actually added.
   */
  hydrate(conversationId: string, tasks: readonly TaskRecord[]): number {
    let added = 0;
    for (const task of tasks) {
      if (!task.id) continue;
      if (this.list(conversationId).some((turn) => turn.taskId === task.id)) continue;
      this.remember(conversationId, {
        taskId: task.id,
        jobId: '',
        status: task.status,
        intent: task.intent,
        result: null,
        at: Date.parse(task.createdAt ?? '') || 0,
      });
      added += 1;
    }
    return added;
  }

  forget(conversationId: string): void {
    this.turns.delete(conversationId);
  }
}

/**
 * Context block prepended to a follow-up request.
 *
 * Phrased as an instruction to the agent, not as hidden state: the agent must be
 * able to tell the difference between "the user said this" and "the previous
 * answer was this".
 */
export function withContinuationContext(text: string, prior: ConversationTurn | null): string {
  if (!prior) return text;
  const summary = (prior.result ?? '').replace(/\s+/g, ' ').trim();
  if (summary === '') return text;
  const context = [
    '[Conversation context — this message continues an earlier request in the same Discord channel.',
    `Earlier request: "${truncateForContext(prior.intent, 240)}"`,
    `Earlier outcome (${prior.status}): "${truncateForContext(summary, MAX_CONTEXT_CHARS)}"`,
    'Treat this as a follow-up: use the earlier outcome where relevant, and do not repeat work already done.]',
  ].join('\n');
  // The API rejects text over 8000 characters; give the user's words priority.
  if (text.length + context.length + 2 > 7_800) return text;
  return `${context}\n\n${text}`;
}

function truncateForContext(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** One-line hint when a channel already has work in flight. */
export function pendingNotice(prior: ConversationTurn): string {
  return `⏭️ A task is still running in this channel (\`${prior.taskId.slice(0, 8)}\`, ${prior.status}). I queued this one too.`;
}