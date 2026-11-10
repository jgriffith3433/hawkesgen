// Customers' builds for playtest.run and the runner router (docs/playtest-runners.md), with no cloud anywhere: the
// build param's forms and the GitHub token kept out of the params, SSRF refusals (names, numbers, IPv6, DNS that points
// inside), GitHub resolved to GitHub's own links (never downloaded), archives staged by content and signed, the router's
// choice, lanes, cooldowns and fallback, a native run against a fake hawkes-play-native runner (the session protocol),
// one that refuses and the next that plays, the browser service's own site serving (site.mjs), and the prices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-intake-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
process.env.HAWKES_PLAYTEST_BUCKET = 'off';

const intake = await import('../src/providers/playtester/intake.ts');
const { runnerCandidates, runnersFor, resetRunners, claimRunner, runnerHealthKey } = await import('../src/providers/playtester/runners.ts');
const { runSession, RunnerUnavailable, groupCrashes } = await import('../src/providers/playtester/native.ts');
const { markDown, isDown, resetHealth } = await import('../src/providers/gpu/health.ts');
const { saveSettings, loadSettings, SETTINGS_DEFAULTS, cleanRunners } = await import('../src/config.ts');
const { quoteJobCredits, isInternalOnlyTool, playtestMinutes } = await import('../src/billing.ts');
const { playtestRunTool } = await import('../src/tools/playtest.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { callScope } = await import('../src/providers/anthropic.ts');
const site = await import('../server/playtest-cloudrun/site.mjs');
const { wsServer: WebSocketServer } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

const tmp = (n: string) => path.join(process.env.HAWKESGEN_DATA_DIR!, n);

// ------------------------------------------------------------------ the build param

test('build forms: blob, asset, URL, { url }, GitHub; anything else is refused', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(intake.parseBuild(`blob:${sha}`, null, { customer: true }), { kind: 'blob', sha });
  assert.deepEqual(intake.parseBuild('asset:as_123', null, { customer: true }), { kind: 'asset', id: 'as_123' });
  assert.deepEqual(intake.parseBuild(null, 'https://example.com/game/', { customer: true }), { kind: 'url', url: 'https://example.com/game/' });
  assert.deepEqual(intake.parseBuild({ url: 'https://example.com/b.zip' }, null, { customer: true }), { kind: 'url', url: 'https://example.com/b.zip' });
  assert.equal(intake.parseBuild(undefined, undefined, { customer: false }), null);
  assert.throws(() => intake.parseBuild('blob:nothex', null, { customer: true }), /sha256/);
  assert.throws(() => intake.parseBuild({ github: { repo: 'nope' , release: 'v1' } }, null, { customer: true }), /owner\/name/);
  assert.throws(() => intake.parseBuild({ github: { repo: 'a/b', release: 'v1', ref: 'main' } }, null, { customer: true }), /exactly one/);
  assert.throws(() => intake.parseBuild({ github: { repo: 'a/b', run: 12 } }, null, { customer: true }), /need a token/);
  assert.throws(() => intake.parseBuild({ github: { repo: 'a/b', ref: '../x' } }, null, { customer: true }), /branch, tag or commit/);
  assert.throws(() => intake.parseBuild(42, null, { customer: true }), /build/);
  // J's own local dev keeps localhost (owner/studio keys only).
  assert.deepEqual(intake.parseBuild(null, 'http://localhost:8089/', { customer: false }), { kind: 'url', url: 'http://localhost:8089/' });
});

test('a GitHub token is used for the run and never stored: the params carry only a reference', () => {
  const token = `ghp_${'x'.repeat(36)}`;
  const b = intake.parseBuild({ github: { repo: 'acme/game', run: 991, artifact: 'webgl', token } }, null, { customer: true }) as any;
  const stored = JSON.stringify(intake.storedBuild(b));
  assert.ok(!stored.includes(token), stored);
  assert.match(b.tokenRef, /^tok_[0-9a-f]{24}$/);
  assert.equal(intake.tokenFor(b.tokenRef), token);
  intake.dropToken(b.tokenRef);
  assert.equal(intake.tokenFor(b.tokenRef), null);
  // Expired: gone.
  const old = intake.holdToken(token, Date.now() - 13 * 3600_000);
  assert.equal(intake.tokenFor(old), null);
  assert.throws(() => intake.parseBuild({ github: { repo: 'a/b', ref: 'main', token: 'hunter2' } }, null, { customer: true }), /GitHub token/);
  // A stored build (a rerun) is checked again and keeps its reference; an Actions run without one is refused.
  const ref = intake.holdToken(token);
  assert.deepEqual(intake.parseBuild({ kind: 'github', repo: 'acme/game', run: 991, artifact: 'webgl', tokenRef: ref }, null, { customer: true }), { kind: 'github', repo: 'acme/game', run: 991, artifact: 'webgl', tokenRef: ref });
  assert.throws(() => intake.parseBuild({ kind: 'github', repo: 'acme/game', run: 991 }, null, { customer: true }), /need a token/);
  assert.deepEqual(intake.parseBuild({ kind: 'blob', sha: 'c'.repeat(64) }, null, { customer: true }), { kind: 'blob', sha: 'c'.repeat(64) });
  assert.throws(() => intake.parseBuild({ kind: 'url', url: 'http://10.0.0.1/' }, null, { customer: true }), /private/);
});

test('exe, args and targets are checked', () => {
  assert.equal(intake.checkEntry('Game/Game.exe'), 'Game/Game.exe');
  assert.equal(intake.checkEntry('Game\\Game.exe'), 'Game/Game.exe');
  for (const bad of ['../x.exe', '/bin/sh', 'C:/Windows/x.exe', 'a/../../b']) assert.throws(() => intake.checkEntry(bad), /inside the build/, bad);
  assert.deepEqual(intake.checkArgs(['-batchmode', '-x']), ['-batchmode', '-x']);
  assert.throws(() => intake.checkArgs('rm -rf'), /list of strings/);
  assert.throws(() => intake.checkArgs(Array(40).fill('a')), /list of strings/);
  assert.throws(() => intake.checkTarget('proton', { kind: 'url', url: 'https://example.com/play/' }), /archive/);
  intake.checkTarget('proton', { kind: 'url', url: 'https://example.com/b.zip' });
  intake.checkTarget('web', { kind: 'url', url: 'https://example.com/play/' });
  assert.throws(() => intake.checkTarget('web', null), /needs a build/);
});

// ------------------------------------------------------------------ SSRF

test('SSRF: private, loopback, link-local and metadata addresses are refused however they are written', () => {
  const refused = [
    'http://localhost:8089/', 'http://LOCALHOST/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'http://169.254.169.254/computeMetadata/v1/', 'http://metadata.google.internal/', 'http://metadata/', 'http://10.0.0.5/', 'http://172.16.3.4/',
    'http://192.168.1.1/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://gen.internal/', 'http://printer.local/', 'http://intranet/',
    'https://user:pass@example.com/', 'file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/',
  ];
  for (const u of refused) assert.throws(() => intake.checkPublicUrl(u), /./, u);
  for (const u of ['https://example.com/game/', 'http://93.184.216.34/', 'https://[2606:4700::1111]/', 'https://itch.zone/html/123/index.html']) assert.equal(intake.checkPublicUrl(u).href.length > 0, true, u);
  // And through the tool's admit, as a customer: refused before anything is queued.
  assert.throws(() => playtestRunTool.admit!({ params: { url: 'http://127.0.0.1:8790/v1/settings' }, client: { id: 'c', role: 'user', projects: ['usr_a'] }, project: 'usr_a', customer: true }), /public|private/);
  // The studio's own keys keep local dev.
  const own = playtestRunTool.admit!({ params: { url: 'http://localhost:8089/' }, client: { id: 'o', role: 'owner', projects: ['*'] }, project: 'doseofdestruction', customer: false });
  assert.equal(own.url, 'http://localhost:8089/');
  assert.notEqual(own.gpu, 'require');
});

test('SSRF: a public-looking name that resolves inside is refused when the run starts', async () => {
  const inside = async () => [{ address: '10.1.2.3' }];
  await assert.rejects(intake.publicUrl('https://rebind.example.com/', inside), /10\.1\.2\.3/);
  await assert.rejects(intake.publicUrl('https://v6.example.com/', async () => [{ address: '93.184.216.34' }, { address: '::1' }]), /::1/);
  const ok = await intake.publicUrl('https://example.com/', async () => [{ address: '93.184.216.34' }]);
  assert.equal(ok.hostname, 'example.com');
});

// ------------------------------------------------------------------ GitHub, staging

function fakeGithub(log: { url: string; auth: string | null; redirect: string | undefined }[]) {
  return (async (url: string, init: any = {}) => {
    log.push({ url, auth: init.headers?.Authorization ?? null, redirect: init.redirect });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    const go = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    if (url.endsWith('/releases/tags/v1.2')) return json({ tag_name: 'v1.2', assets: [{ id: 7, name: 'notes.txt', size: 1 }, { id: 8, name: 'Game-Linux.tar.gz', size: 123 }] });
    if (url.endsWith('/releases/assets/8')) return go('https://objects.githubusercontent.com/signed/linux?sig=1');
    if (url.includes('/actions/runs/55/artifacts')) return json({ artifacts: [{ id: 3, name: 'webgl', size_in_bytes: 99, expired: false }, { id: 4, name: 'win', expired: false }] });
    if (url.endsWith('/actions/artifacts/3/zip')) return go('https://pipelines.actions.githubusercontent.com/signed/webgl?sig=2');
    if (url.includes('/zipball/')) return go('https://codeload.github.com/acme/game/legacy.zip/main?token=short');
    if (url.includes('/private/')) return new Response('{}', { status: 404 });
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
}

test('GitHub builds resolve to GitHub\'s own short links: Gen asks where, never downloads, and sends the token only to api.github.com', async () => {
  const log: any[] = [];
  const f = fakeGithub(log);
  const rel = await intake.resolveGithub({ kind: 'github', repo: 'acme/game', release: 'v1.2' }, { fetch: f, token: null });
  assert.equal(rel.url, 'https://objects.githubusercontent.com/signed/linux?sig=1');
  assert.equal(rel.name, 'Game-Linux.tar.gz');
  const token = `ghp_${'y'.repeat(36)}`;
  const art = await intake.resolveGithub({ kind: 'github', repo: 'acme/game', run: 55, artifact: 'webgl' }, { fetch: f, token });
  assert.equal(art.url, 'https://pipelines.actions.githubusercontent.com/signed/webgl?sig=2');
  const src = await intake.resolveGithub({ kind: 'github', repo: 'acme/game', ref: 'main' }, { fetch: f, token });
  assert.match(src.url, /^https:\/\/codeload\.github\.com\//);
  assert.ok(log.every((x) => x.url.startsWith('https://api.github.com/')), 'only the API is called');
  assert.ok(log.filter((x) => /\/(assets\/8|artifacts\/3\/zip|zipball)/.test(x.url)).every((x) => x.redirect === 'manual'), 'downloads are never followed');
  assert.equal(log.filter((x) => x.auth === `Bearer ${token}`).length, 3);
  // Two artifacts and none named: say which exist.
  await assert.rejects(intake.resolveGithub({ kind: 'github', repo: 'acme/game', run: 55 }, { fetch: f, token }), /2 artifacts: name one.*webgl, win/);
  await assert.rejects(intake.resolveGithub({ kind: 'github', repo: 'acme/private', release: 'latest' }, { fetch: f, token: null }), /404/);
  // A token that went with a restart.
  await assert.rejects(intake.resolveGithub({ kind: 'github', repo: 'acme/game', ref: 'main', tokenRef: 'tok_gone' }, { fetch: f }), /gone/);
});

test('an uploaded archive is staged once by content under its project and signed for the run; a non-archive is refused', async () => {
  const zip = tmp('build.zip');
  fs.writeFileSync(zip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]));
  const objects = new Map<string, string>();
  const stager = {
    stat: async (u: string) => (objects.has(u) ? { size: 1 } : null),
    writeFile: async (u: string, f: string) => { objects.set(u, f); },
    sign: async (u: string, s: number) => `https://storage.googleapis.com/${u.slice(5)}?X-Goog-Expires=${s}&sig=z`,
  };
  const sha = 'b'.repeat(64);
  const a = await intake.stageArchive(zip, sha, 'usr_aaaa', 'lib-bkt', stager);
  assert.equal(a.url, `https://storage.googleapis.com/lib-bkt/playtest-builds/usr_aaaa/${sha}?X-Goog-Expires=21600&sig=z`);
  assert.equal(a.kind, 'archive');
  await intake.stageArchive(zip, sha, 'usr_aaaa', 'lib-bkt', { ...stager, writeFile: async () => { throw new Error('uploaded twice'); } });
  assert.equal(objects.size, 1);
  // Another org's run of the same bytes gets its own copy under its own prefix.
  await intake.stageArchive(zip, sha, 'usr_bbbb', 'lib-bkt', stager);
  assert.ok(objects.has(`gs://lib-bkt/playtest-builds/usr_bbbb/${sha}`));
  const txt = tmp('notes.txt');
  fs.writeFileSync(txt, 'just text');
  await assert.rejects(intake.stageArchive(txt, sha, 'usr_aaaa', 'lib-bkt', stager), /zip, tar or tar\.gz/);
  await assert.rejects(intake.stageArchive(zip, sha, 'usr_aaaa', null, null), /settings\.storage\.bucket/);
});

// ------------------------------------------------------------------ the router

const R = (over: any) => cleanRunners([{ id: 'r', provider: 'native', url: 'https://runner.example.com', targets: ['proton'], lanes: ['studio', 'customer'], pricePerSecond: 0.0002, maxConcurrent: 1, ...over }])[0];
const settingsWith = (runners: any[], playtest: any = {}) => ({ playtest: { ...SETTINGS_DEFAULTS.playtest, ...playtest, runners } }) as any;

test('runners: settings are checked (providers, targets, URLs, numbers)', () => {
  const list = cleanRunners([
    { id: 'ok', provider: 'native', url: 'https://a.example.com/', targets: ['linux', 'proton', 'nope'], maxConcurrent: 3, pricePerSecond: 0.0001, tokenEnv: 'PLAY_NATIVE_TOKEN' },
    { id: 'no-url', provider: 'native', targets: ['linux'] },
    { id: 'bad-provider', provider: 'ssh', url: 'https://a.example.com', targets: ['web'] },
    { id: 'no-targets', provider: 'runpod', targets: [] },
    { id: 'ok', provider: 'runpod', targets: ['web'] },
    { id: 'web', provider: 'runpod', targets: ['web'], url: 'http://10.0.0.1:8080' },
  ]);
  assert.deepEqual(list.map((r) => r.id), ['ok', 'web']);
  assert.deepEqual(list[0].targets, ['linux', 'proton']);
  assert.deepEqual(list[0].lanes, ['studio', 'customer']);
  assert.equal(list[0].tokenEnv, 'PLAY_NATIVE_TOKEN');
  assert.equal(list[1].url, null, 'a private address is not a runner URL');
});

test('the router: by target and lane, first with room first, cooldowns and tries skipped, full ones last', () => {
  resetHealth();
  resetRunners();
  const runners = [
    R({ id: 'studio-only', lanes: ['studio'] }),
    R({ id: 'proton-a' }),
    R({ id: 'proton-b', maxConcurrent: 2 }),
    R({ id: 'linux', targets: ['linux'] }),
    R({ id: 'off', enabled: false }),
    R({ id: 'needs-key', tokenEnv: 'NATIVE_KEY_X' }),
  ];
  const s = settingsWith(runners);
  const get = (k: string) => (k === 'NATIVE_KEY_X' ? 'k' : undefined);
  const ids = (c: any) => c.choices.map((x: any) => x.runner.id);
  const c1 = runnerCandidates({ project: 'usr_a' }, 'proton', 'customer', s, { get });
  assert.deepEqual(ids(c1), ['proton-a', 'proton-b', 'needs-key']);
  assert.ok(c1.skipped.some((x) => /studio-only: doesn't take customers'/.test(x)));
  assert.ok(c1.skipped.some((x) => /linux: doesn't play proton/.test(x)));
  assert.ok(c1.skipped.some((x) => /off: turned off/.test(x)));
  assert.equal((c1.choices[2] as any).token, 'k');
  assert.deepEqual(ids(runnerCandidates({ project: 'doseofdestruction' }, 'proton', 'studio', s, { get })), ['studio-only', 'proton-a', 'proton-b', 'needs-key']);
  // No key in the environment: skipped, said why.
  assert.ok(runnerCandidates({ project: 'usr_a' }, 'proton', 'customer', s).skipped.some((x) => /NATIVE_KEY_X is not set/.test(x)));
  // A cooldown, and a runner this run already failed on.
  markDown(runnerHealthKey('proton-a'), 'refused', 60_000);
  assert.deepEqual(ids(runnerCandidates({ project: 'usr_a', labels: { runnersTried: ['needs-key'] } }, 'proton', 'customer', s, { get })), ['proton-b']);
  resetHealth();
  // Studio's skipProviders hint: leave those browser providers out for this job only (native runners stay).
  const withSkip = settingsWith([
    R({ id: 'runpod', provider: 'runpod', url: 'https://abc.api.runpod.ai', targets: ['web'] }),
    R({ id: 'modal', provider: 'modal', url: 'https://ws--app.modal.run', targets: ['web'] }),
    R({ id: 'native', targets: ['linux'] }),
  ]);
  assert.deepEqual(
    ids(runnerCandidates({ project: 'x', labels: { skipProviders: ['modal', 'bogus'] } }, 'web', 'studio', withSkip)),
    ['runpod'],
  );
  assert.ok(runnerCandidates({ project: 'x', labels: { skipProviders: ['modal'] } }, 'web', 'studio', withSkip).skipped.some((x) => /skipProviders left modal out/.test(x)));
  assert.deepEqual(ids(runnerCandidates({ project: 'x', labels: { skipProviders: ['modal'] } }, 'linux', 'studio', withSkip)), ['native']);
  // Full: proton-a holds its one run, so it goes after the ones with room.
  const release = claimRunner('proton-a');
  assert.deepEqual(ids(runnerCandidates({ project: 'usr_a' }, 'proton', 'customer', s, { get })), ['proton-b', 'needs-key', 'proton-a']);
  release();
  release(); // twice is once
  assert.deepEqual(ids(runnerCandidates({ project: 'usr_a' }, 'proton', 'customer', s, { get })), ['proton-a', 'proton-b', 'needs-key']);
  // Browser runners never get desktop targets, native runners never get pages.
  const mixed = settingsWith([R({ id: 'browser', provider: 'runpod', url: 'https://abc.api.runpod.ai', targets: ['web', 'linux'] }), R({ id: 'native', targets: ['web', 'linux'] })]);
  assert.deepEqual(ids(runnerCandidates({ project: 'x' }, 'linux', 'studio', mixed)), ['native']);
  assert.deepEqual(ids(runnerCandidates({ project: 'x' }, 'web', 'studio', mixed)), ['browser']);
  assert.equal((runnerCandidates({ project: 'x' }, 'web', 'studio', mixed).choices[0] as any).cloud.runner, 'browser');
  // Nothing plays Windows yet: no choices, and the reasons.
  const none = runnerCandidates({ project: 'x' }, 'windows', 'customer', s, { get });
  assert.equal(none.choices.length, 0);
  assert.ok(none.skipped.length > 0);
});

test('the router: with no runners set, today\'s browser services are the web runners, in the backend\'s order', () => {
  const spec = { name: 'gen-playtest-cpu', region: 'us-east4', gpu: null, cpu: 4, memoryGi: 8, maxInstances: 4, tabsPerInstance: 1, timeoutSeconds: 3600, variant: 'cpu' as const, slow: 2 };
  const s = settingsWith([], {
    backend: 'runpod',
    runpod: { ...SETTINGS_DEFAULTS.playtest.runpod, url: 'https://abc123.api.runpod.ai' },
    cloudrunCpu: { ...SETTINGS_DEFAULTS.playtest.cloudrunCpu, url: 'https://cpu.example.run.app' },
  });
  const list = runnersFor('usr_a', s, { cpu: spec });
  assert.deepEqual(list.map((x) => x.runner.id), ['runpod', 'cloudrun-cpu-us-east4']);
  const c = runnerCandidates({ project: 'usr_a' }, 'web', 'customer', s, { specs: { cpu: spec } });
  assert.deepEqual(c.choices.map((x: any) => x.cloud.variant), ['runpod', 'cpu']);
  assert.equal(runnerCandidates({ project: 'usr_a' }, 'proton', 'customer', s, { specs: { cpu: spec } }).choices.length, 0);
  // A list with only a desktop runner keeps today's browser services for web pages (adding it never takes them away).
  const withNative = { ...s, playtest: { ...s.playtest, runners: [R({ id: 'runpod-native', provider: 'native', url: 'https://n.api.runpod.ai', targets: ['linux', 'proton'] })] } };
  assert.deepEqual(runnersFor('usr_a', withNative, { cpu: spec }).map((x) => x.runner.id), ['runpod-native', 'runpod', 'cloudrun-cpu-us-east4']);
  assert.deepEqual(runnerCandidates({ project: 'usr_a' }, 'web', 'customer', withNative, { specs: { cpu: spec } }).choices.map((x: any) => x.cloud.variant), ['runpod', 'cpu']);
  // An explicit browser runner with no URL takes its service's from settings.playtest.
  const ex = settingsWith([R({ id: 'rp', provider: 'runpod', url: null, targets: ['web'], pricePerSecond: 0.0001, maxConcurrent: 6 })], { runpod: { ...SETTINGS_DEFAULTS.playtest.runpod, url: 'https://abc123.api.runpod.ai' } });
  const svc = (runnerCandidates({ project: 'x' }, 'web', 'customer', ex).choices[0] as any).cloud;
  assert.equal(svc.url, 'https://abc123.api.runpod.ai');
  assert.equal(svc.maxInstances * svc.tabsPerInstance, 6);
  assert.ok(Math.abs(svc.pricePerSecond / svc.tabsPerInstance - 0.0001) < 1e-12);
});

// ------------------------------------------------------------------ the session protocol, against a fake runner

type FakeRun = (ws: any, start: any) => void;
async function fakeRunner(token: string | null, play: FakeRun) {
  const wss = new WebSocketServer({ noServer: true });
  const seen: any[] = [];
  const server = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/session' || (token && req.headers['x-hawkes-token'] !== token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: any) => {
      ws.once('message', (m: any) => {
        const start = JSON.parse(String(m));
        seen.push({ start, job: req.headers['x-hawkes-job'] });
        play(ws, start);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, seen, close: () => new Promise<void>((r) => { wss.close(); server.close(() => r()); }) };
}

const send = (ws: any, m: any) => ws.send(JSON.stringify(m));
const sendFile = (ws: any, meta: any, data: Buffer) => {
  send(ws, { type: 'file', bytes: data.length, ...meta });
  for (let i = 0; i < data.length; i += 1000) ws.send(Buffer.concat([Buffer.from([2]), data.subarray(i, i + 1000)]));
  send(ws, { type: 'fileEnd', name: meta.name });
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4000, 7)]);
const MP4 = Buffer.concat([Buffer.from('....ftypisom'), Buffer.alloc(5000, 1)]);

/** A good run: accepted, a step, logs, state, a crash, a frame, perf, the video, a shot, a dump, the result. */
const goodRun: FakeRun = (ws, start) => {
  send(ws, { type: 'accepted', runner: 'fake-1', gpu: 'RTX A4000', os: 'Linux + Proton 9' });
  send(ws, { type: 'step', text: `fetching ${start.build.name ?? 'the build'}` });
  send(ws, { type: 'log', t: 0.5, stream: 'player', line: 'Initialize engine version: 6000.3.7f1' });
  send(ws, { type: 'log', t: 1.5, stream: 'player', line: 'NullReferenceException: Object reference not set' });
  send(ws, { type: 'state', t: 2, status: 'playing', scene: 'Level1', progress: 0.4 });
  ws.send(Buffer.concat([Buffer.from([1]), JPEG]));
  send(ws, { type: 'crash', t: 3, kind: 'signal', signal: 'SIGSEGV', message: 'Segmentation fault', stack: 'at Boss.Update()\nat Player.Loop()', dump: 'crash.dmp' });
  send(ws, { type: 'crash', t: 9, kind: 'signal', signal: 'SIGSEGV', message: 'Segmentation fault', stack: 'at Boss.Update()\nat Player.Loop()' });
  send(ws, { type: 'perf', t: 4, fps: { average: 58, worst: 40 } });
  send(ws, { type: 'perf', final: true, fps: { average: 57.5, worst: 31, p1: 33 }, frameTimes: { p50: 16.6, p95: 21, p99: 30, max: 90 }, cpu: { average: 41, max: 88 }, gpu: { average: 35, max: 70 }, memoryMB: { average: 900, max: 1100 }, source: 'mangohud' });
  sendFile(ws, { name: 'video.mp4', kind: 'video', mime: 'video/mp4' }, MP4);
  sendFile(ws, { name: 'shot-000.jpg', kind: 'shot', mime: 'image/jpeg', t: 2, reason: 'scene', scene: 'Level1' }, JPEG);
  sendFile(ws, { name: 'crash.dmp', kind: 'dump', mime: 'application/octet-stream' }, Buffer.alloc(300, 9));
  send(ws, { type: 'result', outcome: 'won', seconds: 12.5, loadSeconds: 3.2, contract: true, scenarios: [{ id: 'smoke' }], report: { metrics: { score: 10 }, events: [{ t: 2, kind: 'scene' }], log: ['bot: done'] }, problems: [{ severity: 'warning', message: 'a slow load' }] });
  setTimeout(() => ws.close(1000, 'done'), 20);
};

test('runSession: everything a runner sends comes back (logs, state, crashes, perf, frames, files, result)', async () => {
  const r = await fakeRunner('tok-1', goodRun);
  try {
    const frames: Buffer[] = [];
    const s = await runSession({ url: r.url, token: 'tok-1', id: 'fake' }, {
      job: 'j_test', project: 'usr_a', target: 'proton', build: { url: 'https://storage.googleapis.com/b/x?sig', kind: 'archive', name: 'build.zip' },
      exe: 'Game.exe', args: ['-x'], scenario: 'smoke', mode: 'auto', options: null, seed: 1, speed: 1, timeout: 60, bootTimeout: 60, width: 1280, height: 720, shotEvery: 5, liveFps: 4,
    }, { limitMs: 20_000, tmp, handlers: { frame: (j) => frames.push(j) } });
    assert.equal(r.seen[0].start.type, 'start');
    assert.equal(r.seen[0].start.v, 1);
    assert.equal(r.seen[0].start.exe, 'Game.exe');
    assert.equal(r.seen[0].job, 'j_test');
    assert.equal(s.accepted?.runner, 'fake-1');
    assert.equal(s.result?.outcome, 'won');
    assert.equal(s.logs.length, 2);
    assert.equal(s.crashes.length, 2);
    assert.equal(groupCrashes(s.crashes)[0].count, 2);
    assert.equal(s.perf?.fps?.average, 57.5);
    assert.equal(s.perf?.frameTimes?.p99, 30);
    assert.equal(s.perfSamples.length, 1);
    assert.equal(frames.length, 1);
    assert.deepEqual(s.files.map((f) => [f.kind, f.bytes]), [['video', MP4.length], ['shot', JPEG.length], ['dump', 300]]);
    assert.deepEqual(fs.readFileSync(s.files[0].path), MP4);
  } finally {
    await r.close();
  }
});

test('runSession: a refusal or a wrong token is RunnerUnavailable (the router moves on)', async () => {
  const busy = await fakeRunner(null, (ws) => send(ws, { type: 'refused', reason: 'busy: 1 of 1 sessions', retry: true }));
  const locked = await fakeRunner('right', goodRun);
  const start: any = { job: 'j', project: 'p', target: 'linux', build: { url: 'https://x.example/b.zip', kind: 'archive' }, exe: null, args: [], scenario: 'smoke', mode: 'auto', options: null, seed: 1, speed: 1, timeout: 10, bootTimeout: 10, width: 640, height: 360, shotEvery: 5, liveFps: 0 };
  try {
    await assert.rejects(runSession({ url: busy.url, token: null, id: 'busy' }, start, { limitMs: 10_000, tmp }), (e: any) => e instanceof RunnerUnavailable && /busy/.test(e.message));
    await assert.rejects(runSession({ url: locked.url, token: 'wrong', id: 'locked' }, start, { limitMs: 10_000, tmp }), (e: any) => e instanceof RunnerUnavailable);
  } finally {
    await busy.close();
    await locked.close();
  }
});

// ------------------------------------------------------------------ playtest.run end to end on native runners

function fakeCtx(params: Record<string, any>, project = 'doseofdestruction') {
  const outputs: any[] = [];
  const usage: any[] = [];
  const steps: string[] = [];
  const logs: string[] = [];
  let result: any = null;
  const dir = fs.mkdtempSync(path.join(process.env.HAWKESGEN_DATA_DIR!, 'job-'));
  const ctx: any = {
    job: { id: `j_${Math.random().toString(16).slice(2, 10)}`, client: 'c', project, tool: 'playtest.run', labels: {} },
    params: playtestRunTool.admit!({ params: validateParams(playtestRunTool, params), client: { id: 'c', role: 'owner', projects: ['*'] }, project, customer: false }), inputs: {}, done: 0, outputs, signal: new AbortController().signal,
    step: (s: string) => steps.push(s), log: (l: string) => logs.push(l), tmp: (n: string) => path.join(dir, n),
    emit: async (o: any) => { outputs.push({ ...o, asset: `as_${outputs.length}` }); }, result: (v: any) => { result = v; },
    seed: () => 1, usage: (u: any) => usage.push(u), python: async () => '',
  };
  return { ctx, outputs, usage, steps, logs, get result() { return result; } };
}

test('playtest.run on a desktop target: the router\'s first runner refuses, the next plays; result has crashes, logs and perf', async () => {
  resetHealth();
  resetRunners();
  const busy = await fakeRunner(null, (ws) => send(ws, { type: 'refused', reason: 'no GPU free' }));
  const good = await fakeRunner(null, goodRun);
  saveSettings({ playtest: { ...loadSettings().playtest, runners: [
    { id: 'busy', provider: 'native', url: busy.url, targets: ['proton'], lanes: ['studio', 'customer'], pricePerSecond: 0.0002, maxConcurrent: 2, enabled: true, tokenEnv: null },
    { id: 'good', provider: 'native', url: good.url, targets: ['proton', 'linux'], lanes: ['studio', 'customer'], pricePerSecond: 0.0002, maxConcurrent: 2, enabled: true, tokenEnv: null },
  ] as any } });
  try {
    const run = fakeCtx({ build: 'https://downloads.example.com/game-win.zip', target: 'proton', exe: 'Game.exe', timeout: 60 });
    await playtestRunTool.run(run.ctx);
    const r = run.result;
    assert.equal(r.target, 'proton');
    assert.equal(r.runner.id, 'good');
    assert.equal(r.outcome, 'won');
    assert.equal(r.crashes.length, 2);
    assert.deepEqual(r.crashGroups, [{ signature: 'at Boss.Update()', count: 2 }]);
    assert.ok(r.problems.some((x: any) => x.severity === 'blocker' && /crashed 2 times: at Boss\.Update/.test(x.message)));
    assert.equal(r.logs.lines, 2);
    assert.equal(r.console.errors, 1);
    assert.equal(r.perf.fps.average, 57.5);
    assert.equal(r.perf.cpu.max, 88);
    assert.equal(r.fps.average, 57.5);
    assert.equal(r.video, 'as_0');
    assert.equal(r.shots[0].asset, 'as_1');
    assert.equal(r.crashes[0].dumpAsset, 'as_2');
    assert.equal(r.report, 'as_3');
    assert.equal(good.seen[0].start.build.url, 'https://downloads.example.com/game-win.zip');
    assert.ok(isDown(runnerHealthKey('busy')), 'the runner that refused cools down');
    assert.equal(run.usage[0].provider, 'playtest-native');
    assert.ok(run.steps.some((s) => /no GPU free; trying the next runner/.test(s)));
    // Nothing plays Windows: a clear refusal, not a browser here.
    await assert.rejects(playtestRunTool.run(fakeCtx({ build: 'https://downloads.example.com/game-win.zip', target: 'windows' }).ctx), /No runner plays windows builds/);
  } finally {
    saveSettings({ playtest: { ...loadSettings().playtest, runners: [] } });
    await busy.close();
    await good.close();
  }
});

test('playtest.run as a customer: only runners that take customers\' builds, and a URL that resolves inside is refused at run time', async () => {
  resetHealth();
  resetRunners();
  const studio = await fakeRunner(null, goodRun);
  saveSettings({ playtest: { ...loadSettings().playtest, runners: [
    { id: 'studio-box', provider: 'native', url: studio.url, targets: ['linux'], lanes: ['studio'], pricePerSecond: 0, maxConcurrent: 1, enabled: true, tokenEnv: null },
  ] as any } });
  try {
    const run = fakeCtx({ build: 'https://downloads.example.com/game.tar.gz', target: 'linux' }, 'usr_a');
    await assert.rejects(callScope.run({ customer: true }, () => playtestRunTool.run(run.ctx)), /No runner plays linux builds for customers/);
    assert.equal(studio.seen.length, 0);
    // A web URL: the name is checked against DNS before any browser opens it (localhost.example.test doesn't resolve).
    const web = fakeCtx({ url: 'https://nothing-here.invalid/' }, 'usr_a');
    await assert.rejects(callScope.run({ customer: true }, () => playtestRunTool.run(web.ctx)), /resolve/);
  } finally {
    saveSettings({ playtest: { ...loadSettings().playtest, runners: [] } });
    await studio.close();
  }
});

// ------------------------------------------------------------------ the browser service serves builds itself

test('site.mjs: a customer\'s archive is fetched, unpacked and served on the runner, never outside its folder', async () => {
  const src = fs.mkdtempSync(path.join(process.env.HAWKESGEN_DATA_DIR!, 'site-src-'));
  fs.mkdirSync(path.join(src, 'MyGame', 'Build'), { recursive: true });
  fs.writeFileSync(path.join(src, 'MyGame', 'index.html'), '<html>hi</html>');
  fs.writeFileSync(path.join(src, 'MyGame', 'Build', 'game.wasm.br'), Buffer.from([1, 2, 3]));
  const tarFile = path.join(process.env.HAWKESGEN_DATA_DIR!, 'site.tar');
  const made = spawnSync('tar', ['-cf', path.basename(tarFile), '-C', path.basename(src), 'MyGame'], { cwd: process.env.HAWKESGEN_DATA_DIR });
  assert.equal(made.status, 0, String(made.stderr));
  const bytes = fs.readFileSync(tarFile);
  const fetchImpl = (async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })) as typeof fetch;
  const header = Buffer.from(JSON.stringify({ url: 'https://storage.googleapis.com/b/o?sig=1', kind: 'archive', sha256: null })).toString('base64url');
  const parsed = site.parseSiteHeader(header);
  assert.ok(parsed);
  assert.equal(site.parseSiteHeader(Buffer.from(JSON.stringify({ url: 'http://127.0.0.1/x' })).toString('base64url')), null, 'only https links');
  const opened = await site.openSite(parsed, { dir: path.join(process.env.HAWKESGEN_DATA_DIR!, 'sites'), fetchImpl });
  try {
    assert.equal(path.basename(opened.root), 'MyGame', 'the one folder inside is the site');
    const page = await fetch(`http://127.0.0.1:${opened.port}/`);
    assert.equal(await page.text(), '<html>hi</html>');
    const wasm = await fetch(`http://127.0.0.1:${opened.port}/Build/game.wasm.br`, { headers: { 'accept-encoding': 'identity' } }).catch(() => null);
    assert.ok(wasm === null || wasm.headers.get('content-type') === 'application/wasm');
    assert.deepEqual(site.headersFor('Build/game.wasm.br'), { 'Content-Type': 'application/wasm', 'Content-Encoding': 'br' });
    assert.deepEqual(site.headersFor('Build/game.data.gz'), { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
    for (const bad of ['/../site.tar', '/..%2f..%2fsite.tar', '/%2e%2e/%2e%2e/site.tar']) assert.equal(site.resolvePath(opened.root, bad), null, bad);
    assert.equal((await fetch(`http://127.0.0.1:${opened.port}/..%2f..%2fsite.tar`)).status, 404);
    assert.equal(site.siteArg(opened.port), `--host-resolver-rules=MAP build.hawkes.test:80 127.0.0.1:${opened.port}`);
  } finally {
    await opened.close();
  }
  // Too big: refused while downloading, not truncated.
  await assert.rejects(site.download('https://x.example/b', path.join(process.env.HAWKESGEN_DATA_DIR!, 'big'), { max: 10, fetchImpl }), /limit/);
});

// ------------------------------------------------------------------ skipProviders (Studio's retry hint)

test('playtest.run accepts skipProviders: known providers kept, unknown dropped, empty omitted', () => {
  const raw = validateParams(playtestRunTool, { url: 'https://example.com/', skipProviders: ['modal', 'bogus', 'runpod', 'modal'] });
  const admitted = playtestRunTool.admit!({
    params: raw,
    client: { id: 'c', role: 'owner', projects: ['*'] },
    project: 'studio',
    customer: false,
  }) as Record<string, unknown>;
  assert.deepEqual(admitted.skipProviders, ['modal', 'runpod']);
  const empty = playtestRunTool.admit!({
    params: validateParams(playtestRunTool, { url: 'https://example.com/', skipProviders: ['aws', 'nope'] }),
    client: { id: 'c', role: 'owner', projects: ['*'] },
    project: 'studio',
    customer: false,
  }) as Record<string, unknown>;
  assert.equal('skipProviders' in empty, false);
});

// ------------------------------------------------------------------ prices

test('playtests are priced, not internal: run by target and minutes, review by frames and model (provisional)', () => {
  assert.equal(isInternalOnlyTool('playtest.run'), false);
  assert.equal(isInternalOnlyTool('playtest.review'), false);
  assert.equal(isInternalOnlyTool('unity.build'), true);
  assert.equal(isInternalOnlyTool('unity.test'), true);
  const web = quoteJobCredits('playtest.run', { url: 'https://example.com/' });
  const proton = quoteJobCredits('playtest.run', { build: 'https://example.com/b.zip', target: 'proton', timeout: 600 });
  const windows = quoteJobCredits('playtest.run', { build: 'https://example.com/b.zip', target: 'windows', timeout: 600 });
  assert.equal(playtestMinutes({}), 4);
  assert.equal(playtestMinutes({ target: 'proton', timeout: 600 }), 12);
  assert.equal(playtestMinutes({ peers: 2, timeout: 120 }), 6);
  assert.ok(web.credits >= 3 && web.credits <= 12, `web smoke ${web.credits}`);
  assert.equal(proton.credits, Math.ceil(12 * 0.01 * 3 * 100));
  assert.ok(windows.credits > proton.credits * 2, `${windows.credits} vs ${proton.credits}`);
  assert.match(proton.breakdown[0].basis, /provisional/);
  const sonnet = quoteJobCredits('playtest.review', { job: 'j_x', frames: 16, model: 'claude-sonnet-5-5' });
  const opus40 = quoteJobCredits('playtest.review', { job: 'j_x', frames: 40, model: 'claude-opus-5-5' });
  assert.ok(sonnet.credits >= 3);
  assert.ok(opus40.credits > sonnet.credits * 2, `${opus40.credits} vs ${sonnet.credits}`);
});
