/**
 * Operant self-improvement loop.
 *
 * The rule this encodes: **a single failure never rewrites configuration.**
 * A failure is classified, fingerprinted and counted. Only a *repeat* (same
 * fingerprint seen again) is enough to propose a change, and every proposal
 * carries the evidence needed to judge it plus the pointer needed to undo it.
 *
 * The loop mirrors the mission's cycle:
 *   execute → observe → evaluate → diagnose → propose → test → review →
 *   promote → monitor
 *
 * Classification and fingerprinting are pure functions so they can be tested
 * without a database, and so the same input always produces the same fingerprint
 * (otherwise "repeat failure" would never be detected).
 */

export type IncidentCategory =
  | 'dependency_missing'
  | 'config_drift'
  | 'auth_failure'
  | 'network'
  | 'resource_exhaustion'
  | 'tool_misuse'
  | 'model_quality'
  | 'code_defect'
  | 'unknown';

export interface Classification {
  category: IncidentCategory;
  /** Stable hash of the *class*, not the instance: ids/paths/numbers removed. */
  fingerprint: string;
  /** Short human title for the incident row. */
  title: string;
  /** Whether this class is likely to recur without intervention. */
  transient: boolean;
  /** Which memory kind would prevent it next time. */
  remedy: 'procedural' | 'semantic' | 'failure' | 'config';
}

/** Ordered rules; first match wins. Order matters: specific before generic. */
const RULES: { re: RegExp; category: IncidentCategory; remedy: Classification['remedy']; transient?: boolean; title: string }[] = [
  { re: /ERR_PNPM_[A-Z_]*|npm error code ETARGET|Cannot find module|MODULE_NOT_FOUND|command not found|ENOENT/i, category: 'dependency_missing', remedy: 'procedural', title: 'Missing dependency or command' },
  { re: /MISSING_CREDENTIAL|no API key|401 Unauthorized|403 Forbidden|invalid[_-]?token|permission denied/i, category: 'auth_failure', remedy: 'semantic', title: 'Credential or authorization failure' },
  { re: /unsupported reasoning effort|does not support reasoning/i, category: 'config_drift', remedy: 'config', title: 'Model capability mismatch in profile' },
  { re: /sets "[A-Z_]+", which only the launching environment may set/i, category: 'config_drift', remedy: 'config', title: 'Reserved env var set in .env' },
  { re: /multiple usable web providers|not found in.*profile|patch: entry .* not found/i, category: 'config_drift', remedy: 'config', title: 'Profile composition conflict' },
  // Observed in production: DSH exits 1 with "profile \"x\" does not exist;
  // create it with 'dsh plugin --profile x add <package>'". Without this rule
  // that repeat failure classified as `unknown`, which routes it to a generic
  // proposal instead of the config remedy it actually needs.
  { re: /profile\s+["']?[\w.-]+["']?\s+does not exist|does not exist;\s*create it with/i, category: 'config_drift', remedy: 'config', title: 'DSH profile missing or not composed' },
  { re: /ENOSPC|no space left on device|ENOMEM|out of memory|OOMKilled/i, category: 'resource_exhaustion', remedy: 'procedural', title: 'Disk or memory exhaustion' },
  { re: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|server is disconnected|fetch failed/i, category: 'network', remedy: 'procedural', transient: true, title: 'Network or service unreachable' },
  { re: /timed out after|timeout of|deadline exceeded/i, category: 'resource_exhaustion', remedy: 'config', transient: true, title: 'Run exceeded its time budget' },
  { re: /assert|TypeError|ReferenceError|SyntaxError|TS\d{4}|FAILED test/i, category: 'code_defect', remedy: 'procedural', title: 'Code or test failure' },
  { re: /hallucinat|refus|could not verify|weak output|empty response/i, category: 'model_quality', remedy: 'semantic', title: 'Weak or empty model output' },
];

/**
 * Classify a raw failure string.
 *
 * The fingerprint deliberately strips volatile tokens (uuids, absolute paths,
 * ports, line numbers, hex digests) so that the same *kind* of failure maps to
 * the same fingerprint across runs — that is what makes a repeat detectable.
 */
export function classifyFailure(rawError: string): Classification {
  const text = rawError ?? '';
  const rule = RULES.find((r) => r.re.test(text));
  const category = rule?.category ?? 'unknown';
  const title = rule?.title ?? 'Unclassified operational failure';
  const transient = rule?.transient ?? false;
  const remedy = rule?.remedy ?? 'failure';
  const normalized = normalize(text);
  return {
    category,
    fingerprint: `fp_${hash64(`${category}|${normalized}`)}`,
    title,
    transient,
    remedy,
  };
}

/** Strip everything instance-specific, keep the shape. */
export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    // Ordered: structured tokens first, then free numbers. Placeholders must
    // not themselves contain digits or the final digit pass would eat them.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/[0-9a-f]{64}/g, '<digest>')
    .replace(/[a-z]:\\[^\s"']+/gi, '<path>')
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    // Any run of digits: durations, timings, counts, versions, HTTP status
    // codes. Collapsing them is what makes "same failure, different numbers"
    // map to one fingerprint. The *category* still comes from the raw text, so
    // 401-vs-500 style distinctions survive at the classification layer.
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Small, deterministic 64-bit-ish hash (FNV-1a over UTF-16), hex encoded. */
export function hash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c) * 0x85ebca6b;
    h1 >>>= 0;
    h2 >>>= 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ *
 * Policy: what may be promoted without a human
 * ------------------------------------------------------------------ */

export interface ProposalInput {
  category: IncidentCategory;
  occurrences: number;
  remedy: Classification['remedy'];
  title: string;
}

export interface ProposalPlan {
  /** Whether the loop may act alone. */
  autoPromotable: boolean;
  risk: 'low' | 'medium' | 'high' | 'critical';
  kind: 'knowledge' | 'skill_draft' | 'retry_policy' | 'task_contract' | 'tool_selection' | 'model_routing' | 'doc';
  /** Why this decision, in one line, for the audit trail. */
  rationale: string;
}

/**
 * Decide whether a detected repeat failure justifies an automatic change.
 *
 * Deliberately conservative. Only *knowledge* changes (a runbook entry, a
 * memory) are auto-promotable, and only after the failure has been seen at
 * least twice. Anything touching production config, credentials, plugins or
 * routing requires independent review — those are the guardrails the operator
 * asked for, expressed as code instead of prose.
 */
export function planProposal(input: ProposalInput): ProposalPlan {
  const { category, occurrences, remedy } = input;

  if (occurrences < 2) {
    return {
      autoPromotable: false,
      risk: 'low',
      kind: 'knowledge',
      rationale: 'single occurrence: record only, never act (a one-off is not evidence)',
    };
  }

  if (remedy === 'config') {
    return {
      autoPromotable: false,
      risk: 'medium',
      kind: 'doc',
      rationale: 'config defects change how the runtime starts: needs review before promotion',
    };
  }
  if (category === 'auth_failure') {
    return {
      autoPromotable: false,
      risk: 'high',
      kind: 'doc',
      rationale: 'credential-adjacent: never auto-modified, only documented',
    };
  }
  if (category === 'resource_exhaustion') {
    return {
      autoPromotable: false,
      risk: 'medium',
      kind: 'retry_policy',
      rationale: 'retry/limit changes affect cost and load: bounded change, still reviewed',
    };
  }
  if (category === 'dependency_missing' || category === 'network') {
    return {
      autoPromotable: true,
      risk: 'low',
      kind: 'knowledge',
      rationale: 'known recovery procedure can be recorded automatically; it changes no configuration',
    };
  }
  return {
    autoPromotable: false,
    risk: 'medium',
    kind: 'skill_draft',
    rationale: 'quality/defect classes need an independent look before any change is promoted',
  };
}

/** Recovery procedures we are allowed to record as verified knowledge. */
export function recoveryProcedure(c: Classification): { title: string; body: string; tags: string[] } | null {
  switch (c.category) {
    case 'dependency_missing':
      return {
        title: 'Recovery: missing dependency or command',
        body:
          'A required binary/module was absent. Procedure: (1) identify the exact name from the error; ' +
          '(2) install it with the project package manager, pinned; (3) re-run the failing command and capture its output; ' +
          '(4) only then mark the task done. On Windows, npm global shims (e.g. pnpm via corepack) can resolve to a ' +
          'version whose entrypoint is missing — invoke the cached entrypoint directly instead of reinstalling blindly.',
        tags: ['recovery', 'dependency', 'runbook'],
      };
    case 'network':
      return {
        title: 'Recovery: service unreachable',
        body:
          'A dependency was not reachable. Procedure: (1) probe the service health endpoint from the SAME host as the failing ' +
          'caller — a locally-successful probe does not prove remote reachability; (2) check that the service binds an ' +
          'address the caller can actually reach (loopback-only services need a tunnel, not a published port); ' +
          '(3) retry once with backoff, then fail loudly rather than silently degrading.',
        tags: ['recovery', 'network', 'runbook'],
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Database side
 * ------------------------------------------------------------------ */

import type { Db } from '@operant/db';

export interface IncidentRow {
  id: string;
  fingerprint: string;
  title: string;
  symptom: string;
  root_cause: string | null;
  category: string;
  occurrences: number;
  status: string;
  /** Provenance: which tasks/jobs produced this incident class. */
  task_ids: string[];
  job_ids: string[];
  first_seen_at: Date;
  last_seen_at: Date;
}

/** Record (or bump) an incident. Returns the row plus whether it was new. */
export async function recordIncident(
  db: Db,
  rawError: string,
  ctx: { taskId?: string | null; jobId?: string | null } = {},
): Promise<{ incident: IncidentRow; classification: Classification; isRepeat: boolean }> {
  const c = classifyFailure(rawError);
  const rows = await db<IncidentRow[]>`
    INSERT INTO incidents (fingerprint, title, symptom, category, task_ids, job_ids)
    VALUES (${c.fingerprint}, ${c.title}, ${rawError.slice(0, 4000)}, ${c.category},
            ${ctx.taskId ? [ctx.taskId] : []}::uuid[], ${ctx.jobId ? [ctx.jobId] : []}::uuid[])
    ON CONFLICT (fingerprint) DO UPDATE
      SET occurrences = incidents.occurrences + 1,
          last_seen_at = now(),
          symptom = EXCLUDED.symptom,
          task_ids = (
            SELECT array_agg(DISTINCT x) FROM unnest(incidents.task_ids || EXCLUDED.task_ids) AS x
          ),
          job_ids = (
            SELECT array_agg(DISTINCT x) FROM unnest(incidents.job_ids || EXCLUDED.job_ids) AS x
          )
    RETURNING *`;
  const incident = rows[0];
  if (!incident) throw new Error('incident upsert returned no row');
  return { incident, classification: c, isRepeat: incident.occurrences > 1 };
}

/**
 * One pass of the learning loop. Idempotent: it only ever creates knowledge
 * entries or proposals that do not already exist.
 */
export async function learningTick(db: Db): Promise<{
  examined: number;
  knowledgeWritten: number;
  proposalsCreated: number;
}> {
  const open = await db<IncidentRow[]>`
    SELECT * FROM incidents
     WHERE status IN ('open','diagnosed')
       AND occurrences >= 2
     ORDER BY occurrences DESC, last_seen_at DESC
     LIMIT 20`;

  let knowledgeWritten = 0;
  let proposalsCreated = 0;

  for (const incident of open) {
    const c = classifyFailure(incident.symptom);
    const plan = planProposal({
      category: c.category,
      occurrences: incident.occurrences,
      remedy: c.remedy,
      title: incident.title,
    });

    if (plan.autoPromotable) {
      const proc = recoveryProcedure(c);
      if (!proc) continue;
      // Only write if no equivalent active memory exists (idempotent tick).
      const [existing] = await db<{ id: string }[]>`
        SELECT id FROM memories
         WHERE kind = 'procedural' AND active AND title = ${proc.title}
         LIMIT 1`;
      if (!existing) {
        await db`
          INSERT INTO memories (kind, scope, title, body, tags, importance, source_task_id, source_job_id)
          VALUES ('procedural', 'global', ${proc.title}, ${proc.body}, ${proc.tags},
                  0.8, ${incident.task_ids?.[0] ?? null}, ${incident.job_ids?.[0] ?? null})`;
        knowledgeWritten += 1;
      }
      await db`UPDATE incidents SET status = 'mitigated', root_cause = coalesce(root_cause, ${c.title})
                WHERE id = ${incident.id}`;
      continue;
    }

    // Non-auto path: propose, with evidence and a rollback pointer.
    const [dup] = await db<{ id: string }[]>`
      SELECT id FROM improvements
       WHERE incident_id = ${incident.id} AND status IN ('proposed','testing','reviewed')
       LIMIT 1`;
    if (dup) continue;

    await db`
      INSERT INTO improvements (incident_id, title, rationale, change, risk, status, evidence, rollback)
      VALUES (${incident.id},
              ${`Address repeat failure: ${incident.title}`},
              ${plan.rationale},
              ${db.json({ kind: plan.kind, category: c.category, occurrences: incident.occurrences } as never)},
              ${plan.risk},
              'proposed',
              ${db.json([{ claim: `occurred ${incident.occurrences} times`, proof: `incidents.fingerprint=${incident.fingerprint}`, passed: true }] as never)},
              ${db.json({ kind: 'revert_memory', pointer: incident.id, instructions: 'Mark this improvement rejected and delete any memory it created. No production config is touched by a knowledge/skill proposal.' } as never)})`;
    proposalsCreated += 1;
    await db`UPDATE incidents SET status = 'diagnosed' WHERE id = ${incident.id}`;
  }

  return { examined: open.length, knowledgeWritten, proposalsCreated };
}

/**
 * Promote an improvement. Refuses anything not explicitly reviewed unless it is
 * a low-risk knowledge change — the guardrail is enforced here, not in the UI.
 */
export async function promoteImprovement(
  db: Db,
  id: string,
  reviewer: string,
): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db<{ id: string; status: string; risk: string; change: { kind?: string } }[]>`
    SELECT id, status, risk, change FROM improvements WHERE id = ${id}`;
  if (!row) return { ok: false, reason: 'not_found' };
  if (!['proposed', 'testing', 'reviewed'].includes(row.status)) {
    return { ok: false, reason: `cannot promote from status ${row.status}` };
  }
  if (row.risk !== 'low' && row.status !== 'reviewed') {
    return { ok: false, reason: 'high/medium risk requires an explicit independent review before promotion' };
  }
  await db`UPDATE improvements
              SET status = 'promoted', promoted_at = now(), reviewed_by = ${reviewer}, updated_at = now()
            WHERE id = ${id}`;
  await db`INSERT INTO audit_log (action, actor, payload)
           VALUES ('improvement.promoted', ${reviewer}, ${db.json({ improvementId: id } as never)})`;
  return { ok: true };
}

/** Roll back a promoted improvement. Always allowed: it is the safety valve. */
export async function rollbackImprovement(
  db: Db,
  id: string,
  actor: string,
): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db<{ status: string }[]>`SELECT status FROM improvements WHERE id = ${id}`;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'promoted') return { ok: false, reason: `nothing to roll back (status ${row.status})` };
  await db`UPDATE improvements SET status = 'rolled_back', updated_at = now() WHERE id = ${id}`;
  await db`INSERT INTO audit_log (action, actor, payload)
           VALUES ('improvement.rolled_back', ${actor}, ${db.json({ improvementId: id } as never)})`;
  return { ok: true };
}

/** Small summary used by the dashboard and the bot's "what have we learned". */
export async function learningSummary(db: Db) {
  const [row] = await db<
    { incidents: number; open: number; repeats: number; proposals: number; promoted: number; memories: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM incidents) AS incidents,
      (SELECT count(*)::int FROM incidents WHERE status IN ('open','diagnosed')) AS open,
      (SELECT count(*)::int FROM incidents WHERE occurrences > 1) AS repeats,
      (SELECT count(*)::int FROM improvements) AS proposals,
      (SELECT count(*)::int FROM improvements WHERE status = 'promoted') AS promoted,
      (SELECT count(*)::int FROM memories WHERE active AND kind = 'procedural') AS memories`;
  return row ?? { incidents: 0, open: 0, repeats: 0, proposals: 0, promoted: 0, memories: 0 };
}