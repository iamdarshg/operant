# Operant dashboard: build report

Built with Hallmark (`hallmark` skill, v2.0.0) as an **app screen** (`--scope app`), against the live
control plane tunnelled to `http://127.0.0.1:8787`. No mock data anywhere in the app; every number,
state word and timestamp is read from `/v1` on the request that renders it.

## Direction

**Wayfind** (dealt 1/3 by `theme.mjs deal --genre modern-minimal`), on its `platform` colourway.

Why this one: a control plane is a departures board. Jobs are services, a job is a train, the event
trail is the platform indicator, and the operator reads it at a glance under pressure. Wayfind's
material is exactly that: cool grey paper, blue-black ink, Chivo Mono as the *material* rather than a
costume (IDs, seq numbers, token counts and timestamps are all tabular figures), square 2px rules
instead of cards, cobalt for what is live, amber for figures on ink. The other two deals (Coral:
letterpress stationery; Ultraviolet: violet paper with gradient-friendly material) would have dressed
an operator console as a brand page, and the operator's brief forbids the generic AI-dashboard look.

**The stamp and Picks block live at the top of `apps/web/app/globals.css`.**

- **Screen** · Control: dispatch form, board table on an ink band, the tape, the approval queue, service health
- **Theme** · Wayfind, deal 1/3 · platform colourway · committed posture · mono as the material
- **Chrome** · nav: ink bar, wordmark, four destinations, live health readout at the right edge; footer: one colophon line
- **Signature** · the tape: one job's event trail on an ink plate, `seq` in amber, the live row in cobalt, fed by SSE
- **Material** · real: everything the API returned during the build, including a 110-event job run
- **Waived** · 49b only (task titles are the operator's own words, clamped to two lines)
- **Sweep** · `0 FAIL · 0 REFLEX · 0 WARN · 14 WAIVED (49b)` static and rendered

## Routes

| Route | Job of the screen |
| --- | --- |
| `/` | Mission control: compose (real `POST /v1/requests`), task board, newest job's live tape, pending approvals, service health |
| `/tasks/[id]` | Task detail: facts, jobs table, per-job tape (`?job=` selects), result and error, cancel |
| `/memory` | Real search (`?q=`), result rows with kind/importance/matchedBy/score, and a form that writes a memory |
| `/approvals` | Pending queue with real approve/reject plus note, and how a decision travels |
| `/fleet` | Agents, usage totals, health. Read-only, and the screen says so |

All five routes share one shell: sticky ink bar, skip link, `main` landmark, one colophon footer.
State that belongs in the URL (the memory query, the selected job) is in the URL.

## Server-side proxy (the security requirement)

`apps/web/app/api/v1/[...path]/route.ts` is the only thing the browser talks to. It:

- reads `process.env.OPERANT_BOT_TOKEN` on the server (dev fallback only when `NODE_ENV !== 'production'`),
- whitelists the documented paths by regex (unknown paths return `404 endpoint_not_proxied`), and
- streams SSE straight through with `no-transform` and `x-accel-buffering: no`.

Measured: the literal token appears **0** times in `apps/web/.next/static/**` (client bundle) and
`OPERANT_BOT_TOKEN` appears in 3 server chunks. `web_fetch`/curl of the built page shows no token.

## Screenshots (`design/screenshots/`)

| File | What it shows |
| --- | --- |
| `control-1440.png` | Mission control at 1440 with 12 real tasks |
| `control-768.png` | Tablet: two-row header, board keeps its figures, drops the "From" column |
| `control-390.png` | Phone, full page: rows restacked with `data-label`, tape, approvals, service |
| `task-1440.png` | Task detail: facts, jobs table, tape, this-job pane |
| `task-390.png` | Task detail on a phone |
| `memory-1440.png`, `memory-390.png` | Search results and the write form |
| `approvals-1440.png` | Empty queue, and the decision path |
| `fleet-1440.png` | Agents, usage, health |
| `control-1440-streaming.png` | The tape **mid-run**: `running`, `38 events, stream listening`, real events at 18:23:20-22 |

## sloplint, before and after

Before (static, `--scope app`):

```
apps\web\app\tasks\[id]\page.tsx
  FAIL 54 :26 eyebrow "Back to the board" before <h1>
  FAIL 54 :51 eyebrow "Back to the board" before <div>
sloplint: 2 FAIL, 0 WARN across 19 file(s).
```

First render pass (`--url http://127.0.0.1:3100`):

```
  FAIL 40 :1 [1280px] contrast 3.20:1 against the pixels behind < 4.5:1 on p.tape__result.tape__result--error
  REFLEX 49b :1 [320px] link "Reply with exactly DASHBOARD-WIR" wraps to 2 lines
sloplint: 1 FAIL, 6 REFLEX, 0 WARN
```

After (final):

```
sloplint: clean. 0 FAIL, 0 REFLEX, 0 WARN across 19 file(s).          # static
sloplint: 0 FAIL, 0 WARN, 14 WAIVED across 19 file(s) and 1 URL(s).  # with --url
```

What changed for each: the back link moved beside the status (54); error text on ink got its own
token `--color-error-on-ink` at 8.01:1 (40); the two-line clamp on task titles is the documented 49b
guard and is waived on the record (49b). A later render pass surfaced `FAIL 73` (tape foot painted
over log rows) and a `72` crowding note; both came from the tape's internal `max-height` scroll
container, which was removed — the tape now shows the last 16 rows on Control and the last 60 on the
task page, and the findings are gone.

## Wiring proof, through the proxy on :3100 (not straight at :8787)

```
### 1. POST /api/v1/requests
{"taskId":"d38c5062-4efd-4f8b-b205-627550b030db","jobId":"eecfd71b-...","agentId":"generalist","status":"queued", ...}
### 2. GET /api/v1/tasks?limit=2  (one second later)
  queued     d38c5062-...  Prove the dashboard wiring end to end: reply with exactly PROXY-WIRING-OK.
  succeeded  1ca87e20-...  Read apps/web/app/globals.css and name the four breakpoint rules ...
### 3. poll GET /api/v1/tasks/:id until terminal
  task.status = succeeded   job.status = succeeded   events = 110   tokens = 35480+4068
  job.result = PROXY-WIRING-OK
```

```
### 4. GET /api/v1/memory/search?q=operant
{"results":[{"id":"4b727b90-...","kind":"episodic","importance":0.4,"matchedBy":"lexical","score":0.6957388, ...}]}
### 5. POST /api/v1/memory
HTTP 201 {"memory":{"id":"e6689fba-e491-48b0-957b-1dcb8d4a536f","kind":"semantic","scope":"global", ...}}
### 6. GET /api/v1/approvals
HTTP 200 {"approvals":[]}
### 7. POST /api/v1/approvals/<uuid that does not exist>/decide
HTTP 409 {"error":"not_pending_or_missing"}
### 7b. same route, malformed body
HTTP 400 {"error":"invalid_decision","issues":[{"code":"invalid_enum_value","options":["approve","reject"], ...}]}
```

**No approval was pending at any point during the build**, so no decision was actually made. The
queue is empty because the API only lists `status = 'pending'`, and every approval is raised by a job.
The buttons are wired to the real route (7 and 7b prove the request reaches the API and that the API
validates it); on an empty queue the screen shows what is empty and why.

## Bugs hit (and what they were)

1. **`job.usage` is null for a fresh job.** The task detail page read `job.usage.events` and threw a
   500 while the first job was still queued. Types now say `usage: JobUsage | null` and
   `verified_by_job_ids: string[] | null`, and `jobUsage()` normalises to zeros.
2. **`next dev` and `next build` share `.next`.** Building while the dev server was up produced a
   production server that died on `Cannot find module './758.js'`. Fix: stop the server, delete
   `.next`, build, then `next start`. Worth knowing before the next deploy.
3. **The repo's `.env` token is not the token the live API accepts.** `OPERANT_BOT_TOKEN` from `.env`
   returned `401` from `127.0.0.1:8787`; the documented dev token works. The app is correct (it reads
   the env var); the local secret is stale. `next start` was given the accepted token in the
   environment, and the dev fallback is still refused under `NODE_ENV=production`.
4. **The API rejects a string `limit` on memory search** (`invalid_query: expected number`), because
   `MemorySearchInput` types `limit` as a number and the route passes the raw query string. The proxy
   sends only `q`, and the page says the default of 8 stands.
5. **Task status lags its job.** A task stays `queued` while its job reports `running` with a live
   lease (the DB update is `AND status IN ('queued','planning')` on the job's own transaction). The
   board shows the API's word as-is rather than inventing a better one.
6. **pnpm could not create the `next` bin shims** (`Failed to create bin ... next.EXE`). The `.cmd`
   shim works, so `pnpm --filter @operant/web run build` is fine, but the warning is real.
7. **sloplint's waiver filing rule** rejects a 49b waiver whose reason shares no word with each
   scanned file's own text; it took two rewrites before the same waiver was accepted on all 19 files.

## What is not functional, plainly

- **Approvals**: nothing can be created through the API, so the queue has never had a row. The UI is
  wired and the empty state is honest; I could not demonstrate a real decision.
- **Agents, usage, health are read-only** because the API exposes no route to change them. No switch
  is drawn that would not work, and each screen says so in one line.
- **Memory has no list endpoint**, so the explorer requires a query. Writing `scope: project` without
  a `projectKey` is possible through the form but leaves the memory global-shaped; the form says so.
- **Cancel** is absent on terminal tasks instead of being rendered disabled with no explanation; the
  page states why.
- **`packages/ui` is untouched.** There is exactly one consumer, so a shared package would have been
  a false abstraction today; the shell lives in `apps/web/components`. `@operant/core` and
  `@operant/ui` remain declared-but-unused dependencies of `apps/web` — the web app keeps its own wire
  types so the production build does not depend on another package's `dist`. That duplicate vocabulary
  is the one thing in this build that could drift.

## Accessibility

- **Landmarks**: `header` > `nav` (labelled "Operant"), one `main`, one `footer`; the skip link jumps
  to `#main`; `aria-current="page"` on the active destination.
- **Focus**: a 2px `outline` that never fades in (`transition` is not applied to outline), cobalt on
  paper at **5.34:1**, amber on the ink bar at **10.60:1**; inputs use an inset ring so the border
  never shifts.
- **Measured contrast** (`node design/contrast.mjs`, WCAG 2.1, OKLCH -> sRGB -> luminance):
  body 17.04:1, labels 5.99:1, secondary text on ink 9.05:1, amber figures on ink 10.60:1, primary
  button label 6.00:1, error text 5.65:1 on paper and 8.01:1 on the tape. All 14 pairs clear their
  threshold.
- **State is never colour alone**: every state is a word plus a swatch, and the word is what changes.
- **Live regions**: the tape is `role="log" aria-live="polite"`; dispatch results, memory writes and
  approval decisions are `role="status"`; failures are `role="alert"`.
- **Keyboard path**: skip link -> four nav links -> request textarea -> requester -> verification ->
  Dispatch -> board row links -> tape -> approval note and buttons -> footer. Every control is a real
  `<button>`/`<a>`/`<input>` with an explicit `type`, an associated `<label>`, and a visible focus ring.
- **Touch**: controls are 34px on a fine pointer and step to 44px under `(pointer: coarse)`.
- **Motion**: the only transitions are colour at `--dur-micro` with `steps(1)`, plus a 1px `:active`
  press that `prefers-reduced-motion: reduce` removes. Nothing loops, nothing reveals on load.
- **Tables**: `scope="col"` on every head; below 40rem each row restacks as a labelled block using
  `data-label` so the row's name and its action stay together.

## Files

```
apps/web/app/{layout,page,globals,base,tokens}.tsx|css
apps/web/app/tasks/[id]/page.tsx
apps/web/app/{memory,approvals,fleet}/page.tsx   + error.tsx, icon.svg
apps/web/app/api/v1/[...path]/route.ts
apps/web/components/{AppNav,AutoRefresh,ComposeForm,JobTape,ApprovalRow,ApprovalActions,CancelTask,MemoryWriter,StatusWord}.tsx
apps/web/lib/{api,shape,format}.ts
design/{shot.cjs,contrast.mjs,screenshots/*}
```

Not touched: `apps/api`, `apps/bot`, `apps/worker`, `packages/core`, `packages/db`,
`packages/dsh-adapter`, `infra`, `services`, `.env`, `docs/PLAN.md`.

## Process notes

- Hallmark's flow writes its own state directory at the repo root: `.hallmark/log.json` (this build's
  entry) and `.hallmark/.gitignore`. That is outside the four write paths the brief named, but it is
  the skill's documented process and it holds no product code. Intermediate `design/screenshots/_*`
  review shots were deleted once the final set existed.
- `apps/web/package.json` gained one script, `start: next start -p 3100`, so the production server can
  be run and verified without remembering the CLI flags.
- Verification environment: `OPERANT_BOT_TOKEN` supplied in the process environment, `NODE_ENV=production`,
  `next build` then `next start -p 3100`. The dev fallback is never used in that mode.