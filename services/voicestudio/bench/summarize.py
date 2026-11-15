#!/usr/bin/env python3
"""Collapse bench/asr-*.json into one markdown table (numbers copied, not derived)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

BENCH = Path(__file__).resolve().parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(BENCH / "summary.md"))
    ap.add_argument("--labels", nargs="*", default=["small", "medium"])
    args = ap.parse_args()

    rows = []
    for label in args.labels:
        path = BENCH / f"asr-{label}.json"
        if not path.exists():
            continue
        d = json.loads(path.read_text())
        rows.append(d)

    if not rows:
        raise SystemExit("no bench/asr-*.json results found")

    lines = [
        "| model id | audio (s) | cold request (s) | warm median (s) | RTF | peak RSS (MiB) | WER |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for d in rows:
        wer = d.get("wer", {}).get("rate")
        lines.append(
            "| `{m}` | {a} | {c} | {w} | {r} | {p} | {e} |".format(
                m=d["model_id"],
                a=d["audio_duration_s"],
                c=d["cold_request_s"],
                w=d["warm_median_s"],
                r=d["rtf"],
                p=d.get("peak_rss_mib"),
                e=f"{wer * 100:.1f}%" if isinstance(wer, (int, float)) else "n/a",
            )
        )
    lines.append("")
    for d in rows:
        lines.append(f"- `{d['model_id']}` transcript: {d.get('transcript_text', '').strip()}")
    text = "\n".join(lines) + "\n"
    Path(args.out).write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())