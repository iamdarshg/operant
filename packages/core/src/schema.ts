/**
 * Operant domain contract.
 *
 * Single source of truth for every entity exchanged between the control-plane
 * API, the Discord bot, the dashboard and the DSH job adapter. Runtime
 * validation uses these schemas directly; TypeScript types are inferred from
 * them so a schema change cannot drift from the type.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export const Id = z.string().min(1).max(64);
export const Iso = z.string().datetime({ offset: true });
export const Money = z.object({
  /** ISO-4217, e.g. USD */
  currency: z.string().length(3),
  micros: z.number().int(), // 1e-6 units, avoids float drift
});

export const JsonObject = z.record(z.unknown());

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

/** Lifecycle of a user-visible unit of work. */
export const TaskStatus = z.enum([
  'queued',
  'planning',
  'running',
  'waiting_approval',
  'reviewing',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Statuses after which a task never transitions again. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/** Lifecycle of one DSH execution. A task has one or more jobs. */
export const JobStatus = z.enum([
  'queued',
  'dispatched',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];

/**
 * What a job is for. The kind selects the agent profile, the permission mode
 * and the exit criteria — it is not a cosmetic label.
 */
export const JobKind = z.enum([
  'plan', // decompose an intent into jobs
  'execute', // do the work
  'review', // independent critique of an artifact
  'verify', // reproduce/acceptance check, must cite commands run
  'research', // read-only investigation
  'transcribe', // speech -> text via VoiceStudio
  'synthesize', // text -> speech via VoiceStudio
]);
export type JobKind = z.infer<typeof JobKind>;

export const AgentRole = z.enum([
  'supervisor',
  'engineer',
  'reviewer',
  'researcher',
  'ops',
  'voice',
  'generalist',
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** The five memory categories the platform learns through. */
export const MemoryKind = z.enum([
  'episodic',
  'semantic',
  'procedural',
  'failure',
  'evaluation',
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemoryScope = z.enum(['global', 'project']);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const HealthState = z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']);
export type HealthState = z.infer<typeof HealthState>;

/** Every state transition the audit trail records. */
export const AuditAction = z.enum([
  'task.created',
  'task.status',
  'job.created',
  'job.status',
  'job.cancelled',
  'approval.requested',
  'approval.decided',
  'memory.written',
  'memory.corrected',
  'memory.deleted',
  'agent.updated',
  'improvement.proposed',
  'improvement.promoted',
  'improvement.rolled_back',
  'schedule.created',
  'schedule.deleted',
  'auth.denied',
  'config.changed',
]);
export type AuditAction = z.infer<typeof AuditAction>;

/* ------------------------------------------------------------------ *
 * Core entities
 * ------------------------------------------------------------------ */

export const Task = z.object({
  id: Id,
  /** The user's own words. Never rewritten. */
  intent: z.string().min(1),
  status: TaskStatus,
  /** Natural-language title generated for lists; falls back to intent. */
  title: z.string(),
  projectId: Id.nullable(),
  /** Who asked (Discord user id, dashboard user id, or 'system'). */
  requestedBy: z.string(),
  /** Interface the request arrived through. */
  origin: z.enum(['discord', 'dashboard', 'schedule', 'api', 'system']),
  /** Supervisor job that owns decomposition of this task. */
  supervisorJobId: Id.nullable(),
  conversationId: Id.nullable(),
  /** Human-readable summary of where things stand right now. */
  progressNote: z.string().nullable(),
  /** Populated only when status === 'failed' or 'blocked'. */
  failureReason: z.string().nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
});
export type Task = z.infer<typeof Task>;

export const Job = z.object({
  id: Id,
  taskId: Id,
  kind: JobKind,
  status: JobStatus,
  agentId: Id,
  /** Job that spawned this one (supervisor -> child). Null for root jobs. */
  parentJobId: Id.nullable(),
  title: z.string(),
  /** Fully rendered instruction handed to DSH for this attempt. */
  prompt: z.string(),
  /** DSH session id, used to resume after a restart. */
  dshSessionId: z.string().nullable(),
  /** Attempt counter; retries increment it rather than creating a new job. */
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1),
  /** Absolute directory the agent works in. */
  workspacePath: z.string(),
  permissionMode: z.string(),
  /** Reviewer/verifier job ids that independently checked this job. */
  verifiedByJobIds: z.array(Id),
  /** Final assistant message, when the run produced one. */
  result: z.string().nullable(),
  error: z.string().nullable(),
  /** Model + tool usage attributed to this job. */
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      toolCalls: z.number().int().nonnegative(),
      cost: Money.nullable(),
    })
    .nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
});
export type Job = z.infer<typeof Job>;

export const AgentProfile = z.object({
  id: Id,
  /** Stable slug used by routing ("engineering", "review", "research"). */
  slug: z.string().regex(/^[a-z0-9-]{2,32}$/),
  displayName: z.string(),
  role: AgentRole,
  description: z.string(),
  /** Model route, when the runtime exposes more than one. */
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Injected ahead of the job prompt; versioned text, never user-editable at runtime by agents. */
  systemOverlay: z.string(),
  /** Tools this agent may use. Enforced before dispatch, not merely described. */
  allowedTools: z.array(z.string()),
  permissionMode: z.string(),
  enabled: z.boolean(),
  /** Concurrency ceiling for this agent. */
  maxConcurrency: z.number().int().min(1).max(8),
  createdAt: Iso,
  updatedAt: Iso,
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const Artifact = z.object({
  id: Id,
  jobId: Id,
  taskId: Id,
  /** Path relative to the job workspace, or an absolute path for system files. */
  path: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  /** Discord attachment/CDN url once uploaded, else null. */
  remoteUrl: z.string().nullable(),
  createdAt: Iso,
});
export type Artifact = z.infer<typeof Artifact>;

export const Approval = z.object({
  id: Id,
  taskId: Id.nullable(),
  jobId: Id.nullable(),
  /** What the agent wants to do, in plain language. */
  summary: z.string(),
  /** The exact action; the thing a human is approving. */
  action: z.object({
    kind: z.enum([
      'shell_command',
      'file_write_outside_workspace',
      'external_message',
      'account_change',
      'spend',
      'destructive',
      'production_config',
    ]),
    payload: JsonObject,
  }),
  risk: RiskLevel,
  status: ApprovalStatus,
  requestedBy: z.string(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  /** Approvals expire rather than sitting forever. */
  expiresAt: Iso,
  createdAt: Iso,
  decidedAt: Iso.nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const MemoryEntry = z.object({
  id: Id,
  kind: MemoryKind,
  scope: MemoryScope,
  /** Project slug for scoped memories; null for global. */
  projectKey: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  /** Structured retrieval keys (tool names, error classes, file paths...). */
  tags: z.array(z.string()),
  /** Importance drives ranking alongside recency and similarity. */
  importance: z.number().min(0).max(1),
  /** Times this memory was retrieved and actually used. */
  hits: z.number().int().nonnegative(),
  /** Provenance: which task/job taught us this. */
  sourceTaskId: Id.nullable(),
  sourceJobId: Id.nullable(),
  /** False once superseded; superseded rows stay for history. */
  active: z.boolean(),
  supersededBy: Id.nullable(),
  /** Embedding is optional so the system degrades to lexical search cleanly. */
  embedding: z.array(z.number()).nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  lastUsedAt: Iso.nullable(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/** A classified operational failure — the raw material of self-improvement. */
export const Incident = z.object({
  id: Id,
  /** Stable fingerprint: same class of failure hashes the same. */
  fingerprint: z.string(),
  title: z.string(),
  /** Observed symptom, verbatim where possible. */
  symptom: z.string(),
  /** Root cause once diagnosed; null while unknown. */
  rootCause: z.string().nullable(),
  category: z.enum([
    'dependency_missing',
    'config_drift',
    'auth_failure',
    'network',
    'resource_exhaustion',
    'tool_misuse',
    'model_quality',
    'code_defect',
    'unknown',
  ]),
  occurrences: z.number().int().min(1),
  taskIds: z.array(Id),
  jobIds: z.array(Id),
  status: z.enum(['open', 'diagnosed', 'mitigated', 'resolved', 'wontfix']),
  firstSeenAt: Iso,
  lastSeenAt: Iso,
});
export type Incident = z.infer<typeof Incident>;

/**
 * A proposed change produced by the learning loop. Promotions are gated: only
 * changes whose blast radius is low may auto-promote.
 */
export const Improvement = z.object({
  id: Id,
  incidentId: Id.nullable(),
  title: z.string(),
  rationale: z.string(),
  /** The concrete patch: a skill draft, a retry policy, a prompt fragment, a doc. */
  change: z.object({
    kind: z.enum([
      'knowledge', // memory / runbook content
      'skill_draft',
      'retry_policy',
      'task_contract',
      'tool_selection',
      'model_routing',
      'doc',
    ]),
    payload: JsonObject,
  }),
  risk: RiskLevel,
  status: z.enum([
    'proposed',
    'testing',
    'test_failed',
    'reviewed',
    'promoted',
    'rolled_back',
    'rejected',
  ]),
  /** Evidence that it works: benchmark deltas, repro results. */
  evidence: z.array(
    z.object({
      claim: z.string(),
      /** Command run, or artifact path, that supports the claim. */
      proof: z.string(),
      passed: z.boolean(),
    }),
  ),
  /** Everything needed to undo the promotion. */
  rollback: z.object({
    kind: z.enum(['revert_file', 'revert_memory', 'restore_snapshot']),
    pointer: z.string(),
    instructions: z.string(),
  }),
  reviewedBy: z.string().nullable(),
  promotedAt: Iso.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Improvement = z.infer<typeof Improvement>;

export const Schedule = z.object({
  id: Id,
  title: z.string(),
  /** RFC-5545-ish rrule as understood by the scheduler. */
  rrule: z.string(),
  timezone: z.string(),
  /** Natural-language instruction delivered at each occurrence. */
  prompt: z.string(),
  agentSlug: z.string(),
  enabled: z.boolean(),
  lastRunAt: Iso.nullable(),
  nextRunAt: Iso.nullable(),
  createdAt: Iso,
});
export type Schedule = z.infer<typeof Schedule>;

export const UsageEvent = z.object({
  id: Id,
  jobId: Id.nullable(),
  taskId: Id.nullable(),
  kind: z.enum(['llm', 'tool', 'speech', 'storage']),
  provider: z.string(),
  model: z.string().nullable(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** Seconds of audio for speech, calls for tools. */
  units: z.number().nonnegative(),
  cost: Money.nullable(),
  at: Iso,
});
export type UsageEvent = z.infer<typeof UsageEvent>;

export const ServiceHealth = z.object({
  name: z.string(),
  state: HealthState,
  /** Latency of the probe in ms, when measurable. */
  latencyMs: z.number().nullable(),
  detail: z.string().nullable(),
  checkedAt: Iso,
});
export type ServiceHealth = z.infer<typeof ServiceHealth>;

export const AuditEvent = z.object({
  id: Id,
  action: AuditAction,
  actor: z.string(),
  taskId: Id.nullable(),
  jobId: Id.nullable(),
  payload: JsonObject,
  at: Iso,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/* ------------------------------------------------------------------ *
 * API inputs — the contract the bot and dashboard both speak
 * ------------------------------------------------------------------ */

export const CreateRequestInput = z.object({
  /** Verbatim natural language from the human. */
  text: z.string().min(1).max(8000),
  origin: z.enum(['discord', 'dashboard', 'schedule', 'api']),
  requestedBy: z.string().min(1),
  /** Continue an existing conversation/task when replying in a thread. */
  conversationId: Id.nullable().optional(),
  /** Force a specific agent instead of letting the router choose. */
  agentSlug: z.string().optional(),
  /** Ask for independent verification of the result. */
  requireVerification: z.boolean().optional(),
  /** Project directory the work happens in. */
  projectPath: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        mimeType: z.string(),
        /** Storage key or absolute path already ingested. */
        ref: z.string(),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type CreateRequestInput = z.infer<typeof CreateRequestInput>;

export const DecideApprovalInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(2000).optional(),
  decidedBy: z.string().min(1),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInput>;

export const MemorySearchInput = z.object({
  query: z.string().min(1),
  kinds: z.array(MemoryKind).optional(),
  scope: MemoryScope.optional(),
  projectKey: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(8),
});
export type MemorySearchInput = z.infer<typeof MemorySearchInput>;

export const MemorySearchResult = z.object({
  entry: MemoryEntry,
  /** Why it matched: 'lexical' | 'vector' | 'both'. */
  matchedBy: z.enum(['lexical', 'vector', 'both']),
  score: z.number(),
  /** The excerpt shown to the model after budget trimming. */
  excerpt: z.string(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

export const TranscribeInput = z.object({
  /** Local file path or storage key of the audio. */
  ref: z.string().min(1),
  language: z.string().optional(),
  /** 'fast' for Discord responsiveness, 'accurate' for offline batches. */
  profile: z.enum(['fast', 'accurate']).default('fast'),
  diarize: z.boolean().default(false),
});
export type TranscribeInput = z.infer<typeof TranscribeInput>;

export const TranscriptSegment = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string(),
  speaker: z.string().nullable(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const Transcript = z.object({
  text: z.string(),
  language: z.string().nullable(),
  durationSec: z.number().nonnegative(),
  segments: z.array(TranscriptSegment),
  model: z.string(),
  /** Real-time factor: processing seconds per audio second. */
  rtf: z.number().nonnegative(),
});
export type Transcript = z.infer<typeof Transcript>;