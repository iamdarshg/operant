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
