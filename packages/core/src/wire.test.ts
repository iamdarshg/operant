import { describe, it, expect } from 'vitest';
import {
  TaskListWire,
  TaskWire,
  AgentWire,
  ApprovalWire,
  ScheduleWire,
  MemoryResultWire,
  MemorySearchWire,
  JobWire,
  JobEnvelopeWire,
  UsageWire,
  LearningSummaryWire,
  VoiceHealthWire,
} from './wire.js';

const real = {
  id: '59b64e45-8440-4fb9-9c82-b95c044b328d',
  intent: 'Write a file named ok.md',
  title: 'Write a file named ok.md',
  status: 'succeeded',
  origin: 'api',
  project_key: null,
  project_path: null,
  requested_by: 'perm-test',
  conversation_id: null,
  supervisor_job_id: null,
  progress_note: null,
  failure_reason: null,
};

describe('wire schema describes what the API really returns', () => {
  it('accepts a captured real response', () => {
    expect(TaskWire.safeParse(real).success).toBe(true);
  });

  it('accepts snake_case nulls without inventing camelCase fields', () => {
    const parsed = TaskWire.safeParse(real);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The old core schema required these; they are not part of the wire format.
      expect(parsed.data).not.toHaveProperty('requestedBy');
      expect(parsed.data['requested_by']).toBe('perm-test');
    }
  });

  it('rejects a renamed or missing required field', () => {
    const { status: _drop, ...withoutStatus } = real;
    expect(TaskWire.safeParse(withoutStatus).success).toBe(false);
    expect(TaskWire.safeParse({ ...real, status: 'not-a-status' }).success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    expect(TaskWire.safeParse({ ...real, id: '123' }).success).toBe(false);
  });

  it('validates the list envelope', () => {
    expect(TaskListWire.safeParse({ tasks: [real] }).success).toBe(true);
    expect(TaskListWire.safeParse({ items: [real] }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The other four surfaces, using samples captured from the running service.
 * ------------------------------------------------------------------------ */

const realAgent = {
  id: 'generalist',
  display_name: 'Generalist',
  role: 'generalist',
  description: 'Default agent for ordinary requests.',
  permission_mode: 'workspace-write',
  enabled: true,
  max_concurrency: 2,
};

const realApproval = {
  id: 'b99a9cee-cc33-4860-9a4a-b722f73f0cc1',
  task_id: 'bdd33123-d411-42d2-a679-e493ca0ab2e5',
  job_id: '0dc271d8-4fa3-496e-8b92-0a64ae0c23a5',
  summary: 'The agent tried to run bash, blocked.',
  action: { kind: 'destructive', payload: {} },
  risk: 'critical',
  status: 'pending',
  requested_by: 'tool-boundary-guard',
  decided_by: null,
  decision_note: null,
  expires_at: '2026-11-16T20:00:00.000Z',
  created_at: '2026-11-15T22:00:00.000Z',
  decided_at: null,
};

const realSchedule = {
  id: '531b6649-ea1c-483a-b6cd-5112c108c695',
  title: 'Daily standup summary',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  timezone: 'Asia/Calcutta',
  prompt: 'Reply with exactly SCHEDULED-FIRED.',
  agent_slug: 'generalist',
  enabled: true,
  last_run_at: null,
  next_run_at: '2026-11-16T03:30:00.000Z',
  created_at: '2026-11-15T20:14:25.843Z',
};

const realMemory = {
  id: 'fc7b51c2-7c86-46e9-8971-53809003a30a',
  kind: 'episodic',
  title: 'Send an email to the client.',
  excerpt: 'Intent: Send an email to the client.',
  importance: null,
  matchedBy: 'body',
  score: 0.4,
};

describe('agent wire', () => {
  it('accepts a real agent row and rejects a missing display_name', () => {
    expect(AgentWire.safeParse(realAgent).success).toBe(true);
    const { display_name: _drop, ...without } = realAgent;
    expect(AgentWire.safeParse(without).success).toBe(false);
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(AgentWire.safeParse({ ...realAgent, enabled: 'yes' }).success).toBe(false);
  });
});

describe('approval wire', () => {
  it('accepts a real approval with nullable decision fields', () => {
    expect(ApprovalWire.safeParse(realApproval).success).toBe(true);
  });

  it('accepts a null job_id, which is how held requests look', () => {
    expect(ApprovalWire.safeParse({ ...realApproval, job_id: null }).success).toBe(true);
  });

  it('rejects a missing summary and a non-object action', () => {
    const { summary: _drop, ...noSummary } = realApproval;
    expect(ApprovalWire.safeParse(noSummary).success).toBe(false);
    expect(ApprovalWire.safeParse({ ...realApproval, action: 'nope' }).success).toBe(false);
  });
});

describe('schedule wire', () => {
  it('accepts a real schedule, including null timestamps before the first run', () => {
    expect(ScheduleWire.safeParse(realSchedule).success).toBe(true);
    expect(ScheduleWire.safeParse({ ...realSchedule, last_run_at: null, next_run_at: null }).success).toBe(true);
  });

  it('requires the recurrence and rejects a missing one', () => {
    const { rrule: _drop, ...noRule } = realSchedule;
    expect(ScheduleWire.safeParse(noRule).success).toBe(false);
  });
});

describe('memory result wire', () => {
  it('accepts a real result row', () => {
    expect(MemoryResultWire.safeParse(realMemory).success).toBe(true);
  });

  it('accepts a null title and requires an excerpt', () => {
    expect(MemoryResultWire.safeParse({ ...realMemory, title: null }).success).toBe(true);
    const { excerpt: _drop, ...noExcerpt } = realMemory;
    expect(MemoryResultWire.safeParse(noExcerpt).success).toBe(false);
  });

  it('validates the search envelope', () => {
    expect(MemorySearchWire.safeParse({ results: [realMemory] }).success).toBe(true);
    expect(MemorySearchWire.safeParse({ rows: [realMemory] }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */

const realJob = {
  id: '0dc271d8-4fa3-496e-8b92-0a64ae0c23a5',
  task_id: 'bdd33123-d411-42d2-a679-e493ca0ab2e5',
  kind: 'execute',
  status: 'interrupted',
  agent_id: 'generalist',
  parent_job_id: null,
  title: 'Summarise the customer feedback.',
  prompt: 'TASK: Summarise the customer feedback.',
  attempt: 1,
  max_attempts: 2,
  workspace_path: '/opt/operant-src/operant/data/jobs/abc',
  permission_mode: 'workspace-write',
  result: null,
  error: 'blocked at the tool boundary: make world-writable (bash)',
};

describe('job wire', () => {
  it('accepts a real job row, including null result and parent', () => {
    expect(JobWire.safeParse(realJob).success).toBe(true);
    expect(JobEnvelopeWire.safeParse({ job: realJob }).success).toBe(true);
  });

  it('rejects a missing workspace_path and a non-uuid task_id', () => {
    const { workspace_path: _drop, ...noPath } = realJob;
    expect(JobWire.safeParse(noPath).success).toBe(false);
    expect(JobWire.safeParse({ ...realJob, task_id: 'nope' }).success).toBe(false);
  });
});

describe('usage wire', () => {
  it('accepts the real counter triple and rejects a string count', () => {
    expect(UsageWire.safeParse({ usage: { prompt_tokens: 657740, completion_tokens: 138215, jobs: 42 } }).success).toBe(
      true,
    );
    expect(UsageWire.safeParse({ usage: { prompt_tokens: '657740', completion_tokens: 0, jobs: 0 } }).success).toBe(
      false,
    );
  });
});

describe('learning summary wire', () => {
  it('accepts the real counters and rejects a missing proposals field', () => {
    const real = { summary: { incidents: 2, open: 2, repeats: 1, proposals: 1, promoted: 0, memories: 0 } };
    expect(LearningSummaryWire.safeParse(real).success).toBe(true);
    const { proposals: _drop, ...withoutProposals } = real.summary;
    expect(LearningSummaryWire.safeParse({ summary: withoutProposals }).success).toBe(false);
  });
});

describe('voice health wire', () => {
  it('accepts a healthy upstream and rejects a missing state', () => {
    expect(VoiceHealthWire.safeParse({ state: 'healthy', detail: '{"status":"ok"}' }).success).toBe(true);
    expect(VoiceHealthWire.safeParse({ detail: 'x' }).success).toBe(false);
  });
});
