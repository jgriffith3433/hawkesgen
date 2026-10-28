# The control server on Google Cloud

Hawkes Studio and Hawkes Gen run on one AWS EC2 box today (m7i.2xlarge, us-east-1, Elastic IP 52.0.19.230;
hawkesstudio `docs/cloud.md`). This is the plan and the tooling to move that box, as it is, to a Compute Engine VM in
`hawkes-prod` (us-east4-c), next to the portal's and Hawkes Net's VMs. It is a lift-and-shift: the same Ubuntu, units,
Caddy, folders, users and sandbox; only the machine, the secrets store and how AWS is reached change. The cut-over has
about an hour of downtime, and a rollback is a DNS change plus starting the AWS services again.

The scripts are in `deploy/gcp/` (they find `C:\Projects` from wherever they sit, so they can move to hawkesstudio's
`deploy/gcp/` unchanged). Every one prints its plan and changes nothing without `--apply`. J runs the `--apply` steps:
IAM, DNS and secret writes are blocked for the assistant by policy.

| Script | What it does |
|---|---|
| `deploy/gcp/provision.mjs` | The VM, its service account and roles, the static IP, the firewall (first boot: `deploy/gcp/cloud-init.sh`) |
| `deploy/gcp/aws-federation.mjs` | The AWS role `hawkes/hawkes-control-gce` that trusts the VM's service account (no AWS keys on the VM) |
| `deploy/gcp/secrets.mjs` | AWS Secrets Manager (`hawkes/*`) and `/etc/hawkes/keys.env` into Google Secret Manager (`hawkes-control-*`) |
| `deploy/gcp/move.mjs` | `refs`, `prepare`, `check`, `switch`, `rollback`, `cleanup`: the runbook as phases |
| `deploy/gcp/gen-patches/fleet-awsconfig-gce.patch` | Gen: `awsConfig()` uses the federated role on GCE; `myIp()` takes `HAWKES_PUBLIC_IP` |
| `deploy/gcp/studio-patches/aws-gce.patch` | Studio: `src/gceaws.ts` (a copy of Gen's), `src/aws.ts` and the S3 presigner use it |

Already in Gen (this branch): `src/providers/gceaws.ts` (+ `test/gceaws.test.ts`), `bin/fetch-secrets.mjs` reading
Google Secret Manager when `HAWKES_SECRETS_BACKEND=gcp`, and `HAWKESGEN_SMOKE=1` (the API without the queue or any
background task, for the dry run beside the live box).

## What moves, what stays on AWS

| | Today | After the move | Why |
|---|---|---|---|
| Studio, Gen, Caddy, Talk, agents, dev servers, On Air encoder | EC2 m7i.2xlarge | GCE e2-standard-4 | the lift-and-shift |
| Their data (`.data`, reports, homes, beta sites, certificates) | EBS 400 GB | pd-balanced 200 GB | copied with rsync |
| Repos and worktrees | `/srv/hawkes` | fresh clones from GitHub on the same branches | `.work` holds worktrees of the old clones |
| API keys, GitHub token, Claude/Twitch/Cursor/Copilot/Gemini/Antigravity | Secrets Manager `hawkes/*` | Secret Manager `hawkes-control-*` | read by `hawkes-secrets` with the VM's service account |
| `/etc/hawkes/keys.env` | a file | the same file, plus a backup in `hawkes-control-keys-env` | deploy scripts append to it over SSH |
| AWS access | instance role `hawkes/hawkes-control` | role `hawkes/hawkes-control-gce`, web identity from the VM | no keys anywhere |
| GPU fleet, Windows build server, playtesters | AWS | **stay on AWS** | another workstream moves GPU and Unity work to Cloud Run; until then Gen drives EC2 as before |
| Gen's library bucket, playtest videos (S3), cdn.hawkesgen.com (CloudFront) | AWS | **stay on AWS** | the storage move to GCS is its own work; the VM's role keeps `s3:*` on `hawkes-*` |
| Email (SES), Cost Explorer, Route 53 | AWS | **stay on AWS** | through the federated role (SES, CE); DNS through `hawkesgenwebsite/cloud/dns.py` |
| Hawkes Net, the portal | their own VMs / Firebase | unchanged | they reach `gen.hawkesgen.com` by name |

us-east4 (Ashburn) is next to us-east-1 (northern Virginia): a millisecond or two to the fleet, the build server and S3.

## The VM

**e2-standard-4: 4 vCPU, 16 GB, about $110 a month** (us-east4 on-demand; E2 has no sustained-use discount).

Measured on the AWS box: about 4 GB of its 32 GB in use and 20% of 8 vCPUs (about 1.6 vCPUs) on average, with peaks
when agents, Talk, dev servers, a pull-deploy's typecheck and tests, and the On Air encoder overlap. On 4 vCPUs the
average is about 40%, and 16 GB leaves room for those peaks (two agents' Claude Code, two Vite dev servers at 0.3-0.6 GB
each, `tsc` at about 1.5 GB, Xvfb + Chromium + x264 while streaming) plus 4 GB of swap. Two vCPUs would starve the
encoder while a deploy runs its tests; eight are what we pay for today and don't use.

The alternative is **n2-standard-4** (same size, dedicated Cascade Lake/Ice Lake cores, about $160 on-demand, about
$128 after the full-month sustained-use discount). Choose it if the encoder drops frames or CPU steal shows on E2 while
agents work. Changing is a stop, `gcloud compute instances set-machine-type`, a start: about two minutes. A one-year
commitment would take E2 to roughly $70 once the size has settled (J's call, later).

- **Disk:** 200 GB pd-balanced, about $22 a month: `.data` is about 90 GB today, of which about 80 GB is Gen's library
  cache (it shrinks once the library lives in GCS: files missing on disk come back from the bucket on demand), plus
  about 40 GB of repos and worktrees, plus the system, node_modules, Playwright and the venv. The disk is kept when the
  VM is deleted (`--no-boot-disk-auto-delete`). Growing it later is online: `gcloud compute disks resize`, then
  `growpart` and `resize2fs`.
- **Static IP** `hawkes-control` (premium tier), about $3.65 a month: DNS points at it, and Gen lets it into the fleet,
  build server and playtester security groups (`HAWKES_PUBLIC_IP` in the units, so Gen doesn't need to look it up).
- **Firewall:** 80 and 443 from anywhere (Caddy); 22 from J (99.57.156.100) and the other VMs in us-east4-c (the
  portal's and Hawkes Net's: `provision.mjs` looks them up). The move adds one rule on the AWS side for its copy (below).
- **Service account** `hawkes-control@hawkes-prod.iam.gserviceaccount.com`, least privilege:
  - Secret Manager accessor **per secret** (only `hawkes-control-*`, granted by `secrets.mjs`; nothing project-wide)
  - `roles/storage.objectAdmin` + `roles/storage.legacyBucketReader` on Gen's GCS buckets only (`--bucket <name>`, once
    the storage move names them)
  - `roles/run.invoker`, `roles/run.jobsExecutorWithOverrides`, `roles/run.viewer` (Gen's Cloud Run GPU and Unity backends)
  - `roles/logging.logWriter`, `roles/monitoring.metricWriter`
  - the VM gets the `cloud-platform` scope; the roles above are the real limit
- **First boot** (`deploy/gcp/cloud-init.sh`): today's packages (Node 24, Caddy, git and LFS, ffmpeg, the Python venv's
  needs, sqlite3, rsync, Xvfb, fonts, Chromium for On Air), the users `hawkes` and `hawkes-agent` (group
  `hawkes-work`; never in group `hawkes`), 4 GB swap, unattended upgrades, and `hawkes-agent-gce-firewall`: iptables
  owner rules so `hawkes-agent` can't reach the metadata server (169.254.169.254, which on Google hands out the service
  account's tokens and identity) or its IPv6 address fd20:ce::254, exactly like today's IMDS rule. The move then runs
  the same `agent-sandbox.mjs` setup as on AWS, so its `hawkes-agent-firewall` rule is there too.
- **SSH:** the AWS box's key (`hawkesstudio/deploy/.keys/control_ed25519`) for `ubuntu` (project keys and OS Login off
  for this VM), so `deploy.mjs`, `agent-sandbox.mjs`, `local-deploy.mjs` and `auto-ssh.bat` work against it once
  `hawkesstudio/deploy/.state.json` points at it (`move.mjs switch` does that and keeps the AWS one as `.state.aws.json`).

## Keyless AWS (the federation)

```
GCE VM (service account hawkes-control, unique id N)
  └─ metadata server: identity?audience=hawkes-control-aws  ->  Google-signed ID token (1 hour)
       aud = hawkes-control-aws, azp = N, sub = N, iss = https://accounts.google.com
  └─ POST sts.us-east-1.amazonaws.com AssumeRoleWithWebIdentity (unsigned; the token is the proof)
       RoleArn = arn:aws:iam::028793236279:role/hawkes/hawkes-control-gce, DurationSeconds 3600
  <- temporary credentials (1 hour), cached in the process, renewed 10 minutes before they expire
```

- **Trust policy** (`aws-federation.mjs` prints it): principal `{ "Federated": "accounts.google.com" }` (built into
  AWS: no OIDC provider to create), action `sts:AssumeRoleWithWebIdentity`, and `StringEquals` on
  `accounts.google.com:aud` = N (AWS puts Google's `azp` there), `accounts.google.com:sub` = N and
  `accounts.google.com:oaud` = `hawkes-control-aws` (the audience asked for). Only this service account's tokens, and
  only ones minted for this purpose, are accepted.
- **Permissions:** the same as today's `hawkes/hawkes-control`: its inline policies `hawkes-control` (EC2, Service
  Quotas, `sts:GetCallerIdentity`, Secrets Manager `hawkes/*`, S3 `hawkes-*`, CloudWatch Logs, Cost Explorer) and
  `hawkes-mail` (SES from `*@hawkesgen.com`), copied live from the old role by `--apply` (`--live` shows them).
  Secrets Manager can be dropped once nothing reads `hawkes/*` there any more.
- **Gen:** `src/providers/gceaws.ts` fetches the token from the metadata server and calls STS with plain `fetch`; the
  provider is shared by every AWS client in the process (one STS call an hour). With the fleet patch,
  `awsConfig()` returns `{ region, credentials: gceAwsCredentials }` when `HAWKES_AWS_FEDERATION=gce`. Every AWS client
  in Gen goes through `awsConfig()` (fleet, image builder, build server, playtesters, storage, playtest uploads,
  `deploy/cdn.mjs`), so nothing else changes. `HAWKES_AWS_ROLE=1` stays set, so `refreshAccess()` and
  `builderAccess()` still run at start and let the VM's static IP in.
- **Studio:** the same file as `src/gceaws.ts`; `src/aws.ts` (Cost Explorer, EC2 Describe, SES) and the playtest
  presigner use it when `HAWKES_AWS_FEDERATION=gce`.
- **The units:** `move.mjs` adds `/etc/systemd/system/hawkes-{gen,studio}.service.d/gcp.conf` with
  `HAWKES_AWS_FEDERATION=gce`, `HAWKES_AWS_ROLE_ARN`, `HAWKES_AWS_AUDIENCE`, `HAWKES_PUBLIC_IP`, and
  `hawkes-secrets.service.d/gcp.conf` with `HAWKES_SECRETS_BACKEND=gcp`. Drop-ins survive `deploy.mjs` rewriting the
  units, so the existing deploy tooling keeps working.
- **Who can get credentials:** anything running as `hawkes` (Studio, Gen, dev servers) can reach the metadata server,
  as any process could reach IMDS on AWS (the same caveat as today, docs/cloud.md "Developing on beta"). The agent
  sandbox user can't (both firewall units; `move.mjs check` tests it).

## Secrets on Google

`secrets.mjs` copies `hawkes/gen`, `github`, `claude`, `twitch`, `cursor`, `copilot`, `gemini`, `antigravity` (the ones
that exist) from AWS Secrets Manager with the claw keys in `hawkesgen/.env` (or `--from server`: the files the AWS box's
`hawkes-secrets` wrote in `/run/hawkes`), and `/etc/hawkes/keys.env` from the box over SSH, into
`hawkes-control-<name>` (JSON, replicated in us-east4 only). Values stay in memory and go to gcloud on stdin; the plan
shows names and key names only. Each secret is readable by the VM's service account alone.

On the VM, `hawkes-secrets` runs the same `fetch-secrets.mjs` lines as on AWS; with `HAWKES_SECRETS_BACKEND=gcp` it
gets a token from the metadata server and reads `projects/hawkes-prod/secrets/hawkes-control-<name>/versions/latest`
(404 with `--optional` is skipped, as today). Changing a key afterwards: `node deploy/gcp/secrets.mjs --apply --replace`
after updating AWS, or `gcloud secrets versions add hawkes-control-gen --data-file=-` with the JSON on stdin; then
Settings → Restart services (or `sudo systemctl restart hawkes-secrets hawkes-gen hawkes-studio`). The `deploy/*-key.mjs`
helpers still write to AWS; until they learn Google, store there and run `secrets.mjs --apply --replace`.

## The runbook

### Before (no downtime)

1. **The code.** Merge Gen's part (this branch, plus `git apply deploy/gcp/gen-patches/fleet-awsconfig-gce.patch` once
   the storage/GPU work on `fleet.ts` has landed) and Studio's (`git apply` of
   `deploy/gcp/studio-patches/aws-gce.patch` in hawkesstudio) into main. On the AWS box they change nothing:
   federation, the Google secrets backend and smoke mode are all off unless their variables are set.
2. **The VM:** `provision.mjs --apply` (add `--bucket <name>` per GCS bucket when they exist). First boot takes about
   five minutes.
3. **The AWS role:** `aws-federation.mjs --apply`.
4. **The secrets:** `secrets.mjs --apply`.
5. **What names the old address:** `move.mjs refs` (below).
6. **The copy:** `move.mjs prepare --apply` (an hour or more the first time; again any time to refresh, rsync sends only
   the difference). In order:
   1. A copy key made on the VM, allowed into the AWS box's `ubuntu` only from the VM's address with no forwarding or
      pty, and 22/tcp from the VM's IP in the AWS box's security group `sg-0aaed8dd41cf3abdf`.
   2. On AWS: the inventory (every repo with its remote and branch; everything in `/srv/hawkes` that isn't a repo), each
      repo's ignored-but-kept files (reports, local env files; not node_modules, venvs, builds or Unity's Library),
      the list of Gen's library files already in S3 (`assets` joined with `backups`), and `sqlite3 .backup` snapshots
      of every database (they're live).
   3. Config from AWS: `/etc/hawkes`, the `hawkes-*` units and drop-ins, Caddy's file and drop-in, Caddy's data
      (**the certificates**, so HTTPS works the moment DNS moves), the sandbox's wrapper and sudoers, `/etc/gitconfig`,
      the credential helper, `agy`, `/var/lib/hawkes` (the pull-deploy's state), and once the GitHub token from AWS's
      `/run/hawkes/github.env` (the private repos are cloned before Gen's `fetch-secrets.mjs` exists on the VM).
   4. The Google drop-ins and smoke mode (`HAWKESGEN_SMOKE=1`, `STUDIO_SMOKE=1`).
   5. **Fresh clones** from GitHub of every repo on the branch AWS has it on (Gen and Studio on main; product repos on
      beta; Unity website repos on main), LFS files pulled. `.work` is not copied: agent worktrees and the beta working
      copies are made again by Studio; only `.work/apps` (the portal's beta app data) and `.work/beta` (Unity beta
      website copies) come across.
   6. The data: `/home/hawkes` and `/srv/hawkes-agent` (Claude Code logins and sessions, so Talk and agents resume;
      CLI logins), the non-repo folders (story docs, shared art, `AGENTS.md`), `previews/`, `.talk/`, ignored files
      per repo, Studio's `.data`, Gen's `.data` without its library, then **Gen's library last and only the files not
      in S3**, then the database snapshots in place (old `-wal`/`-shm` removed first).
   7. `hawkes-secrets` from Google Secret Manager; packages (Claude Code, Copilot and Gemini CLIs, `npm ci`, Playwright
      Chromium and its system libraries, the venv); the agent sandbox (`agent-sandbox.mjs`'s own script).
   8. Gen and Studio started in smoke mode and Caddy with the copied certificates; nothing else is enabled (no
      pull-deploy, no daily timer, no encoder), so the copy can't touch the fleet, GitHub or Twitch.
   9. `move.mjs check`: secrets read from Google, the AWS role assumed with the VM's identity, the sandbox kept off the
      metadata server and `keys.env`, Gen and Studio health, the federation code present in the clones, HTTPS for every
      host through Caddy on the VM.

   To look at the copy in a browser before the switch, point the names at the VM in J's hosts file
   (`<new ip> studio.hawkesgen.com gen.hawkesgen.com`); it's a smoke copy, so nothing runs there.

### The switch (about an hour of downtime)

In Studio first: pause the PM (Roadmap tab), let agents, Talk answers, Gen jobs and Unity builds finish, and don't go
live meanwhile. Then `move.mjs switch --apply`:

1. AWS must be idle (Studio's critical sections, agents, Talk, detached units, Gen's running jobs); `--force` overrides.
2. **Downtime starts:** on AWS, Studio, Gen, the pull-deploy, the daily timer and the encoder are stopped **and
   disabled** (a reboot must not bring a second Gen up against the same GPU servers). Caddy stays up and answers 502.
   The smoke copies on the VM stop and lose their smoke drop-ins.
3. Database snapshots again and the final rsync (only what changed since prepare; the databases are quiet now).
4. On the VM: `hawkes-secrets`, Gen (it lets the static IP into the fleet, build server and playtester groups and
   takes 52.0.19.230 out), Studio, the daily timer, the pull-deploy (path and boot service), the encoder, the sandbox
   firewalls and Caddy, enabled at boot; lingering for `hawkes` (agents run as its user units).
5. DNS: `dns.py point <name> A <new ip>` (Route 53, TTL 60) for `studio.`, `gen.` and every beta host from
   `products.json` `previews` (today: dod, phorigins, sickofit, yoobaland, placedept, icanbe, imaginelivetv, corporate,
   hawkesgenwebsite, hawkesnet), plus `dev-<sub>` hosts if they were turned on. `hawkesgen.com` and `www` are the
   portal's and are not touched. The old records have TTL 300, so resolvers move within five minutes.
6. It waits until Google's public resolver answers the new address for every name.
7. HTTPS to every name over the internet, then the checks again on the VM.
8. `hawkesstudio/deploy/.state.json` points at the VM (the AWS one kept as `.state.aws.json`).

Then on J's PC: in `hawkesgen/.env`, `HAWKES_ALLOW_IPS=<new ip>` instead of 52.0.19.230 (else Gen started on the PC
takes the server out of the fleet's security groups); `ssh-keygen -R studio.hawkesgen.com` (the VM has its own host
key). Resume the PM; Studio's next pull-deploy, beta push and daily run are the real test.

Downtime: stopping takes a minute, the final copy a few (the databases and a day's changes), starting two, DNS up to
five, the checks a few: about 20-40 minutes, an hour with margin.

### Rollback

`move.mjs rollback --apply` stops and disables everything on the VM, points every name back at 52.0.19.230 and
starts AWS's services again (its Gen lets itself back into the security groups on start). With `--copy-back` it first
pushes the VM's databases back to the AWS box (anything done on Google survives the rollback; files Gen made on the VM
are in S3 through its backups). The AWS box is never stopped by these scripts, so a rollback is always available until
J stops it.

### After the move

- A quiet week, then `move.mjs cleanup --apply` (the copy key and its AWS SSH rule go).
- J, by hand: stop the AWS instance `i-000b0b020f7109750` (keep its disk a while), later snapshot or delete it and
  release the Elastic IP (about $36 a month for disk and address while they exist); delete the `hawkes/hawkes-control`
  role and, once nothing reads them, the `hawkes/*` secrets in AWS.
- A daily snapshot schedule for the VM's disk if wanted (about $0.05/GB-month of changed blocks):
  `gcloud compute resource-policies create snapshot-schedule hawkes-control-daily --region us-east4 --daily-schedule --start-time 10:00 --max-retention-days 7`
  then `gcloud compute disks add-resource-policies hawkes-control --zone us-east4-c --resource-policies hawkes-control-daily`.
- Update hawkesstudio `docs/cloud.md` (the diagram, the SSH line, Costs), `src/costs.ts`'s fixed table (it prices the
  EC2 box), and the AGENTS.md map's "AWS control server" lines.

## What names 52.0.19.230

Found in the repos and configs on 2026-10-28 (hawkesstudio, hawkesgen, hawkesnet, hawkesgenwebsite); `move.mjs refs`
looks again, including AWS security groups in the three regions and Google firewall rules:

| Where | What | After the move |
|---|---|---|
| hawkesstudio `docs/cloud.md` (lines 22, 52) | the diagram and the SSH command | edit to the VM's address |
| hawkesstudio `deploy/.state.json` (ignored) | `ip` every deploy script SSHes to | `switch` rewrites it (`.state.aws.json` keeps the old) |
| hawkesgen `.env` on J's PC (ignored) | `HAWKES_ALLOW_IPS=52.0.19.230` | J sets the new IP |
| Route 53 `hawkesgen.com` | A records: studio, gen and the 10 beta hosts | `switch` (dns.py) |
| AWS security groups: `hawkesgen-comfy` / `dod-comfy` (each fleet region), the build server's, the playtesters' | 52.0.19.230/32 on 8189, 22, 3389 | Gen on the VM replaces it on start (`refreshAccess`, `builderAccess`) and when a playtester is used (`playtesterAccess`) |
| AWS security group `hawkes-control` (sg-0aaed8dd41cf3abdf) | the old box's own group | the move adds 22 from the VM for the copy; `cleanup` removes it |
| The portal's and Hawkes Net's firewalls | docs/cloud.md says the portal box took SSH "from J's IP or this server" | `refs` lists any rule that names the old address; add the VM's beside it |

No tracked file in hawkesnet or hawkesgenwebsite names the address, and no Caddyfile does (the control server's
Caddyfile is built from host names only, `deploy/caddyfile.mjs`). Things that reach the control server by name (the portal's Cloud Functions, the
Hawkes Net box's key checks, GitHub's push hooks, `~/.hawkes/client.json`, `auto-ssh.bat`) follow DNS.

## Costs, before and after (a month)

| | AWS today | Google |
|---|---|---|
| Control machine | m7i.2xlarge, about $294 | e2-standard-4, about $110 (n2-standard-4: about $128 with sustained use) |
| Its disk | 400 GB gp3, about $32 | 200 GB pd-balanced, about $22 |
| Its address | about $3.65 | about $3.65 |
| Secrets | Secrets Manager, about $3 | Secret Manager, 9 secrets, under $1 |
| **Total for the box** | **about $333** | **about $136** |

About $195 a month less, before cross-cloud traffic. What used to stay inside AWS now crosses clouds: the VM
downloading GPU outputs, build results and S3 library files (AWS egress, about $0.09/GB), and uploading job inputs,
files synced to the build server, and the beta sites playtesters load (Google egress, about $0.08-0.12/GB). Measure it
the first week (Studio's Costs tab shows AWS data transfer; Google's billing report shows egress); at 100-300 GB a
month each way it is roughly $15-60. It shrinks as the library moves to GCS and GPU work to Cloud Run. Unchanged: the
build server, GPU fleet and playtesters' disks and hours, Route 53, S3 and CloudFront.
