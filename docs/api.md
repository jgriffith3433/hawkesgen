# Hawkes Gen API

Base URL `http://127.0.0.1:8790/v1`. JSON in and out. From this PC no key is needed while `localOpen` is on;
otherwise send `Authorization: Bearer hg_...` (create keys in the dashboard's Settings, or `hawkesgen key <name>`).
Errors are `{ "error": "...", "kind": "...", "attempts": [...] }` with an HTTP status.

## Jobs

A job runs one tool. Inputs are file references: a local path (owner callers on this PC), `asset:<id>` (anything
in the library) or `blob:<sha256>` (an upload). Params are checked against the tool (unknown or out-of-range
values are rejected; missing ones get the tool's defaults).

```http
POST /v1/jobs
{ "tool": "image.edit", "project": "doseofdestruction",
  "inputs": { "images": ["C:/Projects/AllTheCharacters/Susan/front.png"] },
  "params": { "prompt": "Show this character from the side, facing right", "count": 2, "seed": 1234 },
  "labels": { "fighter": "susan" },
  "key": "susan-side-v1",
  "priority": 0 }
→ { "jobs": [ { "id": "j_…", "status": "queued", … } ] }
```

- `{ "jobs": [ … ] }` submits several at once.
- `preset`: a project's art direction, `"name"` (in the job's project) or `"project/name"`. The preset's tool is
  used when `tool` is left out, its params fill in what the job leaves out, its prompt template wraps the
  job's `prompt` (`{prompt}`, `{style}`), and the project's negative is added. The final params are kept on the
  job, so its recipe is exact.
- `key`: sending the same key again (same API key) returns the existing job instead of a new one.
- `priority`: -10…10, higher first.
- `reuse`: `true` or `{ "exclude": ["a_…"] }`: if a finished job in this project already made exactly this recipe
  (same tool version, params and inputs; any seed), that job is returned (`reused: true`) instead of a new one being
  paid for. `exclude` lists assets the caller already has, so best-of-N asks for distinct takes. `asset.make` sets it
  on every step (unless `fresh`); the MCP `hawkesgen_run` sets it unless `reuse: false`.
- `POST /v1/run` takes the same body plus `timeout` (seconds) and answers when the job ends.

| Route | |
|---|---|
| `GET /v1/jobs?project=&status=queued,running&tool=&limit=` | List (newest first) |
| `GET /v1/jobs/:id` | One job: status, detail, log, outputs, result, error, server, gpu_seconds, cost, graphs |
| `GET /v1/jobs/timing?days=7&since=<ms>&project=` | Where the time goes, per tool (seconds), biggest first: `{ since, at, tools: [{ tool, done, failed, wait, run, total, now }] }`. `wait` (queued to started) and `run` (started to finished) are `{ avg, p50, p90, max }` over the jobs that finished since then (null when none); `now` is `{ queued, running, longestWait }` |
| `POST /v1/jobs/:id/cancel` | Cancel (a running GPU job is interrupted on the server) |
| `POST /v1/jobs/:id/rerun` `{ "sameSeed": false, "params": {...}, "inputs": {...}, "labels": {...}, "priority": 5 }` | Queue it again: a new seed unless sameSeed; `params` changes values (a retake note in the prompt), `inputs` swaps inputs (`asset:`/`blob:`, e.g. an upscale of a new take), `priority` (admin) |
| `POST /v1/jobs/boost` `{ "label": "studioChange", "value": "c_...", "priority": 5, "minutes": 120 }` | (admin) Every job carrying that label runs at that priority until the boost ends: the queued ones now, later ones as they come; `priority: 0` ends it. On GPU servers a higher priority goes before a job of the family the server has loaded. Studio boosts a video's work while J waits for it |
| `GET /v1/playtests/live` | Every `playtest.run` playing or queued: `{ playing: [{ job, project, step, steps (last 6), players: [{ i, scenario, state: { status, scene, progress, fps, note, metrics }, frameAt }], problems: { count, last }, console: { errors, warnings, last }, failed, playtester, host, recorder, device, startedAt, outcome }], waiting: [...], capacity: { machines, lanes }, lanes: { used, limit } }` (`src/tools/livePlay.ts`) |
| `GET /v1/jobs/:id/live` | One playtest's live state in full (every step, the timeline of progress and fps); `live: null` once it has ended (the job's result has the rest) |
| `GET /v1/jobs/:id/live.mjpeg?player=0&fps=8` | The newest video frames of a player as `multipart/x-mixed-replace` MJPEG (1 to 15 fps, only new frames, the screencast's or else the newest screenshot); ends with the run or the viewer. `/frame` gives one JPEG |
| `GET /v1/jobs/:id/shots?since=<i>` | A `playtest.run` job's screenshots, while it plays and after: `{ running, progress, shots: [{ i, t, reason, scene, peer? }] }`. `progress` is the job's latest step (the bot's scene and progress line) to caption the frames; `since` lists only shots after that index (poll with the last `i` you have) |
| `GET /v1/jobs/:id/shots/:i` | One screenshot (JPEG, as taken: no re-encoding). From the run's scratch file while it plays (`no-cache`), from the filed library asset after (cached a day) |
| `GET /v1/jobs/:id/graphs/:name` | A ComfyUI graph the job ran (loads into ComfyUI) |
| `POST /v1/jobs/clear` `{ "project"? }` | Remove finished jobs from the list (admin) |
| `GET /v1/events` | Server-sent events: `event: job` with each job change |

A finished job has `outputs: [{ asset, seed, mime, kind, title }]` and/or `result` (text, JSON, numbers).
While `llm.text` or `llm.json` runs, its `result` is the answer so far: `{ partial: "<text written so far>", chars }`,
saved about four times a second (also in `/v1/events`), so a caller can act on it before the end (the portal's Overseer
builds the world from it line by line). The finished result replaces it. The API backend caches the system prompt.

## Tools

`GET /v1/tools` lists them with their inputs and params; `GET /v1/tools/:id` one. See the README table.

## Library

| Route | |
|---|---|
| `GET /v1/assets?project=&kind=image&tool=&q=&starred=1&job=&playtest=1&limit=&offset=` | Browse (`{ items, total }`). Excludes `playtest.run` recordings, screenshots and reports by default (unless `playtest=1`, `tool=playtest.run` or `job=` is passed); `playtest=1` returns only playtest outputs. A text search also returns CC0 motion clips (`motion:<pack>/<name>`, tags, duration, loop); `tool=motion.library` is the whole list. |
| `GET /v1/assets/:id` | One asset: path, mime, bytes, seed, recipe, labels, tags, title, and `lods` (its levels of detail, below). List rows carry `lods` too; a model's low copy that its job made beside it (`model.lod1`) isn't listed: it belongs to the model |
| `PATCH /v1/assets/:id` `{ "title", "tags", "starred", "labels" }` | Organize |
| `DELETE /v1/assets/:id` | Delete (admin) |
| `GET /v1/files/:id[?download=1&lod=<n>&v=<hash>]` (= `/v1/assets/:id/file`) | The file (supports Range, so videos stream). `ETag` is its sha256; `If-None-Match` answers 304. `lod=n`: a level of detail, the largest level at most n (px for images, triangles for models), else the smallest; the original when n is at least its size and bigger than every level (`X-Lod-Level` says which). With `v` = the file's hash prefix: `Cache-Control: public, max-age=31536000, immutable` |
| `POST /v1/blobs` (body = file bytes, header `X-Filename`) | Upload an input → `{ "blob": "blob:<sha256>" }` |
| `POST /v1/estimate` `{ project, items: [{ tool \| preset, params, count, label }], servers? }` | What a batch would cost before running it: GPU seconds per line (the median of past jobs of that tool, scaled by frames and pixels, else the tool's guess), model loads per family, server boots, API costs, `cost: { gpu, api, idleTail, total, withIdleTail }`, `wallMinutes`, `note`. `asset.make` items expand into their steps × `candidates` plus a pick. `src/estimate.ts` |
| `POST /v1/recipes/check` `{ tool, params, inputs, project }` | `{ status: "current" \| "missing", asset }`: is there an asset from exactly this tool version, params and inputs (any seed)? |

## Entities, slots and versions (docs/library.md)

| Route | What |
|---|---|
| `GET /v1/entities?project&kind&q&tag&archived&limit&offset` | Entities, each with its slots' current version and counts |
| `POST /v1/entities` | `{ project, name, kind, slug?, data?, tags?, upsert? }` |
| `GET` / `PATCH /v1/entities/:project/:slug` | One entity and its slots; change name, kind, data (merged), tags, archived |
| `GET /v1/entities/:id/slots/:slot` | The slot's versions, newest first (`?discarded=0` hides discarded) |
| `POST /v1/entities/:id/slots/:slot/versions` | `{ file: blob:<sha> \| asset:<id>, status?, note?, title? }` |
| `POST /v1/entities/:id/slots/:slot/make` | `{ make?, feedback?, count?, params?, note?, reuse? }`: the job; its outputs land in the slot as takes |
| `POST /v1/entities/:id/slots/:slot/revise` | `{ feedback, version?, count?, references? }`: the job |
| `PATCH /v1/versions/:id` | `{ status: current \| take \| old \| discarded, note? }` |

Job inputs and chain steps take `slot:<project>/<slug>/<slot>[@n|@latest]` and, in an entity's own recipes, `slot:./<slot>`.
`GET /v1/events` also streams `library` events.

## Levels of detail (src/lod.ts)

Every image (PNG, JPEG, WebP) and GLB that a top-level job makes or someone uploads gets levels of detail, made by Gen
itself (`asset.lod`: CPU, its own lane `lod`, one at a time, behind every customer's CPU job, lowest priority, as client
`gen` in project `hawkesgen.lod`; never charged, internal-only). Images: 128, 256, 512, 1024, 2048 px below the long
side and the full size, WebP (shape and transparency kept; pixel art nearest-neighbour and lossless). Models: `low`
(~12% of the triangles, at most 10,000; textures an eighth of the model's, 128-256 px), `mid` (~40%, at most 50,000; <= 1024 px) when it pays,
`high` (every triangle, textures <= 2048) for models with bigger textures; Draco in, Draco out, else quantized.

The summary (`lods`): `{ kind: image | mesh, state: queued | done | skipped | failed, size: [w, h] | tris, tex, bytes,
sha, levels: [{ level, bytes, w, h | tris, tex, role, sha }] }`, smallest first (`level`: px or triangles).

| Route | What |
|---|---|
| `GET /v1/lods?ids=a_1,a_2,...` (up to 500) | `{ lods: { id: summary }, queued }`: many at once (a game's bundle). Assets without levels yet are queued |
| `GET /v1/lods/status` | Assets by state, levels made and their bytes, linked low copies, `asset.lod` jobs |
| `POST /v1/lods/backfill` `{ project?, kind?: image \| mesh, limit?, dryRun? }` | (admin) Links low copies older jobs made, then queues everything kept without levels at this version, newest first. Kept: uploads, top-level jobs' outputs, and of an `asset.make` chain only its first step's picture (not a mask) and its last step's result; the in-between (view sheets, views, masks, raw meshes) and pipeline steps get none. CLI: `hawkesgen lod backfill [--project p] [--kind k]` |
| (setting) `lod.projects` | The projects whose assets get levels automatically (globs; default `usr_*`, `ubeta_*`: hawkesgen.com's customers and starter library, the beta portal's). Others only when asked for by id (`GET /v1/lods`) |
| `POST /v1/lods/prune` `{ project?, limit?, dryRun? }` | (admin) Clears levels made for in-between work: their files and their S3 copies (unless the same content is still used). Their state becomes `pruned`; asked for by id later (`GET /v1/lods`), they're made again. CLI: `hawkesgen lod prune [--project p] [--dry-run]` |

## Library storage (S3)

| Route | What |
|---|---|
| `GET /v1/storage` | The bucket, how many library files are backed up (and bytes), uploads in flight (`queued` = `queueLength` waiting + `uploading`), failures |
| `POST /v1/storage/backfill` | (admin) Queue every file not backed up yet |
| `POST /v1/storage/metadata` | (admin) `{apply?, limit?, after?}` One batch: objects without the right Content-Type/Cache-Control are counted (dry run) or fixed with CopyObject onto itself; `next` is the cursor. CLI: `hawkesgen storage metadata [--apply]` |
| `POST /v1/storage/restore` | (admin) Bring back every library file missing on this disk |

Objects carry the asset's Content-Type (HTML and SVG go as `application/octet-stream`) and `Cache-Control: public, max-age=31536000, immutable`. Asset answers and LOD summaries (and each level) carry `inS3`: true when a CDN link to `sha256/<hash>` will work.

## CDN

`cdn.hawkesgen.com` serves the library's S3 files (`https://cdn.hawkesgen.com/sha256/<hash>`) through CloudFront. Made by
`node deploy/cdn.mjs` (idempotent; **dry run by default**, `--apply` to create; J runs it, an agent never does). It uses Gen's
AWS config and never prints keys. Options: `--domain`, `--zone`, `--bucket`, `--alarm-usd` (default 20).

What it sets up, each step skipped when it already exists:
- an ACM certificate in us-east-1 (DNS-validated through Route 53; if it isn't issued yet, run `--apply` again in a few minutes)
- an Origin Access Control, so the bucket stays private; the bucket policy lets only this distribution read `sha256/*` (other statements are kept)
- a cache policy keyed on the path only (no cookies, headers or query strings; one-year TTLs, because files are content-addressed) with compression
- a response headers policy: `Access-Control-Allow-Origin: *` (sandboxed games have origin null), `Timing-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` (a file can never act as a page)
- the distribution (PriceClass_100: US, Canada, Europe edges; pay-as-you-go, not a flat-rate plan) and the Route 53 A/AAAA alias
- a CloudWatch alarm `hawkesgen-cdn-cloudfront-charges` on CloudFront's month-to-date charges (needs "Receive Billing Alerts" on in the account; add an SNS topic in CloudWatch to be emailed)
- `settings.storage.cdn` = `https://cdn.hawkesgen.com` (saved in the checkout it runs in; on the cloud server `POST /v1/settings` with `{"storage":{"bucket":"...","cdn":"https://cdn.hawkesgen.com"}}`; `storage` is replaced as a whole, so send the bucket too)

Cost: no monthly fee. The free tier covers 1 TB out and 10M requests a month; after that about $0.085/GB and $0.01 per 10,000 HTTPS
requests in the US. S3 to CloudFront transfer is free. No WAF (Shield Standard is on). The script prints this at the end of every run.

**`cdn` links in answers:** when `settings.storage.cdn` is set, asset answers (`GET /v1/assets/:id`), library list rows, LOD summaries
(the original and each level) and `GET /v1/lods` carry `cdn`: `<storage.cdn>/sha256/<hash>`, only for files whose S3 copy exists
(`inS3`); otherwise the field is left out and callers keep `GET /v1/assets/:id/file`, which is unchanged. The bucket stays private but
**a hash link is public to anyone who has it**: hand them out only for things the caller shows publicly (published games,
community things, templates, shares).

On when `settings.storage.bucket` (or `HAWKESGEN_LIBRARY_BUCKET`) is set: each new file is uploaded by content in the
background, and a missing file comes back from S3 when a job or a download needs it. CLI: `hawkesgen storage
[status|backfill|restore]`.

## Presets

| Route | |
|---|---|
| `GET /v1/presets` | Every project's presets |
| `GET /v1/presets/:project` | One project's style line and named presets (`presets/<project>.json`) |
| `PUT /v1/presets/:project` | Replace them (admin) |

## Workflows (ComfyUI as tools)

| Route | |
|---|---|
| `GET /v1/workflows` | Installed workflow tools (manifests) |
| `GET /v1/workflows/:id` | Manifest, graph, and a check against the server's node definitions |
| `PUT /v1/workflows/:id` `{ manifest }` | Save an edited manifest (owner) |
| `DELETE /v1/workflows/:id` `{ confirm: true }` | Remove the tool's folder (owner) |
| `POST /v1/workflows/import` `{ id, template \| workflow, title?, description?, family?, overwrite? }` | Convert a template or an uploaded ComfyUI workflow into a tool (owner) |
| `POST /v1/workflows/reload` | Re-read `workflows/` (admin) |
| `GET /v1/comfy/templates?q=` | ComfyUI's open-source template library (cached) with what's installed |
| `GET /v1/comfy/templates/:name` | A dry run of the import: problems, models, the draft manifest |
| `GET /v1/comfy/templates/:name/thumb` | The template's thumbnail |
| `POST /v1/comfy/refresh` | Re-read node definitions and the template index from a ready server (admin) |

## GPU fleet

| Route | |
|---|---|
| `GET /v1/fleet` | Servers (state, boot stage, price, flavor), settings, retry, last failure, account, which job each server runs and which models it has loaded, and `autoStart` (`auto`, `autoLaunch`, `last`: the last round's servers started or failed and its note, `backoff`: servers left alone after a failed start, with their `misses` in a row; `nextTry`: when a stopped server is tried again; `expectedWait`: about how many seconds until a server takes jobs, boot included, or null), and `disks` (each running server's last measured disk use: `{ pct, free }`) |
| `POST /v1/fleet/settings` `{ servers, auto, autoLaunch, idleMinutes }` | admin. `auto` (on): queued GPU jobs start stopped US servers; `autoLaunch` (off): also launch from the image |
| `POST /v1/fleet/start` `{ id?, confirm: true, keepTrying?: { minutes, every } }` | owner; costs money |
| `POST /v1/fleet/launch` `{ confirm: true, type?: "auto"\|"g6e.xlarge"…, region?: "auto"\|…, keepTrying? }` | owner; a new server |
| `POST /v1/fleet/stop` `{ id? }`, `/stop-all`, `/access`, `/retry-stop` | admin |
| `POST /v1/fleet/terminate` `{ id, confirm: true }` | owner; deletes the server and its disk |
| `POST /v1/fleet/scale` `{ count, confirm: true }` | owner; start stopped servers until `count` run |
| `POST /v1/fleet/sync` `{ id?, families?, confirm: true }` | owner; download missing models/nodes from `server/models.json` |
| `POST /v1/fleet/fix` `{ id?, confirm: true }` | owner; ComfyUI back on the flags that work |
| `POST /v1/fleet/adopt` `{ from: "<dir>", confirm: true }` | owner; take over servers another project launched (tokens + keys) |
| `GET /v1/fleet/health?id=`, `/log?id=&lines=`, `/regions?refresh=1`, `/capacity` | Over SSH / AWS, read-only |
| `GET /v1/fleet/quota?region=` | A region's GPU quota (vCPUs, "Running On-Demand G and VT instances") and its last increase requests; `open` while one is PENDING or CASE_OPENED |
| `POST /v1/fleet/quota` `{ region, value }` | owner; ask AWS to raise that quota to `value` vCPUs (free, launches nothing). Refused when `value` isn't above the current quota or a request is still open. Dashboard: GPU fleet → Regions and GPU quota → Request more; MCP: `hawkesgen_fleet` `request-quota` |
| `GET /v1/fleet/models?id=&refresh=1` | A server's model files, sizes, free disk, and which tools use each |
| `POST /v1/fleet/models/install` `{ id, tool, confirm: true }` | owner; install a workflow tool's models ahead of time |
| `POST /v1/fleet/models/prune` `{ id, files, confirm: true }` | owner; remove model files (never core ones) |

## Machines (monitor)

The GPU servers, the build server and the playtester (`src/machines.ts`, the dashboard's Machines tab). EC2 Describe
for what exists; one SSH command per running machine for the numbers. Nothing is started to measure it, and no
CloudWatch. Running machines are measured every 60 s (kept 7 days); `live=1` measures again if the last reading is
over 15 s old.

| Route | |
|---|---|
| `GET /v1/machines?live=1` | `{ alerts: [{ level: bad\|warn, machine, text }], machines: [{ id, kind: gpu\|builder\|playtester, name, state, region, type, pricePerHour, launched, jobs, idle: { minutes, busy, stopsAt, action }, metrics: { cpu, memUsed, memTotal, gpu, vramUsed, vramTotal, temp, diskSize, diskUsed, diskFree, netIn, netOut, uptime, stage, service }, error }] }`. Alerts: not answering, ComfyUI or the browser server down, disk over 90%, idle 30+ min, GPU at 85°C, memory over 95% |
| `GET /v1/machines/history?hours=1&points=120&id=` | Per machine, averaged buckets: `{ machines: { <id>: [{ at, cpu, mem, gpu, vram, temp, disk (percents), netIn, netOut (bytes/s) }] } }`; up to 168 hours |

## Unity build server

| Route | |
|---|---|
| `GET /v1/builder` | The server: state, setup stage (`setup`, `unity`, `license`, `ready`), price, Remote Desktop file |
| `POST /v1/builder/launch` `{ confirm: true, type?, region?, idleMinutes?, unity? }` | owner; creates it (Windows + Unity with WebGL; about 10 min of setup) |
| `POST /v1/builder/start` / `stop` / `terminate` `{ confirm: true }` | owner for start and terminate (terminate deletes every project's Library) |
| `POST /v1/builder/access` | Lets this PC's IP in (SSH and Remote Desktop) |
| `POST /v1/builder/rdp` | owner; writes the Remote Desktop file (the password stays in a file, never in the response) |
| `GET /v1/builder/rdp-file` | owner; the `.rdp` as a download (`Content-Disposition: attachment`) for the server's current public IP, user `Administrator` prefilled. Lets the caller's IP in on 22 and 3389 first (the last `X-Forwarded-For` entry behind Caddy; this machine's IP when called locally). Starts nothing: a server that isn't running answers 409 `{ ready: false, state }` and the UI offers Start |
| `POST /v1/builder/password` | owner; `{ user, password }`, on demand only (shown/copied in the UI, never logged) |
| `GET /v1/fleet/connect?id=` | owner; a GPU server's ssh command `{ ready, ip, user, keyFile, command }` after letting the caller's IP in. GPU servers are Linux: SSH only, no Remote Desktop |
| `POST /v1/builder/idle` `{ minutes }` | How long it waits idle before powering off |
| `POST /v1/builder/ssh` `{ command, confirm: true }` | owner; runs PowerShell on it |

`POST /v1/builder/start` and `access` also let the caller's IP in (not only this machine's). The dashboard's Unity build server card and Machines tab have **Remote Desktop** (downloads the file, or offers Start if the server is stopped) and **Show password** (copy); GPU server cards have **Copy ssh command**.

Builds are jobs: `unity.build` with `{ project, site, method }`.

The Unity log line `Licensing::Module Error: Access token is unavailable` is benign: successful builds log it too. It used to be reported as a license failure; `finishBuild` in `builder.ts` now blames the license only for hard license errors and otherwise reports the real last error.

## Analytics (docs/analytics.md)

| Route | What |
|---|---|
| `POST /v1/analytics/collect` | **Public, no key.** A batch of player events (JSON, also as `text/plain` for `sendBeacon`), from the product's registered origins only (`analytics/products.json`). 64 KB, 200 events, a per-IP rate limit; `202 { accepted, dropped }`, never a 5xx |
| `GET /sdk/analytics.js`, `/sdk/analytics@1.js` | **Public, no key.** The JS SDK (`clients/js/hawkes-analytics.js`). `@1` is what pages pin (cached an hour), the plain name 5 minutes; both revalidate by `ETag` (`304`) |
| `GET /v1/analytics/products` | The registry |
| `GET /v1/analytics/overview` | Every product: active now, visitors and sessions today / 7d / 30d with trends, a daily series, new vs returning, active time, D1/D7, the biggest drop-off, error rate, rating |
| `GET /v1/analytics/players`, `GET`/`POST /v1/analytics/marks` | Admin. Who visits across products (by network hash, never the IP), bots by reason, and J's marks (`{kind: net\|anon, value, what: me\|bot, on}`): marked sessions are internal (me) or bots (bot), past and future. Reads also take `engaged=1` |
| `GET /v1/analytics/:product[/:section]` | `traffic`, `sessions`, `retention`, `funnel?steps=`, `dropoff`, `levels`, `deaths`, `features`, `feedback`, `errors`, `perf`, `builds?a=&b=`, `insights`, `export?what=&format=csv`; `sessions/list`, `sessions/:id` (a timeline). Without a section: all of them |

Filters on every read: `range` (`30d`) or `from`/`to`, `env` (`live`; `all`), `build`, `device`, `browser`, `country`,
`bots=1`, `internal=1`.

## Hawkes Net (the hawkesnet repo)

Hawkes Net is its own service and repo (`jgriffith3433/hawkesnet`, its `docs/net.md`); Gen answers only `/v1/net/whoami` and `/v1/net/usage` and sends the rest to `https://net.hawkesgen.com` with a 308. The routes below are the box's.

| Route | What |
|---|---|
| `POST /v1/net/ticket` | A join ticket: `{ project, room, name?, sub?, role?, transport: 'auto' \| 'p2p' \| 'relay', config?, client: { sdk, protocols: [3] } }` -> `{ ticket, peer, ord, config, relayUrl, signalUrl, transports, ice, expiresAt, node, epoch }`. With a Gen key (any role; the key's projects, or a key project the registry lists in `keyProjects`), or **no key from one of the project's own sites** (`net/projects.json` origins, plus localhost; players only; limited per address and per project). `403` site or key not allowed, `429` the project's rooms or players at their limit, `503` no node up |
| `GET /v1/net/ws` (WebSocket) | The node inside Gen. `?t=<ticket>&want=auto\|p2p\|relay` or `?r=<resume>`; subprotocol `hawkes-net.v3`. Closes with `4009` when the room is full |
| `GET /v1/net/keys` | **Public.** The public keys nodes check tickets with |
| `GET /v1/net/status`, `/v1/net/nodes` | **Public.** Nodes (up, players, capacity, load) and totals; rooms per project and transport only with a key |
| `POST /v1/net/publish` | A server's world edits or event into a room: `{ project, room \| 'prefix/*', ops?, event?: { name, data }, by?, fx?, except? }` -> `{ delivered, rooms? }`; or `kick: { sub? }` puts out everyone (or those who joined as `sub`) -> `{ kicked }` |
| `POST /v1/net/room` | `{ project, room }` -> `{ open, players, transport, limit }` |
| `POST /v1/net/nodes/heartbeat`, `/v1/net/nodes/room`, `/v1/net/usage` | Relay nodes reporting in (a key for the project `hawkesnet`, or an admin key) |
| `POST /v1/net/keys/rotate` | Owner: a new signing key (the old one works a day more) |
| `GET /sdk/hawkes-net.mjs`, `/sdk/hawkes-net-core.mjs` (also `/sdk/net@1.mjs`) | **Public.** The client SDK |

## Other

| Route | |
|---|---|
| `GET /v1/health` | No key needed: version, which providers are set up, queue counts |
| `GET /v1/me` | Who you are (client, role, projects) |
| `GET /v1/usage?since=<ms>&by=project\|client\|provider\|day` | Usage and cost |
| `GET /v1/providers/elevenlabs/voices` | The ElevenLabs voice library |
| `GET /v1/audio/models` | The open audio models: license, size, VRAM, capabilities, whether each is verified for `provider: auto`; the refused (non-commercial) ones; the loudness targets (docs/audio.md) |
| `GET /v1/providers/anthropic/models` | Claude models the tools accept |
| `GET/POST /v1/settings` | Service settings (owner to change) |
| `GET/POST /v1/clients`, `POST /v1/clients/:id/disable\|enable` | API keys (owner). Roles: owner, admin, user; `projects` limits which projects a key sees |
