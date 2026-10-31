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
const Sign = await import('../src/providers/gpu/sign.ts');
const crypto = await import('node:crypto');

// Gen's signer: a real RSA key standing in for IAM signBlob, so the signatures can be checked.
const KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SIGNER = { email: 'gen-control@hawkes-test.iam.gserviceaccount.com', sign: async (b: Buffer) => crypto.sign('RSA-SHA256', b, KEYS.privateKey) };
Sign.setSigner(SIGNER);
const SETTINGS = path.join(data, 'settings.json');
const baseSettings = fs.readFileSync(SETTINGS, 'utf8');
const withGcp = (patch: Record<string, unknown>) => { const j = JSON.parse(baseSettings); Object.assign(j.unityBuild.gcp, patch); fs.writeFileSync(SETTINGS, JSON.stringify(j)); };

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
/** The customer job as Cloud Run describes it (customer-setup.mjs makes it this way). */
const customerJobResource = (over: Record<string, any> = {}) => ({
  template: { template: {
    serviceAccount: 'unity-customer@hawkes-test.iam.gserviceaccount.com',
    containers: [{ env: [
      { name: 'HAWKES_WORK', value: '/work' }, { name: 'HAWKES_CUSTOMER_JOB', value: '1' },
      { name: 'UNITY_EMAIL', valueSource: { secretKeyRef: { secret: 'unity-customer-email', version: 'latest' } } },
      { name: 'UNITY_PASSWORD', valueSource: { secretKeyRef: { secret: 'unity-customer-password', version: 'latest' } } },
    ] }],
    ...over,
  } },
});

function fakeCloud({ version = '6000.3.7f1', result, jobs = {}, cacheObjects = [] }: { version?: string; result: unknown; jobs?: Record<string, unknown>; cacheObjects?: string[] }) {
  C.forgetCustomerJobChecks();
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
    if (/\/storage\/v1\/b\/[^/]+\/o\?prefix=/.test(url)) {
      const prefix = new URL(url).searchParams.get('prefix')!;
      return json({ items: cacheObjects.filter((n) => n.startsWith(prefix)).map((name) => ({ name, size: 10, updated: '2026-10-30T00:00:00Z' })) });
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
    const jobGet = /run\.googleapis\.com\/v2\/projects\/hawkes-test\/locations\/us-east4\/jobs\/([^/:]+)$/.exec(url);
    if (jobGet && method === 'GET') {
      const name = jobGet[1];
      const j = name in jobs ? jobs[name] : name.endsWith('-customer') ? customerJobResource() : null;
      return j ? json(j) : json({ error: { message: 'not found' } }, 404);
    }
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
    assert.match(run.url, /jobs\/hawkes-unity-build-customer:run$/, "the customer job, never J's");
    const envs = JSON.parse(run.body).overrides.containerOverrides[0].env;
    assert.deepEqual(envs.map((e: any) => e.name).sort(), ['HAWKES_GITHUB_TOKEN', 'HAWKES_SIGNED', 'HAWKES_SPEC']);
    assert.ok(!envs.find((e: any) => e.name === 'HAWKES_SIGNED').value.includes(TOKEN));
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
    assert.match(g.calls.find((c) => c.url.endsWith(':run'))!.url, /jobs\/hawkes-unity-6000-0-customer:run$/);
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

// ------------------------------------------------------------------ isolation (docs/unity-cloudrun.md, "Customer mode")

/** Checks a V4 signed URL against the fake signer's public key; returns its parts. */
function checkSignedUrl(url: string, method: 'GET' | 'PUT') {
  const u = new URL(url);
  assert.equal(u.origin, 'https://storage.googleapis.com');
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q['X-Goog-Algorithm'], 'GOOG4-RSA-SHA256');
  assert.match(q['X-Goog-Credential'], /^gen-control@hawkes-test\.iam\.gserviceaccount\.com\/\d{8}\/auto\/storage\/goog4_request$/);
  assert.equal(q['X-Goog-SignedHeaders'], 'host');
  // Rebuild what was signed (method, path, query without the signature) and verify it with the public key.
  const query = u.search.slice(1).split('&').filter((kv) => !kv.startsWith('X-Goog-Signature=')).join('&');
  const canonical = [method, u.pathname, query, 'host:storage.googleapis.com\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = q['X-Goog-Credential'].split('/').slice(1).join('/');
  const toSign = ['GOOG4-RSA-SHA256', q['X-Goog-Date'], scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(toSign), KEYS.publicKey, Buffer.from(q['X-Goog-Signature'], 'hex')), `${method} ${u.pathname} is signed for ${method}`);
  return { path: u.pathname, expires: Number(q['X-Goog-Expires']) };
}

test('signed URLs: V4 shape, GET and PUT signed as such, the expiry asked for', async () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const get = await Sign.signedUrl('GET', 'gs://hawkes-unity-test/unity-builds/j_1/spec.json', SIGNER, 4200, now);
  const put = await Sign.signedUrl('PUT', 'gs://hawkes-unity-test/unity-builds/j_1/artifact.tgz', SIGNER, 4200, now);
  assert.deepEqual(checkSignedUrl(get, 'GET'), { path: '/hawkes-unity-test/unity-builds/j_1/spec.json', expires: 4200 });
  assert.deepEqual(checkSignedUrl(put, 'PUT'), { path: '/hawkes-unity-test/unity-builds/j_1/artifact.tgz', expires: 4200 });
  assert.match(get, /X-Goog-Date=20261031T120000Z/);
  // A GET URL can't be used to write: its signature is over GET.
  const asPut = get.replace('/spec.json', '/artifact.tgz');
  assert.throws(() => checkSignedUrl(asPut, 'GET'));
  assert.equal(await Sign.signedGetUrl('gs://b/k', SIGNER, 60, now), await Sign.signedUrl('GET', 'gs://b/k', SIGNER, 60, now));
  assert.equal(C.customerUrlSeconds(40), 70 * 60, 'the build limit + 15 for the execution + 15 of margin');
});

test("signed URLs: only that customer's cache key and that job's output", async () => {
  const keys: string[] = [];
  const sign = async (m: 'GET' | 'PUT', k: string) => { keys.push(`${m} ${k}`); return `https://signed/${m}/${k}`; };
  const urls = await C.customerSignedUrls({ bucket: 'hawkes-unity-test', prefix: 'unity-builds/j_9', cachePrefix: 'unity-cache/cust--usr_acme--acme--rocket-game', restore: ['build'], save: 'build', sign });
  assert.equal(urls.bucket, 'hawkes-unity-test');
  assert.deepEqual(Object.keys(urls.get).sort(), ['unity-builds/j_9/spec.json', 'unity-cache/cust--usr_acme--acme--rocket-game/build.json', 'unity-cache/cust--usr_acme--acme--rocket-game/build.tar.zst']);
  assert.deepEqual(Object.keys(urls.put).sort(), ['unity-builds/j_9/artifact.tgz', 'unity-builds/j_9/result.json', 'unity-builds/j_9/unity.log', 'unity-cache/cust--usr_acme--acme--rocket-game/build.json', 'unity-cache/cust--usr_acme--acme--rocket-game/build.tar.zst']);
  // No cache yet: nothing to read but the spec.
  const fresh = await C.customerSignedUrls({ bucket: 'b', prefix: 'unity-builds/j_9', cachePrefix: 'unity-cache/cust--usr_acme--acme--rocket-game', restore: [], save: 'build', sign });
  assert.deepEqual(Object.keys(fresh.get), ['unity-builds/j_9/spec.json']);
  // Never J's caches, never another prefix.
  await assert.rejects(() => C.customerSignedUrls({ bucket: 'b', prefix: 'unity-builds/j_9', cachePrefix: 'unity-cache/sickofitgame-unity', restore: ['main'], save: 'main', sign }), /customer's Library cache/);
  await assert.rejects(() => C.customerSignedUrls({ bucket: 'b', prefix: 'unity-cache/x', cachePrefix: 'unity-cache/cust--a', restore: [], save: null, sign }), /build's prefix/);
  await assert.rejects(() => C.customerSignedUrls({ bucket: 'b', prefix: 'unity-builds/j_9', cachePrefix: 'unity-cache/cust--a', restore: ['../main'], save: null, sign }), /cache key/);
});

test('the customer job: customerJob for the main job, "<job>-customer" for other versions, never one of J\'s', () => {
  const gcp = { job: 'hawkes-unity-build', images: { '6000.3.7f1': 'hawkes-unity-build', '6000.0.40f1': 'hawkes-unity-6000-0' }, customerJob: 'hawkes-unity-build-customer' };
  assert.equal(C.customerJobFor('hawkes-unity-build', gcp), 'hawkes-unity-build-customer');
  assert.equal(C.customerJobFor('hawkes-unity-6000-0', gcp), 'hawkes-unity-6000-0-customer');
  assert.throws(() => C.customerJobFor('hawkes-unity-build', { ...gcp, customerJob: 'hawkes-unity-6000-0' }), (e: any) => e.kind === 'config' && /own build jobs/.test(e.message));
  assert.throws(() => C.customerJobFor('hawkes-unity-build', { ...gcp, customerJob: '' }), (e: any) => e.kind === 'config' && /customer-setup\.mjs/.test(e.message));
  assert.equal(loadSettings().unityBuild.gcp.customerJob, 'hawkes-unity-build-customer', 'the default');
});

test('the execution gets only the token and signed URLs: its cache, its output, nothing else, expiring with the build', async () => {
  const cache = 'unity-cache/cust--usr_acme--acme--rocket-game--Game';
  const g = fakeCloud({
    cacheObjects: [`${cache}/build.tar.zst`, `${cache}/build.json`, 'unity-cache/sickofitgame-unity/main.tar.zst'],
    result: { ok: true, unity: '6000.3.7f1', cache: { restoredFrom: 'build' }, output: { object: 'unity-builds/j_iso1/artifact.tgz', bytes: 10, files: 1 } },
  });
  try {
    const { ctx } = ctxFor('j_iso1', C.admitCustomer(good()));
    await runCustomerBuild(ctx);
    // The job was checked first, then run.
    const jobGet = g.calls.findIndex((c) => c.method === 'GET' && c.url.endsWith('/jobs/hawkes-unity-build-customer'));
    const run = g.calls.findIndex((c) => c.url.endsWith(':run'));
    assert.ok(jobGet >= 0 && jobGet < run);
    const envs = JSON.parse(g.calls[run].body).overrides.containerOverrides[0].env as { name: string; value: string }[];
    assert.deepEqual(envs.map((e) => e.name).sort(), ['HAWKES_GITHUB_TOKEN', 'HAWKES_SIGNED', 'HAWKES_SPEC']);
    assert.equal(envs.find((e) => e.name === 'HAWKES_SPEC')!.value, 'gs://hawkes-unity-test/unity-builds/j_iso1/spec.json');
    const urls = JSON.parse(envs.find((e) => e.name === 'HAWKES_SIGNED')!.value);
    assert.deepEqual(Object.keys(urls).sort(), ['bucket', 'get', 'put']);
    assert.equal(urls.bucket, 'hawkes-unity-test');
    assert.deepEqual(Object.keys(urls.get).sort(), ['unity-builds/j_iso1/spec.json', `${cache}/build.json`, `${cache}/build.tar.zst`]);
    assert.deepEqual(Object.keys(urls.put).sort(), ['unity-builds/j_iso1/artifact.tgz', 'unity-builds/j_iso1/result.json', 'unity-builds/j_iso1/unity.log', `${cache}/build.json`, `${cache}/build.tar.zst`]);
    for (const [method, map] of [['GET', urls.get], ['PUT', urls.put]] as const) {
      for (const [key, url] of Object.entries(map as Record<string, string>)) {
        const c = checkSignedUrl(url, method);
        assert.equal(c.path, `/hawkes-unity-test/${key}`);
        assert.equal(c.expires, (40 + 30) * 60);
      }
    }
    assert.ok(!JSON.stringify(urls).includes('sickofitgame'), "never J's caches");
  } finally {
    g.restore();
  }
});

test('customer mode refuses to run without its job: off, missing, the wrong account, extra secrets, no signer', async () => {
  const refused = async (jobId: string, opts: Parameters<typeof fakeCloud>[0], re: RegExp) => {
    const g = fakeCloud(opts);
    try {
      const { ctx } = ctxFor(jobId, C.admitCustomer(good()));
      await assert.rejects(() => runCustomerBuild(ctx), (e: any) => e.kind === 'config' && re.test(e.message));
      assert.ok(!g.calls.some((c) => c.url.endsWith(':run')), 'no execution');
      assert.ok(!g.writes.has(`unity-builds/${jobId}/spec.json`), 'nothing uploaded');
      return g;
    } finally {
      g.restore();
    }
  };
  try {
    withGcp({ customerJob: '' });
    const off = await refused('j_off', { result: {} }, /Customer builds are off.*customer-setup\.mjs/);
    assert.ok(!off.calls.some((c) => c.url.startsWith('https://api.github.com/')), 'refused before GitHub is asked');
  } finally {
    fs.writeFileSync(SETTINGS, baseSettings);
  }
  await refused('j_missing', { result: {}, jobs: { 'hawkes-unity-build-customer': null } }, /isn't there.*customer-setup\.mjs/);
  await refused('j_sa', { result: {}, jobs: { 'hawkes-unity-build-customer': customerJobResource({ serviceAccount: 'hawkes-unity-build@hawkes-test.iam.gserviceaccount.com' }) } }, /runs as hawkes-unity-build@/);
  await refused('j_secret', { result: {}, jobs: { 'hawkes-unity-build-customer': customerJobResource({ containers: [{ env: [{ name: 'HAWKES_CUSTOMER_JOB', value: '1' }, { name: 'GITHUB_TOKEN', valueSource: { secretKeyRef: { secret: 'github-token' } } }] }] }) } }, /GITHUB_TOKEN/);
  await refused('j_flag', { result: {}, jobs: { 'hawkes-unity-build-customer': customerJobResource({ containers: [{ env: [] }] }) } }, /HAWKES_CUSTOMER_JOB=1/);
  Sign.setSigner(null);
  try {
    await refused('j_nosign', { result: {} }, /can't sign/);
  } finally {
    Sign.setSigner(SIGNER);
  }
});

test("J's own builds are untouched: his job, only HAWKES_SPEC, no job check, no signed URLs", async () => {
  const { runCloudBuild } = await import('../src/providers/builder/cloudrun.ts');
  const g = fakeCloud({ result: { ok: true, output: { object: 'unity-builds/j_own/site.tgz', bytes: 0, changed: [], deleted: [] }, pushed: null, packages: {} } });
  try {
    await runCloudBuild('j_own', { project: 'YoobaLand/YoobaLand', site: 'YoobaLandGame', github: { repo: 'jgriffith3433/YoobaLand', commit: SHA, siteRepo: 'jgriffith3433/YoobaLandGame', branch: 'beta', ref: null, packages: {}, cacheBranch: 'beta', builds: null } } as any, { step: () => {}, log: () => {} });
  } catch { /* the result's shape isn't what this test is about */ } finally {
    g.restore();
  }
  const run = g.calls.find((c) => c.url.endsWith(':run'));
  assert.ok(run, 'it ran');
  assert.match(run!.url, /jobs\/hawkes-unity-build:run$/);
  assert.deepEqual(JSON.parse(run!.body).overrides.containerOverrides[0].env.map((e: any) => e.name), ['HAWKES_SPEC']);
  assert.ok(!g.calls.some((c) => c.method === 'GET' && /\/jobs\/[^/:]+$/.test(c.url)), 'no customer job check');
});

const { spawnSync } = await import('node:child_process');
const hasJq = spawnSync('bash', ['-c', 'jq --version'], { encoding: 'utf8' }).status === 0;
test('entrypoint.sh in customer mode: the bucket only through its signed URLs, never a metadata token', { skip: !hasJq && 'needs bash and jq' }, () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'unity-cloudrun', 'entrypoint.sh'), 'utf8');
  const start = src.indexOf('# ------------------------------------------------------------ cloud storage');
  const end = src.indexOf('# ------------------------------------------------------------ the license');
  assert.ok(start > 0 && end > start);
  const signedJson = JSON.stringify({ bucket: 'bkt', get: { 'unity-builds/j/spec.json': 'https://signed.example/get-spec' }, put: { 'unity-builds/j/result.json': 'https://signed.example/put-result' } });
  // curl is a stand-in that prints what it was asked; the metadata server would show up as its URL.
  const script = [
    'curl() { echo "curl $*"; }',
    `SIGNED_ONLY=true; SIGNED_JSON='${signedJson}'`,
    src.slice(start, end),
    'echo "--get"; gs_get bkt unity-builds/j/spec.json',
    'echo "--put"; gs_put bkt unity-builds/j/result.json /tmp/x application/json',
    'echo "--other"; gs_get bkt unity-cache/sickofitgame-unity/main.tar.zst || echo "refused get"',
    'echo "--otherput"; gs_put bkt unity-cache/sickofitgame-unity/main.tar.zst - 2>/dev/null || echo "refused put"',
    'echo "--bucket"; gs_get otherbucket unity-builds/j/spec.json || echo "refused bucket"',
    'echo "--token"; token 2>/dev/null || echo "no token"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout;
  assert.match(out, /--get\ncurl -fsS --retry 3 https:\/\/signed\.example\/get-spec\n/);
  assert.match(out, /--put\ncurl -fsS --retry 2 -X PUT -T \/tmp\/x -H Content-Type: application\/json https:\/\/signed\.example\/put-result -o \/dev\/null\n/);
  assert.match(out, /refused get/);
  assert.match(out, /refused put/);
  assert.match(out, /refused bucket/);
  assert.match(out, /no token/);
  assert.ok(!/metadata|Authorization/.test(out), 'no metadata server, no bearer token');
});

test('the fallback regions are cleaned: valid, unique, never the main region', () => {
  withGcp({ regions: ['us-west1', 'us-east4', 'nope!', 'us-west1'] });
  try {
    assert.deepEqual(loadSettings().unityBuild.gcp.regions, ['us-west1']);
  } finally {
    withGcp({});
  }
  assert.deepEqual(loadSettings().unityBuild.gcp.regions, ['us-central1'], 'the default');
});
