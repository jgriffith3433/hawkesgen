// The fleet image: manifestKey (what an image must match), firstboot.sh's user data, and dry runs of
// server/firstboot.sh and server/image-prep.sh in a scratch root with the system commands stubbed (like
// bootstrap.test.ts). Skips the dry runs without a bash (on Windows it needs Git Bash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const { manifestKey, loadManifest, imageUserData } = await import('../src/providers/comfy/fleet.ts');

const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p)) : '/bin/bash';
const skip = BASH ? false : 'no bash here';
const posix = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/') : p);
const ROOTED = /(?<![\w.:-])(\/(?:var|opt|etc|usr\/local|run|home|root|tmp)\/)/g;

test('manifestKey ignores descriptions and changes with any model, node or ComfyUI tag', () => {
  const m = loadManifest();
  const key = manifestKey(m);
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.equal(manifestKey({ ...m, _about: 'changed' } as any), key);
  assert.notEqual(manifestKey({ ...m, comfyui: { ...m.comfyui, tag: 'v9.9.9' } }), key);
  assert.notEqual(manifestKey({ ...m, models: m.models.slice(1) }), key);
  assert.notEqual(manifestKey({ ...m, nodes: m.nodes.map((n, i) => (i ? n : { ...n, commit: 'abc' })) }), key);
});

test('image user data fills every placeholder', () => {
  const script = zlib.gunzipSync(Buffer.from(imageUserData('TOKEN123', 25, 'ami-0abc'), 'base64')).toString();
  assert.doesNotMatch(script, /__[A-Z_]+__/);
  assert.match(script, /htpasswd -bc \/etc\/nginx\/gen.htpasswd gen 'TOKEN123'/);
  assert.match(script, /IDLE_MINUTES=25/);
  assert.match(script, /ami-0abc/);
  for (const x of loadManifest().models) assert.ok(script.includes(`${x.dir}/${x.file}`), x.file);
  assert.ok(Buffer.from(imageUserData('T', 20, 'ami-1'), 'base64').length < 16 * 1024, 'EC2 user data is at most 16 KB');
});

function sandbox(stubs: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-img-'));
  const R = posix(root);
  fs.mkdirSync(path.join(root, 'stubs'));
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(root, 'stubs', name), `#!/bin/bash\necho "${name} $*" >> "$ROOT/calls.log"\n${body}\n`, { mode: 0o755 });
  }
  const put = (p: string, data = '') => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), data);
  };
  const run = (script: string, args: string[] = [], env: Record<string, string> = {}) => {
    put('script.sh', script.replace(ROOTED, `${R}$1`));
    fs.rmSync(path.join(root, 'calls.log'), { force: true });
    const r = spawnSync(BASH!, ['-c', 'export PATH="$1:$PATH"; shift; exec bash "$@"', '_', `${R}/stubs`, `${R}/script.sh`, ...args], {
      env: { ...process.env, ROOT: R, ...env }, encoding: 'utf8', timeout: 60_000,
    });
    const calls = fs.existsSync(path.join(root, 'calls.log')) ? fs.readFileSync(path.join(root, 'calls.log'), 'utf8') : '';
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
  };
  const has = (p: string) => fs.existsSync(path.join(root, p));
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
  return { root, R, put, run, has, read };
}

test('first boot from the image sets the password and idle time, starts ComfyUI and warms the disk', { skip }, () => {
  const s = sandbox({ htpasswd: '', chown: '', systemctl: '', curl: 'exit 0', 'systemd-run': '', sleep: '' });
  s.put('usr/local/bin/gen-idle.sh', '#!/bin/bash\nIDLE_MINUTES=20\n');
  s.put('etc/nginx/x', '');
  s.put('var/log/x', '');
  s.put('usr/local/sbin/x', '');
  const script = zlib.gunzipSync(Buffer.from(imageUserData('TOK', 45, 'ami-0123'), 'base64')).toString();
  const r = s.run(script);
  assert.equal(r.code, 0, r.out + s.read('var/log/gen-bootstrap.log'));
  assert.match(r.calls, /htpasswd -bc .*\/etc\/nginx\/gen\.htpasswd gen TOK[\s\S]*systemctl restart nginx[\s\S]*systemctl stop comfyui/);
  assert.match(r.calls, /systemctl restart comfyui/);
  assert.match(r.calls, /systemctl enable --now gen-idle.timer/);
  assert.match(r.calls, /systemd-run --unit gen-warm/);
  assert.match(s.read('usr/local/bin/gen-idle.sh'), /^IDLE_MINUTES=45$/m);
  const st = JSON.parse(s.read('var/lib/gen/status.json'));
  assert.equal(st.stage, 'ready');
  assert.equal(st.image, 'ami-0123');
  assert.ok(s.has('var/lib/gen/last_busy'));
  assert.equal(s.read('var/lib/gen/core.txt').trim().split('\n').length, loadManifest().models.length);
});

test('first boot cleans an image made as is: leftovers, non-core models and a wrong-sized core model go', { skip }, () => {
  const s = sandbox({ htpasswd: '', chown: '', systemctl: '', curl: 'exit 0', 'systemd-run': '', sleep: '' });
  s.put('usr/local/bin/gen-idle.sh', 'IDLE_MINUTES=20\n');
  s.put('etc/nginx/x', '');
  s.put('var/log/x', '');
  const [a, b] = loadManifest().models;
  s.put(`opt/comfy/models/${a.dir}/${a.file}`, 'good');
  s.put(`opt/comfy/models/${b.dir}/${b.file}`, 'go'); // truncated by a restart
  s.put('opt/comfy/models/diffusion_models/z_image_turbo_bf16.safetensors', 'partial');
  s.put('opt/comfy/models/vae/x.safetensors.aria2', 'ctl');
  s.put('opt/comfy/models/checkpoints/put_checkpoints_here', '');
  s.put('opt/comfy.partial/models/big', 'x');
  const sizes = { [`${a.dir}/${a.file}`]: 4, [`${b.dir}/${b.file}`]: 4 };
  const r = s.run(zlib.gunzipSync(Buffer.from(imageUserData('TOK', 20, 'ami-1', sizes), 'base64')).toString());
  assert.equal(r.code, 0, r.out + s.read('var/log/gen-bootstrap.log'));
  assert.ok(s.has(`opt/comfy/models/${a.dir}/${a.file}`));
  for (const gone of [`opt/comfy/models/${b.dir}/${b.file}`, 'opt/comfy/models/diffusion_models/z_image_turbo_bf16.safetensors', 'opt/comfy/models/vae/x.safetensors.aria2', 'opt/comfy.partial']) {
    assert.ok(!s.has(gone), `${gone} should be gone`);
  }
  assert.ok(s.has('opt/comfy/models/checkpoints/put_checkpoints_here'));
  assert.equal(s.read('var/lib/gen/warm.txt').trim(), `${a.dir}/${a.file}`);
  assert.equal(JSON.parse(s.read('var/lib/gen/status.json')).stage, 'ready');
});

test('first boot that cannot start ComfyUI fails (the idle stop then powers it off: terminated when disposable)', { skip }, () => {
  const s = sandbox({ htpasswd: '', chown: '', systemctl: '', curl: 'exit 7', 'systemd-run': '', sleep: '' });
  s.put('usr/local/bin/gen-idle.sh', 'IDLE_MINUTES=20\n');
  s.put('etc/nginx/x', '');
  s.put('var/log/x', '');
  const r = s.run(zlib.gunzipSync(Buffer.from(imageUserData('TOK', 20, 'ami-1'), 'base64')).toString());
  assert.equal(r.code, 1);
  const st = JSON.parse(s.read('var/lib/gen/status.json'));
  assert.equal(st.stage, 'failed');
  assert.match(st.detail, /ComfyUI did not start/);
});

const PREP_STUBS = {
  systemctl: '',
  journalctl: '',
  'cloud-init': '',
  sleep: '',
  df: 'echo Used; echo 171G',
  git: `case "$*" in *describe*) echo v0.40.0;; *rev-parse*) echo "\${NODE_COMMIT:-d7641533d663ffff}";; esac`,
  aria2c: `while [ $# -gt 0 ]; do case "$1" in -d) d=$2; shift;; -o) o=$2; shift;; esac; shift; done
printf '%s' "\${DOWNLOAD:-good}" > "$d/$o"`,
};

function prepBox() {
  const s = sandbox(PREP_STUBS);
  s.put('opt/comfy/main.py', '');
  s.put('opt/comfy/custom_nodes/ComfyUI-KJNodes/.git/HEAD', '');
  s.put('opt/comfy.partial/models/big.safetensors', 'x');
  s.put('opt/comfy/models/checkpoints/put_checkpoints_here', '');
  s.put('opt/comfy/models/diffusion_models/core.safetensors', 'good');
  s.put('opt/comfy/models/vae/short.safetensors', 'go'); // truncated (a restart cut it)
  s.put('opt/comfy/models/diffusion_models/z_image_turbo_bf16.safetensors', 'not core');
  s.put('opt/comfy/models/loras/hawkes/char.safetensors', 'trained');
  s.put('opt/comfy/models/vae/half.safetensors.aria2', 'ctl');
  s.put('opt/comfy/output/out.png', 'x');
  s.put('etc/nginx/gen.htpasswd', 'gen:x');
  s.put('etc/ssh/ssh_host_ed25519_key', 'k');
  s.put('etc/machine-id', 'abc');
  s.put('home/ubuntu/.ssh/authorized_keys', 'ssh-ed25519 AAA');
  s.put('var/lib/gen/status.json', '{}');
  s.put('var/lib/gen/last_busy', '');
  s.put('var/lib/gen/done/apt', '');
  s.put('var/log/gen-bootstrap.log', 'log');
  const sha = crypto.createHash('sha256').update('good').digest('hex');
  s.put('list.txt', `diffusion_models core.safetensors 4 ${sha} https://x/core\nvae short.safetensors 4 ${sha} https://x/short\n`);
  return s;
}

test('image prep keeps only verified core models, fixes a truncated one and strips per-server state', { skip }, () => {
  const s = prepBox();
  const r = s.run(fs.readFileSync('server/image-prep.sh', 'utf8'), [`${s.R}/list.txt`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PREP OK\s*$/);
  assert.match(r.out, /^comfy=v0\.40\.0$/m);
  assert.match(r.out, /^node=ComfyUI-KJNodes d7641533d663/m);
  assert.match(r.out, /^used=171$/m);
  assert.match(r.out, /^fixed vae\/short\.safetensors 4$/m);
  assert.match(r.calls, /aria2c .*-o short\.safetensors https:\/\/x\/short/);
  assert.equal(s.read('opt/comfy/models/vae/short.safetensors'), 'good');
  assert.ok(s.has('opt/comfy/models/diffusion_models/core.safetensors'));
  assert.ok(s.has('opt/comfy/models/checkpoints/put_checkpoints_here'));
  for (const gone of ['opt/comfy.partial', 'opt/comfy/models/diffusion_models/z_image_turbo_bf16.safetensors', 'opt/comfy/models/loras/hawkes/char.safetensors',
    'opt/comfy/models/vae/half.safetensors.aria2', 'opt/comfy/output/out.png', 'etc/nginx/gen.htpasswd', 'etc/ssh/ssh_host_ed25519_key',
    'home/ubuntu/.ssh/authorized_keys', 'var/lib/gen/status.json', 'var/lib/gen/last_busy', 'var/log/gen-bootstrap.log']) {
    assert.ok(!s.has(gone), `${gone} should be gone`);
  }
  assert.equal(s.read('etc/machine-id'), '');
  assert.ok(s.has('var/lib/gen/done/ready'), 'the install service stays off on the image');
  assert.match(r.calls, /cloud-init clean --logs/);
});

test('image prep fails, and puts the server back, when a core model is still wrong after downloading', { skip }, () => {
  const s = prepBox();
  const r = s.run(fs.readFileSync('server/image-prep.sh', 'utf8'), [`${s.R}/list.txt`], { DOWNLOAD: 'bad!' });
  assert.equal(r.code, 1);
  assert.match(r.out, /BAD vae\/short\.safetensors: sha256 doesn't match/);
  assert.match(r.out, /PREP FAILED/);
  assert.doesNotMatch(r.out, /PREP OK/);
  assert.match(r.calls, /systemctl start gen-idle.timer nginx comfyui/);
  assert.ok(s.has('etc/nginx/gen.htpasswd'), 'nothing stripped');
  assert.ok(s.has('home/ubuntu/.ssh/authorized_keys'));
});
