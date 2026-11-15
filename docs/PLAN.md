# Operant — implementation plan and state

**Durable state file.** If the conversation is compacted, this file and
`docs/reports/` are the source of truth. Update it as phases close.

Last updated: 2026-11-15 (Asia/Calcutta)

---

## 1. What is being built

A personal AI-employee platform that runs on DeepSeek Harness (DSH) as the
agent execution engine, exposes Discord as the primary conversational surface
and a web dashboard as mission control, and hosts CPU speech (VoiceStudio) that
both the cloud and the laptop DSH reach over MCP through a private network.

Non-goals: reimplementing DSH, wrapping another agent framework, GPU inference,
or a dashboard whose controls are decorative.

---

## 2. Decisions locked (with the evidence that locked them)

| # | Decision | Evidence |
|---|---|---|
| D1 | Execution engine = `dsh --profile <p> --json` child processes | Verified NDJSON: `session` → `status(turn_start/step_start/step_end/turn_end)` → `text` → `final`. Exit 0 only on completed turn. |
| D2 | Operant jobs run on a **new** profile `operant`, not stock `headless` | Stock headless routes to `deepseek-official` and dies `MISSING_CREDENTIAL` (no `DEEPSEEK_API_KEY` on this host). Proven by a real run. |
| D3 | Model route = `llm-pi-ai` → `surplus` / `deepseek-v4.1-flash-1017` | Same route the working Web profile uses; the model must declare `reasoningEfforts` or the runtime rejects `high`. |
| D4 | Cloud = GCP `e2-standard-8`, `asia-south1-c`, on-demand, 100 GB pd-balanced, **no GPU** | Approved by operator with a hard $120 total cap. Pricing from Cloud Billing Catalog, not memory. |
| D5 | Private by default: dedicated VPC, no `default-allow-ssh`, SSH only via IAP; Tailscale is steady state | The default VPC allows SSH from `0.0.0.0/0` — disallowed by the mission. |
| D6 | Cost control = VM-side watchdog (stops at 300 billed hours) **plus** budget alerts | Budget alerts do not stop billing; the mission states this explicitly. |
| D7 | VoiceStudio image pinned by digest, never `:latest` | `ghcr.io/debpalash/voicestudio:0.5.8@sha256:9cfc492a…871f0d`, linux/amd64 only, anonymous pull works. |
| D8 | VoiceStudio is CPU-first, FastAPI-mounted MCP at `/mcp/` (trailing slash), **unauthenticated transport** | Requires `OMNIVOICE_MCP_ALLOWED_HOSTS` for non-localhost Host headers; never publish `0.0.0.0:3900`. |
| D9 | Search provider is pinned explicitly in every profile | With two mounted DeepSeek providers and no pin, `web_search` fails `multiple usable web providers are registered`. |
| D10 | Discord deferred to the end (operator choice) | Bot is built and unit-tested; real gateway proof needs an operator-supplied token. |

---

## 3. Repository layout

```
D:\CodeProjects\operant
  apps/{api,web,bot,worker}      control plane, dashboard, Discord, job runner
  packages/{core,db,dsh-adapter,memory,learning,mcp-client,ui,web-search-ddg}
  infra/{gcp,compose,systemd,tailscale,scripts}
  services/{voicestudio,dsh}
  tests/{e2e,integration,fixtures}
  docs/{adr,reports,research,runbooks}
  design/
```

`packages/core/src/schema.ts` is the single domain contract every app imports.

---

## 4. Phase and gate status

| Phase | Gate | State |
|---|---|---|
| 1 Reconnaissance | architecture + infra feasibility reviewed | **PASS** — research briefs in `docs/research/`; runtime contract proven by live runs |
| 2 Foundation | stack starts, smoke tests pass, redeployable | **PASS (VM)** — schema, API, worker, adapter compile and run on `operant-core` |
| 3 Core integrations | Discord→DSH→verifiable result; both DSH instances use VoiceStudio | **PARTIAL** — API→worker→DSH→result proven; VoiceStudio deploying; Discord deferred |
| 4 Hallmark UI | every core workflow works desktop + mobile | NOT STARTED |
| 5 Learning/recovery | repeat failures detected, investigated, fixed with tests | NOT STARTED |
| 6 Independent verification | all critical/high defects resolved | NOT STARTED |
| 7 Deployment/handoff | release deployed, restarts recovered, report written | PARTIAL — running on VM via nohup, not yet systemd/compose |

### Verified end-to-end on the VM (2026-11-15)

`POST /v1/requests` → `queued` → worker claim → `dsh --profile operant` →
`status=succeeded` in 10 s → result text `OPERANT-SLICE-OK`, with
`dsh_session_id=session-77e85d8b…` persisted and 16 events written.

| Property | Evidence |
|---|---|
| Auth fails closed | no token → HTTP 401; wrong token → HTTP 401 |
| Survives a worker restart | worker killed → task stayed `queued` → worker restarted → `succeeded`, result `RESTART-SURVIVED` |
| Memory captured | `GET /v1/memory/search?q=OPERANT` returned the episodic entry, `matchedBy=lexical`, score 0.696 |
| Audit trail | `audit_log`: `task.created` per request |
| Durable counts | tasks=2 jobs=2 events=16 memories=2 usage=2 |

---

## 5. Verified evidence log

| When | What | Proof |
|---|---|---|
| 2026-11-15 | GCP pricing measured, not assumed | Cloud Billing Catalog SKUs for `asia-south1`: E2 core `$0.027509/hr`, E2 RAM `$0.003511/GB-hr`, pd-balanced `$0.12/GB-mo`, spot E2 core `$0.01572` |
| 2026-11-15 | DSH headless JSON contract | live run emitted `session`/`status`/`text`/`final` |
| 2026-11-15 | `operant` profile executes a real task | `{"type":"text","text":"OPERANT-EXEC-OK"}` then `turn_end reason completed`, exit 0 |
| 2026-11-15 | VM provisioned | `operant-core` RUNNING `e2-standard-8` asia-south1-c, `10.42.0.2` / `34.100.138.115` |
| 2026-11-15 | Network default-deny | VPC `operant-vpc` (custom, no auto subnets), firewall allows tcp:22 from `35.235.240.0/20` only |

---

## 6. Known constraints and honest limitations

1. **No GPU** — synthesis quality/advanced cloning on CPU may be too slow; those
   stay behind a selectable model profile and are reported as limited, not hidden.
2. **Docker Desktop here is capped at ~4 GB** (`~/.wslconfig memory=4GB`), far
   below the 32 GiB VM. Local Docker verification of large Whisper models is not
   representative; the VM is the reference environment.
3. **Discord token absent** — no real gateway test yet. Deferred by operator.
4. **`DEEPSEEK_API_KEY` absent** — DeepSeek-native search is unavailable until a
   key exists; a keyless DuckDuckGo provider is being added to remove that
   dependency rather than paper over it.
5. **Budget API rejected the create call** (`INVALID_ARGUMENT`); the enforceable
   control is the VM watchdog. Budget alerts must be finished or created in-console.

---

## 7. Write-scope discipline (concurrent agents)

| Owner | Scope |
|---|---|
| Lead | `packages/core`, `infra/**`, `.dsh/profiles/operant`, integration decisions |
| Search provider agent | `packages/web-search-ddg`, `.dsh/profiles/operant-ddg` |
| (future) API agent | `apps/api`, `packages/db` |
| (future) Dashboard agent | `apps/web`, `packages/ui`, `design/**` |
| (future) Voice agent | `services/voicestudio`, `docs/research/voicestudio.md` |

No two owners write the same path. The Lead reviews every diff and runs the
integrated build/test before any phase is called complete.
---

## 8. Repo location and portability (decision 2026-11-15)

**Canonical repository: `E:\CodeProjects\operant`.** Moved off `D:` after that
volume reached 0 bytes free and truncated a source file (recovered from a copy
and from git; no loss). Operator decision, with the stated intent of cloning it
onto an SSD on a future physical machine — so portability is a requirement, not
a nicety.

Portability contract now enforced:

| Requirement | How |
|---|---|
| Clone and run with Docker only | `docker-compose.yml` + `Dockerfile`; no host DSH needed, the agent runtime is baked in at a pinned `0.2.2-rc.1` |
| No host absolute paths | everything relative except `DSH_CREDENTIALS_FILE`, which is inherently host-specific and comes from `.env` |
| No secrets in git | `.env` and `secrets/` gitignored, verified with `git check-ignore`; only `SURPLUS_API_KEY` + `OPERANT_BOT_TOKEN` are manual |
| Reproducible agent config | `services/dsh/profiles/operant/` is the versioned DSH profile (route, search provider, MCP client) |
| Loopback-only exposure | API `127.0.0.1:8787`, speech `127.0.0.1:3900`; no public listener by design |
| Documented migration | `docs/runbooks/portable-deploy.md` §6 (three Docker volumes) |

## 9. Dual DSH ↔ VoiceStudio MCP acceptance matrix (2026-11-15)

| Test | Result | Evidence |
|---|---|---|
| Cloud DSH discovers VoiceStudio tools | **PASS** | 9 tools listed, e.g. `mcp__voicestudio__transcribe` with params `audio_base64`, `audio_path`, `language` |
| Cloud DSH transcribes a sample | **PASS** | exact text of the bench clip, `engine=faster-whisper`, 7.0 s audio |
| Cloud DSH invokes synthesis | **BLOCKED** | `HTTP 403 Licence not accepted for k2-fsa/OmniVoice, eustlb/higgs-audio-v2-tokenizer`. Accepting a licence is an operator-only legal action. CPU synthesis *does* work via the OpenAI-compatible endpoint using the non-gated `kittentts` engine (200, valid 312 KB WAV). |
| Local DSH discovers the same tools | **PASS** | same 9 tools from the laptop |
| Local DSH transcribes a different sample | **PASS** | new TTS-generated clip → "Yellow lanterns drift above the harbor while the tide turns slowly.", 3.4 s |
| Local DSH accesses voice profiles | **PASS** | `list_voices` → 1 profile (`demo0001`, demo) |
| Concurrent use without corrupting sessions | **PASS** | separate sessions on each host, both completed |
| Unauthorized external access denied | **PASS** | `Host: evil.example` → `403`; only `127.0.0.1:3900` and `127.0.0.1:8787` listen |
| Service restart does not break clients | **PASS** | container recreated mid-session; cloud client kept transcribing afterwards |
| Unavailable service does not crash local DSH | **PASS** (dead-port overlay) | turn still completed; tools reported as `server is disconnected` |
| VoiceStudio independently accessible | **PASS** | direct curl: `/health`, `/v1/audio/transcriptions`, `/v1/audio/voices`, `/v1/models` |

Transport note: the laptop reaches the cloud service over **SSH port-forwarding
multiplexed through Google IAP** — authenticated and encrypted, no inbound port
opened, because the service binds loopback only and IAP's direct TCP forwarding
cannot reach a loopback listener. Tailscale is the intended steady state once an
account auth key is available.

## 10. Current honest gaps

1. **Discord bot not built yet** (operator deferred it to the end): no real
   gateway test, no voice-message ingestion.
2. **Dashboard not built**: Hallmark design system and all screens outstanding.
3. **Synthesis over MCP blocked** by the licence gate above.
4. **Learning loop not built**: incidents/improvements tables exist, no worker.
5. **Services run under `nohup` on the VM**, not systemd/compose yet — the
   compose stack is validated locally but not yet running on the VM.
6. **`D:\CodeProjects\operant`** remains as an empty, locked directory.

---

## 11. Round 3 — learning loop, test suite, Discord bot, appliance profile

### Verified on the VM (real runs, not claims)

| Thing | Evidence |
|---|---|
| Unit tests | **43 tests pass**: core 9, learning 24 (incl. the new classification rule), dsh-adapter 11 |
| Repeat-failure detection | two identical faults → **1 incident, occurrences=2** (fingerprint dedup works) |
| Correct classification | after adding a rule for real DSH stderr, the same repeat classifies `config_drift` / "DSH profile missing or not composed" (was `unknown`) |
| Guardrail holds | a repeat produced a **proposal**, not a silent config change: `{"examined":1,"knowledgeWritten":0,"proposalsCreated":1}` |
| Conversation continuity | `conversationId=discord:99887766` → tasks row joined to `conversations`, and `GET /v1/tasks?conversationId=` returns it (db row count 1) |
| Voice API proxy | `GET /v1/voice/health` → healthy; `POST /v1/voice/transcribe` accepts `audioBase64` and forwards; garbage bytes → upstream 422 `invalid_media_file` (correct passthrough, not a 500) |
| Learning/voice routes live | `/v1/learning/summary` returns real zeros after restart |
| Discord bot | 7 test files / **74 tests pass**; `--check` proves config + API reachability and exits 1 naming the missing token; its SSE reader parsed a live job stream (9 frames, `job_done succeeded`) |

Test-count note: the earlier claim of "11 tests" for the adapter plus 9 + 24 = 44; the distinct total measured across the three suites is **44** (9 + 24 + 11).

### Duplication removed (anti-entropy)

There were **two** DSH event mappers: `mapDshEvent` in `packages/core` (regex-based,
unused in production) and `normalize` in `packages/dsh-adapter` (verified against
real runner output). Two mappers means two behaviours and only one gets tested.
`mapDshEvent` and its dead `toIso` helper were deleted; the adapter is the single
owner and now carries the tests.

### Discord bot: what exists, what cannot be proven

Built in `apps/bot`: natural-language routing, conversation continuity keyed on
`discord:<channel id>`, reply-before-dispatch so a long job never blocks the
gateway, coalesced message edits (≥1.5 s apart, honouring `retry-after`), voice
attachment → transcription → treated as the request, approval cards with clicker
authorization, fail-closed allow-lists, and clean exit when the token is absent.

**Not proven, and not claimed:** gateway login, real message/interaction events,
real Discord rate limits, CDN downloads, whether `MESSAGE_CONTENT` is enabled on
the operator's app. All require an operator-supplied bot token.

### Appliance target (operator's next machine)

i7-10700KF (8C/16T) · 32 GB DDR4 · 512 GB SSD · RX 580. Added
`docker-compose.appliance.yml` (validated with `docker compose config`, merged
values confirmed) and `infra/appliance/{README.md,preflight.sh}`.

Key hardware judgement: **the RX 580 is deliberately unused.** ROCm dropped
Polaris (`gfx803`), VoiceStudio ships only CUDA/CPU `amd64` images, and a
hand-built Vulkan whisper.cpp would be slower than this CPU while destroying
reproducibility. The CPU path already measured 0.258 RTF at 0 % WER.

Tuning: `WORKER_CONCURRENCY=3` (agent runs are model-API bound), speech capped at
16 GB, `OMP_NUM_THREADS=4` to stop BLAS oversubscription, Postgres left to the
page cache, and **log rotation on every service** so a chatty container can never
repeat the 0-bytes-free incident.

### Operational rule adopted

No single command may block for more than 2 minutes; anything longer runs as a
background job while other work proceeds.

---

## 12. Round 4 — Hallmark dashboard, and the bug it exposed

### Dashboard (Hallmark-governed, verified)

Direction: Hallmark **app-screen** run, dealt theme **Wayfind** (modern-minimal,
platform colourway). Rationale recorded in the app: a control plane is a
departures board — cool grey paper, blue-black ink, Chivo Mono so IDs/seqs/token
counts are tabular, 2px rules instead of cards, cobalt for live, amber for figures
on ink. The alternative deals were rejected because they would have dressed an
operator console as a brand page.

Routes: `/` mission control, `/tasks/[id]`, `/memory`, `/approvals`, `/fleet`.

Verification I performed myself (not taken from the implementing agent):

| Check | Result |
|---|---|
| Proxy route exists and is the only browser surface | `apps/web/app/api/v1/[...path]/route.ts`, 105 lines, regex whitelists for GETABLE/POSTABLE paths, token read server-side |
| Token leakage | **0** hits for the token in `.next/static/**`; `OPERANT_BOT_TOKEN` present in server chunks (4 refs) |
| Screenshots | 11 PNGs in `design/screenshots/` (control 1440/768/390, task 1440/390, memory 1440/390, approvals 1440, fleet 1440, control-streaming) |
| Build + wiring | production build, 8 routes; a task created **through the proxy** reached `succeeded` |

Hallmark's own gates: `sloplint` static went `2 FAIL → 0 FAIL, 0 REFLEX, 0 WARN
across 19 files`; render went `1 FAIL, 6 REFLEX → 0 FAIL, 0 WARN, 14 WAIVED`.
Real defects it caught and fixed: an eyebrow order violation, a tape text colour
at **3.20:1** (fixed with a new `--color-error-on-ink` token at 8.01:1), and an
internal scroll container causing crowding.

### Bug the dashboard exposed in MY code (fixed)

The agent reported "task status lags its job: stays `queued` while the job runs".
Real defect: `claimNextJob` updated the job but nothing moved the task, and the
worker only learned the session id *after* the child process spawned. Fixed by
making the claim and the task transition **one statement** (CTE). Verified live:

```
t+1s task=queued  t+2s..t+6s task=running  t+7s task=succeeded  result=STATUS-TEST
```

### Honest gaps in the dashboard

1. **Approvals screen has never had a row** — no API route creates an approval
   yet, so the queue is always empty. The decide path is wired and proven real
   (409 on a non-pending id, 400 on an invalid decision), but nobody has ever
   approved anything through it. This is the largest remaining functional hole.
2. Agents/usage/health are read-only because the API offers no mutation there;
   each screen says so rather than showing a dead control.
3. The web app keeps **its own wire types** instead of importing
   `@operant/core`. That duplicate vocabulary is the one drift risk in the repo.
4. `packages/ui` was left untouched deliberately: one consumer makes a shared
   component package a false abstraction at this size.

### Token consistency

The repo `.env` had a stale `OPERANT_BOT_TOKEN`, so the proxy 401'd against the
VM. Local `.env` now matches the VM's dev token. In production this must be a
freshly generated secret, set identically in `.env` on both sides.

---

## 13. Round 5 — the approval gate is now a real mechanism

### Why this mattered
The dashboard's `/approvals` screen could only ever be empty: nothing created an
approval. An approval queue nobody can populate is not a control, it is
decoration. This round made the gate real.

### Design
`packages/core/src/policy.ts` classifies an intent **before dispatch** and returns
`{required, risk, kind, reasons, summary}`. Consequential classes: destructive
operations, spend, account/credential changes, production config, external
messages, and writes outside the workspace.

The critical detail: when a request is gated, **no job row is created at all**.
A job merely marked "queued" would be claimable by a worker and the gate would be
decorative. The job is created inside the same transaction that approves the
request (`decideApproval`), so an approval can never be `approved` without the
job existing, and a job can never appear without an approval.

### Verified end to end on the live stack

| Step | Evidence |
|---|---|
| Gated request is held | `202` with `"jobId":null`, `"status":"waiting_approval"`, `"approvalRequired":true`, `risk:"medium"`, `reasons:["message sent outside this platform"]` |
| No job exists while held | `select count(*) from jobs where task_id=…` → **0** |
| Approval is visible | `GET /v1/approvals` returns that approval id |
| Approve enqueues and runs | `{"decided":true,"jobId":"811a3770…","status":"queued"}` → task `running`, jobs = 1 |
| Reject cancels, creates nothing | task status `cancelled`, jobs = **0** |
| No double decision | second decide → `409 not_pending_or_missing · already approved` |

Policy unit tests: **21 cases**, all passing — including 10 gated intents and 8
ordinary ones that must NOT be gated. Three real rule bugs were found and fixed
by those tests:
1. rule **precedence**: "grant access to the billing dashboard" matched *spend*
   instead of *access change*, because the spend rule came first at equal risk.
   Account-change now precedes spend.
2. "rotate the **API** key" did not match `rotate the key` — the pattern now
   allows up to two qualifier words.
3. `\b(...\/etc\/)` can never match after a space, because `/` is a non-word
   character. Removed the leading boundary.

### Deployment hardening
The VM no longer runs `nohup` stopgaps. `infra/systemd/` provides
`operant-api.service` and `operant-worker.service`, both **active and enabled**
(survive reboot), with `ProtectSystem=strict`, `NoNewPrivileges`, a bounded
restart rate-limit, and `TimeoutStopSec=90` so the worker drains instead of being
killed mid-turn. One self-inflicted config defect was caught from the journal:
`StartLimitIntervalSec` belongs in `[Unit]`, not `[Service]`.

**Lease TTL lowered 900 s → 180 s** (renewed every 45 s). A crashed or rebooted
worker's job is now reclaimable in ~3 minutes instead of stalling for 15.

### Note on the units' user
The units run as `iamdarshg`, not a dedicated `operant` account, because the agent
runtime reads `~/.dsh` (profile + credentials) which that account owns. Migrating
that home to a service user is the correct next step and is not done yet.

---

## 14. Round 5b — independent reviews, a critical finding, and reboot-recovery defects

### CRITICAL, found by the security reviewer and FIXED

The live bearer token was **hardcoded in `apps/bot/src/config.ts`** and therefore in
git (introduced in `1feda7c`). A token in source is a token in every clone, fork
and backup.

Fixed in two steps:
1. The dev fallback is now a **non-functional placeholder**
   (`dev-token-placeholder-not-a-real-credential`); a real API answers 401 to it,
   which is the correct fail-closed behaviour and forces the operator to supply
   `OPERANT_BOT_TOKEN`.
2. The live token was **rotated** (64 hex chars) on the VM and the laptop.
   Verified: the old token now returns **401**, the new one authenticates.

**Still outstanding: the old token remains in git history.** Purging history is a
rewrite that needs an explicit decision; until then the only real mitigation is
that it is already rotated and dead.

### HIGH findings I have NOT fixed (stated plainly)

| # | Finding | Why it matters | Status |
|---|---|---|---|
| H1 | **Approval gate bypassed 11/11 by paraphrase** (`rm -r -f`, `Remove-Item -Recurse -Force`, `delete every file under…`, `drop the users table`, `email the client…`) | The gate inspects *prose*, so any rewording walks past it. The reviewer's conclusion is right: a prose denylist is decorative. Real fix is gating at the **tool-call boundary** — inspect what the agent is about to do, not what the human typed. | OPEN — needs a design change, not a patch |
| H2 | Agent child inherits `OPERANT_BOT_TOKEN` and `DATABASE_URL` (`safeEnv()` spreads `process.env`) | One prompt injection escalates from "agent misbehaves" to "attacker owns the control plane" | OPEN |
| H3 | VoiceStudio `/mcp` is unauthenticated (9 tools incl. `clone_voice`) | SSRF → impersonation. Mitigated today only by loopback-only binding + IAP | OPEN |
| H4 | No rate limiting / lockout on auth | 120 wrong-token requests → 120×401, zero 429 | OPEN |
| M1 | `fastify@5.2.1` (GHSA-p68q-wchp-6fh7, fix ≥5.12.2) and `next@15.1.3` (GHSA-2464-fhr4-w9xw, fix ≥15.5.28) | Known advisories on the auth path and unauth RCE | OPEN — bump needs a verified rebuild |
| M2 | CORS `origin: true` | Any origin may call the API from a browser | OPEN |

What held up (verified): no `/v1` route reachable without a token (401 for absent,
wrong, empty, truncated and query-string tokens); constant-time XOR compare; token
absent from `.next/static`; `.env` and `secrets/` gitignored; `audio_path`
confinement really enforced (`/etc/passwd` and traversal both refused); MCP foreign
`Host` → 403; malformed JSON-RPC → 400; prompt delivered on **stdin, never argv**;
SQL uses tagged templates only; the gate does create **0 job rows** while holding.

### Reboot-recovery defects — three, all mine, all fixed

The reboot test was not ceremonial; it broke three things at once:

1. **`operant-pg` had no restart policy** (`docker run` without `--restart`), so the
   database did not come back after boot. Fixed: `restart=unless-stopped` (verified
   from `docker inspect`).
2. **The worker crashed instead of retrying** when the DB was briefly unavailable,
   and systemd's start-rate limit then marked the unit *permanently failed*. Fixed
   with in-process exponential backoff (1 s → 30 s) and a wider start-limit window.
3. **My own sandbox blocked DSH session writes.** `ProtectHome=read-only` meant the
   agent could not write `~/.dsh/sessions`, so runs failed in ~2 s. Fixed by adding
   `/home/iamdarshg/.dsh` to `ReadWritePaths` — the lesson is that hardening the
   *worker* also hardens the *child agent runtime*, which has its own write needs.

After the fixes: `api=active worker=active`, and a real job returns
`result: "SYSTEMD-OK"` under systemd.

### QA finding #1 resolved

Plain `next start` rendered every panel as an error because Next does not load the
repo-root `.env` and `next start` forces `NODE_ENV=production`, disabling the dev
fallback. Correct invocation (now the documented one):

```
cd apps/web && node --env-file=..\..\.env node_modules\next\dist\bin\next start -p 3100
```

Verified myself on a free port: page renders control-plane content (59 KB, no token
error), proxy returns **3 tasks / 2 pending approvals**, and the full
**approve → job** leg works through the browser proxy:
`waiting_approval (jobId empty)` → approve → `job c3535e29… queued` → task `running`.

Process note: my first attempt probed port 3101, which was the *QA reviewer's* own
server, and reported a false "still broken". Checking which process owns a port
before trusting its output matters.

---

## 15. Round 6 — three dead controls, found by independent QA, all fixed

The QA reviewer walked the rendered app and found three controls that looked
functional and were not. That is exactly the failure mode the mission forbids, so
each is fixed and re-verified through the browser proxy (not curl directly).

### 1. "Cancel task" was dead
The Next proxy attached `content-type: application/json` to every POST, including
body-less ones. Fastify rejects that with `FST_ERR_CTP_EMPTY_JSON_BODY` (400), so
the UI showed "Bad Request" while the job kept running.

Two fixes, because either alone leaves the trap:
- the proxy now sets the content-type **only when a body exists**;
- the API registers a JSON parser that treats an **empty body as `{}`** rather than
  a malformed request ("no arguments" is not "bad request").

Verified through the proxy: `POST /api/v1/tasks/:id/cancel` → `200 {"cancelled":1}`.

### 2. Approve and Reject lied
`decideApproval` was rewritten last round to return
`{decided, decision, taskId, jobId, status}`, but the client still required the old
`body.approval`. A successful decision therefore rendered "the control plane
answered 200", the row stayed pending, and the counter never moved.

`ApprovalActions` now treats `decided:true` as the contract, reports what really
happened (including the created job id and a link to the task), and calls
`router.refresh()` so the server-rendered queue cannot go stale.

Verified through the proxy: gated request (`jobId` empty) → approve →
`decided:true, jobId 5f5500a0…, status queued` → task `running` with 1 job.

### 3. "Ask for a second job to verify the result" was decorative
`require_verification` was stored and read by nothing: no verifier job, and
`verified_by_job_ids` stayed null, while the task detail screen printed
"Verified by: no verification job".

The worker now enqueues a real `review` job (agent `review`, `read-only`,
`parent_job_id` = the execute job) with a prompt that demands evidence rather than
agreement, appends it to the execute job's `verified_by_job_ids`, and moves the
task to `reviewing` so it is not reported as finished while its reviewer runs.

Verified: `jobs → execute:succeeded, review:running`; `verified_by_job_ids` length 1;
task status `reviewing`.

### Known-open UI defects (from the same review, not yet fixed)

| Sev | Defect |
|---|---|
| HIGH | The control-screen tape attaches to the newest non-terminal **task**, and a held approval has no job — so it shows "No job exists yet" while jobs are streaming |
| MED | No link from an approval row to its task/job (partly addressed: the decided state now links) |
| MED | Absolute times rendered UTC with no zone label on an IST browser |
| MED | Board error paragraph on the ink band is 2.85:1 and leaks `TypeError: fetch failed` |
| MED | `/approvals` has no auto-refresh |
| LOW | At 768 px the State/Took columns nearly touch; sub-24 px tap targets; running row shows 0 tokens while the tape shows 1572 |

Verified working by the reviewer and not regressed: dispatch (202 + row + feedback,
mouse and keyboard), memory search/zero-state/write, the tape really streams
(seq 84→128 in 24 s over SSE), cancel absent on terminal tasks, 38 tab stops all
ringed, skip link, landmarks, `role="log"`, no horizontal overflow at
1440/768/390, proxy whitelist 404s unproxied paths.

---

## 16. Round 7 — security hardening that actually closes findings

### H2 (agent inherits control-plane credentials) — FIXED

`safeEnv()` was `{...process.env}`, so every agent child received
`OPERANT_BOT_TOKEN` and `DATABASE_URL`. A prompt injection therefore escalated
from "the agent misbehaves" to "the agent holds the control-plane bearer and the
database password".

It is now an **allow-list** (OS essentials, `NODE_ENV`, DSH home hints, and only
the model-provider keys the agent legitimately needs) plus an explicit
**deny-list applied last** as a guard against a future allow-list mistake.
Verified by three new tests (14/14 in the adapter suite): the bearer, database
URL, session secret, Discord token and cloud credentials are all withheld, while
`PATH`, `HOME` and the provider key still pass through.

### H4 (no auth rate limiting) — FIXED

An independent probe sent 120 wrong-token requests and got 120×401, zero 429.

Now: 20 failures per IP inside a 5-minute window, then `429` with `retry-after`.
Crucially the credential is checked **first** — throttling before authentication
would let an attacker lock the operator out of their own control plane, which is
a worse failure than the brute force it prevents.

Verified: 20×`401` then `429` (`retry-after: 300`), and a **valid token still
returns 200 while that IP is throttled**.

### HIGH (tape showed a jobless task) — FIXED

The control screen picked "newest non-terminal task". A task **held for approval**
is non-terminal and has no job at all, so the tape printed "No job exists yet"
while other jobs were streaming.

It now walks the newest tasks until it finds one that actually has a job, and
tracks which task it settled on so the caption link cannot point somewhere else.
Verified with a held approval deliberately created as the newest task: the page
contains no "No job exists yet", the tape caption names a real job, and the tape
shows a workspace path.

### Added: `docs/OPERATIONS.md`

The three things an operator needs and should not have to reverse-engineer:
the **secrets checklist** (exactly five manual items, and what breaks without
each), **recovery and rollback** (stuck jobs and leases, approval rollback,
volume backup/restore, bad-release rollback, cloud cost emergency), and **how to
add a new agent or tool** (agents are rows, not code; tools are an MCP row or a
native plugin, with the verification step spelled out).

It also carries a blunt "known gaps you should not discover the hard way" section
so the next person does not mistake the documentation for a claim of completeness.

### Still open (unchanged, and architectural rather than cosmetic)

1. **The approval gate inspects prose, not actions** — bypassed 11/11 by
   paraphrase. Tool-call-boundary gating is the real fix.
2. `allowed_tools` is documentation, not enforcement: no tool-level authorization.
3. VoiceStudio `/mcp` remains unauthenticated (upstream design), mitigated only by
   loopback binding + IAP.
4. `/approvals` has no auto-refresh; UTC timestamps carry no zone label.
5. `fastify` / `next` advisories unpinned.
6. The web app keeps duplicate wire types instead of importing `@operant/core`.

---

## 17. Round 8 — enforcement moved to the tool-call boundary

The security review's sharpest finding was that the approval gate inspected the
**request's prose**, so paraphrasing walked past it 11/11. The gate now also
watches what the agent is about to *execute*, which no wording can disguise.

### How it works

1. `assessToolCall(tool, args)` in `packages/core/src/policy.ts` inspects every
   tool call. It blocks: recursive/forced deletes (`rm -rf`, `Remove-Item
   -Recurse`, `del /s`), filesystem/partition operations, `dd if=`, power control,
   `DROP`/`TRUNCATE`, unqualified `DELETE FROM`, `chmod 777`, piping remote content
   into a shell (`curl | bash`, `iwr | iex`), fork bombs, writes into `/etc`, and
   anything touching `authorized_keys`/`.ssh`/`sudoers`.
2. The adapter gained a `guardToolCall` hook. On a block it **kills the child
   immediately** and records the exact call, so the action never completes.
3. The worker escalates: job → `interrupted`, task → `waiting_approval`, and an
   approval is created by `tool-boundary-guard` carrying the exact command.
4. Approving it creates a **new job** whose `approved_commands` holds that one
   command string. The guard permits only an **exact match**, so approval cannot be
   widened into "run anything containing this".

### Verified live, end to end

Request: *"create settings.ini … then fix its permissions by running chmod 777"* —
wording that deliberately passes the prose gate.

| Step | Observed |
|---|---|
| Prose gate | passed (job enqueued) |
| Agent's tool calls | `write` (allowed), then `bash` with `chmod 777 config.ini` |
| Guard | **blocked**, child killed, job `interrupted`, error `blocked at the tool boundary: make world-writable (bash)` |
| Approval | created by `tool-boundary-guard`, risk `high`, payload carries the exact command |
| Approve | new job created, `approved_commands` = that exact command |
| Re-run | job **`succeeded`** — permitted, and `config.ini` really became `mode=777` |
| Task | `succeeded` |

### One more bug the loop exposed

The task reported `failed` even after the approved retry succeeded, because the
policy-blocked attempt counted as a failure in the roll-up. A blocked attempt is a
**pending human decision, not a task failure**, so `finalizeJob` now excludes
`error LIKE 'blocked at the tool boundary%'` from the failure count.

### What this does and does not fix

It closes the *"rewording defeats the gate"* class for actions the agent performs
through tools: enforcement no longer depends on the prompt. It does **not**
retroactively stop a command that already executed before the guard saw it, and
`allowed_tools` per agent is still documentation rather than enforcement.

Also observed while testing, worth recording: the agent runs in a sandboxed
namespace where the host's `/tmp` is invisible, so an instruction to delete a host
path caused it to report "the target does not exist" rather than deleting
something. Defence in depth from the sandbox, not from my policy.

---

## 18. Round 9 — dependency advisories, and a scheduler that can actually fire

### Advisories addressed
`fastify` 5.2.1 → **5.12.2** (GHSA-p68q-wchp-6fh7, auth-path bypass) and `next`
15.1.3 → **15.5.28** (GHSA-2464-fhr4-w9xw, unauth RCE). Fastify verified after the
bump: health `healthy`, and the empty-body cancel path still answers
`200 {"cancelled":1}` (the behaviour from the own-parser registration).

### The `schedules` table was documented but dead
Migration 0001 created `schedules`; nothing ever read it. A capability listed in
the deliverables that did not exist is worse than one that is absent.

Now implemented:
- `packages/core/src/schedule.ts` — a **documented RFC 5545 subset** (FREQ =
  HOURLY/DAILY/WEEKLY, INTERVAL, BYHOUR, BYMINUTE, BYDAY) with timezone-correct
  arithmetic. Unsupported rules **throw** rather than silently mis-scheduling.
- `GET/POST/DELETE /v1/schedules`, validating the rule at creation time.
- A worker tick (boot + every 60 s) that claims a due occurrence and enqueues a
  real task with `origin='schedule'`.

### Verified end to end

| Check | Result |
|---|---|
| Rule → next run | `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` / Asia/Calcutta → `2026-11-16T03:30:00Z` (= 09:00 IST) |
| Unsupported rule | `400 invalid_rrule … FREQ=SECONDLY is not supported` (rejected, not scheduled) |
| Firing | task created with `origin='schedule'`, status `running`, prompt headed `SCHEDULED TASK (daily at 9:00)` |
| Advancement | `last_run_at` set, `next_run_at` moved to the future |
| Worker log | `schedule fired {"scheduleId":…,"taskId":…,"nextRunAt":"2026-11-16T03:30:00.000Z"}` |

### Bug found by testing it (and why it matters)
The first implementation never fired. The claim was guarded with
`WHERE next_run_at = $firedAt`, comparing the row's **microsecond** timestamp to a
**millisecond** JS `Date` read back from it. They are never equal, so the UPDATE
matched zero rows and the tick skipped every schedule **silently** — the row was
due, the worker was alive, no error anywhere.

Fixed by claiming with `WHERE … next_run_at <= now()`. Postgres row locks make that
single UPDATE atomic, so the loser's predicate no longer matches once the winner
has advanced the column. Lesson: never use timestamp equality as a compare-and-swap
across a language boundary with different precision.

Tests: `packages/core/src/schedule.test.ts` — parse/reject cases, the +05:30 offset,
"next occurrence is never the current instant", INTERVAL, WEEKDAY selection, and
determinism. Core suite now **55 tests**.

### Still open
Schedules are API-only (no dashboard or Discord surface yet); `allowed_tools` is
still documentation; VoiceStudio `/mcp` is still unauthenticated; `/approvals`
still has no auto-refresh and timestamps still carry no zone label.

---

## 19. Round 10 — the dashboard stops lying about time and staleness

Two defects the independent QA reviewer reported, both now fixed and confirmed
against the rendered pages (not just the source).

### Timestamps said UTC without saying so
`stamp()` rendered `2026-11-16 19:09:18` with no zone. On an IST browser that reads
as 19:09 **local**, which is 19:09 UTC — off by 5h30. The page is server-rendered
and cannot know the viewer's zone, so it now states the zone it uses:
`2026-11-16 19:59:59 UTC`.

Verified: 8 zone-labelled timestamps on the board, and the same treatment on
`/approvals`.

### `/approvals` never refreshed
A held approval is time-sensitive; a queue that only updates on manual reload
invites acting on a stale screen. The page now mounts `AutoRefresh` (5 s, paused
while the tab is hidden, no animation), active only while something is pending.

Verified: `visibilityState` is present in the shipped `app/approvals/page-*.js`
chunk — the refresher is genuinely bundled, not just referenced.

### Housekeeping
Nine approvals created by my own acceptance tests (`guard-test*`, `qa-selfcheck`,
`tape-test`, `security-review`, …) were sitting in the operator's real queue. They
were rejected with an explicit note rather than deleted, so the audit trail still
shows who created them and why they were closed. One genuine pending approval
remains.

Also verified in the same pass: the dashboard builds and runs on **next 15.5.28**
(the advisory fix), and the proxy still serves live data through it.

---

## 20. Round 11 — artifacts became real, and the deliverable index exists

### `artifacts` was a third dead table
Migration 0001 created `artifacts` with a zod schema and a `job.artifact` event
type, and **nothing ever wrote a row** — the same shape of gap the scheduler had.
Now the worker collects what a job produced (workspace-confined, depth ≤ 6,
25 MB/file cap, 50 files, skipping `node_modules`/`.git`/`dist`), records
filename/mime/bytes/**sha256**, and the API serves it with `x-content-sha256` and
path confinement against the workspace root.

Verified: agent wrote `report.md` → 1 artifact row → download returned 28 bytes
`hello from the artifact test` → served hash `bb5fd045…58ee` **equals** the hash of
the bytes on disk.

### `docs/reports/deployment-report.md`
A single honest index: each requested deliverable, its status, and the command
output or screenshot that proves it — including a nine-item "what is NOT done"
section so the report cannot be mistaken for a victory lap. Three listed gaps are
operator decisions rather than engineering debt (Discord token, VoiceStudio
licence, git-history rewrite).

### Test totals verified this round
`pnpm -r run test`: core **55**, dsh-adapter **14**, learning **24** = **93**
passing. The bot (74) and web suites were last green earlier and were not re-run in
this pass; the deployment report says so rather than implying otherwise.

---

## 21. Round 12 — `allowed_tools` now actually authorizes

The security review's point was precise: per-agent `allowed_tools` existed, was
readable, and gated **nothing**. It granted exactly the same permissions as no list
at all.

Enforcement now sits in the same tool-call guard as the destructive-command policy:

- Only **privileged** tools are gated (bash, pwsh, shell, write, edit, multiedit,
  apply_patch). Gating read/glob/grep/web_*/job_* would break agents for no safety
  gain — a permission list that blocks reading is theatre.
- An empty list means **unspecified**, not "nothing allowed". Failing closed there
  would silently break every agent that predates the column.
- A permission violation finalises as a **failed job with no approval created**.
  Offering "approve" would let the approval path grant what the agent's
  configuration explicitly withholds — the opposite of the intended direction.

Verified:

| Agent | Declared tools | Request | Result |
|---|---|---|---|
| research | read, glob, grep, web_search, web_fetch | "write a file…" | failed — `tool-not-permitted: agent 'research' may not use bash`, **0 approvals** |
| engineering | read, write, edit, glob, grep, pwsh, bash | "write a file…" | **succeeded** (no regression) |

### Two self-inflicted failures worth recording
1. My comment contained `web_*/job_*` — the `*/` **closed the block comment early**
   and the worker died on `SyntaxError: Unexpected token ';'`. TypeScript caught it;
   the deployed systemd unit then entered a start-limit failure loop.
2. I then read the journal and concluded the build was still broken — but the
   `SyntaxError` timestamps **predated the fix**. The real cause of the second
   failure was systemd's rate limit ("Start request repeated too quickly"). The
   remedy was `systemctl reset-failed`, not another code change. Read timestamps
   before trusting an error message.

---

## 22. Round 13 — artifacts reachable from the browser, and a restore was actually tested

### Artifacts had no browser surface
The previous round began recording artifacts, but the proxy whitelist did not
include them, so the platform stored deliverables the dashboard could never show.

- Proxy now permits `tasks/:id/artifacts` and `artifacts/:id/download`, plus
  `GET`/`POST`/`DELETE /v1/schedules`.
- **Binary passthrough fixed.** The proxy decoded every response as text, which
  silently corrupts any file that is not valid UTF-8 — a download would "succeed"
  and hand back a broken file. Non-textual content types now stream through with
  their headers, including `x-content-sha256`.
- The task page renders a **"Files produced"** table (name, type, size, hash
  prefix, download link).

Verified through the proxy: list returned 1 artifact (`report.md`), the download
returned 28 bytes `hello from the artifact test`, and the local sha256
(`bb5fd045…58ee`) equalled the hash served by the API. Task page contains the
section, the link, and the filename.

### Backup restore is no longer an untested claim
`pg_dump -Fc` (258 KB) restored into a **scratch** database reproduced every count
exactly — tasks 50, jobs 48, events 2353, memories 43, agents 4, approvals 13,
artifacts 4 — and real content survived, not just row counts. Scratch database
dropped afterwards; production health verified healthy. Volume-level backup for the
speech service remains untested and the report says so.

---

## 23. Round 14 — recurring work becomes usable by a human

The scheduler worked but was API-only, so the platform advertised "scheduled and
recurring jobs" that no human could create. A capability reachable only with curl
is not a feature; it is a test fixture.

New `/schedules` screen (in the nav):

- lists each schedule with its **raw recurrence**, next run, last fired (or
  "never") and enabled state — the three facts needed to trust a cron replacement;
- a create form that posts the same validated payload as the API, using the
  **browser's own timezone** rather than a hardcoded one;
- inline documentation of the supported subset, so an unsupported rule is a
  visibly refused attempt instead of a silent no-op;
- per-row delete (the only way to stop a recurring job short of editing the DB).

The proxy gained `GET`/`POST`/`DELETE /v1/schedules`; the form reports the API's
own rejection (`invalid_rrule`) rather than claiming success.

Verified against the running service:

| Check | Result |
|---|---|
| Page lists the existing schedule | "Daily standup summary", `FREQ=DAILY`, zone-labelled time |
| Nav | `Schedules` present |
| Create through the proxy (the UI's path) | `Hourly memory sweep`, next run returned |
| Unsupported rule | **400** refused, not stored |
| Delete through the proxy | `deleted: true`, list back to 1 |

---

## 24. Round 15 — the unauthenticated speech endpoint now has a door

VoiceStudio ships `/mcp/` with **no authentication whatsoever** — the security
review confirmed `initialize`, `tools/list` and `tools/call` all succeeded with
zero credentials, including `clone_voice`. Loopback binding only helps until
something on the host is compromised or a forward is left open.

`services/mcp-guard/server.mjs` is a dependency-free Node proxy that requires
`Authorization: Bearer $OPERANT_MCP_TOKEN` and forwards method, path, headers,
query and body unchanged, streaming the response so Streamable-HTTP MCP (POST
JSON + GET SSE) behaves normally. It refuses to start below a 16-character token
— a proxy that starts without a token looks protected while protecting nothing —
compares with `timingSafeEqual`, strips the bearer before forwarding, and keeps
`requestTimeout` disabled so SSE sessions are not cut at five minutes.

Deployed as `operant-mcp-guard.service` (hardened: `ProtectSystem=strict`,
loopback-only AF_INET). Both DSH profiles (cloud and laptop) now point at
`:3901` with the header.

Verified:

| Check | Result |
|---|---|
| No token | **401** `{"error":"unauthorized"}` |
| Wrong token | **401** |
| Valid token, `initialize` | **200**, session id issued |
| `tools/list` through the guard | **200**, all **9** tools present |
| Real agent run | `mcp__voicestudio__check_health` → `{"status":"ok","device":"cpu","engine":"omnivoice","version":"0.5.8"}` |
| Local laptop guard | healthz ok, 401 without token, 200 with token |

Honest limit: anyone with local shell access can still curl `:3900` directly. The
guard closes the network surface, not the host surface — that remains the real
boundary, and the report says so rather than claiming the service is now secure.

### Recurring mistake worth naming
Twice this round I diagnosed a "broken" service whose error was from **before the
fix**: `systemctl start` after a failure loop reports
`Start request repeated too quickly`, and the journal then shows stale stack
traces. `systemctl reset-failed` was the fix both times. I also used an expanding
PowerShell here-string (`@"..."@`), which made `systemctl` run on the laptop
instead of the VM. Both are now habits: reset-failed after any failed unit, and
`@'...'@` for anything containing `$(`.

---

## 25. Round 16 — evidence screenshots, and a chase after a bug that was not there

Added `design/evidence/` with screenshots of the two screens built this session
(`schedules-1440.png`, `schedules-768.png`, `task-artifacts-1440.png`) so the
recurring-work and produced-files surfaces have the same evidence standard as the
reviewed screens.

### Two genuine defects the first screenshot exposed
1. **Invented table class.** I wrote `<table className="table">`; the app has no
   `.table` rule — its tables are `.data` and every cell carries `data-label` for
   the stacked mobile layout. Rendered as a squeezed row with columns glued
   together ("Daily standup summaryFREQ=DAILY…"). Fixed to match the real pattern.
2. **Invented form classes.** I wrote `compose`/`compose__field`; the app uses
   `write-form`/`field`/`write-form__actions`. Without those the inputs had no
   layout constraints. Fixed.

Both were found by looking at the rendered image, not by reading the JSX.

### Then I chased a phantom
The 390 px captures showed text and inputs clipped at the right edge, so I spent
two attempts "fixing" an overflow — first blaming a nested `.container`, then a
non-wrapping hint. Both were plausible and neither was the cause.

The decisive test: capture the **memory page** — which QA had already approved at
390 — with the same tool. It clips identically. Windows Chrome enforces a minimum
window width, so `--window-size=390` lays out wider than 390 and the screenshot
crops it. The tool was wrong, not the page.

Consequence: evidence is captured at 1440 and 768 (widths the tool honours), the
misleading 390 images were deleted, and **390 px remains verified only by the
earlier puppeteer-based QA pass**, not by this one. The two class fixes above are
still real and are kept; the "overflow fixes" were kept only where they were
independently correct (the hint now wraps, and the nested container is gone —
neither harms the layout).

Lesson worth the space: when a measurement disagrees with an approved baseline,
test the measurement against that baseline before changing the code.

---

## 26. Round 17 — a green test suite that was testing nothing

While substantiating the numbers this report cites, `pnpm --filter @operant/bot run
test` on the **deployed host** printed:

```
No test files found, exiting with code 0
```

A pass. The bot suite had never been run there, because `apps/bot/test/` was never
copied, and the script carried `--passWithNoTests`, which converts "no tests" into
"success". That flag is a lie detector turned off: any package whose tests go
missing reports green.

### What removing the mask exposed

1. **The bot suite passes locally** — 7 files, **74 tests**, all green. So the
   number this report quotes is real, on a laptop.
2. **It cannot run on the deployed host**, and the reason is not the tests: the
   import of `../src/config.js` fails because **`apps/bot/src` does not exist on
   the VM**. `apps/bot` is empty there, and there is no `operant-bot` service unit.
   The Discord bot has never been deployed to the cloud host — the deliverable is
   code and local tests, not a running component.

Fixed the mask (`"test": "vitest run"`), so a missing suite fails loudly from now
on. Not yet fixed, and now stated plainly in the report: the bot is undeployed.

### Verified totals, this round

| Suite | Result |
|---|---|
| `packages/core` | **55 passed** |
| `packages/dsh-adapter` | **14 passed** |
| `packages/learning` | **24 passed** |
| `apps/bot` (local) | **74 passed** (7 files) |
| `packages/db`, `packages/mcp-client`, `packages/ui`, `apps/web` | no test files |

Note that `packages/db` has no tests, which is uncomfortable: it owns the lease
claims, the transactional approval decision and the scheduler CAS — the three
places where a subtle bug is most expensive. That is the next honest gap to close.

---

## 27. Round 18 — the database layer finally has tests, and they paid immediately

`packages/db` owned the three most expensive invariants in the system and had **no
tests**: lease claiming under concurrency, the transactional approval decision, and
the scheduler's compare-and-swap. Every one of them depends on row locking and
`SKIP LOCKED`, which an in-memory fake would happily get wrong — so these run
against a real Postgres, in a scratch database that is dropped and recreated.

`packages/db/src/db.test.ts`, six tests:

| Invariant | What it proves |
|---|---|
| migrations + seeds | schema applies, built-in agents exist |
| SKIP LOCKED | three concurrent claims return **distinct** jobs; the task moves to `running` |
| roll-up | a policy-blocked `interrupted` attempt does **not** fail the task |
| approve | exactly **one** job is created; a **second** decision is refused and adds none |
| reject | **zero** jobs created, task `cancelled` |
| schedule CAS | first claim fires, second returns `false` |

Skipped (not passed) when `OPERANT_TEST_DATABASE_URL` is unset, with a warning —
a visible skip, never a silent green.

### Two real bugs the tests found on the first run
1. `decideApproval` threw `UNDEFINED_VALUE: Undefined values are not allowed`
   because the stored job spec's `dshProfile` was passed straight to SQL. Any
   approval created without that field — a real possibility, including from the
   tool-boundary path — would have failed at decision time, in production, after a
   human had already clicked Approve.
2. The same statement used `tx.json(...)`, which failed to stringify inside that
   transaction. Now serialised explicitly and cast to `jsonb`.

Both are in the approve path, which had been "verified" live earlier — the live
test only exercised the shape the code happened to produce, which is exactly what a
test is for and a demo is not.

### `--passWithNoTests` removed from `packages/db` too
It now has tests, so the mask comes off; a missing suite fails loudly.

---

## 28. Round 19 — the state volume restores, and a package that was only a name

### Volume restore is no longer an untested claim
The logical dump test covered rows; this covers the physical volume, which is what
a recovery actually restores. `operant-pgdata` → tar → scratch volume:
**1368 files in, 1368 out**, `PG_VERSION` = 16, production still healthy
afterwards, scratch volume and backup removed. Both drills ran on the same host, so
restoring onto a *different* machine is still untested — the report says exactly
that instead of implying a full disaster-recovery rehearsal.

Only one named volume exists (`operant-pgdata`); job workspaces are host
directories, so their backup is an ordinary file copy, not a volume operation.

### `packages/mcp-client` was a package with no code
Its entire contents were `package.json` and `tsconfig.json`. Nothing in
`apps/api` or `apps/worker` imported it, yet `apps/api/package.json` declared it as
a workspace dependency. It looked like MCP capability in the dependency graph while
being nothing at all — the same class of defect as the dead `schedules` and
`artifacts` tables: a name that implies work nobody did.

Removed the package and the dependency. Rebuilt the dependency chain
(core → db → learning → dsh-adapter → worker/api): all clean.

(Worth noting for future rounds: the worker build initially appeared broken after
the removal, but the errors were unresolved `@operant/*` modules because those
packages had never been built *locally* — they were built on the VM. The failure was
my local checkout, not the change.)

---

## 29. Round 20 — the bot reaches the host and diagnoses itself

The Discord bot had never been deployed: `apps/bot/src` was empty on `operant-core`
and no service unit existed. It now is, and the one thing that is verified is the
one thing that can be verified without a Discord token.

- Source (17 files) and tests (8 files) copied; `tsc` build succeeds on the host.
- `operant-bot.service` installed, hardened (`ProtectSystem=strict`,
  `ProtectHome=read-only`, no write paths beyond `data`), and **deliberately
  disabled** — without a token it exits 1 and would consume the start-limit budget.
- Its own `--check`, run **on the host against the live control plane**, reports:

```
config ok — api=http://127.0.0.1:8787 · allow-list users=0 channels=0 (closed)
intents — GUILDS | GUILD_MESSAGES | GUILD_VOICE_STATES; MESSAGE_CONTENT not requested
API reachable — GET /v1/health state=healthy dshProfile=operant [postgres=healthy]
API auth ok — bearer accepted by GET /v1/tasks (1 task visible)
DISCORD_BOT_TOKEN missing — the Discord gateway cannot log in; startup would exit 1
allow-list empty — this is fail-closed: every message will be refused until ids are configured
intents degraded mode — MESSAGE_CONTENT is privileged...
check: config ok · API reachable · token missing → NOT RUNNABLE (exit 1)
```

Exit code **1**, exactly as designed. That single output is worth more than a claim
that the bot "works": it demonstrates the deployable artifact authenticates against
the real API, and names the one missing prerequisite itself.

Two of my own errors along the way, both the same shape as earlier ones:
I guessed the entry point was `dist/main.js` (it is `dist/index.js`), and I wrapped
the script in `set -e` while running a command that is *supposed* to exit 1, so the
harness reported failure around a successful install. Verify the artifact's own
contract instead of assuming a filename or an exit code.

---

## 30. Round 21 — the proxy allow-list gets tests before it gets trust

The dashboard proxy attaches the control-plane bearer **server-side**, so every
path it forwards is reachable by any browser that can load the dashboard. That
makes the allow-list a security boundary — and it was three regex arrays buried in
a route file with zero tests.

Extracted to `apps/web/lib/proxy-policy.ts` exposing `isProxied(method, segments)`,
with the route now calling it. **38 tests**, covering what is reachable *and* what
is not:

| Class | Examples asserted false |
|---|---|
| unknown routes | `/v1/nope`, `/v1/learning/summary`, `/v1/voice/health` |
| traversal | `tasks/../../etc/passwd`, `artifacts/../../../etc/passwd/download` |
| id shape | `tasks/123`, `jobs/not-a-uuid` |
| extra segments | `tasks/<uuid>/extra`, `jobs/<uuid>/events/more` |
| wrong method | `GET /requests`, `POST /tasks`, `DELETE /tasks/<uuid>` |
| prefix confusion | `tasksXYZ`, `health/extra`, `requests/extra` |
| case | `/v1/TASKS` |

The exactness tests matter most: a single `startsWith` instead of a full-match regex
would have made `tasksXYZ` reachable while looking correct.

Then verified the same claims **live**, not only in vitest:

```
GET /api/v1/tasks            -> 2 tasks        (proxied)
GET /api/v1/schedules        -> 1 schedule     (proxied)
GET /api/v1/learning/summary -> 404            (refused)
GET /api/v1/voice/health     -> 404            (refused)
GET /api/v1/tasks/../../etc/passwd -> 404      (refused)
/, /schedules, /approvals    -> 200            (pages render)
```

`apps/web` also gained `vitest` and lost `--passWithNoTests`, so its first real
suite cannot silently disappear.

Running total: **211 tests** (core 55, dsh-adapter 14, learning 24, db 6, web 38,
bot 74).

---

## 31. Round 22 — the typed contract does not describe the wire format

I set out to fix the "duplicate wire types" gap by proving drift at the source:
a contract test that asks the live API for real resources and parses them through
`@operant/core`'s zod objects.

It failed immediately, and the failure is the finding:

```
contract.test.ts > every task in the list parses as a Task
  → tasks that do not match the contract
contract.test.ts > a task detail and its jobs match the contract
  → [{"path":["projectId"],"code":"invalid_type","received":"undefined"},
     {"path":["requestedBy"],...},{"path":["supervisorJobId"],...},
     {"path":["conversationId"],...}]
```

The API returns:

```json
{"id":"59b64e45-…","intent":"…","status":"succeeded","project_key":null,
 "requested_by":"perm-test","conversation_id":null,"supervisor_job_id":null}
```

So `packages/core`'s `Task` demands **camelCase, required, non-null** fields that
the API has never returned. The schema describes an intended domain model, not the
HTTP surface.

### The conclusion inverts the earlier assumption
When I added compile-time drift guards to `apps/web/lib/shape.ts`, I framed the web
mirror as the drifting copy. The opposite is true: `shape.ts` was written against
the real wire format, so **the web is accurate and core is aspirational**. The
duplicate existed precisely because core could not be used — importing it would
have produced types that do not match a single response.

Nothing caught this because **no layer validates response bodies**: the API returns
database rows and the schemas are only used for input validation and type
annotations. A typed API whose types are never checked against its output is a
document, not a contract.

### Action taken this round
The failing harness is removed from the tree rather than left red (a permanently
failing suite trains people to ignore failures) and its content is preserved in git
history. It gets reinstated once the schema and the wire format agree. The gap is
now recorded in the deployment report with the exact field mismatches, instead of
the vague "duplicate wire types" line it replaced.

Not done, and stated as such: aligning `packages/core` to the wire format, and
adding response validation to the API so this class of drift cannot recur silently.

---

## 32. Round 23 — an acceptance run found the gate had a hole

The consolidated acceptance drill passed on the main claim — services active, a real
request returned exactly `ACCEPTANCE-PASS`, 8 job events, an audit row, episodic
memory written, zero failed units — and then found a genuine defect in the thing I
had already declared working.

### The hole
"Email the client a summary of the build." was dispatched **immediately**: no
approval, one job, task `queued`. My `external_message` rule only understood
`send ... email`, and verb-first phrasing is how people actually write.

That is the difference between a gate and a suggestion. A user typing the natural
sentence walks straight past a control designed to stop them.

### The fix
The pattern now also matches the imperative form with a recipient —
`email|e-mail|dm|message|ping` + `the client|customer|team|user|vendor|boss|manager|…`
— and keeps the existing `send`/`post`/`reply to`/`notify` forms.

Eight new tests, and the negative ones matter as much as the positive:

| Gated | Not gated (reading ≠ doing) |
|---|---|
| "Email the client a summary of the build." | "Read the email from the client and summarise it." |
| "email the customer about the delay" | "Summarise the customer feedback in the inbox." |
| "DM the recruiter my updated CV" | "Write a message template to a file." |
| "Message the vendor asking for a quote" | |
| "Ping the team that the deploy is done" | |

### Verified live, not only in vitest
Same request, after deploy:
`approvalRequired: true`, **no job id**, **0 jobs created**, task `waiting_approval`.
"Summarise the customer feedback in the inbox." still passes ungated, so the fix did
not simply widen the gate into uselessness.

Core suite: **63 tests** (was 55). Running total **219**.

### What this says about the other rules
The destructive and spend rules were exercised by the same drill and held. But this
hole was found by accident, in a rule I had tested. The honest conclusion is that
the prose gate's coverage is **unknown**, not verified — only the phrasings anyone
happened to try are known to work. The tool-call boundary exists precisely because
this layer cannot be trusted alone, and that reasoning is now evidence-backed rather
than theoretical.

---

## 33. Round 24 — the API now validates what it actually sends

Last round established that `packages/core`'s schemas describe an intended model,
not the wire, and that **nothing validated responses** — which is why the divergence
survived. This round closes that for the task endpoints.

### `packages/core/src/wire.ts`
Schemas written against **real captured responses**, snake_case and nullable, and
deliberately `passthrough` (the API returns whole database rows, so extra columns
must not fail). They are strict about the keys the UI depends on: `id` (uuid),
`intent`, `title`, `status` (the enum), `origin`.

### Enforced at the boundary
`GET /v1/tasks` and `GET /v1/tasks/:id` now parse their own output before sending
it. On a mismatch the API logs the offending issues and returns **500
`response_contract_violation`** rather than serving a shape the UI cannot trust. A
loud failure beats a blank cell.

### Verified
- Schema against live data: `list parses: YES (5 tasks)`, `detail parses: YES`.
- After deploy: `/v1/tasks` → **200**, `/v1/tasks/:id` → **200**, and the API log
  contains **0** contract violations — so validation passes on every real row.
- 5 new unit tests including the two that matter: a **renamed/missing** required
  field and a **non-uuid** id are both rejected, and the list envelope is checked
  (`{items:[…]}` fails where `{tasks:[…]}` passes).

Core suite: **68 tests**. Running total **224**.

### Not done, stated plainly
Only the two task endpoints validate. `agents`, `approvals`, `jobs`, `memory`,
`schedules` and the detail endpoints still return unvalidated rows — the pattern is
established and the remaining schemas are mechanical, but writing them without
captured samples would be guessing at the wire format, which is the exact mistake
being corrected here.

---

## 34. Round 25 — a false positive found by reading real data

While capturing response samples for more wire schemas, one approval in the queue
read:

> "The agent tried to run bash, blocked because it is a filesystem or partition
> operation."

The command was `ss -ltn 2>/dev/null; echo "--- docker ---"; docker ps --format
'{{.Names}} {{.Image}}'` — an ordinary diagnostic. The rule `\b(mkfs|fdisk|parted|format)\b`
matched the word **format** inside `--format`.

A gate that blocks `docker ps` is worse than no gate: it produces approvals nobody
reads, trains the operator to click Approve reflexively, and buries the approvals
that matter.

### Fixed
Only real formatting forms are matched now: `mkfs`, `fdisk`, `parted`, `format.com`,
and `format X:` (the Windows drive form). Six new tests pin both directions:

| Must NOT block | Must block |
|---|---|
| `docker ps --format "{{.Names}}"` | `format C: /Q` |
| `ss -ltn; docker ps` | `C:\Windows\System32\format.com D:` |
| `git log --pretty=format:%h` | `mkfs.ext4 /dev/sdb1` |

Verified in the **deployed** artifact, not just the test runner:

```
allow <- docker ps --format "{{.Names}}"
allow <- ss -ltn 2>/dev/null; docker ps
BLOCK <- format C: /Q
BLOCK <- mkfs.ext4 /dev/sdb1
```

The approval the false positive created was withdrawn with a note recording why,
rather than deleted, so the audit trail still explains it.

Core suite: **74 tests**. Running total **230**.

### The lesson I keep relearning
This was invisible in tests and invisible in the UI. It surfaced only by reading an
actual approval row. Every previous round that "read real data" found something:
the dead scheduler, the phantom overflow, the ungated "Email the client", this. The
inverse is also true — every round where I trusted my own summary, I was wrong about
something.
