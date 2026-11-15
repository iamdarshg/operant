#!/usr/bin/env bash
# Proof that model weights survive container recreation.
#
#   bash /opt/operant/voicestudio/scripts/persistence-check.sh
#
# Records the model directory (file count + bytes per repo, counted INSIDE the
# container so it walks the volume through the same path the service uses),
# tears the stack down, brings it back, and records the same numbers plus boot
# and first-transcription timings. A re-download would change the byte counts
# and show up in the new container's log.
set -uo pipefail
cd /opt/operant/voicestudio
VOL=/var/lib/docker/volumes/voicestudio_data/_data

model_stats() {
  sudo docker exec -i voicestudio python3 - <<'PY'
import os
root = "/app/omnivoice_data/huggingface"
hub = os.path.join(root, "hub")
def measure(path):
    files = size = 0
    for d, _, fs in os.walk(path):
        for f in fs:
            p = os.path.join(d, f)
            try:
                files += 1
                size += os.path.getsize(p)
            except OSError:
                pass
    return files, size
f, s = measure(root)
print(f"model_dir total: files={f} bytes={s}")
if os.path.isdir(hub):
    for repo in sorted(r for r in os.listdir(hub) if r.startswith("models--")):
        rf, rs = measure(os.path.join(hub, repo))
        print(f"  {repo}: files={rf} bytes={rs}")
PY
  sudo du -sb "$VOL" | cut -f1 | sed 's/^/volume_bytes=/'
}

wait_healthy() {
  local i code
  for i in $(seq 1 240); do
    code=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3900/health 2>/dev/null || true)
    [[ "$code" == "200" ]] && return 0
    sleep 0.5
  done
  return 1
}

echo "===== BEFORE recreation ====="
sudo docker inspect voicestudio --format 'container_id={{.Id}} created={{.Created}}'
model_stats

echo
echo "===== docker compose down && docker compose up -d ====="
T0=$(date +%s.%N)
sudo docker compose down 2>&1 | tail -3
sudo docker compose up -d 2>&1 | tail -3
wait_healthy || { echo "never healthy after recreate"; exit 1; }
T1=$(date +%s.%N)
python3 -c "print(f'down+up to healthy: {$T1-$T0:.2f}s')"

echo
echo "===== AFTER recreation ====="
sudo docker inspect voicestudio --format 'container_id={{.Id}} created={{.Created}} oom_killed={{.State.OOMKilled}} health={{.State.Health.Status}} restarts={{.RestartCount}}'
model_stats

echo
echo "===== download activity in the NEW container's log ====="
if sudo docker logs voicestudio 2>&1 | grep -iE 'downloading|download start|fetching|snapshot_download|hf.co/'; then
  :
else
  echo "  (no download lines)"
fi

echo
echo "===== first transcription after recreate (model load only, no fetch) ====="
curl -sS -m 900 -w '\nhttp=%{http_code} wall=%{time_total}s\n' \
  -F "file=@bench/known-sentence.wav" -F "model=whisper-1" -F "response_format=json" \
  http://127.0.0.1:3900/v1/audio/transcriptions