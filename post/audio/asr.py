"""Transcribes a clip with faster-whisper (the intelligibility check). Usage: asr.py <wav> [language]. Prints one JSON line."""
import json, os, subprocess, sys

import numpy as np
from faster_whisper import WhisperModel

# ASR_DEVICE=cpu on the GPU worker (Gen's docs/gpu-providers.md): no cuDNN to find, and a few seconds per take.
device = os.environ.get("ASR_DEVICE", "auto")
model = WhisperModel("small", device=device, compute_type="int8" if device == "cpu" else "auto")
# ffmpeg decodes (16 kHz mono float), not faster-whisper's PyAV path: PyAV 15+ dropped an argument faster-whisper passes.
pcm = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", sys.argv[1], "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
audio = np.frombuffer(pcm, dtype=np.float32)
segments, info = model.transcribe(audio, language=(sys.argv[2] if len(sys.argv) > 2 else None), vad_filter=False)
text = " ".join(s.text.strip() for s in segments).strip()
print(json.dumps({"text": text, "language": info.language}))
