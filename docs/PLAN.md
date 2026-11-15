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
| 2 Foundation | stack starts, smoke tests pass, redeployable | **IN PROGRESS** — schema + workspace manifests done; DB, API, compose pending |
| 3 Core integrations | Discord→DSH→verifiable result; both DSH instances use VoiceStudio | **IN PROGRESS** — DSH execution spine proven; VoiceStudio deployment pending; local MCP pending |
| 4 Hallmark UI | every core workflow works desktop + mobile | NOT STARTED |
| 5 Learning/recovery | repeat failures detected, investigated, fixed with tests | NOT STARTED |
| 6 Independent verification | all critical/high defects resolved | NOT STARTED |
| 7 Deployment/handoff | release deployed, restarts recovered, report written | NOT STARTED |

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