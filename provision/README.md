# Operant first-boot provisioning wizard

A zero-dependency local web app that walks a human through preparing a fresh
CachyOS (Arch-based) machine for Operant, one screen at a time. It runs on plain
Node 22 with no `npm install`, binds only to `127.0.0.1:8788`, and reports the
real outcome of every command it runs.

The design rule is simple: **never pretend something succeeded.** A failed
command produces a failed step with the command's actual error text. Nothing
auto-advances. Steps that cannot run on the current platform say so and stop;
they do not crash and they do not invent a pass.

---

## Quick start (from this checkout)

```bash
node provision/wizard/server.mjs
# open http://127.0.0.1:8788/
```

Requirements: Node 22 or newer. No package manager, build step, database or
network install is needed to start the wizard itself.

For the installed, auto-starting version:

```bash
./provision/install.sh
```

That one command:

- checks for Node 22+ and a complete source tree;
- copies the wizard to `~/.operant-provision` (mode 700);
- writes `~/.operant-provision/install.json` with the repo URL and checkout path;
- creates `~/.config/systemd/user/operant-provision.service`;
- creates `~/.config/autostart/operant-provision.desktop`, which opens the
  wizard at login **until every non-finish step has passed** (the finish step
  writes `~/.local/state/operant-provision/wizard-finished`);
- enables and starts the user service when a systemd user manager is available.

Use `./provision/install.sh --dry-run` to print the plan without writing
anything. The bootstrap refuses to run as root, because a user service and a
per-user autostart entry belong to the desktop account.

---

## The nine steps

| # | Step | What it actually does | Needs root |
|---|---|---|---|
| 1 | `hardware` | Reads CPU model/cores, RAM, GPU via `/sys` and `lspci`, disks via `lsblk -J`, and the installed Xorg/Wayland sessions. Read-only. | no |
| 2 | `network` | DNS lookups plus HTTPS HEAD requests to GitHub, the npm registry and the DeepSeek API. Read-only. | no |
| 3 | `secrets` | Collects API keys/bearer token in password fields and writes `/etc/operant/secrets.env` atomically, mode `0600`, owner `root:root`. | yes |
| 4 | `packages` | `sudo pacman -S --needed --noconfirm docker git nodejs python ffmpeg keepassxc`, streams output, enables Docker, verifies versions. | yes |
| 5 | `ai-stack` | `npm install -g @deepseek-ai/dsh@0.2.2-rc.1`, enables corepack, activates the repo's pnpm version, clones the Operant repo if absent, `pnpm install`, `pnpm -r --if-present run build`, verifies api/worker artifacts. | yes (global install) |
| 6 | `theming` | Reports the Plasma/KDE session and the Windows-11 route, with exact commands and caveats. **Never changes the theme or runs a third-party script.** | no |
| 7 | `whatsapp` | Explains that there is no official Linux client; installs Flatpak if needed; installs ZapZap (`com.rtosta.zapzap`) as a per-user Flatpak and labels it unofficial. | yes (Flatpak package) |
| 8 | `browser` | Installs Firefox and Brave (native or Brave's official Flatpak), then prints the exact three `ps`/`awk` commands for a RAM comparison on the human's own tabs. | yes |
| 9 | `finish` | Summarises pass/fail/not-run, lists manual work, and prints the command that starts the platform. | no |

### Privileged steps and sudo

The wizard normally runs as your user. For a step that needs root it tries
**non-interactive** `sudo -n` only. It never opens a password prompt in the
browser and never hangs waiting for one. If non-interactive sudo is not
available, the step prints the exact command and changes nothing.

To complete privileged steps in the wizard, stop the user service once and run
the wizard elevated for those steps:

```bash
systemctl --user stop operant-provision
sudo node ~/.operant-provision/wizard/server.mjs
# open http://127.0.0.1:8788/ and run the privileged step
systemctl --user start operant-provision
```

The elevated server still binds only `127.0.0.1`, does not log credential
values, and keeps its state file owned by your desktop user where possible
(`SUDO_USER` is used to identify the human account). Running the server as root
is the exception, not the normal mode.

---

## Server and API

The whole server is `wizard/server.mjs`, using only `node:http`, `node:fs`,
`node:child_process` and friends.

| Endpoint | Purpose |
|---|---|
| `GET /` | Single-page UI. |
| `GET /api/steps` | All step metadata, statuses, streaming output, and server context. No credential values. |
| `POST /api/steps/:id/run` | Starts one step. `409` if another step is already running. |
| `GET /api/health` | `{ ok, pid, uptimeSeconds, startedAt }`. |

**One job at a time.** The server holds a single `activeJob`; concurrent start
requests get `409` rather than racing two `pacman` transactions.

**Streaming.** Child-process stdout/stderr are line-buffered into the step output
as they arrive, and the browser polls `/api/steps` while a step runs. Output is
capped at 1,500 lines / 256 KiB so a pathological build log cannot freeze the
page; the truncation is shown in the UI.

**Commands are argv arrays.** Every command goes through
`spawn(cmd, argv, { shell: false })`. There is no shell string interpolation and
no user-supplied value is ever placed in a shell program. Commands that need
privilege go through `sudo -n` as a separate argv process. Displayed command
lines redact credentials embedded in URLs (`https://***@host/...`).

**Secrets are not state.** The secrets step receives values in a POST body,
validates names against a fixed allowlist and writes the file directly from
Node. It never logs them, never writes them to the state file, and never echoes
them in the response. The UI clears the password fields after a successful
start. The server rejects bodies over 64 KiB and only accepts `application/json`
for the secrets endpoint.

---

## Security posture

- **Loopback only.** `server.listen(8788, '127.0.0.1')` is the only listen call.
  If `PROVISION_HOST`, `PROVISION_BIND`, `PROVISION_ADDRESS`, `HOST`,
  `BIND_ADDRESS` or `PROVISION_ALLOW_REMOTE` suggest anything but loopback, the
  server refuses to start. Socket activation (`LISTEN_FDS`) is also refused.
- **Host and Origin checks.** Requests whose `Host` is not `localhost` /
  `127.0.0.1` / `::1` are rejected, and cross-origin/cross-site requests are
  rejected. This is DNS-rebinding and CSRF defence, not a substitute for the
  loopback bind.
- **CSP and headers.** The UI has no inline script or style. Responses carry
  `default-src 'none'`, `script-src 'self'`, `style-src 'self'`,
  `connect-src 'self'`, `frame-ancestors 'none'`, `nosniff`, and `no-referrer`.
- **Escaped output.** `app.js` builds every line with `textContent` and
  `createElement`. There is no `innerHTML`.
- **No auto-advance.** Every step is an explicit click. A failure stays failed
  on its screen until a later successful run.
- **Theming is report-only.** The wizard does not apply a global theme, does not
  run `cachyos-tweaks`, and does not edit KDE config files. The commands are
  printed for the human to inspect and run.
- **ZapZap is labelled unofficial.** It wraps WhatsApp Web and is not affiliated
  with Meta; pairing an account is the human's decision.
- **The state file is not secret.** `~/.local/state/operant-provision/state.json`
  stores statuses and output (mode 600) but never credential values. Override the
  location with `PROVISION_STATE_DIR` if needed.

### What this wizard deliberately does not do

- It does not sign in to any account, accept a licence, or pair WhatsApp.
- It does not change the desktop theme.
- It does not create the repo's `.env` or `secrets/.credentials.yaml`; the finish
  screen explains how those relate to `/etc/operant/secrets.env`.
- It does not commit, push or reboot anything.

---

## Checks are plain modules

`wizard/checks/<id>.mjs` exports:

```js
export const id = 'hardware';
export const title = 'Hardware inventory';
export const why = 'One line explaining why this step exists.';
export const needsRoot = false;          // optional
export const fields = [ ... ];            // optional, secrets only
export async function run(ctx, input) {
  ctx.log('...');                         // streams to the UI
  const result = await ctx.run('lscpu', [], { echo: false });
  return { ok: true, summary: '...' };    // ok is mandatory and real
}
```

`ctx` provides `run`, `exec`, `runRoot`, `runAsHuman`, `which`, `log`,
`logSection`, `fmtBytes`, `fmtCmd`, `redact`, `exec` request context (`repoDir`,
`repoUrl`, `humanUser`, `serverPath`, `secretsPath`, `previous`, `allPriorOk`).

To add a step, add its module and its id to `STEP_IDS` in `server.mjs`. Order is
explicit; there is no directory scan.

---

## Verification performed (and what cannot run on Windows)

The wizard is developed on Windows but targets Linux. On Windows:

- all `.mjs` files pass `node --check`;
- the server starts, serves `/`, `/app.js`, `/style.css`, and returns JSON from
  `/api/steps` and `/api/health`;
- `hardware` reports CPU/RAM and explicitly marks GPU/disk/session probes as
  Linux-only;
- `network` runs normally (DNS and HTTPS HEAD);
- `secrets`, `packages`, `ai-stack`, `theming`, `whatsapp` and `browser` fail
  with a clear platform/sudo message instead of crashing;
- `finish` summarises those real outcomes.

Linux-only behaviour cannot be proven on Windows: pacman transactions, Flatpak
installs, `/etc/operant` ownership/mode, systemd user units, KDE theming
detection, and `install.sh` writing the service/autostart files. Those are
written to fail visibly, not silently; verify them on the target CachyOS
machine.

---

## Troubleshooting

- **Port 8788 is busy:** stop the other wizard
  (`systemctl --user stop operant-provision`) or use
  `PROVISION_PORT=8799 node provision/wizard/server.mjs` for development. The
  autostart entry and install script assume 8788.
- **Service did not start:** `systemctl --user status operant-provision --no-pager`
  and `journalctl --user -u operant-provision -n 50 --no-pager`.
- **`dsh` is not on PATH after step 5:** the global npm prefix is not on your
  `PATH`; inspect `npm prefix -g` and your shell profile.
- **`pnpm install` fails on builds:** the repo's `pnpm-workspace.yaml` controls
  `allowBuilds`; do not silence it with `--ignore-scripts`.
- **A step says root is required:** run the printed command yourself, or use the
  elevated one-off above. The wizard will not ask the browser for a password.

## Uninstall

```bash
systemctl --user disable --now operant-provision
rm -f ~/.config/systemd/user/operant-provision.service
rm -f ~/.config/autostart/operant-provision.desktop
rm -rf ~/.operant-provision
rm -rf ~/.local/state/operant-provision
systemctl --user daemon-reload
```