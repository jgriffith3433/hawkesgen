# Unity builds on Google Cloud Run

`unity.build` (and `unity.test`) can run on a **Google Cloud Run job** instead of the AWS Windows build server. One
build = one job execution: a fresh Linux container with Unity 6000.3.7f1 (GameCI's image), the project's sources at an
exact commit from GitHub, and the project's `Library/` restored from a cache in Cloud Storage. The Windows build server
(`builder.ts`) stays as the fallback, and its Remote Desktop editor stays as it is.

Why: the last 30 days on the Windows box were 485 builds done (avg 7.6 min), 104 failed and **61 cancelled after
hanging (avg 56 min, max 4 h)**. A Cloud Run execution has a hard timeout, nothing is shared between builds but the
cache, two projects can build at once, and nothing runs (or costs) between builds.

Code: `src/providers/builder/cloudrun.ts` (Gen's side), `cache.ts` (cache rules, result parsing), `gcp.ts` (Google APIs
over REST with ADC), `server/unity-cloudrun/` (the image), `tools/unity-cloudrun/` (setup scripts). Tests:
`test/unity-cloudrun.test.ts`.

## How one build runs

1. **Gen, here** (`runCloudBuild`):
   - The exact commit of every repo the build needs: the project, and the repos of its local `file:` packages
     (`com.hawkes.gen`, `com.hawkes.analytics` in hawkesgen, `com.hawkes.playtest` in hawkesstudio). HEAD when GitHub
     has it, else the merge base with the default branch.
   - Uncommitted edits (tracked changes and untracked, not-ignored files under the project) go along as `overlay.tgz`,
     deletions as a list (2 GB at most). Ignored files are not sent (the build server sent them; a cloud build builds
     what is in git plus those edits).
   - The website folder (or `siteDir`, Studio's beta copy) goes as `site-in.tgz`, minus the big files of old
     numbered `Game/v<n>` folders: each gets a `.hawkes-stub` instead, so the deploy method still sees the folder.
   - `spec.json` with all of it goes to `gs://<bucket>/unity-builds/<job>/`, and Gen starts the job with one env
     override, `HAWKES_SPEC`, and a task timeout of the build limit + 15 min.
2. **The container** (`server/unity-cloudrun/entrypoint.sh`), each stage timed in `result.json`:
   1. `license`: activates Unity first, so a license problem fails in a minute (see License).
   2. `source`: `git fetch --depth 1 --filter=blob:none origin <commit>` per repo, sparse to the folders needed, LFS
      files checked out and their second copy (`.git/lfs/objects`) dropped; the overlay and deletions applied;
      `file:C:/Projects/...` in `Packages/manifest.json` rewritten to the container's `/work/Projects/...`.
   3. `cache`: restores the Library (below).
   4. `unity`: `unity-editor -batchmode -nographics -quit -projectPath ... -buildTarget WebGL -executeMethod <method>
      -logFile -` with the build's env and args, as builder.ts passes them, plus `WEBSITE_PATH`/`HAWKES_SITE_PATH` (the
      site folder), `HAWKES_PROJECT_PATH`, `HAWKES_COMMIT` and `HAWKES_CLOUD_BUILD=1`; under `timeout <limit>m`.
   5. `output`: what changed in the site folder (size + mtime snapshots before and after) as `site.tgz` (entries named
      `<site>/...`, like the build server's pull) and the list in `result.json` (`output.changed`, `output.deleted`; a
      deleted stub means the whole `Game/v<n>` folder went).
   6. `save`: the Library back to the cache, only after a success and only if it changed.
   7. The license is returned (a serial seat), `unity.log` and `result.json` uploaded. The container always exits 0
      after writing the result; Gen reads it (the job has `max-retries 0` anyway).
3. **Gen, here**: follows the execution (Cloud Run API) and its log (Cloud Logging; the same progress lines as
   today), then downloads `site.tgz` and lays it into the site folder or `siteDir` with the build server's own code
   (`applyPulledSite`). The job's result has the same shape as before (`ok`, `version`, `site`, `errors`, `logTail`,
   `seconds`, `cost`), plus `backend: "cloudrun"` and `cloud` (execution, cache, stage seconds, peak memory).

**Limits:** the container stops Unity at `settings.unityBuild.timeoutMinutes` (40); Gen cancels an execution still
running 25 minutes after that. The Windows build server now has the same limit (it stops Unity and fails the job as
`timeout`), so no build holds a lane for hours on either backend.

## Settings

`settings.unityBuild` (POST `/v1/settings`, owner):

| Key | Default | What |
|---|---|---|
| `backend` | `builder` | Where builds run unless a project says otherwise |
| `projects` | `{}` | Per project: `{ "breakingthrough": "cloudrun", "sickofitgame-unity": "builder" }` |
| `timeoutMinutes` | 40 | The hard limit on one build (both backends) |
| `cleanAfterFailures` | 2 | Cache-looking failures in a row before the next build runs clean |
| `concurrency` | 2 | Cloud builds at once (their own queue lane, `builder-cloud`; the Windows box stays one at a time) |
| `gcp` | | `project`, `region` (us-east4), `job` (hawkes-unity-build), `bucket`, `unity` (6000.3.7f1), `cpu` 8, `memoryGiB` 32 |

The tool params `backend` (auto/builder/cloudrun), `cache` (a cache name) and `clean` (no cache) override per job.
`unity.test` with an `fbx` input always runs on the build server (the FBX is placed in the project folder here).

## The Library cache

- **Where:** `gs://<bucket>/unity-cache/<repo>/<key>.tar.zst` (zstd tar of `Library/`) and `<key>.json` (saved at,
  unpacked bytes, files, Unity version, commit, job). `<repo>` is the project path with `/` as `--`
  (`YoobaLand--YoobaLand`).
- **Which key:** builds of `beta` use `beta` (falling back to `main`), builds of `main` use `main` (falling back to
  `beta`). Any other branch (an agent's change, a detached checkout) **restores** beta's (then main's) and **saves
  nothing**, so the bucket never fills with one cache per change. The `cache` param names one explicitly.
- **Restored only if** its `.json` exists, its Unity version matches, and it is under `HAWKES_CACHE_MAX_GB` (16)
  unpacked. A cache that fails to unpack is dropped for that build (it builds without one).
- **Saved only** after a successful build, and only if the Library changed (a fingerprint of names, sizes and times
  before and after), or a different key was restored.
- **Left out:** `Library/BuildCache` (the Scriptable Build Pipeline's cache: 19 GB in Sick Of It, and it only grows),
  `Search`, `TempArtifacts`, `Logs`, `Bee/tmp`. `Bee` itself is kept (it makes the WebGL player build incremental).
- **Clean builds, automatically:** a failure whose log looks like a broken Library (a corrupt ArtifactDB/LMDB,
  "Rebuilding Library because", a broken Bee graph, a crash while opening the project; never a compile error or a
  license problem) counts toward a streak per repo/key; at `cleanAfterFailures` (2) the next build runs without the
  cache. A clean build that succeeds saves a fresh cache and ends the streak; one that fails the same way keeps the
  next one clean too. State: `.data/builder/cloud-cache.json` (`GET /v1/builder/cloud` shows it).
- **Clear by hand** ("builds started failing"): `hawkesgen builder clear-cache <project> [key]` or
  `POST /v1/builder/caches/clear { repo, key?, confirm: true }`. Lists: `hawkesgen builder caches`,
  `GET /v1/builder/caches` (size, unpacked size, age, Unity, commit, streak, last build).
- **Seeding:** `tools/unity-cloudrun/seed-cache.mjs` uploads a Library from J's PC as the first cache (minus the
  above, minus `Bee` and `ScriptAssemblies`, which are Windows-built). Unity may still reimport assets whose import
  differs by editor platform; the first cloud build's log shows how much.
- Build folders (`unity-builds/`) are deleted by a bucket rule after 14 days; caches stay until replaced or cleared.

## Sizes, and which projects fit

Cloud Run gives at most **8 vCPU and 32 GiB**, and its file system is in memory: the source, the Library, the
build's output, Unity's temp files **and** Unity's own RAM all share the 32 GiB. Measured on J's PC (2026-10-28):

| Project | Library (all) | Library cached (trimmed) | Biggest parts | Source (Assets) | Website output | Estimated peak | Backend |
|---|---|---|---|---|---|---|---|
| breakingthrough | 1.4 GB | **0.4 GB** (+ ~1 GB Linux Bee after the first build) | Bee 1.0, Artifacts 0.1, PackageCache 0.1 | 0.2 GB | 43 MB | ~6-8 GB | **Cloud Run** (pilot) |
| YoobaLand/YoobaLand | 6.0 GB | **3.9 GB** (+ ~2 GB Bee) | PackageCache 2.6, Bee 2.0, Artifacts 0.8 | 1.1 GB | ~0.25 GB per version | ~15-18 GB | **Cloud Run** |
| sickofitgame-unity | **27.3 GB** | **5.7 GB** (+ ~1.2 GB Bee) | **BuildCache 19.7**, Artifacts 3.5, PackageCache 1.5, Bee 1.3, ArtifactDB 0.5, Search 0.5 | 1.9 GB (2.4 GB with the rest, LFS) | 1.3 GB per version (3,658 files) | ~22-26 GB | Cloud Run **trimmed**, VM fallback ready |

Peaks: source + cached Library + Bee growth + the WebGL build (Temp, ServerData, the copied output) + Unity and the
IL2CPP/emscripten toolchain (6-10 GB RSS for a big WebGL link). Each build reports `cloud.memoryPeakBytes` (the
container's cgroup peak), so the pilot replaces these estimates with numbers.

Sick Of It's 27 GB is mostly `Library/BuildCache` (19.7 GB), the Scriptable Build Pipeline's content cache, which is
regenerable and grows without bound. Without it the Library is 5.7 GB and fits. The price: each Sick Of It cloud build
rebuilds its Addressables content from scratch (a few minutes more; the pilot measures it). If its peak goes over
~28 GiB, or the Addressables rebuild makes it slower than the Windows box, Sick Of It goes to the VM fallback.

### The fallback for big projects: the same container on a spot VM

Not Cloud Run's other volumes: an **NFS** volume (Filestore from ~$200/month, or a VM serving NFS) mounts without
locking ("no-lock mode"), and Unity's ArtifactDB is LMDB, which needs real file locks and fast random I/O; a **Cloud
Storage** volume (gcsfuse) is worse for it. Neither is safe for a Library. Cloud Run has no disk-backed scratch volume.

So: **one small Linux VM per big project**, `n2-standard-8` (8 vCPU, 32 GB) **spot**, with a 100 GB `pd-balanced`
disk that keeps `/work` (sources and the Library) between builds, running **the same image**:

- Gen starts the VM (Compute Engine API) with the build's spec in its metadata; the VM's startup script runs
  `docker run -e HAWKES_SPEC=... -e HAWKES_PERSIST=1 -e HAWKES_WORK=/work -v /mnt/disks/work:/work <image>` with the
  secrets read from Secret Manager, then powers off. Gen follows `result.json` in the bucket and the log in Cloud Logging
  (Docker's `gcplogs` driver), exactly as for Cloud Run, and lays the output down with the same code.
- `HAWKES_PERSIST=1` is already in the entrypoint: the Library on the disk is used as is (no restore, no save to the
  bucket), the checkout is fetched in place (`git clean` keeps `Library/`), and `BuildCache` can stay (the disk has room).
- Cost: spot n2-standard-8 about $0.08-0.10/hr while building (a pre-empted build fails with no result and is simply
  run again), the disk ~$10/month (100 GB), no idle box. Compare the Windows box: $0.77/hr + $24/month.
- Not built yet in Gen (only the container side is): it is the next step if the Sick Of It pilot says so. Until
  then, `settings.unityBuild.projects["sickofitgame-unity"] = "builder"` keeps it on the Windows box.

## Costs per build

Cloud Run jobs, us-east4 (Tier 1), list prices: $0.000018 per vCPU-second, $0.000002 per GiB-second, so **8 vCPU +
32 GiB = $0.000208/s, $0.75/hour, billed only while the execution runs** (Gen records it as usage `gcp-cloudrun`).

| Project | Estimated execution (image start, fetch, cache, Unity, upload, save) | Cloud Run | Download to the control server (GCS egress ~$0.12/GB) | About |
|---|---|---|---|---|
| breakingthrough | ~8 min | $0.10 | 43 MB: $0.01 | **$0.11** |
| YoobaLand | ~12 min | $0.15 | ~0.25 GB: $0.03 | **$0.18** |
| Sick Of It (trimmed) | ~20-25 min | $0.25-0.31 | ~1.3 GB: $0.16 | **$0.41-0.47** |

Fixed: the image in Artifact Registry (~7.5 GB, ~$0.70/month), caches in Standard storage (~10 GB packed, ~$0.20/month),
Cloud Logging well inside its free 50 GiB/month, Cloud Build only when the image changes (~$0.25 a build). A failed
build that dies at the license or source stage costs about a cent. At last month's 485 builds, mostly breakingthrough
and Yooba sized, that is roughly $60-90/month with no hanging builds, against the Windows box's ~61 build-hours plus
idle tails plus hung hours at $0.77/hr and its $24/month disk.

## License

**Finding (settle this first):** GameCI does **not** activate Unity **Personal** with `UNITY_EMAIL` + `UNITY_PASSWORD`
alone. Its activation needs the email, the password, **and either `UNITY_SERIAL` (Plus/Pro) or `UNITY_LICENSE`** (the
contents of a `.ulf` license file). For Personal, the `.ulf` comes from Unity Hub: Preferences > Licenses > Add > "Get
a free personal license", which writes `C:\ProgramData\Unity\Unity_lic.ulf` on Windows. Licenses aren't tied to the
OS, so a `.ulf` activated on Windows works in the Linux container. Sources:
[GameCI activation](https://game.ci/docs/github/activation),
[GameCI getting started](https://game.ci/docs/github/getting-started),
[unity-builder: activation needs email, password and a serial or a license](https://lightrun.com/answers/game-ci-unity-builder-license-activation-strategy-could-not-be-determined),
[unity-builder: Personal needs a one-time manual activation per Unity version](https://github.com/benoitdion/unity-builder).

What the container does (`activate` in the entrypoint):
- `UNITY_LICENSE` set: writes it to `~/.local/share/unity3d/Unity/Unity_lic.ulf` and runs
  `unity-editor -batchmode -quit -manualLicenseFile <file>` (GameCI's Personal path). Nothing to return.
- `UNITY_SERIAL` set (a Plus/Pro seat): `-serial -username -password`, and `-returnlicense` at the end, always.
- Neither, or Unity says the license is invalid / not logged in / not entitled / 2FA: the build fails at once with
  kind `license`, and Gen says **"Unity isn't licensed in the cloud build (...). Put the contents of Unity_lic.ulf in
  the secret unity-license (docs/unity-cloudrun.md, "License"), then build again."** (the same words and kind Studio
  already handles for the build server).
- Secret names: **`unity-license`** (→ `UNITY_LICENSE`), **`github-token`** (→ `GITHUB_TOKEN`), and only with a seat
  **`unity-serial`**, **`unity-email`**, **`unity-password`**. Never printed; `.ulf` deleted at the end.

Risks: a Personal `.ulf` can stop being accepted (Unity changes entitlement checks, or the file is for an older major
version); then J makes a new one in Unity Hub and adds it as a new secret version. The license check below proves it
before any real build.

## What J sets up

1. **Install the Google Cloud CLI** and sign in: `gcloud auth login`. Pick or make a project (billing on).
2. **The Unity license file:** in Unity Hub on this PC, Preferences > Licenses > Add > Get a free personal license (if
   `C:\ProgramData\Unity\Unity_lic.ulf` isn't already there).
3. **A GitHub token** for the builds: fine-grained, read-only **Contents** on `breakingthrough`, `YoobaLand`,
   `sickofitgame-unity`, `hawkesgen`, `hawkesstudio` (and LFS, which Contents covers). The control server's existing
   `GITHUB_TOKEN` works too if J prefers one token.
4. Run, in order (each prints first; add `--apply` to do it):
   ```
   node tools/unity-cloudrun/build-image.mjs --project <gcp-project>
   node tools/unity-cloudrun/deploy-job.mjs --project <gcp-project> --bucket hawkes-unity-<gcp-project> --image <printed image>
   gcloud secrets versions add unity-license --data-file="C:\ProgramData\Unity\Unity_lic.ulf" --project <gcp-project>
   gcloud secrets versions add github-token --data-file=<token file> --project <gcp-project>
   node tools/unity-cloudrun/deploy-job.mjs ... --apply        (again, now that the secrets have values)
   ```
5. **Gen's credentials:** `gcloud iam service-accounts keys create hawkes-gen-gcp.json --iam-account=hawkes-gen@<gcp-project>.iam.gserviceaccount.com`,
   put the file on the control server (next to Gen's `.env`, never in git) and set `GOOGLE_APPLICATION_CREDENTIALS` to
   its path in `.env`. (On J's PC, `gcloud auth application-default login` works instead.)
6. **Gen's settings** (owner): `POST /v1/settings` with
   `{"unityBuild": {"gcp": {"project": "<gcp-project>", "bucket": "hawkes-unity-<gcp-project>"}, "projects": {"breakingthrough": "cloudrun"}}}`.

## Pilot: breakingthrough first

1. **License check** (no sources, ~2 min, ~$0.02):
   `gcloud run jobs execute hawkes-unity-build --region us-east4 --update-env-vars HAWKES_LICENSE_CHECK=1 --wait`.
   The log says `license: OK (ulf)` and `the editor opened a project licensed`, or why not. Stop here until it passes.
2. **Seed** breakingthrough's cache (0.4 GB): `node tools/unity-cloudrun/seed-cache.mjs --folder C:\Projects\breakingthrough --project <p> --bucket <b> --apply`
   (Unity closed). Optional: a clean first build costs a few minutes more, not more money worth worrying about.
3. **One build from J's PC**, into a scratch copy: `hawkesgen run unity.build project=breakingthrough
   site=theplacedepartmentwebsite method=WebGlBuild.FullDeploy backend=cloudrun siteDir=<a copy of the website>`.
   Check: `result.version`, the files in the copy, `cloud.memoryPeakBytes`, `cloud.stages`, and that the game plays
   (Studio's smoke playtest of The Place Department against the copy).
4. **On beta:** set `projects.breakingthrough = "cloudrun"` on the control server; the next push to breakingthrough's
   beta builds in the cloud and Studio playtests it as usual. Run a week; compare time, cost and failures with the
   Windows box (Studio's build history has both).
5. **YoobaLand** next (`WEBSITE_PATH` is already read by `YoobaWebBuild.FullDeploy`).
6. **Sick Of It** last, and only after its deploy script stops hard-coding `C:\Projects\...` (below). Watch its
   `memoryPeakBytes` and Addressables time; move it to the VM fallback if either is bad.
7. When all three are happy for two weeks: `backend: "cloudrun"` as the default, stop the Windows box (keep it, stopped,
   for Remote Desktop editing and as the fallback; terminating it is J's call).

## Before each project can build in the cloud

- **breakingthrough:** ready. `WebGlBuild.SiteRoot` defaults to the sibling folder, which is where the container puts
  the site. (Its `EditorPrefs` override doesn't exist in a fresh container.)
- **YoobaLand:** ready. `YoobaWebBuild.FullDeploy` reads `WEBSITE_PATH`, which the container sets.
- **Sick Of It: needs a change in `sickofitgame-unity`.** `GameDeployWindow` hard-codes
  `@"C:\Projects\sickofitgame-unity"` and `@"C:\Projects\sickofitgamewebsite"` and joins sub-paths with `\`; on Linux
  that is a relative file name, not a folder. It should take the website from `HAWKES_SITE_PATH` (or `WEBSITE_PATH`)
  and the project from `Application.dataPath`, and use `Path.Combine` (the container sets both variables). Until
  then it stays on the build server (`projects["sickofitgame-unity"] = "builder"`).
- Every project: Linux file names are case-sensitive; a reference whose case differs from the file on disk works on
  Windows and fails here. The first cloud build of each project shows any.

## Hawkes Studio

Studio calls `unity.build` the same way and reads the same result. One change is needed there: `buildpkgs.ts`
`unityBuild()` brings the **Windows box's** checkouts of hawkesgen and hawkesstudio to `origin/main` before every
build (`syncBuildServerCheckouts`, which starts the box). For a cloud build that is unnecessary (the container fetches
the exact commits Gen's own checkouts are at, which `syncBuildPackages` already brings up to date) and it would start
the Windows box for nothing. Studio should skip it when `GET /v1/builder/cloud` says the product's project builds on
`cloudrun` (its `projects`, else `backend`).
