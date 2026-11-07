// A job never sits forever with nothing running it (src/providers/gpu/nogpu.ts, docs/gpu-providers.md "When no GPU can
// run a job"). 2026-11-02: a video edit sat at "starting" for 20 minutes and more, "picked up again after a restart (0
// done)" five times, with RunPod out of credit and the AWS fleet refusing Gen's keys. Here, with no account anywhere:
// the verdict (fail now / wait / fail after the limit), which routing reasons are lasting, a GPU job with no usable
// provider failing at once in plain words through the queue, a job whose input file is gone failing instead of hanging,
// a job cut off by too many restarts stopping, and a pipeline's steps stopping with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-no-gpu-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
process.env.HAWKESGEN_PUBLIC_URL = 'https://gen.example.test';
delete process.env.K_SERVICE;

const { noGpuVerdict, NO_GPU_ERROR, noGpuAfter, waitSinceOf } = await import('../src/providers/gpu/nogpu.ts');
const { gpuCandidates } = await import('../src/providers/gpu/route.ts');
const { markDown, resetHealth, COOLDOWN } = await import('../src/providers/gpu/health.ts');
const { setRunpodCredit } = await import('../src/providers/gpu/credit.ts');
const { loadServiceMap } = await import('../src/providers/cloudrun/services.ts');
const { saveSettings, SETTINGS_DEFAULTS, loadSettings } = await import('../src/config.ts');
const { publicText } = await import('../src/publictext.ts');

const map = loadServiceMap();
const comfyTool = { provider: 'comfy', gpuSeconds: () => 30 } as any;
const ep = (over: any = {}) => ({ id: 'runpod-a', provider: 'runpod', url: 'https://abc.api.runpod.ai', families: ['*'], gpu: 'L40S', pricePerHour: 1.75, maxConcurrent: 2, graphLimitSeconds: 3300, enabled: true, ...over });
const gpuSettings = (gpu: any = {}) => ({ gpu: { backend: 'fleet', families: {}, providers: [], order: [], familyOrder: {}, ...gpu, cloudrun: { bucket: 'bkt', urls: {}, services: {} } } }) as any;
const KEYS: Record<string, string> = { RUNPOD_API_KEY: 'rp-key' };
const get = (k: string) => KEYS[k];
const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
const job = { family: 'z-image', params: {}, labels: {} };

// ------------------------------------------------------------------ the verdict

test('verdict: every provider out for good fails at once, in plain words', () => {
  const v = noGpuVerdict([{ reason: 'runpod-a: RunPod is out of credit', lasting: true }, { reason: 'fleet: AWS refused Gen', lasting: true }], null, 15, 1000);
  assert.equal(v.fail, true);
  assert.equal((v as any).error, NO_GPU_ERROR);
  assert.match((v as any).log, /out of credit.*AWS refused/);
  // Nothing set up at all is the same.
  assert.equal(noGpuVerdict([], null, 15).fail, true);
  // What the person reads names no provider, before or after publictext.ts.
  assert.doesNotMatch(NO_GPU_ERROR, /runpod|aws|modal|fleet|cloud/i);
  assert.equal(publicText(NO_GPU_ERROR), NO_GPU_ERROR);
});

test('verdict: something that may come free waits, at most queue.gpuWaitMinutes, then fails', () => {
  const blockers = [{ reason: 'mod: no modal GPU came free (skipped for 5 min)', lasting: false }, { reason: 'runpod-a: out of credit', lasting: true }];
  const first = noGpuVerdict(blockers, null, 15, 1_000_000);
  assert.equal(first.fail, false);
  assert.equal(first.since, 1_000_000, 'the clock starts at the first look');
  assert.match((first as any).detail, /stops in 15 min/);
  const later = noGpuVerdict(blockers, first.since, 15, 1_000_000 + 10 * 60_000);
  assert.equal(later.fail, false);
  assert.match((later as any).detail, /stops in 5 min/);
  const over = noGpuVerdict(blockers, first.since, 15, 1_000_000 + 15 * 60_000);
  assert.equal(over.fail, true);
  assert.equal((over as any).error, noGpuAfter(15));
  assert.equal(waitSinceOf({ gpuWaitSince: 5 }), 5);
  assert.equal(waitSinceOf({}), null);
});

// ------------------------------------------------------------------ which routing reasons last

test('routing: no credit, no key, a key refused and nothing set up are lasting; a capacity cooldown and a tried provider pass', () => {
  resetHealth();
  setRunpodCredit({ balance: -0.01, at: Date.now() });
  try {
    const s = gpuSettings({ providers: [ep(), ep({ id: 'mod', provider: 'modal', url: 'https://m.modal.run' })], order: ['runpod-a', 'mod', 'nowhere'] });
    let c = gpuCandidates(job, comfyTool, s, map, Date.now(), get);
    assert.equal(c.choices.length, 0);
    assert.deepEqual(c.blockers.map((b: any) => b.lasting), [true, true, true], JSON.stringify(c.blockers));
    assert.match(c.blockers[0].reason, /out of credit/);
    assert.match(c.blockers[1].reason, /MODAL/);
    // Credit back, but RunPod cooling down after "no GPU free": that passes.
    setRunpodCredit({ balance: 20, at: Date.now() });
    markDown('runpod-a', 'no GPU came free', COOLDOWN.capacity);
    c = gpuCandidates(job, comfyTool, s, map, Date.now(), get);
    assert.equal(c.blockers[0].lasting, false);
    // A key refused cools down for half an hour: lasting.
    markDown('runpod-a', 'RunPod refused Gen\'s credentials', COOLDOWN.auth);
    c = gpuCandidates(job, comfyTool, s, map, Date.now(), get);
    assert.equal(c.blockers[0].lasting, true);
    resetHealth();
    c = gpuCandidates({ ...job, labels: { gpuTried: ['runpod-a'] } }, comfyTool, s, map, Date.now(), get);
    assert.equal(c.blockers[0].lasting, false, 'this job failed there once: the line moves, it may again');
  } finally {
    setRunpodCredit(null);
    resetHealth();
  }
});

// ------------------------------------------------------------------ through the queue

const settle = async (getJob: (id: string) => any, id: string, until = ['done', 'failed', 'cancelled']) => {
  const { queue } = await import('../src/jobs.ts');
  for (let i = 0; i < 200 && !until.includes(getJob(id)!.status); i++) {
    (queue as any).pump();
    await new Promise((r) => setTimeout(r, 20));
  }
  return getJob(id)!;
};

test('the queue: a GPU job no provider can run fails at once, refunded, with the reasons in its log (no wait, no restart loop)', async () => {
  resetHealth();
  Object.assign(process.env, KEYS);
  setRunpodCredit({ balance: -0.01, at: Date.now() });
  saveSettings({ gpu: { providers: [ep()], order: ['runpod-a'], cloudrun: { bucket: 'bkt', urls: {}, services: {} } } } as any);
  try {
    const { submit, getJob } = await import('../src/jobs.ts');
    const j0 = submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: {} } } } });
    const j = await settle(getJob, j0.id);
    assert.equal(j.status, 'failed', j.detail);
    assert.equal(j.error, NO_GPU_ERROR);
    assert.equal(j.gpu_seconds, 0);
    assert.equal(j.cost, 0);
    assert.ok(j.log.some((l: string) => /none will come back by itself: runpod-a: RunPod is out of credit/.test(l)), JSON.stringify(j.log));
  } finally {
    setRunpodCredit(null);
    resetHealth();
    saveSettings({ gpu: { providers: [], order: [], familyOrder: {} } } as any);
  }
});

test('the queue: a GPU job that may get a GPU soon waits with its clock kept, and fails once the wait is over', async () => {
  resetHealth();
  Object.assign(process.env, KEYS);
  setRunpodCredit({ balance: 20, at: Date.now() });
  markDown('runpod-a', 'no GPU came free', COOLDOWN.capacity);
  saveSettings({ gpu: { providers: [ep()], order: ['runpod-a'], cloudrun: { bucket: 'bkt', urls: {}, services: {} } }, queue: { ...SETTINGS_DEFAULTS.queue, gpuWaitMinutes: 15 } } as any);
  try {
    const { submit, getJob } = await import('../src/jobs.ts');
    const { db } = await import('../src/db.ts');
    const j0 = submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: {} } } } });
    let j = await settle(getJob, j0.id, ['failed']);
    assert.equal(j.status, 'queued');
    assert.match(j.detail, /waiting for a GPU .*stops in 15 min/);
    const since = waitSinceOf(j.labels);
    assert.ok(since && Date.now() - since < 60_000, 'its clock is in its labels (a restart keeps it)');
    // Sixteen minutes on (the clock set back), still nothing: it stops.
    db.prepare('UPDATE jobs SET labels = ? WHERE id = ?').run(JSON.stringify({ ...j.labels, gpuWaitSince: Date.now() - 16 * 60_000 }), j.id);
    j = await settle(getJob, j0.id);
    assert.equal(j.status, 'failed');
    assert.equal(j.error, noGpuAfter(15));
  } finally {
    setRunpodCredit(null);
    resetHealth();
    saveSettings({ gpu: { providers: [], order: [], familyOrder: {} } } as any);
  }
});

test('the queue: a job whose input file is gone fails in plain words instead of hanging at "starting"', async () => {
  const { submit, getJob } = await import('../src/jobs.ts');
  const { putAsset } = await import('../src/library.ts');
  const a = putAsset({ data: Buffer.from('not really a png'), ext: '.png', client: 'test', project: 'sandbox', tool: 'upload', recipe: { tool: 'upload', version: 1, params: {}, inputs: {} } as any });
  const j0 = submit(owner, { tool: 'image.transform', project: 'sandbox', params: { ops: [{ op: 'flip' }] }, inputs: { image: `asset:${a.id}` } });
  fs.rmSync(a.path);
  const j = await settle(getJob, j0.id);
  assert.equal(j.status, 'failed', `${j.status}: ${j.detail}`);
  assert.equal(j.error, 'The image file this job uses is no longer available. Add it again and run the job again.');
});

test('a running job cut off by too many restarts stops with a reason instead of starting over again', async () => {
  const { submit, getJob, queue, MAX_RESUMES } = await import('../src/jobs.ts');
  const { db } = await import('../src/db.ts');
  const a = submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: {} } } } });
  const b = submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: {} } } } });
  // Before the queue's next look: both "running" when Gen stopped, one already picked up again the most times.
  db.prepare("UPDATE jobs SET status = 'running', resumed = ? WHERE id = ?").run(MAX_RESUMES, a.id);
  db.prepare("UPDATE jobs SET status = 'running', resumed = 1 WHERE id = ?").run(b.id);
  (queue as any).start();
  const ja = getJob(a.id)!;
  assert.equal(ja.status, 'failed');
  assert.match(ja.error!, /interrupted 5 times .* stopped instead of starting over/);
  const jb = getJob(b.id)!;
  assert.notEqual(jb.status, 'running');
  assert.equal(jb.resumed, 2);
  const { cancel } = await import('../src/jobs.ts');
  if (['queued', 'running'].includes(jb.status)) cancel(b.id);
});

test('cancelling or failing a pipeline job stops its steps (nothing keeps waiting for a GPU for it)', async () => {
  const { submit, getJob, cancel, failJob } = await import('../src/jobs.ts');
  const { db } = await import('../src/db.ts');
  const spec = { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: {} } } } };
  for (const end of ['cancel', 'fail'] as const) {
    const parent = submit(owner, { ...spec });
    const kid = submit(owner, { ...spec, labels: { parent: parent.id, step: 'frame' } });
    const other = submit(owner, { ...spec, labels: { parent: 'j_someone_else', step: 'frame' } });
    for (const id of [parent.id, kid.id, other.id]) db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);
    if (end === 'cancel') cancel(parent.id);
    else failJob(parent.id, 'broke');
    assert.equal(getJob(kid.id)!.status, 'cancelled', end);
    assert.equal(getJob(other.id)!.status, 'running', 'another job\'s steps are left alone');
    cancel(other.id);
  }
});

test('settings: queue.gpuWaitMinutes defaults to 15 and stays within 1 to 240', () => {
  assert.equal(SETTINGS_DEFAULTS.queue.gpuWaitMinutes, 15);
  saveSettings({ queue: { ...SETTINGS_DEFAULTS.queue, gpuWaitMinutes: 9999 } } as any);
  assert.equal(loadSettings().queue.gpuWaitMinutes, 240);
  saveSettings({ queue: { ...SETTINGS_DEFAULTS.queue, gpuWaitMinutes: 20 } } as any);
  assert.equal(loadSettings().queue.gpuWaitMinutes, 20);
  saveSettings({ queue: { ...SETTINGS_DEFAULTS.queue } } as any);
});
