# Appliance profile — i7-10700KF · RX 580 · 32 GB DDR4 · 512 GB SSD

This is the target physical machine. Compose with:

```bash
docker compose -f docker-compose.yml -f docker-compose.appliance.yml up -d --build
```

## 1. What the hardware actually gives us

| Component | Spec | Does it help this platform? |
|---|---|---|
| CPU | i7-10700KF — 8 cores / 16 threads, Comet Lake | **Yes.** This is the whole compute budget. Agent jobs are model-API bound, but speech ASR, builds and Postgres are local CPU work. |
| RAM | 32 GB DDR4 | **Yes, comfortably.** Fits Postgres + 2 agent workers + a 16 GB speech service + OS with headroom. |
| SSD | 512 GB | **Adequate but the tightest constraint.** See §4. |
| GPU | RX 580 (Polaris, GCN 4 / gfx803) | **No.** See §2. |

## 2. Why the RX 580 is deliberately excluded

The mission says no GPU unless independently justified. On this card it is not
just unjustified — it is **not usable** for this workload:

- ROCm dropped Polaris (`gfx803`) from supported targets years ago. There is no
  maintained PyTorch/CTranslate2 path that will run Whisper on it.
- Vulkan-based whisper.cpp is the only escape hatch, it is materially slower
  than modern CPU inference for these model sizes, and it makes the deployment
  unportable (a hand-built binary, not a pinned image).
- VoiceStudio ships `linux/amd64` **CUDA/CPU combined** images only. There is no
  ROCm variant to point at.

So the CPU path measured on the GCP box (faster-whisper small, **0.258 RTF** at
0 % WER on the bench clip) is the right default, and this i7 will be *faster*
than the 8 vCPU Xeon-class VM per core. Do not spend effort on the GPU.

## 3. Concurrency budget (the numbers in this profile)

16 threads, but not 16 useful workers. Agent runs spend their time waiting on
the model API, while ASR and builds are genuinely CPU-hungry. The binding
constraint is RAM per concurrent speech request (~1.1 GB at `small`).

| Consumer | Setting here | Why |
|---|---|---|
| `worker` | `WORKER_CONCURRENCY=3` | 3 concurrent agent runs is plenty for one human. Each is mostly I/O; 3 leaves CPU for speech. |
| `voicestudio` | `mem_limit: 16g` | One `small` ASR run peaks ~1.1 GB; 16g allows a couple of concurrent transcriptions plus model cache. |
| `postgres` | `shm_size: 512m`, no mem_limit | Event tables are small; let the kernel page cache work. |
| `api` | no mem_limit | It is a thin proxy + query layer. |
| Node heap | not pinned | Default is fine at these sizes; pinning causes surprise OOMs more often than it prevents them. |

Admission control: keep **at most 2** heavy local jobs (a `next build` or a
large transcription) running alongside 3 agent workers. Beyond that the box
thrashes and latency, not throughput, degrades.

## 4. Disk budget on 512 GB

Image and data footprint, measured or estimated:

| Item | Size |
|---|---|
| `voicestudio` image (compressed → on-disk) | ~5.6 GB → ~12 GB |
| ASR models `small` / `medium` / `large-v3` | 0.46 / 1.46 / 2.95 GB |
| Node base + app image + `node_modules` | ~2 GB |
| Postgres data (years of jobs/events at this scale) | < 2 GB |
| **Recommended reserve kept free** | **≥ 60 GB** |

The GCP deployment already failed once because the host volume hit **0 bytes**
and silently truncated a source file. Mitigations baked in here:

1. Docker log rotation is set (`max-size: 50m`, `max-file: 3`) so a chatty
   service cannot fill the disk with logs.
2. `scripts/disk-guard.sh` refuses to start a heavy job below a threshold.
3. Keep the repository itself tiny — it is ~600 KB of source; everything else
   is rebuilt. That is what makes the SSD swap trivial.

## 5. What changes vs the default profile

`docker-compose.appliance.yml` only *overrides*; it never redefines services.
It raises worker concurrency for the 16-thread CPU, pins the speech service's
memory, enables log rotation everywhere, and sets an ASR default appropriate for
8 physical cores.

## 6. First-run checklist on the new machine

```bash
bash infra/appliance/preflight.sh          # cores / RAM / free disk / docker
cp .env.example .env
mkdir -p secrets && $EDITOR secrets/.credentials.yaml   # SURPLUS_API_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # OPERANT_BOT_TOKEN
docker compose -f docker-compose.yml -f docker-compose.appliance.yml up -d --build
curl -s localhost:8787/v1/health
```

`preflight.sh` fails closed below 4 cores / 8 GB RAM / 60 GB free, because
starting anyway produces a platform that appears to work and then OOMs under a
real transcription.

Bare-metal build and migration runbook: [../../docs/APPLIANCE.md](../../docs/APPLIANCE.md)

