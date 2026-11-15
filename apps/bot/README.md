# @operant/bot — Discord surface for Operant

Natural language is the interface: any message in an allowed channel becomes a
request to the Operant control plane. There is no command list to learn. The bot
answers immediately, then keeps editing that one message while the work runs.

Built and unit-tested with **no Discord connection**: discord.js is only touched
in `src/discord/gateway.ts`, and the rest of the bot talks to the structural
interfaces in `src/discord/types.ts`. `fetch` is injected everywhere, so the test
suite asserts real HTTP bodies against a fake network.

## Quick start

```powershell
# from the repo root
node "$env:LOCALAPPDATA\node\corepack\v1\pnpm\11.19.0\bin\pnpm.cjs" --filter @operant/bot run build
node apps/bot/dist/index.js --check     # validate config + probe the control plane
node apps/bot/dist/index.js             # start (requires DISCORD_BOT_TOKEN)
```

`--check` prints a report and exits `0` (runnable) or `1` (not runnable). It
validates configuration, calls `GET /v1/health`, proves the bearer token is
accepted by `GET /v1/tasks`, and states whether the Discord token is present. It
never opens a gateway, so it is safe in CI or a container healthcheck.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | **yes** | Gateway token. No fallback in any environment — startup exits 1 without it. |
| `OPERANT_API_BASE` | prod | Control-plane URL. Dev fallback `http://127.0.0.1:8787`. |
| `OPERANT_BOT_TOKEN` | prod | Control-plane bearer. Dev fallback is a local-only token. |
| `DISCORD_ALLOWED_USER_IDS` | recommended | Comma-separated user ids allowed to act. |
| `DISCORD_ALLOWED_CHANNEL_IDS` | recommended | Comma-separated channel ids the bot listens in. |
| `DISCORD_EDIT_INTERVAL_MS` | no | Minimum gap between edits of one message (default 1500). |
| `DISCORD_POLL_INTERVAL_MS` | no | Fallback poll cadence when SSE is unavailable (default 2000). |
| `DISCORD_APPROVAL_POLL_MS` | no | Pending-approval sweep cadence (default 5000). |
| `DISCORD_MAX_ATTACHMENT_BYTES` | no | Voice download cap (default 25 MB, matching the API). |
| `DISCORD_JOB_TIMEOUT_MS` | no | Give up tracking after this long (default 30 min). |

Development fallbacks are **refused** when `NODE_ENV=production`: the process
exits 1 and names `OPERANT_API_BASE` / `OPERANT_BOT_TOKEN` as missing.

With **neither** allow-list set the bot is *closed*: it refuses every message and
says why. That is deliberate — an allow-list-less Discord bot in a guild is a
remote-execution surface for anyone who can post in the channel.

## Intents, and the privileged one

Requested: `GUILDS | GUILD_MESSAGES | GUILD_VOICE_STATES` (mask `641`).

`MESSAGE_CONTENT` is **privileged**: it must be enabled per application in the
Discord developer portal (Bot → Privileged Gateway Intents), and the bot does
**not** request it. What that means in practice:

| With `MESSAGE_CONTENT` | Without it |
| --- | --- |
| Any plain message is a request. | `content` is empty except for @mentions and DMs. |
| — | The bot still receives the event and the attachments, so: (a) requests that @mention it work, (b) voice notes work (audio needs no text), (c) everything else gets an explicit hint naming the intent instead of being silently ignored. |

Nothing in the bot pretends it can read what Discord withheld.

## Behaviour

1. **Natural language only.** A plain message becomes `POST /v1/requests` with
   `origin:"discord"` and the author's id. `/status` is the single optional
   affordance; it reads local state and creates nothing.
2. **Conversation continuity.** `conversationId` = `discord:<channel-or-thread id>`
   — a pure function of the Discord id, so it survives restarts and a thread never
   inherits its parent channel. A follow-up in a channel whose last turn succeeded
   is sent with that turn's outcome folded into `text` as explicit context.
3. **The gateway never blocks.** The "working" reply is posted *before* the API
   call, the request is submitted, and tracking is detached. Each channel owns its
   own message and editor; one long job cannot delay another channel.
4. **Four states, never conflated.** `📥 Request accepted — working in the
   background`, `⚙️ Background activity`, `⏳ Work paused — approval required`,
   `✅ Work completed` / `❌ Work failed` / `🚫 Work cancelled`.
5. **Voice notes.** Audio attachment (`mp3/m4a/wav/ogg/opus/webm/flac/aac`, or an
   `audio/*` content type) → bounded download → base64 → `POST
   /v1/voice/transcribe` → the transcript is **posted** so the user can check it →
   the transcript becomes the request text. Oversized or failed transcriptions
   are reported and never submitted as a request.
6. **Approvals.** `/v1/approvals` is swept for pending items belonging to tasks
   this process started; each gets an embed naming the action, risk, task and
   deadline plus `Approve`/`Reject` buttons. The clicker is authorized with the
   same allow-list as messages, the decision is written with their identity, and
   the card is edited to its decision with the buttons removed.
7. **Rate limits.** At most one edit per message per interval; intermediate states
   are dropped, the newest wins, and a terminal edit waits out the interval rather
   than forcing an early write. A Discord 429 sets a hard `retry-after` gate.
8. **Failures are per message.** API down → "could not reach the control plane";
   API rejection → names the status and points at `OPERANT_BOT_TOKEN`; job failed
   → shows the reason; transcription failed → shows the reason. None of them stop
   the bot.
9. **Clean startup failure.** A missing token prints the exact variable and exits
   `1`; no stack trace, no unhandled rejection, no half-started gateway.

## Files

| Path | Role |
| --- | --- |
| `src/index.ts` | Entry point, `--check` doctor, signal handling, lazy gateway import. |
| `src/config.ts` | Fail-closed env parsing; one error listing every problem. |
| `src/api/client.ts` | Typed control-plane client; 429/`retry-after`, timeouts, error mapping. |
| `src/api/sse.ts` | Total SSE frame parser (comments, chunk splits, unknown events). |
| `src/api/types.ts` | Wire types; snake_case/camelCase normalizers. |
| `src/discord/types.ts` | Structural Discord interfaces (the testability seam). |
| `src/discord/intents.ts` | Intent mask + `MESSAGE_CONTENT` documentation. |
| `src/discord/gateway.ts` | The only discord.js file: adapter + login. |
| `src/bot/handler.ts` | Routing: authorization, voice, submit, detached tracking. |
| `src/bot/conversation.ts` | conversation id derivation + result-context synthesis. |
| `src/bot/job-runner.ts` | SSE → edits, polling fallback, finished-turn bookkeeping. |
| `src/bot/rate-limit.ts` | Coalescing `MessageEditor` + 429 backoff. |
| `src/bot/approvals.ts` | Approval sweep, cards, click handling, authorization. |
| `src/bot/voice.ts` | Detection, bounded download, transcription, error copy. |
| `src/bot/authorize.ts` | Allow-list policy (closed by default). |
| `src/bot/copy.ts` | All user-facing wording, pure and testable. |

## Tests

```powershell
node "$env:LOCALAPPDATA\node\corepack\v1\pnpm\11.19.0\bin\pnpm.cjs" --filter @operant/bot run test
```

No gateway is opened and no network is used. What each file proves:

| Test | Proves |
| --- | --- |
| `test/routing.test.ts` | A plain message produces exactly one `POST /v1/requests` with the right body and bearer; the reply is posted before that call; a long job does not block `handleMessage`; an unauthorized user makes **zero** API calls; no allow-list refuses everyone; `/status` creates nothing; empty content explains `MESSAGE_CONTENT`; an API outage gets a clear message and the next message still works. |
| `test/conversation.test.ts` | `conversationId` is a stable function of the channel/thread; turns are remembered and failures never become context; a follow-up carries the prior outcome in `text`; another channel does not inherit it; restart hydration works. |
| `test/voice.test.ts` | Detection across extensions/mime types; download → exact base64 reaches `/v1/voice/transcribe`; the transcript is posted and becomes the request text; oversize is refused before download; failed/empty transcriptions never submit a request. |
| `test/approvals.test.ts` | Pending approval → one embed with two buttons; click → `POST /v1/approvals/:id/decide` with the clicker's identity; card edited, buttons removed; unauthorized clicker makes no API call; 409 is absorbed; foreign components and bot clicks ignored. |
| `test/event-stream.test.ts` | SSE events edit one message with **no more than one edit per interval** (measured on recorded timestamps, burst coalesced); `job_done` yields the completed copy; a failure shows its reason; polling fallback runs when SSE is unavailable; 429 `retry-after` is honoured; the parser survives chunk splits and keepalive comments. |
| `test/startup.test.ts` | Missing token exits 1, names `DISCORD_BOT_TOKEN`, calls no network, never throws; `--check` reports config ok / API reachable / token missing and exits 1; exits 0 with a token; unreachable and unauthorized APIs exit 1; production refuses dev fallbacks; a rejected login exits 1; a clean start wires handlers and returns 0. |
| `test/config.test.ts` | Dev fallbacks only outside production; all problems collected at once; allow-list parsing; intents are exactly 641 and exclude `MESSAGE_CONTENT`; the four activity states are distinct; copy stays under Discord's limit. |

## What is NOT verified here

There is no real bot token, so the following are **implemented and unit-tested
against mocks, but never exercised against Discord**:

- Gateway login, `ClientReady`, and receipt of real `MessageCreate` /
  `InteractionCreate` events.
- Real REST edit latency and Discord's actual rate-limit behaviour (the 429 path
  is tested with a synthetic `retryAfter`).
- Attachment CDN downloads from `cdn.discordapp.com`, and whether a given client
  icon/UI renders the embeds and buttons as intended.
- That the developer portal has `MESSAGE_CONTENT` enabled for this application.
- End-to-end voice: the speech service may be absent; the bot's failure copy is
  tested, its success path is tested against a mocked `/v1/voice/transcribe`.
- End-to-end agent work: `POST /v1/requests` against the live control plane is
  reachable and authenticated (see `--check`), but this suite never starts a real
  DSH job.

Known gaps, stated plainly:

- The control plane accepts `conversationId` but does not persist it yet
  (`createTaskWithJob` stores no conversation). Continuity therefore relies on the
  bot's in-process store plus the synthesised context block. Once the API stores
  it, `ConversationStore.hydrate` is the hook for restart recovery.
- Approvals are swept only for tasks this process started; approvals for tasks
  created before a restart are not re-posted.
- Non-audio attachments are not ingested (the request contract wants a storage
  `ref` the bot cannot mint). Only voice is forwarded.
- DMs are not supported: `Partials` are not requested, so DMs and uncached
  channels are ignored rather than half-handled.
- If an edit fails for a non-429 reason the last state is retried at the normal
  cadence; after repeated failures the message may lag behind the job (logged).