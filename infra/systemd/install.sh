#!/usr/bin/env bash
# Install the Operant systemd units on the VM and verify they are active.
# Idempotent. Replaces the nohup processes that were only ever a stopgap.
set -euo pipefail
REPO=/opt/operant-src/operant
UNIT_SRC="$(cd "$(dirname "$0")" && pwd)"

install -m 0644 "$UNIT_SRC/operant-api.service"    /etc/systemd/system/operant-api.service
install -m 0644 "$UNIT_SRC/operant-worker.service" /etc/systemd/system/operant-worker.service

# Stop the nohup stopgaps so two supervisors never fight over the same port.
for f in "$REPO/data/api.pid" "$REPO/data/worker.pid"; do
  if [ -f "$f" ]; then kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; fi
done
sleep 1

systemctl daemon-reload
systemctl enable --now operant-api.service
sleep 3
systemctl enable --now operant-worker.service
sleep 3

echo "--- status ---"
systemctl is-active operant-api.service operant-worker.service
echo "--- health ---"
curl -sS --max-time 8 http://127.0.0.1:8787/v1/health || echo "API-DOWN"
echo ""
echo "--- recent api journal ---"
journalctl -u operant-api.service -n 5 --no-pager || true
