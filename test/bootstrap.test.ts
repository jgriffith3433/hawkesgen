// server/bootstrap.sh, dry run: the filled script runs under bash in a scratch root with every system command stubbed
// (apt, systemctl, git, pip, aria2c, df, shutdown…). Checks that a stopped install resumes where it stopped and that
// the idle stop powers off a stuck or failed install. Skips without a bash (on Windows it needs Git Bash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const { userData, loadManifest, stuckFor, unfinishedInstall } = await import('../src/providers/comfy/fleet.ts');

const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p)) : '/bin/bash';
const skip = BASH ? false : 'no bash here';
const posix = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/') : p);

const STUBS: Record<string, string> = {
  systemctl: '',
  'apt-get': '',
  dpkg: '',
  htpasswd: '',
  chown: '',
  mkswap: '',
  swapon: '[ "$1" = "--show" ] && [ -f "$ROOT/swap_on" ] && echo /swapfile; [ "$1" = "--show" ] || touch "$ROOT/swap_on"; exit 0',
  fallocate: 'touch "${@: -1}"',
  'nvidia-smi': 'echo 46068',
  free: 'echo "Mem: 31000 4000 27000"',
  shutdown: 'touch "$ROOT/shutdown"',
  'systemd-cat': 'cat >> "$ROOT/journal"',
  sleep: '',
  jq: 'echo 0',
  df: 'echo Used; cat "$ROOT/df_used" 2>/dev/null || echo 100',
  curl: 'case "$*" in *queue*) echo \'{"queue_running":[],"queue_pending":[]}\';; esac; exit 0',
  git: `case "$1" in clone) d="\${@: -1}"; mkdir -p "$d"; echo torch > "$d/requirements.txt";; esac
[ -n "\${FAIL_GIT:-}" ] && exit 1; exit 0`,
  python3: `[ "$1 $2" = "-m venv" ] && { mkdir -p "$3/bin"; cp "$ROOT/stubs/venvpython" "$3/bin/python"; }; exit 0`,
  venvpython: `echo "pip $*" >> "$ROOT/calls.log"; case "$*" in *torch\\ torchvision*) [ "\${FAIL_ON:-}" = torch ] && exit 1;; esac; exit 0`,
  aria2c: `while [ $# -gt 0 ]; do case "$1" in -d) d=$2; shift;; -o) o=$2; shift;; esac; shift; done
if [ "$o" = "\${FAIL_FILE:-}" ]; then echo part > "$d/$o"; echo ctl > "$d/$o.aria2"; exit 1; fi
echo model > "$d/$o"; rm -f "$d/$o.aria2"`,
};

/** A scratch root with the stubs on PATH and bootstrap.sh filled in, its absolute paths moved under the root. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-boot-'));
  const R = posix(root);
  fs.mkdirSync(path.join(root, 'stubs'));
  for (const [name, body] of Object.entries(STUBS)) {
    const log = name === 'venvpython' ? '' : `echo "${name} $*" >> "$ROOT/calls.log"\n`;
    fs.writeFileSync(path.join(root, 'stubs', name), `#!/bin/bash\n${log}${body}\n`, { mode: 0o755 });
  }
  const script = zlib.gunzipSync(Buffer.from(userData('TOKEN', 30), 'base64')).toString()
    .replace(/(?<![\w.:-])(\/(?:var|opt|etc|usr\/local|run|proc)\/|\/swapfile\b)/g, `${R}$1`);
  fs.writeFileSync(path.join(root, 'part-001'), script);
  for (const d of ['etc/systemd/system', 'etc/nginx/sites-available', 'etc/nginx/sites-enabled', 'usr/local/bin', 'usr/local/sbin', 'var/log/nginx', 'proc']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/fstab'), '');
  fs.writeFileSync(path.join(root, 'proc/uptime'), '600.00 1200.00\n');
  const sh = (file: string, args: string[] = [], env: Record<string, string> = {}) => {
    fs.rmSync(path.join(root, 'calls.log'), { force: true });
    const r = spawnSync(BASH!, ['-c', 'export PATH="$1:$PATH"; shift; exec bash "$@"', '_', `${R}/stubs`, `${R}/${file}`, ...args], {
      env: { ...process.env, ROOT: R, ...env }, encoding: 'utf8', timeout: 60_000,
    });
    const calls = fs.existsSync(path.join(root, 'calls.log')) ? fs.readFileSync(path.join(root, 'calls.log'), 'utf8') : '';
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
  };
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
  const status = () => JSON.parse(read('var/lib/gen/status.json'));
  const done = () => fs.readdirSync(path.join(root, 'var/lib/gen/done'));
  return { root, sh, read, status, done };
}

test('first boot hands over to gen-install.service', { skip }, () => {
  const s = sandbox();
  const r = s.sh('part-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /systemctl enable gen-install.service/);
  assert.match(r.calls, /systemctl start --no-block gen-install.service/);
  assert.match(s.read('usr/local/sbin/gen-install.sh'), /--service/);
  assert.match(s.read('etc/systemd/system/gen-install.service'), /ConditionPathExists=!.*\/var\/lib\/gen\/done\/ready/);
});

test('a stopped install resumes where it stopped', { skip }, () => {
  const s = sandbox();
  const models = loadManifest().models;
  const third = models[2];

  // Run 1: the third model's download breaks off (a stop, or the network).
  let r = s.sh('part-001', ['--service'], { FAIL_FILE: third.file });
  assert.equal(r.code, 1, r.out);
  let st = s.status();
  assert.equal(st.stage, 'failed');
  assert.equal(st.detail, `download ${third.file}`);
  assert.equal(st.run, 1);
  assert.match(st.lastFailure, /download/);
  assert.ok(s.done().includes('apt') && s.done().includes('torch') && s.done().includes(`model-${models[1].dir.replaceAll('/', '_')}-${models[1].file}`));
  assert.ok(fs.existsSync(path.join(s.root, 'opt/comfy/models', third.dir, `${third.file}.aria2`)), 'the partial download is kept');
  assert.match(s.read('usr/local/bin/gen-idle.sh'), /^IDLE_MINUTES=30$/m);

  // Run 2 (the next boot): nothing done is redone; the download continues (-c) and the server gets ready.
  r = s.sh('part-001', ['--service']);
  assert.equal(r.code, 0, r.out);
  st = s.status();
  assert.equal(st.stage, 'ready', r.out);
  assert.equal(st.run, 2);
  assert.equal(st.lastFailure, '');
  assert.match(r.out, /resuming the install \(run 2\)/);
  assert.doesNotMatch(r.calls, /apt-get/);
  assert.doesNotMatch(r.calls, /git clone/);
  assert.doesNotMatch(r.calls, /pip .*torch/);
  const fetched = [...r.calls.matchAll(/ -o (\S+) /g)].map((m) => m[1]);
  assert.deepEqual(fetched, models.slice(2).map((m) => m.file));
  assert.match(r.calls, /aria2c .* -c /);
  assert.match(r.calls, /systemctl restart comfyui/);

  // Run 3: ready, so the install does nothing.
  r = s.sh('part-001', ['--service']);
  assert.equal(r.code, 0);
  assert.equal(r.calls, '');
});

test('a pip step cut off part way is redone whole', { skip }, () => {
  const s = sandbox();
  let r = s.sh('part-001', ['--service'], { FAIL_ON: 'torch' });
  assert.equal(r.code, 1);
  assert.equal(s.status().detail, 'torch');
  r = s.sh('part-001', ['--service']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /pip -m pip install --force-reinstall torch torchvision/);
  assert.doesNotMatch(r.calls, /python3 -m venv/);
});

test('the idle stop powers off stuck and failed installs, and leaves progressing ones', { skip }, () => {
  const s = sandbox();
  s.sh('part-001', ['--service']); // writes gen-idle.sh
  const now = Math.floor(Date.now() / 1000);
  const check = (st: object, { uptime = 3600, dfUsed = 100, moved }: { uptime?: number; dfUsed?: number; moved?: number } = {}) => {
    fs.rmSync(path.join(s.root, 'shutdown'), { force: true });
    if (moved === undefined) fs.rmSync(path.join(s.root, 'run'), { recursive: true, force: true });
    else fs.writeFileSync(path.join(s.root, 'run/gen/install_moved'), String(moved));
    fs.writeFileSync(path.join(s.root, 'var/lib/gen/status.json'), JSON.stringify(st));
    fs.writeFileSync(path.join(s.root, 'proc/uptime'), `${uptime}.12 100.00\n`);
    fs.writeFileSync(path.join(s.root, 'df_used'), String(dfUsed));
    const r = s.sh('usr/local/bin/gen-idle.sh');
    assert.equal(r.code, 0, r.out);
    return fs.existsSync(path.join(s.root, 'shutdown'));
  };
  const installing = (ago: number, detail = 'model 1 of 15: x.safetensors') => ({ stage: 'downloading', detail, time: now - ago, run: 1, started: now - 900, lastFailure: '' });

  assert.equal(check(installing(60)), false, 'progressing');
  assert.equal(check(installing(60), { moved: now - 21 * 60 }), true, 'no progress since the last look, for 21 minutes');
  assert.equal(s.status().stage, 'failed');
  assert.match(s.status().lastFailure, /no progress for 20 minutes \(at: model 1 of 15: x.safetensors\)/);
  assert.equal(s.status().detail, 'model 1 of 15: x.safetensors');

  assert.equal(check(installing(25 * 60)), true, 'status 25 minutes old at the first look');
  assert.equal(check(installing(25 * 60), { uptime: 5 * 60 }), false, 'an old status from before this boot counts from the boot');
  assert.equal(check(installing(60), { uptime: 91 * 60 }), true, 'over 90 minutes this boot');
  assert.match(s.status().lastFailure, /over 90 minutes/);

  assert.equal(check({ stage: 'failed', detail: 'download "x"', time: now - 31 * 60 }), true, 'failed, past the grace period');
  assert.match(s.status().lastFailure, /install failed \(download "x"\)/);
  assert.equal(check({ stage: 'failed', detail: 'torch', time: now - 5 * 60 }), false, 'failed, within the grace period');

  fs.writeFileSync(path.join(s.root, 'var/lib/gen/last_busy'), '');
  assert.equal(check({ stage: 'ready', detail: 'ComfyUI', time: now - 9000 }), false, 'ready and recently busy: today\'s idle rule');
});

test('Gen flags a stuck install and knows a stopped one is unfinished', () => {
  const now = Date.now();
  const at = (minutesAgo: number) => Math.floor((now - minutesAgo * 60_000) / 1000);
  assert.equal(stuckFor({ stage: 'downloading', detail: 'model 3 of 15', time: at(4) }, now), null);
  assert.deepEqual(stuckFor({ stage: 'downloading', detail: 'model 3 of 15', time: at(12) }, now), { minutes: 12, detail: 'model 3 of 15' });
  assert.equal(stuckFor({ stage: 'ready', time: at(500) }, now), null);
  assert.equal(stuckFor({ stage: 'failed', time: at(500) }, now), null, 'failed is its own state, not stuck');

  assert.equal(unfinishedInstall({}), null);
  assert.equal(unfinishedInstall({ lastBoot: { stage: 'ready', run: 2 } }), null);
  assert.deepEqual(unfinishedInstall({ lastBoot: { stage: 'downloading', detail: 'model 1 of 15: x', run: 1 } }), { stage: 'downloading', detail: 'model 1 of 15: x', resumable: true });
  assert.deepEqual(unfinishedInstall({ lastBoot: { stage: 'failed', detail: 'torch', lastFailure: 'install made no progress for 20 minutes', run: 1 } })?.detail, 'install made no progress for 20 minutes');
  assert.equal(unfinishedInstall({ lastBoot: { stage: 'downloading', detail: 'model 1 of 15: x' } })?.resumable, false, 'launched with the old bootstrap.sh');
});
