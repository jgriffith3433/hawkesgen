# ComfyUI on the GPU server: what we learned

Notes from getting the GPU server (tools/gpu, comfy/) to work reliably. Read
this before changing server flags, models or workflows.

## The machine

- **g6e.xlarge:** NVIDIA L40S with 46 GB usable VRAM, 4 vCPUs, **30 GB RAM**.
  The RAM, not the GPU, is the tight resource.
- **Disk:** 250 GB gp3. After setup about 45 GB is the OS, 48 GB swap and 90 GB
  models, leaving about 50 GB free.
  - A job's models may still not fit after the least-recently-used ones are pruned (LTX-2.3 needs 40 GB). Gen can
    then grow that server's disk while it runs (`growDisk` in `fleet.ts`): EBS first, then the partition and the
    filesystem.
  - Each grow is rounded up to 50 GB. It is capped by `fleet.maxDiskGb` (`hawkesgen fleet set maxDiskGb=400`); the
    default is 0, which never grows.
  - Disk costs about $0.08 per GB-month. EBS allows one change per volume every six hours.
- **First setup:** an install from `server/bootstrap.sh` takes 30-45 minutes
  in practice (it was 12 on a good day; the 90 GB of models come from Hugging
  Face). Later starts take a couple of minutes. Servers normally launch from
  the fleet image instead (next point).
- **The fleet image** (since 2026-10-16, after two broken installs blew a
  content budget). `src/providers/comfy/image.ts` turns a ready install into
  an AMI and copies it to every fleet region; `launchServer` uses the newest
  image whose `ModelsKey` tag is `manifestKey()` (a hash of models.json's
  ComfyUI tag, nodes and core models) and falls back to bootstrap.sh when
  none matches. Its user data is `server/firstboot.sh`: this server's
  password, idle time and a fresh idle clock, ComfyUI started, then a
  background `gen-warm` unit reads every core model once (the disk loads
  lazily from S3: no Fast Snapshot Restore, it's about $540/month). Until a
  model is warm its first load is slow; `status.json` `warm` counts them. The
  image's servers get a faster gp3 disk (4000 IOPS, 500 MB/s, about $0.02/hr
  more) for that.
  - **Build:** `hawkesgen fleet image build` (a fresh install, terminated
    after) or `build --from <id>` (a ready server, left stopped and marked
    "image source": its password and keys are stripped, so it can't take jobs;
    terminating it is J's call). `build --from <id> --as-is` images a
    stopped server without starting it (for when AWS has no machine free in
    its zone; the first image, 2026-10-16, was made this way from
    i-045c7d231d6dadef6): no prep, the source stays a normal server, and
    `firstboot.sh` cleans up on every server launched from it (removes
    `/opt/comfy.partial`, aria2 files and non-core models, and deletes a core
    model whose size isn't Hugging Face's so a job re-downloads it). Such an
    image is bigger than it needs to be; rebuild it cleanly when models.json
    next changes. `server/image-prep.sh` removes leftovers and
    every non-core model, checks every core model's size against Hugging
    Face (re-downloading and sha256-checking a wrong one; still wrong fails
    the build), reports ComfyUI's tag and node commits (checked against
    models.json), and strips per-server state (htpasswd, host keys,
    authorized keys, machine-id, idle clock, logs, cloud-init). Then the
    server is stopped and imaged, the image copied to every region, and older
    images and their snapshots deleted. The build survives a restart
    (`.data/fleet/image.json`).
  - **Upkeep:** when models.json or the ComfyUI tag changes, the Fleet tab and
    `fleet image status` say the images are out of date; build a new one
    (nothing builds by itself: it costs a server hour and storage).
    `fleet image prune` deletes images no region launches from.
  - **Disposable servers** (setting `fleet.disposable`, on by default): a
    server launched from the image has shutdown behavior "terminate", so its
    idle power-off deletes it and its disk; Gen's Stop terminates it too.
    Starting servers then launches from the image (auto start, scale, keep
    trying). Nothing lives only on a server: outputs and trained LoRAs are
    pulled into Gen's library (LoRAs are copied back on use), and workflow
    models download again on first use.
  - **Costs:** ~$0.05/GB-month per region for the snapshot (~$8-9/month per
    region at ~170 GB), ~$3-4 once per copy.
- **Installs resume** (since 2026-10-16, when a server stopped mid-install sat
  idle and paying after a restart). cloud-init runs `server/bootstrap.sh` once;
  it copies itself to `/usr/local/sbin/gen-install.sh` and runs as
  `gen-install.service` on every boot until ready. Each step leaves a marker in
  `/var/lib/gen/done/` (apt, swap, comfy, venv, torch, requirements,
  `node-<name>`, `model-<dir>-<file>`, `ready`); a pip step cut off part way is
  redone with `--force-reinstall`, and downloads continue from their partial
  files (aria2c `-c`). `status.json` has `run` (install runs, one per boot) and
  `lastFailure`, and its `time` moves whenever the disk moves, so a still
  `time` means no progress. To redo a step by hand: remove its marker, then
  `sudo systemctl start gen-install`.
- **Never stuck paying:** `gen-idle.sh` (every 5 minutes) powers an installing
  server off after 20 minutes with no progress (status time and disk use
  unchanged), after 90 minutes of install in one boot, or 30 minutes after the
  install failed. The reason stays in `status.json` (`lastFailure`); the next
  start resumes. Ready servers keep the plain idle rule. Hawkes Gen flags an
  install with no progress for 10 minutes as **stuck** (Fleet tab, CLI, MCP,
  the service log), and a stopped server whose install never finished as
  "install unfinished": starting it says it resumes the install. Servers
  launched before this can't resume, so Gen refuses to start one of those
  that it saw stop mid-install.
- **Capacity:** g6e machines are often unavailable. AWS's own error says to
  let it choose the zone, so `launchServer` tries without a zone first, then
  each zone, then each 48 GB type, then each region with quota.
  `node tools/gpu/capacity.mjs` prints AWS's capacity hints.

## ComfyUI memory flags (v0.40.0)

ComfyUI's default is **dynamic VRAM**: it stages model weights in host memory
and streams them to the GPU, keeping fp8 weights fp8.

| Flags | Result on a g6e.xlarge |
|---|---|
| defaults | **Hangs the server.** Weights are staged in *pinned* (locked) RAM: Qwen-Image-Edit 19.6 GB + its text encoder 7.9 GB = 27.5 GB of 30 GB, unswappable. SSH, nginx's upstream and ComfyUI all stop answering. No OOM in the kernel log, because pinned memory never triggers one. |
| `--highvram --disable-dynamic-vram --disable-pinned-memory` | Painting works, but **Wan runs out of GPU memory**. Without dynamic VRAM, fp8 weights load as 16-bit (a 14B fp8 model takes ~28 GB instead of 14), and highvram keeps Wan's high-noise model loaded while the low-noise one loads. |
| `--disable-dynamic-vram --disable-pinned-memory` | Wan still runs out of memory (the 16-bit problem). |
| **`--disable-pinned-memory`** | **Works for everything.** Qwen paint: 28 GB VRAM, RAM ~4 GB. Wan i2v (33 frames at 640): 34 GB VRAM, RAM ~4 GB, 70 s. |

So the server runs `main.py ... --disable-pinned-memory` on machines with
less than 100 GB RAM (bootstrap.sh decides by hardware). To check a running
server: GPU tab → Server log, or
`ssh -i .cache/gpu/<key>.pem ubuntu@<ip> 'systemctl cat comfyui; journalctl -u comfyui -n 50'`.

**Switching model families:** image (Qwen) and video (Wan) models don't fit on
the GPU together, so the job queue calls ComfyUI's `POST /free` whenever the
next job uses a different family (`FAMILY` in tools/gpu/jobs.mjs), and on its
first job after a restart. A switch costs about a minute of loading; jobs of
one kind back to back don't reload.

## Timings (L40S, models loaded)

| Job | Time |
|---|---|
| Backdrop take (1568×672, one pass) | ~14 s |
| Stage piece take (~1100×950, two passes) | ~25 s |
| First job after a family switch | +60–90 s (loading from disk) |
| Wan 2.2 i2v, 33 frames at 640×640 | ~70 s |
| Cutout on the dev PC (BiRefNet, CPU) | ~60 s; the white key used for clean backgrounds takes ~1 s |

## Painting stages with Qwen-Image-Edit 2511

What failed, and what works (tools/maps/paint.mjs, tools/gpu/workflows.mjs
`paintOver`):

1. **Giving it the concept image copies the concept.** Image 2 is treated as
   content, not style. The backdrop came back as the concept photo with small
   changes. **Fix:** pass a *mood board* (the concept shrunk to 40 px wide and
   blurred back up: palette and light, no layout), and describe the scene in
   words.
2. **The words "fighting game" paint fighters.** At cfg 1 (the 4-step
   Lightning LoRA) the negative prompt does nothing, so the prompt itself must
   not invite people: say "game environment art" and "an empty scene: nobody
   in it". Don't draw a dark band at the bottom of a backdrop blockout either;
   it gets painted as a floor with people on it.
3. **Full repaints drift to a three-quarter view.** Asked for a building or
   rooftop, Qwen paints it from above at an angle, whatever the prompt says
   ("orthographic", "side elevation"). That breaks alignment with the
   collision. Low denoise keeps the flat shapes but stays a gray box at 0.65
   to 0.75, and above 0.85 it drifts again. **Fix: two passes:**
   - The blockout is drawn in the stage's own colors (theme body/under/edge),
     with shading, grain and window grids on facades (stage_art.py
     `paint_texture`, `paint_windows`), so the start is close to the answer.
   - **Pass 1** at denoise **0.80** paints it while keeping every edge. This
     is a cliff, not a slope: in a sweep over three seeds, 0.80 (and 0.78)
     gave fits of 0.86–0.97 every time and 0.82 gave about 0.5, with or
     without window grids or the detail pass. With 4 steps, 0.82 probably
     starts the sampler one step earlier, which repaints enough to tilt.
   - **Pass 2** at 0.6 over the result adds detail and light ("refine image 1
     without moving anything").

   The defaults (pass 0.80, detail 0.6) live in content/generation.json
   "paint" (AI Settings → Painting stages; tools/gpu/settings.mjs has the
   defaults). A job's own settings override them. The detail pass barely
   moves the fit (±0.03 in the sweep); the guard keeps pass 1 when it does.
4. **Backdrops** repaint fully (denoise 1, one pass) over a sky-colored
   gradient: there's no alignment to keep.
5. **Cutouts:** pieces are painted on plain white. When the border is clean
   white, alpha comes from distance-to-white (`white_key`), which is instant
   and keeps dark structures. Otherwise BiRefNet runs, and on dark subjects it
   can throw away a whole dark building.

6. **Grain:** hard per-pixel noise in the blockout comes back as blocky,
   pixel-art squares after the detail pass. Keep it faint (±4) and blurred.
7. **Takes vary a lot, so they're measured.** The same settings give anything
   from a flat, perfectly aligned piece to a tilted one with the roof 100
   units low. Every take of a piece that draws platforms gets a **fit score**
   (`fit_score` in stage_art.py): for sampled columns of each platform, is
   there a transparent-to-solid edge within about 14 units of its y? Flat,
   aligned takes score 0.85 to 0.97; tilted ones 0.1 to 0.4. The Paint card
   shows it on each take and sorts the best first, and the stage piece makes 4
   takes per job (others 2). Below about 0.6 it will look off in the game.

   The low scores on City Top's most detailed takes came from pass 1 at 0.82,
   not from the detail pass or the window grids (see the sweep in point 3).
   Takes below the fit target (0.75) are painted again with a new seed, up to
   2 times, and the one that lands better of pass 1 and pass 2 is kept.

Seeds: a take's file is `<piece>-<seed>.webp`, so two jobs with the same seed
overwrite each other. Leave the seed blank for experiments.

## Models

All fp8, listed in comfy/models.json, about 90 GB:

- **Wan 2.2 14B i2v:** high-noise and low-noise experts, plus their 4-step
  Lightx2v LoRAs.
- **Wan 2.2 Animate 14B:** Kijai fp8_scaled, plus the Lightx2v distill LoRA and
  clip_vision_h.
- **Qwen-Image-Edit 2511:** fp8mixed, plus the 4-step Lightning LoRA, the
  qwen_2.5_vl_7b text encoder and the Qwen VAE.
- **Shared:** umt5_xxl text encoder and the Wan 2.1 VAE.

Every workflow is checked against the server's `/object_info` before it runs
(`Comfy.prepare`), so a missing node, input or model file fails fast with a
clear message.

## Things to try next

- More detail at 0.80: richer blockouts (trim, signage, brick bands) and a
  third, gentler pass.
- Pass Claude's silhouettes as a separate line-art image (image 3) so pass 2
  has the edges to hold on to.

- More detail in blockouts: brick and trim patterns, signs, per-piece colors
  from Claude.
- A per-piece "detail" strength in AI Settings (pass 2), and per-stage
  overrides.
- GPU-side cutouts (rembg on the server) to drop the CPU minute for
  non-white backgrounds.
- Wan Animate needs a motion library clip; test it once one exists.
