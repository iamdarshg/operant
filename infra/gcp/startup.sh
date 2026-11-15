#!/usr/bin/env bash
# Operant core VM bootstrap. Idempotent: safe to re-run on an existing host.
#
# Deliberately does NOT: create users with passwords, open inbound ports,
# install GPU stacks, or write secrets to disk. Secrets arrive later via
# /etc/operant/operant.env (0600, root:operant), placed by the deploy step.
set -euo pipefail
exec > >(tee -a /var/log/operant-bootstrap.log) 2>&1
echo "=== operant bootstrap start $(date -Is) ==="

export DEBIAN_FRONTEND=noninteractive
APT_KEYRING=/etc/apt/keyrings
mkdir -p "$APT_KEYRING"

# ---------------------------------------------------------------- base packages
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git jq unzip htop tmux ufw fail2ban \
  ffmpeg sqlite3 zstd rsync python3 python3-venv python3-pip \
  apt-transport-https software-properties-common >/dev/null

# ---------------------------------------------------------------- docker + compose
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d "$APT_KEYRING"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$APT_KEYRING/docker.asc"
  chmod a+r "$APT_KEYRING/docker.asc"
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=$APT_KEYRING/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker
# Compose v2 is the `docker compose` subcommand from docker-compose-plugin.

# ---------------------------------------------------------------- node 22 LTS
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
npm install -g pnpm@10 >/dev/null 2>&1 || true

# ---------------------------------------------------------------- operant layout
id -u operant >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash operant
usermod -aG docker operant
install -d -o operant -g operant -m 0755 /opt/operant
install -d -o operant -g operant -m 0755 /opt/operant/data
install -d -o operant -g operant -m 0755 /opt/operant/data/voicestudio
# Secrets live here, root-owned, group-readable by operant only.
install -d -o root -g operant -m 0750 /etc/operant

# ---------------------------------------------------------------- host hardening
# Default-deny inbound. Nothing in this deployment needs an inbound port:
# Tailscale terminates outside the VM's firewall rules and IAP tunnels SSH.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 41641/udp comment 'tailscale direct' >/dev/null || true
ufw --force enable >/dev/null
systemctl enable --now fail2ban

# ---------------------------------------------------------------- swap
# 32 GiB is ample, but a small swap floor protects a runaway Whisper batch from
# triggering the OOM killer during a build.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -qw vm.swappiness=10

# ---------------------------------------------------------------- cost watchdog
# Budget alerts do NOT stop billing; this does. The VM stops itself once total
# uptime since install exceeds the approved hour cap, unless an operator
# explicitly creates /etc/operant/keepalive. Cap is overridable per deployment.
install -d -m 0755 /usr/local/lib/operant
cat > /usr/local/lib/operant/cost-watchdog.sh <<'WATCHDOG'
#!/usr/bin/env bash
# Stops the instance when cumulative billed uptime would exceed the approved cap.
set -euo pipefail
STATE=/var/lib/operant/runtime-seconds
CAP_FILE=/etc/operant/hour-cap
KEEPALIVE=/etc/operant/keepalive
CAP=$(cat "$CAP_FILE" 2>/dev/null || echo 300)
mkdir -p "$(dirname "$STATE")"
TOTAL=$(cat "$STATE" 2>/dev/null || echo 0)
if [ -f "$KEEPALIVE" ]; then
  logger -t operant-watchdog "keepalive present; uptime $TOTAL s of cap ${CAP}h not enforced"
  exit 0
fi
TOTAL=$((TOTAL + 300))
echo "$TOTAL" > "$STATE"
LIMIT=$((CAP * 3600))
if [ "$TOTAL" -ge "$LIMIT" ]; then
  logger -t operant-watchdog "COST CAP REACHED ($TOTAL s >= $LIMIT s). Stopping instance."
  # sync first: a stop is not a destroy, but journals should be flushed.
  sync
  shutdown -h +1 "operant cost watchdog: approved $CAP h of uptime consumed" || true
else
  logger -t operant-watchdog "uptime $TOTAL s of $LIMIT s cap"
fi
WATCHDOG
chmod 0755 /usr/local/lib/operant/cost-watchdog.sh
echo 300 > /etc/operant/hour-cap
chmod 0644 /etc/operant/hour-cap

cat > /etc/systemd/system/operant-watchdog.service <<'UNIT'
[Unit]
Description=Operant cloud cost watchdog
[Service]
Type=oneshot
ExecStart=/usr/local/lib/operant/cost-watchdog.sh
UNIT
cat > /etc/systemd/system/operant-watchdog.timer <<'UNIT'
[Unit]
Description=Run Operant cost watchdog every 5 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now operant-watchdog.timer

# ---------------------------------------------------------------- docker log limits
# Unbounded json-file logs are a classic way to fill a 100 GB disk silently.
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "live-restore": true
}
JSON
systemctl restart docker

echo "=== operant bootstrap done $(date -Is) ==="