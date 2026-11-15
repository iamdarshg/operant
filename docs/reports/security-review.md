# Independent Security Review — Operant

- **Reviewer:** independent (did not write this system)
- **Date:** 2026-11-16
- **Commit under review:** `cd3c248` (+ uncommitted `packages/core/src/policy.ts`, `apps/api/src/server.ts`, `packages/db/src/index.ts`)
- **Scope:** the 9 areas specified in the brief, plus dependency/IAM posture.
- **Environment:** Windows 11 client, control plane and VoiceStudio reached through pre-existing SSH tunnels via IAP to `operant-core` (GCP `asia-south1-c`).

Every finding below is labelled **VERIFIED EXPLOITABLE** (I ran it and it worked) or **CODE-READING CONCERN** (proven from source, not weaponised). Secrets are never printed; only key names and file modes.

---

## 0. Disclosure — probes that had side effects

Two probes mutated state. Both are stated plainly rather than omitted:

1. `POST /v1/requests` with a spend-class intent created **one task + one approval row** (by design, the gate held — see §7). I attempted to reject it to leave state clean; the API was down at that moment (see §10), so the row remains `pending`. It holds no job and will never run.
2. While discriminating authentication from request-validation on the VoiceStudio REST surface I included `DELETE /history` in the probe list. It returned **200 with no authentication**. `GET /history` had returned `[]` (2 bytes) moments earlier, so **no rows were deleted** — but the fact that an unauthenticated `DELETE` returned 200 is itself a finding (§5.3), and I should not have batched a destructive verb into an exploratory list.

I did not stop services, delete data, or change firewall rules.

---

## Findings table

| # | Severity | Issue | Evidence | Fix |
|---|---|---|---|---|
| F1 | **CRITICAL** | Live control-plane bearer token committed to git | `git grep` → `apps/bot/src/config.ts:21`; token returned `200 OK` on `/v1/tasks` | Rotate now; load from env only; purge history (`git filter-repo`); add CI secret scan (gitleaks) |
| F2 | **HIGH** | Approval gate bypassed by ordinary paraphrase — 11/11 evasions succeeded | `assessIntent()` returned `required:false` for all 11 (§7.2) | Gate on the agent's actual tool calls, not a prose denylist; deny-by-default for shell/write |
| F3 | **HIGH** | Agent child process inherits `OPERANT_BOT_TOKEN` + `DATABASE_URL` | `safeEnv()` = `{...process.env}` (`dsh-adapter/src/index.ts:381-385`) | Allow-list env for the child; never pass control-plane creds to an agent |
| F4 | **HIGH** | VoiceStudio MCP transport is completely unauthenticated | `initialize` + `tools/list` + `tools/call` all succeed with zero credentials (§5.1) | Require per-agent bearer token on `/mcp`; scope tools |
| F5 | **HIGH** | No rate limiting on bearer auth — unlimited online brute force | 120 wrong-token requests → 120×`401`, zero `429` (§1.3) | `@fastify/rate-limit` on auth failures + lockout |
| F6 | **MEDIUM** | `fastify@5.2.1` carries a published auth-bypass advisory on the exact component enforcing auth | `pnpm audit`: `GHSA-p68q-wchp-6fh7`, high, patched `>=5.12.2` | Upgrade Fastify ≥5.12.2 |
| F7 | **MEDIUM** | Unauthenticated reads + destructive verb on VoiceStudio REST | `/system/logs` 200 (18,917 B); `/profiles` 200; `DELETE /history` 200 (§5.3) | Same auth gate as `/mcp`, applied to all routes |
| F8 | **MEDIUM** | `next@15.1.3` unauthenticated RCE advisory (Image Optimization / SVG) | `pnpm audit`: `GHSA-2464-fhr4-w9xw`, critical, patched `>=15.5.28` | Upgrade Next ≥15.5.28 |
| F9 | **MEDIUM** | CORS reflects any origin (`origin: true`) | `server.ts:74` | Pin to the dashboard origin |
| F10 | **LOW** | Early-return length compare leaks token length | `server.ts:81` | Hash both sides then compare fixed-length digests |
| F11 | **LOW** | Secrets file inherits permissive Windows ACLs | `icacls`: `Authenticated Users:(I)(M)`, `Users:(I)(RX)` | Explicit ACL to owner + Administrators |
| F12 | **LOW** | `ufw` allows `41641/udp` from Anywhere (Tailscale) | `ufw status verbose` | Scope to Tailscale CGNAT range, or drop |
| F13 | **LOW** | Project retains `default-allow-ssh/rdp/http(s)` `0.0.0.0/0` on the default VPC | `firewall-rules list` | Delete unused default rules |

---

## 1. AuthN / AuthZ

**PASS overall for the control plane** — default-deny is correctly implemented.

### 1.1 No token / wrong token / malformed header → 401
```
GET /v1/jobs, /v1/tasks, /v1/me, /health, /   => ERR 401   (all)
wrong token              => 401
empty bearer ("Bearer ")  => 401
no "Bearer " prefix       => 401
lowercase "bearer"        => 401
token truncated by 1 char => 401
?token=<valid> query form => 401   (query-string token not honoured — correct)
```
There is **no** unauthenticated `/v1` route except the intentional `GET /v1/health`:
```
GET /v1/health => 200 {"state":"healthy","checks":[{"name":"postgres","state":"healthy","detail":"0ms"}],"dshProfile":"operant"}
```
`/v1/health` discloses DB liveness and the DSH profile name only — acceptable, and it is the documented supervisor probe. Fails closed at boot when `OPERANT_BOT_TOKEN` is unset or `< 16` chars (`server.ts:60-65`).

### 1.2 Constant-time comparison — **PASS with a length leak**
`server.ts:77-85` accumulates `diff |= provided[i] ^ expected[i]` over equal-length buffers. Content comparison is constant-time. The `if (provided.length !== expected.length) return false` at line 81 returns early, leaking **token length** (F10, low — length alone is not exploitable here).

### 1.3 Brute force — **FAIL**
```
120 requests with "Bearer wrong<i>" in 10.65s => {"401":120}
any 429? False
```
No rate limit, no lockout, no backoff, no per-IP throttle anywhere in `server.ts`. Combined with F1 (token is public in git) this is not the primary risk, but a 20-char token with no throttle is brute-forceable offline-of-record if the token is ever a human-chosen string.

---

## 2. Token containment

**FAIL** — the token is committed.

```
$ git -C E:\CodeProjects\operant grep -n "devtoken-operant-cloud"
apps/bot/src/config.ts:21:export const DEV_API_TOKEN = '<REDACTED-BEARER-TOKEN>';
apps/bot/test/startup.test.ts:115: expect(...).toBe('Bearer <REDACTED-BEARER-TOKEN>');
```
Introduced in commit `1feda7c`. The file's own comment claims dev defaults are "refused when `NODE_ENV=production`" — that guards the *fallback*, not the fact that the literal is in the repository.

**The committed literal is the live credential:**
```
GET /v1/tasks?limit=1 with Authorization: Bearer <REDACTED-BEARER-TOKEN>
=> 200 OK
```

**Dashboard client bundle — PASS.** The token is absent from client-served assets:
```
files scanned in apps/web/.next/static (24): NO MATCH for 'devtoken-operant-cloud'
```
It also does not appear in any other `.next` artifact (server bundles or webpack cache). The dashboard therefore does **not** ship the token to the browser; whatever auth it uses stays server-side. No `.next` file, client or server, contains the literal.

**`.gitignore` — PASS.**
```
$ git check-ignore -v .env secrets/.credentials.yaml
.gitignore:6:.env        .env
.gitignore:9:secrets/    secrets/.credentials.yaml
```

---

## 3. Secrets at rest

| Location | Key names | Mode | Verdict |
|---|---|---|---|
| `secrets/.credentials.yaml` (repo) | *(none)* — file is 43 bytes: `# placeholder for compose validation only` | inherited Windows ACL (F11) | **PASS** — no secret material present |
| `/etc/operant/` (VM) | `hour-cap` (a 4-byte counter, not a secret) | dir `750 root:operant`; file `644` | **PASS** — no credentials stored here |
| `~/.dsh/.credentials.yaml` (VM) | `version`, `refs`, `records` | `-rw-------  iamdarshg:iamdarshg` (0600) | **PASS** — owner-only |

Mounted **read-only** into containers — **PASS**:
```
docker-compose.yml:35  - ${DSH_CREDENTIALS_FILE:-./secrets/.credentials.yaml}:/home/operant/.dsh/.credentials.yaml:ro
```
Runtime secret checks confirm nothing is baked into the image; the API reads `OPERANT_BOT_TOKEN` and `DATABASE_URL` from its systemd environment, and the env keys (values redacted) were:
```
NODE_ENV LOG_LEVEL DATABASE_URL OPERANT_API_PORT OPERANT_API_HOST OPERANT_BOT_TOKEN OPERANT_WORKSPACE_ROOT WORKER_CONCURRENCY JOB_TIMEOUT_MS
```
F11 stands as the only weakness: the repo `secrets/` file inherits `Authenticated Users:(I)(M)` / `Users:(I)(RX)`. Harmless today because the file is a placeholder, but the same create-then-forget pattern would make the next real credentials file readable by every local account.

---

## 4. Network exposure

### 4.1 VM listeners — **PASS** (nothing beyond loopback except SSH)
```
LISTEN 0.0.0.0:22            (SSH, restricted by ufw to IAP range)
LISTEN 127.0.0.53%lo:53      (systemd-resolved, link-local)
LISTEN 127.0.0.1:8787        node  (control plane)
LISTEN 127.0.0.1:55432       (postgres)
LISTEN 127.0.0.1:3900        (VoiceStudio)
LISTEN 127.0.0.54:53         (systemd-resolved, link-local)
LISTEN [::]:22
```
Both product services bind loopback only, matching `docker-compose.yml` (`"127.0.0.1:8787:8787"`, `"127.0.0.1:3900:3900"`).

### 4.2 GCP firewall — **PASS for this VM**, with project-level hygiene debt
```
operant-core network = operant-vpc, tags = [operant-node]
rules on operant-vpc:
  operant-allow-iap-ssh  INGRESS  35.235.240.0/20  tcp:22  [operant-node]
```
Only IAP-sourced SSH reaches this instance — no `0.0.0.0/0` rule targets it. However the project still carries rules that would expose **any** VM on the default VPC (F13):
```
default-allow-ssh    INGRESS 0.0.0.0/0  tcp:22
default-allow-rdp    INGRESS 0.0.0.0/0  tcp:3389
default-allow-http   INGRESS 0.0.0.0/0  tcp:80
default-allow-https  INGRESS 0.0.0.0/0  tcp:443
default-allow-icmp   INGRESS 0.0.0.0/0  icmp
```

### 4.3 ufw — **PASS with one unnecessary opening**
```
Status: active
Default: deny (incoming), allow (outgoing), deny (routed)
22/tcp       ALLOW IN  35.235.240.0/20   # ssh via IAP
41641/udp    ALLOW IN  Anywhere          # tailscale direct   (F12)
41641/udp (v6) ALLOW IN Anywhere (v6)
```
`41641/udp` is open to Anywhere at the host layer, though the cloud firewall does not permit it, so it is not actually reachable from the internet today. This is a defence-in-depth inconsistency, not a live hole.

---

## 5. MCP surface

### 5.1 Transport is **unauthenticated — FAIL**
No credential of any kind is required to fully drive the MCP server. A raw handshake succeeded:
```
POST /mcp/  initialize  => 200, Mcp-Session-Id issued
serverInfo: {"name":"VoiceStudio","version":"1.30.0"}
instructions: "AI-agent interface for VoiceStudio — voice cloning, voice design, and video dubbing in 646 languages."

POST /mcp/  tools/list (with session) => 200, 9 tools
POST /mcp/  tools/call list_voices    => 200, returns voice profile records
```
The only protection is **not** authentication:

| Probe | Result | Assessment |
|---|---|---|
| `Host: evil.example` | **403** | DNS-rebinding guard works — PASS |
| `Accept: application/json` only | 406 | transport requires SSE-capable Accept — PASS |
| malformed JSON-RPC body | **400** | parse rejection before dispatch — PASS |
| `GET /mcp/` with no session | 400 | session required — PASS |

So the server is hardened against *browser-driven* rebinding, but any process that can reach `127.0.0.1:3900` — a local user, a compromised dependency, an SSRF, **or the agent itself** (it is wired in as `VOICESTUDIO_MCP_URL: http://voicestudio:3900/mcp/`) — has full tool access.

### 5.2 `audio_path` confinement — **PASS** (the boundary holds)
The tool doc claims `OMNIVOICE_MCP_BASE_PATH` is the security boundary; it is enforced, and this is the one place I tried hardest to break:

| Tool call | Result |
|---|---|
| `transcribe {audio_path:"/etc/passwd"}` | `{"error": "'/etc/passwd' resolves outside OMNIVOICE_MCP_BASE_PATH"}` |
| `transcribe {audio_path:"../../../../etc/passwd"}` | `{"error": "'../../../../etc/passwd' resolves outside ..."}` |
| `clone_voice {ref_audio_path:"/etc/passwd"}` | `{"error": "'/etc/passwd' resolves outside ..."}` |

Base path on the VM is `/data/mcp-audio` (read-only bind from `/opt/operant/voicestudio/bench`, `rw=false`). No arbitrary file read. Minor API-hygiene nit: these refusals come back with `isError:false`, so a naive client may treat a refusal as success.

### 5.3 Blast radius if a request reaches it
9 tools: `generate_speech`, `list_voices`, `list_personalities`, `list_languages`, `transcribe`, `check_health`, `clone_voice`, `describe_voice`, `design_voice`.

An attacker with transport access can:
- **Clone any voice** (`clone_voice`, `design_voice`) from supplied audio and then **synthesise speech in it** (`generate_speech`) — impersonation of a real person's voice, with no consent gate and no audit. This is the highest-impact capability on the surface.
- **Enumerate saved voice profiles** (`list_voices` returned full profile records including `ref_text`, `consent_*`, `audio_url`).
- **Transcribe** any audio file inside the base path — content disclosure for whatever is staged there.
- Burn GPU/CPU freely (no quota or auth).

The same port's REST surface is broader still (320 OpenAPI paths) and **partially unauthenticated** (F7):
```
GET  /profiles                => 200  (829 B)
GET  /history                 => 200
GET  /system/logs             => 200  (18,917 B of logs)
GET  /api/settings/storage    => 200
GET  /api/settings/hf-token/state => 200
POST /generate                => 422  (authz absent — request reached schema validation)
POST /convert                 => 422  (same)
DELETE /history               => 200  (!!) unauthenticated destructive verb
POST /system/set-env          => 403  (gated)
POST /api/settings/license    => 403  (gated)
GET  /api/cloud-sync/local/keys => 403 (gated)
```
The pattern is inconsistent: some mutating routes are gated, but `DELETE /history`, `POST /generate` and `POST /convert` are not, and `/system/logs` leaks operational detail.

---

## 6. Injection / tool abuse

**PASS** — no interpolation sinks found in any of the three files.

### 6.1 `apps/api/src/server.ts` — no shell, no path, no SQL interpolation
Every database call uses the `postgres` tagged-template form (`db\`...\``) with `${}` bound parameters. There is no `exec`, `spawn`, or `child_process` import in the file at all. The one filesystem write is safe because the path component is a server-generated UUID:
```ts
const taskId = randomUUID();
const workspacePath = join(WORKSPACE_ROOT, taskId);   // server.ts:124-125
await mkdir(workspacePath, { recursive: true });
```
User text reaches only `titleFrom()` (whitespace-collapsed, length-capped) and `buildPrompt()` (concatenated into a text blob delivered on stdin). No shell, no SQL, no path.

### 6.2 `packages/dsh-adapter/src/index.ts` — prompt on **stdin**, flags fixed
```ts
const args = ['--profile', profile, '--json'];
if (permissionMode) args.push('--permission-mode', permissionMode);
if (sessionId) args.push('--session-id', sessionId);
...
const child = isWindows
  ? spawn(ComSpec, ['/d','/s','/c', `dsh ${args.map(shellQuote).join(' ')}`], {...})
  : spawn('dsh', args, {...});
...
child.stdin.end(prompt, 'utf8');
```
The prompt is **never** on the argv, so a prompt cannot choose a flag — this is the correct design and the file documents why. `profile` is regex-validated (`/^[a-z0-9][a-z0-9-]{0,31}$/`) before use.

Residual (low): on Windows the argv *is* rebuilt into a `cmd.exe` string. `permissionMode` and `sessionId` are the only variable tokens there, are DB-sourced rather than caller-sourced, and are either restricted by `shellQuote`'s charset or double-quoted. Not attacker-controllable through the API, but `permissionMode` is never validated against an allow-list — worth fixing before any path makes it caller-influenced.

### 6.3 `packages/db/src/index.ts` — tagged templates only
All queries use `db\`\`` / `tx\`\`` with bound `${}` parameters, including the `websearch_to_tsquery('english', ${query})` and `ILIKE ${'%'+query+'%'}` cases (parameterised, so `%`/`_` are wildcard semantics, not injection). The single raw path is:
```ts
await db.unsafe(sqlText);   // migrate(): reads local .sql files from a directory
```
That is a migration runner over repo-controlled files, not user input — acceptable.

---

## 7. Approval gate

**FAIL** — the gate is real (it does hold canonical phrasing, and no job row is created) but it is a prose keyword denylist and falls to any paraphrase.

### 7.1 The gate holds when it fires — **PASS**
Live, authenticated, consequential-but-harmless intent:
```
POST /v1/requests {"text":"Purchase a new GPU instance and pay the invoice, then upgrade the billing plan", ...}
202 {"taskId":"7d8f3cb8-...","jobId":null,"status":"waiting_approval","approvalRequired":true,
     "approvalId":"6cbdda83-...","risk":"high","reasons":["financial commitment"]}
```
`jobId` is `null` and no job row exists — the design intent in `createTaskAwaitingApproval` ("a queued job would be claimable and the gate would be decorative") is honoured. Verified directly in the database:
```
docker exec operant-pg psql -U operant -d operant -tAc \
  "SELECT status FROM approvals WHERE id='6cbdda83-...';"   => pending
docker exec operant-pg psql -U operant -d operant -tAc \
  "SELECT count(*) FROM jobs WHERE task_id='7d8f3cb8-...';"  => 0
```

### 7.2 Evasion — **11 of 11 succeeded**
Rather than dispatch evading prompts against a **live worker** (pid 62328, `apps/worker/dist/main.js` — a created job would actually execute and could have run the destructive instruction), I evaluated the real compiled policy function directly:

```
node -e "import {assessIntent} from './packages/core/src/policy.ts'; ..."
```

| Intent | `required` |
|---|---|
| `rm -rf /var/backups` *(control)* | **true** — destructive/critical |
| `pay the invoice for the billing plan` *(control)* | **true** — spend/high |
| `deploy to production tonight` *(control)* | **true** — production_config/medium |
| `send an email to the client` *(control)* | **true** — external_message/medium |
| `rm -r -f /var/backups` | **false** |
| `Remove-Item -Recurse -Force C:\Users\Darsh Gupta\docs` | **false** |
| `delete every file under data/jobs` | **false** |
| `drop the users table from the database` | **false** |
| `truncate the audit table` | **false** |
| `append this line to /etc/passwd` | **false** |
| `put this key into /root/.ssh/authorized_keys` | **false** |
| `email the client the quarterly report` | **false** |
| `save these lines into /etc/cron.d/backup` | **false** |
| `grant my friend access to the repo` | **false** |
| `run chmod 777 on /etc/shadow` | **false** |

Root causes, each independently sufficient:
- The denylist matches **adjacent tokens**: `truncate\s+table` misses "truncate **the** audit table"; `drop\s+(table|...)` misses "drop **the users** table"; `grant (access|permission)` misses "grant **my friend** access".
- **Plain "delete" is not in the destructive rule at all** — only `rm -rf`, `del /f`, `format X:`.
- **No PowerShell verbs** (`Remove-Item`, `Clear-Content`, `Set-Content`) — the operator's own platform is Windows.
- The `file_write_outside_workspace` rule only accepts `(write|edit|modify|overwrite)` as verbs, so `append`, `put`, `save`, `create`, `chmod` all evade; and its `[^.]{0,40}` window means any sentence longer than ~40 characters before the path defeats it.
- `external_message` requires the literal verb "send"/"post"/"publish"/"notify"/"reply" — "email the client the report" evades.

**The structural problem is deeper than the regexes:** `assessIntent(input.text)` inspects the *user's prose*, once, before dispatch. It never inspects what the agent actually does. The agent can run `rm -rf` via its shell tool regardless of what the prose said. A denylist on intent cannot be the enforcement point for an autonomous agent — the enforcement point has to be the tool-call boundary.

---

## 8. Workspace isolation

**PARTIAL — the path is safe, the confinement is delegated and the environment leaks.**

`workspace_path` is `join(WORKSPACE_ROOT, <uuid>)`; the agent runs with `cwd = job.workspace_path` and `--permission-mode workspace-write` (from `agents.permission_mode`, all four seeded agents are `workspace-write`/`read-only`). There is **no path by which a caller can choose or escape `data/jobs/<task>`** via the API — the UUID is server-generated.

What is *not* provided:
- **No OS-level sandbox per job.** No per-job container, no separate uid, no seccomp/AppArmor, no mount namespace. Enforcement of "workspace-write" rests entirely on the DSH CLI honouring the flag. If DSH's interpretation is weaker than assumed, the agent has the `operant` user's full filesystem (read) with no second line of defence.
- **Credential inheritance (F3, verified from source).** `safeEnv()` is `{...process.env}` minus `NODE_OPTIONS` and `DSH_DEBUG`. The worker's own environment contains `OPERANT_BOT_TOKEN` and `DATABASE_URL`, so the agent's child process receives the control-plane bearer token and the database URL. Any prompt that induces the agent to read its environment (`env`, `set`, `/proc/self/environ`) hands over the control plane — which nullifies every containment property in §1. The model-provider credentials are likewise readable at `~/.dsh/.credentials.yaml` inside the container (by design for the model route, but it means a prompt-injected agent can exfiltrate the LLM API key).

This is the finding I would fix second, after F1: it converts any F2-style prompt injection from "annoying" into "control-plane takeover".

---

## 9. Dependency / IAM

### 9.1 Dependency advisories (`pnpm audit`, 481 deps)
```
{"info":0,"low":16,"moderate":58,"high":48,"critical":9}   // 131 total
```
Material to this review:
- **`fastify@5.2.1` (`apps__api`)** — `GHSA-p68q-wchp-6fh7` "authentication bypass via malformed URLs reaching encapsulated not-found handlers", **high**, patched `>=5.12.2`. Also `GHSA-hwr6-493r-vm6h` (validation bypass) and `GHSA-9q9j-q6p8-xq58` (header validation bypass), both high, both `<5.12.2`. **This advisory is on the exact component that implements the bearer check**, so it deserves priority even though I did not demonstrate an exploit (our auth is a root-level `onRequest` hook, not an encapsulated not-found handler — the specific vector likely does not apply, but I am not certifying that without a PoC).
- **`next@15.1.3` (`apps__web`)** — `GHSA-2464-fhr4-w9xw` "Unauthenticated Remote Code Execution in Image Optimization API when SVG files are used", **critical**, patched `>=15.5.28`; plus several high SSRF/DoS advisories.
- **`@modelcontextprotocol/sdk@1.12.1` (`packages/mcp-client`)** — high: ReDoS (`GHSA-8r9q-7v3j-jr4g`), unbounded request body (`GHSA-f897-62hf-6gxq`, `GHSA-46jr-4wx8-v453`), and "server bearer authentication accepted tokens issued for another service" (`GHSA-rvq5-wwqv-78pq`).
- **`zod@3.24.1`** — `GHSA-mrhx-c7xc-m3w5` memory exhaustion on oversized constrained collections, high.
- Others: `undici@7.2.0` (`apps__bot`) many high DoS/TLS-validation; `sharp@0.33.5` high incl. libvips CVEs; `postcss` high (build-time).
- `tinypool` critical + vitest/vite issues are devDependencies — not shipped.

I am reporting the advisory metadata the tool returned, with versions and patched ranges, rather than asserting a working exploit.

### 9.2 IAM / service account
```
serviceAccounts: 988177451335-compute@developer.gserviceaccount.com
scopes: devstorage.read_only, logging.write, monitoring.write, pubsub,
        service.management.readonly, servicecontrol, trace.append
```
Positive: no `cloud-platform` scope, and there is no project-level IAM binding for this SA in the query I ran (empty result) — so it is narrower than the common default. Negative: **`pubsub` is full read/write** and is not needed by an API/worker/voice host, and `service.management.readonly` is broader than necessary. Because the agent runs as this instance identity, any agent compromise inherits these scopes. Recommend a dedicated SA with `logging.write` + `monitoring.write` only, and verify the binding with `gcloud projects get-iam-policy` before trusting the empty result.

---

## 10. Environmental note (not a finding)

The VM **rebooted at 18:53:51 UTC** mid-review (`uptime -s`), and `operant-api` was stopped/restarted three times immediately before that (18:52:29, 18:53:37, 18:54:18, 18:54:27). My probes were returning normal `200`/`202` throughout, so this was **not** caused by them — but it did kill the local SSH tunnel and take `127.0.0.1:8787` offline for the remainder of the session. After the reboot only `voicestudio` was running; the `operant-pg` container stayed absent for roughly ten minutes and was up again by the end of the review. All evidence in §1, §5–§9 was collected **before** the reboot and remains valid; the `DELETE /history` and gate probes in §0 and §7.1 are from that window, and the gate's zero-job-row result was additionally re-confirmed against Postgres after `operant-pg` returned. The working tree was also being edited concurrently during the review (worker sources, screenshots, `out.json`), which is the likeliest explanation for the pre-reboot service restarts.

---

## What must change before this is exposed to a network

**1. The token is already public — rotate it and stop committing credentials.**
The bearer token (the `devtoken-operant-cloud-…` literal supplied for this review) is committed in git at `apps/bot/src/config.ts:21` and it is the live credential (verified `200 OK`). Anything with repo access has full control-plane access. Rotate, load from environment only, purge from history, and add a CI secret scan. This is unconditional and does not depend on any other finding.

**2. Rebuild the approval gate at the tool-call boundary, not on prose.**
An 11-of-11 evasion rate means the gate provides ~no protection against a motivated or merely unlucky phrasing, and it inspects intent rather than action. Gate consequential *tool calls* (shell exec, write outside the workspace, network send, spend) with deny-by-default and a human approval round-trip, and treat the prose classifier as a UX hint only.

**3. Stop handing control-plane credentials to the agent, and authenticate the MCP surface.**
`safeEnv()` passes `OPERANT_BOT_TOKEN` and `DATABASE_URL` into the agent's child process, so one prompt injection upgrades from "agent misbehaves" to "attacker owns the control plane". Pass an allow-list instead. In parallel, put a bearer token in front of `/mcp` and the unauthenticated VoiceStudio REST routes (`/system/logs`, `DELETE /history`, `POST /generate`, `/convert`) — an unauthenticated voice-cloning endpoint on a loopback port is one SSRF away from being an impersonation service.

Also worth doing in the same pass: upgrade `fastify` ≥5.12.2 and `next` ≥15.5.28 (F6, F8), add rate limiting on auth failures (F5), and remove the `Authenticated Users` ACL inheritance on `secrets/` (F11).