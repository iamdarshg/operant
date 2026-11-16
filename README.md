# Operant

**An AI employee you actually own.**

Operant is a self-hosted platform that turns a queue of work into an auditable
trail of AI agent runs. You dispatch a request; an agent executes it on your own
machine; every step is recorded; anything consequential waits for your approval.

The name is deliberate. In behavioural psychology an *operant* is a behaviour shaped
by its consequences — which is the whole design here: agents that act, get judged by
outcomes, and are constrained by what those outcomes cost.

Built on [DeepSeek Harness](https://deepseek.com) (DSH) as the execution engine —
headless JSON runs, persistent sessions, subagents, MCP clients and scheduling. It is
not a wrapper around LangChain, CrewAI or similar; the agent loop is DSH's.

---

## Why it exists

Autonomous agents fail in two directions: they do nothing useful, or they do
something irreversible. Most platforms optimise for the first and hand-wave the
second. Operant is built the other way round — it assumes the agent will eventually
try something it shouldn't, and makes that a decision a human takes.

Three concrete design commitments:

1. **Nothing consequential runs unattended.** A request is screened before dispatch
   (prose intent), the agent's tool calls are screened during the run (command
   boundary), and each agent has an explicit tool allow-list. A blocked call kills the
   run and becomes a decision, not a retry.
2. **A blocked action cannot be granted by a bug.** Approving a blocked command records
   *that exact command* on the job; the boundary permits exact matches only, so an
   approval cannot be widened into "anything containing this string".
3. **Every claim is checkable.** Jobs carry events; artifacts carry `sha256`; approvals
   carry who decided and why. If the UI says a file was produced, you can hash the bytes.

## What it does

| Capability | Detail |
|---|---|
| **Durable jobs** | Postgres queue with `FOR UPDATE SKIP LOCKED` and leases. A killed worker's job is reclaimed after the lease expires; retries are counted, bounded, and a crashed job cannot loop forever. |
| **Memory** | Episodic, semantic, procedural, failure and evaluation memories, searched with Postgres `tsvector` — no vector database required. |
| **Approvals** | Prose intent gate → tool-call boundary → per-agent authorization, each with its own failure mode. |
| **Schedules** | Recurring work with a documented RFC 5545 subset (`FREQ`, `INTERVAL`, `BYHOUR`, `BYMINUTE`, `BYDAY`), timezone-correct. Unsupported rules are refused rather than mis-scheduled. |
| **Artifacts** | Files a job produces are collected, `sha256`-recorded and downloadable through an authenticating proxy. |
| **Self-improvement** | Failures are fingerprinted, repeated ones become proposals, promotion and rollback are both real operations. Never acts on a single occurrence. |
| **Dashboard** | Next.js: control board, task detail with live event tape, memory search, approvals, fleet, schedules. |
| **Speech** | VoiceStudio (CPU) behind an authenticating MCP guard; transcription and synthesis available to agents as MCP tools. |
| **Chat interface** | Discord bot with voice-note transcription, approval prompts and conversation continuity. |

## Architecture

```
                    ┌──────────────┐
   Discord / HTTP ──│  control API │── Postgres (jobs, memory, approvals, audit)
                    └──────┬───────┘
                           │ claim (SKIP LOCKED + lease)
                    ┌──────▼───────┐
                    │    worker    │── spawns ── dsh --profile … --json
                    └──────┬───────┘                 │
                           │ tools                   │ events
                    ┌──────▼───────┐          ┌──────▼───────┐
                    │ tool boundary│          │ job_events   │
                    └──────────────┘          └──────────────┘
```

- `packages/core` — typed contracts, policy (intent + tool boundary), schedule maths
- `packages/db` — schema, migrations, queue, approvals, memory, artifacts
- `packages/dsh-adapter` — DSH invocation, NDJSON normalisation, stream guard
- `packages/learning` — failure classification, incidents, proposals, rollback
- `apps/api`, `apps/worker`, `apps/bot`, `apps/web`
- `services/mcp-guard` — authenticating proxy in front of an unauthenticated service

## Running it

Requires Node 22, pnpm 11, Docker (for Postgres) and the `dsh` CLI.

```bash
cp .env.example .env          # then set OPERANT_BOT_TOKEN (16+ chars) and your model key
pnpm install
docker compose up -d postgres
pnpm -r run build
pnpm --filter @operant/db run migrate
pnpm --filter @operant/api start   # http://127.0.0.1:8787
pnpm --filter @operant/worker start
pnpm --filter @operant/web dev     # http://127.0.0.1:3000
```

The API **refuses to start** without a bearer token. That is deliberate.

Full operator documentation — secrets checklist, recovery, rollback, and how to add an
agent or a tool — is in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Testing

250 tests across six suites, including integration tests against a real Postgres for
the parts where an in-memory fake would lie (concurrent lease claiming, the
transactional approval decision, the scheduler compare-and-swap).

```bash
OPERANT_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/operant \
  pnpm -r run test
```

The database suite **skips loudly** when no test database is provided — a visible skip,
never a silent pass.

## Honest limitations

Published as it stands, not as a brochure:

- **The prose gate is a denylist and its coverage is unknown.** It was bypassed 11/11
  by paraphrase in review. The tool-call boundary exists *because* that layer cannot be
  trusted alone; it inspects what the agent is about to run, not what you typed.
- **The tool boundary reacts, it does not pre-empt.** A command that executed before
  the event was parsed is not undone.
- **`DISCORD_BOT_TOKEN` is required** for the chat interface; the bot has never been
  exercised against the live gateway in this repository's testing.
- **Speech models are licence-gated and non-commercial.** The bundled VoiceStudio models
  (OmniVoice, Higgs audio tokenizer) are `CC-BY-NC` / Llama-3 terms. Check them before
  any commercial use.
- **One process per service.** No horizontal scaling story; the worker honours
  `WORKER_CONCURRENCY` and that is the design ceiling today.
- **Restore has been exercised on the same host only.** Cross-host disaster recovery is
  documented, not rehearsed.

## Security notes

- The bearer token is read from the environment and never committed. An earlier revision
  did hardcode a dev token — it was removed, rotated, and the placeholder that remains is
  deliberately non-functional.
- `services/mcp-guard` exists because VoiceStudio ships `/mcp` with **no authentication**.
  The guard requires a bearer, refuses to start without a token, and forwards method,
  path, headers and body unchanged.
- Secrets live in `.env` and `secrets/`, both gitignored.

## License

MIT for this codebase — see [`LICENSE`](LICENSE). Vendored model weights and the
VoiceStudio container keep their own licences, which are stricter.