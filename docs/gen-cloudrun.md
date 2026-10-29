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
(`https://gen-beta.hawkesgen.ai`): its own database, library, settings, Claude login and owner key (secret
`gen-beta-owner-key`), the same image and provider keys, a BETA badge on the dashboard and `lane: "beta"` in
`/v1/health`. `main` is **gen**, live. Testing on beta never touches live customers or their files. Made once with
`deploy.ps1 -Lane beta` (client.json gets `genBetaUrl`/`genBetaKey`, live's entry is untouched) and
`npx wrangler deploy --env beta` in `server/gen-edge`.

## Deploys

A push to `beta` or `main` deploys that lane (`.github/workflows/ci.yml`): GitHub signs in to Google with its own OIDC
token (no stored key: the `github-gen` provider of the `github` Workload Identity pool trusts only this repo's main and
beta, as `gen-deployer@`), builds the image of that commit with `tools/gen-cloudrun/build.mjs`, points the lane's
service (`gen-beta` or `gen`) at it, and checks the lane's `/v1/health`; if the new revision doesn't answer within three
minutes, traffic goes back to the previous one and the run fails. The image is per commit, so going live after beta
reuses beta's image. GitHub runs no tests (J, 2026-10-25): run `npm run typecheck` and `npm test` before
pushing. One-time setup: `powershell -ExecutionPolicy Bypass -File tools\gen-cloudrun\setup-ci.ps1` (J). By hand, as
before: `build.mjs --apply`, then `gcloud run services update gen --image <tag>` (or `deploy.ps1` when settings, secrets
or permissions change).

## The address

`https://gen.hawkesgen.ai` is a Cloudflare Worker (`server/gen-edge/`, `npx wrangler deploy` there) that passes every
request to the service's own address and the visitor's IP as `X-Hawkes-Client-IP`, which Gen believes only from
Cloudflare's ranges (`src/analytics/collect.ts clientIp`).

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

## Known limits

- **One instance**: fine for Studio and a few customers; a crowd needs the database off SQLite first.
- A file made just before the instance stops may not be in the library bucket yet (backups run in the background).
- `settings.brain` defaults to Cursor's CLI, which the image doesn't have: set a brain that works on Cloud Run.
