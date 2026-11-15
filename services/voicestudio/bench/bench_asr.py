#!/usr/bin/env python3
"""ASR benchmark against the deployed VoiceStudio OpenAI-compatible endpoint.

Runs ON the VM (needs `sudo docker inspect` + the cgroup file of the
container), and can recreate the container so each measurement starts from a
cold process with a fresh cgroup — that way ``memory.peak`` is attributable to
exactly one model instead of the container's whole life.

    python3 bench_asr.py --model Systran/faster-whisper-small --label small
    python3 bench_asr.py --model Systran/faster-whisper-medium --label medium

Everything is measured, nothing is estimated: wall clock comes from
time.perf_counter() around the HTTP POST, the audio duration from the WAV
header, peak RSS from the cgroup ``memory.peak`` counter, and WER from a
word-level Levenshtein against the sentence that was synthesised.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

BASE = "http://127.0.0.1:3900"
COMPOSE_DIR = Path("/opt/operant/voicestudio")
BENCH_DIR = COMPOSE_DIR / "bench"
CONTAINER = "voicestudio"


def sh(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=check)


def sudo(*args: str, check: bool = True) -> str:
    return sh("sudo", *args, check=check).stdout.strip()


def wait_healthy(timeout_s: float = 600.0) -> float:
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout_s:
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=3) as r:
                if r.status == 200:
                    return time.perf_counter() - t0
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit("service never became healthy")


def container_id() -> str:
    return sudo("docker", "inspect", "-f", "{{.Id}}", CONTAINER)


def cgroup_dir(cid: str) -> Path:
    return Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope")


def read_cg(cid: str, name: str) -> int | None:
    p = cgroup_dir(cid) / name
    try:
        return int(p.read_text().strip())
    except Exception:
        return None


def recreate(model_id: str | None) -> dict:
    """Recreate the container, optionally pinning ASR_MODEL_FASTER."""
    t0 = time.perf_counter()
    if model_id:
        override = Path("/tmp/bench-asr.override.yaml")
        override.write_text(
            "services:\n  voicestudio:\n    environment:\n"
            "      OMNIVOICE_ASR_BACKEND: faster-whisper\n"
            f"      ASR_MODEL_FASTER: {model_id}\n"
        )
        sudo("docker", "compose", "-f", "compose.yaml", "-f", str(override), "up", "-d")
    else:
        sudo("docker", "compose", "up", "-d")
    healthy_after = wait_healthy()
    return {
        "recreate_cmd": f"docker compose up -d (ASR_MODEL_FASTER={model_id})",
        "compose_up_to_healthy_s": round(time.perf_counter() - t0, 2),
        "health_probe_healthy_s": round(healthy_after, 2),
    }


def transcribe(wav: Path, timeout: float = 2400.0) -> tuple[float, dict]:
    boundary = "----voicestudio-bench"
    body = bytearray()
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n'
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n'
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="language"\r\n\r\nen\r\n'
    body += f"--{boundary}\r\n".encode()
    body += (
        f'Content-Disposition: form-data; name="file"; filename="{wav.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode()
    body += wav.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{BASE}/v1/audio/transcriptions",
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:2000]
        raise SystemExit(
            f"transcription failed: HTTP {exc.code}\n{detail}"
        ) from None
    return time.perf_counter() - t0, payload


def wer(reference: str, hypothesis: str) -> tuple[float, int, int, int]:
    import re

    def toks(s: str) -> list[str]:
        s = s.lower().replace("’", "'")
        s = re.sub(r"[^a-z0-9' ]+", " ", s)
        return s.split()

    ref, hyp = toks(reference), toks(hypothesis)
    d = [[0] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
    for i in range(len(ref) + 1):
        d[i][0] = i
    for j in range(len(hyp) + 1):
        d[0][j] = j
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    edits = d[len(ref)][len(hyp)]
    return (edits / len(ref) if ref else float("nan")), edits, len(ref), len(hyp)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="faster-whisper repo id")
    ap.add_argument("--label", required=True)
    ap.add_argument("--audio", default=str(BENCH_DIR / "known-sentence.wav"))
    ap.add_argument("--reference", default="")
    ap.add_argument("--warm-runs", type=int, default=3)
    ap.add_argument("--no-recreate", action="store_true")
    args = ap.parse_args()

    wav = Path(args.audio)
    with wave.open(str(wav)) as w:
        audio_s = w.getnframes() / float(w.getframerate())
        fmt = {
            "channels": w.getnchannels(),
            "sample_rate": w.getframerate(),
            "bits": w.getsampwidth() * 8,
        }

    out: dict = {
        "label": args.label,
        "model_id": args.model,
        "audio": str(wav),
        "audio_format": fmt,
        "audio_duration_s": round(audio_s, 3),
        "started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    if not args.no_recreate:
        out["boot"] = recreate(args.model)

    cid = container_id()
    out["container_id"] = cid
    out["peak_rss_bytes_cgroup_memory_peak"] = read_cg(cid, "memory.peak")

    # Cold: includes model load (and, if it were missing, the download).
    for attempt in (1, 2):
        try:
            cold_s, cold_payload = transcribe(wav)
            break
        except Exception as exc:  # noqa: BLE001
            if attempt == 2:
                raise
            print(f"  cold attempt failed ({exc}); retrying once", file=sys.stderr)
            time.sleep(5)
    out["cold_request_s"] = round(cold_s, 3)
    out["cold_text"] = cold_payload.get("text", "")

    # Warm: steady state after the model is resident.
    warm: list[float] = []
    texts: list[str] = []
    for i in range(args.warm_runs):
        dt, payload = transcribe(wav)
        warm.append(dt)
        texts.append(payload.get("text", ""))
        print(f"  warm[{i + 1}] {dt:.3f}s :: {payload.get('text', '')[:90]}")

    out["warm_request_s"] = [round(x, 3) for x in warm]
    out["warm_median_s"] = round(statistics.median(warm), 3)
    out["warm_min_s"] = round(min(warm), 3)
    out["rtf"] = round(statistics.median(warm) / audio_s, 4)
    out["rtf_cold"] = round(cold_s / audio_s, 4)

    peak = read_cg(cid, "memory.peak")
    out["peak_rss_bytes_cgroup_memory_peak"] = peak
    out["peak_rss_mib"] = round(peak / 2**20, 1) if peak else None
    out["oom_killed"] = (
        sudo("docker", "inspect", "-f", "{{.State.OOMKilled}}", CONTAINER) == "true"
    )
    out["transcript_text"] = texts[-1]
    out["transcripts"] = texts

    ref = args.reference or os.environ.get("KNOWN_TEXT", "")
    if ref:
        rate, edits, n_ref, n_hyp = wer(ref, texts[-1])
        out["wer"] = {
            "reference": ref,
            "hypothesis": texts[-1],
            "rate": round(rate, 4),
            "edits": edits,
            "ref_words": n_ref,
            "hyp_words": n_hyp,
        }

    # Which backend/model the service actually reports as active. Kept compact
    # so the JSON stays a readable result file rather than a dump of the
    # per-engine capability tree.
    try:
        with urllib.request.urlopen(f"{BASE}/engines/asr", timeout=30) as r:
            engines = json.loads(r.read())
        out["engine_active"] = {
            k: engines.get(k)
            for k in ("active", "active_model", "env_override")
        }
    except Exception as exc:  # noqa: BLE001
        out["engine_active"] = f"unavailable: {exc}"

    out_path = BENCH_DIR / f"asr-{args.label}.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k != "engines_asr"}, indent=2))
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())