# Audio: the open-model sound suite

Voices, sound effects and music from open models on the Gen GPU fleet are the **primary** path; ElevenLabs is
**secondary** (decision m_0d7841671d85, J 2026-10-25). Phase 1 (this change) designed, wired and priced all of it; **nothing
has run on a GPU yet**. What still needs a server is at the end ("Not verified without a server").

Every name that callers use today keeps working: `audio.voice`, `audio.sfx`, `audio.dialogue`, `audio.voice-design`,
`audio.voice-save`, `audio.voice-list`, `audio.voice-delete`, `audio.voice-change`, `audio.music`. Their ElevenLabs params,
defaults and version are unchanged, so no existing recipe (`generatedFrom` keys with the voice id and model) looks out of date.

## Providers and routing

Every shared name takes `provider`: `open`, `elevenlabs` or `auto` (unset = auto). `Tool.route` hands the call to the
open twin at submit (the job then runs and is recorded as that tool, with the label `requestedTool`).

| Call | `auto` goes to |
|---|---|
| `audio.voice` with an ElevenLabs voice id | ElevenLabs (always: those ids mean nothing to an open model) |
| `audio.voice` with a Gen voice (`gv_...`) | `audio.voice-open` |
| `audio.voice` with no voice | `audio.voice-open` once a voice model is **verified**, else ElevenLabs |
| `audio.sfx`, `audio.voice-design` | the open twin once a model for it is verified, else ElevenLabs |
| `audio.dialogue` | `audio.dialogue-open` when every voice is a Gen voice and a model is verified |
| `audio.voice-save` / `-delete` with a `gv_` id | the Gen voice library; any other id: ElevenLabs |
| `audio.voice-list` | ElevenLabs; `provider: "open"` lists the Gen library |
| `audio.voice-change` | ElevenLabs. `provider: "open"` is refused (no open model for it yet; Chatterbox VC is the candidate) |

**Verified** = `settings.audio.verified` (POST `/v1/settings`, owner): a model that passed its smoke test and the audition.
Until J marks one, `auto` changes nothing for anyone. If `auto` ran on the open path and it is unavailable (install failed,
no server) and the call has an ElevenLabs voice, the job falls back to ElevenLabs and says so in its log; `provider: "open"`
never falls back.

`GET /v1/audio/models` lists every model with its license, size, VRAM, what it can do and whether it is verified.

## Models and licenses (checked 2026-10-25 from the model pages; re-check before a product ships on one)

| Model | Use | Size / VRAM | License | Status |
|---|---|---|---|---|
| MOSS-TTS v1.5 (1.7B) | speak, direction, clone, design, dialogue | ~6 GB / 12 GB | Apache-2.0 (code and weights) | adapter **not written** (see below) |
| Qwen3-TTS 1.7B (VoiceDesign, Base, CustomVoice) | speak, direction, clone, design | ~14 GB / 10 GB | Apache-2.0; pins `transformers==4.57.3`, own venv | adapter written |
| VoxCPM2 (2B, 48 kHz) | speak, direction (voice description), clone, design | ~5 GB / 10 GB | Apache-2.0 | adapter written |
| Chatterbox | speak, direction (knobs and tags), clone | ~4 GB / 8 GB | MIT; outputs carry Resemble's Perth watermark | adapter written |
| MOSS-SoundEffect v2 (1.3B) | sfx, loop | ~5 GB / 10 GB | Apache-2.0 family, **v2 card not confirmed**: results carry a license warning | adapter **not written** |
| Stable Audio 3 Small-SFX | sfx, loop | ~3 GB / 8 GB | Stability AI Community License: free under US$1M annual revenue | **blocked**: needs the official ComfyUI template imported from a running server |
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
- Stable Audio 3: the official template and its node/model file names must be imported from a server.
- Code pins are `main` until the first install; the READY mark then records what was installed (`COMMIT` file for MOSS).
- Whether Qwen3-TTS runs on a 16 GB T4-class card in bf16, and which GPU the fleet should use for 8B MOSS.
