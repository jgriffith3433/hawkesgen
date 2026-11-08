// unity.render (src/tools/unityrender.ts, docs/unity-render.md): the job check, the sync script (run for real where bash,
// tar, sha256sum and python3 are), and the routing that keeps it off the fleet and ComfyUI endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkJob, syncScript, unityRenderTool } from '../src/tools/unityrender.ts';
import { toolReady } from '../src/providers/gpu/route.ts';
import { getTool } from '../src/tools/index.ts';

const job = { video: 'hawkespunch', w: 1280, h: 720, fps: 24, quality: 'final', snapshot: { kind: 'manifest', manifestHash: 'aca4059912180831' }, shots: [{ id: 'c01', hash: 'abcdef012345', f0: 0, f1: 48 }, { id: 'c02', hash: '0123456789ab', f0: 48, f1: 120 }] };

test('unity.render: registered with its own image and family', () => {
  const t = getTool('unity.render');
  assert.equal(t?.image, 'unity-render');
  assert.equal(t?.family, 'unity-render');
});

test('unity.render: checkJob counts frames and refuses bad jobs', () => {
  assert.equal(checkJob(job).frames, 120);
  assert.throws(() => checkJob({ ...job, video: '../x' }), /video/);
  assert.throws(() => checkJob({ ...job, snapshot: { kind: 'manifest', manifestHash: 'nothex!' } }), /manifestHash/);
  assert.throws(() => checkJob({ ...job, shots: [{ id: 'a', hash: 'abcdef', f0: 5, f1: 5 }] }), /f0 < f1/);
  assert.throws(() => checkJob({ ...job, shots: [] }), /shots/);
  assert.throws(() => unityRenderTool.guard!({ params: { mode: 'sync' }, inputs: {} }), /pack/);
  assert.ok(unityRenderTool.gpuSeconds!({ job }) > 300);
});

test('unity.render: never on the fleet, only on an endpoint naming unity-render', () => {
  const t = getTool('unity.render')!;
  const settings = (families: string[]) => ({ gpu: { providers: [{ id: 'x', enabled: true, families }] } }) as any;
  assert.equal(toolReady(t, { fleetDown: false, settings: settings(['*']) }), false);
  assert.equal(toolReady(t, { fleetDown: true, settings: settings(['rig', 'blender']) }), false);
  assert.equal(toolReady(t, { fleetDown: true, settings: settings(['unity-render']) }), true);
  // The 3D tools still run on an up fleet.
  assert.equal(toolReady(getTool('blender.render')!, { fleetDown: false, settings: settings([]) }), true);
});

const hasTools = ['bash', 'tar', 'sha256sum', 'python3'].every((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0)
  && spawnSync('python3', ['-c', 'import json'], { stdio: 'ignore' }).status === 0;

test('unity.render: the sync script stores verified blobs and a complete manifest only', { skip: !hasTools && 'needs bash, tar, sha256sum, python3' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const vol = path.join(dir, 'vol'), job = path.join(dir, 'job'), x = path.join(dir, 'x');
  fs.mkdirSync(path.join(job, 'in'), { recursive: true }); fs.mkdirSync(x);
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const a = Buffer.from('alpha'), b = Buffer.from('beta');
  fs.writeFileSync(path.join(x, sha(a)), a);
  fs.writeFileSync(path.join(x, '0'.repeat(64)), b); // a name that lies about its bytes
  spawnSync('tar', ['-cf', path.join(job, 'in', 'pack.tar'), '-C', x, '.'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(job, 'in', 'manifest.json'), JSON.stringify({ hash: 'aaaabbbbccccdddd', files: { 'a.txt': sha(a), 'b.txt': sha(b) } }));
  fs.writeFileSync(path.join(job, 'run.sh'), syncScript());
  const env = { ...process.env, HAWKES_WEIGHTS: vol };
  const r1 = spawnSync('bash', ['run.sh'], { cwd: job, env, encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr);
  const store = path.join(vol, 'tkshock-farm', 'snapshots');
  assert.deepEqual(fs.readdirSync(path.join(store, 'blobs')), [sha(a)]);
  assert.match(r1.stdout, /dropped/);
  assert.equal(fs.existsSync(path.join(store, 'manifests', 'aaaabbbbccccdddd.json')), false, 'b is missing: no manifest');
  // The missing blob arrives: the manifest is saved.
  fs.rmSync(path.join(job, 'in', 'x'), { recursive: true, force: true });
  fs.rmSync(x, { recursive: true }); fs.mkdirSync(x); fs.writeFileSync(path.join(x, sha(b)), b);
  spawnSync('tar', ['-cf', path.join(job, 'in', 'pack.tar'), '-C', x, '.'], { stdio: 'ignore' });
  const r2 = spawnSync('bash', ['run.sh'], { cwd: job, env, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(fs.existsSync(path.join(store, 'manifests', 'aaaabbbbccccdddd.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(job, 'res', 'store.json'), 'utf8')).blobs, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
