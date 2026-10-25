"""Transcribes a clip with faster-whisper (the intelligibility check). Usage: asr.py <wav> [language]. Prints one JSON line."""
import json, sys
from faster_whisper import WhisperModel

model = WhisperModel("small", device="auto", compute_type="auto")
segments, info = model.transcribe(sys.argv[1], language=(sys.argv[2] if len(sys.argv) > 2 else None), vad_filter=False)
text = " ".join(s.text.strip() for s in segments).strip()
print(json.dumps({"text": text, "language": info.language}))
