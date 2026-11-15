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