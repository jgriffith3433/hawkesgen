// Unity cloud builds (docs/unity-cloudrun.md): which Library cache a build restores and saves, when a build runs clean,
// reading the container's result.json, the website stubs, and the Google API answers Gen reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const cache = await import('../src/providers/builder/cache.ts');
const gcp = await import('../src/providers/builder/gcp.ts');
const { cloudRunCost } = await import('../src/providers/builder/cloudrun.ts');
const { unityBackendOf, SETTINGS_DEFAULTS } = await import('../src/config.ts');

test('cache names are safe and repos are the project path', () => {
  assert.equal(cache.cacheRepo('YoobaLand/YoobaLand'), 'YoobaLand--YoobaLand');
  assert.equal(cache.cacheRepo('breakingthrough'), 'breakingthrough');
  assert.equal(cache.cacheName('agent/fix: menu'), 'agent--fix__menu');
  assert.equal(cache.cacheName('../../etc'), 'etc');
  assert.equal(cache.cacheName(''), 'default');
  assert.ok(cache.cacheName('x'.repeat(200)).length <= 64);
});

test('beta and main use their own cache and fall back to the other', () => {
  assert.deepEqual(cache.cacheKeys({ branch: 'beta' }), { restore: ['beta', 'main'], save: 'beta' });
  assert.deepEqual(cache.cacheKeys({ branch: 'main' }), { restore: ['main', 'beta'], save: 'main' });
});

test('any other branch restores beta then main and saves nothing', () => {
  assert.deepEqual(cache.cacheKeys({ branch: 'agent/c_123' }), { restore: ['beta', 'main'], save: null });
  assert.deepEqual(cache.cacheKeys({ branch: null }), { restore: ['beta', 'main'], save: null });
});

test('an explicit cache name is used for both restore and save', () => {
  assert.deepEqual(cache.cacheKeys({ branch: 'beta', explicit: 'pilot' }), { restore: ['pilot'], save: 'pilot' });
});

test('a broken Library looks like a cache failure; compile errors and licenses do not', () => {
  assert.equal(cache.failureKind('Failed to open the artifact database\nLMDB: MDB_CORRUPTED'), 'cache');
  assert.equal(cache.failureKind('Rebuilding Library because the asset database could not be found!'), 'cache');
  assert.equal(cache.failureKind('Received signal SIGSEGV\nNative Crash Reporting'), 'cache');
  assert.equal(cache.failureKind('Assets/Player.cs(12,5): error CS0103: The name x does not exist\nSIGSEGV'), 'other');
  assert.equal(cache.failureKind('ArtifactDB is fine but', 'license'), 'other');
  assert.equal(cache.failureKind('[GameDeploy] ERROR: Game/index.html missing'), 'other');
});

test('two cache-looking failures in a row make the next build clean; a success resets it', () => {
  const at = '2026-10-28T00:00:00Z';
  let s = cache.nextCacheState(undefined, { ok: false, failure: 'cache', at, job: 'j1' });
  assert.equal(s.streak, 1);
  assert.equal(cache.shouldRunClean(s).clean, false);
  // A compile error in between neither counts nor resets.
  s = cache.nextCacheState(s, { ok: false, failure: 'other', at, job: 'j2' });
  assert.equal(s.streak, 1);
  s = cache.nextCacheState(s, { ok: false, failure: 'cache', at, job: 'j3' });
  assert.equal(s.streak, 2);
  assert.equal(s.cleanNext, true);
  assert.equal(cache.shouldRunClean(s).clean, true);
  assert.match(cache.shouldRunClean(s).reason, /2 build/);
  // The clean build fails again for a cache-looking reason: still clean next time.
  s = cache.nextCacheState(s, { ok: false, failure: 'cache', at, job: 'j4', clean: true });
  assert.equal(s.cleanNext, true);
  s = cache.nextCacheState(s, { ok: true, at, job: 'j5', clean: true });
  assert.deepEqual([s.streak, s.cleanNext, s.lastBuild?.ok], [0, false, true]);
  assert.equal(cache.shouldRunClean(s).clean, false);
});

test('the clean-after threshold is configurable, and asking for clean always wins', () => {
  const s = cache.nextCacheState(undefined, { ok: false, failure: 'cache', at: 'now', job: 'j' }, 1);
  assert.equal(s.cleanNext, true);
  assert.equal(cache.shouldRunClean(undefined, true).clean, true);
});

test('recordBuild and forgetCache keep state per repo/key', () => {
  const repo = `test-${crypto.randomBytes(4).toString('hex')}`;
  cache.recordBuild(repo, 'beta', { ok: false, failure: 'cache', at: 'now', job: 'a' }, 1);
  cache.recordBuild(repo, 'main', { ok: true, at: 'now', job: 'b' });
  assert.equal(cache.cacheStateOf(repo, 'beta')?.cleanNext, true);
  cache.forgetCache(repo, 'beta');
  assert.equal(cache.cacheStateOf(repo, 'beta'), undefined);
  assert.ok(cache.cacheStateOf(repo, 'main'));
  cache.forgetCache(repo);
  assert.equal(cache.cacheStateOf(repo, 'main'), undefined);
});

const RESULT = {
  v: 1, ok: true, stage: 'save', kind: null, error: null, exitCode: 0,
  seconds: { license: 20, source: 40, cache: 70, unity: 300, output: 15, save: 50, total: 495 }, unity: '6000.3.7f1',
  cache: { restoredFrom: 'beta', restoredBytes: 1500000000, clean: false, reason: '', saved: true, savedKey: 'beta', savedBytes: 420000000, skipped: null },
  output: { object: 'unity-builds/j_1/site.tgz', bytes: 4500, changed: [{ path: 'Game/v8/Build/PlaceDepartment.wasm.unityweb', size: 4000 }, { path: 'Game/index.html', size: 500 }], deleted: ['Game/v7/.hawkes-stub', 'Game/v7/index.html'] },
  results: null, log: 'unity-builds/j_1/unity.log', memoryPeakBytes: 9876543210, errors: [],
};

test('a result.json parses', () => {
  const r = cache.parseCloudResult(JSON.stringify(RESULT));
  assert.equal(r.ok, true);
  assert.equal(r.output?.changed.length, 2);
  assert.equal(r.cache.restoredFrom, 'beta');
  assert.equal(r.seconds.total, 495);
  assert.equal(r.memoryPeakBytes, 9876543210);
});

test('a failed result keeps its kind and error; missing fields get defaults', () => {
  const r = cache.parseCloudResult('\uFEFF' + JSON.stringify({ ok: false, kind: 'license', error: 'no Unity license secret', stage: 'license' }));
  assert.deepEqual([r.ok, r.kind, r.error, r.stage, r.output, r.exitCode], [false, 'license', 'no Unity license secret', 'license', null, null]);
  assert.equal(r.cache.restoredFrom, null);
  assert.deepEqual(r.errors, []);
});

test('result paths that leave the site folder are dropped', () => {
  const r = cache.parseCloudResult(JSON.stringify({ ...RESULT, output: { ...RESULT.output, changed: [{ path: '../evil', size: 1 }, { path: '/etc/passwd', size: 1 }, { path: 'C:/x', size: 1 }, { path: 'Game\\v8\\a.js', size: 2 }], deleted: ['a/../../b', 'ok.txt'] } }));
  assert.deepEqual(r.output?.changed, [{ path: 'Game/v8/a.js', size: 2 }]);
  assert.deepEqual(r.output?.deleted, ['ok.txt']);
});

test('something that is not a result throws', () => {
  assert.throws(() => cache.parseCloudResult('not json'), /isn't JSON/);
  assert.throws(() => cache.parseCloudResult('{"stage":"x"}'), /no "ok"/);
});

test('website stubs: big files of numbered Game folders stay here; a deleted stub is a deleted folder', () => {
  assert.equal(cache.siteInputKeep('Game/v255/Build/a.data.unityweb', 50_000_000), false);
  assert.equal(cache.siteInputKeep('Game/v255/hawkes-sound.js', 3_000), true);
  assert.equal(cache.siteInputKeep('Game/v0000000/template.txt', 50_000_000), true);
  assert.equal(cache.siteInputKeep('index.html', 50_000_000), true);
  assert.equal(cache.stubFolderOf('Game/v7/.hawkes-stub'), 'Game/v7');
  assert.equal(cache.stubFolderOf('Game/v7/index.html'), null);
});

test('Cloud Run answers: the execution name and its state', () => {
  assert.equal(gcp.executionNameOf({ name: 'projects/p/locations/r/operations/o', metadata: { name: 'projects/p/locations/r/jobs/j/executions/j-abc' } }), 'projects/p/locations/r/jobs/j/executions/j-abc');
  assert.equal(gcp.executionNameOf({ name: 'op' }), null);
  const running = gcp.executionState({ runningCount: 1, startTime: '2026-10-28T10:00:00Z' });
  assert.deepEqual([running.done, running.running], [false, true]);
  const ok = gcp.executionState({ completionTime: '2026-10-28T10:09:00Z', succeededCount: 1, conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }] });
  assert.deepEqual([ok.done, ok.succeeded, ok.cancelled], [true, true, false]);
  const bad = gcp.executionState({ completionTime: 'x', failedCount: 1, conditions: [{ type: 'Completed', state: 'CONDITION_FAILED', message: 'Task hawkes-unity-build-abc-task0 failed: memory limit exceeded' }] });
  assert.deepEqual([bad.done, bad.succeeded], [true, false]);
  assert.match(bad.message, /memory limit/);
  assert.deepEqual(gcp.parseGs('gs://hawkes-unity/unity-builds/j/spec.json'), { bucket: 'hawkes-unity', key: 'unity-builds/j/spec.json' });
});

test('a service-account assertion is a valid RS256 JWT', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = gcp.serviceAccountAssertion({ client_email: 'hawkes-gen@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }, 1000);
  const [h, b, s] = jwt.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const body = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.deepEqual([body.iss, body.iat, body.exp, body.aud], ['hawkes-gen@p.iam.gserviceaccount.com', 1000, 4600, 'https://oauth2.googleapis.com/token']);
});

test('the backend: param, then the project, then the default', () => {
  const u = { ...SETTINGS_DEFAULTS.unityBuild, backend: 'cloudrun' as const, projects: { 'sickofitgame-unity': 'builder' as const } };
  assert.equal(unityBackendOf({ project: 'breakingthrough' }, u), 'cloudrun');
  assert.equal(unityBackendOf({ project: 'sickofitgame-unity' }, u), 'builder');
  assert.equal(unityBackendOf({ project: 'sickofitgame-unity', backend: 'cloudrun' }, u), 'cloudrun');
  assert.equal(unityBackendOf({ project: 'x', backend: 'auto' }, { ...u, backend: 'builder' }), 'builder');
});

test('a cloud build costs its seconds at 8 vCPU and 32 GiB', () => {
  // 10 minutes: 600 * (8 * 0.000018 + 32 * 0.000002) = 600 * 0.000208
  assert.equal(Math.round(cloudRunCost(600) * 10000) / 10000, 0.1248);
});

const vm = await import('../src/providers/builder/vm.ts');
const { shouldMoveToVm, licenseMessage } = await import('../src/providers/builder/cloudrun.ts');

test('the build VM is named after the project, as Compute Engine allows', () => {
  assert.equal(vm.vmName('sickofitgame-unity'), 'hawkes-unity-sickofitgame-unity');
  assert.equal(vm.vmName('YoobaLand/YoobaLand'), 'hawkes-unity-yoobaland-yoobaland');
  assert.ok(vm.vmName('x'.repeat(100)).length <= 63);
  assert.match(vm.vmName('A_B.c'), /^[a-z]([-a-z0-9]*[a-z0-9])?$/);
});

test('instance states while waiting for a build', () => {
  assert.equal(vm.vmPhase('STAGING'), 'starting');
  assert.equal(vm.vmPhase('RUNNING'), 'running');
  assert.equal(vm.vmPhase('STOPPING'), 'stopping');
  assert.equal(vm.vmPhase('TERMINATED'), 'stopped');
  assert.equal(vm.vmPhase('SUSPENDED'), 'stopped');
});

test('a Cloud Run build over 85% of its memory, or killed for memory, moves to the VM', () => {
  const limit = 32 * 1024 ** 3;
  assert.equal(shouldMoveToVm({ peakBytes: 0.9 * limit, limitBytes: limit, oom: false, at: 0.85 }), 'peak');
  assert.equal(shouldMoveToVm({ peakBytes: 0.8 * limit, limitBytes: limit, oom: false, at: 0.85 }), null);
  assert.equal(shouldMoveToVm({ peakBytes: null, limitBytes: limit, oom: true, at: 0.85 }), 'oom');
  assert.equal(shouldMoveToVm({ peakBytes: limit, limitBytes: limit, oom: true, at: 0 }), null);
});

test('instance metadata: set and remove keys, keep the others', () => {
  const items = [{ key: 'startup-script', value: '#!/bin/bash' }, { key: 'hawkes-spec', value: 'gs://old' }, { key: 'hawkes-image', value: 'img' }];
  assert.deepEqual(gcp.mergeMetadata(items, { 'hawkes-spec': 'gs://new', 'hawkes-job': 'j_1' }), [
    { key: 'startup-script', value: '#!/bin/bash' }, { key: 'hawkes-image', value: 'img' }, { key: 'hawkes-spec', value: 'gs://new' }, { key: 'hawkes-job', value: 'j_1' },
  ]);
  assert.deepEqual(gcp.mergeMetadata(items, { 'hawkes-spec': null }).map((x) => x.key), ['startup-script', 'hawkes-image']);
});

test('"vm" is a backend per project; a license failure names the two secrets', () => {
  const u = { ...SETTINGS_DEFAULTS.unityBuild, backend: 'cloudrun' as const, projects: { 'sickofitgame-unity': 'vm' as const } };
  assert.equal(unityBackendOf({ project: 'sickofitgame-unity' }, u), 'vm');
  assert.equal(unityBackendOf({ project: 'breakingthrough' }, u), 'cloudrun');
  assert.match(licenseMessage('Unity refused the email or password'), /unity-email and unity-password/);
});
