/**
 * Message copy.
 *
 * The four states a human needs to tell apart are pinned here as named
 * headlines, because "is this still working, is it done, or is it waiting on
 * me?" is the only question a chat surface has to answer:
 *
 *   request / background  — accepted and working, nothing needed from you
 *   waiting_approval      — paused, blocked on a human decision
 *   completed             — the work finished, here is the result
 *   failed / cancelled    — it stopped, here is why
 *
 * All functions are pure so the wording is testable without Discord.
 */
import type {
  ApprovalRecord,
  TaskRecord,
} from '../api/types.js';
import type {
  InteractionReply,
  OutboundActionRow,
  OutboundButton,
  OutboundEmbed,
  OutboundEmbedField,
  OutboundMessage,
} from '../discord/types.js';

/** Discord hard-caps message content at 2000 characters. */
export const MAX_CONTENT = 1_900;

export type ActivityKind =
  | 'request'
  | 'background'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const HEADLINES: Readonly<Record<ActivityKind, string>> = {
  request: '📥 Request accepted — working in the background',
  background: '⚙️ Background activity',
  waiting_approval: '⏳ Work paused — approval required',
  completed: '✅ Work completed',
  failed: '❌ Work failed',
  cancelled: '🚫 Work cancelled',
};

export interface ProgressState {
  readonly taskId: string;
  readonly jobId: string;
  readonly agentId: string | null;
  readonly intent: string;
  readonly status: string;
  readonly eventCount: number;
  readonly toolCalls: readonly string[];
  readonly lastText: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly approvalCount: number;
  readonly elapsedMs: number;
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** Chunk a long result into readable lines instead of one wall of text. */
function quote(text: string, max: number): string {
  return truncate(text, max);
}

function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Which of the six states the copy should reflect. */
export function phaseOf(state: ProgressState): ActivityKind {
  const status = state.status.toLowerCase();
  if (status === 'succeeded') return 'completed';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled';
  if (state.approvalCount > 0 || status === 'waiting_approval') return 'waiting_approval';
  if (state.eventCount === 0 && status !== 'running' && status !== 'dispatched') return 'request';
  if (state.eventCount === 0) return 'request';
  return 'background';
}

export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * The one message the bot keeps editing while a job runs.
 *
 * It always leads with the phase headline, quotes the user's original words so a
 * channel with several requests stays readable, then adds the least surprising
 * amount of detail for that phase.
 */
export function renderProgress(state: ProgressState): string {
  const phase = phaseOf(state);
  const lines: string[] = [HEADLINES[phase]];

  if (state.intent.trim() !== '') lines.push(`> ${quote(state.intent, 180)}`);

  if (phase === 'completed') {
    const body = state.result?.trim() || '(the agent returned no final message)';
    lines.push('', '**Result**', truncate(body, 1_200));
  } else if (phase === 'failed' || phase === 'cancelled') {
    const body = state.error?.trim() || state.lastText?.trim() || 'no reason was reported';
    lines.push('', '**Reason**', truncate(body, 800));
    if (state.result?.trim()) lines.push('', '**Last output**', truncate(state.result, 400));
  } else if (phase === 'waiting_approval') {
    lines.push('', 'Nothing is running until a human decides. The approval card is below.');
  } else if (phase === 'background') {
    if (state.lastText?.trim()) lines.push('', truncate(state.lastText, 600));
    if (state.toolCalls.length > 0) {
      lines.push('', `Tools: ${state.toolCalls.slice(-6).join(', ')}`);
    }
  } else {
    lines.push('', 'Queued for the agent. This message updates as work happens.');
  }

  const facts = [
    `task \`${shortId(state.taskId)}\``,
    state.agentId ? `agent \`${state.agentId}\`` : null,
    `${state.eventCount} event${state.eventCount === 1 ? '' : 's'}`,
    humanDuration(state.elapsedMs),
    `status ${state.status}`,
  ].filter((part): part is string => Boolean(part));

  lines.push('', facts.join(' · '));
  return truncate(lines.join('\n'), MAX_CONTENT);
}

/** The immediate acknowledgement, posted before any HTTP call is made. */
export function renderAccepted(intent: string): string {
  return truncate(
    [
      HEADLINES.request,
      `> ${quote(intent, 180)}`,
      '',
      'Dispatching to the control plane. This message updates as the job runs.',
    ].join('\n'),
    MAX_CONTENT,
  );
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

const RISK_COLORS: Readonly<Record<string, number>> = {
  low: 0x2f9e44,
  medium: 0xe5a50a,
  high: 0xf26419,
  critical: 0xe01e37,
};

function riskColor(risk: string): number {
  return RISK_COLORS[risk.toLowerCase()] ?? 0x577590;
}

function embedField(name: string, value: string, inline = false): OutboundEmbedField {
  return { name, value: truncate(value, 1_000) || '—', inline };
}

export function approvalCustomId(action: 'approve' | 'reject', approvalId: string): string {
  return `operant:approval:${action}:${approvalId}`;
}

export interface ParsedApprovalButton {
  readonly action: 'approve' | 'reject';
  readonly approvalId: string;
}

/** Returns null for any custom id this bot did not create. */
export function parseApprovalCustomId(customId: string): ParsedApprovalButton | null {
  const parts = customId.split(':');
  if (parts.length !== 4) return null;
  const [namespace, kind, action, approvalId] = parts;
  if (namespace !== 'operant' || kind !== 'approval') return null;
  if (action !== 'approve' && action !== 'reject') return null;
  if (!approvalId) return null;
  return { action, approvalId };
}

export function approvalButtons(
  approvalId: string,
  disabled = false,
): OutboundActionRow[] {
  const approve: OutboundButton = {
    type: 2,
    style: 3,
    label: 'Approve',
    custom_id: approvalCustomId('approve', approvalId),
    ...(disabled ? { disabled: true } : {}),
  };
  const reject: OutboundButton = {
    type: 2,
    style: 4,
    label: 'Reject',
    custom_id: approvalCustomId('reject', approvalId),
    ...(disabled ? { disabled: true } : {}),
  };
  return [{ type: 1, components: [approve, reject] }];
}

export function approvalCard(approval: ApprovalRecord): OutboundMessage {
  const fields: OutboundEmbedField[] = [
    embedField('Risk', approval.risk.toUpperCase(), true),
    embedField('Requested by', approval.requestedBy ?? 'unknown', true),
  ];
  if (approval.action) {
    fields.push(embedField('Action', `${approval.action.kind}`));
    const payload = approval.action.payload;
    const keys = Object.keys(payload);
    if (keys.length > 0) {
      fields.push(embedField('Payload', keys.slice(0, 6).map((k) => `${k}: ${String(payload[k])}`).join('\n')));
    }
  }
  if (approval.taskId) fields.push(embedField('Task', `\`${shortId(approval.taskId)}\``, true));
  if (approval.expiresAt) {
    fields.push(embedField('Expires', approval.expiresAt, true));
  }

  const embed: OutboundEmbed = {
    title: 'Approval required',
    description: truncate(approval.summary, 1_200),
    color: riskColor(approval.risk),
    fields,
    footer: { text: `approval ${approval.id}` },
  };

  return {
    content: `${HEADLINES.waiting_approval} — an agent is blocked until someone decides.`,
    embeds: [embed],
    components: approvalButtons(approval.id),
    allowedMentions: { parse: [] },
  };
}

export function decisionMessage(input: {
  readonly approvalId: string;
  readonly taskId: string | null;
  readonly summary: string;
  readonly decision: 'approve' | 'reject';
  readonly decidedBy: string;
  readonly decidedAt?: string;
}): OutboundMessage {
  const approved = input.decision === 'approve';
  const embed: OutboundEmbed = {
    title: approved ? 'Approved' : 'Rejected',
    description: truncate(input.summary, 1_200),
    color: approved ? 0x2f9e44 : 0xe01e37,
    fields: [
      embedField('Decision', approved ? 'approved' : 'rejected', true),
      embedField('Decided by', input.decidedBy, true),
      ...(input.decidedAt ? [embedField('At', input.decidedAt, true)] : []),
      ...(input.taskId ? [embedField('Task', `\`${shortId(input.taskId)}\``, true)] : []),
    ],
    footer: { text: `approval ${input.approvalId}` },
  };
  return {
    content: approved
      ? `✅ Approved by **${input.decidedBy}** — the agent may continue.`
      : `❌ Rejected by **${input.decidedBy}** — the agent will not take that action.`,
    embeds: [embed],
    // The card is settled; leaving live buttons would invite a second decision.
    components: [],
    allowedMentions: { parse: [] },
  };
}

/* ------------------------------------------------------------------ *
 * Short notices
 * ------------------------------------------------------------------ */

export function refusalText(reason: 'user' | 'channel' | 'no_allowlist'): string {
  if (reason === 'no_allowlist') {
    return '🔒 I am not allowed to take requests yet: no allow-list is configured (`DISCORD_ALLOWED_USER_IDS` / `DISCORD_ALLOWED_CHANNEL_IDS`). Ask the operator to add you.';
  }
  return '🔒 Sorry — you are not on the allow-list for this bot, so I cannot run anything for you. Nothing was sent to the control plane.';
}

export function emptyContentHint(): string {
  return [
    '👀 I got your message but Discord gave me no text.',
    'Plain-message reading needs the privileged **MESSAGE_CONTENT** intent enabled in the developer portal (Bot → Privileged Gateway Intents).',
    'Meanwhile: @mention me with your request, or send a voice note — voice attachments work without that intent.',
  ].join('\n');
}

export function apiDownNotice(detail: string): string {
  return [
    '⚠️ I could not reach the Operant control plane, so this request was not accepted.',
    `-# ${truncate(detail, 400)}`,
    'The bot is still running. Try again in a moment.',
  ].join('\n');
}

/** The API answered, but rejected the bot's credentials or the request itself. */
export function apiRejectedNotice(detail: string): string {
  return [
    '⛔ The control plane rejected this request, so nothing was queued.',
    `-# ${truncate(detail, 400)}`,
    'If this says 401, an operator needs to fix `OPERANT_BOT_TOKEN`.',
  ].join('\n');
}

export function transcriptionFailedNotice(detail: string): string {
  return [
    '🎙️ I could not transcribe that audio, so I did not run anything.',
    `-# ${truncate(detail, 400)}`,
  ].join('\n');
}

export function transcriptAck(input: {
  readonly text: string;
  readonly model: string;
  readonly language: string | null;
  readonly durationSec: number;
  readonly rtf: number | null;
}): string {
  const facts = [
    `${input.durationSec.toFixed(1)}s audio`,
    input.model,
    input.language ?? 'language?',
    input.rtf === null ? null : `rtf ${input.rtf}`,
  ].filter((part): part is string => Boolean(part));
  return truncate(
    [
      `🎙️ **Transcript** (${facts.join(' · ')})`,
      `> ${truncate(input.text, 1_200)}`,
      '',
      'Treating the transcript as the request.',
    ].join('\n'),
    MAX_CONTENT,
  );
}

export function progressFailureNotice(task: TaskRecord, detail: string): string {
  return [
    HEADLINES.failed,
    `> ${quote(task.intent, 160)}`,
    '',
    `-# ${truncate(detail, 600)}`,
  ].join('\n');
}

export function unauthorizedClickReply(): InteractionReply {
  return {
    content:
      '🔒 Only allow-listed users may decide approvals. I did not send your decision anywhere.',
    ephemeral: true,
  };
}

export function alreadyDecidedNotice(): string {
  return 'That approval is no longer pending — someone else decided it, or it expired. Nothing was changed.';
}