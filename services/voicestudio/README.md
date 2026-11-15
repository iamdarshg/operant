# VoiceStudio (headless, CPU-only) on `operant-core`

Pinned, loopback-only deployment of the VoiceStudio headless image on the
existing GCE VM. Transcription, TTS, and the MCP endpoint all run in one
container; nothing is reachable from the network except through the loopback
socket we publish.

| | |
| --- | --- |
| Image | `ghcr.io/debpalash/voicestudio:0.5.8@sha256:9cfc492a350ea34ad65ac991cf3b9e0030e3318d684c26435a6a44b074871f0d` |
| Host path | `/opt/operant/voicestudio/` (compose.yaml, .env, scripts/, bench/) |
| Port | `127.0.0.1:3900` only — never `0.0.0.0`, no ufw rule |
| Volume | named volume `voicestudio_data` → `/app/omnivoice_data` |
| Memory | `mem_limit: 16g`, `memswap_limit: 16g` (31 GiB box, ~15 GiB left for the host) |
| Default ASR | `faster-whisper` + `Systran/faster-whisper-small` |
| Healthcheck | `python3 backend/docker_entrypoint.py --health-check` (GETs `/health`) |

Benchmark numbers and the reasoning behind the default live in
[`docs/reports/voicestudio-benchmark.md`](../../docs/reports/voicestudio-benchmark.md).

## Files

- `compose.yaml` — the deployment. Digest-pinned image, loopback publish, memory
  cap, named volume, healthcheck, log rotation.
- `.env.example` — optional overrides (copy to `.env` next to `compose.yaml`).
- `scripts/deploy.ps1` — pushes the release files over IAP and runs
  `docker compose up -d --wait`; fails loudly if the container never gets healthy.
- `scripts/verify.sh` — on-VM smoke test: container status, `/health`, model and
  voice lists, one transcription, MCP `initialize`, listen-socket check.
- `scripts/bench.sh` + `bench/bench_asr.py` — the ASR benchmark (small vs medium).
- `scripts/persistence-check.sh` — proves model weights survive recreation.
- `bench/known-sentence.wav` — the test clip, synthesised by the service's own
  TTS (`kittentts`) from the reference sentence.

## Deploy / update

```powershell
pwsh ./services/voicestudio/scripts/deploy.ps1
```

That is idempotent. It never creates, destroys, or stops the VM, and it does not
touch ufw or firewall rules.

Manual equivalent on the VM:

```bash
cd /opt/operant/voicestudio
sudo docker compose up -d --wait     # compose needs sudo: no docker group membership
sudo docker compose ps
```

## Using it from another machine

The socket is loopback-only, so reach it through an SSH/IAP tunnel or Tailscale:

```bash
gcloud compute ssh operant-core --project=project-ba289c9c-3c25-4e15-9dc \
  --zone=asia-south1-c --tunnel-through-iap -- -N -L 3900:127.0.0.1:3900
# then locally:
curl -sS http://127.0.0.1:3900/v1/models
```

MCP (trailing slash matters):

```
POST http://127.0.0.1:3900/mcp/
Content-Type: application/json
Accept: application/json, text/event-stream
```
The transport is unauthenticated, and the SDK refuses Host headers it does not
know about. `OMNIVOICE_MCP_ALLOWED_HOSTS` must list every name clients dial —
currently `localhost,127.0.0.1,operant-core`. A foreign Host gets `403
"unrecognized host name"`. Add the Tailscale MagicDNS name (`*.ts.net` is
allowed by default) when the tailnet is up.

## OpenAI-compatible API (loopback, no key)

```bash
# health / readiness
curl -sS http://127.0.0.1:3900/health
# {"status":"ok","device":"cpu","engine":"omnivoice","version":"0.5.8"}

# transcribe
curl -sS http://127.0.0.1:3900/v1/audio/transcriptions \
  -F "file=@/opt/operant/voicestudio/bench/known-sentence.wav" \
  -F "model=whisper-1" -F "response_format=json"

# voices / models
curl -sS http://127.0.0.1:3900/v1/audio/voices
curl -sS http://127.0.0.1:3900/v1/models
```

Over the tunnel the same calls work against `http://127.0.0.1:3900` on your
machine. If you ever expose this beyond loopback you must also set
`OMNIVOICE_API_KEY`, because remote callers are then required to send
`Authorization: Bearer <key>` (loopback callers are not).

## Models

Weights live in the named volume and survive `docker compose down`, image
upgrades and host reboots. Download a model through the service (not by hand):

```bash
sudo docker exec voicestudio python3 -c "
import json,urllib.request
req=urllib.request.Request('http://127.0.0.1:3900/models/install',
  data=json.dumps({'repo_id':'Systran/faster-whisper-medium'}).encode(),
  headers={'Content-Type':'application/json'}, method='POST')
print(urllib.request.urlopen(req, timeout=300).read().decode())"
```

`GET /models/install/status` reports progress. Note the admin/install routes are
refused when addressed through the published port (the proxy makes the request
look non-loopback); `docker exec` + `127.0.0.1` inside the container is the
working path, which is what the snippet above does.

Licences: the default TTS engine (`k2-fsa/OmniVoice`) is CC-BY-NC (Higgs Audio 2
+ Llama 3 terms) and is **not** accepted here. The bench clip therefore uses the
Apache-2.0 `kittentts` engine. Accept OmniVoice explicitly in Model Catalogue if
you need it — it is a noncommercial licence and that is your call, not the
deploy script's.

## Verify / re-bench

```bash
bash /opt/operant/voicestudio/scripts/verify.sh              # smoke test
bash /opt/operant/voicestudio/scripts/persistence-check.sh   # down/up + model dir
bash /opt/operant/voicestudio/scripts/bench.sh               # small vs medium
```

## Known limitations

- CPU only: no GPU is installed and none is used; `whisperx` (the image's
  auto-detected default) is replaced by plain `faster-whisper` because it would
  pull large-v3 plus a wav2vec2 alignment model for ~3x the latency.
- The service does not authenticate anything on loopback. Do not change the
  published address without configuring `OMNIVOICE_API_KEY`.
- `docker compose` needs `sudo` on this VM (the `iamdarshg` user is not in the
  `docker` group). Adding it would remove the need for `sudo` but grants
  root-equivalent access; that has not been done.

## Correction: the bench WAV is not in this copy
`bench/known-sentence.wav` could not be written to this repo: the workstation
`D:` drive is at 0 bytes free and even tiny allocations fail with ENOSPC.
The canonical file lives on the VM at
`/opt/operant/voicestudio/bench/known-sentence.wav` (114,636 bytes, 8 kHz mono
PCM). Fetch it, once a few hundred KB are free, with:

```powershell
gcloud compute scp operant-core:/opt/operant/voicestudio/bench/known-sentence.wav 
  services/voicestudio/bench/ --project=project-ba289c9c-3c25-4e15-9dc 
  --zone=asia-south1-c --tunnel-through-iap --quiet
```