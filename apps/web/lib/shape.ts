/**
 * Wire shapes of the Operant control plane, shared by server and browser code.
 * This module is types and constants only: nothing here may carry a credential.
 */

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'reviewing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type JobStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type Task = {
  id: string;
  intent: string;
  title: string;
  status: TaskStatus;
  project_key: string | null;
  project_path: string | null;
  requested_by: string;
  origin: string;
  progress_note: string | null;
  failure_reason: string | null;
  require_verification: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type JobUsage = {
  ms: number;
  events: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
};

export type Job = {
  id: string;
  task_id: string;
  kind: string;
  status: JobStatus;
  agent_id: string;
  parent_job_id: string | null;
  title: string;
  prompt: string;
  dsh_profile: string;
  dsh_session_id: string | null;
  attempt: number;
  max_attempts: number;
  workspace_path: string;
  permission_mode: string;
  /** Null until a verifier job exists. */
  verified_by_job_ids: string[] | null;
  result: string | null;
  error: string | null;
  /** Null until the job has run and written usage. */
  usage: JobUsage | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type JobEvent = {
  id: string;
  job_id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
};

export type MemoryKind = 'episodic' | 'semantic' | 'procedural' | 'failure' | 'evaluation';

export type MemoryResult = {
  id: string;
  kind: MemoryKind;
  title: string;
  excerpt: string;
  importance: number;
  matchedBy: string;
  score: number;
};

export type Agent = {
  id: string;
  display_name: string;
  role: string;
  description: string;
  permission_mode: string;
  enabled: boolean;
  max_concurrency: number;
};

export type Approval = {
  id: string;
  task_id: string | null;
  job_id: string | null;
  summary: string;
  action: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requested_by: string;
  decided_by: string | null;
  decision_note: string | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
};

export type Health = {
  state: string;
  checks: { name: string; state: string; detail?: string }[];
  dshProfile: string;
};

export type Usage = { prompt_tokens: number; completion_tokens: number; jobs: number };

export type Accepted = {
  taskId: string;
  jobId: string;
  agentId: string;
  status: string;
  eventsUrl: string;
  streamUrl: string;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

