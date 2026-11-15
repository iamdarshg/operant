#!/usr/bin/env bash
# ASR benchmark: faster-whisper small vs medium on the SAME synthesised WAV.
# Run ON operant-core after both models are installed (Model Catalogue install
# via POST /models/install — see README).
#
#   bash /opt/operant/voicestudio/scripts/bench.sh
#
# Each measurement recreates the container with ASR_MODEL_FASTER pinned, so the
# per-container cgroup memory.peak is attributable to one model.
set -euo pipefail
cd /opt/operant/voicestudio

export KNOWN_TEXT="The server hums quietly beside the cooling fan while the operator checks the morning logs."
REF="$KNOWN_TEXT"

python3 bench/bench_asr.py --model Systran/faster-whisper-small  --label small  --reference "$REF" --warm-runs 3
python3 bench/bench_asr.py --model Systran/faster-whisper-medium --label medium --reference "$REF" --warm-runs 3

python3 bench/summarize.py --out bench/summary.md