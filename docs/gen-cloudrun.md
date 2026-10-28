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

## Known limits

- **One instance**: fine for Studio and a few customers; a crowd needs the database off SQLite first.
- A file made just before the instance stops may not be in the library bucket yet (backups run in the background).
- `settings.brain` defaults to Cursor's CLI, which the image doesn't have: set a brain that works on Cloud Run.
