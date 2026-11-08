# Hawkes Gen on Cloud Run

Since 2026-10-28 (AWS suspended the account; J: "cloud forward and cheap as possible"), Gen runs as the Cloud Run
service `gen` in `hawkes-staging` / `us-east4`, instead of on the AWS control server. It started empty: the old
database and library stayed on AWS.

## How it runs

- **One instance at most, none while idle** (`--max-instances=1 --min-instances=0`). One instance because SQLite has
  one writer. CPU stays on while an instance lives (`--no-cpu-throttling`), so the queue works between requests.
- **The databases** (`hawkesgen.db`, `analytics.db`) are restored from Cloud Storage when an instance starts and
  streamed back after every change by [Litestream](https://litestream.io) (`server/gen-cloudrun/entrypoint.sh`,
  `litestream.yml`; `gs://<project>-gen-state/db/`).
- **One writer across revisions** (`src/cloudlease.ts`, ported from Studio after studio-beta lost data on a deploy,
  2026-10-31). Max-instances 1 is per revision: during a deploy, and for a while after it, the old revision's instance
  keeps running and Litestream keeps streaming its own generation while the new one restores another, so what the old
  one writes afterwards is lost. A lease in the state bucket fixes that:
  - `db/lease.json` names the holder; `db/alive-<id>` is its heartbeat every 5 s, with each database's Litestream
    generation; `db/released-<id>` is written after its last sync, with those generations.
  - A starting instance claims before `litestream restore` (`entrypoint.sh`: `node src/cloudlease.ts claim`), then waits
    up to 30 s for the previous holder's release and restores exactly the generations it names (`-generation`). Only a
    holder already silent for 15 s before the claim (crashed, gone) is skipped, and then its last heartbeat's generations
    are restored.
  - The holder checks the lease every 5 s (`startCloudHost` → `watchLease`): when another instance claimed it, it pushes
    its state files and exits; Litestream syncs one last time (it runs in the background, not `exec`, with a TERM trap)
    and `entrypoint.sh` writes the release (`cloudlease.ts release`).
  - An older revision (by its number in `K_REVISION`) never claims from a newer one: its claim exits 3 and the instance
    logs "stays down" and runs `server/gen-cloudrun/standby.mjs` instead of Gen: it opens no database and answers every
    request with a 503 "restarting" (JSON on the API, `X-Hawkes-Restarting: 1`; on `/v1/events` a stream that says
    `retry:`), and stops itself after 30 s with no requests.
  - **The handover gap** (2026-11-02): from the old holder's exit until the new revision is ready and takes the traffic
    (restore, then start, about 30 s), the traffic still goes to the old revision. Before the stand-in, its new instances
    exited and Cloud Run answered with Google's HTML "500 Server Error" page; the app's live stream (`/v1/events`) got
    it and the browser's EventSource gave up for good. Now the hawkesgen.ai Worker (`server/gen-edge`) asks a read
    again for up to about 25 s while Gen answers "restarting" (or Google's page), the app reopens its stream with a
    growing wait and catches up once it's back (`dashboard/gen/stream.js`), and Litestream snapshots `hawkesgen.db`
    every 15 min so a restore replays less WAL.
  - Nothing the claim imports opens a database (an empty one would make `restore -if-db-not-exists` skip). Test
    `test/cloud-lease.test.ts`. In the logs a clean deploy reads `[lease] {..."how":"released","generation":{...}}`.
  - **The first deploy with the lease can't hand over:** the running revision has no lease, so the new one claims
    `"how":"first"` while the old one keeps writing until Cloud Run stops it (gen-beta, 2026-10-31: about 40 s of a job's
    log lines on the old copy). Do live's first one while the queue is idle. Every deploy after that hands over
    (verified on gen-beta 00029 and 00030: released, the exact generations restored, the old instance "stays down" and
    is gone within half a minute).
- **State files** beside them (`settings.json`, Cloud Run image refs, small caches) are pulled before Gen reads them and
  pushed when they change and when Cloud Run stops the instance (`src/cloudhost.ts`; `gs://<project>-gen-state/state/`).
- **Library files** live in `gs://<project>-gen-library` (`HAWKESGEN_LIBRARY_STORE=gcs`): every new file is backed up
  there and fetched back on demand, so the instance's disk is only a cache.
- **While jobs are queued or running** Gen calls its own `/v1/health` every 45 s, which keeps Cloud Run from taking the
  instance away mid-job. Once the queue is empty the calls stop and the instance goes away after Cloud Run's idle time.
- **Keys:** there is no "this machine" on Cloud Run, so local open access is off there. On an empty database the secret
  `gen-owner-key` becomes the owner's key (`ensureOwner`). Provider keys are secrets mounted as environment variables.
- **Work goes to the other services:** GPU work to the GPU services (`docs/cloudrun.md`), the CPU suite to `gen-cpu`
  (`docs/cpu-cloudrun.md`), Unity builds to the build job (`docs/unity-cloudrun.md`), playtests to `gen-playtest`
  (`docs/playtest-cloudrun.md`). What isn't routed there yet runs inside this instance.
- Entry: `src/cloudrun-main.ts` (pull state, make the owner, start `src/server.ts`). On Cloud Run, `server.ts` skips the
  AWS-only background work (the machines monitor, fleet images, fleet access).

## Cost

Idle: nothing (plus a few cents of storage). Busy: 2 vCPU and 4 GiB at Cloud Run's instance rates, about $0.16 an hour
while an instance lives (us-east4). An instance lives while requests come in or jobs run, plus Cloud Run's idle time.

## Deploying

1. `node tools/gen-cloudrun/build.mjs --apply` builds the image from the current commit (`git archive`, so `.env` and
   `.data` can't get in; the tag is the commit). Commit first.
2. `powershell -ExecutionPolicy Bypass -File tools\gen-cloudrun\deploy.ps1` (J: IAM and secrets): buckets, permissions,
   secrets from `.env`, the service, its URL, the starting settings, and `~/.hawkes/client.json` (old one kept as
   `client.aws.json`). Every step is safe to repeat. A new image later: build, then run the script again.

## Lanes: dev -> beta -> main

J, 2026-10-28: "dev -> beta -> main". Work lands on `dev` (deploys nothing). `beta` is **gen-beta**
(`https://beta.hawkesgen.ai`): its own database, library, settings, Claude login and owner key (secret
`gen-beta-owner-key`), the same image and provider keys, a BETA badge on the dashboard and `lane: "beta"` in
`/v1/health`. `main` is **gen**, live. Testing on beta never touches live customers or their files. Made once with
`deploy.ps1 -Lane beta` (client.json gets `genBetaUrl`/`genBetaKey`, live's entry is untouched) and
`npx wrangler deploy --env beta` in `server/gen-edge`.

## Pull request check

`.github/workflows/checks.yml` runs `npm ci`, `npm run typecheck` and `npm test` on every pull request into `beta` or
`main` and on pushes to `beta` (J, 2026-11-08). The check is named **`Typecheck and tests`** (workflow `Checks`): add that
name under Settings > Branches (or a ruleset) > Require status checks to make it required. It uses no secrets and no
provider keys (read-only token, `HAWKESGEN_AI_MOCK`, `HAWKESGEN_AUDIO_MOCK` and `HAWKESGEN_QUALITY_MOCK` set), spends nothing,
and times out at 10 minutes (the suite takes about 2 to 3). A newer push to the same pull request cancels the older run.

## Deploys

A push to `beta` or `main` deploys that lane (`.github/workflows/ci.yml`): GitHub signs in to Google with its own OIDC
token (no stored key: the `github-gen` provider of the `github` Workload Identity pool trusts only this repo's main and
beta, as `gen-deployer@`), builds the image of that commit with `tools/gen-cloudrun/build.mjs`, points the lane's
service (`gen-beta` or `gen`) at it, and checks the lane's `/v1/health`; if the new revision doesn't answer within three
minutes, traffic goes back to the previous one and the run fails. The image is per commit, so going live after beta
reuses beta's image. A push to a lane runs no tests itself (J, 2026-10-25): run `npm run typecheck` and `npm test` before
pushing; pull requests are checked as below. One-time setup: `powershell -ExecutionPolicy Bypass -File tools\gen-cloudrun\setup-ci.ps1` (J). By hand, as
before: `build.mjs --apply`, then `gcloud run services update gen --image <tag>` (or `deploy.ps1` when settings, secrets
or permissions change).

## The address

`https://hawkesgen.ai` (and www; beta: `https://beta.hawkesgen.ai`) is a Cloudflare Worker (`server/gen-edge/`,
`npx wrangler deploy` there, `--env beta` for beta) that passes every request to the service's own address and the
visitor's IP as `X-Hawkes-Client-IP`, which Gen believes only from Cloudflare's ranges (`src/analytics/collect.ts
clientIp`). Until 2026-10-29 Gen was gen.hawkesgen.ai (gen-beta.hawkesgen.ai) and these names were the customer portal's,
which moved to hawkesgames.com (hawkesgenwebsite `docs/domain-move.md`). J retired the gen. names the same day
(their routes and DNS records are gone). On the portal's old names the Worker keeps the portal's
links working (`PORTAL_ORIGIN`, `PORTAL_HOSTS`): everything goes to Gen first; a portal OAuth token, or its session on
`/v1` and `/mcp`, goes to the portal; what Gen answers 404 is the portal's (pages redirected, the rest passed on), and so
is a key Gen refuses (401) on `/v1` and `/mcp`. Test `test/gen-edge.test.ts`.

## The CDN

`https://cdn.hawkesgen.ai` is a second Cloudflare Worker (`server/gen-cdn/`, `npx wrangler deploy` there) serving only
`/sha256/<hash>`: a cached file comes from Cloudflare's edge (kept a year: a hash names its bytes), a miss from Gen's
`/cdn/sha256/<hash>` route, which streams that one object from the library bucket with Gen's own identity. No key exists
anywhere (the Google organization forbids service-account keys), the bucket stays private and can't be listed. Gen's
`settings.storage.cdn` set to the address makes asset answers carry CDN links.

What goes out: only files of projects in `settings.storage.cdnProjects` (default `["*"]`: every project except
customers' `usr_`/`ustg_` ones, which get in only by exact name or a `usr_`/`ustg_` prefix). Other files get no CDN link
and the route answers 404, so a leaked hash of a customer's private file shows nothing. On Cloud Run the route answers
only Cloudflare's edge (the last hop in Cloud Run's X-Forwarded-For), so nobody can skip the cache and wake Gen.
Anyone holding a hash of an allowed file can read it: that is what a CDN link is.

## Health and alerts

`GET /v1/health` answers from a 5 s in-process cache (J, 2026-11-08): the body runs three db queries and Cloud Run, Studio's
checks and the keep-alive all ask. It still carries `version`, `commit`, `lane`, `queue` and `loop`; the numbers in it are at
most 5 s old. This is not an HTTP cache (no headers, nothing at the edge). `GET /v1/health?deep=1` with an owner or admin
key is always fresh and adds `deep` (when it was made, how long each query took); from anyone else it gets the cached answer.

`tools/gen-cloudrun/alerts.mjs` prints Cloud Monitoring alert policies for a lane and **creates nothing without `--apply`**
(it never deletes; a metric or policy that exists by name is left alone, so it is safe to repeat):

```
node tools/gen-cloudrun/alerts.mjs --lane beta                       # print
node tools/gen-cloudrun/alerts.mjs --lane beta --channel <id> --apply   # J: create (needs gcloud signed in)
```

| Policy | Fires when |
|---|---|
| 5xx rate | more than 5 `5xx` responses in 5 minutes (Cloud Run's `request_count`) |
| instance restarts | more than 2 boots in 15 minutes (log metric `gen_<lane>_boots`, the "Hawkes Gen on http://" line) |
| event-loop lag | more than 3 blocks of 500 ms or more in 10 minutes (`gen_<lane>_loop_blocks`, `src/lag.ts`'s `[lag]` line) |
| queue depth | more than 50 jobs waiting for 10 minutes (`gen_<lane>_queue_depth`, from the `[queue-depth]` line) |

`--channel` takes a notification channel id (made once in the console); without one the alerts show in the console only.
The queue-depth line is logged when the health cache refreshes while jobs wait, so it is sampled whenever something asks
for health (the keep-alive and Studio do, but an instance nobody asks about logs nothing).

## Known limits

- **One instance**: fine for Studio and a few customers; a crowd needs the database off SQLite first.
- A file made just before the instance stops may not be in the library bucket yet (backups run in the background).
- `settings.brain` defaults to Cursor's CLI, which the image doesn't have: set a brain that works on Cloud Run.
