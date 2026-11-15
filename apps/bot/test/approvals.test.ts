/**
 * Approvals.
 *
 * The important assertions are about authority and effect:
 *   - a pending approval becomes a card with exactly two buttons;
 *   - clicking one calls the decide endpoint with the *clicker's* identity;
 *   - an unauthorized clicker never reaches the API;
 *   - the card is edited to its decision and the buttons are removed, so a
 *     settled approval cannot be clicked into a different outcome.
 */
import { describe, expect, it } from 'vitest';
import { OperantApi } from '../src/api/client.js';
import { ApprovalWatcher } from '../src/bot/approvals.js';
import { approvalCustomId } from '../src/bot/copy.js';
import { silentLogger } from '../src/logger.js';
import {
  FakeChannel,
  FakeInteraction,
  jsonResponse,
  makeFetch,
} from './support/fakes.js';
import type { ApprovalRecord } from '../src/api/types.js';

const approvalRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ap-1',
  task_id: 'task-1',
  job_id: 'job-1',
  summary: 'Delete the workspace directory to free disk space',
  status: 'pending',
  risk: 'high',
  requested_by: 'agent:engineering',
  expires_at: '2026-11-15T01:00:00.000Z',
  created_at: '2026-11-14T23:00:00.000Z',
  action: { kind: 'destructive', payload: { command: 'rm -rf ./data/jobs/task-1' } },
  ...overrides,
});

function buildWatcher(options: {
  approvals?: Record<string, unknown>[];
  decide?: () => Response;
  allowedUserIds?: string[];
} = {}) {
  const pending = options.approvals ?? [approvalRow()];
  const fetcher = makeFetch((call) => {
    if (call.method === 'GET' && call.url.includes('/v1/approvals')) {
      return jsonResponse(200, { approvals: pending });
    }
    if (call.method === 'POST' && call.url.includes('/decide')) {
      if (options.decide) return options.decide();
      return jsonResponse(200, {
        approval: approvalRow({
          status: call.url.includes('ap-1') ? 'approved' : 'rejected',
        }),
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  });
  const config = { apiBase: 'http://127.0.0.1:8787', apiToken: 'test-api-token' };
  const api = new OperantApi({
    base: config.apiBase,
    token: config.apiToken,
    fetchImpl: fetcher.fetchImpl,
    maxRetries: 0,
  });
  const watcher = new ApprovalWatcher({
    api,
    logger: silentLogger(),
    policy: { allowedUserIds: options.allowedUserIds ?? ['user-1'], allowedChannelIds: [] },
    pollMs: 5_000,
  });
  const channel = new FakeChannel('chan-1');
  watcher.trackTask('task-1', channel);
  return { watcher, channel, fetcher };
}

describe('approval cards', () => {
  it('posts one embed with Approve/Reject buttons for a tracked task', async () => {
    const { watcher, channel } = buildWatcher();

    expect(await watcher.pollOnce()).toBe(1);
    expect(channel.sendPayloads).toHaveLength(1);

    const payload = channel.sendPayloads[0]!;
    expect(payload.embeds?.[0]?.title).toBe('Approval required');
    expect(payload.embeds?.[0]?.description).toContain('Delete the workspace');
    expect(payload.embeds?.[0]?.color).toBe(0xf26419); // high risk
    const fields = payload.embeds?.[0]?.fields ?? [];
    expect(fields.find((field) => field.name === 'Risk')?.value).toBe('HIGH');
    expect(fields.find((field) => field.name === 'Task')?.value).toContain('task-1');

    const buttons = payload.components?.[0]?.components ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.label).toBe('Approve');
    expect(buttons[0]?.custom_id).toBe(approvalCustomId('approve', 'ap-1'));
    expect(buttons[1]?.label).toBe('Reject');
    expect(buttons[1]?.custom_id).toBe(approvalCustomId('reject', 'ap-1'));

    // Polling again must not post a second card for the same approval.
    expect(await watcher.pollOnce()).toBe(0);
    expect(channel.sendPayloads).toHaveLength(1);
  });

  it('ignores approvals whose task this process is not tracking', async () => {
    const { watcher, channel } = buildWatcher({
      approvals: [approvalRow({ id: 'ap-9', task_id: 'task-other' })],
    });
    expect(await watcher.pollOnce()).toBe(0);
    expect(channel.sendPayloads).toHaveLength(0);
  });
});

describe('approval interaction', () => {
  it('calls the decide endpoint with the clicker identity, then shows the decision', async () => {
    const { watcher, fetcher } = buildWatcher();
    await watcher.pollOnce();

    const interaction = new FakeInteraction({
      customId: approvalCustomId('approve', 'ap-1'),
      userId: 'user-1',
      username: 'alice',
    });

    expect(await watcher.handleInteraction(interaction)).toBe('handled');

    const decides = fetcher.matching('POST', '/v1/approvals/ap-1/decide');
    expect(decides).toHaveLength(1);
    expect(decides[0]!.json).toEqual({ decision: 'approve', decidedBy: 'alice (user-1)' });

    expect(interaction.updates).toHaveLength(1);
    const shown = interaction.updates[0]!;
    expect(shown.content).toContain('Approved by');
    expect(shown.content).toContain('alice');
    expect(shown.embeds?.[0]?.title).toBe('Approved');
    // Buttons are gone: a settled decision cannot be reversed by a second click.
    expect(shown.components).toEqual([]);
    expect(watcher.decisionFor('ap-1')).toBe('approved');
  });

  it('records a rejection with decision="reject"', async () => {
    const { watcher, fetcher } = buildWatcher();
    await watcher.pollOnce();

    const interaction = new FakeInteraction({
      customId: approvalCustomId('reject', 'ap-1'),
      userId: 'user-1',
      username: 'alice',
    });
    await watcher.handleInteraction(interaction);

    expect((fetcher.matching('POST', '/v1/approvals/ap-1/decide')[0]!.json as Record<string, unknown>)['decision']).toBe('reject');
    expect(interaction.updates[0]!.content).toContain('Rejected by');
  });

  it('refuses a click from a user outside the allow-list and makes no API call', async () => {
    const { watcher, fetcher } = buildWatcher();
    await watcher.pollOnce();
    const callsBefore = fetcher.calls.length;

    const interaction = new FakeInteraction({
      customId: approvalCustomId('approve', 'ap-1'),
      userId: 'mallory',
      username: 'mallory',
    });

    expect(await watcher.handleInteraction(interaction)).toBe('handled');

    // Only the earlier GET /v1/approvals should exist; no decide call.
    expect(fetcher.calls.length).toBe(callsBefore);
    expect(fetcher.count('POST', '/decide')).toBe(0);
    expect(interaction.replies).toHaveLength(1);
    expect(interaction.replies[0]!.ephemeral).toBe(true);
    expect(interaction.replies[0]!.content).toContain('Only allow-listed users');
    expect(watcher.decisionFor('ap-1')).toBeNull();
  });

  it('absorbs a 409 "already decided" race without an error reply', async () => {
    const { watcher } = buildWatcher({
      decide: () => jsonResponse(409, { error: 'not_pending_or_missing' }),
    });
    await watcher.pollOnce();

    const interaction = new FakeInteraction({
      customId: approvalCustomId('approve', 'ap-1'),
      userId: 'user-1',
      username: 'alice',
    });

    expect(await watcher.handleInteraction(interaction)).toBe('handled');
    expect(interaction.updates[0]!.content).toContain('no longer pending');
    expect(interaction.replies).toHaveLength(0);
  });

  it('ignores components it did not create', async () => {
    const { watcher, fetcher } = buildWatcher();
    const interaction = new FakeInteraction({ customId: 'someone-else:button:1' });

    expect(await watcher.handleInteraction(interaction)).toBe('ignored');
    expect(fetcher.count('POST', '/decide')).toBe(0);
  });

  it('ignores clicks from bot accounts', async () => {
    const { watcher } = buildWatcher();
    const interaction = new FakeInteraction({
      customId: approvalCustomId('approve', 'ap-1'),
      userBot: true,
    });
    expect(await watcher.handleInteraction(interaction)).toBe('ignored');
  });
});

/** Type-level reminder that the row shape is the one the live API returns. */
const _shape: ApprovalRecord = {
  id: 'ap-1',
  taskId: 'task-1',
  jobId: null,
  summary: 'x',
  status: 'pending',
  risk: 'low',
  action: null,
  requestedBy: null,
  expiresAt: null,
  createdAt: null,
};
void _shape;