# unity.render: Unity shots on a GPU worker (the render farm)

`unity.render` (`src/tools/unityrender.ts`) renders a Unity project's shots in a Linux Unity editor with graphics on, on
a RunPod worker running the **unity-render image** (`server/unity-render/`). Its first user is the TK Shock render farm
(TurkeyRender `Director/docs/render-farm.md`, `mv farm`): a video's shots are split over N jobs at once and the files
come back under the names the project's own final render reuses.

| Mode | Inputs / params | What the worker does | Back |
|---|---|---|---|
| `sync` | `pack` (a tar of files, each named by the sha256 of its bytes), `manifest` (`{ hash, files: { path: sha256 } }`) | Unpacks into the network volume's store, keeping only blobs whose bytes match their name; saves the manifest once every blob it names is there | `blobs.txt`, `manifests.txt`, `store.json` |
| `check` | none | Lists the store | the same |
| `render` | `job`: `{ video, w, h, fps, quality, snapshot: { kind: "manifest", manifestHash }, shots: [{ id, hash, f0, f1 }], timeoutMin }` | `/hawkes/worker.sh`: display, Unity license, the tree assembled from the manifest, the Library cache, `unity-editor -batchmode` (never `-nographics`) running `Farm.Run`: build, prove each shot's hash on this tree, render | `<id>-<hash>.mp4` + `.json` per shot, `worker.json`, `stages.txt`, `unity.log` |

**Where it runs.** Only on an endpoint whose `families` name `unity-render` (`route.ts`: `tool.image` keeps it off
ComfyUI endpoints; `toolReady` never counts the fleet, which has no Unity). The tool refuses the fleet itself.

**The image.** GameCI's `unityci/editor:ubuntu-6000.3.7f1-webgl-3.2.2` by Gen's pinned digest, plus Xorg/Xvfb, the GL and
Vulkan loaders, ffmpeg, Node 24 and `server/cloudrun/worker.py` (`HAWKES_COMFY=0`: hawkes_job requests only, refused
without the worker token). `worker.sh` and `Farm.cs` are copies of TurkeyRender's `Director/farm/` files (the
private repo is never checked out in CI). Push a tag `farm-image-<anything>`: `.github/workflows/farm-image.yml` builds
it on GitHub and pushes `ghcr.io/jgriffith3433/hawkes-gen-gpu:unity-render-<hash>` and `:unity-render-latest`.

**The endpoint.** `node tools/gpu-providers/runpod.mjs --kind unity-render` prints the plan; `--apply --dc <data center>`
makes the template, a 50 GB network volume (about $3.50 a month) and the load-balancer endpoint: exact GPU models RTX
A4000 / A4500 / RTX 4000 Ada (never a pool alone: MIG slices have no graphics), max 10 workers, idle 300 s, 50 GB
container disk, env `WORKER_TOKEN` and the Unity build account (`UNITY_EMAIL`, `UNITY_PASSWORD`, read from the env or
Secret Manager `unity-email` / `unity-password`, never printed). It prints Gen's settings entry:
`{ id: "runpod-unity", families: ["unity-render"], pricePerHour: 0.58, maxConcurrent: 10, graphLimitSeconds: 7200 }`
with `familyOrder: { "unity-render": ["runpod-unity"] }`.

**What a worker needs from Gen.** The broker (`HAWKESGEN_PUBLIC_URL`, `settings.gpu.cloudrun.bucket`): a worker on RunPod
fetches inputs and returns files through it, so a Gen on a PC with no public address cannot drive one. Run it from
beta or live Gen (or a Gen reachable through a tunnel).

**Costs.** Billed per worker-second at $0.58/h (A4000 class); `gpuSeconds` prices a render at 300 s fixed plus 0.06 s a
frame (0.03 previs) until the farm's measured `farm-pace.json` replaces the guess. Licensing is a Unity Personal seat per
worker, activated and returned each job: the number of workers that can activate at once is the open risk.

Test: `test/unityrender.test.ts`.
