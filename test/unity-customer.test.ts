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
const Sizes = await import('../src/providers/builder/sizes.ts');
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

test('a customer build is priced flat per machine size: m by default (half of xl), xl the old 100', () => {
  const q = (machine?: unknown) => quoteJobCredits({ project: 'usr_acme', tool: 'unity.build', params: { ...good(), ...(machine === undefined ? {} : { machine }) } }).credits;
  assert.equal(UNITY_BUILD_CREDITS, 100);
  assert.equal(q('xl'), UNITY_BUILD_CREDITS);
  assert.equal(q(), 50, 'the default size is m: 4 vCPU, 16 GiB');
  assert.equal(q('m'), 50);
  assert.equal(q('l'), 75);
  assert.equal(q('s'), 25);
  assert.equal(q({ cpu: 4, memoryGiB: 8 }), 42);
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

function fakeCloud({ version = '6000.3.7f1', result, jobs = {}, cacheObjects = [], executions = [], canCreate = false }: {
  version?: string; result: unknown | ((run: number) => unknown); jobs?: Record<string, unknown>; cacheObjects?: string[];
  /** The execution resources of the 1st, 2nd... run (default: a success). */ executions?: unknown[];
  /** Whether Gen may create a job (POST jobs?jobId=): the made ones are kept in `created`. */ canCreate?: boolean;
}) {
  C.forgetCustomerJobChecks();
  Sizes.forgetSizedJobs();
  let runs = 0;
  const created = new Map<string, any>();
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
      if (method === 'DELETE') { writes.delete(key); return new Response(null, { status: 204 }); }
      if (key.endsWith('/cloud-job.json') && writes.has(key)) return new Response(writes.get(key) as unknown as BodyInit);
      if (key.endsWith('/spec.json') && writes.has(key)) return new Response(writes.get(key) as unknown as BodyInit);
      if (key.endsWith('/result.json')) {
        const v = typeof result === 'function' ? (result as (n: number) => unknown)(runs) : result;
        return v === null ? new Response('not found', { status: 404 }) : new Response(JSON.stringify(v));
      }
      if (key.endsWith('/unity.log')) return new Response('[Hawkes] stage: unity\n[Hawkes] built 2 scene(s)\n');
      if (key.endsWith('/artifact.tgz')) return new Response(Buffer.from('fake tar.gz bytes') as unknown as BodyInit);
      return new Response('not found', { status: 404 });
    }
    if (url.includes('run.googleapis.com') && url.endsWith(':run')) { runs++; return json({ metadata: { name: `projects/hawkes-test/locations/us-east4/jobs/${url.split('/jobs/')[1].split(':')[0]}/executions/e-${runs === 1 ? 7 : 7 + runs}` } }); }
    const ex = /\/executions\/e-(\d+)$/.exec(url);
    if (url.includes('run.googleapis.com') && ex) {
      const n = Number(ex[1]) === 7 ? 1 : Number(ex[1]) - 7;
      return json(executions[n - 1] ?? { startTime: '2026-10-31T10:00:00Z', completionTime: '2026-10-31T10:06:00Z', succeededCount: 1 });
    }
    const create = /run\.googleapis\.com\/v2\/projects\/hawkes-test\/locations\/us-east4\/jobs\?jobId=([^&]+)$/.exec(url);
    if (create && method === 'POST') {
      if (!canCreate) return json({ error: { message: 'Permission run.jobs.create denied' } }, 403);
      created.set(decodeURIComponent(create[1]), JSON.parse(body));
      return json({ name: 'projects/hawkes-test/locations/us-east4/operations/op-1', done: true });
    }
    if (url.startsWith('https://logging.googleapis.com/')) return json({ entries: [] });
    const jobGet = /run\.googleapis\.com\/v2\/projects\/hawkes-test\/locations\/us-east4\/jobs\/([^/:]+)$/.exec(url);
    if (jobGet && method === 'GET') {
      const name = jobGet[1];
      const j = name in jobs ? jobs[name] : created.has(name) ? created.get(name) : name.endsWith('-customer') ? customerJobResource() : null;
      return j ? json(j) : json({ error: { message: 'not found' } }, 404);
    }
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  return { writes, calls, created, runs: () => runs, restore: () => { globalThis.fetch = real; } };
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
    assert.match(s.cache.prefix, /^unity-cache\/cust--usr_acme--acme--rocket-game--Game-[0-9a-f]{10}$/, 'a readable name with a hash of the full one');
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

test('the other version picks its own job; a lost token says to submit again, before anything starts', async () => {
  const g = fakeCloud({ version: '6000.0.40f1', result: { ok: true, unity: '6000.0.40f1', output: { object: 'unity-builds/j_cust3/artifact.tgz', bytes: 10, files: 1 } } });
  try {
    const { ctx } = ctxFor('j_cust3', { ...C.admitCustomer(good()), method: 'Acme.Build.Web' });
    await runCustomerBuild(ctx);
    assert.match(g.calls.find((c) => c.url.endsWith(':run'))!.url, /jobs\/hawkes-unity-6000-0-customer:run$/);
    const s = JSON.parse(g.writes.get('unity-builds/j_cust3/spec.json')!.toString('utf8'));
    assert.equal(s.method, 'Acme.Build.Web');
    assert.equal(s.customer.defaultMethod, false);
    const lost = ctxFor('j_cust4', { ...C.admitCustomer(good(), () => 'tok_' + 'f'.repeat(24)) });
    await assert.rejects(() => runCustomerBuild(lost.ctx), /no longer has the GitHub token/);
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
  assert.equal(C.customerUrlSeconds(40), 90 * 60, 'the build limit + 15 for the execution + 15 of margin + 20 for region moves');
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
  const cache = `unity-cache/${C.customerCacheRepo('usr_acme', 'acme/rocket-game', 'Game')}`;
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
        assert.equal(c.expires, (40 + 50) * 60);
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
  assert.ok(!g.calls.some((c) => c.method === 'GET' && /\/jobs\/[^/:]+-customer$/.test(c.url)), 'no customer job check');
  // us-east4 runs the live services (settings' liveRegion): the fallback region us-central1 is tried first (its job
  // is checked: this fake cloud has none there), and the build lands in us-east4 only after it.
  const central = g.calls.findIndex((c) => c.method === 'GET' && c.url.endsWith('/locations/us-central1/jobs/hawkes-unity-build'));
  assert.ok(central >= 0 && central < g.calls.indexOf(run!), 'us-central1 first');
  assert.match(run!.url, /locations\/us-east4\//);
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

test("the live services' region is cleaned: a region name, \"\" to turn it off, else us-east4", () => {
  assert.equal(loadSettings().unityBuild.gcp.liveRegion, 'us-east4', 'the default');
  try {
    withGcp({ liveRegion: 'us-west1' });
    assert.equal(loadSettings().unityBuild.gcp.liveRegion, 'us-west1');
    withGcp({ liveRegion: '' });
    assert.equal(loadSettings().unityBuild.gcp.liveRegion, '');
    withGcp({ liveRegion: 'nope!' });
    assert.equal(loadSettings().unityBuild.gcp.liveRegion, 'us-east4');
  } finally {
    withGcp({});
  }
});

test("GitHub's longer tokens pass the check; a bad one is named by its shape, never echoed", async () => {
  const C2 = await import('../src/providers/builder/customer.ts');
  assert.ok(C2.TOKEN_RE.test(`ghs_${'a1B_'.repeat(90)}`), 'a long installation token with underscores');
  assert.ok(C2.TOKEN_RE.test(`ghs_${'aZ9-x.Q'.repeat(54)}`), "GitHub's 380-character installation tokens, dots and dashes included");
  assert.ok(!C2.TOKEN_RE.test('ghs_abcdefghijklmnopqrstuvwxyz "quoted"'), 'no spaces or quotes');
  assert.ok(C2.TOKEN_RE.test('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!C2.TOKEN_RE.test('Bearer ghs_abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!C2.TOKEN_RE.test('ghs_short'));
});

test("credits: a build that failed on the project itself or ran a while before a cancel keeps its charge; Gen's own failures are refunded", async () => {
  const { keepsCharge } = await import('../src/jobs.ts');
  const now = 1_000_000_000;
  const u = (started: number | null = now - 10 * 60_000) => ({ tool: 'unity.build', started });
  assert.equal(keepsCharge(u(), { kind: 'build' }, false, now), true, 'a compile error');
  assert.equal(keepsCharge(u(), { kind: 'timeout' }, false, now), true, 'its time limit');
  for (const kind of ['license', 'builder', 'gcp', 'config', 'source', 'capacity']) assert.equal(keepsCharge(u(), { kind }, false, now), false, kind);
  assert.equal(keepsCharge(u(now - 30_000), null, true, now), false, 'cancelled in its first two minutes');
  assert.equal(keepsCharge(u(), null, true, now), true, 'cancelled after running a while');
  assert.equal(keepsCharge({ tool: 'image.generate', started: now - 60 * 60_000 }, { kind: 'build' }, false, now), false, 'other tools refund as before');
});

// ------------------------------------------------------------------ machine sizes (sizes.ts; J, 2026-11-01: "make it cheap")

const OK_RESULT = (job: string) => ({ ok: true, stage: 'end', exitCode: 0, unity: '6000.3.7f1', seconds: { unity: 300 }, cache: { restoredFrom: null, saved: true, savedKey: 'build' },
  memoryPeakBytes: 9 * 1024 ** 3, output: { object: `unity-builds/${job}/artifact.tgz`, bytes: 52_000_000, files: 12, changed: [], deleted: [] } });

test('machine sizes: admit keeps a size name or { cpu, memoryGiB }, refuses what Cloud Run can\'t run; J\'s builds refuse it', async () => {
  assert.equal(C.admitCustomer({ ...good(), machine: 'S' }).machine, 's');
  assert.equal(C.admitCustomer({ ...good(), machine: { cpu: 8, memoryGiB: 32 } }).machine, 'xl', 'a named size by its numbers');
  assert.deepEqual(C.admitCustomer({ ...good(), machine: { cpu: 4, memoryGiB: 12 } }).machine, { cpu: 4, memoryGiB: 12 });
  assert.equal('machine' in C.admitCustomer(good()), false, 'none asked: settings\' customerSize at run time');
  assert.throws(() => C.admitCustomer({ ...good(), machine: 'huge' }), (e: any) => e.status === 400 && /isn't a build size/.test(e.message) && /m \(4 vCPU, 16 GiB\)/.test(e.message));
  assert.throws(() => C.admitCustomer({ ...good(), machine: { cpu: 2, memoryGiB: 16 } }), /2 vCPU takes 1 to 8 GiB/);
  assert.throws(() => C.admitCustomer({ ...good(), machine: { cpu: 3, memoryGiB: 8 } }), /cpu must be 2, 4, 6, 8/);
  const { getTool } = await import('../src/tools/index.ts');
  assert.throws(() => getTool('unity.build')!.admit!({ params: { project: 'sickofitgame-unity', machine: 's' } } as any), /machine is for customer builds/);
});

test('machine sizes: the default m runs on its own job, made from the customer job with 4 vCPU and 16 GiB', async () => {
  const g = fakeCloud({ result: OK_RESULT('j_size1'), canCreate: true });
  try {
    const { ctx } = ctxFor('j_size1', C.admitCustomer(good()));
    await runCustomerBuild(ctx);
    const run = g.calls.find((c) => c.url.endsWith(':run'))!;
    assert.match(run.url, /jobs\/hawkes-unity-build-customer-m:run$/);
    const made = g.created.get('hawkes-unity-build-customer-m');
    assert.deepEqual(made.template.template.containers[0].resources.limits, { cpu: '4', memory: '16Gi' });
    assert.equal(made.template.template.serviceAccount, 'unity-customer@hawkes-test.iam.gserviceaccount.com', 'the same account: nothing it may reach');
    assert.ok(made.template.template.containers[0].env.some((e: any) => e.name === 'HAWKES_CUSTOMER_JOB' && e.value === '1'));
    assert.deepEqual(ctx.value.machine, { name: 'm', cpu: 4, memoryGiB: 16 });
    assert.equal(ctx.value.machineAsked, 'm');
    // Priced at the size it ran on: 6 minutes at 4 vCPU / 16 GiB.
    const { cloudRunCost } = await import('../src/providers/builder/cloudrun.ts');
    assert.equal(ctx.value.cost, Math.round(cloudRunCost(360, 4, 16) * 1000) / 1000);
    assert.ok(cloudRunCost(4800, 4, 16) < 0.51 && cloudRunCost(4800, 8, 32) > 0.99, '80 minutes: about $0.50 on m, $1.00 on xl');
  } finally {
    g.restore();
  }
});

test('machine sizes: when Gen may not make the size\'s job, the build runs on the customer job (xl) with a warning', async () => {
  const g = fakeCloud({ result: OK_RESULT('j_size2'), canCreate: false });
  try {
    const { ctx, logs } = ctxFor('j_size2', C.admitCustomer({ ...good(), machine: 's' }));
    await runCustomerBuild(ctx);
    assert.equal(ctx.value.ok, true, 'never fails over a size');
    assert.match(g.calls.find((c) => c.url.endsWith(':run'))!.url, /jobs\/hawkes-unity-build-customer:run$/);
    assert.deepEqual(ctx.value.machine, { name: 'xl', cpu: 8, memoryGiB: 32 });
    assert.equal(ctx.value.machineAsked, 's');
    assert.match(ctx.value.warnings[0], /The s build machine .* isn't set up .*customer-setup\.mjs --sizes --apply/);
    assert.ok(logs.some((l) => /isn't set up/.test(l)));
  } finally {
    g.restore();
  }
});

test('machine sizes: out of memory on s, built again once on m, and the result says so', async () => {
  const oom = { startTime: '2026-10-31T10:00:00Z', completionTime: '2026-10-31T10:03:00Z', succeededCount: 0, failedCount: 1,
    conditions: [{ type: 'Completed', state: 'CONDITION_FAILED', message: 'Task j-x failed: Memory limit of 8192 MiB exceeded with 8400 MiB used.' }] };
  const g = fakeCloud({ result: (run) => (run === 1 ? null : OK_RESULT('j_size3')), executions: [oom], canCreate: true });
  try {
    const params = C.admitCustomer({ ...good(), machine: 's' });
    const { ctx, logs } = ctxFor('j_size3', params);
    await runCustomerBuild(ctx);
    const runs = g.calls.filter((c) => c.url.endsWith(':run'));
    assert.equal(runs.length, 2);
    assert.match(runs[0].url, /customer-s:run$/);
    assert.match(runs[1].url, /customer-m:run$/);
    // The second execution had the token too: kept for the retry, dropped after.
    assert.ok(JSON.parse(runs[1].body).overrides.containerOverrides[0].env.some((e: any) => e.name === 'HAWKES_GITHUB_TOKEN' && e.value === TOKEN));
    assert.equal(tokenFor(params.github.tokenRef), null);
    const r = ctx.value;
    assert.equal(r.ok, true);
    assert.deepEqual(r.machine, { name: 'm', cpu: 4, memoryGiB: 16 });
    assert.equal(r.machineAsked, 's');
    assert.deepEqual({ reason: r.retried.reason, from: r.retried.from, to: r.retried.to }, { reason: 'out of memory', from: 's', to: 'm' });
    assert.ok(r.totalCost > r.cost, 'both runs counted');
    assert.ok(logs.some((l) => /ran out of memory on s .* building again on m/.test(l)));
  } finally {
    g.restore();
  }
});

test('machine sizes: out of memory on xl (the biggest) is not built again', async () => {
  const oom = { startTime: '2026-10-31T10:00:00Z', completionTime: '2026-10-31T10:03:00Z', succeededCount: 0, failedCount: 1,
    conditions: [{ type: 'Completed', state: 'CONDITION_FAILED', message: 'Memory limit of 32768 MiB exceeded' }] };
  const g = fakeCloud({ result: () => null, executions: [oom], canCreate: true });
  try {
    const { ctx } = ctxFor('j_size4', C.admitCustomer({ ...good(), machine: 'xl' }));
    await assert.rejects(() => runCustomerBuild(ctx));
    assert.equal(g.calls.filter((c) => c.url.endsWith(':run')).length, 1);
    assert.equal(ctx.value.retried, undefined);
  } finally {
    g.restore();
  }
});

test('the token vault survives a restart (encrypted at rest), and an expired or missing one fails before any build time', async () => {
  const intake = await import('../src/providers/playtester/intake.ts');
  process.env.HAWKESGEN_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  const logs: string[] = [];
  const ref = intake.holdToken(TOKEN);
  const row = db.prepare('SELECT * FROM held_tokens WHERE ref = ?').get(ref) as any;
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes(TOKEN), 'the token is never stored in clear');
  intake.forgetMemoryTokens(); // Gen restarted
  const b = { tokenRef: ref } as any;
  assert.equal(C.customerToken(b, undefined, (m) => logs.push(m)), TOKEN);
  assert.match(logs.join('\n'), /restored from the encrypted store/);
  assert.equal(C.customerToken(b, undefined, (m) => logs.push(m)), TOKEN);
  assert.match(logs[logs.length - 1], /found in memory/);
  // Expired: past its time, in memory or only in the store.
  const old = intake.holdToken(TOKEN, Date.now() - 13 * 3600_000);
  for (const restart of [false, true]) {
    if (restart) intake.forgetMemoryTokens();
    const e = (() => { try { C.customerToken({ tokenRef: old } as any, undefined, (m) => logs.push(m)); } catch (x) { return x as any; } })();
    assert.equal(e?.kind, 'token');
    assert.match(e.message, /expired.*Nothing was built/);
  }
  assert.match(logs.join('\n'), /expired.*asking Studio/);
  // Dropped: gone from both.
  intake.dropToken(ref);
  intake.forgetMemoryTokens();
  assert.equal(intake.tokenFor(ref), null);
  assert.equal(db.prepare('SELECT 1 FROM held_tokens WHERE ref = ?').get(ref), undefined);
  assert.throws(() => C.customerToken(b, undefined, (m) => logs.push(m)), (e: any) => e.kind === 'token' && /no longer has/.test(e.message));
  assert.match(logs[logs.length - 1], /not found in memory or the store/);
  delete process.env.HAWKESGEN_SECRETS_KEY;
});

test('GitHub refusing the token (401) is a token failure, 403 stays a source one', async () => {
  const f = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
  await assert.rejects(() => C.probeProject({ repo: 'a/b', commit: SHA, path: '.' }, TOKEN, f(401)), (e: any) => e.kind === 'token' && /fresh token/.test(e.message));
  await assert.rejects(() => C.probeProject({ repo: 'a/b', commit: SHA, path: '.' }, TOKEN, f(403)), (e: any) => e.kind === 'source');
});


// ------------------------------------------------------------------ one job, one build (sick-of-it-unity j_bb4c57cd1cf3)
// 2026-11-03: the build succeeded, Gen went down while keeping its 1 GB output (a Buffer beside its temp file and its
// library copy on a 4 GiB instance whose disk is memory), the note and the bucket's artifact were already deleted, so each
// restart built the game again; the fifth execution failed at the fetch, overwrote result.json, and Gen read the earlier
// execution's unity.log as its own ("couldn't fetch ...: ##utp:{MemoryLeaks ...}").

const okResult = (job: string) => ({ ok: true, stage: 'end', exitCode: 0, unity: '6000.3.7f1', seconds: { unity: 300 }, cache: { restoredFrom: 'build', saved: true, savedKey: 'build' },
  output: { object: `unity-builds/${job}/artifact.tgz`, bytes: 52_000_000, files: 12, changed: [], deleted: [] }, log: `unity-builds/${job}/unity.log` });

test('Gen going down while it keeps the build: the restart keeps the same build, it never builds again', async () => {
  const g = fakeCloud({ result: okResult('j_keep1') });
  try {
    const params = C.admitCustomer(good());
    const first = ctxFor('j_keep1', params);
    // The first run gets as far as the log, then Gen goes down while keeping the artifact.
    first.ctx.emit = async (o: any) => { if (o.mime === 'application/gzip') throw new Error('Gen went down (out of memory)'); first.outputs.push({ asset: 'a_log', mime: o.mime }); };
    await assert.rejects(() => runCustomerBuild(first.ctx), /went down/);
    assert.equal(g.runs(), 1);
    assert.ok(g.writes.has('unity-builds/j_keep1/cloud-job.json'), 'the note stays until the output is kept');
    assert.ok(!g.calls.some((c) => c.method === 'DELETE' && c.url.includes('artifact.tgz')), "the bucket's artifact stays until it is kept");
    // A new instance (no local note): it follows the same finished execution and keeps its output.
    fs.rmSync(path.join(data, 'builder', 'cloud-jobs', 'j_keep1.json'), { force: true });
    const again = ctxFor('j_keep1', params);
    await runCustomerBuild(again.ctx);
    assert.equal(g.runs(), 1, 'no second execution');
    assert.equal(again.ctx.value.ok, true);
    assert.equal(again.outputs[1].mime, 'application/gzip');
    assert.ok(!g.writes.has('unity-builds/j_keep1/cloud-job.json'), 'kept: the note goes');
    assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.url.includes('unity-builds%2Fj_keep1%2Fartifact.tgz')), "kept: the bucket's copy goes");
  } finally {
    g.restore();
  }
});

test("a lost note and an earlier execution's success still in the bucket: kept from it, nothing runs again", async () => {
  const job = 'j_keep2';
  const g = fakeCloud({ result: okResult(job), cacheObjects: [`unity-builds/${job}/result.json`, `unity-builds/${job}/unity.log`, `unity-builds/${job}/artifact.tgz`, `unity-builds/${job}/spec.json`] });
  g.writes.set(`unity-builds/${job}/spec.json`, Buffer.from(JSON.stringify({ job, cache: { prefix: 'unity-cache/cust--usr_acme--acme--rocket-game-0123456789', restore: ['build'], save: 'build', clean: false } })));
  try {
    // Started (the note was written) by a run long gone; the token is past GitHub's hour: nothing may need it.
    const { ctx, logs, outputs } = ctxFor(job, C.admitCustomer(good()));
    await runCustomerBuild(ctx);
    assert.equal(g.runs(), 0, 'not built again');
    assert.equal(ctx.value.ok, true);
    assert.match(ctx.value.recovered, /earlier execution/);
    assert.equal(outputs[1].mime, 'application/gzip');
    assert.match(logs.join('\n'), /already built it/);
  } finally {
    g.restore();
  }
});

test("a new execution's failure is its own: the earlier one's result and Unity log are cleared first and never read as its own", async () => {
  const job = 'j_own1';
  const fetchFail = { ok: false, stage: 'source', kind: 'source', error: "couldn't fetch acme/rocket-game at cccccccccccc (is the commit pushed, and can the GitHub token read the repo?): git said: fatal: remote error: upload-pack: not our ref", exitCode: null, seconds: { license: 7, source: 0, total: 10 }, cache: { restoredFrom: null, saved: false }, output: null, log: null };
  const earlier = { ...okResult(job), ok: false, kind: 'build', error: 'Unity exited with code 1' };
  const g = fakeCloud({ result: (runs: number) => (runs === 0 ? earlier : fetchFail), cacheObjects: [`unity-builds/${job}/result.json`, `unity-builds/${job}/unity.log`] });
  try {
    const { ctx } = ctxFor(job, C.admitCustomer(good()));
    await assert.rejects(() => runCustomerBuild(ctx), (e: any) => e.kind === 'source' && e.message === fetchFail.error);
    const del = (k: string) => g.calls.findIndex((c) => c.method === 'DELETE' && c.url.includes(`unity-builds%2F${job}%2F${k}`));
    const run = g.calls.findIndex((c) => c.url.endsWith(':run'));
    assert.ok(del('result.json') >= 0 && del('result.json') < run, "the earlier result is cleared before the new execution starts");
    assert.ok(del('unity.log') >= 0 && del('unity.log') < run, "the earlier Unity log too");
    assert.equal(ctx.value.logTail, '', 'no Unity log: this execution never ran Unity');
    assert.ok(!g.calls.some((c) => c.method === 'GET' && c.url.includes(`${job}%2Funity.log`) && g.calls.indexOf(c) > run), 'the old unity.log is never read');
  } finally {
    g.restore();
  }
});

test('a held token close to GitHub\'s hour starts no new build: kind token, in words Studio reads as "get a fresh one"', () => {
  const logs: string[] = [];
  const at = (min: number) => () => ({ token: TOKEN, ageSeconds: min * 60, from: 'store' as const });
  assert.equal(C.customerToken({ tokenRef: 'tok_' + '2'.repeat(24) } as any, at(10), (m) => logs.push(m)), TOKEN);
  const e = (() => { try { C.customerToken({ tokenRef: 'tok_' + '2'.repeat(24) } as any, at(54), (m) => logs.push(m)); } catch (x) { return x as any; } })();
  assert.equal(e?.kind, 'token');
  assert.match(e.message, /token for this build expired.*Nothing was built: resubmit it with a fresh token/);
  assert.match(logs[logs.length - 1], /held 54 min/);
});

test('a big output is moved into the library, never read into memory', async () => {
  const { putAsset } = await import('../src/library.ts');
  const tmp = path.join(data, 'big-artifact.tgz');
  const bytes = crypto.randomBytes(5 * 1024 * 1024 + 7);
  fs.writeFileSync(tmp, bytes);
  const a = putAsset({ data: Buffer.alloc(0), fromFile: tmp, ext: '.tgz', mime: 'application/gzip', client: 'cust', project: 'usr_acme', tool: 'unity.build', recipe: { tool: 'unity.build', version: 1, params: {}, inputs: {} } });
  assert.equal(fs.existsSync(tmp), false, 'moved, not copied');
  assert.equal(a.bytes, bytes.length);
  assert.equal(a.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.ok(fs.readFileSync(a.path).equals(bytes));
});
