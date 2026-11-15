# Operations — secrets, recovery, and extending the platform

Three things an operator needs and should not have to reverse-engineer: what to
supply by hand, how to get back up when something breaks, and how to add a new
agent or tool without editing the core.

---

## 1. Secrets checklist (the only manual steps)

Nothing else needs a human. The repository is 100 % portable: no vendored
dependencies, no absolute host paths, no committed credentials.

| # | Secret | Where it goes | How to obtain | Consequence if missing |
|---|---|---|---|---|
| 1 | `SURPLUS_API_KEY` (or `ANTSEED_API_KEY`) | `secrets/.credentials.yaml` | Your model-provider account | Every agent run dies `MISSING_CREDENTIAL` before doing work |
| 2 | `OPERANT_BOT_TOKEN` | `.env` (both machines, **identical**) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | The API refuses to start below 16 chars (fail-closed) |
| 3 | `DISCORD_BOT_TOKEN` + `DISCORD_APP_ID` | `.env` | Discord Developer Portal → your app → Bot | Bot cannot log in; everything else works |
| 4 | `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS` | `.env` | Your Discord ids | **Empty = nobody is authorized**; the bot refuses everyone (intentional) |
| 5 | Tailscale auth key *(optional)* | operator-side only | Tailscale admin console | SSH-over-IAP remains the private path |

`.credentials.yaml` shape:

```yaml
version: 1
refs:
  SURPLUS_API_KEY: <your key>
```

Rules that are enforced, not advisory:

- `.env` and `secrets/` are gitignored (verified with `git check-ignore`).
- `secrets/.credentials.yaml` is mounted **read-only** into the containers; the
  agent can read it and cannot rewrite it.
- Never hardcode a token in source. That already happened once: the dev bearer was
  committed in `apps/bot/src/config.ts` and found by the security review. It was
  removed, replaced with a non-functional placeholder, and **rotated**. Git history
  still contains the dead value.

---

## 2. Recovery and rollback

### 2.1 Something is down — check in this order

```bash
docker compose ps                     # or: systemctl status operant-api operant-worker
curl -s localhost:8787/v1/health      # {"state":"healthy","checks":[{"name":"postgres",...}]}
docker compose logs --tail=50 worker
journalctl -u operant-worker -n 50 --no-pager   # VM/systemd installs
```

Health semantics: `healthy` means the API can reach Postgres. It does **not**
claim the worker is running, the model route authenticates, or speech is up. Check
those individually — `GET /v1/voice/health`, and a real request.

### 2.2 A job is stuck

Jobs carry a lease (180 s, renewed every 45 s). A dead worker's job becomes
reclaimable automatically, so the first answer is usually *wait three minutes*.

```sql
-- what is actually running
SELECT id, status, attempt, lease_expires_at FROM jobs
 WHERE status IN ('running','dispatched') ORDER BY created_at;
-- force a job back into the queue
UPDATE jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL WHERE id='<id>';
```

### 2.3 Cancel and approval rollback

- Stop a task: `POST /v1/tasks/:id/cancel` (cancels every open job under it).
- An approval is irreversible by design: it is a recorded human decision. To undo
  the *effect*, cancel the task it enqueued. To reverse a promoted improvement,
  `POST /v1/learning/improvements/:id/rollback` — that is why every improvement
  stores a rollback pointer.

### 2.4 Restore from backup

State lives in three Docker volumes: `pgdata`, `voicestudio_data`, `jobs`.

```bash
# backup
docker run --rm -v operant_pgdata:/v -v "$PWD":/out alpine tar czf /out/pgdata.tgz -C /v .

# restore (on a clean host, before `up`)
docker volume create operant_pgdata
docker run --rm -v operant_pgdata:/v -v "$PWD":/out alpine sh -c 'cd /v && tar xzf /out/pgdata.tgz'
```

`packages/db/migrations/*.sql` are idempotent and run automatically against an
empty volume, so a cold start without a backup is a valid fresh install.

### 2.5 Rollback a bad release

```bash
git log --oneline            # find the last good commit
git checkout <good-sha>
docker compose up -d --build
```

There is no database migration versioning yet: migrations are additive and
idempotent, so rolling the app back never requires rolling the schema back. **That
holds only while migrations are additive** — the first destructive migration
requires a snapshot first.

### 2.6 Cost emergency (cloud VM)

```bash
gcloud compute instances stop operant-core --zone=asia-south1-c \
  --project=project-ba289c9c-3c25-4e15-9dc
```

Compute billing stops; the disk does not (~$12/mo). A stopped VM retains
`/opt/operant-src` and the Docker volumes. A VM-side watchdog already stops it at
300 billed hours, because budget alerts do not stop billing.

---

## 3. Adding a new agent

Agents are rows, not code. Insert one and the router can use it:

```sql
INSERT INTO agents (id, display_name, role, description, system_overlay,
                    permission_mode, max_concurrency, allowed_tools)
VALUES ('data', 'Data', 'generalist', 'Analysis and notebook work.',
        'You are the data specialist. State assumptions. Never invent numbers; label provenance.',
        'workspace-write', 2, ARRAY['read','write','edit','glob','grep','pwsh','bash']);
```

Then route to it: `POST /v1/requests {"text":"…","agentSlug":"data", …}`.

What actually governs the run:

| Column | Effect |
|---|---|
| `system_overlay` | Prepended to the job prompt (the agent's standing instruction) |
| `permission_mode` | Passed to `dsh --permission-mode`; `read-only` for reviewers |
| `max_concurrency` | Advisory ceiling; the real cap is `WORKER_CONCURRENCY` |
| `allowed_tools` | Recorded intent today. **Not yet enforced** — see gaps below |

The default router (`defaultAgentFor`) is keyword-based on purpose: cheap,
inspectable, no model call to decide who does the work.

## 4. Adding a new tool

Two paths, in order of preference.

**4a. An MCP server (no code).** Add one row to the DSH profile and both DSH
instances see its tools as `mcp__<server>__<tool>`:

```yaml
- insert:
    - id: mcp-mytool
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mytool
        transport: streamable-http
        url: http://127.0.0.1:9100/mcp/
        headers: {}
        toolCallTimeoutMs: 60000
        failOnStartupError: false     # a dead tool must not stop DSH booting
        reconnect: { enabled: true, maxAttempts: 5 }
```

`services/dsh/profiles/operant/cordis.patch.yml` is the versioned copy; the live
profile at `~/.dsh/profiles/operant/cordis.patch.yml` is what actually loads.
Verify with `dsh --profile operant --dump-config` (expect zero WARN lines) and then
ask an agent to list its MCP tools — do not assume the row took effect.

**4b. A native DSH plugin (code).** Implement `apply(ctx)` and register into a
service (see `packages/web-search-ddg` for a complete, tested example that
registers a `ctx.web` search provider). Wire it with a `link:` dependency plus an
`- insert:` row, exactly as that package does.

## 5. Known gaps you should not discover the hard way

1. **The approval gate inspects prose, not actions.** An independent reviewer
   bypassed it 11/11 by paraphrase. Gating at the tool-call boundary is the real
   fix and is not done.
2. `allowed_tools` on an agent is documentation, not enforcement. Tool-level
   authorization is not implemented.
3. VoiceStudio's `/mcp` endpoint is **unauthenticated** (upstream design). It is
   mitigated only by binding to loopback and reaching it over SSH/IAP.
4. `/approvals` has no auto-refresh; the decided-state UI refreshes, the list does not.
5. Absolute timestamps render in UTC with no zone label.
6. `fastify` and `next` versions carry published advisories and need bumps.
7. The web app keeps its own wire types instead of importing `@operant/core` —
   the one place a contract can drift.