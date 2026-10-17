# Playtest video: how it's recorded, and why

`playtest.run` records the video with a **CDP screencast** (`src/tools/screencast.ts`) when the browser runs on a GPU
machine (the playtester or a fleet server), and with Playwright's `recordVideo` otherwise (this PC, software
rendering), or when the screencast won't start (the tab is reopened with `recordVideo`). `recorder: screencast |
playwright` forces one. `result.recorder` says which made the video (`kind`, `fps`, and for the screencast the frames
Chromium sent, the frames written and the seconds).

How the screencast works: Chromium sends a JPEG (quality 60, at most the viewport's size) every time it draws a new
frame; the runner acks it at once (Chromium waits for the ack) and keeps a 30 fps clock, writing whatever frame is on
screen at each tick into an MJPEG file. Nothing is encoded while the game plays. After the run, the MJPEG goes back
over SSH to the machine that played the game, ffmpeg there turns it into the H.264 mp4 and the control server only
downloads the result (`remoteEncodeScript` in `src/tools/screencast.ts`, `encodeRemotely` in `src/tools/playtest.ts`):
NVENC (`h264_nvenc -preset p4 -rc vbr -cq 28`) when the GPU has it (the T4 does), else libx264 (crf 28, veryfast),
niced so a game in the other lane keeps its frame rate; ffmpeg is installed there on first use if it's missing. If
that fails, the control server encodes it with libx264 as before. `result.recorder.encodedOn` and `encoder` say which.
(The control server has 2 cores; a 10-minute encode there used to max them out while agents were running.) The CDP session belongs to the page, so it follows navigations (site crawls, reloads). The MJPEG is about 2 MB per second of run (1.2 GB for a
10-minute campaign) in the job's tmp folder; it's deleted once the mp4 is made.

## Measurements (2026-10-16, playtester g4dn.xlarge: T4, 4 vCPU)

Dose Of Destruction live (`https://doseofdestruction.com/Game/`, scenario `smoke` or `match`), 1280x720. "Distinct
fps" counts frames that differ from the one before (`ffmpeg -vf mpdecimate`) per second of the mp4, during the match;
menus, loading and the VS screen are partly still, so whole-video averages are lower for every method. Game fps is the
game's own `state().fps` during the match.

| Recorder | Lanes | Distinct fps in the match | Game fps | mp4 size |
|---|---|---|---|---|
| `recordVideo` (production, `playtest.run` jobs `j_e72a52413247`, `j_3325e7a29497`, `j_e510f6b9e82b`) | 1 and 2 | 25 (its fixed 25 fps container) | 54 to 60 | 2.8 MB / 34 s |
| Tab capture (`getDisplayMedia` + MediaRecorder VP9 4 Mbps) | 1 | 28 to 30 | 59 to 60 | 2.2 MB / 25 s |
| Tab capture, VP9 | 2 | 14 to 25, about 19 | 55 to 59 | 2.3 MB / 30 s |
| Tab capture, VP8 | 2 | 11 to 21, about 14 | 54 to 59 | |
| **CDP screencast** (raw frames received) | 2 | 54 to 59 frames/s, 93% unique | 60 | |
| **CDP screencast through `ScreencastRecorder`** (the shipped path, with screenshots every 5 s and state polls) | 2 | **28 to 30** | 57 to 60 | 3.6 MB / 32 s |
| CDP screencast, real `playtest.run` code on J's laptop (Intel iGPU) | 1 | 30 | 54 | |

With two playtests the T4's 4 vCPUs are saturated (the game's renderer alone takes about 2 cores per tab). Tab capture
encodes VP8/VP9 in software inside the same Chromium, so its frame rate falls with the load; the screencast only
JPEG-encodes on the playtester and leaves the video encode until after the run, so it holds 30.
Neither changed the game's frame rate measurably.

The original report of 3 to 14 distinct fps with `recordVideo` didn't reproduce on 2026-10-16: three production runs
(one alone, two at once) were at its 25 fps ceiling during matches. Whole-video averages are lower (18 to 21) because
of the still menus and loading.

## Things found on the way

- **Tab capture needs Chromium's new headless mode.** The default `chromium-headless-shell` refuses `getDisplayMedia`
  ("Not supported" / "Could not start video source"). It works with `channel: 'chromium'` and
  `--auto-accept-this-tab-capture` (no `--use-fake-ui-for-media-stream`: that gives a fake device that fails), with
  `getDisplayMedia({ video: { frameRate: 30 }, preferCurrentTab: true })`, no user gesture needed.
- **The playtester's browser server ignores client launch args.** Playwright's `run-server` drops `args` from
  `x-playwright-launch-options` unless it's started with `--unsafe`, so `GPU_LINUX_ARGS` (`playtestHost.ts`) never
  reach Chromium on the playtester or a fleet server. Chromium finds the T4 anyway (ANGLE on GL ES, the same renderer
  string as with the args), so nothing depends on them today; `--mute-audio` and the autoplay flag aren't applied.
  The screencast needs no flags. Not changed here.
