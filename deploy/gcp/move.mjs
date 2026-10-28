// Moves the control server (Hawkes Studio + Hawkes Gen) from the AWS EC2 box (52.0.19.230) to the Google VM made by
// provision.mjs: a lift-and-shift with about an hour of downtime. Every phase prints what it would do; --apply does it.
// J runs it from his PC (it uses his SSH key, his claw AWS keys for one security-group rule, and dns.py for Route 53).
// The runbook around it: docs/gcp.md.
//
//   node deploy/gcp/move.mjs refs                  what still names 52.0.19.230 (repos here, AWS security groups, Google
//                                                  firewall rules): read-only
//   node deploy/gcp/move.mjs prepare [--apply]     while AWS keeps serving: the VM's config, secrets, fresh clones of every
//                                                  repo on its branch, packages, a first copy of the data (Gen's library
//                                                  last, only files not already in S3), the agent sandbox, then Gen and
//                                                  Studio in smoke mode (no queue, no PM, no timers) and the checks.
//                                                  Run it again to refresh the copy (rsync sends only what changed).
//   node deploy/gcp/move.mjs check                 the checks again (health, AWS role, secrets, sandbox, Caddy)
//   node deploy/gcp/move.mjs switch [--apply]      the downtime: stop AWS's services, final copy, start on Google, DNS for
//                                                  studio., gen. and every beta host, wait for DNS and HTTPS, health checks
//   node deploy/gcp/move.mjs rollback [--apply] [--copy-back]   Google's services off, DNS back to AWS, AWS's services on
//                                                  (--copy-back first copies the databases written on Google back)
//   node deploy/gcp/move.mjs cleanup [--apply]     after the rollback window: the copy key and its AWS SSH rule removed
//
// What it never does: terminate or stop the AWS instance, release its Elastic IP, delete anything on either side. Those
// are J's, by hand, after a quiet week (docs/gcp.md, "After the move").
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROJECTS, STUDIO_DEPLOY, AWS_STATE_FILE, AWS, ROLE_ARN, GCP, OLD_IP, APPLY, args, flag, say, warn, fail, header, show,
  gcpState, saveGcpState, awsState, onAws, onGce, ssh, awsCfg, awsSdk, gcloudJson, dnsLine, dnsPoint, resolveA, sleep,
} from './lib.mjs';

const phase = args.find((a) => !a.startsWith('--')) ?? 'help';
const G = gcpState();
const NEW_IP = G.ip;
const MOVE = '/var/tmp/hawkes-move';
const DOMAIN = awsState().domain ?? 'hawkesgen.com';

// ------------------------------------------------------------------ hosts
async function hosts() {
  const { previewHosts } = await import(pathToFileURL(path.join(STUDIO_DEPLOY, 'caddyfile.mjs')).href);
  const products = JSON.parse(fs.readFileSync(path.join(PROJECTS, 'hawkesstudio', 'products.json'), 'utf8'));
  const { subs, devHosts } = previewHosts(products, !!awsState().devHosts);
  // hawkesgen.com and www are the portal's (Firebase), never this server.
  return ['studio', 'gen', ...subs, ...devHosts.map((s) => `dev-${s}`)].map((s) => `${s}.${DOMAIN}`);
}

// ------------------------------------------------------------------ remote scripts
/** At the top of every script that runs on the Google VM and pulls from AWS (as root, with the copy key). */
const PULL = String.raw`OLD=${OLD_IP}
E="ssh -i /root/.ssh/hawkes-move -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/hawkes-move-known -o ServerAliveInterval=15"
R() { rsync -aH --info=stats1 -e "$E" --rsync-path="sudo rsync" "$@"; }
A() { $E ubuntu@$OLD "$@"; }
mkdir -p ${MOVE}`;

/** On AWS: what's in /srv/hawkes (repos with their branch, everything else), the lists the copy needs, DB snapshots. */
const AWS_INVENTORY = String.raw`mkdir -p ${MOVE}/db ${MOVE}/lists
cd /srv/hawkes
python3 - <<'PY' > ${MOVE}/inventory.json
import os, re, json, subprocess
root = '/srv/hawkes'
def git(d, *a):
    return subprocess.run(['git', '-c', 'safe.directory=*', '-C', d, *a], capture_output=True, text=True).stdout.strip()
def repo(rel):
    d = os.path.join(root, rel)
    url = re.sub(r'//[^@/]+@', '//', git(d, 'remote', 'get-url', 'origin'))
    return {'path': rel, 'url': url, 'branch': git(d, 'rev-parse', '--abbrev-ref', 'HEAD'), 'commit': git(d, 'rev-parse', 'HEAD'), 'lfs': os.path.exists(os.path.join(d, '.gitattributes')) and 'filter=lfs' in open(os.path.join(d, '.gitattributes'), errors='ignore').read()}
out = {'repos': [], 'other': []}
skip = {'.work', 'previews', '.talk'}
for name in sorted(os.listdir(root)):
    p = os.path.join(root, name)
    if os.path.isdir(os.path.join(p, '.git')):
        out['repos'].append(repo(name)); continue
    if os.path.isdir(p) and name not in skip:
        nested = [s for s in sorted(os.listdir(p)) if os.path.isdir(os.path.join(p, s, '.git'))]
        for s in nested: out['repos'].append(repo(f'{name}/{s}'))
        if nested and all(os.path.isdir(os.path.join(p, s, '.git')) for s in os.listdir(p)): continue
        # A folder with repos inside and other things beside them (YoobaLand/): the other things only.
        out['other'].append({'name': name, 'exclude': nested}); continue
    out['other'].append({'name': name, 'exclude': []})
print(json.dumps(out))
PY
# Per repo: files git ignores that aren't rebuilt (Studio's reports, a product's local env...). .data is copied on its own.
python3 - <<'PY'
import json, subprocess, re
inv = json.load(open('${MOVE}/inventory.json'))
heavy = re.compile(r'(^|/)(node_modules|\.venv|venv|dist|build|Library|Temp|obj|Logs|\.cache|\.next|\.data|play)/?$')
for r in inv['repos']:
    d = '/srv/hawkes/' + r['path']
    out = subprocess.run(['git', '-c', 'safe.directory=*', '-C', d, 'ls-files', '-o', '-i', '--exclude-standard', '--directory'], capture_output=True, text=True).stdout.splitlines()
    keep = [l for l in out if l and not heavy.search(l.rstrip('/'))]
    open('${MOVE}/lists/ignored-' + r['path'].replace('/', '__') + '.txt', 'w').write('\n'.join(keep) + ('\n' if keep else ''))
PY
# Gen's library: the files already backed up in S3 (by content) stay behind; Gen restores them from S3 on demand.
D=/srv/hawkes/hawkesgen/.data
sqlite3 -readonly "$D/hawkesgen.db" "SELECT DISTINCT '/' || substr(a.path, length('$D/library/') + 1) FROM assets a JOIN backups b ON b.sha256 = a.sha256 WHERE a.path LIKE '$D/library/%';" > ${MOVE}/lists/s3-backed.txt
echo "library: $(wc -l < ${MOVE}/lists/s3-backed.txt) files are in S3 and stay behind; $(du -sh $D/library | cut -f1) on disk in all"
# Consistent copies of every SQLite database (they may be in use).
rm -rf ${MOVE}/db/*
find /srv/hawkes/hawkesgen/.data /srv/hawkes/hawkesstudio/.data /srv/hawkes/.work/apps -maxdepth 4 -name '*.db' -size +0 2>/dev/null | while read -r db; do
  mkdir -p "${MOVE}/db$(dirname "$db")"; sqlite3 "$db" ".backup '${MOVE}/db$db'" && echo "snapshot $db"
done
chmod -R go-rwx ${MOVE}`;

/**
 * On Google: the server's config from AWS (before the clones: units, keys file, Caddy, the sandbox's wrapper). The first
 * time also the GitHub token hawkes-secrets wrote on AWS (/run is memory on both), so the private repos can be cloned
 * before Gen's own fetch-secrets.mjs is there to read Secret Manager.
 */
const gceConfig = (first) => String.raw`${PULL}
R ubuntu@$OLD:${MOVE}/inventory.json ubuntu@$OLD:${MOVE}/lists ${MOVE}/
# Server config: Gen's keys file, Caddy's inputs and file, units and drop-ins, the sandbox's wrapper and sudoers, git's LFS
# setting, the credential helper, Antigravity's binary. (Units are enabled by switch, not here.)
R ubuntu@$OLD:/etc/hawkes/ /etc/hawkes/
R ubuntu@$OLD:/etc/caddy/ /etc/caddy/
R ubuntu@$OLD:'/etc/systemd/system/hawkes-*' ubuntu@$OLD:/etc/systemd/system/caddy.service.d /etc/systemd/system/
R ubuntu@$OLD:/etc/sudoers.d/hawkes-agent /etc/sudoers.d/ && visudo -cf /etc/sudoers.d/hawkes-agent >/dev/null
R ubuntu@$OLD:/etc/gitconfig /etc/gitconfig || true
R ubuntu@$OLD:/usr/local/bin/hawkes-agent-run ubuntu@$OLD:/usr/local/bin/git-credential-hawkes ubuntu@$OLD:/usr/local/bin/agy /usr/local/bin/ || true
R ubuntu@$OLD:/usr/local/sbin/hawkes-agent-firewall /usr/local/sbin/ || true
R ubuntu@$OLD:/var/lib/hawkes/ /var/lib/hawkes/
R ubuntu@$OLD:/var/lib/caddy/ /var/lib/caddy/
chown root:hawkes /etc/hawkes/keys.env && chmod 640 /etc/hawkes/keys.env
${first ? 'install -d -m 755 /run/hawkes && R ubuntu@$OLD:/run/hawkes/github.env /run/hawkes/github.env && chown root:hawkes /run/hawkes/github.env && chmod 640 /run/hawkes/github.env' : ''}
systemctl daemon-reload
echo config-copied`;

/** On Google: the data from AWS. The same script for the first pass (prepare, while AWS serves) and the last (switch). */
const GCE_DATA = String.raw`${PULL}
R ubuntu@$OLD:${MOVE}/inventory.json ubuntu@$OLD:${MOVE}/lists ${MOVE}/
# Homes: Claude Code logins and sessions (Talk and agents resume), CLI logins, git config. Caches stay behind.
R --exclude=/.cache/ --exclude=/.npm/ ubuntu@$OLD:/home/hawkes/ /home/hawkes/
R --exclude=/.cache/ --exclude=/.npm/ ubuntu@$OLD:/srv/hawkes-agent/ /srv/hawkes-agent/
# What isn't a repo: story docs, shared art, the beta sites, Talk's workspace, the portal's beta app data, Unity beta sites.
python3 -c "import json; [print(o['name'] + '|' + ' '.join('--exclude=/' + o['name'] + '/' + x + '/' for x in o['exclude'])) for o in json.load(open('${MOVE}/inventory.json'))['other']]" | while IFS='|' read -r name excl; do
  [ -n "$name" ] && R $excl "ubuntu@$OLD:/srv/hawkes/$name" /srv/hawkes/
done
R ubuntu@$OLD:/srv/hawkes/previews /srv/hawkes/ || true
R ubuntu@$OLD:/srv/hawkes/.talk /srv/hawkes/ || true
mkdir -p /srv/hawkes/.work
for d in apps beta; do R "ubuntu@$OLD:/srv/hawkes/.work/$d" /srv/hawkes/.work/ 2>/dev/null || true; done
# Each repo's ignored-but-kept files (reports, local env files).
for f in ${MOVE}/lists/ignored-*.txt; do
  rel=$(basename "$f" .txt | sed 's/^ignored-//; s/__/\//g')
  [ -s "$f" ] && [ -d "/srv/hawkes/$rel" ] && R -r --files-from="$f" "ubuntu@$OLD:/srv/hawkes/$rel/" "/srv/hawkes/$rel/"
done
# Studio's data, then Gen's data without its library, then the library (only what isn't in S3: Gen's library goes last).
DBX="--exclude=*.db --exclude=*.db-wal --exclude=*.db-shm --exclude=*.db-journal"
R $DBX ubuntu@$OLD:/srv/hawkes/hawkesstudio/.data/ /srv/hawkes/hawkesstudio/.data/
R $DBX --exclude=/library/ --exclude=/tmp/ ubuntu@$OLD:/srv/hawkes/hawkesgen/.data/ /srv/hawkes/hawkesgen/.data/
R --exclude-from=${MOVE}/lists/s3-backed.txt ubuntu@$OLD:/srv/hawkes/hawkesgen/.data/library/ /srv/hawkes/hawkesgen/.data/library/
# The database snapshots, in place (a stale -wal next to a new database would corrupt it).
R ubuntu@$OLD:${MOVE}/db/ ${MOVE}/db/
( cd ${MOVE}/db && find . -name '*.db' ) | while read -r rel; do
  db="/$\{rel#./}"; rm -f "$db-wal" "$db-shm" "$db-journal"; install -D -m 640 "${MOVE}/db/$\{rel#./}" "$db"; chown --reference="$(dirname "$db")" "$db"; echo "database $db"
done
# rsync kept every owner by name (the same users exist on both); the snapshots took their folder's owner above.
find /srv/hawkes/hawkesgen/.data/fleet /srv/hawkes/hawkesgen/.data/builder -type f -exec chmod 600 {} + 2>/dev/null || true
du -sh /srv/hawkes/hawkesstudio/.data /srv/hawkes/hawkesgen/.data 2>/dev/null`.replace(/\$\\\{/g, '${');

/** The Google drop-ins: secrets from Secret Manager, AWS through the federated role, the fixed public address. */
const dropIns = (ip) => String.raw`mkdir -p /etc/systemd/system/hawkes-secrets.service.d /etc/systemd/system/hawkes-gen.service.d /etc/systemd/system/hawkes-studio.service.d
cat > /etc/systemd/system/hawkes-secrets.service.d/gcp.conf <<'EOF'
# The Google control VM: secrets from Google Secret Manager (hawkes-control-*), read with the VM's service account.
[Service]
Environment=HAWKES_SECRETS_BACKEND=gcp
Environment=HAWKES_GCP_PROJECT=${GCP.project}
EOF
for u in hawkes-gen hawkes-studio; do cat > /etc/systemd/system/$u.service.d/gcp.conf <<'EOF'
# The Google control VM: AWS (GPU fleet, build server, playtesters, S3, SES, Cost Explorer) through the role the VM's
# identity token is traded for (hawkesgen src/providers/gceaws.ts); no AWS keys. hawkesgen/docs: hawkesstudio docs/gcp.md.
[Service]
Environment=HAWKES_AWS_FEDERATION=gce
Environment=HAWKES_AWS_ROLE_ARN=${ROLE_ARN}
Environment=HAWKES_AWS_AUDIENCE=${AWS.audience}
Environment=HAWKES_PUBLIC_IP=${ip}
EOF
done
systemctl daemon-reload`;

const SMOKE_ON = String.raw`cat > /etc/systemd/system/hawkes-gen.service.d/smoke.conf <<'EOF'
# The move's dry run (deploy/gcp/move.mjs): API and dashboard only, no queue, no fleet access changes. switch removes it.
[Service]
Environment=HAWKESGEN_SMOKE=1
EOF
cat > /etc/systemd/system/hawkes-studio.service.d/smoke.conf <<'EOF'
# The move's dry run (deploy/gcp/move.mjs): the server only, no runs, agents, PM or timers. switch removes it.
[Service]
Environment=STUDIO_SMOKE=1
EOF
systemctl daemon-reload`;

/** On Google, as root: git for the hawkes user, then a fresh clone of every repo on the branch AWS had it on. */
const GCE_CLONES = String.raw`chmod 755 /usr/local/bin/git-credential-hawkes && sed -i 's/\r$//' /usr/local/bin/git-credential-hawkes
H() { sudo -u hawkes -H bash -lc "$1"; }
H 'git config --global credential.https://github.com.helper /usr/local/bin/git-credential-hawkes && git config --global pull.ff only && git config --global init.defaultBranch main'
git lfs install --system --skip-smudge --skip-repo >/dev/null
chown hawkes:hawkes /srv/hawkes
python3 -c "import json; [print(r['path'], r['url'], r['branch'], r['commit'], int(r['lfs'])) for r in json.load(open('${MOVE}/inventory.json'))['repos']]" | while read -r rel url branch commit lfs; do
  d=/srv/hawkes/$rel
  case "$rel" in hawkesgen|hawkesstudio) branch=main ;; esac
  if [ -d "$d/.git" ]; then
    H "cd '$d' && git fetch -q origin && git status --porcelain --untracked-files=no | grep -q . && echo '$rel: has edits, left alone' || git checkout -q '$branch' 2>/dev/null; git merge -q --ff-only 'origin/$branch' 2>/dev/null; echo '$rel: '\$(git log -1 --format='%h %s')"
  else
    mkdir -p "$(dirname "$d")"; chown hawkes:hawkes "$(dirname "$d")"
    if [ "$branch" = HEAD ]; then H "git clone -q '$url' '$d' && cd '$d' && git checkout -q '$commit'"; else H "git clone -q --branch '$branch' '$url' '$d'"; fi
    echo "$rel: cloned ($branch)"
  fi
  [ "$lfs" = 1 ] && H "cd '$d' && git lfs pull" || true
done`;

/** On Google, as root: the same packages deploy.mjs installs (installPackages). */
const GCE_PACKAGES = String.raw`H() { sudo -u hawkes -H bash -lc "$1"; }
npm install -g @anthropic-ai/claude-code @github/copilot @google/gemini-cli --loglevel=error >/tmp/hawkes-npm-g.log 2>&1 && echo global-clis-ok
H 'cd /srv/hawkes/hawkesgen && npm ci --no-audit --no-fund --loglevel=error && cd /srv/hawkes/hawkesstudio && npm ci --no-audit --no-fund --loglevel=error' && echo npm-ok
cd /srv/hawkes/hawkesgen && npx --yes playwright install-deps chromium >/tmp/pw-deps.log 2>&1 && echo pw-deps-ok
H 'cd /srv/hawkes/hawkesgen && npx playwright install chromium >/tmp/pw.log 2>&1' && echo chromium-ok
H 'cd /srv/hawkes/hawkesgen && ( test -x .venv/bin/python || python3 -m venv .venv ) && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q pillow numpy "rembg[cpu]"' && echo venv-ok
loginctl enable-linger hawkes`;

/** The checks: secrets on Google, the AWS role through the VM's identity, the sandbox kept off the metadata server. */
const GCE_CHECKS = String.raw`ok=0; bad() { echo "FAIL: $*"; ok=1; }; pass() { echo "ok: $*"; }
systemctl is-active -q hawkes-secrets && pass "hawkes-secrets read Google Secret Manager ($(ls /run/hawkes/*.env 2>/dev/null | wc -l) files)" || bad "hawkes-secrets (journalctl -u hawkes-secrets)"
[ -s /run/hawkes/gen.env ] && pass "/run/hawkes/gen.env" || bad "/run/hawkes/gen.env is missing"
[ -s /run/hawkes/github.env ] && pass "/run/hawkes/github.env" || bad "/run/hawkes/github.env is missing"
sudo -u hawkes node --input-type=module -e '
const t = await (await fetch("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity?audience=${AWS.audience}", { headers: { "Metadata-Flavor": "Google" } })).text();
const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: "${ROLE_ARN}", RoleSessionName: "gce-move-check", WebIdentityToken: t, DurationSeconds: "900" });
const r = await fetch("https://sts.us-east-1.amazonaws.com/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
const x = await r.text();
if (!r.ok) { console.log("FAIL: AWS role: " + (/<Message>([^<]+)/.exec(x)?.[1] ?? r.status)); process.exit(1); }
console.log("ok: AWS role " + /<Arn>([^<]+)<\/Arn>/.exec(x)?.[1]);
' || ok=1
sudo -u hawkes-agent curl -s -m 3 -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/ >/dev/null 2>&1 && bad "hawkes-agent reaches the metadata server" || pass "hawkes-agent can't reach the metadata server"
sudo -u hawkes-agent cat /etc/hawkes/keys.env >/dev/null 2>&1 && bad "hawkes-agent reads keys.env" || pass "keys.env out of the sandbox's reach"
grep -q federationOn /srv/hawkes/hawkesgen/src/providers/comfy/fleet.ts && pass "Gen main has the GCE federation (fleet.ts awsConfig)" || bad "Gen main lacks the GCE federation: merge deploy/gcp/gen-patches first"
test -f /srv/hawkes/hawkesstudio/src/gceaws.ts && pass "Studio main has the GCE federation (src/gceaws.ts)" || bad "Studio main lacks the GCE federation: apply deploy/gcp/studio-patches/aws-gce.patch first"
grep -q HAWKESGEN_SMOKE /srv/hawkes/hawkesgen/src/server.ts && pass "Gen main has smoke mode" || bad "Gen main lacks HAWKESGEN_SMOKE: merge the Gen branch first"
h=$(curl -s -m 5 http://127.0.0.1:8790/v1/health); [ -n "$h" ] && pass "Gen: $(echo "$h" | head -c 160)" || bad "Gen does not answer on :8790"
s=$(curl -s -m 5 http://127.0.0.1:8791/api/health); [ -n "$s" ] && pass "Studio: $(echo "$s" | head -c 160)" || bad "Studio does not answer on :8791"
systemctl is-active -q caddy && pass "Caddy runs" || bad "Caddy is not running"
for host in __HOSTS__; do
  c=$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$host:443:127.0.0.1" "https://$host/auth/signin" 2>/dev/null || true)
  case "$c" in 2*|3*|401|404) pass "https://$host ($c, certificate ok)";; *) bad "https://$host ($c)";; esac
done
exit $ok`;

// ------------------------------------------------------------------ phases
async function needVm() {
  if (!NEW_IP) fail('No Google VM in hawkesstudio/deploy/.keys/gcp-control.json: node deploy/gcp/provision.mjs --apply first');
  const ready = (await ssh(NEW_IP, 'test -f /var/lib/hawkes/ready && echo ready || echo booting', { quiet: true, known: 'known_hosts_gcp', ok: true })).trim();
  if (ready !== 'ready') fail(`the VM ${NEW_IP} hasn't finished its first boot (/var/log/hawkes-init.log)`);
}

/** Runs (or prints) one remote step. */
async function remote(where, title, script) {
  say(`${where === 'aws' ? `AWS ${OLD_IP}` : `Google ${NEW_IP ?? '(the new VM)'}`}: ${title}`);
  if (!APPLY) { show(script.length > 1800 && !flag('full') ? `${script.slice(0, 1800)}\n… (${script.split('\n').length} lines)` : script); return ''; }
  return where === 'aws' ? onAws(script) : onGce(script);
}

async function copyKey() {
  say("the copy key: Google's root pulls from AWS's ubuntu (only from the VM's address, no shell features), and AWS's SSH rule for it");
  if (!APPLY) { show(`ssh-keygen on the VM (/root/.ssh/hawkes-move); its .pub into AWS ~ubuntu/.ssh/authorized_keys with from="${NEW_IP}"; ${AWS.controlSg} 22/tcp from ${NEW_IP}/32`); return; }
  const pub = (await onGce("install -d -m 700 /root/.ssh; test -f /root/.ssh/hawkes-move || ssh-keygen -q -t ed25519 -N '' -C hawkes-move -f /root/.ssh/hawkes-move; cat /root/.ssh/hawkes-move.pub", { quiet: true })).trim();
  if (!/^ssh-ed25519 \S+ hawkes-move$/.test(pub)) fail('could not read the copy key from the VM');
  const line = `from="${NEW_IP}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ${pub}`;
  await onAws(`grep -qF '${pub.split(' ')[1]}' /home/ubuntu/.ssh/authorized_keys || echo '${line}' >> /home/ubuntu/.ssh/authorized_keys; echo copy-key-ok`);
  const { EC2Client, AuthorizeSecurityGroupIngressCommand } = await awsSdk('@aws-sdk/client-ec2');
  try {
    await new EC2Client(awsCfg()).send(new AuthorizeSecurityGroupIngressCommand({ GroupId: AWS.controlSg, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: `${NEW_IP}/32`, Description: 'hawkes move: the Google VM copies from here' }] }] }));
    say(`${AWS.controlSg}: 22 from ${NEW_IP}/32`);
  } catch (e) {
    if (e.name !== 'InvalidPermission.Duplicate') throw e;
  }
}

async function prepare() {
  header(`prepare: the Google VM ${NEW_IP ?? '(not made yet)'} as a copy of ${OLD_IP} (AWS keeps serving)`);
  if (APPLY) await needVm();
  await copyKey();
  await remote('aws', 'inventory, ignored files per repo, the library files already in S3, database snapshots', AWS_INVENTORY);
  await remote('gce', "config: Gen's keys file, units, Caddy and its certificates, the sandbox's wrapper, the GitHub token for the clones", gceConfig(true));
  await remote('gce', 'Google drop-ins (Secret Manager, the AWS role, the fixed address) and smoke mode', `${dropIns(NEW_IP)}\n${SMOKE_ON}`);
  await remote('gce', 'fresh clones from GitHub on their branches (Gen and Studio on main), LFS files', GCE_CLONES);
  await remote('gce', 'data: homes, non-repo folders, ignored files, Studio data, Gen data, then the library (only what S3 lacks)', GCE_DATA);
  await remote('gce', "secrets, now from Google Secret Manager (Gen main's fetch-secrets.mjs, HAWKES_SECRETS_BACKEND=gcp)", 'systemctl restart hawkes-secrets && ls -l /run/hawkes/');
  await remote('gce', 'packages: Claude Code, Copilot and Gemini CLIs, npm ci, Playwright Chromium, the Python venv', GCE_PACKAGES);
  say('the agent sandbox: the same setup as on AWS (hawkesstudio deploy/agent-sandbox.mjs, its script)');
  const { spawnSync } = await import('node:child_process');
  const sandbox = spawnSync(process.execPath, [path.join(STUDIO_DEPLOY, 'agent-sandbox.mjs'), '--dry-run'], { encoding: 'utf8', windowsHide: true }).stdout;
  if (!/sandbox-ready/.test(sandbox ?? '')) warn('could not read agent-sandbox.mjs --dry-run; run it against the VM after the switch');
  else if (APPLY) await onGce(sandbox.replace(/^set -euo pipefail\n/, ''));
  else show('(agent-sandbox.mjs SETUP: users, folders, wrapper, sudoers, hawkes-agent-firewall, Talk key if missing)');
  await remote('gce', 'start in smoke mode: secrets, Gen (no queue), Studio (no runs, agents, PM), Caddy (the copied certificates)', 'systemctl enable --now hawkes-agent-firewall hawkes-agent-gce-firewall 2>/dev/null || true\nsystemctl restart hawkes-secrets hawkes-gen && sleep 6 && systemctl restart hawkes-studio caddy && sleep 6 && systemctl --no-pager --lines=0 status hawkes-gen hawkes-studio caddy | grep -E "Active|●"');
  if (APPLY) saveGcpState({ preparedAt: new Date().toISOString() });
  await check();
}

async function check() {
  header('checks on the Google VM');
  const script = GCE_CHECKS.replace('__HOSTS__', (await hosts()).join(' '));
  if (!APPLY && phase !== 'check') { show('(health, secrets, AWS role, sandbox, Caddy for every host)'); return; }
  await onGce(script).catch(() => warn('some checks failed (above)'));
}

async function switchOver() {
  const names = await hosts();
  header(`switch: ${OLD_IP} -> ${NEW_IP} (downtime starts at step 2)`);
  if (APPLY && !G.preparedAt) fail('run prepare --apply first');
  if (APPLY) await needVm();
  // 1. Nothing half-done on AWS.
  const busy = APPLY ? await onAws(String.raw`curl -s -m 5 'http://127.0.0.1:8791/api/self-deploys?limit=0' | python3 -c "import sys,json; b=(json.load(sys.stdin) or {}).get('busy') or {}; print('critical', len(b.get('critical') or []), 'agents', b.get('agents', 0), 'talk', b.get('talk', 0))" || true
echo "detached $(sudo -u hawkes XDG_RUNTIME_DIR=/run/user/$(id -u hawkes) systemctl --user list-units --no-legend 'hawkes-*' 2>/dev/null | wc -l)"
echo "gen-running $(sqlite3 -readonly /srv/hawkes/hawkesgen/.data/hawkesgen.db "SELECT count(*) FROM jobs WHERE status='running'")"`, { quiet: true }) : '';
  say(`1. AWS is idle? Pause the PM (Roadmap tab), wait for agents, Talk answers, Gen jobs and Unity builds to finish. ${busy.trim().replace(/\n/g, ', ')}`);
  if (APPLY && /(critical [1-9]|agents [1-9]|talk [1-9]|detached [1-9]|gen-running [1-9])/.test(busy) && !flag('force')) fail('AWS is busy (above): wait, or --force (running work is cut off and resumes on Google where it can)');
  // 2. Stop AWS (disabled too, so a reboot can't bring a second Studio/Gen up against the same fleet).
  await remote('aws', '2. stop and disable Studio, Gen, the pull-deploy, the daily timer and the encoder (Caddy stays: 502 until DNS moves)', 'systemctl disable --now hawkes-pull.path hawkes-pull.service hawkes-daily.timer hawkes-broadcast hawkes-studio hawkes-gen\nsudo -u hawkes XDG_RUNTIME_DIR=/run/user/$(id -u hawkes) systemctl --user stop "hawkes-*" 2>/dev/null || true\necho aws-stopped');
  await remote('gce', '2b. stop the smoke copies', 'systemctl stop hawkes-studio hawkes-gen\nrm -f /etc/systemd/system/hawkes-gen.service.d/smoke.conf /etc/systemd/system/hawkes-studio.service.d/smoke.conf\nsystemctl daemon-reload');
  // 3. Final copy (the databases are quiet now).
  await remote('aws', '3. database snapshots and lists again', AWS_INVENTORY);
  await remote('gce', '3b. final copy (only what changed since prepare)', `${gceConfig(false)}\n${GCE_DATA}`);
  // 4. Start on Google.
  await remote('gce', '4. start everything on Google', 'systemctl daemon-reload\nsystemctl enable --now hawkes-agent-firewall hawkes-agent-gce-firewall hawkes-secrets\nsystemctl restart hawkes-secrets\nsystemctl enable --now hawkes-gen && sleep 6\nsystemctl enable --now hawkes-studio hawkes-daily.timer hawkes-pull.path hawkes-broadcast caddy\nsystemctl enable hawkes-pull.service\nsystemctl restart caddy\nsleep 8; systemctl --no-pager --lines=0 status hawkes-gen hawkes-studio caddy | grep -E "Active|●"');
  // 5. DNS.
  say(`5. DNS (Route 53, TTL 60): ${names.length} names -> ${NEW_IP ?? '<new ip>'}`);
  for (const n of names) {
    show(dnsLine(n, NEW_IP ?? '<new ip>'));
    if (APPLY) dnsPoint(n, NEW_IP);
  }
  if (APPLY) {
    say('6. waiting for public DNS (dns.google) to answer the new address');
    for (let i = 0; i < 40; i++) {
      const left = [];
      for (const n of names) if (!(await resolveA(n)).includes(NEW_IP)) left.push(n);
      if (!left.length) break;
      if (i % 4 === 0) say(`   still old: ${left.join(', ')}`);
      await sleep(15_000);
    }
    say('7. HTTPS and health, through the internet');
    for (const n of names) {
      const r = await fetch(`https://${n}/auth/signin`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) }).then((x) => `${x.status}`).catch((e) => `error ${e.cause?.code ?? e.message}`);
      say(`   https://${n}: ${r}`);
    }
    await onGce(GCE_CHECKS.replace('__HOSTS__', names.join(' '))).catch(() => warn('some checks failed (above): fix, or rollback --apply'));
    // 8. J's PC: every deploy script now talks to the Google VM.
    const st = awsState();
    if (!fs.existsSync(`${AWS_STATE_FILE.replace(/\.json$/, '')}.aws.json`)) fs.writeFileSync(`${AWS_STATE_FILE.replace(/\.json$/, '')}.aws.json`, JSON.stringify(st, null, 2));
    fs.writeFileSync(AWS_STATE_FILE, JSON.stringify({ ...st, ip: NEW_IP, provider: 'gce', gce: { project: GCP.project, zone: GCP.zone, name: GCP.name }, awsIp: OLD_IP }, null, 2));
    saveGcpState({ switchedAt: new Date().toISOString() });
    say(`8. hawkesstudio/deploy/.state.json now points at ${NEW_IP} (the AWS one is kept as .state.aws.json)`);
  } else {
    say('6-8. (with --apply) wait for DNS, check HTTPS for every name, the checks again, point hawkesstudio/deploy/.state.json at the VM');
  }
  say(`then on J's PC: HAWKES_ALLOW_IPS in hawkesgen/.env from ${OLD_IP} to ${NEW_IP ?? '<new ip>'}; ssh-keygen -R studio.hawkesgen.com (the VM has its own host key)`);
}

async function rollback() {
  const names = await hosts();
  header(`rollback: back to AWS ${OLD_IP}`);
  if (flag('copy-back')) {
    await remote('gce', 'stop Google\'s services, then push the databases written on Google back to AWS', `${PULL}\nsystemctl stop hawkes-studio hawkes-gen\nfor db in $(find /srv/hawkes/hawkesgen/.data /srv/hawkes/hawkesstudio/.data /srv/hawkes/.work/apps -maxdepth 4 -name '*.db' -size +0 2>/dev/null); do mkdir -p "${MOVE}/back$(dirname $db)"; sqlite3 "$db" ".backup '${MOVE}/back$db'"; done\nrsync -aH -e "$E" --rsync-path="sudo rsync" ${MOVE}/back/srv/hawkes/ ubuntu@$OLD:/var/tmp/hawkes-move-back/\nA "sudo bash -c 'cd /var/tmp/hawkes-move-back && find . -name \\"*.db\\" | while read -r r; do d=/srv/hawkes/\\\${r#./}; rm -f \\\$d-wal \\\$d-shm; install -m 640 -o hawkes -g hawkes \\\$r \\\$d; done'"`);
  }
  await remote('gce', 'stop and disable everything on Google (the data stays)', 'systemctl disable --now hawkes-pull.path hawkes-pull.service hawkes-daily.timer hawkes-broadcast hawkes-studio hawkes-gen 2>/dev/null || true\necho gce-stopped');
  say(`DNS back: ${names.length} names -> ${OLD_IP}`);
  for (const n of names) {
    show(dnsLine(n, OLD_IP));
    if (APPLY) dnsPoint(n, OLD_IP);
  }
  await remote('aws', 'start AWS again (its Gen lets itself back into the fleet, builder and playtester groups on start)', 'systemctl enable --now hawkes-secrets hawkes-gen && sleep 6 && systemctl enable --now hawkes-studio hawkes-daily.timer hawkes-pull.path hawkes-broadcast && systemctl enable hawkes-pull.service && echo aws-started');
  if (APPLY) {
    const back = `${AWS_STATE_FILE.replace(/\.json$/, '')}.aws.json`;
    if (fs.existsSync(back)) fs.copyFileSync(back, AWS_STATE_FILE);
    saveGcpState({ rolledBackAt: new Date().toISOString() });
    say('hawkesstudio/deploy/.state.json points at AWS again');
  }
}

async function cleanup() {
  header('cleanup: the copy key and its SSH rule');
  await remote('aws', 'remove the copy key from ~ubuntu/.ssh/authorized_keys', "sed -i '/ hawkes-move$/d' /home/ubuntu/.ssh/authorized_keys && echo removed");
  await remote('gce', 'remove the copy key', 'rm -f /root/.ssh/hawkes-move /root/.ssh/hawkes-move.pub /root/.ssh/hawkes-move-known; rm -rf /var/tmp/hawkes-move; echo removed');
  say(`${AWS.controlSg}: revoke 22 from ${NEW_IP}/32`);
  if (APPLY) {
    const { EC2Client, RevokeSecurityGroupIngressCommand } = await awsSdk('@aws-sdk/client-ec2');
    await new EC2Client(awsCfg()).send(new RevokeSecurityGroupIngressCommand({ GroupId: AWS.controlSg, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: `${NEW_IP}/32` }] }] })).catch((e) => warn(e.message));
  }
}

async function refs() {
  header(`what still names ${OLD_IP} (read-only)`);
  const { spawnSync } = await import('node:child_process');
  for (const repo of ['hawkesstudio', 'hawkesgen', 'hawkesnet', 'hawkesgenwebsite']) {
    const dir = path.join(PROJECTS, repo);
    if (!fs.existsSync(dir)) continue;
    const r = spawnSync('git', ['-C', dir, 'grep', '-n', '-I', '-F', OLD_IP], { encoding: 'utf8', windowsHide: true });
    say(`${repo} (tracked files): ${r.stdout.trim() ? '' : 'none'}`);
    if (r.stdout.trim()) show(r.stdout.trim());
  }
  for (const f of [path.join(PROJECTS, 'hawkesgen', '.env'), AWS_STATE_FILE]) {
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(OLD_IP)) say(`${f}: names it (ignored file; values not shown)`);
  }
  try {
    const { EC2Client, DescribeSecurityGroupsCommand } = await awsSdk('@aws-sdk/client-ec2');
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      const r = await new EC2Client(awsCfg(region)).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'ip-permission.cidr', Values: [`${OLD_IP}/32`] }] }));
      for (const sg of r.SecurityGroups ?? []) say(`AWS ${region} security group ${sg.GroupName} (${sg.GroupId}) lets ${OLD_IP} in: Gen on Google replaces it with ${NEW_IP ?? 'the new IP'} on start (refreshAccess, builderAccess, playtesterAccess)`);
    }
  } catch (e) {
    warn(`AWS security groups not read: ${e.message}`);
  }
  const rules = gcloudJson(['compute', 'firewall-rules', 'list', '--project', GCP.project]) ?? [];
  for (const r of rules) if ((r.sourceRanges ?? []).some((c) => c.startsWith(OLD_IP))) say(`Google firewall rule ${r.name} lets ${OLD_IP} in (add ${NEW_IP} beside it)`);
  say(`DNS: ${(await hosts()).join(', ')} -> ${OLD_IP} until switch`);
}

const PHASES = { prepare, check, switch: switchOver, rollback, cleanup, refs };
if (!PHASES[phase]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(phase === 'help' ? 0 : 1);
}
await PHASES[phase]();
