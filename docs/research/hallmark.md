# Hallmark — repo facts, install plan, and how it lands in DSH

Sources fetched (all HTTP 200, 2026-11-15, `main` branch, raw + GitHub API):
<https://github.com/Nutlope/hallmark> · `raw.githubusercontent.com/Nutlope/hallmark/main/README.md` · `.../skills/hallmark/SKILL.md` · `.../skills/hallmark/scripts/install.mjs` · `.../skills/hallmark/scripts/sloplint.mjs` (head) · `.../skills/hallmark/scripts/sloplint-render.mjs` (head) · `.../package.json` · `.../references/themes/dusk.md` · GitHub contents API for `skills/hallmark`, `references`, `references/themes`.
Local, read-only: `C:\Users\Darsh Gupta\.dsh\skills\`, `...\.agents\skills\`, and `@deepseek-ai\dsh-skill-filesystem\lib\index.js`.

Verdict up front: **installable — but not by the documented one-liner.** No documented target is DSH. DSH needs a directory copy into a root it scans; both the shape and the roots are verified below.

## Provenance ledger

| Claim | Verified how |
| --- | --- |
| repo layout, file sizes, theme count/format | GitHub contents API + raw fetches |
| install procedure, harness table, Node ≥18, puppeteer-core+Chrome for browser checks | README.md (fetched) |
| install.mjs targets, payload list, validation gates | install.mjs source (fetched in full) |
| sloplint flags, "zero dependencies, Node 18+" | sloplint.mjs first 3.5 KB (fetched) |
| render tier launches real Chrome, 8 widths | sloplint-render.mjs first 2.2 KB (fetched) |
| **DSH skill roots + bundle shape** | `dsh-skill-filesystem/lib/index.js` lines 160–198, 564, 570 (read locally) |
| `~/.dsh/skills/<name>/SKILL.md` shape works today | `~/.dsh/skills/agent-swarm-orchestration/SKILL.md` inspected |
| `npx skills add` behaviour for a non-listed harness | **not verified** — inferred from install.mjs having no DSH target |
| whether Hallmark's description fires on a dashboard prompt | **not verified** |

## Repo layout (abbreviated)

```
hallmark/
├─ README.md
├─ package.json          name hallmark, version 2.0.0, "type":"module",
│                        "files":["skills"], skill.entry skills/hallmark/SKILL.md,
│                        skill.harnesses [claude-code, codex, cursor, opencode]
├─ site/                 marketing site (OG-hallmark.png)
├─ docs/screenshots/     one jpg per theme
└─ skills/hallmark/      ← the skill; the package ships only this subtree
   ├─ SKILL.md           18,239 B   ← the whole protocol (Floor + Flow 0–7)
   ├─ LICENSE            MIT
   ├─ agents/            harness-side agent prompts (dir present, contents not enumerated)
   ├─ references/        ~26 files, all markdown
   │  ├─ gates.md 39,061 B   ← gate ids/tiers; §1–§4 load at build, §5–§6 at sweep
   │  ├─ craft.md 19,279 · layout.md 16,258 · flow.md 16,750 · macrostructures.md 14,614
   │  ├─ imagery.md 14,343 · redesign.md 12,231 · patterns.md 10,928 · direction.md 7,525
   │  ├─ anatomy.md 7,037 · comp.md 7,669 · export-formats.md 6,294 · interaction-and-states.md 6,034
   │  ├─ microinteractions.md 6,484 · scroll-choreography.md 6,099 · texture.md 6,082
   │  ├─ fonts.md 5,302 · dark-mode.md 3,919 · brand-truth.md 3,685 · responsive.md 3,504
   │  ├─ data-viz.md 3,398 · design-md.md 3,061 · review-finish.md 3,865 · review-hero.md 2,548
   │  ├─ genres/            (genre files: editorial, modern-minimal, atmospheric, playful)
   │  ├─ macrostructures/   (per-shape files)
   │  └─ themes/            README.md + 50 × (<slug>.md + <slug>.jpg)
   └─ scripts/
      ├─ theme.mjs 59,476        deal | draw | scaffold | photos | log | index | validate
      ├─ sloplint.mjs 231,740    static gate checker + --render hand-off
      ├─ sloplint-render.mjs 99,965   Chrome screenshots at 8 widths
      ├─ refcheck.mjs 24,529     reference/theme integrity
      ├─ capture.mjs 9,659       screenshots of a URL / dev server / app
      ├─ picture.mjs 6,423 · imagegen.mjs 4,165 · install.mjs 6,073
      ├─ install-hook.mjs 3,075 (Claude Code edit-time Floor check) · lint-hook.mjs 2,603
      ├─ photos.json 452,868    755 Wikimedia photos, metadata only (no image files)
      ├─ fixtures/               (skipped by install.mjs when copying)
      └─ *.test.mjs              capture / theme / sloplint-render / reroll-exhaustion
```

### Required directory shape

`<skill-root>/<name>/SKILL.md` with YAML frontmatter. Hallmark's frontmatter is exactly:

```yaml
---
name: hallmark
description: "Design skill for websites and new pages that look designed, not generated. Use when the user asks to build or design something new, or names Hallmark. Never use it on an existing design unless the user names Hallmark, as in `/hallmark redesign <path>`."
argument-hint: "<prompt> | redesign <path> | audit <path>"
version: 2.0.0
metadata:
  opencode/slash: "true"
---
```

Everything else (references, scripts) is resolved **relative to the SKILL.md's folder** (`<skill-dir>/scripts/...`), so the folder must be copied whole — a bare SKILL.md is useless.

## The exact DSH path (verified from DSH source)

`…\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js`, `roots(cwd)`:

```
project  <projectRoot>/.dsh/skills        source "project-dsh"
project  <projectRoot>/.agents/skills     source "project-agents"   rank 200
custom   <configured dirs>                source "custom"
user     <dshHome>/skills                 source "user-dsh"         skipSystem
user     <agentsHome>/skills              source "user-agents"      rank 500
bundled  <bundled skill dir>              source "bundled"
```

and the discovery predicate: a bundle is `<root>/<name>/SKILL.md` (`segments.length === 2 && segments[1] === "SKILL.md"`), while a **flat** `<root>/<name>.md` is also accepted.

Therefore:

**Primary target (recommended, matches your stated shape — confirmed to exist and to be live):**
`C:\Users\Darsh Gupta\.dsh\skills\hallmark\SKILL.md`

Confirmed working exactly this way: `~\.dsh\skills\agent-swarm-orchestration\SKILL.md` is the only bundle in that root today and it *is* in the session's skill catalog.

**Secondary target (also scanned by DSH, and the one Hallmark's own installer writes for Codex):**
`C:\Users\Darsh Gupta\.agents\skills\hallmark\SKILL.md` — verified: that folder exists and holds 7 bundles (codex-cli-calling, grok-cli-calling, hermes-cli-calling, kimi-cli-calling, memory-consolidate, plan-execute-validate-hotfix-swarm, ruflo), all 7 of which appear in this session's skill catalog. So `~\.agents\skills` is genuinely a DSH discovery root, just lower-ranked than `~\.dsh\skills`.

Note `~\.claude\skills` exists too, but **Claude Code's `~/.claude/skills` is not in DSH's root list** — don't rely on it.

Installing to `~\.dsh\skills` keeps Hallmark DSH-scoped and highest-ranked; installing to `~\.agents\skills` makes one copy serve Codex, Cursor and DSH. Neither is a documented Hallmark target — both are DSH behaviour, verified above.

## Install plan (numbered, NOT executed)

Assumes Node present (verified: `C:\Program Files\nodejs\node.exe`, v24.10.0) and Chrome present (verified: `C:\Program Files\Google\Chrome\Application\chrome.exe`).

```powershell
# 0. variables
$src   = "D:\CodeProjects\operant\.hallmark-src"
$skill = "$env:USERPROFILE\.dsh\skills\hallmark"

# 1. shallow clone (git is at D:\Git\cmd\git.exe if not on PATH)
& "D:\Git\cmd\git.exe" clone --depth 1 https://github.com/Nutlope/hallmark.git $src

# 2. validate the payload the way the project does (refs + all 50 themes)
node "$src\skills\hallmark\scripts\refcheck.mjs" --errors
node "$src\skills\hallmark\scripts\theme.mjs" validate "$src\skills\hallmark\references\themes\*.md"
# (or skip both: node "$src\skills\hallmark\scripts\install.mjs" --dry-run  prints what it would copy)

# 3. install into DSH's native, highest-ranked user root
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse -Force "$src\skills\hallmark" $skill

# 4. verify the bundle shape + frontmatter the way DSH reads it
Get-Content "$skill\SKILL.md" -TotalCount 8
Test-Path "$skill\references", "$skill\scripts\sloplint.mjs", "$skill\references\themes"

# 5. verify the toolchain runs from the installed location
node "$skill\scripts\sloplint.mjs" --help

# 6. optional browser tier (only for --render / screenshots / --url)
npm i -g puppeteer-core

# 7. optional: remove the clone
Remove-Item -Recurse -Force $src
```

Alternative (uses Hallmark's own installer, which validates then atomically swaps the directory, writing to `~\.agents\skills\hallmark`):

```powershell
node "$src\skills\hallmark\scripts\install.mjs" --codex      # → %USERPROFILE%\.agents\skills\hallmark
node "$src\skills\hallmark\scripts\install.mjs" --codex --dry-run   # rehearsal
node "$src\skills\hallmark\scripts\install.mjs" --remove      # uninstall every known location
```

`install.mjs` copies `PAYLOAD = ["SKILL.md","LICENSE","references","scripts","agents"]`, skipping `.DS_Store`, `.hallmark`, `node_modules`, `fixtures`, and any symlink — it refuses to install if `refcheck --errors` or `theme.mjs validate` fails unless `--force`. It detects harnesses by the presence of `~/.claude`, `~/.codex|~/.agents|~/.cursor`, `~/.config/opencode`, and has **no DSH branch at all**.

Do **not** use `npx skills add nutlope/hallmark -g` as the primary route here: it targets Claude Code / Codex / Cursor / OpenCode only, so it would either no-op for DSH or install to `~/.agents/skills/hallmark` (which DSH *does* read — that side effect is the one reason it would still work).

**Activation:** DSH's skill provider installs filesystem watchers, so a new bundle may be picked up live; if it does not appear in the catalog, start a new session. There is **no `/hallmark` slash command in DSH** — the skill is invoked by naming it or by the model matching its `description`; `argument-hint` and `metadata.opencode/slash` are inert here.

## Documented design process (in order, from SKILL.md "Flow")

0. **Pre-flight** — read the project before asking anything: `design.md`/`DESIGN.md` at root (locked system, overrides everything), `.hallmark/brand-spec.md` or a named real brand, the project's fonts/palette/spacing/motion/framework, a URL or dev server to capture, an Inspo MCP server, `TOGETHER_API_KEY`. Output one cached block to `.hallmark/preflight.json`.
1. **Ask once** — one message: material (what the page can show), audience, the one action the page drives, tone (an extreme: editorial / brutalist / soft / utilitarian / luxury / playful / technical / austere), plus vibe in 4–8 words and an anchor colour. Skipped fields are opt-outs; **facts are never inferred** (a number, quote or logo not given is absent).
2. **Shape** — material inventory (*real / pictures / absent*), name the visitor's job and read it in `anatomy.md`, choose one of 21 shapes in `macrostructures.md`, then `theme.mjs draw` deals the page anatomy. **Mirror test:** if a neighbouring prompt in the same category would get this exact combination, change one decision.
3. **Direction** — first match wins: user-named theme → build it; user said "custom/bespoke/derive it" → `direction.md`, free design; otherwise `theme.mjs deal` offers three themes, pick by material and load only that one theme file.
4. **Load** — exactly: `layout.md`, `anatomy.md` (the job's part), `imagery.md`, `craft.md`, `genres/<genre>.md`, `themes/<slug>.md` + its picture, `gates.md` §1–§4. Everything else is on-demand only.
5. **The Picks block** — the run's single recital of decisions (Shape / Theme / Chrome / Hero / Signature / Sections / Material / Sweep), which doubles as the user's redirect window.
6. **Build** — `theme.mjs scaffold <slug>` writes `tokens.css` + `base.css`; read `patterns.md` once; **hero first**, lint it, get a fresh-context hero review, then the rest. One idea per screen: ≤7-word headline, ≤12-word sentence, 6–9 sections, ≤450 visible words. Stamp line 1 of the CSS. Log to `.hallmark/log.json`.
7. **Sweep** — `sloplint --render` until clean, walk `gates.md` §5, fresh-context finish review (act on its first word: `recapture` / `rebuild` / `fix` / `ship`), close with the material ask, update the Picks block with the real outcome. "A fabricated pass is itself slop."

Verbs, only when the user names Hallmark: `redesign <target>` (keeps content and wiring) and `audit <target>` (report only).

## sloplint

**What it is:** the mechanical gate checker — a single-file, **zero-dependency, Node ≥18** script (231 KB) that statically parses `.html`/`.css` **and** `.jsx/.tsx/.vue/.svelte/.astro` (Tailwind class strings, `cn/clsx/cva` calls), and enforces the gate ids in `gates.md`. It is *not* a browser tool by itself.

```powershell
node <skill-dir>\scripts\sloplint.mjs <file-or-dir ...> [--genre editorial|modern-minimal|atmospheric|playful] `
  [--scope page|component|app] [--stage hero|page] [--json] [--render] `
  [--url http://localhost:3000] [--tier floor] [--before | --kept]
```

Behaviour verified from source: `--url` implies `--render`; `--before` records links/fields/handlers/headings to `.hallmark/before.json` (+ screenshots) and `--kept` fails a redesign that dropped one; `--before` and `--kept` are mutually exclusive; it skips `node_modules`, `dist`, `build`, `coverage` and dot-folders; unknown flags exit 2.

**Does it need a browser?** Only for the render tier. `sloplint-render.mjs` shells out to a **real installed Chrome/Chromium** from a hardcoded list that includes the Windows path `C:\Program Files\Google\Chrome\Application\chrome.exe`, and screenshots **`[320, 375, 414, 768, 1024, 1280, 1440, 1920]`**. The README says that tier also needs `npm i -g puppeteer-core`; the static tier runs with Node alone. It does **not** ask for Playwright. On this machine Chrome is present at exactly that path (verified); `puppeteer-core` is not verified installed.

Invocation in practice: `sloplint --render` for a page, `--stage hero` for the hero-only pass, `--url http://localhost:<port>/<route>` inside a framework project with the dev server up.

## Themes / tokens

Yes, and the format is unusually concrete: **50 themes, each one markdown file ≤8 KB plus a `.jpg` picture of a finished page**, under `references/themes/`. The file is YAML frontmatter (`name, slug, genre, paper, display, accent, posture, keywords, material, photo, pictured`) + a body with the sections `## Tokens` (a real `:root { … }` CSS block in **oklch**), `## Type`, `## Surfaces`, `## Range`, `## Controls`, `## Motion`, `## Voice`, `## Do-nots`, `## Build hint` (Google-Fonts `<link>` + hero/button/glass CSS). Verified against `dusk.md` in full. It is **not** a W3C/Design-Tokens `.json` file, and there is no Tailwind config — tokens are plain CSS custom properties emitted by `theme.mjs scaffold`.

## Dependencies

| Need | Required for | Status here |
| --- | --- | --- |
| Node ≥18 | everything | verified: v24.10.0 |
| Chrome (or Chromium) | `--render`, `--url`, `capture.mjs`, screenshots | verified present at the Windows path in sloplint-render's list |
| `puppeteer-core` (global, per README) | browser tier | **not verified installed** |
| `TOGETHER_API_KEY` | optional comps / `imagegen.mjs` | unknown; not needed for a normal build |
| Inspo MCP server | optional signal 8 in pre-flight | not present in this session |
| Network at build time | Google Fonts links, Wikimedia photo URLs | available |

No `npm install` inside the skill, no lockfile, no build step.

## Risks / unknowns

- **No DSH support is documented.** The one-liner does not know DSH exists; the copy step is ours and must be re-done on every Hallmark upgrade (there is no version pin in DSH).
- **Payload size**: ~1.3 MB of skill (231 KB + 100 KB scripts, 450 KB photos.json, 23 references, 50 themes ×(md+jpg)) — fine on disk, but `references/themes/*.jpg` and `photos.json` are dead weight unless themes are dealt.
- **Path with a space**: `C:\Users\Darsh Gupta\...` — every `node <skill-dir>/scripts/...` invocation must be quoted; unquoted copies will break.
- **The Floor is opinionated** and its rule 15 mandates a **Hallmark stamp as the first non-empty line of the CSS source**. Applying Hallmark inside an existing system (Operant has one) will collide with that system's own conventions; SKILL.md says a locked `design.md` overrides everything, and that a non-named change to an existing design "is not a Hallmark run".
- **Scope guard in its own description**: "Never use it on an existing design unless the user names Hallmark." Expect it to stay quiet unless asked by name — which is also why the copy is low-risk.
- **DSH has no slash command**; the `argument-hint` and `opencode/slash` metadata are inert. Invocation is by name or by description match.
- **`.hallmark/` state directory** is created inside the target project (`preflight.json`, `log.json`, `before.json`, screenshots). Decide whether that should be gitignored.
- **Unverified**: whether `npx skills add` would fail or silently install to `~/.agents/skills`; whether the watcher hot-loads a newly copied bundle without a new session; whether the frontmatter `description` alone is enough for DSH to select Hallmark on a "build me a dashboard" prompt; the contents of `agents/`; whether `theme.mjs`/`refcheck.mjs` run clean on Windows (they use POSIX-ish paths but are `node:path`-based and `install.mjs` handles Windows via `path.join`).