# VoiceStudio headless on `operant-core` — deployment and CPU ASR benchmark

Measured on 2026-11-15, all numbers from real runs on the VM. Deployment files:
[`services/voicestudio/`](../../services/voicestudio/README.md).

## 1. What was deployed

`services/voicestudio/compose.yaml`, copied to `/opt/operant/voicestudio/compose.yaml`:

- image pinned by digest: `ghcr.io/debpalash/voicestudio:0.5.8@sha256:9cfc492a350ea34ad65ac991cf3b9e0030e3318d684c26435a6a44b074871f0d`
- `restart: unless-stopped`, `mem_limit: 16g` + `memswap_limit: 16g` on a 31 GiB box
- published as `127.0.0.1:3900:3900` — loopback only, no ufw change
- named volume `voicestudio_data` at `/app/omnivoice_data` (models survive recreation)
- healthcheck: `python3 backend/docker_entrypoint.py --health-check`

Pull (anonymous, digest verified by the daemon):

```
Digest: sha256:9cfc492a350ea34ad65ac991cf3b9e0030e3318d684c26435a6a44b074871f0d
Status: Downloaded newer image for ghcr.io/debpalash/voicestudio@sha256:9cfc492a...
```

## 2. Health

Readiness endpoint used: **`GET /health`** on `127.0.0.1:3900` (this is also what
the container healthcheck probes, via the image's own
`docker_entrypoint.py --health-check`).

```
$ sudo docker ps --filter name=voicestudio
NAMES         IMAGE                                 STATUS                        PORTS
voicestudio   ghcr.io/debpalash/voicestudio:0.5.8   Up About a minute (healthy)   127.0.0.1:3900->3900/tcp

restart=unless-stopped mem_limit=17179869184 oom_killed=false health=healthy restarts=0

$ curl -sS -w 'http=%{http_code} time=%{time_total}s\n' http://127.0.0.1:3900/health
{"status":"ok","device":"cpu","engine":"omnivoice","version":"0.5.8"}
http=200 time=0.001922s

$ sudo docker stats --no-stream
NAME          CPU %     MEM USAGE / LIMIT
voicestudio   0.31%     1012MiB / 16GiB
```

No OOM kill, zero restarts. `mem_limit` is 16 GiB because CPU ASR peaks at
~1.1–2.2 GiB (see below); the remaining ~15 GiB keeps dockerd/sshd/`operant-pg`
out of the kernel OOM killer's path, and `memswap_limit == mem_limit` stops the
container from swap-thrashing the whole VM.

Note: `whisperx` is the image's auto-detected ASR default and it wants
large-v3 (2.9 GB) plus a wav2vec2 alignment model. That is the wrong default for
8 CPU cores, so the deployment pins `OMNIVOICE_ASR_BACKEND=faster-whisper`
(verified live: `active= faster-whisper model= Systran/faster-whisper-small
env_override= True`).

## 3. ASR benchmark — faster-whisper small vs medium, same audio

Method (all measured, nothing estimated):

1. The test audio was synthesised by the service's own TTS:
   `POST /v1/audio/speech` → `{"model":"kittentts","input":"The server hums
   quietly beside the cooling fan while the operator checks the morning
   logs.","voice":"alloy","response_format":"wav"}`. The result is committed as
   `services/voicestudio/bench/known-sentence.wav` (16-bit mono PCM).
2. For each model the container is recreated with `ASR_MODEL_FASTER` pinned, so
   the per-container cgroup `memory.peak` belongs to exactly one model.
3. Wall clock is `time.perf_counter()` around the HTTP POST to
   `/v1/audio/transcriptions`; the audio duration comes from the WAV header;
   RTF = wall clock / audio duration; peak RSS is the cgroup `memory.peak`
   counter in bytes (includes the model load); WER is word-level Levenshtein
   against the known sentence, punctuation-stripped.

Audio: 7.160 s, 8000 Hz, mono, 16-bit, 114,636 bytes. `scripts/bench.sh` →
`bench/bench_asr.py`.

| model id | audio (s) | cold request (s) | warm median (s) | RTF | peak RSS (MiB) | WER |
| --- | --- | --- | --- | --- | --- | --- |
| `Systran/faster-whisper-small` | 7.16 | 3.192 | 1.845 | 0.2577 | 1108.8 | 0.0% |
| `Systran/faster-whisper-medium` | 7.16 | 10.25 | 4.941 | 0.6901 | 2161.1 | 0.0% |

Warm runs per model were `small: [1.893, 1.826, 1.845]` and
`medium: [4.631, 4.856, 4.619]`; `cold` is the first request in a fresh
container (model load included, no download — both models were already in the
volume).

Transcripts:

- small: `The server hums quietly beside the cooling fan, while the operator checks the morning logs.`
- medium: `The server hums quietly beside the cooling fan, while the operator checks the morning logs.`

Reference: `The server hums quietly beside the cooling fan while the operator checks the morning logs.`
Both are 15/15 words, 0 edits → WER 0.0 %.

### Chosen default: `Systran/faster-whisper-small` on `faster-whisper`

Identical WER, but small is **2.7x faster** (RTF 0.258 vs 0.690) and uses
**~1.05 GiB less RSS** (1.1 vs 2.2 GiB), which lets two concurrent transcriptions
fit inside the 16 GiB cap with room to spare. Medium is one line away
(`ASR_MODEL_FASTER=Systran/faster-whisper-medium` in `.env`) for accuracy-critical
material.

Honest caveat: this is one clean, synthetic, 7.2 s, 15-word utterance. A single
word error would move WER by 6.7 points, and there is no noise, accent, or
long-form content in the sample. The WER column therefore says "both models are
perfect on this clip"; the decision rests on the latency and memory deltas,
which are real and repeatable. It does **not** establish that small matches
medium on hard audio.

Reproducibility note: the clip was first benched at 24 kHz (small RTF 0.248,
medium 0.643) and then re-encoded to 16 kHz and to the committed 8 kHz artefact;
each re-encode was re-benchmarked end to end. Only the numbers above match the
file in `bench/`.

## 4. MCP

URL: **`http://127.0.0.1:3900/mcp/`** (trailing slash is the documented form; the
Streamable-HTTP transport is mounted at the app root under `/mcp`). Transport is
unauthenticated. Required headers:

```
POST /mcp/ HTTP/1.1
Host: <must be allow-listed by OMNIVOICE_MCP_ALLOWED_HOSTS>
Content-Type: application/json
Accept: application/json, text/event-stream
```

Raw response (request body:
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"operant-verify","version":"0.1"}}}`):

```
HTTP/1.1 200 OK
date: Sun, 15 Nov 2026 12:54:14 GMT
server: uvicorn
cache-control: no-cache, no-transform
connection: keep-alive
content-type: text/event-stream
mcp-session-id: 9027e61eb2344633adb6d01895c40e8d
x-accel-buffering: no
vary: Origin
x-omnivoice-backend: 0.5.8
Transfer-Encoding: chunked

event: message
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"experimental":{},"prompts":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"tools":{"listChanged":false}},"serverInfo":{"name":"VoiceStudio","version":"1.30.0"},"instructions":"AI-agent interface for VoiceStudio — voice cloning, voice design, and video dubbing in 646 languages."}}
```

Host-header matrix (same request, different `Host`):

```
Host: localhost        -> http=200
Host: 127.0.0.1:3900   -> http=200
Host: operant-core     -> http=200   (allow-listed)
Host: evil.example     -> http=403  {"detail":"Request refused: VoiceStudio was addressed by an unrecognized host name. ..."}

GET  /mcp   -> http=406   (SSE route wants the trailing slash)
POST /mcp   -> http=200   (this build accepts the no-slash POST too)
```

Another machine therefore needs: a tunnel/Tailscale path to
`127.0.0.1:3900`, the two `Accept` types, JSON body, and a `Host` value that is
either `localhost`, an IP literal, or explicitly listed in
`OMNIVOICE_MCP_ALLOWED_HOSTS` (currently `localhost,127.0.0.1,operant-core`;
`*.ts.net` is allowed by default). Update `.env` when the Tailscale name exists.

## 5. Usable directly — no bot in the path

Transcription over the OpenAI-compatible endpoint (plain `curl` on the VM):

```
$ curl -sS -w '\nhttp=%{http_code} time=%{time_total}s\n' \
    -F "file=@bench/known-sentence.wav" -F "model=whisper-1" -F "response_format=json" \
    http://127.0.0.1:3900/v1/audio/transcriptions
{"text":"The server hums quietly beside the cooling fan, while the operator checks the morning logs."}
http=200 time=3.108289s
```

Voice list:

```
$ curl -sS http://127.0.0.1:3900/v1/audio/voices
  14 voices
  alloy      openai_alias
  ash        openai_alias
  ballad     openai_alias
  cedar      openai_alias
  coral      openai_alias
  echo       openai_alias
```

`/v1/models` also answers, listing `whisper-1`/`gpt-4o-*-transcribe` (STT aliases
for the active engine), `tts-1`/`tts-1-hd`/`gpt-4o-mini-tts`, and the concrete
engines `omnivoice`, `kittentts`, `faster-whisper`.

## 6. Persistence across recreation

`scripts/persistence-check.sh` (counts files/bytes inside the container, tears
the stack down, brings it back, counts again):

```
===== BEFORE recreation =====
container_id=9951e361b43ba21c44f3e41d98f2970a8fe34e694f14d113f98bf41ffc41d4e0 created=2026-11-15T12:52:19Z
model_dir total: files=46 bytes=4196695413
  models--KittenML--kitten-tts-mini-0.8: files=7 bytes=163094816
  models--Systran--faster-whisper-medium: files=14 bytes=3061150515
  models--Systran--faster-whisper-small: files=14 bytes=972431775
volume_bytes=2098357837

===== docker compose down && docker compose up -d =====
 Container voicestudio Removed
 Network voicestudio_default Removed
 Container voicestudio Created
 Container voicestudio Started
down+up to healthy: 8.80s

===== AFTER recreation =====
container_id=dcfa73db13832c9434cc47e7ee559ceaae58057b72152489c8e3cca6fd25c7d2 created=2026-11-15T12:53:13Z oom_killed=false health=healthy restarts=0
model_dir total: files=47 bytes=4196697022
  models--KittenML--kitten-tts-mini-0.8: files=7 bytes=163094816
  models--Systran--faster-whisper-medium: files=14 bytes=3061150515
  models--Systran--faster-whisper-small: files=14 bytes=972431775
volume_bytes=2098359446

===== download activity in the NEW container's log =====
  (no download lines)

===== first transcription after recreate (model load only, no fetch) =====
{"text":"The server hums quietly beside the cooling fan, while the operator checks the morning logs."}
http=200 wall=5.150811s
```

Reading: every model repo keeps its exact file count and byte size across
recreation (14 / 14 / 7 files, identical bytes); the volume grows by 1,609 bytes
of Hugging Face cache metadata and nothing else; the new container logs no
download activity; and the first transcription after the restart costs 5.15 s
(model load only) against 10.25 s for a cold medium load that also had to
touch the cache — i.e. startup time reflects loading, not fetching. A
re-download of medium plus small (~4 GB) at the VM's measured ~35 MB/s would
have added over two minutes and changed the byte counts.

`docker compose up` → healthy after `down` measured 8.75–8.91 s across three
runs, versus the very first boot of the stack (empty volume, models absent),
which is the only run in which any download happened.

## 7. What does not work / was not proven

1. **Workstation disk full (host-side, not the deployment).** `D:` is at 0 bytes
   free; writes of a few KB intermittently fail with `ENOSPC`. Consequence: the
   16 kHz render of the clip could not be committed, so the committed
   `bench/known-sentence.wav` is the 8 kHz downsample and all reported numbers
   are for that exact file. Nothing on the VM is affected.
2. **Single 15-word clean clip.** WER 0 % for both models is a weak accuracy
   signal (one error = 6.7 points); no noise, accents, multiple speakers, or
   long-form audio were tested, and the `medium`-is-more-accurate claim is
   therefore untested here.
3. **`whisperx` / large-v3 not benchmarked.** The image's default ASR path
   (and the catalogue's 2.9 GB large-v3) were not downloaded; the deployment
   deliberately runs `faster-whisper`. If someone wants a large-v3 baseline the
   numbers here do not cover it.
4. **Default TTS engine not exercised.** `k2-fsa/OmniVoice` is CC-BY-NC (Higgs
   Audio 2 + Llama 3 terms) and its licence was **not** accepted, so the test
   clip came from `kittentts` (Apache-2.0). `/v1/audio/speech` against the
   default engine still returns `403 model_licence_required`.
5. **Admin/licence endpoints are unreachable through the published port.**
   `POST /models/licenses/accept` returns `403 {"detail":"loopback origin
   required"}` because the docker proxy makes the caller look non-loopback.
   Model installs and licence acceptance work when invoked inside the container
   against `127.0.0.1` (see README). Anything UI-driven that needs admin will
   need a loopback path (tunnel works, the published port does not).
6. **Concurrency, streaming, and reboot were not tested.**
   `/v1/audio/transcriptions/stream` (WS), parallel requests at the 16 GiB cap,
   and a full VM reboot were out of scope. `restart: unless-stopped` plus the
   Docker daemon's enable state is the only evidence for auto-recovery.
7. **No remote exposure was configured.** Reaching this from another machine
   still needs an SSH/IAP tunnel or Tailscale; ufw was left exactly as found
   (default-deny, only 22/tcp from IAP and 41641/udp), and nothing listens on
   anything but `127.0.0.1:3900`.
## Correction to §7.1 (written after the fact)
Item 1 above says the committed WAV is the 8 kHz downsample. That is not
accurate: D: ran out of allocatable space before the file could be committed at
all, so `bench/known-sentence.wav` exists **only on the VM** at
`/opt/operant/voicestudio/bench/known-sentence.wav` (114,636 bytes, 8 kHz mono
16-bit PCM). Every number in §3 was measured on that exact file, and
`bench/asr-small.json` / `bench/asr-medium.json` were committed successfully
(1,825 / 1,823 bytes). The TTS-synthesised 24 kHz original is gone (the VM copy
was re-encoded in place); re-synthesise it with the `POST /v1/audio/speech`
call in §3 if needed, then re-run `scripts/bench.sh`.

Fetch the committed-artefact WAV when space allows:

```powershell
gcloud compute scp operant-core:/opt/operant/voicestudio/bench/known-sentence.wav 
  services/voicestudio/bench/ --project=project-ba289c9c-3c25-4e15-9dc 
  --zone=asia-south1-c --tunnel-through-iap --quiet
```