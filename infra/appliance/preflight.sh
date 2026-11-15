#!/usr/bin/env bash
# Preflight for the appliance box (i7-10700KF / 32 GB / 512 GB SSD).
#
# Fails closed: a machine below the minimums will start this platform and then
# OOM under a real transcription, which looks like a software bug and wastes an
# afternoon. Refusing early is cheaper.
set -uo pipefail

MIN_CORES=4
MIN_RAM_GB=8
MIN_DISK_GB=60

fail=0
say() { printf '%s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; fail=1; }

say "Operant appliance preflight"

# ---- cpu -------------------------------------------------------------------
if command -v nproc >/dev/null 2>&1; then cores=$(nproc); else cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1); fi
if [ "$cores" -ge "$MIN_CORES" ]; then ok "cpu: ${cores} logical cores"; else bad "cpu: ${cores} cores (< ${MIN_CORES})"; fi

# ---- memory ----------------------------------------------------------------
if [ -r /proc/meminfo ]; then
  mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  ram_gb=$((mem_kb / 1024 / 1024))
  if [ "$ram_gb" -ge "$MIN_RAM_GB" ]; then ok "ram: ${ram_gb} GB"; else bad "ram: ${ram_gb} GB (< ${MIN_RAM_GB})"; fi
  # Speech service is capped at 16g; flag a box that cannot honour it.
  if [ "$ram_gb" -lt 24 ]; then warn "ram: below 24 GB — lower voicestudio mem_limit in docker-compose.appliance.yml"; fi
else
  warn "ram: cannot read /proc/meminfo (not Linux?)"
fi

# ---- disk ------------------------------------------------------------------
avail_gb=$(df -Pk . 2>/dev/null | awk 'NR==2{print int($4/1024/1024)}')
if [ -n "${avail_gb:-}" ]; then
  if [ "$avail_gb" -ge "$MIN_DISK_GB" ]; then ok "disk: ${avail_gb} GB free"; else bad "disk: ${avail_gb} GB free (< ${MIN_DISK_GB}); speech image + models need ~20 GB"; fi
else
  warn "disk: cannot determine free space"
fi

# ---- docker ----------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "docker: $(docker --version 2>/dev/null | cut -d, -f1)"
  if docker compose version >/dev/null 2>&1; then ok "compose: $(docker compose version --short 2>/dev/null)"; else bad "compose: 'docker compose' unavailable"; fi
  if docker info >/dev/null 2>&1; then ok "docker daemon: reachable"; else bad "docker daemon: not reachable (add user to docker group or start it)"; fi
else
  bad "docker: not installed"
fi

# ---- gpu (expected: unusable, and that is fine) ----------------------------
if command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qiE 'vga.*(amd|ati).*(polaris|rx ?580)'; then
  ok "gpu: Polaris/RX 580 detected — intentionally unused (no supported ROCm path); CPU inference is the design"
fi

# ---- secrets ---------------------------------------------------------------
if [ -f .env ]; then ok ".env present"; else bad ".env missing (cp .env.example .env)"; fi
if [ -f secrets/.credentials.yaml ]; then ok "secrets/.credentials.yaml present"; else warn "secrets/.credentials.yaml missing — model route will fail"; fi
if [ -f .env ] && grep -q '^OPERANT_BOT_TOKEN=replace-with' .env 2>/dev/null; then bad "OPERANT_BOT_TOKEN still the placeholder (API refuses to start)"; fi

say ""
if [ "$fail" -eq 0 ]; then
  say "RESULT: ready. Suggested: docker compose -f docker-compose.yml -f docker-compose.appliance.yml up -d --build"
  exit 0
else
  say "RESULT: not ready — fix the [FAIL] lines above."
  exit 1
fi