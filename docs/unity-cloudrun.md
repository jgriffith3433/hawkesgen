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

## GitHub mode: builds from a tag, pushed to the website's beta

Since 2026-10-28 Gen and Studio both run on Cloud Run, so Gen has no checkout of the games or their websites to send
from or lay a build into. **GitHub mode** takes everything from GitHub and puts the result back there. It is what a
build tag uses (J: "can we make it build by listening to tag pushes?"):

```
git tag build-2026-10-28 && git push origin build-2026-10-28     # in sickofitgame-unity, YoobaLand or breakingthrough
```

- **The tag:** `build-<letters, digits, . _ ->`. The repo's `.github/workflows/hawkes-studio.yml` (on `tags: ['build-*']`)
  tells Studio with GitHub's OIDC token, like a push. The tagged commit must contain that workflow line (GitHub runs
  the workflow file of the commit the tag points at). Studio (`hawkesstudio/src/tagbuild.ts`) starts a beta run whose
  build step calls `unity.build` with `github`.
- **The param** (`src/providers/builder/github.ts` checks it):
  `github: { repo: "owner/source", commit: "<40-hex sha>", siteRepo: "owner/website", branch: "beta", ref: "build-...", packages?: { hawkesgen: "main" }, cacheBranch?: "beta" }`
  with `project`, `site` and `method` as usual (and `env`, e.g. Studio's `BUILD_VERSION`). `branch` defaults to `beta`;
  `main`, `master`, `gh-pages`, `live` and `production` are refused here, again in the container, and a result that
  claims a push to main is refused when read. `projectDir`, `siteDir` and tests aren't allowed with it.
- **Backend:** always a cloud one. The project's backend when it is `cloudrun` or `vm`, else `cloudrun`; an explicit
  `backend: builder` is refused.
- **Gen, here:** no commits worked out, no overlay, no `site-in.tgz`. `spec.json` gets `repos` (the source repo at the
  commit, sparse to the project folder: `YoobaLand/YoobaLand` is the folder `YoobaLand` of the repo `YoobaLand`), and a
  `github` block (the website repo and branch, the package refs, the owner, the commit message). The cache key is
  `beta` (restore beta then main, save beta), as for a build of beta.
- **The container** (`server/unity-cloudrun/github.sh`, sourced by `entrypoint.sh`):
  1. `source`: the commit as before (`fetch_repo`). `ProjectSettings/ProjectVersion.txt` must match the image's Unity
     (kind `config` otherwise: Gen had nothing to read it from). Then the repos of the project's local `file:`
     packages (`file:C:/Projects/<repo>/<path>` in `Packages/manifest.json`): `owner/<repo>` at `packages[<repo>]`
     (`main` by default), sparse to the package folders. Their commits are in `result.packages`.
  2. The website: `owner/website` at `branch` (made from the default branch when it doesn't exist yet), depth 1,
     sparse without the old `Game/v<n>` folders (each gets a `.hawkes-stub`, as in normal cloud builds), so Sick Of It's
     old 1.3 GB versions are never downloaded.
  3. `cache`, `unity`, `output` as before (the website diff is computed the same way; no `site.tgz` is uploaded).
  4. `push`: `git add -A --sparse`, a gone stub removes its whole `Game/v<n>` from the index, one commit by
     `Hawkes Gen <gen@hawkesgen.ai>` ("Unity build: <project> <sha7> (<tag>)"), pushed to `refs/heads/<branch>`. When the
     branch moved during the build (a page change, another build), the commit is rebased onto its new tip and pushed
     again (3 tries); a conflict fails the build with kind `push` ("build again"). Nothing changed: nothing pushed.
  5. `result.json` has `pushed: { repo, branch, commit, before, source, files }`.
- **The token:** the secret `github-token` (`GITHUB_TOKEN`) goes to git only as an `http.extraheader` set for each
  fetch and push and removed right after; nothing prints it (the test checks the output and the checkout's config).
  It now needs **Contents: read and write** on the three website repos (sickofitgamewebsite, YoobaLandGame,
  theplacedepartmentwebsite) besides read on the source and package repos.
- **Gen's result:** `ok`, `version` (from the changed `Game/v<n>` files), `site.folder` = `github:<repo>@<branch>`,
  `github`, `pushed`, `packages`, `cloud`. Nothing is laid down here.
- **Tests:** `test/unity-github.test.ts`: the param, the spec against a fake Google Cloud (Storage, Cloud Run, Logging),
  and `github.sh` against local bare repos standing in for GitHub (beta checked out without old builds, the push to beta
  with main untouched, a branch that moved, a website without beta, main refused, the packages, the token). Those need
  `bash`, `git` and `jq`.

## Customer mode: a customer's own project, the build back as an asset

For customers' Studios (hawkesstudio `docs/builds.md`, "unity -> Hawkes Gen"): any Gen key, role `user` included, may
submit `unity.build` in this mode, and only in this mode (`billing.ts customerMayRun`; everything else about the tool
stays internal-only). `src/providers/builder/customer.ts`, `src/tools/build.ts runCustomerBuild`.

```jsonc
{ "tool": "unity.build", "project": "<the key's Gen project>", "params": {
  "github": { "repo": "owner/name", "commit": "<40-hex sha>", "token": "<short-lived GitHub installation token>", "ref": "refs/heads/main" },
  "path": "Game",            // optional: the Unity project folder in the repo; default: the shallowest folder with ProjectSettings/ProjectVersion.txt
  "method": "Acme.Build.Web", // optional -executeMethod; default HawkesGenCloud.HawkesBuild.Build (below)
  "target": "web",            // WebGL; anything else fails with kind "config"
  "out": "artifact",
  "env": { "BUILD_ID": "7" }  // optional, plain names (not HAWKES_, UNITY_, GITHUB_, ...)
} }
```

- **The token** goes into the in-memory token vault at submit (`intake.ts holdToken`, 12 hours); the job's params, its
  row, the library recipe and spec.json keep only its `tok_` reference (`test/unity-customer.test.ts` checks every one).
  It is handed to the one Cloud Run execution as the env override `HAWKES_GITHUB_TOKEN`, used there only as the git
  `http.extraheader` of the fetch, and dropped from the vault when the job ends. Gen restarted before the build started:
  the job fails saying to submit again. Gen's own GitHub secret is never used: the container drops `GITHUB_TOKEN` and
  `R2_BUILDS_TOKEN` in this mode.
- **Before anything starts**, Gen asks GitHub (with that token) for the project folder (the tree, when `path` is not
  given) and its `ProjectVersion.txt`. A version without an image fails at once, kind `config`, naming the project's
  version and the supported ones. **The supported versions are `gcp.images`** (`{ "<version>": "<Cloud Run job>" }`; a
  job execution can't change its image, so each version is its own job running its own image). Empty: `gcp.unity` on
  `gcp.job`. Adding a version: build an image with that GameCI editor tag (`tools/unity-cloudrun/build-image.mjs`), make
  a job from it like `hawkes-unity-build` (same secrets, service account, size), add the line, then make its customer
  twin (`node tools/unity-cloudrun/customer-setup.mjs --for-job <that job> --apply`, below). Customer builds never run
  on these jobs themselves.
- **The container** fetches the whole repo at the commit into `Projects/src` (no sparse checkout, no package rewrite,
  never J's package repos), checks the version again, and builds into `HAWKES_OUT`. With no `method` it adds
  `HawkesBuild.cs` (in the image) as `Assets/HawkesGenCloud/Editor/` with an Editor-only asmdef: every enabled scene in
  EditorBuildSettings to WebGL, compression off (static hosts can't send `Content-Encoding`). With a method, the output
  is whatever `HAWKES_OUT` holds afterwards; empty fails (kind `output`). The folder goes up as `artifact.tgz`.
- **Secrets and the customer's code:** the customer's editor scripts run inside Unity, so in this mode the entrypoint
  first moves every secret out of the environment (into files it reads and deletes, then it starts itself again with a
  clean environment): Unity's process sees no `UNITY_*`, no tokens, no signed URLs.
- **Isolation: no Google identity with any data access.** Whatever identity the container has, the customer's code has
  too (the metadata server answers any process in it). So:
  - **Their own job.** Customer builds run only on `gcp.customerJob` (default `hawkes-unity-build-customer`); another
    version's job `<job>` has the twin `<job>-customer` (`customer.ts customerJobFor`), so `gcp.images` stays one line
    per version. It runs as **`unity-customer@<project>`, which has no role on any bucket and no project role**. Its one
    grant is `secretAccessor` on the Unity license secrets the job mounts (Cloud Run reads mounted secrets as the job's
    account). The job mounts no other secret (never `GITHUB_TOKEN`, never `R2_BUILDS_TOKEN`) and sets
    `HAWKES_CUSTOMER_JOB=1`. J's job and its account (`hawkes-unity-build`, bucket objectAdmin) are unchanged and never
    run a customer build.
  - **Gen checks the job before every build** (`checkCustomerJob`, remembered 10 minutes): it exists, runs as
    `unity-customer@<project>`, sets `HAWKES_CUSTOMER_JOB=1`, mounts only `UNITY_EMAIL`, `UNITY_PASSWORD`,
    `UNITY_SERIAL`. Anything else, or `customerJob` empty, refuses the build with kind `config` naming the setup script,
    before GitHub is asked (when off) and before anything is uploaded or started.
  - **Signed URLs, nothing else.** Gen signs V4 URLs as its own service account (IAM signBlob, `src/providers/gpu/sign.ts
    signedUrl`; `gen-control` on Cloud Run needs `roles/iam.serviceAccountTokenCreator` on itself, which
    `tools/gen-cloudrun/deploy.mjs` grants; on a PC `HAWKESGEN_GCP_IMPERSONATE`), one per object, for that execution
    only, valid the build's limit plus 30 minutes (`customerUrlSeconds`), and passes them as the env override
    `HAWKES_SIGNED` (`{ bucket, get: { key: url }, put: { key: url } }`): GET `unity-builds/<job>/spec.json` and, when
    the archive exists, that customer's own cache (`unity-cache/cust--.../build.tar.zst` and `build.json`); PUT
    `unity-builds/<job>/artifact.tgz`, `unity.log`, `result.json` and the cache back (`build.tar.zst`, `build.json`).
    `customerSignedUrls` refuses any cache that isn't a customer's (`cust--`) and any other prefix. The execution's env
    overrides are exactly `HAWKES_SPEC` (the spec's `gs://` name, not a credential), `HAWKES_GITHUB_TOKEN` and
    `HAWKES_SIGNED`. In this mode the container's `gs_get` / `gs_put` use only those URLs with plain curl; an object
    without one is unreachable, and `token()` refuses (never gsutil, gcloud or the metadata server). On the customer job
    it runs nothing but customer builds.
  - **The metadata server** is made unreachable where possible: before anything else the entrypoint tries
    `iptables -I OUTPUT -d 169.254.169.254 -j REJECT` (the image has iptables) and adds `metadata.google.internal` to
    `/etc/hosts` as `0.0.0.0`, then logs whether it still answers. Cloud Run doesn't give containers `CAP_NET_ADMIN` as
    far as we know, so expect "still reachable": the hosts line only stops lookups by name. **The real guard is the
    account with no roles.** What the customer's code can still get from it: a token for `unity-customer`, which reads
    nothing but the Unity license secrets it mounts. That is why those are a Unity account of their own by default.
  - **Still to keep in mind:** the Unity account's email and password are inside the container during the build (as
    shell variables of the entrypoint and as the mounted secrets' values), and Unity runs as the same user; a
    determined customer could read them. Use a Unity account only for customer builds (the setup's default), never
    J's (`--shared-license` is there but warns).
- **Setting up the customer job** (J, once per lane's project; every step prints first, `--apply` does it):
  1. `node tools/unity-cloudrun/customer-setup.mjs --project hawkes-staging` (read the plan; `--all` makes a twin for
     every version's job, `--for-job <job>` one, `--sizes` also every machine size's job).
  2. Make a Unity account for customer builds (no two-factor sign-in). `node tools/unity-cloudrun/customer-setup.mjs
     --project hawkes-staging --apply` creates `unity-customer@`, the secrets `unity-customer-email` and
     `unity-customer-password` (empty), and stops (exit 3) until they have values: `gcloud secrets versions add
     unity-customer-email --data-file=<file> --project=hawkes-staging` (and the password; files with only the value, no
     newline, deleted after).
  3. Run it again with `--apply`: the job from the same image as J's job, same size, `--service-account
     unity-customer@...`, only the license secrets, `HAWKES_CUSTOMER_JOB=1`; then `roles/run.jobsExecutorWithOverrides`
     on that job and `roles/iam.serviceAccountUser` on `unity-customer@` for `gen-control@` and `hawkes-gen@`.
  4. `gcloud run jobs execute hawkes-unity-build-customer --region=us-east4 --project=hawkes-staging
     --update-env-vars=HAWKES_LICENSE_CHECK=1 --wait` (the license on the customer account).
  5. Gen (each lane, owner): `POST /v1/settings` `{ "unityBuild": { "gcp": { "customerJob": "hawkes-unity-build-customer" } } }`
     (that is also the default; `""` turns customer builds off).
  The image needs rebuilding once for the new `entrypoint.sh` (signed URLs, `HAWKES_CUSTOMER_JOB`) and iptables:
  `tools/unity-cloudrun/build-image.mjs`, then point both jobs at it. Until then the customer job's old entrypoint would
  try the metadata server and fail to read the spec (no access), so no customer build can work, which is safe.
- **Machine sizes** (J, 2026-11-01: "make it work and make it cheap if we don't need all that ... $1 a build feels
  wrong to me"; `src/providers/builder/sizes.ts`). Param `machine`: a size from `gcp.sizes` (default `s` 2 vCPU / 8 GiB,
  `m` 4 / 16, `l` 6 / 24, `xl` 8 / 32) or `{ "cpu": 4, "memoryGiB": 12 }` (Cloud Run's combinations: 2 vCPU up to 8 GiB,
  4 up to 16, 6 up to 24, 8 up to 32). None: `gcp.customerSize`, **`m`** (80 minutes: about $0.50 against $1.00 on xl;
  the flat price is that share of `UNITY_BUILD_CREDITS`: m 50, s 25, l 75, xl 100, `billing.ts unityBuildCredits`).
  A Cloud Run execution can't change its job's CPU or memory (`jobs.run` overrides are env, task count and timeout), so
  each size is a job: `<customer job>-<size>` (`-4c12g` for numbers that aren't a named size); the size equal to
  `gcp.cpu` / `gcp.memoryGiB` (xl) is the customer job itself, as before. Before a build Gen makes sure the size's job is
  there in each region the customer job is in (`customerJobForMachine`, remembered 10 minutes): made from the customer
  job's template (image, `unity-customer@`, env and license secrets, timeout, gen2) with the first container's limits
  changed, and patched when anything but the limits differs, so a new image on the customer job reaches the sizes on
  their next build. That needs `run.jobs.create`/`update` for Gen's account; without them (the setup only grants
  `jobsExecutorWithOverrides` on each job) the build runs on the customer job at its own size, with a warning in the log
  and `result.warnings`: never a failed build. `customer-setup.mjs --sizes --apply` makes every size's job (and the
  grants) up front. **Out of memory** (Cloud Run's "Memory limit ... exceeded"): built again once, the next named size
  with more memory (none past the biggest); `result.retried` says so (`{ reason, from, to, note }`, `totalSeconds`,
  `totalCost`). Every result has `machine` (`{ name, cpu, memoryGiB }`, what it ran on) and `machineAsked`; the cost is
  priced at that machine. Disk: on Cloud Run `/work` (checkout, Library, output, log) is in memory, so memory is the disk
  too; a Cloud Run ephemeral-disk volume (Preview) would take it off memory, but its v2 API shape wasn't confirmed, so it
  isn't used yet (TODO).
- **Library cache:** its own per Gen project and repo (`unity-cache/cust--<project>--<owner>--<repo>[--<path>]`, key
  `build`), never J's or another customer's.
- **Result:** `{ ok, exitCode, seconds, cost, unity, artifact: { asset, url, bytes, files }, github: { repo, commit,
  ref, path }, method, target: "web", errors, logTail?, backend: "cloudrun", cloud, machine, machineAsked, retried?,
  warnings? }`. `artifact.asset` is a library
  asset of the job's project (a `.tar.gz` of the build folder; `url` is `/v1/assets/<id>/file` on Gen); the Unity log
  is the job's first output.
- **Price:** flat `UNITY_BUILD_CREDITS` = 100 credits ($1.00; Cloud Run at 8 vCPU / 32 GiB is about $0.0125 a minute),
  reserved at submit and refunded when the build fails. Provisional. A Gen app account pays from its own credits; a
  customer's Studio cell key (`org_<hex>`, no Gen account) pays from its Studio balance through the control plane, like
  every other job of that key (AGENTS.md, "Customers' Studios pay from their Studio balance"; `src/orgcredits.ts`).
- Always Cloud Run (`backend` is set to `cloudrun`; the queue's `builder-cloud` lane), never the build server or a VM.

## Settings

`settings.unityBuild` (POST `/v1/settings`, owner):

| Key | Default | What |
|---|---|---|
| `backend` | `builder` | Where builds run unless a project says otherwise: `builder`, `cloudrun` or `vm`. **Set to `cloudrun` on both cloud Gens since 2026-10-29** (the AWS build server is gone) |
| `projects` | `{}` | Per project: `{ "breakingthrough": "cloudrun", "sickofitgame-unity": "vm" }` |
| `timeoutMinutes` | 40 | The hard limit on one build (every backend) |
| `cleanAfterFailures` | 2 | Cache-looking failures in a row before the next build runs clean |
| `concurrency` | 2 | Cloud Run builds at once (their own queue lane, `builder-cloud`; VM builds `builder-vm` and the Windows box one at a time) |
| `vmAt` | 0.85 | A Cloud Run build peaking over this share of its memory moves its project to `vm` (0: never) |
| `gcp` | | `project`, `region` (us-east4), `job` (hawkes-unity-build), `bucket`, `unity` (6000.3.7f1), `cpu` 8, `memoryGiB` 32, `images` (customer mode's versions: `{ "<version>": "<job>" }`; empty = `unity` on `job`), `customerJob` (hawkes-unity-build-customer: the isolated job customer builds run on; other versions' `<job>-customer`; `""` turns customer builds off), `regions` (`["us-central1"]`: more regions with the same jobs, below), `liveRegion` (us-east4: where live Gen and Studio run, tried last; `""` turns that off) |
| `vm` | | `zone` (us-east4-a), `machineType` (n2-standard-8), `pricePerHour` (0.10, for usage) |

**When a region is full** (J, 2026-10-31: a build waited for Google's "unknown quota capacity" in us-east4 with our quota
unused): an execution that hasn't started after 3 minutes and says it's waiting for capacity is cancelled and started
again in the next of `gcp.regions` that has the job (a start the region refuses moves on at once too). The job record
follows it, so the log, cancel and the deadline use the new execution. A follow resumed after a restart doesn't move it
(the customer's token lives only in the process that started it). Every region needs the same jobs: `deploy-job.mjs
--region <r> --apply` and `customer-setup.mjs --region <r> --apply` (same image, same bucket; us-central1 has both
since 2026-10-31). Adding a Unity version means its job in every region. **Check and align them with one command:**
`node tools/unity-cloudrun/regions.mjs [--lane live|beta]` reads the running Gen's own regions and lists each region's
jobs and images (exit 1 when they differ); `--image <image> --apply` runs deploy-job and customer-setup in every one
(2026-10-31: live Gen's main region was us-west1, set up long before by hand, with no customer job). A customer build
only runs where its customer job is there and checks out, skipping the rest.

**The live services' region goes last** (2026-11-02: 8 vCPU builds and CPU playtests used up hawkes-staging's Cloud
Run CPU quota in us-east4, and live Studio couldn't start a new revision). Cloud Run's CPU quota ("Total CPU allocation,
per project per region") is shared by every service and job in a region, so `gcp.liveRegion` (us-east4, where gen,
studio and the customer studios run) is tried after every other region a build has: `region` us-east4 with `regions`
`["us-central1", "us-west1"]` builds in us-central1, then us-west1, then us-east4. With only the live region a build
still runs there. The CPU playtest service orders its regions the same way (docs/playtest-cloudrun.md).

The tool params `backend` (auto/builder/cloudrun/vm), `cache` (a cache name) and `clean` (no cache) override per job.
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

### The build VM: for projects too big for Cloud Run

Cloud Run's other volumes don't help here. An **NFS** volume (Filestore, from about $200/month, or a VM serving NFS)
mounts without file locking ("no-lock mode"), and Unity's ArtifactDB is LMDB, which needs real locks and fast random
I/O. A **Cloud Storage** volume (gcsfuse) is worse for it. Neither is safe for a Library, and Cloud Run has no
disk-backed scratch volume.

So a project whose backend is **`vm`** (`settings.unityBuild.projects`) builds on **its own small spot VM**, running
**the same image** (`src/providers/builder/vm.ts`):

- **The machine:**
  - The VM is `hawkes-unity-<project>`, e.g. `hawkes-unity-sickofitgame-unity`.
  - It is an `n2-standard-8` spot machine (8 vCPU, 32 GB) running Container-Optimized OS, with a 50 GB boot disk.
  - A separate 200 GB `pd-balanced` work disk (`<name>-work`) keeps the sources and the Library between builds.
  - `tools/unity-cloudrun/vm.mjs` makes it, printing first and acting only with `--apply`. It is stopped whenever
    nothing builds.
- **A build, from Gen:**
  1. Gen uploads the same inputs and `spec.json` as for Cloud Run.
  2. It sets the instance metadata `hawkes-spec` and `hawkes-job`, then starts the VM (Compute Engine REST with ADC,
     no SDK).
  3. The VM's startup script (`server/unity-cloudrun/vm-startup.sh`) mounts the work disk, reads the secrets from
     Secret Manager into a root-only file in `/run`, pulls the image, and runs the container. The flags are
     `HAWKES_PERSIST=1 HAWKES_WORK=/work` and `--log-driver=gcplogs`.
  4. When the build is done, the VM powers itself off.
  5. Gen follows the container's log (Cloud Logging, `gcplogs-docker-driver`), `result.json` in the bucket, and the
     instance's state. Then it stops the VM, which does nothing if it already is, and takes `hawkes-spec` off it.
  6. Gen lays the output down with the same code as for Cloud Run, and the result has the same shape.
- **`HAWKES_PERSIST=1`:**
  - The Library on the disk is used as it is.
  - If there is none yet, the first build restores the bucket's cache, which seed-cache.mjs may have uploaded.
  - Nothing is saved back to the bucket.
  - The checkout is fetched in place; `git clean` keeps `Library/`.
  - `BuildCache` can stay, because the disk has room.
- **When Google takes the spot VM back:** the VM stops and the build ends with "the build VM stopped before the build
  finished … run the build again". Its disk and Library are kept.
- **Waiting:** VM builds have their own queue lane, one at a time. A VM found still running from an earlier build is
  stopped after a minute.
- **Automatic move to the VM:** when a Cloud Run build's memory peak (`cloud.memoryPeakBytes`) passes **85%** of its
  limit (`settings.unityBuild.vmAt`; 0 turns it off), or Cloud Run kills it for memory, Gen sets that project to
  `vm`. The job's log and its `result.movedToVm` say so, and also say to make the VM first if it isn't there.
- **Cost:**
  - Spot `n2-standard-8` is about $0.08–0.10/hour while building (`settings.unityBuild.vm.pricePerHour`, 0.10, for
    the usage records).
  - The disks cost about $20/month (200 GB) plus $5/month (50 GB boot).
  - There is no idle machine. The Windows box, for comparison, costs $0.77/hour plus $24/month.
- **Rights** (vm.mjs sets them):
  - The build's account may read the image.
  - Gen's account has `compute.instanceAdmin.v1`, so it can start and stop the VM and set its metadata.

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

**What changed (2026-10-28):**
- Unity no longer offers manual (`.ulf`) activation for Personal: `license.unity3d.com/manual` redirects away, and
  GameCI says so.
- J's PC has no `Unity_lic.ulf`.
- The first design (a `.ulf` in a secret) is therefore dropped.

**What the build does now: Personal activation through the Unity Licensing Client, signed in with the account's email
and password, at the start of every build, returned at the end.**

- **The client and the call:** the Unity Licensing Client (`Unity.Licensing.Client`) ships inside the editor. The
  entrypoint finds it under `/opt/unity`, or uses `UNITY_LICENSING_CLIENT_PATH`, and runs:
  `Unity.Licensing.Client --activate-ulf --include-personal --username "$UNITY_EMAIL" --password "$UNITY_PASSWORD"`.
  - This is what RageAgainstThePixel's `unity-cli` (`activate-license --license personal`) runs.
  - GameCI's personal path (cli PR #246, merged 2026-09-05) does the same with `--activate-all --include-personal`.
  - The entrypoint tries `--activate-ulf` first and falls back to `--activate-all` when the client doesn't know the
    first flag. Network timeouts are retried 3 times.
- **Returning the license:** `Unity.Licensing.Client --return-ulf`, in the exit trap, so a failed or timed-out build
  returns it too. Only a container killed outright (out of memory) can't, and that activation frees itself later.
- **Why not the alternatives:**
  - `unity-editor -username -password` without a serial is the Plus/Pro path. Unity documents that it does not
    apply to Personal, and GameCI says the same.
  - The Unity Hub CLI (`unity license activate --personal`) needs a cached sign-in from a desktop session.
  - Manual `.ulf` activation is gone.
  - A Plus/Pro serial still works: set the secret `unity-serial` (`deploy-job.mjs --serial`) and the editor's
    `-serial` path is used, with `-returnlicense` at the end.
- **When activation fails**, the build fails at once with kind **`license`** and one of these reasons. Gen says
  "Unity isn't licensed in the cloud build: <reason>. The build signs in to Unity with the secrets unity-email and
  unity-password …".
  - "the Unity account asks for two-factor or device verification, which a headless build can't answer"
  - "Unity refused the email or password (secrets unity-email, unity-password)": the client's exit code 2, or the
    words.
  - "the Unity account has no free Personal activation (seat limit) …"
  - "the secrets unity-email and unity-password … are empty"
  - otherwise, the client's own error line
- **Secrets are never printed:**
  - The test (`test/unity-license.test.ts`, against a fake client) checks that the password never reaches the output.
  - The password does appear in the container's own process list, because the client has no stdin option. That is
    the same in GameCI, and nobody else can see that container.
- **Secret names:** `unity-email` → `UNITY_EMAIL`, `unity-password` → `UNITY_PASSWORD`, `github-token` →
  `GITHUB_TOKEN`, and optionally `unity-serial`. Cloud Run mounts them; the build VM reads them from Secret Manager.

**Risks, honestly:**
- **Undocumented flags:** Unity documents neither the Licensing Client's flags nor its messages (GameCI's PR says
  so). An editor update could change them. The license check below catches that before any real build.
- **No 2FA on the build account:** the account must not have two-factor sign-in, because nothing headless can answer
  it. That is a real security trade-off. The safest form is a **separate Unity account used only for builds**, with
  a long random password that lives only in Secret Manager.
- **Unity's terms:**
  - Unity Personal is for individuals and small companies under Unity's revenue and funding threshold. Each person
    or entity using it must qualify.
  - Unity sells Build Server licenses for headless CI machines, which shows that Unity sees automated builds as a
    paid use case.
  - Using a Personal seat on ephemeral CI machines is what GameCI's whole Personal path does, but Unity has never
    explicitly blessed it.
  - If Hawkes ever passes the Personal threshold, or Unity objects, the answer is a Plus/Pro or Build Server seat
    (`unity-serial`). No code changes: the entrypoint already has that path.
- **Seat limits:** each build activates and returns a seat. Two builds at once (the default `concurrency` 2), plus
  J's own editor, plus a VM build, could hit the account's activation limit. If builds start failing with "seat
  limit", set `settings.unityBuild.concurrency` to 1.

**Sources:**
- [game-ci/cli PR #246, Personal activation via the Unity Licensing Client](https://github.com/game-ci/cli/pull/246):
  merged; uses `--activate-all --include-personal --username --password`; says the flags are undocumented, that 2FA
  can't be answered headless, and that `unity-editor -serial -username -password` is the serial path only.
- [RageAgainstThePixel/unity-cli](https://github.com/RageAgainstThePixel/unity-cli) and its
  [`license-client.ts`](https://raw.githubusercontent.com/RageAgainstThePixel/unity-cli/main/src/license-client.ts):
  `--activate-ulf --username --password --include-personal`, return with `--return-ulf`, exit code 2 = invalid
  credentials.
- [Running Unity 6000.x headless builds in a Linux container](https://dev.to/nydjustin/running-unity-6000x-headless-builds-in-a-linux-container-a-field-report-including-licensing-519b)
  (the Hub CLI needs a cached sign-in; the manual `.alf` flow fails for Personal).
- [GameCI activation docs](https://game.ci/docs/github/activation).

## What J sets up

1. **Install the Google Cloud CLI** and sign in: `gcloud auth login`. Pick or make a project with billing on.
2. **The build account (recommended):**
   - Make a separate Unity account for builds at id.unity.com and leave two-factor sign-in **off** on it.
   - Sign in to Unity Hub with it once and accept the Personal terms, so the account has a Personal entitlement.
   - J's own account works too, if 2FA is off on it.
3. **A GitHub token** for the builds:
   - Fine-grained, with read-only **Contents** on breakingthrough, YoobaLand, sickofitgame-unity, hawkesgen and
     hawkesstudio, and **Contents: read and write** on sickofitgamewebsite, YoobaLandGame and theplacedepartmentwebsite
     (GitHub mode pushes the build to their beta). LFS is covered by Contents.
   - The control server's existing `GITHUB_TOKEN` works too.
4. **Image, job and secrets.** Each script prints first; add `--apply` to do it.
   ```
   node tools/unity-cloudrun/build-image.mjs --project <gcp-project> --apply
   node tools/unity-cloudrun/deploy-job.mjs --project <gcp-project> --bucket hawkes-unity-<gcp-project> --image <printed image> --apply
   powershell -ExecutionPolicy Bypass -File tools\unity-cloudrun\add-secrets.ps1 -Project <gcp-project>
   node tools/unity-cloudrun/deploy-job.mjs --project <gcp-project> --bucket hawkes-unity-<gcp-project> --image <printed image> --apply
   ```
   - The first deploy-job run makes the secrets `unity-email`, `unity-password` and `github-token` empty and stops
     before the job.
   - `add-secrets.ps1` asks for the three values without showing them. Leave an answer empty to keep the current
     value; `-Serial` also asks for a Plus/Pro serial.
   - The second deploy-job run makes the job.
   - To set one secret by hand instead: write the value to a file with no newline at the end, run
     `gcloud secrets versions add unity-password --data-file=<file> --project <gcp-project>`, then delete the file.
5. **The license check**, about 2 minutes and about $0.02:
   ```
   gcloud run jobs execute hawkes-unity-build --region us-east4 --project <gcp-project> --update-env-vars HAWKES_LICENSE_CHECK=1 --wait
   ```
   - It activates, opens a throwaway project, and returns the seat.
   - Its log (Cloud Run > Jobs > hawkes-unity-build > the execution > Logs) says
     `license: OK, the editor opened a project licensed`, or `license: FAILED: <reason>`.
   - A failed check also makes the execution fail, so `--wait` reports it.
6. **Gen's credentials:**
   - Run `gcloud iam service-accounts keys create hawkes-gen-gcp.json --iam-account=hawkes-gen@<gcp-project>.iam.gserviceaccount.com`.
   - Put the file on the control server, next to Gen's `.env` and never in git.
   - Set `GOOGLE_APPLICATION_CREDENTIALS` to its path in `.env`.
   - On a Google control VM, its own service account (ADC) works instead.
7. **Gen's settings** (owner): `POST /v1/settings` with
   `{"unityBuild": {"gcp": {"project": "<gcp-project>", "bucket": "hawkes-unity-<gcp-project>"}, "projects": {"breakingthrough": "cloudrun"}}}`.
8. **For a big project** (Sick Of It), or when Gen says a project moved to its VM:
   - Run `node tools/unity-cloudrun/vm.mjs --folder C:\Projects\sickofitgame-unity --image <image> --project <gcp-project> --apply`.
   - Then set `"projects": {..., "sickofitgame-unity": "vm"}`.

## Pilot: breakingthrough first

1. **License check:** step 5 above. Stop here until it passes.
2. **Seed** breakingthrough's cache (0.4 GB), with Unity closed:
   `node tools/unity-cloudrun/seed-cache.mjs --folder C:\Projects\breakingthrough --project <p> --bucket <b> --apply`.
   This is optional: without it, the first cloud build is a full import.
3. **One build into a scratch copy:**
   `hawkesgen run unity.build project=breakingthrough site=theplacedepartmentwebsite method=WebGlBuild.FullDeploy backend=cloudrun siteDir=<a copy of the website>`.
   - Check `result.version`, the files in the copy, `cloud.memoryPeakBytes` and `cloud.stages`.
   - Check that the game plays (Studio's smoke playtest of The Place Department against the copy).
4. **On beta:**
   - Set `projects.breakingthrough = "cloudrun"` on the control server. The next push to breakingthrough's beta builds
     in the cloud, and Studio playtests it as usual.
   - Run it for a week and compare time, cost and failures with the Windows box.
5. **YoobaLand** next. `YoobaWebBuild.FullDeploy` already reads `WEBSITE_PATH`.
6. **Sick Of It:**
   - Only after its deploy script stops hard-coding `C:\Projects\...` (below).
   - Either Cloud Run with the trimmed cache (the 85% rule moves it to the VM by itself if it peaks too high), or its
     VM from the start.
7. **When all three have been fine for two weeks:**
   - Make `backend: "cloudrun"` the default.
   - Stop the Windows box, but keep it stopped for Remote Desktop editing and as the fallback. Terminating it is J's
     call.

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
`cloudrun` or `vm` (its `projects`, else `backend`).
