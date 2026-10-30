"""Transcribes a clip with faster-whisper (the intelligibility check). Usage: asr.py <wav> [language]. Prints one JSON line."""
import json, os, sys
from faster_whisper import WhisperModel

# ASR_DEVICE=cpu on the GPU worker (Gen's docs/gpu-providers.md): no cuDNN to find, and a few seconds per take.
device = os.environ.get("ASR_DEVICE", "auto")
model = WhisperModel("small", device=device, compute_type="int8" if device == "cpu" else "auto")
segments, info = model.transcribe(sys.argv[1], language=(sys.argv[2] if len(sys.argv) > 2 else None), vad_filter=False)
text = " ".join(s.text.strip() for s in segments).strip()
print(json.dumps({"text": text, "language": info.language}))
