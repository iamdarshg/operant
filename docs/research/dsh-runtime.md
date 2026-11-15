# DSH runtime contract — verified technical brief

Provenance: `@deepseek-ai/dsh` **0.2.2-rc.1** installed at
`C:\Users\Darsh Gupta\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`;
host Node **v24.10.0**. Everything below was read from that installed source or
observed with `dsh --profile web --dump-config` on 2026-11-15. No model call was
spent; `.dsh` was only read, never written.

Files actually read (all paths under the install root above unless noted):

| Path | What it establishes |
|---|---|
| `node_modules/@deepseek-ai/dsh-mcp-client/README.md` | config fields, naming, coexistence, reconnect semantics |
| `node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js` | zod `Config` union L781–801 — the real field set |
| `C:\Users\Darsh Gupta\.dsh\profiles\web\cordis.patch.yml` | live profile patch (633 lines, top-level array) |
| `lib/profile-boot-e2mS45fC.js` | layer order, `--patch` plumbing |
| `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` L505–555 | `applyPatches` — *why* a patch entry can be dropped |
| `lib/bin.js` L27–105 | `--patch` is repeatable, applied last |
| `node_modules/@deepseek-ai/dsh-headless/lib/json-stream-Dc3g2Bl1.js` | **every** `--json` event shape |
| `node_modules/@deepseek-ai/dsh-headless/lib/startup.js` | exact CLI flags and validation |
| `node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` L858–921 | path encoding for sessions |
| `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts` L170–216 | `TurnEndReason` union |
| `node_modules/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` | host-vs-preset placement, official insert idiom |
| `node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml` | shipped MCP patch template |

---

## 1. Registering an MCP server in a DSH profile

### 1.1 What a patch file is

`cordis.patch.yml` (and any `--patch` overlay) is **a top-level YAML array of
patch entries**. Each entry is one of exactly two kinds, per `applyPatches`:

```yaml
# (A) override an entry that already exists in the composed tree
- id: <existing-row-id>     # required
  name: <optional guard>   # if present and ≠ target's name → entry skipped with a warning
  config: {...}            # merged key-by-key onto the existing entry
  disabled: true

# (B) insert new entries
- id: <group-id>           # optional; omitted → appended at the ROOT list
  insert: [ {id, name, config}, ... ]
- insert: [ {...} ]         # root append, no target group
```

`applyPatches` (`dsh-app-boot/lib/index.js` L516–553) destructures
`{ id, insert, name, ...overrides }`. For a non-insert patch with an `id` that
is **not** in the composed tree it calls `warn("patch: entry %C not found")` and
`continue`s — the row is **silently absent**.

### 1.2 The exact snippet (verified by composition, not by assumption)

Append to `C:\Users\Darsh Gupta\.dsh\profiles\web\cordis.patch.yml`, or put it in
its own overlay file and pass `--patch`:

```yaml
- insert:
    - id: mcp-ins-test2
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: instest2
        transport: streamable-http
        url: http://100.64.0.5:8765/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

A plugin instance is therefore: `id` (Loader row identity — unique within the
list it lives in; the same id legitimately recurs inside different presets, e.g.
`domain-mcp` appears once per uiux/cyber preset in this profile's tree),
`name` (the package to mount — the npm package name or a profile-local name like
`dsh-soul-md`), and `config` (that package's own Config schema).

Verified result (`--dump-config` output, end of the root list):

```
- id: mcp-ins-test2
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: instest2
    transport: streamable-http
    url: http://100.64.0.5:8765/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

The negative control matters: the identical entry **written without `insert:`**
composed to nothing and printed

```
dsh: [...\ov-bare.yml] patch: entry "mcp-bare-test" not found
```

with zero occurrences of the row in the dumped tree. So *"add a row with a new
id"* is not a supported patch form — only `insert` adds rows.

### 1.3 Two instances of the same plugin

Two instances coexist by differing in **`id`** (tree identity) and **`serverName`**
(MCP namespace). The namespace must be unique *inside one registration scope*,
and a duplicate throws at activation:

> `mcp-client: serverName "X" is already in use by another mcp-client instance`
> (`dsh-mcp-client/lib/index.js` L819)

A live worked example is already in this profile's composed tree — the `cyber`
agent preset mounts two `dsh-mcp-client` rows side by side:

```
      - id: domain-mcp            name: '@deepseek-ai/dsh-mcp-client'
        config: {serverName: cyber-tools, transport: stdio, command: C:\Program Files\nodejs\node.exe, ...}
      - id: context-memory        name: '@deepseek-ai/dsh-mcp-client'
        config: {serverName: cyber-memory, transport: stdio, command: python, ...}
```

Tools surface as `mcp__<serverName>__<rawName>`, so `cyber-tools` and
`cyber-memory` never collide even if both expose `search`.

**Placement matters.** Host-level rows (root of the list, as in §1.2) are
profile-wide. Rows inside a `preset-<id>` declaration
(`name: '@deepseek-ai/dsh-agent-preset'`, `config.plugins: [...]`) exist only in
sessions that selected that preset. Root-append is the right choice for "this
laptop should reach the remote MCP server everywhere"; preset-internal insert
(`- id: preset-cyber` + `insert:`) is the right choice for "only the cyber
persona". Note that overriding a preset replaces its **whole** `config`, so
never "edit" a preset to add one row — insert into a root-level or own bundle
row instead.

### 1.4 Layer order and where `--patch` sits

`composeProfile` / `runProfile` (`lib/profile-boot-e2mS45fC.js` L225–248):

1. bundle layers, in `package.json` → `dsh.profile.bundles` order
2. the profile's own `$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml` — home-level, **outranks** the per-profile layer
   (absent on this machine: `Test-Path` → `False`)
4. each `--patch <path>` overlay, in argv order
5. the telemetry switch

`--patch` is a repeatable single-value collector (`lib/bin.js` L27–28),
applied **after** every other layer, so an overlay wins and the profile's own
patch file is never touched. Relative paths resolve against the process cwd.
`--patch` is refused together with `--dump-default-config`.

Safe practice used by this machine already: keep overlays in
`C:\Users\Darsh Gupta\.dsh\overlays\` (e.g. the existing
`no-broken-plugins.yml`) and boot with
`dsh --profile web --patch "$env:USERPROFILE\.dsh\overlays\<file>.yml"`.
Because patch layers are additive lists, an overlay that only inserts one row
cannot disturb existing entries: for a root insert `applyPatches` does exactly
`data.push(...clone)` and then only adds the new entries to its id map — no
other entry is read, moved, or rewritten.

One methodological warning: **do not try to prove this with a line diff of two
`--dump-config` outputs.** The emitter's block-scalar wrapping is not stable
between runs (the same long `path:` value appeared as `path: >-` in one dump and
inline in the next), so a naive `Compare-Object` reports hundreds of spurious
differences. Compare the set of row ids, or grep for the specific ids you care
about.

---

## 2. Headless execution contract

### 2.1 Flags (parsed by `dsh-headless/lib/startup.js` L36–45)

The command is `dsh --profile headless …`; the one-shot runner is the headless
profile's app.

| Flag | Meaning (verbatim behaviour from source) |
|---|---|
| `[task...]` | task text; multiple words joined by spaces; `-` alone reads stdin; blank positional is a usage error |
| `--json` | NDJSON run events on stdout instead of the final message |
| `--session-id <id>` | adopt the persisted Session with this id; unknown id → error before any work |
| `--permission-mode <preset>` | select a configured permission preset for this run, including on resume |
| `--approval-policy <ask\|never>` | `choices([...APPROVAL_POLICIES])`; `APPROVAL_POLICIES = ['ask','never']` (`dsh-user-approval/lib/index.js` L37). `never` rejects anything needing a human |
| `--add-dir <path>` | repeatable; each must be absolute (`isAbsolute`) and NUL-free; de-duplicated via `new Set`. Requires the sandbox-policy row to include `headlessStartup.additionalWritableRoots` or the run is rejected |

`--help` prints the app help and exits without running. Diagnose a hung
terminal invocation as "it read stdin": `dsh headless --help` with a pipe that
never closes waits for a task. This is operator experience, not documented
behaviour.

### 2.2 The actual NDJSON shape

Determined **statically** from `dsh-headless/lib/json-stream-Dc3g2Bl1.js`
(`projectJsonRun`) — no live paid run needed. Every line is one JSON object with
a `type` discriminator:

| `type` | Fields | Emitted when |
|---|---|---|
| `session` | `sessionId`, `cwd` | first line, before the subscription starts |
| `status` | `phase: 'turn_start' \| 'step_start' \| 'step_end' \| 'turn_end'`, `turn`, `step?`, `reason?`, `usage?` | on `turn/start`, `step/start`, `step/end`, `turn/end` |
| `thinking` | `text` | one line per committed `reasoning` content block |
| `text` | `text` | one line per committed `text` content block |
| `tool_call` | `callId`, `tool`, `input` | on `tool/call`; `input` is parsed JSON, `{}` for empty args, raw string if unparseable |
| `tool_result` | `callId`, `status: 'completed' \| 'error'`, `result`, `error?` | on appended `tool/result` only (`surfaceOp !== 'append'` is dropped) |
| `final` | `sessionId`, `reason`, `text` | last line; `reason` is the durable `TurnEndReason` or `null` |
| `error` | `message` | only for failures *outside* a turn (usage errors, unusable `--session-id`, driver failure); stream ends **without** `final` |

Details that bite a backend:

- `status.usage` on `step_end` is present only when **every** attempt in the step
  reported usage (`addUsage` marks the sum incomplete otherwise and the field is
  dropped rather than published as a partial sum). Fields: `inputTokens`,
  `outputTokens`, and optionally `totalTokens`, `cacheReadTokens`,
  `cacheWriteTokens`, `reasoningTokens`.
- `text`/`thinking` are **commit-point** projections, not token deltas: a retried
  or discarded attempt never appears. Default (non-`--json`) mode is the only
  live text channel and it goes to stderr under `dsh: reasoning:`.
- Bounds: every string and object key capped at **8 KiB** (`maxStringBytes`
  default 8192) with `truncated: true` added; one line + newline capped at
  **32 KiB**; over-long lines keep scalars, drop structured fields, and at the
  extreme reduce to `{type, truncated}`; containers deeper than 64 levels are cut.
  The terminal `final` is exempt and unbounded.
- A well-formed stream can still describe a failure: check the **process exit
  code** and `final.reason.kind`, not the presence of `final`.
- `TurnEndReason.kind` ∈ `completed | aborted | blocked | error | max-tokens |
  interrupted | forked` (`dsh-session/lib/types/types.d.ts` L170–214). Exit 0
  only for a completed final `turn/end`; everything else exits 1.

`requires one live run`: nothing in this section. The shapes above are read from
the projection code, so a live run is only needed to see real *values*.

---

## 3. Session persistence and resume

### 3.1 Root

Composed row (from `--dump-config`):

```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
```

→ root is `C:\Users\Darsh Gupta\.dsh\sessions`, `compression` defaults to `zstd`.

### 3.2 Path pattern

```
<root>/--<project-key>--/<encoded-session-id>/session.v<N>.jsonl.zstd
```

- `projectKey(cwd)` (`…jsonl/lib/index.js` L880–899): each `/`, `\` or `:`
  becomes one `-` (runs collapsed); `[A-Za-z0-9._-]` stays literal; everything
  else becomes `~XXXX` (uppercase 4-digit hex, code units); wrapped in `--…--`;
  first 251 chars kept. `cwd === undefined` → `_no-cwd/`.
- `encodeSegment(id)` (L858–870): same escape rule, `.` → `~002E`,
  `..` → `~002E~002E`; alphanumerics, `.`, `_`, `-` stay literal. So a normal
  UUID or `session-<uuid>` id maps to a **directory name identical to the id**.
- Current generation is `session.v4.jsonl.zstd`; the reader selects the
  numerically highest canonical generation and supports v0–v3 migration. With
  `compression: 'none'` the same file is plain newline-delimited text.

Observed on this machine: `--C-Users-Darsh~0020Gupta--/4aaf9240-48ba-4931-9cbb-fb5bbc0e885f/session.v4.jsonl.zstd`
(the space in `Darsh Gupta` becomes `~0020`).

### 3.3 Resuming after a restart

- Read `sessionId` from the **opening `session` event** (or `final.sessionId`),
  persist it, and later run the same command from the **same cwd** with
  `--session-id <id>`.
- Adoption is refused (and the run fails before the task) when: no such Session;
  the Session recorded a different working directory; it recorded no cwd; it is
  a subagent session; it runs under a preset this profile does not compose or
  whose preset record is malformed; or an Agent is already live under that id in
  the process.
- Adoption requires the composed `sessionPersistence` **and** `sessionQuery`
  services — a profile missing either fails loudly rather than handing back an
  id whose history dies with the process.
- Grants are not sticky: re-supply `--permission-mode`, `--approval-policy` and
  every `--add-dir` on resume.
- Crash semantics: committed events survive; an interrupted final turn is closed
  by synthetic `turn/end {reason: {kind: 'interrupted'}}` on the next write, so a
  backend that sees `interrupted` may legitimately re-drive that turn.

---

## 4. Reaching a remote Streamable-HTTP MCP server over Tailscale

### 4.1 What `StreamableHttpConfig` actually accepts

The streamable branch of the zod union (`dsh-mcp-client/lib/index.js` L792–801):

| Field | Type / default | Notes |
|---|---|---|
| `transport` | const `'streamable-http'` | required |
| `serverName` | string, `/^[A-Za-z0-9_-]{1,32}$/` | required; tool namespace |
| `url` | string | required; any absolute URL |
| `headers` | `Record<string,string>`, default `{}` | the **only** auth surface |
| `toolCallTimeoutMs` | number, default `60000` | per `tools/call` / resource request |
| `failOnStartupError` | boolean, default `false` | `true` → reject plugin activation |
| `maxInstructionBytes` | number ≥1, default 32768 | oversized server instructions reject the connection |
| `reconnect` | `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}` | backoff doubles; budget resets after a stay-up longer than `maxDelayMs` |

The transport is constructed as
`new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`
(`lib/index.js` L46). Consequences to design around:

- **No OAuth, no token field, no mTLS options, no per-server proxy knob.**
  If the endpoint needs a bearer token, an API key, or a shared secret, it must
  be expressed as an entry in `headers`.
- `!!js` expressions are allowed in patch files and are evaluated at plugin
  activation, so a secret can stay out of the file:
  `Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'` — verified to compose
  and to be preserved verbatim in the dumped tree.
- Process-wide HTTP proxying comes from environment (`installProxyFromEnvironment`
  in `lib/profile-boot-e2mS45fC.js`), not from this config.
- `env` scrubbing is stdio-only, so header values are whatever you write.

### 4.2 Tailscale-specific notes

Tailscale gives network identity, not application auth; the MCP server still
needs its own check (a header secret) because `100.64.0.0/10` peers and anyone on
the tailnet can reach the port. Use the MagicDNS name or the `100.x.y.z` address
directly in `url` — DSH needs nothing Tailscale-aware. `tailscale serve` can
front the port with a real certificate, which is worth doing if the URL crosses
an untrusted hop. Recommended header set is one secret plus nothing else; add
`Accept: application/json, text/event-stream` only if the server rejects
negotiation.

### 4.3 Additive configuration, existing registrations preserved

Laptop side — one overlay file, one inserted row, zero edits to existing rows:

```yaml
# %USERPROFILE%\.dsh\overlays\remote-mcp.yml
# Boot: dsh --profile web --patch "%USERPROFILE%\.dsh\overlays\remote-mcp.yml"
- insert:
    - id: mcp-remote-tailscale
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: remote
        transport: streamable-http
        url: http://desktop.tailnet-name.ts.net:8765/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.MCP_SHARED_SECRET}`'
        failOnStartupError: true
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true
          maxAttempts: 5
```

Why this is safe: the overlay is a new layer on top of the profile; `insert`
appends to the root list; no existing row id is named, so no existing
registration (`domain-mcp`, `context-memory`, any `mcp-resources`) can be
replaced, disabled, or reordered. Checked against the dumped tree: with the
overlay applied the composed tree gained the new row at the end of the root list
and every pre-existing id (`session-persistence-jsonl`, `mcp-resources`,
`domain-mcp`, `context-memory`, `preset-cyber`, …) was still present.

Two failure modes to watch:

1. `failOnStartupError: true` turns a Tailscale outage at boot into a load
   error for that row. `app-boot`'s startup policy still lets an optional MCP
   entry fail without aborting the harness, but the model then sees no
   `mcp__remote__*` tools. Prefer `false` with reconnection for a laptop that
   roams.
2. A `serverName` clash with an existing row throws at activation and that
   instance's tools never appear — pick a namespace no other row uses.

---

## 5. Verification log

| Check | Command | Result |
|---|---|---|
| baseline composition | `dsh --profile web --dump-config < nul` (stdin from NUL) | exit 0, 198,194 bytes, 5,105 lines |
| bare entry rejected | `--patch ov-bare.yml` | `patch: entry "mcp-bare-test" not found`, 0 rows |
| insert accepted | `--patch ov-insert.yml` | no warnings, row at end of root list |
| `!!js` header preserved | `--patch ov-insert2.yml` | `Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'` |
| session root | grep of dumped tree | `root: !!js dshHomePath('sessions')` |
| session layout | `Get-ChildItem ~\.dsh\sessions\--D-CodeProjects-cfd--` | `<id>/session.v4.jsonl.zstd` |
| version | `package.json` | `0.2.2-rc.1` |

`dsh headless --help` and `dsh --profile headless --help` both blocked on an open
stdin pipe in this environment; the flag set in §2.1 was taken from
`startup.js`, which is the same source that builds the help text.