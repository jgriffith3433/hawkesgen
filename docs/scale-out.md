# Scaling Gen past one instance

Written 2026-11-08 for the stability item (i_c8587ff818df). J's steer: single instance first; move off SQLite only if the load
harness shows it is needed. This page is the reading behind that call: what one instance holds, what breaks first, what would
break across several, and the order to fix it. Docs only; nothing here is applied. Prices are rough (us-east4, list rates, Nov
2026) and should be re-checked before anyone commits to them.

## 1. What one instance holds today

Gen on Cloud Run is `--max-instances=1 --min-instances=0 --cpu=2 --memory=4Gi --concurrency=80` (`tools/gen-cloudrun/deploy.mjs`).
One instance because SQLite has one writer (`src/db.ts`: WAL, `node:sqlite`), kept safe across deploys by the lease
(`src/cloudlease.ts`, docs/gen-cloudrun.md).

**Load report numbers** (docs/load.md; `tools/load/run.mjs`, a local copy with every paid provider mocked, so they show Gen's own
code, not Cloud Run):

| Measured | Result |
|---|---|
| 300 users, default rate, all storms | 836 of 836 jobs finished; `POST /v1/jobs` p95 ~240 ms; peak RSS 340 MB; restart back in ~1.4 s |
| Sign-up burst (300 sign-ins at once) | ~12 s, p95 11 s, event loop blocked ~6 s (password hashing). The one FAIL on that run |
| 150 accounts x 3 tabs = 450 held streams, 0.2 jobs/s each | sign-in p95 546 ms, submit p95 6 ms, RSS 259 MB (heap 64 MB), worst loop lag 479 ms, 0 errors |
| 60 accounts, 1 tab vs 4 tabs | submit p95 7 ms either way: extra tabs do not slow submits |

**Not yet measured:** the remote run against beta (`tools/load/remote.mjs`, workflow `ops-load-beta`, 90 then 450 streams).
No report from it is merged into this repo, so nothing below claims a number from Cloud Run itself. The first thing to do
with this page is paste that run's table into section 1.

**What breaks first, in order:**
1. **Connection slots, not memory.** Each `GET /v1/events` stream holds a Cloud Run concurrency slot. At 80 the 81st request
   waits, with memory at a few hundred MB of 4 GiB. docs/load.md recommends 400 (not applied; needs the beta run first).
   That puts the ceiling at about 130 signed-in people with the default 3 tabs each, or about 400 with one tab.
2. **The event loop.** Everything is one thread. Sign-in hashing blocks it for seconds in a burst (a launch spike is exactly
   this), and every open stream waits with it. This breaks the *feel* long before anything crashes.
3. **SQLite's single writer.** Fine at the harness's rate (jobs, ledger and library writes all finished). It is the limit that
   decides section 3, not the one reached first.
4. **CPU: 2 vCPU**, shared by the API, the queue, ffmpeg and Pillow work that is not yet routed to `gen-cpu`, and Litestream.

## 2. What breaks across several instances

Raising `--max-instances` today would be wrong for reasons beyond the database: the database file lives on one instance's disk
(Litestream restores it; it does not merge two writers), and the lease deliberately makes a second instance **stop** the first.
Even with a shared database, this in-memory state is per process. "Effect" is what a person would see.

**Jobs and the queue** (the biggest block; the table rows survive, the running state does not):
| State | File | Effect with two instances |
|---|---|---|
| `Queue.busy`, `lanes`, `cloud`, `aborts`, `families`, `diskAvoid`, `uploads` (which server/lane runs which job) | `src/jobs.ts` (class `Queue`, ~l.661) | Both instances pump the same `queued` rows and start the same job twice; fair-share caps (`queue.perProjectLane`, `perProjectGpu`) and "one family per GPU" are counted per instance, so each customer gets double; a cancel reaches only the instance holding the `AbortController` |
| `dirtyLogs` (log lines waiting to flush every second) | `src/jobs.ts:134` | A reader on the other instance sees a stale log |
| `runSeconds`, `spendCache` | `src/jobs.ts:1512`, `:403` | Estimates and the daily spend guard see half the picture |
| `busy` (productions being advanced) and the 15 s `advanceAll` timer | `src/showrunner/production.ts:181`, `:285` | The same production advanced twice; shots made twice, paid twice |
| `pending` (LOD work), `queue`/`queued` (storage backup) | `src/lod.ts:84`, `src/storage.ts:166` | Duplicate work; harmless but wasteful |
| `active` upload counters | `src/uploads.ts:24` | The 20-parallel-upload cap becomes 20 per instance |
| GPU provider cooldowns and last errors | `src/providers/gpu/health.ts:7-9` | One instance keeps sending jobs to a provider the other found down |
| Cloud Run / CPU routing memory, `recent`, `jobChecks`, `ensured` | `src/providers/cloudrun/cpu.ts:123`, `src/providers/builder/customer.ts:326`, `src/providers/builder/sizes.ts:126` | Duplicate checks; mostly cosmetic |
| The 45 s self-ping that keeps an instance alive while jobs run | `src/cloudhost.ts:124` | Pings whichever instance Cloud Run picks, not necessarily the one running the job: a job's instance can be scaled in mid-run |

**Live streams** (`GET /v1/events`):
| State | File | Effect |
|---|---|---|
| `byUser`, `byProject`, `wide` (open streams) and the bus itself (`events`, an in-process `EventEmitter`) | `src/eventhub.ts:28-30`, `src/bus.ts` | The worst one for users: a job finishes on instance A and only the people connected to A hear it. Instance B's people see a spinner until they reload |
| The 3-streams-per-account cap | `src/eventhub.ts` | Becomes 3 per instance |
| Stream ids (`nextId`) | `src/eventhub.ts:27` | Ids are per process; events carry no shared sequence, so a reconnect to another instance cannot resume where it left off (the app refetches on `onReconnect` instead) |

**Rate limiters and one-time tokens** (each says "use once" or "N per minute"; with N instances, N times that):
| State | File | Effect |
|---|---|---|
| Request token buckets (`buckets`) | `src/ratelimit.ts:46` | Limits multiply by instance count; sign-in limit (15/min per address, the abuse guard) is the one that matters |
| Analytics collect windows, heavy-answer `cache` | `src/analytics/collect.ts:207`, `src/analytics/routes.ts:25` | Per-instance limits; a dashboard can show different numbers on refresh |
| Test sign-in nonces `used`, GitHub OIDC nonces `used` | `src/testsignin.ts:37`, `src/githubsignin.ts:38` | A token meant for one use works once per instance (beta only) |
| Org credits charge retries | `src/orgcredits.ts:142` (timer) | Two settlers could refund one job twice unless the row is claimed in the database |

**Smaller caches** (safe to leave, stale at worst): `clientsSeen` (`src/api.ts:281`), `orgClients` (`src/providers/anthropic.ts:48`),
playtest host and runner bookkeeping (`src/providers/playtester/*.ts`, `src/providers/playtester/intake.ts:98`, the GitHub token
vault, **in memory by design**: it must not be shared to disk), `aimock` queues (`src/aimock.ts:42`, tests only), `lag.ts` blocks.

**Things that are fine** because they already live outside the process: library files (`gs://…-gen-library`), settings and state
files (bucket sync, but see below), GPU/CPU services (separate Cloud Run services), Stripe webhooks (idempotent per invoice).

**One more trap, not a Map:** `settings.json` and the other state files are pulled at start and pushed every 30 s
(`src/cloudhost.ts`). Two instances would overwrite each other's settings (last writer wins). Anything that writes settings at
run time (the admin screens, the GPU cooldown) needs to move into the database first.

**Timers that would run twice** (each starts in every instance): the production advancer (15 s), org-charge settling, the
make-feedback summarizer (3 h), RunPod credit and cap checks, the analytics purge (10 min), the machines monitor
(AWS only, off on Cloud Run). These need a single owner (a lease row in the database) or a Cloud Scheduler call.

## 3. Cold start

The instance restores two databases from Cloud Storage before Gen listens (`server/gen-cloudrun/entrypoint.sh`): claim the
lease, wait for the previous holder to release (up to 30 s), `litestream restore` for `hawkesgen.db` and `analytics.db`, pull
state files, start. docs/gen-cloudrun.md measures the **deploy handover at about 30 s**; the edge Worker retries reads for ~25 s
while Gen answers "restarting". A cold start from zero with no previous holder skips the wait but still restores, so it grows
with the database (Litestream snapshots every 15 min so a restore replays little WAL). The load harness's restart (~1.4 s) is a
local process restart with the database on disk and so does **not** include any of this.

Cost of cold starts today: a visitor who arrives when the instance is gone waits for restore plus boot; `--min-instances=1`
removes it (about $0.16/h x 24 x 30 ≈ $115/month with CPU always on, 2 vCPU/4 GiB; worth it only once there are real visitors
at all hours). A managed database removes the restore from the start and with it most of the wait (the process boots in about
a second or two).

## 4. Recommended next step

**Do not add instances yet. Make the one instance hold more, then move the database, then add instances.** Reasons: the harness
says one instance copes with the expected launch crowd once the slot count and the sign-in block are fixed; the risks of going
wide (section 2) are many and silent; and J asked for the SQLite move only if the harness shows it is needed.

**Step 0 (free, do now):** run `ops-load-beta` at 30 x 3 then 150 x 3, add its table to section 1, and decide with real numbers.

**Migration order** (each step ships alone and leaves one instance working):
1. **Concurrency 80 → ~400 and sign-in off the event loop** (hash with `crypto.scrypt` async, which it may already be, or a worker
   thread; cap parallel hashes). *Cost: $0.* Fixes the two things that break first. Check with the sign-up storm.
2. **Pin `min-instances=1` before launch day** if cold starts are felt. *~$115/month.* Optional.
3. **Move the shared decisions into the database** while still on one instance: GPU provider cooldowns, the spent-today guard,
   the "advance this production" claim, the org-charge refund claim, one-time token nonces. Each becomes a row with a unique key
   or a `claimed_by`/`claimed_until` column, as the lease already does for the instance. *Cost: $0; this is the real work.*
4. **Make the queue claim jobs in the database** (`UPDATE jobs SET claimed_by=?, claimed_until=? WHERE id=? AND claimed_by IS NULL`),
   so two pumps can never run one job; keep the in-memory `busy`/`lanes` as a cache of what *this* instance claimed. Counted
   caps (per-project lane, per-GPU) read the database.
5. **Managed Postgres** (Cloud SQL, 1 vCPU / 3.75 GB, regional HA off to start): *about $50-70/month, ~$120 with HA.* Move
   `hawkesgen.db` first, then `analytics.db` (large, append-heavy; could instead go to BigQuery or stay SQLite on its own
   single instance, since only Gen's collect door writes it). The code is `node:sqlite` with hand-written SQL in ~100 places, so
   this is a port of queries and a data copy, not a flip. Dual-write behind a flag, compare, cut over. This also retires
   Litestream, the lease and the restore cold start.
6. **Shared events:** Postgres `LISTEN/NOTIFY` (free once step 5 is done) or Memorystore Redis pub/sub (basic 1 GB, *about $35/month*)
   carrying `job`, `library`, `production`, `scene` events between instances; each instance still holds its own streams and
   forwards what it hears. Event ids come from the database so a reconnect can resume.
7. **Shared rate limits:** the sign-in and moderate buckets in Redis (or a Postgres counter table); the rest can stay per
   instance, since over-allowing 2x on reads is harmless. Put Cloudflare's rate rules in front for the cheap bulk.
8. **Then raise `--max-instances` to 2-3** with `--min-instances=1`: *about +$115 per always-on instance, much less if the
   extra ones scale to zero between peaks.* Move the periodic timers behind a Cloud Scheduler call or a lease row so only one
   instance runs each.

**Rough monthly bill at "launch plus": ≈ $120 Postgres with HA + $35 Redis + 2 x $115 always-on = about $385/month**, against
$0-$115 today. Cheaper stop on the way: steps 1-4 alone cost nothing and double the headroom.

**What to watch to know it's time to move:** event-loop lag in `GET /v1/health` (`loop`) staying above ~500 ms in normal use;
requests waiting on concurrency slots; a restore taking longer than ~20 s (database size); `SQLITE_BUSY` in the log.

## Left for later

- The beta run's numbers (section 1) once `ops-load-beta` has been dispatched.
- A measured cold start on gen-beta (time from first request to first 200 with no instance and a populated database).
- A per-query port list for step 5.
