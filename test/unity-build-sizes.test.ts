// Machine sizes of customer Unity builds (src/providers/builder/sizes.ts; docs/unity-cloudrun.md, "Machine sizes"):
// the sizes and their Cloud Run combinations, a job per size, the job made or brought in line from the customer job, the
// fallback when it can't be, one size up after running out of memory. A fake Cloud Run API: nothing real is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sizes-'));
const S = await import('../src/providers/builder/sizes.ts');
const { loadSettings } = await import('../src/config.ts');

const gcp = { sizes: S.DEFAULT_SIZES, customerSize: 'm' };

test('settings: the four sizes and m by default; bad sizes dropped, a bad default falls back to m', () => {
  const g = loadSettings().unityBuild.gcp;
  assert.deepEqual(g.sizes, { s: { cpu: 2, memoryGiB: 8 }, m: { cpu: 4, memoryGiB: 16 }, l: { cpu: 6, memoryGiB: 24 }, xl: { cpu: 8, memoryGiB: 32 } });
  assert.equal(g.customerSize, 'm');
  const sizes = S.cleanSizes({ tiny: { cpu: 2, memoryGiB: 4 }, bad: { cpu: 2, memoryGiB: 16 }, 'Not ok': { cpu: 4, memoryGiB: 8 }, m: { cpu: 4, memoryGiB: 16 } });
  assert.deepEqual(Object.keys(sizes), ['tiny', 'm']);
  assert.equal(S.cleanCustomerSize('nope', sizes), 'm');
  assert.equal(S.cleanCustomerSize('tiny', sizes), 'tiny');
  assert.deepEqual(S.cleanSizes(null), S.DEFAULT_SIZES);
});

test('Cloud Run combinations: 2 vCPU up to 8 GiB, 4 up to 16, 6 up to 24, 8 up to 32', () => {
  for (const [cpu, max] of [[2, 8], [4, 16], [6, 24], [8, 32]]) {
    assert.equal(S.machineProblem(cpu, max), null);
    assert.match(String(S.machineProblem(cpu, max + 1)), /GiB of memory/);
  }
  assert.match(String(S.machineProblem(1, 2)), /cpu must be/);
  assert.match(String(S.machineProblem(4, 7.5)), /whole number/);
});

test('resolveMachine: a name, numbers (named when they match), the default', () => {
  assert.deepEqual(S.resolveMachine(undefined, gcp), { name: 'm', cpu: 4, memoryGiB: 16 });
  assert.deepEqual(S.resolveMachine('L', gcp), { name: 'l', cpu: 6, memoryGiB: 24 });
  assert.deepEqual(S.resolveMachine('{"cpu":2,"memoryGiB":8}', gcp), { name: 's', cpu: 2, memoryGiB: 8 });
  assert.deepEqual(S.resolveMachine({ cpu: 4, memoryGiB: 12 }, gcp), { name: '4c12g', cpu: 4, memoryGiB: 12 });
  assert.throws(() => S.resolveMachine({ cpu: 4, memoryGiB: 12, gpu: 1 }, gcp), /not gpu/);
  assert.throws(() => S.resolveMachine(['s'], gcp), /size name/);
});

test('the job of a size: the customer job for its own size (xl, as before), "<job>-<size>" for the others', () => {
  const own = { cpu: 8, memoryGiB: 32 };
  assert.equal(S.sizedJobName('hawkes-unity-build-customer', { name: 'xl', cpu: 8, memoryGiB: 32 }, own), 'hawkes-unity-build-customer');
  assert.equal(S.sizedJobName('hawkes-unity-build-customer', { name: 'm', cpu: 4, memoryGiB: 16 }, own), 'hawkes-unity-build-customer-m');
  assert.equal(S.sizedJobName('hawkes-unity-6000-0-customer', { name: '4c12g', cpu: 4, memoryGiB: 12 }, own), 'hawkes-unity-6000-0-customer-4c12g');
});

test('one size up: the next named size with more memory, none past the biggest', () => {
  assert.equal(S.nextBigger({ name: 's', cpu: 2, memoryGiB: 8 }, S.DEFAULT_SIZES)?.name, 'm');
  assert.equal(S.nextBigger({ name: '4c12g', cpu: 4, memoryGiB: 12 }, S.DEFAULT_SIZES)?.name, 'm');
  assert.equal(S.nextBigger({ name: 'l', cpu: 6, memoryGiB: 24 }, S.DEFAULT_SIZES)?.name, 'xl');
  assert.equal(S.nextBigger({ name: 'xl', cpu: 8, memoryGiB: 32 }, S.DEFAULT_SIZES), null);
});

/** A fake Cloud Run v2 jobs API over a map of job name -> resource. */
function fakeApi(jobs: Record<string, any>, o: { createFails?: boolean } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const api = async (url: string, init: { method?: string; body?: unknown; missingOk?: boolean } = {}) => {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    calls.push({ method, url, body: init.body });
    const create = /\/jobs\?jobId=(.+)$/.exec(url);
    if (create) {
      if (o.createFails) throw new Error('Google Cloud answered 403: Permission run.jobs.create denied');
      jobs[decodeURIComponent(create[1])] = init.body;
      return { name: 'operations/op-1', done: true };
    }
    const name = /\/jobs\/([^/?:]+)$/.exec(url)?.[1] ?? '';
    if (method === 'PATCH') { jobs[name] = init.body; return { name: 'operations/op-2', done: true }; }
    return jobs[name] ?? null;
  };
  return { api, calls };
}
const base = (image = 'img:v2') => ({
  name: 'projects/p/locations/us-east4/jobs/hawkes-unity-build-customer', uid: 'u-1', etag: 'e', labels: { project: 'hawkes-gen', 'run.googleapis.com/x': 'y' }, launchStage: 'GA',
  template: { taskCount: 1, template: { serviceAccount: 'unity-customer@p.iam.gserviceaccount.com', timeout: '3300s', maxRetries: 0, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
    containers: [{ image, env: [{ name: 'HAWKES_CUSTOMER_JOB', value: '1' }], resources: { limits: { cpu: '8', memory: '32Gi' } } }] } },
});
const M = { name: 'm', cpu: 4, memoryGiB: 16 };
const T = { project: 'p', region: 'us-east4', job: 'hawkes-unity-build-customer' };

test('ensure: made from the customer job (its template, other limits, Google\'s own labels left out); then left alone', async () => {
  const jobs: Record<string, any> = { 'hawkes-unity-build-customer': base() };
  const f = fakeApi(jobs);
  assert.equal(await S.ensureSizedJobIn(T, 'hawkes-unity-build-customer-m', M, f.api), 'made');
  const made = jobs['hawkes-unity-build-customer-m'];
  assert.deepEqual(made.template.template.containers[0].resources.limits, { cpu: '4', memory: '16Gi' });
  assert.equal(made.template.template.containers[0].image, 'img:v2');
  assert.equal(made.template.template.serviceAccount, 'unity-customer@p.iam.gserviceaccount.com');
  assert.equal(made.uid, undefined);
  assert.equal(made.labels['run.googleapis.com/x'], undefined);
  assert.equal(made.labels['hawkes-size'], 'm');
  assert.deepEqual(base().template.template.containers[0].resources.limits, { cpu: '8', memory: '32Gi' }, 'the customer job itself is untouched');
  assert.equal(await S.ensureSizedJobIn(T, 'hawkes-unity-build-customer-m', M, f.api), 'ok');
  assert.ok(!f.calls.slice(-2).some((c) => c.method !== 'GET'));
});

test('ensure: a new image on the customer job reaches the size\'s job (patched), no customer job is "nobase"', async () => {
  const jobs: Record<string, any> = { 'hawkes-unity-build-customer': base('img:v2') };
  const f = fakeApi(jobs);
  await S.ensureSizedJobIn(T, 'hawkes-unity-build-customer-m', M, f.api);
  jobs['hawkes-unity-build-customer'] = base('img:v3');
  assert.equal(await S.ensureSizedJobIn(T, 'hawkes-unity-build-customer-m', M, f.api), 'updated');
  assert.equal(jobs['hawkes-unity-build-customer-m'].template.template.containers[0].image, 'img:v3');
  assert.match(f.calls.find((c) => c.method === 'PATCH')!.url, /jobs\/hawkes-unity-build-customer-m$/);
  assert.equal(await S.ensureSizedJobIn({ ...T, job: 'nope' }, 'nope-m', M, fakeApi({}).api), 'nobase');
});

test('the job for a size: made where the customer job is; when it can\'t be made, the customer job with a warning', async () => {
  S.forgetSizedJobs();
  const own = { cpu: 8, memoryGiB: 32 };
  const ok = fakeApi({ 'hawkes-unity-build-customer': base() });
  const r1 = await S.customerJobForMachine({ base: T.job, machine: M, own, project: 'p', regions: ['us-east4'], api: ok.api });
  assert.deepEqual(r1, { job: 'hawkes-unity-build-customer-m', machine: M });
  S.forgetSizedJobs();
  const denied = fakeApi({ 'hawkes-unity-build-customer': base() }, { createFails: true });
  const r2 = await S.customerJobForMachine({ base: T.job, machine: M, own, project: 'p', regions: ['us-east4'], sizes: S.DEFAULT_SIZES, api: denied.api });
  assert.equal(r2.job, 'hawkes-unity-build-customer');
  assert.deepEqual(r2.machine, { name: 'xl', cpu: 8, memoryGiB: 32 });
  assert.match(String(r2.warning), /run\.jobs\.create denied/);
  // Its own size: the customer job, nothing asked of Cloud Run.
  const none = fakeApi({});
  assert.deepEqual(await S.customerJobForMachine({ base: T.job, machine: { name: 'xl', ...own }, own, project: 'p', regions: ['us-east4'], api: none.api }), { job: T.job, machine: { name: 'xl', ...own } });
  assert.equal(none.calls.length, 0);
});
