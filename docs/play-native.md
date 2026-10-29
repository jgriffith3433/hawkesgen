# Desktop playtests: the `hawkes-play-native` runner

The runner that plays a customer's **Linux build**, or a **Windows .exe under Proton**, on an NVIDIA GPU, through
playtest contract v2's native transport. This is the "Desktop .exe, first pass: Proton" and "Linux native" row of
hawkesstudio `docs/platform-plan.md` section 3.4. It is the runner side of section 3.3. Gen's conductor and router
(`settings.playtest.runners`, `runnerCandidates`) are separate work and don't exist yet. Nothing in `src/` calls this
runner yet.

| Path | What |
|---|---|
| `server/play-native/Dockerfile` | The image: Ubuntu 24.04, Node 24, Xorg + Xvfb, Mesa (software path), GE-Proton, ffmpeg, MangoHud, the input helper |
| `server/play-native/server.mjs` | HTTP (`/ping`, `/healthz`, `/ready`, `/selftest`) and the WebSocket `/session`, one run per worker at a time |
| `server/play-native/session.mjs` | One run: fetch, unpack, prefix, launch as `player`, contract or smoke, capture, collect, upload |
| `server/play-native/display.mjs` | The X display (Xorg on NVIDIA, else Xvfb) and the GPU self-test |
| `server/play-native/driver.mjs` | Fetches the NVIDIA driver's graphics libraries and Xorg modules for the host's driver version (RunPod mounts neither) |
| `server/play-native/capture.mjs` | One ffmpeg: the mp4, the live JPEG frames, and tiny gray frames for the black/frozen checks |
| `server/play-native/input.py` | Real OS input: XTEST keyboard/mouse, a uinput Xbox 360 pad when `/dev/uinput` exists |
| `server/play-native/contract/` | `protocol.mjs` and `ws-server.mjs` **copied unchanged** from hawkesstudio `clients/native/` (dev 68f0b66): keep them in step |
| `tools/play-native/setup.mjs` | The RunPod load-balancer endpoint (print-only unless `--apply`) |
| `tools/play-native/test.mjs` | A stand-in conductor for local tests: serves a build, takes uploads, drives a session; `--pack` makes test builds |
| `tools/play-native/unit.test.mjs` | Tests of the pure helpers: `node --test tools/play-native/unit.test.mjs` |
| `.github/workflows/play-native-image.yml` | A `play-native-image-*` tag builds and pushes the image to GHCR (like `playtest-image.yml`) |

## The design

### The display

One X display per worker. The self-test picks it once and every run uses it:

1. **Xorg on the NVIDIA driver, headless** (`xorg-nvidia.conf`: no monitor, `AllowEmptyInitialConfiguration`, a
   virtual 1280x720 screen). Games get real GLX and Vulkan on the GPU, and ffmpeg's `x11grab` reads the frames. RunPod
   serverless mounts the driver's compute and video libraries but not the graphics ones. It doesn't mount the Xorg
   module either. `driver.mjs` fetches the `.run` installer for the host's exact driver version (~300 MB, extracted
   only, nothing goes into the kernel). It copies out the EGL/GLX/Vulkan libraries, `nvidia_drv.so` and
   `libglxserver_nvidia.so`. This is the browser runner's `ensureGraphicsLibs` plus the two Xorg files.
2. **Xvfb** as the fallback. GL is Mesa's llvmpipe. Vulkan is NVIDIA's if it can present to a non-NVIDIA X server,
   else lavapipe. In GPU mode the self-test accepts a display only when its Vulkan device is the NVIDIA GPU. Vulkan is
   what DXVK and VKD3D use, so it decides how Windows games run.

**Why not gamescope.** The plan named gamescope's headless backend first. It was not used because:
- it wants a DRM render node (`/dev/dri`), which RunPod containers don't get
- its frames leave through PipeWire, not X, so capture would need another path

Xorg on the driver is the approach containerized GPU desktops use (selkies and similar). Xvfb covers everything else.

**The self-test** (`/ready`, `/selftest`) is proved, not assumed, like the browser runner's:
- `vulkaninfo` names the devices under each ICD (NVIDIA first, then lavapipe)
- `vkcube` draws for 4 seconds, and one grabbed frame must not be black
- `glxinfo` records the GL renderer
- NVENC is checked with a 0.2 s encode

The Vulkan ICD is then pinned for every run (`VK_ICD_FILENAMES`), so Mesa never stands in for the GPU quietly.
`HAWKES_ALLOW_SOFTWARE=1` accepts software (local tests, and a CPU fallback if we ever want one). `/ping` says 200 once
the test is over, whatever it found, and `/session` then refuses with `412 No GPU`. This matches the browser runner:
RunPod holds requests forever for a worker whose `/ping` never says 200.

### A run (the session protocol)

The conductor opens `wss://<endpoint>.api.runpod.ai/session` with two headers:
- `Authorization: Bearer RUNPOD_API_KEY`, which RunPod's gateway checks and drops
- `X-Hawkes-Token`, which the image checks against `HAWKES_TOKEN`

The image holds no cloud credentials. A worker plays **one run at a time**; a second connection gets 429. The full
message list is at the top of `server.mjs`. In short:

```
start {build:{url, sha256?}, target:"linux"|"proton", exe?, args?, env?, scenario?, options?, limits?,
       live?:{fps, width, frames}, upload?:{video, report, logs, dumps, shots:[...]}}
input {id?, kind:"key"|"pointer"|"pad"|"text"|"action", ...}   ->  ack {re, ok, error?}
stop
<- status {phase}, log {source: runner|stdout|stderr|game}, hello, state, event, problem, first-frame,
   smoke-input, exit, binary JPEG frames (the live view), result; then close 1000
```

What a run does (`session.mjs`; every step has a hard limit, and a watchdog covers the whole run):
1. **Fetch** the build from its signed URL (https only), with a size cap. The sha256 is checked when given. Builds
   are cached on the worker by sha256 (`HAWKES_BUILD_CACHE_GB`, default 20, oldest out first).
2. **Unpack** with `bsdtar`: zip, tar, gzip, xz, zstd, bzip2, 7z. It refuses `..` and absolute paths. A single top
   folder is flattened, and a file that isn't an archive is taken as the executable.
3. **Find the executable**: `exe` if given, else:
   - Proton: the one `.exe` that isn't a crash handler, redistributable, installer or helper
   - Linux: `*.x86_64`, `*.x86` or `*.sh`, else an ELF at the top
4. **Proton:** the run gets its own copy of the worker's warmed Wine prefix (below).
5. **The contract server** listens on `127.0.0.1` with a fresh token (the reference runner's own code). The game
   launches with `HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token>`. `options.via` takes `env`, `arg`, `both`, or
   `none` (no address: a smoke run of a game that has the SDK).
6. **Launch as the user `player`** (uid 1000), never root, with a clean environment:
   - the runner's token isn't in it, and `player` can't read the server's environment (checked)
   - the customer's `env` is added, except variables that steer the runner (`HAWKES_PLAYTEST`, `DISPLAY`, `HOME`,
     `STEAM_COMPAT_*`, `XDG_RUNTIME_DIR`)
   - Proton runs as `python3 /opt/proton/proton run <exe>` with `STEAM_COMPAT_DATA_PATH` set, no Steam
7. **Record** from before launch, so boot is on the video. One ffmpeg reads the screen at 30 fps and writes three
   things:
   - the mp4 (NVENC when the self-test found it, else libx264)
   - JPEG frames for the live view (`live.fps`, default 5; dropped when the socket is behind)
   - 64x36 gray frames at 2 fps for the black-screen and frozen-screen checks
8. **Contract or smoke.** The runner waits `limits.helloSeconds` for the SDK's `hello`:
   - **With a hello:** wait for `ready`, `start` the scenario, follow state, events and logs, `stop` it at the limit
     (`stuck`), read the report, `quit`. This works like the reference `test-runner.mjs`.
   - **Without one, a smoke run:** wait for the first frame that isn't black, then press the usual inputs for
     `limits.smokeSeconds`: Return, space, arrows, WASD, z/x/e/j, clicks, Escape, and pad A/Start when there's a pad.
     It catches:
     - a **crash**: the process exits; the report gives the exit code or signal and the error lines from stderr
     - a **hang**: the screen is unchanged for `hangSeconds` and the player's processes use under 2% CPU over 5 more seconds
     - a **black screen**: nothing drawn within `bootSeconds`

     A screen frozen while the CPU is busy is only a warning. A static menu looks like that.
   - A game that says hello late, during the smoke, switches to the contract.
9. **Stop and collect:**
   - `quit`, then SIGTERM to the process group, then `pkill -KILL -u player`, which also ends Wine's wineserver
   - **logs**: the process output, the SDK's log lines, and every `*.log` written during the run under home, the game
     folder and the prefix. That includes Unity's `Player.log` (found in the prefix's `AppData/LocalLow`), Godot's
     logs and protonfixes
   - **dumps**: `*.dmp`, `*.mdmp` and `core*`, as `dumps.tar.gz`
   - **perf**:
     - MangoHud frame times (average fps, 1% low, p99 and worst frame time)
     - the game's own fps (from `state`)
     - CPU and memory of the player's processes, every second
     - GPU use and memory (from `nvidia-smi`, every 2 s)
   - **shots**: the newest live frame at the first frame, at each `scene`/`problem`/`finish` event, every 10 s of a
     smoke run, and at the end (at most 24)
10. **Upload** to the signed URLs in `start.upload`: each is a URL, or `{url, headers, method}` (PUT by default). The
    report goes last, listing what each upload did. Then the `result` message goes out (the report without the long
    lists), the socket closes, and the run's folder is deleted (`HAWKES_KEEP_RUNS=1` keeps it for debugging).

**Limits** (`start.limits`, clamped):

| Limit | Default | Notes |
|---|---|---|
| `seconds` | 600 | the worker's cap is `HAWKES_MAX_SECONDS`, 3600 |
| `bootSeconds` | Linux 120, Proton 240 | |
| `helloSeconds` | Linux 45, Proton 120 | |
| `smokeSeconds` | 40 | |
| `fetchSeconds` | 600 | |
| `maxBuildBytes` | 8 GB | |
| `hangSeconds` | 15 | |

### Proton

GE-Proton (`GE-Proton11-10`, pinned with its sha512 in the Dockerfile) at `/opt/proton`, with DXVK, VKD3D-Proton and
protonfixes, run without Steam. These are set:

| Variable | Value |
|---|---|
| `SteamAppId`, `SteamGameId` | `0` |
| `WINEDEBUG` | `-all` (`options.wineDebug` overrides it) |
| `PROTON_NO_ESYNC` | `1` |
| `WINEDLLOVERRIDES` | `winemenubuilder.exe=d` |

`options.wined3d: true` switches to WineD3D (OpenGL) for a game that fails on DXVK.

**The warm prefix:**
- Making a Wine prefix is wineboot's 10 to 60 seconds, so each worker makes one at startup (`proton run cmd.exe /c
  exit`) and keeps it as a root-owned, read-only template.
- Each run copies it (`cp -a`), so no run can change the next run's prefix.
- A Proton run that arrives during the warm-up waits for it, up to 4 minutes.

To move Proton, change `GE_PROTON` in the Dockerfile and rebuild. The download is checked against its own
`.sha512sum`.

### Input

`input.py` is one long-lived root helper on the display:
- **Keyboard and mouse** go through **XTEST** (`key` by X keysym name; `pointer` with x/y in pixels or 0..1; `button`,
  `scroll`). `text` goes through `xdotool type`.
- **`pad`** is a **uinput Xbox 360 pad** (buttons, sticks, triggers, d-pad), with `SDL_JOYSTICK_DISABLE_UDEV=1` for
  the game. It needs `/dev/uinput` in the container. Docker Desktop doesn't have it, and RunPod probably doesn't either.
  Without it, `pad` input acks `ok: false` with the reason, and the self-test reports `input.pad: false`.
- **`action`** goes to the game's own `input()` hook over the contract.

### Isolation (platform-plan 3.5)

- The build runs as `player` on a throwaway worker that holds no cloud credentials. The run's folder is deleted
  afterwards and every `player` process is killed.
- Builds and uploads move only through signed URLs from Gen. The runner never fetches anything else for a run.
- **Not covered here:**
  - **Network egress is open.** RunPod gives no `NET_ADMIN`, so there's no firewall.
  - **Xorg and the input helper run as root** on the same machine as the game, so an X server exploit would reach root.
    Root then has `HAWKES_TOKEN`, which the gateway's RunPod key still guards.
  - The time caps limit mining. The GPU caps are RunPod's.

## What was verified (2026-10-29, Docker Desktop on J's PC: no NVIDIA GPU)

Everything ran in the real image (`docker build server/play-native`: 3.5 GB unpacked, 0.9 GB of layers) on **Xvfb with
lavapipe/llvmpipe** (`HAWKES_ALLOW_SOFTWARE=1`). Uploads went through `tools/play-native/test.mjs` (PUT to a local HTTP
server). The unit tests pass (8).

| Case | Result |
|---|---|
| Self-test | Xvfb, Vulkan on llvmpipe (lavapipe, API 1.4.318), vkcube drew, GL llvmpipe; 5 s. Wine prefix warmed in **12 s, 285 MB** |
| Fake game (the reference `fake-game.mjs`, Linux, contract) | hello, ready, `smoke` **won**, `action` input forwarded to the game, every upload made; 1.1 s |
| Fake game, `long` scenario, limit 12 s | stopped at the limit, outcome **stuck** |
| **Unity 6000.3.7f1 Win64 Mono build with `com.hawkes.playtest`** (the contract-v2 session's test scene, 26.6 MB) **under Proton**, contract | Hello from Unity, platform `windows`. Ready, `smoke` **won** (3 ticks, events, warnings as game logs), `action` input reached the game's `input()` hook. Unity ran on **DXVK** (D3D11 on lavapipe). `Player.log` was found in the prefix and collected. See the timings below this table |
| The same Unity build, no address (`via: none`), smoke | First frame **21.4 s** after launch. The full input sequence ran, and the static scene gave a "screen didn't change" warning. In one of three runs the game **exited with code 3** partway through the inputs, and it was reported as a crash with the stderr lines. Not reproduced in the other two: it looks like a flaky exit on lavapipe under Wine, not the runner |
| Smoke: `vkcube` (a live Vulkan window) | **done**, no problems. MangoHud: 4330 frame-time samples |
| Smoke: draws, then exits with 3 | **crash** at 4.9 s, exit code 3, the stderr line quoted |
| Smoke: draws, then SIGSTOP | **hang** about 21 s after the freeze (screen still, 0.0% CPU) |
| Smoke: never opens a window | **black screen** after the 20 s boot limit |
| Auth and busy | No token: 401. A second session during a run: refused (the server answers 429; the client saw the handshake fail). A bad token on the socket: refused |
| Input | key, key down/up, pointer click, text and action all acked ok. `pad` acked "no /dev/uinput in this container" (expected on Docker Desktop) |

Timings for the Unity contract run under Proton:

| Step | Time |
|---|---|
| Fetch (from the PC, through Docker Desktop's network) | 12 s |
| Prefix copy | 8.5 s |
| Launch to first frame (splash) | 33 s |
| Launch to hello | 35 s |
| Whole run | 61 s |

MangoHud measured 84 fps on average (1% low 2.4 fps) and the game reported 50 fps. CPU averaged 57%. Memory peaked at
779 MB.

**Not tested** (no NVIDIA GPU here, and no money spent):
- **Every GPU path:**
  - Xorg on the NVIDIA driver
  - `driver.mjs`'s fetch of the driver and Xorg modules
  - NVIDIA Vulkan on Xvfb
  - NVENC
  - `nvidia-smi` GPU sampling

  The first GPU worker will show which display wins (`/selftest`). **The main risk:** headless Xorg may not start in
  an unprivileged RunPod container (no `/dev/tty*`, maybe no `/dev/nvidia-modeset`), and NVIDIA's Vulkan may not
  present to Xvfb. Then the worker has no GPU path and refuses runs with 412. The next options would be RunPod Pods
  (more device access) or gamescope with a PipeWire capture.
- The Unity **skybox showed white** on lavapipe; the splash rendered correctly. Whether that is lavapipe or the scene
  needs a GPU run.
- **Builds and engines not tried:**
  - an IL2CPP Windows build (only Mono was tried; IL2CPP worked on real Windows in the contract-v2 session)
  - a native Linux Unity or Godot export (no Linux build module or Godot on this PC: the Linux path was proved with
    the fake game and the vkcube scripts)
  - 32-bit Windows games (no i386 libraries in the image)
  - games that need audio (no sound device: Unity falls back to FMOD's emulated output; ALSA errors in the log are
    normal)
- **The gamepad** (needs `/dev/uinput`).
- **The real services:** uploads to real Cloud Storage signed URLs, RunPod itself, the GHCR workflow and `setup.mjs
  --apply`.

## Local test

```bash
docker build -t hawkes-play-native:dev server/play-native
docker run -d --name pn -p 18080:8080 -e HAWKES_ALLOW_SOFTWARE=1 -e HAWKES_ALLOW_HTTP=1 -e HAWKES_TOKEN=localtest --add-host host.docker.internal:host-gateway hawkes-play-native:dev
curl -H "X-Hawkes-Token: localtest" localhost:18080/selftest
node tools/play-native/test.mjs --pack fake fake.tar.gz
node tools/play-native/test.mjs --runner http://127.0.0.1:18080 --token localtest --build fake.tar.gz --input
node tools/play-native/test.mjs --runner http://127.0.0.1:18080 --token localtest --target proton --build MyGame-win64.zip
```

`--pack` makes `fake`, `cube`, `crash`, `hang` and `black` builds. `--options '{"via":"none"}'` smoke-tests a game that
has the SDK. The result JSON and the uploads land in `--out`.

## J's steps to deploy (none done; the first two cost nothing)

1. **The image.**
   - Push a tag from a commit that has the workflow: `git tag play-native-image-1 && git push origin play-native-image-1`.
     GitHub builds `ghcr.io/jgriffith3433/hawkes-play-native:<tag>-<sha>` and `:latest`, plus a copy in the public
     `hawkes-gen-gpu` package (`:play-native-<tag>-<sha>`).
   - Make `hawkes-play-native` public on GHCR (or pass `--image` with the `hawkes-gen-gpu` copy).
   - About 15 minutes; Proton is most of the download.
2. **The endpoint.**
   - Run `node tools/play-native/setup.mjs` and read the plan.
   - Then run `node tools/play-native/setup.mjs --apply`.
   - It makes the template (40 GB disk) and a load-balancer endpoint:
     - workers min 0, max 2, one run per worker
     - the same graphics-capable GPU models as the browser runner (never a MIG slice)
     - 60 s idle
   - Free until a worker starts.
   - Token: `PLAY_NATIVE_TOKEN` in `.env`, else the browser runner's.
3. **The first GPU check** (starts one worker: a few cents, J's OK):

   ```bash
   curl -H "Authorization: Bearer $RUNPOD_API_KEY" -H "X-Hawkes-Token: ..." https://<endpoint>.api.runpod.ai/selftest
   ```

   Look at `display.kind` (`xorg-nvidia` hoped for), `vulkan.device` (the NVIDIA card), `nvenc.ok` and `driver`.
   Then run `tools/play-native/test.mjs` against it. The build must be at a public https URL; the test's own HTTP
   server only works locally.
4. **Gen's router** (separate work) adds the runner to `settings.playtest.runners`. `setup.mjs` prints the entry. The
   conductor signs the build and upload URLs per run.

**Cost** (RunPod serverless flex, 16 GB class, $0.58/h while a worker runs):

| Item | Estimate |
|---|---|
| Cold start (driver fetch, self-test, prefix warm) | 1 to 2 min, not measured on RunPod |
| A Proton smoke run | 1 to 2 min |
| A run on a warm worker | about $0.01 to $0.02 |
| A run that starts the worker | about $0.03 |

These fit the plan's ~$0.02 to $0.05 a smoke.
