# VoiceStudio — CPU-only deployment & MCP endpoint research

Researched 2026-11-15. Upstream: <https://github.com/debpalash/VoiceStudio>.
Scope: can we run VoiceStudio headless, CPU-only, from a pinned image, and point
both a cloud and a local MCP client at it?

Evidence is labelled throughout:

- **[V]** = verified by me in this session (registry API, image config, HF API, GitHub API, upstream source files).
- **[D]** = documented by upstream, not independently verified (no container was started; nothing was deployed).

---

## 1. What the project is

A local-first "AI voice studio": voice cloning, voice design, video dubbing,
dictation, transcription and audiobook/narration in 646 languages. Two delivery
forms share one Python backend:

- an Electron desktop app (macOS / Windows x64 / Linux x64), and
- a **headless HTTP server** — the Docker image serves the same renderer over
  HTTP and binds port 3900 **[D]**.

Default TTS engine is "VoiceStudio (OmniVoice)", described upstream as powered by
k2-fsa/OmniVoice. Dozens of alternative TTS/ASR engines exist and are switched per
deployment (**Model Catalogue** or `OMNIVOICE_TTS_BACKEND` / `OMNIVOICE_ASR_BACKEND`).

- Supported install methods **[D]**: Docker (GHCR + Docker Hub), Homebrew cask,
  PowerShell installer, AUR, Snap, DEB, AppImage, Nix, from source (`bun run dev`),
  Android APK, iOS IPA.
- License **[V]**: AGPL-3.0 (`license.spdx_id` = `AGPL-3.0`; also baked into the
  image label `org.opencontainers.image.licenses=AGPL-3.0`). Model weights carry
  their own licenses ([model inventory](https://github.com/debpalash/VoiceStudio/blob/main/docs/licensing/model-inventory.md)).
- Maintenance **[V]**: created 2026-04-09, 110,570 stars, 12,244 forks, 18 open
  issues (excluding PRs), 5 open PRs, `pushed_at` 2026-11-14T20:07Z, last 5 commits
  all dated 2026-11-14. Latest release **v0.5.8**, published 2026-11-12T08:53Z,
  not a prerelease. Very active.

Verdict on activity: actively and heavily maintained; the risk is churn, not abandonment.

---

## 2. CPU-only deployment: real and supported

**[D]** Upstream explicitly supports CPU inference and documents it as the default
"run locally on the CPU" path:

> "No GPU? The app is fully usable on the CPU, just slower."
> — README

> "Stable images · CPU · NVIDIA CUDA · AMD ROCm."
> — README Docker section

There is **no separate CPU image**. The unsuffixed tags (`:latest`, `:stable`,
`:0.5.8`) are a combined CUDA/CPU build: the image carries CUDA/nvidia paths and
libraries but falls back to CPU when no GPU is present **[V]** (config
`PATH=/usr/local/nvidia/bin:/usr/local/cuda/bin…`, label
`com.nvidia.volumes.needed=nvidia_driver`). Docs confirm: "The default (CUDA)
image runs CPU-only on AMD hardware" **[D]**.

Practical consequence **[V]**: you download a ~5.58 GB (compressed, 23 layers)
CUDA-bearing image to run CPU-only. There is no slim CPU variant.

---

## 3. Image reference and pinned digest

Registry: `ghcr.io` (alias `ghcr.io/debpalash/omnivoice-studio`; Docker Hub mirror
`palashdeb/omnivoice-studio` with identical tags) **[D]**.

### Verified tag → index digest (GHCR registry `HEAD /v2/debpalash/voicestudio/manifests/<tag>`) **[V]**

| Tag | Index digest | amd64 child manifest digest | Platforms |
|---|---|---|---|
| `latest` | `sha256:f5d8bef48e5625818eced27e1420725e2d5dc0bf916a09ff1971a2bfa9a3bfcc` | `sha256:6b7ceb19f91f6bcc7271231813659957fd9e93781b156d3fcb3e1c704dee5ec5` | `linux/amd64` + attestation |
| `main` | same as `latest` | same | same |
| **`stable`** | **`sha256:9cfc492a350ea34ad65ac991cf3b9e0030e3318d684c26435a6a44b074871f0d`** | **`sha256:96e02b59032db32c21d534a2826dcddb83bb7402c5c876720e62e023e3efdac5`** | `linux/amd64` + attestation |
| `0.5.8` | identical to `stable` | identical | same |
| `0.5` | identical to `stable` | identical | same |
| `0.5.7` | `sha256:65f1305c749c759d3656fed5f12623a98aff11e5f326d28bf7095cb57f3a9e0b` | `sha256:c0d909e61144fc559308ba945f3bde57aa493aa6a62ec68f2ad6c18a0c3c2743` | `linux/amd64` |
| `0.5.6` | `sha256:588fe119082bb97e722f5e53fe7b0fe1a406885bf72a4c60889d3d03376d7768` | — | `linux/amd64` |
| `beta` | `sha256:ac0c88d655e0283b47b4509d624f9dde1d94f8947925f7781ef30325dca57cb5` | — | — |

`linux/amd64` requirement: **satisfied on every tag inspected [V]**. The second
manifest entry in each index is `architecture: unknown, os: unknown` — a buildkit
provenance attestation, not a real platform.

### Recommended pins

Production (reproducible):

```
ghcr.io/debpalash/voicestudio:0.5.8@sha256:9cfc492a350ea34ad65ac991cf3b9e0030e3318d684c26435a6a44b074871f0d
```

If you deliberately want the rolling preview:

```
ghcr.io/debpalash/voicestudio:latest@sha256:f5d8bef48e5625818eced27e1420725e2d5dc0bf916a09ff1971a2bfa9a3bfcc
```

Do **not** pin `:stable` by tag alone — it moves on every stable release **[D]**.

Value of the digest pin: I observed `:latest` and `:stable` move independently
within 2 days of each other (builds dated 2026-11-14 and 2026-11-12) **[V]**.

### Image identity (verified from the amd64 config blob) **[V]**

- `:stable` / `0.5.8`: created `2026-11-12T00:33Z`, `org.opencontainers.image.version=sha-c1050c1`,
  env `OMNIVOICE_BUILD_COMMIT=c1050c16d9b3881e5d4161ee58ccc0582b3f20f9`.
- `:latest`: created `2026-11-14T19:09Z`, env revision `39a6c551dc8a8bc6802b7dc7310515beb37a0d68`
  (matches the top commit on `main` at the time of writing **[V]**).
- Entrypoint: `python3 backend/docker_entrypoint.py`; `WorkingDir=/app`; `PYTHONPATH=/app/backend`.
- `ExposedPorts`: `3900/tcp`.
- `OMNIVOICE_SERVER_MODE=1`, `OMNIVOICE_BIND_HOST=0.0.0.0`.
- 23 layers, 5.58 GB compressed total; largest single layer 4,074 MB (the
  CUDA/PyTorch stack).

Anonymous access: **works**. `docker manifest inspect` and the `ghcr.io/token`
anonymous pull-token flow both succeeded without credentials **[V]**. No
`docker login` is required for a public pull.

---

## 4. Ports, volumes, persistence

### Port **[V]**+**[D]**

- Container listens on **3900/tcp** (image `ExposedPorts`, `OMNIVOICE_BIND_HOST=0.0.0.0`)
  **[V]**; host-side docs always publish `127.0.0.1:3900:3900` **[D]**.
- Default `.well-known` capability document: `http://127.0.0.1:3900/.well-known/voicestudio-speech`.
- `OMNIVOICE_PORT` overrides the backend port.
- Port **3902** is *not* an API — it was the retired Tauri dictation control port
  and is now the Electron dev-server port; `/v1/dictation/*` and its JSON-RPC are
  gone **[D]**.

### Volume **[V]** (declared in the image, not merely documented)

- `Volumes: /app/omnivoice_data`
- `HF_HOME=/app/omnivoice_data/huggingface`

So models live *inside* the data volume by default. One mount persists
everything:

| Mount | Purpose |
|---|---|
| `/app/omnivoice_data` | Project DB, user voices, settings, encrypted HF token, **and** the Hugging Face model cache |

**Trap [D]**: mounting a host cache at `/root/.cache/huggingface` does nothing —
`HF_HOME` already points into the data volume. To reuse a host cache, bind it to
`-v ~/.cache/huggingface:/app/omnivoice_data/huggingface`. The container runs as
root, so files it writes there are root-owned on the host.

The upstream production guide splits persistence into two volumes
(`voicestudio-data` and `voicestudio-models` mounted at
`/app/omnivoice_data/huggingface`) so the model cache can be discarded
independently **[D]**.

**Upgrade trap [D]**: older container layouts kept application data inside the
container. Follow `docs/install/docker-data-recovery.md` before recreating a
container built with an older command.

### Credentials / env **[D]**

| Var | Meaning |
|---|---|
| `OMNIVOICE_API_KEY` | Administrator/root key; the UI exchanges it for a short-lived browser session |
| `OMNIVOICE_DATA_DIR=/app/omnivoice_data` | Confirms the data root |
| `OMNIVOICE_SERVER_MODE` | `1` in the image; relaxes the loopback-origin gate for Docker NAT |
| `OMNIVOICE_ANALYTICS_DISABLED=1` | Switches opt-in analytics off entirely |
| `OMNIVOICE_MCP_DISABLE=1` | Skips mounting `/mcp` |
| `OMNIVOICE_MCP_OUTPUT_MODE` | `resources` (default) · `files` · `both` |
| `OMNIVOICE_MCP_BASE_PATH` | Security boundary for file-shaped MCP arguments |
| `OMNIVOICE_MCP_ALLOWED_HOSTS` | Host patterns allowed past the MCP DNS-rebinding guard |
| `OMNIVOICE_ALLOWED_HOSTS` / `OMNIVOICE_ALLOWED_ORIGINS` | Host/origin allowlists |

---

## 5. MCP endpoint — yes, `/mcp/` is documented (and mounted in source)

**[D]** `docs/mcp.md`: the MCP server is "**mounted on the running backend** at
`/mcp`", nothing extra to start.

**[V]** Source confirms it: `backend/main.py` contains

```python
if os.environ.get("OMNIVOICE_MCP_DISABLE", "").strip().lower() not in ("1", "true", "yes", "on"):
    from mcp_server import mount_mcp
    mount_mcp(app)
    ...
    logger.info("MCP server mounted at /mcp")
```

### Transport

- **Streamable HTTP** at `http://<host>:3900/mcp/` — *keep the trailing slash* **[D]**.
- Current backends also answer bare `/mcp` for `POST`, `GET` (event stream) and
  `DELETE`; older builds returned 405 for bare `/mcp` **[D]**. Use `/mcp/`.
- **stdio** via the bundled shim `python -m backend.mcp_shim` (needs a source
  checkout and its Python env, e.g. `uv run python -m backend.mcp_shim`), or the
  direct stdio server `python -m backend.mcp_server` **[D]**.

### Tools exposed **[D]**

`generate_speech`, `clone_voice`, `describe_voice`, `design_voice`, `transcribe`,
`list_voices`, `list_personalities`, `list_languages`, `check_health`.
Resources: `voice://{profile_id}`, `history://recent` (≤20 items).
`list_voices`, `list_personalities`, `transcribe`, `check_health` return
JSON-**encoded text** — the client must `json.loads()` the text block.

### Client configuration seen in docs **[D]**

Codex CLI:

```toml
[mcp_servers.voicestudio]
url = "http://127.0.0.1:3900/mcp/"
http_headers = { "X-OmniVoice-Client-Id" = "codex-cli" }
```

Hermes / generic:

```yaml
mcp_servers:
  voicestudio:
    url: "http://127.0.0.1:3900/mcp/"
    headers:
      X-OmniVoice-Client-Id: "hermes"
```

Per-agent voice binding: `X-OmniVoice-Client-Id` header maps to a voice profile.
Bindings are managed at `GET/PUT /api/mcp/bindings` and
`DELETE /api/mcp/bindings/{client_id}` **[D]**.

### Auth reality for `/mcp/` **[D]** — read this before exposing it

- Consumption tools (including `clone_voice` / `design_voice` profile creation)
  work over loopback **without an administrator key**.
- "The MCP transport is not authenticated, so don't expose it on the open internet."
- Non-localhost Host headers are rejected by the MCP SDK's DNS-rebinding guard:
  set `OMNIVOICE_MCP_ALLOWED_HOSTS` (e.g. `host.containers.internal:*,192.168.1.50:*`).
  **Docker, a hostname, or a manually bound server all need this** — this is the
  single most likely reason a "cloud" MCP client fails against a container.
- LAN mode requires `X-OmniVoice-Pin` (six-digit share PIN), plaintext unless
  tunnelled; admin operations additionally need `Authorization: Bearer <key>`.

### Not verified

I did **not** call `/mcp/` on a running container. The endpoint is documented
**[D]** and its mount is present in source **[V]**, but "the shipped 0.5.8 image
moves MCP JSON-RPC on 3900" remains unconfirmed at runtime.

---

## 6. Speech engines on CPU

### ASR (speech-to-text)

| Engine | CPU? | In stock image? |
|---|---|---|
| **Faster-Whisper** (CTranslate2) | **Yes — int8 on macOS/Windows/Linux** **[D]** | Yes, "installed by default" **[D]** |
| WhisperX | Yes (CUDA · CPU) **[D]** | Yes, default **[D]** |
| PyTorch Whisper | Yes (CUDA · MPS · CPU) **[D]** | Yes, default **[D]** |
| Faster-Whisper (isolated) | Yes **[D]** | Opt-in pick; ships in image **[D]** |
| **whisper.cpp** | **Yes — "runs on the CPU everywhere"** **[D]** | **No** — binary *and* GGML model are user-managed; "VoiceStudio does not download them automatically" **[D]** |
| Parakeet TDT (NeMo) | Yes, "fast CPU" **[D]** | Separate venv, never the app's **[D]** |
| Moonshine | CPU only **[D]** | Needs pip install **[D]** |
| FunASR (SenseVoice) | Yes (CUDA · CPU) **[D]** | Needs `pip install funasr` **[D]** |
| Sherpa-ONNX | Yes — live streaming dictation **[D]** | `pip install sherpa-onnx` + model dir **[D]** |
| OpenAI-compatible endpoint | network **[D]** | Config only |

Key CPU facts **[D]**:

- Faster-Whisper on CPU uses **int8** (not fp16). Default model repo is
  `Systran/faster-whisper-large-v3`; `ASR_MODEL_FASTER` accepts size aliases
  `tiny … large-v3`, `distil-large-v3`, or any CTranslate2 Whisper repo on HF.
- Auto-detect picks faster-whisper **only when WhisperX is unavailable**.
- Silero VAD runs before transcription.
- CUDA OOM falls back to CPU with the same model/accuracy, just slower.
- **whisper.cpp is a poor fit for the Docker deployment**: no binary in the image,
  no auto-download, and it must be wired via `OMNIVOICE_WHISPER_CPP_BIN` /
  `OMNIVOICE_WHISPER_CPP_MODEL`, which means a derived image or a bind mount.
  Dropping a static `whisper-cli` binary into a bind-mounted path and setting
  `OMNIVOICE_WHISPER_CPP_DIR` is plausible but **untested here**.

### TTS on CPU

| Engine | CPU? | Effort to get it |
|---|---|---|
| **OmniVoice (default)** | CUDA · MPS · **CPU** **[D]** | Built in — but it is the slow path |
| OmniVoice GGUF (native, llama.cpp-style) | CUDA · MPS · **CPU** **[D]** | **Native binary bundled in the desktop installers — not in the Docker image** **[D]** |
| Supertonic-3 | **CPU only** **[D]** | `uv sync --extra supertonic` + license **[D]** |
| KittenTTS | **CPU only**, 8 preset voices, no cloning **[D]** | `pip install kittentts` **[D]** |
| PocketTTS (Kyutai) | CPU (not Intel Mac) **[D]** | `uv sync --extra pockettts` + license **[D]** |
| CosyVoice 3 | CUDA · CPU **[D]** | clone + requirements |
| VoxCPM2 | CUDA · MPS · CPU **[D]** | `pip install "voxcpm>=2.0.3"` |
| Sherpa-ONNX TTS | CUDA · CPU **[D]** | `pip install sherpa-onnx` |
| IndexTTS 2.5 | CUDA · CPU **[D]** | one-click sidecar |
| dots.tts (2B) | CUDA · CPU, not Windows **[D]** | clone + env var |
| MOSS-TTS v1.5 (8B) | CUDA · CPU **[D]** | clone + env var |

**Honest reading:** the only CPU-friendly TTS that ships *inside the image* is the
default OmniVoice PyTorch path. Upstream's own guidance is that CPU rendering is
"often 10–50x slower than on a GPU" and "expect ~2x slower than MPS, more against
CUDA" **[D]**. The genuinely CPU-tuned options (OmniVoice GGUF, Supertonic-3,
KittenTTS, PocketTTS) all require an install step the stock image does not do, so
they imply a derived image.

### Model storage on disk **[V]**

- `HF_HOME=/app/omnivoice_data/huggingface` (set in the image) → models live in
  the persisted data volume.
- Overridable with `HF_HOME` / `HF_HUB_CACHE` **[D]**.
- whisper.cpp models, if used, are searched in
  `backend/engines/whisper_cpp/models/`, `~/.cache/whisper/`, or the HF cache for
  `ggerganov/whisper.cpp` **[D]**.
- An install reserves **2 GB free** on the model disk beyond the download size
  **[D]**.
- First run pulls **~2.4 GB** of weights (docker.md) / **~2.3 GB** for OmniVoice
  specifically (mcp.md) **[D]**.

### Faster-Whisper INT8 sizes — measured from the Hugging Face API **[V]**

Sizes below are the real bytes in the `Systran/faster-whisper-*` CTranslate2 repos
(i.e. already INT8-quantised `model.bin`), fetched via
`https://huggingface.co/api/models/Systran/<repo>/tree/main`:

| Model | `model.bin` | Repo total (all files) |
|---|---|---|
| `faster-whisper-small` | 461.1 MB | **463.7 MB** |
| `faster-whisper-medium` | 1,457.1 MB | **1,459.7 MB** |
| `faster-whisper-large-v3` | 2,944.3 MB | **2,947.7 MB** |

Peak-RAM estimate (my engineering estimate, **not** an upstream figure): CTranslate2
holds the quantised weights plus activations that scale with beam size and audio
window — budget `model size + 0.4–0.9 GB` for beam_size 5, `+0.3–0.5 GB` for
beam_size 1.

| Model | Weights | Est. peak RSS (beam 5) | Fits 4 GB total? |
|---|---|---|---|
| small | 0.46 GB | ~0.9–1.4 GB | Yes — with room for FFmpeg and the Python runtime |
| medium | 1.46 GB | ~1.9–2.4 GB | Marginal; only with no TTS resident |
| large-v3 | 2.95 GB | ~3.4–3.9 GB | No — no headroom for the host, Docker, or torch |

---

## 7. HTTP API for transcription/synthesis (independent of MCP)

**Yes — and it is OpenAI-compatible.** Route prefix and decorators verified in
`backend/api/routers/openai_compat.py` **[V]**:

```python
router = APIRouter(prefix="/v1", tags=["OpenAI-Compatible Audio API"],
                   route_class=OpenAIErrorRoute,
                   dependencies=[Depends(require_consumer)])
@router.post("/audio/speech")
@router.post("/audio/transcriptions")
@router.post("/audio/translations")
@router.get("/models")
@router.get("/models/{model_id:path}")
@router.get("/audio/voices")
```

So the callable surface is:

| Method | Path | Notes **[V]** |
|---|---|---|
| POST | `/v1/audio/speech` | Body model `SpeechRequest`: `model`, `voice`, `input`, `response_format`. `req.model` is resolved via `_resolve_engine(...)`; a non-accepted model licence raises **403** with OpenAI error shape, and a non-routable model raises **400** `model_not_available`. Compressed formats require ffmpeg and fail fast before any model load. |
| POST | `/v1/audio/transcriptions` | multipart: `file` (required), `model` (Form, default `"whisper-1"`), `language`, `prompt`, `response_format` (`json`,`text`,`verbose_json`,`srt`,`vtt`), `temperature` |
| POST | `/v1/audio/translations` | same shape as transcriptions |
| GET | `/v1/models`, `/v1/models/{id}` | OpenAI-style listing |
| GET | `/v1/audio/voices` | voice enumeration |

Also **[D]**:

- `GET /.well-known/voicestudio-speech` → capability document `voicestudio.speech.v1`
  with relative URLs (proxy-safe).
- `WS /v1/audio/transcriptions/stream` → live partial/final text; raw PCM via
  `?pcm=1&sr=16000`, or WebM/Opus frames; `{"type":"input_audio.end"}` closes input
  without closing the socket. Frames carry `protocol` and `session_id`.
- `POST` + `GET` `/ws/tts` streaming synthesis (terminal `done` frame carries
  `ttfa_ms`, `gen_time_s`, `rtf`).
- Ops endpoints: `/health` (503 with current step during startup),
  `/startup/progress`, `/system/info`, `/system/logs`, `/engines`,
  `/models/install`, `/setup/download-stream`, `/model/loaded`,
  `/system/flush-memory`, `/model/unload/{tts|diarization|sidecar:<id>|sidecars}`.

Working examples from the upstream production guide **[D]**:

```bash
curl http://127.0.0.1:3900/v1/audio/speech \
  -H "Authorization: Bearer $OMNIVOICE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<resolved-tts-engine-id>","voice":"alloy","input":"Production check.","response_format":"wav"}' \
  --output check.wav

curl http://127.0.0.1:3900/v1/audio/transcriptions \
  -H "Authorization: Bearer $OMNIVOICE_API_KEY" \
  -F "file=@check.wav" -F "model=<resolved-asr-engine-id>"
```

Caveat **[D]**: use the **resolved engine id** (from `GET /engines` or
`GET /v1/models`), not an OpenAI alias. `/health` reports
`{"status","device","engine","version"}` where `device` is the device the *active
TTS engine* generates on (`cpu`, `cuda (...)`, …).

Python bridge (dependency-free) **[D]**: `python -m backend.speech_client capabilities`
and `python -m backend.speech_client transcribe recording.wav`, honouring
`VOICESTUDIO_URL`, `OMNIVOICE_PORT` (default 3900) and `OMNIVOICE_API_KEY`.

---

## 8. Recommended CPU ASR tier

### For a 4 GB RAM target

- **`faster-whisper-small`, int8** (463.7 MB weights, ~0.9–1.4 GB peak) — the only
  tier with real headroom.
- Set `ASR_MODEL_FASTER=small`, pin `OMNIVOICE_ASR_BACKEND=faster-whisper`, and
  `OMNIVOICE_DEVICE=cpu`.
- Expect to load **one** model at a time. `OMNIVOICE_SINGLE_ENGINE_RESIDENT=1`
  (the default) and `OMNIVOICE_IDLE_TIMEOUT_S` short (e.g. 120–300) matter more
  than any speed knob here.
- `distil-large-v3` is *not* the answer at 4 GB: distil shrinks the decoder, not
  the encoder, so it lands near medium in memory.
- Realistically: on 4 GB this box is an **ASR-only** deployment. Do not expect
  OmniVoice TTS to work.

### For a 32 GB RAM target

- **`faster-whisper-large-v3`, int8** (2,947.7 MB, ~3.4–3.9 GB peak) if accuracy
  matters; **`medium`** (1,459.7 MB) if you want lower latency and shorter
  transcript latency tails.
- With 32 GB you can also afford `OMNIVOICE_SINGLE_ENGINE_RESIDENT=0` to keep
  several TTS engines warm, and a real `whisper.cpp` build alongside.
- For dubbing/word timestamps prefer WhisperX; for plain transcription
  faster-whisper (no wav2vec2 alignment pass, cheaper).

---

## 9. Top 5 deployment risks

1. **4 GB is likely below the practical floor.** The only image is a combined
   CUDA/CPU build: 5.58 GB compressed across 23 layers, largest layer 4.07 GB
   **[V]**. Add the ~2.4 GB default OmniVoice weights **[D]** plus Python/torch RSS
   and a 4 GB WSL2 VM will OOM during model load, not during inference. There is
   no CPU-slim image. Mitigation: raise the VM to ≥8–12 GB, or run ASR-only with
   `faster-whisper-small` and the TTS engine never loaded.
2. **Tag churn / wrong pin.** `:latest` and `:main` are rolling previews rebuilt
   from every `main` commit (observed build 2026-11-14 for `latest` vs 2026-11-12
   for `stable`) **[V]**; `:stable` floats to each release **[D]**. Worse, the
   registry `tags/list?n=1000` response is truncated at exactly 1000 entries and
   **did not include `0.5.8`** even though the tag exists **[V]** — so tag
   enumeration alone is unreliable. Always pin `:0.5.8@sha256:9cfc492a…`.
3. **CPU-tuned engines are not in the image.** whisper.cpp needs a user-supplied
   `whisper-cli` + GGML model (never auto-downloaded) **[D]**; OmniVoice GGUF ships
   only in desktop installers **[D]**; KittenTTS / Supertonic-3 / PocketTTS need
   `pip`/`uv` extras **[D]**. The stock image's CPU story is "slow OmniVoice" — a
   derived image is the real answer, which adds build and maintenance surface.
4. **MCP is unauthenticated at the transport level.** Upstream states the MCP
   transport is not authenticated and must not face the internet **[D]**; any
   non-localhost host (Docker, Tailscale name, reverse proxy) additionally needs
   `OMNIVOICE_MCP_ALLOWED_HOSTS` or the DNS-rebinding guard refuses it **[D]**. The
   failure mode is a confusing refusal, not a clear auth error, and the "fix"
   people reach for (allowlist `*`, or publishing `0.0.0.0:3900`) hands an
   unauthenticated speech API to the network. Keep `127.0.0.1:3900` and tunnel.
5. **Licence and licence-gating surprises.** App is AGPL-3.0 **[V]** — network
   serving triggers AGPL obligations. Model weights are separately licensed
   **[D]**, `/v1/audio/speech` returns **403** when a model licence has not been
   accepted, and some engines (audio.cpp Breeze-TTS weights) are
   research/non-commercial **[D]**. Also note `/health` can read `unknown` rather
   than `cpu` on unverified devices, and CPU renders get a much larger generation
   budget (`OMNIVOICE_CPU_GENERATE_TIMEOUT_S`, default 600 s, scaling at 4 s per
   input character up to a 2 h cap) **[D]** — a naive 30 s client timeout will
   look like a hang.

### Two smaller ones worth knowing

- `/v1/audio/*` is mounted with `Depends(require_consumer)` **[V]**; the API key is
  a **root** credential, not a per-route token, so a shared key grants admin too
  **[D]**. Use a path-allowlisting proxy if the backend is multi-tenant.
- Docker NAT makes every request look non-loopback, hence `OMNIVOICE_SERVER_MODE=1`
  in the image **[D]**. That keeps admin routes reachable from the LAN port mapping
  if you publish `0.0.0.0:3900`.

---

## 10. Minimal pinned CPU compose (derived from verified + documented facts)

```yaml
services:
  voicestudio:
    image: ghcr.io/debpalash/voicestudio:0.5.8@sha256:9cfc492a350ea34ad65ac991cf3b9e0030e3318d684c26435a6a44b074871f0d
    restart: unless-stopped
    environment:
      OMNIVOICE_API_KEY: ${OMNIVOICE_API_KEY:?set a long random key}
      OMNIVOICE_DATA_DIR: /app/omnivoice_data
      OMNIVOICE_DEVICE: cpu
      OMNIVOICE_ASR_BACKEND: faster-whisper
      ASR_MODEL_FASTER: small           # 4 GB target; use large-v3 on 32 GB
      OMNIVOICE_ANALYTICS_DISABLED: "1"
      # OMNIVOICE_MCP_ALLOWED_HOSTS: "host.containers.internal:*,mcp.example.internal:*"
    ports:
      - "127.0.0.1:3900:3900"
    volumes:
      - voicestudio-data:/app/omnivoice_data
      - voicestudio-models:/app/omnivoice_data/huggingface
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3900/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 120s

volumes:
  voicestudio-data:
  voicestudio-models:
```

`start_period: 120s` matters: `/health` returns 503 while heavy init runs, and the
image `HEALTHCHECK` only flips healthy at 200 **[D]**.

---

## 11. Fallback if GHCR were to deny anonymous access

It did **not** deny anonymous access in this session — `docker manifest inspect`
and the anonymous `ghcr.io/token` flow both succeeded **[V]**. Recorded fallbacks
in priority order:

1. **Docker Hub mirror** — `palashdeb/omnivoice-studio:0.5.8`, same images and tag
   semantics, published by the same project **[D]**. Verify its digest separately;
   do not assume it equals the GHCR digest.
2. **Build from source** — `deploy/Dockerfile` with
   `--build-arg BASE_IMAGE=<cpu|cuda|rocm|cuda-arm64>-base`, plus
   `deploy/uv-overrides.txt`, `deploy/security-constraints.txt` and
   `deploy/security_floors.py` which the official build applies **[D]**.
3. **Native install** instead of a container: `curl -fsSL https://voicestudio.sh/install | sh`
   or the repo's `scripts/install.sh`, then run the backend directly **[D]**.

---

## 12. What I did not verify

- No container was pulled or started (scratch pulls were out of scope, and the
  5.58 GB image would have polluted the disk).
- Therefore unverified at runtime: that `/mcp/` answers JSON-RPC on 0.5.8; that
  faster-whisper/WhisperX import cleanly in this image; the effective
  `ASR_MODEL_FASTER` default; actual CPU realtime factor; actual peak RSS.
- Model peak-RAM figures are my estimates; only the on-disk sizes in §6 are
  measured.
- Star/fork counts are as returned by the GitHub API at query time and are not
  independently audited.

## Sources

- Repo: <https://github.com/debpalash/VoiceStudio>
- README: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/README.md>
- Docker install: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/install/docker.md>
- MCP: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/mcp.md>
- Local speech platform: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/speech-platform.md>
- Production private API: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/production-private-api.md>
- Engine catalog: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/engines/README.md>
- Faster-Whisper engine: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/engines/faster-whisper.md>
- whisper.cpp engine: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/engines/whisper-cpp.md>
- Performance: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/performance.md>
- Model downloads: <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/docs/downloading-models.md>
- OpenAI-compatible routes (source): <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/backend/api/routers/openai_compat.py>
- Backend app/MCP mount (source): <https://raw.githubusercontent.com/debpalash/VoiceStudio/main/backend/main.py>
- GHCR package: <https://github.com/debpalash/VoiceStudio/pkgs/container/voicestudio>
- Docker Hub mirror: <https://hub.docker.com/r/palashdeb/omnivoice-studio>
- CTranslate2 model repos: <https://huggingface.co/Systran/faster-whisper-small>, <https://huggingface.co/Systran/faster-whisper-medium>, <https://huggingface.co/Systran/faster-whisper-large-v3>
- GitHub API: <https://api.github.com/repos/debpalash/VoiceStudio>