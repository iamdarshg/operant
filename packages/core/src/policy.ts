/**
 * Consequential-action policy.
 *
 * The mission's rule is "require approval for financial commitments, privileged
 * account changes, destructive operations and sensitive external actions". That
 * has to be code, not a paragraph — an approval queue nobody can populate is not
 * a mechanism.
 *
 * This is deliberately a *declarative gate* on the intent, not a runtime
 * interception of shell commands: the control plane decides before dispatch
 * whether the request may run unattended. It is conservative — it prefers a
 * false positive (one extra click) over a false negative (an unattended delete).
 */
import type { RiskLevel } from './schema.js';

export type ApprovalActionKind =
  | 'shell_command'
  | 'file_write_outside_workspace'
  | 'external_message'
  | 'account_change'
  | 'spend'
  | 'destructive'
  | 'production_config';

export interface RiskAssessment {
  required: boolean;
  risk: RiskLevel;
  kind: ApprovalActionKind;
  /** Which phrases triggered it — shown to the approver so the click is informed. */
  reasons: string[];
  /** One-line description of what would happen if approved. */
  summary: string;
}

interface Rule {
  kind: ApprovalActionKind;
  risk: RiskLevel;
  /** Human label for the trigger. */
  label: string;
  pattern: RegExp;
}

/**
 * Ordered rules. Specific and unambiguous first: a "delete the staging table"
 * request must not be excused by the presence of an unrelated word.
 */
const RULES: Rule[] = [
  {
    kind: 'destructive',
    risk: 'critical',
    label: 'destructive filesystem or data operation',
    pattern: /\b(rm\s+-rf|rm\s+-fr|del\s+\/f|format\s+[a-z]:|drop\s+(table|database|schema)|truncate\s+table|wipe|purge|destroy|nuke)\b/i,
  },
  // Account changes come BEFORE spend: "grant access to the billing dashboard" is
// an access change that merely mentions billing, and rule order decides which
// kind wins at equal risk. Ordered most-specific-intent first.
  {
    kind: 'account_change',
    risk: 'high',
    label: 'privileged account or access change',
    pattern:
      /\b(change (the )?password|reset (the )?password|rotate (the )?(\w+ ){0,2}(key|keys|token|credentials?|secret)|grant (access|permission)|revoke (access|permission)|add (a )?(user|admin)|create (an? )?(account|admin)|iam (policy|role)|make (me |them )?admin)\b/i,
  },
  {
    kind: 'spend',
    risk: 'high',
    label: 'financial commitment',
    pattern: /\b(pay|payment|purchase|buy|subscribe|checkout|invoice|upgrade (the |my )?plan|billing|top up|charge (the )?card)\b/i,
  },
  {
    kind: 'production_config',
    risk: 'medium',
    label: 'production or shared configuration change',
    pattern: /\b(deploy (to )?(prod|production)|push to (prod|production)|production (config|environment|database)|change (the )?firewall|open (a )?port|modify (the )?(vpc|dns|tls|certificate))\b/i,
  },
  {
    kind: 'external_message',
    risk: 'medium',
    label: 'message sent outside this platform',
    pattern: /\b(send (an? )?(email|e-mail|dm|text|tweet)|(email|e-mail|dm|message|ping)\s+(the\s+)?(client|customer|team|user|vendor|boss|manager|recruiter|everyone|group|channel)|post (to )?(twitter|x\.com|linkedin|reddit|the (team|channel|group))|publish (to|on)|reply to (the )?(client|customer)|notify (the )?(client|customer|team))\b/i,
  },
  {
    kind: 'file_write_outside_workspace',
    risk: 'medium',
    label: 'write outside the job workspace',
    // No leading \b before the path alternation: "/" is a non-word character, so
    // \b(...\/etc\/) can never match after a space. Observed failure in tests.
    pattern: /\b(write|edit|modify|overwrite)\b[^.]{0,40}(c:\s*\\|d:\s*\\|e:\s*\\|\/etc\/|\/usr\/|\/var\/|system32|~\/\.dsh)/i,
  },
];

/** Paths that make an otherwise ordinary request sensitive. */
const SENSITIVE_PATH = /(\/etc\/|\/usr\/|\/var\/|system32|\.dsh\/|\.ssh\/|\.aws\/|\.codex\/)/i;

/**
 * Assess one intent.
 *
 * @param text the user's own words, unmodified
 * @returns whether a human must approve before any job is dispatched
 */
export function assessIntent(text: string): RiskAssessment {
  const reasons: string[] = [];
  let kind: ApprovalActionKind = 'shell_command';
  let risk: RiskLevel = 'low';

  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      reasons.push(rule.label);
      if (rank[rule.risk] > rank[risk]) {
        risk = rule.risk;
        kind = rule.kind;
      }
    }
  }

  // A sensitive path mentioned without a write verb is still worth a look when
  // the request also instructs a change.
  if (reasons.length === 0 && SENSITIVE_PATH.test(text) && /\b(change|update|edit|add|remove|delete|move)\b/i.test(text)) {
    reasons.push('touches a sensitive path outside the workspace');
    kind = 'file_write_outside_workspace';
    risk = 'medium';
  }

  if (reasons.length === 0) {
    return { required: false, risk: 'low', kind, reasons: [], summary: 'read-only or workspace-scoped work' };
  }

  const summary = `This request looks like a ${reasons[0]}. It will not run until a human approves it.`;
  return { required: true, risk, kind, reasons, summary };
}

/** Convenience for UIs: does this intent need a human before it runs? */
export function requiresApproval(text: string): boolean {
  return assessIntent(text).required;
}

/* ------------------------------------------------------------------ *
 * Tool-call boundary
 * ------------------------------------------------------------------ */

export interface ToolCallAssessment {
  block: boolean;
  risk: RiskLevel;
  kind: ApprovalActionKind;
  reason: string;
}

/**
 * Commands that must never run unattended, regardless of how the request was
 * phrased. This is the layer that fixes the finding "the gate inspects prose, so
 * paraphrasing walks past it": here we look at the command the agent is about to
 * execute, which no amount of creative wording changes.
 */
const SHELL_DENY: { re: RegExp; reason: string; risk: RiskLevel; kind: ApprovalActionKind }[] = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: 'recursive or forced delete', risk: 'critical', kind: 'destructive' },
  { re: /\b(rm|rmdir)\s+-[a-z]*r[a-z]*\s+\/(\s|$)/i, reason: 'delete from filesystem root', risk: 'critical', kind: 'destructive' },
  { re: /\b(del|erase)\s+.*\/s/i, reason: 'recursive delete (Windows)', risk: 'critical', kind: 'destructive' },
  { re: /\bRemove-Item\b[^\n]*-Recurse/i, reason: 'recursive delete (PowerShell)', risk: 'critical', kind: 'destructive' },
  { re: /\b(mkfs|fdisk|parted|format)\b/i, reason: 'filesystem or partition operation', risk: 'critical', kind: 'destructive' },
  { re: /\bdd\s+if=/i, reason: 'raw device write', risk: 'critical', kind: 'destructive' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'host power control', risk: 'high', kind: 'destructive' },
  { re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: 'destructive SQL', risk: 'critical', kind: 'destructive' },
  { re: /\bDELETE\s+FROM\s+\w+\s*(;|$)/i, reason: 'unqualified DELETE (no WHERE clause)', risk: 'high', kind: 'destructive' },
  { re: /\bchmod\s+(-R\s+)?777\b/i, reason: 'make world-writable', risk: 'high', kind: 'production_config' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(ba)?sh/i, reason: 'pipe remote content into a shell', risk: 'critical', kind: 'shell_command' },
  { re: /\b(iwr|Invoke-WebRequest)\b[^\n|]*\|\s*iex/i, reason: 'execute remote content (PowerShell)', risk: 'critical', kind: 'shell_command' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb', risk: 'critical', kind: 'destructive' },
  // No leading \b: `>` is a non-word character, so \b(>>?|tee) can never match
// after a space. This exact trap already bit the file-write rule once.
  { re: /(>>?|tee)\s*\/etc\//i, reason: 'write into /etc', risk: 'high', kind: 'file_write_outside_workspace' },
  { re: /authorized_keys|\.ssh\/|shadow\b|sudoers/i, reason: 'credential or privilege file', risk: 'critical', kind: 'account_change' },
];

/** Tool names that only mutate the workspace and need no boundary check. */
const READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'list_agents']);

/**
 * Assess one tool call the agent is about to make / has just made.
 *
 * @param tool tool name as the runtime reports it
 * @param args the tool arguments
 * @returns whether the worker must stop the run and escalate to a human
 */
export function assessToolCall(tool: string, args: unknown): ToolCallAssessment {
  const name = tool.toLowerCase();
  const serialized = safeStringify(args);

  // Reviewers and read-only tooling are exempt: they cannot mutate anything.
  if (READONLY_TOOLS.has(name)) {
    return { block: false, risk: 'low', kind: 'shell_command', reason: 'read-only tool' };
  }

  for (const rule of SHELL_DENY) {
    if (rule.re.test(serialized)) {
      return { block: true, risk: rule.risk, kind: rule.kind, reason: rule.reason };
    }
  }

  // Writes that escape the workspace: the sandbox should stop these, but if the
  // permission mode were relaxed the policy still refuses to do it unasked.
  const writeish = /\b(write|edit|create|append|save|move|copy)\b/i.test(name) || /(write|edit|patch)/.test(name);
  const outside = /(\/etc\/|\/usr\/|\/var\/|\/root\/|system32|\.ssh\/|\.aws\/|\.dsh\/|authorized_keys)/i.test(serialized);
  if (writeish && outside) {
    return { block: true, risk: 'high', kind: 'file_write_outside_workspace', reason: 'write outside the job workspace' };
  }

  return { block: false, risk: 'low', kind: 'shell_command', reason: 'no policy rule triggered' };
}

/** JSON.stringify that never throws on cycles. */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[circular]';
        seen.add(v as object);
      }
      return v;
    }) ?? '';
  } catch {
    return String(value);
  }
}