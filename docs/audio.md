# Audio: the open-model sound suite

Voices, sound effects and music from Gen's own open models are the **primary** path; ElevenLabs is **secondary** (decision
m_0d7841671d85, J 2026-10-25). They run wherever GPU jobs run (below, "Where it runs"). What still needs a real GPU run is
at the end ("Not verified without a server").

## Where it runs (2026-10-30)

J, 2026-10-30: "We have our own audio jobs on gen right? We should use those", "fast and cheap. AND we want quality ...
implement it so it's not complicated, works in the existing system". The AWS fleet (the only place the open models ran, over
SSH) is gone, so they now run on the same GPU providers as every image and video job (RunPod, Modal: docs/gpu-providers.md),
through the same queue, broker, billing and resume:
- **Voices: Qwen3-TTS** (speak, direction, voice design, clone; Apache-2.0) is **in the GPU worker image**
  (`server/cloudrun/Dockerfile`): its own venv under `/opt/hawkes-audio/qwen3-tts` that shares ComfyUI's PyTorch through a
  `.pth` (its `transformers==4.57.3` pin wins inside the venv and never touches ComfyUI), plus `asr` (faster-whisper, on the
  CPU) for `verify`. Gen sends one request whose "graph" is `{ "hawkes_audio": spec }` (`audio-open.ts synthesizeRemote`);
  the worker runs `post/audio/run.py` (copied into the image) and returns its `out/` folder. Weights download from Hugging
  Face on a worker's first voice job (about 4.5 GB per Qwen repo; on the provider's volume at `MODELS_MOUNT/hf` when mounted).
  VoxCPM2 and Chatterbox are not in the image (a job naming them says so).
- **Sound effects: Stable Audio 3 Medium** as a ComfyUI workflow (`workflows/audio-sfx-sa3`: ComfyUI's own template without its
  Qwen prompt rewrite, 8 LCM steps, about 10 GB of models fetched from their Hugging Face URLs). `audio.sfx` runs it one graph
  per take and keeps its own post-processing (trim, loudness, seamless loops). The broker also serves any workflow
  manifest's model URLs now, so `audio.music` (ACE-Step) fetches its models the same way.
- **House voices** (`src/audio/house.ts`): twelve ready-made voices (`hv_` ids: name, about, a voice description and a
  seed) that the app, the AI and the director cast. `tools/house-voices.mjs --make` designs each once and saves it to the
  `shared` project under its id; from then on every line clones that sample (the same voice in every line) and the app plays
  it as the preview (`GET /v1/audio/house/:id/preview`). Before that, each line is designed from the description and seed.
- On the fleet (if it comes back) nothing changed: the same tools install the venv over SSH.
- **Measured on beta** (2026-10-30, RunPod L40S class): a voice line about 31-56 GPU seconds and $0.015-0.03 once a worker is
  warm (75 s end to end; a host's first start pulls the image and the Qwen weights, about 5 minutes); a Stable Audio 3 effect
  about 50 GPU seconds and $0.02-0.03. The villain line came back word for word through the transcriber. All twelve house
  voices have samples on beta (`tools/house-voices.mjs --beta --make`); live gets them after its deploy.
- Loudness is one measured gain (ebur128) under the true-peak ceiling, a limiter past it (`post.ts loudnessGain`): ffmpeg 5.1's
  loudnorm (Gen's image) made a 2 s effect quieter, and resampled every take to 192 kHz.
- The transcriber decodes with ffmpeg: PyAV 15 dropped an argument faster-whisper still passes. When it fails anyway, the
  takes come back unchecked (`verifySkipped` says why), not wrong.
- **Modal** runs the same image too (2026-10-31): a voice line there took 64 s from a warm container, $0.05, word for word.

Every name that callers use today keeps working: `audio.voice`, `audio.sfx`, `audio.dialogue`, `audio.voice-design`,
`audio.voice-save`, `audio.voice-list`, `audio.voice-delete`, `audio.voice-change`, `audio.music`. Their ElevenLabs params,
defaults and version are unchanged, so no existing recipe (`generatedFrom` keys with the voice id and model) looks out of date.

## Providers and routing

**The open suite is the default for every audio tool; ElevenLabs runs only when asked** (J, 2026-10-25: "Eleven labs is secondary").
Every shared name takes `provider`: `open`, `elevenlabs` or `auto`; unset is `auto`, which means **open**. `Tool.route` hands the
call to the open twin at submit (the job then runs and is recorded as that tool, with the label `requestedTool`).

| Call | Runs on |
|---|---|
| `audio.voice`, `audio.sfx`, `audio.dialogue`, `audio.voice-design`, `audio.voice-save`, `audio.voice-list`, `audio.voice-delete` | the open suite (the Gen voice library for save, list and delete), verified model or not; a verified one is preferred when several fit |
| `audio.voice` with an ElevenLabs voice id (not `gv_`) | ElevenLabs: old content (Unity `audio.json`, DoD `content/voice.json`, PH Origins voice lines) keeps its voice |
| `audio.dialogue` with any ElevenLabs voice id in the cast | ElevenLabs |
| any of them with `provider: "elevenlabs"` | ElevenLabs |
| `audio.voice-change` | ElevenLabs only (no open model yet; Chatterbox VC is the candidate). `provider: "open"` is refused |

There is no silent fall back to ElevenLabs for list, design, save, delete or sound effects. A speak or dialogue call
that carries an ElevenLabs voice id and fails on the open path may fall back to ElevenLabs (and says so in its log);
`provider: "open"` never falls back. The model's default `eleven_*` value is always filled in, so a model name alone does
not select ElevenLabs: pass `provider: "elevenlabs"` or an ElevenLabs voice id.

**While ElevenLabs billing is blocked** (the fail-fast billing error) a call with an ElevenLabs voice id fails and the message
says how to go on: clone that character's existing recording with `audio.voice-clone` (then `audio.voice` with `voice: gv_...`),
or design a new voice with `audio.voice-design` and keep it with `audio.voice-save` (`elevenlabsId` links the old id).

**Verified** = `settings.audio.verified` (POST `/v1/settings`, owner): a model that passed its smoke test and the audition.
It no longer gates routing; it only ranks models when several can do the job.

`GET /v1/audio/models` lists every model with its license, size, VRAM, what it can do and whether it is verified.

## Models and licenses (checked 2026-10-25 from the model pages; re-check before a product ships on one)

| Model | Use | Size / VRAM | License | Status |
|---|---|---|---|---|
| MOSS-TTS v1.5 (1.7B) | speak, direction, clone, design, dialogue | ~6 GB / 12 GB | Apache-2.0 (code and weights) | **blocked**: adapter not written |
| Qwen3-TTS 1.7B (VoiceDesign, Base, CustomVoice) | speak, direction, clone, design | ~14 GB / 10 GB | Apache-2.0; pins `transformers==4.57.3`, own venv | **the voice model**: in the worker image |
| VoxCPM2 (2B, 48 kHz) | speak, direction (voice description), clone, design | ~5 GB / 10 GB | Apache-2.0 | adapter written |
| Chatterbox | speak, direction (knobs and tags), clone | ~4 GB / 8 GB | MIT; outputs carry Resemble's Perth watermark | adapter written |
| MOSS-SoundEffect v2 (1.3B) | sfx, loop | ~5 GB / 10 GB | Apache-2.0 family, **v2 card not confirmed** | **blocked**: adapter not written |
| Stable Audio 3 Medium | sfx, loop | ~10 GB / 12 GB | Stability AI Community License: free under US$1M annual revenue | **the sound-effect model**: `workflows/audio-sfx-sa3` |
| ACE-Step 1.5 XL | music | ~12 GB / 20 GB | MIT | already `audio.music` |
| MMAudio / HunyuanVideo-Foley | video to foley | | MMAudio code MIT, weights unverified; Hunyuan excludes EU/UK/KR | not wired (optional, later) |
| MiniMax Music 3 | vocal songs | | license sources conflict | evaluation only, not wired |
| Fish Audio Drama 3 | | 35B MoE | unchecked; earlier Fish weights were non-commercial; too heavy for the fleet | not wired |

Refused outright (non-commercial): F5-TTS weights, Fish Speech / OpenAudio S1, XTTS v2 (`REFUSED_MODELS`; a test keeps them out).

**Why not ComfyUI custom nodes for the voices.** The brief named the ComfyUI wrappers (richservo/comfyui-moss-tts,
1038lab/ComfyUI-QwenTTS, wildminder/ComfyUI-VoxCPM). Node names and widget names cannot be checked without a server, and
the Qwen wrapper's `transformers==4.57.3` pin would clash with the shared ComfyUI env. So each model runs from its own
package in its own venv under `/opt/hawkes-audio/<model>` through one runner (`post/audio/run.py`), installed on first use
the way `motion.from-text` and `mesh.rig` install. A ComfyUI wrapper can replace an adapter later without touching the tools.

## Install (resumable, verified)

`src/providers/audio/install.ts` + `audio.ts`. The lessons built in:
- the install is a **detached systemd unit** (`hawkes-audio-install-<model>`); a Gen restart does not stop it, and the next job
  finds the unit active and waits instead of starting a second one;
- weights download into the Hugging Face cache (resumable); `verify.py` fails on any `.incomplete` blob or a file whose size
  differs from the hub's listing; only then is `READY` written (`<code ref> <pip hash>`), so a half-written model is never used;
- Ubuntu 24.04 has no `python3.11`: the deadsnakes PPA is added when the plain install fails (the `mesh.rig` fix);
- 30 GB free is required first; one venv per model keeps pins apart; faster-whisper (the intelligibility check) is its own component `asr`;
- a job on a server counts as activity for the idle shutdown (touches `last_busy`); GPU tools take one server per job like every GPU tool, family `audio:<model>`.

## Direction (emotion, delivery, pace, style)

`direction` is a sentence (`"tired, almost whispering"`) or `{ emotion, delivery, pace: slow|normal|fast, style, intensity: 0..1, notes }`.
ElevenLabs-style `[tags]` in the text count too (`"[sighs] I'm eleven seconds late."`). `src/audio/direction.ts` maps it per model:

| Model | What it gets |
|---|---|
| MOSS-TTS, Qwen3-TTS, VoxCPM2 (`instruct`) | one instruction sentence built from the direction and tags ("tired, almost whispering, slow pace, understated, with sighs"); tags are removed from the spoken text |
| Chatterbox (`tags`) | `exaggeration` from emotion/intensity, `cfg_weight` from pace (fast 0.3, slow 0.7); its own tags (`[laugh] [cough] [chuckle] [sigh] [gasp] [groan] [sniff]`) stay in the text |
| models with no direction | text only |

What a model cannot do is returned in `result.dropped` (e.g. `tag [growls]`, `style "noir"`); `result.applied` shows what was sent.

## Tools

| Tool | What |
|---|---|
| `audio.voice` / `audio.voice-open` | Speak a line. Voice from the Gen library (`voice: gv_...`), a cloned `reference` (3-10 s input), or a `description`. `direction`, `language`, `count` takes, `seed`, `verify` (transcribe each take, word-error-rate vs the text), post-processing params. |
| `audio.voice-design` / `-open` | Candidates (default 3) from a description, each saved in the Gen library as a candidate with recipe and its preview clip as reference. |
| `audio.voice-save` / `-open` | Names the one you keep (`gv_...`); `elevenlabsId` links the ElevenLabs voice the character uses today. |
| `audio.voice-clone` | A 3-10 s sample to a saved Gen voice (no GPU). Only clone voices you have the rights to. |
| `audio.voice-list` / `-delete` (open) | The Gen voice library: no slot cap. `provider: "open"`, `project: "*"` for all. |
| `audio.dialogue` / `-open` | Table read in Gen voices; per-line `direction`, `gapMs`/`pauseMs`; the same shape as ElevenLabs (track, one clip per line, `segments` with start/end). Lines are spoken one by one: no overlap or `[interrupting]`. |
| `audio.sfx` / `-open` | MOSS-SoundEffect (Stable Audio 3 when wired). `duration`, `loop` (made longer by `crossfade`, crossfaded, loop point checked), `count`, `variants` (a list of prompts for one event, each a take). |
| `audio.process` | Free, ffmpeg: trim silence, fade, loudness-normalise (per-product target), resample, wav / mp3 / ogg / flac. |
| `audio.analyze` | Free: LUFS, true peak, clipping, leading/trailing silence, length, optional loop-point check; `{ ok, problems }`. |
| `audio.music-loop` | Free: seamless loop (tail crossfaded into the head), `intro-loop` split, or `check` only. |
| `audio.music` | Unchanged (ACE-Step 1.5 XL, `lyrics` empty = instrumental). |

**Voice library.** Table `audio_voices` (id `gv_...`, project, name, description, model, language, `recipe`, reference clip
in `DATA_DIR/voices`, `elevenlabs_id`). A voice is its recipe, not a model file, so any server and any cloning model can
speak it. A designed voice with no reference clip can only be spoken by the model that designed it. The character voice
files (`content/voice.json`, Audio json) still hold ElevenLabs ids and keep working; to move a character, design or clone a
voice, save it with `elevenlabsId`, and change the product's id to the `gv_` id when J agrees.

**Post-processing** (`src/audio/post.ts`): every open take is silence-trimmed and loudness-normalised (two-pass `loudnorm`,
linear) to `settings.audio.targetLufs`: `<project>:<kind>`, `<project>`, `default:<kind>`, `default` (defaults -16 voice and
music, -18 sfx), converted from the `format` name (`mp3_44100_128` -> mp3, `wav`, `ogg`, `flac`), optional `sampleRate`, `fade`;
`normalize: false` and `trim: false` turn them off. Each take's measurements and the verdict are in its metadata and the result.

## Cost

Estimates come from `hawkesgen_estimate` (a routed call is priced as the tool that would run). Phase 1 numbers are the
tools' own guesses (no job history yet); the audition replaces them with measurements. Per call on an already-running,
already-installed server, GPU only: a 150-character line about 1 minute of GPU, 4 verified takes ~2 minutes, 3 voice
candidates ~1.5 minutes, a 6-line table read ~2 minutes, four 3 s effects ~1.5 minutes (each about $0.03-0.05 of GPU at
$1.86/h; the estimate adds server boot). Free tools (`audio.process`, `-analyze`, `-music-loop`, `-voice-clone`, the library
tools) run on the control server. Model installs (first use per server, not in these numbers): Qwen3-TTS ~14 GB, MOSS ~6 GB,
VoxCPM2 ~5 GB, Chatterbox ~4 GB, ASR ~0.5 GB, 10-15 minutes each on a fresh server.

## Audition (the quality gate)

`audio/audition-set.json`: real lines from the products (Sick Of It hero, announcer, overlord, with their tags; Dose Of
Destruction Exit Punk and Shutup Bot) and sounds (monster growl, UI click, footsteps x3, explosion, calm ambience loop, boss theme).

```
node tools/audition.mjs plan [--models qwen3-tts,voxcpm2]    # what would run + the priced estimate; spends nothing
node tools/audition.mjs run --yes [--no-elevenlabs]          # J's OK first
node tools/audition.mjs report <dir>
```

`run` writes `report.html` (every line across every engine side by side with players, LUFS, true peak, length, word error
rate and transcript, problems in red), `report.json` and the audio. ElevenLabs takes get the same free `audio.analyze`.
Chatterbox cannot design a voice, so it clones the ElevenLabs take of the same line. The checks filter; J listens.
A Gen started with `HAWKESGEN_AUDIO_MOCK=1` (any spare port, e.g. `HAWKESGEN_PORT=8899 HAWKESGEN_DATA_DIR=...`) runs the
whole thing with ffmpeg tones instead of a GPU: that is the smoke path.

## Music

Kept: `audio.music`. Added (free, ffmpeg): `audio.music-loop` for seamless loops, intro + loop pairs and the loop-point check.
**Not built in phase 1:** stems, cover/edit (ACE-Step M2M or YuE2 cover) and MiniMax Music 3 for vocal songs. Cover/edit and
stems need ComfyUI graphs from the ACE-Step templates (import from a running server with `hawkesgen_import_workflow`);
MiniMax needs its license read first (sources conflict). Both are in the follow-up list.

## Not verified without a server

- The runner's adapters (`post/audio/run.py`) are written from the packages' documented APIs (qwen-tts `Qwen3TTSModel`,
  `voxcpm.VoxCPM`, `chatterbox.tts.ChatterboxTTS`) and have never run. Package versions, model repo names (`Qwen/Qwen3-TTS-12Hz-1.7B-*`,
  `openbmb/VoxCPM2`, `ResembleAI/chatterbox`), sample rates, VRAM and install sizes are from model pages, not measured.
- **MOSS-TTS and MOSS-SoundEffect have no adapter yet** (`NotWired`): their entry points and the repo names
  (`OpenMOSS-Team/MOSS-TTS`, `OpenMOSS-Team/MOSS-SoundEffect`) need reading on a real install. richservo's ComfyUI nodes are the alternative.
- The worker image with the audio venvs has not been built yet (push a `gpu-image-*` tag), and no voice or Stable Audio 3
  job has run on RunPod or Modal: the first ones measure the cold start, the GPU seconds and the quality. The venv step was
  checked in a Linux container with CPU PyTorch (the `.pth` share, the pins, the imports), and the worker's audio request
  with a fake model.
- Code pins are `main` until the first install; the READY mark then records what was installed (`COMMIT` file for MOSS).
- Whether Qwen3-TTS runs on a 16 GB T4-class card in bf16, and which GPU the fleet should use for 8B MOSS.
