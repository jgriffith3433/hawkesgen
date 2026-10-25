"""Runs one audio job on a GPU server, inside the model's own venv (docs/audio.md).

Usage: <model venv python> /opt/hawkes-audio/run.py spec.json
spec.json: { "task": "speak"|"design"|"sfx", "model": id, "items": [ { id, text, instruct, exaggeration, cfg_weight,
speed, ref, ref_text, description, seconds, loop, seed, language } ] }
Writes out/<id>.wav (mono float WAV at the model's rate) and out/result.json. Progress lines start with "HB ".

Every adapter below is written from the package's documented API and has NOT been run on a GPU yet (phase 1).
A model that fails here fails the job with the real traceback; provider "auto" then falls back to ElevenLabs.
"""
import json, os, sys, time, traceback

import numpy as np
import soundfile as sf


def log(msg):
    print("HB " + msg, flush=True)


def seeded(seed):
    if seed is None:
        return
    import random
    random.seed(seed); np.random.seed(seed)
    try:
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass


def write(path, wav, rate):
    wav = np.asarray(wav, dtype=np.float32).squeeze()
    sf.write(path, wav, rate)
    return len(wav) / float(rate)


class Qwen3TTS:
    rate = 24000

    def __init__(self):
        import torch
        from qwen_tts import Qwen3TTSModel
        self.torch = torch
        self.kw = dict(device_map="cuda:0", dtype=torch.bfloat16)
        self.Model = Qwen3TTSModel
        self.cache = {}

    def model(self, repo):
        if repo not in self.cache:
            self.cache[repo] = self.Model.from_pretrained(repo, **self.kw)
        return self.cache[repo]

    def speak(self, it):
        lang = {"en": "English", "zh": "Chinese"}.get(it.get("language", "en"), "Auto")
        if it.get("ref"):
            m = self.model("Qwen/Qwen3-TTS-12Hz-1.7B-Base")
            wavs, sr = m.generate_voice_clone(text=it["text"], language=lang, ref_audio=it["ref"], ref_text=it.get("ref_text") or None)
        else:
            m = self.model("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
            # Without a reference the voice comes from the instruction: the description plus the direction.
            instruct = ". ".join(x for x in [it.get("description"), it.get("instruct")] if x) or "A clear, natural voice."
            wavs, sr = m.generate_voice_design(text=it["text"], language=lang, instruct=instruct)
        return wavs[0], sr

    design = speak


class VoxCPM2:
    rate = 48000

    def __init__(self):
        from voxcpm import VoxCPM
        self.m = VoxCPM.from_pretrained("openbmb/VoxCPM2")
        self.rate = getattr(getattr(self.m, "tts_model", None), "sample_rate", 48000)

    def speak(self, it):
        text = it["text"]
        # VoxCPM2 takes a voice description in parentheses in front of the text (voice design / direction).
        desc = ", ".join(x for x in [it.get("description"), it.get("instruct")] if x)
        if desc and not it.get("ref"):
            text = f"({desc}){text}"
        kw = {}
        if it.get("ref"):
            kw = dict(prompt_wav_path=it["ref"], prompt_text=it.get("ref_text") or None)
        return self.m.generate(text=text, cfg_value=2.0, inference_timesteps=10, **kw), self.rate

    design = speak


class Chatterbox:
    rate = 24000

    def __init__(self):
        from chatterbox.tts import ChatterboxTTS
        self.m = ChatterboxTTS.from_pretrained(device="cuda")
        self.rate = self.m.sr

    def speak(self, it):
        kw = {}
        if it.get("exaggeration") is not None: kw["exaggeration"] = it["exaggeration"]
        if it.get("cfg_weight") is not None: kw["cfg_weight"] = it["cfg_weight"]
        if it.get("ref"): kw["audio_prompt_path"] = it["ref"]
        wav = self.m.generate(it["text"], **kw)
        return wav.squeeze().cpu().numpy(), self.rate

    def design(self, it):
        raise RuntimeError("Chatterbox has no voice design; clone from a sample instead")


class NotWired:
    """MOSS-TTS / MOSS-SoundEffect: the adapter is not written until the package's entry point is read on a real install."""
    def __init__(self, name):
        self.name = name
    def speak(self, it):
        raise RuntimeError(f"{self.name}: the runner adapter is not verified yet; run tools/audition.mjs --probe on a server and finish run.py")
    design = speak


ADAPTERS = {
    "qwen3-tts": lambda: Qwen3TTS(),
    "voxcpm2": lambda: VoxCPM2(),
    "chatterbox": lambda: Chatterbox(),
    "moss-tts": lambda: NotWired("MOSS-TTS"),
    "moss-soundeffect": lambda: NotWired("MOSS-SoundEffect"),
}


def main():
    spec = json.load(open(sys.argv[1]))
    os.makedirs("out", exist_ok=True)
    log(f"step loading {spec['model']}")
    t0 = time.time()
    adapter = ADAPTERS[spec["model"]]()
    load = time.time() - t0
    results = []
    for i, it in enumerate(spec["items"]):
        log(f"step {spec['task']} {i + 1} of {len(spec['items'])}")
        seeded(it.get("seed"))
        t = time.time()
        fn = adapter.design if spec["task"] == "design" else adapter.speak
        wav, rate = fn(it)
        secs = write(f"out/{it['id']}.wav", wav, rate)
        results.append({"id": it["id"], "seconds": secs, "rate": rate, "gpu_seconds": time.time() - t})
        log(f"item {it['id']} {secs:.2f}")
    json.dump({"model": spec["model"], "load_seconds": load, "items": results}, open("out/result.json", "w"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
