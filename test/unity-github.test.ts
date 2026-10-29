// GitHub mode of the Unity cloud build (docs/unity-cloudrun.md, "GitHub mode"): the params Gen accepts, the spec it
// writes for the container (with a fake Google Cloud: Storage, Cloud Run, Logging), the result it returns, and the
// container's git side (server/unity-cloudrun/github.sh) against local repos standing in for GitHub: the website's
// beta checkout with old Game/v<n> left out, the commit and push to beta (never main), a branch that moved meanwhile,
// the package repos from the manifest, and the token never printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-unity-gh-'));
process.env.HAWKESGEN_DATA_DIR = data;
const creds = path.join(data, 'adc.json');
fs.writeFileSync(creds, JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }));
process.env.GOOGLE_APPLICATION_CREDENTIALS = creds;
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ unityBuild: { gcp: { project: 'hawkes-test', bucket: 'hawkes-unity-test', region: 'us-east4', job: 'hawkes-unity-build', unity: '6000.3.7f1', cpu: 8, memoryGiB: 32 } } }));

const gh = await import('../src/providers/builder/github.ts');
const { parseCloudResult } = await import('../src/providers/builder/cache.ts');
const { runCloudBuild } = await import('../src/providers/builder/cloudrun.ts');
const { githubBackend } = await import('../src/tools/build.ts');

const SHA = 'a'.repeat(40);
const base = { repo: 'jgriffith3433/YoobaLand', commit: SHA, siteRepo: 'jgriffith3433/YoobaLandGame', ref: 'build-oct28' };

test('the github param: defaults to beta, and never main', () => {
  const g = gh.githubBuildOf(base, 'YoobaLand/YoobaLand', 'YoobaLandGame');
  assert.equal(g.branch, 'beta');
  assert.equal(g.cacheBranch, 'beta');
  assert.deepEqual(g.packages, { hawkesgen: 'main', hawkesstudio: 'main' });
  for (const branch of ['main', 'MASTER', 'gh-pages']) assert.throws(() => gh.githubBuildOf({ ...base, branch }, 'p', 's'), /never pushes/);
  assert.throws(() => gh.githubBuildOf({ ...base, commit: 'abc123' }, 'p', 's'), /full commit sha/);
  assert.throws(() => gh.githubBuildOf({ ...base, repo: 'nope' }, 'p', 's'), /owner\/name/);
  assert.throws(() => gh.githubBuildOf(base, 'p', undefined), /needs site/);
  assert.throws(() => gh.githubBuildOf({ ...base, siteRepo: base.repo }, 'p', 's'), /website repo/);
  assert.throws(() => gh.githubBuildOf({ ...base, branch: '--force' }, 'p', 's'), /isn't a branch/);
  assert.equal(gh.githubBuildOf({ ...base, packages: { hawkesgen: 'gcp' } }, 'p', 's').packages.hawkesgen, 'gcp');
});

test('the source repo is fetched sparse to the project inside it', () => {
  const g = gh.githubBuildOf(base, 'YoobaLand/YoobaLand', 'YoobaLandGame');
  assert.deepEqual(gh.githubRepos(g, 'YoobaLand/YoobaLand'), [{ slug: 'jgriffith3433/YoobaLand', top: 'YoobaLand', commit: SHA, branch: null, sparse: ['YoobaLand'] }]);
  assert.deepEqual(gh.githubRepos({ ...g, repo: 'jgriffith3433/breakingthrough' }, 'breakingthrough')[0].sparse, []);
  assert.deepEqual(gh.githubSite(g, 'YoobaLandGame'), { slug: 'jgriffith3433/YoobaLandGame', top: 'YoobaLandGame', branch: 'beta' });
  assert.match(gh.buildCommitMessage(g, 'YoobaLand/YoobaLand'), /^Unity build: YoobaLand\/YoobaLand aaaaaaa \(build-oct28\)/);
});

test('GitHub mode runs in the cloud: builder becomes Cloud Run, an explicit builder is refused', () => {
  assert.equal(githubBackend(undefined, 'builder'), 'cloudrun');
  assert.equal(githubBackend('auto', 'vm'), 'vm');
  assert.throws(() => githubBackend('builder', 'builder'), /runs in the cloud/);
});

test('the result carries the push, and a push to main is never believed', () => {
  const ok = parseCloudResult(JSON.stringify({ ok: true, pushed: { repo: 'o/site', branch: 'beta', commit: 'b'.repeat(40), before: 'c'.repeat(40), source: SHA, files: 3 }, packages: { hawkesgen: 'd'.repeat(40), bad: 1 } }));
  assert.deepEqual(ok.pushed, { repo: 'o/site', branch: 'beta', commit: 'b'.repeat(40), before: 'c'.repeat(40), source: SHA, files: 3 });
  assert.deepEqual(ok.packages, { hawkesgen: 'd'.repeat(40) });
  assert.equal(parseCloudResult(JSON.stringify({ ok: true })).pushed, null);
  assert.throws(() => parseCloudResult(JSON.stringify({ ok: true, pushed: { repo: 'o/site', branch: 'main', commit: 'b'.repeat(40), source: SHA } })), /never does/);
});

/** A fake Google Cloud: token, Storage (writes kept, reads served), Cloud Run (one execution, done), Logging. */
function fakeGoogle(result: unknown) {
  const writes = new Map<string, Buffer>();
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.replace(/\?.*$/, '')}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'fake-token', expires_in: 3600 });
    if (url.startsWith('https://storage.googleapis.com/upload/')) {
      const name = new URL(url).searchParams.get('name')!;
      writes.set(name, Buffer.from(init.body instanceof Buffer || init.body instanceof Uint8Array ? init.body : String(init.body)));
      return json({ name });
    }
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/')) {
      const key = decodeURIComponent(url.replace(/^.*\/o\//, '').replace(/\?.*$/, ''));
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (key.endsWith('/result.json')) return new Response(JSON.stringify(result));
      if (key.endsWith('/unity.log')) return new Response('[Hawkes] stage: unity\nBuild succeeded\n');
      return new Response('not found', { status: 404 });
    }
    if (url.includes('run.googleapis.com') && url.endsWith(':run')) return json({ metadata: { name: 'projects/hawkes-test/locations/us-east4/jobs/hawkes-unity-build/executions/e-1' } });
    if (url.includes('run.googleapis.com') && url.includes('/executions/e-1')) return json({ startTime: '2026-10-28T10:00:00Z', completionTime: '2026-10-28T10:08:00Z', succeededCount: 1 });
    if (url.startsWith('https://logging.googleapis.com/')) return json({ entries: [{ textPayload: '[Hawkes] stage: push', timestamp: '2026-10-28T10:07:00Z' }] });
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  return { writes, calls, restore: () => { globalThis.fetch = real; } };
}

test('a GitHub-mode build: the spec names the commit and the website branch, and nothing is laid down here', async () => {
  const pushed = { repo: 'jgriffith3433/YoobaLandGame', branch: 'beta', commit: 'e'.repeat(40), before: 'f'.repeat(40), source: SHA, files: 4 };
  const g = fakeGoogle({
    ok: true, stage: 'end', exitCode: 0, seconds: { unity: 300 }, cache: { restoredFrom: 'beta', saved: true, savedKey: 'beta' },
    output: { object: 'unity-builds/j1/site.tgz', bytes: 2048, changed: [{ path: 'Game/v8/Build/a.wasm.unityweb', size: 2000 }, { path: 'index.html', size: 48 }], deleted: ['Game/v7/.hawkes-stub'] },
    pushed, packages: { hawkesgen: '1'.repeat(40) },
  });
  const logs: string[] = [];
  try {
    const github = gh.githubBuildOf(base, 'YoobaLand/YoobaLand', 'YoobaLandGame');
    const r: any = await runCloudBuild('j1', { project: 'YoobaLand/YoobaLand', site: 'YoobaLandGame', method: 'YoobaWebBuild.FullDeploy', env: { BUILD_VERSION: '8' }, github }, { step: () => {}, log: (s) => logs.push(s) });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.pushed, pushed);
    assert.deepEqual(r.site.changed, ['YoobaLandGame/Game/v8/Build/a.wasm.unityweb', 'YoobaLandGame/index.html']);
    assert.deepEqual(r.site.deleted, ['YoobaLandGame/Game/v7']);
    const spec = JSON.parse(g.writes.get('unity-builds/j1/spec.json')!.toString('utf8'));
    assert.deepEqual(spec.repos, [{ slug: 'jgriffith3433/YoobaLand', top: 'YoobaLand', commit: SHA, branch: null, sparse: ['YoobaLand'] }]);
    assert.equal(spec.siteInput, null);
    assert.equal(spec.overlay, null);
    assert.equal(spec.unity, '6000.3.7f1');
    assert.deepEqual(spec.cache.restore, ['beta', 'main']);
    assert.equal(spec.cache.save, 'beta');
    assert.deepEqual(spec.env, { BUILD_VERSION: '8' });
    assert.deepEqual(spec.github.site, { slug: 'jgriffith3433/YoobaLandGame', top: 'YoobaLandGame', branch: 'beta' });
    assert.equal(spec.github.owner, 'jgriffith3433');
    assert.match(spec.github.message, /build-oct28/);
    // Only the spec went up; nothing came down (no site.tgz) and no checkout here was read.
    assert.deepEqual([...g.writes.keys()], ['unity-builds/j1/spec.json']);
    assert.ok(!g.calls.some((c) => c.includes('site.tgz')));
    assert.ok(g.calls.some((c) => c.endsWith('jobs/hawkes-unity-build:run')));
    assert.ok(logs.some((l) => /pushed jgriffith3433\/YoobaLandGame beta: fffffff -> eeeeeee/.test(l)), logs.join('\n'));
  } finally {
    g.restore();
  }
});

// ------------------------------------------------------------------ the container's git side (github.sh)

const SH = path.resolve(import.meta.dirname, '..', 'server', 'unity-cloudrun', 'github.sh');
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const toBash = (p: string) => p.replace(/\\/g, '/');
const TOKEN = 'ghp_FAKE_TOKEN_never_printed_123';

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Bare repos under <root>/gh/<owner>/<name>.git, standing in for GitHub; a website with main, beta and Game/v3. */
function fakeGitHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-gh-'));
  const mk = (slug: string, files: Record<string, string>, branches = ['main']) => {
    const bare = path.join(root, 'gh', `${slug}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q', '--bare');
    git(bare, 'config', 'uploadpack.allowFilter', 'true');
    git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const w = path.join(root, 'seed', slug);
    fs.mkdirSync(w, { recursive: true });
    git(w, 'init', '-q');
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true });
      fs.writeFileSync(path.join(w, f), text);
    }
    git(w, 'add', '-A');
    git(w, 'commit', '-q', '-m', 'seed');
    git(w, 'remote', 'add', 'origin', bare);
    for (const b of branches) git(w, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`);
    return { bare, seed: w };
  };
  const site = mk('o/site', { 'index.html': 'v3 loader', 'Game/v3/Build/big.data': 'BIG OLD BUILD', 'Game/v3/index.html': 'old', 'about.html': 'about' }, ['main', 'beta']);
  const nobeta = mk('o/site2', { 'index.html': 'x', 'Game/v1/a.txt': 'old' }, ['main']);
  const gen = mk('o/hawkesgen', { 'clients/unity/com.hawkes.gen/package.json': '{}', 'clients/unity/com.hawkes.analytics/package.json': '{}', 'src/big.ts': 'not needed' });
  const studio = mk('o/hawkesstudio', { 'clients/unity/com.hawkes.playtest/package.json': '{}', 'src/x.ts': 'no' });
  return { root, site, nobeta, gen, studio };
}

/** Runs a bash snippet with github.sh sourced, as the entrypoint would (die exits 3 with the reason). */
function sh(fake: ReturnType<typeof fakeGitHub>, spec: unknown, script: string) {
  const work = path.join(fake.root, 'work');
  const P = path.join(work, 'Projects');
  fs.mkdirSync(P, { recursive: true });
  fs.writeFileSync(path.join(work, 'spec.json'), JSON.stringify(spec));
  const prelude = `
set -uo pipefail
P='${toBash(P)}'; WORK='${toBash(work)}'; S="$WORK/spec.json"
AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\\n')"
j() { jq -r "$1 // empty" "$S"; }
log() { echo "[Hawkes] $*"; }
die() { echo "DIE $1: $2"; exit 3; }
. '${toBash(SH)}'
`;
  const r = spawnSync('bash', ['-c', prelude + script], {
    encoding: 'utf8',
    env: { ...process.env, HAWKES_GIT_BASE: `file://${toBash(path.join(fake.root, 'gh'))}`, GITHUB_TOKEN: TOKEN, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), P, work };
}

const hasJq = hasBash && spawnSync('bash', ['-c', 'jq --version'], { encoding: 'utf8' }).status === 0;
const siteSpec = (branch = 'beta', slug = 'o/site') => ({ github: { owner: 'o', site: { slug, top: 'site', branch }, packages: { hawkesgen: 'main', hawkesstudio: 'main' }, message: 'Unity build: game 1234567 (build-x)' } });

test('github.sh: beta is checked out without the old builds, the new one is pushed to beta, main is untouched', { skip: !hasJq }, () => {
  const fake = fakeGitHub();
  try {
    const mainBefore = git(fake.site.bare, 'rev-parse', 'main');
    const r = sh(fake, siteSpec(), `
github_site site
[ -f "$P/site/Game/v3/.hawkes-stub" ] && echo STUB-OK
[ -f "$P/site/Game/v3/Build/big.data" ] && echo OLD-FILES-CHECKED-OUT
# the "build": a new Game/v4, the loader pointing at it, the old folder gone (its stub with it)
rm -rf "$P/site/Game/v3"; mkdir -p "$P/site/Game/v4/Build"; echo new > "$P/site/Game/v4/Build/game.wasm.unityweb"; echo 'v4 loader' > "$P/site/index.html"
printf 'Game/v3/.hawkes-stub\\n' > "$WORK/deleted.txt"
github_publish site ${'1'.repeat(40)}
echo "PUSHED=$PUSHED_JSON"
`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /STUB-OK/);
    assert.doesNotMatch(r.out, /OLD-FILES-CHECKED-OUT/);
    assert.doesNotMatch(r.out, new RegExp(TOKEN));
    assert.doesNotMatch(r.out, new RegExp(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')));
    const pushed = JSON.parse(/PUSHED=(.*)/.exec(r.out)![1]);
    assert.equal(pushed.branch, 'beta');
    assert.equal(pushed.repo, 'o/site');
    assert.equal(pushed.commit, git(fake.site.bare, 'rev-parse', 'beta'));
    assert.equal(git(fake.site.bare, 'rev-parse', 'main'), mainBefore, 'main never moves');
    const tree = git(fake.site.bare, 'ls-tree', '-r', '--name-only', 'beta').split('\n');
    assert.deepEqual(tree.sort(), ['Game/v4/Build/game.wasm.unityweb', 'about.html', 'index.html']);
    assert.equal(git(fake.site.bare, 'show', 'beta:index.html'), 'v4 loader');
    assert.match(git(fake.site.bare, 'log', '-1', '--format=%an <%ae>%n%s', 'beta'), /Hawkes Gen <gen@hawkesgen.ai>\nUnity build: game 1234567 \(build-x\)/);
    // No credential stays in the checkout's config.
    assert.doesNotMatch(fs.readFileSync(path.join(r.P, 'site', '.git', 'config'), 'utf8'), /extraheader/i);
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('github.sh: beta moved during the build, so the build goes on top of it', { skip: !hasJq }, () => {
  const fake = fakeGitHub();
  try {
    const r = sh(fake, siteSpec(), `
github_site site
# someone merges a page change into beta meanwhile
( cd '${toBash(fake.site.seed)}' && git fetch -q origin beta && git checkout -q -B beta origin/beta && echo 'new about' > about.html && git -c user.name=t -c user.email=t@t commit -qam page && git push -q origin beta )
mkdir -p "$P/site/Game/v4"; echo new > "$P/site/Game/v4/g.js"; : > "$WORK/deleted.txt"
github_publish site ${'2'.repeat(40)}
echo "PUSHED=$PUSHED_JSON"
`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /refused \(try 1\)/);
    assert.equal(git(fake.site.bare, 'show', 'beta:about.html'), 'new about');
    assert.equal(git(fake.site.bare, 'show', 'beta:Game/v4/g.js'), 'new');
    assert.equal(git(fake.site.bare, 'show', 'beta:Game/v3/index.html'), 'old', 'old builds stay unless the build removed them');
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('github.sh: a website without beta gets one from its default branch; main and protected names are refused', { skip: !hasJq }, () => {
  const fake = fakeGitHub();
  try {
    const r = sh(fake, siteSpec('beta', 'o/site2'), `
github_site site
echo hi > "$P/site/new.txt"; : > "$WORK/deleted.txt"
github_publish site ${'3'.repeat(40)}
`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /has no beta yet/);
    assert.equal(git(fake.nobeta.bare, 'show', 'beta:new.txt'), 'hi');
    assert.equal(git(fake.nobeta.bare, 'ls-tree', '--name-only', 'main').includes('new.txt'), false);
    for (const branch of ['main', 'Master', 'gh-pages']) {
      const m = sh(fake, siteSpec(branch), 'github_site site; echo REACHED');
      assert.equal(m.code, 3, m.out);
      assert.match(m.out, /DIE config: a build never pushes/);
      assert.doesNotMatch(m.out, /REACHED/);
    }
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('github.sh: the manifest\'s file: packages come from their repos, sparse, at the named branch', { skip: !hasJq }, () => {
  const fake = fakeGitHub();
  try {
    const r = sh(fake, siteSpec(), `
mkdir -p "$P/game/Packages"
cat > "$P/game/Packages/manifest.json" <<'EOF'
{ "dependencies": {
  "com.hawkes.gen": "file:C:/Projects/hawkesgen/clients/unity/com.hawkes.gen",
  "com.hawkes.analytics": "file:C:/Projects/hawkesgen/clients/unity/com.hawkes.analytics",
  "com.hawkes.playtest": "file:C:/Projects/hawkesstudio/clients/unity/com.hawkes.playtest",
  "com.unity.ugui": "2.0.0" } }
EOF
github_packages "$P/game" game
echo "PACKAGES=$PACKAGES_JSON"
if [ -e "$P/hawkesgen/src" ]; then echo SPARSE-BROKEN; fi
`);
    assert.equal(r.code, 0, r.out);
    const pk = JSON.parse(/PACKAGES=(.*)/.exec(r.out)![1]);
    assert.equal(pk.hawkesgen, git(fake.gen.bare, 'rev-parse', 'main'));
    assert.equal(pk.hawkesstudio, git(fake.studio.bare, 'rev-parse', 'main'));
    assert.ok(fs.existsSync(path.join(r.P, 'hawkesgen', 'clients', 'unity', 'com.hawkes.gen', 'package.json')));
    assert.ok(fs.existsSync(path.join(r.P, 'hawkesgen', 'clients', 'unity', 'com.hawkes.analytics', 'package.json')));
    assert.ok(fs.existsSync(path.join(r.P, 'hawkesstudio', 'clients', 'unity', 'com.hawkes.playtest', 'package.json')));
    assert.doesNotMatch(r.out, /SPARSE-BROKEN/);
    assert.doesNotMatch(r.out, new RegExp(TOKEN));
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});
