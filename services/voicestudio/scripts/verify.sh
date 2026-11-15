#!/usr/bin/env bash
# Reachability + independence + MCP smoke test. Run ON operant-core (or via
# `gcloud compute ssh ... --command 'bash /opt/operant/voicestudio/scripts/verify.sh'`).
#
# Everything talks to 127.0.0.1:3900 because that is the only published socket.
# Nothing here opens a port or touches ufw.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3900}"
MCP_URL="$BASE/mcp/"
AUDIO="${AUDIO:-/opt/operant/voicestudio/bench/known-sentence.wav}"
KNOWN_TEXT="${KNOWN_TEXT:-The server hums quietly beside the cooling fan while the operator checks the morning logs.}"

hdr() { printf '\n===== %s =====\n' "$1"; }

hdr "1. container status"
sudo docker ps --filter name=voicestudio \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
sudo docker inspect voicestudio --format \
  'restart={{.HostConfig.RestartPolicy.Name}} mem_limit={{.HostConfig.Memory}} oom_killed={{.State.OOMKilled}} health={{.State.Health.Status}} restarts={{.RestartCount}}'

hdr "2. readiness: GET /health"
curl -sS -m 10 -w '\nhttp=%{http_code} time=%{time_total}s\n' "$BASE/health"

hdr "3. OpenAI-compatible: GET /v1/models (STT/TTS ids)"
curl -sS -m 30 "$BASE/v1/models" |
  python3 -c 'import sys,json; d=json.load(sys.stdin); [print(f"  {m[\"id\"]:<24} kind={m[\"voicestudio\"][\"kind\"]:<4} active_engine={m[\"voicestudio\"][\"alias_for_active_engine\"]}") for m in d["data"]]'

hdr "4. OpenAI-compatible: GET /v1/audio/voices (count + first ids)"
curl -sS -m 30 "$BASE/v1/audio/voices" |
  python3 -c 'import sys,json; d=json.load(sys.stdin); v=d["voices"]; print(f"  {len(v)} voices"); [print(f"  {x[\"voice_id\"]:<10} {x[\"type\"]}") for x in v[:6]]'

hdr "5. OpenAI-compatible transcription: POST /v1/audio/transcriptions"
if [[ -f "$AUDIO" ]]; then
  curl -sS -m 900 -w '\nhttp=%{http_code} time=%{time_total}s\n' \
    -F "file=@$AUDIO" -F "model=whisper-1" -F "response_format=json" \
    "$BASE/v1/audio/transcriptions"
  echo "known text: $KNOWN_TEXT"
else
  echo "  (no $AUDIO yet — run scripts/bench.sh first)"
fi

hdr "6. MCP initialize: POST $MCP_URL with Host: localhost"
curl -sS -m 60 -i -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Host: localhost' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"operant-verify","version":"0.1"}}}' |
  head -40

hdr "7. MCP initialize with a foreign Host header (should be refused)"
curl -sS -m 60 -o /dev/null -w 'Host: evil.example  http=%{http_code}\n' -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Host: evil.example' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

hdr "8. MCP initialize using the deployment hostname (allow-listed)"
curl -sS -m 60 -o /dev/null -w 'Host: operant-core http=%{http_code}\n' -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Host: operant-core' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

hdr "9. listening sockets (must be 127.0.0.1:3900 only)"
sudo ss -lntp | grep -E '3900|State' || true