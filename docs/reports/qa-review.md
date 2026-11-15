# Operant dashboard — independent QA / product review

Reviewer: independent agent (did not build this). Date: 2026-11-16, 00:17–00:53 IST.
Target: the **rendered** app from `apps/web` (Next 15.1.3) against the live control plane on
`127.0.0.1:8787`, Chrome 1440x900 / 768x900 / 390x844, driven with `puppeteer-core` +
focused DOM reads and real keypresses. Screenshots: `design/review/*.png`.

Everything below was executed against the running app. Nothing is taken from source
except where labelled "code path" (used only for states I could not produce live).

## How it was run (and what moved under me)

- `pnpm --filter @operant/web run build` → clean. `next start` serves the build.
- `:3100` was already occupied by an earlier instance; I left it alone and reviewed on a
  fresh `next start` of the same build (`:3104`, launched with the bearer token exported into
  its environment). `:3105` is a different operator's instance (`--env-file=../../.env`); I did
  not use it. Mid-review the control plane on `:8787` **went down**
  (00:22: health 200 → connection refused, no listener on 8787/55432, no tunnel process) and
  came back at ~00:34 **with a rotated bearer token** (`.env` rewritten at 00:31). The `:3100`
  instance, holding the old token, then rendered `unauthorized` on every panel; I reviewed on a
  new instance (`:3104`) started with the current token. This is an environment fact, not a
  product defect, but it means *every* screenshot here comes from `:3104`, not `:3100`.
- Error states were produced deliberately on throwaway instances: `:3101` (plain `next start`,
  no token) and `:3102` (`OPERANT_API_BASE_URL` pointed at a dead port). No service was killed.

## Verdict on dead / decorative controls: **YES, three of them**

| Control | What actually happens | Severity |
|---|---|---|
| **Cancel task** | Always fails. UI shows a red **"Bad Request"**; task keeps running. | **critical** |
| **Approve / Reject** | Performs the decision, then reports **"the control plane answered 200"** as an error. | **critical** |
| **"Ask for a second job to verify the result"** | Stores a flag nobody reads; no verifier job is ever created. | **high** |

Evidence for each is below.

## Defect list

### 1. CRITICAL — "Cancel task" is dead in the rendered app
Repro: open `/tasks/<a running task>` → click **Cancel task** → **Yes, cancel it**.
Result: `POST /api/v1/tasks/:id/cancel` → **400**, row shows `Bad Request`, status stays `running`.

- Proxy sends `content-type: application/json` with an **empty body**; Fastify rejects it:
  `{"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY",...,"message":"Body cannot be empty when content-type is set to 'application/json'"}`.
- The endpoint itself works: same task, same moment, `POST` **without** the content-type header →
  `200 {"cancelled":1}` and the task becomes `cancelled` with its job `cancelled`.
- Effect: a safety-critical control cannot stop a running job. Because it fails **after** the
  confirm step, the operator is told the stop failed and will assume the job is still spending.
- Evidence: `cancel-1-before.png`, `cancel-2-confirm.png`, `cancel-3-after.png`.

### 2. CRITICAL — Approving or rejecting in the UI reports failure while succeeding
Repro: `/approvals` → **Approve** (or **Reject**) → the row stays pending with both buttons live,
the header still says `2 pending`, and a red **"the control plane answered 200"** appears.

- Network: `POST /api/v1/approvals/:id/decide` → **200**
  `{"decided":true,"decision":"approve","taskId":"29e1fbc4…","jobId":"63084ebc…","status":"queued"}`.
- The job **was created and is running** (verified via `/v1/jobs/63084ebc…` → `running`,
  `/v1/approvals` → that approval gone, `1 pending`). The screen says otherwise.
- Root cause (code path): the client requires `body.approval`, which this response does not
  contain, so it falls into its error branch and prints the status code.
- Consequence: the operator believes the approval failed and re-clicks; the second click gets
  `409 already approved`, so the queue teaches the user that the feature is broken.
- Reject behaves identically: `200 {"decided":true,"decision":"reject","status":"cancelled"}` →
  UI error, row still shown.
- The queue **does** surface API-held approvals correctly (summary, risk, requester, expiry, note
  field, both buttons) — that half of the brief is satisfied. Evidence: `probe-approvals-1440.png`,
  `r_approvals-1440.png`/`-768`/`-390`, `approve-after-1440.png`, `reject-after-1440.png`.

### 3. HIGH — "Ask for a second job to verify the result" is decorative
Repro: dispatch with the checkbox ticked → `POST /v1/requests` → **202**, task
`require_verification: true`, **one** job, `verified_by_job_ids: null`. Task detail then says
`Verification: asked for at dispatch` and `Verified by: no verification job`, and the board prints
`verification asked`. `require_verification` appears in the data layer only (type + INSERT); no
API or worker code reads it, and none of the 27 tasks in the live list has more than one job.

### 4. MEDIUM — The control screen's Tape shows "no job" while the fleet is visibly working
Repro: dispatch a long job, then create a gated request (newer). Control shows **"3 in flight"**
and the Tape pane says *"No job exists yet, so there is no event trail. Dispatch a request and the
tape fills…"* — advice that is wrong, because a request was dispatched and its job is streaming.
Cause: the pane attaches to the newest non-terminal **task**, which for a held approval has zero
jobs; it never looks for the running job elsewhere. Evidence: `control-tape-empty-running-1440.png`
and the same state at 390 in `r_-390.png`.

### 5. MEDIUM — The approval queue has no route to the thing it approved
No `<a>` inside an approval row and no `/tasks/…` link on `/approvals` (checked in the DOM:
`jobLinksOnPage: []`, `taskLinksOnPage: []`). After a decision the user has no way to reach the
task or job that was created. The just-created job is only discoverable from `/` or by URL.

### 6. MEDIUM — All timestamps are UTC but labelled as if local
`clock()`/`stamp()` use `toISOString()`. Tape rows read `19:09:18`, approval rows read
`expires 2026-11-16 18:50:14` for an instant that is `18:50Z` = **00:20 IST the next day**, on a
browser whose timezone is IST. Relative ages ("raised 18m ago") sit next to absolute UTC times with
no zone marker. For "expires", this is a 5h30 error in the direction that matters.

### 7. MEDIUM — The board's error message is unreadable on the dark band
In the API-down state the error paragraph sits inside `.band--ink` with the muted colour:
measured **2.85:1** (`oklch(0.47 0.016 260)` on `rgb(10,13,19)`) for 14px text — below 4.5:1.
It also leaks the transport error verbatim: *"…control plane unreachable at http://127.0.0.1:8787:
TypeError: fetch failed"*. Evidence: `error-unreachable-1440.png`, `focus-8.png`.

### 8. MEDIUM — A fresh checkout's documented run command produces a fully dead dashboard
Repro (exactly the documented command): `cd apps/web; node node_modules/next/dist/bin/next start
-p 3104` → every data region (board, tape, approvals, service, every figure) renders
*"OPERANT_BOT_TOKEN is not set on this server, so the control plane refuses every request."*,
nav shows `failed`, all figures `—`. Re-run at 00:36 **after** the root `.env` had gained a real
64-char token — still dead, so the failure is the env plumbing, not a missing secret.
Cause: `apps/web` loads only its own `.env*` (none exist); the root `.env` is not read, and
`next start` forces `NODE_ENV=production`, which disables the dev-token fallback in `lib/api.ts`.
The instances that do work on this machine were started with `node --env-file=../../.env … next
start` (visible in their command lines), i.e. the run instruction needs that flag or an export.
Evidence: `error-missing-token-1440.png`.

### 9. MEDIUM — `/approvals` never refreshes
No `AutoRefresh`, no polling, no refresh control on that route. A new approval that arrives while
the page is open never appears, and after a decision the header counter stays stale (`2 pending`
while the API reports `1`). Repro: sit on `/approvals`, create a gated request via the API — the
page does not change, even after minutes.

### 10. LOW — 768px board columns collide and the jobs table clips
At 768 the `From` column is dropped (intentional) but `State` and `Took` end up ~8px apart, so
`waiting approval` and `not started` read as one string. The jobs table on `/tasks/[id]` is 746px
wide in a 720px container (right edge 770 on a 768 viewport) and loses its last column.
Evidence: `r_-768.png`, `board-768-crop.png`, `task_…-768.png`. No document-level horizontal
overflow at any width (1440/768/390: `scrollWidth == clientWidth` on all five screens).

### 11. LOW — Sub-24px tap targets
Board task links 21px tall, `Back to the board` 18px, job-id link 17px, `<summary>` 21px, the
verify checkbox 13×16 (its label does enlarge the hit area). WCAG 2.5.8 AA is 24×24.

### 12. LOW — Job table shows `0` tokens and a live duration while the job runs
A running job row reads `Tokens in 0 / Tokens out 0` and `Took 25s`, while the tape beside it
already shows `1572 completionTokens`. Null usage is rendered as zero rather than `—`.

### 13. LOW — Every route shares one document title; task detail has no current nav item
`<title>` is `Operant control plane` on `/`, `/memory`, `/approvals`, `/fleet`, `/tasks/[id]`.
`aria-current="page"` is correct on the four destinations but absent on `/tasks/[id]`, so that
screen has no "you are here" cue.

### 14. LOW — Two copy inaccuracies
- Cancel copy: *"the API only cancels a task that is still queued, dispatched or running"* — the
  UI can never cancel anything (defect 1), so the success sentence is unreachable.
- Memory copy: *"the API rejects a string `limit`"* — the API answers **200** with
  `{"error":"invalid_query", "issues":[…], "results":[]}`, not a rejection.

## What works, verified live

- **Dispatch** (mouse and keyboard): `POST /api/v1/requests` → 202, board row count 22→23,
  feedback *"Accepted as 2313a97a, routed to generalist. Open the task"*, page refreshes and the
  tape picks up the new job. Every visible nav link, form field, checkbox, search, write and
  details control does something real.
- **Tape really streams.** Held open on a running job for 24s: `GET /api/v1/jobs/…/stream?after=84`
  → 200, last row advanced `seq 84 → 128` (`step 10 → step 16 started`) with no reload; footer
  reports `open over /v1/jobs/:id/stream`, `seq 128`; `role="log" aria-live="polite"`.
- **Cancel is correctly absent on terminal tasks**, with honest copy: *"This task is succeeded, so
  the API will not cancel it. The button is absent rather than dead."* — verified on two finished
  tasks.
- **Memory**: search with results (1 match rendered), zero results (*"No memory matches
  "zzzznomatchqq". Every match needs a word that is literally in the record."*), and the write
  form (`POST /api/v1/memory` → 201, *"Stored semantic QA review probe note as 5a54b78b"*, and the
  row is searchable immediately). Screenshots: `memory-results-1440.png`, `memory-zero-1440.png`,
  `memory-write-1440.png`, `memory-found-1440.png`.
- **Keyboard**: 38 tab stops on `/` (the 39th Tab leaves the page) and every control is reached;
  focus rings are a real 2px (`outline: 2px solid` cobalt, amber on the ink bar) on skip link,
  nav, fields, checkbox, buttons and board links (`focus-0…9.png`, `focus-board-link.png`). The
  skip link is off-screen at rest and surfaces at `top: 12px` on first Tab. Keyboard-only end to
  end: type → Space ticks the checkbox → Enter dispatches (202) → Enter on a board link navigates
  to the task.
- **Semantics**: `<header>`, `<nav aria-label="Operant">`, `<main id="main">`, `<footer>` on every
  route; one `<h1>` per screen; `aria-current="page"` on the active destination; zero unnamed
  interactive controls; `<th scope="col">` on every table.
- **No state is colour-only**: every status word carries text plus an 8px swatch and, for the
  selected nav item, weight + underline as well.
- **Contrast** (computed styles read in-page from Chrome, WCAG relative luminance, OKLCH→sRGB
  converted in the same page): lead 5.97, labels 6.36, footer 5.97, amber figures on ink 10.63,
  board link 17.01, table headings 9.10, primary button 6.02, risk chip 5.32, wordmark 17.01 —
  all clear. The one exception is defect 7 (2.85:1).
- **Proxy is a real whitelist**: `GET /api/v1/learning/summary` → `404
  {"error":"endpoint_not_proxied"}`; unknown task id → in-page *"The control plane has no task with
  id …"*.
- **Fleet is honest about being read-only** — *"Every control on this screen would be a lie: the
  API exposes these as reads only"* — and it has no controls to back that up with.

## Not verified (and why)

- **Degraded health** rendering on `/fleet` and in the nav — I would have had to degrade a shared
  service; the code path maps any non-`healthy` check to the `failed` state word, but I did not see
  it rendered.
- **Approval expiry** — the rows carry a 24h expiry; nothing in the window could test it.
- **The `?job=` job switcher** — no task in the live DB has more than one job (defect 3 is why
  the verify checkbox never produces one), so the selector had nothing to switch between.
- **The 409 copy in the UI** — I confirmed the API answers `409 not_pending_or_missing
  ("already approved")` on a second decide, but the UI's own 409 message is only reachable after
  defect 2 is fixed.
- **Cancel on a queued (not yet running) task** — every task I could catch was already `running`
  or finished.
- Browser coverage is Chrome only (Firefox is reserved for the user on this machine).

## The three highest-impact fixes

1. **Make the proxy POST body honest** — do not set `content-type: application/json` when there is
   no body (or send `{}`). One line unlocks Cancel, which is the only way to stop a running job.
2. **Fix the decide contract** — accept `{decided, taskId, jobId, status}` as success, then drop or
   re-render the row and refresh the queue counter. Today the most consequential action in the
   product tells the operator it failed while it runs.
3. **Make verification real or remove it** — create the verifier job the checkbox promises (and
   fill `verified_by_job_ids`), or delete the checkbox and the three places that echo it
   (`verification asked`, `asked for at dispatch`, `Verified by`). A dead promise on the dispatch
   form is the cheapest way to lose trust in everything else on the page.