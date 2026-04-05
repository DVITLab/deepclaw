#!/usr/bin/env python3
"""Transcribe one audio file to stdout using faster-whisper (local, no API)."""
from __future__ import annotations

import os
import sys

def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <audio-file>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(f"Not a file: {path}", file=sys.stderr)
        sys.exit(2)

    model_size = os.environ.get("DEEPCLAW_WHISPER_MODEL", "tiny").strip() or "tiny"
    device = os.environ.get("DEEPCLAW_WHISPER_DEVICE", "cpu").strip() or "cpu"
    compute_type = os.environ.get("DEEPCLAW_WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"

    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    segments, _info = model.transcribe(
        path,
        beam_size=1,
        vad_filter=True,
    )
    text = "".join(segment.text for segment in segments).strip()
    print(text, end="")


if __name__ == "__main__":
    main()
