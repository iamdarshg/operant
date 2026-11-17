#!/usr/bin/env bash
# Operant first-boot provisioning wizard — one-command user-level bootstrap.
#
# Installs the wizard for the CURRENT desktop user:
#   ~/.operant-provision                  (the copied app; no npm install)
#   ~/.config/systemd/user/operant-provision.service
#   ~/.config/autostart/operant-provision.desktop
#
# It deliberately refuses to run as root: a systemd *user* service and a
# per-user autostart entry belong to the human account. Privileged provisioning
# steps either use passwordless sudo or print the exact command for you to run.

set -euo pipefail

PORT=8788
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.operant-provision"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
SERVICE_DIR="${CONFIG_DIR}/systemd/user"
UNIT="${SERVICE_DIR}/operant-provision.service"
AUTOSTART_DIR="${CONFIG_DIR}/autostart"
DESKTOP="${AUTOSTART_DIR}/operant-provision.desktop"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/operant-provision"
MARKER="${STATE_DIR}/wizard-finished"

DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--dry-run]

Installs the Operant first-boot wizard for the current desktop user.

  --dry-run   Print the actions without creating or changing anything.
  --help      Show this text.

Requires Linux with systemd user services (CachyOS/Arch is the target) and
Node 22+ already on PATH. Run it as your normal user, never with sudo.
EOF
}

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $argument" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
plan() { printf '  [dry-run] %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    say "warning: this would refuse to run as root; the real install must run as your desktop user."
  else
    say "Refusing to run as root." >&2
    say "The service and autostart entry belong to your desktop user. Run: ./install.sh" >&2
    exit 1
  fi
fi

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
if [ "$OS_NAME" != "Linux" ] && [ "$DRY_RUN" -eq 0 ]; then
  say "This bootstrap targets Linux (CachyOS/Arch). Detected: ${OS_NAME}." >&2
  say "Nothing was installed. Use --dry-run to inspect the plan from another OS." >&2
  exit 1
fi
if [ "$OS_NAME" != "Linux" ]; then
  say "warning: detected ${OS_NAME}; this is a dry run only."
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  say "Node 22+ is required, but 'node' is not on PATH." >&2
  say "Install it first (the wizard cannot install its own runtime):" >&2
  say "  sudo pacman -S --needed nodejs" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
case "${NODE_MAJOR}" in
  ''|*[!0-9]*)
    say "Could not read a numeric Node version from ${NODE_BIN}." >&2
    exit 1
    ;;
esac
if [ "${NODE_MAJOR}" -lt 22 ]; then
  say "Node ${NODE_MAJOR} is too old; Operant needs Node 22 or newer (found at ${NODE_BIN})." >&2
  exit 1
fi

for required in \
  "${SCRIPT_DIR}/wizard/server.mjs" \
  "${SCRIPT_DIR}/wizard/ui/index.html" \
  "${SCRIPT_DIR}/wizard/ui/app.js" \
  "${SCRIPT_DIR}/wizard/ui/style.css" \
  "${SCRIPT_DIR}/wizard/checks/hardware.mjs" \
  "${SCRIPT_DIR}/wizard/checks/finish.mjs"; do
  if [ ! -f "$required" ]; then
    say "Incomplete source tree: missing ${required}" >&2
    exit 1
  fi
done

REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_URL=""
if command -v git >/dev/null 2>&1; then
  REPO_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
fi

REPO_DIR="${OPERANT_REPO_DIR:-}"
if [ -z "$REPO_DIR" ]; then
  if [ -f "${REPO_ROOT}/package.json" ] && [ -d "${REPO_ROOT}/apps" ]; then
    REPO_DIR="$REPO_ROOT"
  else
    REPO_DIR="${HOME}/operant"
  fi
fi
REPO_URL_DISPLAY="${REPO_URL:-none known; the ai-stack step will explain how to set it}"

say "Operant provisioning wizard — bootstrap"
say "  source:      ${SCRIPT_DIR}"
say "  install to:  ${DEST}"
say "  user service:${UNIT}"
say "  autostart:   ${DESKTOP}"
say "  repo:        ${REPO_DIR}"
say "  repo URL:    ${REPO_URL_DISPLAY}"
say ""

# ---------------------------------------------------------------------------
# Copy the app
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  plan "mkdir -p ${DEST}"
  plan "copy ${SCRIPT_DIR}/. -> ${DEST}/ (without overwriting runtime state)"
  plan "write ${DEST}/install.json (repo URL, repo dir, source root; mode 600)"
else
  mkdir -p "$DEST"
  chmod 700 "$DEST"
  if [ "$SCRIPT_DIR" != "$DEST" ]; then
    cp -a "${SCRIPT_DIR}/." "${DEST}/"
  fi
  rm -f "${DEST}/install.json"
  "$NODE_BIN" - "${DEST}/install.json" "$REPO_URL" "$REPO_DIR" "$REPO_ROOT" "$HOME" <<'NODE'
const fs = require('node:fs');
const [file, repoUrl, repoDir, sourceRoot, home] = process.argv.slice(2);
const data = {
  version: 1,
  installedAt: new Date().toISOString(),
  repoUrl,
  repoDir,
  sourceRoot,
  home,
  port: 8788,
};
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE
fi

# ---------------------------------------------------------------------------
# systemd user service
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  plan "mkdir -p ${SERVICE_DIR}"
  plan "write ${UNIT} (ExecStart=${NODE_BIN} ${DEST}/wizard/server.mjs; 127.0.0.1 only)"
else
  mkdir -p "$SERVICE_DIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=Operant first-boot provisioning wizard (loopback only)
Documentation=file://${DEST}/README.md

[Service]
Type=simple
WorkingDirectory=${DEST}
ExecStart="${NODE_BIN}" "${DEST}/wizard/server.mjs"
Restart=on-failure
RestartSec=3
UMask=0077
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
  chmod 644 "$UNIT"
fi

# ---------------------------------------------------------------------------
# Per-user autostart entry
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  plan "mkdir -p ${AUTOSTART_DIR}"
  plan "write ${DESKTOP} (opens http://127.0.0.1:${PORT}/ until ${MARKER} exists)"
else
  mkdir -p "$AUTOSTART_DIR"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Operant Setup
GenericName=First-boot provisioning
Comment=Local provisioning wizard for this Operant machine (127.0.0.1 only)
Exec=sh -c "sleep 4; test -f '${MARKER}' || xdg-open http://127.0.0.1:${PORT}/"
Icon=utilities-terminal
Terminal=false
Categories=System;
OnlyShowIn=KDE;GNOME;XFCE;
X-GNOME-Autostart-enabled=true
EOF
  chmod 644 "$DESKTOP"
fi

# ---------------------------------------------------------------------------
# Start it (systemd user manager, if present)
# ---------------------------------------------------------------------------
STARTED=0
if [ "$DRY_RUN" -eq 1 ]; then
  plan "systemctl --user daemon-reload"
  plan "systemctl --user enable --now operant-provision.service"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  if systemctl --user daemon-reload && systemctl --user enable --now operant-provision.service; then
    STARTED=1
    sleep 1
    if systemctl --user is-active --quiet operant-provision.service; then
      say "Service is active."
    else
      say "Service did not become active. Inspect it with:" >&2
      say "  systemctl --user status operant-provision.service --no-pager" >&2
      say "  journalctl --user -u operant-provision.service -n 50 --no-pager" >&2
    fi
  else
    say "systemd could not enable/start the user service. Inspect it with:" >&2
    say "  systemctl --user status operant-provision.service --no-pager" >&2
    say "  journalctl --user -u operant-provision.service -n 50 --no-pager" >&2
  fi
else
  say "systemd user session is not available here; start the wizard manually:" >&2
  say "  ${NODE_BIN} ${DEST}/wizard/server.mjs" >&2
fi

if ! command -v xdg-open >/dev/null 2>&1; then
  say "warning: xdg-open is missing; the autostart entry cannot open a browser by itself." >&2
fi

# ---------------------------------------------------------------------------
# What to do next
# ---------------------------------------------------------------------------
say ""
say "Open:  http://127.0.0.1:${PORT}/"
if [ "$STARTED" -eq 1 ]; then
  say "Stop:  systemctl --user stop operant-provision"
  say "Logs:  journalctl --user -u operant-provision -f"
else
  say "Run:   ${NODE_BIN} ${DEST}/wizard/server.mjs"
fi
say ""
say "Security posture: the server binds 127.0.0.1 only, rejects non-local Host/Origin"
say "headers, runs commands with argv arrays (no shell), and never logs credential values."
say "Privileged steps either use passwordless sudo or print the exact command and change nothing."
say ""
if [ "$STARTED" -eq 1 ]; then
  say "For a privileged step the service cannot perform, stop it once and run the wizard elevated:"
  say "  systemctl --user stop operant-provision"
  say "  sudo ${NODE_BIN} ${DEST}/wizard/server.mjs"
  say "Then restart the user service when done. The server still binds loopback only."
fi
say ""
say "Uninstall later:"
say "  systemctl --user disable --now operant-provision"
say "  rm -f '${UNIT}' '${DESKTOP}'"
say "  rm -rf '${DEST}'"