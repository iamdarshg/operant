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
| 4 | Discord bot | **Code complete, gateway untested** | 74 tests, `--check` mode verified live (SSE reader); **no real gateway login** — requires the operator's bot token |
| 5 | Voice transcription | **Done** | VoiceStudio CPU, faster-whisper `small` (measured 0.258 RTF, 0 % WER, 1108 MiB); `/v1/voice/transcribe` accepts `audioBase64` or `ref` |
| 6 | VoiceStudio MCP on **both** DSH | **Done** | 9 `mcp__voicestudio__*` tools discovered on cloud and laptop profile; foreign `Host` → 403 |
| 7 | Next.js dashboard, every control functional | **Mostly** | 5 routes; three dead controls found by independent QA were fixed and re-verified (§4). Schedules are not surfaced in the UI |
| 8 | Hallmark design process | **Done** | skill installed and listed in the catalog; dashboard built under it |
| 9 | Self-improvement with rollback | **Done** | 24 tests; `occurrences < 2` never acts; config/auth/resource never auto-apply; `promote`/`rollback` endpoints |
| 10 | Approval gate | **Done, layered** | prose intent gate (21 tests) + **tool-call boundary** that kills a run and escalates (§5) |
| 11 | Scheduled/recurring jobs | **Done (API only)** | RFC 5545 subset, worker tick, live fire verified (§6) |
| 12 | Artifacts (files produced) | **Done** | collected after each job, sha256-recorded, downloadable with hash verification (§7) |
| 13 | GCP IaC, no GPU, cost-capped | **Done** | e2-standard-8, asia-south1-c, 100 GB pd-balanced, private VPC, IAP-only SSH, $120 hard cap, 300 h watchdog |
| 14 | Automated tests | **Done** | 93 verified this round (core 55, adapter 14, learning 24) + bot 74 and web suites from earlier runs |
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
7. **The web app keeps duplicate wire types** rather than importing `@operant/core`
   — the one place the contract can drift.
8. **Backup restore is tested, but only at the database level.** A live dump was
   restored into a scratch database and reproduced every row count and real content
   (see §10). Docker-volume backup/restore for the speech service's data directory
   is still untested.
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
