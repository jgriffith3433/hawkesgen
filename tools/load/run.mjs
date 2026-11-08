#!/usr/bin/env node
// Hawkes Gen load harness (docs/load.md): N test accounts through a LOCAL copy of Gen with every provider mocked.
//
//   node tools/load/run.mjs --users 300
//   node tools/load/run.mjs --users 300 --storms signup,uploads,restart --rate 2 --duration 30
//
// It starts its own copy of the service (scratch data folder, free port, HAWKESGEN_MOCK_PROVIDERS=1, the test sign-in
// on), signs in --users test accounts (POST /v1/users/test-session), opens GET /v1/events for each (held open: the
// harness never polls events), submits mock jobs at --rate jobs/second per user, and prints a pass/fail table:
// p50/p95/p99 per route, 429 and 5xx counts, the server's memory and restarts, and event-loop lag from /v1/health.
// Storms: signup (all accounts sign in at once), uploads (20 parallel blob uploads), restart (the server is killed
// and started again mid-run; streams reconnect, queued jobs must still finish).
//
// Safety: GPU is never touched (tools are mocked; a copy on a non-loopback address is refused). It aborts, exit 2, if
// /v1/health shows a live lane, mocks off, or any real provider cost. Exit 0: every check passed; 1: a check failed.
// The only timers are the harness's own (pacing, a health sample every 2 s); the product gains none.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : (process.argv[i + 1] ?? true); };
const OPT = {
  users: Math.max(1, Number(arg('users', 50))),
  rate: Number(arg('rate', 0.2)),         // jobs per second per user
  duration: Number(arg('duration', 20)), // seconds of load
  storms: String(arg('storms', 'signup,uploads,restart,limits')).split(',').map((s) => s.trim()).filter(Boolean),
  url: arg('url', null),                 // an already running local copy (loopback only); else one is started
  keep: process.argv.includes('--keep'),
  p95: Number(arg('p95-ms', 2000)),
  lag: Number(arg('lag-ms', 1000)),
  rssMb: Number(arg('rss-mb', 1500)),
  drain: Number(arg('drain', 120)),       // seconds to wait for the last jobs
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[load]', ...a);
const die = (msg) => { console.error(`[load] ABORT: ${msg}`); process.exit(2); };

// ------------------------------------------------------------------------------------------------ the server copy
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-load-'));
const SECRET = `tss_${crypto.randomBytes(24).toString('base64url')}`;
fs.writeFileSync(path.join(dataDir, 'test-signin.json'), JSON.stringify({ secret: SECRET, at: Date.now() }));
let child = null, port = 0, BASE = '', spawns = 0, exits = [];

function startServer() {
  spawns++;
  const env = {
    ...process.env,
    HAWKESGEN_DATA_DIR: dataDir, HAWKESGEN_PORT: String(port), HAWKESGEN_HOST: '127.0.0.1',
    HAWKESGEN_LANE: 'local', HAWKESGEN_TEST_SIGNIN: '1', HAWKESGEN_MOCK_PROVIDERS: '1',
    HAWKESGEN_STARTER_CREDITS: '1000000', HAWKESGEN_AUDIO_MOCK: '1', HAWKESGEN_QUALITY_MOCK: '1',
    // Nothing that spends: no keys reach the copy.
    ANTHROPIC_API_KEY: '', ELEVENLABS_API_KEY: '', RUNPOD_API_KEY: '', MODAL_TOKEN_ID: '', MODAL_TOKEN_SECRET: '',
  };
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'server.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = [];
  const keepTail = (d) => { tail.push(...String(d).split('\n').filter(Boolean)); tail = tail.slice(-30); };
  child.stdout.on('data', keepTail); child.stderr.on('data', keepTail);
  const me = child;
  child.on('exit', (code, sig) => { exits.push({ code, sig, at: Date.now(), tail: [...tail] }); });
  return me;
}
async function waitHealthy(ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`${BASE}/v1/health`); if (r.ok) return await r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('the service did not come up');
}

// ------------------------------------------------------------------------------------------------ measuring
const stats = new Map(); // route -> { ms: [], status: {}, errs }
const norm = (p) => p.split('?')[0].replace(/\/(j|a|e|blob)_[a-z0-9]+/gi, '/:id').replace(/[0-9a-f]{16,}/g, ':hash');
function note(route, ms, status) {
  const s = stats.get(route) ?? { ms: [], codes: {}, netErr: 0 };
  stats.set(route, s);
  if (status === 0) s.netErr++; else s.ms.push(ms);
  s.codes[status] = (s.codes[status] ?? 0) + 1;
}
async function call(user, method, route, body, raw) {
  const t = performance.now();
  let status = 0, json = null;
  try {
    const headers = { ...(user ? { 'x-forwarded-for': `10.${(user.i >> 16) & 255}.${(user.i >> 8) & 255}.${user.i & 255}` } : {}), ...(user?.cookie ? { cookie: user.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'x-filename': 'load.bin' } : {}) };
    const r = await fetch(BASE + route, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    status = r.status;
    const setCookie = r.headers.get('set-cookie');
    if (setCookie && user) user.cookie = setCookie.split(';')[0];
    json = await r.json().catch(() => null);
  } catch { status = 0; }
  note(`${method} ${norm(route)}`, performance.now() - t, status);
  return { status, json };
}
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]; };

const health = { samples: 0, maxRss: 0, maxLag: 0, maxHeap: 0, pids: new Set(), realCost: 0, bad: null, last: null };
async function sampleHealth() {
  try {
    const r = await fetch(`${BASE}/v1/health`);
    const h = await r.json();
    health.samples++; health.last = h;
    health.pids.add(h.process?.pid);
    health.maxRss = Math.max(health.maxRss, h.process?.rssMb ?? 0);
    health.maxHeap = Math.max(health.maxHeap, h.process?.heapMb ?? 0);
    health.maxLag = Math.max(health.maxLag, h.loop?.maxMs ?? 0);
    health.realCost = Math.max(health.realCost, h.mock?.realCost ?? 0);
    if (h.lane === 'live' || !h.mock?.providers) health.bad = `health says lane=${h.lane}, mock providers ${h.mock?.providers}`;
    else if ((h.mock?.realCost ?? 0) > 0) health.bad = `health shows real provider cost $${h.mock.realCost}`;
    if (health.bad) { log('ABORT:', health.bad); await shutdown(); process.exit(2); }
  } catch { /* server down (restart storm) */ }
}

// ------------------------------------------------------------------------------------------------ users
function signToken(project) {
  const exp = Math.floor(Date.now() / 1000) + 300, nonce = crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(`${project}.${exp}.${nonce}`).digest('base64url');
  return { project, exp, nonce, sig };
}
const users = Array.from({ length: OPT.users }, (_, i) => ({ i, project: `load-${String(i).padStart(4, '0')}`, cookie: null, submitted: new Set(), done: new Set(), failed: new Set(), events: 0, reconnects: 0, stream: null, open: false }));

async function signIn(u) {
  const r = await call(u, 'POST', '/v1/users/test-session', signToken(u.project));
  if (r.status !== 200 || !u.cookie) throw new Error(`sign-in for ${u.project} gave ${r.status}`);
  u.id = r.json?.user?.id;
}

// The event stream, held open for the whole run (the harness reconnects after a restart; the product has no timer for it).
let stopping = false;
async function holdStream(u) {
  while (!stopping) {
    const ac = new AbortController();
    u.stream = ac;
    try {
      const r = await fetch(`${BASE}/v1/events`, { headers: { cookie: u.cookie }, signal: ac.signal });
      note('GET /v1/events (open)', 0, r.status);
      if (r.status !== 200) { await sleep(1000); continue; }
      u.open = true;
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          if (!block.startsWith('event: job')) continue;
          u.events++;
          try {
            const j = JSON.parse(block.split('\n').find((l) => l.startsWith('data: ')).slice(6));
            if (j.status === 'done') u.done.add(j.id); else if (j.status === 'failed' || j.status === 'cancelled') u.failed.add(j.id);
          } catch {}
        }
      }
    } catch { /* closed: server restarted or we are stopping */ }
    u.open = false;
    if (!stopping) { u.reconnects++; await sleep(500 + Math.random() * 500); }
  }
}

const TOOLS = [
  { tool: 'image.generate', params: { prompt: 'a load test fox', width: 512, height: 512 } },
  { tool: 'audio.sfx', params: { prompt: 'a door creak' } },
  { tool: 'audio.voice', params: { text: 'Testing, one two three.' } },
];
async function submit(u, n) {
  const spec = TOOLS[n % TOOLS.length];
  const r = await call(u, 'POST', '/v1/jobs', { ...spec, params: { ...spec.params, seed: 1000 + n }, labels: { load: true } });
  const j = r.json?.jobs?.[0];
  if (r.status === 200 && j?.id) u.submitted.add(j.id);
  return r;
}
async function readMix(u) {
  await call(u, 'GET', '/v1/jobs?limit=5');
  await call(u, 'GET', '/v1/users/me');
}

// ------------------------------------------------------------------------------------------------ storms
const storms = [];
async function stormSignup() {
  // The whole crowd signs in at the same moment (fresh accounts: nothing exists for them yet).
  const t = performance.now();
  const results = await Promise.allSettled(users.map(signIn));
  const bad = results.filter((r) => r.status === 'rejected').length;
  storms.push({ name: 'sign-up burst', ok: bad === 0, detail: `${users.length - bad}/${users.length} signed in in ${Math.round(performance.now() - t)} ms` });
}
async function stormUploads() {
  const pick = users.filter((u) => u.cookie).slice(0, 20);
  const t = performance.now();
  const results = await Promise.all(pick.map(async (u, i) => (await call(u, 'POST', '/v1/blobs', null, crypto.randomBytes(2 * 1024 * 1024 + i))).status));
  const ok = results.filter((s) => s === 200).length;
  storms.push({ name: '20 parallel uploads', ok: ok === pick.length && pick.length === Math.min(20, users.length), detail: `${ok}/${pick.length} x 2 MiB in ${Math.round(performance.now() - t)} ms` });
}
// Above the limit: one address hammers a strict route (sign-in) and must be told 429 + Retry-After; /v1/health, hit as
// hard, must never be. Not counted in the route table (these 429s are the point), so "429s under 1%" still judges normal use.
async function stormLimits() {
  const ip = { 'x-forwarded-for': '203.0.113.200', 'content-type': 'application/json' };
  let limited = 0, early = 0, retryOk = true, plain = true;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/v1/users/test-session`, { method: 'POST', headers: ip, body: '{}' });
      if (r.status === 429) {
        limited++;
        const ra = Number(r.headers.get('retry-after'));
        if (!(ra >= 1)) retryOk = false;
        const j = await r.json().catch(() => null);
        if (typeof j?.error !== 'string') plain = false;
      } else { if (limited === 0) early++; await r.arrayBuffer(); }
    } catch {}
  }
  let healthLimited = 0;
  for (let i = 0; i < 400; i++) { try { const r = await fetch(`${BASE}/v1/health`, { headers: { 'x-forwarded-for': '203.0.113.201' } }); if (r.status === 429) healthLimited++; await r.arrayBuffer(); } catch {} }
  storms.push({ name: 'rate limit: 60 sign-ins from one address, 400 health checks', ok: limited > 0 && early > 0 && retryOk && plain && healthLimited === 0,
    detail: `${early} let through, then ${limited} x 429 (Retry-After ${retryOk ? 'set' : 'MISSING'}, plain JSON ${plain}); health limited ${healthLimited}` });
}
async function stormRestart() {
  const before = health.last?.process?.pid;
  const t = performance.now();
  const old = child;
  old.kill('SIGTERM');
  await new Promise((r) => { old.once('exit', r); setTimeout(() => { try { old.kill('SIGKILL'); } catch {} }, 8000); });
  startServer();
  let back = null;
  try { back = await waitHealthy(60000); } catch {}
  storms.push({ name: 'mid-run restart', ok: Boolean(back) && back.process?.pid !== before, detail: back ? `back in ${Math.round(performance.now() - t)} ms (pid ${before} -> ${back.process?.pid})` : 'did not come back' });
}

// ------------------------------------------------------------------------------------------------ the run
async function shutdown() {
  stopping = true;
  for (const u of users) u.stream?.abort();
  if (child && !OPT.keep && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 5000); }); }
}
process.on('SIGINT', async () => { await shutdown(); process.exit(130); });

async function main() {
  if (OPT.url) {
    const u = new URL(OPT.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) die(`${OPT.url} is not a local copy; this harness runs against localhost only`);
    BASE = OPT.url.replace(/\/+$/, ''); port = Number(u.port) || 80;
    die('--url needs the copy\'s test sign-in secret in its data folder; start without --url so the harness starts its own copy');
  }
  port = await freePort(); BASE = `http://127.0.0.1:${port}`;
  log(`starting a local copy on ${BASE} (data ${dataDir}), mock providers on`);
  startServer();
  const h0 = await waitHealthy().catch((e) => { die(`${e.message}\n${(exits.at(-1)?.tail ?? []).join('\n')}`); });
  if (h0.lane === 'live' || !h0.mock?.providers) die(`health: lane ${h0.lane}, mock providers ${h0.mock?.providers}: refusing to run`);
  if ((h0.mock.realCost ?? 0) > 0) die(`health already shows real provider cost $${h0.mock.realCost}`);
  log(`health ok: lane ${h0.lane}, providers mocked, real cost $${h0.mock.realCost}`);
  await sampleHealth();
  const ticker = setInterval(sampleHealth, 2000);

  // 1. sign-in (the sign-up burst, or a staggered ramp when that storm is off)
  if (OPT.storms.includes('signup')) await stormSignup();
  else { for (let i = 0; i < users.length; i += 10) await Promise.all(users.slice(i, i + 10).map(signIn)); }
  const live = users.filter((u) => u.cookie);
  if (!live.length) { clearInterval(ticker); await shutdown(); die('no account could sign in'); }

  // 2. one held event stream each
  live.forEach((u) => { holdStream(u); });
  const opened = Date.now() + 15000;
  while (live.some((u) => !u.open) && Date.now() < opened) await sleep(100);
  log(`${live.filter((u) => u.open).length}/${live.length} event streams open`);

  // 3. load: every user submits mock jobs at --rate, with some reads between; storms land partway through
  const end = Date.now() + OPT.duration * 1000;
  const gap = Math.max(5, 1000 / Math.max(0.01, OPT.rate));
  const worker = async (u) => {
    await sleep(Math.random() * gap);
    for (let n = 0; Date.now() < end; n++) {
      await submit(u, n);
      if (n % 3 === 0) await readMix(u);
      await sleep(gap);
    }
  };
  const stormPlan = [];
  if (OPT.storms.includes('limits')) stormPlan.push([0.2, stormLimits]);
  if (OPT.storms.includes('uploads')) stormPlan.push([0.3, stormUploads]);
  if (OPT.storms.includes('restart')) stormPlan.push([0.6, stormRestart]);
  const stormRun = stormPlan.map(async ([at, fn]) => { await sleep(OPT.duration * 1000 * at); await fn(); });
  log(`load for ${OPT.duration} s: ${live.length} users x ${OPT.rate} jobs/s each, storms: ${OPT.storms.join(', ') || 'none'}`);
  await Promise.all([...live.map(worker), ...stormRun]);

  // 4. drain: wait (on the streams, no polling) for every submitted job to be reported finished
  log('waiting for the last jobs');
  const total = () => live.reduce((a, u) => a + u.submitted.size, 0);
  const finished = () => live.reduce((a, u) => a + [...u.submitted].filter((id) => u.done.has(id) || u.failed.has(id)).length, 0);
  const drainEnd = Date.now() + OPT.drain * 1000;
  while (finished() < total() && Date.now() < drainEnd) await sleep(250);
  // A job whose terminal event was missed in a restart gap is looked up once, on demand.
  for (const u of live) for (const id of u.submitted) if (!u.done.has(id) && !u.failed.has(id)) {
    const r = await call(u, 'GET', `/v1/jobs/${id}`);
    const st = r.json?.job?.status ?? r.json?.status;
    if (st === 'done') u.done.add(id); else if (st === 'failed' || st === 'cancelled') u.failed.add(id);
  }
  await sampleHealth();
  clearInterval(ticker);
  const final = health.last;
  const drained = { submitted: total(), done: live.reduce((a, u) => a + u.done.size, 0), failed: live.reduce((a, u) => a + u.failed.size, 0) };
  const noEvents = live.filter((u) => u.submitted.size && u.events === 0).length;
  const reconnects = live.reduce((a, u) => a + u.reconnects, 0);
  await shutdown();
  report({ final, drained, noEvents, reconnects, liveCount: live.length });
}

function report({ final, drained, noEvents, reconnects, liveCount }) {
  const rows = []; let failed = 0;
  const check = (name, ok, detail) => { rows.push({ name, ok, detail }); if (!ok) failed++; };
  console.log('\nroute'.padEnd(34) + 'n'.padStart(7) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + '  429'.padStart(6) + '  5xx'.padStart(6) + '  err'.padStart(6) + '  result');
  let n429 = 0, n5xx = 0, nErr = 0;
  for (const [route, s] of [...stats].sort()) {
    const c429 = s.codes[429] ?? 0, c5 = Object.entries(s.codes).filter(([k]) => +k >= 500).reduce((a, [, v]) => a + v, 0);
    n429 += c429; n5xx += c5; nErr += s.netErr;
    const open = route.endsWith('(open)');
    const p95 = pct(s.ms, 95);
    // Restart storms cause connection errors and 5xx-free failures only for the seconds the server is down; they're counted, not failed.
    const ok = open || p95 <= OPT.p95;
    if (!ok) failed++;
    const n = Object.values(s.codes).reduce((a, v) => a + v, 0);
    console.log(route.padEnd(34) + String(n).padStart(7) + (open ? '-' : Math.round(pct(s.ms, 50))).toString().padStart(8) + (open ? '-' : Math.round(p95)).toString().padStart(8) + (open ? '-' : Math.round(pct(s.ms, 99))).toString().padStart(8) + String(c429).padStart(6) + String(c5).padStart(6) + String(s.netErr).padStart(6) + (ok ? '  pass' : '  FAIL'));
  }
  check(`no 5xx responses`, n5xx === 0, `${n5xx}`);
  check(`429s under 1% of requests`, n429 <= 0.01 * [...stats.values()].reduce((a, s) => a + Object.values(s.codes).reduce((x, y) => x + y, 0), 0), `${n429}`);
  const restartRan = OPT.storms.includes('restart');
  check(`connection errors only from the restart`, restartRan || nErr === 0, `${nErr}${restartRan ? ' (restart storm on)' : ''}`);
  check(`every submitted job finished`, drained.done + drained.failed === drained.submitted && drained.failed === 0, `${drained.done} done, ${drained.failed} failed of ${drained.submitted}`);
  check(`every user's event stream heard its jobs`, noEvents === 0, `${noEvents} silent of ${liveCount}${reconnects ? `, ${reconnects} reconnects` : ''}`);
  check(`server memory under ${OPT.rssMb} MB`, health.maxRss <= OPT.rssMb, `peak rss ${health.maxRss} MB, heap ${health.maxHeap} MB`);
  check(`event-loop lag under ${OPT.lag} ms`, health.maxLag <= OPT.lag, `worst ${health.maxLag} ms, p99 ${final?.loop?.p99Ms ?? '?'} ms`);
  const unexpected = restartRan ? Math.max(0, spawns - 2) : Math.max(0, spawns - 1);
  const crashed = exits.filter((e) => e.code !== 0 && e.sig !== 'SIGTERM' && e.sig !== 'SIGKILL' && e.at).length;
  check(`no unplanned restarts or crashes`, unexpected === 0 && crashed === 0, `${spawns} start${spawns === 1 ? '' : 's'}, ${health.pids.size} pids${restartRan ? ' (1 planned)' : ''}`);
  check(`real provider cost is $0`, health.realCost === 0, `$${health.realCost}`);
  for (const s of storms) check(`storm: ${s.name}`, s.ok, s.detail);
  console.log('\ncheck'.padEnd(46) + 'result'.padEnd(8) + 'detail');
  for (const r of rows) console.log(r.name.padEnd(45) + (r.ok ? 'pass' : 'FAIL').padEnd(8) + r.detail);
  const total = rows.length + stats.size;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${total - failed} of ${total} checks passed. $0 spent.`);
  if (!OPT.keep) fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error('[load] error:', e); await shutdown(); process.exit(2); });
