# Deployment report — Operant

Written at commit `ed321c5`+ (artifacts round). This is the deliverable index: for
each thing the brief asked for, what exists, **how it was verified**, and what is
still not true. Evidence is a command output, a test result, or a screenshot — not
a claim that code was written.

Live environment: GCP `operant-core` (project `project-ba289c9c-3c25-4e15-9dc`,
zone `asia-south1-c`), `operant-api` + `operant-worker` under systemd, Postgres in
Docker (`operant-pg`, `restart=unless-stopped`), repo at `/opt/operant-src/operant`.

---

## 1. Deliverable status

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | Typed control-plane API | **Done** | zod contracts in `packages/core/src/schema.ts`; every `/v1` route 401s without a token; health, tasks, jobs, memory, approvals, usage, voice, learning, schedules, artifacts |
| 2 | Durable jobs in Postgres | **Done** | `FOR UPDATE SKIP LOCKED` + 180 s leases, append-only `job_events`; survived a mid-job reboot and resumed (see §3) |
| 3 | Memory kinds | **Done** | `memories.kind` covers episodic/semantic/procedural/failure/evaluation; worker writes episodic + failure rows; tsvector search verified |
| 4 | Discord bot | **Deployed to the host, not running, gateway untested** | 74 tests passing locally (7 files); source + build now on `operant-core` with `operant-bot.service` installed but **disabled**. Its own `--check` on the host reports: `config ok · API reachable · token missing → NOT RUNNABLE (exit 1)`, and confirms the bearer is accepted by `GET /v1/tasks`. What is still unproven is the **Discord gateway login**, which needs the bot token. |
| 5 | Voice transcription | **Done** | VoiceStudio CPU, faster-whisper `small` (measured 0.258 RTF, 0 % WER, 1108 MiB); `/v1/voice/transcribe` accepts `audioBase64` or `ref` |
| 6 | VoiceStudio MCP on **both** DSH | **Done** | 9 `mcp__voicestudio__*` tools discovered on cloud and laptop profile; foreign `Host` → 403 |
| 7 | Next.js dashboard, every control functional | **Mostly** | 5 routes; three dead controls found by independent QA were fixed and re-verified (§4). Schedules are not surfaced in the UI |
| 8 | Hallmark design process | **Done** | skill installed and listed in the catalog; dashboard built under it |
| 9 | Self-improvement with rollback | **Done** | 24 tests; `occurrences < 2` never acts; config/auth/resource never auto-apply; `promote`/`rollback` endpoints |
| 10 | Approval gate | **Done, layered** | prose intent gate (21 tests) + **tool-call boundary** that kills a run and escalates (§5) |
| 11 | Scheduled/recurring jobs | **Done (API only)** | RFC 5545 subset, worker tick, live fire verified (§6) |
| 12 | Artifacts (files produced) | **Done** | collected after each job, sha256-recorded, downloadable with hash verification (§7) |
| 13 | GCP IaC, no GPU, cost-capped | **Done** | e2-standard-8, asia-south1-c, 100 GB pd-balanced, private VPC, IAP-only SSH, $120 hard cap, 300 h watchdog |
| 14 | Automated tests | **Done** | **250 tests**: core 92, dsh-adapter 14, learning 24, db 8 (integration, real Postgres), web 38 (proxy allow-list), bot 74 |
| 15 | Security review | **Done** | `docs/reports/security-review.md`, 9 areas, PASS/FAIL with commands |
| 16 | Independent UI/QA review | **Done** | `docs/reports/qa-review.md` + 47 screenshots in `design/review/` |
| 17 | Ops runbook | **Done** | `docs/OPERATIONS.md` — secrets checklist, recovery, rollback, extending |
| 18 | Deployment report | **This file** | — |

---

## 2. Acceptance test: a real request end to end

```
POST /v1/requests {"text":"Reply with exactly SYSTEMD-OK."}
→ task succeeded, result "SYSTEMD-OK"
```

Verified under systemd after a reboot, through the authenticated API, with the job
executed by a real `dsh --profile operant --json` child process.

## 3. Acceptance test: survives a restart

A job was killed mid-flight by a VM reboot. After boot: the lease expired, the job
was reclaimed, and the task completed. The reboot also exposed three real defects,
all fixed: no Postgres restart policy, a worker that crashed instead of backing
off, and a sandbox that blocked DSH session writes.

## 4. Acceptance test: every visible control does something

Independent QA found three controls that **looked** functional and were not:

| Control | Defect | Now |
|---|---|---|
| Cancel task | proxy set `content-type: application/json` on a body-less POST → Fastify 400 | 200 `{"cancelled":1}` via the proxy |
| Approve / Reject | client required `body.approval`; API returns `{decided,…}` → showed "answered 200", row stayed pending | row updates, job link shown, queue refreshes |
| Verify checkbox | flag stored, nothing read it | real `review` job enqueued, `verified_by_job_ids` set, task → `reviewing` |

## 5. Acceptance test: a dangerous action cannot run unattended

Wording chosen to **pass** the prose gate ("…fix its permissions by running
`chmod 777`"):

| Step | Observed |
|---|---|
| Prose gate | passed — job enqueued |
| Agent tool calls | `write` (allowed), then `bash` + `chmod 777` |
| Tool boundary | **blocked**, child killed, `blocked at the tool boundary: make world-writable (bash)` |
| Approval | `tool-boundary-guard`, risk `high`, exact command recorded |
| Approve | new job, `approved_commands` = that exact command |
| Re-run | **succeeded**; file really became `mode=777` |

## 6. Acceptance test: a schedule fires

`FREQ=DAILY;BYHOUR=9;BYMINUTE=0` / Asia/Calcutta → `2026-11-16T03:30:00Z` (09:00
IST). Unsuitable rules are rejected (`400 invalid_rrule`). A due schedule produced
a task with `origin='schedule'` and advanced `next_run_at`.

## 7. Acceptance test: a produced file is retrievable and verifiable

Agent wrote `report.md` → collected automatically → downloadable:

```
bytes 28 · "hello from the artifact test"
served x-content-sha256 = bb5fd045…58ee
actual sha256           = bb5fd045…58ee   (match)
```

---

## 8. What is NOT done — read this before trusting the platform

1. **No Discord gateway test.** The bot has never logged into Discord. It needs
   `DISCORD_BOT_TOKEN`; until then "Discord as the primary interface" is unproven.
2. **VoiceStudio synthesis is licence-gated.** Cloning/TTS over MCP returns
   `403 Licence not accepted for k2-fsa/OmniVoice, eustlb/higgs-audio-v2-tokenizer`.
   Accepting a licence is your legal act, not mine. CPU TTS via the OpenAI-compatible
   `POST /v1/audio/speech` with `model:"kittentts"` does work.
3. **VoiceStudio itself has no authentication** (upstream design). It is now
   reachable only through `services/mcp-guard`, a dependency-free proxy that
   requires `Authorization: Bearer $OPERANT_MCP_TOKEN` — verified 401 without a
   token, 200 with one, all 9 tools working through it, on **both** cloud and
   local. Anyone with local shell access can still bypass the guard and reach
   `:3900` directly, so on-host access remains the real boundary.
4. **Per-agent tool authorization is enforced for privileged tools only** (`bash`,
   `pwsh`, `shell`, `write`, `edit`, `multiedit`, `apply_patch`). A `research`
   agent is refused the shell, and that refusal is a hard failure with **no
   approval offered** — it is configuration, not a decision a human should be able
   to overrule. Observational tools (`read`, `glob`, `grep`, `web_*`, `job_*`)
   remain ungated by design.
5. **The tool boundary reacts, it does not pre-empt.** A command that has already
   executed before the guard parsed the event is not undone.
6. **Schedules and artifacts now have a UI surface** (`/schedules` with create and
   delete; "Files produced" on the task page). Schedules have **no Discord
   commands**, so recurring work cannot yet be created from the chat interface.
7. **`packages/core`'s domain schema still does not match the wire format**, and it never
   did: it requires camelCase `projectId`/`requestedBy` while the API returns snake_case
   `project_key`/`requested_by`. That divergence survived because nothing validated
   responses. **Partly closed:** `packages/core/src/wire.ts` now describes the *actual*
   shapes, and eight read endpoints (`tasks`, `tasks/:id`, `jobs/:id`, `agents`,
   `approvals`, `schedules`, `memory/search`, `usage`, `learning/summary`,
   `voice/health`) parse their own output and return 500 `response_contract_violation`
   on a mismatch — verified with zero violations under live traffic. **Still open:** the
   original `schema.ts` objects remain unaligned, so anyone importing `Task` instead of
   `TaskWire` gets a type that matches no response.
8. **Both backup paths are now exercised.** A live `pg_dump` restored into a scratch
   database reproduced every row count and real content (§10), and the actual state
   volume (`operant-pgdata`) was backed up and restored into a scratch volume:
   **1368 files in, 1368 files out**, `PG_VERSION` = 16, production healthy
   afterwards, scratch volume removed. What is still untested is restoring onto a
   *different host*, not onto the same machine.
9. **Token still in git history** (`1feda7c`). Rotated and dead; purging history is
   a rewrite that needs your approval.

## 9. Cost

Measured $0.33242/h compute (e2-standard-8 on-demand) + $0.12/GB-month disk. The
300-hour watchdog stops the VM at ≈ $104.66, inside the approved $120 cap. Budget
`operant-hard-cap` exists; **alerts do not stop billing**, the watchdog is what does.
---

## 10. Acceptance test: a backup actually restores

Performed against the live database, into a **scratch** database so production was
never touched.

```
pg_dump -Fc                      → 258,412 bytes
source  : tasks=50 jobs=48 events=2353 memories=43 agents=4 approvals=13 artifacts=4
restored: tasks=50 jobs=48 events=2353 memories=43 agents=4 approvals=13 artifacts=4
content : "Done. Created `ok.md` in the working dir"   (not just counts)
cleanup : scratch database dropped; production health = healthy
```

Identical counts and surviving text, so the dump is a real backup rather than a
file that merely exists.

---

## 11. Acceptance test: the state volume restores

The database dump test (§10) covers logical state. This covers the physical volume,
which is what a real recovery actually restores.

```
tar the operant-pgdata volume   → source: 1368 files
extract into a scratch volume   → restored: 1368 files
PG_VERSION                      → 16 (a readable Postgres data directory)
cleanup                         → scratch volume removed, backup deleted
production after the drill      → {"state":"healthy","checks":[{"name":"postgres","state":"healthy"}]}
```

Not covered: restoring onto a **different host**. Both drills ran on `operant-core`.





