/**
 * Wire schemas: what the API **actually returns**.
 *
 * `schema.ts` describes the intended domain model, and it does not match the HTTP
 * surface — it expects camelCase required fields (`projectId`, `requestedBy`) while
 * the API returns snake_case database rows (`project_key`, `requested_by`) with
 * nulls. Nothing validated responses, so that divergence went unnoticed.
 *
 * These schemas are written against real responses captured from the running
 * service. They are deliberately `passthrough` (extra columns are allowed, because
 * the API returns whole rows) but strict about the keys the UI depends on, so a
 * rename or a type change fails at the boundary instead of rendering a blank cell.
 */
import { z } from 'zod';
import { TaskStatus } from './schema.js';

export const TaskWire = z
  .object({
    id: z.string().uuid(),
    intent: z.string(),
    title: z.string(),
    status: TaskStatus,
    origin: z.string(),
    // These are nullable in the database and are nullable on the wire.
    project_key: z.string().nullable().optional(),
    project_path: z.string().nullable().optional(),
    requested_by: z.string().nullable().optional(),
    conversation_id: z.string().nullable().optional(),
    supervisor_job_id: z.string().nullable().optional(),
    progress_note: z.string().nullable().optional(),
    failure_reason: z.string().nullable().optional(),
  })
  .passthrough();

export const TaskListWire = z.object({ tasks: z.array(TaskWire) }).passthrough();

export const TaskDetailWire = z
  .object({ task: TaskWire, jobs: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

export type TaskWire = z.infer<typeof TaskWire>;
/* ------------------------------------------------------------------ more surfaces
 * Key lists captured from the running service, not from the type declarations.
 * `passthrough` everywhere because the API returns whole database rows; strict only
 * about the fields the UI renders, so a rename fails at the boundary.
 * ---------------------------------------------------------------------- */

export const AgentWire = z
  .object({
    id: z.string(),
    display_name: z.string(),
    role: z.string(),
    description: z.string().nullable().optional(),
    permission_mode: z.string(),
    enabled: z.boolean(),
    max_concurrency: z.number(),
  })
  .passthrough();

export const AgentListWire = z.object({ agents: z.array(AgentWire) }).passthrough();

export const ApprovalWire = z
  .object({
    id: z.string().uuid(),
    task_id: z.string().uuid().nullable(),
    job_id: z.string().uuid().nullable(),
    summary: z.string(),
    action: z.record(z.string(), z.unknown()),
    risk: z.string(),
    status: z.string(),
    requested_by: z.string().nullable().optional(),
    created_at: z.string(),
  })
  .passthrough();

export const ApprovalListWire = z.object({ approvals: z.array(ApprovalWire) }).passthrough();

export const ScheduleWire = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    rrule: z.string(),
    timezone: z.string(),
    prompt: z.string(),
    agent_slug: z.string(),
    enabled: z.boolean(),
    last_run_at: z.string().nullable(),
    next_run_at: z.string().nullable(),
    created_at: z.string(),
  })
  .passthrough();

export const ScheduleListWire = z.object({ schedules: z.array(ScheduleWire) }).passthrough();

export const MemoryResultWire = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    title: z.string().nullable(),
    excerpt: z.string(),
  })
  .passthrough();

export const MemorySearchWire = z.object({ results: z.array(MemoryResultWire) }).passthrough();

export const JobWire = z
  .object({
    id: z.string().uuid(),
    task_id: z.string().uuid(),
    kind: z.string(),
    status: z.string(),
    agent_id: z.string(),
    parent_job_id: z.string().uuid().nullable(),
    title: z.string(),
    prompt: z.string(),
    attempt: z.number(),
    max_attempts: z.number(),
    workspace_path: z.string(),
    permission_mode: z.string(),
    result: z.string().nullable(),
    error: z.string().nullable(),
  })
  .passthrough();

export const JobEnvelopeWire = z.object({ job: JobWire }).passthrough();

export const UsageWire = z
  .object({
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        jobs: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export const LearningSummaryWire = z
  .object({
    summary: z
      .object({
        incidents: z.number(),
        open: z.number(),
        proposals: z.number(),
        promoted: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export const VoiceHealthWire = z
  .object({ state: z.string(), detail: z.string().nullable().optional() })
  .passthrough();
