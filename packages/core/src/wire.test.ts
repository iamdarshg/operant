import { describe, it, expect } from 'vitest';
import { TaskListWire, TaskWire } from './wire.js';

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