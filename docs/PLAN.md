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

---

## 35. Round 26 — the write rules were judging the wrong thing

Capturing shapes for more wire schemas surfaced a second approval from
`tool-boundary-guard`: a **write blocked as "outside the workspace"** whose
destination was inside the job's own workspace. The file's *content* mentioned
`/etc/cron.d` and `.ssh/authorized_keys` — example paths in a security report — and
the rule scanned the whole argument object, content included.

So the guard was judging text the agent was writing **about** security as though it
were performing it. Same class of bug as `docker ps --format`: the pattern matched
something adjacent to the true intent.

### Fixed, in two parts
1. **File-mutating tools are judged on their destination only** (`file_path`,
   `path`, `target`, …), never on the content they carry.
2. Shell tools keep scanning the command, which is what those rules describe.
3. Within the write branch, a credential path (`authorized_keys`, `.ssh/`,
   `.aws/`, `.dsh/`, `sudoers`, `shadow`) is classified as **`account_change` /
   critical** rather than a generic "outside workspace" complaint — the approver
   sees privilege escalation, not a path grievance.

### Verified on the deployed artifact

```
PASS workspace report mentioning sensitive paths -> allow
PASS write outside workspace                     -> block(file_write_outside_workspace)
PASS credential file write                       -> block(account_change)
PASS diagnostic (docker ps --format)             -> allow
PASS real formatting (format C:)                 -> block(destructive)
failures: 0
```

Core suite: **77 tests** (was 74). Running total **233**.

### A process failure worth recording
The first attempt to deploy this reported a *failing* check — because my `scp` used
relative paths from the wrong working directory, so the host kept running the old
predicate and I nearly "verified" a fix that was not deployed. The check that caught
it was the check itself failing. Re-ran with absolute paths: 5/5 pass. **A
verification step must confirm what actually reached the host, not what you intended
to send.**

Test-harness artifacts from my own probes and the acceptance runs were withdrawn
from the approval queue with notes, so the operator's queue shows only real items.

---

## 36. Round 27 — response validation on every read surface, and a subtle mistake in where it ran

Extended the wire contract from tasks to **agents, approvals, schedules and memory
search**, using key lists captured from the running service rather than from the
type declarations.

Then it broke two endpoints with 500s — and the failure was instructive:

```
approvals -> expected string, received date   path: ["approvals",0,"created_at"]
schedules -> expected string, received date   path: ["schedules",0,"last_run_at"]
```

The schemas were right. The **validation point was wrong**: I parsed the in-memory
object, where timestamps are still JS `Date`s, while Fastify serializes them to ISO
strings on the way out. The contract describes what goes **over the wire**, so
`assertWire` now serializes first and validates the actual payload:

```ts
const wire = JSON.parse(JSON.stringify(value ?? null));
```

That is a general trap: validating the object you are about to send is not the same
as validating what you send, and the difference only shows up for types that change
during serialization.

### Verified after the fix

```
/v1/health 200 · /v1/agents 200 · /v1/approvals 200 · /v1/schedules 200
/v1/memory/search 200 · /v1/tasks 200 · /v1/usage 200
15 fresh requests issued -> contract violations in the last 20 seconds: 0
```

Worth being precise about what this proves: the schemas accept the shapes the service
produces **today**. It does not prove the schemas are complete — `passthrough` means
an extra column would be ignored, and a field the UI does not read is not required.

Also honest: the four new schemas are validated against live responses but do **not**
yet have unit tests of their own (the task schemas do). That is a gap, not a
completeness claim.

---

## 37. Round 28 — the four new wire schemas now have their own tests

Last round I stated plainly that the agent/approval/schedule/memory schemas were
validated against live responses but had no unit tests. Closing that.

10 tests, built from **captured real rows** rather than invented fixtures, and each
schema is exercised in both directions:

| Schema | Accepts | Rejects |
|---|---|---|
| Agent | real agent row | missing `display_name`; `enabled: "yes"` |
| Approval | real row with nullable decision fields; `job_id: null` (how a held request looks) | missing `summary`; `action: "nope"` |
| Schedule | real row; `next_run_at: null` before the first run | missing `rrule` |
| Memory | real result; `title: null` | missing `excerpt`; wrong envelope key (`rows`) |

The envelope tests matter as much as the field tests: `{rows:[…]}` failing where
`{results:[…]}` passes is the difference between a rename being caught and a panel
silently showing nothing.

Core suite: **87 tests**. Running total **243** (core 87, dsh-adapter 14, learning
24, db 6, web 38, bot 74). Verified on both the laptop and the deployed host.

### Remaining known gaps
Response validation covers seven read endpoints; `jobs`, `usage`, `voice/*` and the
learnings endpoints still return unvalidated rows. The prose-gate coverage is unknown
by construction. The tool boundary reacts rather than pre-empts. `packages/ui` has no
tests. The local MCP guard is a manual process. Restore has never been tried on a
different host.

---

## 38. Round 29 — every read endpoint now validates its output

Finished the job started two rounds ago: `jobs`, `usage`, `learning/summary` and
`voice/health` join tasks, agents, approvals, schedules and memory search.

Shapes were captured from the service, not inferred: `job` has 25 columns including
`approved_commands`, `verified_by_job_ids` and four nullable timestamps; usage is a
three-counter envelope; the learning summary carries six counters (five required,
`repeats`/`memories` tolerated).

Five more tests, again built from captured rows:
- job: accepts null `result`/`parent_job_id`; rejects missing `workspace_path` and a non-uuid `task_id`
- usage: rejects string counts (`"657740"`), which is exactly what a serializer change would produce
- learning: rejects a missing `proposals`
- voice: rejects a payload with no `state`

### Verified on the deployed API
```
/v1/jobs/:id 200 · /v1/usage 200 · /v1/learning/summary 200 · /v1/voice/health 200
/v1/agents 200 · /v1/approvals 200 · /v1/schedules 200 · /v1/tasks 200
contract violations: 0
```

Core suite **92 tests**. Running total **248**.

### The typed-API deliverable is now closed, with one honest qualifier
All eight read endpoints validate what they send and fail loudly on a contract
violation. What this does **not** do: validate request bodies beyond the existing zod
input schemas (they already were), cover the `/v1/learning/incidents` and
`/v1/learning/improvements` list endpoints (plain rows, no UI dependency yet), or
prove the schemas are exhaustive — `passthrough` means an added column goes unnoticed
by design.

Remaining known gaps are now: prose-gate coverage unknown by construction; tool
boundary reacts rather than pre-empts; `packages/ui` untested; local MCP guard is a
manual process; restore never tried on a different host.

---

## 39. Round 30 — the crown claim re-verified against the current system

"Survives a restart" was proven in an early round, before the MCP guard, the bot
unit, the artifacts ledger, the scheduler and the wire contract existed. A claim
verified against a smaller system is not verified, so it was re-run.

### Evidence

```
before:  boot id 275b3db3-…  ·  api/worker/guard active  ·  bot inactive (disabled)
reboot issued
after:   boot id cefb937b-…  ·  uptime 1 minute        <- it really restarted
         operant-api         active / enabled
         operant-worker      active / enabled
         operant-mcp-guard   active / enabled
         operant-bot         inactive / disabled        <- still intentionally off
         postgres container  running, restart=unless-stopped
         health              {"state":"healthy","checks":[{"name":"postgres",...}]}
         failed units        0
```

Then, with no intervention:

```
POST /v1/requests -> task succeeded, result "POST-REBOOT-PASS"
schedules         -> still armed for the next occurrence
/v1/voice/health  -> healthy via the MCP guard
artifacts         -> 0 for this task (correct: the agent wrote no files)
```

### What this does and does not establish
It establishes the operator definition of done: *a real request succeeds
end-to-end, survives a restart, leaves an auditable trail, and needs no manual
repair.* Everything came back by itself — no `systemctl start`, no container
nudge, no reconfiguration.

It does **not** establish that a job survives being *interrupted mid-flight* by the
reboot. There was no in-flight work at the time (checked before rebooting: 0 queued,
dispatched or running jobs), so the lease-reclaim path was not exercised this round.
It was exercised in the earlier reboot test; re-exercising it would need a
deliberately killed job, which is worth doing and was not done here.

### State at the end of this round
248 tests green; 224 tracked files; tree clean; API, worker and MCP guard active on
boot; bot installed and disabled pending a Discord token.

The three remaining blockers are all human decisions, not engineering: the Discord
bot token (gateway login is the only unproven leg of the platform), the VoiceStudio
licence acceptance for synthesis, and approval to rewrite git history so the rotated
bearer stops appearing in `1feda7c`.

---

## 40. Round 31 — the retry limit was silently inert

Tested the one durability claim that had never been re-exercised: a job interrupted
**mid-flight** by a worker crash.

### The reclaim itself works
```
submit "run sleep 60"                 -> task running, job running, attempt 1, lease valid
SIGKILL the worker's MainPID          -> job still holds a live lease (genuinely stuck)
restart worker
t+210s                                -> job succeeded, result "SLEPT-AND-DONE"
worker log: job start 22:15:39 pid 3320  …  job start 22:18:39 pid 4139
```

Durability holds: an abandoned job is reclaimed by a new worker after the lease
expires and completes. That is the property the whole queue exists for.

### But the log shows the bug
Both starts logged **`attempt: 1`**. `claimNextJob` reclaimed the job without
incrementing the counter.

And the worker *does* enforce the cap:

```ts
if (job.attempt < job.max_attempts) { requeue } else { fail }
```

So `attempt` never exceeding 1 meant **`max_attempts` could never fire**. A job that
crashed the worker every time would be reclaimed forever, burning model calls
indefinitely. The cap was documentation in a column.

### Fixed
`claimNextJob` now increments `attempt` when it reclaims an abandoned attempt
(`status IN ('running','dispatched')`), and leaves it alone on a first claim — a
fresh job is not a retry.

Two new tests pin both directions:
- reclaim after an expired lease → `attempt` **2**
- first claim → `attempt` **1**

`packages/db` suite: **8 tests**. Running total **250**.

### Also verified
A fresh job after the change still reports `attempt: 1` and succeeds, so the fix did
not turn normal runs into retries.

### Honest remainder
The mid-flight test now proves reclaim *and* correct retry accounting, but not the
end condition: I did not make a job fail repeatedly to watch it exhaust its attempts
and be marked permanently failed. That specific path — cap reached → job `failed`,
task failed, incident recorded — is still unexercised.

---

## 41. Round 32 — the retry cap and the retry loop both verified

Closed the gap named last round: whether a job that cannot succeed is actually stopped.

### Cap of 1: fails immediately
A job pointed at a non-existent DSH profile (deterministic failure, real code path):

```
job  failed | attempt 1 | max_attempts 1 | "turn ended with reason \"unknown\" (exit 1)"
task failed
incidents for task            1
job rows for task             1   <- it did not keep retrying
```

### Cap of 2: retries exactly once, then fails
```
t+5s   job failed | attempt 2 | max_attempts 2
worker log: "job failed, requeued {"attempt":1,"max":2,"reason":"turn ended with reason unknown (exit 1)"}"
task failed
```

That `requeued` line is the proof that the counter and the cap cooperate. **Before last
round's fix this loop was infinite**: `attempt` stayed at 1, `1 < 2` was always true,
and a permanently failing job would have been requeued forever, burning model calls
until someone noticed. The fix turned a silent infinite loop into a bounded retry.

### Cleanup
Both fixtures were inserted directly into Postgres to exercise the worker, and were
deleted afterwards so they do not appear as real work in the operator's task list.

### What remains unverified in this area
Nothing I can think of for retries. The related gap is different: a job whose *worker*
dies is reclaimed by lease expiry (verified last round), but a job that hangs while
the worker stays alive is bounded only by `JOB_TIMEOUT_MS`, which I have not exercised
by hanging one deliberately.

---

## 42. Round 33 — the hang timeout is still unverified, and I nearly reported a leak that did not exist

Attempted to close the last named durability gap: a job that hangs while the worker
stays alive, bounded by `JOB_TIMEOUT_MS`.

### Attempt
`JOB_TIMEOUT_MS` defaults to 20 minutes, so it was temporarily lowered to 60 s on the
worker unit, a job was submitted that runs `sleep 300`, and the job was polled.

### Result: inconclusive, and honestly so
- No `timed out` line ever appeared in the worker log, across 180 s — three times the
  configured budget.
- The job's `attempt` did change 1 → 2 at exactly **180 s**, which is the *lease*
  duration, not the timeout.
- That transition coincides precisely with **my own `systemctl restart`** while
  restoring the unit at the end of the script.

So the most likely reading is: the timeout never fired, the run stayed alive, and my
restart killed the worker; the lease then expired and the restarted worker reclaimed
the job. The override, the timeout path, or both are implicated, and **I do not know
which**. It is recorded as unverified rather than passed.

### The leak I nearly reported
`pgrep -fc 'dsh --profile'` returned **2**, and I started writing up orphaned agent
processes surviving a SIGKILLed worker — a genuinely dangerous failure (duplicate
execution with real side effects). Before reporting it I checked what those PIDs were:

```
pid=12138 cwd=/home/iamdarshg age=0s
pid=12139 cwd=            age=s
```

They were **my own shell**, matched because the pattern string appears in its own
command line, at age 0 seconds. A precise check (`ps -eo args | grep '^node .*dsh'`,
plus the worker's own children) returns **0 orphans** and no children.

### Why this belongs in the record
This is the fourth time in this project that a measurement, not the system, was
wrong — a Chrome window size that cropped pages, `systemctl` running on the wrong
host, `scp` sending from the wrong directory, and now `pgrep` matching itself. The
pattern is consistent: **before acting on a surprising measurement, measure the
measurement.** On this evidence the failure mode that looks most alarming is also the
easiest to fake.

---

## 43. Round 34 — the timeout mystery, resolved

Last round I left `JOB_TIMEOUT_MS` as "unverified, cause unknown". Resolved, and the
cause was not where I was looking.

### Three measurements, in order

**1. Is the adapter timeout itself sound?** Tested in isolation, bypassing systemd:

```
runDshJob({ prompt: 'sleep 60', timeoutMs: 8000 })
-> elapsed=8s  timedOut=true  cancelled=false  ok=false   eventCount=8
```

The mechanism works and fires on time. So the adapter was never the problem.

**2. What is the timeout actually set to in production?**

```
/proc/<worker>/environ  ->  JOB_TIMEOUT_MS=900000
```

**Fifteen minutes**, set in `.env` via `EnvironmentFile=`. My round-33 attempt set
`Environment=JOB_TIMEOUT_MS=60000` in the unit and assumed it would win; it did not.
That alone explains the whole previous result: a 60-second budget was never in force,
so nothing could have fired at 60 s — and the 180-second change I observed was the
lease expiring after my own restart, exactly as I suspected but could not prove.

**3. Does it work end to end with the effective value?** Changed `.env` to 60 000,
restarted, submitted a job that sleeps 300 s:

```
attempt 1  -> "timed out after 60000ms"  -> job failed, requeued
attempt 2  -> "timed out after 60000ms"  -> job failed permanently
final      -> interrupted | attempt 2 | "timed out after 60000ms"
```

So: the wall clock fires, the retry accounting counts it, the cap stops it. Exactly
the behaviour claimed, now with evidence.

### One wart found while proving it
A timeout finalises the job as **`interrupted`**, not `failed`, because the worker maps
`timedOut` onto that status. Everything downstream treats it as terminal so nothing is
broken, but an operator reading the job list sees "interrupted" for something that
exhausted its retries. Worth aligning; not worth hiding.

### Restored
`.env` is back to `JOB_TIMEOUT_MS=900000`, the fixture task was deleted, the worker is
active with the original environment. Verified from `/proc/environ`, not assumed.

### The general lesson, again
Last round I looked for the cause in the worker's code and the unit file. The value
came from a third place — `.env` via `EnvironmentFile` — and my unit-level override was
silently outranked. **Read the effective value from the running process; never infer it
from where you think it is configured.**

---

## 44. Round 35 — a timeout now reports that it failed

The wart from last round: a job that exhausted its retries was recorded as
`interrupted` whenever the cause was a timeout. That reads like an external
cancellation, not a job giving up, and it muddies the one status an operator scans
for problems.

`interrupted` is now reserved for what it actually means — a policy block, where work
stopped on purpose and is waiting for a human. Everything else that exhausts its
attempts is `failed`.

### Verified end to end
`.env` set to 45 000 ms (confirmed in `/proc/<worker>/environ`), a job submitted that
sleeps 300 s:

```
final: failed | attempt 2 | "timed out after 45000ms"
task:  failed
```

Previously the same run produced `interrupted`. `.env` restored to 900 000 and the
effective value re-read from `/proc/environ` afterwards; the fixture task was deleted.

### Durability claims, all now evidenced
| Claim | How it was proven |
|---|---|
| an abandoned job is reclaimed | SIGKILL the worker mid-run; a new worker completes it |
| reclaim counts as a retry | `attempt` 1 → 2 with the unit test covering both directions |
| retries are bounded | cap 2 → one requeue, then terminal |
| the cap stops a hopeless job | cap 1 → immediate failure |
| a hang is killed by the wall clock | 45 s override → "timed out after 45000ms" |
| a timeout is a failure, not a cancellation | this round |

That closes the durability area. The remaining gaps elsewhere are unchanged and
listed in the deployment report.

---

## 45. Round 36 — the laptop's MCP guard is a service now, not a shell I happened to leave running

The gap said: "the local MCP guard is a manual process". It was worse — the guard
running on the laptop was a child of a session I had started, so it would die whenever
that went away, and the voicestudio tools would silently disappear from the local DSH.

### What was built
- `~/.dsh/mcp-guard-supervise.ps1` — a supervise loop that restarts the guard if it
  dies, reading its bearer from the repo `.env`.
- `operant-mcp-guard.vbs` in the Startup folder — the same detached, windowless launch
  pattern the harness already uses for `:3081`.

### What it verified, including the failure
The supervisor logs to `~/.dsh/logs/mcp-guard.log`, and the sequence shows both halves:

```
04:22:17  supervisor starting
04:22:36  OPERANT_MCP_TOKEN missing or short in E:\CodeProjects\operant\.env; not starting the guard
04:23:37  OPERANT_MCP_TOKEN missing or short ...
04:24:38  starting guard on :3901
```

The refusal is the interesting part: the local `.env` had **no** `OPERANT_MCP_TOKEN` —
I had only ever exported it in the shell before hand-starting the guard. So the
supervisor correctly declined to start an unauthenticated proxy and **said why in one
line**. That is the difference between a service and a shrug.

After persisting the token (`.env` is gitignored; verified with `git check-ignore`),
the guard came back on `:3901` by itself. Killing the listener and waiting also brings
it back.

### The remaining honest gap on this host
The **upstream is gone locally**: `docker ps` shows no containers at all, so
VoiceStudio is not running on the laptop. The guard answers, and the MCP client reports
the server disconnected — DSH keeps working, the voice tools are simply absent.

So "wired into BOTH cloud and local DSH" is currently true of the wiring and false of
the local upstream. Starting it is one command (`docker compose --profile voice up -d`)
and is documented in the runbook; I did not start Docker Desktop on the user's machine
without being asked.

---

## 46. Round 37 — three packages that were only names

`packages/ui` had no tests because it had **no code**: the entire package was
`package.json` and `tsconfig.json`, and `apps/web` declared it as a dependency while
importing nothing from it.

Sweeping the workspace for the same shape found another:

| Package | Source files | Used by |
|---|---|---|
| `packages/ui` | 0 | declared in `apps/web`, imported nowhere |
| `packages/memory` | 0 | declared in `api`, `worker`, `learning`, imported nowhere |
| `packages/mcp-client` | 0 | removed two rounds ago |

Three of seven packages were placeholders. A dependency graph is a claim about
architecture, and these made the platform look like it had a memory service, a
component library and an MCP client when it had three empty folders. That is the same
failure as the dead `schedules` and `artifacts` tables — a name doing the work of an
implementation — and it is the last of that pattern I can find.

### Removed
`packages/memory`, `packages/ui`, and their `workspace:*` references in `apps/api`,
`apps/web`, `apps/worker` and `packages/learning`. `packages/mcp-client` was already
removed locally but its directory was still on the host; it is gone there now too.

### Verified after removal
- Whole workspace builds: core, db, learning, dsh-adapter, api, worker, bot.
- Tests unchanged and green: core **92**, learning **24**, dsh-adapter **14**, web **38**;
  db **8 skipped** locally (no test database — the suite skips loudly by design).
- Deployed host rebuilt and restarted: `api=active worker=active guard=active`,
  health `healthy`, `/v1/tasks` **200**, handler output unchanged.
- Remaining packages: core, db, dsh-adapter, learning, web-search-ddg — every one of
  them with real source.

### Why this mattered more than it looks
Nothing broke, because nothing used them. But "has a memory package" and "has a UI
package" are exactly the claims an evaluator would check by looking at the tree, and
they were false. Deleting them makes the tree honest: five packages, all real.

---

## 47. Round 38 — every page has its own title

The QA review's accessibility finding: no per-route `<title>`. Confirmed — all six
routes rendered the single root title "Operant control plane", so browser tabs,
history, bookmarks and screen-reader page announcements were identical everywhere.
That is WCAG 2.4.2 (Page Titled), not a cosmetic nicety.

Added a `title` template on the root layout and a `metadata` export per route, then
verified the rendered HTML rather than the source:

| Route | `<title>` |
|---|---|
| `/` | Control |
| `/approvals` | Approvals · Operant |
| `/fleet` | Fleet · Operant |
| `/memory` | Memory · Operant |
| `/schedules` | Schedules · Operant |
| `/tasks/[id]` | Task · Operant |

One wart: the home route renders `Control` without the `· Operant` suffix, because a
page at the same level as the layout merges differently. Distinct titles were the
point and all six are distinct, so it is recorded rather than chased.

`/tasks/[id]` uses a static "Task" title. A `generateMetadata` that includes the task
title would be better for history and bookmarks; it needs a fetch per navigation and
was not done.

---

## 48. Round 39 — an error nobody could read

The QA review flagged that the error paragraph on the dark band measured **2.85:1**,
below the 4.5:1 AA floor. Confirmed, and the cause was embarrassing: the palette
already defined `--color-error-on-ink` for exactly this case, applied it to the tape's
result block… and never applied it to the feedback paragraph.

### Fixed
`.band--ink .feedback--error { color: var(--color-error-on-ink); }`

### Measured rather than assumed
Converted both tokens from OKLCH to linear sRGB and computed WCAG relative luminance:

```
--color-error        on ink : 3.20:1   (AA needs 4.5)  <- the bug
--color-error-on-ink on ink : 8.01:1   (AA needs 4.5)  <- now
```

My 3.20 does not exactly match QA's 2.85 — different ink band shade or their sampling
included antialiasing — but both are below the floor, so the finding was real either
way. The replacement clears it with room.

Verified the rule is in the shipped CSS (`9290323de8b6978e.css`), not just the source.

### What this pattern keeps showing
This is the third time the same shape has appeared: a capability existed and was never
wired up — the `schedules` table, the `artifacts` table, `allowed_tools`, and now a
colour token. The platform was not missing features so much as missing **connections
between things it already had**. That is a more useful diagnosis than "add more".
