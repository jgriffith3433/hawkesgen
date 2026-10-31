// Customer mode of the Unity cloud build (docs/unity-cloudrun.md, "Customer mode"; src/providers/builder/customer.ts):
// the params a customer key may send, the internal-only refusal for everything else, the token kept out of the stored
// job, the Unity version checked against the images before anything starts, and the result shape (a fake Google Cloud
// and a fake GitHub API: nothing real is called).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-unity-cust-'));
process.env.HAWKESGEN_DATA_DIR = data;
const creds = path.join(data, 'adc.json');
fs.writeFileSync(creds, JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }));
process.env.GOOGLE_APPLICATION_CREDENTIALS = creds;
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ unityBuild: { gcp: { project: 'hawkes-test', bucket: 'hawkes-unity-test', region: 'us-east4', job: 'hawkes-unity-build', unity: '6000.3.7f1', cpu: 8, memoryGiB: 32, images: { '6000.3.7f1': 'hawkes-unity-build', '6000.0.40f1': 'hawkes-unity-6000-0' } } } }));

const C = await import('../src/providers/builder/customer.ts');
const { db } = await import('../src/db.ts');
const { submit, getJob, queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // nothing runs here: jobs stay queued
const { customerMayRun, quoteJobCredits, UNITY_BUILD_CREDITS } = await import('../src/billing.ts');
const { runCustomerBuild } = await import('../src/tools/build.ts');
const { tokenFor } = await import('../src/providers/playtester/intake.ts');
const { loadSettings } = await import('../src/config.ts');

const SHA = 'c'.repeat(40);
const TOKEN = 'ghs_customerInstallationToken0123456789';
const customer = { id: 'cust', name: 'a customer', role: 'user', projects: ['usr_acme'] } as any;
const good = () => ({ github: { repo: 'acme/rocket-game', commit: SHA, token: TOKEN, ref: 'refs/heads/main' }, target: 'web', out: 'artifact' });

test('customer params: repo, sha, token and target are checked; the token becomes a vault reference', () => {
  const held: string[] = [];
  const hold = (t: string) => { held.push(t); return 'tok_' + '0'.repeat(24); };
  const p = C.admitCustomer({ ...good(), path: './Game/', method: 'Acme.Build.Web' }, hold);
  assert.deepEqual(p.github, { repo: 'acme/rocket-game', commit: SHA, tokenRef: 'tok_' + '0'.repeat(24), ref: 'refs/heads/main' });
  assert.equal(p.path, 'Game');
  assert.equal(p.method, 'Acme.Build.Web');
  assert.equal(p.backend, 'cloudrun');
  assert.deepEqual(held, [TOKEN]);
  assert.ok(!JSON.stringify(p).includes(TOKEN));
  const throwsKind = (params: any, re: RegExp, kind = 'params') => assert.throws(() => C.admitCustomer(params, hold), (e: any) => re.test(e.message) && e.kind === kind && !String(e.message).includes(TOKEN));
  throwsKind({ ...good(), github: { ...good().github, repo: 'rocket-game' } }, /owner\/name/);
  throwsKind({ ...good(), github: { ...good().github, commit: 'abc123' } }, /full commit sha/);
  throwsKind({ ...good(), github: { ...good().github, commit: 'G'.repeat(40) } }, /full commit sha/);
  throwsKind({ ...good(), github: { ...good().github, token: 'not-a-token' } }, /GitHub token/);
  throwsKind({ ...good(), github: { ...good().github, token: TOKEN + ' x' } }, /GitHub token/);
  throwsKind({ ...good(), github: { ...good().github, siteRepo: 'acme/site' } }, /siteRepo/);
  throwsKind({ ...good(), github: { ...good().github, tokenRef: 'tok_' + '1'.repeat(24) } }, /tokenRef/);
  throwsKind({ ...good(), site: 'acme-site' }, /site isn't for customer/);
  throwsKind({ ...good(), path: '../outside' }, /plain folder/);
  throwsKind({ ...good(), method: 'rm -rf /' }, /static method/);
  throwsKind({ ...good(), env: { UNITY_PASSWORD: 'x' } }, /env UNITY_PASSWORD/);
  // Any target but web (WebGL) fails as a config problem: the image builds WebGL only.
  for (const target of ['windows', 'StandaloneWindows64', 'android']) throwsKind({ ...good(), target }, /WebGL only/, 'config');
  assert.equal(C.admitCustomer({ ...good(), target: 'WebGL' }, hold).target, 'web');
});

test('who may: customer mode only for user keys; the internal-only refusal still covers everything else', () => {
  assert.equal(C.isCustomerMode(good()), true);
  assert.equal(C.isCustomerMode({ ...good(), out: undefined }), false, 'out "artifact" is required');
  assert.equal(C.isCustomerMode({ github: { repo: 'a/b', commit: SHA, siteRepo: 'a/c' }, project: 'x', site: 'y' }), false, "J's GitHub mode is not customer mode");
  assert.equal(customerMayRun('unity.build', good()), true);
  assert.equal(customerMayRun('unity.test', good()), false);
  // J's GitHub mode and folder builds stay internal-only for user keys.
  assert.throws(() => submit(customer, { project: 'usr_acme', tool: 'unity.build', params: { project: 'sickofitgame-unity', site: 'sickofitgamewebsite' } } as any), /internal-only/);
  assert.throws(() => submit(customer, { project: 'usr_acme', tool: 'unity.build', params: { project: 'YoobaLand/YoobaLand', site: 'YoobaLandGame', github: { repo: 'jgriffith3433/YoobaLand', commit: SHA, siteRepo: 'jgriffith3433/YoobaLandGame' } } } as any), /internal-only/);
  assert.throws(() => submit(customer, { project: 'usr_acme', tool: 'unity.build', params: { github: { repo: 'acme/a', commit: SHA, token: TOKEN } } } as any), /internal-only/, 'no out "artifact": refused');
  assert.throws(() => submit(customer, { project: 'usr_acme', tool: 'unity.test', params: { project: 'x' } } as any), /internal-only/);
  // Inside a chain too.
  assert.throws(() => submit(customer, { project: 'usr_acme', tool: 'asset.make', params: { steps: [{ tool: 'unity.build', params: good() }] } } as any), /internal-only/);
});

test('the stored job has no token: params, the row and the recipe carry only its reference', () => {
  const job = submit(customer, { project: 'usr_acme', tool: 'unity.build', params: good() } as any);
  assert.equal(job.status, 'queued');
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as Record<string, unknown>;
  assert.ok(!JSON.stringify(row).includes(TOKEN), 'no column of the job row holds the token');
  const stored = getJob(job.id)!;
  assert.match(stored.params.github.tokenRef, /^tok_[0-9a-f]{24}$/);
  assert.equal(stored.params.github.token, undefined);
  assert.equal(stored.params.out, 'artifact');
  // The token waits in memory for the run, behind that reference.
  assert.equal(tokenFor(stored.params.github.tokenRef), TOKEN);
  const all = db.prepare('SELECT * FROM jobs').all();
  assert.ok(!JSON.stringify(all).includes(TOKEN));
});

test('a customer build is priced flat', () => {
  const q = quoteJobCredits({ project: 'usr_acme', tool: 'unity.build', params: good() });
  assert.equal(q.credits, UNITY_BUILD_CREDITS);
  assert.equal(UNITY_BUILD_CREDITS, 100);
});

test('Unity versions: the images setting, and a version without an image fails naming both', () => {
  const images = C.unityImages(loadSettings().unityBuild.gcp);
  assert.deepEqual(images, { '6000.3.7f1': 'hawkes-unity-build', '6000.0.40f1': 'hawkes-unity-6000-0' });
  assert.deepEqual(C.unityImages({ unity: '6000.3.7f1', job: 'hawkes-unity-build', images: {} }), { '6000.3.7f1': 'hawkes-unity-build' }, 'empty: the one image');
  assert.equal(C.jobForVersion('6000.0.40f1', images), 'hawkes-unity-6000-0');
  assert.throws(() => C.jobForVersion('2022.3.10f1', images), (e: any) => e.kind === 'config' && /Unity 2022\.3\.10f1/.test(e.message) && /Supported: 6000\.0\.40f1, 6000\.3\.7f1/.test(e.message));
  assert.equal(C.editorVersionOf('m_EditorVersion: 6000.3.7f1\nm_EditorVersionWithRevision: 6000.3.7f1 (abc)\n'), '6000.3.7f1');
  assert.equal(C.projectPathIn(['README.md', 'Game/ProjectSettings/ProjectVersion.txt', 'Game/Library/x/ProjectSettings/ProjectVersion.txt', 'Tools/Old/ProjectSettings/ProjectVersion.txt']), 'Game');
  assert.equal(C.projectPathIn(['ProjectSettings/ProjectVersion.txt', 'Sub/ProjectSettings/ProjectVersion.txt']), '.');
  assert.equal(C.projectPathIn(['src/index.ts']), null);
});

/** A fake GitHub API (tree, ProjectVersion.txt) and Google Cloud (Storage, Cloud Run, Logging). */
function fakeCloud({ version = '6000.3.7f1', result }: { version?: string; result: unknown }) {
  const writes = new Map<string, Buffer>();
  const calls: { method: string; url: string; body: string; auth: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body instanceof Buffer || init.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : typeof init.body === 'string' ? init.body : '';
    calls.push({ method, url, body, auth: String(init.headers?.Authorization ?? '') });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.github.com/repos/acme/rocket-game/git/trees/')) return json({ tree: [{ path: 'README.md', type: 'blob' }, { path: 'Game/ProjectSettings/ProjectVersion.txt', type: 'blob' }], truncated: false });
    if (url.startsWith('https://api.github.com/repos/acme/rocket-game/contents/Game/ProjectSettings/ProjectVersion.txt')) return new Response(`m_EditorVersion: ${version}\n`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'fake-token', expires_in: 3600 });
    if (url.startsWith('https://storage.googleapis.com/upload/')) {
      const name = new URL(url).searchParams.get('name')!;
      writes.set(name, Buffer.from(body));
      return json({ name });
    }
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/')) {
      const key = decodeURIComponent(url.replace(/^.*\/o\//, '').replace(/\?.*$/, ''));
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (key.endsWith('/cloud-job.json') && writes.has(key)) return new Response(writes.get(key) as unknown as BodyInit);
      if (key.endsWith('/result.json')) return new Response(JSON.stringify(result));
      if (key.endsWith('/unity.log')) return new Response('[Hawkes] stage: unity\n[Hawkes] built 2 scene(s)\n');
      if (key.endsWith('/artifact.tgz')) return new Response(Buffer.from('fake tar.gz bytes') as unknown as BodyInit);
      return new Response('not found', { status: 404 });
    }
    if (url.includes('run.googleapis.com') && url.endsWith(':run')) return json({ metadata: { name: `projects/hawkes-test/locations/us-east4/jobs/${url.split('/jobs/')[1].split(':')[0]}/executions/e-7` } });
    if (url.includes('run.googleapis.com') && url.includes('/executions/e-7')) return json({ startTime: '2026-10-31T10:00:00Z', completionTime: '2026-10-31T10:06:00Z', succeededCount: 1 });
    if (url.startsWith('https://logging.googleapis.com/')) return json({ entries: [] });
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  return { writes, calls, restore: () => { globalThis.fetch = real; } };
}

/** A RunContext for runCustomerBuild: emits become fake assets, the result is kept. */
function ctxFor(jobId: string, params: Record<string, any>) {
  const outputs: any[] = [];
  const logs: string[] = [];
  const ctx: any = {
    job: { id: jobId, client: 'cust', project: 'usr_acme', tool: 'unity.build', labels: {} }, params, inputs: {}, done: 0, outputs,
    signal: new AbortController().signal, step: (s: string) => logs.push(s), log: (s: string) => logs.push(s), tmp: (n: string) => path.join(data, n),
    emit: async (o: any) => { outputs.push({ asset: `a_${outputs.length + 1}`, mime: o.mime, title: o.title, bytes: o.data.length }); },
    result: (v: unknown) => { ctx.value = v; }, seed: () => 1, usage: () => {}, python: async () => '',
  };
  return { ctx, logs, outputs };
}

test('a customer build: the project and version from GitHub, the token only on the execution, the output as an asset', async () => {
  const g = fakeCloud({
    result: { ok: true, stage: 'end', exitCode: 0, unity: '6000.3.7f1', seconds: { unity: 300 }, cache: { restoredFrom: null, saved: true, savedKey: 'build' },
      output: { object: 'unity-builds/j_cust1/artifact.tgz', bytes: 52_000_000, files: 12, changed: [], deleted: [] } },
  });
  try {
    const params = C.admitCustomer(good());
    const { ctx, logs, outputs } = ctxFor('j_cust1', params);
    await runCustomerBuild(ctx);
    const r = ctx.value;
    assert.equal(r.ok, true);
    assert.equal(r.unity, '6000.3.7f1');
    assert.equal(typeof r.seconds, 'number');
    assert.deepEqual(r.artifact, { asset: 'a_2', url: '/v1/assets/a_2/file', bytes: Buffer.from('fake tar.gz bytes').length, files: 12 });
    assert.deepEqual(r.github, { repo: 'acme/rocket-game', commit: SHA, ref: 'refs/heads/main', path: 'Game' });
    assert.equal(outputs[1].mime, 'application/gzip');
    // GitHub was asked with the customer's token; the spec in the bucket names the project but holds no token.
    assert.ok(g.calls.filter((c) => c.url.startsWith('https://api.github.com/')).every((c) => c.auth === `Bearer ${TOKEN}`));
    const spec = g.writes.get('unity-builds/j_cust1/spec.json')!.toString('utf8');
    assert.ok(!spec.includes(TOKEN), 'spec.json has no token');
    const s = JSON.parse(spec);
    assert.deepEqual(s.repos, [{ slug: 'acme/rocket-game', top: 'src', commit: SHA, branch: null, sparse: [] }]);
    assert.equal(s.project, 'src/Game');
    assert.equal(s.method, C.DEFAULT_METHOD);
    assert.deepEqual(s.customer, { repo: 'acme/rocket-game', commit: SHA, ref: 'refs/heads/main', path: 'Game', defaultMethod: true, out: 'artifact' });
    assert.equal(s.github, null);
    assert.match(s.cache.prefix, /^unity-cache\/cust--usr_acme--acme--rocket-game--Game$/);
    // The execution of that version's job carries the token as an env override, and nothing else does.
    const run = g.calls.find((c) => c.url.endsWith(':run'))!;
    assert.match(run.url, /jobs\/hawkes-unity-build:run$/);
    const envs = JSON.parse(run.body).overrides.containerOverrides[0].env;
    assert.deepEqual(envs.map((e: any) => e.name).sort(), ['HAWKES_GITHUB_TOKEN', 'HAWKES_SPEC']);
    assert.equal(envs.find((e: any) => e.name === 'HAWKES_GITHUB_TOKEN').value, TOKEN);
    assert.ok(!g.calls.filter((c) => c !== run && !c.url.startsWith('https://api.github.com/')).some((c) => c.body.includes(TOKEN) || c.url.includes(TOKEN)));
    for (const k of g.writes.keys()) assert.ok(!g.writes.get(k)!.toString('utf8').includes(TOKEN), `${k} has no token`);
    assert.ok(!logs.join('\n').includes(TOKEN), 'the log has no token');
    assert.ok(!JSON.stringify(r).includes(TOKEN), 'the result has no token');
    // The vault forgets it once the job is done.
    assert.equal(tokenFor(params.github.tokenRef), null);
  } finally {
    g.restore();
  }
});

test('a project on a Unity version Gen has no image for fails before anything starts', async () => {
  const g = fakeCloud({ version: '2022.3.10f1', result: { ok: true } });
  try {
    const params = C.admitCustomer(good());
    const { ctx } = ctxFor('j_cust2', params);
    await assert.rejects(() => runCustomerBuild(ctx), (e: any) => e.kind === 'config' && /uses Unity 2022\.3\.10f1/.test(e.message) && /Supported: 6000\.0\.40f1, 6000\.3\.7f1/.test(e.message));
    assert.ok(!g.calls.some((c) => c.url.includes('run.googleapis.com')), 'no Cloud Run execution');
    assert.ok(!g.writes.has('unity-builds/j_cust2/spec.json'));
    assert.equal(tokenFor(params.github.tokenRef), null);
  } finally {
    g.restore();
  }
});

test('the other version picks its own job; a lost token says to submit again', async () => {
  const g = fakeCloud({ version: '6000.0.40f1', result: { ok: true, unity: '6000.0.40f1', output: { object: 'unity-builds/j_cust3/artifact.tgz', bytes: 10, files: 1 } } });
  try {
    const { ctx } = ctxFor('j_cust3', { ...C.admitCustomer(good()), method: 'Acme.Build.Web' });
    await runCustomerBuild(ctx);
    assert.match(g.calls.find((c) => c.url.endsWith(':run'))!.url, /jobs\/hawkes-unity-6000-0:run$/);
    const s = JSON.parse(g.writes.get('unity-builds/j_cust3/spec.json')!.toString('utf8'));
    assert.equal(s.method, 'Acme.Build.Web');
    assert.equal(s.customer.defaultMethod, false);
    const lost = ctxFor('j_cust4', { ...C.admitCustomer(good(), () => 'tok_' + 'f'.repeat(24)) });
    await assert.rejects(() => runCustomerBuild(lost.ctx), /token for this build is gone/);
  } finally {
    g.restore();
  }
});

test('a result whose output is not this job\'s artifact is refused', async () => {
  const g = fakeCloud({ result: { ok: true, output: { object: 'unity-cache/someone-else/build.tar.zst', bytes: 10, files: 1 } } });
  try {
    const { ctx } = ctxFor('j_cust5', C.admitCustomer(good()));
    await assert.rejects(() => runCustomerBuild(ctx), /no output/);
  } finally {
    g.restore();
  }
});
